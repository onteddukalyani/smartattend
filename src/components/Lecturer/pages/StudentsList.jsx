import { useEffect, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { useNavigate } from "react-router-dom";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import { FaSearch, FaSyncAlt, FaUserPlus, FaCheckCircle, FaCamera, FaExclamationTriangle, FaFileExcel } from "react-icons/fa";
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
            const [usersSnap, studentsSnap, authUsersSnap] = await Promise.all([
                getDocs(collection(db, "users")).catch((err) => {
                    console.warn("Could not read users:", err);
                    return { docs: [] };
                }),
                getDocs(collection(db, "students")).catch((err) => {
                    console.warn("Could not read students:", err);
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

            const getCanonicalRoll = (d, id) => {
                if (d?.rollNo && String(d.rollNo).trim()) {
                    const r = String(d.rollNo).trim();
                    return (r.includes("@") ? r.split("@")[0] : r).toUpperCase();
                }
                if (d?.email && String(d.email).includes("@")) {
                    return String(d.email).split("@")[0].trim().toUpperCase();
                }
                if (id && String(id).includes("@")) {
                    return String(id).split("@")[0].trim().toUpperCase();
                }
                return String(id || "").trim().toUpperCase();
            };

            const studentMap = new Map();

            const mergeStudent = (docSnap) => {
                const d = docSnap.data();
                if (!isStudentDoc(d, docSnap.id)) return;
                const roll = getCanonicalRoll(d, docSnap.id);
                if (!roll) return;

                const existing = studentMap.get(roll) || {};
                const cleanEmail = (d.email || existing.email || (roll.toLowerCase() + "@iiitdwd.ac.in")).toLowerCase().trim();
                const branch = (d.branch && String(d.branch).toLowerCase() !== "general")
                    ? d.branch
                    : ((existing.branch && String(existing.branch).toLowerCase() !== "general") ? existing.branch : "CSE");

                studentMap.set(roll, {
                    ...existing,
                    ...d,
                    id: roll,
                    rollNo: roll,
                    email: cleanEmail,
                    name: d.name || existing.name || "Student",
                    branch: branch,
                    semester: d.semester || existing.semester || "1",
                    phone: d.phone || existing.phone || "",
                    status: d.status || existing.status || "active",
                    faceRegistered: d.faceRegistered ?? existing.faceRegistered ?? false,
                    biometricEnrolled: d.biometricEnrolled ?? existing.biometricEnrolled ?? false,
                    faceDescriptor: d.faceDescriptor || existing.faceDescriptor || null,
                    photoURL: d.photoURL || existing.photoURL || "",
                    role: "student"
                });
            };

            // 1. authorizedUsers
            authUsersSnap.docs.forEach(mergeStudent);

            // 2. students collection
            studentsSnap.docs.forEach(mergeStudent);

            // 3. users
            usersSnap.docs.forEach(mergeStudent);

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
                <div className="students-list-controls">
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
                        type="button"
                        onClick={() => navigate("/lecturer/students/add?tab=bulk")}
                        className="bulk-upload-btn"
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "9px 18px",
                            borderRadius: "10px",
                            background: "linear-gradient(135deg, #10b981, #059669)",
                            color: "#ffffff",
                            border: "none",
                            fontWeight: "700",
                            fontSize: "0.88rem",
                            cursor: "pointer",
                            boxShadow: "0 4px 12px rgba(16, 185, 129, 0.25)",
                            whiteSpace: "nowrap"
                        }}
                    >
                        <FaFileExcel /> Bulk Upload
                    </button>
                    <button
                        type="button"
                        onClick={() => navigate("/lecturer/students/add?tab=single")}
                        className="add-student-btn"
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "9px 18px",
                            borderRadius: "10px",
                            background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                            color: "#ffffff",
                            border: "none",
                            fontWeight: "700",
                            fontSize: "0.88rem",
                            cursor: "pointer",
                            boxShadow: "0 4px 12px rgba(99, 102, 241, 0.25)",
                            whiteSpace: "nowrap"
                        }}
                    >
                        <FaUserPlus /> Add Student
                    </button>
                    <button
                        onClick={getStudents}
                        disabled={loading}
                        className="students-refresh-btn"
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
                    <div className="students-actions-bar">
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
                                <th className="sortable-th" onClick={() => requestSort("faceRegistered")} title="Click to sort by Face Biometrics">
                                    Face Biometrics <SortIcon sortConfig={sortConfig} columnKey="faceRegistered" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("status")} title="Click to sort by Status">
                                    Status <SortIcon sortConfig={sortConfig} columnKey="status" />
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedStudents.map((student) => {
                                const hasFace = Boolean(
                                    student.faceRegistered ||
                                    (student.faceDescriptor && Array.isArray(student.faceDescriptor) && student.faceDescriptor.length === 128)
                                );
                                return (
                                    <tr
                                        key={student.id}
                                        onClick={() => setSelectedStudent(student)}
                                        style={{ cursor: "pointer" }}
                                        title="Click to view student profile, attendance history or register facial data"
                                    >
                                        <td><strong>{student.rollNo || "N/A"}</strong></td>
                                        <td>{student.name || "N/A"}</td>
                                        <td>{student.email || "N/A"}</td>
                                        <td>{(student.branch && String(student.branch).toLowerCase() !== "general") ? student.branch : "CSE"}</td>
                                        <td>{student.semester || "N/A"}</td>
                                        <td>
                                            {hasFace ? (
                                                <span style={{
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: "5px",
                                                    padding: "4px 10px",
                                                    borderRadius: "20px",
                                                    fontSize: "0.78rem",
                                                    fontWeight: 700,
                                                    background: "#dcfce7",
                                                    color: "#15803d",
                                                    border: "1px solid #bbf7d0"
                                                }}>
                                                    <FaCheckCircle /> Enrolled
                                                </span>
                                            ) : (
                                                <span style={{
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: "5px",
                                                    padding: "4px 10px",
                                                    borderRadius: "20px",
                                                    fontSize: "0.78rem",
                                                    fontWeight: 700,
                                                    background: "#fef3c7",
                                                    color: "#b45309",
                                                    border: "1px solid #fde68a"
                                                }}>
                                                    <FaCamera /> Pending (Click to Enroll)
                                                </span>
                                            )}
                                        </td>
                                        <td>
                                            <span className={`status-badge ${student.status === "active" ? "active" : "disabled"}`}>
                                                {student.status || "N/A"}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Student Details Modal */}
            {selectedStudent && (
                <StudentDetailModal
                    student={selectedStudent}
                    onClose={() => {
                        setSelectedStudent(null);
                        getStudents();
                    }}
                    onUpdate={(updated) => {
                        if (!updated) return;
                        setSelectedStudent(updated);
                        setStudents((prev) =>
                            prev.map((s) => (s.id === updated.id || s.rollNo === updated.rollNo ? { ...s, ...updated } : s))
                        );
                    }}
                />
            )}
        </div>
    );
}

export default StudentsList;
