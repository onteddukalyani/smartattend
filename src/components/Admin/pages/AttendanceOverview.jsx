import React, { useEffect, useState } from "react";
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
  const [activeViewTab, setActiveViewTab] = useState("matrix"); // "matrix" | "overview"
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

  const computeOverview = (authDocs, studentsDocs, usersDocs, sessionsDocs, recordsDocs, complaintsDocs = []) => {
    try {
      const totalSessionsCount = sessionsDocs.length;
      const totalRecordsCount = recordsDocs.length;

      // 1. Gather all Flagged Violations from attendance records and security complaints
      const violationsList = [];
      recordsDocs.forEach((docSnap) => {
        const d = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
        const isReviewedOrResolved =
          d.reviewed === true ||
          d.excused === true ||
          d.resolved === true ||
          d.dismissed === true ||
          d.status === "APPROVED" ||
          d.status === "RESOLVED" ||
          d.status === "DISMISSED" ||
          d.status === "REJECTED" ||
          d.status === "ATTENDED" ||
          d.status === "PRESENT";

        const isFlagged = !isReviewedOrResolved && (
          d.status === "FLAGGED" ||
          d.status === "FLAGGED_DISQUALIFIED" ||
          d.status === "VIOLATION" ||
          d.flagged === true ||
          d.hasViolation === true
        );

        if (isFlagged) {
          violationsList.push({
            id: docSnap.id || d.id,
            ...d
          });
        }
      });

      complaintsDocs.forEach((cSnap) => {
        const c = typeof cSnap.data === "function" ? cSnap.data() : cSnap;
        if (c && c.status !== "RESOLVED" && c.status !== "DISMISSED" && c.status !== "CLOSED" && !c.resolved) {
          violationsList.push({
            id: cSnap.id || c.id,
            rollNo: c.rollNo || c.rollNumber || "UNKNOWN",
            studentName: c.userName || c.name || c.rollNo,
            classCode: c.context || "Security System",
            violationReason: c.reason || "Security verification flagged",
            timestamp: c.reportedAt || (c.timestamp ? new Date(c.timestamp).getTime() : Date.now()),
            status: c.status || "OPEN_COMPLAINT",
            ...c
          });
        }
      });

      // Deduplicate violations by ID or roll+timestamp
      const uniqueViolations = [];
      const seenViolIds = new Set();
      violationsList.forEach(v => {
        if (!seenViolIds.has(v.id)) {
          seenViolIds.add(v.id);
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

      setStudents(studentList);
      setRecentSessions(sessionsList.slice(0, 6));
      setStats({
        totalStudents: studentList.length,
        totalRecords: Math.max(totalRecordsCount, studentAttendedSessionSet.size),
        totalSessions: totalSessionsCount,
        activeSessions: activeCount,
        averageAttendanceRate: avgRate,
        totalViolations: uniqueViolations.length
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
      <div style={{ display: "flex", gap: "10px", marginBottom: "1.5rem", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => setActiveViewTab("matrix")}
          style={{
            padding: "10px 18px",
            borderRadius: "12px",
            border: activeViewTab === "matrix" ? "none" : "1px solid var(--border, #cbd5e1)",
            background: activeViewTab === "matrix" ? "linear-gradient(135deg, #6366f1, #4f46e5)" : "var(--surface, #ffffff)",
            color: activeViewTab === "matrix" ? "#ffffff" : "var(--text-main, #334155)",
            fontWeight: 800,
            fontSize: "0.9rem",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            boxShadow: activeViewTab === "matrix" ? "0 4px 14px rgba(99, 102, 241, 0.3)" : "none"
          }}
        >
          <FaLayerGroup /> 📊 Master Attendance Sheet (All Classes Matrix)
        </button>

        <button
          type="button"
          onClick={() => setActiveViewTab("overview")}
          style={{
            padding: "10px 18px",
            borderRadius: "12px",
            border: activeViewTab === "overview" ? "none" : "1px solid var(--border, #cbd5e1)",
            background: activeViewTab === "overview" ? "linear-gradient(135deg, #6366f1, #4f46e5)" : "var(--surface, #ffffff)",
            color: activeViewTab === "overview" ? "#ffffff" : "var(--text-main, #334155)",
            fontWeight: 800,
            fontSize: "0.9rem",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            boxShadow: activeViewTab === "overview" ? "0 4px 14px rgba(99, 102, 241, 0.3)" : "none"
          }}
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
            <span>Flagged Violations</span>
            <strong style={stats.totalViolations > 0 ? { color: "#dc2626" } : {}}>
              {loading ? "..." : stats.totalViolations}
            </strong>
          </div>
        </div>
      </div>

      {/* FLAGGED VIOLATIONS & ANTI-PROXY AUDIT SECTION */}
      <section className="attendance-section">
        <div className="section-heading">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <FaShieldAlt style={{ color: "#ef4444" }} />
              Flagged Anti-Proxy Violations &amp; Security Audits ({flaggedViolations.length})
            </h2>
            <p>App switch detections, device mismatch alerts, and security audit logs</p>
          </div>
        </div>

        {flaggedViolations.length === 0 ? (
          <div className="empty-state" style={{ background: "var(--surface, white)", padding: "20px", borderRadius: "14px", textAlign: "center", border: "1px solid #e2e8f0" }}>
            <p style={{ margin: 0, color: "#10b981", fontWeight: 700 }}>
              ✅ No flagged violations or anti-proxy breaches found. System is secure!
            </p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "12px", marginBottom: "20px" }}>
            {flaggedViolations.map((v) => (
              <div
                key={v.id}
                style={{
                  background: "#fff1f2",
                  border: "1.5px solid #fecdd3",
                  borderRadius: "14px",
                  padding: "14px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  position: "relative"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                  <div>
                    <strong style={{ fontSize: "0.95rem", color: "#9f1239" }}>
                      {v.studentName || v.rollNo || "Unknown Student"}
                    </strong>
                    <div style={{ fontSize: "0.8rem", fontFamily: "monospace", color: "#be123c", fontWeight: 700 }}>
                      {v.rollNo || "N/A"}
                    </div>
                  </div>
                  <span style={{ fontSize: "0.74rem", background: "#fee2e2", color: "#b91c1c", padding: "3px 8px", borderRadius: "6px", fontWeight: 750 }}>
                    {v.status || "FLAGGED"}
                  </span>
                </div>

                <p style={{ margin: 0, fontSize: "0.82rem", color: "#881337", lineHeight: 1.35 }}>
                  {v.violationReason || v.reason || "App Switched or Device Mismatch"}
                </p>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: "6px", borderTop: "1px solid #fecdd3", marginTop: "4px" }}>
                  <span style={{ fontSize: "0.74rem", color: "#9f1239" }}>
                    {v.timestamp || v.submittedAt ? new Date(v.timestamp || v.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Recently"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedViolation(v)}
                    style={{
                      padding: "5px 12px",
                      borderRadius: "8px",
                      background: "#e11d48",
                      color: "#ffffff",
                      border: "none",
                      fontSize: "0.78rem",
                      fontWeight: 700,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px"
                    }}
                  >
                    <FaShieldAlt /> Review
                  </button>
                </div>
              </div>
            ))}
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
            setFlaggedViolations((prev) => prev.filter((v) => v.id !== violId));
            loadAttendanceData();
          }}
        />
      )}
    </div>
  );
};

export default AttendanceOverview;