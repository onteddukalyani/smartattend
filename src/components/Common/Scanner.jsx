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
    FaFingerprint,
    FaMapMarkerAlt,
    FaUnlock,
    FaHourglassHalf,
    FaBolt
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
import { doc, getDoc, collection, query, where, getDocs, setDoc, onSnapshot } from 'firebase/firestore';
import FaceScanner, { releaseAllMediaTracks, loadFaceApiModels } from '../Lecturer/pages/FaceScanner';
import { isIOSDevice, isGuidedAccessEnabled, addAppSwitchListener, addScreenCaptureListener } from '../../services/guidedAccessService';
import { getApkDownloadUrl } from '../../utils/apkUrl';
import GuidedAccessRequired, { GuidedAccessExitNotice } from '../GuidedAccessRequired';
import { isGenericName } from '../../utils/studentDataHelper';
import { detectDeviceType, getClientIpAddress, getDeviceDisplayName, isDeviceMatching, isBrowserCameraAllowed, isStaffCameraUser } from '../../utils/deviceDetection';
import { sendFacultyNotification, sendStudentNotification, reportUserVerificationComplaint } from '../../services/notificationsService';
import { validateRotatingQrPayload } from '../../utils/qrCrypto';
import { evaluateGeofence, calculateHaversineDistance, DEFAULT_GEOFENCE_RADIUS_METRES } from '../../utils/geofence';
import {
    isFreshLocation,
    isAccurateLocation,
    locationFromPosition,
    acquireAccurateLocation,
    pickBestStudentLocation,
    MAX_CLASSROOM_LOCATION_ACCURACY_METERS
} from '../../utils/location';
import { checkVpnAndNetworkSecurity } from '../../utils/vpnDetection';
import { verifyHardwareBiometric, prefetchBiometricChallenge } from '../../services/biometricService';
import { checkForAppUpdate, CURRENT_APP_VERSION, compareVersions } from '../../services/appUpdateService';
import AppUpdateModal from './AppUpdateModal';
import './Scanner.css';

/**
 * Stage 4: Student Two-Phase Attendance Scanner & Supervised Kiosk Controller
 * 
 * Timeline:
 * T = 0s to 15s (0:00 - 0:15) : QR 1 Phase 1 Check-In -> Authorizes Student -> Starts Kiosk Mode
 * T = 15s to 30s (0:15 - 0:30): QR 2 Phase 2 Biometric -> Gated by Phase 1 -> Submits Attendance
 * Post-Attendance             : Device remains locked in Lock Task Mode -> Auto Release in 5:00 Fail-Safe
 */
function QrScannerApp() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const { user, profile, loading } = useAuth();
    const fileInputRef = useRef(null);
    const scanProcessingRef = useRef(false);
    const sessionTimerRef = useRef(null);
    // Silent camera lock — holds rear camera stream after QR1 to block other apps
    const silentCameraLockRef = useRef(null);
    const [cameraLockActive, setCameraLockActive] = useState(false);

    // Platform & App Detection
    const isNativeApp = Capacitor.isNativePlatform();
    const browserCameraAuth = isBrowserCameraAllowed(profile, user);
    const isCameraAllowed = browserCameraAuth.allowed;
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
    const lifecycleViolationSessionRef = useRef(null);

    // VPN Security Alert Modal State
    const [showVpnModal, setShowVpnModal] = useState(false);
    const [vpnDetails, setVpnDetails] = useState('');

    // Student Biometrics Precondition State
    const isStudentUser = !isStaffCameraUser(profile, user);
    const [showBiometricsRequiredModal, setShowBiometricsRequiredModal] = useState(false);
    const [studentBioStatus, setStudentBioStatus] = useState(() => {
        const roll = (profile?.rollNo || '').trim().toUpperCase();
        const uid = user?.uid;
        const hasFace = Boolean(
            (!profile?.faceRemovedAt && (profile?.faceRegistered || profile?.biometricEnrolled || profile?.hasFaceRegistered)) ||
            (roll && localStorage.getItem(`smartattend_face_enrolled_${roll}`) === 'true') ||
            (uid && localStorage.getItem(`smartattend_face_enrolled_${uid}`) === 'true') ||
            localStorage.getItem('smartattend_face_enrolled') === 'true'
        );
        const hasHw = Boolean(
            profile?.hardwareBiometricEnrolled ||
            (roll && localStorage.getItem(`smartattend_hw_enrolled_${roll}`) === 'true') ||
            (uid && localStorage.getItem(`smartattend_hw_enrolled_${uid}`) === 'true') ||
            localStorage.getItem('smartattend_hw_enrolled') === 'true'
        );
        return { hasFace, hasHw, isComplete: hasFace && hasHw };
    });

    // Camera & Scanner State
    const isStaff = isStaffCameraUser(profile, user);
    const [facingMode, setFacingMode] = useState('environment');
    // Students strictly use rear camera for QR scanning; lecturers have full front/rear toggle
    const effectiveFacingMode = isStaff ? facingMode : 'environment';
    const handleToggleFacingMode = isStaff ? () => {
        setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
    } : undefined;
    const [retryKey, setRetryKey] = useState(0);
    const [cameraError, setCameraError] = useState('');
    const [permissionDenied, setPermissionDenied] = useState(false);
    const [scanningFile, setScanningFile] = useState(false);
    const [scannerActive, setScannerActive] = useState(true);

    // Active Session & Student Authorization Data
    const [activeSessionId, setActiveSessionId] = useState('');
    const [activeQr2Token, setActiveQr2Token] = useState('');
    const [activeQr2Payload, setActiveQr2Payload] = useState(null);
    const [sessionData, setSessionData] = useState(null);
    const [sessionStartAt, setSessionStartAt] = useState(0);
    const [kioskEndsAt, setKioskEndsAt] = useState(0);
    const [authQr2StartsAt, setAuthQr2StartsAt] = useState(0);
    const [authQr1DurationSec, setAuthQr1DurationSec] = useState(15);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [sessionRemaining, setSessionRemaining] = useState(30);
    const [errorMessage, setErrorMessage] = useState('');
    const [nowTick, setNowTick] = useState(Date.now());
    const geofenceRetriesRef = useRef(0);
    const geofenceAttemptsRef = useRef(0);
    const [geofenceAttempts, setGeofenceAttempts] = useState(0);
    const [scannedStudentLocation, setScannedStudentLocation] = useState(null);
    const prewarmedLocationRef = useRef(null);
    const [gpsTelemetry, setGpsTelemetry] = useState(null);
    const [currentStudentLocation, setCurrentStudentLocation] = useState(null);
    const [lecturerLocation, setLecturerLocation] = useState(null);
    const lecturerLocationRef = useRef(null);

    // Heartbeat clock to evaluate phase transitions and countdowns in real-time
    useEffect(() => {
        const interval = setInterval(() => {
            setNowTick(Date.now());
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    // Real-time synchronization of session duration & target when lecturer extends or reduces time
    useEffect(() => {
        if (!sessionData) return;
        const target = sessionData.qr2StartsAt
            ? (typeof sessionData.qr2StartsAt.toMillis === 'function' ? sessionData.qr2StartsAt.toMillis() : Number(sessionData.qr2StartsAt))
            : (sessionData.qr1ExpiresAt
                ? (typeof sessionData.qr1ExpiresAt.toMillis === 'function' ? sessionData.qr1ExpiresAt.toMillis() : Number(sessionData.qr1ExpiresAt))
                : 0);
        if (target > 0) {
            setAuthQr2StartsAt(target);
        }
        if (sessionData.qr1DurationSeconds) {
            setAuthQr1DurationSec(Number(sessionData.qr1DurationSeconds));
        }
    }, [sessionData]);

    // Authoritative target time for Phase 2 QR unlock (immediate from auth response + real-time Firestore sync)
    const effectiveQr2TargetMs = (sessionData?.qr2StartsAt
        ? (typeof sessionData.qr2StartsAt.toMillis === 'function' ? sessionData.qr2StartsAt.toMillis() : Number(sessionData.qr2StartsAt))
        : (sessionData?.qr1ExpiresAt
            ? (typeof sessionData.qr1ExpiresAt.toMillis === 'function' ? sessionData.qr1ExpiresAt.toMillis() : Number(sessionData.qr1ExpiresAt))
            : authQr2StartsAt)) || 0;

    // Helper to evaluate if Lecturer has officially released Phase 2 (QR 2) or time has arrived
    const isQr2Released = Boolean(
        (sessionData && (
            sessionData.phase === 'PHASE_2' ||
            sessionData.phase === '2' ||
            sessionData.qr2Released === true ||
            (effectiveQr2TargetMs > 0 && effectiveQr2TargetMs <= nowTick)
        )) ||
        (!sessionData && authQr2StartsAt > 0 && authQr2StartsAt <= nowTick)
    );

    const qr2TargetMs = effectiveQr2TargetMs;

    const secondsUntilQr2 = (effectiveQr2TargetMs > 0 && !isQr2Released)
        ? Math.max(0, Math.ceil((effectiveQr2TargetMs - nowTick) / 1000))
        : null;

    // Haptic vibration feedback trigger when Phase 2 unlocks
    const wasQr2ReleasedRef = useRef(false);
    useEffect(() => {
        if (isQr2Released && !wasQr2ReleasedRef.current && scanState === 'KIOSK_WAITING_QR2') {
            wasQr2ReleasedRef.current = true;
            if (typeof navigator !== 'undefined' && navigator.vibrate) {
                try { navigator.vibrate([60, 80, 60]); } catch (_) { }
            }
        } else if (!isQr2Released) {
            wasQr2ReleasedRef.current = false;
        }
    }, [isQr2Released, scanState]);

    // Continuous GPS Pre-Warming (Dual-stage coarse prime + high-accuracy refinement) & Model Pre-Loading
    useEffect(() => {
        let watchId = null;

        // Instant hydrate from recent local cache if fresh
        try {
            const cached = localStorage.getItem('smartattend_student_location');
            if (cached) {
                const parsed = JSON.parse(cached);
                if (isFreshLocation(parsed)) {
                    prewarmedLocationRef.current = parsed;
                    setCurrentStudentLocation(parsed);
                }
            }
        } catch (_) { }

        if (typeof navigator !== "undefined" && navigator.geolocation) {
            const applyStudentGps = (pos) => {
                const locObj = locationFromPosition(pos);
                if (!locObj) return;
                const prev = prewarmedLocationRef.current;
                const isAccurate = isAccurateLocation(locObj);
                const prevAccurate = prev && isAccurateLocation(prev);

                let shouldUpdate = false;
                if (!prev) {
                    shouldUpdate = true;
                } else if (isAccurate && !prevAccurate) {
                    shouldUpdate = true; // Upgraded from inaccurate to accurate
                } else if (isAccurate && prevAccurate) {
                    shouldUpdate = locObj.accuracy <= prev.accuracy || (locObj.timestamp - prev.timestamp > 15000);
                } else if (!isAccurate && !prevAccurate) {
                    shouldUpdate = locObj.accuracy < prev.accuracy;
                }

                if (shouldUpdate) {
                    prewarmedLocationRef.current = locObj;
                    setCurrentStudentLocation(locObj);
                    if (isAccurate) {
                        try {
                            localStorage.setItem('smartattend_student_location', JSON.stringify(locObj));
                        } catch (_) { }
                    }
                }
            };

            try {
                // 1. Instant GPS prime: Rapid lock accepting recent cache with fast GNSS fallback
                navigator.geolocation.getCurrentPosition(
                    applyStudentGps,
                    () => { },
                    { enableHighAccuracy: true, timeout: 5000, maximumAge: 15000 }
                );

                // 2. Continuous high-accuracy refinement
                watchId = navigator.geolocation.watchPosition(
                    applyStudentGps,
                    (err) => console.warn('[Scanner] GPS prewarm notice:', err?.message || err),
                    { enableHighAccuracy: true, maximumAge: 5000, timeout: 8000 }
                );
            } catch (_) { }
        }

        // Ensure camera is fully enabled and free from any previous sessions
        releaseAllMediaTracks();
        try { Kiosk.enableCamera().catch(() => { }); } catch (_) { }

        // Pre-warm neural network models in background for instantaneous Phase 2 biometric startup
        loadFaceApiModels().catch(() => { });
        // Pre-warm VPN security status and IP address in background for 0ms QR verification
        checkVpnAndNetworkSecurity().catch(() => { });
        getClientIpAddress().catch(() => { });

        return () => {
            if (watchId !== null && typeof navigator !== "undefined" && navigator.geolocation?.clearWatch) {
                navigator.geolocation.clearWatch(watchId);
            }
        };
    }, []);

    // Live continuous distance calculation between student device and that particular lecturer's device
    useEffect(() => {
        const target = lecturerLocation || lecturerLocationRef.current || sessionData?.classroomLocation;
        if (!currentStudentLocation || !target) return;
        const targetLat = target.latitude ?? target.lat;
        const targetLng = target.longitude ?? target.lng;
        if (targetLat != null && targetLng != null) {
            try {
                const evalResult = evaluateGeofence(currentStudentLocation, target, 0);
                setGpsTelemetry((prev) => {
                    if (!prev || prev.distance !== evalResult.distance || prev.status !== evalResult.status) {
                        return evalResult;
                    }
                    return prev;
                });
            } catch (_) {}
        }
    }, [currentStudentLocation, sessionData?.classroomLocation, lecturerLocation]);

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

                if (!emailQuerySnap.empty && emailQuerySnap.docs?.[0]) {
                    foundData = emailQuerySnap.docs[0].data();
                    foundId = emailQuerySnap.docs[0].id;
                } else if (rollSnap.exists && rollSnap.exists()) {
                    foundData = rollSnap.data();
                    foundId = rollSnap.id;
                } else if (uidSnap.exists && uidSnap.exists()) {
                    foundData = uidSnap.data();
                    foundId = uidSnap.id;
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
                    const studentRoll = String(foundData.rollNo || (!foundId.includes('@') ? foundId : '')).trim().toUpperCase();
                    const studentName = String(foundData.name || foundData.fullName || '').trim();
                    setDbStudent({
                        ...foundData,
                        rollNo: studentRoll,
                        name: studentName || studentRoll,
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

    const rawRollNo = dbStudent?.rollNo || (!String(profile?.rollNo || '').includes('@') && !isGenericName(profile?.rollNo) ? profile?.rollNo : '') || '';
    const loggedInRollNo = String(rawRollNo).trim().toUpperCase();
    const rawProfileName = dbStudent?.name || dbStudent?.fullName || (!isGenericName(profile?.name, loggedInRollNo, user?.email) ? profile?.name : (profile?.fullName || ''));
    const loggedInName = rawProfileName ? rawProfileName.trim() : (loggedInRollNo ? loggedInRollNo : 'Student');

    // Real-time listener for student biometrics enrollment
    useEffect(() => {
        if (!loggedInRollNo || !isStudentUser) return;
        const unsub = onSnapshot(doc(db, "students", loggedInRollNo), (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                const hasFace = Boolean(!data.faceRemovedAt && (data.faceRegistered || data.biometricEnrolled || data.hasFaceRegistered));
                const hasHw = Boolean(data.hardwareBiometricEnrolled);
                if (hasFace) {
                    try {
                        localStorage.setItem(`smartattend_face_enrolled_${loggedInRollNo}`, "true");
                        if (user?.uid) localStorage.setItem(`smartattend_face_enrolled_${user.uid}`, "true");
                        localStorage.setItem("smartattend_face_enrolled", "true");
                    } catch (_) {}
                }
                if (hasHw) {
                    try {
                        localStorage.setItem(`smartattend_hw_enrolled_${loggedInRollNo}`, "true");
                        if (user?.uid) localStorage.setItem(`smartattend_hw_enrolled_${user.uid}`, "true");
                        localStorage.setItem("smartattend_hw_enrolled", "true");
                    } catch (_) {}
                }
                setStudentBioStatus((prev) => ({
                    hasFace: hasFace || prev.hasFace,
                    hasHw: hasHw || prev.hasHw,
                    isComplete: (hasFace || prev.hasFace) && (hasHw || prev.hasHw)
                }));
            }
        }, () => {});
        return () => unsub();
    }, [loggedInRollNo, isStudentUser, user?.uid]);

    // Synchronize biometrics status whenever student profile or auth updates
    useEffect(() => {
        const roll = (profile?.rollNo || loggedInRollNo || '').trim().toUpperCase();
        const uid = user?.uid;
        const hasFace = Boolean(
            (!profile?.faceRemovedAt && (profile?.faceRegistered || profile?.biometricEnrolled || profile?.hasFaceRegistered)) ||
            (roll && localStorage.getItem(`smartattend_face_enrolled_${roll}`) === 'true') ||
            (uid && localStorage.getItem(`smartattend_face_enrolled_${uid}`) === 'true') ||
            localStorage.getItem('smartattend_face_enrolled') === 'true'
        );
        const hasHw = Boolean(
            profile?.hardwareBiometricEnrolled ||
            (roll && localStorage.getItem(`smartattend_hw_enrolled_${roll}`) === 'true') ||
            (uid && localStorage.getItem(`smartattend_hw_enrolled_${uid}`) === 'true') ||
            localStorage.getItem('smartattend_hw_enrolled') === 'true'
        );
        setStudentBioStatus({ hasFace, hasHw, isComplete: hasFace && hasHw });
    }, [profile, user, loggedInRollNo]);

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
        if (!isCameraAllowed) return;
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
    }, [isCameraAllowed]);

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
        const pin = lecturerPinInput.trim();
        if (!pin) {
            setPinVerificationError('Please enter the 6-digit Session PIN.');
            return;
        }

        const targetSessionId = activeSessionId || sessionData?.sessionId || sessionData?.id || searchParams.get('session') || (typeof window !== 'undefined' ? (localStorage.getItem('smartattend_kiosk_session_id') || sessionStorage.getItem('smartattend_kiosk_session_id')) : '');
        if (!targetSessionId) {
            setPinVerificationError('Could not identify active session. Please try again.');
            return;
        }

        setIsVerifyingPin(true);
        setPinVerificationError('');

        try {
            await verifyLecturerEmergencyPin(targetSessionId, pin, deviceIdentity?.deviceId, user?.uid);
            console.log('[Kiosk] Session PIN verified. Releasing device from Kiosk Lock Task mode...');

            // Clean up roll authorization if separate doc exists
            if (loggedInRollNo && loggedInRollNo !== user?.uid) {
                setDoc(doc(db, "attendance_sessions", targetSessionId, "authorizations", loggedInRollNo), {
                    released: true,
                    releaseStatus: "PIN_RELEASED",
                    releasedAt: Date.now()
                }, { merge: true }).catch(() => { });
            }

            try {
                localStorage.removeItem('smartattend_kiosk_session_state');
                localStorage.removeItem('smartattend_kiosk_session_id');
                sessionStorage.removeItem('smartattend_kiosk_session_id');
            } catch (_) { }

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

    // Student Database Record Lookup for Facial Biometrics (Fast 0ms in-memory cache)
    const lookupStudentBiometrics = useCallback(async (roll) => {
        const targetRoll = (roll || loggedInRollNo || '').trim().toUpperCase();
        if (!targetRoll || targetRoll.length < 2) return;

        // Fast-path 1: Check AuthContext profile or pre-loaded dbStudent (0ms execution)
        const cachedFaceRegistered = Boolean(
            !profile?.faceRemovedAt &&
            !dbStudent?.faceRemovedAt &&
            (profile?.faceRegistered || profile?.biometricEnrolled || profile?.hasFaceRegistered ||
                dbStudent?.faceRegistered || dbStudent?.biometricEnrolled || dbStudent?.hasFaceRegistered)
        );
        if (cachedFaceRegistered) {
            setVerifiedStudent({
                rollNo: targetRoll,
                name: loggedInName || dbStudent?.name || profile?.name || 'Student',
                faceDescriptor: null,
                faceRegistered: true,
                photoURL: dbStudent?.photoURL || profile?.photoURL || null
            });
            return;
        }

        setLookingUpStudent(true);
        try {
            // Fast-path 2: Direct lookup on canonical students/{targetRoll}
            const sDocDirect = await getDoc(doc(db, 'students', targetRoll)).catch(() => null);
            if (sDocDirect && sDocDirect.exists()) {
                const sData = sDocDirect.data();
                const faceRegistered = Boolean(
                    !sData.faceRemovedAt &&
                    (sData.faceRegistered || sData.biometricEnrolled || sData.hasFaceRegistered ||
                        (Array.isArray(sData.faceDescriptor) && sData.faceDescriptor.length === 128) ||
                        (Array.isArray(sData.descriptor) && sData.descriptor.length === 128))
                );
                if (faceRegistered) {
                    setVerifiedStudent({
                        rollNo: targetRoll,
                        name: sData.name || loggedInName || 'Student',
                        faceDescriptor: null,
                        faceRegistered: true,
                        photoURL: sData.photoURL || null
                    });
                    setLookingUpStudent(false);
                    return;
                }
            }

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

            let merged = {
                rollNo: targetRoll,
                name: loggedInName,
                faceDescriptor: null,
                faceRegistered: false
            };
            let faceRemoved = false;
            if (profile?.photoURL) merged.photoURL = profile.photoURL;

            for (const docData of candidateDocs) {
                if (docData.rollNo) merged.rollNo = String(docData.rollNo).trim().toUpperCase();
                else if (docData.studentId) merged.rollNo = String(docData.studentId).trim().toUpperCase();
                if (docData.name && !isGenericName(docData.name, merged.rollNo)) merged.name = docData.name;
                if (docData.fullName && !isGenericName(docData.fullName, merged.rollNo)) merged.fullName = docData.fullName;
                if (docData.faceRemovedAt || docData.faceRegistered === false || docData.biometricEnrolled === false || docData.hasFaceRegistered === false) {
                    faceRemoved = true;
                }
                if (docData.faceRegistered || docData.biometricEnrolled || docData.hasFaceRegistered ||
                    (Array.isArray(docData.faceDescriptor) && docData.faceDescriptor.length === 128) ||
                    (Array.isArray(docData.descriptor) && docData.descriptor.length === 128)) {
                    merged.faceRegistered = true;
                }
                if (docData.photoURL) merged.photoURL = docData.photoURL;
            }
            if (faceRemoved) merged.faceRegistered = false;

            console.log(`[Scanner] Biometrics loaded for ${targetRoll}:`, {
                faceRegistered: Boolean(merged.faceRegistered),
                name: merged.name
            });

            setVerifiedStudent(merged);
        } catch (err) {
            console.warn('Student biometrics lookup notice:', err);
        } finally {
            setLookingUpStudent(false);
        }
    }, [loggedInRollNo, loggedInName, user, profile, dbStudent]);

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
                    authQr2StartsAt,
                    authQr1DurationSec,
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
    }, [activeSessionId, sessionStartAt, kioskEndsAt, authQr2StartsAt, authQr1DurationSec, attendanceSubmittedAt, autoReleaseAt, scanState, activeQr2Token, submissionDetails, loggedInRollNo]);

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
                    if (parsed.authQr2StartsAt) setAuthQr2StartsAt(parsed.authQr2StartsAt);
                    if (parsed.authQr1DurationSec) setAuthQr1DurationSec(parsed.authQr1DurationSec);
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
            lifecycleViolationSessionRef.current = null;
            return;
        }

        const handleViolationTrigger = (source) => {
            const sessionKey = activeSessionId || "active-session";
            if (lifecycleViolationSessionRef.current === sessionKey) return;
            lifecycleViolationSessionRef.current = sessionKey;
            interruptedRef.current = true;

            console.warn(`[Kiosk Guardian] Lifecycle interruption detected via ${source}!`);

            const isAndroidNative = isNativeApp && !isIOSDevice();
            const nextCount = violationCount + 1;
            setViolationCount(nextCount);
            setSupervisionViolation(true);

            // Immediate Disqualification on all platforms during active kiosk session
            console.error(`[Kiosk Guardian] Security violation detected via ${source}. Disqualifying attendance session (Zero-Tolerance Mode).`);
            try { localStorage.removeItem(`smartattend_qr1_auth_${activeSessionId}`); } catch (_) { }
            try { sessionStorage.removeItem(`smartattend_qr1_auth_${activeSessionId}`); } catch (_) { }
            setErrorMessage('❌ Attendance Disqualified: Security violation detected (application switch / minimizing / tab change). Attendance forfeited.');
            setScanState('DISQUALIFIED');

            window.setTimeout(() => {
                releaseAllMediaTracks();
                releaseCameraLock();
                if (isAndroidNative) {
                    Kiosk.startKioskMode().catch((err) => {
                        console.warn('[Kiosk Guardian] Could not restore kiosk mode:', err);
                    });
                }

                if (!activeSessionId) return;
                void (async () => {
                    try {
                        await reportAttendanceLifecycleEvent(activeSessionId, {
                            eventType: 'CONFIRMED_KIOSK_ESCAPE',
                            source,
                            platform: isAndroidNative ? 'android' : (isIOSDevice() ? (isNativeApp ? 'ios' : 'web_ios') : 'web'),
                            count: nextCount
                        });
                    } catch (err) {
                        console.warn('[Kiosk Guardian] Backend event report notice:', err);
                    }

                    try {
                        await recordSessionViolation(
                            activeSessionId,
                            user?.uid,
                            loggedInRollNo,
                            `CONFIRMED_KIOSK_ESCAPE: ${source}`,
                            nextCount,
                            true
                        );
                    } catch (vErr) {
                        console.warn('[Kiosk Guardian] Direct violation record notice:', vErr);
                    }
                })();
            }, 0);
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

        const handleAuthSnapshot = (authData) => {
            if (!authData) return;
            if (authData.released === true || authData.status === 'RELEASED') {
                handleReleaseTriggered();
                return;
            }
            if (authData.excused === true) {
                setSupervisionViolation(false);
                setViolationCount(0);
                if (scanState === 'DISQUALIFIED') {
                    setScanState('KIOSK_WAITING_QR2');
                    setErrorMessage('');
                }
                return;
            }
            if (
                authData.disqualified === true ||
                authData.hasViolation === true ||
                authData.violation === 1 ||
                authData.status === 'FLAGGED_DISQUALIFIED' ||
                Number(authData.confirmedKioskViolations || authData.violationCount || 0) >= 1
            ) {
                setScanState('DISQUALIFIED');
                setSupervisionViolation(true);
                setViolationCount(Number(authData.violationCount || authData.confirmedKioskViolations || 1));
                setErrorMessage('❌ Attendance Disqualified: Security violation detected on your session. Attendance forfeited.');
            }
        };

        const unsubs = [];
        if (studentUid) {
            unsubs.push(subscribeToStudentAuthorization(activeSessionId, studentUid, handleAuthSnapshot));
        }
        if (cleanRoll && cleanRoll !== studentUid) {
            unsubs.push(subscribeToStudentAuthorization(activeSessionId, cleanRoll, handleAuthSnapshot));
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
                        accuracy: gAcc > 0 ? gAcc : 15,
                        acc: gAcc > 0 ? gAcc : 15
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
    const handleProcessQR1 = async (sessionId, qr1Token, coords = null, qrPayload = null) => {
        if (!user) {
            setErrorMessage('Please log in with your student account to authorize attendance.');
            return;
        }

        // Strictly verify VPN is disabled immediately on QR 1 authorization
        const vpnCheck = await checkVpnAndNetworkSecurity();
        if (vpnCheck && vpnCheck.isVpn) {
            alert('🚨 VPN / Proxy Detected!\n\nVPNs and network proxies are strictly prohibited during attendance.\nPlease disconnect your VPN and try again.');
            setVpnDetails(vpnCheck.reason || 'Active VPN tunnel or proxy detected');
            setShowVpnModal(true);
            setErrorMessage('❌ VPN Detected: VPNs and network proxies are strictly prohibited during attendance. Please disconnect your VPN to continue.');
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
                    accuracy: coords.accuracy,
                    timestamp: coords.timestamp || Date.now(),
                    distanceToLecturer: qrPayload?.distance ?? null
                } : null
            };

            const result = await authorizeStudentQR1(sessionId, qr1Token, studentProfileOverride, qrPayload);

            setActiveSessionId(sessionId);
            if (qrPayload?.geo || qrPayload?.classroomLocation) {
                const geo = qrPayload.geo || qrPayload.classroomLocation;
                lecturerLocationRef.current = geo;
                setLecturerLocation(geo);
            }
            setSessionStartAt(result.sessionStartAt || Date.now());
            setKioskEndsAt(result.kioskEndsAt || (Date.now() + 180000));

            // Instant authoritative target calculation for QR2 countdown
            const calculatedQr2Target = result.qr2StartsAt || result.qr1ExpiresAt || (Date.now() + 60000);
            setAuthQr2StartsAt(calculatedQr2Target);
            const totalWaitSec = result.qr1DurationSeconds || Math.max(15, Math.round((calculatedQr2Target - (result.sessionStartAt || Date.now())) / 1000)) || 15;
            setAuthQr1DurationSec(totalWaitSec);

            // Move to Kiosk Supervised Waiting state immediately so the countdown displays on the student screen
            setScanState('KIOSK_WAITING_QR2');

            // Turn off camera tracks completely while waiting for QR 2 (strictly no scanning, saves battery)
            releaseAllMediaTracks();
            releaseCameraLock();

            // Start Android Lock Task Mode, Web Supervision & Device Policy Restrictions in background
            Kiosk.setAttendanceRestrictions()
                .then(() => Kiosk.startKioskMode())
                .catch((kioskErr) => console.warn('[Kiosk] Notice starting kiosk mode:', kioskErr));

            // Device Owner: disable screen capture/recording at OS level
            Kiosk.setScreenCaptureDisabled({ disabled: true }).catch(() => { });

            // Pre-fetch student biometric template in background
            lookupStudentBiometrics(result.rollNo || loggedInRollNo).catch((bioErr) => {
                console.warn('Biometrics lookup notice:', bioErr);
            });

            // iOS Apple Guided Access Check: Only enforce for native iOS app, never web Safari
            if (isNativeApp && isIOSDevice()) {
                isGuidedAccessEnabled().then((gaStatus) => {
                    if (!gaStatus.enabled) {
                        setShowGuidedAccessRequired(true);
                    }
                }).catch(() => { });
            }

            // Pre-warm biometric challenge for Phase 2 hardware verification
            prefetchBiometricChallenge(sessionId).catch(() => { });
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
            const currentSession = activeSessionId || sessionData?.sessionId || sessionData?.id || (typeof window !== 'undefined' ? (localStorage.getItem('smartattend_kiosk_session_id') || sessionStorage.getItem('smartattend_kiosk_session_id')) : '');
            const hardwareBio = await verifyHardwareBiometric(user?.uid, "SmartAttend Classroom Verification", currentSession);
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
            }, 350);
        } catch (bioErr) {
            console.warn("[Scanner] Hardware biometric notice:", bioErr);
            setFingerprintError(bioErr.message || "Fingerprint authentication error.");
            setFingerprintVerifying(false);
        }
    }, [user?.uid, activeSessionId, sessionData?.sessionId, sessionData?.id]);

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
    const handleProcessQR2 = async (sessionId, qr2Token, qrPayload = null) => {
        if (!user) {
            setErrorMessage('Please log in to submit attendance.');
            return;
        }

        // Strictly block QR 2 validation if student is disqualified or has an unexcused violation
        if (scanState === 'DISQUALIFIED' || violationCount > 0 || supervisionViolation) {
            setErrorMessage('❌ Attendance Disqualified: Security violation detected on your session. Attendance forfeited.');
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
            if (qrPayload) setActiveQr2Payload(qrPayload);
            const result = await validateStudentQR2(targetSession, qr2Token, qrPayload);

            setActiveSessionId(targetSession);
            setActiveQr2Token(qr2Token);
            if (result.kioskEndsAt) setKioskEndsAt(result.kioskEndsAt);

            // Pre-warm biometric challenge for immediate hardware fingerprint verification
            prefetchBiometricChallenge(targetSession).catch(() => { });

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
            await new Promise((resolve) => setTimeout(resolve, 60));

            // Dual Biometric Gate: Native mobile devices must verify physical fingerprint first
            fingerprintAutoTriggeredRef.current = false;
            setBiometricComboStep(isNativeApp ? 'FINGERPRINT' : 'FACE');
            setFingerprintError('');
            setScanState('BIOMETRIC_SCAN');
        } catch (err) {
            console.error('Error validating QR 2:', err);
            const msg = err.message || '';
            if (msg.includes('violation') || msg.includes('disqualified') || msg.includes('unexcused')) {
                setErrorMessage('❌ Attendance Disqualified: Security violation detected on your session. Attendance forfeited.');
                setScanState('DISQUALIFIED');
                setSupervisionViolation(true);
            } else if (msg.includes('QR 1') || msg.includes('Access denied') || msg.includes('Access Denied')) {
                setErrorMessage('⛔ Access Denied: You did not scan QR 1 during Phase 1 (0:00 - 1:00). You cannot mark attendance for this session.');
                setScanState(activeSessionId ? 'KIOSK_WAITING_QR2' : 'IDLE');
            } else {
                setErrorMessage(msg || 'Invalid Phase 2 QR code.');
                setScanState(activeSessionId ? 'KIOSK_WAITING_QR2' : 'IDLE');
            }
        }
    };

    // Master Scan Handler with Dynamic Token Expiry & Geofence Enforcement
    const processSessionString = async (raw) => {
        if (!raw) return;

        // STRICT ENFORCEMENT: Students cannot scan any attendance QR without both Face and Fingerprint biometrics registered
        if (isStudentUser && !studentBioStatus.isComplete) {
            alert('⚠️ Biometrics Required!\n\nYou must register both Face and Fingerprint before scanning attendance QR codes.\n\nPlease complete your biometric registration first.');
            setShowBiometricsRequiredModal(true);
            setErrorMessage('⚠️ Biometrics Required: Please register your face and fingerprint biometrics before scanning.');
            return;
        }

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

        // =========================================================================
        // IMMEDIATE SECURITY CHECK: VPN & Proxy Detection (Alert Student Directly)
        // =========================================================================
        const vpnStatus = await checkVpnAndNetworkSecurity();
        if (vpnStatus && vpnStatus.isVpn) {
            console.warn('[Scanner] Active VPN detected immediately on QR scan:', vpnStatus.reason);
            alert('🚨 VPN / Proxy Detected!\n\nVPNs and network proxies are strictly prohibited during attendance.\nPlease disconnect your VPN and try again.');
            setVpnDetails(vpnStatus.reason || 'Active VPN tunnel or proxy detected');
            setShowVpnModal(true);
            geofenceAttemptsRef.current += 1;
            const currentAttempts = geofenceAttemptsRef.current;
            setGeofenceAttempts(currentAttempts);
            if (currentAttempts >= 3) {
                setErrorMessage('❌ Attendance Rejected: Maximum security attempts (3/3) exceeded. Active VPN detected on device. Attendance forfeited.');
                setScanState('DISQUALIFIED');
                setSupervisionViolation(true);
                if (activeSessionId || payload.sessionId) {
                    recordSessionViolation(activeSessionId || payload.sessionId, user?.uid, loggedInRollNo, 'VPN_DETECTED');
                }
            } else {
                setErrorMessage(`❌ VPN Detected: VPNs and network proxies are strictly prohibited during attendance. Please disconnect your VPN and try again (Attempt ${currentAttempts}/3).`);
            }
            return;
        }

        // 2. Dynamic Geofence, Lecturer Distance Calculation & Fast Location Acquisition
        const classroomTarget = payload.geo || sessionData?.classroomLocation || lecturerLocationRef.current;
        if (classroomTarget) {
            lecturerLocationRef.current = classroomTarget;
            setLecturerLocation(classroomTarget);
        }
        const selectedGeofence = Number(classroomTarget?.radius ?? classroomTarget?.r ?? sessionData?.geofenceRadius ?? DEFAULT_GEOFENCE_RADIUS_METRES);
        const isGeofenceDisabled = selectedGeofence === 0 || classroomTarget?.enabled === false || sessionData?.geofenceRadius === 0;

        // Retrieve student's device location (instant pre-warmer, recent cache, or fast fix)
        // Fast, accurate candidate selection: gather all candidates across memory & local storage
        const candidates = [prewarmedLocationRef.current, currentStudentLocation];
        try {
            const cached = localStorage.getItem('smartattend_student_location');
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed) candidates.push(parsed);
            }
        } catch (_) {}

        // Pick best accurate location (prioritizing accuracy <= 45m)
        let studentCoords = pickBestStudentLocation(candidates);

        // Fast GPS Lock: If location is not yet acquired or is stale (>60s), quickly resolve within 1.5 seconds
        if ((!studentCoords || !isFreshLocation(studentCoords)) && typeof navigator !== "undefined" && navigator.geolocation) {
            try {
                const freshFix = await new Promise((resolve) => {
                    const tid = setTimeout(() => resolve(null), 1500);
                    navigator.geolocation.getCurrentPosition(
                        (pos) => {
                            clearTimeout(tid);
                            resolve({
                                latitude: pos.coords.latitude,
                                longitude: pos.coords.longitude,
                                accuracy: pos.coords.accuracy || 20,
                                timestamp: pos.timestamp || Date.now()
                            });
                        },
                        () => {
                            clearTimeout(tid);
                            resolve(null);
                        },
                        { enableHighAccuracy: true, timeout: 1400, maximumAge: 10000 }
                    );
                });
                if (freshFix) {
                    studentCoords = freshFix;
                    prewarmedLocationRef.current = freshFix;
                    setCurrentStudentLocation(freshFix);
                }
            } catch (_) {}
        }

        // Ensure location coordinates are never null when scanning in classroom
        if (!studentCoords && classroomTarget) {
            const cLat = Number(classroomTarget.latitude ?? classroomTarget.lat);
            const cLng = Number(classroomTarget.longitude ?? classroomTarget.lng ?? classroomTarget.lon);
            if (Number.isFinite(cLat) && Number.isFinite(cLng)) {
                studentCoords = {
                    latitude: cLat,
                    longitude: cLng,
                    accuracy: Number(classroomTarget.accuracy) || 25,
                    timestamp: Date.now()
                };
            }
        }

        // Continuous dual-lock GPS refinement runs concurrently with the flow without blocking
        if ((!studentCoords || !isAccurateLocation(studentCoords)) && !isGeofenceDisabled && typeof navigator !== "undefined" && navigator.geolocation) {
            acquireAccurateLocation(navigator.geolocation, {
                timeoutMs: 4000,
                maxAccuracy: MAX_CLASSROOM_LOCATION_ACCURACY_METERS,
                maximumAge: 10000
            }).then((freshFix) => {
                if (freshFix && isFreshLocation(freshFix)) {
                    prewarmedLocationRef.current = freshFix;
                    setCurrentStudentLocation(freshFix);
                    setScannedStudentLocation(freshFix);
                    try {
                        localStorage.setItem('smartattend_student_location', JSON.stringify(freshFix));
                    } catch (_) {}
                }
            }).catch(() => {});
        }

        // Store student's scanned location in state and persistent storage
        if (studentCoords) {
            setScannedStudentLocation(studentCoords);
            try {
                localStorage.setItem('smartattend_student_location', JSON.stringify(studentCoords));
                localStorage.setItem('smartattend_scanned_location', JSON.stringify(studentCoords));
            } catch (_) {}
        }

        // Calculate distance between student device and the specific lecturer who created the session
        let calculatedDistance = null;
        if (studentCoords && classroomTarget) {
            const sLat = Number(studentCoords.latitude ?? studentCoords.lat);
            const sLng = Number(studentCoords.longitude ?? studentCoords.lng ?? studentCoords.lon);
            const lLat = Number(classroomTarget.latitude ?? classroomTarget.lat);
            const lLng = Number(classroomTarget.longitude ?? classroomTarget.lng ?? classroomTarget.lon);
            if (Number.isFinite(sLat) && Number.isFinite(sLng) && Number.isFinite(lLat) && Number.isFinite(lLng)) {
                calculatedDistance = Math.round(calculateHaversineDistance(sLat, sLng, lLat, lLng) * 10) / 10;
            }
        }

        // 2.5 Strictly block scanning if student is in DISQUALIFIED state
        if (scanState === 'DISQUALIFIED' || violationCount > 0 || supervisionViolation) {
            console.warn('[Scanner] Scan rejected: Student is in DISQUALIFIED state.');
            setErrorMessage('❌ Attendance Disqualified: Security violation detected on your session. Attendance forfeited.');
            return;
        }

        const enhancedPayload = {
            ...payload,
            studentLocation: studentCoords ? {
                latitude: studentCoords.latitude,
                longitude: studentCoords.longitude,
                accuracy: studentCoords.accuracy,
                timestamp: studentCoords.timestamp || Date.now(),
                distanceToLecturer: calculatedDistance
            } : null,
            distance: calculatedDistance
        };

        // 3. If student is already checked in (in Kiosk Mode waiting for QR 2):
        // STRICTLY IGNORE any QR 1 scans until QR 2 is released by lecturer!
        const isCurrentSession = !activeSessionId || payload.sessionId === activeSessionId;
        const isWaitingForQr2ThisSession = scanState === 'KIOSK_WAITING_QR2' && isCurrentSession;

        if (isWaitingForQr2ThisSession) {
            const isQR2 = Boolean(payload.qr2Token || payload.phase === '2' || payload.phase === 'PHASE_2' || (sessionData?.phase === 'PHASE_2' && payload.sessionId === activeSessionId));
            const isQR1 = Boolean(payload.qr1Token || payload.phase === '1' || payload.phase === 'PHASE_1');

            if (!isQr2Released) {
                console.log('[Scanner] QR scan blocked: Phase 2 has not been released yet.');
                setErrorMessage('🔒 Scanning is locked. Please wait for the countdown to finish before scanning QR 2.');
                return;
            }

            if (isQR2) {
                console.log('[Scanner] Phase 2 (QR 2) scanned successfully. Proceeding to biometrics...');
                handleProcessQR2(payload.sessionId || activeSessionId, payload.qr2Token || payload.sessionId, enhancedPayload);
            } else if (isQR1) {
                // QR 1 is explicitly blocked from re-scanning!
                console.log('[Scanner] QR 1 ignored. Student already completed Phase 1 check-in. Waiting for Lecturer to display QR 2.');
                setErrorMessage('You have already scanned QR 1. Please scan QR 2 displayed on the screen.');
            } else if (sessionData?.phase === 'PHASE_2') {
                handleProcessQR2(payload.sessionId || activeSessionId, payload.qr2Token || payload.sessionId, enhancedPayload);
            }
            return;
        }

        // 4. Initial Phase 1: Mock GPS Check & Geofence Telemetry
        // 4A. Mock GPS Check: Reject spoofed / fake location
        if (studentCoords?.isMock || studentCoords?.mocked || studentCoords?.isMockLocation) {
            geofenceAttemptsRef.current += 1;
            const currentAttempts = geofenceAttemptsRef.current;
            setGeofenceAttempts(currentAttempts);
            if (currentAttempts >= 3) {
                setErrorMessage('❌ Attendance Rejected: Maximum attempts (3/3) exceeded. Mock GPS / Fake location detected. Attendance forfeited.');
                setScanState('DISQUALIFIED');
                setSupervisionViolation(true);
                if (activeSessionId || payload.sessionId) {
                    recordSessionViolation(activeSessionId || payload.sessionId, user?.uid, loggedInRollNo, 'MOCK_LOCATION_DETECTED');
                }
            } else {
                setErrorMessage(`🚨 Mock GPS Detected: Spoofed location detected. Please disable mock location apps (Attempt ${currentAttempts}/3).`);
            }
            return;
        }

        // 4B. Geofence Telemetry: Calculate distance and update live radar without halting the flow
        if (!isGeofenceDisabled && classroomTarget && calculatedDistance !== null) {
            let geoEval = evaluateGeofence(studentCoords, classroomTarget, geofenceAttemptsRef.current);
            setGpsTelemetry(geoEval);

            // If precision is still settling, refine in parallel without blocking check-in
            if (geoEval.status === "INCONCLUSIVE_RETRY" && typeof navigator !== "undefined" && navigator.geolocation) {
                acquireAccurateLocation(navigator.geolocation, {
                    timeoutMs: 6000,
                    maxAccuracy: MAX_CLASSROOM_LOCATION_ACCURACY_METERS,
                    maximumAge: 0
                }).then((refinedFix) => {
                    if (refinedFix && isFreshLocation(refinedFix)) {
                        prewarmedLocationRef.current = refinedFix;
                        setCurrentStudentLocation(refinedFix);
                        setScannedStudentLocation(refinedFix);
                    }
                }).catch(() => {});
            }

            const isWithinGeofence = geoEval.status === "PASS" || geoEval.status === "INCONCLUSIVE_RETRY";

            if (!isWithinGeofence && isAccurateLocation(studentCoords)) {
                geofenceAttemptsRef.current += 1;
                const currentAttempts = geofenceAttemptsRef.current;
                setGeofenceAttempts(currentAttempts);

                const displayDist = geoEval?.effectiveDistance !== undefined ? geoEval.effectiveDistance : calculatedDistance;
                if (currentAttempts >= 3) {
                    console.error(`[Geofence] Max attempts (3/3) exceeded. Distance: ${displayDist}m > ${selectedGeofence}m.`);
                    setErrorMessage(`❌ Attendance Rejected: Maximum attempts (3/3) exceeded. You are ${displayDist}m away from the lecturer (allowed: ≤ ${selectedGeofence}m). Attendance forfeited.`);
                    setScanState('DISQUALIFIED');
                    setSupervisionViolation(true);
                    if (activeSessionId || payload.sessionId) {
                        recordSessionViolation(activeSessionId || payload.sessionId, user?.uid, loggedInRollNo, 'GEOFENCE_EXCEEDED_MAX_ATTEMPTS');
                    }
                    return;
                } else {
                    console.warn(`[Geofence] Attempt ${currentAttempts}/3 rejected. Distance: ${displayDist}m > ${selectedGeofence}m.`);
                    setErrorMessage(`❌ Geofence Rejection: You are ${displayDist}m away from the lecturer (allowed: ≤ ${selectedGeofence}m). Attempt ${currentAttempts}/3. Please move closer to the lecturer and scan again.`);
                    return;
                }
            }
        }

        // 4D. Accepted to next layer! Reset attempt counter and enter Kiosk mode
        geofenceAttemptsRef.current = 0;
        setGeofenceAttempts(0);

        if (payload.qr1Token || payload.phase === '1' || payload.phase === 'PHASE_1') {
            await handleProcessQR1(payload.sessionId, payload.qr1Token, studentCoords, enhancedPayload);
        } else if (payload.qr2Token || payload.phase === '2' || payload.phase === 'PHASE_2') {
            await handleProcessQR2(payload.sessionId, payload.qr2Token, enhancedPayload);
        } else {
            await handleProcessQR1(payload.sessionId, payload.sessionId, studentCoords, enhancedPayload);
        }
    };

    const autoCheckedUrlRef = useRef(false);
    // Auto-check URL search params on mount (e.g. if student opened link directly)
    useEffect(() => {
        if (loading) return;
        if (!user) return;
        if (autoCheckedUrlRef.current) return;

        const urlSession = searchParams.get('session');
        const urlQr1 = searchParams.get('qr1Token');
        const urlQr2 = searchParams.get('qr2Token');
        const urlPhase = searchParams.get('phase');

        if (urlSession && (urlQr1 || urlPhase === '1')) {
            autoCheckedUrlRef.current = true;
            try { window.history.replaceState({}, '', window.location.pathname); } catch (_) { }
            handleProcessQR1(urlSession, urlQr1 || urlSession);
        } else if (urlSession && (urlQr2 || urlPhase === '2')) {
            autoCheckedUrlRef.current = true;
            try { window.history.replaceState({}, '', window.location.pathname); } catch (_) { }
            handleProcessQR2(urlSession, urlQr2 || urlSession);
        }
    }, [searchParams, loading, user]);

    const processSessionStringRef = useRef(processSessionString);
    useEffect(() => {
        processSessionStringRef.current = processSessionString;
    }, [processSessionString]);

    const handleCameraScan = useCallback((result) => {
        if (!result) return;
        if (isStudentUser && !studentBioStatus.isComplete) {
            alert('⚠️ Biometrics Required!\n\nYou must register both Face and Fingerprint before scanning attendance QR codes.\n\nPlease complete your biometric registration first.');
            setShowBiometricsRequiredModal(true);
            return;
        }
        const raw = result[0]?.rawValue || (typeof result === 'string' ? result : '');
        if (!raw || scanProcessingRef.current || !processSessionStringRef.current) return;

        scanProcessingRef.current = true;
        Promise.resolve(processSessionStringRef.current(raw))
            .catch((err) => {
                console.error('[Scanner] QR processing failed:', err);
                setErrorMessage(err.message || 'Unable to process this QR code. Please try again.');
            })
            .finally(() => {
                scanProcessingRef.current = false;
            });
    }, [isStudentUser, studentBioStatus]);

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

        if (isStudentUser && !studentBioStatus.isComplete) {
            alert('⚠️ Biometrics Required!\n\nYou must register both Face and Fingerprint before scanning attendance QR codes.\n\nPlease complete your biometric registration first.');
            setShowBiometricsRequiredModal(true);
            return;
        }

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

                // Enforce that attendance can only be submitted if device is confirmed within geofence
                const classroomTarget = activeQr2Payload?.geo || sessionData?.classroomLocation || lecturerLocationRef.current;
                const selectedGeofence = Number(classroomTarget?.radius ?? classroomTarget?.r ?? sessionData?.geofenceRadius ?? DEFAULT_GEOFENCE_RADIUS_METRES);
                const isGeofenceDisabled = selectedGeofence === 0 || classroomTarget?.enabled === false || sessionData?.geofenceRadius === 0;

                if (!isGeofenceDisabled && classroomTarget) {
                    let locForSubmit = pickBestStudentLocation([
                        scannedStudentLocation,
                        currentStudentLocation,
                        prewarmedLocationRef.current
                    ]);

                    // Fast continuous refinement to guarantee accurate GPS at submission time
                    if ((!locForSubmit || !isAccurateLocation(locForSubmit)) && typeof navigator !== "undefined" && navigator.geolocation) {
                        try {
                            const fresh = await acquireAccurateLocation(navigator.geolocation, {
                                timeoutMs: 5000,
                                maxAccuracy: MAX_CLASSROOM_LOCATION_ACCURACY_METERS,
                                maximumAge: 15000
                            });
                            if (fresh && isFreshLocation(fresh)) {
                                locForSubmit = fresh;
                                setCurrentStudentLocation(fresh);
                            }
                        } catch (_) {}
                    }

                    if (locForSubmit) {
                        const geoCheck = evaluateGeofence(locForSubmit, classroomTarget, 0);
                        setGpsTelemetry(geoCheck);
                        if (geoCheck.status === "MOCK_DETECTED") {
                            setSubmittingAttendance(false);
                            setErrorMessage("🚨 Mock / Fake GPS detected. Attendance submission blocked.");
                            setScanState("DISQUALIFIED");
                            return;
                        }
                        if (geoCheck.status === "REJECT") {
                            setSubmittingAttendance(false);
                            setErrorMessage(`❌ Attendance Submission Blocked: Your device is ${geoCheck.distance}m away (outside classroom boundary of ${geoCheck.radius}m). Attendance can only be submitted within the classroom.`);
                            return;
                        }
                    }
                }

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
                        hardwareProof,
                        activeQr2Payload
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
                    if (subErr.message?.includes('already recorded') || subErr.message?.includes('already-exists') || subErr.message?.includes('already been recorded') || subErr.message?.includes('already submitted')) {
                        setErrorMessage('');
                        setScanState('ATTENDANCE_SUCCESS');
                        return;
                    }
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
    }, [activeSessionId, activeQr2Token, activeQr2Payload, submittingAttendance, loggedInRollNo, loggedInName, sessionData, hardwareProof]);

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

    // Render Student Biometrics Precondition Modal
    const renderBiometricsRequiredModal = () => {
        if (!showBiometricsRequiredModal) return null;
        return (
            <div style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(15, 23, 42, 0.92)',
                zIndex: 99999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '20px'
            }}>
                <div style={{
                    background: '#ffffff',
                    borderRadius: '24px',
                    maxWidth: '440px',
                    width: '100%',
                    padding: '28px',
                    textAlign: 'center',
                    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.4)',
                    border: '2px solid #f59e0b'
                }}>
                    <div style={{
                        width: '64px',
                        height: '64px',
                        borderRadius: '50%',
                        background: '#fef3c7',
                        color: '#d97706',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '32px',
                        margin: '0 auto 16px'
                    }}>
                        <FaUserCheck />
                    </div>
                    <h3 style={{ fontSize: '1.35rem', fontWeight: 800, color: '#92400e', margin: '0 0 10px 0' }}>
                        Biometrics Registration Required
                    </h3>
                    <p style={{ fontSize: '0.92rem', color: '#334155', lineHeight: 1.5, margin: '0 0 16px 0' }}>
                        To ensure physical presence and prevent proxy attendance, all students must enroll both <strong>Face Biometrics</strong> and <strong>Device Fingerprint</strong> before scanning.
                    </p>
                    <div style={{
                        textAlign: 'left',
                        background: '#f8fafc',
                        padding: '14px 18px',
                        borderRadius: '12px',
                        border: '1px solid #e2e8f0',
                        marginBottom: '20px',
                        fontSize: '0.86rem',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {studentBioStatus.hasFace ? <FaCheckCircle style={{ color: '#10b981' }} /> : <FaExclamationTriangle style={{ color: '#f59e0b' }} />}
                            <span style={{ color: studentBioStatus.hasFace ? '#15803d' : '#b45309', fontWeight: 700 }}>
                                Face Biometrics: {studentBioStatus.hasFace ? 'Enrolled' : 'Not Registered'}
                            </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {studentBioStatus.hasHw ? <FaCheckCircle style={{ color: '#10b981' }} /> : <FaExclamationTriangle style={{ color: '#f59e0b' }} />}
                            <span style={{ color: studentBioStatus.hasHw ? '#15803d' : '#b45309', fontWeight: 700 }}>
                                Device Fingerprint: {studentBioStatus.hasHw ? 'Enrolled' : 'Not Registered'}
                            </span>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '10px' }}>
                        <button
                            type="button"
                            onClick={() => setShowBiometricsRequiredModal(false)}
                            style={{
                                flex: 1,
                                padding: '12px',
                                borderRadius: '12px',
                                background: 'transparent',
                                border: '1px solid #cbd5e1',
                                color: '#64748b',
                                fontWeight: 700,
                                fontSize: '0.9rem',
                                cursor: 'pointer'
                            }}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setShowBiometricsRequiredModal(false);
                                navigate('/student/face-enroll');
                            }}
                            style={{
                                flex: 2,
                                padding: '12px',
                                borderRadius: '12px',
                                background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                                color: '#ffffff',
                                border: 'none',
                                fontWeight: 800,
                                fontSize: '0.92rem',
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '8px',
                                boxShadow: '0 4px 12px rgba(245, 158, 11, 0.3)'
                            }}
                        >
                            <FaCamera /> Register Biometrics
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    // Render High-Visibility VPN / Proxy Security Modal
    const renderVpnModal = () => {
        if (!showVpnModal) return null;
        return (
            <div style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(15, 23, 42, 0.94)',
                zIndex: 99999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '20px'
            }}>
                <div style={{
                    background: '#ffffff',
                    borderRadius: '24px',
                    maxWidth: '440px',
                    width: '100%',
                    padding: '28px',
                    textAlign: 'center',
                    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.4)',
                    border: '2px solid #ef4444'
                }}>
                    <div style={{
                        width: '64px',
                        height: '64px',
                        borderRadius: '50%',
                        background: '#fee2e2',
                        color: '#dc2626',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '32px',
                        margin: '0 auto 16px'
                    }}>
                        <FaShieldAlt />
                    </div>
                    <h3 style={{ fontSize: '1.35rem', fontWeight: 800, color: '#991b1b', margin: '0 0 10px 0' }}>
                        VPN / Proxy Detected
                    </h3>
                    <p style={{ fontSize: '0.92rem', color: '#334155', lineHeight: 1.5, margin: '0 0 14px 0' }}>
                        SmartAttend security has detected an active VPN tunnel or network proxy on your device.
                    </p>
                    {vpnDetails && (
                        <div style={{
                            padding: '10px 14px',
                            borderRadius: '10px',
                            background: '#f8fafc',
                            border: '1px solid #e2e8f0',
                            fontSize: '0.82rem',
                            color: '#64748b',
                            marginBottom: '16px',
                            wordBreak: 'break-word'
                        }}>
                            {vpnDetails}
                        </div>
                    )}
                    <p style={{ fontSize: '0.86rem', color: '#64748b', margin: '0 0 20px 0' }}>
                        VPNs and proxies are strictly prohibited during attendance to ensure physical presence. Please turn OFF your VPN in Settings and tap Retry.
                    </p>
                    <button
                        type="button"
                        onClick={async () => {
                            setShowVpnModal(false);
                            setErrorMessage('');
                            const recheck = await checkVpnAndNetworkSecurity();
                            if (recheck?.isVpn) {
                                alert('🚨 VPN Still Detected!\nPlease turn off your VPN in phone Settings before retrying.');
                                setShowVpnModal(true);
                            }
                        }}
                        style={{
                            width: '100%',
                            padding: '14px',
                            borderRadius: '14px',
                            background: 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)',
                            color: '#ffffff',
                            border: 'none',
                            fontWeight: 800,
                            fontSize: '0.96rem',
                            cursor: 'pointer',
                            boxShadow: '0 4px 14px rgba(220, 38, 38, 0.35)'
                        }}
                    >
                        I Disconnected VPN — Retry Scan
                    </button>
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

    // Live GPS Coordinates & Lecturer Proximity Telemetry Component
    const renderGpsTelemetryCard = () => (
        <div style={{
            margin: '12px auto 16px',
            width: '100%',
            maxWidth: '480px',
            padding: '12px 16px',
            borderRadius: '16px',
            background: 'var(--surface, #ffffff)',
            border: gpsTelemetry?.status === 'REJECT' ? '1.5px solid #ef4444' : (gpsTelemetry?.status === 'PASS' ? '1.5px solid #10b981' : '1px solid var(--border, #e2e8f0)'),
            boxShadow: '0 4px 14px rgba(0, 0, 0, 0.05)',
            textAlign: 'left',
            boxSizing: 'border-box'
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--text-muted, #475569)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <FaMapMarkerAlt style={{ color: '#6366f1' }} /> GPS Proximity &amp; Distance
                </span>
                {gpsTelemetry?.status === 'PASS' ? (
                    <span style={{ fontSize: '0.74rem', fontWeight: 800, color: '#059669', background: 'rgba(16, 185, 129, 0.12)', padding: '2px 8px', borderRadius: '6px' }}>
                        ✓ Within Classroom ({gpsTelemetry.distance <= 1.5 ? '< 1m' : `${gpsTelemetry.distance}m`})
                    </span>
                ) : gpsTelemetry?.status === 'REJECT' ? (
                    <span style={{ fontSize: '0.74rem', fontWeight: 800, color: '#dc2626', background: 'rgba(239, 68, 68, 0.12)', padding: '2px 8px', borderRadius: '6px' }}>
                        ✕ Outside Limit ({gpsTelemetry.distance}m)
                    </span>
                ) : (
                    <span style={{ fontSize: '0.74rem', fontWeight: 700, color: '#4f46e5', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <FaSpinner className="fa-spin" style={{ fontSize: '0.7rem' }} /> GNSS Active
                    </span>
                )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px', fontSize: '0.78rem' }}>
                <div style={{ padding: '8px 10px', background: 'var(--bg-subtle, #f8fafc)', borderRadius: '10px' }}>
                    <div style={{ color: '#64748b', fontSize: '0.7rem', fontWeight: 600 }}>
                        {scannedStudentLocation ? '📍 Scanned Device Location' : 'Student Location'}
                    </div>
                    <div style={{ fontWeight: 750, color: 'var(--text-main, #0f172a)' }}>
                        {(scannedStudentLocation || currentStudentLocation)
                            ? `${(scannedStudentLocation || currentStudentLocation).latitude.toFixed(4)}, ${(scannedStudentLocation || currentStudentLocation).longitude.toFixed(4)}`
                            : 'Acquiring satellite lock...'}
                    </div>
                    {(scannedStudentLocation || currentStudentLocation) && (
                        <div style={{ fontSize: '0.68rem', color: '#10b981', fontWeight: 600 }}>
                            GNSS Precision: ±{Math.round((scannedStudentLocation || currentStudentLocation).accuracy || 15)}m
                        </div>
                    )}
                </div>

                <div style={{ padding: '8px 10px', background: 'var(--bg-subtle, #f8fafc)', borderRadius: '10px' }}>
                    <div style={{ color: '#64748b', fontSize: '0.7rem', fontWeight: 600 }}>Distance to Lecturer</div>
                    <div style={{
                        fontWeight: 800,
                        fontSize: '0.88rem',
                        color: (gpsTelemetry?.distance !== undefined && gpsTelemetry?.distance !== null)
                            ? ((gpsTelemetry.status === 'PASS' || gpsTelemetry.distance <= (gpsTelemetry.radius || 10)) ? '#059669' : '#dc2626')
                            : '#4338ca'
                    }}>
                        {gpsTelemetry?.distance !== undefined && gpsTelemetry?.distance !== null
                            ? (gpsTelemetry.status === 'PASS'
                                ? (gpsTelemetry.distance <= 1.5
                                    ? `< 1m (Co-located · Verified)`
                                    : `${gpsTelemetry.distance}m (In Classroom Range)`)
                                : `${gpsTelemetry.distance} metres`)
                            : (gpsTelemetry?.locationAcquiring ? 'Measuring distance...' : 'Scan QR on screen')}
                    </div>
                    <div style={{
                        fontSize: '0.68rem',
                        color: gpsTelemetry?.status === 'PASS' ? '#059669' : '#64748b',
                        fontWeight: gpsTelemetry?.status === 'PASS' ? 700 : 500
                    }}>
                        {gpsTelemetry?.status === 'PASS'
                            ? `✓ Within Classroom Limit (≤ ${gpsTelemetry.radius || 10}m)`
                            : (gpsTelemetry?.radius ? `Boundary: ≤ ${gpsTelemetry.radius}m` : 'Classroom Geofence')}
                    </div>
                </div>
            </div>

            {geofenceAttempts > 0 && (
                <div style={{
                    marginTop: '8px',
                    padding: '6px 10px',
                    borderRadius: '8px',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    fontSize: '0.74rem',
                    color: '#b91c1c',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontWeight: 700
                }}>
                    <span>⚠️ Geofence Attempt: {geofenceAttempts}/3</span>
                    <span>{Math.max(0, 3 - geofenceAttempts)} attempt{3 - geofenceAttempts === 1 ? '' : 's'} remaining</span>
                </div>
            )}
        </div>
    );

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
                {renderBiometricsRequiredModal()}
                {renderVpnModal()}

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
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center' }}>
                                    <button
                                        type="button"
                                        onClick={handleTriggerFingerprint}
                                        style={{
                                            padding: '12px 20px',
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
                                    <button
                                        type="button"
                                        onClick={() => setBiometricComboStep('FACE')}
                                        style={{
                                            padding: '12px 20px',
                                            borderRadius: '12px',
                                            background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
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
                                        <FaCamera /> Verify with 3D Face Scan Instead
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center' }}>
                                    <button
                                        type="button"
                                        onClick={handleTriggerFingerprint}
                                        disabled={fingerprintVerifying}
                                        style={{
                                            padding: '14px 24px',
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
                                    <button
                                        type="button"
                                        onClick={() => setBiometricComboStep('FACE')}
                                        style={{
                                            padding: '14px 20px',
                                            borderRadius: '14px',
                                            background: 'var(--surface, #ffffff)',
                                            color: '#4f46e5',
                                            border: '1.5px solid #6366f1',
                                            fontWeight: 800,
                                            fontSize: '0.92rem',
                                            cursor: 'pointer',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '8px'
                                        }}
                                    >
                                        <FaCamera /> Verify with 3D Face
                                    </button>
                                </div>
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
                            onEnrollRequest={() => navigate('/student/face-enroll')}
                        />

                        {verifiedStudent && !verifiedStudent.faceRegistered && !lookingUpStudent && (
                            <div style={{ marginTop: '16px', textAlign: 'center' }}>
                                <button
                                    type="button"
                                    onClick={() => navigate('/student/face-enroll')}
                                    style={{
                                        padding: '12px 24px',
                                        borderRadius: '12px',
                                        background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
                                        color: '#ffffff',
                                        border: 'none',
                                        fontWeight: 800,
                                        fontSize: '0.92rem',
                                        cursor: 'pointer',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        boxShadow: '0 4px 14px rgba(99, 102, 241, 0.35)'
                                    }}
                                >
                                    <FaCamera /> Enroll / Register Face Biometrics Now
                                </button>
                            </div>
                        )}
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
        const totalDuration = sessionData?.qr1DurationSeconds || authQr1DurationSec || 15;
        const remainingSec = secondsUntilQr2 !== null ? secondsUntilQr2 : 0;
        const progressFraction = Math.max(0, Math.min(1, remainingSec / totalDuration));
        const CIRCUMFERENCE = 465;
        const strokeOffset = CIRCUMFERENCE * (1 - progressFraction);

        return (
            <div className="st-scanner-container">
                {renderLecturerPinModal()}
                {renderBiometricsRequiredModal()}
                {renderVpnModal()}

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
                    {isQr2Released ? <FaBolt style={{ color: '#10b981' }} /> : <FaClock style={{ color: '#6366f1' }} />}
                    <span>{isQr2Released ? 'QR 2 Released · Scan the next QR' : 'Phase 1 Complete · Waiting for lecturer to release QR 2'}</span>
                </div>

                {/* Live GPS & Lecturer Distance Telemetry */}
                {renderGpsTelemetryCard()}

                {!isQr2Released ? (
                    /* Hero Supervised Waiting & Countdown Card (Strictly No Scanning) */
                    <div className="st-kiosk-hero-card">
                        <div className="st-kiosk-glow-orb" />

                        {/* Phase 1 Recorded Badge */}
                        <div className="st-phase1-success-badge">
                            <FaCheckCircle className="st-success-check-icon" />
                            <span>Phase 1 Check-In Recorded</span>
                        </div>

                        <div className="st-kiosk-session-title">
                            {sessionData?.courseCode || 'Classroom Attendance'}
                        </div>
                        <div className="st-kiosk-session-sub">
                            {sessionData?.lecturerName ? `Lecturer: ${sessionData.lecturerName}` : 'Session Active'} · {sessionData?.roomNo ? `Room ${sessionData.roomNo}` : loggedInRollNo}
                        </div>

                        {/* Circular SVG Animated Countdown Ring */}
                        <div className="st-timer-ring-container">
                            {/* Dynamic Rotating Orbit Spinner & Radar Sweep */}
                            <div className="st-timer-orbit-spinner" />
                            <div className="st-timer-radar-sweep" />

                            <svg className="st-timer-svg" viewBox="0 0 180 180">
                                <defs>
                                    <linearGradient id="stTimerGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                        <stop offset="0%" stopColor="#38bdf8" />
                                        <stop offset="50%" stopColor="#818cf8" />
                                        <stop offset="100%" stopColor="#c084fc" />
                                    </linearGradient>
                                </defs>
                                <circle
                                    className="st-timer-bg-circle"
                                    cx="90"
                                    cy="90"
                                    r="74"
                                />
                                <circle
                                    className="st-timer-progress-circle"
                                    cx="90"
                                    cy="90"
                                    r="74"
                                    strokeDasharray={CIRCUMFERENCE}
                                    strokeDashoffset={strokeOffset}
                                />
                            </svg>

                            <div className="st-timer-center-content">
                                <div className="st-timer-icon-wrap">
                                    <FaSyncAlt className="st-timer-turning-sync-icon" />
                                </div>
                                <div className="st-timer-digital">
                                    {secondsUntilQr2 !== null && secondsUntilQr2 > 0 ? (
                                        <>
                                            {String(Math.floor(secondsUntilQr2 / 60)).padStart(2, '0')}:
                                            {String(secondsUntilQr2 % 60).padStart(2, '0')}
                                        </>
                                    ) : (
                                        '00:00'
                                    )}
                                </div>
                                <div className="st-timer-subtext">
                                    LOADING PHASE 2 QR
                                </div>
                            </div>
                        </div>

                        {/* Live Turning Loading Badge */}
                        <div className="st-turning-loader-badge">
                            <span className="st-turning-dot-pulse" />
                            <span>Actively synchronizing session · Auto-loading Phase 2 QR</span>
                        </div>

                        {/* Strict Camera Paused / Locked Indicator */}
                        <div className="st-camera-paused-card">
                            <div className="st-paused-header">
                                <span className="st-paused-lock-pill">
                                    <FaLock /> Camera Paused &amp; Scanning Locked
                                </span>
                            </div>
                            <p className="st-paused-desc">
                                All scanning is paused to conserve battery and enforce integrity. Please attend to your lecture. Your camera will automatically reactivate the moment Phase 2 begins.
                            </p>
                        </div>

                        {/* Live Sync Status */}
                        <div className="st-live-sync-indicator">
                            <span className="st-sync-dot"></span>
                            <span>Connected to Lecturer's Session · Listening for QR 2 broadcast</span>
                        </div>
                    </div>
                ) : (
                    /* Phase 2 Live View (Camera view smoothly morphs in) */
                    <div className="st-phase2-active-card">
                        <div className="st-phase2-floating-banner">
                            <span className="st-sync-dot" style={{ background: '#ffffff', boxShadow: '0 0 10px #ffffff' }}></span>
                            <FaBolt />
                            <span>⚡ Phase 2 Live · Scan QR 2 on Screen Now</span>
                        </div>

                        <div className="st-camera-viewport-card active-phase2">
                            {isCameraAllowed ? (
                                <NativeQrScanner
                                    key={`waiting-${retryKey}-${effectiveFacingMode}`}
                                    onScan={handleCameraScan}
                                    onError={handleCameraError}
                                    facingMode={effectiveFacingMode}
                                    onToggleFacingMode={handleToggleFacingMode}
                                    active={scanState === 'KIOSK_WAITING_QR2' && isQr2Released}
                                />
                            ) : (
                                <div className="st-browser-camera-blocked-card" style={{ padding: '24px', textAlign: 'center', background: '#ffffff', borderRadius: '16px' }}>
                                    <FaLock style={{ fontSize: '32px', color: '#dc2626', marginBottom: '10px' }} />
                                    <h4 style={{ color: '#991b1b', margin: '0 0 8px' }}>Camera Blocked in Web Browser</h4>
                                    <p style={{ fontSize: '0.88rem', color: '#64748b', margin: 0 }}>
                                        Camera in browser is only available for Lecturers, Admins, and iPhone users. Please use the official SmartAttend Android App (.apk).
                                    </p>
                                </div>
                            )}
                        </div>

                        <div className="st-phase2-instruction">
                            Point your device's camera at the Phase 2 QR code displayed on the classroom screen.
                        </div>
                    </div>
                )}

                {errorMessage && (
                    <div className="st-scanner-error-banner" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                            <div>{errorMessage}</div>
                            <button
                                type="button"
                                onClick={() => setErrorMessage('')}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: '#b91c1c',
                                    cursor: 'pointer',
                                    fontSize: '1rem',
                                    padding: '0 4px',
                                    flexShrink: 0
                                }}
                                title="Dismiss"
                            >
                                ✕
                            </button>
                        </div>
                        {(errorMessage.includes('Geofence') || errorMessage.includes('GPS') || errorMessage.includes('outside')) && (
                            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                                <button
                                    type="button"
                                    onClick={async () => {
                                        setErrorMessage('📍 Recalibrating high-precision GPS lock...');
                                        if (typeof navigator !== "undefined" && navigator.geolocation) {
                                            try {
                                                const loc = await acquireAccurateLocation(navigator.geolocation, {
                                                    timeoutMs: 6500,
                                                    maxAccuracy: MAX_CLASSROOM_LOCATION_ACCURACY_METERS
                                                });
                                                if (loc && isFreshLocation(loc)) {
                                                    prewarmedLocationRef.current = loc;
                                                    setCurrentStudentLocation(loc);
                                                    try { localStorage.setItem('smartattend_student_location', JSON.stringify(loc)); } catch (_) {}
                                                    setErrorMessage('');
                                                } else {
                                                    setErrorMessage('⚠️ GPS lock acquired but precision is low. Please move near a window or outdoors and retry.');
                                                }
                                            } catch (err) {
                                                setErrorMessage(`⚠️ GPS refresh failed: ${err?.message || 'Unable to acquire satellite fix'}`);
                                            }
                                        }
                                    }}
                                    style={{
                                        padding: '6px 12px',
                                        borderRadius: '8px',
                                        background: '#b91c1c',
                                        color: '#ffffff',
                                        border: 'none',
                                        fontSize: '0.78rem',
                                        fontWeight: 800,
                                        cursor: 'pointer'
                                    }}
                                >
                                    🔄 Recalibrate &amp; Refresh GPS
                                </button>
                            </div>
                        )}
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

            {/* Student Biometrics Precondition Banner */}
            {isStudentUser && !studentBioStatus.isComplete && (
                <div style={{
                    margin: '0 0 16px 0',
                    padding: '16px 18px',
                    borderRadius: '16px',
                    background: '#fffbeb',
                    border: '2px solid #f59e0b',
                    boxShadow: '0 4px 12px rgba(245, 158, 11, 0.15)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#b45309', fontWeight: 800, fontSize: '0.98rem' }}>
                        <FaExclamationTriangle style={{ fontSize: '1.25rem', flexShrink: 0 }} />
                        <span>Biometrics Registration Required</span>
                    </div>
                    <p style={{ margin: 0, fontSize: '0.86rem', color: '#78350f', lineHeight: 1.45 }}>
                        You cannot scan attendance until your <strong>Face</strong> and <strong>Fingerprint</strong> biometrics are registered. Please complete enrollment to enable scanning.
                    </p>
                    <button
                        type="button"
                        onClick={() => navigate('/student/face-enroll')}
                        style={{
                            alignSelf: 'flex-start',
                            padding: '9px 18px',
                            borderRadius: '10px',
                            background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                            color: '#ffffff',
                            border: 'none',
                            fontWeight: 800,
                            fontSize: '0.86rem',
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '8px',
                            boxShadow: '0 4px 12px rgba(245, 158, 11, 0.25)'
                        }}
                    >
                        <FaCamera /> Register Biometrics Now
                    </button>
                </div>
            )}

            {/* Camera Viewport (Spacious, rounded card) */}
            <div className="st-camera-viewport-card">
                {isCameraAllowed && scannerActive ? (
                    <NativeQrScanner
                        key={`${retryKey}-${effectiveFacingMode}`}
                        onScan={handleCameraScan}
                        onError={handleCameraError}
                        facingMode={effectiveFacingMode}
                        onToggleFacingMode={handleToggleFacingMode}
                        active={scannerActive}
                    />
                ) : !isCameraAllowed ? (
                    <div className="st-browser-camera-blocked-card" style={{
                        padding: '32px 24px',
                        textAlign: 'center',
                        background: '#ffffff',
                        borderRadius: '20px',
                        border: '2px solid #fecaca',
                        boxShadow: '0 10px 25px -5px rgba(239, 68, 68, 0.1)'
                    }}>
                        <div style={{
                            width: '68px',
                            height: '68px',
                            margin: '0 auto 16px',
                            borderRadius: '50%',
                            background: '#fee2e2',
                            color: '#dc2626',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '30px'
                        }}>
                            <FaLock />
                        </div>
                        <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#991b1b', margin: '0 0 10px 0' }}>
                            Camera Blocked in Web Browser
                        </h3>
                        <p style={{ fontSize: '0.92rem', color: '#475569', lineHeight: 1.55, margin: '0 0 16px 0' }}>
                            Per college attendance security policy, camera access in the web browser is only available for <strong>Lecturers</strong>, <strong>Admins</strong>, and <strong>iPhone users</strong>.
                        </p>
                        <div style={{
                            padding: '12px 16px',
                            borderRadius: '12px',
                            background: '#fef2f2',
                            border: '1px solid #fecaca',
                            color: '#b91c1c',
                            fontSize: '0.85rem',
                            fontWeight: 700,
                            marginBottom: '20px',
                            textAlign: 'left',
                            lineHeight: 1.45
                        }}>
                            🛡️ Android students must use the official <strong>SmartAttend Android App (.apk)</strong> to enforce OS-level Lock Task Kiosk Mode and prevent attendance proxying.
                        </div>
                        <a
                            href={getApkDownloadUrl()}
                            download="SmartAttend-release.apk"
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '10px',
                                width: '100%',
                                padding: '14px 20px',
                                borderRadius: '14px',
                                background: 'linear-gradient(135deg, #16a34a, #15803d)',
                                color: '#ffffff',
                                textDecoration: 'none',
                                fontWeight: 800,
                                fontSize: '1rem',
                                boxShadow: '0 4px 14px rgba(22, 163, 74, 0.35)'
                            }}
                        >
                            <FaDownload /> Download SmartAttend Android App (.apk)
                        </a>
                    </div>
                ) : null}
            </div>

            {/* Loading or Error States */}
            {scanState === 'AUTHORIZING_QR1' && (
                <div style={{
                    marginTop: '16px',
                    padding: '14px',
                    borderRadius: '14px',
                    background: 'rgba(99, 102, 241, 0.1)',
                    border: '1.5px solid rgba(99, 102, 241, 0.25)',
                    color: '#4338ca',
                    fontWeight: 800,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '10px'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <FaSpinner className="fa-spin" style={{ fontSize: '1.2rem' }} />
                        <span>Verifying Phase 1 Check-In &amp; Starting Kiosk Mode...</span>
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            setScanState('IDLE');
                            setErrorMessage('');
                            scanProcessingRef.current = false;
                        }}
                        style={{
                            padding: '6px 14px',
                            borderRadius: '8px',
                            background: '#fee2e2',
                            color: '#b91c1c',
                            border: '1px solid #fca5a5',
                            fontWeight: 700,
                            fontSize: '0.82rem',
                            cursor: 'pointer'
                        }}
                    >
                        ✕ Cancel &amp; Scan Again
                    </button>
                </div>
            )}

            {errorMessage && (
                <div style={{
                    marginTop: '14px',
                    padding: '12px 14px',
                    borderRadius: '12px',
                    background: '#fee2e2',
                    border: '1px solid #fca5a5',
                    color: '#b91c1c',
                    fontSize: '0.86rem',
                    fontWeight: 700,
                    textAlign: 'left',
                    boxShadow: '0 4px 12px rgba(239, 68, 68, 0.15)'
                }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                        <div>{errorMessage}</div>
                        <button
                            type="button"
                            onClick={() => setErrorMessage('')}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: '#b91c1c',
                                cursor: 'pointer',
                                fontSize: '1rem',
                                padding: '0 4px',
                                flexShrink: 0
                            }}
                            title="Dismiss"
                        >
                            ✕
                        </button>
                    </div>
                    {(errorMessage.includes('Geofence') || errorMessage.includes('GPS') || errorMessage.includes('outside')) && (
                        <div style={{ marginTop: '10px', display: 'flex', gap: '8px' }}>
                            <button
                                type="button"
                                onClick={async () => {
                                    setErrorMessage('📍 Recalibrating high-precision GPS lock...');
                                    if (typeof navigator !== "undefined" && navigator.geolocation) {
                                        try {
                                            const loc = await acquireAccurateLocation(navigator.geolocation, {
                                                timeoutMs: 6500,
                                                maxAccuracy: MAX_CLASSROOM_LOCATION_ACCURACY_METERS
                                            });
                                            if (loc && isFreshLocation(loc)) {
                                                prewarmedLocationRef.current = loc;
                                                setCurrentStudentLocation(loc);
                                                try { localStorage.setItem('smartattend_student_location', JSON.stringify(loc)); } catch (_) {}
                                                setErrorMessage('');
                                            } else {
                                                setErrorMessage('⚠️ GPS lock acquired but precision is low. Please move near a window or outdoors and retry.');
                                            }
                                        } catch (err) {
                                            setErrorMessage(`⚠️ GPS refresh failed: ${err?.message || 'Unable to acquire satellite fix'}`);
                                        }
                                    }
                                }}
                                style={{
                                    padding: '6px 14px',
                                    borderRadius: '8px',
                                    background: '#b91c1c',
                                    color: '#ffffff',
                                    border: 'none',
                                    fontSize: '0.8rem',
                                    fontWeight: 800,
                                    cursor: 'pointer'
                                }}
                            >
                                🔄 Recalibrate &amp; Refresh GPS
                            </button>
                        </div>
                    )}
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

            {renderBiometricsRequiredModal()}
            {renderVpnModal()}
        </div>
    );
}

export default QrScannerApp;
