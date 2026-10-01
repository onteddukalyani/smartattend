import { db } from "../firebase";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  limit,
  serverTimestamp
} from "firebase/firestore";

// In-Memory Subscriber Dispatchers
const localStudentListeners = new Map();
const localFacultyListeners = new Set();

// Cross-tab storage sync handler
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key && e.key.startsWith("smartattend_notifs_student_")) {
      const rollNo = e.key.replace("smartattend_notifs_student_", "");
      const listeners = localStudentListeners.get(rollNo);
      if (listeners && e.newValue) {
        try {
          const list = JSON.parse(e.newValue);
          listeners.forEach(cb => { try { cb(list); } catch (_) {} });
        } catch (_) {}
      }
    } else if (e.key === "smartattend_notifs_faculty") {
      if (e.newValue) {
        try {
          const list = JSON.parse(e.newValue);
          localFacultyListeners.forEach(cb => { try { cb(list); } catch (_) {} });
        } catch (_) {}
      }
    } else if (e.key === "smartattend_notifs_broadcast_ping") {
      try {
        const facList = getLocalFacultyNotifs();
        localFacultyListeners.forEach(cb => { try { cb(facList); } catch (_) {} });
        localStudentListeners.forEach((listeners, rollKey) => {
          const studList = getLocalStudentNotifs(rollKey);
          listeners.forEach(cb => { try { cb(studList); } catch (_) {} });
        });
      } catch (_) {}
    }
  });
}

/**
 * Extract millisecond timestamp from varied Firestore / Local formats
 */
export function getTimestampMs(item) {
  if (!item) return Date.now();
  if (typeof item.createdAt === "number" && !isNaN(item.createdAt) && item.createdAt > 0) {
    return item.createdAt;
  }
  if (item.timestamp) {
    if (typeof item.timestamp.toMillis === "function") return item.timestamp.toMillis();
    if (typeof item.timestamp.toDate === "function") return item.timestamp.toDate().getTime();
    if (typeof item.timestamp === "number" && !isNaN(item.timestamp)) return item.timestamp;
    if (typeof item.timestamp === "string") {
      const parsed = Date.parse(item.timestamp);
      if (!isNaN(parsed)) return parsed;
    }
    if (item.timestamp.seconds) return item.timestamp.seconds * 1000;
  }
  if (typeof item.submittedAt === "number") return item.submittedAt;
  return Date.now();
}

// Helper: Persistent Read & Deleted ID Sets
function getReadNotifIds(storageKey) {
  try {
    const raw = localStorage.getItem(`smartattend_read_ids_${storageKey}`);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (_) {
    return new Set();
  }
}

function saveReadNotifIds(storageKey, set) {
  try {
    const arr = Array.from(set).slice(-200);
    localStorage.setItem(`smartattend_read_ids_${storageKey}`, JSON.stringify(arr));
  } catch (_) {}
}

function getDeletedNotifIds(storageKey) {
  try {
    const raw = localStorage.getItem(`smartattend_del_ids_${storageKey}`);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (_) {
    return new Set();
  }
}

function saveDeletedNotifIds(storageKey, set) {
  try {
    const arr = Array.from(set).slice(-200);
    localStorage.setItem(`smartattend_del_ids_${storageKey}`, JSON.stringify(arr));
  } catch (_) {}
}

function getLocalStudentNotifs(rollNo) {
  try {
    const raw = localStorage.getItem(`smartattend_notifs_student_${rollNo}`);
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

function saveLocalStudentNotifs(rollNo, list) {
  try {
    localStorage.setItem(`smartattend_notifs_student_${rollNo}`, JSON.stringify(list.slice(0, 60)));
  } catch (_) {}
}

function getLocalFacultyNotifs() {
  try {
    const raw = localStorage.getItem('smartattend_notifs_faculty');
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

function saveLocalFacultyNotifs(list) {
  try {
    localStorage.setItem('smartattend_notifs_faculty', JSON.stringify(list.slice(0, 80)));
  } catch (_) {}
}

/**
 * Play a subtle melodic notification chime using Web Audio API
 */
export function playNotificationChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = "sine";
    osc2.type = "sine";

    // Pleasant two-tone chime (E5 -> B5)
    osc1.frequency.setValueAtTime(659.25, now);
    osc1.frequency.exponentialRampToValueAtTime(987.77, now + 0.12);

    osc2.frequency.setValueAtTime(1318.5, now + 0.12);
    osc2.frequency.exponentialRampToValueAtTime(1975.53, now + 0.28);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.14);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.45);

    setTimeout(() => {
      try {
        ctx.close();
      } catch (_) {}
    }, 600);
  } catch (_) {
    // Autoplay or background environment
  }
}

/**
 * Send real-time notification to a specific student document
 */
export async function sendStudentNotification(
  studentRollNo,
  title,
  message,
  type = "SYSTEM_UPDATE",
  senderName = "Faculty/Admin",
  metadata = {}
) {
  if (!studentRollNo) return;
  const cleanRoll = String(studentRollNo).trim().toUpperCase();
  const rollPrefix = cleanRoll.includes("@") ? cleanRoll.split("@")[0].trim().toUpperCase() : cleanRoll;
  const nowMs = Date.now();

  const notifPayload = {
    id: "loc_" + nowMs + "_" + Math.random().toString(36).substring(2, 7),
    recipientRollNo: cleanRoll,
    recipientRollPrefix: rollPrefix,
    recipientRole: "student",
    title: title,
    message: message,
    type: type,
    senderName: senderName,
    read: false,
    createdAt: nowMs,
    timestamp: new Date().toISOString(),
    metadata: metadata || {}
  };

  // 1. Update local storage caches for instant local feedback
  const targetKeys = Array.from(new Set([cleanRoll, rollPrefix].filter(Boolean)));
  targetKeys.forEach(r => {
    const existing = getLocalStudentNotifs(r);
    const updated = [notifPayload, ...existing.filter(n => n.title !== title || nowMs - getTimestampMs(n) > 3000)];
    saveLocalStudentNotifs(r, updated);

    const listeners = localStudentListeners.get(r);
    if (listeners) {
      listeners.forEach(cb => { try { cb(updated); } catch (_) {} });
    }
  });

  // 2. Dispatch to Firestore across all potential student collection endpoints
  const writes = [
    addDoc(collection(db, "students", cleanRoll, "notifications"), {
      ...notifPayload,
      timestamp: serverTimestamp()
    }).catch(() => {}),
    addDoc(collection(db, "student_notifications", cleanRoll, "notifications"), {
      ...notifPayload,
      timestamp: serverTimestamp()
    }).catch(() => {}),
    addDoc(collection(db, "notifications"), {
      ...notifPayload,
      targetRoles: ["student", "all"],
      timestamp: serverTimestamp()
    }).catch(() => {})
  ];

  if (rollPrefix && rollPrefix !== cleanRoll) {
    writes.push(
      addDoc(collection(db, "students", rollPrefix, "notifications"), {
        ...notifPayload,
        timestamp: serverTimestamp()
      }).catch(() => {}),
      addDoc(collection(db, "student_notifications", rollPrefix, "notifications"), {
        ...notifPayload,
        timestamp: serverTimestamp()
      }).catch(() => {})
    );
  }

  await Promise.all(writes);
}

/**
 * Send real-time audit & activity notification to Lecturers & Admins
 */
export async function sendFacultyNotification(
  title,
  message,
  type = "SYSTEM_AUDIT",
  studentRollNo = "",
  senderName = "System",
  metadata = {},
  targetRole = "faculty"
) {
  const nowMs = Date.now();
  const notifPayload = {
    id: "loc_fac_" + nowMs + "_" + Math.random().toString(36).substring(2, 7),
    title: title,
    message: message,
    type: type,
    targetRole: targetRole,
    studentRollNo: studentRollNo ? String(studentRollNo).trim().toUpperCase() : "",
    senderName: senderName,
    read: false,
    createdAt: nowMs,
    timestamp: new Date().toISOString(),
    metadata: metadata || {}
  };

  // 1. Update local storage cache
  const existing = getLocalFacultyNotifs();
  const updated = [notifPayload, ...existing.filter(n => n.title !== title || nowMs - getTimestampMs(n) > 3000)];
  saveLocalFacultyNotifs(updated);

  localFacultyListeners.forEach(cb => {
    try { cb(updated); } catch (_) {}
  });

  // 2. Dispatch to Firestore
  try {
    const facultyNotifRef = collection(db, "faculty_notifications");
    await addDoc(facultyNotifRef, {
      ...notifPayload,
      timestamp: serverTimestamp()
    });

    const globalNotifRef = collection(db, "notifications");
    await addDoc(globalNotifRef, {
      ...notifPayload,
      targetRoles: [targetRole, "faculty", "admin", "lecturer", "all"],
      timestamp: serverTimestamp()
    });
  } catch (_) {}
}

/**
 * Send targeted notification to Admins
 */
export async function sendAdminNotification(
  title,
  message,
  type = "ADMIN_ALERT",
  senderName = "System",
  metadata = {}
) {
  return sendFacultyNotification(title, message, type, "", senderName, metadata, "admin");
}

/**
 * Send targeted notification to Lecturers
 */
export async function sendLecturerNotification(
  title,
  message,
  type = "LECTURER_ALERT",
  senderName = "System",
  metadata = {}
) {
  return sendFacultyNotification(title, message, type, "", senderName, metadata, "lecturer");
}

/**
 * Broadcast an announcement to Students, Lecturers, and/or Admins
 */
export async function sendBroadcastNotification({
  targetRoles = ["student", "lecturer", "admin"],
  title = "Announcement",
  message = "",
  type = "BROADCAST_ANNOUNCEMENT",
  senderName = "Campus Administrator",
  senderRole = "admin",
  metadata = {}
}) {
  const normalizedTargetRoles = Array.isArray(targetRoles)
    ? targetRoles.map(r => String(r).toLowerCase().trim())
    : (targetRoles ? [String(targetRoles).toLowerCase().trim()] : ["student", "lecturer", "admin", "all", "everyone"]);
  
  if (normalizedTargetRoles.length === 0 || normalizedTargetRoles.includes("all") || normalizedTargetRoles.includes("everyone")) {
    normalizedTargetRoles.push("student", "lecturer", "admin", "faculty", "all", "everyone");
  }

  const nowMs = Date.now();

  const payload = {
    id: "loc_broad_" + nowMs + "_" + Math.random().toString(36).substring(2, 7),
    title: title || "Important Announcement",
    message: message || "",
    type: type || "BROADCAST_ANNOUNCEMENT",
    targetRoles: Array.from(new Set(normalizedTargetRoles)),
    targetRole: normalizedTargetRoles.includes("student") ? "all" : (normalizedTargetRoles.includes("lecturer") ? "faculty" : "admin"),
    senderName: senderName || (senderRole === "admin" ? "Campus Administrator" : "Course Lecturer"),
    senderRole: senderRole || "admin",
    isAnnouncement: true,
    isBroadcast: true,
    read: false,
    createdAt: nowMs,
    timestamp: new Date().toISOString(),
    metadata: metadata || {}
  };

  // 1. Instantly dispatch to in-memory Student listeners & local student caches
  if (normalizedTargetRoles.some(r => ["student", "students", "all", "everyone"].includes(r))) {
    localStudentListeners.forEach((listeners, rollKey) => {
      const existing = getLocalStudentNotifs(rollKey);
      const updated = [payload, ...existing.filter(n => n.id !== payload.id && n.title !== payload.title)];
      saveLocalStudentNotifs(rollKey, updated);
      listeners.forEach(cb => { try { cb(updated); } catch (_) {} });
    });
    try {
      const existingAll = getLocalStudentNotifs("ALL");
      saveLocalStudentNotifs("ALL", [payload, ...existingAll]);
    } catch (_) {}
  }

  // 2. Instantly dispatch to in-memory Faculty/Admin listeners & local faculty caches
  if (normalizedTargetRoles.some(r => ["faculty", "lecturer", "admin", "all", "everyone", "professors"].includes(r))) {
    const existing = getLocalFacultyNotifs();
    const updated = [payload, ...existing.filter(n => n.id !== payload.id && n.title !== payload.title)];
    saveLocalFacultyNotifs(updated);
    localFacultyListeners.forEach(cb => { try { cb(updated); } catch (_) {} });
  }

  // 3. Ping cross-tab storage
  try {
    localStorage.setItem("smartattend_notifs_broadcast_ping", JSON.stringify({ id: payload.id, time: nowMs }));
  } catch (_) {}

  // 4. Dispatch to Firestore collections in parallel: broadcast_notifications, announcements, and notifications
  const writes = [
    addDoc(collection(db, "broadcast_notifications"), {
      ...payload,
      timestamp: serverTimestamp()
    }).catch(() => {}),
    addDoc(collection(db, "announcements"), {
      ...payload,
      timestamp: serverTimestamp()
    }).catch(() => {}),
    addDoc(collection(db, "notifications"), {
      ...payload,
      timestamp: serverTimestamp()
    }).catch(() => {})
  ];

  if (normalizedTargetRoles.some(r => ["faculty", "lecturer", "admin", "all", "everyone"].includes(r))) {
    writes.push(
      addDoc(collection(db, "faculty_notifications"), {
        ...payload,
        targetRole: normalizedTargetRoles.includes("admin") && !normalizedTargetRoles.includes("lecturer") ? "admin" : "faculty",
        timestamp: serverTimestamp()
      }).catch(() => {})
    );
  }

  await Promise.all(writes);
  return { success: true };
}

/**
 * Student requests Admin/Lecturer to reset their locked device
 */
export async function requestDeviceResetByStudent({
  studentRollNo,
  studentName = "",
  detectedPlatform = "",
  registeredDevice = "",
  reason = "Student requested device reset"
}) {
  if (!studentRollNo) return { success: false, error: "Missing roll number" };
  const cleanRoll = String(studentRollNo).trim().toUpperCase();

  try {
    // 1. Notify Admins and Lecturers with 1-click action metadata
    await sendFacultyNotification(
      `📱 Phone Reset Requested: ${cleanRoll}`,
      `Student ${studentName || cleanRoll} (${cleanRoll}) requested a phone registration reset.\n• Registered Device: ${registeredDevice || 'None'}\n• Detected Device: ${detectedPlatform || 'Unknown'}\n• Reason: ${reason}`,
      "DEVICE_RESET_REQUEST",
      cleanRoll,
      studentName || cleanRoll,
      {
        actionable: true,
        actionType: "RESET_DEVICE",
        studentRollNo: cleanRoll,
        detectedPlatform,
        registeredDevice,
        reason
      },
      "faculty"
    );

    // 2. Notify Student that request was queued
    await sendStudentNotification(
      cleanRoll,
      "📨 Phone Reset Request Sent",
      `Your request to change your phone has been sent to your teacher and administrator. You will receive an update here once it is approved.`,
      "DEVICE_RESET_PENDING",
      "System Support"
    );

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Admin or Lecturer approves student device reset directly from notification card
 */
export async function approveDeviceResetAction(studentRollNo, approvedByName = "Administrator", notificationId = null) {
  if (!studentRollNo) return { success: false, error: "Missing roll number" };
  const cleanRoll = String(studentRollNo).trim().toUpperCase();

  try {
    const studentDocRef = doc(db, "students", cleanRoll);
    await updateDoc(studentDocRef, {
      isDeviceRegistered: false,
      deviceFingerprint: null,
      registeredPlatform: null,
      registeredDevice: null,
      deviceType: null,
      deviceModel: null,
      deviceUUID: null,
      lastDeviceResetAt: serverTimestamp(),
      lastDeviceResetBy: approvedByName
    });

    // Notify Student
    await sendStudentNotification(
      cleanRoll,
      "✅ Phone Reset Approved",
      `Your phone registration was approved and reset by ${approvedByName}. You can now open your dashboard to set up your new phone.`,
      "DEVICE_RESET",
      approvedByName
    );

    // Audit Log for faculty
    await sendFacultyNotification(
      `⚡ Phone Reset Approved: ${cleanRoll}`,
      `Phone lock for student ${cleanRoll} was successfully reset by ${approvedByName}.`,
      "DEVICE_RESET_APPROVED",
      cleanRoll,
      approvedByName
    );

    // Mark notification read/resolved if ID provided
    if (notificationId) {
      await markFacultyNotificationAsRead(notificationId);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Subscribe to real-time notifications for a student
 * Listens across: students/{roll}/notifications, student_notifications/{roll}/notifications, broadcast_notifications, announcements, and notifications
 */
export function subscribeToStudentNotifications(studentRollNo, callback, studentEmail = "") {
  if (!studentRollNo && !studentEmail) return () => {};
  const cleanRoll = String(studentRollNo || studentEmail).trim().toUpperCase();
  const cleanEmail = String(studentEmail || "").trim().toLowerCase();
  const rollPrefix = cleanRoll.includes("@") ? cleanRoll.split("@")[0].trim().toUpperCase() : cleanRoll;
  const emailPrefix = cleanEmail.includes("@") ? cleanEmail.split("@")[0].trim().toUpperCase() : "";

  const allKeySet = new Set([cleanRoll, rollPrefix, cleanEmail, emailPrefix].filter(Boolean));
  const primaryKey = rollPrefix || cleanRoll;

  // Load persistent sets
  const readSet = getReadNotifIds(primaryKey);
  const deletedSet = getDeletedNotifIds(primaryKey);

  // Send initial local cache to callback immediately
  const initialCached = getLocalStudentNotifs(primaryKey)
    .filter(n => !deletedSet.has(n.id))
    .map(n => (readSet.has(n.id) ? { ...n, read: true } : n));
  callback(initialCached);

  // Register in-memory callback for all relevant roll aliases
  allKeySet.forEach(k => {
    if (!localStudentListeners.has(k)) {
      localStudentListeners.set(k, new Set());
    }
    localStudentListeners.get(k).add(callback);
  });

  let remoteStudentNotifs = [];
  let remoteBroadcastNotifs = [];
  let remoteAnnouncements = [];
  let remoteGlobalNotifs = [];

  const mergeAndEmit = () => {
    const currentReadSet = getReadNotifIds(primaryKey);
    const currentDeletedSet = getDeletedNotifIds(primaryKey);

    const all = [
      ...remoteStudentNotifs,
      ...remoteBroadcastNotifs,
      ...remoteAnnouncements,
      ...remoteGlobalNotifs
    ];
    const local = getLocalStudentNotifs(primaryKey);

    local.forEach(l => {
      if (!all.some(c => c.id === l.id || (c.title === l.title && Math.abs(getTimestampMs(c) - getTimestampMs(l)) < 4000))) {
        all.push(l);
      }
    });

    const combined = all
      .filter(n => !currentDeletedSet.has(n.id))
      .map(n => ({
        ...n,
        read: Boolean(n.read || currentReadSet.has(n.id))
      }))
      .sort((a, b) => {
        const timeA = getTimestampMs(a);
        const timeB = getTimestampMs(b);
        return timeB - timeA;
      });

    allKeySet.forEach(k => saveLocalStudentNotifs(k, combined));

    const listeners = localStudentListeners.get(primaryKey);
    if (listeners) {
      listeners.forEach(cb => {
        try { cb(combined); } catch (_) {}
      });
    }
  };

  const unsubs = [];

  // 1. Direct Student subcollection listeners (students/{k}/notifications and student_notifications/{k}/notifications)
  allKeySet.forEach(k => {
    try {
      const notifRef = collection(db, "students", k, "notifications");
      const unsub = onSnapshot(query(notifRef, limit(35)), (snapshot) => {
        const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        remoteStudentNotifs = [...remoteStudentNotifs.filter(r => !docs.some(d => d.id === r.id)), ...docs];
        mergeAndEmit();
      }, () => {});
      unsubs.push(unsub);
    } catch (_) {}

    try {
      const fbRef = collection(db, "student_notifications", k, "notifications");
      const unsub = onSnapshot(query(fbRef, limit(35)), (snapshot) => {
        const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        remoteStudentNotifs = [...remoteStudentNotifs.filter(r => !docs.some(d => d.id === r.id)), ...docs];
        mergeAndEmit();
      }, () => {});
      unsubs.push(unsub);
    } catch (_) {}
  });

  // 2. Broadcast notifications collection listener
  try {
    const broadcastRef = collection(db, "broadcast_notifications");
    const unsub = onSnapshot(query(broadcastRef, limit(60)), (snapshot) => {
      remoteBroadcastNotifs = snapshot.docs
        .map(d => ({
          id: d.id,
          ...d.data()
        }))
        .filter(n => {
          const rawRoles = n.targetRoles || n.targetRole || [];
          const roles = Array.isArray(rawRoles)
            ? rawRoles.map(r => String(r).toLowerCase().trim())
            : (rawRoles ? [String(rawRoles).toLowerCase().trim()] : []);
          if (roles.length === 0) return true;
          return roles.some(r => ["student", "students", "all", "everyone", ""].includes(r));
        });
      mergeAndEmit();
    }, () => {});
    unsubs.push(unsub);
  } catch (_) {}

  // 3. Announcements collection listener
  try {
    const announcementsRef = collection(db, "announcements");
    const unsub = onSnapshot(query(announcementsRef, limit(60)), (snapshot) => {
      remoteAnnouncements = snapshot.docs
        .map(d => ({
          id: d.id,
          ...d.data()
        }))
        .filter(n => {
          const rawRoles = n.targetRoles || n.targetRole || [];
          const roles = Array.isArray(rawRoles)
            ? rawRoles.map(r => String(r).toLowerCase().trim())
            : (rawRoles ? [String(rawRoles).toLowerCase().trim()] : []);
          if (roles.length === 0) return true;
          return roles.some(r => ["student", "students", "all", "everyone", ""].includes(r));
        });
      mergeAndEmit();
    }, () => {});
    unsubs.push(unsub);
  } catch (_) {}

  // 4. Global notifications collection listener
  try {
    const globalRef = collection(db, "notifications");
    const unsub = onSnapshot(query(globalRef, limit(60)), (snapshot) => {
      remoteGlobalNotifs = snapshot.docs
        .map(d => ({
          id: d.id,
          ...d.data()
        }))
        .filter(n => {
          const targetRoll = (n.studentRollNo || n.recipientRollNo || n.recipientRollPrefix || "").toUpperCase().trim();
          if (targetRoll && (targetRoll === cleanRoll || targetRoll === rollPrefix || targetRoll === emailPrefix || targetRoll === "ALL")) return true;
          const rawRoles = n.targetRoles || n.targetRole || [];
          const roles = Array.isArray(rawRoles)
            ? rawRoles.map(r => String(r).toLowerCase().trim())
            : (rawRoles ? [String(rawRoles).toLowerCase().trim()] : []);
          if (roles.length === 0) return true;
          return roles.some(r => ["student", "students", "all", "everyone", ""].includes(r));
        });
      mergeAndEmit();
    }, () => {});
    unsubs.push(unsub);
  } catch (_) {}

  return () => {
    allKeySet.forEach(k => {
      if (localStudentListeners.has(k)) {
        localStudentListeners.get(k).delete(callback);
      }
    });
    unsubs.forEach(u => {
      if (typeof u === "function") {
        try { u(); } catch (_) {}
      }
    });
  };
}

/**
 * Subscribe to real-time notifications for Lecturers & Admins
 */
export function subscribeToFacultyNotifications(callback, roleFilter = "faculty") {
  const readSet = getReadNotifIds("faculty");
  const deletedSet = getDeletedNotifIds("faculty");

  // Send initial local cache immediately
  const initialCached = getLocalFacultyNotifs()
    .filter(n => !deletedSet.has(n.id))
    .map(n => (readSet.has(n.id) ? { ...n, read: true } : n));

  let filteredLocal = initialCached;
  const filterRoleNorm = String(roleFilter).toLowerCase();

  const isRoleMatching = (n) => {
    const rawRoles = n.targetRoles || n.targetRole || [];
    const roles = Array.isArray(rawRoles)
      ? rawRoles.map(r => String(r).toLowerCase().trim())
      : (rawRoles ? [String(rawRoles).toLowerCase().trim()] : []);
    if (roles.length === 0) return true;
    if (filterRoleNorm === "admin") {
      return roles.some(r => ["admin", "admins", "faculty", "all", "everyone", ""].includes(r));
    } else {
      return roles.some(r => ["lecturer", "lecturers", "faculty", "professors", "all", "everyone", ""].includes(r));
    }
  };

  filteredLocal = initialCached.filter(isRoleMatching);
  callback(filteredLocal);

  localFacultyListeners.add(callback);

  let remoteFacultyNotifs = [];
  let remoteBroadcastNotifs = [];
  let remoteAnnouncements = [];
  let remoteGlobalNotifs = [];

  const mergeAndEmitFaculty = () => {
    const currentReadSet = getReadNotifIds("faculty");
    const currentDeletedSet = getDeletedNotifIds("faculty");

    const all = [
      ...remoteFacultyNotifs,
      ...remoteBroadcastNotifs,
      ...remoteAnnouncements,
      ...remoteGlobalNotifs
    ];
    const local = getLocalFacultyNotifs();

    local.forEach(l => {
      if (!all.some(c => c.id === l.id || (c.title === l.title && Math.abs(getTimestampMs(c) - getTimestampMs(l)) < 4000))) {
        all.push(l);
      }
    });

    const combined = all
      .filter(n => !currentDeletedSet.has(n.id))
      .map(n => ({
        ...n,
        read: Boolean(n.read || currentReadSet.has(n.id))
      }))
      .sort((a, b) => {
        const timeA = getTimestampMs(a);
        const timeB = getTimestampMs(b);
        return timeB - timeA;
      });

    saveLocalFacultyNotifs(combined);

    localFacultyListeners.forEach(cb => {
      const filtered = combined.filter(isRoleMatching);
      try { cb(filtered); } catch (_) {}
    });
  };

  const unsubs = [];

  // 1. Faculty Notifications collection
  try {
    const facultyNotifRef = collection(db, "faculty_notifications");
    const unsub = onSnapshot(query(facultyNotifRef, limit(60)), (snapshot) => {
      remoteFacultyNotifs = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      mergeAndEmitFaculty();
    }, () => {});
    unsubs.push(unsub);
  } catch (_) {}

  // 2. Broadcast Notifications collection
  try {
    const broadcastRef = collection(db, "broadcast_notifications");
    const unsub = onSnapshot(query(broadcastRef, limit(60)), (snapshot) => {
      remoteBroadcastNotifs = snapshot.docs
        .map(d => ({
          id: d.id,
          ...d.data()
        }))
        .filter(isRoleMatching);
      mergeAndEmitFaculty();
    }, () => {});
    unsubs.push(unsub);
  } catch (_) {}

  // 3. Announcements collection
  try {
    const announcementsRef = collection(db, "announcements");
    const unsub = onSnapshot(query(announcementsRef, limit(60)), (snapshot) => {
      remoteAnnouncements = snapshot.docs
        .map(d => ({
          id: d.id,
          ...d.data()
        }))
        .filter(isRoleMatching);
      mergeAndEmitFaculty();
    }, () => {});
    unsubs.push(unsub);
  } catch (_) {}

  // 4. Global Notifications collection
  try {
    const globalRef = collection(db, "notifications");
    const unsub = onSnapshot(query(globalRef, limit(60)), (snapshot) => {
      remoteGlobalNotifs = snapshot.docs
        .map(d => ({
          id: d.id,
          ...d.data()
        }))
        .filter(isRoleMatching);
      mergeAndEmitFaculty();
    }, () => {});
    unsubs.push(unsub);
  } catch (_) {}

  return () => {
    localFacultyListeners.delete(callback);
    unsubs.forEach(u => {
      if (typeof u === "function") {
        try { u(); } catch (_) {}
      }
    });
  };
}

/**
 * Mark a student notification as read
 */
export async function markNotificationAsRead(studentRollNo, notificationId) {
  if (!notificationId) return;
  const cleanRoll = studentRollNo ? String(studentRollNo).trim().toUpperCase() : "STUDENT";
  const rollPrefix = cleanRoll.includes("@") ? cleanRoll.split("@")[0].trim().toUpperCase() : cleanRoll;

  // 1. Update persistent read set
  const readSet = getReadNotifIds(cleanRoll);
  readSet.add(notificationId);
  saveReadNotifIds(cleanRoll, readSet);

  if (rollPrefix && rollPrefix !== cleanRoll) {
    const prefixSet = getReadNotifIds(rollPrefix);
    prefixSet.add(notificationId);
    saveReadNotifIds(rollPrefix, prefixSet);
  }

  // 2. Update local caches
  [cleanRoll, rollPrefix].forEach(r => {
    if (!r) return;
    const local = getLocalStudentNotifs(r);
    const updated = local.map(n => n.id === notificationId ? { ...n, read: true } : n);
    saveLocalStudentNotifs(r, updated);

    const listeners = localStudentListeners.get(r);
    if (listeners) {
      listeners.forEach(cb => { try { cb(updated); } catch (_) {} });
    }
  });

  // 3. Attempt Firestore doc updates
  if (studentRollNo && !notificationId.startsWith("loc_")) {
    const updates = [
      updateDoc(doc(db, "students", cleanRoll, "notifications", notificationId), { read: true, readAt: Date.now() }).catch(() => {}),
      updateDoc(doc(db, "student_notifications", cleanRoll, "notifications", notificationId), { read: true, readAt: Date.now() }).catch(() => {}),
      updateDoc(doc(db, "notifications", notificationId), { read: true, readAt: Date.now() }).catch(() => {})
    ];
    if (rollPrefix && rollPrefix !== cleanRoll) {
      updates.push(
        updateDoc(doc(db, "students", rollPrefix, "notifications", notificationId), { read: true, readAt: Date.now() }).catch(() => {})
      );
    }
    await Promise.all(updates);
  }
}

/**
 * Mark all student notifications as read
 */
export async function markAllStudentNotificationsRead(studentRollNo, notifIds = []) {
  const cleanRoll = studentRollNo ? String(studentRollNo).trim().toUpperCase() : "STUDENT";
  const rollPrefix = cleanRoll.includes("@") ? cleanRoll.split("@")[0].trim().toUpperCase() : cleanRoll;

  const readSet = getReadNotifIds(cleanRoll);
  notifIds.forEach(id => { if (id) readSet.add(id); });
  saveReadNotifIds(cleanRoll, readSet);

  if (rollPrefix && rollPrefix !== cleanRoll) {
    const prefixSet = getReadNotifIds(rollPrefix);
    notifIds.forEach(id => { if (id) prefixSet.add(id); });
    saveReadNotifIds(rollPrefix, prefixSet);
  }

  [cleanRoll, rollPrefix].forEach(r => {
    if (!r) return;
    const local = getLocalStudentNotifs(r);
    const updated = local.map(n => ({ ...n, read: true }));
    saveLocalStudentNotifs(r, updated);

    const listeners = localStudentListeners.get(r);
    if (listeners) {
      listeners.forEach(cb => { try { cb(updated); } catch (_) {} });
    }
  });

  if (studentRollNo) {
    for (const id of notifIds) {
      if (!id || id.startsWith("loc_")) continue;
      updateDoc(doc(db, "students", cleanRoll, "notifications", id), { read: true, readAt: Date.now() }).catch(() => {});
      updateDoc(doc(db, "notifications", id), { read: true, readAt: Date.now() }).catch(() => {});
    }
  }
}

/**
 * Mark a faculty notification as read
 */
export async function markFacultyNotificationAsRead(notificationId) {
  if (!notificationId) return;

  const readSet = getReadNotifIds("faculty");
  readSet.add(notificationId);
  saveReadNotifIds("faculty", readSet);

  const local = getLocalFacultyNotifs();
  const updated = local.map(n => n.id === notificationId ? { ...n, read: true } : n);
  saveLocalFacultyNotifs(updated);

  localFacultyListeners.forEach(cb => { try { cb(updated); } catch (_) {} });

  if (!notificationId.startsWith("loc_")) {
    updateDoc(doc(db, "faculty_notifications", notificationId), { read: true, readAt: Date.now() }).catch(() => {});
    updateDoc(doc(db, "notifications", notificationId), { read: true, readAt: Date.now() }).catch(() => {});
  }
}

/**
 * Mark all faculty notifications as read
 */
export async function markAllFacultyNotificationsRead(notifIds = []) {
  const readSet = getReadNotifIds("faculty");
  notifIds.forEach(id => { if (id) readSet.add(id); });
  saveReadNotifIds("faculty", readSet);

  const local = getLocalFacultyNotifs();
  const updated = local.map(n => ({ ...n, read: true }));
  saveLocalFacultyNotifs(updated);

  localFacultyListeners.forEach(cb => { try { cb(updated); } catch (_) {} });

  for (const id of notifIds) {
    if (!id || id.startsWith("loc_")) continue;
    updateDoc(doc(db, "faculty_notifications", id), { read: true, readAt: Date.now() }).catch(() => {});
    updateDoc(doc(db, "notifications", id), { read: true, readAt: Date.now() }).catch(() => {});
  }
}

/**
 * Delete a faculty notification
 */
export async function deleteFacultyNotification(notificationId) {
  if (!notificationId) return;

  const deletedSet = getDeletedNotifIds("faculty");
  deletedSet.add(notificationId);
  saveDeletedNotifIds("faculty", deletedSet);

  const local = getLocalFacultyNotifs();
  const updated = local.filter(n => n.id !== notificationId);
  saveLocalFacultyNotifs(updated);

  localFacultyListeners.forEach(cb => { try { cb(updated); } catch (_) {} });

  if (!notificationId.startsWith("loc_")) {
    deleteDoc(doc(db, "faculty_notifications", notificationId)).catch(() => {});
    deleteDoc(doc(db, "notifications", notificationId)).catch(() => {});
  }
}

/**
 * Delete a student notification
 */
export async function deleteStudentNotification(studentRollNo, notificationId) {
  if (!notificationId) return;
  const cleanRoll = studentRollNo ? String(studentRollNo).trim().toUpperCase() : "STUDENT";
  const rollPrefix = cleanRoll.includes("@") ? cleanRoll.split("@")[0].trim().toUpperCase() : cleanRoll;

  const deletedSet = getDeletedNotifIds(cleanRoll);
  deletedSet.add(notificationId);
  saveDeletedNotifIds(cleanRoll, deletedSet);

  if (rollPrefix && rollPrefix !== cleanRoll) {
    const prefixSet = getDeletedNotifIds(rollPrefix);
    prefixSet.add(notificationId);
    saveDeletedNotifIds(rollPrefix, prefixSet);
  }

  [cleanRoll, rollPrefix].forEach(r => {
    if (!r) return;
    const local = getLocalStudentNotifs(r);
    const updated = local.filter(n => n.id !== notificationId);
    saveLocalStudentNotifs(r, updated);

    const listeners = localStudentListeners.get(r);
    if (listeners) {
      listeners.forEach(cb => { try { cb(updated); } catch (_) {} });
    }
  });

  if (studentRollNo && !notificationId.startsWith("loc_")) {
    deleteDoc(doc(db, "students", cleanRoll, "notifications", notificationId)).catch(() => {});
    deleteDoc(doc(db, "student_notifications", cleanRoll, "notifications", notificationId)).catch(() => {});
    deleteDoc(doc(db, "notifications", notificationId)).catch(() => {});
  }
}

/**
 * Log a user verification complaint and dispatch alerts to Admins & Lecturers
 */
export async function reportUserVerificationComplaint(userDetails = {}, errorReason = "User verification failed", contextName = "SYSTEM_CHECK") {
  const email = (userDetails.email || userDetails.studentEmail || "").toLowerCase().trim();
  const rollNo = (userDetails.rollNo || userDetails.rollNumber || (email ? email.split("@")[0] : "UNKNOWN")).toUpperCase().trim();
  const userName = userDetails.name || userDetails.displayName || userDetails.studentName || rollNo;

  try {
    const complaintRef = collection(db, "security_complaints");
    const complaintData = {
      rollNo: rollNo,
      email: email,
      userName: userName,
      reason: errorReason,
      context: contextName,
      status: "OPEN_COMPLAINT",
      severity: "HIGH",
      reportedAt: Date.now(),
      timestamp: serverTimestamp()
    };

    await addDoc(complaintRef, complaintData);
  } catch (_) {}

  // Dispatch real-time alert to all Admins and Lecturers
  await sendFacultyNotification(
    `🚨 Security Alert: ${rollNo}`,
    `User verification alert for ${userName} (${rollNo}).\nReason: ${errorReason}\nContext: ${contextName}`,
    "USER_VERIFICATION_FAILURE",
    rollNo,
    "Security Guard",
    {
      rollNo,
      email,
      reason: errorReason,
      context: contextName
    },
    "faculty"
  );

  // Also notify student if valid roll exists
  if (rollNo && rollNo !== "UNKNOWN") {
    await sendStudentNotification(
      rollNo,
      "⚠️ Security Alert",
      `A security issue was detected with your recent attempt (${errorReason}). An alert has been shared with your teachers and administrators.`,
      "SECURITY_ALERT",
      "Security Guard",
      {
        reason: errorReason,
        context: contextName
      }
    );
  }

  return { success: true };
}
