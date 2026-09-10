import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  FaUserGraduate,
  FaChalkboardTeacher,
  FaUserShield,
  FaCalendarCheck,
  FaArrowRight,
  FaHistory,
  FaCheckCircle,
  FaChalkboard,
  FaSyncAlt
} from "react-icons/fa";
import { collection, getDocs, query, where, onSnapshot } from "firebase/firestore";
import { db } from "../../../firebase";
import "./AdminOverview.css";

const AdminOverview = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    studentsCount: 0,
    lecturersCount: 0,
    adminsCount: 1,
    sessionsCount: 0,
    attendancesCount: 0
  });
  const [recentRecords, setRecentRecords] = useState([]);
  const [recentSessions, setRecentSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  const computeAdminData = (usersDocs, studentsDocs, sessionsDocs, recordsDocs, authDocs) => {
    try {
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

      const studentSet = new Set();
      const lecturerSet = new Set();
      let admins = 0;

      // 1. Process authorizedUsers
      authDocs.forEach((docSnap) => {
        const d = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
        const role = String(d.role || "").toLowerCase().trim();
        const email = (d.email || docSnap.id).toLowerCase().trim();

        if (role === "lecturer" || role === "faculty" || role === "professor") {
          lecturerSet.add(email);
        } else if (role === "admin") {
          admins++;
        } else if (role === "student") {
          const roll = getCanonicalRoll(d, docSnap.id);
          if (roll) studentSet.add(roll);
        }
      });

      // 2. Process students collection
      studentsDocs.forEach((docSnap) => {
        const d = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
        const roll = getCanonicalRoll(d, docSnap.id);
        if (roll) studentSet.add(roll);
      });

      // 3. Process users collection
      usersDocs.forEach((docSnap) => {
        const d = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
        const role = String(d.role || "").toLowerCase().trim();
        const email = (d.email || "").toLowerCase().trim();

        if (role === "lecturer" || role === "faculty" || role === "professor") {
          lecturerSet.add(email || docSnap.id);
        } else if (role === "admin") {
          admins++;
        } else {
          const isStudent = role === "student" ||
            Boolean(d.rollNo) ||
            Boolean(d.semester) ||
            Boolean(d.branch) ||
            /^\d{2}[a-zA-Z]{3}\d{2,4}$/i.test(docSnap.id);

          if (isStudent) {
            const roll = getCanonicalRoll(d, docSnap.id);
            if (roll) studentSet.add(roll);
          }
        }
      });

      // Recent attendances
      const recordsList = recordsDocs.map((d) => ({
        id: d.id,
        ...(typeof d.data === "function" ? d.data() : d)
      }));
      recordsList.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

      // Build map of users for lecturer name resolution
      const userMap = new Map();
      usersDocs.forEach((d) => {
        const u = typeof d.data === "function" ? d.data() : d;
        if (u.name) {
          userMap.set(d.id, u.name);
          if (u.email) userMap.set(u.email.toLowerCase().trim(), u.name);
        }
      });
      authDocs.forEach((d) => {
        const u = typeof d.data === "function" ? d.data() : d;
        if (u.name) {
          userMap.set(d.id.toLowerCase().trim(), u.name);
          if (u.email) userMap.set(u.email.toLowerCase().trim(), u.name);
        }
      });

      // Recent sessions
      const sessionsList = sessionsDocs.map((d) => {
        const data = typeof d.data === "function" ? d.data() : d;
        const ownerEmail = (data.ownerEmail || data.lecturerEmail || "").toLowerCase().trim();
        const ownerId = data.ownerId;
        const resolvedLecturer = data.lecturerName || userMap.get(ownerId) || userMap.get(ownerEmail) || (ownerEmail ? ownerEmail.split("@")[0] : "Faculty");

        return {
          id: d.id,
          ...data,
          lecturerName: resolvedLecturer
        };
      });
      sessionsList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      setStats({
        studentsCount: studentSet.size,
        lecturersCount: lecturerSet.size,
        adminsCount: Math.max(admins, 1),
        sessionsCount: sessionsDocs.length || 0,
        attendancesCount: recordsDocs.length || 0
      });

      setRecentRecords(recordsList.slice(0, 5));
      setRecentSessions(sessionsList.slice(0, 5));

    } catch (err) {
      console.error("Error computing admin overview data:", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchOverviewData = async () => {
    try {
      setLoading(true);
      const [usersSnap, studentsSnap, sessionsSnap, recordsSnap, authUsersSnap] = await Promise.all([
        getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "students")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "attendance_sessions")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "attendance_records")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] }))
      ]);
      computeAdminData(usersSnap.docs, studentsSnap.docs, sessionsSnap.docs, recordsSnap.docs, authUsersSnap.docs);
    } catch (err) {
      console.error("Error fetching admin overview data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let usersDocs = [];
    let studentsDocs = [];
    let sessionsDocs = [];
    let recordsDocs = [];
    let authDocs = [];

    const recompute = () => {
      computeAdminData(usersDocs, studentsDocs, sessionsDocs, recordsDocs, authDocs);
    };

    const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
      usersDocs = snap.docs;
      recompute();
    }, (e) => console.warn("users snapshot error:", e));

    const unsubStudents = onSnapshot(collection(db, "students"), (snap) => {
      studentsDocs = snap.docs;
      recompute();
    }, (e) => console.warn("students snapshot error:", e));

    const unsubSessions = onSnapshot(collection(db, "attendance_sessions"), (snap) => {
      sessionsDocs = snap.docs;
      recompute();
    }, (e) => console.warn("sessions snapshot error:", e));

    const unsubRecords = onSnapshot(collection(db, "attendance_records"), (snap) => {
      recordsDocs = snap.docs;
      recompute();
    }, (e) => console.warn("records snapshot error:", e));

    const unsubAuth = onSnapshot(collection(db, "authorizedUsers"), (snap) => {
      authDocs = snap.docs;
      recompute();
    }, (e) => console.warn("auth snapshot error:", e));

    return () => {
      unsubUsers();
      unsubStudents();
      unsubSessions();
      unsubRecords();
      unsubAuth();
    };
  }, []);

  return (
    <div className="admin-overview">
      {/* Header */}
      <div className="admin-page-header">
        <div>
          <h1>Admin Dashboard</h1>
          <p>Manage IIIT Dharwad attendance, users, faculty, and system access.</p>
        </div>
        <button
          onClick={fetchOverviewData}
          disabled={loading}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.6rem 1.2rem",
            borderRadius: "8px",
            background: "linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)",
            color: "#ffffff",
            border: "none",
            fontWeight: "600",
            cursor: loading ? "not-allowed" : "pointer",
            boxShadow: "0 4px 12px rgba(79, 70, 229, 0.3)"
          }}
          title="Refresh statistics and data"
        >
          <FaSyncAlt className={loading ? "fa-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Statistics */}
      <div className="admin-stats">
        <div
          className="admin-stat-card"
          onClick={() => navigate("/admin/students")}
          style={{ cursor: "pointer" }}
          title="Click to manage students"
        >
          <div className="stat-icon">
            <FaUserGraduate />
          </div>
          <div>
            <span>Total Students</span>
            <strong>{loading ? "..." : stats.studentsCount}</strong>
          </div>
        </div>

        <div
          className="admin-stat-card"
          onClick={() => navigate("/admin/lecturers")}
          style={{ cursor: "pointer" }}
          title="Click to manage lecturers"
        >
          <div className="stat-icon">
            <FaChalkboardTeacher />
          </div>
          <div>
            <span>Lecturers</span>
            <strong>{loading ? "..." : stats.lecturersCount}</strong>
          </div>
        </div>

        <div
          className="admin-stat-card"
          onClick={() => navigate("/admin/admins")}
          style={{ cursor: "pointer" }}
          title="Click to manage administrators"
        >
          <div className="stat-icon">
            <FaUserShield />
          </div>
          <div>
            <span>Administrators</span>
            <strong>{loading ? "..." : stats.adminsCount}</strong>
          </div>
        </div>

        <div
          className="admin-stat-card"
          onClick={() => navigate("/admin/attendance")}
          style={{ cursor: "pointer" }}
          title="Click to view attendance overview"
        >
          <div className="stat-icon">
            <FaCalendarCheck />
          </div>
          <div>
            <span>Total Attendances</span>
            <strong>{loading ? "..." : stats.attendancesCount}</strong>
          </div>
        </div>
      </div>

      {/* Sections */}
      <div className="admin-overview-grid">
        {/* Recent Attendance Activity */}
        <section className="admin-panel">
          <div className="panel-header">
            <div>
              <h2>Recent Attendance Submissions</h2>
              <p>Latest verified student check-ins</p>
            </div>
            <button
              className="panel-view-all"
              onClick={() => navigate("/admin/attendance")}
            >
              View All <FaArrowRight />
            </button>
          </div>

          {recentRecords.length === 0 ? (
            <div className="empty-state">
              <p>No recent attendance activity recorded yet.</p>
            </div>
          ) : (
            <div className="recent-records-list">
              {recentRecords.map((rec) => (
                <div
                  key={rec.id}
                  className="recent-record-item"
                  onClick={() => navigate("/admin/attendance")}
                  style={{ cursor: "pointer" }}
                  title="Click to view attendance records"
                >
                  <div className="record-avatar">
                    <FaUserGraduate />
                  </div>
                  <div className="record-meta">
                    <strong>{rec.rollNo || "No Roll"}</strong>
                    <span>{rec.fullName || "Student"} • Room {rec.roomNo || "N/A"}</span>
                  </div>
                  <div className="record-time">
                    <span className="present-badge">Present ✅</span>
                    <small>
                      {rec.submittedAt
                        ? new Date(rec.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                        : "Just now"}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Recent Classes / Sessions */}
        <section className="admin-panel">
          <div className="panel-header">
            <div>
              <h2>Recent Classes & Sessions</h2>
              <p>Lecturer-generated attendance sessions</p>
            </div>
            <button
              className="panel-view-all"
              onClick={() => navigate("/admin/classes")}
            >
              View Classes <FaArrowRight />
            </button>
          </div>

          {recentSessions.length === 0 ? (
            <div className="empty-state">
              <p>No classes created yet.</p>
            </div>
          ) : (
            <div className="recent-records-list">
              {recentSessions.map((sess) => (
                <div
                  key={sess.id}
                  className="recent-record-item"
                  onClick={() => navigate(`/admin/classes/${sess.id}`)}
                  style={{ cursor: "pointer" }}
                  title="Click to view detailed session attendance"
                >
                  <div className="record-avatar session-avatar">
                    <FaChalkboard />
                  </div>
                  <div className="record-meta">
                    <strong>{sess.courseCode || sess.classCode || "Class Session"}</strong>
                    <span>{sess.lecturerName ? `By ${sess.lecturerName} • ` : ""}Room {sess.roomNo || "N/A"}</span>
                  </div>
                  <div className="record-time">
                    <span className={sess.active && (sess.expiresAt || 0) > Date.now() ? "live-badge" : "closed-badge"}>
                      {sess.active && (sess.expiresAt || 0) > Date.now() ? "🔴 Live" : "Closed"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default AdminOverview;