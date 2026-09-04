import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, getDoc, getDocs, query, where, writeBatch } from "firebase/firestore";
import { useNavigate, useParams } from "react-router-dom";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import './AttendanceData.css';

function ClassesData() {
    const { user } = useAuth();
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
                where("sessionId", "==", session.id),
                where("ownerId", "==", user.uid)
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
                const snapshot = await getDocs(query(
                    collection(db, "attendance_sessions"),
                    where("ownerId", "==", user.uid)
                ));
                setSessions(snapshot.docs.map((sessionDoc) => ({
                    id: sessionDoc.id,
                    ...sessionDoc.data()
                })));
            } catch (error) {
                console.error("Error getting sessions:", error);
            } finally {
                setLoading(false);
            }
        };

        getSessions();
    }, [user]);

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
                                <th className="sortable-th" onClick={() => requestSort("courseCode")} title="Click to sort by Course Code">
                                    Course Code <SortIcon sortConfig={sortConfig} columnKey="courseCode" />
                                </th>
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
                            {sortedSessions.map((session) => (
                                <tr key={session.id} onClick={() => navigate(`/lecturer/attendance-sessions/${session.id}`)}>
                                    <td>{session.classCode || "N/A"}</td>
                                    <td>{session.courseCode || "N/A"}</td>
                                    <td>{session.roomNo || "N/A"}</td>
                                    <td>{session.createdAt ? new Date(session.createdAt).toLocaleDateString() : "N/A"}</td>
                                    <td>{session.createdAt ? new Date(session.createdAt).toLocaleTimeString() : "N/A"}</td>
                                    <td>
                                        <button type="button" onClick={() => navigate(`/lecturer/attendance-sessions/${session.id}`)}>
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
                            ))}
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
    const { user } = useAuth();

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

                setSession({ id: sessionSnapshot.id, ...sessionSnapshot.data() });
                const recordsQuery = query(
                    collection(db, "attendance_records"),
                    where("ownerId", "==", user.uid)
                );
                const recordsSnapshot = await getDocs(recordsQuery);
                const rawRecords = recordsSnapshot.docs.map((recordDoc) => ({
                    id: recordDoc.id,
                    ...recordDoc.data()
                })).filter((record) => record.sessionId === sessionId);

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
                <button className="back-to-sessions-btn" onClick={() => navigate("/lecturer/attendance-sessions")}>⬅️ Back to Sessions</button>
                <p>Session not found.</p>
            </div>
        );
    }

    return (
        <div className="attendance-data-page">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
                <button className="back-to-sessions-btn" onClick={() => navigate("/lecturer/attendance-sessions")}>⬅️ Back to Sessions</button>
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
