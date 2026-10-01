import React, { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  collection,
  getDocs,
  onSnapshot,
  query
} from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../authcontext";
import { exportMasterAttendanceMatrix } from "../../DownloadExcel";
import { mergeAllStudentRecords } from "../../utils/studentDataHelper";
import StudentDetailModal from "./StudentDetailModal";
import {
  FaSearch,
  FaFileExcel,
  FaFilter,
  FaSort,
  FaSortUp,
  FaSortDown,
  FaSortAmountDown,
  FaSortAmountUp,
  FaCheckCircle,
  FaExclamationTriangle,
  FaUserGraduate,
  FaChalkboardTeacher,
  FaCalendarAlt,
  FaLayerGroup,
  FaBookOpen,
  FaSpinner,
  FaUsers,
  FaRedo,
  FaCheck,
  FaTimes
} from "react-icons/fa";
import "./MasterAttendanceMatrix.css";

function getStudentSortLabel(config, sessions) {
  if (!config) return "Roll Number (A-Z)";
  if (config.key?.startsWith("session_")) {
    const sId = config.key.replace("session_", "");
    const targetSess = sessions.find((s) => s.id === sId);
    const dateLabel = targetSess?.createdAt
      ? new Date(targetSess.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : "Selected Class";
    return `${dateLabel} (${targetSess?.classCode || "Class"}) Turnout (${config.direction === "desc" ? "Present first" : "Absent first"})`;
  }
  switch (config.key) {
    case "percentage":
      return `Attendance % (${config.direction === "desc" ? "Highest first: 100% → 0%" : "Lowest first: 0% → 100%"})`;
    case "attendedCount":
      return `Classes Attended (${config.direction === "desc" ? "Most to least" : "Least to most"})`;
    case "attendedHours":
      return `Lecture Hours (${config.direction === "desc" ? "Most to least" : "Least to most"})`;
    case "name":
      return `Student Name (${config.direction === "asc" ? "A → Z" : "Z → A"})`;
    case "rollNo":
    default:
      return `Roll Number (${config.direction === "asc" ? "A → Z" : "Z → A"})`;
  }
}

export default function MasterAttendanceMatrix({
  preselectedCourseCode = "",
  preselectedBatch = "",
  standalone = true,
  role = null
}) {
  const { user, profile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentRole = (role || profile?.role || "lecturer").toLowerCase();
  const isAdmin = currentRole === "admin" || currentRole === "administrator" || currentRole === "superadmin";

  const [loading, setLoading] = useState(true);
  const [allSessions, setAllSessions] = useState([]);
  const [allRecords, setAllRecords] = useState([]);
  const [allStudents, setAllStudents] = useState([]);
  const [allCourses, setAllCourses] = useState([]);

  // URL Query Sync
  const initialCourseFromUrl = searchParams.get("course") || preselectedCourseCode || "ALL";
  const initialBatchFromUrl = searchParams.get("batch") || preselectedBatch || "ALL";

  // Filters & Search
  const [selectedCourse, setSelectedCourse] = useState(initialCourseFromUrl);
  const [selectedBatch, setSelectedBatch] = useState(initialBatchFromUrl);
  const [selectedSemester, setSelectedSemester] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [eligibilityFilter, setEligibilityFilter] = useState("ALL"); // "ALL", "ELIGIBLE", "SHORTAGE", "CRITICAL"
  const [selectedStudentForModal, setSelectedStudentForModal] = useState(null);

  // Sorting State
  // 1. Session columns sort mode: "most_attended" | "least_attended" | "newest" | "oldest"
  const [sessionSortMode, setSessionSortMode] = useState("newest");

  // 2. Student rows sort config: key: "percentage" | "attendedCount" | "attendedHours" | "rollNo" | "name" | `session_${id}`
  const [studentSortConfig, setStudentSortConfig] = useState({
    key: "rollNo",
    direction: "asc"
  });

  // Sync with searchParams changes
  useEffect(() => {
    const urlCourse = searchParams.get("course");
    if (urlCourse) {
      setSelectedCourse(urlCourse.toUpperCase().trim());
    }
    const urlBatch = searchParams.get("batch");
    if (urlBatch) {
      setSelectedBatch(urlBatch.trim());
    }
  }, [searchParams]);

  // 1. Fetch & Listen to Firestore data in real-time
  useEffect(() => {
    let isMounted = true;
    let unsubSessions = () => {};
    let unsubRecords = () => {};

    const loadData = async () => {
      try {
        setLoading(true);

        // Fetch students & courses reference datasets
        const [studentsSnap, authUsersSnap, usersSnap, coursesSnap] = await Promise.all([
          getDocs(collection(db, "students")).catch(() => ({ docs: [] })),
          getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] })),
          getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
          getDocs(collection(db, "courses")).catch(() => ({ docs: [] }))
        ]);

        if (!isMounted) return;

        // Build comprehensive student list
        const mergedStudents = mergeAllStudentRecords(
          studentsSnap.docs,
          authUsersSnap.docs,
          usersSnap.docs
        );
        setAllStudents(mergedStudents);

        // Courses list
        const coursesList = coursesSnap.docs.map((d) => ({
          id: d.id,
          ...d.data()
        }));
        setAllCourses(coursesList);

        // Real-time listener on attendance_sessions
        unsubSessions = onSnapshot(collection(db, "attendance_sessions"), (sessSnap) => {
          if (!isMounted) return;
          const sessList = sessSnap.docs.map((d) => {
            const data = d.data();
            let createdAtMs = Date.now();
            if (typeof data.createdAt === "number") createdAtMs = data.createdAt;
            else if (data.createdAt?.toMillis) createdAtMs = data.createdAt.toMillis();
            else if (data.createdAt?.seconds) createdAtMs = data.createdAt.seconds * 1000;
            else if (typeof data.timestamp === "number") createdAtMs = data.timestamp;

            return {
              id: d.id,
              ...data,
              createdAt: createdAtMs,
              courseCode: (data.courseCode || data.classCode || "").toUpperCase().trim(),
              durationHours: Number(data.durationHours) || Number(data.hours) || Number(data.lectureHours) || 1.0
            };
          });
          setAllSessions(sessList);
        });

        // Real-time listener on attendance_records
        unsubRecords = onSnapshot(collection(db, "attendance_records"), (recSnap) => {
          if (!isMounted) return;
          const recList = recSnap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              ...data,
              rollNo: String(data.rollNo || data.rollNumber || "").trim().toUpperCase(),
              sessionId: String(data.sessionId || data.session_id || "").trim()
            };
          });
          setAllRecords(recList);
          setLoading(false);
        });
      } catch (err) {
        console.error("Error loading master attendance datasets:", err);
        if (isMounted) setLoading(false);
      }
    };

    loadData();

    return () => {
      isMounted = false;
      unsubSessions();
      unsubRecords();
    };
  }, []);

  // 2. Build fast lookup Attendance Matrix Map: `${rollNo}_${sessionId}` -> boolean
  const { matrixMap, attendeeCountsPerSession } = useMemo(() => {
    const map = new Map();
    const counts = new Map();

    allRecords.forEach((rec) => {
      const roll = rec.rollNo;
      const sessId = rec.sessionId;
      if (roll && sessId) {
        const key1 = `${roll}_${sessId}`;
        if (!map.has(key1)) {
          map.set(key1, true);
          map.set(`${roll.toLowerCase()}_${sessId}`, true);
          counts.set(sessId, (counts.get(sessId) || 0) + 1);
        }
      }
    });

    // Also check attendees arrays embedded directly in sessions if any records were omitted
    allSessions.forEach((sess) => {
      if (Array.isArray(sess.attendees)) {
        sess.attendees.forEach((att) => {
          const roll = String(att.rollNo || att.rollNumber || (typeof att === "string" ? att : "")).trim().toUpperCase();
          if (roll) {
            const key1 = `${roll}_${sess.id}`;
            if (!map.has(key1)) {
              map.set(key1, true);
              map.set(`${roll.toLowerCase()}_${sess.id}`, true);
              counts.set(sess.id, (counts.get(sess.id) || 0) + 1);
            }
          }
        });
      }
    });

    return { matrixMap: map, attendeeCountsPerSession: counts };
  }, [allRecords, allSessions]);

  // 3. Filter & Sort Session Columns
  const filteredSessions = useMemo(() => {
    return allSessions
      .filter((sess) => {
        // Course filter
        if (selectedCourse !== "ALL") {
          const cCodeUpper = selectedCourse.toUpperCase().trim();
          const matchCourse =
            sess.courseCode?.toUpperCase().trim() === cCodeUpper ||
            sess.classCode?.toUpperCase().trim() === cCodeUpper;
          if (!matchCourse) return false;
        }

        // Batch filter
        if (selectedBatch !== "ALL") {
          const sBatch = String(sess.batch || "").trim();
          if (sBatch && sBatch !== selectedBatch) return false;
        }

        // Lecturer filter if not admin
        if (!isAdmin && user?.email) {
          const isOwner =
            sess.ownerId === user.uid ||
            (sess.ownerEmail && sess.ownerEmail.toLowerCase() === user.email.toLowerCase()) ||
            (sess.lecturerEmail && sess.lecturerEmail.toLowerCase() === user.email.toLowerCase());
          // If no specific owner is recorded, allow matching course
          if (!isOwner && sess.ownerEmail) return false;
        }

        return true;
      })
      .sort((a, b) => {
        const countA = attendeeCountsPerSession.get(a.id) || 0;
        const countB = attendeeCountsPerSession.get(b.id) || 0;

        if (sessionSortMode === "most_attended") {
          // Sort columns with largest turnout first
          if (countB !== countA) return countB - countA;
          return (b.createdAt || 0) - (a.createdAt || 0);
        } else if (sessionSortMode === "least_attended") {
          // Sort columns with least turnout first
          if (countA !== countB) return countA - countB;
          return (a.createdAt || 0) - (b.createdAt || 0);
        } else if (sessionSortMode === "oldest") {
          // Oldest first (chronological Aug 3, Aug 4...)
          return (a.createdAt || 0) - (b.createdAt || 0);
        } else {
          // Newest first
          return (b.createdAt || 0) - (a.createdAt || 0);
        }
      });
  }, [allSessions, selectedCourse, selectedBatch, sessionSortMode, isAdmin, user, attendeeCountsPerSession]);

  // 4. Calculate Attendance and Percentages for each Student
  const processedStudents = useMemo(() => {
    const totalSessionsCount = filteredSessions.length;
    const totalLectureHours = filteredSessions.reduce(
      (acc, s) => acc + (Number(s.durationHours) || 1.0),
      0
    );

    return allStudents
      .filter((stud) => {
        // Filter by batch
        if (selectedBatch !== "ALL") {
          const b = String(stud.batch || "").trim();
          if (b && b !== selectedBatch) return false;
        }

        // Filter by semester
        if (selectedSemester !== "ALL") {
          const sem = String(stud.semester || "").trim();
          if (sem && sem !== selectedSemester) return false;
        }

        // Search Query
        if (searchQuery.trim()) {
          const query = searchQuery.toLowerCase().trim();
          const name = String(stud.name || stud.fullName || "").toLowerCase();
          const roll = String(stud.rollNo || stud.id || "").toLowerCase();
          if (!name.includes(query) && !roll.includes(query)) return false;
        }

        return true;
      })
      .map((stud) => {
        const cleanRoll = String(stud.rollNo || stud.id || "").trim().toUpperCase();
        let attendedCount = 0;
        let attendedHours = 0;

        filteredSessions.forEach((sess) => {
          const isPresent = Boolean(
            matrixMap.get(`${cleanRoll}_${sess.id}`) ||
            matrixMap.get(`${cleanRoll.toLowerCase()}_${sess.id}`)
          );

          if (isPresent) {
            attendedCount += 1;
            attendedHours += Number(sess.durationHours) || 1.0;
          }
        });

        const percentage = totalSessionsCount > 0 ? Math.round((attendedCount / totalSessionsCount) * 100) : 0;

        return {
          ...stud,
          rollNo: cleanRoll,
          name: stud.name || stud.fullName || cleanRoll,
          attendedCount,
          attendedHours,
          totalSessionsCount,
          totalLectureHours,
          percentage
        };
      })
      .filter((stud) => {
        // Eligibility filter
        if (eligibilityFilter === "ELIGIBLE") return stud.percentage >= 75;
        if (eligibilityFilter === "SHORTAGE") return stud.percentage < 75;
        if (eligibilityFilter === "CRITICAL") return stud.percentage < 60;
        return true;
      });
  }, [allStudents, filteredSessions, matrixMap, selectedBatch, selectedSemester, searchQuery, eligibilityFilter]);

  // 5. Apply Comprehensive Sorting to Student Rows
  const sortedStudents = useMemo(() => {
    const list = [...processedStudents];
    const { key, direction } = studentSortConfig;

    list.sort((a, b) => {
      // 1. Session column specific sort (Present '1's first vs Absent '0's first)
      if (key && key.startsWith("session_")) {
        const sessId = key.replace("session_", "");
        const isPresentA = Boolean(
          matrixMap.get(`${a.rollNo}_${sessId}`) ||
          matrixMap.get(`${a.rollNo.toLowerCase()}_${sessId}`)
        );
        const isPresentB = Boolean(
          matrixMap.get(`${b.rollNo}_${sessId}`) ||
          matrixMap.get(`${b.rollNo.toLowerCase()}_${sessId}`)
        );

        if (isPresentA !== isPresentB) {
          return direction === "desc"
            ? (isPresentB ? 1 : 0) - (isPresentA ? 1 : 0)
            : (isPresentA ? 1 : 0) - (isPresentB ? 1 : 0);
        }
        // Secondary sort by rollNo
        return a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true, sensitivity: "base" });
      }

      // 2. Attendance percentage sort
      if (key === "percentage") {
        if (a.percentage !== b.percentage) {
          return direction === "asc" ? a.percentage - b.percentage : b.percentage - a.percentage;
        }
        if (a.attendedCount !== b.attendedCount) {
          return direction === "asc" ? a.attendedCount - b.attendedCount : b.attendedCount - a.attendedCount;
        }
        return a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true, sensitivity: "base" });
      }

      // 3. Attended count sort
      if (key === "attendedCount") {
        if (a.attendedCount !== b.attendedCount) {
          return direction === "asc" ? a.attendedCount - b.attendedCount : b.attendedCount - a.attendedCount;
        }
        return a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true, sensitivity: "base" });
      }

      // 4. Attended hours sort
      if (key === "attendedHours") {
        if (a.attendedHours !== b.attendedHours) {
          return direction === "asc" ? a.attendedHours - b.attendedHours : b.attendedHours - a.attendedHours;
        }
        return a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true, sensitivity: "base" });
      }

      // 5. Name sort
      if (key === "name") {
        const comp = (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
        return direction === "asc" ? comp : -comp;
      }

      // 6. Roll Number sort (default)
      const comp = a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true, sensitivity: "base" });
      return direction === "asc" ? comp : -comp;
    });

    return list;
  }, [processedStudents, studentSortConfig, matrixMap]);

  // Handler for column header clicks
  const handleStudentSort = (key, defaultDirection = "desc") => {
    setStudentSortConfig((prev) => {
      if (prev.key === key) {
        return {
          key,
          direction: prev.direction === "asc" ? "desc" : "asc"
        };
      }
      return {
        key,
        direction: (key === "rollNo" || key === "name") ? "asc" : defaultDirection
      };
    });
  };

  // 6. Aggregate Summary Statistics
  const summaryStats = useMemo(() => {
    const totalStudentsCount = sortedStudents.length;
    const totalSessionsCount = filteredSessions.length;
    const totalHours = filteredSessions.reduce((acc, s) => acc + (Number(s.durationHours) || 1.0), 0);

    const eligibleCount = sortedStudents.filter((s) => s.percentage >= 75).length;
    const shortageCount = sortedStudents.filter((s) => s.percentage < 75).length;
    const avgPct =
      totalStudentsCount > 0
        ? Math.round(sortedStudents.reduce((acc, s) => acc + s.percentage, 0) / totalStudentsCount)
        : 0;

    return {
      totalStudents: totalStudentsCount,
      totalSessions: totalSessionsCount,
      totalHours: totalHours.toFixed(1),
      eligibleCount,
      shortageCount,
      averagePercentage: avgPct
    };
  }, [sortedStudents, filteredSessions]);

  // 7. Handle Master Excel Export (Exports cleanly with exact current sorted order)
  const handleExportExcel = () => {
    if (sortedStudents.length === 0) {
      alert("No student attendance data found to export.");
      return;
    }

    const courseObj = allCourses.find((c) => c.courseCode === selectedCourse) || {};
    const courseTitle = selectedCourse === "ALL" ? "All Courses Combined" : `${selectedCourse} - ${courseObj.courseName || "Class"}`;

    exportMasterAttendanceMatrix({
      courseName: courseTitle,
      courseCode: selectedCourse === "ALL" ? "ALL-CLASSES" : selectedCourse,
      batch: selectedBatch === "ALL" ? "" : selectedBatch,
      sessions: filteredSessions,
      students: sortedStudents,
      matrixMap: matrixMap,
      filename: `Master-Attendance-Matrix-${selectedCourse}-${new Date().toISOString().slice(0, 10)}`
    });
  };

  const isCustomSorted =
    studentSortConfig.key !== "rollNo" ||
    studentSortConfig.direction !== "asc" ||
    sessionSortMode !== "newest";

  if (loading) {
    return (
      <div className="matrix-container" style={{ textAlign: "center", padding: "4rem 1rem" }}>
        <FaSpinner className="fa-spin" style={{ fontSize: "2.5rem", color: "#6366f1", marginBottom: "12px" }} />
        <h3 style={{ margin: 0, color: "var(--text-main, #0f172a)" }}>Loading Master Attendance Sheet...</h3>
        <p style={{ margin: "4px 0 0", color: "var(--text-muted, #64748b)" }}>Aggregating multi-class records &amp; attendance matrix...</p>
      </div>
    );
  }

  return (
    <div className="matrix-container">
      {/* Header Bar */}
      <div className="matrix-header-bar">
        <div>
          <h2 className="matrix-header-title">
            <FaLayerGroup style={{ color: "#6366f1" }} /> Master Attendance Sheet &amp; Class Matrix
          </h2>
          <p className="matrix-header-desc">
            Consolidated multi-class matrix with interactive sorting by student attendance percentages, class turnout, and session marks.
          </p>
        </div>

        <div className="matrix-actions-group">
          <button
            type="button"
            className="matrix-btn-export"
            onClick={handleExportExcel}
            disabled={sortedStudents.length === 0}
            title="Download Clean Master Excel Sheet in current sorted order"
          >
            <FaFileExcel />
            <span>Download Master Excel (.xlsx)</span>
          </button>
        </div>
      </div>

      {/* Top Summary Stats Cards */}
      <div className="matrix-stats-grid">
        <div className="matrix-stat-card blue">
          <div className="matrix-stat-val">{summaryStats.totalSessions}</div>
          <div className="matrix-stat-lbl">Classes / Sessions Held</div>
        </div>

        <div className="matrix-stat-card emerald">
          <div className="matrix-stat-val">{summaryStats.totalHours} hrs</div>
          <div className="matrix-stat-lbl">Total Lecture Hours</div>
        </div>

        <div className="matrix-stat-card">
          <div className="matrix-stat-val">{summaryStats.totalStudents}</div>
          <div className="matrix-stat-lbl">Enrolled Students</div>
        </div>

        <div className="matrix-stat-card emerald">
          <div className="matrix-stat-val">{summaryStats.averagePercentage}%</div>
          <div className="matrix-stat-lbl">Average Class Attendance</div>
        </div>

        <div className="matrix-stat-card emerald">
          <div className="matrix-stat-val" style={{ color: "#059669" }}>{summaryStats.eligibleCount}</div>
          <div className="matrix-stat-lbl">Eligible (≥ 75%)</div>
        </div>

        <div className="matrix-stat-card rose">
          <div className="matrix-stat-val" style={{ color: "#dc2626" }}>{summaryStats.shortageCount}</div>
          <div className="matrix-stat-lbl">Shortage (&lt; 75%)</div>
        </div>
      </div>

      {/* Filter & Search Toolbar */}
      <div className="matrix-toolbar">
        {/* Search */}
        <div className="matrix-search-box">
          <FaSearch />
          <input
            type="text"
            className="matrix-search-input"
            placeholder="Search student by name or roll number..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Course Filter */}
        <select
          className="matrix-select"
          value={selectedCourse}
          onChange={(e) => {
            const val = e.target.value;
            setSelectedCourse(val);
            const newParams = new URLSearchParams(searchParams);
            if (val !== "ALL") newParams.set("course", val);
            else newParams.delete("course");
            setSearchParams(newParams);
          }}
          title="Filter by Course"
        >
          <option value="ALL">📚 All Courses Combined</option>
          {allCourses.map((c) => {
            const code = c.code || c.courseCode || c.id;
            const name = c.name || c.courseName || code;
            return (
              <option key={c.id} value={code}>
                {code} - {name}
              </option>
            );
          })}
        </select>

        {/* Batch Filter */}
        <select
          className="matrix-select"
          value={selectedBatch}
          onChange={(e) => setSelectedBatch(e.target.value)}
          title="Filter by Batch"
        >
          <option value="ALL">🎓 All Batches</option>
          <option value="2025">Batch 2025</option>
          <option value="2024">Batch 2024</option>
          <option value="2023">Batch 2023</option>
        </select>

        {/* Semester Filter */}
        <select
          className="matrix-select"
          value={selectedSemester}
          onChange={(e) => setSelectedSemester(e.target.value)}
          title="Filter by Semester"
        >
          <option value="ALL">📑 All Semesters</option>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
            <option key={s} value={String(s)}>
              Semester {s}
            </option>
          ))}
        </select>

        {/* Eligibility Filter */}
        <select
          className="matrix-select"
          value={eligibilityFilter}
          onChange={(e) => setEligibilityFilter(e.target.value)}
          title="Filter by Attendance Eligibility"
        >
          <option value="ALL">👥 All Students</option>
          <option value="ELIGIBLE">✅ Eligible Only (≥ 75%)</option>
          <option value="SHORTAGE">⚠️ Shortage (&lt; 75%)</option>
          <option value="CRITICAL">🚨 Critical Shortage (&lt; 60%)</option>
        </select>

        {/* Quick Sort Students Dropdown */}
        <div className="matrix-sort-control-group">
          <label className="matrix-control-label">Sort Students:</label>
          <select
            className="matrix-select matrix-sort-select"
            value={
              studentSortConfig.key?.startsWith("session_")
                ? "SESSION_CUSTOM"
                : `${studentSortConfig.key}_${studentSortConfig.direction}`
            }
            onChange={(e) => {
              const val = e.target.value;
              if (val === "SESSION_CUSTOM") return;
              const [k, d] = val.split("_");
              setStudentSortConfig({ key: k, direction: d });
            }}
            title="Sort students in sheet"
          >
            <option value="percentage_desc">🏆 Attendance % (Highest First: 100% → 0%)</option>
            <option value="percentage_asc">⚠️ Attendance % (Lowest First: 0% → 100%)</option>
            <option value="attendedCount_desc">📚 Most Classes Attended</option>
            <option value="attendedHours_desc">⏱️ Most Lecture Hours</option>
            <option value="rollNo_asc">🔢 Roll Number (A → Z)</option>
            <option value="rollNo_desc">🔢 Roll Number (Z → A)</option>
            <option value="name_asc">👤 Student Name (A → Z)</option>
            <option value="name_desc">👤 Student Name (Z → A)</option>
            {studentSortConfig.key?.startsWith("session_") && (
              <option value="SESSION_CUSTOM" disabled>
                📍 Sorted by Class Column
              </option>
            )}
          </select>
        </div>

        {/* Quick Sort Session Columns Dropdown */}
        <div className="matrix-sort-control-group">
          <label className="matrix-control-label">Sort Classes:</label>
          <select
            className="matrix-select matrix-sort-select"
            value={sessionSortMode}
            onChange={(e) => setSessionSortMode(e.target.value)}
            title="Sort class date columns"
          >
            <option value="most_attended">👥 Most Students Appeared (Highest Turnout)</option>
            <option value="least_attended">📉 Least Students Appeared (Lowest Turnout)</option>
            <option value="newest">📅 Newest Classes First</option>
            <option value="oldest">📅 Oldest Classes First (Chronological)</option>
          </select>
        </div>
      </div>

      {/* Active Sort Status & Quick Reset Banner */}
      {isCustomSorted && (
        <div className="matrix-sort-indicator-bar">
          <div className="matrix-sort-indicator-text">
            <span>
              <strong>Students:</strong>{" "}
              <span className="matrix-sort-badge">
                {getStudentSortLabel(studentSortConfig, filteredSessions)}
              </span>
            </span>
            <span className="matrix-sort-indicator-divider">•</span>
            <span>
              <strong>Classes:</strong>{" "}
              <span className="matrix-sort-badge">
                {sessionSortMode === "most_attended"
                  ? "👥 Most Students Appeared (Highest Turnout)"
                  : sessionSortMode === "least_attended"
                  ? "📉 Least Students Appeared (Lowest Turnout)"
                  : sessionSortMode === "oldest"
                  ? "📅 Oldest Classes First (Chronological)"
                  : "📅 Newest Classes First"}
              </span>
            </span>
          </div>

          <button
            type="button"
            className="matrix-reset-sort-btn"
            onClick={() => {
              setStudentSortConfig({ key: "rollNo", direction: "asc" });
              setSessionSortMode("newest");
            }}
            title="Reset sorting to default (Roll Number A-Z, Newest Classes First)"
          >
            <FaRedo style={{ fontSize: "0.75rem" }} /> Reset Sorting
          </button>
        </div>
      )}

      {/* Main Multi-Session Matrix Table */}
      {filteredSessions.length === 0 ? (
        <div className="matrix-table-wrapper matrix-empty-state">
          <div className="matrix-empty-icon">📅</div>
          <h3 style={{ margin: "0 0 6px", color: "var(--text-main, #0f172a)" }}>
            No Attendance Sessions Found
          </h3>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>
            {selectedCourse !== "ALL"
              ? `No sessions recorded for course "${selectedCourse}". Generate a QR session to start recording attendance.`
              : "No attendance sessions have been created yet."}
          </p>
        </div>
      ) : sortedStudents.length === 0 ? (
        <div className="matrix-table-wrapper matrix-empty-state">
          <div className="matrix-empty-icon">🔍</div>
          <h3 style={{ margin: "0 0 6px", color: "var(--text-main, #0f172a)" }}>
            No Matching Students Found
          </h3>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>
            No students matched your search query or selected eligibility filter.
          </p>
        </div>
      ) : (
        <div className="matrix-table-wrapper">
          <table className="matrix-table" id="master-attendance-matrix-table">
            <thead>
              {/* Row 1: Main Headers with Click-to-Sort */}
              <tr>
                <th
                  className="matrix-freeze-col-1 matrix-th-sortable"
                  onClick={() => handleStudentSort("rollNo", "asc")}
                  title="Click to reset sort to default"
                >
                  #
                </th>

                <th
                  className={`matrix-freeze-col-2 matrix-th-sortable ${studentSortConfig.key === "rollNo" ? "matrix-th-active-sort" : ""}`}
                  onClick={() => handleStudentSort("rollNo", "asc")}
                  title="Click to sort by Roll Number"
                >
                  <div className="matrix-th-flex">
                    <span>Roll No</span>
                    <span className="matrix-th-sort-icon">
                      {studentSortConfig.key === "rollNo" ? (
                        studentSortConfig.direction === "asc" ? <FaSortUp /> : <FaSortDown />
                      ) : (
                        <FaSort />
                      )}
                    </span>
                  </div>
                </th>

                <th
                  className={`matrix-freeze-col-3 matrix-th-sortable ${studentSortConfig.key === "name" ? "matrix-th-active-sort" : ""}`}
                  onClick={() => handleStudentSort("name", "asc")}
                  title="Click to sort alphabetically by Student Name"
                >
                  <div className="matrix-th-flex">
                    <span>Student Name</span>
                    <span className="matrix-th-sort-icon">
                      {studentSortConfig.key === "name" ? (
                        studentSortConfig.direction === "asc" ? <FaSortUp /> : <FaSortDown />
                      ) : (
                        <FaSort />
                      )}
                    </span>
                  </div>
                </th>

                <th
                  className={`matrix-th-sortable ${studentSortConfig.key === "attendedCount" ? "matrix-th-active-sort" : ""}`}
                  onClick={() => handleStudentSort("attendedCount", "desc")}
                  style={{ minWidth: "95px", textAlign: "center" }}
                  title="Click to sort by number of classes attended"
                >
                  <div className="matrix-th-flex" style={{ justifyContent: "center" }}>
                    <span>Attended</span>
                    <span className="matrix-th-sort-icon">
                      {studentSortConfig.key === "attendedCount" ? (
                        studentSortConfig.direction === "asc" ? <FaSortUp /> : <FaSortDown />
                      ) : (
                        <FaSort />
                      )}
                    </span>
                  </div>
                </th>

                <th
                  className={`matrix-th-sortable ${studentSortConfig.key === "attendedHours" ? "matrix-th-active-sort" : ""}`}
                  onClick={() => handleStudentSort("attendedHours", "desc")}
                  style={{ minWidth: "95px", textAlign: "center" }}
                  title="Click to sort by total lecture hours attended"
                >
                  <div className="matrix-th-flex" style={{ justifyContent: "center" }}>
                    <span>Lecture Hrs</span>
                    <span className="matrix-th-sort-icon">
                      {studentSortConfig.key === "attendedHours" ? (
                        studentSortConfig.direction === "asc" ? <FaSortUp /> : <FaSortDown />
                      ) : (
                        <FaSort />
                      )}
                    </span>
                  </div>
                </th>

                <th
                  className={`matrix-th-sortable ${studentSortConfig.key === "percentage" ? "matrix-th-active-sort" : ""}`}
                  onClick={() => handleStudentSort("percentage", "desc")}
                  style={{ minWidth: "110px", textAlign: "center" }}
                  title="Click to sort by Attendance Percentage (%)"
                >
                  <div className="matrix-th-flex" style={{ justifyContent: "center" }}>
                    <span>Attendance %</span>
                    <span className="matrix-th-sort-icon">
                      {studentSortConfig.key === "percentage" ? (
                        studentSortConfig.direction === "asc" ? <FaSortUp /> : <FaSortDown />
                      ) : (
                        <FaSort />
                      )}
                    </span>
                  </div>
                </th>

                {/* Session Date Columns */}
                {filteredSessions.map((sess) => {
                  const dateObj = sess.createdAt ? new Date(sess.createdAt) : new Date();
                  const dateLabel = dateObj.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric"
                  });
                  const isSortedThisSession = studentSortConfig.key === `session_${sess.id}`;
                  const count = attendeeCountsPerSession.get(sess.id) || 0;

                  return (
                    <th
                      key={sess.id}
                      className={`matrix-cell-session matrix-th-sortable ${isSortedThisSession ? "matrix-th-active-sort" : ""}`}
                      onClick={() => handleStudentSort(`session_${sess.id}`, "desc")}
                      title={`Class: ${sess.classCode} | Date: ${dateLabel} | Room: ${sess.roomNo || "N/A"}\n👥 ${count} students appeared.\n👉 Click to sort students who attended this class on top!`}
                    >
                      <div className="matrix-session-th-title">
                        {dateLabel}
                        {isSortedThisSession && (
                          <span className="matrix-session-sort-indicator">
                            {studentSortConfig.direction === "desc" ? "▼" : "▲"}
                          </span>
                        )}
                      </div>
                      <div className="matrix-session-th-code">{sess.classCode || sess.courseCode}</div>
                    </th>
                  );
                })}
              </tr>

              {/* Row 2: Sub-info / Weight / Duration / Students Appeared Count */}
              <tr className="matrix-subhead-row">
                <th className="matrix-freeze-col-1">—</th>
                <th className="matrix-freeze-col-2">—</th>
                <th className="matrix-freeze-col-3">Total Classes: {filteredSessions.length}</th>
                <th style={{ textAlign: "center" }}>{summaryStats.totalSessions} sessions</th>
                <th style={{ textAlign: "center" }}>{summaryStats.totalHours} hrs</th>
                <th style={{ textAlign: "center" }}>Target: 75%</th>

                {filteredSessions.map((sess) => {
                  const duration = Number(sess.durationHours) || 1.0;
                  const count = attendeeCountsPerSession.get(sess.id) || 0;
                  const totalEnrolled = sortedStudents.length;
                  const turnoutPct = totalEnrolled > 0 ? Math.round((count / totalEnrolled) * 100) : 0;

                  return (
                    <th
                      key={`sub_${sess.id}`}
                      className="matrix-cell-session matrix-subhead-session-th"
                      onClick={() => handleStudentSort(`session_${sess.id}`, "desc")}
                      title={`Turnout: ${count}/${totalEnrolled} students (${turnoutPct}%). Click to sort.`}
                      style={{ cursor: "pointer" }}
                    >
                      <span className="matrix-session-duration">{duration} hr</span>
                      <span className="matrix-session-turnout-pill" title={`${count} students appeared`}>
                        {count} present
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody>
              {sortedStudents.map((stud, idx) => {
                const pct = stud.percentage;
                const pctStatus = pct >= 75 ? "good" : pct >= 60 ? "warning" : "danger";

                return (
                  <tr key={stud.rollNo || idx}>
                    <td className="matrix-freeze-col-1" style={{ color: "var(--text-muted, #64748b)" }}>
                      {idx + 1}
                    </td>

                    <td className="matrix-freeze-col-2">
                      <span
                        className="matrix-roll-link"
                        onClick={() => setSelectedStudentForModal(stud)}
                        title="Click to view full student profile & history"
                      >
                        {stud.rollNo}
                      </span>
                    </td>

                    <td className="matrix-freeze-col-3" style={{ color: "var(--text-main, #0f172a)" }}>
                      {stud.name}
                    </td>

                    <td style={{ textAlign: "center", color: "var(--text-main, #334155)" }}>
                      <strong>{stud.attendedCount}</strong> / {stud.totalSessionsCount}
                    </td>

                    <td style={{ textAlign: "center", color: "var(--text-muted, #64748b)" }}>
                      {stud.attendedHours.toFixed(1)} hrs
                    </td>

                    <td style={{ textAlign: "center" }}>
                      <span className={`matrix-pct-pill ${pctStatus}`}>
                        {pct >= 75 ? "✓" : pct < 60 ? "!" : "•"} {pct}%
                      </span>
                    </td>

                    {/* Class Session Attendance Marks */}
                    {filteredSessions.map((sess) => {
                      const isPresent = Boolean(
                        matrixMap.get(`${stud.rollNo}_${sess.id}`) ||
                        matrixMap.get(`${stud.rollNo.toLowerCase()}_${sess.id}`)
                      );

                      return (
                        <td key={sess.id} className="matrix-cell-session">
                          {isPresent ? (
                            <span
                              className="matrix-mark-present"
                              title={`Present in ${sess.classCode} (${new Date(sess.createdAt).toLocaleDateString()})`}
                            >
                              1
                            </span>
                          ) : (
                            <span
                              className="matrix-mark-absent"
                              title={`Absent in ${sess.classCode} (${new Date(sess.createdAt).toLocaleDateString()})`}
                            >
                              0
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Student Profile Modal */}
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
