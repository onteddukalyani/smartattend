import React, { useState, useEffect, useRef } from "react";
import { FaGraduationCap, FaQrcode, FaCheckCircle, FaExclamationCircle, FaShieldAlt, FaTimes } from "react-icons/fa";

/**
 * Mobile-First Native Suppression Rule:
 * We completely hide and suppress HeadsUpNotification on mobile viewports (<= 768px)
 * or if running inside Android / iOS Capacitor shell. On mobile devices, native push
 * or on-screen card indicators take precedence.
 */
function isSmallOrMobileDevice() {
    if (typeof window === "undefined") return false;
    const isMobileWidth = window.innerWidth <= 768;
    const isMobileAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator?.userAgent || "");
    const isCapacitor = Boolean(window.Capacitor?.isNativePlatform && window.Capacitor.isNativePlatform());
    return isMobileWidth || isMobileAgent || isCapacitor;
}

/**
 * HeadsUpNotification Component
 * Displays a non-intrusive floating banner for critical real-time alerts
 * on laptop and desktop screens (attendance opened, verification complete, system warnings).
 */
export function HeadsUpNotification() {
    const isMobileDevice = isSmallOrMobileDevice();
    const [currentAlert, setCurrentAlert] = useState(null);
    const [isDismissing, setIsDismissing] = useState(false);
    const dismissTimerRef = useRef(null);

    const triggerDismiss = () => {
        setIsDismissing(true);
        setTimeout(() => {
            setCurrentAlert(null);
            setIsDismissing(false);
        }, 300);
    };

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

    if (isMobileDevice || !currentAlert) return null;

    const type = String(currentAlert.type || "").toUpperCase();
    const title = currentAlert.title || "SmartAttend Notice";
    const message = currentAlert.message || "";

    // Determine category styling
    let icon = <FaGraduationCap />;
    let accentBorder = "#3b82f6";
    let badgeBg = "rgba(59, 130, 246, 0.15)";
    let badgeColor = "#60a5fa";

    if (type.includes("SESSION") || type.includes("LIVE") || type.includes("QR")) {
        icon = <FaQrcode />;
        accentBorder = "#10b981";
        badgeBg = "rgba(16, 185, 129, 0.15)";
        badgeColor = "#34d399";
    } else if (type.includes("SUCCESS") || type.includes("VERIF")) {
        icon = <FaCheckCircle />;
        accentBorder = "#10b981";
        badgeBg = "rgba(16, 185, 129, 0.15)";
        badgeColor = "#34d399";
    } else if (type.includes("ALERT") || type.includes("WARNING") || type.includes("VIOLATION")) {
        icon = <FaShieldAlt />;
        accentBorder = "#ef4444";
        badgeBg = "rgba(239, 68, 68, 0.15)";
        badgeColor = "#f87171";
    }

    return (
        <aside
            aria-live="polite"
            role="status"
            aria-atomic="true"
            aria-label={`Notification: ${title}`}
            style={{
                position: "fixed",
                top: "20px",
                right: "20px",
                zIndex: 999999,
                maxWidth: "380px",
                width: "calc(100% - 40px)",
                background: "rgba(15, 23, 42, 0.95)",
                backdropFilter: "blur(12px)",
                border: "1.5px solid rgba(255, 255, 255, 0.12)",
                borderLeft: `4px solid ${accentBorder}`,
                borderRadius: "14px",
                boxShadow: "0 14px 38px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.05)",
                padding: "14px 16px",
                display: "flex",
                alignItems: "flex-start",
                gap: "12px",
                color: "#f8fafc",
                transform: isDismissing ? "translateY(-18px) scale(0.96)" : "translateY(0) scale(1)",
                opacity: isDismissing ? 0 : 1,
                transition: "all 0.28s cubic-bezier(0.16, 1, 0.3, 1)",
                pointerEvents: isDismissing ? "none" : "auto",
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
            }}
        >
            <div
                style={{
                    width: "36px",
                    height: "36px",
                    borderRadius: "10px",
                    background: badgeBg,
                    color: badgeColor,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "1.05rem",
                    flexShrink: 0
                }}
            >
                {icon}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                    <h4
                        style={{
                            margin: 0,
                            fontSize: "0.88rem",
                            fontWeight: 700,
                            color: "#ffffff",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis"
                        }}
                    >
                        {title}
                    </h4>
                    <button
                        type="button"
                        onClick={triggerDismiss}
                        style={{
                            background: "transparent",
                            border: "none",
                            color: "#94a3b8",
                            cursor: "pointer",
                            padding: "2px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "0.85rem",
                            transition: "color 0.15s ease"
                        }}
                        title="Dismiss notification"
                    >
                        <FaTimes />
                    </button>
                </div>
                <p
                    style={{
                        margin: "4px 0 0 0",
                        fontSize: "0.78rem",
                        color: "#cbd5e1",
                        lineHeight: 1.45,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden"
                    }}
                >
                    {message}
                </p>
            </div>
        </aside>
    );
}

export default HeadsUpNotification;
