import { useEffect, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { Link } from "react-router-dom";
import { collection, onSnapshot } from "firebase/firestore";
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
                                <QRCodeCanvas value={`${window.location.origin}/student/mark-attendance?session=${encodeURIComponent(session.id)}`} size={140} />
                                <div className="active-session-meta">
                                    <strong>{session.courseCode || session.classCode || "Class"}</strong>
                                    <span>Room {session.roomNo || "N/A"} · {session.classCode || "CSE"}</span>
                                    <small className="active-session-expiry">
                                        <FaClock /> Expires {session.expiresAt ? new Date(session.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Soon"}
                                    </small>
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