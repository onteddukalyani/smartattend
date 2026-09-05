import React, { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
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
    FaBookOpen,
    FaGraduationCap,
    FaSearch,
    FaSyncAlt,
    FaChalkboardTeacher,
    FaDoorOpen,
    FaCalendarCheck,
    FaLayerGroup,
    FaExclamationTriangle,
    FaCheckCircle,
    FaInfoCircle,
    FaTimes,
    FaQrcode,
    FaArrowRight,
    FaClock,
    FaPercentage
} from "react-icons/fa";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import "./StudentCourses.css";

export default function StudentCourses() {
    const { user, profile } = useAuth();
    const navigate = useNavigate();

    const [courses, setCourses] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [search, setSearch] = useState("");
    const [selectedDepartment, setSelectedDepartment] = useState("all");
    const [selectedSemester, setSelectedSemester] = useState("all");
    const [statusFilter, setStatusFilter] = useState("all"); // "all", "safe", "shortage", "my_dept"
    const [selectedCourseModal, setSelectedCourseModal] = useState(null);

    // Roll number derivation from email prefix / profile
    const emailRoll = (user?.email || "").split("@")[0].trim().toUpperCase();
    const activeRollNo = (profile?.rollNo || emailRoll || "").trim().toUpperCase();
    const studentDept = profile?.department || profile?.branch || "";

    // Build candidate roll numbers for matching
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
        if (user?.uid) {
            set.add(user.uid);
        }
        return Array.from(set).filter(Boolean).slice(0, 10);
    }, [activeRollNo, profile?.rollNo, user?.email, user?.uid]);

    // 1. Real-time Courses listener
    useEffect(() => {
        setLoading(true);
        const unsubscribeCourses = onSnapshot(
            collection(db, "courses"),
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({
                    id: d.id,
                    ...d.data()
                }));
                list.sort((a, b) => (a.courseCode || "").localeCompare(b.courseCode || ""));
                setCourses(list);
                setLoading(false);
            },
            (err) => {
                console.error("Error loading courses:", err);
                setLoading(false);
            }
        );

        return () => unsubscribeCourses();
    }, []);

    // 2. Real-time Sessions listener
    useEffect(() => {
        const unsubscribeSessions = onSnapshot(
            collection(db, "attendance_sessions"),
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({
                    id: d.id,
                    ...d.data()
                }));
                setSessions(list);
            },
            (err) => console.warn("Error loading sessions:", err)
        );

        return () => unsubscribeSessions();
    }, []);

    // 3. Real-time Attendance Records listener
    useEffect(() => {
        if (!candidateRolls || candidateRolls.length === 0) return;

        const q = query(
            collection(db, "attendance_records"),
            where("rollNo", "in", candidateRolls)
        );

        const unsubscribeRecords = onSnapshot(
            q,
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({
                    id: d.id,
                    ...d.data()
                }));
                setRecords(list);
            },
            (err) => console.warn("Error loading attendance records for courses:", err)
        );

        return () => unsubscribeRecords();
    }, [candidateRolls]);

    // Manual Refresh Handler
    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            const [coursesSnap, sessionsSnap, recordsSnap] = await Promise.all([
                getDocs(collection(db, "courses")),
                getDocs(collection(db, "attendance_sessions")),
                candidateRolls.length > 0
                    ? getDocs(query(collection(db, "attendance_records"), where("rollNo", "in", candidateRolls)))
                    : { docs: [] }
            ]);

            const cList = coursesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
            cList.sort((a, b) => (a.courseCode || "").localeCompare(b.courseCode || ""));
            setCourses(cList);

            setSessions(sessionsSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
            setRecords(recordsSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
        } catch (err) {
            console.error("Refresh error:", err);
        } finally {
            setRefreshing(false);
        }
    };

    // Calculate per-course attendance and insights
    const courseStats = useMemo(() => {
        // Build session ID to session map
        const sessionMap = new Map();
        sessions.forEach((s) => sessionMap.set(s.id, s));

        return courses.map((course) => {
            const cCode = (course.courseCode || "").trim().toUpperCase();

            // Total sessions conducted for this course
            const courseSessions = sessions.filter((s) => {
                const sCourse = (s.courseCode || s.classCode || "").trim().toUpperCase();
                return sCourse === cCode || (cCode && s.id && s.id.toUpperCase().includes(cCode));
            });
            const totalConducted = courseSessions.length;

            // Student attendance records for this course
            const courseRecords = records.filter((r) => {
                const rCourse = (r.courseCode || r.classCode || "").trim().toUpperCase();
                if (rCourse && rCourse === cCode) return true;

                // Match via session ID
                if (r.sessionId) {
                    const sess = sessionMap.get(r.sessionId);
                    if (sess) {
                        const sCourse = (sess.courseCode || sess.classCode || "").trim().toUpperCase();
                        return sCourse === cCode;
                    }
                }
                return false;
            });

            // Unique sessions attended by student
            const attendedCount = courseRecords.length;
            const percentage = totalConducted > 0
                ? Math.min(100, Math.round((attendedCount / totalConducted) * 100))
                : null;

            // Safety Calculations
            let status = "none";
            let leavesAvailable = 0;
            let classesNeeded = 0;

            if (totalConducted > 0 && percentage !== null) {
                if (percentage >= 75) {
                    status = "safe";
                    // Number of consecutive classes student can miss while staying >= 75%
                    leavesAvailable = Math.floor((attendedCount - 0.75 * totalConducted) / 0.75);
                    if (leavesAvailable < 0) leavesAvailable = 0;
                } else if (percentage >= 65) {
                    status = "warning";
                    classesNeeded = Math.ceil((0.75 * totalConducted - attendedCount) / 0.25);
                    if (classesNeeded < 0) classesNeeded = 0;
                } else {
                    status = "danger";
                    classesNeeded = Math.ceil((0.75 * totalConducted - attendedCount) / 0.25);
                    if (classesNeeded < 0) classesNeeded = 0;
                }
            }

            return {
                ...course,
                cCode,
                totalConducted,
                attendedCount,
                percentage,
                status,
                leavesAvailable,
                classesNeeded,
                history: courseRecords
            };
        });
    }, [courses, sessions, records]);

    // KPI Metrics across all courses
    const kpis = useMemo(() => {
        const total = courseStats.length;
        const activeSubjects = courseStats.filter((c) => c.totalConducted > 0);
        const totalPercentSum = activeSubjects.reduce((acc, c) => acc + (c.percentage || 0), 0);
        const avgPercentage = activeSubjects.length > 0
            ? Math.round(totalPercentSum / activeSubjects.length)
            : 0;

        const safeCount = activeSubjects.filter((c) => (c.percentage || 0) >= 75).length;
        const shortageCount = activeSubjects.filter((c) => (c.percentage || 0) < 75).length;

        return {
            total,
            activeCount: activeSubjects.length,
            avgPercentage,
            safeCount,
            shortageCount
        };
    }, [courseStats]);

    // Unique departments & semesters for filters
    const departments = useMemo(() => {
        const set = new Set(courses.map((c) => c.department).filter(Boolean));
        return Array.from(set).sort();
    }, [courses]);

    const semesters = useMemo(() => {
        const set = new Set(courses.map((c) => String(c.semester)).filter(Boolean));
        return Array.from(set).sort((a, b) => Number(a) - Number(b));
    }, [courses]);

    // Filtered Course List
    const filteredCourses = useMemo(() => {
        const q = search.toLowerCase().trim();

        return courseStats.filter((course) => {
            // Search match
            const matchSearch =
                !q ||
                (course.courseCode || "").toLowerCase().includes(q) ||
                (course.courseName || "").toLowerCase().includes(q) ||
                (course.lecturerName || "").toLowerCase().includes(q) ||
                (course.department || "").toLowerCase().includes(q) ||
                (course.defaultRoom || "").toLowerCase().includes(q);

            if (!matchSearch) return false;

            // Department filter
            if (selectedDepartment !== "all" && course.department !== selectedDepartment) {
                return false;
            }

            // Semester filter
            if (selectedSemester !== "all" && String(course.semester) !== selectedSemester) {
                return false;
            }

            // Status filter
            if (statusFilter === "safe") {
                return course.percentage !== null && course.percentage >= 75;
            }
            if (statusFilter === "shortage") {
                return course.percentage !== null && course.percentage < 75;
            }
            if (statusFilter === "my_dept") {
                if (!studentDept) return true;
                return (course.department || "").toLowerCase() === studentDept.toLowerCase();
            }

            return true;
        });
    }, [courseStats, search, selectedDepartment, selectedSemester, statusFilter, studentDept]);

    const getStatusBadge = (course) => {
        if (course.totalConducted === 0 || course.percentage === null) {
            return <span className="sc-status-badge sc-badge-muted"><FaInfoCircle /> No Classes Yet</span>;
        }
        if (course.percentage >= 75) {
            return <span className="sc-status-badge sc-badge-safe"><FaCheckCircle /> {course.percentage}% Safe</span>;
        }
        if (course.percentage >= 65) {
            return <span className="sc-status-badge sc-badge-warning"><FaExclamationTriangle /> {course.percentage}% Warning</span>;
        }
        return <span className="sc-status-badge sc-badge-danger"><FaExclamationTriangle /> {course.percentage}% Critical</span>;
    };

    return (
        <div className="student-courses-page">
            {/* Header section */}
            <div className="sc-header-card">
                <div className="sc-header-info">
                    <div className="sc-header-icon-wrap">
                        <FaBookOpen />
                    </div>
                    <div>
                        <div className="sc-header-badge">
                            <FaGraduationCap /> Academic Curriculum & Attendance
                        </div>
                        <h1 className="sc-header-title">My Courses & Syllabus</h1>
                        <p className="sc-header-desc">
                            Track real-time subject attendance, faculty contacts, syllabus status, and class eligibility.
                        </p>
                    </div>
                </div>

                <div className="sc-header-actions">
                    <button
                        className={`sc-btn sc-btn-refresh ${refreshing ? "spinning" : ""}`}
                        onClick={handleRefresh}
                        disabled={refreshing}
                        title="Sync latest course and attendance records"
                    >
                        <FaSyncAlt />
                        <span>{refreshing ? "Refreshing..." : "Refresh"}</span>
                    </button>
                    <button
                        className="sc-btn sc-btn-primary"
                        onClick={() => navigate("/student/mark-attendance")}
                    >
                        <FaQrcode />
                        <span>Scan QR</span>
                    </button>
                </div>
            </div>

            {/* KPI Summary Cards */}
            <div className="sc-kpi-grid">
                <div className="sc-kpi-card sc-kpi-total">
                    <div className="sc-kpi-icon"><FaBookOpen /></div>
                    <div className="sc-kpi-content">
                        <span className="sc-kpi-label">Total Courses</span>
                        <h3 className="sc-kpi-value">{kpis.total}</h3>
                        <span className="sc-kpi-sub">{kpis.activeCount} with active sessions</span>
                    </div>
                </div>

                <div className="sc-kpi-card sc-kpi-average">
                    <div className="sc-kpi-icon"><FaPercentage /></div>
                    <div className="sc-kpi-content">
                        <span className="sc-kpi-label">Average Attendance</span>
                        <h3 className="sc-kpi-value">{kpis.avgPercentage}%</h3>
                        <span className="sc-kpi-sub">
                            {kpis.avgPercentage >= 75 ? "Target Achieved (≥75%)" : "Needs Attention (<75%)"}
                        </span>
                    </div>
                </div>

                <div className="sc-kpi-card sc-kpi-safe">
                    <div className="sc-kpi-icon"><FaCheckCircle /></div>
                    <div className="sc-kpi-content">
                        <span className="sc-kpi-label">Safe Subjects</span>
                        <h3 className="sc-kpi-value">{kpis.safeCount}</h3>
                        <span className="sc-kpi-sub">Attendance ≥ 75%</span>
                    </div>
                </div>

                <div className="sc-kpi-card sc-kpi-alert">
                    <div className="sc-kpi-icon"><FaExclamationTriangle /></div>
                    <div className="sc-kpi-content">
                        <span className="sc-kpi-label">Low Attendance</span>
                        <h3 className="sc-kpi-value">{kpis.shortageCount}</h3>
                        <span className="sc-kpi-sub">Below 75% threshold</span>
                    </div>
                </div>
            </div>

            {/* Filter and Search Bar */}
            <div className="sc-filter-container">
                <div className="sc-search-wrap">
                    <FaSearch className="sc-search-icon" />
                    <input
                        type="text"
                        placeholder="Search by course code, name, instructor, or room..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="sc-search-input"
                    />
                    {search && (
                        <button className="sc-clear-btn" onClick={() => setSearch("")}>
                            <FaTimes />
                        </button>
                    )}
                </div>

                <div className="sc-filters-row">
                    {/* Status Tabs */}
                    <div className="sc-status-tabs">
                        <button
                            className={`sc-tab-btn ${statusFilter === "all" ? "active" : ""}`}
                            onClick={() => setStatusFilter("all")}
                        >
                            All ({courseStats.length})
                        </button>
                        <button
                            className={`sc-tab-btn ${statusFilter === "safe" ? "active" : ""}`}
                            onClick={() => setStatusFilter("safe")}
                        >
                            Safe ≥75% ({kpis.safeCount})
                        </button>
                        <button
                            className={`sc-tab-btn ${statusFilter === "shortage" ? "active" : ""}`}
                            onClick={() => setStatusFilter("shortage")}
                        >
                            Shortage ({kpis.shortageCount})
                        </button>
                        {studentDept && (
                            <button
                                className={`sc-tab-btn ${statusFilter === "my_dept" ? "active" : ""}`}
                                onClick={() => setStatusFilter("my_dept")}
                            >
                                My Dept ({studentDept})
                            </button>
                        )}
                    </div>

                    {/* Department & Semester Dropdowns */}
                    <div className="sc-dropdown-group">
                        <select
                            value={selectedDepartment}
                            onChange={(e) => setSelectedDepartment(e.target.value)}
                            className="sc-select"
                        >
                            <option value="all">All Departments</option>
                            {departments.map((d) => (
                                <option key={d} value={d}>{d}</option>
                            ))}
                        </select>

                        <select
                            value={selectedSemester}
                            onChange={(e) => setSelectedSemester(e.target.value)}
                            className="sc-select"
                        >
                            <option value="all">All Semesters</option>
                            {semesters.map((s) => (
                                <option key={s} value={s}>Sem {s}</option>
                            ))}
                        </select>
                    </div>
                </div>
            </div>

            {/* Course Cards Grid */}
            {loading ? (
                <div className="sc-loading-grid">
                    {[1, 2, 3, 4, 5, 6].map((i) => (
                        <div key={i} className="sc-skeleton-card" />
                    ))}
                </div>
            ) : filteredCourses.length === 0 ? (
                <div className="sc-empty-state">
                    <div className="sc-empty-icon">
                        <FaBookOpen />
                    </div>
                    <h3>No Courses Found</h3>
                    <p>
                        {search || selectedDepartment !== "all" || selectedSemester !== "all" || statusFilter !== "all"
                            ? "No subjects match your active search or filter criteria. Try resetting filters."
                            : "No academic courses have been configured yet by the administration or faculty."}
                    </p>
                    {(search || selectedDepartment !== "all" || selectedSemester !== "all" || statusFilter !== "all") && (
                        <button
                            className="sc-btn sc-btn-outline"
                            onClick={() => {
                                setSearch("");
                                setSelectedDepartment("all");
                                setSelectedSemester("all");
                                setStatusFilter("all");
                            }}
                        >
                            Reset All Filters
                        </button>
                    )}
                </div>
            ) : (
                <div className="sc-courses-grid">
                    {filteredCourses.map((course) => {
                        const pct = course.percentage;
                        const isSafe = pct !== null && pct >= 75;
                        const isWarning = pct !== null && pct >= 65 && pct < 75;
                        const isDanger = pct !== null && pct < 65;

                        return (
                            <div
                                key={course.id || course.courseCode}
                                className={`sc-course-card ${isSafe ? "card-safe" : isDanger ? "card-danger" : isWarning ? "card-warning" : ""}`}
                                onClick={() => setSelectedCourseModal(course)}
                            >
                                {/* Card Header */}
                                <div className="sc-card-top">
                                    <div className="sc-card-tags">
                                        <span className="sc-code-badge">{course.courseCode || "N/A"}</span>
                                        {course.department && (
                                            <span className="sc-tag-dept">{course.department}</span>
                                        )}
                                        {course.semester && (
                                            <span className="sc-tag-sem">Sem {course.semester}</span>
                                        )}
                                    </div>
                                    <div className="sc-card-status">
                                        {getStatusBadge(course)}
                                    </div>
                                </div>

                                {/* Course Title */}
                                <h3 className="sc-course-name">{course.courseName || "Untitled Course"}</h3>

                                {/* Faculty & Room Info */}
                                <div className="sc-info-list">
                                    <div className="sc-info-row">
                                        <FaChalkboardTeacher className="sc-info-icon" />
                                        <span className="sc-info-text">
                                            <strong>{course.lecturerName || "Assigned Faculty"}</strong>
                                        </span>
                                    </div>
                                    <div className="sc-info-row">
                                        <FaDoorOpen className="sc-info-icon" />
                                        <span className="sc-info-text">Room: {course.defaultRoom || "Main Hall"}</span>
                                        {course.credits && (
                                            <span className="sc-credits-pill">
                                                <FaLayerGroup /> {course.credits} Credits
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* Attendance Gauge Bar */}
                                <div className="sc-attendance-box">
                                    <div className="sc-att-header">
                                        <span className="sc-att-label">Attendance Record</span>
                                        <span className={`sc-att-pct ${isSafe ? "text-safe" : isDanger ? "text-danger" : isWarning ? "text-warning" : "text-muted"}`}>
                                            {pct !== null ? `${pct}%` : "No sessions"}
                                        </span>
                                    </div>

                                    <div className="sc-progress-bar-bg">
                                        <div
                                            className={`sc-progress-bar-fill ${isSafe ? "fill-safe" : isDanger ? "fill-danger" : isWarning ? "fill-warning" : "fill-muted"}`}
                                            style={{ width: `${pct !== null ? pct : 0}%` }}
                                        />
                                        {/* 75% Threshold Marker */}
                                        <div className="sc-threshold-marker" title="Minimum 75% required" />
                                    </div>

                                    <div className="sc-att-stats-row">
                                        <span>Attended: <strong>{course.attendedCount}</strong></span>
                                        <span>Conducted: <strong>{course.totalConducted}</strong></span>
                                    </div>
                                </div>

                                {/* Smart Advice Box */}
                                <div className="sc-advice-box">
                                    {course.totalConducted === 0 ? (
                                        <span className="sc-advice-text muted">
                                            <FaInfoCircle /> Classes have not commenced for this subject yet.
                                        </span>
                                    ) : isSafe ? (
                                        <span className="sc-advice-text safe">
                                            <FaCheckCircle /> Safe! You can miss <strong>{course.leavesAvailable}</strong> class{course.leavesAvailable === 1 ? "" : "es"} safely.
                                        </span>
                                    ) : (
                                        <span className="sc-advice-text alert">
                                            <FaExclamationTriangle /> Attend next <strong>{course.classesNeeded}</strong> class{course.classesNeeded === 1 ? "" : "es"} to reach 75%.
                                        </span>
                                    )}
                                </div>

                                {/* Card Footer CTA */}
                                <div className="sc-card-footer">
                                    <span className="sc-view-details-link">
                                        View Details & Attendance Logs <FaArrowRight />
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Course Detail Modal */}
            {selectedCourseModal && (
                <div className="sc-modal-backdrop" onClick={() => setSelectedCourseModal(null)}>
                    <div className="sc-modal-card" onClick={(e) => e.stopPropagation()}>
                        <div className="sc-modal-header">
                            <div>
                                <div className="sc-card-tags">
                                    <span className="sc-code-badge">{selectedCourseModal.courseCode}</span>
                                    <span className="sc-tag-dept">{selectedCourseModal.department}</span>
                                    <span className="sc-tag-sem">Semester {selectedCourseModal.semester}</span>
                                </div>
                                <h2 className="sc-modal-title">{selectedCourseModal.courseName}</h2>
                            </div>
                            <button
                                className="sc-modal-close"
                                onClick={() => setSelectedCourseModal(null)}
                                aria-label="Close modal"
                            >
                                <FaTimes />
                            </button>
                        </div>

                        <div className="sc-modal-body">
                            {/* Quick Details Bar */}
                            <div className="sc-modal-detail-strip">
                                <div className="sc-modal-strip-item">
                                    <span className="sc-strip-label">Instructor</span>
                                    <span className="sc-strip-val">{selectedCourseModal.lecturerName || "Assigned Faculty"}</span>
                                    {selectedCourseModal.lecturerEmail && (
                                        <span className="sc-strip-sub">{selectedCourseModal.lecturerEmail}</span>
                                    )}
                                </div>
                                <div className="sc-modal-strip-item">
                                    <span className="sc-strip-label">Default Room</span>
                                    <span className="sc-strip-val">{selectedCourseModal.defaultRoom || "Main Hall"}</span>
                                </div>
                                <div className="sc-modal-strip-item">
                                    <span className="sc-strip-label">Credits</span>
                                    <span className="sc-strip-val">{selectedCourseModal.credits || 3} Credits</span>
                                </div>
                            </div>

                            {/* Description if present */}
                            {selectedCourseModal.description && (
                                <div className="sc-modal-section">
                                    <h4 className="sc-section-title">Course Description & Syllabus</h4>
                                    <p className="sc-course-desc">{selectedCourseModal.description}</p>
                                </div>
                            )}

                            {/* Attendance Analytics Breakdown */}
                            <div className="sc-modal-section">
                                <h4 className="sc-section-title">Your Subject Attendance Breakdown</h4>
                                <div className="sc-modal-analytics-card">
                                    <div className="sc-modal-analytics-left">
                                        <div className="sc-big-pct">
                                            {selectedCourseModal.percentage !== null ? `${selectedCourseModal.percentage}%` : "—"}
                                        </div>
                                        <span className="sc-pct-subtitle">
                                            {selectedCourseModal.percentage !== null && selectedCourseModal.percentage >= 75
                                                ? "Eligible for Exams"
                                                : selectedCourseModal.totalConducted === 0
                                                    ? "Pending Sessions"
                                                    : "Shortage Warning"}
                                        </span>
                                    </div>

                                    <div className="sc-modal-analytics-right">
                                        <div className="sc-stat-pill">
                                            <span>Attended Classes</span>
                                            <strong>{selectedCourseModal.attendedCount} / {selectedCourseModal.totalConducted}</strong>
                                        </div>
                                        <div className="sc-stat-pill">
                                            <span>Missed Classes</span>
                                            <strong>
                                                {selectedCourseModal.totalConducted >= selectedCourseModal.attendedCount
                                                    ? selectedCourseModal.totalConducted - selectedCourseModal.attendedCount
                                                    : 0}
                                            </strong>
                                        </div>
                                        <div className="sc-stat-pill">
                                            <span>Status</span>
                                            <strong>
                                                {selectedCourseModal.percentage >= 75 ? (
                                                    <span className="text-safe">Safe (+{selectedCourseModal.leavesAvailable} Leaves)</span>
                                                ) : selectedCourseModal.totalConducted === 0 ? (
                                                    <span className="text-muted">No Sessions</span>
                                                ) : (
                                                    <span className="text-danger">Needs +{selectedCourseModal.classesNeeded} Classes</span>
                                                )}
                                            </strong>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Student's recent attendance logs for this course */}
                            <div className="sc-modal-section">
                                <h4 className="sc-section-title">
                                    Attendance Logs ({selectedCourseModal.history?.length || 0})
                                </h4>
                                {(!selectedCourseModal.history || selectedCourseModal.history.length === 0) ? (
                                    <div className="sc-no-records-box">
                                        <FaCalendarCheck />
                                        <p>No individual attendance entries logged yet for this subject.</p>
                                    </div>
                                ) : (
                                    <div className="sc-modal-logs-list">
                                        {selectedCourseModal.history.map((record, idx) => {
                                            const timeStr = record.submittedAt
                                                ? new Date(record.submittedAt).toLocaleString(undefined, {
                                                    dateStyle: "medium",
                                                    timeStyle: "short"
                                                })
                                                : "Recorded";

                                            return (
                                                <div key={record.id || idx} className="sc-log-row">
                                                    <div className="sc-log-icon">
                                                        <FaCheckCircle />
                                                    </div>
                                                    <div className="sc-log-info">
                                                        <span className="sc-log-title">
                                                            {record.classCode || selectedCourseModal.courseCode} — Present
                                                        </span>
                                                        <span className="sc-log-sub">
                                                            <FaClock /> {timeStr} • Room {record.roomNo || selectedCourseModal.defaultRoom || "N/A"}
                                                        </span>
                                                    </div>
                                                    <span className="sc-log-badge">Verified</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="sc-modal-footer">
                            <button
                                className="sc-btn sc-btn-outline"
                                onClick={() => setSelectedCourseModal(null)}
                            >
                                Close
                            </button>
                            <button
                                className="sc-btn sc-btn-primary"
                                onClick={() => {
                                    setSelectedCourseModal(null);
                                    navigate("/student/mark-attendance");
                                }}
                            >
                                <FaQrcode /> Scan QR for Class
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
