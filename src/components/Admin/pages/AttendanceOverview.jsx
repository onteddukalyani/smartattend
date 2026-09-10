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
  FaEye
} from "react-icons/fa";
import { collection, getDocs, query, where, onSnapshot } from "firebase/firestore";
import { db } from "../../../firebase";
import StudentDetailModal from "../../Common/StudentDetailModal";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import "./AttendanceOverview.css";
import { mergeAllStudentRecords } from "../../../utils/studentDataHelper";

const AttendanceOverview = () => {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [students, setStudents] = useState([]);
  const [recentSessions, setRecentSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [stats, setStats] = useState({
    totalStudents: 0,
    totalRecords: 0,
    totalSessions: 0,
    activeSessions: 0,
    averageAttendanceRate: 0
  });

  const computeOverview = (authDocs, studentsDocs, usersDocs, sessionsDocs, recordsDocs) => {
    try {
      const totalSessionsCount = sessionsDocs.length;
      const totalRecordsCount = recordsDocs.length;

      // Map unique attended session count per canonical Roll Number
      const studentAttendedSessionSet = new Map();

      recordsDocs.forEach((docSnap) => {
        const d = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
        const roll = d.rollNo;
        const sessionId = d.sessionId || (docSnap.id && docSnap.id.includes("_") ? docSnap.id.split("_")[0] : docSnap.id);
        if (roll) {
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
        averageAttendanceRate: avgRate
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
      const [authSnap, studentsSnap, usersSnap, sessionsSnap, recordsSnap] = await Promise.all([
        getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "students")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "attendance_sessions")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "attendance_records")).catch(() => ({ docs: [] }))
      ]);
      computeOverview(authSnap.docs, studentsSnap.docs, usersSnap.docs, sessionsSnap.docs, recordsSnap.docs);
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

    const recomputeOverview = () => {
      computeOverview(authDocs, studentsDocs, usersDocs, sessionsDocs, recordsDocs);
    };

    const unsubAuth = onSnapshot(collection(db, "authorizedUsers"), (snap) => {
      authDocs = snap.docs;
      recomputeOverview();
    }, (err) => console.warn("authorizedUsers snapshot error:", err));

    const unsubStudents = onSnapshot(collection(db, "students"), (snap) => {
      studentsDocs = snap.docs;
      recomputeOverview();
    }, (err) => console.warn("students snapshot error:", err));

    const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
      usersDocs = snap.docs;
      recomputeOverview();
    }, (err) => console.warn("users snapshot error:", err));

    const unsubSessions = onSnapshot(collection(db, "attendance_sessions"), (snap) => {
      sessionsDocs = snap.docs;
      recomputeOverview();
    }, (err) => console.warn("attendance_sessions snapshot error:", err));

    const unsubRecords = onSnapshot(collection(db, "attendance_records"), (snap) => {
      recordsDocs = snap.docs;
      recomputeOverview();
    }, (err) => console.warn("attendance_records snapshot error:", err));

    return () => {
      unsubAuth();
      unsubStudents();
      unsubUsers();
      unsubSessions();
      unsubRecords();
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
      {/* Header */}
      <div className="attendance-header">
        <div>
          <h1>Attendance Overview</h1>
          <p>Real-time attendance metrics, live sessions, and student attendance logs from database.</p>
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

        <div className="attendance-stat-card present">
          <div className="attendance-stat-icon">
            <FaUserGraduate />
          </div>
          <div>
            <span>Total Students</span>
            <strong>{loading ? "..." : stats.totalStudents}</strong>
          </div>
        </div>
      </div>

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
                    <span className="branch-badge">{(student.branch && String(student.branch).toLowerCase() !== "general") ? student.branch : "CSE"}</span>
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
    </div>
  );
};

export default AttendanceOverview;