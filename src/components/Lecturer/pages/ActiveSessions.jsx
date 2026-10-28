import { useEffect, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { Link, useNavigate } from "react-router-dom";
import { collection, onSnapshot, doc, updateDoc } from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { FaQrcode, FaClock, FaCheckCircle, FaDoorOpen, FaUsers, FaMapMarkerAlt } from "react-icons/fa";
import './ActiveSessions.css';

function ActiveSessions() {
    const navigate = useNavigate();
    const { user, profile } = useAuth();
    const [activeSessions, setActiveSessions] = useState([]);
    const [recentSessions, setRecentSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [anchoringSessionId, setAnchoringSessionId] = useState(null);
    const [anchorFeedback, setAnchorFeedback] = useState({});

    const handleAnchorPhoneGps = (e, sessionId, currentRadius) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            alert("Geolocation is not supported on this device/browser.");
            return;
        }
        setAnchoringSessionId(sessionId);
        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                try {
                    const lat = pos.coords.latitude;
                    const lng = pos.coords.longitude;
                    const acc = Math.round(pos.coords.accuracy);
                    const radius = Number(currentRadius) > 0 ? Number(currentRadius) : 10;
                    const coords = {
                        latitude: lat,
                        longitude: lng,
                        lat: lat,
                        lng: lng,
                        accuracy: acc,
                        radius: radius,
                        timestamp: Date.now(),
                        source: "PHONE_ANCHOR",
                        anchoredBy: user?.email || "Lecturer Phone"
                    };
                    await updateDoc(doc(db, "attendance_sessions", sessionId), {
                        classroomLocation: coords,
                        geofenceRadius: radius,
                        updatedAt: Date.now()
                    });
                    setAnchorFeedback((prev) => ({
                        ...prev,
                        [sessionId]: { type: "success", message: `✅ Phone GPS Anchored (±${acc}m)! Projector screen updated in real-time.` }
                    }));
                } catch (err) {
                    setAnchorFeedback((prev) => ({
                        ...prev,
                        [sessionId]: { type: "error", message: `Failed to update: ${err.message}` }
                    }));
                } finally {
                    setAnchoringSessionId(null);
                }
            },
            (err) => {
                setAnchoringSessionId(null);
                setAnchorFeedback((prev) => ({
                    ...prev,
                    [sessionId]: { type: "error", message: `GPS error: ${err.message}. Please allow location access.` }
                }));
            },
            { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
        );
    };

    useEffect(() => {
        if (!user) {
            setLoading(false);
            return;
        }

        const userEmail = (user?.email || "").toLowerCase().trim();
        const userPrefix = userEmail ? userEmail.split("@")[0] : "";
        const userName = (profile?.name || user?.displayName || "").toLowerCase().trim();
        const userUid = user?.uid || "";
        const isAdmin = 
            profile?.role === "admin" || 
            profile?.role === "administrator" || 
            profile?.role === "superadmin" || 
            localStorage.getItem("smartattend-user-role") === "admin";

        const genericNames = new Set(["lecturer", "faculty", "admin", "faculty member", "user", "teacher", "unknown", "n/a", "student", "staff"]);
        const isNamedProperly = userName && !genericNames.has(userName) && userName.length >= 4;

        const isMySession = (data) => {
            if (isAdmin) return true;
            const ownerId = String(data.ownerId || "").toLowerCase().trim();
            const ownerEmail = String(data.ownerEmail || data.lecturerEmail || "").toLowerCase().trim();
            const sessLectName = String(data.lecturerName || "").toLowerCase().trim();

            if (userUid && (ownerId === userUid.toLowerCase() || ownerEmail === userUid.toLowerCase())) return true;
            if (userEmail && (ownerEmail === userEmail || ownerId === userEmail)) return true;
            if (userPrefix && userPrefix.length >= 3 && (ownerId === userPrefix || ownerEmail === `${userPrefix}@iiitdwd.ac.in` || ownerEmail === `${userPrefix}@gmail.com`)) return true;
            if (isNamedProperly && sessLectName && sessLectName === userName) return true;
            return false;
        };

        const unsub = onSnapshot(collection(db, "attendance_sessions"), (snapshot) => {
            try {
                const now = Date.now();
                const allMy = snapshot.docs
                    .map((sessionDoc) => ({ id: sessionDoc.id, ...sessionDoc.data() }))
                    .filter((session) => isMySession(session))
                    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

                const live = allMy.filter((s) => s.active !== false && (s.expiresAt || 0) > now);
                const recent = allMy.slice(0, 8);

                setActiveSessions(live);
                setRecentSessions(recent);
            } catch (error) {
                console.error("Error processing active sessions snapshot:", error);
            } finally {
                setLoading(false);
            }
        }, (err) => {
            console.error("Error subscribing to active sessions:", err);
            setLoading(false);
        });

        return () => unsub();
    }, [user, profile]);

    return (
        <main className="dashboard-page active-sessions-page">
            <div className="active-sessions-panel">
                <div className="active-sessions-heading">
                    <div>
                        <p className="dashboard-section-kicker">LIVE ATTENDANCE</p>
                        <h2>Active Session QR Codes</h2>
                    </div>
                    <Link to="/lecturer/lecturerpage" className="new-session-link">
                        + Generate New QR
                    </Link>
                </div>

                {activeSessions.length === 0 ? (
                    <div className="active-empty-box">
                        <FaQrcode className="active-empty-icon" />
                        <h3>No Active Live Sessions</h3>
                        <p>
                            Attendance QR codes remain live for the configured session duration. Start a new session to generate an active QR.
                        </p>
                        <Link to="/lecturer/lecturerpage" className="active-start-btn">
                            <FaQrcode /> Start New Session
                        </Link>
                    </div>
                ) : (
                    <div className="active-sessions-grid">
                        {activeSessions.map((session) => (
                            <Link to={`/lecturer/attendance-sessions/${session.id}`} className="active-session-card" key={session.id}>
                                <div className="active-session-qr-wrap">
                                    <QRCodeCanvas value={`${window.location.origin}/student/mark-attendance?session=${encodeURIComponent(session.id)}`} size={135} />
                                </div>
                                <div className="active-session-meta">
                                    <div className="active-session-tag-row">
                                        <span className="active-session-live-tag">● LIVE</span>
                                        {session.batch && <span className="active-session-batch-tag">Batch {session.batch}</span>}
                                    </div>
                                    <strong>{session.courseCode || session.classCode || "Class"}</strong>
                                    <span>Room {session.roomNo || "N/A"} · {session.classCode || "CSE"}</span>
                                    <small className="active-session-expiry">
                                        <FaClock /> Expires {session.expiresAt ? new Date(session.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Soon"}
                                    </small>

                                    {/* GPS Source / Status Badge */}
                                    <div style={{ marginTop: "6px", width: "100%", display: "flex", justifyContent: "center" }}>
                                        {session.classroomLocation?.source === "PHONE_ANCHOR" ? (
                                            <span style={{ fontSize: "0.74rem", fontWeight: 700, padding: "3px 8px", borderRadius: "6px", background: "rgba(16, 185, 129, 0.12)", color: "#059669", border: "1px solid rgba(16, 185, 129, 0.25)" }}>
                                                📱 Phone GPS Anchored (±{session.classroomLocation.accuracy}m)
                                            </span>
                                        ) : session.classroomLocation?.latitude ? (
                                            <span style={{ fontSize: "0.74rem", fontWeight: 700, padding: "3px 8px", borderRadius: "6px", background: "rgba(99, 102, 241, 0.1)", color: "#4f46e5", border: "1px solid rgba(99, 102, 241, 0.2)" }}>
                                                💻 Laptop Geofence (±{Math.round(session.classroomLocation.accuracy || 35)}m)
                                            </span>
                                        ) : (
                                            <span style={{ fontSize: "0.74rem", fontWeight: 700, padding: "3px 8px", borderRadius: "6px", background: "rgba(100, 116, 139, 0.1)", color: "#64748b" }}>
                                                🌐 Projector Mode (GPS Off)
                                            </span>
                                        )}
                                    </div>

                                    {/* 1-Tap Anchor Phone GPS Button */}
                                    <button
                                        type="button"
                                        onClick={(e) => handleAnchorPhoneGps(e, session.id, session.geofenceRadius)}
                                        disabled={anchoringSessionId === session.id}
                                        style={{
                                            marginTop: "8px",
                                            padding: "7px 12px",
                                            borderRadius: "8px",
                                            background: session.classroomLocation?.source === "PHONE_ANCHOR"
                                                ? "rgba(16, 185, 129, 0.15)"
                                                : "linear-gradient(135deg, #059669, #10b981)",
                                            color: session.classroomLocation?.source === "PHONE_ANCHOR" ? "#047857" : "#ffffff",
                                            border: session.classroomLocation?.source === "PHONE_ANCHOR" ? "1px solid rgba(16, 185, 129, 0.4)" : "none",
                                            fontSize: "0.78rem",
                                            fontWeight: 750,
                                            cursor: "pointer",
                                            display: "inline-flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            gap: "6px",
                                            width: "100%",
                                            boxShadow: session.classroomLocation?.source === "PHONE_ANCHOR" ? "none" : "0 2px 6px rgba(16, 185, 129, 0.3)"
                                        }}
                                        title="Use this phone's satellite GPS to anchor the laptop projector screen"
                                    >
                                        <FaMapMarkerAlt />
                                        {anchoringSessionId === session.id
                                            ? "Acquiring Phone GPS..."
                                            : session.classroomLocation?.source === "PHONE_ANCHOR"
                                                ? "🔄 Re-Anchor Phone GPS"
                                                : "📍 Anchor Phone GPS to Projector"}
                                    </button>

                                    {anchorFeedback[session.id] && (
                                        <p style={{
                                            margin: "4px 0 0 0",
                                            fontSize: "0.72rem",
                                            fontWeight: 700,
                                            textAlign: "center",
                                            color: anchorFeedback[session.id].type === "success" ? "#059669" : "#dc2626"
                                        }}>
                                            {anchorFeedback[session.id].message}
                                        </p>
                                    )}

                                    <div style={{ marginTop: "8px", display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center", width: "100%" }}>
                                        <span style={{
                                            fontSize: "0.78rem",
                                            fontWeight: 750,
                                            color: "#6366f1",
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "4px"
                                        }}>
                                            <FaUsers /> View Full Roster ({session.attendanceCount || 0} Submitted) →
                                        </span>
                                    </div>

                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            navigate(`/lecturer/lecturerpage?session=${session.id}`);
                                        }}
                                        style={{
                                            marginTop: "6px",
                                            padding: "6px 14px",
                                            borderRadius: "8px",
                                            background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                                            color: "#ffffff",
                                            border: "none",
                                            fontSize: "0.78rem",
                                            fontWeight: 750,
                                            cursor: "pointer",
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "6px",
                                            boxShadow: "0 2px 8px rgba(99, 102, 241, 0.25)"
                                        }}
                                        title="Open Live Projector & Kiosk Monitor Screen"
                                    >
                                        <FaQrcode /> 📺 Live Projector QR
                                    </button>
                                </div>
                            </Link>
                        ))}
                    </div>
                )}

                {/* Recent Sessions List for Quick Access */}
                {recentSessions.length > 0 && (
                    <div className="active-recent-section">
                        <div className="active-recent-header">
                            <h3>Recent Class Sessions</h3>
                            <Link to="/lecturer/attendance-sessions" className="active-view-all-link">
                                View All Classes →
                            </Link>
                        </div>

                        <div className="active-recent-grid">
                            {recentSessions.map((session) => {
                                const sDate = session.createdAt ? new Date(session.createdAt) : null;
                                return (
                                    <Link
                                        key={session.id}
                                        to={`/lecturer/attendance-sessions/${session.id}`}
                                        className="active-recent-card"
                                    >
                                        <div className="active-recent-top">
                                            <strong>
                                                {session.courseCode || session.classCode || "Class Session"}
                                            </strong>
                                            <span className="active-recent-badge">
                                                Batch {session.batch || "2025"}
                                            </span>
                                        </div>
                                        <div className="active-recent-details">
                                            <span><FaDoorOpen /> Room {session.roomNo || "N/A"}</span>
                                            <span>• {session.classCode || "General"}</span>
                                        </div>
                                        <div className="active-recent-time">
                                            {sDate ? sDate.toLocaleDateString() : "Date N/A"} {sDate ? sDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                                        </div>
                                    </Link>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </main>
    );
}

export default ActiveSessions;