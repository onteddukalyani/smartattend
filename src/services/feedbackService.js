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
const EMAILJS_SERVICE_ID = "service_eimkd0e";
const EMAILJS_TEMPLATE_ID = "template_lvxz9nq";
const EMAILJS_PUBLIC_KEY = "1p7HibAfyDgCJLrc2";
const DEVELOPER_TEAM_EMAIL = "onteddukalyani@gmail.com";

async function sendSupportTicketEmail(ticket) {
  const submittedBy = ticket.submittedBy || {};
  const submitterEmail = submittedBy.email || "";
  const attachmentType = ticket.attachmentUrl?.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/)?.[1];
  const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: {
        to_email: DEVELOPER_TEAM_EMAIL,
        recipient_email: DEVELOPER_TEAM_EMAIL,
        developer_email: DEVELOPER_TEAM_EMAIL,
        ticket_id: ticket.id,
        type: ticket.type,
        category: ticket.category,
        priority: ticket.priority,
        title: ticket.title,
        description: ticket.description,
        rating: ticket.rating || "",
        name: submittedBy.name || "User",
        submitted_by: submittedBy.name || "User",
        submitter_email: submitterEmail || "Not provided",
        from_name: submittedBy.name || "SmartAttend user",
        reply_to: submitterEmail,
        roll_no: submittedBy.rollNo || "Not provided",
        role: submittedBy.role || "unknown",
        department: submittedBy.department || "Not provided",
        submitted_at: new Date(ticket.createdAt).toLocaleString(),
        attachment_content: ticket.attachmentUrl || "",
        attachment_filename: ticket.attachmentName || "issue-screenshot",
        attachment_content_type: attachmentType || "image/png",
        attachment_image_style: ticket.attachmentUrl
          ? "display:block;width:100%;max-width:560px;height:auto;border-radius:12px;"
          : "display:none;"
      }
    })
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`EmailJS returned ${response.status}: ${responseText.slice(0, 300)}`);
  }
}

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
  institutionName: "IIIT Dharwad Campus ",
  officeLocation: "Academic Block",
  email: "25bcs108@iiitdwd.ac.in",
  adminEmail: "onteddukalyani@gmail.com",
  hours: "Monday – Saturday, 8:30 AM – 6:00 PM IST",
  helpline: "+91 XXXXX XXXXX",
  urgentHelpline: "+91 XXXXX XXXXX (Active Attendance Helpdesk)"
};

/**
 * Pre-defined Frequently Asked Questions (FAQs)
 */
export const FREQUENT_QUESTIONS = [
  {
    id: "faq-iphone-instructions",
    category: "iPhone (iOS)",
    question: "How do I setup iPhone, enable camera, and exit/leave the app when attendance ends?",
    answer: "1. Camera: Tap 'aA' in Safari address bar -> Website Settings -> Camera -> Allow. 2. Guided Access: iOS Settings -> Accessibility -> Guided Access -> turn ON and set PIN. 3. Before Scanning: Triple-click Side Button -> tap Start. 4. How to Exit: Triple-click Side Button -> enter PIN -> tap 'End' in top-left -> swipe up to leave."
  },
  {
    id: "faq-qr",
    category: "QR & Scanning",
    question: "Why does my camera show a black screen, blocked message, or fail to scan?",
    answer: "On Android devices, camera scanning in a web browser is disabled for attendance security — you must open the official SmartAttend Android App (.apk) with Kiosk mode. On iPhone, ensure camera permission is granted in Safari Settings. If issues persist, verify that you are within the classroom geofence range."
  },
  {
    id: "faq-camera-policy",
    category: "Platform & Security",
    question: "Can I mark attendance online in browser, or must I use the mobile app?",
    answer: "iPhone users can mark attendance directly in Safari web (with Guided Access). Android users MUST use the official SmartAttend Android App (.apk) because Android web browsers cannot enforce hardware kiosk locks against background apps or screen-sharing proxies."
  },
  {
    id: "faq-device-lock",
    category: "Device Security",
    question: "I see 'Device Mismatch', 'Guided Access Required', or Device Locked error. What should I do?",
    answer: "SmartAttend locks your account to your registered phone to prevent proxy attendance. On iPhone, triple-click the Side Button to start Guided Access. On Android, run the attendance session in the SmartAttend app. If you recently changed or reset your phone, ask your course lecturer or admin for an instant device lock reset."
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
  let deviceSpecs;
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
    attachmentName: ticketPayload.attachmentName || null,
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

  // 3. Deliver email notification directly to developer team (onteddukalyani@gmail.com)
  let emailNotificationSent = false;
  let emailNotificationError = "";
    try {
      await sendSupportTicketEmail(fullTicket);
      emailNotificationSent = true;
    } catch (err) {
      emailNotificationSent = false;
      emailNotificationError = err instanceof Error ? err.message : String(err);
      console.error("[feedbackService] Support email notification failed:", err);
    }

      // 4. In-app notifications are explicitly disabled for all help & feedback submissions.
      // No one (admins, faculty, or students) receives in-app notifications.
      // Only the developer team receives emails directly.

    return { success: true, ticket: fullTicket, emailNotificationSent, emailNotificationError };
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
