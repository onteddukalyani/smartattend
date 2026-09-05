import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, getDoc, getDocs, query, where, writeBatch } from "firebase/firestore";
import { useNavigate, useParams } from "react-router-dom";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import './AttendanceData.css';

function ClassesData() {
    const { user, profile } = useAuth();
    const [sessions, setSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();

    const { sortedItems: sortedSessions, sortConfig, requestSort } = useTableSort(sessions, "createdAt", "desc");

    const removeSession = async (event, session) => {
        event.stopPropagation();
        if (!window.confirm(`Remove the ${session.classCode || "selected"} session?`)) {
            return;
        }

        try {
            const recordsQuery = query(
                collection(db, "attendance_records"),
                where("sessionId", "==", session.id)
            );
            const recordsSnapshot = await getDocs(recordsQuery);
            const batch = writeBatch(db);

            recordsSnapshot.docs.forEach((recordDoc) => {
                batch.delete(recordDoc.ref);
            });
            batch.delete(doc(db, "attendance_sessions", session.id));
            await batch.commit();
            setSessions((currentSessions) => currentSessions.filter(({ id }) => id !== session.id));
        } catch (error) {
            console.error("Error removing session:", error);
            window.alert("Could not remove this session.");
        }
    };

    useEffect(() => {
        const getSessions = async () => {
            try {
                // Fetch all sessions and users to resolve lecturer names
                const [sessionsSnapshot, usersSnapshot, authUsersSnapshot] = await Promise.all([
                    getDocs(collection(db, "attendance_sessions")),
                    getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
                    getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] }))
                ]);

                const userMap = new Map();
                usersSnapshot.docs.forEach((d) => {
                    const u = d.data();
                    if (u.name) {
                        userMap.set(d.id, u.name);
                        if (u.email) userMap.set(u.email.toLowerCase().trim(), u.name);
                    }
                });
                authUsersSnapshot.docs.forEach((d) => {
                    const u = d.data();
                    if (u.name) {
                        userMap.set(d.id.toLowerCase().trim(), u.name);
                        if (u.email) userMap.set(u.email.toLowerCase().trim(), u.name);
                    }
                });

                const userUid = user?.uid;
                const userEmail = (user?.email || "").toLowerCase().trim();
                const isAdmin = 
                    profile?.role === "admin" || 
                    profile?.role === "administrator" || 
                    profile?.role === "superadmin" || 
                    localStorage.getItem("smartattend-user-role") === "admin" || 
                    window.location.pathname.startsWith("/admin");

                const allSessions = sessionsSnapshot.docs
                    .map((sessionDoc) => {
                        const data = sessionDoc.data();
                        const ownerEmail = (data.ownerEmail || data.lecturerEmail || "").toLowerCase().trim();
                        const ownerId = data.ownerId;
                        const resolvedLecturer = data.lecturerName || userMap.get(ownerId) || userMap.get(ownerEmail) || (ownerEmail ? ownerEmail.split("@")[0] : "Faculty");

                        return {
                            id: sessionDoc.id,
                            ...data,
                            lecturerName: resolvedLecturer
                        };
                    })
                    .filter((sess) => {
                        if (isAdmin) return true;
                        const ownerEmail = (sess.ownerEmail || sess.lecturerEmail || "").toLowerCase().trim();
                        const ownerId = sess.ownerId;
                        if (userUid && ownerId === userUid) return true;
                        if (userEmail && (ownerEmail === userEmail || ownerId === userEmail)) return true;
                        return false;
                    });

                setSessions(allSessions);
            } catch (error) {
                console.error("Error getting sessions:", error);
            } finally {
                setLoading(false);
            }
        };

        getSessions();
    }, [user, profile]);

    if (loading) {
        return <p>Loading sessions...</p>;
    }

    return (
        <div className="attendance-data-page">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
                <h2>Attendance Sessions</h2>
                {sessions.length > 0 && (
                    <button
                        className="download-excel-btn"
                        onClick={() => downloadExcel("classes-sessions-table", `Sessions-List-${new Date().toISOString().slice(0, 10)}`)}
                    >
                        📥 Download Excel
                    </button>
                )}
            </div>
            {sessions.length === 0 ? <p>No attendance sessions yet.</p> : (
                <div className="attendance-table-scroll">
                    <table id="classes-sessions-table">
                        <thead>
                            <tr>
                                <th className="sortable-th" onClick={() => requestSort("classCode")} title="Click to sort by Class Code">
                                    Class Code <SortIcon sortConfig={sortConfig} columnKey="classCode" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("batch")} title="Click to sort by Batch">
                                    Batch <SortIcon sortConfig={sortConfig} columnKey="batch" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("courseCode")} title="Click to sort by Course Code">
                                    Course Code <SortIcon sortConfig={sortConfig} columnKey="courseCode" />
                                </th>
                                {profile?.role === "admin" && (
                                    <th className="sortable-th" onClick={() => requestSort("lecturerName")} title="Click to sort by Lecturer">
                                        Lecturer <SortIcon sortConfig={sortConfig} columnKey="lecturerName" />
                                    </th>
                                )}
                                <th className="sortable-th" onClick={() => requestSort("roomNo")} title="Click to sort by Room No">
                                    Room No <SortIcon sortConfig={sortConfig} columnKey="roomNo" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("createdAt")} title="Click to sort by Date">
                                    Date <SortIcon sortConfig={sortConfig} columnKey="createdAt" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("createdAt")} title="Click to sort by Time">
                                    Time <SortIcon sortConfig={sortConfig} columnKey="createdAt" />
                                </th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedSessions.map((session) => {
                                const basePath = profile?.role === "admin" ? "/admin/classes" : "/lecturer/attendance-sessions";
                                return (
                                    <tr key={session.id} onClick={() => navigate(`${basePath}/${session.id}`)}>
                                        <td><strong>{session.classCode || "N/A"}</strong></td>
                                        <td>{session.batch || "—"}</td>
                                        <td>{session.courseCode || "N/A"}</td>
                                        {profile?.role === "admin" && <td>{session.lecturerName || "Faculty"}</td>}
                                        <td>{session.roomNo || "N/A"}</td>
                                        <td>{session.createdAt ? new Date(session.createdAt).toLocaleDateString() : "N/A"}</td>
                                        <td>{session.createdAt ? new Date(session.createdAt).toLocaleTimeString() : "N/A"}</td>
                                        <td>
                                            <button
                                                type="button"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    navigate(`${basePath}/${session.id}`);
                                                }}
                                            >
                                                View Attendance
                                            </button>
                                            <button
                                                type="button"
                                                className="remove-session-btn"
                                                onClick={(event) => removeSession(event, session)}
                                            >
                                                Remove
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

export function SessionAttendanceData() {
    const { sessionId } = useParams();
    const [session, setSession] = useState(null);
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();
    const { user, profile } = useAuth();
    const basePath = profile?.role === "admin" ? "/admin/classes" : "/lecturer/attendance-sessions";

    const { sortedItems: sortedRecords, sortConfig, requestSort } = useTableSort(records, "rollNo", "asc");

    const removeRecord = async (record) => {
        if (!window.confirm(`Remove attendance for ${record.fullName || "this student"}?`)) {
            return;
        }

        try {
            await deleteDoc(doc(db, "attendance_records", record.id));
            setRecords((currentRecords) => currentRecords.filter(({ id }) => id !== record.id));
        } catch (error) {
            console.error("Error removing attendance record:", error);
            window.alert("Could not remove attendance record.");
        }
    };

    useEffect(() => {
        const getAttendance = async () => {
            try {
                const sessionSnapshot = await getDoc(doc(db, "attendance_sessions", sessionId));
                if (!sessionSnapshot.exists()) {
                    return;
                }

                const sessData = sessionSnapshot.data();

                // If lecturer name missing, attempt lookup from users
                let lecturerDisplay = sessData.lecturerName;
                if (!lecturerDisplay) {
                    const ownerEmail = sessData.ownerEmail || sessData.lecturerEmail;
                    if (ownerEmail) {
                        const userSnap = await getDoc(doc(db, "authorizedUsers", ownerEmail.toLowerCase())).catch(() => ({ exists: () => false }));
                        if (userSnap.exists() && userSnap.data().name) {
                            lecturerDisplay = userSnap.data().name;
                        } else {
                            lecturerDisplay = ownerEmail.split("@")[0];
                        }
                    } else {
                        lecturerDisplay = "Faculty";
                    }
                }

                setSession({ id: sessionSnapshot.id, ...sessData, lecturerName: lecturerDisplay });

                const recordsQuery = query(
                    collection(db, "attendance_records"),
                    where("sessionId", "==", sessionId)
                );
                const recordsSnapshot = await getDocs(recordsQuery);
                const rawRecords = recordsSnapshot.docs.map((recordDoc) => ({
                    id: recordDoc.id,
                    ...recordDoc.data()
                }));

                rawRecords.sort((a, b) => {
                    const rollA = a.rollNo || "";
                    const rollB = b.rollNo || "";
                    return rollA.localeCompare(rollB, undefined, { numeric: true, sensitivity: 'base' });
                });

                setRecords(rawRecords);
            } catch (error) {
                console.error("Error getting attendance:", error);
            } finally {
                setLoading(false);
            }
        };

        getAttendance();
    }, [sessionId, user]);

    if (loading) {
        return <p>Loading attendance...</p>;
    }

    if (!session) {
        return (
            <div className="attendance-data-page">
                <button className="back-to-sessions-btn" onClick={() => navigate(basePath)}>⬅️ Back to Sessions</button>
                <p>Session not found.</p>
            </div>
        );
    }

    return (
        <div className="attendance-data-page">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
                <button className="back-to-sessions-btn" onClick={() => navigate(basePath)}>⬅️ Back to Sessions</button>
                {records.length > 0 && (
                    <button
                        className="download-excel-btn"
                        onClick={() => downloadExcel("session-attendance-table", `Attendance-${session.classCode || "Class"}-${new Date().toISOString().slice(0, 10)}`)}
                    >
                        📥 Download Excel
                    </button>
                )}
            </div>
            <h2>Attendance - {session.classCode}</h2>
            <div style={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "12px",
                padding: "12px 18px",
                marginBottom: "20px",
                display: "flex",
                flexWrap: "wrap",
                gap: "16px",
                fontSize: "0.9rem",
                color: "#475569"
            }}>
                <span><strong>Lecturer:</strong> {session.lecturerName || "Faculty"}</span>
                {session.batch && <span><strong>Batch:</strong> {session.batch}</span>}
                <span><strong>Course Code:</strong> {session.courseCode || "N/A"}</span>
                <span><strong>Room:</strong> {session.roomNo || "N/A"}</span>
                <span><strong>Total Students Present:</strong> <strong style={{ color: "#10b981" }}>{records.length}</strong></span>
            </div>
            {records.length === 0 ? <p>No students submitted attendance for this session.</p> : (
                <div className="attendance-table-scroll">
                    <table id="session-attendance-table">
                        <thead>
                            <tr>
                                <th className="sortable-th" onClick={() => requestSort("rollNo")} title="Click to sort by Roll Number">
                                    Roll Number <SortIcon sortConfig={sortConfig} columnKey="rollNo" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("fullName")} title="Click to sort by Name">
                                    Name <SortIcon sortConfig={sortConfig} columnKey="fullName" />
                                </th>
                                <th>Class Code</th>
                                <th>Room No</th>
                                <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Date">
                                    Date <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Time">
                                    Time <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                                </th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedRecords.map((record) => (
                                <tr key={record.id}>
                                    <td><strong>{record.rollNo}</strong></td>
                                    <td>{record.fullName}</td>
                                    <td>{session.classCode}</td>
                                    <td>{session.roomNo || "N/A"}</td>
                                    <td>{record.submittedAt ? new Date(record.submittedAt).toLocaleDateString() : "N/A"}</td>
                                    <td>{record.submittedAt ? new Date(record.submittedAt).toLocaleTimeString() : "N/A"}</td>
                                    <td>
                                        <button
                                            type="button"
                                            className="remove-session-btn"
                                            style={{ margin: 0, padding: "6px 12px", fontSize: "0.82rem" }}
                                            onClick={() => removeRecord(record)}
                                        >
                                            Remove
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

export default ClassesData;
