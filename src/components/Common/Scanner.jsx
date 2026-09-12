import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
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
    FaExternalLinkAlt
} from 'react-icons/fa';
import { MdQrCodeScanner } from 'react-icons/md';
import { useAuth } from '../authcontext';
import { Kiosk } from '../../plugins/kiosk';
import {
    authorizeStudentQR1,
    validateStudentQR2,
    submitVerifiedAttendance,
    subscribeToSession
} from '../../services/sessionAuthService';
import { db } from '../../firebase';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { isGenericName } from '../../utils/studentDataHelper';
import FaceScanner from '../Lecturer/pages/FaceScanner';

/**
 * Stage 4: Student Two-Phase Attendance Scanner & Supervised Kiosk Controller
 * 
 * Timeline:
 * T = 0s to 60s (0:00 - 1:00) : QR 1 Phase 1 Check-In -> Authorizes Student -> Starts Kiosk Mode
 * T = 60s to 180s (1:00 - 3:00): QR 2 Phase 2 Biometric -> Gated by Phase 1 -> Submits Attendance
 * T = 180s (3:00)             : Session Ends -> Stops Kiosk Mode -> Returns to Dashboard
 */
function QrScannerApp() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const { user, profile, loading } = useAuth();
    const fileInputRef = useRef(null);
    const sessionTimerRef = useRef(null);

    // Platform & App Detection
    const isNativeApp = Capacitor.isNativePlatform();
    const [showAppBanner, setShowAppBanner] = useState(false);
    const [dismissedAppBanner, setDismissedAppBanner] = useState(false);

    // Current State: 'IDLE' | 'AUTHORIZING_QR1' | 'KIOSK_WAITING_QR2' | 'VALIDATING_QR2' | 'BIOMETRIC_SCAN' | 'ATTENDANCE_SUCCESS'
    const [scanState, setScanState] = useState('IDLE');

    // Web Guardian Supervision State
    const [supervisionViolation, setSupervisionViolation] = useState(false);
    const [violationCount, setViolationCount] = useState(0);

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

    // Biometric Verification Data
    const [verifiedStudent, setVerifiedStudent] = useState(null);
    const [lookingUpStudent, setLookingUpStudent] = useState(false);
    const [submittingAttendance, setSubmittingAttendance] = useState(false);
    const [submissionDetails, setSubmissionDetails] = useState(null);

    // Resolve Student Identity
    const loggedInRollNo = (profile?.rollNo || (user?.email || '').split('@')[0] || '').trim().toUpperCase();
    const rawProfileName = profile?.name || profile?.fullName || '';
    const loggedInName = (!isGenericName(rawProfileName, loggedInRollNo, user?.email)) ? rawProfileName.trim() : loggedInRollNo;

    // Camera default preference (desktop vs mobile)
    useEffect(() => {
        if (typeof window !== 'undefined') {
            const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
            if (!isMobile) {
                setFacingMode('user');
            }
        }
    }, []);

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
                sEmailDoc
            ] = await Promise.all([
                getDoc(doc(db, 'students', targetRoll)).catch(() => ({ exists: () => false })),
                getDoc(doc(db, 'users', targetRoll)).catch(() => ({ exists: () => false })),
                getDoc(doc(db, 'authorizedUsers', targetRoll)).catch(() => ({ exists: () => false })),
                getDocs(query(collection(db, 'students'), where('rollNo', '==', targetRoll))).catch(() => ({ docs: [] })),
                getDocs(query(collection(db, 'users'), where('rollNo', '==', targetRoll))).catch(() => ({ docs: [] })),
                prefix !== targetRoll ? getDoc(doc(db, 'students', prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
                getDoc(doc(db, 'students', possibleEmail)).catch(() => ({ exists: () => false }))
            ]);

            const candidateDocs = [];
            if (sDoc.exists()) candidateDocs.push(sDoc.data());
            if (uDoc.exists()) candidateDocs.push(uDoc.data());
            if (aDoc.exists()) candidateDocs.push(aDoc.data());
            sRollSnap.docs?.forEach((d) => candidateDocs.push(d.data()));
            uRollSnap.docs?.forEach((d) => candidateDocs.push(d.data()));
            if (sPrefixDoc.exists()) candidateDocs.push(sPrefixDoc.data());
            if (sEmailDoc.exists()) candidateDocs.push(sEmailDoc.data());

            let merged = { rollNo: targetRoll, name: loggedInName };
            for (const docData of candidateDocs) {
                if (docData.name && !isGenericName(docData.name, targetRoll)) merged.name = docData.name;
                if (docData.fullName && !isGenericName(docData.fullName, targetRoll)) merged.fullName = docData.fullName;
                if (Array.isArray(docData.faceDescriptor) && docData.faceDescriptor.length === 128) {
                    merged.faceDescriptor = docData.faceDescriptor;
                    merged.faceRegistered = true;
                }
                if (docData.photoURL) merged.photoURL = docData.photoURL;
            }

            setVerifiedStudent(merged);
        } catch (err) {
            console.warn('Student biometrics lookup notice:', err);
        } finally {
            setLookingUpStudent(false);
        }
    }, [loggedInRollNo, loggedInName, user]);

    // Authoritative 3-Minute Session Countdown Timer
    useEffect(() => {
        if (!sessionStartAt || !kioskEndsAt) return;

        const updateClock = () => {
            const now = Date.now();
            const elapsed = Math.floor((now - sessionStartAt) / 1000);
            const remaining = Math.max(0, Math.floor((kioskEndsAt - now) / 1000));
            setElapsedSeconds(elapsed);
            setSessionRemaining(remaining);

            // When fixed 3-minute deadline ends (T = 180s)
            if (remaining <= 0) {
                if (sessionTimerRef.current) clearInterval(sessionTimerRef.current);
                console.log('[Kiosk] 3-minute session completed. Automatically unlocking Kiosk mode...');
                Kiosk.stopKiosk().catch(() => {});
                navigate('/student', { replace: true });
            }
        };

        updateClock();
        sessionTimerRef.current = setInterval(updateClock, 1000);

        return () => {
            if (sessionTimerRef.current) clearInterval(sessionTimerRef.current);
        };
    }, [sessionStartAt, kioskEndsAt, scanState, navigate]);

    // Cleanup Kiosk lock when component unmounts
    useEffect(() => {
        return () => {
            // Only unlock if session is not actively waiting or finished
            Kiosk.stopKiosk().catch(() => {});
        };
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

    // Web Guardian Supervision: Monitor tab switches or leaving app during active session
    useEffect(() => {
        const isSessionActive = scanState === 'KIOSK_WAITING_QR2' || scanState === 'BIOMETRIC_SCAN' || scanState === 'ATTENDANCE_SUCCESS';
        if (!isSessionActive) {
            setSupervisionViolation(false);
            return;
        }

        const handleVisibilityChange = () => {
            if (document.hidden || document.visibilityState === 'hidden') {
                console.warn('[Kiosk Guardian] Tab switch or App minimize detected!');
                setSupervisionViolation(true);
                setViolationCount((c) => c + 1);
            }
        };

        const handleBlur = () => {
            if (!isNativeApp) {
                console.warn('[Kiosk Guardian] Window blur detected!');
                setSupervisionViolation(true);
                setViolationCount((c) => c + 1);
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('blur', handleBlur);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('blur', handleBlur);
        };
    }, [scanState, isNativeApp]);

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
            if (data.kioskEndsAt && !kioskEndsAt) {
                const endMs = typeof data.kioskEndsAt.toMillis === 'function' ? data.kioskEndsAt.toMillis() : data.kioskEndsAt;
                setKioskEndsAt(endMs);
            }
            // If lecturer ends the session in real-time
            if (data.status === 'CLOSED' || data.phase === 'CLOSED' || data.isClosed === true) {
                console.log('[Kiosk] Session marked as CLOSED by Lecturer. Automatically unlocking Kiosk mode...');
                Kiosk.stopKiosk().catch(() => {});
                navigate('/student', { replace: true });
            }
        });
        return () => unsub();
    }, [activeSessionId, sessionStartAt, kioskEndsAt, navigate]);

    // Parse Scanned String / URL
    const parseScannedPayload = (raw) => {
        if (!raw) return null;
        let sessionId = null;
        let qr1Token = null;
        let qr2Token = null;
        let phase = null;

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

        return { sessionId, qr1Token, qr2Token, phase };
    };

    // 1. Process Phase 1 QR 1: Check-in & Start Lock Task Kiosk
    const handleProcessQR1 = async (sessionId, qr1Token) => {
        if (!user) {
            setErrorMessage('Please log in with your student account to authorize attendance.');
            return;
        }

        setScanState('AUTHORIZING_QR1');
        setErrorMessage('');

        try {
            const studentProfileOverride = {
                rollNo: loggedInRollNo,
                name: loggedInName,
                email: user.email || ''
            };

            const result = await authorizeStudentQR1(sessionId, qr1Token, studentProfileOverride);

            setActiveSessionId(sessionId);
            setSessionStartAt(result.sessionStartAt || Date.now());
            setKioskEndsAt(result.kioskEndsAt || (Date.now() + 180000));

            // Start Android Lock Task Mode & Web Supervision
            try {
                console.log('[Kiosk] Activating Native Android Lock Task / Supervised Kiosk mode for Student...');
                await Kiosk.startKiosk();
            } catch (kioskErr) {
                console.warn('[Kiosk] Notice starting kiosk mode:', kioskErr);
            }

            // Pre-fetch student biometric template
            try {
                await lookupStudentBiometrics(result.rollNo || loggedInRollNo);
            } catch (bioErr) {
                console.warn('Biometrics lookup notice:', bioErr);
            }

            // Move to Kiosk Supervised Waiting state
            setScanState('KIOSK_WAITING_QR2');
        } catch (err) {
            console.error('Error authorizing QR 1:', err);
            setErrorMessage(err.message || 'Could not authorize Phase 1 check-in. Please verify session is active.');
            setScanState('IDLE');
        }
    };

    // 2. Process Phase 2 QR 2: Gate verification & open Face Biometric Scanner
    const handleProcessQR2 = async (sessionId, qr2Token) => {
        if (!user) {
            setErrorMessage('Please log in to submit attendance.');
            return;
        }

        setScanState('VALIDATING_QR2');
        setErrorMessage('');

        try {
            const targetSession = sessionId || activeSessionId;
            const result = await validateStudentQR2(targetSession, qr2Token);

            setActiveSessionId(targetSession);
            setActiveQr2Token(qr2Token);
            if (result.kioskEndsAt) setKioskEndsAt(result.kioskEndsAt);

            // Ensure biometrics are loaded
            await lookupStudentBiometrics(result.rollNo || loggedInRollNo);

            // Move to Live Biometric Face Verification
            setScanState('BIOMETRIC_SCAN');
        } catch (err) {
            console.error('Error validating QR 2:', err);
            const msg = err.message || '';
            if (msg.includes('QR 1') || msg.includes('Access denied') || msg.includes('permission-denied')) {
                setErrorMessage('⛔ Access Denied: You did not scan QR 1 during Phase 1 (0:00 - 1:00). You cannot attend this session.');
            } else {
                setErrorMessage(msg || 'Invalid Phase 2 QR code.');
            }
            setScanState(activeSessionId ? 'KIOSK_WAITING_QR2' : 'IDLE');
        }
    };

    // Master Scan Handler
    const processSessionString = (raw) => {
        if (!raw) return;
        const payload = parseScannedPayload(raw);

        if (!payload || !payload.sessionId) {
            setErrorMessage('Invalid QR code format. Please scan a valid SmartAttend session QR code.');
            return;
        }

        // Detect QR 1 (Phase 1) vs QR 2 (Phase 2)
        if (payload.qr2Token || payload.phase === '2' || payload.phase === 'PHASE_2') {
            handleProcessQR2(payload.sessionId, payload.qr2Token);
        } else if (payload.qr1Token || payload.phase === '1' || payload.phase === 'PHASE_1') {
            handleProcessQR1(payload.sessionId, payload.qr1Token);
        } else {
            // Fallback: If in waiting state, treat as QR 2; otherwise treat as QR 1
            if (scanState === 'KIOSK_WAITING_QR2') {
                handleProcessQR2(payload.sessionId, payload.sessionId);
            } else {
                handleProcessQR1(payload.sessionId, payload.sessionId);
            }
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

    const handleCameraScan = (result) => {
        if (!result) return;
        const raw = result[0]?.rawValue || (typeof result === 'string' ? result : '');
        if (raw) {
            processSessionString(raw);
        }
    };

    const handleCameraError = (error) => {
        console.warn('Scanner Error:', error);
        const errName = error?.name || '';
        const errMsg = error?.message || String(error);

        if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError' || errMsg.toLowerCase().includes('permission')) {
            setPermissionDenied(true);
            setCameraError("Camera permission blocked on HTTP. Use 'Snap / Upload QR Photo' below for instant scan!");
        } else if (errName === 'OverconstrainedError' || errMsg.toLowerCase().includes('constraint')) {
            if (facingMode === 'environment') {
                setFacingMode('user');
                setRetryKey((k) => k + 1);
            }
        } else {
            setCameraError('WebRTC camera stream unavailable. Please use the camera snap button below.');
        }
    };

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
                try {
                    const submissionResult = await submitVerifiedAttendance(
                        activeSessionId,
                        activeQr2Token || activeSessionId,
                        {
                            confidence: res.confidence || 100,
                            distance: res.distance || 0.35,
                            liveness: res.liveness === true,
                            blinkCount: res.blinkCount || 1
                        }
                    );

                    setSubmissionDetails({
                        rollNo: submissionResult.rollNo || loggedInRollNo,
                        studentName: submissionResult.studentName || loggedInName,
                        courseCode: sessionData?.courseCode || 'CLASS',
                        classCode: sessionData?.classCode || '',
                        roomNo: sessionData?.roomNo || 'C002',
                        submittedAt: Date.now()
                    });

                    setScanState('ATTENDANCE_SUCCESS');
                } catch (subErr) {
                    console.error('Attendance submission error:', subErr);
                    alert('❌ Attendance submission notice: ' + (subErr.message || 'Error recording attendance'));
                } finally {
                    setSubmittingAttendance(false);
                }
            }
        }
    }, [activeSessionId, activeQr2Token, submittingAttendance, loggedInRollNo, loggedInName, sessionData]);

    const formatMmSs = (sec) => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    };

    // =========================================================================
    // UI VIEW 1: ATTENDANCE SUBMITTED (Holds Kiosk Mode until T = 180s)
    // =========================================================================
    if (scanState === 'ATTENDANCE_SUCCESS') {
        return (
            <div style={{
                maxWidth: '540px',
                margin: '30px auto',
                padding: '30px 22px',
                background: 'var(--surface, #ffffff)',
                borderRadius: '24px',
                border: '1.5px solid var(--border, #e2e8f0)',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.15)',
                color: 'var(--text-main, #0f172a)',
                textAlign: 'center'
            }}>
                <div style={{
                    width: '72px',
                    height: '72px',
                    borderRadius: '50%',
                    background: '#dcfce7',
                    color: '#15803d',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 16px',
                    fontSize: '38px',
                    boxShadow: '0 8px 20px rgba(22, 163, 74, 0.2)'
                }}>
                    <FaCheckCircle />
                </div>

                <h2 style={{ fontSize: '1.55rem', fontWeight: 800, margin: '0 0 6px 0', color: '#15803d' }}>
                    Attendance Marked Successfully!
                </h2>
                <p style={{ color: 'var(--text-muted, #64748b)', fontSize: '0.9rem', margin: '0 0 20px 0' }}>
                    Your biometric attendance is verified and securely registered.
                </p>

                {/* Details Box */}
                <div style={{
                    background: 'var(--surface-soft, #f8fafc)',
                    border: '1.5px solid var(--border, #e2e8f0)',
                    borderRadius: '16px',
                    padding: '16px 18px',
                    textAlign: 'left',
                    marginBottom: '20px'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #e2e8f0' }}>
                        <span style={{ color: '#64748b', fontSize: '0.85rem' }}>Roll Number:</span>
                        <strong style={{ fontWeight: 800 }}>{submissionDetails?.rollNo || loggedInRollNo}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #e2e8f0' }}>
                        <span style={{ color: '#64748b', fontSize: '0.85rem' }}>Student Name:</span>
                        <strong style={{ fontWeight: 800 }}>{submissionDetails?.studentName || loggedInName}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #e2e8f0' }}>
                        <span style={{ color: '#64748b', fontSize: '0.85rem' }}>Class / Room:</span>
                        <strong style={{ fontWeight: 800 }}>{submissionDetails?.courseCode} · Room {submissionDetails?.roomNo}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                        <span style={{ color: '#64748b', fontSize: '0.85rem' }}>Biometric Verification:</span>
                        <strong style={{ color: '#15803d', fontWeight: 800 }}>✅ PASSED (100% Match)</strong>
                    </div>
                </div>

                {/* Supervised Lock Task Countdown (Fixed T = 180s deadline) */}
                <div style={{
                    background: 'rgba(99, 102, 241, 0.08)',
                    border: '1.5px solid rgba(99, 102, 241, 0.3)',
                    borderRadius: '16px',
                    padding: '16px',
                    marginBottom: '10px'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: '#6366f1', fontWeight: 800, fontSize: '0.92rem', marginBottom: '6px' }}>
                        <FaShieldAlt /> Supervised Kiosk Mode Active
                    </div>
                    <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#4338ca', marginBottom: '4px' }}>
                        {formatMmSs(sessionRemaining)}
                    </div>
                    <p style={{ margin: 0, fontSize: '0.84rem', color: '#64748b' }}>
                        Device is locked in Supervised Kiosk Mode. It will automatically unlock and return to your dashboard when the session reaches 0:00.
                    </p>
                </div>
            </div>
        );
    }

    // =========================================================================
    // UI VIEW 2: LIVE BIOMETRIC FACE SCANNER (Triggered by Phase 2 QR 2)
    // =========================================================================
    if (scanState === 'BIOMETRIC_SCAN') {
        return (
            <div style={{
                maxWidth: '560px',
                margin: '20px auto',
                padding: '24px 20px',
                background: 'var(--surface, #ffffff)',
                borderRadius: '24px',
                border: '1.5px solid var(--border, #e2e8f0)',
                boxShadow: '0 20px 45px -20px rgba(0, 0, 0, 0.15)',
                color: 'var(--text-main, #0f172a)',
                textAlign: 'center'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                    <div style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 12px',
                        borderRadius: '999px',
                        background: 'rgba(16, 185, 129, 0.12)',
                        color: '#059669',
                        fontSize: '0.8rem',
                        fontWeight: 800
                    }}>
                        <FaCheckCircle /> Phase 2: Biometric Verification
                    </div>

                    <div style={{ fontSize: '0.85rem', fontWeight: 800, color: '#6366f1' }}>
                        ⏱️ {formatMmSs(sessionRemaining)} / 3:00
                    </div>
                </div>

                <h2 style={{ margin: '0 0 6px 0', fontSize: '1.4rem', fontWeight: 800 }}>
                    Face Biometric Verification
                </h2>
                <p style={{ margin: '0 0 16px 0', color: 'var(--text-muted, #64748b)', fontSize: '0.86rem' }}>
                    Position your face within the frame. Blink naturally to confirm liveness.
                </p>

                {/* Face Scanner Component */}
                <FaceScanner
                    verifiedStudent={verifiedStudent}
                    lookingUp={lookingUpStudent}
                    rollNo={loggedInRollNo}
                    onVerificationChange={handleFaceVerificationChange}
                />

                {submittingAttendance && (
                    <div style={{
                        marginTop: '16px',
                        padding: '12px',
                        borderRadius: '12px',
                        background: '#dcfce7',
                        color: '#15803d',
                        fontWeight: 800,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px'
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
            <div style={{
                maxWidth: '540px',
                margin: '24px auto',
                padding: '26px 20px',
                background: 'var(--surface, #ffffff)',
                borderRadius: '24px',
                border: '1.5px solid var(--border, #e2e8f0)',
                boxShadow: '0 20px 45px -20px rgba(0, 0, 0, 0.15)',
                color: 'var(--text-main, #0f172a)',
                textAlign: 'center',
                position: 'relative'
            }}>
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
                        padding: '24px',
                        color: '#ffffff',
                        textAlign: 'center'
                    }}>
                        <div style={{
                            width: '80px',
                            height: '80px',
                            borderRadius: '50%',
                            background: '#fee2e2',
                            color: '#b91c1c',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '40px',
                            marginBottom: '16px'
                        }}>
                            <FaExclamationTriangle />
                        </div>
                        <h2 style={{ fontSize: '1.6rem', fontWeight: 800, margin: '0 0 10px 0', color: '#f87171' }}>
                            Supervision Alert!
                        </h2>
                        <p style={{ maxWidth: '420px', fontSize: '0.95rem', color: '#cbd5e1', lineHeight: 1.5, marginBottom: '20px' }}>
                            You switched tabs or left SmartAttend during an active attendance session ({loggedInRollNo}).
                            App switching is strictly prohibited to prevent proxy attendance.
                        </p>
                        <div style={{
                            padding: '10px 18px',
                            borderRadius: '12px',
                            background: 'rgba(239, 68, 68, 0.2)',
                            border: '1px solid rgba(239, 68, 68, 0.4)',
                            color: '#fca5a5',
                            fontSize: '0.85rem',
                            fontWeight: 700,
                            marginBottom: '24px'
                        }}>
                            Violations Logged: {violationCount} · Time Remaining: {formatMmSs(sessionRemaining)}
                        </div>
                        <button
                            type="button"
                            onClick={() => setSupervisionViolation(false)}
                            style={{
                                padding: '14px 28px',
                                borderRadius: '14px',
                                background: '#6366f1',
                                color: '#ffffff',
                                border: 'none',
                                fontWeight: 800,
                                fontSize: '1rem',
                                cursor: 'pointer',
                                boxShadow: '0 4px 16px rgba(99, 102, 241, 0.4)'
                            }}
                        >
                            Return to Attendance Session
                        </button>
                    </div>
                )}

                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    style={{ display: 'none' }}
                    onChange={handleFileScan}
                />

                {/* Supervised Banner */}
                <div style={{
                    padding: '10px 14px',
                    borderRadius: '12px',
                    background: 'linear-gradient(135deg, #4338ca 0%, #6366f1 100%)',
                    color: '#ffffff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '16px'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800, fontSize: '0.85rem' }}>
                        <FaShieldAlt /> {isNativeApp ? 'Android Kiosk Mode Active (App Locked)' : 'Supervised Session Active'}
                    </div>
                    <div style={{ fontWeight: 800, fontSize: '0.95rem' }}>
                        ⏱️ {formatMmSs(sessionRemaining)} / 3:00
                    </div>
                </div>

                {/* Success Icon */}
                <div style={{
                    width: '60px',
                    height: '60px',
                    borderRadius: '50%',
                    background: '#dcfce7',
                    color: '#15803d',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 12px',
                    fontSize: '32px'
                }}>
                    <FaCheckCircle />
                </div>

                <h2 style={{ margin: '0 0 6px 0', fontSize: '1.35rem', fontWeight: 800 }}>
                    Phase 1 Check-In Complete!
                </h2>
                <p style={{ margin: '0 0 16px 0', color: 'var(--text-muted, #64748b)', fontSize: '0.86rem' }}>
                    You are <strong>AUTHORIZED</strong> for this session ({loggedInRollNo} · {loggedInName}).
                </p>

                {/* Instruction Callout */}
                <div style={{
                    background: 'rgba(99, 102, 241, 0.08)',
                    border: '1.5px dashed #6366f1',
                    borderRadius: '16px',
                    padding: '14px 16px',
                    marginBottom: '18px',
                    textAlign: 'left'
                }}>
                    <div style={{ fontWeight: 800, color: '#4338ca', fontSize: '0.9rem', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <FaClock /> Next: Scan QR 2 for Biometric Attendance
                    </div>
                    <p style={{ margin: 0, fontSize: '0.82rem', color: '#475569', lineHeight: 1.4 }}>
                        When your lecturer displays <strong>QR 2 (1:00 - 3:00)</strong> on the screen, point your camera below or tap "Scan QR 2 via Camera" to verify your face and mark attendance.
                    </p>
                </div>

                {/* Snap QR 2 Button */}
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={scanningFile}
                    style={{
                        width: '100%',
                        padding: '13px',
                        borderRadius: '14px',
                        background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                        color: '#ffffff',
                        border: 'none',
                        fontWeight: 800,
                        fontSize: '0.96rem',
                        cursor: 'pointer',
                        marginBottom: '16px',
                        boxShadow: '0 4px 14px rgba(16, 185, 129, 0.3)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px'
                    }}
                >
                    {scanningFile ? <><FaSpinner className="fa-spin" /> Decoding QR 2...</> : <><FaCamera /> Scan Phase 2 QR via Camera</>}
                </button>

                {/* Live Scanner Frame */}
                <div style={{
                    borderRadius: '16px',
                    overflow: 'hidden',
                    border: '2px solid rgba(99, 102, 241, 0.4)',
                    background: '#020617',
                    position: 'relative',
                    minHeight: '220px'
                }}>
                    <Scanner
                        key={`waiting-${retryKey}-${facingMode}`}
                        onScan={handleCameraScan}
                        onError={handleCameraError}
                        constraints={{ facingMode }}
                        sound={false}
                        components={{ audio: false }}
                    />
                </div>

                {errorMessage && (
                    <div style={{
                        marginTop: '12px',
                        padding: '10px 14px',
                        borderRadius: '10px',
                        background: '#fee2e2',
                        border: '1px solid #fca5a5',
                        color: '#b91c1c',
                        fontSize: '0.84rem',
                        fontWeight: 700,
                        textAlign: 'left'
                    }}>
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
        <div style={{
            maxWidth: '540px',
            margin: '30px auto',
            padding: '26px 22px',
            background: 'var(--surface, #ffffff)',
            borderRadius: '20px',
            border: '1.5px solid var(--border, #e2e8f0)',
            boxShadow: '0 20px 45px -20px rgba(0, 0, 0, 0.1)',
            color: 'var(--text-main, #0f172a)',
            textAlign: 'center'
        }}>
            {/* Smart App vs Website Banner for Mobile Web Browsers */}
            {showAppBanner && !dismissedAppBanner && (
                <div style={{
                    marginBottom: '18px',
                    padding: '12px 14px',
                    borderRadius: '14px',
                    background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)',
                    color: '#ffffff',
                    border: '1px solid #4338ca',
                    textAlign: 'left',
                    boxShadow: '0 4px 14px rgba(49, 46, 129, 0.3)'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800, fontSize: '0.88rem' }}>
                            <FaMobileAlt style={{ color: '#a5b4fc' }} /> SmartAttend App
                        </div>
                        <button
                            type="button"
                            onClick={() => setDismissedAppBanner(true)}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: '#94a3b8',
                                cursor: 'pointer',
                                fontSize: '0.8rem',
                                padding: '2px 6px'
                            }}
                        >
                            ✕
                        </button>
                    </div>
                    <p style={{ margin: '0 0 10px 0', fontSize: '0.8rem', color: '#e0e7ff', lineHeight: 1.35 }}>
                        Have the SmartAttend Android App? Open directly in app for seamless Kiosk Lock Task mode.
                    </p>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            type="button"
                            onClick={handleOpenInSmartAttendApp}
                            style={{
                                flex: 1,
                                padding: '8px 12px',
                                borderRadius: '10px',
                                background: '#6366f1',
                                color: '#ffffff',
                                border: 'none',
                                fontWeight: 800,
                                fontSize: '0.82rem',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '6px'
                            }}
                        >
                            <FaExternalLinkAlt style={{ fontSize: '0.75rem' }} /> Open in App
                        </button>
                        <button
                            type="button"
                            onClick={() => setDismissedAppBanner(true)}
                            style={{
                                padding: '8px 12px',
                                borderRadius: '10px',
                                background: 'rgba(255, 255, 255, 0.12)',
                                color: '#ffffff',
                                border: 'none',
                                fontWeight: 700,
                                fontSize: '0.82rem',
                                cursor: 'pointer'
                            }}
                        >
                            Stay on Web
                        </button>
                    </div>
                </div>
            )}

            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: 'none' }}
                onChange={handleFileScan}
            />

            {/* Header Navigation */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
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

                <button
                    type="button"
                    onClick={() => {
                        setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
                        setRetryKey((k) => k + 1);
                    }}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 12px',
                        borderRadius: '8px',
                        background: 'var(--surface-soft, #f1f5f9)',
                        border: '1px solid var(--border, #cbd5e1)',
                        color: 'var(--text-main, #334155)',
                        fontSize: '0.78rem',
                        fontWeight: 700,
                        cursor: 'pointer'
                    }}
                >
                    <FaSyncAlt /> {facingMode === 'environment' ? 'Rear Cam' : 'Front Cam'}
                </button>
            </div>

            {/* Icon & Title */}
            <div style={{
                width: '58px',
                height: '58px',
                borderRadius: '50%',
                background: 'rgba(99, 102, 241, 0.12)',
                color: '#6366f1',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 12px',
                fontSize: '30px'
            }}>
                <MdQrCodeScanner />
            </div>

            <h2 style={{ margin: '0 0 6px 0', fontSize: '1.45rem', fontWeight: 800 }}>
                Scan Class QR Code
            </h2>
            <p style={{ margin: '0 0 16px 0', color: 'var(--text-muted, #64748b)', fontSize: '0.88rem' }}>
                Point camera at the attendance QR code displayed on the lecturer screen.
            </p>

            {/* Student Info Pill */}
            {user && (
                <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 14px',
                    borderRadius: '999px',
                    background: 'var(--surface-soft, #f8fafc)',
                    border: '1px solid var(--border, #e2e8f0)',
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    color: '#334155',
                    marginBottom: '16px'
                }}>
                    <FaUserCheck style={{ color: '#6366f1' }} />
                    <span>Logged in as: <strong>{loggedInRollNo}</strong> ({loggedInName})</span>
                </div>
            )}

            {/* Snap Button */}
            <div style={{ marginBottom: '16px' }}>
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={scanningFile || scanState !== 'IDLE'}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        width: '100%',
                        padding: '13px 20px',
                        borderRadius: '14px',
                        background: 'linear-gradient(180deg, var(--accent, #6366f1), var(--accent-strong, #4338ca))',
                        color: '#ffffff',
                        border: 'none',
                        fontWeight: 800,
                        fontSize: '0.98rem',
                        cursor: 'pointer',
                        boxShadow: '0 4px 16px rgba(99, 102, 241, 0.35)'
                    }}
                >
                    {scanningFile ? (
                        <><FaSpinner className="fa-spin" /> Decoding QR Code...</>
                    ) : (
                        <><FaCamera /> Scan QR via Device Camera</>
                    )}
                </button>
            </div>

            {/* Camera Viewport */}
            <div style={{
                borderRadius: '16px',
                overflow: 'hidden',
                border: '2px dashed rgba(99, 102, 241, 0.4)',
                background: '#020617',
                position: 'relative',
                minHeight: '260px',
                boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.15)'
            }}>
                {scannerActive && (
                    <Scanner
                        key={`${retryKey}-${facingMode}`}
                        onScan={handleCameraScan}
                        onError={handleCameraError}
                        constraints={{ facingMode }}
                        sound={false}
                        components={{ audio: false }}
                    />
                )}

                {permissionDenied && (
                    <div style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'rgba(15, 23, 42, 0.95)',
                        padding: '24px 20px',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#f8fafc',
                        zIndex: 10
                    }}>
                        <FaCamera style={{ fontSize: '2.4rem', color: '#6366f1', marginBottom: '10px' }} />
                        <h4 style={{ margin: '0 0 6px', fontSize: '1rem', fontWeight: 800 }}>Tap Above to Scan</h4>
                        <p style={{ margin: '0 0 14px', fontSize: '0.82rem', color: '#94a3b8', lineHeight: 1.4, maxWidth: '300px' }}>
                            Click <strong>"Scan QR via Device Camera"</strong> above to scan instantly with your phone camera!
                        </p>
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            style={{
                                padding: '10px 20px',
                                borderRadius: '10px',
                                background: '#6366f1',
                                color: '#ffffff',
                                border: 'none',
                                fontWeight: 700,
                                fontSize: '0.88rem',
                                cursor: 'pointer'
                            }}
                        >
                            <FaCamera /> Open Camera Now
                        </button>
                    </div>
                )}
            </div>

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
        </div>
    );
}

export default QrScannerApp;
