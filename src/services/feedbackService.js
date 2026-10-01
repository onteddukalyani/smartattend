import { db } from "../firebase";
import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  limit,
  serverTimestamp
} from "firebase/firestore";
import {
  sendFacultyNotification,
  sendStudentNotification
} from "./notificationsService";
import { getDeviceFingerprint } from "../utils/deviceDetection";

const LOCAL_STORAGE_KEY = "smartattend_support_tickets_v1";

/**
 * Helper: Retrieve local cached tickets
 */
export function getLocalTickets() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

/**
 * Helper: Save tickets to local cache
 */
export function saveLocalTickets(tickets) {
  try {
    if (Array.isArray(tickets)) {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(tickets.slice(0, 150)));
    }
  } catch (_) { }
}

/**
 * Generate a unique human-friendly Ticket ID e.g. "TKT-84920"
 */
export function generateTicketId(prefix = "TKT") {
  const randomNum = Math.floor(10000 + Math.random() * 90000);
  return `${prefix}-${randomNum}`;
}

/**
 * Pre-defined Institutional Helpdesk Contacts with safe fallbacks
 */
export const SUPPORT_CONTACTS = {
  institutionName: "SmartAttend Campus Tech Support",
  officeLocation: "CS & IT Block, Tech Support Desk (Room 204)",
  email: "support@smartattend.campus.edu",
  adminEmail: "admin@smartattend.campus.edu",
  hours: "Monday – Saturday, 8:30 AM – 6:00 PM IST",
  helpline: "+91 98765 43210",
  urgentHelpline: "+91 98765 43211 (Active Class Grievance Desk)"
};

/**
 * Pre-defined Frequently Asked Questions (FAQs)
 */
export const FREQUENT_QUESTIONS = [
  {
    id: "faq-qr",
    category: "QR & Scanning",
    question: "Why does my camera show a black screen or fail to scan the QR code?",
    answer: "Ensure camera permissions are enabled in your browser/device settings. Make sure you are within the session radius and your device is properly focused on the screen. If issues persist, try reloading or switching to the Native Android APK."
  },
  {
    id: "faq-device-lock",
    category: "Device Security",
    question: "I see 'Device Mismatch' or 'Guided Access Required' error. What should I do?",
    answer: "SmartAttend locks your account to your registered device for proxy-free attendance. If you switched phones or reset your browser, go to Settings > Device Security & Setup or submit an issue ticket to request an admin device unlock."
  },
  {
    id: "faq-face",
    category: "Face Recognition",
    question: "My face verification failed during attendance. Will my attendance be recorded?",
    answer: "Face verification requires adequate lighting and looking straight at the camera. If it repeatedly fails, you can re-enroll your biometric template in 'Face Registration' or ask your lecturer for manual attendance verification."
  },
  {
    id: "faq-courses",
    category: "Courses & Timetable",
    question: "Why am I not seeing my current semester courses?",
    answer: "Ensure your enrolled semester is updated correctly in Settings > Academic Semester. Courses for your branch and current semester will automatically synchronize on your dashboard."
  },
  {
    id: "faq-notifications",
    category: "Notifications",
    question: "How do I check if my issue was reviewed by the administrators?",
    answer: "Whenever an admin or faculty reviews your ticket, you will receive an in-app notification with their reply and resolution status. You can also view live ticket statuses under the 'My Submissions' tab."
  },
  {
    id: "faq-offline",
    category: "Connectivity",
    question: "What happens if I lose Wi-Fi or mobile network during attendance?",
    answer: "SmartAttend features offline caching. If your attendance was scanned, the app retains your token locally and synchronizes as soon as connectivity is restored."
  }
];

/**
 * Submit a new Feedback or Issue Ticket
 */
export async function submitSupportTicket(ticketPayload) {
  const now = Date.now();
  const ticketType = ticketPayload.type || "feedback";
  const defaultPrefix = ticketType === "issue" ? "BUG" : ticketType === "inquiry" ? "INQ" : "TKT";
  const ticketId = ticketPayload.id || generateTicketId(defaultPrefix);

  // Gather device fingerprint automatically
  let deviceSpecs = {};
  try {
    deviceSpecs = await getDeviceFingerprint();
  } catch (_) {
    deviceSpecs = {
      deviceType: "web",
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown"
    };
  }

  const cleanEmail = (ticketPayload.submittedBy?.email || "").toLowerCase().trim();
  const cleanRoll = (ticketPayload.submittedBy?.rollNo || "").toUpperCase().trim();
  const userName = ticketPayload.submittedBy?.name || cleanRoll || cleanEmail || "User";
  const role = ticketPayload.submittedBy?.role || "student";

  const fullTicket = {
    id: ticketId,
    ticketId: ticketId,
    type: ticketType, // "feedback", "issue", "inquiry", "suggestion"
    category: ticketPayload.category || "General Experience",
    title: (ticketPayload.title || "").trim() || (ticketType === "issue" ? "Reported Issue" : "User Feedback"),
    description: (ticketPayload.description || "").trim(),
    priority: ticketPayload.priority || "medium", // "low", "medium", "high", "urgent"
    rating: Number(ticketPayload.rating) || 0, // 1 - 5 for feedback
    sentiment: ticketPayload.sentiment || null,
    tags: Array.isArray(ticketPayload.tags) ? ticketPayload.tags : [],
    attachmentUrl: ticketPayload.attachmentUrl || null, // Base64 or Image URL
    deviceSpecs: {
      ...deviceSpecs,
      ...(ticketPayload.deviceSpecsOverride || {})
    },
    status: "open", // "open", "in_progress", "resolved", "closed"
    adminResponse: "",
    resolvedAt: null,
    resolvedBy: null,
    submittedBy: {
      uid: ticketPayload.submittedBy?.uid || null,
      name: userName,
      email: cleanEmail,
      rollNo: cleanRoll,
      role: role,
      department: ticketPayload.submittedBy?.department || ""
    },
    createdAt: now,
    updatedAt: now
  };

  // 1. Save to local storage for instant responsiveness & offline resilience
  const existingLocal = getLocalTickets();
  const updatedLocal = [fullTicket, ...existingLocal.filter(t => t.id !== ticketId)];
  saveLocalTickets(updatedLocal);

  // 2. Persist to Firestore with graceful error handling
  try {
    const docRef = doc(db, "support_tickets", ticketId);
    await setDoc(docRef, {
      ...fullTicket,
      timestamp: serverTimestamp()
    });
  } catch (err) {
    // Firestore rules might be denied or offline, cached locally
    console.debug?.("[feedbackService] Firestore save notice (cached locally):", err?.message || err);
  }

  // 3. Trigger Real-Time Notification to Admins / Faculty
  try {
    const isUrgent = fullTicket.priority === "urgent" || fullTicket.priority === "high";
    const notifTitle = isUrgent
      ? `🚨 [${fullTicket.priority.toUpperCase()}] New ${fullTicket.type === "issue" ? "Issue Reported" : "Ticket"}: ${ticketId}`
      : `📩 New ${fullTicket.type === "issue" ? "Issue" : "Feedback"} from ${userName}`;

    const notifMessage = `${fullTicket.title}\nCategory: ${fullTicket.category} | From: ${userName} (${role.toUpperCase()})\n"${fullTicket.description.slice(0, 140)}${fullTicket.description.length > 140 ? "..." : ""}"`;

    await sendFacultyNotification(
      notifTitle,
      notifMessage,
      fullTicket.type === "issue" ? "SECURITY_ALERT" : "GENERAL",
      ticketId,
      userName,
      {
        ticketId,
        type: fullTicket.type,
        category: fullTicket.category,
        priority: fullTicket.priority,
        submittedBy: fullTicket.submittedBy
      },
      "admin"
    );
  } catch (_) { }

  // 4. Send confirmation notification to student
  if (role === "student" && (cleanRoll || cleanEmail)) {
    try {
      const recipientRoll = cleanRoll || cleanEmail.split("@")[0].toUpperCase();
      await sendStudentNotification(
        recipientRoll,
        `✅ Ticket Submitted #${ticketId}`,
        `We've received your ${fullTicket.type === "issue" ? "issue report" : "feedback"} regarding "${fullTicket.title}". Our support team will look into it promptly.`,
        "SYSTEM_INFO",
        "Support Team",
        {
          ticketId,
          type: fullTicket.type,
          status: "open"
        }
      );
    } catch (_) { }
  }

  return { success: true, ticket: fullTicket };
}

/**
 * Subscribe to tickets submitted by a specific user (Student / Lecturer)
 */
export function subscribeToMyTickets(userIdentifier, callback) {
  if (!userIdentifier || typeof callback !== "function") return () => { };

  const cleanId = String(userIdentifier).trim().toLowerCase();
  const cleanRoll = cleanId.toUpperCase();

  const getFilteredLocal = () => {
    const local = getLocalTickets();
    return local.filter(t => {
      const sub = t.submittedBy || {};
      const matchEmail = (sub.email || "").toLowerCase() === cleanId;
      const matchRoll = (sub.rollNo || "").toUpperCase() === cleanRoll;
      const matchUid = sub.uid === userIdentifier;
      return matchEmail || matchRoll || matchUid;
    });
  };

  // Immediate trigger with local cache
  callback(getFilteredLocal());

  try {
    const ticketsRef = collection(db, "support_tickets");
    const q = query(ticketsRef, limit(60));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        try {
          const firestoreTickets = [];
          snapshot.forEach(docSnap => {
            const data = docSnap.data();
            const sub = data.submittedBy || {};
            const matchEmail = (sub.email || "").toLowerCase() === cleanId;
            const matchRoll = (sub.rollNo || "").toUpperCase() === cleanRoll;
            const matchUid = sub.uid === userIdentifier;

            if (matchEmail || matchRoll || matchUid) {
              firestoreTickets.push({
                id: docSnap.id,
                ...data
              });
            }
          });

          // Merge firestore with local
          const local = getFilteredLocal();
          const map = new Map();
          firestoreTickets.forEach(t => map.set(t.id, t));
          local.forEach(t => {
            if (!map.has(t.id)) map.set(t.id, t);
          });

          const merged = Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          callback(merged);
        } catch (_) {
          callback(getFilteredLocal());
        }
      },
      (err) => {
        // Handle permission denied or network errors silently by keeping local data intact
        callback(getFilteredLocal());
      }
    );

    return unsubscribe;
  } catch (_) {
    return () => { };
  }
}

/**
 * Subscribe to all tickets for Admin Support Desk
 */
export function subscribeToAllTickets(callback) {
  if (typeof callback !== "function") return () => { };

  // Immediate trigger with local cache
  callback(getLocalTickets());

  try {
    const ticketsRef = collection(db, "support_tickets");
    const q = query(ticketsRef, limit(100));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        try {
          const firestoreTickets = [];
          snapshot.forEach(docSnap => {
            firestoreTickets.push({
              id: docSnap.id,
              ...docSnap.data()
            });
          });

          // Merge with local
          const local = getLocalTickets();
          const map = new Map();
          firestoreTickets.forEach(t => map.set(t.id, t));
          local.forEach(t => {
            if (!map.has(t.id)) map.set(t.id, t);
          });

          const merged = Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          saveLocalTickets(merged);
          callback(merged);
        } catch (_) {
          callback(getLocalTickets());
        }
      },
      (err) => {
        callback(getLocalTickets());
      }
    );

    return unsubscribe;
  } catch (_) {
    return () => { };
  }
}

/**
 * Update ticket status, admin reply, or resolution notes
 */
export async function updateTicketStatus(ticketId, updateData = {}) {
  if (!ticketId) return { success: false, error: "Missing ticketId" };

  const now = Date.now();
  const updates = {
    status: updateData.status || "in_progress",
    adminResponse: (updateData.adminResponse || "").trim(),
    resolvedBy: updateData.resolvedBy || "Administrator",
    updatedAt: now
  };

  if (updates.status === "resolved" || updates.status === "closed") {
    updates.resolvedAt = now;
  }

  // 1. Update local storage
  const local = getLocalTickets();
  const index = local.findIndex(t => t.id === ticketId);
  let targetTicket = null;
  if (index !== -1) {
    local[index] = { ...local[index], ...updates };
    targetTicket = local[index];
    saveLocalTickets(local);
  }

  // 2. Update Firestore
  try {
    const docRef = doc(db, "support_tickets", ticketId);
    await updateDoc(docRef, {
      ...updates,
      timestamp: serverTimestamp()
    });
  } catch (_) { }

  // 3. Dispatch real-time notification to the original submitter
  if (targetTicket && targetTicket.submittedBy) {
    const sub = targetTicket.submittedBy;
    const cleanRoll = (sub.rollNo || "").toUpperCase().trim();
    const cleanEmail = (sub.email || "").toLowerCase().trim();

    if (sub.role === "student" && (cleanRoll || cleanEmail)) {
      const recipient = cleanRoll || cleanEmail.split("@")[0].toUpperCase();
      const statusTitle = updates.status === "resolved"
        ? `🎉 Ticket #${ticketId} Resolved!`
        : `💬 Update on Ticket #${ticketId}`;

      const statusMsg = updates.adminResponse
        ? `Status: ${updates.status.toUpperCase()}\nResponse: "${updates.adminResponse}"`
        : `Your support ticket status has been updated to "${updates.status.toUpperCase()}".`;

      try {
        await sendStudentNotification(
          recipient,
          statusTitle,
          statusMsg,
          updates.status === "resolved" ? "SYSTEM_INFO" : "GENERAL",
          "Support Desk",
          {
            ticketId,
            status: updates.status,
            adminResponse: updates.adminResponse
          }
        );
      } catch (_) { }
    } else if (sub.role === "lecturer") {
      try {
        await sendFacultyNotification(
          `Update on Ticket #${ticketId}`,
          `Your reported ticket status has been updated to "${updates.status.toUpperCase()}".\n${updates.adminResponse ? `Response: ${updates.adminResponse}` : ""}`,
          "GENERAL",
          ticketId,
          "Support Desk",
          {
            ticketId,
            status: updates.status
          },
          "lecturer"
        );
      } catch (_) { }
    }
  }

  return { success: true };
}

/**
 * Delete a ticket
 */
export async function deleteTicket(ticketId) {
  if (!ticketId) return;

  // Local storage
  const local = getLocalTickets();
  const filtered = local.filter(t => t.id !== ticketId);
  saveLocalTickets(filtered);

  // Firestore
  try {
    await deleteDoc(doc(db, "support_tickets", ticketId));
  } catch (_) { }
}
