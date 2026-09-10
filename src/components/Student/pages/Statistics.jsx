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
    FaChartPie,
    FaExclamationTriangle,
    FaCheckCircle,
    FaTimesCircle,
    FaBookOpen,
    FaSyncAlt,
    FaFileDownload,
    FaSearch,
    FaClock,
    FaFilter,
    FaAward,
    FaCalendarAlt,
    FaCamera,
    FaUserCheck,
    FaGraduationCap,
    FaQrcode,
    FaShieldAlt,
    FaArrowRight
} from "react-icons/fa";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import { getCandidateRolls, computeStudentMetrics } from "../studentAttendanceHelper";
import { isGenericName } from "../../../utils/studentDataHelper";
import "./Statistics.css";

export default function Statistics() {
    const { user, profile } = useAuth();
    const [courses, setCourses] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [search, setSearch] = useState("");
    const [selectedCourseFilter, setSelectedCourseFilter] = useState("all");
    const [fetchedStudentData, setFetchedStudentData] = useState(null);

    // Roll number strictly derived from Gmail prefix or profile
    const emailRoll = (user?.email || "").split("@")[0].trim().toUpperCase();
    const activeRollNo = (profile?.rollNo || emailRoll || "").trim().toUpperCase();

    // Fetch student profile details from Firestore across all collections in real-time
    useEffect(() => {
        if (!activeRollNo) return;
        const cleanEmail = (user?.email || "").toLowerCase().trim();
        const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase().trim() : activeRollNo.toLowerCase().trim();

        const unsubs = [];

        const handleDocUpdate = (snap) => {
            if (snap.exists()) {
                const d = snap.data();
                setFetchedStudentData((prev) => {
                    let resolvedName = prev?.name;
                    if (isGenericName(resolvedName, activeRollNo, cleanEmail) && !isGenericName(d.name, activeRollNo, cleanEmail)) resolvedName = String(d.name).trim();
                    if (isGenericName(resolvedName, activeRollNo, cleanEmail) && !isGenericName(d.fullName, activeRollNo, cleanEmail)) resolvedName = String(d.fullName).trim();
                    if (isGenericName(resolvedName, activeRollNo, cleanEmail) && !isGenericName(d.displayName, activeRollNo, cleanEmail)) resolvedName = String(d.displayName).trim();
                    if (!resolvedName || isGenericName(resolvedName, activeRollNo, cleanEmail)) resolvedName = (!isGenericName(d.name, activeRollNo, cleanEmail) ? d.name : null) || (!isGenericName(d.fullName, activeRollNo, cleanEmail) ? d.fullName : null) || prev?.name || "";

                    const branch = (d.branch && String(d.branch).toLowerCase() !== "general")
                        ? d.branch
                        : (prev?.branch || d.department || "CSE");

                    const semester = (d.semester && String(d.semester).trim() && String(d.semester).trim() !== "1")
                        ? d.semester
                        : (prev?.semester || d.semester || "1");

                    const isExplicitlyRemoved = Boolean(
                        d.faceRemovedAt ||
                        d.faceRegistered === false ||
                        d.biometricEnrolled === false ||
                        d.hasFaceRegistered === false ||
                        !d.faceDescriptor ||
                        (Array.isArray(d.faceDescriptor) && d.faceDescriptor.length !== 128)
                    );

                    const hasFace = !isExplicitlyRemoved && Array.isArray(d.faceDescriptor) && d.faceDescriptor.length === 128;
                    const validDescriptor = hasFace ? d.faceDescriptor : null;
                    const photo = isExplicitlyRemoved ? "" : ((d.photoURL && d.photoURL.length > 5) ? d.photoURL : (prev?.photoURL || d.photo || d.image || ""));

                    return {
                        ...(prev || {}),
                        ...d,
                        name: resolvedName,
                        fullName: resolvedName,
                        branch: branch,
                        semester: semester,
                        photoURL: photo,
                        faceRegistered: hasFace,
                        biometricEnrolled: hasFace,
                        hasFaceRegistered: hasFace,
                        faceRemovedAt: isExplicitlyRemoved ? (d.faceRemovedAt || Date.now()) : null,
                        faceDescriptor: validDescriptor
                    };
                });
            }
        };

        // 1. Listen to students collection
        unsubs.push(onSnapshot(doc(db, "students", activeRollNo), handleDocUpdate, (err) => console.warn("student doc snapshot error:", err)));

        // 2. Listen to users collection
        unsubs.push(onSnapshot(doc(db, "users", activeRollNo), handleDocUpdate, (err) => console.warn("user doc snapshot error:", err)));

        // 3. Listen to authorizedUsers collection
        if (cleanEmail) {
            unsubs.push(onSnapshot(doc(db, "authorizedUsers", cleanEmail), handleDocUpdate, (err) => console.warn("authUser doc snapshot error:", err)));
        }

        return () => {
            unsubs.forEach((u) => u && u());
        };
    }, [activeRollNo, user?.email]);

    const studentName = fetchedStudentData?.name || profile?.name || activeRollNo || "Student";
    const rawBranch = profile?.branch || fetchedStudentData?.branch;
    const studentBranch = (rawBranch && String(rawBranch).toLowerCase() !== "general") ? rawBranch : "CSE";
    const studentSemester = profile?.semester || fetchedStudentData?.semester || "1";

    // Face biometric registration status detection
    const hasFaceRegistered = Boolean(
        fetchedStudentData
            ? (
                !fetchedStudentData.faceRemovedAt &&
                fetchedStudentData.faceRegistered !== false &&
                fetchedStudentData.biometricEnrolled !== false &&
                Array.isArray(fetchedStudentData.faceDescriptor) &&
                fetchedStudentData.faceDescriptor.length === 128
            )
            : (
                !profile?.faceRemovedAt &&
                profile?.faceRegistered !== false &&
                profile?.biometricEnrolled !== false &&
                Array.isArray(profile?.faceDescriptor) &&
                profile.faceDescriptor.length === 128
            )
    );

    // Build candidate roll numbers for matching
    const candidateRolls = useMemo(() => {
        return getCandidateRolls(user, profile, fetchedStudentData);
    }, [user, profile, fetchedStudentData]);

    // 1. Real-time Courses listener
    useEffect(() => {
        const unsubscribeCourses = onSnapshot(
            collection(db, "courses"),
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
                setCourses(list);
            },
            (err) => console.warn("Error loading courses:", err)
        );
        return () => unsubscribeCourses();
    }, []);

    // 2. Real-time Sessions listener
    useEffect(() => {
        const unsubscribeSessions = onSnapshot(
            collection(db, "attendance_sessions"),
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
                setSessions(list);
            },
            (err) => console.warn("Error loading sessions:", err)
        );
        return () => unsubscribeSessions();
    }, []);

    // 3. Real-time Attendance Records listener
    useEffect(() => {
        if (!candidateRolls || candidateRolls.length === 0) {
            setLoading(false);
            return;
        }

        setLoading(true);

        const recordsQ = query(
            collection(db, "attendance_records"),
            where("rollNo", "in", candidateRolls)
        );

        const unsubscribeRecords = onSnapshot(
            recordsQ,
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
                setRecords(list);
                setLoading(false);
                setRefreshing(false);
            },
            (err) => {
                console.error("Error loading statistics records:", err);
                setLoading(false);
                setRefreshing(false);
            }
        );

        return () => unsubscribeRecords();
    }, [candidateRolls]);

    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            const [coursesSnap, sessionsSnap, recordsSnap] = await Promise.all([
                getDocs(collection(db, "courses")).catch(() => ({ docs: [] })),
                getDocs(collection(db, "attendance_sessions")).catch(() => ({ docs: [] })),
                candidateRolls.length > 0
                    ? getDocs(query(collection(db, "attendance_records"), where("rollNo", "in", candidateRolls))).catch(() => ({ docs: [] }))
                    : { docs: [] }
            ]);

            setCourses(coursesSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
            setSessions(sessionsSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
            setRecords(recordsSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
        } catch (err) {
            console.error("Manual refresh error:", err);
        } finally {
            setRefreshing(false);
        }
    };

    // Unified metrics computation
    const metrics = useMemo(() => {
        return computeStudentMetrics(courses, sessions, records, {
            branch: studentBranch,
            semester: studentSemester
        });
    }, [courses, sessions, records, studentBranch, studentSemester]);

    // Filtered records for table
    const filteredRecords = useMemo(() => {
        return metrics.enrichedRecords.filter((r) => {
            const term = search.toLowerCase().trim();
            const courseMatch =
                selectedCourseFilter === "all" ||
                (r.courseCode || "").toUpperCase() === selectedCourseFilter.toUpperCase() ||
                (r.classCode || "").toUpperCase().includes(selectedCourseFilter.toUpperCase());

            if (!courseMatch) return false;

            if (!term) return true;
            return (
                (r.courseCode || "").toLowerCase().includes(term) ||
                (r.classCode || "").toLowerCase().includes(term) ||
                (r.roomNo || "").toLowerCase().includes(term) ||
                (r.rollNo || "").toLowerCase().includes(term) ||
                (r.lecturerName || "").toLowerCase().includes(term)
            );
        });
    }, [metrics.enrichedRecords, search, selectedCourseFilter]);

    // Sorting
    const { sortedItems: sortedRecords, sortConfig, requestSort } = useTableSort(filteredRecords, "submittedAt", "desc");

    const handleExport = () => {
        downloadExcel(
            "student-statistics-table",
            `${activeRollNo || "Student"}_Attendance_Statistics_${new Date().toISOString().slice(0, 10)}`
        );
    };

    return (
        <div className="student-statistics-page">
            {/* 1. Header Banner */}
            <div className="stats-header-banner">
                <div className="stats-header-info">
                    <div className="stats-brand-icon-wrap">
                        <FaGraduationCap className="stats-brand-icon" />
                    </div>
                    <div className="stats-title-wrap">
                        <h1>My Attendance &amp; Analytics</h1>
                        <p className="stats-subtitle">
                            Real-time attendance metrics, subject eligibility, and verified session logs for Roll No: <strong>{activeRollNo}</strong>.
                        </p>
                        <div className="stats-pill-group">
                            <span className="stats-pill roll-pill">
                                <FaIdCard /> {activeRollNo || "Student"}
                            </span>
                            <span className="stats-pill">
                                <FaUserGraduate /> {studentName}
                            </span>
                            <span className="stats-pill">
                                <FaBookOpen /> {studentBranch} • Sem {studentSemester}
                            </span>
                            {hasFaceRegistered ? (
                                <span className="stats-pill status-face-active" title="Facial biometric descriptor is active">
                                    <FaUserCheck /> Face Biometric Active
                                </span>
                            ) : (
                                <Link to="/student" className="stats-pill status-face-pending" title="Click to enroll face on Dashboard">
                                    <FaCamera /> Face Biometric Pending
                                </Link>
                            )}
                        </div>
                    </div>
                </div>

                <div className="stats-header-actions">
                    <button
                        className="stats-btn-refresh"
                        onClick={handleRefresh}
                        disabled={refreshing}
                        title="Refresh attendance records"
                    >
                        <FaSyncAlt className={refreshing ? "stats-spin" : ""} />
                        <span>{refreshing ? "Refreshing..." : "Refresh"}</span>
                    </button>
                    <button
                        className="stats-btn-export"
                        onClick={handleExport}
                        disabled={metrics.enrichedRecords.length === 0}
                        title="Export statistics to Excel"
                    >
                        <FaFileDownload />
                        <span>Export Excel</span>
                    </button>
                </div>
            </div>

            {/* 2. Top Metric Cards */}
            <div className="stats-kpi-grid">
                {/* Overall Attendance Percentage Meter */}
                <div className="stats-kpi-card stats-kpi-primary">
                    <div className="stats-kpi-header">
                        <span className="stats-kpi-label">Overall Attendance</span>
                        <FaChartPie className="stats-kpi-icon" />
                    </div>
                    <div className="stats-kpi-value-row">
                        <span className="stats-kpi-number">{metrics.overallPercentage}%</span>
                        <span
                            className={`stats-status-badge ${metrics.overallPercentage >= 75
                                ? "status-safe"
                                : metrics.overallPercentage >= 65
                                    ? "status-warning"
                                    : "status-danger"
                                }`}
                        >
                            {metrics.overallPercentage >= 75 ? (
                                <><FaCheckCircle /> On Track</>
                            ) : metrics.overallPercentage >= 65 ? (
                                <><FaExclamationTriangle /> Low Attendance</>
                            ) : (
                                <><FaTimesCircle /> Critical</>
                            )}
                        </span>
                    </div>
                    <div className="stats-kpi-meter-bar">
                        <div
                            className="stats-kpi-meter-fill"
                            style={{
                                width: `${Math.min(metrics.overallPercentage, 100)}%`,
                                backgroundColor:
                                    metrics.overallPercentage >= 75
                                        ? "#10b981"
                                        : metrics.overallPercentage >= 65
                                            ? "#f59e0b"
                                            : "#ef4444"
                            }}
                        />
                    </div>
                    <p className="stats-kpi-footer-text">
                        Minimum 75% required for university exam eligibility.
                    </p>
                </div>

                {/* Total Attended Classes */}
                <div className="stats-kpi-card">
                    <div className="stats-kpi-header">
                        <span className="stats-kpi-label">Classes Attended</span>
                        <FaCalendarCheck className="stats-kpi-icon text-green" />
                    </div>
                    <div className="stats-kpi-value-row">
                        <span className="stats-kpi-number text-green">{metrics.totalAttended}</span>
                        <span className="stats-kpi-unit">/ {metrics.totalConducted} conducted</span>
                    </div>
                    <p className="stats-kpi-footer-text">
                        Total verified sessions attended with QR &amp; Face verification.
                    </p>
                </div>

                {/* Classes Missed */}
                <div className="stats-kpi-card">
                    <div className="stats-kpi-header">
                        <span className="stats-kpi-label">Classes Missed</span>
                        <FaTimesCircle className="stats-kpi-icon text-red" />
                    </div>
                    <div className="stats-kpi-value-row">
                        <span className="stats-kpi-number text-red">{metrics.totalMissed}</span>
                        <span className="stats-kpi-unit">sessions</span>
                    </div>
                    <p className="stats-kpi-footer-text">
                        Recorded absences across all conducted course sessions.
                    </p>
                </div>

                {/* Target Requirement Calculator */}
                <div className="stats-kpi-card stats-kpi-target">
                    <div className="stats-kpi-header">
                        <span className="stats-kpi-label">75% Target Status</span>
                        <FaAward className="stats-kpi-icon text-indigo" />
                    </div>
                    <div className="stats-target-content">
                        {metrics.overallPercentage >= 75 ? (
                            <div>
                                <span className="stats-target-highlight text-green">
                                    {metrics.safeToMiss} {metrics.safeToMiss === 1 ? "class" : "classes"}
                                </span>
                                <p className="stats-target-desc">
                                    You can safely miss up to <strong>{metrics.safeToMiss}</strong> more {metrics.safeToMiss === 1 ? "class" : "classes"} while maintaining 75% attendance.
                                </p>
                            </div>
                        ) : (
                            <div>
                                <span className="stats-target-highlight text-amber">
                                    +{metrics.neededToReach75} {metrics.neededToReach75 === 1 ? "class" : "classes"}
                                </span>
                                <p className="stats-target-desc">
                                    Attend the next <strong>{metrics.neededToReach75}</strong> consecutive {metrics.neededToReach75 === 1 ? "class" : "classes"} without absence to reach 75%.
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Face Biometric Status Card */}
                <div className="stats-kpi-card stats-kpi-face">
                    <div className="stats-kpi-header">
                        <span className="stats-kpi-label">Face Biometric Status</span>
                        <FaShieldAlt className={`stats-kpi-icon ${hasFaceRegistered ? "text-green" : "text-amber"}`} />
                    </div>
                    <div className="stats-target-content">
                        {hasFaceRegistered ? (
                            <div>
                                <span className="stats-target-highlight text-green" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                    <FaUserCheck /> Enrolled &amp; Active
                                </span>
                                <p className="stats-target-desc">
                                    Your facial vector descriptor is registered and verified for fast attendance verification.
                                </p>
                            </div>
                        ) : (
                            <div>
                                <span className="stats-target-highlight text-amber" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                    <FaCamera /> Action Required
                                </span>
                                <p className="stats-target-desc">
                                    Register your face biometric to enable instant verification during live class sessions.
                                </p>
                                <Link to="/student" className="stats-face-action-link">
                                    Register Face Now <FaArrowRight />
                                </Link>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* 3. Subject-Wise Attendance Breakdown */}
            <div className="stats-section-card">
                <div className="stats-section-header">
                    <div>
                        <h2>Subject-Wise Attendance Breakdown</h2>
                        <p>Course-level attendance percentages and eligibility</p>
                    </div>
                    <span className="stats-count-badge">
                        {metrics.coursesWithStats.length} {metrics.coursesWithStats.length === 1 ? "Course" : "Courses"}
                    </span>
                </div>

                {metrics.coursesWithStats.length === 0 ? (
                    <div className="stats-empty-state">
                        <FaBookOpen className="stats-empty-icon" />
                        <p>No course attendance recorded yet.</p>
                    </div>
                ) : (
                    <div className="stats-subjects-grid">
                        {metrics.coursesWithStats.map((item, idx) => {
                            const pct = item.percentage;
                            const isSafe = pct !== null && pct >= 75;
                            const isWarning = pct !== null && pct >= 65 && pct < 75;
                            const isDanger = pct !== null && pct < 65;

                            return (
                                <div
                                    key={idx}
                                    className={`stats-subject-item ${selectedCourseFilter === item.courseCode ? "active" : ""}`}
                                    onClick={() => {
                                        setSelectedCourseFilter((prev) => (prev === item.courseCode ? "all" : item.courseCode));
                                    }}
                                    style={{ cursor: "pointer" }}
                                    title={`Click to filter table logs for ${item.courseCode}`}
                                >
                                    <div className="stats-subject-top">
                                        <div className="stats-subject-title">
                                            <FaBookOpen className="stats-subject-icon" />
                                            <h3>{item.courseCode} — {item.courseName}</h3>
                                        </div>
                                        <span
                                            className={`stats-subject-badge ${isSafe
                                                ? "status-safe"
                                                : isWarning
                                                    ? "status-warning"
                                                    : isDanger
                                                        ? "status-danger"
                                                        : "status-muted"
                                                }`}
                                        >
                                            {pct !== null ? `${pct}%` : "No classes"}
                                        </span>
                                    </div>

                                    <div className="stats-subject-meter">
                                        <div
                                            className="stats-subject-fill"
                                            style={{
                                                width: `${Math.min(pct !== null ? pct : 0, 100)}%`,
                                                backgroundColor: isSafe
                                                    ? "#10b981"
                                                    : isWarning
                                                        ? "#f59e0b"
                                                        : isDanger
                                                            ? "#ef4444"
                                                            : "#94a3b8"
                                            }}
                                        />
                                    </div>

                                    <div className="stats-subject-footer">
                                        <span>
                                            Attended: <strong>{item.attendedCount}</strong> / {item.totalConducted}
                                        </span>
                                        <span className="stats-subject-status-text">
                                            {item.totalConducted === 0 ? (
                                                "Pending Sessions"
                                            ) : isSafe ? (
                                                <span style={{ color: "#10b981", fontWeight: 700 }}>Eligible (+{item.leavesAvailable} Leaves Safe)</span>
                                            ) : (
                                                <span style={{ color: "#ef4444", fontWeight: 700 }}>At Risk (Need +{item.classesNeeded} Classes)</span>
                                            )}
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 4. Attendance Log Table with Search & Filters */}
            <div className="stats-section-card">
                <div className="stats-section-header stats-table-header-row">
                    <div>
                        <h2>Attendance History Logs</h2>
                        <p>Complete record of all verified class attendances</p>
                    </div>

                    <div className="stats-controls-row">
                        {/* Course Filter Dropdown */}
                        <div className="stats-filter-dropdown-wrap">
                            <FaFilter className="stats-filter-icon" />
                            <select
                                value={selectedCourseFilter}
                                onChange={(e) => setSelectedCourseFilter(e.target.value)}
                                className="stats-course-select"
                                aria-label="Filter by course"
                            >
                                <option value="all">All Courses ({metrics.coursesWithStats.length})</option>
                                {metrics.coursesWithStats.map((s, idx) => (
                                    <option key={idx} value={s.courseCode}>
                                        {s.courseCode} ({s.attendedCount} Attended)
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Search Input */}
                        <div className="stats-search-box">
                            <FaSearch className="stats-search-icon" />
                            <input
                                type="text"
                                placeholder="Search records..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </div>
                    </div>
                </div>

                {loading ? (
                    <div className="stats-loading">
                        <div className="stats-spinner" />
                        <p>Loading attendance data...</p>
                    </div>
                ) : sortedRecords.length === 0 ? (
                    <div className="stats-empty-state">
                        <FaCalendarAlt className="stats-empty-icon" />
                        <p>No matching attendance records found.</p>
                    </div>
                ) : (
                    <div className="stats-table-wrapper">
                        <table className="stats-data-table" id="student-statistics-table">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th onClick={() => requestSort("submittedAt")}>
                                        Date &amp; Time <SortIcon config={sortConfig} columnKey="submittedAt" />
                                    </th>
                                    <th onClick={() => requestSort("courseCode")}>
                                        Course / Subject <SortIcon config={sortConfig} columnKey="courseCode" />
                                    </th>
                                    <th onClick={() => requestSort("classCode")}>
                                        Class Code <SortIcon config={sortConfig} columnKey="classCode" />
                                    </th>
                                    <th onClick={() => requestSort("roomNo")}>
                                        Room No <SortIcon config={sortConfig} columnKey="roomNo" />
                                    </th>
                                    <th onClick={() => requestSort("verificationMethod")}>
                                        Verification Mode <SortIcon config={sortConfig} columnKey="verificationMethod" />
                                    </th>
                                    <th onClick={() => requestSort("status")}>
                                        Status <SortIcon config={sortConfig} columnKey="status" />
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {sortedRecords.map((r, index) => {
                                    const dateObj = r.submittedAt ? new Date(r.submittedAt) : null;
                                    const formattedDate = dateObj
                                        ? dateObj.toLocaleDateString("en-US", {
                                            month: "short",
                                            day: "numeric",
                                            year: "numeric"
                                        })
                                        : "N/A";
                                    const formattedTime = dateObj
                                        ? dateObj.toLocaleTimeString("en-US", {
                                            hour: "2-digit",
                                            minute: "2-digit"
                                        })
                                        : "";

                                    const isBiometricVerified = Boolean(
                                        r.verificationMethod === "face" ||
                                        r.verificationMethod === "face_biometric" ||
                                        r.faceVerified === true ||
                                        r.biometricVerified === true
                                    );

                                    return (
                                        <tr key={r.id || index}>
                                            <td className="text-muted">{index + 1}</td>
                                            <td>
                                                <div className="stats-date-cell">
                                                    <span className="stats-date-primary">{formattedDate}</span>
                                                    <span className="stats-date-time">
                                                        <FaClock /> {formattedTime}
                                                    </span>
                                                </div>
                                            </td>
                                            <td>
                                                <span className="stats-course-badge">
                                                    {r.courseCode || "N/A"}
                                                </span>
                                            </td>
                                            <td>
                                                <span className="stats-class-code">{r.classCode || "N/A"}</span>
                                            </td>
                                            <td>Room {r.roomNo || "N/A"}</td>
                                            <td>
                                                {isBiometricVerified ? (
                                                    <span className="stats-verify-badge verify-face">
                                                        <FaUserCheck /> Face Biometric
                                                    </span>
                                                ) : (
                                                    <span className="stats-verify-badge verify-qr">
                                                        <FaQrcode /> QR Scanned
                                                    </span>
                                                )}
                                            </td>
                                            <td>
                                                <span className="stats-table-status-badge">
                                                    <FaCheckCircle /> Present
                                                </span>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
