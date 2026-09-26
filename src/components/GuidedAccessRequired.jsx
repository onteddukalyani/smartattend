import React, { useState, useEffect, useCallback } from 'react';
import {
    FaShieldAlt,
    FaSyncAlt,
    FaLock,
    FaSlidersH,
    FaHandPointRight,
    FaCheckCircle,
    FaMobileAlt,
    FaInfoCircle
} from 'react-icons/fa';
import { isGuidedAccessEnabled, addGuidedAccessListener } from '../services/guidedAccessService';
import './GuidedAccessRequired.css';

/**
 * GuidedAccessRequired Component (iOS Full-Screen Lockdown Guard)
 * 
 * Displayed when an iPhone student scans QR1 and Guided Access is not yet active.
 * Guides the student with visual instructions to triple-click the Side Button
 * and automatically dismisses as soon as native Guided Access activates.
 * 
 * @param {Object} props
 * @param {Function} props.onEnabled - Callback invoked when Guided Access is detected active
 */
export function GuidedAccessRequired({ onEnabled }) {
    const [isChecking, setIsChecking] = useState(false);
    const [statusMessage, setStatusMessage] = useState('');
    const [isUnlocked, setIsUnlocked] = useState(false);

    const handleGuidedAccessActive = useCallback(() => {
        setIsUnlocked(true);
        setStatusMessage('Guided Access active! Continuing attendance...');
        if (typeof onEnabled === 'function') {
            setTimeout(() => {
                onEnabled();
            }, 600);
        }
    }, [onEnabled]);

    // 1. Check status on mount & attach real-time listener from Swift
    useEffect(() => {
        let cleanup = null;

        const initListener = async () => {
            cleanup = await addGuidedAccessListener((status) => {
                if (status && status.enabled) {
                    handleGuidedAccessActive();
                }
            });
        };

        initListener();

        // Periodic safety poll every 2 seconds while blocking screen is mounted
        const pollInterval = setInterval(async () => {
            const res = await isGuidedAccessEnabled();
            if (res && res.enabled) {
                handleGuidedAccessActive();
            }
        }, 2000);

        return () => {
            if (typeof cleanup === 'function') cleanup();
            clearInterval(pollInterval);
        };
    }, [handleGuidedAccessActive]);

    // Manual "Check Again" button trigger
    const handleCheckAgain = async () => {
        setIsChecking(true);
        setStatusMessage('');
        try {
            const res = await isGuidedAccessEnabled();
            if (res && res.enabled) {
                handleGuidedAccessActive();
            } else {
                setStatusMessage('Guided Access is still OFF. Please triple-click the Side Button.');
            }
        } catch (err) {
            setStatusMessage('Could not verify status. Please ensure Guided Access is started.');
        } finally {
            setTimeout(() => setIsChecking(false), 500);
        }
    };

    return (
        <div className="guided-access-overlay" role="dialog" aria-modal="true" aria-labelledby="ga-title">
            <div className="guided-access-container">
                {/* Header Badge */}
                <div className="ga-badge">
                    <span className="ga-badge-pulse"></span>
                    <FaShieldAlt /> iOS Guided Access Required
                </div>

                <h2 id="ga-title" className="ga-title">
                    Lock SmartAttend to Proceed
                </h2>
                <p className="ga-subtitle">
                    To ensure attendance integrity on iPhone, please turn on <strong>Guided Access</strong> before proceeding to QR 2.
                </p>

                {/* iPhone Vector Graphic with Animated Triple-Click Highlight */}
                <div className="ga-illustration-wrap">
                    <svg
                        className="ga-iphone-svg"
                        viewBox="0 0 200 320"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                    >
                        {/* iPhone Frame */}
                        <rect x="25" y="10" width="150" height="300" rx="32" fill="#1e293b" stroke="#3b82f6" strokeWidth="3" />
                        {/* Screen */}
                        <rect x="33" y="18" width="134" height="284" rx="24" fill="#ffffff" />
                        {/* Dynamic Island / Speaker Notch */}
                        <rect x="75" y="24" width="50" height="12" rx="6" fill="#0f172a" />
                        
                        {/* Side Button Graphic on the Right Edge */}
                        <rect x="175" y="90" width="6" height="35" rx="3" fill="#2563eb" />
                        
                        {/* Screen Content: SmartAttend Guided Access Card */}
                        <rect x="44" y="60" width="112" height="180" rx="14" fill="#eff6ff" stroke="#bfdbfe" strokeWidth="1.5" />
                        <circle cx="100" cy="100" r="22" fill="#2563eb" />
                        <path
                            d="M93 100 L98 105 L108 94"
                            stroke="#ffffff"
                            strokeWidth="3.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                        <rect x="56" y="135" width="88" height="10" rx="5" fill="#1e40af" />
                        <rect x="66" y="152" width="68" height="6" rx="3" fill="#93c5fd" />
                        <rect x="54" y="175" width="92" height="24" rx="8" fill="#2563eb" />
                        <rect x="70" y="184" width="60" height="6" rx="3" fill="#ffffff" />
                    </svg>

                    {/* Animated Side Button Pulse Indicator */}
                    <div className="ga-side-button-hint">
                        <FaHandPointRight style={{ color: '#2563eb', fontSize: '1.2rem' }} />
                        <div className="ga-hint-pill">Triple-Click Side Button</div>
                    </div>
                </div>

                {/* Step-by-Step Instructions */}
                <div className="ga-steps-list">
                    <div className="ga-step-item">
                        <div className="ga-step-number">1</div>
                        <div className="ga-step-content">
                            <div className="ga-step-title">Enable Guided Access in Settings</div>
                            <p className="ga-step-desc">
                                Go to <span className="ga-highlight">Settings</span> → <span className="ga-highlight">Accessibility</span> → <span className="ga-highlight">Guided Access</span> and switch it <strong>ON</strong>.
                            </p>
                        </div>
                    </div>

                    <div className="ga-step-item">
                        <div className="ga-step-number">2</div>
                        <div className="ga-step-content">
                            <div className="ga-step-title">Start Session in SmartAttend</div>
                            <p className="ga-step-desc">
                                Return here and <strong>Triple-click the Side Button</strong> (or Home Button), then tap <strong>Start</strong> in the top-right corner.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Live Status Message */}
                {statusMessage && (
                    <p className={`ga-status-msg ${isUnlocked ? 'success' : ''}`}>
                        {statusMessage}
                    </p>
                )}

                {/* Actions */}
                <div className="ga-actions">
                    <button
                        type="button"
                        className="ga-check-button"
                        onClick={handleCheckAgain}
                        disabled={isChecking || isUnlocked}
                    >
                        {isChecking ? (
                            <>
                                <FaSyncAlt className="ga-spin-icon" /> Checking Guided Access...
                            </>
                        ) : isUnlocked ? (
                            <>
                                <FaCheckCircle /> Guided Access Active
                            </>
                        ) : (
                            <>
                                <FaSyncAlt /> Check Again
                            </>
                        )}
                    </button>

                    <div className="ga-footer-note">
                        <FaLock /> Automatically proceeds once Guided Access starts.
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * GuidedAccessExitNotice Component
 * 
 * Shown after student completes attendance on iOS to remind them how to exit Guided Access.
 */
export function GuidedAccessExitNotice() {
    return (
        <div className="ga-exit-banner">
            <div className="ga-exit-banner-icon">
                <FaCheckCircle />
            </div>
            <div className="ga-exit-banner-content">
                <h4>Attendance Completed!</h4>
                <p>
                    You can now exit Guided Access anytime by <strong>Triple-clicking the Side Button</strong> and entering your iPhone passcode.
                </p>
            </div>
        </div>
    );
}

export default GuidedAccessRequired;
