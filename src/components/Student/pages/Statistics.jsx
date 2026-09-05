import React, { useEffect, useState, useMemo } from "react";
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
    FaCalendarAlt
} from "react-icons/fa";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import "./Statistics.css";

export default function Statistics() {
    const { user, profile } = useAuth();
    const [records, setRecords] = useState([]);
    const [allSessions, setAllSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [search, setSearch] = useState("");
    const [selectedCourseFilter, setSelectedCourseFilter] = useState("all");
    const [fetchedStudentData, setFetchedStudentData] = useState(null);

    // Roll number strictly derived from Gmail prefix (e.g. 25bcs108@gmail.com -> 25BCS108)
    const emailRoll = (user?.email || "").split("@")[0].trim().toUpperCase();
    const activeRollNo = (profile?.rollNo || emailRoll || "").trim().toUpperCase();

    // Fetch student profile details from Firestore
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
        return Array.from(set).filter(Boolean).slice(0, 10);
    }, [activeRollNo, profile?.rollNo, user?.email]);

    // Fetch sessions and attendance records in real time
    useEffect(() => {
        if (!candidateRolls || candidateRolls.length === 0) {
            setLoading(false);
            return;
        }

        setLoading(true);

        // Fetch all attendance sessions
        getDocs(collection(db, "attendance_sessions"))
            .then((sessionsSnap) => {
                const sessionsList = sessionsSnap.docs.map((d) => ({
                    id: d.id,
                    ...d.data()
                }));
                setAllSessions(sessionsList);
            })
            .catch((err) => console.warn("Could not fetch sessions:", err));

        // Real-time listener for student's attendance records
        const recordsQ = query(
            collection(db, "attendance_records"),
            where("rollNo", "in", candidateRolls)
        );

        const unsubscribe = onSnapshot(
            recordsQ,
            (snapshot) => {
                const fetched = snapshot.docs.map((docSnap) => {
                    const data = docSnap.data();
                    return {
                        id: docSnap.id,
                        ...data,
                        courseCode: data.courseCode || "N/A",
                        classCode: data.classCode || "N/A",
                        roomNo: data.roomNo || "N/A"
                    };
                });

                fetched.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
                setRecords(fetched);
                setLoading(false);
                setRefreshing(false);
            },
            (err) => {
                console.error("Error loading statistics:", err);
                setLoading(false);
                setRefreshing(false);
            }
        );

        return () => unsubscribe();
    }, [candidateRolls]);

    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            const [sessionsSnap, recordsSnap] = await Promise.all([
                getDocs(collection(db, "attendance_sessions")),
                getDocs(query(collection(db, "attendance_records"), where("rollNo", "in", candidateRolls)))
            ]);

            const sessionsList = sessionsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
            setAllSessions(sessionsList);

            const sessionsMap = new Map();
            sessionsList.forEach((s) => sessionsMap.set(s.id, s));

            const fetched = recordsSnap.docs.map((docSnap) => {
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

            fetched.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
            setRecords(fetched);
        } catch (err) {
            console.error("Manual refresh error:", err);
        } finally {
            setRefreshing(false);
        }
    };

    // Calculate subject-wise metrics
    const subjectStats = useMemo(() => {
        // Collect all distinct courses student has records for, or that exist in sessions
        const statsMap = {};

        // Track attended classes per course
        records.forEach((rec) => {
            const course = (rec.courseCode || "General").trim().toUpperCase();
            if (!statsMap[course]) {
                statsMap[course] = { course, attended: 0, total: 0, records: [] };
            }
            statsMap[course].attended += 1;
            statsMap[course].records.push(rec);
        });

        // Track total conducted sessions for matching courses
        allSessions.forEach((sess) => {
            const course = (sess.courseCode || "").trim().toUpperCase();
            if (course && statsMap[course]) {
                statsMap[course].total += 1;
            }
        });

        // If total conducted is less than attended (due to missing sessions), normalize total
        Object.values(statsMap).forEach((item) => {
            if (item.total < item.attended) {
                item.total = item.attended;
            }
            item.percentage = item.total > 0 ? Math.round((item.attended / item.total) * 100) : 100;
        });

        return Object.values(statsMap);
    }, [records, allSessions]);

    // Overall aggregate statistics
    const totalAttended = records.length;
    const totalConducted = subjectStats.reduce((acc, curr) => acc + curr.total, 0) || totalAttended;
    const totalMissed = Math.max(0, totalConducted - totalAttended);
    const overallPercentage = totalConducted > 0 ? Math.round((totalAttended / totalConducted) * 100) : (totalAttended > 0 ? 100 : 0);

    // 75% Attendance Requirement Math
    // Needed to reach 75%: (attended + x) / (conducted + x) >= 0.75  =>  x >= 3*conducted - 4*attended
    // Can miss while staying >= 75%: attended / (conducted + y) >= 0.75  =>  y <= (attended / 0.75) - conducted
    const requiredThreshold = 75;
    const neededToReach75 = Math.max(0, Math.ceil(3 * totalConducted - 4 * totalAttended));
    const safeToMiss = overallPercentage >= requiredThreshold
        ? Math.max(0, Math.floor((totalAttended / 0.75) - totalConducted))
        : 0;

    // Filtered records for table
    const filteredRecords = useMemo(() => {
        return records.filter((r) => {
            const term = search.toLowerCase().trim();
            const courseMatch = selectedCourseFilter === "all" || (r.courseCode || "").toUpperCase() === selectedCourseFilter.toUpperCase();
            if (!courseMatch) return false;

            if (!term) return true;
            return (
                (r.courseCode || "").toLowerCase().includes(term) ||
                (r.classCode || "").toLowerCase().includes(term) ||
                (r.roomNo || "").toLowerCase().includes(term) ||
                (r.rollNo || "").toLowerCase().includes(term)
            );
        });
    }, [records, search, selectedCourseFilter]);

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
                    <div className="stats-avatar">
                        {studentName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <h1>Attendance Statistics & Analytics</h1>
                        <p className="stats-subtitle">
                            Detailed overview of attendance records, subject performance, and compliance metrics.
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
                        disabled={records.length === 0}
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
                        <span className="stats-kpi-number">{overallPercentage}%</span>
                        <span
                            className={`stats-status-badge ${
                                overallPercentage >= 75
                                    ? "status-safe"
                                    : overallPercentage >= 65
                                    ? "status-warning"
                                    : "status-danger"
                            }`}
                        >
                            {overallPercentage >= 75 ? (
                                <><FaCheckCircle /> On Track</>
                            ) : overallPercentage >= 65 ? (
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
                                width: `${Math.min(overallPercentage, 100)}%`,
                                backgroundColor:
                                    overallPercentage >= 75
                                        ? "#10b981"
                                        : overallPercentage >= 65
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
                        <span className="stats-kpi-number text-green">{totalAttended}</span>
                        <span className="stats-kpi-unit">sessions</span>
                    </div>
                    <p className="stats-kpi-footer-text">
                        Total verified sessions attended with QR scanning.
                    </p>
                </div>

                {/* Classes Missed */}
                <div className="stats-kpi-card">
                    <div className="stats-kpi-header">
                        <span className="stats-kpi-label">Classes Missed</span>
                        <FaTimesCircle className="stats-kpi-icon text-red" />
                    </div>
                    <div className="stats-kpi-value-row">
                        <span className="stats-kpi-number text-red">{totalMissed}</span>
                        <span className="stats-kpi-unit">sessions</span>
                    </div>
                    <p className="stats-kpi-footer-text">
                        Recorded absences across all course sessions.
                    </p>
                </div>

                {/* Target Requirement Calculator */}
                <div className="stats-kpi-card stats-kpi-target">
                    <div className="stats-kpi-header">
                        <span className="stats-kpi-label">75% Target Status</span>
                        <FaAward className="stats-kpi-icon text-indigo" />
                    </div>
                    <div className="stats-target-content">
                        {overallPercentage >= 75 ? (
                            <div>
                                <span className="stats-target-highlight text-green">
                                    {safeToMiss} {safeToMiss === 1 ? "class" : "classes"}
                                </span>
                                <p className="stats-target-desc">
                                    You can safely miss up to <strong>{safeToMiss}</strong> more {safeToMiss === 1 ? "class" : "classes"} while maintaining 75% attendance.
                                </p>
                            </div>
                        ) : (
                            <div>
                                <span className="stats-target-highlight text-amber">
                                    +{neededToReach75} {neededToReach75 === 1 ? "class" : "classes"}
                                </span>
                                <p className="stats-target-desc">
                                    Attend the next <strong>{neededToReach75}</strong> consecutive {neededToReach75 === 1 ? "class" : "classes"} without absence to reach 75%.
                                </p>
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
                </div>

                {subjectStats.length === 0 ? (
                    <div className="stats-empty-state">
                        <FaBookOpen className="stats-empty-icon" />
                        <p>No course attendance recorded yet.</p>
                    </div>
                ) : (
                    <div className="stats-subjects-grid">
                        {subjectStats.map((item, idx) => (
                            <div key={idx} className="stats-subject-item">
                                <div className="stats-subject-top">
                                    <div className="stats-subject-title">
                                        <FaBookOpen className="stats-subject-icon" />
                                        <h3>{item.course}</h3>
                                    </div>
                                    <span
                                        className={`stats-subject-badge ${
                                            item.percentage >= 75
                                                ? "status-safe"
                                                : item.percentage >= 65
                                                ? "status-warning"
                                                : "status-danger"
                                        }`}
                                    >
                                        {item.percentage}%
                                    </span>
                                </div>

                                <div className="stats-subject-meter">
                                    <div
                                        className="stats-subject-fill"
                                        style={{
                                            width: `${Math.min(item.percentage, 100)}%`,
                                            backgroundColor:
                                                item.percentage >= 75
                                                    ? "#10b981"
                                                    : item.percentage >= 65
                                                    ? "#f59e0b"
                                                    : "#ef4444"
                                        }}
                                    />
                                </div>

                                <div className="stats-subject-footer">
                                    <span>
                                        Attended: <strong>{item.attended}</strong> / {item.total}
                                    </span>
                                    <span className="stats-subject-status-text">
                                        {item.percentage >= 75 ? "Eligible" : "At Risk"}
                                    </span>
                                </div>
                            </div>
                        ))}
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
                                <option value="all">All Courses</option>
                                {subjectStats.map((s, idx) => (
                                    <option key={idx} value={s.course}>
                                        {s.course}
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
                                        Date & Time <SortIcon config={sortConfig} columnKey="submittedAt" />
                                    </th>
                                    <th onClick={() => requestSort("courseCode")}>
                                        Course Code <SortIcon config={sortConfig} columnKey="courseCode" />
                                    </th>
                                    <th onClick={() => requestSort("classCode")}>
                                        Class <SortIcon config={sortConfig} columnKey="classCode" />
                                    </th>
                                    <th onClick={() => requestSort("roomNo")}>
                                        Room No <SortIcon config={sortConfig} columnKey="roomNo" />
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
                                            <td>{r.classCode || "N/A"}</td>
                                            <td>{r.roomNo || "N/A"}</td>
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
