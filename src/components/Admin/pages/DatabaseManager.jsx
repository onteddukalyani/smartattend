import React, { useState, useEffect } from "react";
import {
  FaDatabase,
  FaSyncAlt,
  FaSearch,
  FaTrashAlt,
  FaSave,
  FaPlusCircle,
  FaDownload,
  FaTools,
  FaCheckCircle,
  FaExclamationTriangle,
  FaUserGraduate,
  FaChalkboardTeacher,
  FaUserShield,
  FaBookOpen,
  FaClipboardList,
  FaKey,
  FaUnlockAlt,
  FaFileExport
} from "react-icons/fa";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  query,
  limit
} from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { deleteStudentRecordCompletely, resetStudentDeviceLockGlobally, broadcastStudentUpdate } from "../../../utils/studentDataHelper";
import "./DatabaseManager.css";

const COLLECTIONS = [
  { id: "students", label: "Students", icon: FaUserGraduate },
  { id: "lecturers", label: "Lecturers", icon: FaChalkboardTeacher },
  { id: "admins", label: "Admins", icon: FaUserShield },
  { id: "courses", label: "Courses", icon: FaBookOpen },
  { id: "attendance_sessions", label: "Attendance Sessions", icon: FaClipboardList },
  { id: "attendance_records", label: "Attendance Records", icon: FaClipboardList },
  { id: "institution", label: "Institution", icon: FaDatabase },
  { id: "reregistration_requests", label: "Re-registration Requests", icon: FaKey },
  { id: "support_tickets", label: "Support Tickets", icon: FaTools }
];

const DatabaseManager = () => {
  const { user, profile } = useAuth();

  const [activeTab, setActiveTab] = useState("overview"); // "overview" | "inspector" | "repair"
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState({ type: "", text: "" });

  // 1. Stats State
  const [counts, setCounts] = useState({
    students: 0,
    studentsWithFace: 0,
    studentsLocked: 0,
    lecturers: 0,
    admins: 0,
    courses: 0,
    attendance_sessions: 0,
    attendance_records: 0,
    reregistration_requests: 0,
    support_tickets: 0
  });

  // 2. Inspector / Fixer State
  const [selectedCollection, setSelectedCollection] = useState("students");
  const [searchDocId, setSearchDocId] = useState("");
  const [inspectingDoc, setInspectingDoc] = useState(null);
  const [isNewDoc, setIsNewDoc] = useState(false);
  const [editFields, setEditFields] = useState({});

  // 3. Repair Utilities State
  const [repairRollNo, setRepairRollNo] = useState("");
  const [newLecturerEmail, setNewLecturerEmail] = useState("");
  const [newLecturerName, setNewLecturerName] = useState("");
  const [newLecturerDept, setNewLecturerDept] = useState("Computer Science");

  useEffect(() => {
    fetchDatabaseStats();
  }, []);

  const showFeedback = (type, text) => {
    setFeedback({ type, text });
    setTimeout(() => {
      setFeedback({ type: "", text: "" });
    }, 6000);
  };

  // =========================================================
  // 1. FETCH DATABASE STATS
  // =========================================================
  const fetchDatabaseStats = async () => {
    setLoading(true);
    try {
      const [
        studentsSnap,
        lecturersSnap,
        adminsSnap,
        coursesSnap,
        sessionsSnap,
        recordsSnap,
        reregSnap,
        ticketsSnap
      ] = await Promise.all([
        getDocs(collection(db, "students")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "lecturers")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "admins")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "courses")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "attendance_sessions")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "attendance_records")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "reregistration_requests")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "support_tickets")).catch(() => ({ docs: [] }))
      ]);

      let faceCount = 0;
      let lockedCount = 0;
      studentsSnap.docs.forEach((d) => {
        const data = d.data();
        if (data.faceRegistered || data.biometricEnrolled || data.hasFaceRegistered) {
          faceCount++;
        }
        if (data.deviceTypeLocked || data.isDeviceRegistered) {
          lockedCount++;
        }
      });

      setCounts({
        students: studentsSnap.docs.length,
        studentsWithFace: faceCount,
        studentsLocked: lockedCount,
        lecturers: lecturersSnap.docs.length,
        admins: adminsSnap.docs.length,
        courses: coursesSnap.docs.length,
        attendance_sessions: sessionsSnap.docs.length,
        attendance_records: recordsSnap.docs.length,
        reregistration_requests: reregSnap.docs.length,
        support_tickets: ticketsSnap.docs.length
      });

      showFeedback("success", "Database stats synchronized successfully.");
    } catch (err) {
      console.error("Error loading database stats:", err);
      showFeedback("error", "Unable to load database stats: " + (err.message || "Network error"));
    } finally {
      setLoading(false);
    }
  };

  // =========================================================
  // 2. EXPORT COLLECTION TO JSON
  // =========================================================
  const exportCollectionToJson = async (collName) => {
    try {
      setLoading(true);
      const snap = await getDocs(collection(db, collName));
      const data = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));

      const jsonStr = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `smartattend_${collName}_backup_${Date.now()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      showFeedback("success", `Exported ${data.length} records from '${collName}' successfully.`);
    } catch (err) {
      console.error("Export error:", err);
      showFeedback("error", "Export failed: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  // =========================================================
  // 3. INSPECT DOCUMENT
  // =========================================================
  const handleInspectDocument = async (customId = null) => {
    const targetId = (customId || searchDocId || "").trim();
    if (!targetId) {
      showFeedback("error", "Please enter a Document ID (e.g. Roll No or Email).");
      return;
    }

    setLoading(true);
    setInspectingDoc(null);
    setIsNewDoc(false);

    try {
      const snap = await getDoc(doc(db, selectedCollection, targetId));
      if (snap.exists()) {
        const data = snap.data();
        setInspectingDoc({ id: snap.id, ...data });
        setEditFields({ ...data });
        showFeedback("success", `Loaded document '${targetId}' from '${selectedCollection}'.`);
      } else {
        setIsNewDoc(true);
        setEditFields({
          name: "",
          email: targetId.includes("@") ? targetId : "",
          rollNo: !targetId.includes("@") ? targetId.toUpperCase() : "",
          status: "active",
          approved: true,
          role: selectedCollection === "students" ? "student" : (selectedCollection === "lecturers" ? "lecturer" : "admin"),
          createdAt: Date.now()
        });
        showFeedback("info", `Document '${targetId}' not found. You can initialize it below.`);
      }
    } catch (err) {
      console.error("Inspector error:", err);
      showFeedback("error", "Error loading document: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  // Save changes to current document
  const handleSaveDocument = async () => {
    const targetId = (searchDocId || inspectingDoc?.id || "").trim();
    if (!targetId) return;

    setLoading(true);
    try {
      const payload = {
        ...editFields,
        updatedAt: Date.now()
      };
      await setDoc(doc(db, selectedCollection, targetId), payload, { merge: true });

      setInspectingDoc({ id: targetId, ...payload });
      setIsNewDoc(false);
      showFeedback("success", `Document '${targetId}' in '${selectedCollection}' saved successfully!`);
      fetchDatabaseStats();
    } catch (err) {
      console.error("Error saving document:", err);
      showFeedback("error", "Failed to save document: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  // Delete document completely from database
  const handleDeleteDocument = async () => {
    const targetId = (searchDocId || inspectingDoc?.id || "").trim();
    if (!targetId) return;

    const confirmed = window.confirm(
      `Are you ABSOLUTELY sure you want to permanently delete document '${targetId}' from '${selectedCollection}'?\n\nThis action cannot be undone. If this user is currently logged in, they will be automatically logged out immediately!`
    );
    if (!confirmed) return;

    setLoading(true);
    try {
      if (selectedCollection === "students") {
        await deleteStudentRecordCompletely({ id: targetId, rollNo: targetId, email: inspectingDoc?.email });
      } else {
        await deleteDoc(doc(db, selectedCollection, targetId));
      }

      setInspectingDoc(null);
      setEditFields({});
      showFeedback("success", `Document '${targetId}' was completely deleted from '${selectedCollection}'.`);
      fetchDatabaseStats();
    } catch (err) {
      console.error("Error deleting document:", err);
      showFeedback("error", "Failed to delete document: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  // =========================================================
  // 4. REPAIR UTILITIES
  // =========================================================
  const repairInstitutionSettings = async () => {
    setLoading(true);
    try {
      await Promise.all([
        setDoc(doc(db, "institution", "settings"), {
          name: "Indian Institute of Information Technology, Dharwad",
          shortName: "IIIT Dharwad",
          domain: "iiitdwd.ac.in",
          sessionDuration: 10,
          qrRefreshInterval: 10,
          attendanceWindow: 5,
          allowLateAttendance: true,
          defaultGeofenceRadius: 10,
          updatedAt: Date.now()
        }, { merge: true }),
        setDoc(doc(db, "app_updates", "latest"), {
          version: "1.0.4",
          versionCode: 6,
          releaseDate: "2026-10-23",
          minRequiredVersion: "1.0.1",
          title: "SmartAttend Release (v1.0.4)",
          isMandatory: false,
          updatedAt: Date.now()
        }, { merge: true })
      ]);
      showFeedback("success", "Institution settings & app release parameters successfully initialized!");
      fetchDatabaseStats();
    } catch (err) {
      showFeedback("error", "Failed to repair institution settings: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const emergencyResetStudent = async () => {
    const roll = (repairRollNo || "").trim().toUpperCase();
    if (!roll) {
      showFeedback("error", "Please provide a valid Student Roll Number.");
      return;
    }

    setLoading(true);
    try {
      await resetStudentDeviceLockGlobally(roll);
      await setDoc(doc(db, "students", roll), {
        faceRegistered: false,
        biometricEnrolled: false,
        hasFaceRegistered: false,
        faceRemovedAt: Date.now(),
        deviceTypeLocked: false,
        isDeviceRegistered: false,
        hardwareBiometricEnrolled: false,
        deviceResetAt: Date.now(),
        updatedAt: Date.now()
      }, { merge: true });

      broadcastStudentUpdate({ rollNo: roll, faceRegistered: false, deviceTypeLocked: false });

      showFeedback("success", `Student ${roll}: Face biometrics reset and hardware device lock unlocked successfully!`);
      setRepairRollNo("");
      fetchDatabaseStats();
    } catch (err) {
      showFeedback("error", "Failed to reset student: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const emergencyCreateLecturer = async () => {
    const email = (newLecturerEmail || "").trim().toLowerCase();
    const name = (newLecturerName || "").trim();
    if (!email || !email.includes("@")) {
      showFeedback("error", "Please provide a valid lecturer email address.");
      return;
    }

    setLoading(true);
    try {
      const prefix = email.split("@")[0];
      const lecturerData = {
        name: name || prefix,
        fullName: name || prefix,
        email: email,
        department: newLecturerDept,
        designation: "Faculty / Lecturer",
        role: "lecturer",
        status: "active",
        approved: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await Promise.all([
        setDoc(doc(db, "lecturers", email), lecturerData, { merge: true }),
        setDoc(doc(db, "lecturers", prefix), lecturerData, { merge: true })
      ]);

      showFeedback("success", `Lecturer '${email}' registered and authorized successfully!`);
      setNewLecturerEmail("");
      setNewLecturerName("");
      fetchDatabaseStats();
    } catch (err) {
      showFeedback("error", "Failed to create lecturer: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="database-manager-page">
      {/* Header */}
      <div className="db-header">
        <div className="db-header-text">
          <h1>
            <FaDatabase style={{ color: "var(--accent, #6366f1)" }} />
            Database &amp; System Control Hub
          </h1>
          <p>
            Complete administrator control over Firebase Firestore: Inspect, repair, edit, or delete any record directly without opening the Firebase Console.
          </p>
        </div>
        <div className="db-header-actions">
          <button
            type="button"
            className="db-btn db-btn-primary"
            onClick={fetchDatabaseStats}
            disabled={loading}
          >
            <FaSyncAlt className={loading ? "spin-icon" : ""} />
            Sync Health
          </button>
        </div>
      </div>

      {/* Feedback banner */}
      {feedback.text && (
        <div className={`db-alert db-alert-${feedback.type}`}>
          {feedback.type === "success" && <FaCheckCircle />}
          {feedback.type === "error" && <FaExclamationTriangle />}
          {feedback.type === "info" && <FaDatabase />}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="db-tabs">
        <button
          type="button"
          className={`db-tab-btn ${activeTab === "overview" ? "active" : ""}`}
          onClick={() => setActiveTab("overview")}
        >
          <FaDatabase /> Collections Overview &amp; Exports
        </button>
        <button
          type="button"
          className={`db-tab-btn ${activeTab === "inspector" ? "active" : ""}`}
          onClick={() => setActiveTab("inspector")}
        >
          <FaSearch /> Document Inspector &amp; Record Editor
        </button>
        <button
          type="button"
          className={`db-tab-btn ${activeTab === "repair" ? "active" : ""}`}
          onClick={() => setActiveTab("repair")}
        >
          <FaTools /> System Repair &amp; Emergency Utilities
        </button>
      </div>

      {/* =====================================================
          TAB 1: OVERVIEW & LIVE COUNTS
          ===================================================== */}
      {activeTab === "overview" && (
        <div>
          <div className="db-stats-grid">
            <div className="db-stat-card">
              <div className="db-stat-top">
                <span className="db-stat-title">Students</span>
                <FaUserGraduate className="db-stat-icon" />
              </div>
              <div className="db-stat-value">{counts.students}</div>
              <div className="db-stat-meta">{counts.studentsWithFace} face enrolled • {counts.studentsLocked} device locked</div>
            </div>

            <div className="db-stat-card">
              <div className="db-stat-top">
                <span className="db-stat-title">Lecturers</span>
                <FaChalkboardTeacher className="db-stat-icon" />
              </div>
              <div className="db-stat-value">{counts.lecturers}</div>
              <div className="db-stat-meta">Active Faculty Records</div>
            </div>

            <div className="db-stat-card">
              <div className="db-stat-top">
                <span className="db-stat-title">Admins</span>
                <FaUserShield className="db-stat-icon" />
              </div>
              <div className="db-stat-value">{counts.admins}</div>
              <div className="db-stat-meta">System Administrators</div>
            </div>

            <div className="db-stat-card">
              <div className="db-stat-top">
                <span className="db-stat-title">Courses</span>
                <FaBookOpen className="db-stat-icon" />
              </div>
              <div className="db-stat-value">{counts.courses}</div>
              <div className="db-stat-meta">Active Curriculum Modules</div>
            </div>

            <div className="db-stat-card">
              <div className="db-stat-top">
                <span className="db-stat-title">Sessions</span>
                <FaClipboardList className="db-stat-icon" />
              </div>
              <div className="db-stat-value">{counts.attendance_sessions}</div>
              <div className="db-stat-meta">Total Created QR Sessions</div>
            </div>

            <div className="db-stat-card">
              <div className="db-stat-top">
                <span className="db-stat-title">Attendance Logs</span>
                <FaClipboardList className="db-stat-icon" />
              </div>
              <div className="db-stat-value">{counts.attendance_records}</div>
              <div className="db-stat-meta">Verified Attendance Records</div>
            </div>
          </div>

          {/* Quick Export Table */}
          <div className="db-card">
            <div className="db-card-header">
              <h2><FaFileExport /> One-Click Collection Backup &amp; JSON Export</h2>
            </div>
            <p style={{ color: "var(--text-muted, #64748b)", fontSize: "14px", margin: "0 0 16px" }}>
              Download complete, uncorrupted JSON snapshots of any collection straight to your device:
            </p>

            <div className="db-table-wrapper">
              <table className="db-table">
                <thead>
                  <tr>
                    <th>Collection Name</th>
                    <th>Document Count</th>
                    <th>Canonical Path</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {COLLECTIONS.map((c) => (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 700 }}>
                        <c.icon style={{ marginRight: "8px", verticalAlign: "middle" }} />
                        {c.label}
                      </td>
                      <td>
                        <span className="db-badge db-badge-blue">
                          {counts[c.id] ?? "—"} docs
                        </span>
                      </td>
                      <td style={{ fontFamily: "monospace", color: "#64748b" }}>/{c.id}</td>
                      <td>
                        <button
                          type="button"
                          className="db-btn db-btn-secondary"
                          style={{ padding: "6px 12px", fontSize: "12px" }}
                          onClick={() => exportCollectionToJson(c.id)}
                          disabled={loading}
                        >
                          <FaDownload /> Export JSON
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================
          TAB 2: DOCUMENT INSPECTOR & RECORD EDITOR
          ===================================================== */}
      {activeTab === "inspector" && (
        <div className="db-card">
          <div className="db-card-header">
            <h2><FaSearch /> Direct Document Inspector &amp; Record Fixer</h2>
          </div>
          <p style={{ color: "var(--text-muted, #64748b)", fontSize: "14px", margin: "0 0 20px" }}>
            Search for any record across Firestore. You can inspect its exact database values, modify fields, or permanently delete it with 1 click.
          </p>

          <div className="db-form-row">
            <div className="db-form-group">
              <label>Target Collection</label>
              <select
                className="db-select"
                value={selectedCollection}
                onChange={(e) => {
                  setSelectedCollection(e.target.value);
                  setInspectingDoc(null);
                  setIsNewDoc(false);
                }}
              >
                {COLLECTIONS.map((c) => (
                  <option key={c.id} value={c.id}>{c.label} (/{c.id})</option>
                ))}
              </select>
            </div>

            <div className="db-form-group" style={{ flex: 2 }}>
              <label>Document ID / Key (e.g. 21BCS001, lecturer email, course ID)</label>
              <input
                type="text"
                className="db-input"
                placeholder={selectedCollection === "students" ? "e.g. 21BCS001" : (selectedCollection === "lecturers" ? "e.g. prof.name@iiitdwd.ac.in" : "Document ID")}
                value={searchDocId}
                onChange={(e) => setSearchDocId(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleInspectDocument(); }}
              />
            </div>

            <div className="db-form-group" style={{ justifyContent: "flex-end" }}>
              <button
                type="button"
                className="db-btn db-btn-primary"
                onClick={() => handleInspectDocument()}
                disabled={loading || !searchDocId.trim()}
              >
                <FaSearch /> Search / Fetch Record
              </button>
            </div>
          </div>

          {/* Inspected Record Details */}
          {(inspectingDoc || isNewDoc) && (
            <div className="db-result-box">
              <div className="db-result-header">
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", color: "var(--text-main, #0f172a)" }}>
                    Document ID: <code>{searchDocId}</code>
                  </h3>
                  <span style={{ fontSize: "12px", color: "var(--text-muted, #64748b)" }}>
                    Path: /{selectedCollection}/{searchDocId}
                  </span>
                </div>
                <div>
                  {isNewDoc ? (
                    <span className="db-badge db-badge-red">Not In Database (New)</span>
                  ) : (
                    <span className="db-badge db-badge-green">Exists in Database</span>
                  )}
                </div>
              </div>

              {/* Editable Fields Grid */}
              <div className="db-form-row">
                <div className="db-form-group">
                  <label>Name / Display Name</label>
                  <input
                    type="text"
                    className="db-input"
                    value={editFields.name || editFields.fullName || ""}
                    onChange={(e) => setEditFields({ ...editFields, name: e.target.value, fullName: e.target.value })}
                  />
                </div>

                <div className="db-form-group">
                  <label>Email</label>
                  <input
                    type="email"
                    className="db-input"
                    value={editFields.email || ""}
                    onChange={(e) => setEditFields({ ...editFields, email: e.target.value })}
                  />
                </div>

                <div className="db-form-group">
                  <label>Account Status</label>
                  <select
                    className="db-select"
                    value={editFields.status || "active"}
                    onChange={(e) => setEditFields({ ...editFields, status: e.target.value })}
                  >
                    <option value="active">Active (Can Log In)</option>
                    <option value="disabled">Disabled (Cannot Log In)</option>
                    <option value="removed">Removed (Auto Log Out)</option>
                  </select>
                </div>
              </div>

              {selectedCollection === "students" && (
                <div className="db-form-row">
                  <div className="db-form-group">
                    <label>Roll Number</label>
                    <input
                      type="text"
                      className="db-input"
                      value={editFields.rollNo || ""}
                      onChange={(e) => setEditFields({ ...editFields, rollNo: e.target.value.toUpperCase() })}
                    />
                  </div>

                  <div className="db-form-group">
                    <label>Branch / Department</label>
                    <input
                      type="text"
                      className="db-input"
                      value={editFields.branch || editFields.department || "CSE"}
                      onChange={(e) => setEditFields({ ...editFields, branch: e.target.value, department: e.target.value })}
                    />
                  </div>

                  <div className="db-form-group">
                    <label>Semester</label>
                    <input
                      type="text"
                      className="db-input"
                      value={editFields.semester || "1"}
                      onChange={(e) => setEditFields({ ...editFields, semester: e.target.value })}
                    />
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: "20px", gap: "12px", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: "10px" }}>
                  <button
                    type="button"
                    className="db-btn db-btn-success"
                    onClick={handleSaveDocument}
                    disabled={loading}
                  >
                    <FaSave /> {isNewDoc ? "Create Document in Firestore" : "Save Changes to Database"}
                  </button>
                </div>

                {!isNewDoc && (
                  <button
                    type="button"
                    className="db-btn db-btn-danger"
                    onClick={handleDeleteDocument}
                    disabled={loading}
                  >
                    <FaTrashAlt /> Delete Record Completely
                  </button>
                )}
              </div>

              {/* Raw JSON View */}
              <div style={{ marginTop: "20px" }}>
                <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-muted, #64748b)" }}>
                  Raw Document Data in Firestore:
                </span>
                <pre className="db-json-preview">
                  {JSON.stringify(inspectingDoc || editFields, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =====================================================
          TAB 3: REPAIR & EMERGENCY UTILITIES
          ===================================================== */}
      {activeTab === "repair" && (
        <div>
          {/* 1. Emergency Student Unlocker */}
          <div className="db-card">
            <div className="db-card-header">
              <h2><FaUnlockAlt /> Emergency Biometric Reset &amp; Hardware Unlock</h2>
            </div>
            <p style={{ color: "var(--text-muted, #64748b)", fontSize: "14px", margin: "0 0 16px" }}>
              If a student changed devices, damaged their webcam, or has biometric errors: enter their Roll Number to instantly wipe old face descriptors and unlock device lock.
            </p>

            <div className="db-form-row">
              <div className="db-form-group" style={{ flex: 2 }}>
                <label>Student Roll Number</label>
                <input
                  type="text"
                  className="db-input"
                  placeholder="e.g. 21BCS001"
                  value={repairRollNo}
                  onChange={(e) => setRepairRollNo(e.target.value.toUpperCase())}
                />
              </div>
              <div className="db-form-group" style={{ justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="db-btn db-btn-primary"
                  onClick={emergencyResetStudent}
                  disabled={loading || !repairRollNo.trim()}
                >
                  <FaUnlockAlt /> Reset Face &amp; Unlock Device
                </button>
              </div>
            </div>
          </div>

          {/* 2. Emergency Lecturer Creator */}
          <div className="db-card">
            <div className="db-card-header">
              <h2><FaChalkboardTeacher /> Emergency Lecturer Authorization</h2>
            </div>
            <p style={{ color: "var(--text-muted, #64748b)", fontSize: "14px", margin: "0 0 16px" }}>
              Quickly authorize or fix a faculty member if they cannot log in:
            </p>

            <div className="db-form-row">
              <div className="db-form-group">
                <label>Lecturer Email</label>
                <input
                  type="email"
                  className="db-input"
                  placeholder="e.g. prof.sharma@iiitdwd.ac.in"
                  value={newLecturerEmail}
                  onChange={(e) => setNewLecturerEmail(e.target.value)}
                />
              </div>
              <div className="db-form-group">
                <label>Full Name</label>
                <input
                  type="text"
                  className="db-input"
                  placeholder="e.g. Dr. Rajesh Sharma"
                  value={newLecturerName}
                  onChange={(e) => setNewLecturerName(e.target.value)}
                />
              </div>
              <div className="db-form-group">
                <label>Department</label>
                <input
                  type="text"
                  className="db-input"
                  value={newLecturerDept}
                  onChange={(e) => setNewLecturerDept(e.target.value)}
                />
              </div>
            </div>
            <button
              type="button"
              className="db-btn db-btn-success"
              onClick={emergencyCreateLecturer}
              disabled={loading || !newLecturerEmail.trim()}
            >
              <FaPlusCircle /> Authorize &amp; Save Lecturer
            </button>
          </div>

          {/* 3. System Repair */}
          <div className="db-card">
            <div className="db-card-header">
              <h2><FaTools /> System Documents Repair &amp; Auto-Bootstrap</h2>
            </div>
            <p style={{ color: "var(--text-muted, #64748b)", fontSize: "14px", margin: "0 0 16px" }}>
              If you cleared the database or re-installed the project: click below to ensure standard institution settings (geofence 10m, rotation 10s, window 5 min) and app update definitions are created.
            </p>
            <button
              type="button"
              className="db-btn db-btn-primary"
              onClick={repairInstitutionSettings}
              disabled={loading}
            >
              <FaTools /> Repair &amp; Bootstrap Essential System Documents
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DatabaseManager;
