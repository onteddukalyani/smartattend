import React, { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  FaTimes,
  FaBookOpen,
  FaChalkboardTeacher,
  FaEnvelope,
  FaBuilding,
  FaGraduationCap,
  FaLayerGroup,
  FaCalendarAlt,
  FaUsers,
  FaClock,
  FaFileExcel,
  FaExternalLinkAlt,
  FaCheckCircle,
  FaQrcode,
  FaIdCard,
  FaSearch,
  FaSyncAlt,
  FaChartBar
} from "react-icons/fa";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../firebase";
import { downloadExcel } from "../../DownloadExcel";
import { useTableSort, SortIcon } from "./useTableSort";
import { normalizeCourseDepartment } from "./CoursesManager";
import "./StudentDetailModal.css";

export default function CourseDetailModal({
  course,
  lecturers = [],
  allStudents = [],
  onClose,
  onOpenRoster,
  onEditCourse,
  isAdmin = false
}) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("sessions"); // "sessions" | "students"
  const [sessions, setSessions] = useState([]);
  const [attendancesCountMap, setAttendancesCountMap] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [studentSearch, setStudentSearch] = useState("");

  const courseCode = course?.code || course?.courseCode || course?.id || "COURSE";
  const courseName = course?.name || course?.courseName || course?.title || "Untitled Course";
  const classCode = course?.classCode || course?.classNumber || "C003";
  const dept = normalizeCourseDepartment(course?.department || "CSE");
  const semester = course?.semester || 4;
  const credits = course?.credits || 4;

  // Resolve assigned lecturer info
  const assignedLecturer = useMemo(() => {
    if (!course) return null;
    const directEmail = (course.lecturerEmail || course.assignedLecturerEmail || "").toLowerCase().trim();
    const directName = course.lecturer || course.lecturerName || "";

    // Search in lecturers array
    let matched = null;
    if (directEmail) {
      matched = lecturers.find((l) => (l.email || "").toLowerCase().trim() === directEmail);
    }
    if (!matched && directName) {
      matched = lecturers.find((l) => (l.name || "").toLowerCase().trim() === directName.toLowerCase().trim());
    }
    if (!matched && Array.isArray(course.assignedLecturers) && course.assignedLecturers.length > 0) {
      const first = course.assignedLecturers[0];
      const email = typeof first === "string" ? first.toLowerCase().trim() : (first.email || "").toLowerCase().trim();
      if (email) {
        matched = lecturers.find((l) => (l.email || "").toLowerCase().trim() === email);
      }
    }

    if (matched) {
      return {
        name: matched.name || matched.displayName || directName || "Faculty In-Charge",
        email: matched.email || directEmail || "",
        department: matched.department || dept,
        designation: matched.designation || "Assistant Professor",
        photoURL: matched.photoURL || matched.photo || matched.image || null
      };
    }

    return {
      name: directName || (directEmail ? directEmail.split("@")[0] : "Assigned Faculty"),
      email: directEmail || "",
      department: dept,
      designation: "Faculty In-Charge",
      photoURL: null
    };
  }, [course, lecturers, dept]);

  // Fetch all attendance sessions & records for this course
  useEffect(() => {
    if (!course) {
      setLoading(false);
      return;
    }

    let isMounted = true;
    const fetchCourseData = async () => {
      try {
        setLoading(true);
        const [sessionsSnap, recordsSnap] = await Promise.all([
          getDocs(collection(db, "attendance_sessions")).catch(() => ({ docs: [] })),
          getDocs(collection(db, "attendance_records")).catch(() => ({ docs: [] }))
        ]);

        if (!isMounted) return;

        // Build count map: sessionId -> attendees count
        const counts = new Map();
        recordsSnap.docs.forEach((docSnap) => {
          const data = docSnap.data();
          const sid = data.sessionId || data.session_id;
          if (sid) {
            counts.set(sid, (counts.get(sid) || 0) + 1);
          }
        });

        // Filter sessions matching this course
        const cleanCourseCode = courseCode.toUpperCase().trim();
        const courseSessions = [];

        sessionsSnap.docs.forEach((docSnap) => {
          const data = docSnap.data();
          const sessCourse = (data.courseCode || data.classCode || "").toUpperCase().trim();
          const sessClass = (data.classCode || "").toUpperCase().trim();

          if (sessCourse === cleanCourseCode || sessClass === cleanCourseCode || (classCode && sessClass === classCode.toUpperCase().trim())) {
            let createdAtMs = 0;
            if (typeof data.createdAt === "number") createdAtMs = data.createdAt;
            else if (data.createdAt?.toMillis) createdAtMs = data.createdAt.toMillis();
            else if (data.createdAt?.seconds) createdAtMs = data.createdAt.seconds * 1000;
            else if (typeof data.timestamp === "number") createdAtMs = data.timestamp;

            // Also check embedded attendees array if records snapshot was empty
            let attendeeCount = counts.get(docSnap.id) || 0;
            if (attendeeCount === 0 && Array.isArray(data.attendees)) {
              attendeeCount = data.attendees.length;
            }

            courseSessions.push({
              id: docSnap.id,
              ...data,
              createdAt: createdAtMs,
              attendeeCount,
              roomNo: data.roomNo || data.room || classCode,
              lecturerName: data.lecturerName || data.ownerEmail?.split("@")[0] || assignedLecturer.name || "Faculty"
            });
          }
        });

        // Sort sessions newest first
        courseSessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        setSessions(courseSessions);
        setAttendancesCountMap(counts);
      } catch (err) {
        console.warn("Error fetching course activity:", err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchCourseData();

    return () => {
      isMounted = false;
    };
  }, [course, courseCode, classCode, assignedLecturer.name]);

  // Enrolled students list enriched with student directory
  const enrolledStudentsList = useMemo(() => {
    if (!course) return [];
    const rawList = Array.isArray(course.enrolledStudents) ? course.enrolledStudents : [];
    return rawList.map((item, idx) => {
      const roll = typeof item === "string" ? item : item.rollNo || item.rollNumber || "";
      const cleanRoll = String(roll).trim().toUpperCase();
      const studentMatch = allStudents.find((s) => String(s.rollNo || s.id || "").trim().toUpperCase() === cleanRoll);
      return {
        id: cleanRoll || `stud-${idx}`,
        rollNo: cleanRoll,
        name: studentMatch?.name || studentMatch?.fullName || "—",
        email: studentMatch?.email || "—",
        department: studentMatch?.branch || studentMatch?.department || dept,
        batch: studentMatch?.batch || "2025"
      };
    });
  }, [course, allStudents, dept]);

  const filteredEnrolledStudents = useMemo(() => {
    if (!studentSearch.trim()) return enrolledStudentsList;
    const q = studentSearch.toLowerCase().trim();
    return enrolledStudentsList.filter(
      (s) => s.rollNo.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q)
    );
  }, [enrolledStudentsList, studentSearch]);

  const { sortedItems: sortedSessions, sortConfig, requestSort } = useTableSort(sessions, "createdAt", "desc");

  // Navigation handlers
  const handleOpenCourseAttendances = () => {
    onClose?.();
    const basePath = window.location.pathname.startsWith("/admin") ? "/admin/classes" : "/lecturer/attendance-sessions";
    navigate(`${basePath}?course=${encodeURIComponent(courseCode)}`);
  };

  const handleOpenMasterMatrix = () => {
    onClose?.();
    const basePath = window.location.pathname.startsWith("/admin") ? "/admin/classes" : "/lecturer/attendance-sessions";
    navigate(`${basePath}?course=${encodeURIComponent(courseCode)}&view=matrix`);
  };

  const handleOpenSpecificSession = (sessionId) => {
    onClose?.();
    const basePath = window.location.pathname.startsWith("/admin") ? "/admin/classes" : "/lecturer/attendance-sessions";
    navigate(`${basePath}/${sessionId}`);
  };

  const handleExportSessionsExcel = () => {
    const exportData = sortedSessions.map((sess, idx) => ({
      "S.No": idx + 1,
      "Course Code": courseCode,
      "Course Name": courseName,
      "Class / Room": sess.roomNo || classCode,
      "Conducted By": sess.lecturerName || assignedLecturer.name,
      "Date & Time": sess.createdAt ? new Date(sess.createdAt).toLocaleString() : "N/A",
      "Total Attendees": sess.attendeeCount || 0,
      "Status": (sess.status === "ACTIVE" || sess.phase === "PHASE_1" || sess.phase === "PHASE_2") ? "Active / In Progress" : "Completed"
    }));

    downloadExcel(exportData, `${courseCode}_Classes_Attendance_Report_${new Date().toISOString().slice(0, 10)}`);
  };

  const totalAttendeesAllSessions = sessions.reduce((acc, s) => acc + (s.attendeeCount || 0), 0);
  const activeSessionsCount = sessions.filter((s) => s.status === "ACTIVE" || s.phase === "PHASE_1" || s.phase === "PHASE_2").length;

  if (!course) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="student-modal-container" style={{ maxWidth: "860px" }} onClick={(e) => e.stopPropagation()}>
        {/* Close Button */}
        <button className="modal-close-btn" onClick={onClose} aria-label="Close modal">
          <FaTimes />
        </button>

        {/* Header Profile Section */}
        <div className="modal-profile-header">
          <div className="modal-avatar-wrapper" style={{ background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)", color: "#ffffff" }}>
            <FaBookOpen style={{ fontSize: "1.8rem" }} />
          </div>

          <div className="modal-header-meta">
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
              <span className="badge-dept" style={{ background: "#6366f1", color: "#ffffff", fontWeight: 800, padding: "3px 8px", borderRadius: "6px", fontSize: "0.82rem" }}>
                {courseCode}
              </span>
              <span className="badge-dept">
                <FaBuilding /> {dept} · Sem {semester}
              </span>
              <span className="badge-roll">
                <FaGraduationCap /> {credits} Credits
              </span>
            </div>

            <h2>{courseName}</h2>

            <div className="modal-badges-row">
              <span className="badge-roll" style={{ background: "rgba(99, 102, 241, 0.1)", color: "#6366f1" }}>
                <FaLayerGroup /> Class Code: {classCode}
              </span>
              {activeSessionsCount > 0 && (
                <span className="badge-status online">
                  <span className="status-dot"></span> Live Session Active
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Respective Faculty In-Charge Card */}
        <div style={{ margin: "0 24px 16px", padding: "14px 18px", background: "var(--surface-soft, #f8fafc)", border: "1px solid var(--border, #e2e8f0)", borderRadius: "14px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ width: "42px", height: "42px", borderRadius: "12px", background: "#e0e7ff", color: "#4338ca", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.2rem", fontWeight: 800, overflow: "hidden" }}>
              {assignedLecturer.photoURL ? (
                <img src={assignedLecturer.photoURL} alt={assignedLecturer.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <FaChalkboardTeacher />
              )}
            </div>
            <div>
              <div style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--text-muted, #64748b)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Respective Assigned Lecturer (Faculty In-Charge)
              </div>
              <div style={{ fontSize: "0.98rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                {assignedLecturer.name}
              </div>
              {assignedLecturer.email && (
                <div style={{ fontSize: "0.82rem", color: "var(--text-muted, #64748b)", display: "flex", alignItems: "center", gap: "6px" }}>
                  <FaEnvelope style={{ fontSize: "0.75rem" }} /> {assignedLecturer.email}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              className="action-btn-pill view"
              onClick={handleOpenCourseAttendances}
              title={`View all attendance sessions for ${courseCode}`}
            >
              <FaChartBar /> View All Course Attendances
            </button>
          </div>
        </div>

        {/* Quick KPI Stats Row */}
        <div className="modal-stats-overview" style={{ margin: "0 24px 20px" }}>
          <div className="stat-box primary">
            <span className="stat-label">Classes Held</span>
            <span className="stat-value">{loading ? "—" : sessions.length}</span>
            <span className="stat-sub">Total sessions</span>
          </div>

          <div className="stat-box emerald">
            <span className="stat-label">Enrolled Students</span>
            <span className="stat-value">{enrolledStudentsList.length}</span>
            <span className="stat-sub">In course roster</span>
          </div>

          <div className="stat-box amber">
            <span className="stat-label">Total Attendances</span>
            <span className="stat-value">{loading ? "—" : totalAttendeesAllSessions}</span>
            <span className="stat-sub">Recorded marks</span>
          </div>
        </div>

        {/* Modal Navigation Tabs */}
        <div className="modal-tab-nav" style={{ margin: "0 24px 16px" }}>
          <button
            type="button"
            className={`tab-item-btn ${activeTab === "sessions" ? "active" : ""}`}
            onClick={() => setActiveTab("sessions")}
          >
            <FaCalendarAlt /> Classes &amp; Sessions ({sessions.length})
          </button>
          <button
            type="button"
            className={`tab-item-btn ${activeTab === "students" ? "active" : ""}`}
            onClick={() => setActiveTab("students")}
          >
            <FaUsers /> Enrolled Students ({enrolledStudentsList.length})
          </button>
        </div>

        {/* Tab 1: Sessions List */}
        {activeTab === "sessions" && (
          <div className="modal-section-card" style={{ margin: "0 24px 20px", padding: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
              <div style={{ fontWeight: 800, fontSize: "0.95rem", color: "var(--text-main, #0f172a)" }}>
                Attendance Sessions Conducted for {courseCode}
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  className="action-btn-pill export"
                  onClick={handleExportSessionsExcel}
                  disabled={sessions.length === 0}
                  style={{ padding: "6px 12px", fontSize: "0.8rem" }}
                >
                  <FaFileExcel /> Export Excel
                </button>
                <button
                  type="button"
                  className="action-btn-pill view"
                  onClick={handleOpenMasterMatrix}
                  style={{ padding: "6px 12px", fontSize: "0.8rem" }}
                >
                  <FaLayerGroup /> Master Sheet
                </button>
              </div>
            </div>

            {loading ? (
              <div style={{ textAlign: "center", padding: "30px", color: "var(--text-muted, #64748b)" }}>
                <FaSyncAlt className="fa-spin" style={{ fontSize: "1.5rem", marginBottom: "8px" }} />
                <p style={{ margin: 0 }}>Loading attendance session records...</p>
              </div>
            ) : sortedSessions.length === 0 ? (
              <div style={{ textAlign: "center", padding: "30px 16px", background: "var(--surface-soft, #f8fafc)", borderRadius: "12px", border: "1px dashed var(--border, #cbd5e1)" }}>
                <FaCalendarAlt style={{ fontSize: "2rem", color: "#94a3b8", marginBottom: "8px" }} />
                <h4 style={{ margin: "0 0 4px", color: "var(--text-main, #0f172a)" }}>No Classes Conducted Yet</h4>
                <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-muted, #64748b)" }}>
                  No attendance sessions have been created for {courseCode} yet.
                </p>
              </div>
            ) : (
              <div className="table-responsive-wrapper" style={{ maxHeight: "300px", overflowY: "auto" }}>
                <table className="modal-data-table">
                  <thead>
                    <tr>
                      <th onClick={() => requestSort("createdAt")} style={{ cursor: "pointer" }}>
                        Date &amp; Time <SortIcon sortConfig={sortConfig} columnKey="createdAt" />
                      </th>
                      <th>Room</th>
                      <th>Conducted By</th>
                      <th onClick={() => requestSort("attendeeCount")} style={{ cursor: "pointer" }}>
                        Turnout <SortIcon sortConfig={sortConfig} columnKey="attendeeCount" />
                      </th>
                      <th>Status</th>
                      <th style={{ textAlign: "right" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSessions.map((sess) => {
                      const isLive = sess.status === "ACTIVE" || sess.phase === "PHASE_1" || sess.phase === "PHASE_2";
                      return (
                        <tr
                          key={sess.id}
                          onClick={() => handleOpenSpecificSession(sess.id)}
                          style={{ cursor: "pointer" }}
                          className="clickable-session-row"
                        >
                          <td>
                            <strong>{sess.createdAt ? new Date(sess.createdAt).toLocaleDateString() : "N/A"}</strong>
                            <div style={{ fontSize: "0.75rem", color: "var(--text-muted, #64748b)" }}>
                              {sess.createdAt ? new Date(sess.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                            </div>
                          </td>
                          <td>
                            <span className="room-chip">{sess.roomNo || classCode}</span>
                          </td>
                          <td>
                            <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>{sess.lecturerName}</span>
                          </td>
                          <td>
                            <span className="turnout-pill">
                              <FaUsers style={{ fontSize: "0.75rem" }} /> {sess.attendeeCount || 0}
                            </span>
                          </td>
                          <td>
                            {isLive ? (
                              <span className="status-badge-active" style={{ fontSize: "0.75rem", padding: "3px 8px" }}>
                                <span className="pulse-dot"></span> Live
                              </span>
                            ) : (
                              <span style={{ fontSize: "0.75rem", color: "#10b981", background: "rgba(16, 185, 129, 0.1)", padding: "3px 8px", borderRadius: "6px", fontWeight: 700 }}>
                                Completed
                              </span>
                            )}
                          </td>
                          <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="action-btn-pill view"
                              onClick={() => handleOpenSpecificSession(sess.id)}
                              style={{ padding: "4px 10px", fontSize: "0.75rem" }}
                            >
                              Inspect
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Enrolled Students */}
        {activeTab === "students" && (
          <div className="modal-section-card" style={{ margin: "0 24px 20px", padding: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
              <div className="modal-search-wrapper" style={{ flex: "1 1 200px", maxWidth: "320px" }}>
                <FaSearch className="modal-search-icon" />
                <input
                  type="text"
                  className="modal-search-input"
                  placeholder="Search enrolled roll or name..."
                  value={studentSearch}
                  onChange={(e) => setStudentSearch(e.target.value)}
                  style={{ width: "100%", padding: "7px 12px 7px 32px", fontSize: "0.85rem", borderRadius: "8px", border: "1px solid var(--border, #cbd5e1)" }}
                />
              </div>

              <div style={{ display: "flex", gap: "8px" }}>
                {onOpenRoster && (
                  <button
                    type="button"
                    className="action-btn-pill edit"
                    onClick={() => {
                      onClose?.();
                      onOpenRoster(course);
                    }}
                    style={{ padding: "6px 12px", fontSize: "0.8rem" }}
                  >
                    <FaUsers /> Manage Roster
                  </button>
                )}
              </div>
            </div>

            {filteredEnrolledStudents.length === 0 ? (
              <div style={{ textAlign: "center", padding: "28px", color: "var(--text-muted, #64748b)" }}>
                <p style={{ margin: 0 }}>No enrolled students match your search.</p>
              </div>
            ) : (
              <div className="table-responsive-wrapper" style={{ maxHeight: "300px", overflowY: "auto" }}>
                <table className="modal-data-table">
                  <thead>
                    <tr>
                      <th>Roll Number</th>
                      <th>Student Name</th>
                      <th>Email</th>
                      <th>Department</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEnrolledStudents.map((stud) => (
                      <tr key={stud.id}>
                        <td>
                          <strong>{stud.rollNo}</strong>
                        </td>
                        <td>{stud.name}</td>
                        <td style={{ fontSize: "0.82rem", color: "var(--text-muted, #64748b)" }}>{stud.email}</td>
                        <td>
                          <span className="department-chip" style={{ fontSize: "0.75rem", padding: "2px 8px" }}>{stud.department}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Modal Footer Actions */}
        <div className="modal-action-footer" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", borderTop: "1px solid var(--border, #e2e8f0)", flexWrap: "wrap", gap: "10px" }}>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {onEditCourse && (
              <button
                type="button"
                className="action-btn-pill edit"
                onClick={() => {
                  onClose?.();
                  onEditCourse(course);
                }}
              >
                Edit Course Details
              </button>
            )}
          </div>

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button
              type="button"
              className="action-btn-pill secondary"
              onClick={onClose}
            >
              Close
            </button>
            <button
              type="button"
              className="action-btn-pill primary"
              onClick={handleOpenCourseAttendances}
              style={{ background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)", color: "#ffffff", fontWeight: 700 }}
            >
              <FaChartBar /> Open All Course Attendances
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
