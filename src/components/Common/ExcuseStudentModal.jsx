import React, { useState, useEffect, useMemo } from "react";
import {
  FaTimes,
  FaUserCheck,
  FaCalendarAlt,
  FaBookOpen,
  FaSearch,
  FaCheckCircle,
  FaSpinner,
  FaExclamationTriangle,
  FaInfoCircle,
  FaRegCheckCircle,
  FaUndoAlt
} from "react-icons/fa";
import {
  doc,
  setDoc,
  deleteDoc,
  updateDoc,
  arrayUnion,
  increment,
  getDoc
} from "firebase/firestore";
import { db } from "../../firebase";
import { sendStudentNotification, sendFacultyNotification } from "../../services/notificationsService";
import "./ExcuseStudentModal.css";

const PRESET_REASONS = [
  { id: "medical", label: "🏥 Medical / Sick Leave", text: "Medical Leave" },
  { id: "od", label: "🏛️ On-Duty (OD) / College Event", text: "On-Duty (Official College Event)" },
  { id: "sports", label: "⚽ Sports / Tournament", text: "Sports / Inter-College Tournament" },
  { id: "leave", label: "📝 Approved Personal Leave", text: "Approved Personal Leave" },
  { id: "permission", label: "⚡ Special Faculty Permission", text: "Special Faculty Permission" }
];

export default function ExcuseStudentModal({
  isOpen,
  onClose,
  allCourses = [],
  allStudents = [],
  allSessions = [],
  matrixMap = new Map(),
  defaultCourse = "",
  prefilledStudent = null,
  prefilledSessionId = null,
  profile = null,
  user = null,
  onExcuseSuccess = null
}) {
  // Course State
  const [selectedCourse, setSelectedCourse] = useState("");
  
  // Student Search & Selection State
  const [studentSearch, setStudentSearch] = useState("");
  const [selectedStudent, setSelectedStudent] = useState(null);
  
  // Date / Session Mode: "existing" | "date"
  const [sessionMode, setSessionMode] = useState("existing");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [customDate, setCustomDate] = useState(() => new Date().toISOString().slice(0, 10));
  
  // Excuse Reason & Remarks
  const [selectedPreset, setSelectedPreset] = useState("medical");
  const [customReason, setCustomReason] = useState("");
  const [remarks, setRemarks] = useState("");

  // Submission State
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null); // { type: 'success' | 'error', text: '' }

  // Initialize modal state on open
  useEffect(() => {
    if (!isOpen) return;
    setStatusMessage(null);

    // Initial course resolution
    const initialCourse = defaultCourse && defaultCourse !== "ALL"
      ? defaultCourse
      : (allCourses[0]?.code || allCourses[0]?.courseCode || allCourses[0]?.id || "");
    setSelectedCourse(initialCourse);

    // Initial student resolution
    if (prefilledStudent) {
      setSelectedStudent(prefilledStudent);
      setStudentSearch(prefilledStudent.rollNo || prefilledStudent.name || "");
    } else {
      setSelectedStudent(null);
      setStudentSearch("");
    }

    // Initial session resolution
    if (prefilledSessionId) {
      setSelectedSessionId(prefilledSessionId);
      setSessionMode("existing");
    } else {
      setSelectedSessionId("");
    }

    setSelectedPreset("medical");
    setCustomReason("");
    setRemarks("");
  }, [isOpen, defaultCourse, prefilledStudent, prefilledSessionId, allCourses]);

  // Filter sessions matching selectedCourse
  const courseSessions = useMemo(() => {
    if (!selectedCourse) return [];
    const norm = selectedCourse.toUpperCase().trim();
    return allSessions
      .filter((s) => {
        const c1 = (s.courseCode || "").toUpperCase().trim();
        const c2 = (s.classCode || "").toUpperCase().trim();
        return c1 === norm || c2 === norm;
      })
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [allSessions, selectedCourse]);

  // Set default selectedSessionId when course changes
  useEffect(() => {
    if (courseSessions.length > 0 && !selectedSessionId) {
      setSelectedSessionId(courseSessions[0].id);
    }
  }, [courseSessions, selectedSessionId]);

  // Filter students based on studentSearch
  const filteredStudents = useMemo(() => {
    if (!studentSearch.trim()) return allStudents.slice(0, 30);
    const q = studentSearch.toLowerCase().trim();
    return allStudents.filter((s) => {
      const name = (s.name || s.fullName || "").toLowerCase();
      const roll = (s.rollNo || s.id || "").toLowerCase();
      return name.includes(q) || roll.includes(q);
    }).slice(0, 30);
  }, [allStudents, studentSearch]);

  // Current Attendance Status for selected student on the chosen session
  const currentAttendanceStatus = useMemo(() => {
    if (!selectedStudent) return null;
    const cleanRoll = String(selectedStudent.rollNo || selectedStudent.id || "").trim().toUpperCase();
    if (!cleanRoll) return null;

    let targetSessId = selectedSessionId;
    if (sessionMode === "date" && customDate) {
      const matchSess = courseSessions.find((s) => {
        if (!s.createdAt) return false;
        return new Date(s.createdAt).toISOString().slice(0, 10) === customDate;
      });
      if (matchSess) targetSessId = matchSess.id;
    }

    if (!targetSessId) return null;

    const mark = matrixMap.get(`${cleanRoll}_${targetSessId}`) ||
                 matrixMap.get(`${cleanRoll.toLowerCase()}_${targetSessId}`);
    if (!mark) return { status: "ABSENT", isPresent: false, isExcused: false };

    const isExcused = Boolean(mark.isExcused || mark.excused || mark.status === "EXCUSED" || mark.attendanceStatus === "EXCUSED");
    return {
      status: isExcused ? "EXCUSED" : "PRESENT",
      isPresent: true,
      isExcused,
      reason: mark.excuseReason || mark.remarks || "",
      excusedBy: mark.excusedBy || ""
    };
  }, [selectedStudent, selectedSessionId, sessionMode, customDate, courseSessions, matrixMap]);

  if (!isOpen) return null;

  // Resolve Effective Reason Text
  const effectiveReason = customReason.trim()
    ? customReason.trim()
    : (PRESET_REASONS.find((r) => r.id === selectedPreset)?.text || "Excused Absence");

  // Handle Excuse Submission
  const handleSubmitExcuse = async (e) => {
    if (e) e.preventDefault();
    if (!selectedCourse) {
      setStatusMessage({ type: "error", text: "Please select a course." });
      return;
    }
    if (!selectedStudent) {
      setStatusMessage({ type: "error", text: "Please select a student to excuse." });
      return;
    }

    setSubmitting(true);
    setStatusMessage(null);

    const cleanRoll = String(selectedStudent.rollNo || selectedStudent.id || "").trim().toUpperCase();
    const studentName = selectedStudent.name || selectedStudent.fullName || cleanRoll;
    const studentUid = selectedStudent.uid || selectedStudent.studentUid || cleanRoll;
    const courseCode = selectedCourse.toUpperCase().trim();
    const courseObj = allCourses.find((c) => (c.code || c.courseCode || c.id) === selectedCourse) || {};
    const courseName = courseObj.name || courseObj.courseName || courseCode;
    const lecturerName = profile?.name || profile?.email || "Faculty Lecturer";
    const lecturerEmail = user?.email || "";

    try {
      let targetSessionId = selectedSessionId;
      let sessionTimestamp = Date.now();
      let sessionDateString = customDate;

      if (sessionMode === "existing") {
        const foundSess = courseSessions.find((s) => s.id === selectedSessionId);
        if (foundSess) {
          targetSessionId = foundSess.id;
          sessionTimestamp = foundSess.createdAt || Date.now();
          sessionDateString = new Date(sessionTimestamp).toISOString().slice(0, 10);
        } else {
          throw new Error("Please select an existing class session.");
        }
      } else {
        // Mode is "date"
        if (!customDate) throw new Error("Please pick a valid date.");
        sessionDateString = customDate;
        const matchingSess = courseSessions.find((s) => {
          if (!s.createdAt) return false;
          return new Date(s.createdAt).toISOString().slice(0, 10) === customDate;
        });

        if (matchingSess) {
          targetSessionId = matchingSess.id;
          sessionTimestamp = matchingSess.createdAt || Date.now();
        } else {
          // Create a synthetic excused session record in attendance_sessions so it registers everywhere
          const parsedDate = new Date(`${customDate}T10:00:00`);
          sessionTimestamp = isNaN(parsedDate.getTime()) ? Date.now() : parsedDate.getTime();
          targetSessionId = `EXCUSED_${courseCode}_${customDate.replace(/-/g, "")}`;

          const newSessionPayload = {
            id: targetSessionId,
            sessionId: targetSessionId,
            courseCode: courseCode,
            classCode: courseCode,
            courseName: courseName,
            date: customDate,
            createdAt: sessionTimestamp,
            timestamp: sessionTimestamp,
            durationHours: 1.0,
            roomNo: "Room Excused",
            lecturerName: lecturerName,
            lecturerEmail: lecturerEmail,
            active: false,
            isExcusedSession: true,
            attendedCount: 1,
            attendees: [
              {
                rollNo: cleanRoll,
                studentName: studentName,
                studentUid: studentUid,
                status: "EXCUSED",
                excused: true,
                excuseReason: effectiveReason,
                timestamp: sessionTimestamp
              }
            ]
          };

          await setDoc(doc(db, "attendance_sessions", targetSessionId), newSessionPayload, { merge: true });
        }
      }

      // 1. Write authoritative record into attendance_records collection
      const recordDocId = `${targetSessionId}_${cleanRoll}`;
      const recordRef = doc(db, "attendance_records", recordDocId);

      const attendanceRecordPayload = {
        id: recordDocId,
        sessionId: targetSessionId,
        rollNo: cleanRoll,
        studentUid: studentUid,
        studentName: studentName,
        courseCode: courseCode,
        classCode: courseCode,
        courseName: courseName,
        date: sessionDateString,
        status: "EXCUSED",
        attendanceStatus: "EXCUSED",
        verified: true,
        isExcused: true,
        excused: true,
        excuseReason: effectiveReason,
        remarks: remarks.trim() || "",
        excusedBy: lecturerName,
        excusedByEmail: lecturerEmail,
        excusedAt: Date.now(),
        submittedAt: sessionTimestamp,
        timestamp: sessionTimestamp
      };

      await setDoc(recordRef, attendanceRecordPayload, { merge: true });

      // 2. Append/Update student entry on attendance_sessions doc
      try {
        const sessRef = doc(db, "attendance_sessions", targetSessionId);
        const sessDocSnap = await getDoc(sessRef);
        if (sessDocSnap.exists()) {
          const sessData = sessDocSnap.data() || {};
          const currentAttendees = Array.isArray(sessData.attendees) ? sessData.attendees : [];
          const existingIdx = currentAttendees.findIndex((att) => {
            const r = String(att?.rollNo || att?.rollNumber || att || "").trim().toUpperCase();
            return r === cleanRoll;
          });

          const newAttendeeObj = {
            rollNo: cleanRoll,
            studentName: studentName,
            studentUid: studentUid,
            status: "EXCUSED",
            excused: true,
            excuseReason: effectiveReason,
            timestamp: sessionTimestamp
          };

          let updatedAttendees;
          let countIncrement = 0;
          if (existingIdx >= 0) {
            updatedAttendees = [...currentAttendees];
            updatedAttendees[existingIdx] = { ...updatedAttendees[existingIdx], ...newAttendeeObj };
          } else {
            updatedAttendees = [...currentAttendees, newAttendeeObj];
            countIncrement = 1;
          }

          const sessUpdate = { attendees: updatedAttendees };
          if (countIncrement > 0) {
            sessUpdate.attendedCount = increment(countIncrement);
          }
          await updateDoc(sessRef, sessUpdate);
        }
      } catch (sessErr) {
        console.warn("Notice updating session doc attendees array:", sessErr);
      }

      // 3. Dispatch real-time student notification
      await sendStudentNotification(
        cleanRoll,
        `Attendance Excused ✅ (${courseCode})`,
        `Your attendance for ${courseCode} on ${sessionDateString} has been marked as Excused (${effectiveReason}) by ${lecturerName}.`,
        "ATTENDANCE_EXCUSED",
        lecturerName
      ).catch(() => {});

      // 4. Dispatch real-time faculty audit notification
      await sendFacultyNotification(
        `Attendance Excused: ${cleanRoll}`,
        `Student ${studentName} (${cleanRoll}) was granted excused attendance in ${courseCode} (${sessionDateString}) by ${lecturerName}. Reason: ${effectiveReason}.`,
        "ATTENDANCE_EXCUSED",
        cleanRoll,
        lecturerName
      ).catch(() => {});

      setStatusMessage({
        type: "success",
        text: `✅ Attendance successfully marked as Excused for ${studentName} (${cleanRoll}) on ${sessionDateString}. All attendance sheets and student records have updated!`
      });

      if (onExcuseSuccess) {
        onExcuseSuccess({
          rollNo: cleanRoll,
          sessionId: targetSessionId,
          courseCode,
          date: sessionDateString,
          status: "EXCUSED"
        });
      }

      // Automatically dismiss after 2.5 seconds
      setTimeout(() => {
        onClose();
      }, 2500);

    } catch (err) {
      console.error("Error submitting student excuse:", err);
      setStatusMessage({
        type: "error",
        text: err.message || "Failed to mark student as excused. Please try again."
      });
    } finally {
      setSubmitting(false);
    }
  };

  // Handle Remove / Un-excuse Attendance
  const handleRemoveExcuse = async () => {
    if (!selectedStudent || !selectedSessionId) return;
    const cleanRoll = String(selectedStudent.rollNo || selectedStudent.id || "").trim().toUpperCase();
    const studentName = selectedStudent.name || cleanRoll;
    const confirmed = window.confirm(
      `Revert Excused Attendance?\n\nAre you sure you want to remove the excused attendance record for ${studentName} (${cleanRoll})? This will mark them absent for this class session across all pages.`
    );
    if (!confirmed) return;

    setSubmitting(true);
    setStatusMessage(null);

    try {
      // Delete from attendance_records
      const recordDocId = `${selectedSessionId}_${cleanRoll}`;
      await deleteDoc(doc(db, "attendance_records", recordDocId)).catch(() => {});

      // Remove from session attendees
      const sessRef = doc(db, "attendance_sessions", selectedSessionId);
      const sessSnap = await getDoc(sessRef);
      if (sessSnap.exists()) {
        const sessData = sessSnap.data() || {};
        const currentAttendees = Array.isArray(sessData.attendees) ? sessData.attendees : [];
        const filteredAttendees = currentAttendees.filter((att) => {
          const r = String(att?.rollNo || att?.rollNumber || att || "").trim().toUpperCase();
          return r !== cleanRoll;
        });
        await updateDoc(sessRef, {
          attendees: filteredAttendees,
          attendedCount: Math.max(0, (sessData.attendedCount || filteredAttendees.length + 1) - 1)
        }).catch(() => {});
      }

      setStatusMessage({
        type: "success",
        text: `🗑️ Attendance excuse removed for ${studentName}. The student is now marked Absent.`
      });

      if (onExcuseSuccess) {
        onExcuseSuccess({
          rollNo: cleanRoll,
          sessionId: selectedSessionId,
          status: "REMOVED"
        });
      }

      setTimeout(() => {
        onClose();
      }, 2000);
    } catch (err) {
      console.error("Error removing excuse:", err);
      setStatusMessage({ type: "error", text: "Failed to remove excuse: " + err.message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="excuse-modal-overlay" role="dialog" aria-modal="true">
      <div className="excuse-modal-card">
        {/* Header */}
        <div className="excuse-modal-header">
          <div className="excuse-modal-header-info">
            <div className="excuse-modal-badge">
              <FaUserCheck /> Faculty Attendance Override
            </div>
            <h2 className="excuse-modal-title">Excuse Student Attendance</h2>
            <p className="excuse-modal-subtitle">
              Mark a student as Excused for a specific course and date. Updates the attendance matrix, student statistics, and session logs in real-time.
            </p>
          </div>
          <button
            type="button"
            className="excuse-close-btn"
            onClick={onClose}
            title="Close dialog"
            aria-label="Close"
          >
            <FaTimes />
          </button>
        </div>

        {/* Feedback Alert */}
        {statusMessage && (
          <div className={`excuse-alert-banner ${statusMessage.type}`}>
            {statusMessage.type === "success" ? <FaCheckCircle /> : <FaExclamationTriangle />}
            <span>{statusMessage.text}</span>
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmitExcuse} className="excuse-form">
          {/* Step 1: Course Selector */}
          <div className="excuse-form-group">
            <label className="excuse-label">
              <FaBookOpen style={{ color: "#6366f1" }} /> Select Course:
            </label>
            <select
              className="excuse-select"
              value={selectedCourse}
              onChange={(e) => {
                setSelectedCourse(e.target.value);
                setSelectedSessionId("");
              }}
              required
            >
              {allCourses.map((c) => {
                const code = c.code || c.courseCode || c.id;
                const name = c.name || c.courseName || code;
                return (
                  <option key={code} value={code}>
                    {code} — {name}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Step 2: Student Selection */}
          <div className="excuse-form-group">
            <label className="excuse-label">
              <FaSearch style={{ color: "#059669" }} /> Select Student:
            </label>
            <div className="excuse-search-wrap">
              <input
                type="text"
                className="excuse-input"
                placeholder="Search by student name or roll number (e.g. 21CS01)..."
                value={studentSearch}
                onChange={(e) => {
                  setStudentSearch(e.target.value);
                  if (selectedStudent && (selectedStudent.name !== e.target.value && selectedStudent.rollNo !== e.target.value)) {
                    setSelectedStudent(null);
                  }
                }}
              />
            </div>

            {/* Live Student Dropdown Results (if not yet chosen) */}
            {!selectedStudent && (
              <div className="excuse-students-dropdown">
                {filteredStudents.length === 0 ? (
                  <div className="excuse-student-empty">No matching students found</div>
                ) : (
                  filteredStudents.map((stud) => {
                    const roll = stud.rollNo || stud.id;
                    const name = stud.name || stud.fullName || roll;
                    return (
                      <div
                        key={roll}
                        className="excuse-student-option"
                        onClick={() => {
                          setSelectedStudent(stud);
                          setStudentSearch(`${roll} - ${name}`);
                        }}
                      >
                        <div className="excuse-student-opt-name">
                          <strong>{roll}</strong> — {name}
                        </div>
                        <div className="excuse-student-opt-meta">
                          {stud.branch || stud.department || "CSE"} • Sem {stud.semester || "1"}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* Selected Student Card */}
            {selectedStudent && (
              <div className="excuse-selected-student-card">
                <div className="excuse-selected-avatar">
                  {selectedStudent.photoURL ? (
                    <img src={selectedStudent.photoURL} alt={selectedStudent.name} />
                  ) : (
                    <span>{(selectedStudent.name || selectedStudent.rollNo || "S").charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <div className="excuse-selected-details">
                  <div className="excuse-selected-name">
                    {selectedStudent.name || selectedStudent.fullName}
                  </div>
                  <div className="excuse-selected-sub">
                    Roll: <strong>{selectedStudent.rollNo}</strong> • {selectedStudent.branch || "CSE"} (Sem {selectedStudent.semester || "1"})
                  </div>
                </div>
                <button
                  type="button"
                  className="excuse-change-student-btn"
                  onClick={() => {
                    setSelectedStudent(null);
                    setStudentSearch("");
                  }}
                >
                  Change
                </button>
              </div>
            )}
          </div>

          {/* Step 3: Date & Session Selection */}
          <div className="excuse-form-group">
            <label className="excuse-label">
              <FaCalendarAlt style={{ color: "#3b82f6" }} /> Date &amp; Class Session:
            </label>

            <div className="excuse-mode-tabs">
              <button
                type="button"
                className={`excuse-mode-tab ${sessionMode === "existing" ? "active" : ""}`}
                onClick={() => setSessionMode("existing")}
              >
                📋 Select Existing Held Class ({courseSessions.length})
              </button>
              <button
                type="button"
                className={`excuse-mode-tab ${sessionMode === "date" ? "active" : ""}`}
                onClick={() => setSessionMode("date")}
              >
                📅 Pick Specific Calendar Date
              </button>
            </div>

            {sessionMode === "existing" ? (
              courseSessions.length === 0 ? (
                <div className="excuse-alert-notice">
                  <FaInfoCircle /> No held sessions found for {selectedCourse}. Switch to "Pick Specific Calendar Date" to record an excused class on any date.
                </div>
              ) : (
                <select
                  className="excuse-select"
                  value={selectedSessionId}
                  onChange={(e) => setSelectedSessionId(e.target.value)}
                  required
                >
                  {courseSessions.map((sess) => {
                    const dateStr = sess.createdAt
                      ? new Date(sess.createdAt).toLocaleDateString("en-US", {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          year: "numeric"
                        })
                      : "Held Session";
                    const count = sess.attendedCount || (Array.isArray(sess.attendees) ? sess.attendees.length : 0);
                    return (
                      <option key={sess.id} value={sess.id}>
                        {dateStr} — {sess.classCode || sess.courseCode} ({count} Present, Room: {sess.roomNo || "C001"})
                      </option>
                    );
                  })}
                </select>
              )
            ) : (
              <div className="excuse-date-picker-wrap">
                <input
                  type="date"
                  className="excuse-input"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  max={new Date().toISOString().slice(0, 10)}
                  required
                />
                <span className="excuse-date-hint">
                  {courseSessions.some((s) => s.createdAt && new Date(s.createdAt).toISOString().slice(0, 10) === customDate)
                    ? "✓ Matches an existing recorded lecture on this date."
                    : "ℹ A formal excused session will be created for this date."}
                </span>
              </div>
            )}
          </div>

          {/* Current Status Pill if student & session selected */}
          {currentAttendanceStatus && (
            <div className={`excuse-current-status-card ${currentAttendanceStatus.status.toLowerCase()}`}>
              <div className="excuse-status-indicator">
                {currentAttendanceStatus.isExcused ? (
                  <FaRegCheckCircle style={{ color: "#d97706" }} />
                ) : currentAttendanceStatus.isPresent ? (
                  <FaCheckCircle style={{ color: "#059669" }} />
                ) : (
                  <FaExclamationTriangle style={{ color: "#64748b" }} />
                )}
                <span>
                  Current Status: <strong>{currentAttendanceStatus.status}</strong>
                  {currentAttendanceStatus.isExcused && currentAttendanceStatus.reason && (
                    <> ({currentAttendanceStatus.reason})</>
                  )}
                </span>
              </div>
              {currentAttendanceStatus.isExcused && (
                <button
                  type="button"
                  className="excuse-revert-btn"
                  onClick={handleRemoveExcuse}
                  disabled={submitting}
                  title="Remove this excuse and mark student absent"
                >
                  <FaUndoAlt /> Mark Absent
                </button>
              )}
            </div>
          )}

          {/* Step 4: Reason Selection */}
          <div className="excuse-form-group">
            <label className="excuse-label">Excuse Reason / Category:</label>
            <div className="excuse-preset-chips">
              {PRESET_REASONS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`excuse-preset-chip ${selectedPreset === r.id ? "active" : ""}`}
                  onClick={() => {
                    setSelectedPreset(r.id);
                    setCustomReason("");
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <input
              type="text"
              className="excuse-input"
              style={{ marginTop: "10px" }}
              placeholder="Or enter custom reason (e.g. Hospitalization, Hackathon, NSS Camp)..."
              value={customReason}
              onChange={(e) => setCustomReason(e.target.value)}
            />
          </div>

          {/* Step 5: Remarks / Note */}
          <div className="excuse-form-group">
            <label className="excuse-label">Official Remarks / Certificate No (Optional):</label>
            <textarea
              className="excuse-textarea"
              rows={2}
              placeholder="e.g. Medical certificate #MC-8821 verified by department HOD..."
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>

          {/* Modal Actions */}
          <div className="excuse-modal-actions">
            <button
              type="button"
              className="excuse-btn-cancel"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="excuse-btn-submit"
              disabled={submitting || !selectedStudent || !selectedCourse}
            >
              {submitting ? (
                <>
                  <FaSpinner className="fa-spin" />
                  <span>Recording Attendance...</span>
                </>
              ) : (
                <>
                  <FaUserCheck />
                  <span>Confirm &amp; Excuse Student</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
