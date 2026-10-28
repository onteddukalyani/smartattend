import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    FaMapMarkerAlt,
    FaFingerprint,
    FaCheckCircle,
    FaTimes,
    FaShieldAlt,
    FaArrowRight,
    FaSpinner,
    FaBolt
} from 'react-icons/fa';
import { locationFromPosition, isAccurateLocation } from '../../utils/location';
import './StudentReadinessModal.css';

/**
 * StudentReadinessModal
 * Prompts student for:
 * 1. Location Access (required for classroom geofence attendance verification)
 * 2. Biometric Registration (prompts them to register 3D Face & Fingerprint if not enrolled)
 */
export function StudentReadinessModal({
    isOpen,
    onClose,
    hasFaceRegistered = false,
    studentName = 'Student'
}) {
    const navigate = useNavigate();

    // Location Permission State: 'checking' | 'granted' | 'prompt' | 'denied'
    const [locationStatus, setLocationStatus] = useState('checking');
    const [requestingLocation, setRequestingLocation] = useState(false);

    // Inspect current permission states
    const checkPermissions = useCallback(async () => {
        // Check Geolocation Permission
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
                            setLocationStatus('granted'); // System permission was granted
                        },
                        { enableHighAccuracy: false, timeout: 6000, maximumAge: 30000 }
                    );
                }
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 }
        );
    };

    const isBiometricEnrolled = Boolean(hasFaceRegistered);
    const isLocationGranted = locationStatus === 'granted';
    const allCompleted = isLocationGranted && isBiometricEnrolled;

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
                            ? "All required classroom permissions and biometric credentials are fully configured."
                            : "Please enable location access and ensure your biometrics are enrolled before attending class."}
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

                    {/* Item 2: Biometrics Registration */}
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
                    {!isLocationGranted ? (
                        <button
                            type="button"
                            onClick={handleRequestLocation}
                            disabled={requestingLocation}
                            className="readiness-main-btn"
                        >
                            {requestingLocation ? <FaSpinner className="fa-spin" /> : <FaBolt />}
                            <span>{requestingLocation ? 'Enabling Location...' : 'Allow Classroom Location Access'}</span>
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
