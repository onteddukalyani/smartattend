import { useEffect, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import './AttendanceData.css'
import { downloadExcel } from "../../../DownloadExcel";

import { useTableSort, SortIcon } from "../../Common/useTableSort";

function AttendanceData() {
    const { user } = useAuth();
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);

    const { sortedItems: sortedRecords, sortConfig, requestSort } = useTableSort(records, "rollNo", "asc");

    useEffect(() => {
        const getAttendance = async () => {
            try {
                const [recordsSnapshot, sessionsSnapshot] = await Promise.all([
                    getDocs(query(collection(db, "attendance_records"), where("ownerId", "==", user.uid))),
                    getDocs(query(collection(db, "attendance_sessions"), where("ownerId", "==", user.uid)))
                ]);

                const sessions = new Map(
                    sessionsSnapshot.docs.map((sessionDoc) => [
                        sessionDoc.id,
                        sessionDoc.data()
                    ])
                );

                const data = recordsSnapshot.docs.map((recordDoc) => ({
                    id: recordDoc.id,
                    ...recordDoc.data(),
                    session: sessions.get(recordDoc.data().sessionId)
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
                            </tr>
                        </thead>

                        <tbody>
                            {sortedRecords.map((record) => (
                                <tr key={record.id}>
                                    <td><strong>{record.rollNo}</strong></td>
                                    <td>{record.fullName}</td>
                                    <td>{record.session?.classCode || "N/A"}</td>
                                    <td>{record.session?.roomNo || "N/A"}</td>
                                    <td>
                                        {new Date(
                                            record.submittedAt
                                        ).toLocaleString()}
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

export default AttendanceData;