import "./Dashboard.css";
import { useEffect, useState } from "react";
import { SiGoogleclassroom } from "react-icons/si";
import { IoQrCodeOutline } from "react-icons/io5";
import { IoAddCircleOutline } from "react-icons/io5";
import { GoPeople } from "react-icons/go";
import { LuClipboardList } from "react-icons/lu";
import { SlCalender } from "react-icons/sl";
import { Link } from "react-router-dom";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";

function Dashboard() {
    const { user } = useAuth();
    const [recentSessions, setRecentSessions] = useState([]);
    const [counts, setCounts] = useState({
        sessions: 0,
        activeSessions: 0,
        students: 0,
        attendanceToday: 0
    });

    useEffect(() => {
        const getDashboardCounts = async () => {
            try {
                const [sessionsSnapshot, recordsSnapshot] = await Promise.all([
                    getDocs(query(collection(db, "attendance_sessions"), where("ownerId", "==", user.uid))),
                    getDocs(query(collection(db, "attendance_records"), where("ownerId", "==", user.uid)))
                ]);
                const sessions = sessionsSnapshot.docs
                    .map((sessionDoc) => ({
                        id: sessionDoc.id,
                        ...sessionDoc.data()
                    }))
                    .sort((firstSession, secondSession) => secondSession.createdAt - firstSession.createdAt);
                setRecentSessions(sessions.slice(0, 3));
                const now = Date.now();
                const startOfToday = new Date();
                startOfToday.setHours(0, 0, 0, 0);
                const studentRollNumbers = new Set();
                let attendanceToday = 0;

                recordsSnapshot.docs.forEach((recordDoc) => {
                    const record = recordDoc.data();
                    if (record.rollNo) {
                        studentRollNumbers.add(record.rollNo);
                    }
                    if (record.submittedAt >= startOfToday.getTime()) {
                        attendanceToday += 1;
                    }
                });

                setCounts({
                    sessions: sessionsSnapshot.size,
                    activeSessions: sessionsSnapshot.docs.filter((sessionDoc) => {
                        const session = sessionDoc.data();
                        return session.active !== false && session.expiresAt > now;
                    }).length,
                    students: studentRollNumbers.size,
                    attendanceToday
                });
            } catch (error) {
                console.error("Error getting dashboard counts:", error);
            }
        };

        getDashboardCounts();
    }, [user]);

    const dashcards = [
        { icon: <IoAddCircleOutline />, name: "Take Attendance", value: "Start", path: "/lecturer/lecturerpage", description: "New class session" },
        { icon: <SiGoogleclassroom />, name: "Classes", value: counts.sessions, path: "/lecturer/attendance-sessions" },
        { icon: <IoQrCodeOutline />, name: "Active Sessions", value: counts.activeSessions, path: "/lecturer/active-sessions" },
        { icon: <GoPeople />, name: "Total Students", value: counts.students, path: "/lecturer/students" },
        { icon: <LuClipboardList />, name: "Attendance Today", value: counts.attendanceToday, path: "/lecturer/attendance-data" },
    ];
    return (
        <div className="dashboard-page">
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
    )
}
export default Dashboard;