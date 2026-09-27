import { db } from "../firebase";
import { collection, doc, addDoc, updateDoc, onSnapshot, query, orderBy, limit, serverTimestamp } from "firebase/firestore";

/**
 * Send real-time notification to a specific student document
 * @param {string} studentRollNo - Target student roll number
 * @param {string} title - Notification title
 * @param {string} message - Notification details message
 * @param {string} type - Notification category type
 * @param {string} senderName - Name of Lecturer or Admin who made the change
 */
export async function sendStudentNotification(studentRollNo, title, message, type = "SYSTEM_UPDATE", senderName = "Faculty/Admin") {
  if (!studentRollNo) return;
  const cleanRoll = String(studentRollNo).trim().toUpperCase();

  try {
    const notifRef = collection(db, "students", cleanRoll, "notifications");
    await addDoc(notifRef, {
      recipientRollNo: cleanRoll,
      title: title,
      message: message,
      type: type,
      senderName: senderName,
      read: false,
      createdAt: Date.now(),
      timestamp: serverTimestamp()
    });
    console.log(`[Notifications] Sent notification to ${cleanRoll}: ${title}`);
  } catch (err) {
    console.warn("Notice sending student notification:", err);
  }
}

/**
 * Subscribe to real-time notifications for a student
 */
export function subscribeToStudentNotifications(studentRollNo, callback) {
  if (!studentRollNo) return () => {};
  const cleanRoll = String(studentRollNo).trim().toUpperCase();

  try {
    const notifRef = collection(db, "students", cleanRoll, "notifications");
    const q = query(notifRef, orderBy("createdAt", "desc"), limit(15));
    return onSnapshot(q, (snapshot) => {
      const notifs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      callback(notifs);
    }, (err) => console.warn("Notifications subscription notice:", err));
  } catch (err) {
    console.warn("Error subscribing to notifications:", err);
    return () => {};
  }
}

/**
 * Mark a student notification as read
 */
export async function markNotificationAsRead(studentRollNo, notificationId) {
  if (!studentRollNo || !notificationId) return;
  const cleanRoll = String(studentRollNo).trim().toUpperCase();

  try {
    const notifDocRef = doc(db, "students", cleanRoll, "notifications", notificationId);
    await updateDoc(notifDocRef, {
      read: true,
      readAt: Date.now()
    });
  } catch (err) {
    console.warn("Error marking notification read:", err);
  }
}

/**
 * Send real-time audit & activity notification to Lecturers & Admins
 */
export async function sendFacultyNotification(title, message, type = "SYSTEM_AUDIT", studentRollNo = "", senderName = "System") {
  try {
    const facultyNotifRef = collection(db, "faculty_notifications");
    await addDoc(facultyNotifRef, {
      title: title,
      message: message,
      type: type,
      studentRollNo: studentRollNo ? String(studentRollNo).trim().toUpperCase() : "",
      senderName: senderName,
      read: false,
      createdAt: Date.now(),
      timestamp: serverTimestamp()
    });
    console.log(`[Faculty Notifications] Logged: ${title}`);
  } catch (err) {
    console.warn("Notice sending faculty notification:", err);
  }
}

/**
 * Subscribe to real-time notifications for Lecturers & Admins
 */
export function subscribeToFacultyNotifications(callback) {
  try {
    const facultyNotifRef = collection(db, "faculty_notifications");
    const q = query(facultyNotifRef, orderBy("createdAt", "desc"), limit(20));
    return onSnapshot(q, (snapshot) => {
      const notifs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      callback(notifs);
    }, (err) => {
      if (err?.code === 'permission-denied') {
        console.info("[Faculty Notifications] Awaiting permissions...");
      } else {
        console.warn("Faculty notifications subscription notice:", err);
      }
      callback([]);
    });
  } catch (err) {
    console.warn("Error subscribing to faculty notifications:", err);
    return () => {};
  }
}

/**
 * Mark a faculty notification as read
 */
export async function markFacultyNotificationAsRead(notificationId) {
  if (!notificationId) return;
  try {
    const notifDocRef = doc(db, "faculty_notifications", notificationId);
    await updateDoc(notifDocRef, {
      read: true,
      readAt: Date.now()
    });
  } catch (err) {
    console.warn("Error marking faculty notification read:", err);
  }
}

/**
 * Log a user verification complaint and dispatch high-priority alerts to Admins & Lecturers
 * @param {Object} userDetails - User info (email, rollNo, name, etc.)
 * @param {string} errorReason - Explanation of why the user check failed
 * @param {string} contextName - Location/Action (e.g. "STUDENT_LOGIN", "ATTENDANCE_CHECKIN", "DEVICE_SETUP")
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
    console.log(`[Security Complaints] Logged complaint for ${rollNo}: ${errorReason}`);

    // Dispatch real-time alert to all Admins and Lecturers
    await sendFacultyNotification(
      `🚨 Security Complaint: ${rollNo}`,
      `User verification failed for ${userName} (${rollNo}). Reason: ${errorReason}. Context: ${contextName}. Complaint logged for Admin & Faculty audit.`,
      "USER_VERIFICATION_FAILURE",
      rollNo,
      "Security Guard"
    );

    // Also notify student if valid roll exists
    if (rollNo && rollNo !== "UNKNOWN") {
      await sendStudentNotification(
        rollNo,
        "⚠️ User Verification Alert",
        `Verification Warning: Your attempt was flagged by security.\nReason: ${errorReason}\nContext: ${contextName}\nAn incident report has been sent to your Course Lecturer & Administrator for review.`,
        "SECURITY_ALERT",
        "Security Guard"
      );
    }

    return { success: true, complaintData };
  } catch (err) {
    console.warn("Error logging user verification complaint:", err);
    return { success: false, error: err.message };
  }
}


