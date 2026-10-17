import { useState, useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import {
    FaBullhorn,
    FaCalendarCheck,
    FaUserEdit,
    FaShieldAlt,
    FaBell,
    FaTimes,
    FaQrcode
} from "react-icons/fa";
import "./HeadsUpNotification.css";

/**
 * Check if the client is a mobile device, phone (e.g. iPhone, Android), APK, or small screen
 */
export function isSmallOrMobileDevice() {
    if (typeof window === "undefined") return false;
    if (Capacitor.isNativePlatform()) return true;
    if (window.innerWidth <= 800) return true;
    const ua = (navigator.userAgent || navigator.vendor || window.opera || "").toLowerCase();
    return /android|iphone|ipad|ipod|mobile/i.test(ua);
}

/**
 * Global Real-App Heads-Up Notification Banner
 * 
 * Pops down from the top of the screen when any notification or announcement arrives,
 * strictly enabled for desktop browser view and suppressed on mobile devices/apps.
 */
export function HeadsUpNotification() {
    const isMobileDevice = isSmallOrMobileDevice();
    const [currentAlert, setCurrentAlert] = useState(null);
    const [isDismissing, setIsDismissing] = useState(false);
    const dismissTimerRef = useRef(null);

    useEffect(() => {
        // Suppress completely on mobile devices / APK / iPhones per user requirement
        if (isMobileDevice) return;

        const handleNewNotification = (e) => {
            const data = e.detail;
            if (!data || !data.title) return;

            // Clear any active dismiss timer
            if (dismissTimerRef.current) {
                clearTimeout(dismissTimerRef.current);
            }

            setIsDismissing(false);
            setCurrentAlert(data);

            // Auto-dismiss after 6.5 seconds
            dismissTimerRef.current = setTimeout(() => {
                triggerDismiss();
            }, 6500);
        };

        window.addEventListener("smartattend:headsup_notification", handleNewNotification);
        return () => {
            window.removeEventListener("smartattend:headsup_notification", handleNewNotification);
            if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
        };
    }, []);

    const triggerDismiss = () => {
        setIsDismissing(true);
        setTimeout(() => {
            setCurrentAlert(null);
            setIsDismissing(false);
        }, 300);
    };

    if (isMobileDevice || !currentAlert) return null;

    const type = String(currentAlert.type || "").toUpperCase();
    const title = currentAlert.title || "SmartAttend Notice";
    const message = currentAlert.message || "";

    // Determine category styling
    let category = "default";
    let icon = <FaBell />;
    let badgeText = "Notification";

    if (
        type.includes("ANNOUNCE") ||
        type.includes("BROADCAST") ||
        type.includes("GENERAL_NOTICE") ||
        title.toLowerCase().includes("announcement")
    ) {
        category = "announcement";
        icon = <FaBullhorn />;
        badgeText = "Announcement";
    } else if (
        type.includes("SESSION") ||
        type.includes("CLASS") ||
        type.includes("ATTENDANCE") ||
        title.toLowerCase().includes("attendance")
    ) {
        category = "session";
        icon = <FaCalendarCheck />;
        badgeText = "Live Class";
    } else if (
        type.includes("PROFILE") ||
        type.includes("DEVICE_RESET") ||
        title.toLowerCase().includes("profile") ||
        title.toLowerCase().includes("photo")
    ) {
        category = "profile";
        icon = <FaUserEdit />;
        badgeText = "Account Update";
    } else if (
        type.includes("SECURITY") ||
        type.includes("ALERT") ||
        type.includes("VIOLATION") ||
        type.includes("WARNING")
    ) {
        category = "security";
        icon = <FaShieldAlt />;
        badgeText = "Security Alert";
    }

    const handleClickNotification = () => {
        // Dispatch open notification modal request
        try {
            window.dispatchEvent(
                new CustomEvent("smartattend:open_notification_modal", {
                    detail: currentAlert
                })
            );
        } catch (_) {}
        triggerDismiss();
    };

    return (
        <div className="headsup-container">
            <div
                className={`headsup-card ${category} ${isDismissing ? "dismissing" : ""}`}
                onClick={handleClickNotification}
            >
                <div className={`headsup-icon-wrapper ${category}`}>
                    {icon}
                </div>

                <div className="headsup-body">
                    <div className="headsup-header-meta">
                        <span className="headsup-app-label">
                            SmartAttend
                            <span className={`headsup-badge ${category}`}>
                                {badgeText}
                            </span>
                        </span>
                        <span className="headsup-time">Just now</span>
                    </div>

                    <h4 className="headsup-title">{title}</h4>
                    {message && <p className="headsup-message">{message}</p>}
                </div>

                <button
                    type="button"
                    className="headsup-close-btn"
                    onClick={(e) => {
                        e.stopPropagation();
                        triggerDismiss();
                    }}
                    title="Dismiss notification"
                    aria-label="Dismiss notification"
                >
                    <FaTimes />
                </button>

                <div className={`headsup-progress-bar ${category}`} />
            </div>
        </div>
    );
}

export default HeadsUpNotification;
