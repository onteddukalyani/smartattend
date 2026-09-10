import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  FaFileDownload,
  FaCamera,
  FaSave,
  FaRedo,
  FaTrashAlt,
  FaShieldAlt
} from "react-icons/fa";
import { collection, getDocs, query, where, doc, setDoc, deleteDoc, onSnapshot } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../authcontext";
import { downloadExcel } from "../../DownloadExcel";
import { useTableSort, SortIcon } from "./useTableSort";
import { LiveFaceEnrollment } from "./LiveFaceEnrollment";
import { removeStudentFaceAndBiometrics, removeStudentPhotoOnly, checkDuplicateFaceBiometrics } from "../../utils/biometricManager";
import { deleteStudentRecordCompletely } from "../../utils/studentDataHelper";
import "./StudentDetailModal.css";

const StudentDetailModal = ({ student, onClose, onUpdate }) => {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [currentStudent, setCurrentStudent] = useState(student);
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sessionsMap, setSessionsMap] = useState(new Map());

  // Biometric Enrollment State
  const [showFaceEnroll, setShowFaceEnroll] = useState(false);
  const [enrolledBiometric, setEnrolledBiometric] = useState(null);
  const [savingFace, setSavingFace] = useState(false);
  const [removingFace, setRemovingFace] = useState(false);
  const [removingPhoto, setRemovingPhoto] = useState(false);
  const [deletingStudent, setDeletingStudent] = useState(false);
  const [faceSuccessMsg, setFaceSuccessMsg] = useState("");

  const isCurrentAdminPath = window.location.pathname.startsWith("/admin");
  const isCurrentLecturerPath = window.location.pathname.startsWith("/lecturer");

  const isAdmin = isCurrentAdminPath || (!isCurrentLecturerPath && (
    profile?.role === "admin" ||
    profile?.role === "administrator" ||
    profile?.role === "superadmin"
  ));

  const isLecturer = isCurrentLecturerPath || (!isCurrentAdminPath && (
    profile?.role === "lecturer" ||
    profile?.role === "faculty" ||
    profile?.role === "professor"
  ));

  const isStaff = isAdmin || isLecturer;
  const basePath = isCurrentAdminPath ? "/admin/classes" : "/lecturer/attendance-sessions";

  const { sortedItems: sortedAttendance, sortConfig, requestSort } = useTableSort(attendanceRecords, "submittedAt", "desc");

  // Sync currentStudent with updated student prop and live listeners
  useEffect(() => {
    if (student) {
      setCurrentStudent(student);
    }
  }, [student]);

  useEffect(() => {
    if (!currentStudent || !currentStudent.rollNo) return;
    const cleanRoll = String(currentStudent.rollNo).trim().toUpperCase();
    const cleanEmail = (currentStudent.email || "").toLowerCase().trim();

    const unsubStudent = onSnapshot(doc(db, "students", cleanRoll), (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        setCurrentStudent((prev) => ({ ...(prev || {}), ...d }));
      }
    }, (err) => console.warn("Student doc snapshot warning:", err));

    const unsubUser = onSnapshot(doc(db, "users", cleanRoll), (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        setCurrentStudent((prev) => ({ ...(prev || {}), ...d }));
      }
    }, (err) => console.warn("User doc snapshot warning:", err));

    return () => {
      unsubStudent();
      unsubUser();
    };
  }, [currentStudent?.rollNo]);

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

        const recordsQuery = query(
          collection(db, "attendance_records"),
          where("rollNo", "==", cleanRoll)
        );

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
  }, [student]);

  if (!student) return null;

  // Aggregate stats
  const totalAttended = attendanceRecords.length;
  const uniqueCourses = new Set(attendanceRecords.map(r => r.session?.courseId || r.courseId).filter(Boolean)).size;

  const isFaceExplicitlyRemoved = Boolean(
    currentStudent?.faceRemovedAt ||
    currentStudent?.faceRegistered === false ||
    currentStudent?.biometricEnrolled === false ||
    currentStudent?.hasFaceRegistered === false
  );

  const isFaceEnrolled = Boolean(
    !isFaceExplicitlyRemoved &&
    Array.isArray(currentStudent?.faceDescriptor) &&
    currentStudent.faceDescriptor.length === 128
  );

  const handleExportAttendance = () => {
    if (!attendanceRecords.length) {
      alert("No attendance records to export for this student.");
      return;
    }

    const exportData = attendanceRecords.map((r) => ({
      "Roll Number": currentStudent.rollNo || "",
      "Student Name": currentStudent.name || "",
      "Course Code": r.session?.courseCode || r.courseCode || "N/A",
      "Course Name": r.session?.courseName || r.courseName || "General Session",
      "Date": r.submittedAt ? new Date(r.submittedAt).toLocaleDateString() : "N/A",
      "Time": r.submittedAt ? new Date(r.submittedAt).toLocaleTimeString() : "N/A",
      "Status": r.status || "Present",
      "Confidence": r.confidence ? `${r.confidence}%` : "100%",
      "Method": r.method || "Biometric Face + QR"
    }));

    downloadExcel(exportData, `Attendance_${currentStudent.rollNo || "Student"}_Report`);
  };

  const handleExportDetails = handleExportAttendance;

  const handleSaveBiometrics = async () => {
    if (!enrolledBiometric || !enrolledBiometric.faceDescriptor) return;
    try {
      setSavingFace(true);
      const cleanRoll = String(currentStudent.rollNo || currentStudent.id || "").trim().toUpperCase();
      const cleanEmail = String(currentStudent.email || "").trim().toLowerCase();
      const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase().trim() : cleanRoll.toLowerCase();

      const rawVector = enrolledBiometric.faceDescriptor;
      const cleanVector = Array.isArray(rawVector) ? rawVector : Array.from(rawVector);

      // Verify no other registered student has this biometric face
      const duplicateCheck = await checkDuplicateFaceBiometrics(cleanVector, cleanRoll, cleanEmail);
      if (duplicateCheck.isDuplicate && duplicateCheck.conflictStudent) {
        const cs = duplicateCheck.conflictStudent;
        alert(`⛔ Duplicate Face Detected!\n\nThis face is already registered to "${cs.name}" (Roll No: ${cs.rollNo} • ${cs.confidence}% Match).\n\nThe system strictly prohibits saving duplicate facial biometric templates across multiple students.`);
        setSavingFace(false);
        return;
      }

      const updateData = {
        faceDescriptor: cleanVector,
        photoURL: enrolledBiometric.photoURL || currentStudent.photoURL || "",
        faceRegistered: true,
        biometricEnrolled: true,
        hasFaceRegistered: true,
        enrolledAt: Date.now()
      };

      const promises = [];
      if (cleanRoll) {
        promises.push(setDoc(doc(db, "students", cleanRoll), updateData, { merge: true }));
        promises.push(setDoc(doc(db, "users", cleanRoll), updateData, { merge: true }));
      }
      if (cleanEmail) {
        promises.push(setDoc(doc(db, "authorizedUsers", cleanEmail), updateData, { merge: true }).catch(() => { }));
        promises.push(setDoc(doc(db, "students", cleanEmail), updateData, { merge: true }).catch(() => { }));
        promises.push(setDoc(doc(db, "users", cleanEmail), updateData, { merge: true }).catch(() => { }));
      }
      if (prefix && prefix !== cleanRoll.toLowerCase()) {
        promises.push(setDoc(doc(db, "students", prefix), updateData, { merge: true }).catch(() => { }));
        promises.push(setDoc(doc(db, "users", prefix), updateData, { merge: true }).catch(() => { }));
        promises.push(setDoc(doc(db, "authorizedUsers", prefix), updateData, { merge: true }).catch(() => { }));
      }
      if (currentStudent.id && currentStudent.id !== cleanRoll && currentStudent.id !== cleanEmail) {
        promises.push(setDoc(doc(db, "students", currentStudent.id), updateData, { merge: true }).catch(() => { }));
        promises.push(setDoc(doc(db, "users", currentStudent.id), updateData, { merge: true }).catch(() => { }));
      }
      if (currentStudent.userDocId) {
        promises.push(setDoc(doc(db, "users", currentStudent.userDocId), updateData, { merge: true }).catch(() => { }));
      }

      await Promise.all(promises);

      const updatedStudent = {
        ...currentStudent,
        ...updateData
      };

      setCurrentStudent(updatedStudent);
      onUpdate?.(updatedStudent);

      setFaceSuccessMsg("✅ Face biometric enrolled & synchronized successfully across database!");
      setTimeout(() => {
        setShowFaceEnroll(false);
        setFaceSuccessMsg("");
      }, 2500);
    } catch (err) {
      console.error("Error saving face biometric:", err);
      alert("Failed to save biometric: " + err.message);
    } finally {
      setSavingFace(false);
    }
  };

  const handleRemoveFaceBiometrics = async () => {
    if (!isStaff) {
      alert("Only administrators and faculty lecturers have permission to remove registered facial biometrics.");
      return;
    }

    const studentName = currentStudent.name || "Student";
    const studentRoll = currentStudent.rollNo || currentStudent.id || "";

    const confirm = window.confirm(
      `⚠️ Clear Facial Biometrics & Photo?\n\nAre you sure you want to remove the registered facial biometric data and enrolled photo for ${studentName} (${studentRoll})?\n\nThis will permanently clear their 128-D biometric vector and avatar photo across all database collections.`
    );
    if (!confirm) return;

    try {
      setRemovingFace(true);
      await removeStudentFaceAndBiometrics(currentStudent);

      const updatedStudent = {
        ...currentStudent,
        faceRegistered: false,
        biometricEnrolled: false,
        hasFaceRegistered: false,
        faceDescriptor: null,
        photoURL: "",
        image: "",
        photo: ""
      };

      setCurrentStudent(updatedStudent);
      onUpdate?.(updatedStudent);

      setShowFaceEnroll(false);
      setFaceSuccessMsg("🗑️ Registered facial biometric data and photo have been completely removed.");
      setTimeout(() => {
        setFaceSuccessMsg("");
      }, 3500);
    } catch (err) {
      console.error("Error removing face biometrics:", err);
      alert("Failed to remove face biometrics: " + err.message);
    } finally {
      setRemovingFace(false);
    }
  };

  const handleRemovePhotoOnly = async () => {
    if (!isStaff) {
      alert("Only administrators and faculty lecturers have permission to remove student photos.");
      return;
    }

    const studentName = currentStudent.name || "Student";
    const studentRoll = currentStudent.rollNo || currentStudent.id || "";

    const confirm = window.confirm(
      `⚠️ Delete Student Photo?\n\nAre you sure you want to delete the photo for ${studentName} (${studentRoll})?`
    );
    if (!confirm) return;

    try {
      setRemovingPhoto(true);
      await removeStudentPhotoOnly(currentStudent);

      const updatedStudent = {
        ...currentStudent,
        photoURL: "",
        image: "",
        photo: ""
      };

      setCurrentStudent(updatedStudent);
      onUpdate?.(updatedStudent);

      setFaceSuccessMsg("🗑️ Student photo has been deleted.");
      setTimeout(() => {
        setFaceSuccessMsg("");
      }, 3000);
    } catch (err) {
      console.error("Error removing photo:", err);
      alert("Failed to remove photo: " + err.message);
    } finally {
      setRemovingPhoto(false);
    }
  };

  const handleDeleteStudent = async () => {
    if (!isStaff) {
      alert("Only faculty lecturers and administrators have permission to delete student records.");
      return;
    }

    const studentName = currentStudent.name || "Student";
    const studentRoll = currentStudent.rollNo || currentStudent.id || "";

    const confirm = window.confirm(
      `⚠️ Delete Student Record?\n\nAre you sure you want to permanently delete ${studentName} (${studentRoll})?\n\nThis will completely purge their record across all database collections (users, students, and authorized users). This action cannot be undone.`
    );
    if (!confirm) return;

    try {
      setDeletingStudent(true);
      const cleanRoll = String(currentStudent.rollNo || currentStudent.id || "").trim().toUpperCase();

      await deleteStudentRecordCompletely(currentStudent);

      alert(`✅ Student ${studentName} (${cleanRoll}) was successfully deleted.`);
      if (onUpdate) onUpdate(null);
      if (onClose) onClose();
    } catch (err) {
      console.error("Error deleting student:", err);
      alert("Failed to delete student record: " + err.message);
    } finally {
      setDeletingStudent(false);
    }
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
          <div className="modal-avatar-container-outer">
            <div className="modal-avatar-wrapper">
              {currentStudent.photoURL || currentStudent.image ? (
                <img
                  src={currentStudent.photoURL || currentStudent.image}
                  alt={currentStudent.name}
                  className="modal-avatar-img"
                />
              ) : (
                <div className="modal-avatar-placeholder">
                  <FaUser />
                </div>
              )}
            </div>
            {isStaff && (currentStudent.photoURL || currentStudent.image) && (
              <button
                type="button"
                className="modal-avatar-delete-photo-btn"
                title="Staff action: Delete student profile photo"
                onClick={handleRemovePhotoOnly}
                disabled={removingPhoto}
                aria-label="Delete student photo"
              >
                <FaTrashAlt />
              </button>
            )}
          </div>

          <div className="modal-header-meta">
            <h2>{currentStudent.name || "Unnamed Student"}</h2>
            <div className="modal-badges-row">
              <span className="badge-roll">
                <FaIdCard /> {currentStudent.rollNo || "No Roll No"}
              </span>
              <span className={`badge-status ${currentStudent.status === "active" ? "active" : "disabled"}`}>
                {currentStudent.status === "active" ? "Active Student" : "Disabled"}
              </span>
              <span className="badge-branch">
                {(currentStudent.branch && String(currentStudent.branch).toLowerCase() !== "general") ? currentStudent.branch : "CSE"} {currentStudent.semester ? `• Sem ${currentStudent.semester}` : ""}
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
                  <span>{currentStudent.email || "Not provided"}</span>
                </div>
              </div>

              <div className="info-row">
                <FaPhone className="info-icon" />
                <div>
                  <label>Phone Number</label>
                  <span>{currentStudent.phone || "Not provided"}</span>
                </div>
              </div>

              <div className="info-row">
                <FaGraduationCap className="info-icon" />
                <div>
                  <label>Branch & Semester</label>
                  <span>{(currentStudent.branch && String(currentStudent.branch).toLowerCase() !== "general") ? currentStudent.branch : "CSE"} - Semester {currentStudent.semester || "1"}</span>
                </div>
              </div>

              <div className="info-row">
                <FaVenusMars className="info-icon" />
                <div>
                  <label>Gender</label>
                  <span>{currentStudent.gender ? currentStudent.gender.toUpperCase() : "Not specified"}</span>
                </div>
              </div>

              <div className="info-row">
                <FaCalendarAlt className="info-icon" />
                <div>
                  <label>Date of Birth</label>
                  <span>{currentStudent.dob || "Not specified"}</span>
                </div>
              </div>

              <div className="info-row">
                {isFaceEnrolled ? (
                  <FaCheckCircle className="info-icon success" />
                ) : (
                  <FaTimesCircle className="info-icon warning" />
                )}
                <div>
                  <label>Face Biometric Status</label>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
                    <span>{isFaceEnrolled ? "Registered & Active ✅" : "Not Registered ⏳"}</span>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      {isStaff && isFaceEnrolled && (
                        <button
                          type="button"
                          onClick={handleRemoveFaceBiometrics}
                          disabled={removingFace}
                          title="Staff Action: Clear student's facial biometric data and enrolled photo"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            fontSize: "0.78rem",
                            fontWeight: 700,
                            padding: "5px 10px",
                            borderRadius: "8px",
                            background: "rgba(239, 68, 68, 0.12)",
                            color: "#ef4444",
                            border: "1px solid rgba(239, 68, 68, 0.3)",
                            cursor: removingFace ? "not-allowed" : "pointer"
                          }}
                        >
                          <FaTrashAlt /> {removingFace ? "Removing..." : "Remove Face & Photo"}
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setShowFaceEnroll((prev) => !prev)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          fontSize: "0.8rem",
                          fontWeight: 700,
                          padding: "5px 12px",
                          borderRadius: "8px",
                          background: showFaceEnroll ? "var(--surface-soft, #f1f5f9)" : "linear-gradient(135deg, #6366f1, #4f46e5)",
                          color: showFaceEnroll ? "var(--text-main, #334155)" : "#ffffff",
                          border: "1px solid var(--border, #cbd5e1)",
                          cursor: "pointer"
                        }}
                      >
                        <FaCamera /> {showFaceEnroll ? "Hide Camera" : (isFaceEnrolled ? "Re-enroll Face" : "Enroll Face")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Live Face Enrollment in Modal */}
              {showFaceEnroll && (
                <div style={{ marginTop: "12px", borderTop: "1px solid var(--border, #e2e8f0)", paddingTop: "12px" }}>
                  <LiveFaceEnrollment
                    hideHeader={true}
                    targetRollNo={currentStudent?.rollNo}
                    targetEmail={currentStudent?.email}
                    targetName={currentStudent?.name}
                    onFaceEnrolled={(data) => setEnrolledBiometric(data)}
                  />
                  {enrolledBiometric?.faceDescriptor && (
                    <div style={{ marginTop: "12px", textAlign: "center" }}>
                      <button
                        type="button"
                        onClick={handleSaveBiometrics}
                        disabled={savingFace}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "8px",
                          padding: "10px 20px",
                          borderRadius: "10px",
                          background: "#6366f1",
                          color: "#ffffff",
                          border: "none",
                          fontWeight: 700,
                          fontSize: "0.9rem",
                          cursor: savingFace ? "not-allowed" : "pointer",
                          boxShadow: "0 4px 12px rgba(99, 102, 241, 0.3)"
                        }}
                      >
                        <FaSave /> {savingFace ? "Saving Biometrics..." : "💾 Save & Sync Face Biometrics"}
                      </button>
                    </div>
                  )}
                  {faceSuccessMsg && (
                    <div style={{ marginTop: "10px", padding: "8px 12px", background: "#dcfce7", color: "#15803d", borderRadius: "8px", fontSize: "0.85rem", fontWeight: 700, textAlign: "center" }}>
                      {faceSuccessMsg}
                    </div>
                  )}
                </div>
              )}

              {/* Delete Student Action for Staff */}
              {isStaff && (
                <div style={{ marginTop: "20px", borderTop: "1px solid var(--border, #e2e8f0)", paddingTop: "14px", display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={handleDeleteStudent}
                    disabled={deletingStudent}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "9px 18px",
                      borderRadius: "10px",
                      background: "rgba(239, 68, 68, 0.12)",
                      color: "#ef4444",
                      border: "1.5px solid rgba(239, 68, 68, 0.35)",
                      fontWeight: 700,
                      fontSize: "0.85rem",
                      cursor: deletingStudent ? "not-allowed" : "pointer",
                      transition: "all 0.2s ease"
                    }}
                    title="Permanently remove this student record from all database collections"
                  >
                    <FaTrashAlt /> {deletingStudent ? "Deleting Student..." : "Delete Student Record"}
                  </button>
                </div>
              )}
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
                    {sortedAttendance.map((rec) => {
                      const targetSessionId = rec.sessionId || rec.session?.id || (rec.id && rec.id.includes("_") ? rec.id.split("_")[0] : rec.id);

                      return (
                        <tr
                          key={rec.id}
                          onClick={() => {
                            if (targetSessionId) {
                              navigate(`${basePath}/${targetSessionId}`);
                              if (onClose) onClose();
                            }
                          }}
                          style={{ cursor: targetSessionId ? "pointer" : "default" }}
                          title={targetSessionId ? "Click to view full class session attendance" : ""}
                        >
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
                      );
                    })}
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
