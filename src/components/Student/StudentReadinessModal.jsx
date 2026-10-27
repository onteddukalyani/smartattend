import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    FaMapMarkerAlt,
    FaBell,
    FaFingerprint,
    FaCheckCircle,
    FaExclamationTriangle,
    FaTimes,
    FaShieldAlt,
    FaArrowRight,
    FaSpinner,
    FaBolt,
    FaMobileAlt,
    FaInfoCircle
} from 'react-icons/fa';
import { requestAppNotificationPermissions } from '../../services/nativeNotificationService';
import { locationFromPosition, isAccurateLocation } from '../../utils/location';
import './StudentReadinessModal.css';

/**
 * StudentReadinessModal
 * Prompts student for:
 * 1. Location Access (required for classroom geofence attendance verification)
 * 2. Notification Access (required for session start alerts and confirmations)
 * 3. Biometric Registration (prompts them to register 3D Face & Fingerprint if not enrolled)
 * 4. Device Model Setup (prompts them to select Android vs iPhone and view setup instructions)
 */
export function StudentReadinessModal({
    isOpen,
    onClose,
    hasFaceRegistered = false,
    hasHwRegistered = false,
    hasDeviceRegistered = false,
    onOpenDeviceModal = null,
    studentName = 'Student',
    activeRollNo = ''
}) {
    const navigate = useNavigate();

    // Location Permission State: 'checking' | 'granted' | 'prompt' | 'denied'
    const [locationStatus, setLocationStatus] = useState('checking');
    const [requestingLocation, setRequestingLocation] = useState(false);

    // Notification Permission State: 'checking' | 'granted' | 'default' | 'denied'
    const [notifStatus, setNotifStatus] = useState('checking');
    const [requestingNotif, setRequestingNotif] = useState(false);

    // Inspect current permission states
    const checkPermissions = useCallback(async () => {
        // 1. Check Geolocation Permission
        if (typeof navigator !== 'undefined' && navigator.permissions && navigator.permissions.query) {
            try {
                const geoPermission = await navigator.permissions.query({ name: 'geolocation' });
                setLocationStatus(geoPermission.state);
                geoPermission.onchange = () => {
                    setLocationStatus(geoPermission.state);
                };
            } catch (_) {
                setLocationStatus('prompt');
            }
        } else if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
            setLocationStatus('prompt');
        } else {
            setLocationStatus('denied');
        }

        // 2. Check Notification Permission
        if (typeof window !== 'undefined' && 'Notification' in window) {
            setNotifStatus(Notification.permission);
        } else {
            setNotifStatus('granted'); // Fallback if unsupported platform
        }
    }, []);

    useEffect(() => {
        if (isOpen) {
            checkPermissions();
        }
    }, [isOpen, checkPermissions]);

    // Request Location Access Handler
    const handleRequestLocation = async () => {
        if (typeof navigator === 'undefined' || !navigator.geolocation) {
            alert('Geolocation is not supported on this device/browser.');
            return;
        }

        setRequestingLocation(true);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setRequestingLocation(false);
                setLocationStatus('granted');
                const loc = locationFromPosition(pos);
                if (loc && isAccurateLocation(loc)) {
                    try {
                        localStorage.setItem('smartattend_student_location', JSON.stringify(loc));
                    } catch (_) { }
                }
            },
            (err) => {
                if (err.code === 1) { // PERMISSION_DENIED
                    setRequestingLocation(false);
                    setLocationStatus('denied');
                } else {
                    // Position timeout or unavailable GNSS: attempt fast network/Wi-Fi positioning fallback
                    navigator.geolocation.getCurrentPosition(
                        (fallbackPos) => {
                            setRequestingLocation(false);
                            setLocationStatus('granted');
                            const loc = locationFromPosition(fallbackPos);
                            if (loc) {
                                try {
                                    localStorage.setItem('smartattend_student_location', JSON.stringify(loc));
                                } catch (_) { }
                            }
                        },
                        () => {
                            setRequestingLocation(false);
                            setLocationStatus('granted'); // System permission was granted, satellite signal just settling
                        },
                        { enableHighAccuracy: false, timeout: 6000, maximumAge: 30000 }
                    );
                }
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 }
        );
    };

    // Request Notification Permission Handler
    const handleRequestNotification = async () => {
        setRequestingNotif(true);
        try {
            await requestAppNotificationPermissions();
            if (typeof window !== 'undefined' && 'Notification' in window) {
                setNotifStatus(Notification.permission);
            } else {
                setNotifStatus('granted');
            }
        } catch (err) {
            console.warn('[ReadinessModal] Notification request error:', err);
        } finally {
            setRequestingNotif(false);
        }
    };

    // One-click Grant All Permissions
    const [grantingAll, setGrantingAll] = useState(false);
    const handleGrantAll = async () => {
        setGrantingAll(true);
        if (notifStatus !== 'granted') {
            await handleRequestNotification();
        }
        if (locationStatus !== 'granted') {
            await handleRequestLocation();
        }
        setGrantingAll(false);
    };

    const isBiometricEnrolled = Boolean(hasFaceRegistered);
    const isLocationGranted = locationStatus === 'granted';
    const isNotifGranted = notifStatus === 'granted';
    const isDeviceConfigured = Boolean(
        hasDeviceRegistered ||
        (typeof window !== 'undefined' && (
            window.Capacitor?.isNativePlatform?.() ||
            localStorage.getItem('smartattend_student_device_type') ||
            localStorage.getItem('smartattend_device_type')
        ))
    );
    const allCompleted = isLocationGranted && isNotifGranted && isBiometricEnrolled && isDeviceConfigured;

    if (!isOpen) return null;

    return (
        <div className="readiness-modal-overlay" role="dialog" aria-modal="true">
            <div className="readiness-modal-card">
                {/* Close Button */}
                <button
                    type="button"
                    className="readiness-close-btn"
                    onClick={onClose}
                    title="Dismiss setup"
                    aria-label="Close"
                >
                    <FaTimes />
                </button>

                {/* Header */}
                <div className="readiness-header">
                    <div className="readiness-badge-pill">
                        <FaShieldAlt /> Classroom Readiness Setup
                    </div>
                    <h2 className="readiness-title">
                        {allCompleted ? "You're All Set!" : `Welcome, ${studentName}!`}
                    </h2>
                    <p className="readiness-subtitle">
                        {allCompleted
                            ? "All required classroom permissions, device configuration, and biometric credentials are fully configured."
                            : "Please enable location & notification access, select your phone model, and ensure your biometrics are enrolled before attending class."}
                    </p>
                </div>

                {/* Requirements Checklist */}
                <div className="readiness-items-list">
                    {/* Item 1: Location Access */}
                    <div className={`readiness-item-card ${isLocationGranted ? 'granted' : locationStatus === 'denied' ? 'denied' : 'action-needed'}`}>
                        <div className={`readiness-item-icon ${isLocationGranted ? 'success' : 'location'}`}>
                            {isLocationGranted ? <FaCheckCircle /> : <FaMapMarkerAlt />}
                        </div>
                        <div className="readiness-item-info">
                            <div className="readiness-item-top">
                                <h3 className="readiness-item-title">Classroom Location Access</h3>
                                <span className={`readiness-status-badge ${isLocationGranted ? 'badge-success' : locationStatus === 'denied' ? 'badge-denied' : 'badge-pending'}`}>
                                    {isLocationGranted ? 'Granted ✓' : locationStatus === 'denied' ? 'Blocked ✕' : 'Required'}
                                </span>
                            </div>
                            <p className="readiness-item-desc">
                                Required by lecturers to verify your physical presence inside the classroom geofence.
                            </p>
                            {!isLocationGranted && (
                                <button
                                    type="button"
                                    onClick={handleRequestLocation}
                                    disabled={requestingLocation}
                                    className="readiness-action-btn btn-location"
                                >
                                    {requestingLocation ? <FaSpinner className="fa-spin" /> : <FaMapMarkerAlt />}
                                    <span>{requestingLocation ? 'Requesting...' : 'Allow Location Access'}</span>
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Item 2: Notifications */}
                    <div className={`readiness-item-card ${isNotifGranted ? 'granted' : notifStatus === 'denied' ? 'denied' : 'action-needed'}`}>
                        <div className={`readiness-item-icon ${isNotifGranted ? 'success' : 'notification'}`}>
                            {isNotifGranted ? <FaCheckCircle /> : <FaBell />}
                        </div>
                        <div className="readiness-item-info">
                            <div className="readiness-item-top">
                                <h3 className="readiness-item-title">Real-Time Notifications</h3>
                                <span className={`readiness-status-badge ${isNotifGranted ? 'badge-success' : notifStatus === 'denied' ? 'badge-denied' : 'badge-pending'}`}>
                                    {isNotifGranted ? 'Allowed ✓' : notifStatus === 'denied' ? 'Blocked ✕' : 'Required'}
                                </span>
                            </div>
                            <p className="readiness-item-desc">
                                Receive instant alerts when live attendance sessions open, plus audit confirmations.
                            </p>
                            {!isNotifGranted && (
                                <button
                                    type="button"
                                    onClick={handleRequestNotification}
                                    disabled={requestingNotif}
                                    className="readiness-action-btn btn-notif"
                                >
                                    {requestingNotif ? <FaSpinner className="fa-spin" /> : <FaBell />}
                                    <span>{requestingNotif ? 'Requesting...' : 'Enable Notifications'}</span>
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Item 3: Phone Model Setup (Android / iPhone) */}
                    <div className={`readiness-item-card ${isDeviceConfigured ? 'granted' : 'action-needed'}`}>
                        <div className={`readiness-item-icon ${isDeviceConfigured ? 'success' : 'device'}`}>
                            {isDeviceConfigured ? <FaCheckCircle /> : <FaMobileAlt />}
                        </div>
                        <div className="readiness-item-info">
                            <div className="readiness-item-top">
                                <h3 className="readiness-item-title">Phone Model Setup (Android / iPhone)</h3>
                                <span className={`readiness-status-badge ${isDeviceConfigured ? 'badge-success' : 'badge-pending'}`}>
                                    {isDeviceConfigured ? 'Configured & Locked ✓' : 'Action Required'}
                                </span>
                            </div>
                            <p className="readiness-item-desc">
                                {isDeviceConfigured
                                    ? "Your phone model is verified for attendance anti-proxy protection."
                                    : "Choose whether you use an Android or iPhone to receive customized APK or Guided Access instructions."}
                            </p>
                            {!isDeviceConfigured && (
                                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '6px' }}>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            onClose();
                                            if (onOpenDeviceModal) {
                                                onOpenDeviceModal();
                                            } else {
                                                navigate('/student/device-setup');
                                            }
                                        }}
                                        className="readiness-action-btn btn-primary"
                                    >
                                        <FaMobileAlt />
                                        <span>Select Android / iPhone</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            onClose();
                                            navigate('/student/device-setup');
                                        }}
                                        className="readiness-action-btn btn-location"
                                        style={{ background: 'rgba(99, 102, 241, 0.08)', color: '#4f46e5', border: '1px solid rgba(99, 102, 241, 0.3)' }}
                                    >
                                        <FaInfoCircle />
                                        <span>View Instructions</span>
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Item 4: Biometrics Registration */}
                    <div className={`readiness-item-card ${isBiometricEnrolled ? 'granted' : 'action-needed'}`}>
                        <div className={`readiness-item-icon ${isBiometricEnrolled ? 'success' : 'biometric'}`}>
                            {isBiometricEnrolled ? <FaCheckCircle /> : <FaFingerprint />}
                        </div>
                        <div className="readiness-item-info">
                            <div className="readiness-item-top">
                                <h3 className="readiness-item-title">Biometric Enrollment</h3>
                                <span className={`readiness-status-badge ${isBiometricEnrolled ? 'badge-success' : 'badge-pending'}`}>
                                    {isBiometricEnrolled ? 'Registered & Locked ✓' : 'Action Required'}
                                </span>
                            </div>
                            <p className="readiness-item-desc">
                                {isBiometricEnrolled
                                    ? "Your facial biometrics are officially registered and locked. Attendance verification is ready."
                                    : "Live 3D Face enrollment is required to verify identity during attendance scanning."}
                            </p>
                            {!isBiometricEnrolled && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        onClose();
                                        navigate('/student/face-enroll');
                                    }}
                                    className="readiness-action-btn btn-primary"
                                >
                                    <FaFingerprint />
                                    <span>Register Biometrics Now</span>
                                    <FaArrowRight style={{ fontSize: '0.72rem' }} />
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Footer CTAs */}
                <div className="readiness-footer">
                    {!isLocationGranted || !isNotifGranted ? (
                        <button
                            type="button"
                            onClick={handleGrantAll}
                            disabled={grantingAll}
                            className="readiness-main-btn"
                        >
                            {grantingAll ? <FaSpinner className="fa-spin" /> : <FaBolt />}
                            <span>{grantingAll ? 'Enabling Permissions...' : 'Grant All Required Permissions'}</span>
                        </button>
                    ) : !isDeviceConfigured ? (
                        <button
                            type="button"
                            onClick={() => {
                                onClose();
                                if (onOpenDeviceModal) {
                                    onOpenDeviceModal();
                                } else {
                                    navigate('/student/device-setup');
                                }
                            }}
                            className="readiness-main-btn"
                        >
                            <FaMobileAlt />
                            <span>Select Phone Model (Android / iPhone)</span>
                            <FaArrowRight />
                        </button>
                    ) : !isBiometricEnrolled ? (
                        <button
                            type="button"
                            onClick={() => {
                                onClose();
                                navigate('/student/face-enroll');
                            }}
                            className="readiness-main-btn"
                        >
                            <FaFingerprint />
                            <span>Continue to Biometric Registration</span>
                            <FaArrowRight />
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={onClose}
                            className="readiness-main-btn success-btn"
                        >
                            <FaCheckCircle />
                            <span>Continue to Student Dashboard</span>
                        </button>
                    )}

                    <button
                        type="button"
                        onClick={onClose}
                        className="readiness-skip-btn"
                    >
                        I'll finish this before class
                    </button>
                </div>
            </div>
        </div>
    );
}

export default StudentReadinessModal;
