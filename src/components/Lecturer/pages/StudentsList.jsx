import { useEffect, useState, useMemo, useCallback } from "react";
import { collection, getDocs, doc, deleteDoc, onSnapshot } from "firebase/firestore";
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

import { mergeAllStudentRecords, normalizeDescriptor, deleteStudentRecordCompletely } from "../../../utils/studentDataHelper";

function StudentsList() {
    const { user, profile } = useAuth();
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

    const isAdmin = profile?.role === "admin" || profile?.role === "administrator" || profile?.role === "superadmin" || window.location.pathname.startsWith("/admin");
    const basePath = isAdmin ? "/admin" : "/lecturer";

    const getStudents = useCallback(async () => {
        try {
            setLoading(true);
            const [authSnap, studentsSnap, usersSnap] = await Promise.all([
                getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] })),
                getDocs(collection(db, "students")).catch(() => ({ docs: [] })),
                getDocs(collection(db, "users")).catch(() => ({ docs: [] }))
            ]);

            const merged = mergeAllStudentRecords(authSnap.docs, studentsSnap.docs, usersSnap.docs);
            setStudents(merged);
        } catch (err) {
            console.error("Error fetching students:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        let authDocs = [];
        let studentsDocs = [];
        let usersDocs = [];

        const recomputeStudents = () => {
            const merged = mergeAllStudentRecords(authDocs, studentsDocs, usersDocs);
            setStudents(merged);
            setLoading(false);
        };

        const unsubAuth = onSnapshot(collection(db, "authorizedUsers"), (snap) => {
            authDocs = snap.docs;
            recomputeStudents();
        }, (err) => console.warn("authorizedUsers snapshot error:", err));

        const unsubStudents = onSnapshot(collection(db, "students"), (snap) => {
            studentsDocs = snap.docs;
            recomputeStudents();
        }, (err) => console.warn("students snapshot error:", err));

        const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
            usersDocs = snap.docs;
            recomputeStudents();
        }, (err) => console.warn("users snapshot error:", err));

        return () => {
            unsubAuth();
            unsubStudents();
            unsubUsers();
        };
    }, []);

    // Check if a student has biometric face enrolled (strictly requires 128-D vector)
    const checkHasFace = (student) => {
        if (!student) return false;
        if (student.faceRemovedAt) return false;
        const fd = student.faceDescriptor || student.descriptor;
        if (Array.isArray(fd) && fd.length === 128) return true;
        if (fd instanceof Float32Array && fd.length === 128) return true;
        return false;
    };


    // Remove Student (Lecturer & Admin permission)
    const handleRemoveStudent = async (student, e) => {
        if (e) e.stopPropagation();
        const studentName = student.name || student.rollNo || "this student";
        const confirmed = window.confirm(
            `⚠️ Delete Student Record?\n\nAre you sure you want to delete ${studentName} (${student.rollNo || student.id})? This will permanently remove their record from SmartAttend across the database.`
        );
        if (!confirmed) return;

        const roll = (student.rollNo || student.id || "").trim().toUpperCase();
        const previousState = [...students];

        // OPTIMISTIC UPDATE: Instant 0ms removal from UI
        setStudents((prev) => prev.filter((s) => s.id !== student.id && s.rollNo !== roll));

        try {
            setActionLoading(student.id || roll);
            await deleteStudentRecordCompletely(student);
            alert(`✅ Student ${studentName} (${roll}) has been deleted.`);
        } catch (err) {
            console.error("Error deleting student:", err);
            // Rollback on error
            setStudents(previousState);
            alert("Failed to delete student: " + err.message);
        } finally {
            setActionLoading(null);
        }
    };

    // Remove Facial Biometrics (Lecturer & Admin permission)
    const handleRemoveFaceBiometrics = async (student, e) => {
        if (e) e.stopPropagation();
        const studentName = student.name || "Student";
        const cleanRoll = String(student.rollNo || student.id || "").trim().toUpperCase();

        const confirmed = window.confirm(
            `⚠️ Clear Facial Biometrics & Photo?\n\nAre you sure you want to remove the registered facial biometric vector and photo for ${studentName} (${cleanRoll})?\n\nThis will allow the student or lecturer to re-enroll facial biometrics cleanly.`
        );
        if (!confirmed) return;

        const updated = {
            faceRegistered: false,
            biometricEnrolled: false,
            hasFaceRegistered: false,
            faceDescriptor: null,
            photoURL: "",
            image: "",
            photo: ""
        };

        // OPTIMISTIC UPDATE: Instant 0ms response in UI
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

        try {
            setActionLoading(student.id || student.rollNo);
            await removeStudentFaceAndBiometrics(student);
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
                    onClick={() => navigate(basePath)}
                    title={`Return to ${isAdmin ? "Admin" : "Lecturer"} Dashboard`}
                >
                    <FaArrowLeft /> Back to Dashboard
                </button>
                <div className="top-bar-badge">
                    <FaGraduationCap /> {isAdmin ? "Admin Portal • Student Directory" : "Lecturer Portal • Student Directory"}
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
                            onClick={() => navigate(`${basePath}/students/add?tab=bulk`)}
                            title="Bulk upload students via CSV/Excel"
                        >
                            <FaFileExcel /> Bulk Upload
                        </button>
                        <button
                            type="button"
                            className="hero-action-btn btn-add"
                            onClick={() => navigate(`${basePath}/students/add?tab=single`)}
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
                                onClick={() => navigate(`${basePath}/students/add?tab=single`)}
                            >
                                <FaUserPlus /> Add First Student
                            </button>
                            <button
                                className="empty-bulk-btn"
                                onClick={() => navigate(`${basePath}/students/add?tab=bulk`)}
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
