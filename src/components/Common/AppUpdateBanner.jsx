import React, { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
    FaRocket,
    FaDownload,
    FaRedo,
    FaTimes,
    FaChevronUp,
    FaChevronDown,
    FaAndroid,
    FaGlobe
} from 'react-icons/fa';
import './AppUpdateBanner.css';

/**
 * AppUpdateBanner
 *
 * Prominently alerts active users that a new version of SmartAttend has been deployed.
 * - On Native Android (APK): Informs the user they must update the app (as they cannot simply refresh),
 *   providing direct access to download the APK and step-by-step installation instructions.
 * - On Web Browser: Prompts users with a quick 1-click 'Refresh Page' button to load the new build.
 */
export default function AppUpdateBanner({
    updateInfo,
    onOpenModal,
    onDismiss
}) {
    const [isCollapsed, setIsCollapsed] = useState(false);

    if (!updateInfo || !updateInfo.hasUpdate) return null;

    const isNative = Capacitor.isNativePlatform() || Boolean(updateInfo.isNative);
    const latestVersion = updateInfo.latestVersion || '1.0.3';
    const currentVersion = updateInfo.currentVersion || '1.0.2';
    const isMandatory = Boolean(updateInfo.isMandatory);

    const handleWebRefresh = () => {
        try {
            // Unregister service workers or clear cache if possible, then hard refresh
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistrations().then((registrations) => {
                    registrations.forEach((reg) => reg.update());
                });
            }
        } catch (_) {}
        window.location.reload(true);
    };

    const handleActionClick = () => {
        if (isNative) {
            if (onOpenModal) onOpenModal();
        } else {
            handleWebRefresh();
        }
    };

    const handleToggleCollapse = (e) => {
        e.stopPropagation();
        setIsCollapsed((prev) => !prev);
    };

    const handleCloseBanner = (e) => {
        e.stopPropagation();
        if (onDismiss) {
            onDismiss();
        } else {
            setIsCollapsed(true);
        }
    };

    // Compact floating pill when collapsed
    if (isCollapsed) {
        return (
            <div
                className="st-update-pill-floating"
                onClick={() => setIsCollapsed(false)}
                role="button"
                tabIndex={0}
                title="Click to view update details"
            >
                <span className="st-pill-icon"><FaRocket /></span>
                <span className="st-pill-text">Update v{latestVersion} available</span>
                <button
                    type="button"
                    className="st-pill-action-btn"
                    onClick={(e) => {
                        e.stopPropagation();
                        handleActionClick();
                    }}
                >
                    {isNative ? 'Update' : 'Refresh'}
                </button>
            </div>
        );
    }

    return (
        <aside
            className={`st-update-banner-container ${isMandatory ? 'mandatory' : ''}`}
            aria-label="App update notification"
            role="alert"
        >
            <div className="st-update-banner-content">
                {/* Left Badge / Icon */}
                <div className="st-update-banner-icon-wrap">
                    <div className="st-update-banner-rocket">
                        <FaRocket />
                    </div>
                    <span className="st-banner-platform-tag">
                        {isNative ? <><FaAndroid /> APK App</> : <><FaGlobe /> Web</>}
                    </span>
                </div>

                {/* Main Message */}
                <div className="st-update-banner-info">
                    <div className="st-update-banner-title-row">
                        <h4 className="st-update-banner-title">
                            {isMandatory ? '⚠️ Required Update:' : '🚀 New Update Available:'} SmartAttend v{latestVersion}
                        </h4>
                        <span className="st-version-diff-tag">
                            v{currentVersion} ➔ v{latestVersion}
                        </span>
                    </div>

                    <p className="st-update-banner-desc">
                        {isNative ? (
                            <>
                                A new app version has been released! Because you are using the installed app,
                                tap <strong>Update App</strong> to download and install the new APK.
                            </>
                        ) : (
                            <>
                                A new version is live! Tap <strong>Refresh Now</strong> to load the updated web interface.
                            </>
                        )}
                    </p>
                </div>

                {/* Action Buttons */}
                <div className="st-update-banner-actions">
                    <button
                        type="button"
                        className="st-update-banner-primary-btn"
                        onClick={handleActionClick}
                    >
                        {isNative ? (
                            <>
                                <FaDownload />
                                <span>Update App (.apk)</span>
                            </>
                        ) : (
                            <>
                                <FaRedo />
                                <span>Refresh Now</span>
                            </>
                        )}
                    </button>

                    {!isMandatory && (
                        <div className="st-update-banner-controls">
                            <button
                                type="button"
                                className="st-update-banner-collapse-btn"
                                onClick={handleToggleCollapse}
                                title="Minimize banner"
                                aria-label="Minimize"
                            >
                                <FaChevronUp />
                            </button>
                            <button
                                type="button"
                                className="st-update-banner-close-btn"
                                onClick={handleCloseBanner}
                                title="Dismiss notification"
                                aria-label="Dismiss"
                            >
                                <FaTimes />
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </aside>
    );
}
