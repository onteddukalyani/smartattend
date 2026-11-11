import React, { useState, useEffect, useMemo, useCallback } from "react";
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
  FaInfoCircle,
  FaBell,
  FaUndo
} from "react-icons/fa";
import {
  collection,
  collectionGroup,
  getDocs,
  doc,
  setDoc,
  deleteDoc,
  writeBatch,
  runTransaction,
  Timestamp
} from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import {
  deleteStudentRecordCompletely,
  resetStudentDeviceLockGlobally,
  broadcastStudentUpdate
} from "../../../utils/studentDataHelper";
import {
  purgeUserCompletelyFromAllDatabases,
  deduplicateUsersCollection
} from "../../../utils/userManagementService";
import "./DatabaseManager.css";

// Available Collections in SmartAttend
const COLLECTIONS = [
  { id: "students", label: "Students", icon: FaUserGraduate },
  { id: "lecturers", label: "Lecturers", icon: FaChalkboardTeacher },
  { id: "admins", label: "Admins", icon: FaUserShield },
  { id: "users", label: "Users Auth Index", icon: FaDatabase },
  { id: "authorizedUsers", label: "Authorized Users", icon: FaUserShield },
  { id: "courses", label: "Courses", icon: FaBookOpen },
  { id: "attendance_sessions", label: "Sessions", icon: FaClipboardList },
  { id: "attendance_records", label: "Attendance Logs", icon: FaClipboardList },
  { id: "reregistration_requests", label: "Biometric Requests", icon: FaKey },
  { id: "support_tickets", label: "Support Tickets", icon: FaTools },
  { id: "devices", label: "Registered Devices", icon: FaMobileAlt },
  { id: "institution", label: "Settings", icon: FaUniversity },
  { id: "app_updates", label: "App Releases", icon: FaDatabase }
];

const CLEANUP_TARGETS = [
  {
    id: "users_duplicates",
    label: "Duplicate User Accounts & Legacy UIDs",
    description: "Detects and cleans email-prefix duplicates (e.g. 'onteddukalyani' when 'onteddukalyani@gmail.com' exists) and raw Auth UID documents across users, lecturers, admins, and authorizedUsers.",
    collection: "users",
    icon: FaDatabase,
    confirmText: "CLEAN DUPLICATES",
    isDeduplication: true
  },
  {
    id: "students",
    label: "Student list",
    description: "Delete student profile documents only. Firebase Authentication accounts and student notifications are not deleted.",
    collection: "students",
    icon: FaUserGraduate,
    confirmText: "DELETE STUDENT LIST"
  },
  {
    id: "lecturers",
    label: "Lecturers",
    description: "Delete lecturer profile documents only. Lecturer notification data is a separate action.",
    collection: "lecturers",
    icon: FaChalkboardTeacher,
    confirmText: "DELETE LECTURERS"
  },
  {
    id: "support_tickets",
    label: "Support tickets",
    description: "Permanently delete all support ticket documents.",
    collection: "support_tickets",
    icon: FaTools,
    confirmText: "DELETE SUPPORT TICKETS"
  },
  {
    id: "student_notifications",
    label: "Student notifications",
    description: "Delete student-only notification records. Shared broadcasts are kept.",
    notificationRole: "student",
    notificationAliases: ["student", "students"],
    nestedRoots: ["students", "student_notifications"],
    globalRoots: ["notifications", "broadcast_notifications", "announcements"],
    icon: FaBell,
    confirmText: "DELETE STUDENT NOTIFICATIONS"
  },
  {
    id: "lecturer_notifications",
    label: "Lecturer notifications",
    description: "Delete lecturer-only notification records and lecturer notification subcollections. Shared broadcasts are kept.",
    notificationRole: "lecturer",
    notificationAliases: ["lecturer", "lecturers", "faculty", "professor", "professors"],
    nestedRoots: ["lecturers"],
    globalRoots: ["lecturer_notifications", "faculty_notifications", "notifications", "broadcast_notifications", "announcements"],
    icon: FaBell,
    confirmText: "DELETE LECTURER NOTIFICATIONS"
  },
  {
    id: "admin_notifications",
    label: "Admin notifications",
    description: "Delete admin-only notification records and admin notification subcollections. Shared broadcasts are kept.",
    notificationRole: "admin",
    notificationAliases: ["admin", "admins"],
    nestedRoots: ["admins"],
    globalRoots: ["admin_notifications", "faculty_notifications", "notifications", "broadcast_notifications", "announcements"],
    icon: FaBell,
    confirmText: "DELETE ADMIN NOTIFICATIONS"
  }
];

const isExclusiveNotificationForRole = (data, aliases) => {
  const rawTargets = Array.isArray(data.targetRoles) && data.targetRoles.length
    ? data.targetRoles
    : [data.targetRole || data.recipientRole].filter(Boolean);
  const targets = new Set(rawTargets.map((role) => String(role).toLowerCase().trim()));
  return targets.size > 0 && [...targets].every((role) => aliases.includes(role));
};

const getCleanupTargetRefs = async (target) => {
  if (!target.notificationRole) {
    const snapshot = await getDocs(collection(db, target.collection));
    return snapshot.docs.map((item) => ({ ref: item.ref, data: item.data() }));
  }

  const records = new Map();
  const [nestedSnapshot, ...globalSnapshots] = await Promise.all([
    getDocs(collectionGroup(db, "notifications")),
    ...target.globalRoots.map((root) => getDocs(collection(db, root)))
  ]);

  nestedSnapshot.docs.forEach((item) => {
    const path = item.ref.path.split("/");
    if (path.length === 4 && target.nestedRoots.includes(path[0])) {
      records.set(item.ref.path, { ref: item.ref, data: item.data() });
    }
  });

  globalSnapshots.forEach((snapshot) => {
    snapshot.docs.forEach((item) => {
      if (isExclusiveNotificationForRole(item.data(), target.notificationAliases)) {
        records.set(item.ref.path, { ref: item.ref, data: item.data() });
      }
    });
  });

  return [...records.values()];
};

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
    docIdRule: "/lecturers/{email} (Canonical lowercase email address)",
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
    docIdRule: "/admins/{email} (Canonical lowercase email address)",
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
      { name: "sessionDuration", type: "number", required: true, desc: "Reference default duration (Class session timings are manually set by Lecturers)" }
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
  const [cleanupTargetInProgress, setCleanupTargetInProgress] = useState("");
  const [recoveryGroups, setRecoveryGroups] = useState([]);
  const [loadingRecovery, setLoadingRecovery] = useState(false);
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
  const [deduplicating, setDeduplicating] = useState(false);

  const showFeedback = useCallback((type, text) => {
    setFeedback({ type, text });
    setTimeout(() => {
      setFeedback({ type: "", text: "" });
    }, 6000);
  }, []);

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
      let docs = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));

      // For Staff (Lecturers & Admins): Deduplicate by canonical email so double entries never appear in app,
      // and auto-purge redundant prefix documents from Firestore in the background.
      if (collId === "lecturers" || collId === "admins") {
        const canonicalMap = new Map();
        const redundantDocIdsToDelete = [];

        snap.docs.forEach((d) => {
          const data = d.data() || {};
          const email = (data.email || (d.id.includes("@") ? d.id : "")).toLowerCase().trim();
          const key = email || d.id.toLowerCase().trim();
          const isCanonical = d.id.includes("@");

          if (!canonicalMap.has(key)) {
            canonicalMap.set(key, { _id: d.id, ...data });
          } else {
            const existing = canonicalMap.get(key);
            if (isCanonical && !existing._id.includes("@")) {
              // Current doc is the canonical email document; mark previous prefix doc for cleanup
              redundantDocIdsToDelete.push(existing._id);
              canonicalMap.set(key, { ...existing, ...data, _id: d.id });
            } else if (!isCanonical) {
              // Current doc is a redundant prefix document
              redundantDocIdsToDelete.push(d.id);
            }
          }
        });

        // Additional heuristic check: if a doc has a prefix ID (e.g. 'kalyani2k08'),
        // and its email document ('kalyani2k08@gmail.com') already exists, schedule it for deletion
        for (const [, item] of canonicalMap.entries()) {
          if (!item._id.includes("@") && item.email && item.email.includes("@")) {
            const canonicalExists = snap.docs.some((sd) => sd.id.toLowerCase() === item.email.toLowerCase());
            if (canonicalExists) {
              redundantDocIdsToDelete.push(item._id);
            }
          }
        }

        docs = Array.from(canonicalMap.values());

        // Background auto-purge: delete redundant prefix duplicates directly from Firestore
        if (redundantDocIdsToDelete.length > 0) {
          const uniqueIdsToDelete = [...new Set(redundantDocIdsToDelete)];
          console.log(`[DatabaseManager] Auto-purging ${uniqueIdsToDelete.length} redundant duplicate prefix docs from ${collId}:`, uniqueIdsToDelete);
          uniqueIdsToDelete.forEach((dupId) => {
            deleteDoc(doc(db, collId, dupId)).catch((e) => console.warn(`Notice: Could not auto-purge ${collId}/${dupId}:`, e?.message || e));
          });
        }
      }

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
          if (c.id === "lecturers" || c.id === "admins") {
            const uniqueKeys = new Set();
            s.docs.forEach((d) => {
              const email = (d.data()?.email || (d.id.includes("@") ? d.id : "")).toLowerCase().trim();
              uniqueKeys.add(email || d.id.toLowerCase().trim());
            });
            return { id: c.id, count: uniqueKeys.size };
          }
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

  const loadRecoveryGroups = useCallback(async () => {
    setLoadingRecovery(true);
    try {
      const snapshot = await getDocs(collection(db, "database_recovery"));
      const groups = new Map();
      const now = Timestamp.now().toMillis();

      snapshot.docs.forEach((item) => {
        const record = item.data();
        const expiresAt = record.expiresAt?.toMillis?.() || 0;
        if (!record.operationId || expiresAt <= now) return;

        if (!groups.has(record.operationId)) {
          groups.set(record.operationId, {
            operationId: record.operationId,
            targetId: record.targetId,
            label: record.label,
            deletedAt: record.deletedAt,
            expiresAt: record.expiresAt,
            records: []
          });
        }
        groups.get(record.operationId).records.push({
          id: item.id,
          originalPath: record.originalPath,
          originalData: record.originalData,
          expiresAt: record.expiresAt
        });
      });

      setRecoveryGroups(
        [...groups.values()].sort(
          (a, b) => (b.deletedAt?.toMillis?.() || 0) - (a.deletedAt?.toMillis?.() || 0)
        )
      );
    } catch (err) {
      console.error("Failed to load deleted data recovery entries:", err);
      showFeedback("error", `Failed to load recovery data: ${err.message || "Unknown error"}`);
    } finally {
      setLoadingRecovery(false);
    }
  }, [showFeedback]);

  useEffect(() => {
    if (activeTab === "cleanup") {
      loadRecoveryGroups();
    }
  }, [activeTab, loadRecoveryGroups]);

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
      `Are you sure you want to permanently delete '${displayName}' (${targetId}) from '${selectedCollection}'?\n\nThis will purge all corresponding records across all database collections and unassign any related courses.`
    );
    if (!confirmed) return;

    setLoading(true);
    try {
      if (["students", "lecturers", "admins", "users", "authorizedUsers"].includes(selectedCollection)) {
        await purgeUserCompletelyFromAllDatabases(docItem, selectedCollection);
      } else {
        await deleteDoc(doc(db, selectedCollection, targetId));
      }

      showFeedback("success", `Successfully deleted '${displayName}' across the entire database.`);
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

  const handleDeleteCleanupTarget = async (target) => {
    if (cleanupTargetInProgress) return;

    if (target.isDeduplication) {
      const confirmation = window.prompt(
        `This will scan users, lecturers, admins, and authorizedUsers to merge and purge all email-prefix duplicates and raw Auth UID documents.\n\nType exactly: ${target.confirmText}`
      );
      if (confirmation !== target.confirmText) {
        if (confirmation !== null) {
          showFeedback("error", "Confirmation did not match. Nothing was cleaned.");
        }
        return;
      }

      setCleanupTargetInProgress(target.id);
      try {
        const res = await deduplicateUsersCollection();
        if (res.success) {
          showFeedback("success", `✅ Deduplication complete! Purged ${res.removedCount} duplicate documents and merged ${res.mergedCount} profiles successfully.`);
          await loadActiveCollection(selectedCollection);
          await fetchAllCounts();
        } else {
          showFeedback("error", `Deduplication encountered warnings: ${res.error || "Check console"}`);
        }
      } catch (err) {
        showFeedback("error", `Deduplication failed: ${err.message}`);
      } finally {
        setCleanupTargetInProgress("");
      }
      return;
    }

    let deletedCount = 0;
    setCleanupTargetInProgress(target.id);
    try {
      const records = await getCleanupTargetRefs(target);
      if (!records.length) {
        showFeedback("success", `No ${target.label.toLowerCase()} data was found to delete.`);
        return;
      }

      const typedConfirmation = window.prompt(
        `This moves ${records.length} ${target.label.toLowerCase()} record(s) to recovery for 3 days. After that, recovery is unavailable and Firestore permanently removes the backups.\n\nType exactly: ${target.confirmText}`
      );
      if (typedConfirmation !== target.confirmText) {
        if (typedConfirmation !== null) {
          showFeedback("error", "Confirmation did not match. Nothing was deleted.");
        }
        return;
      }

      const operationId = `${target.id}_${doc(collection(db, "database_recovery")).id}`;
      const deletedAtMs = Timestamp.now().toMillis();
      const expiresAt = Timestamp.fromMillis(deletedAtMs + 3 * 24 * 60 * 60 * 1000);
      for (let offset = 0; offset < records.length; offset += 250) {
        const batch = writeBatch(db);
        records.slice(offset, offset + 250).forEach((record, index) => {
          const recoveryRef = doc(db, "database_recovery", `${operationId}_${offset + index}`);
          batch.set(recoveryRef, {
            operationId,
            targetId: target.id,
            label: target.label,
            originalPath: record.ref.path,
            originalData: record.data,
            deletedAt: Timestamp.fromMillis(deletedAtMs),
            expiresAt
          });
          batch.delete(record.ref);
        });
        await batch.commit();
        deletedCount += Math.min(250, records.length - offset);
      }

      showFeedback("success", `Moved ${deletedCount} ${target.label.toLowerCase()} record(s) to recovery. They can be restored for 3 days.`);
      if (target.collection) {
        setCounts((prev) => ({ ...prev, [target.collection]: 0 }));
        if (selectedCollection === target.collection) {
          await loadActiveCollection(target.collection);
        }
      }
      await fetchAllCounts();
      await loadRecoveryGroups();
    } catch (err) {
      console.error(`Failed to delete ${target.label}:`, err);
      const partialMessage = deletedCount ? ` ${deletedCount} record(s) were deleted before the failure.` : "";
      showFeedback("error", `Failed to delete ${target.label.toLowerCase()}: ${err.message || "Unknown error"}.${partialMessage}`);
    } finally {
      setCleanupTargetInProgress("");
    }
  };

  const handleRestoreRecoveryGroup = async (group) => {
    if (cleanupTargetInProgress) return;

    if (!group.records.length || group.expiresAt?.toMillis?.() <= Timestamp.now().toMillis()) {
      showFeedback("error", "This recovery window has expired. The data can no longer be restored.");
      await loadRecoveryGroups();
      return;
    }

    const confirmation = window.prompt(
      `Restore ${group.records.length} ${group.label.toLowerCase()} record(s)? Existing records will not be overwritten.\n\nType exactly: RESTORE ${group.label.toUpperCase()}`
    );
    if (confirmation !== `RESTORE ${group.label.toUpperCase()}`) {
      if (confirmation !== null) {
        showFeedback("error", "Confirmation did not match. Nothing was restored.");
      }
      return;
    }

    setCleanupTargetInProgress(group.operationId);
    try {
      let restoredCount = 0;
      let conflictCount = 0;
      let expiredCount = 0;

      for (let offset = 0; offset < group.records.length; offset += 20) {
        const results = await Promise.all(group.records.slice(offset, offset + 20).map(async (record) => {
          if (record.expiresAt?.toMillis?.() <= Timestamp.now().toMillis()) return "expired";

          const recoveryRef = doc(db, "database_recovery", record.id);
          const originalRef = doc(db, record.originalPath);
          return runTransaction(db, async (transaction) => {
            const [recoverySnapshot, originalSnapshot] = await Promise.all([
              transaction.get(recoveryRef),
              transaction.get(originalRef)
            ]);
            if (!recoverySnapshot.exists()) return "expired";
            if ((recoverySnapshot.data().expiresAt?.toMillis?.() || 0) <= Timestamp.now().toMillis()) return "expired";
            if (originalSnapshot.exists()) return "conflict";

            transaction.set(originalRef, recoverySnapshot.data().originalData);
            transaction.delete(recoveryRef);
            return "restored";
          });
        }));

        results.forEach((result) => {
          if (result === "restored") restoredCount += 1;
          else if (result === "conflict") conflictCount += 1;
          else expiredCount += 1;
        });
      }

      const messages = [`Restored ${restoredCount} record(s).`];
      if (conflictCount) messages.push(`${conflictCount} existing record(s) were left unchanged.`);
      if (expiredCount) messages.push(`${expiredCount} record(s) had expired and could not be restored.`);
      showFeedback(conflictCount || expiredCount ? "info" : "success", messages.join(" "));

      const target = CLEANUP_TARGETS.find((item) => item.id === group.targetId);
      if (target?.collection && selectedCollection === target.collection) {
        await loadActiveCollection(target.collection);
      }
      await fetchAllCounts();
      await loadRecoveryGroups();
    } catch (err) {
      console.error("Failed to restore deleted data:", err);
      showFeedback("error", `Failed to restore data: ${err.message || "Unknown error"}`);
    } finally {
      setCleanupTargetInProgress("");
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

      // Save strictly to canonical email document across collections
      await Promise.all([
        setDoc(doc(db, "lecturers", email), lecturerData, { merge: true }),
        setDoc(doc(db, "users", email), lecturerData, { merge: true }),
        setDoc(doc(db, "authorizedUsers", email), lecturerData, { merge: true })
      ]);

      // Remove any legacy prefix duplicate document
      if (prefix && prefix !== email) {
        deleteDoc(doc(db, "lecturers", prefix)).catch(() => { });
        deleteDoc(doc(db, "users", prefix)).catch(() => { });
        deleteDoc(doc(db, "authorizedUsers", prefix)).catch(() => { });
      }

      showFeedback("success", `Lecturer '${email}' registered and authorized successfully with single canonical key!`);
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

  const runDeduplication = async () => {
    const confirmed = window.confirm(
      "🧹 Clean & Deduplicate User Accounts?\n\nThis will scan Firestore (users, lecturers, admins, authorizedUsers):\n1. Merge and delete redundant email-prefix duplicates (e.g. 'onteddukalyani' when 'onteddukalyani@gmail.com' exists).\n2. Remove raw Firebase Auth UID duplicate documents.\n3. Retain single canonical documents for every staff and student.\n\nProceed?"
    );
    if (!confirmed) return;

    setDeduplicating(true);
    try {
      const res = await deduplicateUsersCollection();
      if (res.success) {
        showFeedback(
          "success",
          `✅ Deduplication complete! Purged ${res.removedCount} duplicate documents and merged ${res.mergedCount} profiles.`
        );
        loadActiveCollection(selectedCollection);
        fetchAllCounts();
      } else {
        showFeedback("error", "Deduplication finished with warnings: " + (res.error || "Check console"));
      }
    } catch (err) {
      console.error("Deduplication error:", err);
      showFeedback("error", "Failed to deduplicate: " + err.message);
    } finally {
      setDeduplicating(false);
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
            className="db-btn db-btn-warning"
            onClick={runDeduplication}
            disabled={deduplicating || loading}
            style={{ background: "#f59e0b", color: "#fff", borderColor: "#d97706" }}
            title="Scan and remove redundant prefix and UID duplicates across all collections"
          >
            <FaSyncAlt className={deduplicating ? "spin-icon" : ""} />
            {deduplicating ? "Cleaning..." : "🧹 Clean Duplicates"}
          </button>
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
          className={`db-tab-btn ${activeTab === "cleanup" ? "active" : ""}`}
          onClick={() => handleTabSwitch("cleanup")}
        >
          <FaTrashAlt /> Delete Data
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
                {["users", "lecturers", "admins"].includes(selectedCollection) && (
                  <button
                    type="button"
                    className="db-btn db-btn-warning"
                    onClick={runDeduplication}
                    disabled={deduplicating || loading}
                    style={{ background: "#f59e0b", color: "#fff", borderColor: "#d97706" }}
                    title="Scan and remove redundant prefix and UID duplicates"
                  >
                    <FaSyncAlt className={deduplicating ? "fa-spin" : ""} /> {deduplicating ? "Cleaning..." : "🧹 Clean Duplicates"}
                  </button>
                )}
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

                  {/* USERS AUTH INDEX TABLE */}
                  {selectedCollection === "users" && (
                    <>
                      <thead>
                        <tr>
                          <th>User Identifier / Email</th>
                          <th>Full Name</th>
                          <th>Role</th>
                          <th>Status</th>
                          <th>Device / Hardware</th>
                          <th style={{ textAlign: "right" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDocs.map((u) => {
                          const isEmail = u._id.includes("@");
                          const status = String(u.status || (u.approved !== false ? "active" : "disabled")).toLowerCase();
                          return (
                            <tr key={u._id}>
                              <td style={{ fontWeight: 800, color: isEmail ? "var(--accent, #6366f1)" : "#f59e0b" }}>
                                {u._id}
                                {!isEmail && (
                                  <span className="db-badge db-badge-amber" style={{ marginLeft: "8px", fontSize: "11px" }}>
                                    Duplicate / Legacy
                                  </span>
                                )}
                              </td>
                              <td style={{ fontWeight: 700 }}>{u.name || u.fullName || "—"}</td>
                              <td>
                                <span className={`db-badge ${u.role === "admin" ? "db-badge-red" : u.role === "lecturer" ? "db-badge-blue" : "db-badge-green"}`}>
                                  {(u.role || (u.isAdmin ? "admin" : "user")).toUpperCase()}
                                </span>
                              </td>
                              <td>
                                {status === "active" ? (
                                  <span className="db-badge db-badge-green"><FaCheck /> Active</span>
                                ) : (
                                  <span className="db-badge db-badge-red"><FaBan /> {status.toUpperCase()}</span>
                                )}
                              </td>
                              <td style={{ fontSize: "12px", color: "var(--text-muted, #64748b)" }}>
                                {u.deviceType || u.registeredPlatform || (u.hardwareBiometricEnrolled ? "Hardware Biometric" : "—")}
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <div className="db-row-actions" style={{ justifyContent: "flex-end" }}>
                                  <button type="button" className="db-row-btn" onClick={() => setInspectingDoc(u)}>
                                    <FaEye /> Inspect
                                  </button>
                                  <button type="button" className="db-row-btn" onClick={() => handleOpenEdit(u)}>
                                    <FaEdit /> Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="db-row-btn db-row-btn-danger"
                                    onClick={() => handleDeleteRecord(u)}
                                    title="Delete user and purge all records across entire database"
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
                  {!["students", "lecturers", "admins", "users", "courses", "attendance_sessions", "attendance_records"].includes(selectedCollection) && (
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

      {activeTab === "cleanup" && (
        <div>
          <div className="db-card">
            <div className="db-card-header">
              <h2><FaExclamationTriangle /> Delete data by category</h2>
            </div>
            <p style={{ color: "var(--text-muted, #64748b)", fontSize: "14px", margin: "0" }}>
              Each button affects only its named Firestore data group. Deleted records can be restored for 3 days, after which recovery is unavailable and Firestore permanently removes the backups.
              Student and lecturer Firebase Authentication accounts are not deleted. Admin records are intentionally excluded.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))", gap: "16px" }}>
            {CLEANUP_TARGETS.map((target) => {
              const Icon = target.icon;
              const isDeleting = cleanupTargetInProgress === target.id;
              return (
                <section className="db-card" key={target.id} style={{ marginBottom: 0 }}>
                  <div className="db-card-header">
                    <h2><Icon /> {target.label}</h2>
                  </div>
                  <p style={{ minHeight: "58px", color: "var(--text-muted, #64748b)", fontSize: "13px" }}>
                    {target.description}
                  </p>
                  <button
                    type="button"
                    className="db-btn db-btn-danger"
                    disabled={Boolean(cleanupTargetInProgress) || loading}
                    onClick={() => handleDeleteCleanupTarget(target)}
                  >
                    {isDeleting ? <FaSyncAlt className="spin-icon" /> : <FaTrashAlt />}
                    {isDeleting ? "Deleting..." : `Delete ${target.label}`}
                  </button>
                </section>
              );
            })}
          </div>

          <div className="db-card" style={{ marginTop: "24px" }}>
            <div className="db-card-header">
              <h2><FaUndo /> Recover recently deleted data</h2>
              <button
                type="button"
                className="db-btn db-btn-secondary"
                onClick={loadRecoveryGroups}
                disabled={loadingRecovery || Boolean(cleanupTargetInProgress)}
              >
                <FaSyncAlt className={loadingRecovery ? "spin-icon" : ""} /> Refresh
              </button>
            </div>
            {loadingRecovery ? (
              <p style={{ color: "var(--text-muted, #64748b)" }}>Loading available recoveries...</p>
            ) : recoveryGroups.length === 0 ? (
              <p style={{ color: "var(--text-muted, #64748b)", margin: 0 }}>
                There are no deleted records available to recover.
              </p>
            ) : (
              <div style={{ display: "grid", gap: "12px" }}>
                {recoveryGroups.map((group) => {
                  const expiresAt = group.expiresAt?.toDate?.();
                  const isRestoring = cleanupTargetInProgress === group.operationId;
                  return (
                    <div
                      key={group.operationId}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "16px",
                        flexWrap: "wrap",
                        padding: "14px 16px",
                        border: "1px solid var(--border, #e2e8f0)",
                        borderRadius: "12px"
                      }}
                    >
                      <div>
                        <strong>{group.label}</strong>
                        <div style={{ color: "var(--text-muted, #64748b)", fontSize: "13px", marginTop: "4px" }}>
                          {group.records.length} record(s)
                          {expiresAt ? ` · Recovery ends ${expiresAt.toLocaleString()}` : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="db-btn db-btn-success"
                        disabled={Boolean(cleanupTargetInProgress) || loadingRecovery}
                        onClick={() => handleRestoreRecoveryGroup(group)}
                      >
                        {isRestoring ? <FaSyncAlt className="spin-icon" /> : <FaUndo />}
                        {isRestoring ? "Restoring..." : "Restore"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
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
          {/* 3. Deduplicate Users & Staff Accounts */}
          <div className="db-card" style={{ borderLeft: "4px solid #f59e0b" }}>
            <div className="db-card-header">
              <h2><FaSyncAlt /> Deduplicate &amp; Clean Users Collection</h2>
            </div>
            <p style={{ color: "var(--text-muted, #64748b)", fontSize: "14px", margin: "0 0 16px" }}>
              Removes redundant username/prefix duplicate entries (e.g. <code>onteddukalyani</code> when <code>onteddukalyani@gmail.com</code> exists) and stray Firebase Auth UID records from the <code>users</code> collection, merging any orphaned profile data into single canonical documents.
            </p>
            <button
              type="button"
              className="db-btn db-btn-warning"
              onClick={runDeduplication}
              disabled={deduplicating || loading}
              style={{ background: "#f59e0b", color: "#fff", borderColor: "#d97706" }}
            >
              <FaSyncAlt className={deduplicating ? "fa-spin" : ""} /> {deduplicating ? "Cleaning Duplicates..." : "🧹 Clean & Deduplicate Users Collection"}
            </button>
          </div>

          {/* 4. System Repair */}
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
