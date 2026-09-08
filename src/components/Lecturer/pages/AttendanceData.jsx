import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import './AttendanceData.css'
import { downloadExcel } from "../../../DownloadExcel";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import StudentDetailModal from "../../Common/StudentDetailModal";

function AttendanceData() {
    const { user, profile } = useAuth();
    const navigate = useNavigate();
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedStudentForModal, setSelectedStudentForModal] = useState(null);

    const isCurrentAdminPath = window.location.pathname.startsWith("/admin");
    const isCurrentLecturerPath = window.location.pathname.startsWith("/lecturer");

    const isAdmin = isCurrentAdminPath || (!isCurrentLecturerPath && (
        profile?.role === "admin" || 
        profile?.role === "administrator" || 
        profile?.role === "superadmin"
    ));

    const basePath = isCurrentAdminPath ? "/admin/classes" : "/lecturer/attendance-sessions";

    const { sortedItems: sortedRecords, sortConfig, requestSort } = useTableSort(records, "rollNo", "asc");

    useEffect(() => {
        const getAttendance = async () => {
            if (!user) return;
            try {
                const userEmail = (user?.email || "").toLowerCase().trim();
                const userPrefix = userEmail ? userEmail.split("@")[0] : "";
                const userUid = user?.uid || "";

                const [recordsSnapshot, sessionsSnapshot] = await Promise.all([
                    getDocs(collection(db, "attendance_records")),
                    getDocs(collection(db, "attendance_sessions"))
                ]);

                const isMyData = (data) => {
                    const ownerId = String(data.ownerId || "").toLowerCase().trim();
                    const ownerEmail = String(data.ownerEmail || data.lecturerEmail || "").toLowerCase().trim();
                    if (userUid && (ownerId === userUid.toLowerCase() || ownerEmail === userUid.toLowerCase())) return true;
                    if (userEmail && (ownerEmail === userEmail || ownerId === userEmail)) return true;
                    if (userPrefix && userPrefix.length >= 3 && (ownerId === userPrefix || ownerEmail === `${userPrefix}@iiitdwd.ac.in` || ownerEmail === `${userPrefix}@gmail.com`)) return true;
                    return false;
                };

                const mySessionsMap = new Map();
                sessionsSnapshot.docs.forEach((sessionDoc) => {
                    const data = sessionDoc.data();
                    if (isMyData(data)) {
                        mySessionsMap.set(sessionDoc.id, { id: sessionDoc.id, ...data });
                    }
                });

                const data = recordsSnapshot.docs
                    .filter((recordDoc) => {
                        const rec = recordDoc.data();
                        return isMyData(rec) || mySessionsMap.has(rec.sessionId);
                    })
                    .map((recordDoc) => ({
                        id: recordDoc.id,
                        ...recordDoc.data(),
                        session: mySessionsMap.get(recordDoc.data().sessionId) || { classCode: recordDoc.data().classCode, roomNo: recordDoc.data().roomNo }
                    })).sort((a, b) => {
                        const rollA = a.rollNo || "";
                        const rollB = b.rollNo || "";
                        return rollA.localeCompare(rollB, undefined, { numeric: true, sensitivity: 'base' });
                    });

                setRecords(data);

            } catch (error) {
                console.error("Error getting attendance:", error);
            } finally {
                setLoading(false);
            }
        };

        getAttendance();
    }, [user]);

    if (loading) {
        return <p>Loading attendance...</p>;
    }

    return (
        <div className="attendance-data-page">
            <h2>Attendance Records</h2>

            {records.length === 0 ? (
                <p>No attendance records yet.</p>
            ) : (
                <div className="attendance-table-scroll">
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "12px" }}>
                        <button
                            className="download-excel-btn"
                            onClick={() => downloadExcel("attendance-data", `Attendance-Records-${new Date().toISOString().slice(0, 10)}`)}
                        >
                            📥 Download Excel
                        </button>
                    </div>
                    <table id='attendance-data'>
                        <thead>
                            <tr>
                                <th className="sortable-th" onClick={() => requestSort("rollNo")} title="Click to sort by Roll Number">
                                    Roll Number <SortIcon sortConfig={sortConfig} columnKey="rollNo" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("fullName")} title="Click to sort by Name">
                                    Name <SortIcon sortConfig={sortConfig} columnKey="fullName" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("session.classCode")} title="Click to sort by Class Code">
                                    Class Code <SortIcon sortConfig={sortConfig} columnKey="session.classCode" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("session.roomNo")} title="Click to sort by Room No">
                                    Room No <SortIcon sortConfig={sortConfig} columnKey="session.roomNo" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Submitted At">
                                    Submitted At <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                                </th>
                                <th>Session</th>
                            </tr>
                        </thead>

                        <tbody>
                            {sortedRecords.map((record) => {
                                const targetSessionId = record.sessionId || record.session?.id || (record.id && record.id.includes("_") ? record.id.split("_")[0] : record.id);

                                return (
                                    <tr
                                        key={record.id}
                                        onClick={() => setSelectedStudentForModal({
                                            id: record.studentUid || record.rollNo,
                                            rollNo: record.rollNo,
                                            name: record.fullName || record.name || record.studentName || "Student",
                                            email: record.studentEmail || record.email || "",
                                            department: record.session?.department || record.classCode || "CSE"
                                        })}
                                        style={{ cursor: "pointer" }}
                                        title="Click to view student details & attendance history"
                                    >
                                        <td><strong>{record.rollNo}</strong></td>
                                        <td>{record.fullName || record.name || "Student"}</td>
                                        <td>{record.session?.classCode || record.classCode || "N/A"}</td>
                                        <td>{record.session?.roomNo || record.roomNo || "N/A"}</td>
                                        <td>
                                            {record.submittedAt ? new Date(record.submittedAt).toLocaleString() : "—"}
                                        </td>
                                        <td onClick={(e) => e.stopPropagation()}>
                                            {targetSessionId ? (
                                                <button
                                                    type="button"
                                                    onClick={() => navigate(`${basePath}/${targetSessionId}`)}
                                                    style={{
                                                        padding: "4px 10px",
                                                        fontSize: "0.8rem",
                                                        fontWeight: 700,
                                                        borderRadius: "6px",
                                                        background: "rgba(99, 102, 241, 0.1)",
                                                        color: "#4f46e5",
                                                        border: "1px solid rgba(99, 102, 241, 0.3)",
                                                        cursor: "pointer"
                                                    }}
                                                    title="View full session attendees"
                                                >
                                                    View Session →
                                                </button>
                                            ) : "—"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Student Detail Modal */}
            {selectedStudentForModal && (
                <StudentDetailModal
                    student={selectedStudentForModal}
                    onClose={() => setSelectedStudentForModal(null)}
                    onUpdate={() => {}}
                />
            )}
        </div>
    );
}

export default AttendanceData;