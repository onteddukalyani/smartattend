import { useEffect, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { Link } from "react-router-dom";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { FaQrcode, FaClock, FaCheckCircle, FaDoorOpen, FaUsers } from "react-icons/fa";
import './ActiveSessions.css';

function ActiveSessions() {
    const { user, profile } = useAuth();
    const [activeSessions, setActiveSessions] = useState([]);
    const [recentSessions, setRecentSessions] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const getActiveSessions = async () => {
            if (!user) {
                setLoading(false);
                return;
            }
            try {
                const userEmail = (user?.email || "").toLowerCase().trim();
                const userPrefix = userEmail ? userEmail.split("@")[0] : "";
                const userName = (profile?.name || user?.displayName || "").toLowerCase().trim();
                const userUid = user?.uid || "";
                const isAdmin = 
                    profile?.role === "admin" || 
                    profile?.role === "administrator" || 
                    profile?.role === "superadmin" || 
                    localStorage.getItem("smartattend-user-role") === "admin";

                const snapshot = await getDocs(collection(db, "attendance_sessions"));
                const now = Date.now();

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

                const allMy = snapshot.docs
                    .map((sessionDoc) => ({ id: sessionDoc.id, ...sessionDoc.data() }))
                    .filter((session) => isMySession(session))
                    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

                const live = allMy.filter((s) => s.active !== false && (s.expiresAt || 0) > now);
                const recent = allMy.slice(0, 8);

                setActiveSessions(live);
                setRecentSessions(recent);
            } catch (error) {
                console.error("Error getting active sessions:", error);
            } finally {
                setLoading(false);
            }
        };

        getActiveSessions();
    }, [user, profile]);

    return (
        <main className="dashboard-page active-sessions-page">
            <div className="active-sessions-panel">
                <div className="active-sessions-heading">
                    <div>
                        <p className="dashboard-section-kicker">LIVE ATTENDANCE</p>
                        <h2>Active session QR codes</h2>
                    </div>
                    <Link to="/lecturer/lecturerpage" className="new-session-link">
                        + Generate New QR
                    </Link>
                </div>

                {activeSessions.length === 0 ? (
                    <div style={{
                        padding: "32px 20px",
                        background: "var(--surface-soft, #f8fafc)",
                        border: "1.5px dashed var(--border, #cbd5e1)",
                        borderRadius: "16px",
                        textAlign: "center",
                        margin: "16px 0 32px"
                    }}>
                        <FaQrcode style={{ fontSize: "2.5rem", color: "#6366f1", marginBottom: "12px", opacity: 0.8 }} />
                        <h3 style={{ margin: "0 0 6px", fontSize: "1.15rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                            No Live Active Sessions
                        </h3>
                        <p style={{ margin: "0 0 16px", fontSize: "0.88rem", color: "var(--text-muted, #64748b)" }}>
                            Attendance QR codes remain live for 2 minutes upon creation. Start a new session below to generate an active QR code.
                        </p>
                        <Link
                            to="/lecturer/lecturerpage"
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "8px",
                                padding: "10px 20px",
                                borderRadius: "10px",
                                background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                                color: "#ffffff",
                                textDecoration: "none",
                                fontWeight: 700,
                                fontSize: "0.9rem"
                            }}
                        >
                            <FaQrcode /> Start Class Session
                        </Link>
                    </div>
                ) : (
                    <div className="active-sessions-grid">
                        {activeSessions.map((session) => (
                            <Link to={`/lecturer/attendance-sessions/${session.id}`} className="active-session-card" key={session.id}>
                                <QRCodeCanvas value={`${window.location.origin}/student-form?session=${session.id}`} size={150} />
                                <div>
                                    <strong>{session.courseCode || session.classCode || "Class"}</strong>
                                    <span>Room {session.roomNo || "N/A"} · {session.classCode || "CSE"}</span>
                                    <small style={{ color: "#10b981", fontWeight: 700 }}>
                                        <FaClock /> Expires {new Date(session.expiresAt).toLocaleTimeString()}
                                    </small>
                                </div>
                            </Link>
                        ))}
                    </div>
                )}

                {/* Recent Sessions List for Quick Access */}
                {recentSessions.length > 0 && (
                    <div style={{ marginTop: "32px", textAlign: "left" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                            <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                                Recent Class Sessions
                            </h3>
                            <Link to="/lecturer/attendance-sessions" style={{ fontSize: "0.85rem", color: "#6366f1", fontWeight: 700, textDecoration: "none" }}>
                                View All Classes →
                            </Link>
                        </div>

                        <div style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                            gap: "14px"
                        }}>
                            {recentSessions.map((session) => {
                                const sDate = session.createdAt ? new Date(session.createdAt) : null;
                                return (
                                    <Link
                                        key={session.id}
                                        to={`/lecturer/attendance-sessions/${session.id}`}
                                        style={{
                                            display: "block",
                                            padding: "14px 16px",
                                            background: "var(--surface, #ffffff)",
                                            border: "1.5px solid var(--border, #e2e8f0)",
                                            borderRadius: "14px",
                                            textDecoration: "none",
                                            color: "inherit",
                                            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.04)",
                                            transition: "all 0.2s ease"
                                        }}
                                    >
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
                                            <strong style={{ fontSize: "0.95rem", color: "#6366f1" }}>
                                                {session.courseCode || session.classCode || "Class Session"}
                                            </strong>
                                            <span style={{ fontSize: "0.76rem", padding: "2px 8px", borderRadius: "6px", background: "rgba(99, 102, 241, 0.1)", color: "#6366f1", fontWeight: 700 }}>
                                                Batch {session.batch || "2025"}
                                            </span>
                                        </div>
                                        <div style={{ fontSize: "0.82rem", color: "var(--text-muted, #64748b)", display: "flex", gap: "10px", marginBottom: "6px" }}>
                                            <span><FaDoorOpen /> Room {session.roomNo || "N/A"}</span>
                                            <span>• {session.classCode || "General"}</span>
                                        </div>
                                        <div style={{ fontSize: "0.76rem", color: "var(--text-muted, #94a3b8)" }}>
                                            {sDate ? sDate.toLocaleString() : "Date N/A"}
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