import React, { useEffect, useState } from "react";
import {
  FaTimes,
  FaUser,
  FaEnvelope,
  FaIdCard,
  FaGraduationCap,
  FaPhone,
  FaCalendarAlt,
  FaVenusMars,
  FaCheckCircle,
  FaTimesCircle,
  FaClipboardList,
  FaHistory,
  FaChalkboard,
  FaFileDownload
} from "react-icons/fa";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../authcontext";
import { downloadExcel } from "../../DownloadExcel";
import { useTableSort, SortIcon } from "./useTableSort";
import "./StudentDetailModal.css";

const StudentDetailModal = ({ student, onClose }) => {
  const { user, profile } = useAuth();
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sessionsMap, setSessionsMap] = useState(new Map());

  const { sortedItems: sortedAttendance, sortConfig, requestSort } = useTableSort(attendanceRecords, "submittedAt", "desc");

  useEffect(() => {
    if (!student || !student.rollNo) {
      setLoading(false);
      return;
    }

    const fetchStudentAttendance = async () => {
      try {
        setLoading(true);

        // Fetch all attendance records for this student's roll number
        const cleanRoll = String(student.rollNo).trim().toUpperCase();
        
        let recordsQuery;
        // If user is lecturer, they can query where ownerId == user.uid, or if admin query all
        const isAdminUser = profile?.role === "admin" || user?.email === "onteddukalyani@gmail.com";

        if (isAdminUser) {
          recordsQuery = query(
            collection(db, "attendance_records"),
            where("rollNo", "==", cleanRoll)
          );
        } else {
          // Lecturer
          recordsQuery = query(
            collection(db, "attendance_records"),
            where("rollNo", "==", cleanRoll)
          );
        }

        const [recordsSnap, sessionsSnap] = await Promise.all([
          getDocs(recordsQuery),
          getDocs(collection(db, "attendance_sessions"))
        ]);

        const sMap = new Map();
        sessionsSnap.docs.forEach((docSnap) => {
          sMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
        });
        setSessionsMap(sMap);

        const records = recordsSnap.docs.map((docSnap) => {
          const data = docSnap.data();
          return {
            id: docSnap.id,
            ...data,
            session: sMap.get(data.sessionId) || null
          };
        });

        // Sort records descending by date
        records.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
        setAttendanceRecords(records);
      } catch (err) {
        console.error("Error fetching student attendance details:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchStudentAttendance();
  }, [student, profile, user]);

  if (!student) return null;

  // Calculate stats
  const totalAttended = attendanceRecords.length;
  const uniqueCourses = new Set(
    attendanceRecords
      .map((r) => r.session?.courseCode || r.session?.classCode)
      .filter(Boolean)
  ).size;

  const handleExportAttendance = () => {
    const exportData = attendanceRecords.map((rec) => ({
      "Student Name": student.name || "N/A",
      "Roll Number": student.rollNo || "N/A",
      "Course Code": rec.session?.courseCode || "N/A",
      "Class Code": rec.session?.classCode || "N/A",
      "Room": rec.roomNo || rec.session?.roomNo || "N/A",
      "Date & Time": rec.submittedAt ? new Date(rec.submittedAt).toLocaleString() : "N/A",
      "Status": "Present"
    }));

    downloadExcel(
      exportData,
      `${student.rollNo}_Attendance_Report_${new Date().toISOString().slice(0, 10)}`
    );
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="student-modal-container" onClick={(e) => e.stopPropagation()}>
        {/* Close Button */}
        <button className="modal-close-btn" onClick={onClose} aria-label="Close modal">
          <FaTimes />
        </button>

        {/* Header Profile Section */}
        <div className="modal-profile-header">
          <div className="modal-avatar-wrapper">
            {student.photoURL || student.image ? (
              <img
                src={student.photoURL || student.image}
                alt={student.name}
                className="modal-avatar-img"
              />
            ) : (
              <div className="modal-avatar-placeholder">
                <FaUser />
              </div>
            )}
          </div>

          <div className="modal-header-meta">
            <h2>{student.name || "Unnamed Student"}</h2>
            <div className="modal-badges-row">
              <span className="badge-roll">
                <FaIdCard /> {student.rollNo || "No Roll No"}
              </span>
              <span className={`badge-status ${student.status === "active" ? "active" : "disabled"}`}>
                {student.status === "active" ? "Active Student" : "Disabled"}
              </span>
              <span className="badge-branch">
                {student.branch || "General"} {student.semester ? `• Sem ${student.semester}` : ""}
              </span>
            </div>
          </div>
        </div>

        {/* Quick Attendance Stats */}
        <div className="modal-stats-grid">
          <div className="stat-box">
            <div className="stat-icon-wrap green">
              <FaCheckCircle />
            </div>
            <div>
              <span className="stat-label">Classes Attended</span>
              <strong className="stat-value">{totalAttended}</strong>
            </div>
          </div>

          <div className="stat-box">
            <div className="stat-icon-wrap indigo">
              <FaChalkboard />
            </div>
            <div>
              <span className="stat-label">Unique Courses</span>
              <strong className="stat-value">{uniqueCourses}</strong>
            </div>
          </div>

          <div className="stat-box">
            <div className="stat-icon-wrap blue">
              <FaHistory />
            </div>
            <div>
              <span className="stat-label">Last Attendance</span>
              <strong className="stat-value">
                {attendanceRecords.length > 0
                  ? new Date(attendanceRecords[0].submittedAt).toLocaleDateString()
                  : "Never"}
              </strong>
            </div>
          </div>
        </div>

        {/* Two-Column Info: Student Details & Attendance Logs */}
        <div className="modal-content-grid">
          {/* Left Column: Personal Information */}
          <div className="info-card">
            <h3>
              <FaUser /> Student Information
            </h3>
            <div className="info-rows">
              <div className="info-row">
                <FaEnvelope className="info-icon" />
                <div>
                  <label>Email Address</label>
                  <span>{student.email || "Not provided"}</span>
                </div>
              </div>

              <div className="info-row">
                <FaPhone className="info-icon" />
                <div>
                  <label>Phone Number</label>
                  <span>{student.phone || "Not provided"}</span>
                </div>
              </div>

              <div className="info-row">
                <FaGraduationCap className="info-icon" />
                <div>
                  <label>Branch & Semester</label>
                  <span>{student.branch || "N/A"} - Semester {student.semester || "1"}</span>
                </div>
              </div>

              <div className="info-row">
                <FaVenusMars className="info-icon" />
                <div>
                  <label>Gender</label>
                  <span>{student.gender ? student.gender.toUpperCase() : "Not specified"}</span>
                </div>
              </div>

              <div className="info-row">
                <FaCalendarAlt className="info-icon" />
                <div>
                  <label>Date of Birth</label>
                  <span>{student.dob || "Not specified"}</span>
                </div>
              </div>

              <div className="info-row">
                {student.faceRegistered ? (
                  <FaCheckCircle className="info-icon success" />
                ) : (
                  <FaTimesCircle className="info-icon warning" />
                )}
                <div>
                  <label>Face Biometric Status</label>
                  <span>{student.faceRegistered ? "Registered ✅" : "Not Registered ⏳"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Attendance Activity History */}
          <div className="info-card recorded-classes-card">
            <div className="card-header-flex">
              <div className="card-title-group">
                <div className="card-title-icon-badge">
                  <FaClipboardList />
                </div>
                <div>
                  <h3>Attendance History</h3>
                  <span className="card-subtitle-count">{totalAttended} classes attended</span>
                </div>
              </div>
              {attendanceRecords.length > 0 && (
                <button
                  type="button"
                  className="mini-export-btn"
                  onClick={handleExportAttendance}
                  title="Export Attendance History"
                >
                  <FaFileDownload /> Export
                </button>
              )}
            </div>

            {loading ? (
              <div className="history-loading">Loading attendance records...</div>
            ) : attendanceRecords.length === 0 ? (
              <div className="history-empty">
                <div className="empty-icon-capsule">
                  <FaClipboardList className="empty-icon" />
                </div>
                <h4>No Attendance Records Yet</h4>
                <p>This student has not marked attendance in any recorded sessions yet.</p>
                <div className="empty-state-badge">
                  <span className="standby-dot"></span>
                  <span>Standby • Ready for class attendance</span>
                </div>
              </div>
            ) : (
              <div className="history-table-container">
                <table className="modal-history-table">
                  <thead>
                    <tr>
                      <th className="sortable-th" onClick={() => requestSort("session.courseCode")} title="Click to sort by Course / Class">
                        Course / Class <SortIcon sortConfig={sortConfig} columnKey="session.courseCode" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("roomNo")} title="Click to sort by Room">
                        Room <SortIcon sortConfig={sortConfig} columnKey="roomNo" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Date & Time">
                        Date & Time <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                      </th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedAttendance.map((rec) => (
                      <tr key={rec.id}>
                        <td>
                          <strong>{rec.session?.courseCode || rec.session?.classCode || "Class Session"}</strong>
                          {rec.session?.classCode && rec.session?.courseCode && (
                            <small className="sub-text"> ({rec.session.classCode})</small>
                          )}
                        </td>
                        <td>{rec.roomNo || rec.session?.roomNo || "N/A"}</td>
                        <td>
                          {rec.submittedAt ? (
                            <span>{new Date(rec.submittedAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
                          ) : (
                            "N/A"
                          )}
                        </td>
                        <td>
                          <span className="present-badge">Present ✅</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default StudentDetailModal;
