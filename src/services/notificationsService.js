import { db } from "../firebase";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp
} from "firebase/firestore";

// In-Memory Subscriber Dispatchers for Local Fallback Events
const localStudentListeners = new Map();
const localFacultyListeners = new Set();

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
    localStorage.setItem(`smartattend_notifs_student_${rollNo}`, JSON.stringify(list.slice(0, 30)));
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
    localStorage.setItem('smartattend_notifs_faculty', JSON.stringify(list.slice(0, 40)));
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
    // Audio autoplay restrictions or headless environment
  }
}

/**
 * Send real-time notification to a specific student document
 * @param {string} studentRollNo - Target student roll number
 * @param {string} title - Notification title
 * @param {string} message - Notification details message
 * @param {string} type - Notification category type
 * @param {string} senderName - Name of Lecturer or Admin who made the change
 * @param {Object} metadata - Optional extra payload (courseId, sessionId, ip, etc.)
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

  const notifPayload = {
    id: "loc_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
    recipientRollNo: cleanRoll,
    recipientRole: "student",
    title: title,
    message: message,
    type: type,
    senderName: senderName,
    read: false,
    createdAt: Date.now(),
    timestamp: new Date().toISOString(),
    metadata: metadata || {}
  };

  // 1. Always update local storage cache for instant UI feedback
  const existing = getLocalStudentNotifs(cleanRoll);
  const updated = [notifPayload, ...existing.filter(n => n.title !== title || Date.now() - n.createdAt > 3000)];
  saveLocalStudentNotifs(cleanRoll, updated);

  const listeners = localStudentListeners.get(cleanRoll);
  if (listeners) {
    listeners.forEach(cb => {
      try { cb(updated); } catch (_) {}
    });
  }

  // 2. Dispatch to Firestore
  try {
    const notifRef = collection(db, "students", cleanRoll, "notifications");
    await addDoc(notifRef, {
      ...notifPayload,
      timestamp: serverTimestamp()
    });
  } catch (err) {
    try {
      const fallbackRef = collection(db, "student_notifications", cleanRoll, "notifications");
      await addDoc(fallbackRef, {
        ...notifPayload,
        timestamp: serverTimestamp()
      });
    } catch (_) {
      // Local cache already preserved above
    }
  }
}

/**
 * Send real-time audit & activity notification to Lecturers & Admins
 * @param {string} title - Alert title
 * @param {string} message - Notification message
 * @param {string} type - Notification category type
 * @param {string} studentRollNo - Optional relevant student roll number
 * @param {string} senderName - Sender name or role
 * @param {Object} metadata - Optional metadata (actionable, courseId, ip, platform, etc.)
 * @param {string} targetRole - 'faculty' | 'admin' | 'lecturer' | 'all'
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
  const notifPayload = {
    id: "loc_fac_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
    title: title,
    message: message,
    type: type,
    targetRole: targetRole,
    studentRollNo: studentRollNo ? String(studentRollNo).trim().toUpperCase() : "",
    senderName: senderName,
    read: false,
    createdAt: Date.now(),
    timestamp: new Date().toISOString(),
    metadata: metadata || {}
  };

  // 1. Update local storage cache for instant feedback
  const existing = getLocalFacultyNotifs();
  const updated = [notifPayload, ...existing.filter(n => n.title !== title || Date.now() - n.createdAt > 3000)];
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
  } catch (_) {
    // Local cache already preserved above
  }
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
 * Broadcast an announcement or critical notice to Students, Lecturers, and/or Admins
 * @param {Object} options - { targetRoles: ['student', 'lecturer', 'admin'], title, message, type, senderName, senderRole, metadata }
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
  try {
    const broadcastRef = collection(db, "broadcast_notifications");
    await addDoc(broadcastRef, {
      title,
      message,
      type,
      targetRoles,
      senderName,
      senderRole,
      createdAt: Date.now(),
      timestamp: serverTimestamp(),
      metadata: metadata || {}
    });
  } catch (_) {}

  // Also log to faculty feed if target includes faculty/admin
  if (targetRoles.includes("admin") || targetRoles.includes("lecturer")) {
    const targetRole = targetRoles.includes("admin") && !targetRoles.includes("lecturer")
      ? "admin"
      : !targetRoles.includes("admin") && targetRoles.includes("lecturer")
      ? "lecturer"
      : "faculty";

    await sendFacultyNotification(
      `📢 ${title}`,
      message,
      type,
      "",
      senderName,
      metadata,
      targetRole
    );
  }

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
      `📱 Device Reset Requested: ${cleanRoll}`,
      `Student ${studentName || cleanRoll} (${cleanRoll}) requested a device reset.\nRegistered Platform: ${registeredDevice || 'None'}\nDetected Device: ${detectedPlatform || 'Unknown'}\nReason: ${reason}`,
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
      "📨 Device Reset Request Sent",
      `Your request to reset your device lock has been submitted to Administrators and Lecturers.\nYou will receive a confirmation alert once approved.`,
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
      "✅ Device Lock Reset Approved",
      `Your registered device lock has been approved and cleared by ${approvedByName}.\nPlease open SmartAttend on your current device to complete setup.`,
      "DEVICE_RESET",
      approvedByName
    );

    // Audit Log for faculty
    await sendFacultyNotification(
      `⚡ Device Reset Approved: ${cleanRoll}`,
      `Device lock for student ${cleanRoll} was successfully reset by ${approvedByName}.`,
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
 */
export function subscribeToStudentNotifications(studentRollNo, callback) {
  if (!studentRollNo) return () => {};
  const cleanRoll = String(studentRollNo).trim().toUpperCase();

  // Send initial local cache to callback immediately
  const cached = getLocalStudentNotifs(cleanRoll);
  callback(cached);

  // Register in-memory callback
  if (!localStudentListeners.has(cleanRoll)) {
    localStudentListeners.set(cleanRoll, new Set());
  }
  const set = localStudentListeners.get(cleanRoll);
  set.add(callback);

  try {
    const notifRef = collection(db, "students", cleanRoll, "notifications");
    const q = query(notifRef, orderBy("createdAt", "desc"), limit(25));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const notifs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      // Merge remote and local notifications without duplicates
      const local = getLocalStudentNotifs(cleanRoll);
      const combined = [...notifs];
      local.forEach(l => {
        if (!combined.some(c => c.id === l.id || (c.title === l.title && Math.abs((c.createdAt || 0) - (l.createdAt || 0)) < 4000))) {
          combined.push(l);
        }
      });
      combined.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      saveLocalStudentNotifs(cleanRoll, combined);
      callback(combined);
    }, () => {
      // Graceful fallback to local cache on permission restriction
      callback(getLocalStudentNotifs(cleanRoll));
    });

    return () => {
      set.delete(callback);
      if (typeof unsubscribe === "function") unsubscribe();
    };
  } catch (_) {
    return () => { set.delete(callback); };
  }
}

/**
 * Subscribe to real-time notifications for Lecturers & Admins
 */
export function subscribeToFacultyNotifications(callback, roleFilter = "faculty") {
  // Send initial local cache immediately
  const cached = getLocalFacultyNotifs();
  let filteredLocal = cached;
  if (roleFilter === "admin") {
    filteredLocal = cached.filter(n => !n.targetRole || n.targetRole === "admin" || n.targetRole === "faculty" || n.targetRole === "all");
  } else if (roleFilter === "lecturer") {
    filteredLocal = cached.filter(n => !n.targetRole || n.targetRole === "lecturer" || n.targetRole === "faculty" || n.targetRole === "all");
  }
  callback(filteredLocal);

  localFacultyListeners.add(callback);

  try {
    const facultyNotifRef = collection(db, "faculty_notifications");
    const q = query(facultyNotifRef, orderBy("createdAt", "desc"), limit(35));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const allNotifs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      // Merge remote and local without duplicates
      const local = getLocalFacultyNotifs();
      const combined = [...allNotifs];
      local.forEach(l => {
        if (!combined.some(c => c.id === l.id || (c.title === l.title && Math.abs((c.createdAt || 0) - (l.createdAt || 0)) < 4000))) {
          combined.push(l);
        }
      });
      combined.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      saveLocalFacultyNotifs(combined);

      let filtered = combined;
      if (roleFilter === "admin") {
        filtered = combined.filter(n => !n.targetRole || n.targetRole === "admin" || n.targetRole === "faculty" || n.targetRole === "all");
      } else if (roleFilter === "lecturer") {
        filtered = combined.filter(n => !n.targetRole || n.targetRole === "lecturer" || n.targetRole === "faculty" || n.targetRole === "all");
      }

      callback(filtered);
    }, () => {
      // Graceful fallback to local cache
      callback(filteredLocal);
    });

    return () => {
      localFacultyListeners.delete(callback);
      if (typeof unsubscribe === "function") unsubscribe();
    };
  } catch (_) {
    return () => { localFacultyListeners.delete(callback); };
  }
}

/**
 * Mark a student notification as read
 */
export async function markNotificationAsRead(studentRollNo, notificationId) {
  if (!studentRollNo || !notificationId) return;
  const cleanRoll = String(studentRollNo).trim().toUpperCase();

  // Update local cache
  const local = getLocalStudentNotifs(cleanRoll);
  const updated = local.map(n => n.id === notificationId ? { ...n, read: true } : n);
  saveLocalStudentNotifs(cleanRoll, updated);

  try {
    const notifDocRef = doc(db, "students", cleanRoll, "notifications", notificationId);
    await updateDoc(notifDocRef, {
      read: true,
      readAt: Date.now()
    });
  } catch (_) {}
}

/**
 * Mark a faculty notification as read
 */
export async function markFacultyNotificationAsRead(notificationId) {
  if (!notificationId) return;

  // Update local cache
  const local = getLocalFacultyNotifs();
  const updated = local.map(n => n.id === notificationId ? { ...n, read: true } : n);
  saveLocalFacultyNotifs(updated);

  try {
    const notifDocRef = doc(db, "faculty_notifications", notificationId);
    await updateDoc(notifDocRef, {
      read: true,
      readAt: Date.now()
    });
  } catch (_) {}
}

/**
 * Delete a faculty notification
 */
export async function deleteFacultyNotification(notificationId) {
  if (!notificationId) return;

  const local = getLocalFacultyNotifs();
  const updated = local.filter(n => n.id !== notificationId);
  saveLocalFacultyNotifs(updated);

  try {
    const notifDocRef = doc(db, "faculty_notifications", notificationId);
    await deleteDoc(notifDocRef);
  } catch (_) {}
}

/**
 * Delete a student notification
 */
export async function deleteStudentNotification(studentRollNo, notificationId) {
  if (!studentRollNo || !notificationId) return;
  const cleanRoll = String(studentRollNo).trim().toUpperCase();

  const local = getLocalStudentNotifs(cleanRoll);
  const updated = local.filter(n => n.id !== notificationId);
  saveLocalStudentNotifs(cleanRoll, updated);

  try {
    const notifDocRef = doc(db, "students", cleanRoll, "notifications", notificationId);
    await deleteDoc(notifDocRef);
  } catch (_) {}
}

/**
 * Log a user verification complaint and dispatch high-priority alerts to Admins & Lecturers
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
    `User verification failed for ${userName} (${rollNo}).\nReason: ${errorReason}\nContext: ${contextName}\nLogged for Admin & Lecturer audit.`,
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
      "⚠️ User Verification Alert",
      `Verification Warning: Your attempt was flagged by security.\nReason: ${errorReason}\nContext: ${contextName}\nAn incident report has been sent to your Course Lecturer & Administrator for review.`,
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
