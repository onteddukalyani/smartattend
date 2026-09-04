import { useEffect, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { useNavigate } from "react-router-dom";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import { FaSearch, FaSyncAlt } from "react-icons/fa";
import StudentDetailModal from "../../Common/StudentDetailModal";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import "./StudentsList.css";

function StudentsList() {
    const { user } = useAuth();
    const [students, setStudents] = useState([]);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(true);
    const [selectedStudent, setSelectedStudent] = useState(null);
    const navigate = useNavigate();

    const getStudents = async () => {
        try {
            setLoading(true);
            const [usersSnap, authUsersSnap] = await Promise.all([
                getDocs(collection(db, "users")).catch((err) => {
                    console.warn("Could not read users:", err);
                    return { docs: [] };
                }),
                getDocs(collection(db, "authorizedUsers")).catch((err) => {
                    console.warn("Could not read authorizedUsers:", err);
                    return { docs: [] };
                })
            ]);

            const isStudentDoc = (d, id) => {
                const r = String(d.role || "").toLowerCase().trim();
                if (r === "student") return true;
                if (r === "lecturer" || r === "faculty" || r === "admin") return false;
                if (d.rollNo || d.semester || d.branch) return true;
                if (/^\d{2}[a-zA-Z]{3}\d{2,4}$/i.test(id)) return true;
                return false;
            };

            const studentMap = new Map();

            // 1. authorizedUsers
            authUsersSnap.docs.forEach((doc) => {
                const d = doc.data();
                if (isStudentDoc(d, doc.id)) {
                    const key = (d.email || d.rollNo || doc.id).toLowerCase().trim();
                    studentMap.set(key, { id: doc.id, ...d });
                }
            });

            // 2. users
            usersSnap.docs.forEach((doc) => {
                const d = doc.data();
                if (isStudentDoc(d, doc.id)) {
                    const key = (d.email || d.rollNo || doc.id).toLowerCase().trim();
                    const existing = studentMap.get(key) || {};
                    studentMap.set(key, { ...existing, ...d, id: doc.id });
                }
            });

            const rawStudents = Array.from(studentMap.values());
            rawStudents.sort((a, b) => {
                const rollA = a.rollNo || "";
                const rollB = b.rollNo || "";
                return rollA.localeCompare(rollB, undefined, { numeric: true, sensitivity: 'base' });
            });
            setStudents(rawStudents);
        } catch (error) {
            console.error("Error getting students:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        getStudents();
    }, [user]);

    const filteredStudents = students.filter((student) => {
        const searchTerm = search.toLowerCase();
        return (
            (student.rollNo || "").toLowerCase().includes(searchTerm) ||
            (student.name || "").toLowerCase().includes(searchTerm) ||
            (student.branch || "").toLowerCase().includes(searchTerm)
        );
    });

    const { sortedItems: sortedStudents, sortConfig, requestSort } = useTableSort(filteredStudents, "rollNo", "asc");

    if (loading) {
        return (
            <div className="attendance-data-page">
                <button className="back-to-sessions-btn" onClick={() => navigate("/lecturer")}>⬅️ Back to Dashboard</button>
                <h2>Registered Students</h2>
                <p>Loading students...</p>
            </div>
        );
    }

    return (
        <div className="attendance-data-page">
            <button className="back-to-dashboard-btn" onClick={() => navigate("/lecturer")}>⬅️ Back to Dashboard</button>

            <div className="students-list-header">
                <h2>Registered Students</h2>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <div className="students-search-wrapper">
                        <FaSearch className="search-icon" />
                        <input
                            type="text"
                            placeholder="Search by roll number, name, or branch..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="students-search-input"
                        />
                    </div>
                    <button
                        onClick={getStudents}
                        disabled={loading}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.5rem",
                            padding: "0.6rem 1rem",
                            borderRadius: "8px",
                            background: "#4f46e5",
                            color: "#ffffff",
                            border: "none",
                            fontWeight: "600",
                            cursor: loading ? "not-allowed" : "pointer",
                            fontSize: "0.9rem"
                        }}
                        title="Refresh student list"
                    >
                        <FaSyncAlt className={loading ? "fa-spin" : ""} /> Refresh
                    </button>
                </div>
            </div>

            {filteredStudents.length === 0 ? (
                <p className="no-students-message">No matching students found.</p>
            ) : (
                <div className="attendance-table-scroll">
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "12px" }}>
                        <button
                            className="download-excel-btn"
                            onClick={() => downloadExcel("student-table", `Students-List-${new Date().toISOString().slice(0, 10)}`)}
                        >
                            📥 Download Excel
                        </button>
                    </div>
                    <table id="student-table">
                        <thead>
                            <tr>
                                <th className="sortable-th" onClick={() => requestSort("rollNo")} title="Click to sort by Roll Number">
                                    Roll Number <SortIcon sortConfig={sortConfig} columnKey="rollNo" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("name")} title="Click to sort by Name">
                                    Name <SortIcon sortConfig={sortConfig} columnKey="name" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("email")} title="Click to sort by Email">
                                    Email <SortIcon sortConfig={sortConfig} columnKey="email" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("branch")} title="Click to sort by Branch">
                                    Branch <SortIcon sortConfig={sortConfig} columnKey="branch" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("semester")} title="Click to sort by Semester">
                                    Semester <SortIcon sortConfig={sortConfig} columnKey="semester" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("status")} title="Click to sort by Status">
                                    Status <SortIcon sortConfig={sortConfig} columnKey="status" />
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedStudents.map((student) => (
                                <tr
                                    key={student.id}
                                    onClick={() => setSelectedStudent(student)}
                                    style={{ cursor: "pointer" }}
                                    title="Click to view student profile & attendance history"
                                >
                                    <td><strong>{student.rollNo || "N/A"}</strong></td>
                                    <td>{student.name || "N/A"}</td>
                                    <td>{student.email || "N/A"}</td>
                                    <td>{student.branch || "N/A"}</td>
                                    <td>{student.semester || "N/A"}</td>
                                    <td>
                                        <span className={`status-badge ${student.status === "active" ? "active" : "disabled"}`}>
                                            {student.status || "N/A"}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Student Details Modal */}
            {selectedStudent && (
                <StudentDetailModal
                    student={selectedStudent}
                    onClose={() => setSelectedStudent(null)}
                />
            )}
        </div>
    );
}

export default StudentsList;
