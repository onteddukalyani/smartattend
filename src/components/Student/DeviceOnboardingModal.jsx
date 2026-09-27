import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
    FaAndroid,
    FaApple,
    FaDownload,
    FaShieldAlt,
    FaCheckCircle,
    FaExclamationTriangle,
    FaTimes,
    FaInfoCircle,
    FaExternalLinkAlt,
    FaLock
} from 'react-icons/fa';
import { Capacitor } from '@capacitor/core';
import { db } from '../../firebase';
import { doc, setDoc } from 'firebase/firestore';
import { useAuth } from '../authcontext';
import { isGuidedAccessEnabled } from '../../services/guidedAccessService';
import { detectDeviceType } from '../../utils/deviceDetection';
import { sendFacultyNotification, sendStudentNotification } from '../../services/notificationsService';
import './DeviceOnboardingModal.css';

const ANDROID_APK_URL = import.meta.env.VITE_ANDROID_APK_URL?.trim() || '';

/**
 * DeviceOnboardingModal
 * Asks student to select Android vs iPhone (iOS) device.
 * - Android: If browser, forces download/install of native APK (Lock Task Kiosk Mode).
 * - iPhone: Guides PWA Home Screen installation + iOS Guided Access setup.
 * - Immediately locks device selection (deviceTypeLocked: true) upon saving.
 */
export function DeviceOnboardingModal({ isOpen, onClose }) {
    const { user, profile } = useAuth();
    const isNativeApp = Capacitor.isNativePlatform();
    const roll = (profile?.rollNo || user?.email?.split('@')[0] || '').trim().toUpperCase();
    const detectedDevice = detectDeviceType();
    const mismatchReportKey = `smartattend:device-mismatch-reported:${roll}`;

    // Device Choice State: 'android' | 'ios' | null
    const [selectedDevice, setSelectedDevice] = useState(() => {
        try {
            return localStorage.getItem('smartattend_student_device_type') || detectedDevice;
        } catch {
            return detectedDevice;
        }
    });

    const [gaVerified, setGaVerified] = useState(false);
    const [gaCheckLoading, setGaCheckLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [mismatchReported, setMismatchReported] = useState(() => {
        try {
            return localStorage.getItem(mismatchReportKey) === 'sent';
        } catch {
            return false;
        }
    });

    if (!isOpen) return null;

    const hasDeviceMismatch = Boolean(detectedDevice && selectedDevice && detectedDevice !== selectedDevice);
    const isLocked = Boolean(
        profile?.role === 'student' &&
        (localStorage.getItem('smartattend_student_device_type') || profile?.deviceType) &&
        (profile?.deviceTypeLocked === true || localStorage.getItem('smartattend_student_device_locked') === 'true')
    );

    const handleSelectDevice = async (deviceType) => {
        if (isLocked) {
            alert("🔒 Device Selection Locked!\n\nYour device preference is permanently locked to protect attendance integrity. Only a Lecturer or System Administrator can reset your device type.");
            return;
        }
        setSelectedDevice(deviceType);
        setMismatchReported(false);
    };

    const handleReportDeviceMismatch = async () => {
        if (!hasDeviceMismatch || !roll || mismatchReported) return;
        setSaving(true);
        try {
            const studentName = profile?.name || user?.displayName || roll;
            await sendFacultyNotification(
                'Student Device Type Mismatch Reported',
                `Student ${studentName} (${roll}) selected ${selectedDevice} but this device was detected as ${detectedDevice}. Please verify the student's device setup.`,
                'DEVICE_TYPE_MISMATCH',
                roll,
                studentName
            );
            try {
                localStorage.setItem(mismatchReportKey, 'sent');
            } catch {
                // The report is still sent if local storage is unavailable.
            }
            setMismatchReported(true);
        } finally {
            setSaving(false);
        }
    };

    const handleSaveAndLockDevice = async () => {
        if (!selectedDevice) return;
        if (hasDeviceMismatch) {
            await handleReportDeviceMismatch();
            return;
        }
        setSaving(true);
        try {
            localStorage.setItem('smartattend_student_device_type', selectedDevice);
            localStorage.setItem('smartattend_student_device_locked', 'true');

            if (roll && db) {
                const lockPayload = {
                    deviceType: selectedDevice,
                    deviceTypeLocked: true,
                    deviceSelectedAt: Date.now()
                };

                // Update students collection & users collection
                await setDoc(doc(db, 'students', roll), lockPayload, { merge: true });
                await setDoc(doc(db, 'users', roll), lockPayload, { merge: true }).catch(() => {});

                const studentName = profile?.name || roll;
                const deviceLabel = selectedDevice === 'android' ? 'Android APK' : 'iPhone (iOS Guided Access)';

                // Notify Faculty & Admin audit stream
                await sendFacultyNotification(
                    'Device Type Selected & Locked',
                    `Student ${studentName} (${roll}) registered and locked their device preference to ${deviceLabel}.`,
                    'DEVICE_LOCKED',
                    roll,
                    studentName
                );

                // Send confirmation notification to Student's own audit log
                await sendStudentNotification(
                    roll,
                    'Device Locked 🔒',
                    `Your registered device type has been locked to ${deviceLabel}. Only a Lecturer or Admin can reset your device preference.`,
                    'DEVICE_LOCKED',
                    'System Security'
                );
            }
        } catch (e) {
            console.warn('Error saving device preference:', e);
        } finally {
            setSaving(false);
            if (onClose) onClose();
        }
    };

    const handleCheckGuidedAccess = async () => {
        setGaCheckLoading(true);
        try {
            const res = await isGuidedAccessEnabled();
            if (res && res.enabled) {
                setGaVerified(true);
            } else {
                alert('Guided Access is currently OFF on your iPhone.\n\nPlease go to Settings -> Accessibility -> Guided Access, turn it ON, and triple-click the Side/Home Button.');
            }
        } catch (e) {
            console.warn('Guided Access check notice:', e);
        } finally {
            setGaCheckLoading(false);
        }
    };

    return (
        <div className="device-modal-overlay" role="dialog" aria-modal="true">
            <div className="device-modal-card">
                {onClose && (
                    <button className="device-modal-close-btn" onClick={onClose} aria-label="Close">
                        <FaTimes />
                    </button>
                )}

                <div className="device-modal-header">
                    <div className="device-modal-badge">
                        <FaShieldAlt /> Device Verification & Security
                    </div>
                    <h2 className="device-modal-title">Select Your Phone Type</h2>
                    <p className="device-modal-subtitle">
                        SmartAttend uses hardware security features (Android Kiosk / iOS Guided Access) to verify attendance.
                    </p>
                </div>

                {isLocked && (
                    <div className="device-status-banner status-warning" style={{ background: '#fef3c7', borderColor: '#fde68a', color: '#92400e', marginBottom: '16px' }}>
                        <FaLock style={{ fontSize: '1.2rem', flexShrink: 0 }} />
                        <div>
                            <strong>Device Lock Active 🔒</strong>
                            <div>Your device selection is locked to <strong>{(selectedDevice || profile?.deviceType || '').toUpperCase()}</strong>. Only a Lecturer or Admin can unlock your device.</div>
                        </div>
                    </div>
                )}

                {/* 1. Device Type Selector Buttons */}
                <div className="device-select-grid">
                    <div
                        className={`device-option-card ${selectedDevice === 'android' ? 'selected-android' : ''} ${isLocked ? 'disabled-locked' : ''}`}
                        onClick={() => handleSelectDevice('android')}
                        style={{ opacity: isLocked && selectedDevice !== 'android' ? 0.5 : 1, cursor: isLocked ? 'not-allowed' : 'pointer' }}
                    >
                        <div className="device-icon-wrap android-icon-bg">
                            <FaAndroid />
                        </div>
                        <h3 className="device-option-title">Android Phone</h3>
                        <span className="device-option-tag tag-android">Requires Android APK</span>
                    </div>

                    <div
                        className={`device-option-card ${selectedDevice === 'ios' ? 'selected-ios' : ''} ${isLocked ? 'disabled-locked' : ''}`}
                        onClick={() => handleSelectDevice('ios')}
                        style={{ opacity: isLocked && selectedDevice !== 'ios' ? 0.5 : 1, cursor: isLocked ? 'not-allowed' : 'pointer' }}
                    >
                        <div className="device-icon-wrap ios-icon-bg">
                            <FaApple />
                        </div>
                        <h3 className="device-option-title">iPhone (iOS)</h3>
                        <span className="device-option-tag tag-ios">PWA + Guided Access</span>
                    </div>
                </div>

                {hasDeviceMismatch && (
                    <div className="device-status-banner status-warning" role="alert">
                        <FaExclamationTriangle style={{ fontSize: '1.2rem', flexShrink: 0 }} />
                        <div>
                            <strong>Selected phone type does not match this device</strong>
                            <div>This device appears to be {detectedDevice === 'android' ? 'Android' : 'iPhone'}, but {selectedDevice === 'android' ? 'Android' : 'iPhone'} is selected. Select the detected type to continue. Saving the mismatch will report it to administrators and lecturers.</div>
                            {mismatchReported && <div><strong>Mismatch report sent to administrators and lecturers.</strong></div>}
                        </div>
                    </div>
                )}

                {/* 2. Android Flow & APK Force Download */}
                {selectedDevice === 'android' && (
                    <div className="device-details-box">
                        {isNativeApp ? (
                            <div className="device-status-banner status-success">
                                <FaCheckCircle style={{ fontSize: '1.4rem', flexShrink: 0 }} />
                                <div>
                                    <strong>Official Android APK Installed & Active! ✅</strong>
                                    <div>Your device is running the native SmartAttend app with OS-level Kiosk Lock Task protection.</div>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div className="device-status-banner status-warning">
                                    <FaExclamationTriangle style={{ fontSize: '1.4rem', flexShrink: 0 }} />
                                    <div>
                                        <strong>Android Native App Mandatory for Attendance!</strong>
                                        <div>Use the institution-provided Android app for attendance. Browser-only attendance does not provide Android kiosk protection.</div>
                                    </div>
                                </div>

                                {ANDROID_APK_URL ? (
                                    <a
                                        href={ANDROID_APK_URL}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="device-action-btn btn-apk-download"
                                    >
                                        <FaDownload /> Download SmartAttend Android APK (.apk)
                                    </a>
                                ) : (
                                    <div className="device-status-banner status-info">
                                        <FaInfoCircle style={{ fontSize: '1.2rem', flexShrink: 0 }} />
                                        <div>
                                            <strong>Get the signed APK from your institution</strong>
                                            <div>No APK download link is configured in this web app.</div>
                                            <Link to="/student/device-setup" onClick={onClose}>
                                                <FaExternalLinkAlt /> Read the complete setup guide
                                            </Link>
                                        </div>
                                    </div>
                                )}

                                <div className="device-steps-guide">
                                    <div className="step-card">
                                        <div className="step-num">1</div>
                                        <div className="step-text">
                                            Tap the APK download button above, or request the current signed APK from your administrator.
                                        </div>
                                    </div>
                                    <div className="step-card">
                                        <div className="step-num">2</div>
                                        <div className="step-text">
                                            Open the downloaded file and allow <span className="step-highlight">Install from Unknown Sources</span> if prompted.
                                        </div>
                                    </div>
                                    <div className="step-card">
                                        <div className="step-num">3</div>
                                        <div className="step-text">
                                            If prompted on your device, grant <span className="step-highlight">Display over other apps</span> permission to support attendance lock mode.
                                        </div>
                                    </div>
                                    <div className="step-card">
                                        <div className="step-num">4</div>
                                        <div className="step-text">
                                            Launch the SmartAttend app from your Android home screen to mark attendance securely.
                                        </div>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* 3. iPhone / iOS Flow & Guided Access Setup */}
                {selectedDevice === 'ios' && (
                    <div className="device-details-box">
                        <div className="device-status-banner status-warning" style={{ background: '#fee2e2', borderColor: '#fca5a5', color: '#991b1b', marginBottom: '14px' }}>
                            <FaExclamationTriangle style={{ fontSize: '1.5rem', flexShrink: 0 }} />
                            <div>
                                <strong>⚠️ ZERO-TOLERANCE POLICY: 1 Violation = Attendance Disqualified!</strong>
                                <div style={{ fontSize: '0.84rem', marginTop: '4px' }}>
                                    If you switch apps, minimize Safari/PWA, press Home, or take a screen capture during attendance scanning, your attendance will be <strong>IMMEDIATELY CANCELLED</strong> and recorded as a security breach in Firebase for Lecturer review.
                                </div>
                            </div>
                        </div>

                        <div className="device-status-banner status-info" style={{ marginBottom: '14px' }}>
                            <FaInfoCircle style={{ fontSize: '1.3rem', flexShrink: 0 }} />
                            <div>
                                <strong>iPhone Guided Access Mandatory Setup</strong>
                                <div>Follow these steps first to protect your attendance from accidental cancellation:</div>
                            </div>
                        </div>

                        <div className="device-steps-guide" style={{ marginBottom: '16px' }}>
                            <div className="step-card">
                                <div className="step-num">1</div>
                                <div className="step-text">
                                    Open Safari <span className="step-arrow" aria-hidden="true">→</span> Tap Share Icon <span className="step-arrow" aria-hidden="true">→</span> Select <span className="step-highlight">Add to Home Screen</span> (PWA Mode).
                                </div>
                            </div>
                            <div className="step-card">
                                <div className="step-num">2</div>
                                <div className="step-text">
                                    Go to <span className="step-highlight">iOS Settings</span> <span className="step-arrow" aria-hidden="true">→</span> <span className="step-highlight">Accessibility</span> <span className="step-arrow" aria-hidden="true">→</span> <span className="step-highlight">Guided Access</span> <span className="step-arrow" aria-hidden="true">→</span> Turn <strong>ON</strong> and set a passcode.
                                </div>
                            </div>
                            <div className="step-card">
                                <div className="step-num">3</div>
                                <div className="step-text">
                                    Before scanning QR code, <strong>Triple-Click Side Button</strong> to start Guided Access lockdown.
                                </div>
                            </div>
                        </div>

                        <button
                            type="button"
                            className="device-action-btn btn-verify-ga"
                            onClick={handleCheckGuidedAccess}
                            disabled={gaCheckLoading}
                        >
                            <FaShieldAlt /> {gaCheckLoading ? 'Verifying...' : (gaVerified ? 'Guided Access Verified! ✅' : 'Verify Guided Access Status')}
                        </button>
                    </div>
                )}

                {/* Save & Lock Device Selection Button */}
                {selectedDevice && (
                    <button
                        type="button"
                        style={{
                            width: '100%',
                            marginTop: '20px',
                            padding: '13px',
                            borderRadius: '14px',
                            background: isLocked ? '#475569' : 'linear-gradient(135deg, #1e293b, #0f172a)',
                            color: '#ffffff',
                            border: 'none',
                            fontWeight: '700',
                            fontSize: '1rem',
                            cursor: saving ? 'wait' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '8px',
                            boxShadow: '0 4px 14px rgba(15, 23, 42, 0.25)'
                        }}
                        onClick={handleSaveAndLockDevice}
                        disabled={saving}
                    >
                        <FaLock /> {saving ? (hasDeviceMismatch ? 'Sending mismatch report...' : 'Saving & Locking...') : (hasDeviceMismatch ? (mismatchReported ? 'Mismatch Report Sent' : 'Report Mismatch') : (isLocked ? 'Close (Device Preference Locked 🔒)' : 'Save Device & Lock Preference 🔒'))}
                    </button>
                )}
            </div>
        </div>
    );
}

export default DeviceOnboardingModal;

