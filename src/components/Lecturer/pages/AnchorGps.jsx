import React, { useState, useEffect, useCallback } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import {
    FaMapMarkerAlt,
    FaCheckCircle,
    FaExclamationTriangle,
    FaSpinner,
    FaArrowLeft,
    FaSatelliteDish,
    FaRedo,
    FaMobileAlt
} from "react-icons/fa";

export default function AnchorGps() {
    const [searchParams] = useSearchParams();
    const sessionId = searchParams.get("session") || searchParams.get("sessionId") || "";
    const navigate = useNavigate();
    const { user, profile } = useAuth();

    const [status, setStatus] = useState("ACQUIRING"); // "ACQUIRING" | "SUCCESS" | "ERROR"
    const [errorMessage, setErrorMessage] = useState("");
    const [sessionData, setSessionData] = useState(null);
    const [coords, setCoords] = useState(null);
    const [accuracy, setAccuracy] = useState(null);

    // 1. Fetch Session details to verify existence & ownership
    useEffect(() => {
        if (!sessionId) {
            setStatus("ERROR");
            setErrorMessage("No active session ID provided in the link. Please scan the QR code from the projector screen.");
            return;
        }

        let isMounted = true;
        getDoc(doc(db, "attendance_sessions", sessionId))
            .then((snap) => {
                if (!isMounted) return;
                if (!snap.exists()) {
                    setStatus("ERROR");
                    setErrorMessage(`Attendance session "${sessionId}" does not exist or has already ended.`);
                    return;
                }
                const data = snap.data();
                setSessionData({ id: snap.id, ...data });
            })
            .catch((err) => {
                if (!isMounted) return;
                setStatus("ERROR");
                setErrorMessage(`Could not load session details: ${err.message}`);
            });

        return () => { isMounted = false; };
    }, [sessionId]);

    // 2. Acquire High-Accuracy Mobile GPS and Anchor to Firestore
    const handleAcquireAndAnchorGps = useCallback(() => {
        if (!sessionId) return;
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            setStatus("ERROR");
            setErrorMessage("Geolocation is not supported by your mobile browser. Please allow location permissions in device settings.");
            return;
        }

        setStatus("ACQUIRING");
        setErrorMessage("");

        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                try {
                    const lat = pos.coords.latitude;
                    const lng = pos.coords.longitude;
                    const acc = Math.round(pos.coords.accuracy || 5);
                    const currentRadius = sessionData?.geofenceRadius || 10;

                    const anchoredCoords = {
                        latitude: lat,
                        longitude: lng,
                        accuracy: acc,
                        radius: currentRadius > 0 ? currentRadius : 10,
                        source: "PHONE_ANCHOR",
                        timestamp: Date.now(),
                        anchoredBy: user?.email || profile?.name || "Lecturer Mobile"
                    };

                    await updateDoc(doc(db, "attendance_sessions", sessionId), {
                        classroomLocation: anchoredCoords,
                        geofenceRadius: currentRadius > 0 ? currentRadius : 10,
                        locationMode: "MOBILE",
                        updatedAt: Date.now()
                    });

                    setCoords(anchoredCoords);
                    setAccuracy(acc);
                    setStatus("SUCCESS");
                } catch (err) {
                    console.error("[AnchorGps] Error updating session:", err);
                    setStatus("ERROR");
                    setErrorMessage(`Failed to anchor GPS: ${err.message}`);
                }
            },
            (err) => {
                console.warn("[AnchorGps] Geolocation error:", err);
                setStatus("ERROR");
                setErrorMessage(
                    err.code === 1
                        ? "Location permission was denied. Please allow Location Access in browser/phone settings, then tap Re-Try."
                        : `GPS acquisition failed (${err.message}). Ensure Location/GPS is turned ON and retry.`
                );
            },
            {
                enableHighAccuracy: true,
                timeout: 15000,
                maximumAge: 0
            }
        );
    }, [sessionId, sessionData?.geofenceRadius, user?.email, profile?.name]);

    // Auto-trigger GPS acquisition once sessionData is ready
    useEffect(() => {
        if (sessionData && status === "ACQUIRING") {
            handleAcquireAndAnchorGps();
        }
    }, [sessionData, status, handleAcquireAndAnchorGps]);

    return (
        <div style={{
            minHeight: "100vh",
            background: "linear-gradient(180deg, #0f172a 0%, #1e1b4b 100%)",
            color: "#f8fafc",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px 16px",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        }}>
            <div style={{
                maxWidth: "440px",
                width: "100%",
                background: "rgba(30, 41, 59, 0.85)",
                border: "1.5px solid rgba(99, 102, 241, 0.35)",
                borderRadius: "20px",
                padding: "28px 22px",
                boxShadow: "0 20px 40px rgba(0, 0, 0, 0.5)",
                backdropFilter: "blur(12px)",
                textAlign: "center"
            }}>
                {/* Header Icon */}
                <div style={{
                    width: "72px",
                    height: "72px",
                    borderRadius: "50%",
                    background: status === "SUCCESS"
                        ? "rgba(16, 185, 129, 0.18)"
                        : status === "ERROR"
                            ? "rgba(239, 68, 68, 0.18)"
                            : "rgba(99, 102, 241, 0.18)",
                    border: `2px solid ${status === "SUCCESS" ? "#10b981" : status === "ERROR" ? "#ef4444" : "#6366f1"}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    margin: "0 auto 18px",
                    fontSize: "2rem",
                    color: status === "SUCCESS" ? "#10b981" : status === "ERROR" ? "#ef4444" : "#818cf8"
                }}>
                    {status === "SUCCESS" ? (
                        <FaCheckCircle />
                    ) : status === "ERROR" ? (
                        <FaExclamationTriangle />
                    ) : (
                        <FaSatelliteDish className="fa-spin" style={{ animationDuration: "3s" }} />
                    )}
                </div>

                {/* Title */}
                <h2 style={{ margin: "0 0 8px", fontSize: "1.35rem", fontWeight: 800 }}>
                    {status === "SUCCESS"
                        ? "Satellite GPS Anchored!"
                        : status === "ERROR"
                            ? "GPS Acquisition Issue"
                            : "Anchoring Phone GPS..."}
                </h2>

                <p style={{ margin: "0 0 20px", fontSize: "0.86rem", color: "#94a3b8", lineHeight: 1.5 }}>
                    {status === "SUCCESS"
                        ? "Your phone's high-precision satellite location is now locked. The laptop projector screen updated in real-time."
                        : status === "ERROR"
                            ? errorMessage
                            : "Reading precise satellite GPS coordinates from your mobile phone..."}
                </p>

                {/* Session Card Info */}
                {sessionData && (
                    <div style={{
                        background: "rgba(15, 23, 42, 0.7)",
                        border: "1px solid rgba(148, 163, 184, 0.2)",
                        borderRadius: "14px",
                        padding: "14px",
                        marginBottom: "20px",
                        textAlign: "left",
                        fontSize: "0.82rem"
                    }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                            <span style={{ color: "#94a3b8" }}>Course:</span>
                            <strong style={{ color: "#ffffff" }}>{sessionData.courseCode || sessionData.classCode}</strong>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                            <span style={{ color: "#94a3b8" }}>Room:</span>
                            <strong style={{ color: "#ffffff" }}>{sessionData.roomNo || "Room"}</strong>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                            <span style={{ color: "#94a3b8" }}>Lecturer:</span>
                            <strong style={{ color: "#ffffff" }}>{sessionData.lecturerName || user?.email || "Faculty"}</strong>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span style={{ color: "#94a3b8" }}>Geofence:</span>
                            <strong style={{ color: "#10b981" }}>{sessionData.geofenceRadius || 10}m Radius</strong>
                        </div>
                    </div>
                )}

                {/* Success GPS Telemetry */}
                {status === "SUCCESS" && coords && (
                    <div style={{
                        background: "rgba(16, 185, 129, 0.12)",
                        border: "1px solid rgba(16, 185, 129, 0.35)",
                        borderRadius: "12px",
                        padding: "12px",
                        marginBottom: "20px",
                        fontSize: "0.82rem",
                        color: "#6ee7b7"
                    }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", fontWeight: 800, marginBottom: "4px" }}>
                            <FaMapMarkerAlt /> Accuracy: ±{accuracy} metres
                        </div>
                        <div style={{ fontSize: "0.76rem", opacity: 0.85 }}>
                            Coordinates: {coords.latitude?.toFixed(5)}, {coords.longitude?.toFixed(5)}
                        </div>
                    </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "100%" }}>
                    {status === "SUCCESS" ? (
                        <>
                            <button
                                type="button"
                                onClick={() => navigate(`/lecturer/lecturerpage?session=${encodeURIComponent(sessionId)}`)}
                                style={{
                                    width: "100%",
                                    padding: "12px",
                                    borderRadius: "12px",
                                    background: "linear-gradient(135deg, #10b981, #059669)",
                                    color: "#ffffff",
                                    border: "none",
                                    fontWeight: 750,
                                    fontSize: "0.92rem",
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: "8px",
                                    boxShadow: "0 4px 14px rgba(16, 185, 129, 0.3)"
                                }}
                            >
                                <FaMobileAlt /> Go to Active Session Controls
                            </button>
                            <button
                                type="button"
                                onClick={handleAcquireAndAnchorGps}
                                style={{
                                    width: "100%",
                                    padding: "10px",
                                    borderRadius: "10px",
                                    background: "rgba(255, 255, 255, 0.08)",
                                    color: "#cbd5e1",
                                    border: "1px solid rgba(255, 255, 255, 0.15)",
                                    fontWeight: 700,
                                    fontSize: "0.84rem",
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: "6px"
                                }}
                            >
                                <FaRedo /> Re-Calibrate GPS Coordinates
                            </button>
                        </>
                    ) : status === "ERROR" ? (
                        <>
                            <button
                                type="button"
                                onClick={handleAcquireAndAnchorGps}
                                style={{
                                    width: "100%",
                                    padding: "12px",
                                    borderRadius: "12px",
                                    background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                                    color: "#ffffff",
                                    border: "none",
                                    fontWeight: 750,
                                    fontSize: "0.92rem",
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: "8px"
                                }}
                            >
                                <FaRedo /> Re-Try GPS Acquisition
                            </button>
                            <Link
                                to="/lecturer"
                                style={{
                                    padding: "10px",
                                    color: "#94a3b8",
                                    fontSize: "0.82rem",
                                    textDecoration: "none",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: "6px"
                                }}
                            >
                                <FaArrowLeft /> Back to Lecturer Dashboard
                            </Link>
                        </>
                    ) : (
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", color: "#818cf8", fontSize: "0.9rem", fontWeight: 700 }}>
                            <FaSpinner className="fa-spin" /> Fetching GPS Fix...
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

