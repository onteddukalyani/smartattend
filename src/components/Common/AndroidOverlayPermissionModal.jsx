import React, { useState, useEffect, useCallback } from 'react';
import {
    FaShieldAlt,
    FaEllipsisV,
    FaFingerprint,
    FaToggleOn,
    FaCheckCircle,
    FaExternalLinkAlt,
    FaTimes,
    FaInfoCircle,
    FaAndroid,
    FaRedo,
    FaLock
} from 'react-icons/fa';
import { Capacitor } from '@capacitor/core';
import { KioskPlugin } from '../../plugins/kiosk';
import './AndroidOverlayPermissionModal.css';

/**
 * AndroidOverlayPermissionModal
 * 
 * Beautifully styled CSS modal replacing the raw native Android AlertDialog.
 * Guides Android 13+ APK users through unlocking Restricted Settings & enabling
 * 'Display over other apps' overlay permission for unbreakable Kiosk Lock Mode.
 */
export default function AndroidOverlayPermissionModal({
    forceOpen = false,
    onClose = () => {}
}) {
    const isNativeAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
    const [isOpen, setIsOpen] = useState(false);
    const [isChecking, setIsChecking] = useState(false);
    const [isGranted, setIsGranted] = useState(false);
    const [currentStep, setCurrentStep] = useState(1);

    // Check overlay permission status from native plugin
    const verifyOverlayStatus = useCallback(async () => {
        if (!isNativeAndroid) return false;
        setIsChecking(true);
        try {
            const res = await KioskPlugin.canDrawOverlays();
            const granted = Boolean(res?.canDrawOverlays);
            setIsGranted(granted);
            if (granted) {
                // If it was open, automatically close after a short celebration
                setTimeout(() => {
                    setIsOpen(false);
                    onClose();
                }, 1200);
            }
            return granted;
        } catch (err) {
            console.warn('[OverlayModal] Status check notice:', err);
            return false;
        } finally {
            setIsChecking(false);
        }
    }, [isNativeAndroid, onClose]);

    // Initial check on mount
    useEffect(() => {
        if (!isNativeAndroid) return;

        if (forceOpen) {
            setIsOpen(true);
            verifyOverlayStatus();
            return;
        }

        const dismissed = sessionStorage.getItem('smartattend_dismissed_overlay_prompt');
        if (dismissed === 'true') return;

        verifyOverlayStatus().then((granted) => {
            if (!granted) {
                // Present after a graceful 1.5s delay on app startup
                const timer = setTimeout(() => setIsOpen(true), 1500);
                return () => clearTimeout(timer);
            }
        });
    }, [isNativeAndroid, forceOpen, verifyOverlayStatus]);

    // Re-verify immediately when user switches back from Android Settings
    useEffect(() => {
        if (!isOpen) return;

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                verifyOverlayStatus();
            }
        };

        const handleFocus = () => {
            verifyOverlayStatus();
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('focus', handleFocus);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('focus', handleFocus);
        };
    }, [isOpen, verifyOverlayStatus]);

    const handleOpenAppInfo = async () => {
        setCurrentStep(2);
        try {
            await KioskPlugin.openAppDetailsSettings();
        } catch (err) {
            console.warn('[OverlayModal] Open App Info error:', err);
        }
    };

    const handleOpenOverlaySettings = async () => {
        setCurrentStep(4);
        try {
            await KioskPlugin.requestOverlayPermission();
        } catch (err) {
            console.warn('[OverlayModal] Open Overlay Settings error:', err);
        }
    };

    const handleDismiss = () => {
        try {
            sessionStorage.setItem('smartattend_dismissed_overlay_prompt', 'true');
        } catch (_) {}
        setIsOpen(false);
        onClose();
    };

    if (!isOpen || !isNativeAndroid) return null;

    return (
        <div className="overlay-guide-backdrop" role="dialog" aria-modal="true" aria-labelledby="overlay-guide-title">
            <div className="overlay-guide-card">
                {/* Header glow banner */}
                <div className="overlay-guide-header">
                    <div className="overlay-guide-icon-badge">
                        <FaShieldAlt className="shield-icon" />
                        <span className="android-chip"><FaAndroid /> Android 13+</span>
                    </div>
                    <button
                        type="button"
                        className="overlay-guide-close"
                        onClick={handleDismiss}
                        aria-label="Close modal"
                    >
                        <FaTimes />
                    </button>
                    <h2 id="overlay-guide-title" className="overlay-guide-title">
                        Action Required: Allow Restricted Settings & Overlay
                    </h2>
                    <p className="overlay-guide-subtitle">
                        SmartAttend requires <strong>Display over other apps</strong> to lock attendance sessions and prevent proxy attendance.
                    </p>
                </div>

                {/* Android Security Notice Box */}
                <div className="overlay-security-notice">
                    <div className="notice-icon"><FaInfoCircle /></div>
                    <div className="notice-content">
                        <strong>📌 Downloaded APK Security Step:</strong>
                        <span> Because SmartAttend is installed as an APK, Android restricts special permissions by default until unlocked.</span>
                    </div>
                </div>

                {/* 4 Interactive Visual Step Cards */}
                <div className="overlay-steps-container">
                    <div className={`overlay-step-row ${currentStep >= 1 ? 'active' : ''}`}>
                        <div className="step-number">1</div>
                        <div className="step-details">
                            <span className="step-title">Open App Info Settings</span>
                            <span className="step-desc">Tap <strong>"1. Open App Info"</strong> below to view SmartAttend system details.</span>
                        </div>
                    </div>

                    <div className={`overlay-step-row ${currentStep >= 2 ? 'active' : ''}`}>
                        <div className="step-number">2</div>
                        <div className="step-details">
                            <span className="step-title">Tap the 3 Dots Menu (⋮)</span>
                            <span className="step-desc">Look at the top-right corner of App Info and tap the <strong>3 vertical dots (⋮)</strong>.</span>
                        </div>
                    </div>

                    <div className={`overlay-step-row ${currentStep >= 3 ? 'active' : ''}`}>
                        <div className="step-number">3</div>
                        <div className="step-details">
                            <span className="step-title">Allow Restricted Settings</span>
                            <span className="step-desc">Tap <strong>"Allow restricted settings"</strong> and verify your Fingerprint or PIN.</span>
                        </div>
                    </div>

                    <div className={`overlay-step-row ${currentStep >= 4 ? 'active' : ''}`}>
                        <div className="step-number">4</div>
                        <div className="step-details">
                            <span className="step-title">Turn ON Overlay Permission</span>
                            <span className="step-desc">Return here, tap <strong>"2. Enable Overlay"</strong>, and switch SmartAttend to <strong>Allowed</strong>.</span>
                        </div>
                    </div>
                </div>

                {/* Live Verification Status Pill */}
                {isGranted ? (
                    <div className="overlay-status-banner success">
                        <FaCheckCircle className="status-icon" />
                        <span>Permission Granted! Kiosk mode is ready.</span>
                    </div>
                ) : (
                    <div className="overlay-status-banner checking">
                        <FaLock className="status-icon" />
                        <span>Overlay permission is currently disabled.</span>
                        <button
                            type="button"
                            className="btn-recheck"
                            onClick={verifyOverlayStatus}
                            disabled={isChecking}
                            title="Refresh permission status"
                        >
                            <FaRedo className={isChecking ? 'spin' : ''} /> {isChecking ? 'Checking...' : 'Verify'}
                        </button>
                    </div>
                )}

                {/* High-Contrast Action Buttons */}
                <div className="overlay-action-buttons">
                    <button
                        type="button"
                        className="btn-overlay-action primary"
                        onClick={handleOpenAppInfo}
                    >
                        <FaExternalLinkAlt /> 1. Open App Info (3 Dots ⋮)
                    </button>

                    <button
                        type="button"
                        className="btn-overlay-action secondary"
                        onClick={handleOpenOverlaySettings}
                    >
                        <FaToggleOn /> 2. Enable Overlay Switch
                    </button>
                </div>

                {/* Footer link */}
                <div className="overlay-guide-footer">
                    <button type="button" className="btn-overlay-dismiss" onClick={handleDismiss}>
                        Remind Me Later
                    </button>
                </div>
            </div>
        </div>
    );
}
