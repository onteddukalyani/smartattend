import React, { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import {
    collection,
    doc,
    getDoc,
    getDocs,
    onSnapshot,
    query,
    where
} from "firebase/firestore";
import {
    FaUserGraduate,
    FaIdCard,
    FaCalendarCheck,
    FaChalkboardTeacher,
    FaHistory,
    FaSearch,
    FaFileDownload,
    FaCheckCircle,
    FaBookOpen,
    FaClock,
    FaSyncAlt,
    FaEdit,
    FaCheck
} from "react-icons/fa";
import { MdQrCodeScanner } from "react-icons/md";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import "./Dashboard.css";

export default function StudentDashboard() {
    const { user, profile } = useAuth();
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [search, setSearch] = useState("");
    const [customRoll, setCustomRoll] = useState(() => {
        return localStorage.getItem("smartattend_student_roll") || "";
    });
    const [isEditingRoll, setIsEditingRoll] = useState(false);
    const [editRollInput, setEditRollInput] = useState("");

    // Identify primary student roll number
    const activeRollNo = (
        customRoll ||
        profile?.rollNo ||
        user?.email?.split("@")[0] ||
        ""
    ).trim().toUpperCase();

    const [fetchedStudentData, setFetchedStudentData] = useState(null);

    // Resolve student profile name directly if not loaded
    useEffect(() => {
        if (!activeRollNo) return;
        getDoc(doc(db, "users", activeRollNo))
            .then((snap) => {
                if (snap.exists()) {
                    setFetchedStudentData(snap.data());
                }
            })
            .catch(() => {});
    }, [activeRollNo]);

    const studentName = profile?.name || fetchedStudentData?.name || user?.displayName || "Student";
    const studentBranch = profile?.branch || fetchedStudentData?.branch || "General";
    const studentSemester = profile?.semester || fetchedStudentData?.semester || "1";

    // Build list of candidate roll numbers to guarantee matching
    const candidateRolls = useMemo(() => {
        const set = new Set();
        if (activeRollNo) {
            set.add(activeRollNo);
            set.add(activeRollNo.toLowerCase());
            const digits = activeRollNo.replace(/\D/g, "");
            if (digits && digits.length >= 2) set.add(digits);
        }
        if (profile?.rollNo) {
            const r = String(profile.rollNo).trim();
            set.add(r);
            set.add(r.toUpperCase());
            set.add(r.toLowerCase());
            const digits = r.replace(/\D/g, "");
            if (digits && digits.length >= 2) set.add(digits);
        }
        if (user?.email) {
            const prefix = user.email.split("@")[0].trim();
            set.add(prefix);
            set.add(prefix.toUpperCase());
            set.add(prefix.toLowerCase());
            const digits = prefix.replace(/\D/g, "");
            if (digits && digits.length >= 2) set.add(digits);
        }
        return Array.from(set).filter(Boolean).slice(0, 10);
    }, [activeRollNo, profile?.rollNo, user?.email]);

    // Real-time Firestore attendance listener
    useEffect(() => {
        if (!candidateRolls || candidateRolls.length === 0) {
            setLoading(false);
            return;
        }

        setLoading(true);

        // Preload sessions map in background for legacy records missing courseCode
        const sessionsMap = new Map();
        getDocs(collection(db, "attendance_sessions"))
            .then((snap) => {
                snap.docs.forEach((d) => sessionsMap.set(d.id, d.data()));
            })
            .catch((err) => {
                console.warn("Could not preload sessions map:", err.message);
            });

        // 1. Listen for records matching candidate roll numbers
        const recordsQ = query(
            collection(db, "attendance_records"),
            where("rollNo", "in", candidateRolls)
        );

        const unsubscribeRoll = onSnapshot(
            recordsQ,
            (snapshot) => {
                const fetchedRecords = snapshot.docs.map((docSnap) => {
                    const data = docSnap.data();
                    const sessionInfo = sessionsMap.get(data.sessionId) || {};
                    return {
                        id: docSnap.id,
                        ...data,
                        courseCode: data.courseCode || sessionInfo.courseCode || "N/A",
                        classCode: data.classCode || sessionInfo.classCode || "N/A",
                        roomNo: data.roomNo || sessionInfo.roomNo || "N/A"
                    };
                });

                // Sort descending: most recent attended class first
                fetchedRecords.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
                setRecords(fetchedRecords);
                setLoading(false);
                setRefreshing(false);
            },
            (err) => {
                console.error("Error listening to student attendance records:", err);
                setLoading(false);
                setRefreshing(false);
            }
        );

        return () => unsubscribeRoll();
    }, [candidateRolls]);

    const handleManualRefresh = async () => {
        setRefreshing(true);
        try {
            const recordsQ = query(
                collection(db, "attendance_records"),
                where("rollNo", "in", candidateRolls)
            );
            const [recordsSnap, sessionsSnap] = await Promise.all([
                getDocs(recordsQ),
                getDocs(collection(db, "attendance_sessions")).catch(() => ({ docs: [] }))
            ]);

            const sessionsMap = new Map();
            sessionsSnap.docs.forEach((d) => sessionsMap.set(d.id, d.data()));

            const fetchedRecords = recordsSnap.docs.map((docSnap) => {
                const data = docSnap.data();
                const sessionInfo = sessionsMap.get(data.sessionId) || {};
                return {
                    id: docSnap.id,
                    ...data,
                    courseCode: data.courseCode || sessionInfo.courseCode || "N/A",
                    classCode: data.classCode || sessionInfo.classCode || "N/A",
                    roomNo: data.roomNo || sessionInfo.roomNo || "N/A"
                };
            });

            fetchedRecords.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
            setRecords(fetchedRecords);
        } catch (err) {
            console.error("Manual refresh error:", err);
        } finally {
            setRefreshing(false);
        }
    };

    const handleSaveRollNumber = () => {
        const clean = editRollInput.trim().toUpperCase();
        if (clean) {
            localStorage.setItem("smartattend_student_roll", clean);
            setCustomRoll(clean);
        }
        setIsEditingRoll(false);
    };

    // Derived statistics
    const totalAttended = records.length;
    const uniqueCourses = new Set(records.map((r) => r.courseCode).filter((c) => c && c !== "N/A")).size;
    const lastAttended = records.length > 0 && records[0].submittedAt
        ? new Date(records[0].submittedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
        : "No classes yet";

    // Search filter
    const filteredRecords = records.filter((r) => {
        const term = search.toLowerCase().trim();
        if (!term) return true;
        return (
            (r.courseCode || "").toLowerCase().includes(term) ||
            (r.classCode || "").toLowerCase().includes(term) ||
            (r.roomNo || "").toLowerCase().includes(term) ||
            (r.rollNo || "").toLowerCase().includes(term)
        );
    });

    // Universal interactive sorting
    const { sortedItems: sortedRecords, sortConfig, requestSort } = useTableSort(filteredRecords, "submittedAt", "desc");

    const handleExport = () => {
        downloadExcel(
            "student-attended-table",
            `${activeRollNo || "Student"}_My_Attendance_${new Date().toISOString().slice(0, 10)}`
        );
    };

    return (
        <div className="student-dashboard">
            {/* 1. Student Hero Profile Banner */}
            <div className="student-hero-banner">
                <div className="student-hero-main">
                    <div className="student-hero-avatar">
                        {studentName.charAt(0).toUpperCase()}
                    </div>
                    <div className="student-hero-info">
                        <h1>Welcome, {studentName} 👋</h1>
                        <div className="student-hero-badges">
                            {isEditingRoll ? (
                                <span className="roll-edit-inline">
                                    <input
                                        type="text"
                                        value={editRollInput}
                                        onChange={(e) => setEditRollInput(e.target.value)}
                                        placeholder="Enter Roll No"
                                        autoFocus
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") handleSaveRollNumber();
                                            if (e.key === "Escape") setIsEditingRoll(false);
                                        }}
                                    />
                                    <button type="button" onClick={handleSaveRollNumber}>
                                        <FaCheck /> Save
                                    </button>
                                </span>
                            ) : (
                                <span
                                    className="student-roll-badge"
                                    onClick={() => {
                                        setEditRollInput(activeRollNo);
                                        setIsEditingRoll(true);
                                    }}
                                    title="Click to change active roll number"
                                >
                                    <FaIdCard /> {activeRollNo || "Set Roll Number"} <FaEdit style={{ marginLeft: "4px", fontSize: "0.75rem", opacity: 0.8 }} />
                                </span>
                            )}
                            <span className="student-sub-badge">
                                {studentBranch} • Semester {studentSemester}
                            </span>
                            <span className="student-sub-badge">
                                {user?.email || "Student Account"}
                            </span>
                        </div>
                    </div>
                </div>

                <div className="student-hero-action">
                    <Link to="/student/mark-attendance" className="scan-qr-cta">
                        <MdQrCodeScanner size={20} />
                        <span>Scan Class QR Code</span>
                    </Link>
                </div>
            </div>

            {/* 2. Attendance Summary Statistics */}
            <div className="student-stats-grid">
                <div className="student-stat-card">
                    <div className="student-stat-icon blue">
                        <FaCalendarCheck />
                    </div>
                    <div className="student-stat-content">
                        <span>Total Classes Attended</span>
                        <strong>{loading ? "..." : totalAttended}</strong>
                    </div>
                </div>

                <div className="student-stat-card green">
                    <div className="student-stat-icon green">
                        <FaBookOpen />
                    </div>
                    <div className="student-stat-content">
                        <span>Distinct Subjects</span>
                        <strong>{loading ? "..." : uniqueCourses}</strong>
                    </div>
                </div>

                <div className="student-stat-card purple">
                    <div className="student-stat-icon purple">
                        <FaClock />
                    </div>
                    <div className="student-stat-content">
                        <span>Last Attended Class</span>
                        <strong style={{ fontSize: "1.1rem" }}>{loading ? "..." : lastAttended}</strong>
                    </div>
                </div>
            </div>

            {/* 3. Attended Classes Log */}
            <div className="student-records-card">
                <div className="records-header-row">
                    <div>
                        <h2>Classes You Have Attended ({records.length})</h2>
                        <p>Real-time attendance register for Roll No: <strong>{activeRollNo}</strong></p>
                    </div>

                    <div className="records-controls">
                        <button
                            type="button"
                            className="dashboard-refresh-btn"
                            onClick={handleManualRefresh}
                            disabled={refreshing}
                            title="Check for newly registered attendance"
                        >
                            <FaSyncAlt className={refreshing ? "fa-spin" : ""} />
                            <span>{refreshing ? "Updating..." : "Refresh"}</span>
                        </button>

                        {records.length > 0 && (
                            <div className="records-search">
                                <FaSearch />
                                <input
                                    type="text"
                                    placeholder="Search subject, class or room..."
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                />
                            </div>
                        )}

                        {records.length > 0 && (
                            <button
                                type="button"
                                className="download-export-btn"
                                onClick={handleExport}
                                title="Download Excel report of your attendance"
                            >
                                <FaFileDownload /> Export Excel
                            </button>
                        )}
                    </div>
                </div>

                {loading ? (
                    <div className="student-empty-state">
                        <p>Loading your attendance records in real-time...</p>
                    </div>
                ) : filteredRecords.length === 0 ? (
                    <div className="student-empty-state">
                        <FaHistory />
                        <h3>{search ? "No matching classes found" : "No attendance recorded yet for this Roll Number"}</h3>
                        <p>
                            {search
                                ? "Try a different search term."
                                : `No records found under Roll Number "${activeRollNo}". If your roll number is different, click your roll number badge above to change it.`}
                        </p>
                        {!search && (
                            <Link to="/student/mark-attendance" className="scan-qr-cta" style={{ display: "inline-flex", margin: "0 auto" }}>
                                <MdQrCodeScanner size={18} /> Mark Attendance Now
                            </Link>
                        )}
                    </div>
                ) : (
                    <div className="student-table-wrap">
                        <table className="student-att-table" id="student-attended-table">
                            <thead>
                                <tr>
                                    <th className="sortable-th" onClick={() => requestSort("rollNo")} title="Click to sort by Roll Number">
                                        Roll Number <SortIcon sortConfig={sortConfig} columnKey="rollNo" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("fullName")} title="Click to sort by Student Name">
                                        Student Name <SortIcon sortConfig={sortConfig} columnKey="fullName" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("courseCode")} title="Click to sort by Course">
                                        Course / Subject <SortIcon sortConfig={sortConfig} columnKey="courseCode" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("classCode")} title="Click to sort by Class Code">
                                        Class Code <SortIcon sortConfig={sortConfig} columnKey="classCode" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("roomNo")} title="Click to sort by Room">
                                        Room <SortIcon sortConfig={sortConfig} columnKey="roomNo" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Date">
                                        Date <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Time">
                                        Time <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                                    </th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sortedRecords.map((item) => (
                                    <tr key={item.id}>
                                        <td><strong>{item.rollNo || activeRollNo}</strong></td>
                                        <td><strong>{item.fullName || studentName}</strong></td>
                                        <td><strong>{item.courseCode}</strong></td>
                                        <td>{item.classCode}</td>
                                        <td>Room {item.roomNo}</td>
                                        <td>
                                            {item.submittedAt
                                                ? new Date(item.submittedAt).toLocaleDateString(undefined, {
                                                    weekday: "short",
                                                    month: "short",
                                                    day: "numeric",
                                                    year: "numeric"
                                                })
                                                : "N/A"}
                                        </td>
                                        <td>
                                            {item.submittedAt
                                                ? new Date(item.submittedAt).toLocaleTimeString([], {
                                                    hour: "2-digit",
                                                    minute: "2-digit"
                                                })
                                                : "N/A"}
                                        </td>
                                        <td>
                                            <span className="present-tag">
                                                <FaCheckCircle /> Present
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}