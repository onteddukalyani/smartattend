import { useEffect, useState, useMemo } from "react";
import { collection, getDocs, doc, deleteDoc } from "firebase/firestore";
import { useNavigate } from "react-router-dom";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import { removeStudentFaceAndBiometrics } from "../../../utils/biometricManager";
import {
    FaSearch,
    FaSyncAlt,
    FaUserPlus,
    FaCheckCircle,
    FaCamera,
    FaExclamationTriangle,
    FaFileExcel,
    FaArrowLeft,
    FaUserGraduate,
    FaIdBadge,
    FaShieldAlt,
    FaEye,
    FaTimes,
    FaFilter,
    FaThLarge,
    FaList,
    FaUserCheck,
    FaGraduationCap,
    FaTrashAlt,
    FaUserTimes,
    FaSpinner
} from "react-icons/fa";
import StudentDetailModal from "../../Common/StudentDetailModal";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import "./StudentsList.css";

function StudentsList() {
    const { user } = useAuth();
    const [students, setStudents] = useState([]);
    const [search, setSearch] = useState("");
    const [branchFilter, setBranchFilter] = useState("ALL");
    const [faceFilter, setFaceFilter] = useState("ALL");
    const [statusFilter, setStatusFilter] = useState("ALL");
    const [viewMode, setViewMode] = useState("table"); // 'table' | 'cards'
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(null);
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
                    branch: branch.toUpperCase(),
                    semester: d.semester || existing.semester || "1",
                    phone: d.phone || existing.phone || "",
                    status: d.status || existing.status || "active",
                    faceRegistered: Boolean(
                        d.faceRegistered ||
                        existing.faceRegistered ||
                        d.biometricEnrolled ||
                        existing.biometricEnrolled ||
                        d.isFaceEnrolled ||
                        existing.isFaceEnrolled ||
                        d.hasFaceRegistered ||
                        existing.hasFaceRegistered ||
                        (Array.isArray(d.faceDescriptor) && d.faceDescriptor.length > 0) ||
                        (Array.isArray(existing.faceDescriptor) && existing.faceDescriptor.length > 0) ||
                        (d.photoURL && String(d.photoURL).length > 0) ||
                        (existing.photoURL && String(existing.photoURL).length > 0)
                    ),
                    biometricEnrolled: Boolean(
                        d.biometricEnrolled ||
                        existing.biometricEnrolled ||
                        d.faceRegistered ||
                        existing.faceRegistered ||
                        (Array.isArray(d.faceDescriptor) && d.faceDescriptor.length > 0) ||
                        (Array.isArray(existing.faceDescriptor) && existing.faceDescriptor.length > 0)
                    ),
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

    // Check if a student has biometric face enrolled
    const checkHasFace = (student) => {
        return Boolean(
            student.faceRegistered ||
            student.biometricEnrolled ||
            (student.faceDescriptor && Array.isArray(student.faceDescriptor) && student.faceDescriptor.length === 128)
        );
    };

    // Remove Student (Lecturer & Admin permission)
    const handleRemoveStudent = async (student, e) => {
        if (e) e.stopPropagation();
        const studentName = student.name || student.rollNo || "this student";
        const confirmed = window.confirm(
            `⚠️ Delete Student Record?\n\nAre you sure you want to delete ${studentName} (${student.rollNo || student.id})? This will permanently remove their record from SmartAttend across the database.`
        );
        if (!confirmed) return;

        try {
            setActionLoading(student.id || student.rollNo);
            const roll = (student.rollNo || student.id || "").trim().toUpperCase();
            const email = student.email ? student.email.toLowerCase().trim() : null;
            const prefix = email ? email.split("@")[0].toLowerCase().trim() : null;

            const promises = [
                deleteDoc(doc(db, "users", roll)).catch(() => {}),
                deleteDoc(doc(db, "students", roll)).catch(() => {})
            ];

            if (student.id && student.id !== roll) {
                promises.push(deleteDoc(doc(db, "users", student.id)).catch(() => {}));
                promises.push(deleteDoc(doc(db, "students", student.id)).catch(() => {}));
            }

            if (email) {
                promises.push(deleteDoc(doc(db, "authorizedUsers", email)).catch(() => {}));
                promises.push(deleteDoc(doc(db, "students", email)).catch(() => {}));
            }

            if (prefix && prefix !== email && prefix !== roll.toLowerCase()) {
                promises.push(deleteDoc(doc(db, "authorizedUsers", prefix)).catch(() => {}));
                promises.push(deleteDoc(doc(db, "students", prefix)).catch(() => {}));
            }

            await Promise.all(promises);

            setStudents((prev) => prev.filter((s) => s.id !== student.id && s.rollNo !== roll));
            alert(`✅ Student ${studentName} (${roll}) has been deleted.`);
        } catch (err) {
            console.error("Error deleting student:", err);
            alert("Failed to delete student: " + err.message);
        } finally {
            setActionLoading(null);
        }
    };

    // Remove Facial Biometrics (Lecturer & Admin permission)
    const handleRemoveFaceBiometrics = async (student, e) => {
        if (e) e.stopPropagation();
        const studentName = student.name || "Student";
        const studentRoll = student.rollNo || student.id || "";

        const confirmed = window.confirm(
            `⚠️ Clear Facial Biometrics & Photo?\n\nAre you sure you want to remove the registered facial biometric vector and photo for ${studentName} (${studentRoll})?\n\nThis will allow the student or lecturer to re-enroll facial biometrics cleanly.`
        );
        if (!confirmed) return;

        try {
            setActionLoading(student.id || student.rollNo);
            const cleanRoll = String(student.rollNo || student.id || "").trim().toUpperCase();

            await removeStudentFaceAndBiometrics(student);

            const updated = {
                faceRegistered: false,
                biometricEnrolled: false,
                hasFaceRegistered: false,
                faceDescriptor: null,
                photoURL: "",
                image: "",
                photo: ""
            };

            setStudents((prev) =>
                prev.map((s) =>
                    s.id === student.id || (cleanRoll && s.rollNo === cleanRoll)
                        ? { ...s, ...updated }
                        : s
                )
            );

            if (selectedStudent && (selectedStudent.id === student.id || selectedStudent.rollNo === cleanRoll)) {
                setSelectedStudent((prev) => (prev ? { ...prev, ...updated } : null));
            }

            alert(`✅ Facial biometric data and photo for ${studentName} (${cleanRoll}) have been cleared.`);
        } catch (err) {
            console.error("Error removing face biometrics:", err);
            alert("Failed to remove face biometrics: " + err.message);
        } finally {
            setActionLoading(null);
        }
    };

    // Statistical Summary Metrics
    const stats = useMemo(() => {
        const total = students.length;
        const enrolled = students.filter(checkHasFace).length;
        const pending = total - enrolled;
        const active = students.filter((s) => (s.status || "active").toLowerCase() === "active").length;
        const enrolledPct = total > 0 ? Math.round((enrolled / total) * 100) : 0;

        return {
            total,
            enrolled,
            pending,
            active,
            enrolledPct
        };
    }, [students]);

    // Available branches for filter tabs
    const availableBranches = useMemo(() => {
        const branches = new Set(["CSE", "DSAI", "ECE"]);
        students.forEach((s) => {
            if (s.branch && s.branch !== "GENERAL") {
                branches.add(s.branch);
            }
        });
        return ["ALL", ...Array.from(branches).sort()];
    }, [students]);

    // Filter students
    const filteredStudents = useMemo(() => {
        return students.filter((student) => {
            const searchTerm = search.toLowerCase().trim();
            const matchesSearch =
                !searchTerm ||
                (student.rollNo || "").toLowerCase().includes(searchTerm) ||
                (student.name || "").toLowerCase().includes(searchTerm) ||
                (student.email || "").toLowerCase().includes(searchTerm) ||
                (student.branch || "").toLowerCase().includes(searchTerm) ||
                String(student.semester || "").toLowerCase().includes(searchTerm);

            const matchesBranch =
                branchFilter === "ALL" ||
                (student.branch && student.branch.toUpperCase() === branchFilter.toUpperCase());

            const hasFace = checkHasFace(student);
            const matchesFace =
                faceFilter === "ALL" ||
                (faceFilter === "ENROLLED" && hasFace) ||
                (faceFilter === "PENDING" && !hasFace);

            const matchesStatus =
                statusFilter === "ALL" ||
                (statusFilter === "ACTIVE" && (student.status || "active").toLowerCase() === "active") ||
                (statusFilter === "INACTIVE" && (student.status || "active").toLowerCase() !== "active");

            return matchesSearch && matchesBranch && matchesFace && matchesStatus;
        });
    }, [students, search, branchFilter, faceFilter, statusFilter]);

    const { sortedItems: sortedStudents, sortConfig, requestSort } = useTableSort(filteredStudents, "rollNo", "asc");

    const hasActiveFilters = search !== "" || branchFilter !== "ALL" || faceFilter !== "ALL" || statusFilter !== "ALL";

    const clearAllFilters = () => {
        setSearch("");
        setBranchFilter("ALL");
        setFaceFilter("ALL");
        setStatusFilter("ALL");
    };

    return (
        <div className="students-registry-page">
            {/* Top Navigation & Breadcrumb */}
            <div className="students-top-bar">
                <button
                    className="back-btn"
                    onClick={() => navigate("/lecturer")}
                    title="Return to Lecturer Dashboard"
                >
                    <FaArrowLeft /> Back to Dashboard
                </button>
                <div className="top-bar-badge">
                    <FaGraduationCap /> Student Management
                </div>
            </div>

            {/* Hero Header Banner */}
            <div className="students-hero-banner">
                <div className="hero-content">
                    <div className="hero-title-group">
                        <div className="hero-icon-box">
                            <FaUserGraduate />
                        </div>
                        <div>
                            <h1>Registered Students Directory</h1>
                            <p>Manage student profiles, verify biometric facial enrollments, and monitor academic records.</p>
                        </div>
                    </div>
                    <div className="hero-actions">
                        <button
                            type="button"
                            className="hero-action-btn btn-excel"
                            onClick={() => downloadExcel("students-registry-table", `Students_Directory_${new Date().toISOString().slice(0, 10)}`)}
                            title="Export student directory to Excel"
                        >
                            <FaFileExcel /> Export Excel
                        </button>
                        <button
                            type="button"
                            className="hero-action-btn btn-bulk"
                            onClick={() => navigate("/lecturer/students/add?tab=bulk")}
                            title="Bulk upload students via CSV/Excel"
                        >
                            <FaFileExcel /> Bulk Upload
                        </button>
                        <button
                            type="button"
                            className="hero-action-btn btn-add"
                            onClick={() => navigate("/lecturer/students/add?tab=single")}
                            title="Add a new student"
                        >
                            <FaUserPlus /> Add Student
                        </button>
                        <button
                            type="button"
                            className="hero-action-btn btn-refresh"
                            onClick={getStudents}
                            disabled={loading}
                            title="Refresh student records"
                        >
                            <FaSyncAlt className={loading ? "spin-icon" : ""} /> Refresh
                        </button>
                    </div>
                </div>
            </div>

            {/* Metrics Overview Stat Cards */}
            <div className="students-stats-grid">
                <div className="stat-card total-card">
                    <div className="stat-card-header">
                        <span className="stat-label">Total Students</span>
                        <div className="stat-icon-wrapper blue">
                            <FaUserGraduate />
                        </div>
                    </div>
                    <div className="stat-value">{stats.total}</div>
                    <div className="stat-meta">
                        <span className="stat-pill-info">{availableBranches.length - 1} Departments</span>
                    </div>
                </div>

                <div className="stat-card biometric-card">
                    <div className="stat-card-header">
                        <span className="stat-label">Face Biometrics Enrolled</span>
                        <div className="stat-icon-wrapper green">
                            <FaCheckCircle />
                        </div>
                    </div>
                    <div className="stat-value-group">
                        <span className="stat-value text-green">{stats.enrolled}</span>
                        <span className="stat-badge-pct">{stats.enrolledPct}% Enrolled</span>
                    </div>
                    <div className="stat-progress-bar">
                        <div
                            className="stat-progress-fill"
                            style={{ width: `${stats.enrolledPct}%` }}
                        />
                    </div>
                </div>

                <div className="stat-card pending-card">
                    <div className="stat-card-header">
                        <span className="stat-label">Biometrics Pending</span>
                        <div className="stat-icon-wrapper amber">
                            <FaCamera />
                        </div>
                    </div>
                    <div className="stat-value text-amber">{stats.pending}</div>
                    <div className="stat-meta">
                        <span className="stat-meta-text">Requires webcam capture</span>
                    </div>
                </div>

                <div className="stat-card active-card">
                    <div className="stat-card-header">
                        <span className="stat-label">Active Status</span>
                        <div className="stat-icon-wrapper purple">
                            <FaUserCheck />
                        </div>
                    </div>
                    <div className="stat-value text-purple">{stats.active}</div>
                    <div className="stat-meta">
                        <span className="stat-meta-text">Eligible for session attendance</span>
                    </div>
                </div>
            </div>

            {/* Search, Filter Toolbar & View Mode Switcher */}
            <div className="students-toolbar-card">
                <div className="toolbar-search-row">
                    <div className="search-box-container">
                        <FaSearch className="search-field-icon" />
                        <input
                            type="text"
                            placeholder="Search by roll number, name, branch, or email..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="search-input-field"
                        />
                        {search && (
                            <button
                                className="search-clear-btn"
                                onClick={() => setSearch("")}
                                title="Clear search"
                            >
                                <FaTimes />
                            </button>
                        )}
                    </div>

                    <div className="toolbar-right-controls">
                        <div className="view-mode-toggle">
                            <button
                                className={`view-toggle-btn ${viewMode === "table" ? "active" : ""}`}
                                onClick={() => setViewMode("table")}
                                title="Table View"
                            >
                                <FaList /> Table
                            </button>
                            <button
                                className={`view-toggle-btn ${viewMode === "cards" ? "active" : ""}`}
                                onClick={() => setViewMode("cards")}
                                title="Card Grid View"
                            >
                                <FaThLarge /> Cards
                            </button>
                        </div>
                    </div>
                </div>

                {/* Filter Pills Bar */}
                <div className="filter-chips-row">
                    <div className="filter-group">
                        <span className="filter-group-label"><FaFilter /> Branch:</span>
                        <div className="chips-list">
                            {availableBranches.map((br) => {
                                const count = br === "ALL"
                                    ? students.length
                                    : students.filter((s) => s.branch && s.branch.toUpperCase() === br.toUpperCase()).length;
                                return (
                                    <button
                                        key={br}
                                        className={`filter-chip ${branchFilter === br ? "active" : ""}`}
                                        onClick={() => setBranchFilter(br)}
                                    >
                                        {br} <span className="chip-count">({count})</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="filter-group">
                        <span className="filter-group-label">Biometrics:</span>
                        <div className="chips-list">
                            <button
                                className={`filter-chip ${faceFilter === "ALL" ? "active" : ""}`}
                                onClick={() => setFaceFilter("ALL")}
                            >
                                All
                            </button>
                            <button
                                className={`filter-chip chip-enrolled ${faceFilter === "ENROLLED" ? "active" : ""}`}
                                onClick={() => setFaceFilter("ENROLLED")}
                            >
                                <FaCheckCircle /> Enrolled ({stats.enrolled})
                            </button>
                            <button
                                className={`filter-chip chip-pending ${faceFilter === "PENDING" ? "active" : ""}`}
                                onClick={() => setFaceFilter("PENDING")}
                            >
                                <FaCamera /> Pending ({stats.pending})
                            </button>
                        </div>
                    </div>

                    {hasActiveFilters && (
                        <button
                            className="clear-filters-btn"
                            onClick={clearAllFilters}
                            title="Reset all search filters"
                        >
                            <FaTimes /> Reset Filters
                        </button>
                    )}
                </div>
            </div>

            {/* Results Count Bar */}
            <div className="students-results-info">
                <p>
                    Showing <strong>{sortedStudents.length}</strong> of <strong>{students.length}</strong> registered students
                    {hasActiveFilters && <span className="active-filter-indicator"> (Filtered)</span>}
                </p>
            </div>

            {/* Loading State */}
            {loading ? (
                <div className="students-loading-container">
                    <div className="loading-spinner-ring" />
                    <h3>Loading Student Records...</h3>
                    <p>Fetching authorized student profiles and biometric status from database.</p>
                </div>
            ) : sortedStudents.length === 0 ? (
                /* Empty Results State */
                <div className="students-empty-state">
                    <div className="empty-state-icon">
                        <FaUserGraduate />
                    </div>
                    <h3>No Matching Students Found</h3>
                    <p>
                        {hasActiveFilters
                            ? "No students match your current search query or filter selections. Try clearing your filters."
                            : "There are no registered students in the system yet. You can add them individually or use bulk upload."}
                    </p>
                    {hasActiveFilters ? (
                        <button className="empty-reset-btn" onClick={clearAllFilters}>
                            <FaTimes /> Clear All Filters
                        </button>
                    ) : (
                        <div className="empty-actions">
                            <button
                                className="empty-add-btn"
                                onClick={() => navigate("/lecturer/students/add?tab=single")}
                            >
                                <FaUserPlus /> Add First Student
                            </button>
                            <button
                                className="empty-bulk-btn"
                                onClick={() => navigate("/lecturer/students/add?tab=bulk")}
                            >
                                <FaFileExcel /> Bulk Upload CSV
                            </button>
                        </div>
                    )}
                </div>
            ) : viewMode === "table" ? (
                /* Modern Table View */
                <div className="students-table-card">
                    <div className="table-responsive-container">
                        <table id="students-registry-table" className="students-modern-table">
                            <thead>
                                <tr>
                                    <th className="sortable-th th-roll" onClick={() => requestSort("rollNo")}>
                                        <div className="th-content">
                                            <span>Roll Number</span>
                                            <SortIcon sortConfig={sortConfig} columnKey="rollNo" />
                                        </div>
                                    </th>
                                    <th className="sortable-th th-student" onClick={() => requestSort("name")}>
                                        <div className="th-content">
                                            <span>Student Details</span>
                                            <SortIcon sortConfig={sortConfig} columnKey="name" />
                                        </div>
                                    </th>
                                    <th className="sortable-th th-branch" onClick={() => requestSort("branch")}>
                                        <div className="th-content">
                                            <span>Branch / Dept</span>
                                            <SortIcon sortConfig={sortConfig} columnKey="branch" />
                                        </div>
                                    </th>
                                    <th className="sortable-th th-sem" onClick={() => requestSort("semester")}>
                                        <div className="th-content">
                                            <span>Semester</span>
                                            <SortIcon sortConfig={sortConfig} columnKey="semester" />
                                        </div>
                                    </th>
                                    <th className="sortable-th th-face" onClick={() => requestSort("faceRegistered")}>
                                        <div className="th-content">
                                            <span>Face Biometrics</span>
                                            <SortIcon sortConfig={sortConfig} columnKey="faceRegistered" />
                                        </div>
                                    </th>
                                    <th className="sortable-th th-status" onClick={() => requestSort("status")}>
                                        <div className="th-content">
                                            <span>Status</span>
                                            <SortIcon sortConfig={sortConfig} columnKey="status" />
                                        </div>
                                    </th>
                                    <th className="th-actions">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sortedStudents.map((student) => {
                                    const hasFace = checkHasFace(student);
                                    const branch = student.branch || "CSE";
                                    const isActive = (student.status || "active").toLowerCase() === "active";

                                    return (
                                        <tr
                                            key={student.id || student.rollNo}
                                            onClick={() => setSelectedStudent(student)}
                                            className="student-table-row"
                                            title="Click to view student profile, attendance logs, or register face biometrics"
                                        >
                                            <td className="td-roll">
                                                <span className="roll-badge">{student.rollNo || "N/A"}</span>
                                            </td>
                                            <td className="td-student">
                                                <div className="student-info-text">
                                                    <strong className="student-name">{student.name || "Student"}</strong>
                                                    <span className="student-email">{student.email || `${(student.rollNo || "").toLowerCase()}@iiitdwd.ac.in`}</span>
                                                </div>
                                            </td>
                                            <td className="td-branch">
                                                <span className={`branch-badge branch-${branch.toLowerCase()}`}>
                                                    {branch}
                                                </span>
                                            </td>
                                            <td className="td-sem">
                                                <span className="sem-pill">
                                                    Sem {student.semester || "1"}
                                                </span>
                                            </td>
                                            <td className="td-face">
                                                {hasFace ? (
                                                    <span className="face-badge enrolled" title="Face biometric vectors registered">
                                                        <FaCheckCircle /> Enrolled
                                                    </span>
                                                ) : (
                                                    <span className="face-badge pending" title="Biometrics pending. Click row to capture webcam face vector.">
                                                        <FaCamera /> Pending Enrollment
                                                    </span>
                                                )}
                                            </td>
                                            <td className="td-status">
                                                <span className={`account-status-badge ${isActive ? "active" : "inactive"}`}>
                                                    {isActive ? "Active" : "Inactive"}
                                                </span>
                                            </td>
                                            <td className="td-actions" onClick={(e) => e.stopPropagation()}>
                                                <div className="student-actions-cluster">
                                                    <button
                                                        type="button"
                                                        className="row-action-btn view-btn"
                                                        onClick={() => setSelectedStudent(student)}
                                                        title="View student profile & attendance logs"
                                                    >
                                                        <FaEye /> View
                                                    </button>

                                                    {hasFace && (
                                                        <button
                                                            type="button"
                                                            className="row-action-btn remove-face-btn"
                                                            onClick={(e) => handleRemoveFaceBiometrics(student, e)}
                                                            disabled={actionLoading === (student.id || student.rollNo)}
                                                            title="Clear student facial biometrics & photo"
                                                        >
                                                            {actionLoading === (student.id || student.rollNo) ? <FaSpinner className="fa-spin" /> : <FaUserTimes />}
                                                        </button>
                                                    )}

                                                    <button
                                                        type="button"
                                                        className="row-action-btn delete-student-btn"
                                                        onClick={(e) => handleRemoveStudent(student, e)}
                                                        disabled={actionLoading === (student.id || student.rollNo)}
                                                        title="Delete student record permanently from database"
                                                    >
                                                        {actionLoading === (student.id || student.rollNo) ? <FaSpinner className="fa-spin" /> : <FaTrashAlt />}
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : (
                /* Card Grid View */
                <div className="students-cards-grid">
                    {sortedStudents.map((student) => {
                        const hasFace = checkHasFace(student);
                        const branch = student.branch || "CSE";
                        const isActive = (student.status || "active").toLowerCase() === "active";

                        return (
                            <div
                                key={student.id || student.rollNo}
                                className="student-grid-card"
                                onClick={() => setSelectedStudent(student)}
                            >
                                <div className="card-top-header">
                                    <span className={`branch-badge branch-${branch.toLowerCase()}`}>
                                        {branch}
                                    </span>
                                    <span className={`account-status-badge ${isActive ? "active" : "inactive"}`}>
                                        {isActive ? "Active" : "Inactive"}
                                    </span>
                                </div>

                                <div className="card-student-body">
                                    <h3 className="card-student-name">{student.name || "Student"}</h3>
                                    <span className="card-roll-badge">{student.rollNo || "N/A"}</span>
                                    <span className="card-student-email">{student.email}</span>
                                </div>

                                <div className="card-student-details">
                                    <div className="card-detail-item">
                                        <span className="detail-label">Semester</span>
                                        <span className="detail-val">Semester {student.semester || "1"}</span>
                                    </div>
                                    <div className="card-detail-item">
                                        <span className="detail-label">Biometrics</span>
                                        {hasFace ? (
                                            <span className="face-badge enrolled mini">
                                                <FaCheckCircle /> Enrolled
                                            </span>
                                        ) : (
                                            <span className="face-badge pending mini">
                                                <FaCamera /> Pending
                                            </span>
                                        )}
                                    </div>
                                </div>

                                <div className="card-footer-action" onClick={(e) => e.stopPropagation()}>
                                    <button
                                        type="button"
                                        className="card-view-btn"
                                        onClick={() => setSelectedStudent(student)}
                                    >
                                        <FaEye /> View Profile
                                    </button>

                                    {hasFace && (
                                        <button
                                            type="button"
                                            className="card-icon-btn remove-face-btn"
                                            onClick={(e) => handleRemoveFaceBiometrics(student, e)}
                                            disabled={actionLoading === (student.id || student.rollNo)}
                                            title="Clear facial biometrics"
                                        >
                                            {actionLoading === (student.id || student.rollNo) ? <FaSpinner className="fa-spin" /> : <FaUserTimes />}
                                        </button>
                                    )}

                                    <button
                                        type="button"
                                        className="card-icon-btn delete-student-btn"
                                        onClick={(e) => handleRemoveStudent(student, e)}
                                        disabled={actionLoading === (student.id || student.rollNo)}
                                        title="Delete student"
                                    >
                                        {actionLoading === (student.id || student.rollNo) ? <FaSpinner className="fa-spin" /> : <FaTrashAlt />}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Student Details & Biometric Modal */}
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
