import "./Dashboard.css";
import { useEffect, useState } from "react";
import { FaUser } from "react-icons/fa";
import { SiGoogleclassroom } from "react-icons/si";
import { IoQrCodeOutline } from "react-icons/io5";
import { IoAddCircleOutline } from "react-icons/io5";
import { GoPeople } from "react-icons/go";
import { LuClipboardList } from "react-icons/lu";
import { SlCalender } from "react-icons/sl";
import { FaChalkboardTeacher, FaUniversity, FaEnvelope } from "react-icons/fa";
import { Link } from "react-router-dom";
import { collection, getDocs, onSnapshot } from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";

function Dashboard() {
    const { user, profile } = useAuth();
    const [recentSessions, setRecentSessions] = useState([]);
    const [counts, setCounts] = useState({
        sessions: 0,
        activeSessions: 0,
        students: 0,
        attendanceToday: 0
    });

    const [imageFailed, setImageFailed] = useState(false);

    const lecturerName = profile?.name || user?.displayName || (user?.email ? user.email.split("@")[0] : "Faculty Member");
    const avatarSrc = profile?.photoURL || profile?.image || profile?.photo || user?.photoURL || user?.photoUrl;

    useEffect(() => {
        if (!user) return;

        const userEmail = (user?.email || "").toLowerCase().trim();
        const userPrefix = userEmail ? userEmail.split("@")[0] : "";
        const userUid = user?.uid || "";
        const isAdmin = profile?.role === "admin" || profile?.role === "administrator" || profile?.role === "superadmin";

        const isMySession = (data) => {
            if (isAdmin) return true;
            const ownerId = String(data.ownerId || "").toLowerCase().trim();
            const ownerEmail = String(data.ownerEmail || data.lecturerEmail || "").toLowerCase().trim();
            if (userUid && (ownerId === userUid.toLowerCase() || ownerEmail === userUid.toLowerCase())) return true;
            if (userEmail && (ownerEmail === userEmail || ownerId === userEmail)) return true;
            if (userPrefix && userPrefix.length >= 3 && (ownerId === userPrefix || ownerEmail === `${userPrefix}@iiitdwd.ac.in` || ownerEmail === `${userPrefix}@gmail.com`)) return true;
            return false;
        };

        let sessionsDocs = [];
        let recordsDocs = [];

        const recomputeLecturerDashboard = () => {
            try {
                const mySessions = sessionsDocs
                    .map((sessionDoc) => ({
                        id: sessionDoc.id,
                        ...(typeof sessionDoc.data === "function" ? sessionDoc.data() : sessionDoc)
                    }))
                    .filter((s) => isMySession(s))
                    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

                setRecentSessions(mySessions.slice(0, 3));
                const now = Date.now();
                const startOfToday = new Date();
                startOfToday.setHours(0, 0, 0, 0);
                const startOfTodayMs = startOfToday.getTime();

                const studentRollNumbers = new Set();
                let attendanceToday = 0;

                const mySessionIds = new Set(mySessions.map((s) => s.id));

                recordsDocs.forEach((recordDoc) => {
                    const record = typeof recordDoc.data === "function" ? recordDoc.data() : recordDoc;
                    if (isMySession(record) || mySessionIds.has(record.sessionId)) {
                        if (record.rollNo) {
                            studentRollNumbers.add(String(record.rollNo).toUpperCase().trim());
                        }
                        if ((record.submittedAt || 0) >= startOfTodayMs) {
                            attendanceToday += 1;
                        }
                    }
                });

                // Also count embedded session attendees
                mySessions.forEach((sess) => {
                    if (Array.isArray(sess.attendees)) {
                        sess.attendees.forEach((att) => {
                            const roll = att.rollNo || att.rollNumber || (typeof att === "string" ? att : null);
                            if (roll) {
                                studentRollNumbers.add(String(roll).toUpperCase().trim());
                            }
                            const t = att.submittedAt || att.timestamp || sess.createdAt || 0;
                            if (t >= startOfTodayMs) {
                                attendanceToday += 1;
                            }
                        });
                    }
                });

                setCounts({
                    sessions: mySessions.length,
                    activeSessions: mySessions.filter((s) => s.active !== false && (s.expiresAt || 0) > now).length,
                    students: studentRollNumbers.size,
                    attendanceToday
                });
            } catch (err) {
                console.error("Error computing lecturer dashboard counts:", err);
            }
        };

        const unsubSessions = onSnapshot(collection(db, "attendance_sessions"), (snap) => {
            sessionsDocs = snap.docs;
            recomputeLecturerDashboard();
        }, (e) => console.warn("sessions snapshot error:", e));

        const unsubRecords = onSnapshot(collection(db, "attendance_records"), (snap) => {
            recordsDocs = snap.docs;
            recomputeLecturerDashboard();
        }, (e) => console.warn("records snapshot error:", e));

        return () => {
            unsubSessions();
            unsubRecords();
        };
    }, [user, profile]);

    const dashcards = [
        { icon: <IoAddCircleOutline />, name: "Take Attendance", value: "Start", path: "/lecturer/lecturerpage", description: "New class session" },
        { icon: <SiGoogleclassroom />, name: "Classes", value: counts.sessions, path: "/lecturer/attendance-sessions" },
        { icon: <IoQrCodeOutline />, name: "Active Sessions", value: counts.activeSessions, path: "/lecturer/active-sessions" },
        { icon: <GoPeople />, name: "Total Students", value: counts.students, path: "/lecturer/students" },
        { icon: <LuClipboardList />, name: "Attendance Today", value: counts.attendanceToday, path: "/lecturer/attendance-data" },
    ];
    return (
        <div className="dashboard-page">
            {/* 1. Lecturer Profile Banner */}
            <div className="lecturer-hero-banner">
                <div className="lecturer-hero-main">
                    <div className="lecturer-hero-avatar">
                        {avatarSrc && !imageFailed ? (
                            <img
                                src={avatarSrc}
                                alt={lecturerName || "Lecturer"}
                                onError={() => setImageFailed(true)}
                                style={{ width: "100%", height: "100%", borderRadius: "16px", objectFit: "cover" }}
                            />
                        ) : (
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", fontSize: "2rem" }}>
                                <FaUser />
                            </div>
                        )}
                    </div>
                    <div className="lecturer-hero-info">
                        <div className="lecturer-hero-title-row">
                            <h1 className="lecturer-hero-title">Welcome, {lecturerName} 👋</h1>
                        </div>
                        <div className="lecturer-hero-badges">
                            <span className="lecturer-badge pill-faculty">
                                <FaChalkboardTeacher /> Faculty Member
                            </span>
                            <span className="lecturer-badge">
                                <FaUniversity /> {profile?.department || "Computer Science Department"}
                            </span>
                            <span className="lecturer-badge">
                                <FaEnvelope /> {user?.email || "Faculty Account"}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="dash-cards">
                {dashcards.map((item, index) => (
                    <div key={index}>
                        <Link to={item.path} className="dash-link dash-card">
                            <span className="dash-icons">{item.icon}</span>
                            <div className="card-details">
                                <p>{item.name}</p>
                                <p>{item.value}</p>
                                <p>{item.description || (item.name === "Attendance Today" ? "Submissions today" : "From Database")}</p>
                            </div>
                        </Link>
                    </div>
                ))}
            </div><br></br>
            <div className="dash-recent-activity">
                <h2>Recent Attendance Sessions</h2>
                {recentSessions.length === 0 ? (
                    <div className="recent-card">
                        <SlCalender className="icon" />
                        <p>No sessions yet</p>
                        <p>Start a new attendance session to see it here.</p>
                        <Link to="/lecturer/lecturerpage" className="recent-start-link">Start Attendance</Link>
                    </div>
                ) : (
                    <div className="recent-sessions-list">
                        {recentSessions.map((session) => {
                            const sessionDate = session.createdAt ? new Date(session.createdAt) : null;
                            return (
                                <Link to={`/lecturer/attendance-sessions/${session.id}`} className="recent-session" key={session.id}>
                                    <span className="recent-session-icon"><SlCalender /></span>
                                    <span className="recent-session-info">
                                        <strong>{session.classCode || "Class"}</strong>
                                        <span>Room {session.roomNo || "N/A"}</span>
                                    </span>
                                    <span className="recent-session-time">
                                        {sessionDate ? sessionDate.toLocaleDateString() : "N/A"}
                                        <small>{sessionDate ? sessionDate.toLocaleTimeString() : ""}</small>
                                    </span>
                                </Link>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
export default Dashboard;