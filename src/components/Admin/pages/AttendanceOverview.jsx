import React, { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  FaSync,
  FaUserCheck,
  FaUserTimes,
  FaUserGraduate,
  FaSearch,
  FaCalendarCheck,
  FaCalendarAlt,
  FaChalkboard,
  FaEye,
  FaExclamationTriangle,
  FaShieldAlt,
  FaCheck,
  FaLayerGroup
} from "react-icons/fa";
import { collection, getDocs, onSnapshot } from "firebase/firestore";
import { db } from "../../../firebase";
import StudentDetailModal from "../../Common/StudentDetailModal";
import ViolationReviewModal from "../../Common/ViolationReviewModal";
import MasterAttendanceMatrix from "../../Common/MasterAttendanceMatrix";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import "./AttendanceOverview.css";
import { mergeAllStudentRecords, normalizeBranchName } from "../../../utils/studentDataHelper";

const AttendanceOverview = () => {
  const navigate = useNavigate();
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [activeViewTab, setActiveViewTab] = useState("overview"); // "overview" | "matrix"
  const [violationFilterTab, setViolationFilterTab] = useState("ALL"); // "ALL" | "PENDING" | "RESOLVED_PRESENT" | "RESOLVED_ABSENT"
  const [violationDateFilter, setViolationDateFilter] = useState("TODAY"); // "TODAY" | "ALL" | "YYYY-MM-DD"
  const [violationClassFilter, setViolationClassFilter] = useState("ALL"); // "ALL" | classCode
  const [availableClasses, setAvailableClasses] = useState([]);
  const [search, setSearch] = useState("");
  const [students, setStudents] = useState([]);
  const [recentSessions, setRecentSessions] = useState([]);
  const [flaggedViolations, setFlaggedViolations] = useState([]);
  const [selectedViolation, setSelectedViolation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [stats, setStats] = useState({
    totalStudents: 0,
    totalRecords: 0,
    totalSessions: 0,
    activeSessions: 0,
    averageAttendanceRate: 0,
    totalViolations: 0
  });

  const filteredViolationsByClassAndDate = useMemo(() => {
    return flaggedViolations.filter((v) => {
      // 1. Class / Course filter
      if (violationClassFilter !== "ALL") {
        const vClass = (v.classCode || "").toUpperCase().trim();
        const vCourse = (v.courseCode || "").toUpperCase().trim();
        const target = violationClassFilter.toUpperCase().trim();
        if (vClass !== target && vCourse !== target) {
          return false;
        }
      }

      // 2. Date filter (defaults to TODAY)
      const rawDate = v.timestamp || v.submittedAt || v.sessionDate || v.createdAt;
      if (violationDateFilter === "TODAY") {
        if (!rawDate) return true;
        const dStr = new Date(typeof rawDate === "string" ? rawDate : Number(rawDate)).toISOString().slice(0, 10);
        if (dStr !== todayStr) return false;
      } else if (violationDateFilter !== "ALL") {
        if (!rawDate) return false;
        const dStr = new Date(typeof rawDate === "string" ? rawDate : Number(rawDate)).toISOString().slice(0, 10);
        if (dStr !== violationDateFilter) return false;
      }

      return true;
    });
  }, [flaggedViolations, violationClassFilter, violationDateFilter, todayStr]);

  const pendingViolations = useMemo(() => {
    return filteredViolationsByClassAndDate.filter((v) => !v.isReviewed);
  }, [filteredViolationsByClassAndDate]);

  const resolvedPresentViolations = useMemo(() => {
    return filteredViolationsByClassAndDate.filter(
      (v) => v.isReviewed && (v.resolutionStatus === "RESOLVED_PRESENT" || v.status === "APPROVED" || v.excused === true)
    );
  }, [filteredViolationsByClassAndDate]);

  const resolvedAbsentViolations = useMemo(() => {
    return filteredViolationsByClassAndDate.filter(
      (v) => v.isReviewed && (v.resolutionStatus === "RESOLVED_ABSENT" || v.status === "REJECTED")
    );
  }, [filteredViolationsByClassAndDate]);

  const displayedViolations = useMemo(() => {
    if (violationFilterTab === "PENDING") return pendingViolations;
    if (violationFilterTab === "RESOLVED_PRESENT") return resolvedPresentViolations;
    if (violationFilterTab === "RESOLVED_ABSENT") return resolvedAbsentViolations;
    return filteredViolationsByClassAndDate;
  }, [violationFilterTab, pendingViolations, resolvedPresentViolations, resolvedAbsentViolations, filteredViolationsByClassAndDate]);

  const computeOverview = (authDocs, studentsDocs, usersDocs, sessionsDocs, recordsDocs, complaintsDocs = []) => {
    try {
      const totalSessionsCount = sessionsDocs.length;
      const totalRecordsCount = recordsDocs.length;

      // Extract distinct class/course codes for the filter dropdown
      const classCodesSet = new Set();
      sessionsDocs.forEach((sDoc) => {
        const s = typeof sDoc.data === "function" ? sDoc.data() : sDoc;
        if (s.classCode) classCodesSet.add(s.classCode);
        if (s.courseCode) classCodesSet.add(s.courseCode);
      });
      setAvailableClasses(Array.from(classCodesSet).sort());

      // 1. Gather all Flagged Violations (Records, Session arrays, and Security complaints)
      const violationsList = [];

      // A. Violations from attendance_records
      recordsDocs.forEach((docSnap) => {
        const d = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
        const isResolvedPresent = d.status === "APPROVED" || d.excused === true;
        const isResolvedAbsent = d.status === "REJECTED";
        const isDismissed = d.status === "DISMISSED" || d.dismissed === true;
        const isReviewedOrResolved =
          d.reviewed === true ||
          Boolean(d.reviewedByRole) ||
          Boolean(d.reviewedAt) ||
          isResolvedPresent ||
          isResolvedAbsent ||
          isDismissed ||
          d.flagged === false ||
          d.hasViolation === false ||
          d.status === "RESOLVED" ||
          d.status === "ATTENDED" ||
          d.status === "PRESENT";

        const isViolationRecord =
          d.status === "FLAGGED" ||
          d.status === "FLAGGED_DISQUALIFIED" ||
          d.status === "FLAGGED_WARNING" ||
          d.status === "VIOLATION" ||
          d.flagged === true ||
          d.hasViolation === true ||
          d.excused === true ||
          Boolean(d.excuseReason) ||
          Boolean(d.violationReason) ||
          Boolean(d.violationType);

        if (isViolationRecord) {
          const resStatus = isResolvedPresent
            ? "RESOLVED_PRESENT"
            : isResolvedAbsent
            ? "RESOLVED_ABSENT"
            : isDismissed
            ? "DISMISSED"
            : isReviewedOrResolved
            ? "RESOLVED"
            : "PENDING";

          violationsList.push({
            id: docSnap.id || d.id,
            isReviewed: isReviewedOrResolved,
            resolutionStatus: d.resolutionStatus || resStatus,
            timestamp: d.timestamp || d.submittedAt || d.createdAt || Date.now(),
            ...d
          });
        }
      });

      // B. Violations from attendance_sessions (s.flaggedViolations array)
      sessionsDocs.forEach((sDoc) => {
        const s = typeof sDoc.data === "function" ? sDoc.data() : sDoc;
        const sId = sDoc.id || s.id;
        if (Array.isArray(s.flaggedViolations)) {
          s.flaggedViolations.forEach((f, idx) => {
            const isResolvedPresent = f.resolutionStatus === "RESOLVED_PRESENT" || f.status === "APPROVED" || f.excused === true;
            const isResolvedAbsent = f.resolutionStatus === "RESOLVED_ABSENT" || f.status === "REJECTED";
            const isDismissed = f.resolutionStatus === "DISMISSED" || f.status === "DISMISSED" || f.dismissed === true;
            const isReviewed = f.reviewed === true || Boolean(f.reviewedAt) || Boolean(f.reviewedByName) || isResolvedPresent || isResolvedAbsent || isDismissed;

            const resStatus = isResolvedPresent
              ? "RESOLVED_PRESENT"
              : isResolvedAbsent
              ? "RESOLVED_ABSENT"
              : isDismissed
              ? "DISMISSED"
              : isReviewed
              ? "RESOLVED"
              : "PENDING";

            violationsList.push({
              id: f.id || `${sId}_${f.rollNo || idx}`,
              sessionId: sId,
              classCode: s.classCode || s.courseCode || "General",
              courseCode: s.courseCode || s.classCode || "General",
              lecturerName: s.lecturerName || "Faculty",
              sessionDate: s.createdAt,
              rollNo: f.rollNo || f.studentUid || "UNKNOWN",
              studentName: f.studentName || f.fullName || f.rollNo || "Unknown Student",
              violationReason: f.violationReason || f.violationType || f.reason || "App Switched or Screen Locked",
              timestamp: f.timestamp || f.occurredAt || s.createdAt || Date.now(),
              status: f.status || (isReviewed ? (isResolvedPresent ? "APPROVED" : isResolvedAbsent ? "REJECTED" : "DISMISSED") : "FLAGGED"),
              resolutionStatus: f.resolutionStatus || resStatus,
              isReviewed: isReviewed,
              reviewedByName: f.reviewedByName,
              reviewNotes: f.reviewNotes,
              ...f
            });
          });
        }
      });

      // C. Violations from security_complaints
      complaintsDocs.forEach((cSnap) => {
        const c = typeof cSnap.data === "function" ? cSnap.data() : cSnap;
        const isResolvedComplaint = c?.status === "RESOLVED" || c?.status === "DISMISSED" || c?.status === "CLOSED" || c?.resolved === true;
        if (c) {
          violationsList.push({
            id: cSnap.id || c.id,
            rollNo: c.rollNo || c.rollNumber || "UNKNOWN",
            studentName: c.userName || c.name || c.rollNo,
            classCode: c.context || "Security System",
            courseCode: c.context || "Security System",
            violationReason: c.reason || "Security verification flagged",
            timestamp: c.reportedAt || (c.timestamp ? new Date(c.timestamp).getTime() : Date.now()),
            status: c.status || (isResolvedComplaint ? "RESOLVED" : "OPEN_COMPLAINT"),
            resolutionStatus: isResolvedComplaint ? "DISMISSED" : "PENDING",
            isReviewed: isResolvedComplaint,
            ...c
          });
        }
      });

      // Deduplicate violations by ID or roll+timestamp
      const uniqueViolations = [];
      const seenViolIds = new Set();
      violationsList.forEach((v) => {
        const key = v.id || `${v.sessionId}_${v.rollNo}`;
        if (!seenViolIds.has(key)) {
          seenViolIds.add(key);
          uniqueViolations.push(v);
        }
      });
      uniqueViolations.sort((a, b) => (b.timestamp || b.submittedAt || 0) - (a.timestamp || a.submittedAt || 0));
      setFlaggedViolations(uniqueViolations);

      // Map unique attended session count per canonical Roll Number
      const studentAttendedSessionSet = new Map();

      recordsDocs.forEach((docSnap) => {
        const d = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
        const roll = d.rollNo;
        const sessionId = d.sessionId || (docSnap.id && docSnap.id.includes("_") ? docSnap.id.split("_")[0] : docSnap.id);
        if (roll && d.status !== "FLAGGED_DISQUALIFIED" && d.status !== "REJECTED") {
          const clean = roll.toUpperCase().trim();
          if (!studentAttendedSessionSet.has(clean)) {
            studentAttendedSessionSet.set(clean, new Set());
          }
          studentAttendedSessionSet.get(clean).add(sessionId || `rec_${Math.random()}`);
        }
      });

      sessionsDocs.forEach((docSnap) => {
        const s = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
        const sessionId = docSnap.id || s.id;
        if (Array.isArray(s.attendees)) {
          s.attendees.forEach((att) => {
            const roll = att.rollNo || att.rollNumber || (typeof att === "string" ? att : null);
            if (roll) {
              const clean = String(roll).toUpperCase().trim();
              if (!studentAttendedSessionSet.has(clean)) {
                studentAttendedSessionSet.set(clean, new Set());
              }
              studentAttendedSessionSet.get(clean).add(sessionId || `sess_${Math.random()}`);
            }
          });
        }
      });

      const attendanceCountMap = new Map();
      studentAttendedSessionSet.forEach((sessionSet, cleanRoll) => {
        attendanceCountMap.set(cleanRoll, sessionSet.size);
      });

      // Merge students across all collections via unified engine
      const canonicalStudents = mergeAllStudentRecords(authDocs, studentsDocs, usersDocs);

      // Map real students with attended count & attendance rate
      const studentList = canonicalStudents.map((data) => {
        const cleanRoll = (data.rollNo || "").toUpperCase().trim();
        const attended = attendanceCountMap.get(cleanRoll) || 0;
        const rate = totalSessionsCount > 0
          ? Math.min(100, Math.round((attended / totalSessionsCount) * 100))
          : 0;

        return {
          ...data,
          attendedCount: attended,
          attendanceRate: rate
        };
      });

      studentList.sort((a, b) => (b.attendedCount || 0) - (a.attendedCount || 0));

      // Sessions list from database
      const sessionsList = sessionsDocs.map((docSnap) => ({
        id: docSnap.id,
        ...(typeof docSnap.data === "function" ? docSnap.data() : docSnap)
      }));
      sessionsList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      // Active sessions right now
      const activeCount = sessionsList.filter(
        (s) => s.active === true && (s.expiresAt || 0) > Date.now()
      ).length;

      // Average rate across students
      const avgRate = studentList.length > 0
        ? Math.round(
          studentList.reduce((acc, s) => acc + s.attendanceRate, 0) / studentList.length
        )
        : 0;

      const pendingCount = uniqueViolations.filter((v) => !v.isReviewed).length;

      setStudents(studentList);
      setRecentSessions(sessionsList.slice(0, 6));
      setStats({
        totalStudents: studentList.length,
        totalRecords: Math.max(totalRecordsCount, studentAttendedSessionSet.size),
        totalSessions: totalSessionsCount,
        activeSessions: activeCount,
        averageAttendanceRate: avgRate,
        totalViolations: pendingCount,
        allViolationsCount: uniqueViolations.length
      });

      // Keep selected student modal state in sync with real-time updates
      setSelectedStudent((prevSelected) => {
        if (!prevSelected) return null;
        const fresh = studentList.find((s) =>
          (s.rollNo && prevSelected.rollNo && s.rollNo.toUpperCase().trim() === prevSelected.rollNo.toUpperCase().trim()) ||
          (s.email && prevSelected.email && s.email.toLowerCase().trim() === prevSelected.email.toLowerCase().trim()) ||
          (s.id && prevSelected.id && s.id === prevSelected.id)
        );
        return fresh ? { ...prevSelected, ...fresh } : prevSelected;
      });
    } catch (error) {
      console.error("Error computing attendance overview:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadAttendanceData = async () => {
    try {
      setLoading(true);
      const [authSnap, studentsSnap, usersSnap, sessionsSnap, recordsSnap, complaintsSnap] = await Promise.all([
        getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "students")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "attendance_sessions")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "attendance_records")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "security_complaints")).catch(() => ({ docs: [] }))
      ]);
      computeOverview(authSnap.docs, studentsSnap.docs, usersSnap.docs, sessionsSnap.docs, recordsSnap.docs, complaintsSnap.docs);
    } catch (err) {
      console.error("Error refreshing attendance data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let authDocs = [];
    let studentsDocs = [];
    let usersDocs = [];
    let sessionsDocs = [];
    let recordsDocs = [];
    let complaintsDocs = [];

    const recomputeOverview = () => {
      computeOverview(authDocs, studentsDocs, usersDocs, sessionsDocs, recordsDocs, complaintsDocs);
    };

    const unsubAuth = onSnapshot(collection(db, "authorizedUsers"), (snap) => {
      authDocs = snap.docs;
      recomputeOverview();
    }, () => {});

    const unsubStudents = onSnapshot(collection(db, "students"), (snap) => {
      studentsDocs = snap.docs;
      recomputeOverview();
    }, () => {});

    const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
      usersDocs = snap.docs;
      recomputeOverview();
    }, () => {});

    const unsubSessions = onSnapshot(collection(db, "attendance_sessions"), (snap) => {
      sessionsDocs = snap.docs;
      recomputeOverview();
    }, () => {});

    const unsubRecords = onSnapshot(collection(db, "attendance_records"), (snap) => {
      recordsDocs = snap.docs;
      recomputeOverview();
    }, () => {});

    const unsubComplaints = onSnapshot(collection(db, "security_complaints"), (snap) => {
      complaintsDocs = snap.docs;
      recomputeOverview();
    }, () => {});

    return () => {
      unsubAuth();
      unsubStudents();
      unsubUsers();
      unsubSessions();
      unsubRecords();
      unsubComplaints();
    };
  }, []);

  const filteredStudents = students.filter((student) => {
    const term = search.toLowerCase().trim();
    if (!term) return true;
    return (
      (student.name || "").toLowerCase().includes(term) ||
      (student.rollNo || "").toLowerCase().includes(term) ||
      (student.branch || "").toLowerCase().includes(term) ||
      (student.email || "").toLowerCase().includes(term)
    );
  });

  const { sortedItems: sortedStudents, sortConfig, requestSort } = useTableSort(filteredStudents, "rollNo", "asc");

  const getAttendanceClass = (percentage) => {
    if (percentage >= 75) return "attendance-good";
    if (percentage >= 50) return "attendance-average";
    return "attendance-low";
  };

  return (
    <div className="attendance-overview admin-attendance-page">
      {/* View Switcher Tabs */}
      <div className="view-switcher-bar">
        <button
          type="button"
          onClick={() => setActiveViewTab("matrix")}
          className={`view-switcher-btn ${activeViewTab === "matrix" ? "active" : ""}`}
        >
          <FaLayerGroup /> 📊 Master Attendance Sheet (All Classes Matrix)
        </button>

        <button
          type="button"
          onClick={() => setActiveViewTab("overview")}
          className={`view-switcher-btn ${activeViewTab === "overview" ? "active" : ""}`}
        >
          <FaCalendarAlt /> 📈 Attendance Metrics &amp; Violations Audit
        </button>
      </div>

      {activeViewTab === "matrix" ? (
        <MasterAttendanceMatrix role="admin" />
      ) : (
        <>
          {/* Header */}
          <div className="attendance-header">
            <div>
              <h1>Attendance &amp; Violations Overview</h1>
              <p>Real-time attendance metrics, security violations audit, live sessions, and student attendance logs.</p>
            </div>

            <button
              type="button"
              className="refresh-attendance"
              onClick={loadAttendanceData}
            >
              <FaSync className={loading ? "spin-icon" : ""} />
              <span>Refresh</span>
            </button>
          </div>

      {/* OVERALL ATTENDANCE CARD */}
      <div className="overall-attendance-card">
        <div className="overall-attendance-info">
          <span className="card-label">Institution Average Attendance</span>
          <h2>{stats.averageAttendanceRate}%</h2>
          <p>
            {stats.totalSessions > 0
              ? `Calculated across ${stats.totalSessions} sessions and ${stats.totalStudents} registered students.`
              : "No sessions recorded in database yet."}
          </p>
        </div>

        <div className="overall-progress">
          <div className="overall-progress-track">
            <div
              className="overall-progress-fill"
              style={{ width: `${stats.averageAttendanceRate}%` }}
            />
          </div>
          <span>{stats.averageAttendanceRate}%</span>
        </div>
      </div>

      {/* STATISTICS */}
      <div className="attendance-stat-grid">
        <div className="attendance-stat-card present">
          <div className="attendance-stat-icon">
            <FaUserCheck />
          </div>
          <div>
            <span>Total Attendances</span>
            <strong>{loading ? "..." : stats.totalRecords}</strong>
          </div>
        </div>

        <div className="attendance-stat-card classes">
          <div className="attendance-stat-icon">
            <FaCalendarAlt />
          </div>
          <div>
            <span>Classes / Sessions</span>
            <strong>{loading ? "..." : stats.totalSessions}</strong>
          </div>
        </div>

        <div className="attendance-stat-card leave">
          <div className="attendance-stat-icon">
            <FaCalendarCheck />
          </div>
          <div>
            <span>Active Live Sessions</span>
            <strong>{loading ? "..." : stats.activeSessions}</strong>
          </div>
        </div>

        <div className={`attendance-stat-card ${stats.totalViolations > 0 ? "attendance-stat-alert" : "present"}`}>
          <div className="attendance-stat-icon" style={stats.totalViolations > 0 ? { background: "#fee2e2", color: "#dc2626" } : {}}>
            <FaExclamationTriangle />
          </div>
          <div>
            <span>Pending Violations</span>
            <strong style={stats.totalViolations > 0 ? { color: "#dc2626" } : {}}>
              {loading ? "..." : stats.totalViolations}
            </strong>
          </div>
        </div>
      </div>

      {/* FLAGGED VIOLATIONS & ANTI-PROXY AUDIT SECTION */}
      <section className="attendance-section">
        <div className="section-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: "8px", margin: 0 }}>
              <FaShieldAlt style={{ color: "#ef4444" }} />
              Anti-Proxy Violations &amp; Security Audits ({filteredViolationsByClassAndDate.length})
            </h2>
            <p style={{ margin: "4px 0 0 0" }}>
              Permanent audit records for app switches, lockout violations, and administrative review decisions.
            </p>
          </div>

          {/* Filter Tabs */}
          <div className="violation-filter-bar">
            <button
              type="button"
              onClick={() => setViolationFilterTab("ALL")}
              className={`violation-tab-btn ${violationFilterTab === "ALL" ? "active-all" : ""}`}
            >
              📋 All ({filteredViolationsByClassAndDate.length})
            </button>
            <button
              type="button"
              onClick={() => setViolationFilterTab("PENDING")}
              className={`violation-tab-btn ${violationFilterTab === "PENDING" ? "active-pending" : ""}`}
            >
              🚨 Pending ({pendingViolations.length})
            </button>
            <button
              type="button"
              onClick={() => setViolationFilterTab("RESOLVED_PRESENT")}
              className={`violation-tab-btn ${violationFilterTab === "RESOLVED_PRESENT" ? "active-present" : ""}`}
            >
              ✅ Resolved Present ({resolvedPresentViolations.length})
            </button>
            <button
              type="button"
              onClick={() => setViolationFilterTab("RESOLVED_ABSENT")}
              className={`violation-tab-btn ${violationFilterTab === "RESOLVED_ABSENT" ? "active-absent" : ""}`}
            >
              ❌ Resolved Absent ({resolvedAbsentViolations.length})
            </button>
          </div>
        </div>

        {/* Filter Controls Row: Class and Date selectors */}
        <div className="violation-controls-row">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text-muted, #64748b)" }}>Class / Course:</span>
            <select
              value={violationClassFilter}
              onChange={(e) => setViolationClassFilter(e.target.value)}
              className="violation-filter-select"
            >
              <option value="ALL">🏫 All Classes &amp; Courses</option>
              {availableClasses.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text-muted, #64748b)" }}>Session Date:</span>
            <select
              value={violationDateFilter}
              onChange={(e) => setViolationDateFilter(e.target.value)}
              className="violation-filter-select"
            >
              <option value="TODAY">📅 Today ({todayStr})</option>
              <option value="ALL">🗓️ All Dates (Historical)</option>
              <option value="CUSTOM">🔍 Custom Date...</option>
            </select>
            {violationDateFilter !== "TODAY" && violationDateFilter !== "ALL" && (
              <input
                type="date"
                value={violationDateFilter === "CUSTOM" ? todayStr : violationDateFilter}
                onChange={(e) => setViolationDateFilter(e.target.value)}
                className="violation-filter-select"
                style={{ padding: "6px 10px" }}
              />
            )}
          </div>
        </div>

        {displayedViolations.length === 0 ? (
          <div className="violation-empty-state">
            <p className={violationFilterTab === "PENDING" ? "empty-pending" : "empty-other"}>
              {violationFilterTab === "PENDING"
                ? "✅ No pending violations to review! All attendance sessions for this filter are clear."
                : violationFilterTab === "RESOLVED_PRESENT"
                ? "No violations resolved as Present in this date/class filter."
                : violationFilterTab === "RESOLVED_ABSENT"
                ? "No violations resolved as Absent in this date/class filter."
                : "No violation records found matching the selected class and date."}
            </p>
          </div>
        ) : (
          <div className="violation-cards-grid">
            {displayedViolations.map((v) => {
              const isResolved = Boolean(v.isReviewed);
              const isPresent = v.resolutionStatus === "RESOLVED_PRESENT" || v.status === "APPROVED" || v.excused === true;
              const isAbsent = v.resolutionStatus === "RESOLVED_ABSENT" || v.status === "REJECTED";
              
              const cardClass = !isResolved ? "pending" : isPresent ? "resolved" : isAbsent ? "absent" : "resolved";
              const badgeClass = !isResolved ? "pending" : isPresent ? "resolved" : isAbsent ? "absent" : "resolved";
              
              const statusLabel = !isResolved
                ? (v.status || "PENDING REVIEW 🚨")
                : isPresent
                ? "Resolved (Present) ✅"
                : isAbsent
                ? "Resolved (Absent) ❌"
                : "Dismissed 🛡️";

              return (
                <div
                  key={v.id}
                  className={`violation-audit-card ${cardClass}`}
                >
                  <div className="violation-card-top">
                    <div>
                      <strong className="violation-student-name">
                        {v.studentName || v.rollNo || "Unknown Student"}
                      </strong>
                      <div className="violation-student-roll">
                        {v.rollNo || "N/A"}
                        {v.classCode && (
                          <span style={{ marginLeft: "8px", fontWeight: 600, color: "var(--accent, #6366f1)" }}>
                            • {v.classCode}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className={`violation-card-badge ${badgeClass}`}>
                      {statusLabel}
                    </span>
                  </div>

                  <p className="violation-reason-text">
                    {v.violationReason || v.reason || "App Switched or Screen Locked"}
                    {v.reviewNotes && <span className="violation-note-text">• Note: {v.reviewNotes}</span>}
                    {v.reviewedByName && (
                      <span className="violation-note-text" style={{ fontStyle: "italic", opacity: 0.9 }}>
                        • Reviewed by: {v.reviewedByName}
                      </span>
                    )}
                  </p>

                  <div className="violation-card-footer">
                    <span className="violation-time-text">
                      {v.timestamp || v.submittedAt
                        ? new Date(v.timestamp || v.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                        : "Recently"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedViolation(v)}
                      className={`violation-action-btn ${isResolved ? "resolved" : "pending"}`}
                    >
                      <FaShieldAlt /> {isResolved ? "Audit Info" : "Review"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* RECENT SESSIONS */}
      <section className="attendance-section">
        <div className="section-heading">
          <div>
            <h2>Recent Recorded Classes</h2>
            <p>Live session history recorded by lecturers in Firestore</p>
          </div>
        </div>

        {recentSessions.length === 0 ? (
          <div className="empty-state" style={{ background: "var(--surface, white)", padding: "24px", borderRadius: "12px", textAlign: "center" }}>
            <p>No class sessions created in the database yet.</p>
          </div>
        ) : (
          <div className="recent-sessions">
            {recentSessions.map((sess) => {
              const isLive = sess.active && (sess.expiresAt || 0) > Date.now();
              return (
                <div
                  key={sess.id}
                  className="recent-session"
                  onClick={() => navigate(`/admin/classes/${sess.id}`)}
                  style={{ cursor: "pointer" }}
                  title="Click to view detailed session attendance"
                >
                  <div className={`session-icon ${isLive ? "active-icon" : "completed-icon"}`}>
                    <FaChalkboard />
                  </div>

                  <div className="session-details">
                    <strong>
                      {sess.courseCode || sess.classCode || "Class Session"}
                      {sess.classCode && sess.courseCode ? ` (${sess.classCode})` : ""}
                    </strong>
                    <span>
                      Room {sess.roomNo || "N/A"} • {sess.createdAt ? new Date(sess.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "N/A"}
                    </span>
                  </div>

                  <span className={`session-status ${isLive ? "active" : "completed"}`}>
                    {isLive ? "🔴 Live" : "Closed"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* STUDENT ATTENDANCE TABLE */}
      <section className="attendance-section">
        <div className="section-heading">
          <div>
            <h2>Student Attendance Records ({students.length})</h2>
            <p>Click any student to view their complete attendance history.</p>
          </div>

          <div className="attendance-search">
            <FaSearch />
            <input
              type="text"
              placeholder="Search by name, roll number, or branch..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="attendance-table-wrapper">
          <table className="attendance-table">
            <thead>
              <tr>
                <th className="sortable-th" onClick={() => requestSort("name")} title="Click to sort by Student Name">
                  Student <SortIcon sortConfig={sortConfig} columnKey="name" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("rollNo")} title="Click to sort by Roll Number">
                  Roll No <SortIcon sortConfig={sortConfig} columnKey="rollNo" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("branch")} title="Click to sort by Branch">
                  Branch <SortIcon sortConfig={sortConfig} columnKey="branch" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("attendedCount")} title="Click to sort by Classes Attended">
                  Classes Attended <SortIcon sortConfig={sortConfig} columnKey="attendedCount" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("attendanceRate")} title="Click to sort by Attendance %">
                  Attendance % <SortIcon sortConfig={sortConfig} columnKey="attendanceRate" />
                </th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              {sortedStudents.map((student) => (
                <tr
                  key={student.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelectedStudent(student)}
                  title="Click to view student attendance history"
                >
                  <td>
                    <div className="student-cell">
                      <div className="student-avatar" style={{ background: "linear-gradient(135deg, #6366f1, #4338ca)", color: "white" }}>
                        {student.name ? student.name.charAt(0).toUpperCase() : "S"}
                      </div>
                      <div className="student-info">
                        <strong>{student.name || "Unnamed Student"}</strong>
                        <span>{student.email || "No email"}</span>
                      </div>
                    </div>
                  </td>

                  <td>
                    <span className="roll-number">{student.rollNo || "-"}</span>
                  </td>

                  <td>
                    <span className="branch-badge">{normalizeBranchName(student.branch || "CSE")}</span>
                  </td>

                  <td>
                    <strong>{student.attendedCount || 0} classes</strong>
                  </td>

                  <td>
                    <div className="percentage-cell">
                      <div className="percentage-bar">
                        <div
                          className={`percentage-fill ${getAttendanceClass(student.attendanceRate)}`}
                          style={{ width: `${student.attendanceRate}%` }}
                        />
                      </div>
                      <span className={getAttendanceClass(student.attendanceRate)}>
                        {student.attendanceRate}%
                      </span>
                    </div>
                  </td>

                  <td onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="view-icon-btn"
                      onClick={() => setSelectedStudent(student)}
                      title="View Details"
                    >
                      <FaEye />
                    </button>
                  </td>
                </tr>
              ))}

              {filteredStudents.length === 0 && (
                <tr>
                  <td colSpan="6" className="no-students">
                    {search ? "No matching students found." : "No student records found in database."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      </>
      )}

      {/* Student Details Modal */}
      {selectedStudent && (
        <StudentDetailModal
          student={selectedStudent}
          onClose={() => setSelectedStudent(null)}
          onUpdate={(updated) => {
            if (!updated) return;
            setSelectedStudent(updated);
          }}
        />
      )}

      {/* Flagged Violation Review Modal */}
      {selectedViolation && (
        <ViolationReviewModal
          violation={selectedViolation}
          onClose={() => setSelectedViolation(null)}
          onActionComplete={(violId, decision) => {
            setFlaggedViolations((prev) =>
              prev.map((v) =>
                v.id === violId
                  ? {
                      ...v,
                      isReviewed: true,
                      reviewed: true,
                      resolutionStatus: decision,
                      status:
                        decision === "RESOLVED_PRESENT"
                          ? "APPROVED"
                          : decision === "RESOLVED_ABSENT"
                          ? "REJECTED"
                          : "DISMISSED"
                    }
                  : v
              )
            );
            loadAttendanceData();
          }}
        />
      )}
    </div>
  );
};

export default AttendanceOverview;