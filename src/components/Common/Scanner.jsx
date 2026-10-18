import React, { useState, useEffect, useRef, useCallback } from 'react';
import NativeQrScanner from './NativeQrScanner';
import jsQR from 'jsqr';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import {
    FaArrowLeft,
    FaCheckCircle,
    FaSpinner,
    FaSyncAlt,
    FaShieldAlt,
    FaClock,
    FaUserCheck,
    FaArrowRight,
    FaCamera,
    FaExclamationTriangle,
    FaMobileAlt,
    FaExternalLinkAlt,
    FaLock,
    FaKey,
    FaDownload,
    FaFingerprint
} from 'react-icons/fa';
import { MdQrCodeScanner } from 'react-icons/md';
import { useAuth } from '../authcontext';
import { Kiosk } from '../../plugins/kiosk';
import {
    authorizeStudentQR1,
    validateStudentQR2,
    submitVerifiedAttendance,
    subscribeToSession,
    subscribeToStudentAuthorization,
    recordSessionViolation,
    reportAttendanceLifecycleEvent,
    verifyLecturerEmergencyPin,
    requestAutoFailSafeUnlock
} from '../../services/sessionAuthService';
import { db } from '../../firebase';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import FaceScanner, { releaseAllMediaTracks, loadFaceApiModels } from '../Lecturer/pages/FaceScanner';
import { isIOSDevice, isGuidedAccessEnabled, addAppSwitchListener, addScreenCaptureListener } from '../../services/guidedAccessService';
import { getApkDownloadUrl } from '../../utils/apkUrl';
import GuidedAccessRequired, { GuidedAccessExitNotice } from '../GuidedAccessRequired';
import { isGenericName, normalizeDescriptor } from '../../utils/studentDataHelper';
import { detectDeviceType, getClientIpAddress, getDeviceDisplayName, isDeviceMatching } from '../../utils/deviceDetection';
import { sendFacultyNotification, sendStudentNotification, reportUserVerificationComplaint } from '../../services/notificationsService';
import { validateRotatingQrPayload } from '../../utils/qrCrypto';
import { evaluateGeofence } from '../../utils/geofence';
import { verifyHardwareBiometric } from '../../services/biometricService';
import { checkForAppUpdate, CURRENT_APP_VERSION, compareVersions } from '../../services/appUpdateService';
import AppUpdateModal from './AppUpdateModal';
import './Scanner.css';

/**
 * Stage 4: Student Two-Phase Attendance Scanner & Supervised Kiosk Controller
 * 
 * Timeline:
 * T = 0s to 60s (0:00 - 1:00) : QR 1 Phase 1 Check-In -> Authorizes Student -> Starts Kiosk Mode
 * T = 60s to 180s (1:00 - 3:00): QR 2 Phase 2 Biometric -> Gated by Phase 1 -> Submits Attendance
 * Post-Attendance             : Device remains locked in Lock Task Mode -> Auto Release in 5:00 Fail-Safe
 */
function QrScannerApp() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const { user, profile, loading } = useAuth();
    const fileInputRef = useRef(null);
    const sessionTimerRef = useRef(null);
    // Silent camera lock — holds rear camera stream after QR1 to block other apps
    const silentCameraLockRef = useRef(null);
    const [cameraLockActive, setCameraLockActive] = useState(false);

    // Platform & App Detection
    const isNativeApp = Capacitor.isNativePlatform();
    const [showAppBanner, setShowAppBanner] = useState(false);
    const [dismissedAppBanner, setDismissedAppBanner] = useState(false);
    const [deviceOwnerStatus, setDeviceOwnerStatus] = useState({ checked: false, isDeviceOwner: true, isWeb: false });
    const [deviceIdentity, setDeviceIdentity] = useState(null);

    // App Update Gate & Reminder
    const [versionBlock, setVersionBlock] = useState(null);
    const [availableUpdate, setAvailableUpdate] = useState(null);
    const [showUpdateModalFromScanner, setShowUpdateModalFromScanner] = useState(false);

    useEffect(() => {
        let isMounted = true;
        checkForAppUpdate().then((info) => {
            if (!isMounted) return;
            if (info && info.hasUpdate) {
                setAvailableUpdate(info);
                if (info.isMandatory || compareVersions(info.minRequiredVersion, CURRENT_APP_VERSION) > 0) {
                    setVersionBlock({
                        minVersion: info.minRequiredVersion || info.latestVersion,
                        currentVersion: CURRENT_APP_VERSION,
                        mandatoryReason: info.mandatoryReason || "A required app update is pending for your device to mark attendance.",
                        info
                    });
                }
            }
        }).catch(() => { });
        return () => { isMounted = false; };
    }, []);

    // Current State: 'IDLE' | 'AUTHORIZING_QR1' | 'KIOSK_WAITING_QR2' | 'VALIDATING_QR2' | 'BIOMETRIC_SCAN' | 'ATTENDANCE_SUCCESS' | 'DISQUALIFIED'
    const [scanState, setScanState] = useState('IDLE');

    // iOS Guided Access Lockdown State
    const [showGuidedAccessRequired, setShowGuidedAccessRequired] = useState(false);

    // Web Guardian Supervision & Lifecycle Monitoring State
    const [supervisionViolation, setSupervisionViolation] = useState(false);
    const [violationCount, setViolationCount] = useState(0);
    const [interruptionWarning, setInterruptionWarning] = useState(false);
    const interruptedRef = useRef(false);

    // Camera & Scanner State
    const [facingMode, setFacingMode] = useState('environment');
    const [retryKey, setRetryKey] = useState(0);
    const [cameraError, setCameraError] = useState('');
    const [permissionDenied, setPermissionDenied] = useState(false);
    const [scanningFile, setScanningFile] = useState(false);
    const [scannerActive, setScannerActive] = useState(true);

    // Active Session & Student Authorization Data
    const [activeSessionId, setActiveSessionId] = useState('');
    const [activeQr2Token, setActiveQr2Token] = useState('');
    const [sessionData, setSessionData] = useState(null);
    const [sessionStartAt, setSessionStartAt] = useState(0);
    const [kioskEndsAt, setKioskEndsAt] = useState(0);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [sessionRemaining, setSessionRemaining] = useState(180);
    const [errorMessage, setErrorMessage] = useState('');
    const [nowTick, setNowTick] = useState(Date.now());
    const geofenceRetriesRef = useRef(0);
    const prewarmedLocationRef = useRef(null);

    // Heartbeat clock to evaluate phase transitions and countdowns in real-time
    useEffect(() => {
        const interval = setInterval(() => {
            setNowTick(Date.now());
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    // Helper to evaluate if Lecturer has officially released Phase 2 (QR 2)
    const isQr2Released = Boolean(
        sessionData && (
            sessionData.phase === 'PHASE_2' ||
            sessionData.phase === '2' ||
            sessionData.qr2Released === true ||
            (sessionData.qr2StartsAt && (
                typeof sessionData.qr2StartsAt.toMillis === 'function'
                    ? sessionData.qr2StartsAt.toMillis()
                    : Number(sessionData.qr2StartsAt)
            ) <= nowTick) ||
            (sessionData.qr1ExpiresAt && (
                typeof sessionData.qr1ExpiresAt.toMillis === 'function'
                    ? sessionData.qr1ExpiresAt.toMillis()
                    : Number(sessionData.qr1ExpiresAt)
            ) <= nowTick)
        )
    );

    const qr2TargetMs = sessionData?.qr2StartsAt
        ? (typeof sessionData.qr2StartsAt.toMillis === 'function' ? sessionData.qr2StartsAt.toMillis() : Number(sessionData.qr2StartsAt))
        : (sessionData?.qr1ExpiresAt
            ? (typeof sessionData.qr1ExpiresAt.toMillis === 'function' ? sessionData.qr1ExpiresAt.toMillis() : Number(sessionData.qr1ExpiresAt))
            : 0);

    const secondsUntilQr2 = (qr2TargetMs > 0 && !isQr2Released)
        ? Math.max(0, Math.ceil((qr2TargetMs - nowTick) / 1000))
        : null;

    // Continuous High-Accuracy GPS Pre-Warming & Model Pre-Loading
    useEffect(() => {
        let watchId = null;
        if (typeof navigator !== "undefined" && navigator.geolocation) {
            try {
                watchId = navigator.geolocation.watchPosition(
                    (pos) => {
                        if (pos && pos.coords) {
                            const acc = Number(pos.coords.accuracy) || 80;
                            const prev = prewarmedLocationRef.current;
                            // Keep fix if fresher or more precise (lower accuracy radius)
                            if (!prev || (Date.now() - prev.timestamp > 15000) || acc <= prev.accuracy) {
                                prewarmedLocationRef.current = {
                                    latitude: pos.coords.latitude,
                                    longitude: pos.coords.longitude,
                                    lat: pos.coords.latitude,
                                    lng: pos.coords.longitude,
                                    accuracy: acc,
                                    timestamp: Date.now()
                                };
                            }
                        }
                    },
                    (err) => console.warn('[Scanner] GPS prewarm notice:', err?.message || err),
                    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
                );
            } catch (_) { }
        }

        // Ensure camera is fully enabled and free from any previous sessions
        releaseAllMediaTracks();
        try { Kiosk.enableCamera().catch(() => { }); } catch (_) { }

        // Pre-warm neural network models in background for instantaneous Phase 2 biometric startup
        loadFaceApiModels().catch(() => { });

        return () => {
            if (watchId !== null && typeof navigator !== "undefined" && navigator.geolocation?.clearWatch) {
                navigator.geolocation.clearWatch(watchId);
            }
        };
    }, []);

    // 5-Minute Fail-Safe Auto Release State
    const [attendanceSubmittedAt, setAttendanceSubmittedAt] = useState(0);
    const [autoReleaseAt, setAutoReleaseAt] = useState(0);
    const [autoReleaseRemaining, setAutoReleaseRemaining] = useState(300); // 5 minutes in seconds

    // Biometric Verification Data
    const [verifiedStudent, setVerifiedStudent] = useState(null);
    const [lookingUpStudent, setLookingUpStudent] = useState(false);
    const [submittingAttendance, setSubmittingAttendance] = useState(false);
    const [submissionDetails, setSubmissionDetails] = useState(null);
    const [hardwareProof, setHardwareProof] = useState(null);
    // Dual Biometric Combo State (Step 1: Fingerprint -> Step 2: 3D Face)
    const [biometricComboStep, setBiometricComboStep] = useState('FINGERPRINT'); // 'FINGERPRINT' | 'FACE'
    const [fingerprintVerifying, setFingerprintVerifying] = useState(false);
    const [fingerprintError, setFingerprintError] = useState('');
    const fingerprintAutoTriggeredRef = useRef(false);

    // Resolve Student Identity Strictly from Database (Firestore 'students' collection)
    const [dbStudent, setDbStudent] = useState(null);
    const [loadingDbStudent, setLoadingDbStudent] = useState(true);

    useEffect(() => {
        let isMounted = true;
        if (!user) {
            setLoadingDbStudent(false);
            return;
        }

        const fetchDbProfile = async () => {
            try {
                setLoadingDbStudent(true);
                const cleanEmail = (user.email || '').toLowerCase().trim();
                const cleanUid = user.uid || '';
                const cleanProfileRoll = (profile?.rollNo || '').trim().toUpperCase();

                const lookups = [
                    cleanProfileRoll ? getDoc(doc(db, 'students', cleanProfileRoll)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
                    cleanUid ? getDoc(doc(db, 'students', cleanUid)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
                    cleanEmail ? getDocs(query(collection(db, 'students'), where('email', '==', cleanEmail))).catch(() => ({ empty: true, docs: [] })) : Promise.resolve({ empty: true, docs: [] }),
                    cleanUid ? getDocs(query(collection(db, 'students'), where('uid', '==', cleanUid))).catch(() => ({ empty: true, docs: [] })) : Promise.resolve({ empty: true, docs: [] })
                ];

                const [rollSnap, uidSnap, emailQuerySnap, uidQuerySnap] = await Promise.all(lookups);

                let foundData = null;
                let foundId = '';

                if (rollSnap.exists && rollSnap.exists()) {
                    foundData = rollSnap.data();
                    foundId = rollSnap.id;
                } else if (uidSnap.exists && uidSnap.exists()) {
                    foundData = uidSnap.data();
                    foundId = uidSnap.id;
                } else if (!emailQuerySnap.empty && emailQuerySnap.docs?.[0]) {
                    foundData = emailQuerySnap.docs[0].data();
                    foundId = emailQuerySnap.docs[0].id;
                } else if (!uidQuerySnap.empty && uidQuerySnap.docs?.[0]) {
                    foundData = uidQuerySnap.docs[0].data();
                    foundId = uidQuerySnap.docs[0].id;
                }

                // Casing fallback search across students collection if needed
                if (!foundData && cleanEmail) {
                    const allStudentsSnap = await getDocs(collection(db, 'students')).catch(() => ({ docs: [] }));
                    for (const d of allStudentsSnap.docs || []) {
                        const data = d.data();
                        if ((data.email || '').toLowerCase().trim() === cleanEmail) {
                            foundData = data;
                            foundId = d.id;
                            break;
                        }
                    }
                }

                if (isMounted && foundData) {
                    const studentRoll = String(foundData.rollNo || (!foundId.includes('@') ? foundId : (profile?.rollNo || ''))).trim().toUpperCase();
                    const studentName = String(foundData.name || foundData.fullName || profile?.name || profile?.fullName || '').trim();
                    setDbStudent({
                        ...foundData,
                        rollNo: studentRoll,
                        name: studentName,
                        id: studentRoll || foundId
                    });
                }
            } catch (err) {
                console.warn('[Scanner] DB profile lookup notice:', err);
            } finally {
                if (isMounted) setLoadingDbStudent(false);
            }
        };

        fetchDbProfile();
        return () => { isMounted = false; };
    }, [user, profile?.rollNo]);

    const loggedInRollNo = (dbStudent?.rollNo || (profile?.rollNo && !profile.rollNo.includes('@') ? profile.rollNo : '')).trim().toUpperCase();
    const rawProfileName = dbStudent?.name || dbStudent?.fullName || profile?.name || profile?.fullName || '';
    const loggedInName = rawProfileName ? rawProfileName.trim() : (loggedInRollNo ? loggedInRollNo : 'Student');

    // Lecturer Emergency PIN Release Modal State
    const [showPinModal, setShowPinModal] = useState(false);
    const [lecturerPinInput, setLecturerPinInput] = useState('');
    const [pinVerificationError, setPinVerificationError] = useState('');
    const [isVerifyingPin, setIsVerifyingPin] = useState(false);

    /**
     * acquireCameraLock — Silently grabs the rear camera after QR1.
     * While this stream is held, no other app or browser tab can access the camera.
     * The stream is NOT displayed — it runs hidden in the background.
     */
    const acquireCameraLock = useCallback(async () => {
        // Already locked — don't open a second stream
        if (silentCameraLockRef.current) return;
        try {
            console.log('[CameraLock] Acquiring silent rear camera lock...');
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' }, width: { ideal: 320 }, height: { ideal: 240 } },
                audio: false
            });
            silentCameraLockRef.current = stream;
            setCameraLockActive(true);
            console.log('[CameraLock] Rear camera locked. Other apps cannot access camera.');
        } catch (err) {
            // Camera already in use or permission not granted — non-fatal, kiosk still works
            console.warn('[CameraLock] Could not acquire silent camera lock:', err.message);
        }
    }, []);

    /**
     * releaseCameraLock — Releases the silently held camera stream.
     * Called before biometric face scan (which opens front camera) and on all exit paths.
     */
    const releaseCameraLock = useCallback(() => {
        if (silentCameraLockRef.current) {
            console.log('[CameraLock] Releasing silent camera lock.');
            silentCameraLockRef.current.getTracks().forEach((track) => track.stop());
            silentCameraLockRef.current = null;
            setCameraLockActive(false);
        }
    }, []);

    // Check Device Owner & Anti-Escape Overlay status on launch
    const [overlayStatus, setOverlayStatus] = useState({ checked: false, canDraw: true });
    const [showOverlayInstructionsModal, setShowOverlayInstructionsModal] = useState(false);
    const checkDeviceProvisioning = useCallback(async () => {
        if (isNativeApp) {
            try {
                const ownerRes = await Kiosk.isDeviceOwner();
                const identRes = await Kiosk.getDeviceIdentity();
                const overlayRes = await Kiosk.canDrawOverlays();
                setOverlayStatus({ checked: true, canDraw: Boolean(overlayRes?.canDrawOverlays) });
                setDeviceIdentity(identRes);
                setDeviceOwnerStatus({
                    checked: true,
                    isDeviceOwner: Boolean(ownerRes?.isDeviceOwner),
                    isWeb: false
                });
            } catch (e) {
                setDeviceOwnerStatus({ checked: true, isDeviceOwner: false, isWeb: false });
                setOverlayStatus({ checked: true, canDraw: false });
            }
        } else {
            setDeviceOwnerStatus({ checked: true, isDeviceOwner: false, isWeb: true });
        }
    }, [isNativeApp]);

    useEffect(() => {
        checkDeviceProvisioning();

        let appStateHandle = null;
        if (isNativeApp) {
            CapacitorApp.addListener('appStateChange', ({ isActive }) => {
                if (isActive) {
                    checkDeviceProvisioning();
                }
            }).then((h) => {
                appStateHandle = h;
            });
        }

        const onFocus = () => {
            checkDeviceProvisioning();
        };
        window.addEventListener('focus', onFocus);

        return () => {
            if (appStateHandle && typeof appStateHandle.remove === 'function') {
                appStateHandle.remove();
            }
            window.removeEventListener('focus', onFocus);
        };
    }, [checkDeviceProvisioning, isNativeApp]);

    const handleLecturerPinUnlock = async (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (!lecturerPinInput.trim()) {
            setPinVerificationError('Please enter the 6-digit Session PIN.');
            return;
        }

        setIsVerifyingPin(true);
        setPinVerificationError('');

        try {
            await verifyLecturerEmergencyPin(activeSessionId, lecturerPinInput.trim(), deviceIdentity?.deviceId, user?.uid);
            console.log('[Kiosk] Session PIN verified via Cloud Function. Releasing device from Kiosk Lock Task mode...');
            try { localStorage.removeItem('smartattend_kiosk_session_state'); } catch (_) { }
            releaseCameraLock();
            releaseAllMediaTracks();
            await Kiosk.stopKioskMode().catch(() => { });
            await Kiosk.clearAttendanceRestrictions().catch(() => { });
            setShowPinModal(false);
            navigate('/student', { replace: true });
        } catch (err) {
            console.error('Session PIN verification error:', err);
            setPinVerificationError(err.message || 'Invalid Session PIN. Device remains locked in Kiosk mode.');
        } finally {
            setIsVerifyingPin(false);
        }
    };

    // Unmount track release
    useEffect(() => {
        return () => {
            releaseCameraLock();
            releaseAllMediaTracks();
        };
    }, [releaseCameraLock]);

    // Student Database Record Lookup for Facial Biometrics
    const lookupStudentBiometrics = useCallback(async (roll) => {
        const targetRoll = (roll || loggedInRollNo || '').trim().toUpperCase();
        if (!targetRoll || targetRoll.length < 2) return;

        setLookingUpStudent(true);
        try {
            const possibleEmail = user?.email?.toLowerCase().trim() || `${targetRoll.toLowerCase()}@iiitdwd.ac.in`;
            const prefix = targetRoll.toLowerCase();

            const [
                sDoc, uDoc, aDoc,
                sRollSnap, uRollSnap,
                sPrefixDoc,
                sEmailDoc,
                uUidDoc, sUidDoc,
                sEmailSnap, uEmailSnap
            ] = await Promise.all([
                getDoc(doc(db, 'students', targetRoll)).catch(() => ({ exists: () => false })),
                getDoc(doc(db, 'users', targetRoll)).catch(() => ({ exists: () => false })),
                getDoc(doc(db, 'authorizedUsers', targetRoll)).catch(() => ({ exists: () => false })),
                getDocs(query(collection(db, 'students'), where('rollNo', '==', targetRoll))).catch(() => ({ docs: [] })),
                getDocs(query(collection(db, 'users'), where('rollNo', '==', targetRoll))).catch(() => ({ docs: [] })),
                prefix !== targetRoll ? getDoc(doc(db, 'students', prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
                getDoc(doc(db, 'students', possibleEmail)).catch(() => ({ exists: () => false })),
                user?.uid ? getDoc(doc(db, 'users', user.uid)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
                user?.uid ? getDoc(doc(db, 'students', user.uid)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
                user?.email ? getDocs(query(collection(db, 'students'), where('email', '==', user.email.toLowerCase().trim()))).catch(() => ({ docs: [] })) : Promise.resolve({ docs: [] }),
                user?.email ? getDocs(query(collection(db, 'users'), where('email', '==', user.email.toLowerCase().trim()))).catch(() => ({ docs: [] })) : Promise.resolve({ docs: [] })
            ]);

            const candidateDocs = [];
            if (sDoc.exists()) candidateDocs.push(sDoc.data());
            if (uDoc.exists()) candidateDocs.push(uDoc.data());
            if (aDoc.exists()) candidateDocs.push(aDoc.data());
            sRollSnap.docs?.forEach((d) => candidateDocs.push(d.data()));
            uRollSnap.docs?.forEach((d) => candidateDocs.push(d.data()));
            if (sPrefixDoc.exists()) candidateDocs.push(sPrefixDoc.data());
            if (sEmailDoc.exists()) candidateDocs.push(sEmailDoc.data());
            if (uUidDoc?.exists && uUidDoc.exists()) candidateDocs.push(uUidDoc.data());
            if (sUidDoc?.exists && sUidDoc.exists()) candidateDocs.push(sUidDoc.data());
            sEmailSnap.docs?.forEach((d) => candidateDocs.push(d.data()));
            uEmailSnap.docs?.forEach((d) => candidateDocs.push(d.data()));

            let merged = { rollNo: targetRoll, name: loggedInName };
            const authDesc = normalizeDescriptor(profile?.faceDescriptor);
            if (authDesc && Array.isArray(authDesc) && authDesc.length === 128) {
                merged.faceDescriptor = authDesc;
                merged.faceRegistered = true;
            }
            if (profile?.photoURL) merged.photoURL = profile.photoURL;

            for (const docData of candidateDocs) {
                if (docData.rollNo) merged.rollNo = String(docData.rollNo).trim().toUpperCase();
                else if (docData.studentId) merged.rollNo = String(docData.studentId).trim().toUpperCase();
                if (docData.name && !isGenericName(docData.name, merged.rollNo)) merged.name = docData.name;
                if (docData.fullName && !isGenericName(docData.fullName, merged.rollNo)) merged.fullName = docData.fullName;
                const desc = normalizeDescriptor(docData.faceDescriptor) || normalizeDescriptor(docData.descriptor);
                if (desc && Array.isArray(desc) && desc.length === 128) {
                    merged.faceDescriptor = desc;
                    merged.faceRegistered = true;
                }
                if (docData.photoURL) merged.photoURL = docData.photoURL;
            }

            console.log(`[Scanner] Biometrics loaded for ${targetRoll}:`, {
                hasDescriptor: Boolean(merged.faceDescriptor),
                faceRegistered: Boolean(merged.faceRegistered),
                name: merged.name
            });

            setVerifiedStudent(merged);
        } catch (err) {
            console.warn('Student biometrics lookup notice:', err);
        } finally {
            setLookingUpStudent(false);
        }
    }, [loggedInRollNo, loggedInName, user, profile]);

    // Authoritative Session Countdown Timer
    useEffect(() => {
        if (!sessionStartAt || !kioskEndsAt) return;

        const updateClock = () => {
            const now = Date.now();
            const elapsed = Math.floor((now - sessionStartAt) / 1000);
            const remaining = Math.max(0, Math.floor((kioskEndsAt - now) / 1000));
            setElapsedSeconds(elapsed);
            setSessionRemaining(remaining);
        };

        updateClock();
        sessionTimerRef.current = setInterval(updateClock, 1000);

        return () => {
            if (sessionTimerRef.current) clearInterval(sessionTimerRef.current);
        };
    }, [sessionStartAt, kioskEndsAt]);

    // 5-Minute Fail-Safe Countdown Timer after Attendance Submission
    useEffect(() => {
        if (scanState !== 'ATTENDANCE_SUCCESS' || !autoReleaseAt) return;

        const updateFailSafe = async () => {
            const now = Date.now();
            const remaining = Math.max(0, Math.floor((autoReleaseAt - now) / 1000));
            setAutoReleaseRemaining(remaining);

            // Fail-safe trigger: 5 minutes elapsed without lecturer release
            if (remaining <= 0) {
                console.log('[Kiosk] 5-Minute fail-safe timer expired. Authorizing automatic device release...');
                try {
                    await requestAutoFailSafeUnlock(activeSessionId, user?.uid, deviceIdentity?.deviceId);
                } catch (e) {
                    console.warn('Fail safe unlock notice:', e);
                }
                try { localStorage.removeItem('smartattend_kiosk_session_state'); } catch (_) { }
                releaseCameraLock();
                releaseAllMediaTracks();
                await Kiosk.stopKioskMode().catch(() => { });
                await Kiosk.clearAttendanceRestrictions().catch(() => { });
                navigate('/student', { replace: true });
            }
        };

        updateFailSafe();
        const interval = setInterval(updateFailSafe, 1000);

        return () => clearInterval(interval);
    }, [scanState, autoReleaseAt, activeSessionId, user?.uid, deviceIdentity?.deviceId, navigate]);

    // Automatic Release When Session Ends (Guarantees student device is never stuck, even on errors or disqualifications)
    const [sessionEndedAutoReleased, setSessionEndedAutoReleased] = useState(false);
    const hasAutoReleasedRef = useRef(false);

    useEffect(() => {
        if (!activeSessionId) return;

        const checkSessionEndingRelease = () => {
            const now = Date.now();
            const endMs = kioskEndsAt || (sessionData?.kioskEndsAt ? (typeof sessionData.kioskEndsAt.toMillis === 'function' ? sessionData.kioskEndsAt.toMillis() : Number(sessionData.kioskEndsAt)) : 0);
            const isClosed = sessionData?.status === 'CLOSED' || sessionData?.phase === 'CLOSED' || sessionData?.isClosed === true;
            const isExpired = endMs > 0 && now >= endMs;

            if ((isClosed || isExpired) && !hasAutoReleasedRef.current) {
                hasAutoReleasedRef.current = true;
                console.log('[Kiosk] Session ended/expired. Automatically releasing all device restrictions...');
                try { localStorage.removeItem('smartattend_kiosk_session_state'); } catch (_) { }
                try { sessionStorage.removeItem(`smartattend_qr1_auth_${activeSessionId}`); } catch (_) { }
                try { localStorage.removeItem(`smartattend_qr1_auth_${activeSessionId}`); } catch (_) { }
                releaseCameraLock();
                releaseAllMediaTracks();
                Kiosk.stopKioskMode().catch(() => { });
                Kiosk.clearAttendanceRestrictions().catch(() => { });
                setSessionEndedAutoReleased(true);

                // Call backend fail-safe release in background
                requestAutoFailSafeUnlock(activeSessionId, user?.uid, deviceIdentity?.deviceId).catch(() => { });

                if (scanState === 'ATTENDANCE_SUCCESS') {
                    navigate('/student', { replace: true });
                }
            }
        };

        checkSessionEndingRelease();
        const interval = setInterval(checkSessionEndingRelease, 1000);
        return () => clearInterval(interval);
    }, [activeSessionId, kioskEndsAt, sessionData, scanState, user?.uid, deviceIdentity?.deviceId, navigate, releaseCameraLock]);

    // Session state persistence across app crash / restarts
    useEffect(() => {
        const isSessionOngoing = activeSessionId && (
            (kioskEndsAt && kioskEndsAt > Date.now()) ||
            (autoReleaseAt && autoReleaseAt > Date.now()) ||
            scanState === 'KIOSK_WAITING_QR2' ||
            scanState === 'BIOMETRIC_SCAN' ||
            scanState === 'ATTENDANCE_SUCCESS'
        );

        if (isSessionOngoing) {
            try {
                localStorage.setItem('smartattend_kiosk_session_state', JSON.stringify({
                    sessionId: activeSessionId,
                    sessionStartAt,
                    kioskEndsAt,
                    attendanceSubmittedAt,
                    autoReleaseAt,
                    scanState,
                    activeQr2Token,
                    submissionDetails,
                    rollNo: loggedInRollNo
                }));
            } catch (e) {
                console.warn('LocalStorage save notice:', e);
            }
        } else if (scanState === 'IDLE' || (autoReleaseAt && Date.now() >= autoReleaseAt)) {
            try {
                localStorage.removeItem('smartattend_kiosk_session_state');
            } catch (_) { }
        }
    }, [activeSessionId, sessionStartAt, kioskEndsAt, attendanceSubmittedAt, autoReleaseAt, scanState, activeQr2Token, submissionDetails, loggedInRollNo]);

    // Resume session on mount if app was closed/restarted during active session
    useEffect(() => {
        try {
            const raw = localStorage.getItem('smartattend_kiosk_session_state');
            if (raw) {
                const parsed = JSON.parse(raw);
                const hasValidTimer = (parsed.autoReleaseAt && parsed.autoReleaseAt > Date.now()) || (parsed.kioskEndsAt && parsed.kioskEndsAt > Date.now());
                if (parsed && parsed.sessionId && hasValidTimer) {
                    console.log('[Kiosk] Resuming active attendance session after app launch/restart:', parsed);
                    setActiveSessionId(parsed.sessionId);
                    setSessionStartAt(parsed.sessionStartAt);
                    setKioskEndsAt(parsed.kioskEndsAt);
                    if (parsed.attendanceSubmittedAt) setAttendanceSubmittedAt(parsed.attendanceSubmittedAt);
                    if (parsed.autoReleaseAt) {
                        setAutoReleaseAt(parsed.autoReleaseAt);
                        setAutoReleaseRemaining(Math.max(0, Math.floor((parsed.autoReleaseAt - Date.now()) / 1000)));
                    }
                    if (parsed.activeQr2Token) setActiveQr2Token(parsed.activeQr2Token);
                    if (parsed.submissionDetails) setSubmissionDetails(parsed.submissionDetails);
                    setScanState(parsed.scanState || 'KIOSK_WAITING_QR2');

                    // Re-enforce native Lock Task Mode & DevicePolicyManager restrictions
                    Kiosk.startKioskMode().catch(() => { });
                    Kiosk.setAttendanceRestrictions().catch(() => { });
                } else {
                    localStorage.removeItem('smartattend_kiosk_session_state');
                }
            }
        } catch (e) {
            console.warn('Notice restoring session:', e);
        }
    }, []);

    // Intercept hardware/software back button on Android
    useEffect(() => {
        let backListener = null;
        if (isNativeApp) {
            CapacitorApp.addListener('backButton', () => {
                const isSessionActive = scanState === 'KIOSK_WAITING_QR2' || scanState === 'BIOMETRIC_SCAN' || scanState === 'ATTENDANCE_SUCCESS';
                if (isSessionActive) {
                    console.log('[Kiosk] Back navigation blocked during active attendance kiosk session.');
                } else {
                    navigate('/student', { replace: true });
                }
            }).then((handle) => {
                backListener = handle;
            });
        }

        return () => {
            if (backListener && typeof backListener.remove === 'function') {
                backListener.remove();
            }
        };
    }, [scanState, isNativeApp, navigate]);

    // Multi-Platform Guardian Supervision & Lifecycle Monitoring
    useEffect(() => {
        const isSessionActive = scanState === 'KIOSK_WAITING_QR2' || scanState === 'BIOMETRIC_SCAN';
        if (!isSessionActive) {
            setSupervisionViolation(false);
            setInterruptionWarning(false);
            interruptedRef.current = false;
            return;
        }

        const handleViolationTrigger = async (source) => {
            console.warn(`[Kiosk Guardian] Lifecycle interruption detected via ${source}!`);

            const isAndroidNative = isNativeApp && !isIOSDevice();
            if (isAndroidNative) {
                // Android native app: Strict kiosk policy
                // 1st confirmed violation = warning; 2nd confirmed violation = rejected attendance & flagged student.
                // Enforce the threshold on the backend.
                const nextCount = violationCount + 1;
                setViolationCount(nextCount);
                const isDisq = nextCount >= 2;

                let backendResult = null;
                if (activeSessionId) {
                    try {
                        backendResult = await reportAttendanceLifecycleEvent(activeSessionId, {
                            eventType: 'CONFIRMED_KIOSK_ESCAPE',
                            source: source,
                            platform: 'android',
                            count: nextCount
                        });
                    } catch (err) {
                        console.warn('[Kiosk Guardian] Backend event report notice:', err);
                    }

                    // Explicitly update Firestore with student's roll number & UID
                    try {
                        await recordSessionViolation(
                            activeSessionId,
                            user?.uid,
                            loggedInRollNo,
                            `CONFIRMED_KIOSK_ESCAPE: ${source}`,
                            nextCount,
                            isDisq || Boolean(backendResult?.disqualified)
                        );
                    } catch (vErr) {
                        console.warn('[Kiosk Guardian] Direct violation record notice:', vErr);
                    }
                }

                if (nextCount >= 2 || (backendResult && backendResult.disqualified)) {
                    console.error(`[Kiosk Guardian] Android Security violation limit reached (count = ${nextCount}). Disqualifying attendance session.`);
                    try { localStorage.removeItem(`smartattend_qr1_auth_${activeSessionId}`); } catch (_) { }
                    try { sessionStorage.removeItem(`smartattend_qr1_auth_${activeSessionId}`); } catch (_) { }
                    releaseAllMediaTracks();
                    Kiosk.startKioskMode().catch(() => { });
                    setErrorMessage('❌ Attendance Disqualified: Security violation limit reached (2 confirmed kiosk exits). Attendance forfeited.');
                    setScanState('DISQUALIFIED');
                    setSupervisionViolation(false);
                } else {
                    console.warn(`[Kiosk Guardian] Android Security Warning: Violation 1 of 2 recorded.`);
                    // Immediately re-enforce Kiosk LockTask mode and keep app pinned in foreground
                    Kiosk.startKioskMode().catch(() => { });
                    setSupervisionViolation(true);
                }
                return;
            }

            // iPhone native app and website/browser:
            // - Detect supported page/app lifecycle signals (visibilitychange, blur, iOS lifecycle).
            // - When the student returns, display a warning and record event for review.
            // - Do NOT claim iOS or browsers can reliably prevent or detect every app switch.
            // - Do NOT treat every hidden-page event as confirmed misconduct.
            // - Do NOT automatically reject attendance solely due to ambiguous browser lifecycle events.
            interruptedRef.current = true;
            if (activeSessionId) {
                reportAttendanceLifecycleEvent(activeSessionId, {
                    eventType: 'SUSPICIOUS_LIFECYCLE_INTERRUPTION',
                    source: source,
                    platform: isIOSDevice() ? (isNativeApp ? 'ios' : 'web_ios') : 'web'
                }).catch(() => { });
            }
        };

        const handleReturnToApp = (source) => {
            if (interruptedRef.current) {
                console.log(`[Lifecycle] Student returned to SmartAttend after interruption (${source}).`);
                interruptedRef.current = false;
                setInterruptionWarning(true);
            }
        };

        let appStateHandle = null;
        if (isNativeApp) {
            CapacitorApp.addListener('appStateChange', ({ isActive }) => {
                if (!isActive) {
                    handleViolationTrigger('APP_BACKGROUNDED');
                } else {
                    handleReturnToApp('APP_FOREGROUNDED');
                }
            }).then((h) => {
                appStateHandle = h;
            });
        }

        // iOS-specific: subscribe to native GuidedAccessPlugin appSwitchDetected events.
        let iosAppSwitchCleanup = null;
        if (isNativeApp && isIOSDevice()) {
            addAppSwitchListener((switchData) => {
                if (switchData.event === 'WILL_RESIGN_ACTIVE') {
                    handleViolationTrigger('IOS_RESIGN_ACTIVE');
                }
            }).then((cleanup) => {
                iosAppSwitchCleanup = cleanup;
            });
        }

        const handleVisibilityChange = () => {
            if (document.hidden || document.visibilityState === 'hidden') {
                handleViolationTrigger('VISIBILITY_CHANGE');
            } else {
                handleReturnToApp('VISIBILITY_RETURN');
            }
        };

        const handleBlur = () => {
            handleViolationTrigger('WINDOW_BLUR');
        };

        const handleFocus = () => {
            handleReturnToApp('WINDOW_FOCUS');
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('blur', handleBlur);
        window.addEventListener('focus', handleFocus);

        // ── Anti-Proxy Web Guardian Hardening ────────────────────────────────
        // 1. Block keyboard shortcuts that open DevTools, new tabs, or reveal source
        const handleKeyDown = (e) => {
            const key = e.key;
            const ctrl = e.ctrlKey || e.metaKey;
            const shift = e.shiftKey;
            // Block: F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+U, Ctrl+S, Ctrl+A, Ctrl+P, Ctrl+T, Ctrl+W
            if (
                key === 'F12' ||
                (ctrl && shift && (key === 'I' || key === 'i' || key === 'J' || key === 'j')) ||
                (ctrl && !shift && (key === 'u' || key === 'U' || key === 's' || key === 'S' ||
                    key === 'a' || key === 'A' || key === 'p' || key === 'P' ||
                    key === 't' || key === 'T' || key === 'w' || key === 'W'))
            ) {
                e.preventDefault();
                e.stopPropagation();
                console.warn('[AntiProxy] Blocked keyboard shortcut:', key);
            }
        };

        // 2. Block right-click (prevents inspect element)
        const handleContextMenu = (e) => {
            e.preventDefault();
            return false;
        };

        // 3. Block text selection during attendance session
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';

        // 4. DevTools detection — check every 1 second if window dimensions reveal docked DevTools
        let devToolsCheckInterval = null;
        if (!isNativeApp) {
            const DEVTOOLS_THRESHOLD = 160;
            devToolsCheckInterval = setInterval(() => {
                const widthDiff = window.outerWidth - window.innerWidth;
                const heightDiff = window.outerHeight - window.innerHeight;
                if (widthDiff > DEVTOOLS_THRESHOLD || heightDiff > DEVTOOLS_THRESHOLD) {
                    handleViolationTrigger('DEVTOOLS_OPENED');
                }
            }, 1000);
        }

        // 5. iOS native: screen capture / recording detection → immediate disqualify
        let iosScreenCaptureCleanup = null;
        if (isNativeApp && isIOSDevice()) {
            addScreenCaptureListener((captureData) => {
                if (captureData.isCaptured) {
                    console.error('[AntiProxy] Screen recording/capture detected on iOS — disqualifying.');
                    if (activeSessionId) {
                        recordSessionViolation(activeSessionId, user?.uid, loggedInRollNo, 'SCREEN_CAPTURE_DETECTED');
                    }
                    // Immediate disqualification — no warning
                    try { localStorage.removeItem(`smartattend_qr1_auth_${activeSessionId}`); } catch (_) { }
                    try { sessionStorage.removeItem(`smartattend_qr1_auth_${activeSessionId}`); } catch (_) { }
                    releaseAllMediaTracks();
                    Kiosk.startKioskMode().catch(() => { });
                    setErrorMessage('❌ Screen recording detected and blocked. Attendance Disqualified. Device remains locked until Lecturer unlocks.');
                    setScanState('DISQUALIFIED');
                }
            }).then((cleanup) => { iosScreenCaptureCleanup = cleanup; });
        }

        document.addEventListener('keydown', handleKeyDown, true);
        document.addEventListener('contextmenu', handleContextMenu);
        // ─────────────────────────────────────────────────────────────────────

        return () => {
            if (appStateHandle && typeof appStateHandle.remove === 'function') appStateHandle.remove();
            if (typeof iosAppSwitchCleanup === 'function') iosAppSwitchCleanup();
            if (typeof iosScreenCaptureCleanup === 'function') iosScreenCaptureCleanup();
            if (devToolsCheckInterval) clearInterval(devToolsCheckInterval);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('blur', handleBlur);
            window.removeEventListener('focus', handleFocus);
            document.removeEventListener('keydown', handleKeyDown, true);
            document.removeEventListener('contextmenu', handleContextMenu);
            document.body.style.userSelect = '';
            document.body.style.webkitUserSelect = '';
        };
    }, [scanState, isNativeApp, activeSessionId, user, loggedInRollNo, violationCount]);

    // Mobile Web App Auto-Launch (If opened via phone camera or Chrome)
    useEffect(() => {
        if (typeof window !== 'undefined' && !isNativeApp) {
            const isAndroid = /Android/i.test(navigator.userAgent);
            const session = searchParams.get('session');
            if (isAndroid) {
                setShowAppBanner(true);
                if (session) {
                    const qr1 = searchParams.get('qr1Token') || '';
                    const qr2 = searchParams.get('qr2Token') || '';
                    const phase = searchParams.get('phase') || '';
                    const currentUrl = window.location.href;
                    const intentUrl = `intent://student/mark-attendance?session=${encodeURIComponent(session)}&qr1Token=${encodeURIComponent(qr1)}&qr2Token=${encodeURIComponent(qr2)}&phase=${encodeURIComponent(phase)}#Intent;scheme=smartattend;package=com.smartattend.app;S.browser_fallback_url=${encodeURIComponent(currentUrl)};end`;
                    try {
                        window.location.href = intentUrl;
                    } catch (e) {
                        console.warn('[AutoLaunch] Intent redirect error:', e);
                    }
                }
            }
        }
    }, [isNativeApp, searchParams]);

    const handleOpenInSmartAttendApp = () => {
        const currentUrl = window.location.href;
        const session = searchParams.get('session') || activeSessionId || '';
        const qr1 = searchParams.get('qr1Token') || '';
        const qr2 = searchParams.get('qr2Token') || activeQr2Token || '';
        const phase = searchParams.get('phase') || '';

        // Android Chrome Intent:
        // If SmartAttend App is installed -> Directly launches native app!
        // If SmartAttend App is NOT installed -> Stays seamlessly on fallback webpage!
        const intentUrl = `intent://student/mark-attendance?session=${encodeURIComponent(session)}&qr1Token=${encodeURIComponent(qr1)}&qr2Token=${encodeURIComponent(qr2)}&phase=${encodeURIComponent(phase)}#Intent;scheme=smartattend;package=com.smartattend.app;S.browser_fallback_url=${encodeURIComponent(currentUrl)};end`;

        window.location.href = intentUrl;
    };

    // Subscribe to Session document updates
    useEffect(() => {
        if (!activeSessionId) return;
        const unsub = subscribeToSession(activeSessionId, (data) => {
            setSessionData(data);
            if (data.sessionStartAt && !sessionStartAt) {
                const startMs = typeof data.sessionStartAt.toMillis === 'function' ? data.sessionStartAt.toMillis() : data.sessionStartAt;
                setSessionStartAt(startMs);
            }
            if (data.kioskEndsAt) {
                const endMs = typeof data.kioskEndsAt.toMillis === 'function' ? data.kioskEndsAt.toMillis() : data.kioskEndsAt;
                if (endMs && endMs !== kioskEndsAt) {
                    setKioskEndsAt(endMs);
                }
            }
            // If lecturer ends the session in real-time or releases student
            const cleanRoll = (loggedInRollNo || '').trim().toUpperCase();
            const studentUid = user?.uid;
            if (
                data.status === 'CLOSED' || data.phase === 'CLOSED' || data.isClosed === true ||
                data.released === true ||
                (cleanRoll && data.releasedStudents?.[cleanRoll] === true) ||
                (studentUid && data.releasedStudents?.[studentUid] === true)
            ) {
                console.log('[Kiosk] Session closed or student released by Lecturer. Automatically unlocking Kiosk mode...');
                try { localStorage.removeItem('smartattend_kiosk_session_state'); } catch (_) { }
                try { sessionStorage.removeItem(`smartattend_qr1_auth_${activeSessionId}`); } catch (_) { }
                try { localStorage.removeItem(`smartattend_qr1_auth_${activeSessionId}`); } catch (_) { }
                releaseCameraLock();
                releaseAllMediaTracks();
                Kiosk.stopKioskMode().catch(() => { });
                Kiosk.clearAttendanceRestrictions().catch(() => { });
                navigate('/student', { replace: true });
            }
        });
        return () => unsub();
    }, [activeSessionId, sessionStartAt, kioskEndsAt, loggedInRollNo, user?.uid, navigate]);

    // Subscribe to Individual Student Authorization for Remote Release by Lecturer
    useEffect(() => {
        if (!activeSessionId) return;
        const studentUid = user?.uid;
        const cleanRoll = (loggedInRollNo || '').trim().toUpperCase();
        if (!studentUid && !cleanRoll) return;

        const handleReleaseTriggered = () => {
            console.log('[Kiosk] Individual device release authorized by Lecturer. Unlocking Kiosk mode...');
            try { localStorage.removeItem('smartattend_kiosk_session_state'); } catch (_) { }
            try { sessionStorage.removeItem(`smartattend_qr1_auth_${activeSessionId}`); } catch (_) { }
            try { localStorage.removeItem(`smartattend_qr1_auth_${activeSessionId}`); } catch (_) { }
            releaseCameraLock();
            releaseAllMediaTracks();
            Kiosk.stopKioskMode().catch(() => { });
            Kiosk.clearAttendanceRestrictions().catch(() => { });
            navigate('/student', { replace: true });
        };

        const unsubs = [];
        if (studentUid) {
            unsubs.push(subscribeToStudentAuthorization(activeSessionId, studentUid, (authData) => {
                if (authData && (authData.released === true || authData.status === 'RELEASED')) {
                    handleReleaseTriggered();
                }
            }));
        }
        if (cleanRoll && cleanRoll !== studentUid) {
            unsubs.push(subscribeToStudentAuthorization(activeSessionId, cleanRoll, (authData) => {
                if (authData && (authData.released === true || authData.status === 'RELEASED')) {
                    handleReleaseTriggered();
                }
            }));
        }

        return () => {
            unsubs.forEach((u) => { try { u(); } catch (_) { } });
        };
    }, [activeSessionId, user?.uid, loggedInRollNo, navigate]);

    // Parse Scanned String / URL
    const parseScannedPayload = (raw) => {
        if (!raw) return null;
        let sessionId = null;
        let qr1Token = null;
        let qr2Token = null;
        let phase = null;

        let geo = null;
        try {
            let urlObj = null;
            if (raw.startsWith('http://') || raw.startsWith('https://')) {
                urlObj = new URL(raw);
            } else if (raw.includes('session=') || raw.includes('?')) {
                urlObj = new URL(raw, window.location.origin);
            }

            if (urlObj) {
                sessionId = urlObj.searchParams.get('session');
                qr1Token = urlObj.searchParams.get('qr1Token');
                qr2Token = urlObj.searchParams.get('qr2Token');
                phase = urlObj.searchParams.get('phase');
                const gLat = urlObj.searchParams.get('geolat');
                const gLng = urlObj.searchParams.get('geolng');
                const gR = Number(urlObj.searchParams.get('geor') || 10);
                const gAcc = Number(urlObj.searchParams.get('geoacc') || 0);
                if (gLat && gLng) {
                    geo = {
                        latitude: Number(gLat),
                        longitude: Number(gLng),
                        lat: Number(gLat),
                        lng: Number(gLng),
                        radius: gR,
                        r: gR,
                        accuracy: gAcc > 0 ? gAcc : 50,
                        acc: gAcc > 0 ? gAcc : 50
                    };
                }
            }
        } catch {
            const sessMatch = raw.match(/[?&]session=([^&#]+)/);
            if (sessMatch) sessionId = sessMatch[1];
            const qr1Match = raw.match(/[?&]qr1Token=([^&#]+)/);
            if (qr1Match) qr1Token = qr1Match[1];
            const qr2Match = raw.match(/[?&]qr2Token=([^&#]+)/);
            if (qr2Match) qr2Token = qr2Match[1];
            const pMatch = raw.match(/[?&]phase=([^&#]+)/);
            if (pMatch) phase = pMatch[1];
        }

        if (!sessionId && !raw.startsWith('http') && raw.trim().length > 3) {
            sessionId = raw.trim();
        }

        return { sessionId, qr1Token, qr2Token, phase, geo };
    };

    // Dual Verification: Auto-detect device and verify against registered device preference
    const verifyDeviceIntegrity = useCallback(async (targetSessionId = '') => {
        const registeredType = profile?.deviceType || profile?.registeredDeviceType || (typeof window !== 'undefined' ? localStorage.getItem('smartattend_student_device_type') : null);
        const detectedType = detectDeviceType();

        // If a device type is registered for this student, verify against current runtime
        if (registeredType && !isDeviceMatching(registeredType, detectedType)) {
            let clientIp = 'Unknown IP';
            try {
                clientIp = await getClientIpAddress();
            } catch (_) { }

            const regLabel = getDeviceDisplayName(registeredType);
            const curLabel = getDeviceDisplayName(detectedType || 'web');

            console.error(`[AntiProxy] Device mismatch: Registered as ${regLabel}, attempted from ${curLabel} (IP: ${clientIp})`);

            // 1. Send real-time security alert to Faculty & Admins
            try {
                await sendFacultyNotification(
                    `🚨 Anti-Proxy Alert: Device Mismatch for ${loggedInName} (${loggedInRollNo})`,
                    `Student ${loggedInName} (${loggedInRollNo}) attempted attendance from an unauthorized device.\n• Registered Device: ${regLabel}\n• Attempted Device: ${curLabel}\n• IP Address: ${clientIp}\n• User-Agent: ${navigator.userAgent}\n• Session ID: ${targetSessionId || activeSessionId || 'Active Scan'}\n\nAttendance scan was blocked to prevent proxy.`,
                    'DEVICE_MISMATCH_SECURITY_ALERT',
                    loggedInRollNo,
                    'Anti-Proxy Sentinel'
                );
            } catch (e) {
                console.warn('Faculty notif notice:', e);
            }

            // 2. Send real-time notification to the Student
            try {
                await sendStudentNotification(
                    loggedInRollNo,
                    '⚠️ Different Phone Detected',
                    `Attendance could not be marked because your account is linked to a ${regLabel}, but you scanned using a ${curLabel}.\n\nIf you got a new phone, please ask your teacher or administrator to reset your registered phone.`,
                    'SECURITY_ALERT',
                    'Attendance Security'
                );
            } catch (e) {
                console.warn('Student notif notice:', e);
            }

            // 3. Log security complaint
            try {
                await reportUserVerificationComplaint(
                    { email: user?.email, rollNo: loggedInRollNo, name: loggedInName },
                    `Device Mismatch: Registered as ${regLabel} but attempted attendance from ${curLabel} (IP: ${clientIp})`,
                    'ATTENDANCE_SCANNER_DEVICE_GUARD'
                );
            } catch (e) {
                console.warn('Complaint logging notice:', e);
            }

            const err = `❌ Device Mismatch Blocked: Your account is locked to a registered ${regLabel}. You cannot mark attendance from a ${curLabel} (IP: ${clientIp}). This unauthorized proxy attempt has been reported to your Lecturer and Administrator.`;
            setErrorMessage(err);
            return false;
        }
        return true;
    }, [profile?.deviceType, profile?.registeredDeviceType, loggedInName, loggedInRollNo, user?.email, activeSessionId]);

    // 1. Process Phase 1 QR 1: Check-in & Start Lock Task Kiosk
    const handleProcessQR1 = async (sessionId, qr1Token, coords = null) => {
        if (!user) {
            setErrorMessage('Please log in with your student account to authorize attendance.');
            return;
        }

        // Strictly verify device platform integrity before proceeding
        const deviceValid = await verifyDeviceIntegrity(sessionId);
        if (!deviceValid) return;

        // Strictly verify overlay permission on personal Android devices before initiating Kiosk Lock
        if (isNativeApp && !deviceOwnerStatus.isDeviceOwner && !overlayStatus.canDraw) {
            setErrorMessage('🛡️ Attendance Lock Guard Required: Please tap "Enable Lock Mode Permission" above to allow SmartAttend to securely lock your device during attendance.');
            return;
        }

        // Strictly prevent re-scanning QR 1 if already checked in or waiting for QR 2
        if (scanState === 'KIOSK_WAITING_QR2' || scanState === 'VALIDATING_QR2' || scanState === 'BIOMETRIC_SCAN' || scanState === 'ATTENDANCE_SUCCESS' || (activeSessionId && activeSessionId === sessionId)) {
            console.log('[Scanner] QR 1 ignored: Student already authorized for Phase 1. Waiting for QR 2 release.');
            return;
        }

        setScanState('AUTHORIZING_QR1');
        setErrorMessage('');

        try {
            let clientIp = 'Unknown IP';
            try { clientIp = await getClientIpAddress(); } catch (_) { }

            const studentProfileOverride = {
                rollNo: loggedInRollNo,
                name: loggedInName,
                email: user.email || '',
                deviceId: deviceIdentity?.deviceId || null,
                deviceIp: clientIp,
                deviceType: profile?.deviceType || profile?.registeredDeviceType || (typeof window !== 'undefined' ? localStorage.getItem('smartattend_student_device_type') : null),
                isDeviceOwner: deviceOwnerStatus.isDeviceOwner,
                studentLocation: coords ? {
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    accuracy: coords.accuracy
                } : null
            };

            const result = await authorizeStudentQR1(sessionId, qr1Token, studentProfileOverride);

            setActiveSessionId(sessionId);
            setSessionStartAt(result.sessionStartAt || Date.now());
            setKioskEndsAt(result.kioskEndsAt || (Date.now() + 180000));

            // Start Android Lock Task Mode, Web Supervision & Device Policy Restrictions
            try {
                console.log('[Kiosk] Activating Native Android Lock Task / Dedicated Kiosk mode for Student...');
                await Kiosk.setAttendanceRestrictions();
                await Kiosk.startKioskMode();
            } catch (kioskErr) {
                console.warn('[Kiosk] Notice starting kiosk mode:', kioskErr);
            }

            // Device Owner: disable screen capture/recording at OS level
            try { await Kiosk.setScreenCaptureDisabled({ disabled: true }); } catch (_) { }

            // Pre-fetch student biometric template
            try {
                await lookupStudentBiometrics(result.rollNo || loggedInRollNo);
            } catch (bioErr) {
                console.warn('Biometrics lookup notice:', bioErr);
            }

            // iOS Apple Guided Access Check: Only enforce for native iOS app, never web Safari
            if (isNativeApp && isIOSDevice()) {
                const gaStatus = await isGuidedAccessEnabled();
                if (!gaStatus.enabled) {
                    console.log('[GuidedAccess] iOS native app detected with Guided Access OFF. Displaying lock requirement screen.');
                    setShowGuidedAccessRequired(true);
                    return;
                }
            }

            // Move to Kiosk Supervised Waiting state (QR 1 is now permanently closed for this session)
            setScanState('KIOSK_WAITING_QR2');
        } catch (err) {
            console.error('Error authorizing QR 1:', err);
            setErrorMessage(err.message || 'Could not authorize Phase 1 check-in. Please verify session is active.');
            setScanState('IDLE');
        }
    };

    // Dual Biometric Combo: Step 1 Hardware Fingerprint Verification Handler
    const handleTriggerFingerprint = useCallback(async () => {
        setFingerprintVerifying(true);
        setFingerprintError('');
        try {
            const hardwareBio = await verifyHardwareBiometric(user?.uid, "SmartAttend Classroom Verification");
            if (!hardwareBio.success) {
                setFingerprintError(hardwareBio.message || "❌ Hardware fingerprint authentication failed. Please touch the sensor again.");
                setFingerprintVerifying(false);
                return;
            }
            setHardwareProof(hardwareBio);
            setFingerprintVerifying(false);
            // Celebratory visual transition to Step 2 (Face Scan)
            setTimeout(() => {
                setBiometricComboStep('FACE');
            }, 850);
        } catch (bioErr) {
            console.warn("[Scanner] Hardware biometric notice:", bioErr);
            setFingerprintError(bioErr.message || "Fingerprint authentication error.");
            setFingerprintVerifying(false);
        }
    }, [user?.uid]);

    // Auto-trigger fingerprint prompt when entering Step 1
    useEffect(() => {
        if (scanState === 'BIOMETRIC_SCAN' && biometricComboStep === 'FINGERPRINT') {
            if (!hardwareProof && !fingerprintAutoTriggeredRef.current) {
                fingerprintAutoTriggeredRef.current = true;
                handleTriggerFingerprint();
            }
        } else if (scanState !== 'BIOMETRIC_SCAN') {
            fingerprintAutoTriggeredRef.current = false;
        }
    }, [scanState, biometricComboStep, hardwareProof, handleTriggerFingerprint]);

    // 2. Process Phase 2 QR 2: Gate verification & open Face Biometric Scanner
    const handleProcessQR2 = async (sessionId, qr2Token) => {
        if (!user) {
            setErrorMessage('Please log in to submit attendance.');
            return;
        }

        // Strictly verify device platform integrity before validating QR2
        const deviceValid = await verifyDeviceIntegrity(sessionId);
        if (!deviceValid) return;

        // Prevent redundant QR 2 validations if already scanning biometrics or submitted
        if (scanState === 'VALIDATING_QR2' || scanState === 'BIOMETRIC_SCAN' || scanState === 'ATTENDANCE_SUCCESS') {
            return;
        }

        // Immediately release QR camera tracks before async network calls to avoid camera ISP conflict
        setScannerActive(false);
        releaseCameraLock();
        releaseAllMediaTracks();
        setScanState('VALIDATING_QR2');
        setErrorMessage('');

        try {
            const targetSession = sessionId || activeSessionId;
            if (!targetSession) {
                throw new Error("No active attendance session identified.");
            }
            const result = await validateStudentQR2(targetSession, qr2Token);

            setActiveSessionId(targetSession);
            setActiveQr2Token(qr2Token);
            if (result.kioskEndsAt) setKioskEndsAt(result.kioskEndsAt);

            // Ensure biometrics are loaded
            await lookupStudentBiometrics(result.rollNo || loggedInRollNo);

            // Release silent camera lock before biometric — front camera needs to open
            releaseCameraLock();
            // Device Owner: re-enable OS-level camera policy so front camera can be used for face scan
            try { await Kiosk.enableCamera(); } catch (_) { }

            // Explicitly release previous QR camera tracks to avoid camera resource collision
            releaseAllMediaTracks();
            setScannerActive(false);

            // Safe cooldown to allow Android Camera Service to complete HAL disconnection from rear camera
            await new Promise((resolve) => setTimeout(resolve, 350));

            // Enter Fast Biometric Verification: Direct Face Scan (< 1s)
            fingerprintAutoTriggeredRef.current = false;
            setBiometricComboStep('FACE');
            setFingerprintError('');
            setScanState('BIOMETRIC_SCAN');
        } catch (err) {
            console.error('Error validating QR 2:', err);
            const msg = err.message || '';
            if (msg.includes('QR 1') || msg.includes('Access denied') || msg.includes('Access Denied') || msg.includes('permission-denied')) {
                setErrorMessage('⛔ Access Denied: You did not scan QR 1 during Phase 1 (0:00 - 1:00). You cannot mark attendance for this session.');
            } else {
                setErrorMessage(msg || 'Invalid Phase 2 QR code.');
            }
            setScanState(activeSessionId ? 'KIOSK_WAITING_QR2' : 'IDLE');
        }
    };

    // Master Scan Handler with Dynamic Token Expiry & Geofence Enforcement
    const processSessionString = async (raw) => {
        if (!raw) return;

        // 1. Validate Dynamic Rotating Token and Expiry Window
        const validation = await validateRotatingQrPayload(raw);
        if (!validation.valid) {
            console.warn('[Scanner] Rotating QR token validation failed:', validation.error);
            setErrorMessage(validation.message || '❌ Invalid or expired QR code.');
            return;
        }

        const payload = validation.payload || parseScannedPayload(raw);
        if (!payload || !payload.sessionId) {
            setErrorMessage('Invalid QR code format. Please scan a valid SmartAttend session QR code.');
            return;
        }

        // 2. Geofence Check (Enforces classroom boundary with indoor tolerance)
        let studentCoords = null;
        const classroomTarget = payload.geo || sessionData?.classroomLocation;
        const isGeofenceDisabled = sessionData?.geofenceRadius === 0 || classroomTarget?.radius === 0 || classroomTarget?.enabled === false;
        if (classroomTarget && !isGeofenceDisabled) {
            try {
                const getCoords = async () => {
                    const cached = prewarmedLocationRef.current;
                    // If cached fix is fresh (under 35s), return immediately without blocking!
                    if (cached && (Date.now() - cached.timestamp < 35000)) {
                        return cached;
                    }
                    return new Promise((resolve) => {
                        if (typeof navigator === "undefined" || !navigator.geolocation) {
                            resolve(cached || null);
                            return;
                        }
                        let resolved = false;
                        const safetyTimer = setTimeout(() => {
                            if (!resolved) {
                                resolved = true;
                                resolve(prewarmedLocationRef.current || cached || null);
                            }
                        }, 2500);

                        navigator.geolocation.getCurrentPosition(
                            (pos) => {
                                if (resolved) return;
                                resolved = true;
                                clearTimeout(safetyTimer);
                                const fresh = {
                                    latitude: pos.coords.latitude,
                                    longitude: pos.coords.longitude,
                                    lat: pos.coords.latitude,
                                    lng: pos.coords.longitude,
                                    accuracy: Number(pos.coords.accuracy) || 20,
                                    timestamp: Date.now()
                                };
                                prewarmedLocationRef.current = fresh;
                                resolve(fresh);
                            },
                            () => {
                                if (resolved) return;
                                resolved = true;
                                clearTimeout(safetyTimer);
                                resolve(prewarmedLocationRef.current || cached || null);
                            },
                            { enableHighAccuracy: true, timeout: 2500, maximumAge: 15000 }
                        );
                    });
                };
                studentCoords = await getCoords();
                const geoEval = evaluateGeofence(studentCoords, classroomTarget, geofenceRetriesRef.current);

                if (geoEval.status === "MOCK_DETECTED") {
                    console.error("[Geofence] Mock location detected!");
                    if (activeSessionId || payload.sessionId) {
                        recordSessionViolation(activeSessionId || payload.sessionId, user?.uid, loggedInRollNo, "MOCK_LOCATION_DETECTED");
                    }
                    setErrorMessage(geoEval.message);
                    return;
                }
                if (geoEval.status === "REJECT") {
                    console.error("[Geofence] Geofence rejected:", geoEval);
                    setErrorMessage(geoEval.message);
                    return;
                }
                if (geoEval.status === "INCONCLUSIVE_RETRY") {
                    geofenceRetriesRef.current = (geofenceRetriesRef.current || 0) + 1;
                    if (geoEval.canRetry) {
                        setErrorMessage(geoEval.message);
                        return;
                    } else {
                        // Max retries reached indoors: since student is scanning the 10-second rotating QR directly in front of the projector screen,
                        // allow attendance to proceed with an indoor proximity notice rather than permanently blocking them
                        console.warn("[Geofence] Indoor GPS inconclusive after retries. Proceeding with classroom proximity audit flag.");
                    }
                }
            } catch (geoErr) {
                console.warn("[Geofence] Check notice:", geoErr);
            }
        }

        // 3. If student is already checked in (in Kiosk Mode waiting for QR 2):
        // STRICTLY IGNORE any QR 1 scans until QR 2 is released by lecturer!
        if (scanState === 'KIOSK_WAITING_QR2' || activeSessionId) {
            const isQR2 = Boolean(payload.qr2Token || payload.phase === '2' || payload.phase === 'PHASE_2' || (sessionData?.phase === 'PHASE_2' && payload.sessionId === activeSessionId));
            const isQR1 = Boolean(payload.qr1Token || payload.phase === '1' || payload.phase === 'PHASE_1');

            if (!isQr2Released) {
                console.log('[Scanner] QR scan blocked: Phase 2 has not been released yet.');
                setErrorMessage('QR 2 is not yet released. Scanning is paused until your lecturer begins Phase 2.');
                return;
            }

            if (isQR2) {
                console.log('[Scanner] Phase 2 (QR 2) scanned successfully. Proceeding to biometrics...');
                handleProcessQR2(payload.sessionId || activeSessionId, payload.qr2Token || payload.sessionId);
            } else if (isQR1) {
                // QR 1 is explicitly blocked from re-scanning!
                console.log('[Scanner] QR 1 ignored. Student already completed Phase 1 check-in. Waiting for Lecturer to display QR 2.');
                setErrorMessage('You have already scanned QR 1. Please scan QR 2 displayed on the screen.');
            } else if (sessionData?.phase === 'PHASE_2') {
                handleProcessQR2(payload.sessionId || activeSessionId, payload.qr2Token || payload.sessionId);
            }
            return;
        }

        // 4. Initial state (student has not scanned QR 1 yet):
        if (payload.qr1Token || payload.phase === '1' || payload.phase === 'PHASE_1') {
            handleProcessQR1(payload.sessionId, payload.qr1Token, studentCoords);
        } else if (payload.qr2Token || payload.phase === '2' || payload.phase === 'PHASE_2') {
            handleProcessQR2(payload.sessionId, payload.qr2Token);
        } else {
            handleProcessQR1(payload.sessionId, payload.sessionId, studentCoords);
        }
    };

    // Auto-check URL search params on mount (e.g. if student opened link directly)
    useEffect(() => {
        if (loading) return;
        if (!user) return;

        const urlSession = searchParams.get('session');
        const urlQr1 = searchParams.get('qr1Token');
        const urlQr2 = searchParams.get('qr2Token');
        const urlPhase = searchParams.get('phase');

        if (urlSession && (urlQr1 || urlPhase === '1')) {
            handleProcessQR1(urlSession, urlQr1 || urlSession);
        } else if (urlSession && (urlQr2 || urlPhase === '2')) {
            handleProcessQR2(urlSession, urlQr2 || urlSession);
        }
    }, [searchParams, loading, user]);

    const processSessionStringRef = useRef(processSessionString);
    useEffect(() => {
        processSessionStringRef.current = processSessionString;
    }, [processSessionString]);

    const handleCameraScan = useCallback((result) => {
        if (!result) return;
        const raw = result[0]?.rawValue || (typeof result === 'string' ? result : '');
        if (raw) {
            if (processSessionStringRef.current) {
                processSessionStringRef.current(raw);
            }
        }
    }, []);

    const handleCameraError = useCallback((error) => {
        console.warn('Scanner Error:', error);
        const errName = error?.name || '';
        const errMsg = error?.message || String(error);

        if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError' || errMsg.toLowerCase().includes('permission')) {
            setPermissionDenied(true);
            setCameraError("Camera permission blocked on HTTP. Use 'Snap / Upload QR Photo' below for instant scan!");
        } else if (errName === 'OverconstrainedError' || errMsg.toLowerCase().includes('constraint')) {
            setRetryKey((k) => k + 1);
        } else {
            setCameraError('WebRTC camera stream unavailable. Please use the camera snap button below.');
        }
    }, []);

    const handleFileScan = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setScanningFile(true);
        setCameraError('');

        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || img.width;
                    canvas.height = img.naturalHeight || img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const code = jsQR(imageData.data, imageData.width, imageData.height, {
                        inversionAttempts: 'attemptBoth'
                    });

                    setScanningFile(false);
                    if (code && code.data) {
                        processSessionString(code.data);
                    } else {
                        setCameraError('❌ Could not detect QR code in photo. Please point camera directly at the QR code and snap again.');
                    }
                } catch (decodeErr) {
                    console.error('QR decode error:', decodeErr);
                    setScanningFile(false);
                    setCameraError('Error reading QR image.');
                }
            };
            img.onerror = () => {
                setScanningFile(false);
                setCameraError('Failed to load photo.');
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    };

    // 3. Handle Live Face Biometric Verification change & submit attendance
    const handleFaceVerificationChange = useCallback(async (res) => {
        if (res && res.verified) {
            // Auto-submit verified attendance
            if (!submittingAttendance) {
                setSubmittingAttendance(true);
                releaseAllMediaTracks();
                try {
                    const submissionResult = await submitVerifiedAttendance(
                        activeSessionId,
                        activeQr2Token || activeSessionId,
                        {
                            confidence: res.confidence || 100,
                            distance: res.distance || 0.35,
                            liveness: res.liveness === true,
                            blinkCount: res.blinkCount || 1,
                            liveDescriptor: res.liveDescriptor || null,
                            faceDescriptor: res.liveDescriptor || null,
                            verified: true,
                            antiSpoofScore: "PASSED"
                        },
                        hardwareProof
                    );

                    const submittedMs = submissionResult.submittedAt || submissionResult.attendanceSubmittedAt || Date.now();
                    const autoReleaseMs = submissionResult.autoReleaseAt || (submittedMs + 5 * 60 * 1000);

                    setAttendanceSubmittedAt(submittedMs);
                    setAutoReleaseAt(autoReleaseMs);
                    setAutoReleaseRemaining(Math.max(0, Math.floor((autoReleaseMs - Date.now()) / 1000)));

                    setSubmissionDetails({
                        rollNo: submissionResult.rollNo || loggedInRollNo,
                        studentName: submissionResult.studentName || loggedInName,
                        courseCode: sessionData?.courseCode || 'CLASS',
                        classCode: sessionData?.classCode || '',
                        roomNo: sessionData?.roomNo || 'C002',
                        submittedAt: submittedMs,
                        autoReleaseAt: autoReleaseMs
                    });

                    // Keep device in Lock Task Mode
                    setScanState('ATTENDANCE_SUCCESS');
                } catch (subErr) {
                    console.error('Attendance submission error:', subErr);
                    alert('❌ Attendance submission notice: ' + (subErr.message || 'Error recording attendance'));
                    if (subErr.message?.includes('QR 1') || subErr.message?.includes('Access Denied') || subErr.message?.includes('Missing Phase 1')) {
                        setErrorMessage(subErr.message);
                        setScanState('IDLE');
                    }
                } finally {
                    setSubmittingAttendance(false);
                }
            }
        }
    }, [activeSessionId, activeQr2Token, submittingAttendance, loggedInRollNo, loggedInName, sessionData, hardwareProof]);

    const formatMmSs = (sec) => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    };

    // Render Lecturer Emergency PIN Release Modal
    const renderLecturerPinModal = () => {
        if (!showPinModal) return null;
        return (
            <div style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(15, 23, 42, 0.85)',
                backdropFilter: 'blur(8px)',
                zIndex: 10000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '20px'
            }}>
                <div style={{
                    maxWidth: '400px',
                    width: '100%',
                    background: '#ffffff',
                    borderRadius: '20px',
                    padding: '26px 24px',
                    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
                    textAlign: 'center',
                    color: '#0f172a'
                }}>
                    <div style={{
                        width: '56px',
                        height: '56px',
                        borderRadius: '50%',
                        background: 'rgba(99, 102, 241, 0.12)',
                        color: '#6366f1',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '24px',
                        margin: '0 auto 12px'
                    }}>
                        <FaLock />
                    </div>
                    <h3 style={{ margin: '0 0 6px', fontSize: '1.25rem', fontWeight: 800 }}>
                        Lecturer Session PIN Unlock
                    </h3>
                    <p style={{ margin: '0 0 16px', fontSize: '0.84rem', color: '#64748b', lineHeight: 1.4 }}>
                        Enter the 6-digit Session PIN displayed on the Lecturer Dashboard to unlock this device from Kiosk mode.
                    </p>

                    <form onSubmit={handleLecturerPinUnlock}>
                        <input
                            type="password"
                            maxLength={6}
                            value={lecturerPinInput}
                            onChange={(e) => setLecturerPinInput(e.target.value)}
                            placeholder="Enter 6-digit Session PIN"
                            autoFocus
                            style={{
                                width: '100%',
                                padding: '12px 16px',
                                borderRadius: '12px',
                                border: '1.5px solid #cbd5e1',
                                fontSize: '1.2rem',
                                letterSpacing: '4px',
                                textAlign: 'center',
                                fontWeight: 800,
                                marginBottom: '12px',
                                outline: 'none'
                            }}
                        />

                        {pinVerificationError && (
                            <div style={{
                                padding: '8px 12px',
                                borderRadius: '8px',
                                background: '#fee2e2',
                                color: '#b91c1c',
                                fontSize: '0.82rem',
                                fontWeight: 700,
                                marginBottom: '12px'
                            }}>
                                {pinVerificationError}
                            </div>
                        )}

                        <div style={{ display: 'flex', gap: '10px' }}>
                            <button
                                type="button"
                                onClick={() => {
                                    setShowPinModal(false);
                                    setLecturerPinInput('');
                                    setPinVerificationError('');
                                }}
                                style={{
                                    flex: 1,
                                    padding: '11px',
                                    borderRadius: '12px',
                                    background: '#f1f5f9',
                                    border: '1px solid #cbd5e1',
                                    color: '#475569',
                                    fontWeight: 700,
                                    fontSize: '0.9rem',
                                    cursor: 'pointer'
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={isVerifyingPin}
                                style={{
                                    flex: 1,
                                    padding: '11px',
                                    borderRadius: '12px',
                                    background: '#6366f1',
                                    border: 'none',
                                    color: '#ffffff',
                                    fontWeight: 800,
                                    fontSize: '0.9rem',
                                    cursor: 'pointer',
                                    boxShadow: '0 4px 14px rgba(99, 102, 241, 0.4)'
                                }}
                            >
                                {isVerifyingPin ? <FaSpinner className="fa-spin" /> : 'Authorize Release'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        );
    };

    // =========================================================================
    // UI VIEW -0: MANDATORY APP UPDATE BLOCK SCREEN
    // =========================================================================
    if (versionBlock) {
        return (
            <div style={{
                maxWidth: '540px',
                margin: '30px auto',
                padding: '32px 24px',
                background: 'var(--surface, #ffffff)',
                borderRadius: '24px',
                border: '1.5px solid #ef4444',
                boxShadow: '0 25px 50px -12px rgba(239, 68, 68, 0.25)',
                color: 'var(--text-main, #0f172a)',
                textAlign: 'center',
                position: 'relative'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', marginBottom: '16px' }}>
                    <button
                        type="button"
                        onClick={() => navigate('/student')}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--accent, #6366f1)',
                            fontSize: '0.9rem',
                            fontWeight: 700,
                            cursor: 'pointer'
                        }}
                    >
                        <FaArrowLeft /> Back to Dashboard
                    </button>
                </div>

                <div style={{
                    width: '76px',
                    height: '76px',
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)',
                    color: '#ffffff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 16px',
                    fontSize: '36px',
                    boxShadow: '0 8px 24px rgba(239, 68, 68, 0.35)'
                }}>
                    <FaExclamationTriangle />
                </div>

                <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 14px',
                    borderRadius: '999px',
                    background: '#fee2e2',
                    color: '#dc2626',
                    fontSize: '0.82rem',
                    fontWeight: 800,
                    marginBottom: '12px'
                }}>
                    Update Required
                </div>

                <h2 style={{ fontSize: '1.45rem', fontWeight: 800, color: '#0f172a', margin: '0 0 8px' }}>
                    SmartAttend Update Required
                </h2>
                <p style={{ fontSize: '0.9rem', color: '#475569', lineHeight: 1.5, margin: '0 0 20px' }}>
                    {versionBlock.mandatoryReason}
                </p>

                <div style={{
                    background: 'var(--surface-soft, #f8fafc)',
                    border: '1px solid #e2e8f0',
                    borderRadius: '16px',
                    padding: '16px',
                    marginBottom: '20px',
                    textAlign: 'left',
                    fontSize: '0.85rem'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ color: '#64748b', fontWeight: 600 }}>Your App Version:</span>
                        <strong style={{ color: '#dc2626' }}>v{versionBlock.currentVersion}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#64748b', fontWeight: 600 }}>Required Minimum:</span>
                        <strong style={{ color: '#10b981' }}>v{versionBlock.minVersion}</strong>
                    </div>
                </div>

                <button
                    type="button"
                    onClick={() => setShowUpdateModalFromScanner(true)}
                    style={{
                        width: '100%',
                        padding: '14px',
                        borderRadius: '14px',
                        background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
                        color: '#ffffff',
                        border: 'none',
                        fontSize: '0.95rem',
                        fontWeight: 700,
                        cursor: 'pointer',
                        marginBottom: '10px',
                        boxShadow: '0 8px 18px rgba(99, 102, 241, 0.35)'
                    }}
                >
                    Update SmartAttend Now (.apk)
                </button>

                <button
                    type="button"
                    onClick={() => navigate('/student/support')}
                    style={{
                        width: '100%',
                        padding: '10px',
                        borderRadius: '12px',
                        background: 'transparent',
                        color: '#64748b',
                        border: '1px solid #cbd5e1',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        cursor: 'pointer'
                    }}
                >
                    Emergency Help &amp; Support
                </button>

                {showUpdateModalFromScanner && versionBlock.info && (
                    <AppUpdateModal
                        updateInfo={versionBlock.info}
                        onClose={() => setShowUpdateModalFromScanner(false)}
                    />
                )}
            </div>
        );
    }

    // =========================================================================
    // UI VIEW: PASSIVE APP UPDATE REQUIRED GATE
    // =========================================================================
    if (versionBlock) {
        return (
            <div style={{
                maxWidth: '540px',
                margin: '30px auto',
                padding: '32px 24px',
                background: 'var(--surface, #ffffff)',
                borderRadius: '24px',
                border: '1.5px solid #ef4444',
                boxShadow: '0 25px 50px -12px rgba(239, 68, 68, 0.25)',
                color: 'var(--text-main, #0f172a)',
                textAlign: 'center',
                position: 'relative'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', marginBottom: '16px' }}>
                    <button
                        type="button"
                        onClick={() => navigate('/student')}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--accent, #6366f1)',
                            fontSize: '0.9rem',
                            fontWeight: 700,
                            cursor: 'pointer'
                        }}
                    >
                        <FaArrowLeft /> Back to Dashboard
                    </button>
                </div>

                <div style={{
                    width: '76px',
                    height: '76px',
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                    color: '#ffffff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 16px',
                    fontSize: '36px',
                    boxShadow: '0 8px 24px rgba(239, 68, 68, 0.35)'
                }}>
                    <FaExclamationTriangle />
                </div>

                <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 14px',
                    borderRadius: '999px',
                    background: '#fee2e2',
                    color: '#dc2626',
                    fontSize: '0.82rem',
                    fontWeight: 800,
                    marginBottom: '12px'
                }}>
                    <FaLock /> Mandatory App Update Required
                </div>

                <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#0f172a', margin: '0 0 8px' }}>
                    Attendance Protocol Update Required
                </h2>
                <p style={{ fontSize: '0.9rem', color: '#475569', lineHeight: 1.5, margin: '0 0 20px' }}>
                    {versionBlock.mandatoryReason}
                </p>

                <div style={{
                    background: 'var(--surface-soft, #f8fafc)',
                    border: '1.5px solid var(--border, #e2e8f0)',
                    borderRadius: '16px',
                    padding: '16px',
                    textAlign: 'left',
                    marginBottom: '20px'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Your Installed Version:</span>
                        <strong style={{ fontSize: '0.85rem', color: '#ef4444' }}>v{versionBlock.currentVersion}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Minimum Required Version:</span>
                        <strong style={{ fontSize: '0.85rem', color: '#16a34a' }}>v{versionBlock.minVersion}</strong>
                    </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <button
                        type="button"
                        onClick={() => setShowUpdateModalFromScanner(true)}
                        style={{
                            width: '100%',
                            padding: '14px 20px',
                            borderRadius: '14px',
                            background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                            color: '#ffffff',
                            border: 'none',
                            fontWeight: 800,
                            fontSize: '1rem',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '10px',
                            boxShadow: '0 6px 20px rgba(16, 185, 129, 0.4)'
                        }}
                    >
                        <FaDownload /> Update SmartAttend Now
                    </button>

                    <button
                        type="button"
                        onClick={() => navigate('/student/support')}
                        style={{
                            width: '100%',
                            padding: '12px 20px',
                            borderRadius: '14px',
                            background: 'var(--surface-soft, #f1f5f9)',
                            color: '#334155',
                            border: '1.5px solid var(--border, #cbd5e1)',
                            fontWeight: 700,
                            fontSize: '0.9rem',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '8px'
                        }}
                    >
                        Contact Technical Support
                    </button>
                </div>

                {showUpdateModalFromScanner && (
                    <AppUpdateModal
                        updateInfo={{ ...(versionBlock.info || {}), isOpen: true }}
                        onClose={() => setShowUpdateModalFromScanner(false)}
                    />
                )}
            </div>
        );
    }

    // =========================================================================
    // UI VIEW -1: STRICT ANDROID WEB BROWSER BLOCK SCREEN
    // =========================================================================
    const isAndroidDevice = typeof navigator !== 'undefined' && (/Android/i.test(navigator.userAgent) || detectDeviceType() === 'android');
    if (!isNativeApp && isAndroidDevice) {
        return (
            <div style={{
                maxWidth: '540px',
                margin: '30px auto',
                padding: '32px 24px',
                background: 'var(--surface, #ffffff)',
                borderRadius: '24px',
                border: '1.5px solid #6366f1',
                boxShadow: '0 25px 50px -12px rgba(99, 102, 241, 0.25)',
                color: 'var(--text-main, #0f172a)',
                textAlign: 'center',
                position: 'relative'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', marginBottom: '16px' }}>
                    <button
                        type="button"
                        onClick={() => navigate('/student')}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--accent, #6366f1)',
                            fontSize: '0.9rem',
                            fontWeight: 700,
                            cursor: 'pointer'
                        }}
                    >
                        <FaArrowLeft /> Back to Dashboard
                    </button>
                </div>

                <div style={{
                    width: '76px',
                    height: '76px',
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg, #4338ca 0%, #6366f1 100%)',
                    color: '#ffffff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 16px',
                    fontSize: '36px',
                    boxShadow: '0 8px 24px rgba(99, 102, 241, 0.35)'
                }}>
                    <FaMobileAlt />
                </div>

                <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 14px',
                    borderRadius: '999px',
                    background: '#fee2e2',
                    color: '#dc2626',
                    fontSize: '0.82rem',
                    fontWeight: 800,
                    marginBottom: '12px'
                }}>
                    <FaLock /> Android Web Attendance Blocked
                </div>

                <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#0f172a', margin: '0 0 8px' }}>
                    SmartAttend Android App Required
                </h2>
                <p style={{ fontSize: '0.9rem', color: '#475569', lineHeight: 1.5, margin: '0 0 20px' }}>
                    Anti-proxy security requires attendance marking on Android devices to run inside the native <strong>SmartAttend Android App</strong> with hardware Lock Task protection. Marking attendance via mobile web browser is disabled.
                </p>

                <div style={{
                    background: 'var(--surface-soft, #f8fafc)',
                    border: '1.5px solid var(--border, #e2e8f0)',
                    borderRadius: '16px',
                    padding: '16px',
                    textAlign: 'left',
                    marginBottom: '20px'
                }}>
                    <div style={{ fontWeight: 800, color: '#4338ca', fontSize: '0.86rem', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <FaShieldAlt /> Enforced Security Measures:
                    </div>
                    <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '0.82rem', color: '#64748b', lineHeight: 1.5 }}>
                        <li>Hardware-secured <strong>Lock Task Kiosk Mode</strong> to prevent proxy attendance</li>
                        <li>Hardware-secured <strong>Live Facial Biometric</strong> verification</li>
                        <li>Real-time Device Fingerprint & IP Sentinel Verification</li>
                    </ul>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <button
                        type="button"
                        onClick={handleOpenInSmartAttendApp}
                        style={{
                            width: '100%',
                            padding: '14px 20px',
                            borderRadius: '14px',
                            background: 'linear-gradient(135deg, #6366f1 0%, #4338ca 100%)',
                            color: '#ffffff',
                            border: 'none',
                            fontWeight: 800,
                            fontSize: '1rem',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '10px',
                            boxShadow: '0 6px 20px rgba(99, 102, 241, 0.4)'
                        }}
                    >
                        <FaExternalLinkAlt /> Open in SmartAttend App
                    </button>

                    <a
                        href={getApkDownloadUrl()}
                        download="SmartAttend-release.apk"
                        style={{
                            width: '100%',
                            padding: '12px 20px',
                            borderRadius: '14px',
                            background: 'var(--surface-soft, #f1f5f9)',
                            color: '#334155',
                            border: '1.5px solid var(--border, #cbd5e1)',
                            fontWeight: 700,
                            fontSize: '0.9rem',
                            textDecoration: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '8px'
                        }}
                    >
                        <FaDownload /> Download SmartAttend Android APK (.apk)
                    </a>
                </div>
            </div>
        );
    }

    // =========================================================================
    // UI VIEW 0: iOS GUIDED ACCESS LOCK REQUIRED SCREEN
    // =========================================================================
    if (showGuidedAccessRequired) {
        return (
            <GuidedAccessRequired
                onEnabled={() => {
                    console.log('[GuidedAccess] Guided Access activated! Resuming attendance session.');
                    setShowGuidedAccessRequired(false);
                    setScanState('KIOSK_WAITING_QR2');
                }}
            />
        );
    }

    // =========================================================================
    // UI VIEW 1: ATTENDANCE SUBMITTED (Attendance Lock Active until Lecturer Release)
    // =========================================================================
    if (scanState === 'ATTENDANCE_SUCCESS') {
        return (
            <div className="st-success-card">
                <div className="st-success-icon-badge">
                    <FaCheckCircle />
                </div>

                <h2 className="st-success-title">
                    Attendance Submitted Successfully
                </h2>
                <div className="st-success-kiosk-status">
                    <FaShieldAlt style={{ color: '#10b981' }} />
                    <span>{isIOSDevice() ? 'Guided Access Active' : 'Lock Task Mode Active'} · Awaiting Release</span>
                </div>

                {/* On iOS: Guided Access Exit Guidance Notice */}
                {isIOSDevice() && <GuidedAccessExitNotice />}

                {/* Details Box */}
                <div className="st-attendance-details-box">
                    <div className="st-attendance-details-row">
                        <span className="st-attendance-details-label">Student:</span>
                        <strong className="st-attendance-details-val">{submissionDetails?.rollNo || loggedInRollNo} · {submissionDetails?.studentName || loggedInName}</strong>
                    </div>
                    <div className="st-attendance-details-row">
                        <span className="st-attendance-details-label">Class / Room:</span>
                        <strong className="st-attendance-details-val">{submissionDetails?.courseCode} · Room {submissionDetails?.roomNo}</strong>
                    </div>
                    <div className="st-attendance-details-row">
                        <span className="st-attendance-details-label">Biometrics:</span>
                        <strong className="st-attendance-details-val" style={{ color: '#15803d' }}>✅ Verified (Combo Pass)</strong>
                    </div>
                </div>

                {/* Student Enters Lecturer's Announced 6-Digit Session PIN */}
                <div className="st-pin-unlock-card">
                    <div className="st-pin-unlock-title">
                        <FaLock /> Enter Session PIN to Unlock
                    </div>
                    <p className="st-pin-unlock-desc">
                        Enter 6-digit Session PIN announced by lecturer to exit.
                    </p>

                    <form onSubmit={handleLecturerPinUnlock} style={{ maxWidth: '340px', margin: '0 auto' }}>
                        <input
                            type="password"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            maxLength={6}
                            value={lecturerPinInput}
                            onChange={(e) => {
                                setLecturerPinInput(e.target.value.replace(/\D/g, ''));
                                if (pinVerificationError) setPinVerificationError('');
                            }}
                            placeholder="6-Digit PIN"
                            autoFocus
                            className="st-pin-input-field"
                            style={pinVerificationError ? { borderColor: '#ef4444' } : {}}
                        />

                        {pinVerificationError && (
                            <div className="st-scanner-error-banner" style={{ margin: '0 auto 14px', maxWidth: '340px', textAlign: 'center' }}>
                                {pinVerificationError}
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={isVerifyingPin || !lecturerPinInput.trim()}
                            className="st-pin-submit-btn"
                            style={isVerifyingPin || !lecturerPinInput.trim() ? { opacity: 0.65, cursor: 'not-allowed' } : {}}
                        >
                            {isVerifyingPin ? (
                                <><FaSpinner className="fa-spin" /> Verifying PIN...</>
                            ) : (
                                <><FaLock /> Unlock Device</>
                            )}
                        </button>
                    </form>
                </div>

                {/* 5-Minute Fail-Safe Live Countdown */}
                <div style={{
                    background: 'var(--surface-soft, #f8fafc)',
                    border: '1.5px solid var(--border, #e2e8f0)',
                    borderRadius: '16px',
                    padding: '14px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px'
                }}>
                    <div style={{ textAlign: 'left' }}>
                        <div style={{ fontSize: '0.82rem', fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            Fail-Safe Auto Release
                        </div>
                        <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: '2px' }}>
                            Device automatically unlocks when timer expires
                        </div>
                    </div>
                    <div style={{ fontSize: '1.45rem', fontWeight: 800, color: '#4338ca', fontFamily: 'monospace' }}>
                        {formatMmSs(autoReleaseRemaining)}
                    </div>
                </div>
            </div>
        );
    }

    // =========================================================================
    // UI VIEW 1.4: SESSION ENDED AUTOMATIC RELEASE (Guarantees device is freed upon session finish)
    // =========================================================================
    if (sessionEndedAutoReleased) {
        return (
            <div style={{
                maxWidth: '540px',
                margin: '36px auto',
                padding: '36px 24px',
                background: 'var(--surface, #ffffff)',
                borderRadius: '24px',
                border: '2px solid #10b981',
                boxShadow: '0 20px 40px -10px rgba(16, 185, 129, 0.25)',
                color: 'var(--text-main, #0f172a)',
                textAlign: 'center',
                position: 'relative'
            }}>
                <div style={{
                    width: '74px',
                    height: '74px',
                    borderRadius: '50%',
                    background: '#dcfce7',
                    color: '#16a34a',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 16px',
                    fontSize: '36px',
                    boxShadow: '0 8px 20px rgba(22, 163, 74, 0.2)'
                }}>
                    <FaUnlock />
                </div>

                <h2 style={{ fontSize: '1.45rem', fontWeight: 800, margin: '0 0 8px 0', color: '#15803d' }}>
                    Session Ended · Device Released
                </h2>
                <p style={{ color: 'var(--text-muted, #64748b)', fontSize: '0.92rem', margin: '0 0 20px 0', lineHeight: 1.55 }}>
                    The attendance session has officially concluded. All kiosk mode restrictions and camera locks have been automatically cleared.
                </p>

                <button
                    type="button"
                    onClick={() => {
                        releaseCameraLock();
                        releaseAllMediaTracks();
                        Kiosk.stopKioskMode().catch(() => { });
                        Kiosk.clearAttendanceRestrictions().catch(() => { });
                        navigate('/student', { replace: true });
                    }}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '12px 24px',
                        borderRadius: '12px',
                        background: '#10b981',
                        color: '#ffffff',
                        border: 'none',
                        fontSize: '0.92rem',
                        fontWeight: 800,
                        cursor: 'pointer',
                        boxShadow: '0 4px 14px rgba(16, 185, 129, 0.35)'
                    }}
                >
                    <FaCheckCircle /> Return to Student Dashboard
                </button>
            </div>
        );
    }

    // =========================================================================
    // UI VIEW 1.5: DISQUALIFIED LOCKED SCREEN (App switching detected, locked until Lecturer PIN or Session End)
    // =========================================================================
    if (scanState === 'DISQUALIFIED') {
        return (
            <div style={{
                maxWidth: '540px',
                margin: '30px auto',
                padding: '30px 22px',
                background: 'var(--surface, #ffffff)',
                borderRadius: '24px',
                border: '2px solid #ef4444',
                boxShadow: '0 25px 50px -12px rgba(239, 68, 68, 0.25)',
                color: 'var(--text-main, #0f172a)',
                textAlign: 'center',
                position: 'relative'
            }}>
                {renderLecturerPinModal()}

                <div style={{
                    width: '72px',
                    height: '72px',
                    borderRadius: '50%',
                    background: '#fee2e2',
                    color: '#dc2626',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 16px',
                    fontSize: '38px',
                    boxShadow: '0 8px 20px rgba(220, 38, 38, 0.25)'
                }}>
                    <FaExclamationTriangle />
                </div>

                <h2 style={{ fontSize: '1.5rem', fontWeight: 800, margin: '0 0 6px 0', color: '#dc2626' }}>
                    Attendance Disqualified
                </h2>
                <p style={{ color: 'var(--text-muted, #64748b)', fontSize: '0.9rem', margin: '0 0 20px 0', lineHeight: 1.5 }}>
                    App switching or minimizing was detected during active attendance supervision.
                </p>

                <div style={{
                    background: '#fef2f2',
                    border: '1.5px solid #fecaca',
                    borderRadius: '16px',
                    padding: '16px 18px',
                    textAlign: 'left',
                    marginBottom: '16px'
                }}>
                    <div style={{ color: '#991b1b', fontSize: '0.85rem', lineHeight: 1.5 }}>
                        <strong>🔒 Attendance Lock Active:</strong> Hand your device to your course lecturer to authorize release using the Session PIN, or wait for the session to conclude.
                    </div>
                </div>

                {/* Auto-Release when Session Ends Notice */}
                <div style={{
                    background: 'rgba(99, 102, 241, 0.08)',
                    border: '1px solid rgba(99, 102, 241, 0.25)',
                    borderRadius: '14px',
                    padding: '12px 16px',
                    textAlign: 'left',
                    marginBottom: '20px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px'
                }}>
                    <FaClock style={{ color: '#6366f1', fontSize: '1.2rem', flexShrink: 0 }} />
                    <div style={{ color: '#4338ca', fontSize: '0.83rem', lineHeight: 1.45 }}>
                        <strong>Automatic Protection:</strong> If you experienced a problem, this device will automatically unlock once the session ending time is reached ({formatMmSs(sessionRemaining || 0)}).
                    </div>
                </div>

                <button
                    type="button"
                    onClick={() => setShowPinModal(true)}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '12px 20px',
                        borderRadius: '12px',
                        background: '#dc2626',
                        color: '#ffffff',
                        border: 'none',
                        fontSize: '0.9rem',
                        fontWeight: 800,
                        cursor: 'pointer',
                        boxShadow: '0 4px 14px rgba(220, 38, 38, 0.35)'
                    }}
                >
                    <FaLock /> Enter Lecturer Release Code
                </button>
            </div>
        );
    }

    // =========================================================================
    // UI VIEW 1.5: VALIDATING QR2 (Transitioning to Face Biometrics)
    // =========================================================================
    if (scanState === 'VALIDATING_QR2') {
        return (
            <div style={{
                maxWidth: '520px',
                margin: '40px auto',
                padding: '36px 24px',
                background: 'var(--surface, #ffffff)',
                borderRadius: '24px',
                textAlign: 'center',
                border: '1.5px solid var(--border, #e2e8f0)',
                boxShadow: '0 20px 45px -20px rgba(0, 0, 0, 0.15)',
                color: 'var(--text-main, #0f172a)'
            }}>
                <FaSpinner className="fa-spin" style={{ fontSize: '3rem', color: '#6366f1', marginBottom: '16px' }} />
                <h3 style={{ margin: '0 0 8px', fontSize: '1.25rem', fontWeight: 800 }}>
                    Validating Attendance Token...
                </h3>
                <p style={{ margin: 0, color: 'var(--text-muted, #64748b)', fontSize: '0.9rem' }}>
                    Preparing front camera for facial biometric verification. Please look at your device.
                </p>
            </div>
        );
    }

    // =========================================================================
    // UI VIEW 2: LIVE BIOMETRIC FACE SCANNER (Triggered by Phase 2 QR 2)
    // =========================================================================
    if (scanState === 'BIOMETRIC_SCAN') {
        return (
            <div className="st-biometric-container">
                {renderLecturerPinModal()}

                <div className="st-biometric-header">
                    <div className="st-biometric-phase-chip">
                        <FaCheckCircle /> Phase 2: Biometric Verification
                    </div>

                    <button
                        type="button"
                        onClick={() => setShowPinModal(true)}
                        className="st-biometric-exit-btn"
                    >
                        <FaLock /> Lecturer Exit
                    </button>
                </div>

                {/* Dual Biometric Combo Stepper */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '12px',
                    margin: '0 0 20px 0',
                    padding: '10px 16px',
                    background: 'var(--surface-muted, #f8fafc)',
                    borderRadius: '16px',
                    border: '1.5px solid var(--border, #e2e8f0)'
                }}>
                    {/* Step 1: Fingerprint */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 16px',
                        borderRadius: '999px',
                        background: hardwareProof
                            ? 'rgba(16, 185, 129, 0.12)'
                            : (biometricComboStep === 'FINGERPRINT' ? 'rgba(99, 102, 241, 0.12)' : 'transparent'),
                        color: hardwareProof
                            ? '#059669'
                            : (biometricComboStep === 'FINGERPRINT' ? '#4f46e5' : '#94a3b8'),
                        fontWeight: 800,
                        fontSize: '0.9rem',
                        border: hardwareProof
                            ? '1.5px solid #10b981'
                            : (biometricComboStep === 'FINGERPRINT' ? '1.5px solid #6366f1' : '1px solid transparent'),
                        transition: 'all 0.3s ease'
                    }}>
                        <FaFingerprint />
                        <span>1. Fingerprint {hardwareProof ? '✓' : ''}</span>
                    </div>

                    <FaArrowRight style={{ color: '#cbd5e1', fontSize: '0.85rem' }} />

                    {/* Step 2: 3D Face Scan */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 16px',
                        borderRadius: '999px',
                        background: biometricComboStep === 'FACE'
                            ? 'rgba(99, 102, 241, 0.12)'
                            : 'transparent',
                        color: biometricComboStep === 'FACE' ? '#4f46e5' : '#94a3b8',
                        fontWeight: 800,
                        fontSize: '0.9rem',
                        border: biometricComboStep === 'FACE' ? '1.5px solid #6366f1' : '1px solid transparent',
                        transition: 'all 0.3s ease'
                    }}>
                        <FaCamera />
                        <span>2. 3D Face Scan</span>
                    </div>
                </div>

                {biometricComboStep === 'FINGERPRINT' ? (
                    /* Step 1: Device Fingerprint Verification Card */
                    <div style={{
                        padding: '28px 24px',
                        background: 'linear-gradient(180deg, rgba(248, 250, 252, 0.8) 0%, rgba(241, 245, 249, 0.98) 100%)',
                        borderRadius: '20px',
                        border: '2px dashed var(--border, #cbd5e1)',
                        margin: '12px 0 20px 0'
                    }}>
                        <h2 style={{ margin: '0 0 8px 0', fontSize: '1.45rem', fontWeight: 800 }}>
                            Step 1: Device Fingerprint Verification
                        </h2>
                        <p style={{ margin: '0 0 22px 0', color: 'var(--text-muted, #64748b)', fontSize: '0.92rem' }}>
                            Touch your device fingerprint sensor or tap below to authenticate.
                        </p>

                        {/* Interactive Fingerprint Graphic */}
                        <div
                            onClick={handleTriggerFingerprint}
                            style={{
                                width: '100px',
                                height: '100px',
                                margin: '0 auto 20px auto',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                borderRadius: '50%',
                                background: hardwareProof
                                    ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                                    : (fingerprintError
                                        ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
                                        : 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)'),
                                color: '#ffffff',
                                fontSize: '2.8rem',
                                boxShadow: hardwareProof
                                    ? '0 10px 28px -4px rgba(16, 185, 129, 0.45)'
                                    : '0 10px 28px -4px rgba(99, 102, 241, 0.35)',
                                cursor: 'pointer',
                                transition: 'all 0.3s ease'
                            }}
                            title="Touch sensor to verify fingerprint"
                        >
                            {hardwareProof ? (
                                <FaCheckCircle style={{ fontSize: '2.8rem' }} />
                            ) : fingerprintVerifying ? (
                                <FaSpinner className="fa-spin" style={{ fontSize: '2.4rem' }} />
                            ) : (
                                <FaFingerprint />
                            )}
                        </div>

                        {/* Fingerprint Status Feedback */}
                        {hardwareProof ? (
                            <div style={{
                                color: '#059669',
                                fontWeight: 800,
                                fontSize: '0.98rem',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '8px'
                            }}>
                                <FaCheckCircle />
                                <span>Fingerprint Confirmed! Starting Face Scan...</span>
                            </div>
                        ) : fingerprintError ? (
                            <div>
                                <p style={{ color: '#dc2626', fontWeight: 700, fontSize: '0.9rem', margin: '0 0 16px 0' }}>
                                    {fingerprintError}
                                </p>
                                <button
                                    type="button"
                                    onClick={handleTriggerFingerprint}
                                    style={{
                                        padding: '12px 24px',
                                        borderRadius: '12px',
                                        background: '#6366f1',
                                        color: '#ffffff',
                                        border: 'none',
                                        fontWeight: 800,
                                        fontSize: '0.92rem',
                                        cursor: 'pointer',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '8px'
                                    }}
                                >
                                    <FaSyncAlt /> Retry Fingerprint
                                </button>
                            </div>
                        ) : (
                            <div>
                                <button
                                    type="button"
                                    onClick={handleTriggerFingerprint}
                                    disabled={fingerprintVerifying}
                                    style={{
                                        padding: '14px 28px',
                                        borderRadius: '14px',
                                        background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
                                        color: '#ffffff',
                                        border: 'none',
                                        fontWeight: 800,
                                        fontSize: '0.98rem',
                                        cursor: fingerprintVerifying ? 'wait' : 'pointer',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '10px',
                                        boxShadow: '0 6px 18px rgba(99, 102, 241, 0.3)'
                                    }}
                                >
                                    <FaFingerprint />
                                    <span>{fingerprintVerifying ? "Verifying..." : "Verify Fingerprint"}</span>
                                </button>
                            </div>
                        )}
                    </div>
                ) : (
                    /* Step 2: 3D Face Biometric & Liveness */
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginBottom: '14px' }}>
                            <h2 style={{ margin: 0, fontSize: '1.45rem', fontWeight: 800 }}>
                                Step 2: Face Biometric &amp; Liveness
                            </h2>
                            <span style={{ fontSize: '0.88rem', color: '#64748b' }}>• Keep face in frame</span>
                        </div>

                        {/* On-Return Interruption Warning Banner */}
                        {interruptionWarning && (
                            <div style={{
                                margin: '0 0 14px 0',
                                padding: '10px 16px',
                                borderRadius: '12px',
                                background: '#fffbeb',
                                border: '1px solid #f59e0b',
                                color: '#92400e',
                                fontSize: '0.88rem',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '10px'
                            }}>
                                <span><strong>Interruption Recorded:</strong> Remain on screen.</span>
                                <button
                                    type="button"
                                    onClick={() => setInterruptionWarning(false)}
                                    style={{ background: 'transparent', border: 'none', color: '#b45309', fontWeight: 800, fontSize: '0.84rem', cursor: 'pointer' }}
                                >
                                    Dismiss
                                </button>
                            </div>
                        )}

                        {/* Face Scanner Component */}
                        <FaceScanner
                            verifiedStudent={verifiedStudent}
                            lookingUp={lookingUpStudent}
                            rollNo={loggedInRollNo}
                            onVerificationChange={handleFaceVerificationChange}
                        />
                    </div>
                )}

                {submittingAttendance && (
                    <div style={{
                        marginTop: '16px',
                        padding: '14px 18px',
                        borderRadius: '14px',
                        background: '#dcfce7',
                        color: '#15803d',
                        fontWeight: 800,
                        fontSize: '0.95rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '10px'
                    }}>
                        <FaSpinner className="fa-spin" />
                        <span>Biometrics Verified! Submitting attendance record...</span>
                    </div>
                )}
            </div>
        );
    }

    // =========================================================================
    // UI VIEW 3: KIOSK WAITING SCREEN (Phase 1 Complete, Waiting for Phase 2 QR)
    // =========================================================================
    if (scanState === 'KIOSK_WAITING_QR2') {
        return (
            <div className="st-scanner-container">
                {renderLecturerPinModal()}

                {/* Web Guardian Violation Overlay */}
                {supervisionViolation && (
                    <div style={{
                        position: 'fixed',
                        inset: 0,
                        backgroundColor: 'rgba(15, 23, 42, 0.96)',
                        zIndex: 9999,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '28px',
                        color: '#ffffff',
                        textAlign: 'center'
                    }}>
                        <div style={{
                            width: '68px',
                            height: '68px',
                            borderRadius: '50%',
                            background: '#fee2e2',
                            color: '#b91c1c',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '34px',
                            marginBottom: '16px'
                        }}>
                            <FaExclamationTriangle />
                        </div>
                        <h2 style={{ fontSize: '1.45rem', fontWeight: 800, margin: '0 0 10px 0', color: '#f87171' }}>
                            Security Supervision Alert!
                        </h2>
                        <p style={{ maxWidth: '440px', fontSize: '0.94rem', color: '#cbd5e1', lineHeight: 1.5, marginBottom: '20px' }}>
                            App switching detected for <strong>{loggedInRollNo}</strong>. Leaving SmartAttend is strictly prohibited.
                        </p>
                        <button
                            type="button"
                            onClick={() => setSupervisionViolation(false)}
                            style={{
                                padding: '12px 28px',
                                borderRadius: '14px',
                                background: '#6366f1',
                                color: '#ffffff',
                                border: 'none',
                                fontWeight: 800,
                                fontSize: '0.95rem',
                                cursor: 'pointer',
                                boxShadow: '0 4px 14px rgba(99, 102, 241, 0.35)'
                            }}
                        >
                            Return to Attendance Session
                        </button>
                    </div>
                )}

                {/* Supervised Bar */}
                <div className="st-supervised-bar">
                    <div className="st-supervised-bar-left">
                        <FaLock /> Lock Mode Active ({loggedInRollNo})
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowPinModal(true)}
                        className="st-supervised-release-btn"
                    >
                        Release
                    </button>
                </div>

                {/* Instruction / Status Badge */}
                <div className="st-scanner-waiting-pill">
                    {isQr2Released ? <FaCheckCircle style={{ color: '#059669' }} /> : <FaClock />}
                    <span>{isQr2Released ? 'Phase 2 Live · Point camera at screen QR 2' : 'Phase 1 Complete · Waiting for QR 2'}</span>
                </div>

                {!isQr2Released ? (
                    /* QR Scanning Blocked / Paused View */
                    <div className="st-scanner-waiting-box">
                        <p>
                            Scanning paused to save battery. Camera unlocks automatically when QR 2 appears.
                        </p>

                        {secondsUntilQr2 !== null && secondsUntilQr2 > 0 ? (
                            <div className="st-countdown-display">
                                <div className="st-countdown-label">
                                    Estimated QR 2 In
                                </div>
                                <div className="st-countdown-time">
                                    {Math.floor(secondsUntilQr2 / 60)}:{String(secondsUntilQr2 % 60).padStart(2, '0')}
                                </div>
                            </div>
                        ) : (
                            <div style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '10px',
                                padding: '12px 22px',
                                borderRadius: '12px',
                                background: '#ffffff',
                                border: '1.5px solid #e2e8f0',
                                fontSize: '0.92rem',
                                color: '#475569',
                                fontWeight: 700
                            }}>
                                <FaSpinner className="fa-spin" style={{ color: '#6366f1' }} /> Listening for lecturer to release QR 2...
                            </div>
                        )}
                    </div>
                ) : (
                    /* Live Scanner Frame (Only active when QR 2 is released) */
                    <div className="st-camera-viewport-card active-phase2">
                        <div className="st-camera-badge-floating">
                            ⚡ Phase 2 Live · Scan QR 2 on Screen
                        </div>

                        <NativeQrScanner
                            key={`waiting-${retryKey}-environment`}
                            onScan={handleCameraScan}
                            onError={handleCameraError}
                            facingMode="environment"
                            active={scanState === 'KIOSK_WAITING_QR2' && isQr2Released}
                        />
                    </div>
                )}

                {errorMessage && (
                    <div className="st-scanner-error-banner">
                        {errorMessage}
                    </div>
                )}
            </div>
        );
    }

    // =========================================================================
    // UI VIEW 4: INITIAL IDLE SCANNER (Student Scans QR 1)
    // =========================================================================
    return (
        <div className="st-scanner-container">
            {/* Header Navigation */}
            <div className="st-scanner-header">
                <button
                    type="button"
                    onClick={() => navigate('/student')}
                    className="st-scanner-back-btn"
                >
                    <FaArrowLeft /> Dashboard
                </button>

                {/* Student Badge */}
                {user && (
                    <div className="st-scanner-student-chip">
                        <FaUserCheck className="chip-icon" />
                        <span><strong>{loggedInRollNo}</strong> ({loggedInName})</span>
                    </div>
                )}
            </div>

            {/* Title & Status */}
            <div className="st-scanner-title-section">
                <h2 className="st-scanner-title">
                    Scan Class QR Code
                </h2>
                <p className="st-scanner-subtitle">
                    Point your camera at the attendance QR code displayed by your lecturer
                </p>
                <div className="st-scanner-supervised-pill">
                    <FaShieldAlt style={{ color: '#10b981' }} />
                    <span>Supervised Session Active · Keep in view</span>
                </div>
            </div>

            {/* Camera Viewport (Spacious, rounded card) */}
            <div className="st-camera-viewport-card">
                {scannerActive && (
                    <NativeQrScanner
                        key={`${retryKey}-environment`}
                        onScan={handleCameraScan}
                        onError={handleCameraError}
                        facingMode="environment"
                        active={scannerActive}
                    />
                )}
            </div>

            {/* Android Web Browser Native APK Download Notice */}
            {!isNativeApp && !isIOSDevice() && (
                <div style={{
                    marginTop: '16px',
                    padding: '16px',
                    borderRadius: '16px',
                    background: '#fef3c7',
                    border: '1px solid #fde68a',
                    color: '#92400e',
                    fontSize: '0.9rem',
                    textAlign: 'center'
                }}>
                    <div style={{ fontWeight: 800, marginBottom: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                        <FaExclamationTriangle /> Android Web Browser Detected
                    </div>
                    <p style={{ margin: '0 0 12px 0', fontSize: '0.84rem', lineHeight: 1.45 }}>
                        Attendance security requires OS-level Kiosk Lock Task mode. Please install the official SmartAttend Android app.
                    </p>
                    <a
                        href={getApkDownloadUrl()}
                        download="SmartAttend-release.apk"
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '8px',
                            padding: '10px 18px',
                            borderRadius: '12px',
                            background: '#15803d',
                            color: '#ffffff',
                            textDecoration: 'none',
                            fontWeight: 700,
                            fontSize: '0.88rem',
                            boxShadow: '0 4px 12px rgba(21, 128, 61, 0.25)'
                        }}
                    >
                        <FaDownload /> Download SmartAttend APK (.apk)
                    </a>
                </div>
            )}

            {/* Loading or Error States */}
            {scanState === 'AUTHORIZING_QR1' && (
                <div style={{
                    marginTop: '16px',
                    padding: '12px',
                    borderRadius: '12px',
                    background: 'rgba(99, 102, 241, 0.1)',
                    color: '#4338ca',
                    fontWeight: 800,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px'
                }}>
                    <FaSpinner className="fa-spin" />
                    <span>Verifying Phase 1 Check-In &amp; Starting Kiosk Mode...</span>
                </div>
            )}

            {errorMessage && (
                <div style={{
                    marginTop: '14px',
                    padding: '12px 14px',
                    borderRadius: '10px',
                    background: '#fee2e2',
                    border: '1px solid #fca5a5',
                    color: '#b91c1c',
                    fontSize: '0.86rem',
                    fontWeight: 700,
                    textAlign: 'left'
                }}>
                    {errorMessage}
                </div>
            )}

            {/* Overlay Permission Instructions Modal */}
            {showOverlayInstructionsModal && (
                <div style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(15, 23, 42, 0.75)',
                    backdropFilter: 'blur(4px)',
                    zIndex: 9999,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '20px'
                }}>
                    <div style={{
                        background: 'var(--surface, #ffffff)',
                        borderRadius: '20px',
                        maxWidth: '460px',
                        width: '100%',
                        padding: '28px 24px',
                        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
                        border: '1px solid var(--border, #e2e8f0)',
                        textAlign: 'left'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
                            <div style={{
                                width: '44px',
                                height: '44px',
                                borderRadius: '12px',
                                background: '#fef3c7',
                                color: '#d97706',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '1.4rem',
                                flexShrink: 0
                            }}>
                                <FaShieldAlt />
                            </div>
                            <div>
                                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-main, #0f172a)' }}>
                                    Display Over Other Apps
                                </h3>
                                <span style={{ fontSize: '0.8rem', color: '#d97706', fontWeight: 700 }}>
                                    Required for Kiosk Lock Mode
                                </span>
                            </div>
                        </div>

                        <p style={{ margin: '0 0 16px', fontSize: '0.88rem', color: 'var(--text-muted, #475569)', lineHeight: 1.5 }}>
                            Android requires this permission to keep SmartAttend pinned in the foreground and protect your attendance from accidental app-switching disqualifications.
                        </p>

                        <div style={{
                            background: 'var(--bg-subtle, #f8fafc)',
                            borderRadius: '12px',
                            padding: '14px',
                            marginBottom: '20px',
                            border: '1px solid var(--border, #e2e8f0)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '10px'
                        }}>
                            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                                <span style={{ background: '#d97706', color: '#ffffff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 800, flexShrink: 0 }}>1</span>
                                <span style={{ fontSize: '0.84rem', color: 'var(--text-main, #1e293b)', lineHeight: 1.4 }}>
                                    Tap <strong>"Open Settings to Enable"</strong> below.
                                </span>
                            </div>
                            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                                <span style={{ background: '#d97706', color: '#ffffff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 800, flexShrink: 0 }}>2</span>
                                <span style={{ fontSize: '0.84rem', color: 'var(--text-main, #1e293b)', lineHeight: 1.4 }}>
                                    Locate and select <strong>"SmartAttend"</strong> in the app list.
                                </span>
                            </div>
                            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                                <span style={{ background: '#d97706', color: '#ffffff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 800, flexShrink: 0 }}>3</span>
                                <span style={{ fontSize: '0.84rem', color: 'var(--text-main, #1e293b)', lineHeight: 1.4 }}>
                                    Switch the toggle to <strong>Allow display over other apps</strong> (turn ON).
                                </span>
                            </div>
                            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                                <span style={{ background: '#d97706', color: '#ffffff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 800, flexShrink: 0 }}>4</span>
                                <span style={{ fontSize: '0.84rem', color: 'var(--text-main, #1e293b)', lineHeight: 1.4 }}>
                                    Tap your device's <strong>Back button</strong> to return to SmartAttend.
                                </span>
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                            <button
                                type="button"
                                onClick={() => setShowOverlayInstructionsModal(false)}
                                style={{
                                    padding: '10px 16px',
                                    borderRadius: '10px',
                                    background: 'transparent',
                                    border: '1px solid var(--border, #cbd5e1)',
                                    color: 'var(--text-muted, #64748b)',
                                    fontWeight: 700,
                                    fontSize: '0.86rem',
                                    cursor: 'pointer'
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={async () => {
                                    setShowOverlayInstructionsModal(false);
                                    await Kiosk.requestOverlayPermission();
                                    setTimeout(checkDeviceProvisioning, 1500);
                                    setTimeout(checkDeviceProvisioning, 3500);
                                }}
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    padding: '10px 18px',
                                    borderRadius: '10px',
                                    background: 'linear-gradient(135deg, #d97706, #b45309)',
                                    color: '#ffffff',
                                    border: 'none',
                                    fontWeight: 800,
                                    fontSize: '0.86rem',
                                    cursor: 'pointer',
                                    boxShadow: '0 4px 12px rgba(217, 119, 6, 0.3)'
                                }}
                            >
                                <FaShieldAlt /> Open Settings to Enable
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default QrScannerApp;
