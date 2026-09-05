import { useEffect, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { Link } from "react-router-dom";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import './ActiveSessions.css';

function ActiveSessions() {
    const { user } = useAuth();
    const [activeSessions, setActiveSessions] = useState([]);

    useEffect(() => {
        const getActiveSessions = async () => {
            if (!user) return;
            try {
                const userEmail = (user?.email || "").toLowerCase().trim();
                const userPrefix = userEmail ? userEmail.split("@")[0] : "";
                const userUid = user?.uid || "";

                const snapshot = await getDocs(collection(db, "attendance_sessions"));
                const now = Date.now();

                const isMySession = (data) => {
                    const ownerId = String(data.ownerId || "").toLowerCase().trim();
                    const ownerEmail = String(data.ownerEmail || data.lecturerEmail || "").toLowerCase().trim();
                    if (userUid && ownerId === userUid.toLowerCase()) return true;
                    if (userEmail && (ownerEmail === userEmail || ownerId === userEmail)) return true;
                    if (userPrefix && (ownerId === userPrefix || ownerEmail.includes(userPrefix))) return true;
                    return false;
                };

                setActiveSessions(snapshot.docs
                    .map((sessionDoc) => ({ id: sessionDoc.id, ...sessionDoc.data() }))
                    .filter((session) => isMySession(session) && session.active !== false && (session.expiresAt || 0) > now));
            } catch (error) {
                console.error("Error getting active sessions:", error);
            }
        };

        getActiveSessions();
    }, [user]);

    return (
        <main className="dashboard-page active-sessions-page">
            <div className="active-sessions-panel">
                <div className="active-sessions-heading">
                    <div>
                        <p className="dashboard-section-kicker">LIVE NOW</p>
                        <h2>Active session QR codes</h2>
                    </div>
                    <Link to="/lecturer/lecturerpage" className="new-session-link">New session</Link>
                </div>
                {activeSessions.length === 0 ? (
                    <p className="active-sessions-empty">No active sessions. Start a new session to create a student QR code.</p>
                ) : (
                    <div className="active-sessions-grid">
                        {activeSessions.map((session) => (
                            <Link to={`/attendance-sessions/${session.id}`} className="active-session-card" key={session.id}>
                                <QRCodeCanvas value={`${window.location.origin}/student-form?session=${session.id}`} size={150} />
                                <div>
                                    <strong>{session.classCode || "Class"}</strong>
                                    <span>Room {session.roomNo || "N/A"}</span>
                                    <small>Expires {new Date(session.expiresAt).toLocaleTimeString()}</small>
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
            </div>
        </main>
    );
}
export default ActiveSessions;