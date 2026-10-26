import React, { useState, useEffect, useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  FaDatabase,
  FaSyncAlt,
  FaSearch,
  FaTrashAlt,
  FaSave,
  FaPlus,
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
  FaEdit,
  FaTimes,
  FaCamera,
  FaMobileAlt,
  FaCheck,
  FaBan,
  FaEye,
  FaCopy,
  FaClock,
  FaLayerGroup,
  FaArrowRight,
  FaUniversity,
  FaInfoCircle
} from "react-icons/fa";
import {
  collection,
  getDocs,
  doc,
  setDoc,
  deleteDoc
} from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import {
  deleteStudentRecordCompletely,
  resetStudentDeviceLockGlobally,
  broadcastStudentUpdate
} from "../../../utils/studentDataHelper";
import "./DatabaseManager.css";

// Available Collections in SmartAttend
const COLLECTIONS = [
  { id: "students", label: "Students", icon: FaUserGraduate },
  { id: "lecturers", label: "Lecturers", icon: FaChalkboardTeacher },
  { id: "admins", label: "Admins", icon: FaUserShield },
  { id: "courses", label: "Courses", icon: FaBookOpen },
  { id: "attendance_sessions", label: "Sessions", icon: FaClipboardList },
  { id: "attendance_records", label: "Attendance Logs", icon: FaClipboardList },
  { id: "reregistration_requests", label: "Biometric Requests", icon: FaKey },
  { id: "support_tickets", label: "Support Tickets", icon: FaTools },
  { id: "institution", label: "Settings", icon: FaUniversity },
  { id: "app_updates", label: "App Releases", icon: FaDatabase }
];

// Visual Architecture & Schema Blueprint (Replaces raw JSON)
const SCHEMA_BLUEPRINTS = [
  {
    id: "students",
    title: "Students Master Records",
    docIdRule: "/students/{UPPERCASE_ROLL} (e.g. students/22BCS001)",
    description: "Core student identities. Roll numbers are canonical keys. Handles login permissions, face biometrics, and single-device hardware bindings.",
    primaryKey: "rollNo",
    icon: FaUserGraduate,
    fields: [
      { name: "rollNo", type: "string", required: true, desc: "Unique student roll number (Canonical uppercase, e.g. 22BCS001)" },
      { name: "name", type: "string", required: true, desc: "Student full legal name" },
      { name: "email", type: "string", required: true, desc: "University email address (e.g. 22bcs001@iiitdwd.ac.in)" },
      { name: "branch", type: "string", required: true, desc: "Engineering department (e.g. CSE, ECE, DSAI)" },
      { name: "semester", type: "string", required: true, desc: "Current academic semester (e.g. 1 to 8)" },
      { name: "role", type: "string", required: true, desc: "Must be 'student'" },
      { name: "status", type: "string", required: true, desc: "'active' (can log in), 'disabled', or 'removed' (auto-logged out immediately)" },
      { name: "approved", type: "boolean", required: true, desc: "Authorization flag (true permits mobile/web login)" },
      { name: "faceRegistered", type: "boolean", required: false, desc: "True if biometric face embeddings have been scanned and enrolled" },
      { name: "faceDescriptor", type: "array", required: false, desc: "128-dimensional facial embedding vector array" },
      { name: "deviceTypeLocked", type: "boolean", required: false, desc: "True once bound to student's verified primary device" },
      { name: "deviceId", type: "string", required: false, desc: "Hardware installation fingerprint" },
      { name: "createdAt", type: "timestamp", required: false, desc: "Record registration timestamp (ms)" }
    ]
  },
  {
    id: "lecturers",
    title: "Faculty & Instructors",
    docIdRule: "/lecturers/{email} and /lecturers/{prefix}",
    description: "Authorized faculty instructors permitted to launch classroom attendance sessions, generate rolling dual QR codes, and review attendance stats.",
    primaryKey: "email",
    icon: FaChalkboardTeacher,
    fields: [
      { name: "email", type: "string", required: true, desc: "Lecturer email address (e.g. sharma@iiitdwd.ac.in)" },
      { name: "name", type: "string", required: true, desc: "Faculty full name (e.g. Dr. Rajesh Sharma)" },
      { name: "department", type: "string", required: true, desc: "Academic department (e.g. Computer Science)" },
      { name: "designation", type: "string", required: false, desc: "Academic title (e.g. Assistant Professor, HOD)" },
      { name: "role", type: "string", required: true, desc: "Must be 'lecturer'" },
      { name: "status", type: "string", required: true, desc: "'active' (can login) or 'disabled'" },
      { name: "approved", type: "boolean", required: true, desc: "Authorization flag" }
    ]
  },
  {
    id: "admins",
    title: "System Administrators",
    docIdRule: "/admins/{email} and /admins/{prefix}",
    description: "System administrators with universal permissions to manage student and faculty rosters, audit attendance records, and configure institution parameters.",
    primaryKey: "email",
    icon: FaUserShield,
    fields: [
      { name: "email", type: "string", required: true, desc: "Administrator email (e.g. onteddukalyani@gmail.com)" },
      { name: "name", type: "string", required: true, desc: "Administrator name" },
      { name: "department", type: "string", required: false, desc: "Administration division" },
      { name: "role", type: "string", required: true, desc: "Must be 'admin'" },
      { name: "isAdmin", type: "boolean", required: true, desc: "Superuser permission flag" },
      { name: "status", type: "string", required: true, desc: "'active'" }
    ]
  },
  {
    id: "courses",
    title: "Courses & Subjects",
    docIdRule: "/courses/{COURSE_CODE} (e.g. courses/CS301)",
    description: "Academic curriculum subjects mapped to departments, semesters, assigned faculty instructors, and enrolled student rosters.",
    primaryKey: "courseCode",
    icon: FaBookOpen,
    fields: [
      { name: "courseCode", type: "string", required: true, desc: "Unique subject code (e.g. CS301, EC204)" },
      { name: "courseName", type: "string", required: true, desc: "Course title (e.g. Data Structures & Algorithms)" },
      { name: "branch", type: "string", required: true, desc: "Target branch (e.g. CSE)" },
      { name: "semester", type: "string", required: true, desc: "Target semester (e.g. 5)" },
      { name: "lecturerEmail", type: "string", required: false, desc: "Assigned faculty email" },
      { name: "lecturerName", type: "string", required: false, desc: "Assigned faculty name" },
      { name: "students", type: "array", required: false, desc: "Array of enrolled student roll numbers" }
    ]
  },
  {
    id: "attendance_sessions",
    title: "Attendance Class Sessions",
    docIdRule: "/attendance_sessions/{sessionId}",
    description: "Live or archived class attendance sessions generated by lecturers with dynamic dual QR codes and GPS geofence checks.",
    primaryKey: "sessionId",
    icon: FaClipboardList,
    fields: [
      { name: "sessionId", type: "string", required: true, desc: "Auto-generated unique session ID" },
      { name: "courseCode", type: "string", required: true, desc: "Subject code for the session" },
      { name: "courseName", type: "string", required: false, desc: "Subject name" },
      { name: "lecturerEmail", type: "string", required: true, desc: "Faculty email of the session owner" },
      { name: "active", type: "boolean", required: true, desc: "True while students are permitted to scan QR" },
      { name: "phase", type: "number", required: true, desc: "Dual QR rotation phase (1 or 2)" },
      { name: "geofenceRadius", type: "number", required: true, desc: "Allowed GPS radius in meters (default 10m)" },
      { name: "createdAt", type: "timestamp", required: true, desc: "Session creation timestamp" },
      { name: "expiresAt", type: "timestamp", required: true, desc: "Session expiration timestamp" }
    ]
  },
  {
    id: "attendance_records",
    title: "Verified Attendance Logs",
    docIdRule: "/attendance_records/{recordId}",
    description: "Immutable attendance check-in receipts created when a student successfully passes geofence check, QR scan, and facial verification.",
    primaryKey: "recordId",
    icon: FaClipboardList,
    fields: [
      { name: "sessionId", type: "string", required: true, desc: "Class session ID" },
      { name: "studentRoll", type: "string", required: true, desc: "Verified student roll number" },
      { name: "studentName", type: "string", required: true, desc: "Student full name" },
      { name: "status", type: "string", required: true, desc: "'present'" },
      { name: "biometricStatus", type: "string", required: true, desc: "Verification result (e.g. 'Verified')" },
      { name: "submittedAt", type: "timestamp", required: true, desc: "Verification timestamp" }
    ]
  },
  {
    id: "institution",
    title: "Institution Settings",
    docIdRule: "/institution/settings (Singleton Document)",
    description: "Global university parameters including GPS geofence default radius, QR rotation interval, and institutional email domain rules.",
    primaryKey: "settings",
    icon: FaUniversity,
    fields: [
      { name: "name", type: "string", required: true, desc: "University name (e.g. Indian Institute of Information Technology, Dharwad)" },
      { name: "shortName", type: "string", required: true, desc: "University short acronym (e.g. IIIT Dharwad)" },
      { name: "domain", type: "string", required: true, desc: "Authorized email domain (e.g. iiitdwd.ac.in)" },
      { name: "defaultGeofenceRadius", type: "number", required: true, desc: "Classroom GPS radius in meters (10m)" },
      { name: "qrRefreshInterval", type: "number", required: true, desc: "Dual QR rotation interval in seconds (10s)" },
      { name: "sessionDuration", type: "number", required: true, desc: "Standard class duration in minutes (10m)" }
    ]
  },
  {
    id: "app_updates",
    title: "App Release & Updates",
    docIdRule: "/app_updates/latest (Singleton Document)",
    description: "Mobile APK version control definition to deliver over-the-air update prompts to Android devices.",
    primaryKey: "latest",
    icon: FaDatabase,
    fields: [
      { name: "version", type: "string", required: true, desc: "Current release semantic version (e.g. 1.0.4)" },
      { name: "versionCode", type: "number", required: true, desc: "Android build version code (e.g. 6)" },
      { name: "releaseDate", type: "string", required: true, desc: "Release date string" },
      { name: "minRequiredVersion", type: "string", required: true, desc: "Minimum mandatory version" },
      { name: "apkUrl", type: "string", required: false, desc: "Direct download URL for APK" },
      { name: "isMandatory", type: "boolean", required: true, desc: "Forces student app to update before login" }
    ]
  }
];

const DatabaseManager = () => {
  const { user, profile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Tab State: "explorer" | "schema" | "repair"
  const initialTab = searchParams.get("tab") || "explorer";
  const initialColl = searchParams.get("collection") || "students";

  const [activeTab, setActiveTab] = useState(initialTab);
  const [selectedCollection, setSelectedCollection] = useState(initialColl);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState({ type: "", text: "" });

  // Data & Counts
  const [collectionDocs, setCollectionDocs] = useState([]);
  const [counts, setCounts] = useState({});
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Visual Modals State
  const [inspectingDoc, setInspectingDoc] = useState(null); // Visual Document Inspector
  const [showRawVector, setShowRawVector] = useState(false);
  const [modalMode, setModalMode] = useState(null); // "edit" | "add" | null
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [formFields, setFormFields] = useState({});
  const [savingRecord, setSavingRecord] = useState(false);

  // Repair State
  const [repairRollNo, setRepairRollNo] = useState("");
  const [newLecturerEmail, setNewLecturerEmail] = useState("");
  const [newLecturerName, setNewLecturerName] = useState("");
  const [newLecturerDept, setNewLecturerDept] = useState("Computer Science");

  const showFeedback = (type, text) => {
    setFeedback({ type, text });
    setTimeout(() => {
      setFeedback({ type: "", text: "" });
    }, 6000);
  };

  // Sync tab with URL
  const handleTabSwitch = (newTab) => {
    setActiveTab(newTab);
    setSearchParams({ tab: newTab, collection: selectedCollection });
  };

  const handleCollectionSwitch = (collId) => {
    setSelectedCollection(collId);
    setSearchParams({ tab: activeTab, collection: collId });
  };

  // =========================================================
  // 1. LOAD COLLECTION DATA & COUNTS
  // =========================================================
  const loadActiveCollection = async (collId = selectedCollection) => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, collId));
      const docs = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));

      docs.sort((a, b) => {
        if (collId === "students") {
          return String(a.rollNo || a._id).localeCompare(String(b.rollNo || b._id));
        }
        if (a.createdAt && b.createdAt) {
          return b.createdAt - a.createdAt;
        }
        return String(a.name || a.courseCode || a._id).localeCompare(String(b.name || b.courseCode || b._id));
      });

      setCollectionDocs(docs);
      setCounts((prev) => ({ ...prev, [collId]: docs.length }));
    } catch (err) {
      console.error("Error loading collection:", err);
      showFeedback("error", `Failed to load '${collId}': ` + (err.message || "Network error"));
    } finally {
      setLoading(false);
    }
  };

  const fetchAllCounts = async () => {
    try {
      const countPromises = COLLECTIONS.map(async (c) => {
        try {
          const s = await getDocs(collection(db, c.id));
          return { id: c.id, count: s.docs.length };
        } catch (_) {
          return { id: c.id, count: 0 };
        }
      });
      const results = await Promise.all(countPromises);
      const newCounts = {};
      results.forEach((r) => { newCounts[r.id] = r.count; });
      setCounts(newCounts);
    } catch (_) { }
  };

  useEffect(() => {
    fetchAllCounts();
  }, []);

  useEffect(() => {
    loadActiveCollection(selectedCollection);
    setSearchQuery("");
  }, [selectedCollection]);

  // =========================================================
  // 2. SEARCH & FILTERING
  // =========================================================
  const filteredDocs = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return collectionDocs.filter((d) => {
      if (statusFilter !== "all") {
        const itemStatus = String(d.status || (d.approved !== false ? "active" : "disabled")).toLowerCase();
        if (statusFilter === "active" && itemStatus !== "active") return false;
        if (statusFilter === "disabled" && itemStatus !== "disabled" && itemStatus !== "deactivated") return false;
        if (statusFilter === "removed" && itemStatus !== "removed" && itemStatus !== "deleted") return false;
      }

      if (!q) return true;

      const idMatch = String(d._id || "").toLowerCase().includes(q);
      const rollMatch = String(d.rollNo || "").toLowerCase().includes(q);
      const nameMatch = String(d.name || d.fullName || "").toLowerCase().includes(q);
      const emailMatch = String(d.email || "").toLowerCase().includes(q);
      const courseMatch = String(d.courseCode || d.courseName || "").toLowerCase().includes(q);
      const deptMatch = String(d.department || d.branch || "").toLowerCase().includes(q);

      return idMatch || rollMatch || nameMatch || emailMatch || courseMatch || deptMatch;
    });
  }, [collectionDocs, searchQuery, statusFilter]);

  // =========================================================
  // 3. EDIT / ADD MODAL HANDLERS
  // =========================================================
  const handleOpenEdit = (docItem) => {
    setInspectingDoc(null);
    setSelectedDoc(docItem);
    setFormFields({ ...docItem });
    setModalMode("edit");
  };

  const handleOpenAdd = (targetColl = selectedCollection) => {
    setInspectingDoc(null);
    setSelectedCollection(targetColl);
    setSelectedDoc(null);

    let defaults = {
      status: "active",
      approved: true,
      createdAt: Date.now()
    };

    if (targetColl === "students") {
      defaults = {
        ...defaults,
        rollNo: "",
        name: "",
        email: "",
        branch: "CSE",
        semester: "1",
        role: "student",
        faceRegistered: false,
        deviceTypeLocked: false
      };
    } else if (targetColl === "lecturers") {
      defaults = {
        ...defaults,
        name: "",
        email: "",
        department: "Computer Science",
        designation: "Faculty / Lecturer",
        role: "lecturer"
      };
    } else if (targetColl === "admins") {
      defaults = {
        ...defaults,
        name: "",
        email: "",
        department: "Administration",
        designation: "System Administrator",
        role: "admin",
        isAdmin: true
      };
    } else if (targetColl === "courses") {
      defaults = {
        ...defaults,
        courseName: "",
        courseCode: "",
        branch: "CSE",
        semester: "1",
        lecturerName: "",
        lecturerEmail: ""
      };
    }

    setFormFields(defaults);
    setModalMode("add");
  };

  const handleSaveRecord = async () => {
    let targetDocId = "";
    if (modalMode === "edit") {
      targetDocId = selectedDoc._id;
    } else {
      if (selectedCollection === "students") {
        targetDocId = (formFields.rollNo || "").trim().toUpperCase();
        if (!targetDocId) {
          showFeedback("error", "Roll Number is required for students.");
          return;
        }
      } else if (selectedCollection === "lecturers" || selectedCollection === "admins") {
        targetDocId = (formFields.email || "").trim().toLowerCase();
        if (!targetDocId || !targetDocId.includes("@")) {
          showFeedback("error", "A valid email is required.");
          return;
        }
      } else if (selectedCollection === "courses") {
        targetDocId = (formFields.courseCode || "").trim().toUpperCase();
        if (!targetDocId) {
          showFeedback("error", "Course Code is required.");
          return;
        }
      } else {
        targetDocId = (formFields.id || formFields._id || `doc_${Date.now()}`).trim();
      }
    }

    setSavingRecord(true);
    try {
      const cleanData = { ...formFields };
      delete cleanData._id;
      cleanData.updatedAt = Date.now();

      await setDoc(doc(db, selectedCollection, targetDocId), cleanData, { merge: true });

      if (selectedCollection === "students") {
        broadcastStudentUpdate({ rollNo: targetDocId, ...cleanData });
      }

      showFeedback("success", `Record '${targetDocId}' in '${selectedCollection}' saved successfully!`);
      setModalMode(null);
      loadActiveCollection(selectedCollection);
      fetchAllCounts();
    } catch (err) {
      console.error("Error saving record:", err);
      showFeedback("error", "Failed to save: " + err.message);
    } finally {
      setSavingRecord(false);
    }
  };

  const handleDeleteRecord = async (docItem) => {
    const targetId = docItem._id || docItem.id || docItem.rollNo || docItem.email;
    const displayName = docItem.name || docItem.fullName || docItem.courseName || targetId;

    const confirmed = window.confirm(
      `Are you sure you want to permanently delete '${displayName}' (${targetId}) from '${selectedCollection}'?\n\nIf this user is currently logged in, they will be automatically logged out immediately!`
    );
    if (!confirmed) return;

    setLoading(true);
    try {
      if (selectedCollection === "students") {
        await deleteStudentRecordCompletely({ id: targetId, rollNo: docItem.rollNo || targetId, email: docItem.email });
      } else {
        await deleteDoc(doc(db, selectedCollection, targetId));
      }

      showFeedback("success", `Successfully deleted '${displayName}' from '${selectedCollection}'.`);
      setInspectingDoc(null);
      setCollectionDocs((prev) => prev.filter((d) => d._id !== targetId));
      setCounts((prev) => ({ ...prev, [selectedCollection]: Math.max((prev[selectedCollection] || 1) - 1, 0) }));
    } catch (err) {
      console.error("Delete error:", err);
      showFeedback("error", "Failed to delete: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleQuickResetFace = async (student) => {
    const roll = student.rollNo || student._id;
    if (!window.confirm(`Reset face biometric vectors for student ${roll} (${student.name})?`)) return;

    try {
      await setDoc(doc(db, "students", roll), {
        faceRegistered: false,
        biometricEnrolled: false,
        hasFaceRegistered: false,
        faceRemovedAt: Date.now(),
        updatedAt: Date.now()
      }, { merge: true });

      broadcastStudentUpdate({ rollNo: roll, faceRegistered: false });
      showFeedback("success", `Face biometrics reset for ${roll}.`);
      loadActiveCollection("students");
    } catch (err) {
      showFeedback("error", "Failed to reset face: " + err.message);
    }
  };

  const handleQuickUnlockDevice = async (student) => {
    const roll = student.rollNo || student._id;
    if (!window.confirm(`Unlock hardware device lock for student ${roll}?`)) return;

    try {
      await resetStudentDeviceLockGlobally(roll);
      showFeedback("success", `Device lock removed for ${roll}. Student can now sign in from any authorized device.`);
      loadActiveCollection("students");
    } catch (err) {
      showFeedback("error", "Failed to unlock device: " + err.message);
    }
  };

  // =========================================================
  // 4. SYSTEM REPAIR UTILITIES
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
      fetchAllCounts();
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
      loadActiveCollection("students");
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
      loadActiveCollection("lecturers");
      fetchAllCounts();
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
            Complete visual control over Firestore: explore live records, view collection architecture, edit users, and repair accounts without JSON.
          </p>
        </div>
        <div className="db-header-actions">
          <button
            type="button"
            className="db-btn db-btn-primary"
            onClick={() => {
              loadActiveCollection();
              fetchAllCounts();
            }}
            disabled={loading}
          >
            <FaSyncAlt className={loading ? "spin-icon" : ""} />
            Sync Records
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
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
          className={`db-tab-btn ${activeTab === "explorer" ? "active" : ""}`}
          onClick={() => handleTabSwitch("explorer")}
        >
          <FaDatabase /> Live Visual Data Explorer
        </button>
        <button
          type="button"
          className={`db-tab-btn ${activeTab === "schema" ? "active" : ""}`}
          onClick={() => handleTabSwitch("schema")}
        >
          <FaBookOpen /> Database Architecture &amp; Schema Blueprint
        </button>
        <button
          type="button"
          className={`db-tab-btn ${activeTab === "repair" ? "active" : ""}`}
          onClick={() => handleTabSwitch("repair")}
        >
          <FaTools /> System Repair &amp; Emergency Utilities
        </button>
      </div>

      {/* =====================================================
          TAB 1: LIVE VISUAL DATA EXPLORER (NO JSON)
          ===================================================== */}
      {activeTab === "explorer" && (
        <div>
          {/* Collection Selector Pills */}
          <div className="db-collection-pills">
            {COLLECTIONS.map((c) => {
              const Icon = c.icon;
              const count = counts[c.id] ?? 0;
              const isActive = selectedCollection === c.id;

              return (
                <button
                  key={c.id}
                  type="button"
                  className={`db-pill ${isActive ? "active" : ""}`}
                  onClick={() => handleCollectionSwitch(c.id)}
                >
                  <Icon />
                  <span>{c.label}</span>
                  <span className="db-pill-count">{count}</span>
                </button>
              );
            })}
          </div>

          {/* Main Card with Toolbar & Interactive Table */}
          <div className="db-card">
            <div className="db-card-header">
              <h2>
                {selectedCollection === "students" && <FaUserGraduate />}
                {selectedCollection === "lecturers" && <FaChalkboardTeacher />}
                {selectedCollection === "admins" && <FaUserShield />}
                {selectedCollection === "courses" && <FaBookOpen />}
                {selectedCollection === "attendance_sessions" && <FaClipboardList />}
                {selectedCollection === "attendance_records" && <FaClipboardList />}
                {selectedCollection === "reregistration_requests" && <FaKey />}
                {selectedCollection === "support_tickets" && <FaTools />}
                {selectedCollection === "institution" && <FaUniversity />}
                {selectedCollection === "app_updates" && <FaDatabase />}
                <span>
                  {COLLECTIONS.find((c) => c.id === selectedCollection)?.label || selectedCollection} Records
                </span>
                <span className="db-badge db-badge-blue" style={{ fontSize: "13px" }}>
                  {filteredDocs.length} of {collectionDocs.length} shown
                </span>
              </h2>

              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  type="button"
                  className="db-btn db-btn-success"
                  onClick={() => handleOpenAdd(selectedCollection)}
                >
                  <FaPlus /> Add New Record
                </button>
              </div>
            </div>

            {/* Toolbar: Search and Filter */}
            <div className="db-toolbar">
              <div className="db-search-box">
                <FaSearch style={{ color: "#64748b" }} />
                <input
                  type="text"
                  placeholder={`Search ${selectedCollection} by name, roll no, email, code...`}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer" }}
                  >
                    <FaTimes />
                  </button>
                )}
              </div>

              <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <label style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-muted, #64748b)" }}>
                  Status:
                </label>
                <select
                  className="db-select"
                  style={{ padding: "8px 12px", fontSize: "13px" }}
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="all">All Records</option>
                  <option value="active">Active Only</option>
                  <option value="disabled">Disabled / Inactive</option>
                  <option value="removed">Removed / Deleted</option>
                </select>
              </div>
            </div>

            {/* Table Container */}
            {loading && collectionDocs.length === 0 ? (
              <div className="db-empty-state">
                <FaSyncAlt className="spin-icon" style={{ fontSize: "32px", color: "#6366f1" }} />
                <p style={{ marginTop: "12px", fontWeight: 600 }}>Loading records from Firestore...</p>
              </div>
            ) : filteredDocs.length === 0 ? (
              <div className="db-empty-state">
                <FaDatabase className="db-empty-icon" />
                <h3 style={{ margin: "0 0 6px" }}>No matching records found</h3>
                <p style={{ margin: 0, fontSize: "14px" }}>
                  {searchQuery ? "Try refining your search query." : `The '${selectedCollection}' collection is currently empty.`}
                </p>
                <button
                  type="button"
                  className="db-btn db-btn-primary"
                  style={{ marginTop: "16px" }}
                  onClick={() => handleOpenAdd(selectedCollection)}
                >
                  <FaPlus /> Add First Record
                </button>
              </div>
            ) : (
              <div className="db-table-wrapper">
                <table className="db-table">
                  {/* STUDENTS TABLE */}
                  {selectedCollection === "students" && (
                    <>
                      <thead>
                        <tr>
                          <th>Roll Number</th>
                          <th>Student Name</th>
                          <th>Email Address</th>
                          <th>Branch &amp; Sem</th>
                          <th>Account Status</th>
                          <th>Face Biometrics</th>
                          <th>Device Lock</th>
                          <th style={{ textAlign: "right" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDocs.map((s) => {
                          const isFace = Boolean(s.faceRegistered || s.biometricEnrolled || s.hasFaceRegistered);
                          const isLocked = Boolean(s.deviceTypeLocked || s.isDeviceRegistered);
                          const status = String(s.status || (s.approved !== false ? "active" : "disabled")).toLowerCase();

                          return (
                            <tr key={s._id}>
                              <td style={{ fontWeight: 800, color: "var(--accent, #6366f1)" }}>
                                {s.rollNo || s._id}
                              </td>
                              <td style={{ fontWeight: 700 }}>{s.name || s.fullName || "—"}</td>
                              <td style={{ color: "var(--text-muted, #64748b)" }}>{s.email || "—"}</td>
                              <td>
                                <span className="db-badge db-badge-blue">
                                  {s.branch || "CSE"} - Sem {s.semester || "1"}
                                </span>
                              </td>
                              <td>
                                {status === "active" ? (
                                  <span className="db-badge db-badge-green"><FaCheck /> Active</span>
                                ) : (
                                  <span className="db-badge db-badge-red"><FaBan /> {status.toUpperCase()}</span>
                                )}
                              </td>
                              <td>
                                {isFace ? (
                                  <span className="db-badge db-badge-green"><FaCamera /> Enrolled</span>
                                ) : (
                                  <span className="db-badge db-badge-amber">Pending</span>
                                )}
                              </td>
                              <td>
                                {isLocked ? (
                                  <span className="db-badge db-badge-red"><FaMobileAlt /> Locked</span>
                                ) : (
                                  <span className="db-badge db-badge-gray">Unlocked</span>
                                )}
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <div className="db-row-actions" style={{ justifyContent: "flex-end" }}>
                                  <button
                                    type="button"
                                    className="db-row-btn"
                                    onClick={() => setInspectingDoc(s)}
                                    title="Inspect all properties visually"
                                  >
                                    <FaEye /> Inspect
                                  </button>
                                  <button
                                    type="button"
                                    className="db-row-btn"
                                    onClick={() => handleOpenEdit(s)}
                                    title="Edit student details"
                                  >
                                    <FaEdit /> Edit
                                  </button>
                                  {isFace && (
                                    <button
                                      type="button"
                                      className="db-row-btn"
                                      onClick={() => handleQuickResetFace(s)}
                                      title="Reset face biometric vectors"
                                    >
                                      <FaCamera /> Reset
                                    </button>
                                  )}
                                  {isLocked && (
                                    <button
                                      type="button"
                                      className="db-row-btn"
                                      onClick={() => handleQuickUnlockDevice(s)}
                                      title="Unlock hardware device lock"
                                    >
                                      <FaUnlockAlt /> Unlock
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="db-row-btn db-row-btn-danger"
                                    onClick={() => handleDeleteRecord(s)}
                                    title="Delete student completely"
                                  >
                                    <FaTrashAlt />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </>
                  )}

                  {/* LECTURERS TABLE */}
                  {selectedCollection === "lecturers" && (
                    <>
                      <thead>
                        <tr>
                          <th>Faculty Name</th>
                          <th>Email Address</th>
                          <th>Department</th>
                          <th>Designation</th>
                          <th>Status</th>
                          <th style={{ textAlign: "right" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDocs.map((l) => (
                          <tr key={l._id}>
                            <td style={{ fontWeight: 800 }}>{l.name || l.fullName || l._id}</td>
                            <td style={{ color: "var(--text-muted, #64748b)" }}>{l.email || l._id}</td>
                            <td><span className="db-badge db-badge-blue">{l.department || "Faculty"}</span></td>
                            <td>{l.designation || "Lecturer"}</td>
                            <td>
                              {l.status === "active" || l.approved !== false ? (
                                <span className="db-badge db-badge-green"><FaCheck /> Active</span>
                              ) : (
                                <span className="db-badge db-badge-red"><FaBan /> {l.status || "Disabled"}</span>
                              )}
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <div className="db-row-actions" style={{ justifyContent: "flex-end" }}>
                                <button type="button" className="db-row-btn" onClick={() => setInspectingDoc(l)}>
                                  <FaEye /> Inspect
                                </button>
                                <button type="button" className="db-row-btn" onClick={() => handleOpenEdit(l)}>
                                  <FaEdit /> Edit
                                </button>
                                <button type="button" className="db-row-btn db-row-btn-danger" onClick={() => handleDeleteRecord(l)}>
                                  <FaTrashAlt />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}

                  {/* ADMINS TABLE */}
                  {selectedCollection === "admins" && (
                    <>
                      <thead>
                        <tr>
                          <th>Admin Name</th>
                          <th>Email Address</th>
                          <th>Department</th>
                          <th>Designation</th>
                          <th>Status</th>
                          <th style={{ textAlign: "right" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDocs.map((a) => (
                          <tr key={a._id}>
                            <td style={{ fontWeight: 800 }}>{a.name || a.fullName || a._id}</td>
                            <td style={{ color: "var(--text-muted, #64748b)" }}>{a.email || a._id}</td>
                            <td><span className="db-badge db-badge-blue">{a.department || "Administration"}</span></td>
                            <td>{a.designation || "System Administrator"}</td>
                            <td>
                              <span className="db-badge db-badge-green"><FaCheck /> Active</span>
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <div className="db-row-actions" style={{ justifyContent: "flex-end" }}>
                                <button type="button" className="db-row-btn" onClick={() => setInspectingDoc(a)}>
                                  <FaEye /> Inspect
                                </button>
                                <button type="button" className="db-row-btn" onClick={() => handleOpenEdit(a)}>
                                  <FaEdit /> Edit
                                </button>
                                <button type="button" className="db-row-btn db-row-btn-danger" onClick={() => handleDeleteRecord(a)}>
                                  <FaTrashAlt />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}

                  {/* COURSES TABLE */}
                  {selectedCollection === "courses" && (
                    <>
                      <thead>
                        <tr>
                          <th>Course Code</th>
                          <th>Course Name</th>
                          <th>Assigned Lecturer</th>
                          <th>Branch &amp; Sem</th>
                          <th>Enrolled Students</th>
                          <th style={{ textAlign: "right" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDocs.map((c) => {
                          const enrolledCount = Array.isArray(c.students) ? c.students.length : (Array.isArray(c.enrolledStudents) ? c.enrolledStudents.length : 0);

                          return (
                            <tr key={c._id}>
                              <td style={{ fontWeight: 800, color: "var(--accent, #6366f1)" }}>
                                {c.courseCode || c.code || c._id}
                              </td>
                              <td style={{ fontWeight: 700 }}>{c.courseName || c.name || "—"}</td>
                              <td>{c.lecturerName || c.lecturerEmail || "Not Assigned"}</td>
                              <td><span className="db-badge db-badge-blue">{c.branch || "CSE"} - Sem {c.semester || "1"}</span></td>
                              <td><span className="db-badge db-badge-green">{enrolledCount} Students</span></td>
                              <td style={{ textAlign: "right" }}>
                                <div className="db-row-actions" style={{ justifyContent: "flex-end" }}>
                                  <button type="button" className="db-row-btn" onClick={() => setInspectingDoc(c)}>
                                    <FaEye /> Inspect
                                  </button>
                                  <button type="button" className="db-row-btn" onClick={() => handleOpenEdit(c)}>
                                    <FaEdit /> Edit
                                  </button>
                                  <button type="button" className="db-row-btn db-row-btn-danger" onClick={() => handleDeleteRecord(c)}>
                                    <FaTrashAlt />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </>
                  )}

                  {/* SESSIONS TABLE */}
                  {selectedCollection === "attendance_sessions" && (
                    <>
                      <thead>
                        <tr>
                          <th>Session ID</th>
                          <th>Course / Subject</th>
                          <th>Lecturer</th>
                          <th>Created Time</th>
                          <th>Status / Phase</th>
                          <th>Geofence</th>
                          <th style={{ textAlign: "right" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDocs.map((sess) => {
                          const dateStr = sess.createdAt ? new Date(sess.createdAt).toLocaleString() : "—";
                          const isEnded = Boolean(sess.status === "ended" || sess.isEnded);

                          return (
                            <tr key={sess._id}>
                              <td style={{ fontFamily: "monospace", fontWeight: 700 }}>{sess._id}</td>
                              <td style={{ fontWeight: 700 }}>{sess.courseName || sess.courseCode || "Class Session"}</td>
                              <td>{sess.lecturerName || sess.ownerEmail || "Faculty"}</td>
                              <td style={{ color: "#64748b" }}>{dateStr}</td>
                              <td>
                                {isEnded ? (
                                  <span className="db-badge db-badge-gray">Ended</span>
                                ) : (
                                  <span className="db-badge db-badge-green">Phase {sess.phase || 1} Active</span>
                                )}
                              </td>
                              <td>{sess.geofenceRadius || 10}m</td>
                              <td style={{ textAlign: "right" }}>
                                <div className="db-row-actions" style={{ justifyContent: "flex-end" }}>
                                  <button type="button" className="db-row-btn" onClick={() => setInspectingDoc(sess)}>
                                    <FaEye /> Inspect
                                  </button>
                                  <button type="button" className="db-row-btn db-row-btn-danger" onClick={() => handleDeleteRecord(sess)}>
                                    <FaTrashAlt />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </>
                  )}

                  {/* ATTENDANCE RECORDS TABLE */}
                  {selectedCollection === "attendance_records" && (
                    <>
                      <thead>
                        <tr>
                          <th>Record ID</th>
                          <th>Student Roll No</th>
                          <th>Student Name</th>
                          <th>Status</th>
                          <th>Verification</th>
                          <th>Logged At</th>
                          <th style={{ textAlign: "right" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDocs.map((rec) => {
                          const timeStr = rec.submittedAt ? new Date(rec.submittedAt).toLocaleString() : (rec.timestamp ? new Date(rec.timestamp).toLocaleString() : "—");

                          return (
                            <tr key={rec._id}>
                              <td style={{ fontFamily: "monospace", fontSize: "12px", color: "#64748b" }}>{rec._id}</td>
                              <td style={{ fontWeight: 800, color: "var(--accent, #6366f1)" }}>{rec.studentRoll || rec.rollNo || "—"}</td>
                              <td style={{ fontWeight: 700 }}>{rec.studentName || rec.name || "—"}</td>
                              <td><span className="db-badge db-badge-green">PRESENT</span></td>
                              <td>
                                <span className="db-badge db-badge-blue">
                                  {rec.biometricStatus || "Verified"}
                                </span>
                              </td>
                              <td style={{ color: "#64748b" }}>{timeStr}</td>
                              <td style={{ textAlign: "right" }}>
                                <div className="db-row-actions" style={{ justifyContent: "flex-end" }}>
                                  <button type="button" className="db-row-btn" onClick={() => setInspectingDoc(rec)}>
                                    <FaEye /> Inspect
                                  </button>
                                  <button type="button" className="db-row-btn db-row-btn-danger" onClick={() => handleDeleteRecord(rec)}>
                                    <FaTrashAlt />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </>
                  )}

                  {/* FALLBACK / GENERIC TABLE */}
                  {!["students", "lecturers", "admins", "courses", "attendance_sessions", "attendance_records"].includes(selectedCollection) && (
                    <>
                      <thead>
                        <tr>
                          <th>Document ID</th>
                          <th>Primary Identifier</th>
                          <th>Key Values</th>
                          <th style={{ textAlign: "right" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDocs.map((item) => (
                          <tr key={item._id}>
                            <td style={{ fontWeight: 700, fontFamily: "monospace" }}>{item._id}</td>
                            <td style={{ fontWeight: 700 }}>{item.name || item.title || item.version || item.rollNo || item.email || "Document"}</td>
                            <td style={{ color: "#64748b", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {Object.keys(item).filter(k => !k.startsWith("_")).slice(0, 4).map(k => `${k}: ${String(item[k])}`).join(" • ")}
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <div className="db-row-actions" style={{ justifyContent: "flex-end" }}>
                                <button type="button" className="db-row-btn" onClick={() => setInspectingDoc(item)}>
                                  <FaEye /> Inspect
                                </button>
                                <button type="button" className="db-row-btn" onClick={() => handleOpenEdit(item)}>
                                  <FaEdit /> Edit
                                </button>
                                <button type="button" className="db-row-btn db-row-btn-danger" onClick={() => handleDeleteRecord(item)}>
                                  <FaTrashAlt />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================
          TAB 2: DATABASE ARCHITECTURE & SCHEMA BLUEPRINT (NO JSON)
          ===================================================== */}
      {activeTab === "schema" && (
        <div className="db-schema-grid">
          <div className="db-card" style={{ background: "linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(16, 185, 129, 0.04) 100%)", border: "1px solid rgba(99, 102, 241, 0.25)" }}>
            <h2 style={{ margin: "0 0 8px", fontSize: "20px", display: "flex", alignItems: "center", gap: "10px" }}>
              <FaLayerGroup style={{ color: "#6366f1" }} /> Canonical Database Architecture
            </h2>
            <p style={{ margin: 0, fontSize: "14px", color: "var(--text-muted, #64748b)" }}>
              The SmartAttend system enforces clean, unified Document ID conventions to guarantee 0 permission errors, prevent document fragmentation, and keep hardware security strictly enforced.
            </p>
          </div>

          {SCHEMA_BLUEPRINTS.map((schema) => {
            const Icon = schema.icon;
            const liveCount = counts[schema.id] ?? 0;

            return (
              <div key={schema.id} className="db-schema-card">
                <div className="db-schema-header">
                  <div className="db-schema-title-group">
                    <h3>
                      <Icon style={{ color: "#6366f1" }} />
                      <span>{schema.title}</span>
                      <span className="db-badge db-badge-blue">{liveCount} Live Records</span>
                    </h3>
                    <div className="db-schema-docid">
                      Primary Key Pattern: {schema.docIdRule}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      className="db-btn db-btn-secondary"
                      onClick={() => {
                        handleCollectionSwitch(schema.id);
                        handleTabSwitch("explorer");
                      }}
                    >
                      <FaDatabase /> Browse Live Records ({liveCount})
                    </button>
                    <button
                      type="button"
                      className="db-btn db-btn-success"
                      onClick={() => handleOpenAdd(schema.id)}
                    >
                      <FaPlus /> Add {schema.id === "students" ? "Student" : (schema.id === "lecturers" ? "Faculty" : "Item")}
                    </button>
                  </div>
                </div>

                <p className="db-schema-desc">{schema.description}</p>

                {/* Field Dictionary Table */}
                <div className="db-table-wrapper">
                  <table className="db-table">
                    <thead>
                      <tr>
                        <th style={{ width: "20%" }}>Field Name</th>
                        <th style={{ width: "15%" }}>Data Type</th>
                        <th style={{ width: "15%" }}>Requirement</th>
                        <th style={{ width: "50%" }}>Field Description &amp; Usage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schema.fields.map((f) => (
                        <tr key={f.name}>
                          <td style={{ fontWeight: 800, fontFamily: "monospace", color: "var(--accent, #6366f1)" }}>
                            {f.name}
                          </td>
                          <td>
                            <span className={`db-type-pill db-type-${f.type.startsWith("array") ? "array" : f.type}`}>
                              {f.type}
                            </span>
                          </td>
                          <td>
                            {f.required ? (
                              <span className="db-badge db-badge-amber">Required</span>
                            ) : (
                              <span className="db-badge db-badge-gray">Optional</span>
                            )}
                          </td>
                          <td style={{ color: "var(--text-main, #334155)" }}>{f.desc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* =====================================================
          TAB 3: SYSTEM REPAIR & EMERGENCY UTILITIES
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
              <FaPlus /> Authorize &amp; Save Lecturer
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

      {/* =====================================================
          VISUAL DOCUMENT INSPECTOR MODAL (100% VISUAL - NO JSON)
          ===================================================== */}
      {inspectingDoc && (
        <div className="db-modal-overlay" onClick={() => setInspectingDoc(null)}>
          <div className="db-modal-content db-modal-content-wide" onClick={(e) => e.stopPropagation()}>
            <div className="db-modal-header">
              <div>
                <h3>
                  <FaEye style={{ color: "#6366f1" }} /> Document Inspector
                </h3>
                <span className="db-schema-docid" style={{ marginTop: "4px" }}>
                  /{selectedCollection}/{inspectingDoc._id}
                </span>
              </div>
              <button type="button" className="db-modal-close" onClick={() => setInspectingDoc(null)}>
                <FaTimes />
              </button>
            </div>

            {/* Visual Properties Grid */}
            <div className="db-inspector-grid">
              {Object.keys(inspectingDoc)
                .filter((k) => !k.startsWith("_"))
                .map((key) => {
                  const val = inspectingDoc[key];
                  const isTime = typeof val === "number" && val > 1600000000000 && (key.toLowerCase().includes("at") || key.toLowerCase().includes("time") || key.toLowerCase().includes("date"));
                  const isBool = typeof val === "boolean";
                  const isArray = Array.isArray(val);
                  const isFaceVector = key === "faceDescriptor" && isArray;

                  return (
                    <div
                      key={key}
                      className={`db-prop-card ${isFaceVector || (isArray && val.length > 5) ? "full-width" : ""}`}
                    >
                      <div className="db-prop-header">
                        <span className="db-prop-label">{key}</span>
                        <span className="db-type-pill db-type-string">
                          {isTime ? "timestamp" : isBool ? "boolean" : isArray ? `array (${val.length})` : typeof val}
                        </span>
                      </div>

                      <div className="db-prop-value">
                        {isFaceVector ? (
                          <div>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <span className="db-badge db-badge-green"><FaCamera /> 128D Face Embedding Enrolled</span>
                              <button
                                type="button"
                                className="db-btn db-btn-secondary"
                                style={{ padding: "4px 8px", fontSize: "11px" }}
                                onClick={() => setShowRawVector(!showRawVector)}
                              >
                                {showRawVector ? "Hide Raw Floats" : "Show 128 Floats"}
                              </button>
                            </div>
                            {showRawVector && (
                              <div className="db-vector-box">
                                [{val.map(n => typeof n === "number" ? n.toFixed(4) : String(n)).join(", ")}]
                              </div>
                            )}
                          </div>
                        ) : isTime ? (
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <FaClock style={{ color: "#6366f1" }} />
                            <span>{new Date(val).toLocaleString()}</span>
                          </div>
                        ) : isBool ? (
                          val ? (
                            <span className="db-badge db-badge-green"><FaCheck /> True / Active</span>
                          ) : (
                            <span className="db-badge db-badge-gray"><FaBan /> False / Inactive</span>
                          )
                        ) : isArray ? (
                          <div className="db-chips-container">
                            {val.length === 0 ? (
                              <span style={{ color: "#94a3b8" }}>Empty List</span>
                            ) : (
                              val.map((item, idx) => (
                                <span key={idx} className="db-chip">
                                  {typeof item === "object" ? JSON.stringify(item) : String(item)}
                                </span>
                              ))
                            )}
                          </div>
                        ) : val === null || val === undefined || val === "" ? (
                          <span style={{ color: "#94a3b8", fontStyle: "italic" }}>Not Set</span>
                        ) : (
                          <span>{String(val)}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>

            {/* Modal Actions */}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "24px", gap: "10px", flexWrap: "wrap" }}>
              <button
                type="button"
                className="db-btn db-btn-secondary"
                onClick={() => setInspectingDoc(null)}
              >
                Close Inspector
              </button>

              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  className="db-btn db-btn-primary"
                  onClick={() => handleOpenEdit(inspectingDoc)}
                >
                  <FaEdit /> Edit in Visual Form
                </button>
                <button
                  type="button"
                  className="db-btn db-btn-danger"
                  onClick={() => handleDeleteRecord(inspectingDoc)}
                >
                  <FaTrashAlt /> Delete Record
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================
          EDIT / ADD RECORD MODAL (100% VISUAL FORM - NO JSON)
          ===================================================== */}
      {modalMode && (
        <div className="db-modal-overlay" onClick={() => setModalMode(null)}>
          <div className="db-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="db-modal-header">
              <h3>
                {modalMode === "edit" ? "Edit Database Record" : "Add New Record"} ({COLLECTIONS.find(c => c.id === selectedCollection)?.label || selectedCollection})
              </h3>
              <button type="button" className="db-modal-close" onClick={() => setModalMode(null)}>
                <FaTimes />
              </button>
            </div>

            {/* FORM FIELDS TAILORED BY COLLECTION */}
            <div>
              {/* Common Name Field */}
              {selectedCollection !== "attendance_sessions" && selectedCollection !== "attendance_records" && (
                <div className="db-form-row">
                  <div className="db-form-group">
                    <label>{selectedCollection === "courses" ? "Course Name" : "Full Name"}</label>
                    <input
                      type="text"
                      className="db-input"
                      value={formFields.name || formFields.fullName || formFields.courseName || ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        setFormFields({ ...formFields, name: val, fullName: val, courseName: val });
                      }}
                    />
                  </div>

                  {selectedCollection !== "courses" && (
                    <div className="db-form-group">
                      <label>Email Address</label>
                      <input
                        type="email"
                        className="db-input"
                        value={formFields.email || ""}
                        onChange={(e) => setFormFields({ ...formFields, email: e.target.value })}
                        disabled={modalMode === "edit" && selectedCollection === "lecturers"}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Student specific fields */}
              {selectedCollection === "students" && (
                <>
                  <div className="db-form-row">
                    <div className="db-form-group">
                      <label>Roll Number</label>
                      <input
                        type="text"
                        className="db-input"
                        value={formFields.rollNo || ""}
                        onChange={(e) => setFormFields({ ...formFields, rollNo: e.target.value.toUpperCase() })}
                        disabled={modalMode === "edit"}
                      />
                    </div>

                    <div className="db-form-group">
                      <label>Branch / Department</label>
                      <input
                        type="text"
                        className="db-input"
                        value={formFields.branch || formFields.department || "CSE"}
                        onChange={(e) => setFormFields({ ...formFields, branch: e.target.value, department: e.target.value })}
                      />
                    </div>

                    <div className="db-form-group">
                      <label>Semester</label>
                      <input
                        type="text"
                        className="db-input"
                        value={formFields.semester || "1"}
                        onChange={(e) => setFormFields({ ...formFields, semester: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="db-form-row">
                    <div className="db-form-group">
                      <label>Account Status</label>
                      <select
                        className="db-select"
                        value={formFields.status || "active"}
                        onChange={(e) => setFormFields({ ...formFields, status: e.target.value })}
                      >
                        <option value="active">Active (Permitted to Log In)</option>
                        <option value="disabled">Disabled (Cannot Log In)</option>
                        <option value="removed">Removed (Auto-Logout Immediately)</option>
                      </select>
                    </div>

                    <div className="db-form-group">
                      <label>Face Biometric Enrollment</label>
                      <select
                        className="db-select"
                        value={formFields.faceRegistered ? "true" : "false"}
                        onChange={(e) => {
                          const val = e.target.value === "true";
                          setFormFields({
                            ...formFields,
                            faceRegistered: val,
                            biometricEnrolled: val,
                            hasFaceRegistered: val,
                            faceRemovedAt: val ? null : Date.now()
                          });
                        }}
                      >
                        <option value="true">Enrolled (Biometrics Active)</option>
                        <option value="false">Pending (Require Capture / Reset)</option>
                      </select>
                    </div>

                    <div className="db-form-group">
                      <label>Hardware Device Binding</label>
                      <select
                        className="db-select"
                        value={formFields.deviceTypeLocked ? "true" : "false"}
                        onChange={(e) => {
                          const val = e.target.value === "true";
                          setFormFields({
                            ...formFields,
                            deviceTypeLocked: val,
                            isDeviceRegistered: val
                          });
                        }}
                      >
                        <option value="true">Locked to First Device</option>
                        <option value="false">Unlocked (Any Device Allowed)</option>
                      </select>
                    </div>
                  </div>
                </>
              )}

              {/* Lecturer specific fields */}
              {selectedCollection === "lecturers" && (
                <div className="db-form-row">
                  <div className="db-form-group">
                    <label>Department</label>
                    <input
                      type="text"
                      className="db-input"
                      value={formFields.department || "Computer Science"}
                      onChange={(e) => setFormFields({ ...formFields, department: e.target.value })}
                    />
                  </div>
                  <div className="db-form-group">
                    <label>Designation</label>
                    <input
                      type="text"
                      className="db-input"
                      value={formFields.designation || "Assistant Professor"}
                      onChange={(e) => setFormFields({ ...formFields, designation: e.target.value })}
                    />
                  </div>
                  <div className="db-form-group">
                    <label>Account Status</label>
                    <select
                      className="db-select"
                      value={formFields.status || "active"}
                      onChange={(e) => setFormFields({ ...formFields, status: e.target.value })}
                    >
                      <option value="active">Active (Can Log In)</option>
                      <option value="disabled">Disabled (Cannot Log In)</option>
                    </select>
                  </div>
                </div>
              )}

              {/* Course specific fields */}
              {selectedCollection === "courses" && (
                <div className="db-form-row">
                  <div className="db-form-group">
                    <label>Course Code</label>
                    <input
                      type="text"
                      className="db-input"
                      value={formFields.courseCode || formFields.code || ""}
                      onChange={(e) => setFormFields({ ...formFields, courseCode: e.target.value.toUpperCase(), code: e.target.value.toUpperCase() })}
                      disabled={modalMode === "edit"}
                    />
                  </div>
                  <div className="db-form-group">
                    <label>Assigned Lecturer Email</label>
                    <input
                      type="email"
                      className="db-input"
                      value={formFields.lecturerEmail || ""}
                      onChange={(e) => setFormFields({ ...formFields, lecturerEmail: e.target.value })}
                    />
                  </div>
                  <div className="db-form-group">
                    <label>Branch &amp; Semester</label>
                    <input
                      type="text"
                      className="db-input"
                      placeholder="e.g. CSE - 1"
                      value={`${formFields.branch || "CSE"} - ${formFields.semester || "1"}`}
                      onChange={(e) => {
                        const parts = e.target.value.split("-");
                        setFormFields({ ...formFields, branch: parts[0]?.trim() || "CSE", semester: parts[1]?.trim() || "1" });
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Modal Action Buttons */}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "24px", gap: "10px" }}>
              <button
                type="button"
                className="db-btn db-btn-secondary"
                onClick={() => setModalMode(null)}
              >
                Cancel
              </button>

              <button
                type="button"
                className="db-btn db-btn-success"
                onClick={handleSaveRecord}
                disabled={savingRecord}
              >
                <FaSave /> {savingRecord ? "Saving to Database..." : "Save to Database"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DatabaseManager;
