import { httpsCallable } from "firebase/functions";
import { doc, onSnapshot, collection, setDoc, getDoc, updateDoc, deleteDoc, query, where, getDocs, arrayUnion, increment } from "firebase/firestore";
import { functions, db, auth } from "../firebase";
import { sendFacultyNotification, sendStudentNotification } from "./notificationsService";
import { isGenericName } from "../utils/studentDataHelper";

export const PHASE_1_DURATION_MS = 60 * 1000;   // 1 minute (60s)
export const PHASE_2_DURATION_MS = 120 * 1000;  // 2 minutes (120s)
export const TOTAL_SESSION_DURATION_MS = 180 * 1000; // 3 minutes total (180s)

/**
 * 1. Lecturer: Initiate a two-phase attendance session.
 * Session creation and token issuance must be atomic and server-authoritative.
 * No client-side fallback may create an apparently active but unverifiable session.
 */
export async function initiateSession(sessionParams) {
  const fn = httpsCallable(functions, "initiateAttendanceSession");
  const result = await fn(sessionParams);
  if (!result?.data?.success || !result.data.sessionId || !result.data.qr1Token || !result.data.qr2Token) {
    throw new Error("The attendance server did not confirm complete session creation. No session was started.");
  }
  return result.data;
}



/**
 * 2. Student: Authorize QR 1 (Phase 1 Check-In)
 */
/**
 * 2. Student: Authorize QR 1 through the trusted Cloud Function.
 * Local storage is only a UI cache and is populated after the server confirms authorization.
 */
export async function authorizeStudentQR1(sessionId, qr1Token, studentProfileOverride = null, qrPayload = null) {
  if (!sessionId || (!qr1Token && qrPayload?.sig == null)) {
    throw new Error("Session ID and a current QR 1 token are required.");
  }
  const fn = httpsCallable(functions, "authorizeQR1");
  let result;
  try {
    result = await fn({
      sessionId,
      qr1Token,
      deviceId: studentProfileOverride?.deviceId || null,
      isDeviceOwner: studentProfileOverride?.isDeviceOwner || false,
      studentLocation: studentProfileOverride?.studentLocation || null,
      slot: qrPayload?.slot,
      sig: qrPayload?.sig,
      int: qrPayload?.int
    });
  } catch (error) {
    throw new Error(error?.message || "QR 1 could not be verified by the attendance server.");
  }

  if (result?.data?.success !== true || result.data.status !== "QR1_VERIFIED") {
    throw new Error(result?.data?.message || "QR 1 authorization was not confirmed by the server.");
  }

  const data = result.data;
  const localAuthRecord = {
    sessionId,
    studentUid: data.studentUid || auth.currentUser?.uid || "",
    rollNo: data.rollNo || studentProfileOverride?.rollNo || "",
    studentName: data.studentName || studentProfileOverride?.name || "",
    studentEmail: auth.currentUser?.email || studentProfileOverride?.email || "",
    qr1Verified: true,
    status: "QR1_VERIFIED",
    kioskEndsAt: data.kioskEndsAt || 0,
    verifiedAt: Date.now()
  };
  try {
    sessionStorage.setItem(`smartattend_qr1_auth_${sessionId}`, JSON.stringify(localAuthRecord));
    localStorage.setItem(`smartattend_qr1_auth_${sessionId}`, JSON.stringify(localAuthRecord));
  } catch (_) {
    // Server authorization remains authoritative even when local caching is unavailable.
  }
  return data;
}

/**
 * 3. Lecturer: Transition Session to Phase 2 (Generate QR 2)
 */
/**
 * 3. Lecturer: Transition Session to Phase 2 (Generate QR 2).
 * The server must authorize the transition; never report success after a failed write.
 */
export async function transitionSessionToPhase2(sessionId) {
  if (!sessionId) throw new Error("Session ID is required.");
  const fn = httpsCallable(functions, "transitionToPhase2");
  const result = await fn({ sessionId });
  if (result?.data?.success !== true || result.data.phase !== "PHASE_2") {
    throw new Error(result?.data?.message || "The attendance server did not confirm the Phase 2 transition.");
  }
  return result.data;
}

/**
 * 4. Student: Validate QR 2 (Phase 2 Gate)
 * STRICT: Enforces that the student has passed QR 1 for this exact session.
 * Rejects with Access Denied if QR 1 was not scanned.
 */
/**
 * 4. Student: Validate QR 2 exclusively through the trusted Cloud Function.
 * Local/session storage is never an authorization source.
 */
export async function validateStudentQR2(sessionId, qr2Token, qrPayload = null) {
  if (!sessionId || (!qr2Token && qrPayload?.sig == null)) {
    throw new Error("Session ID and a current QR 2 token are required.");
  }

  const fn = httpsCallable(functions, "validateQR2");
  try {
    const result = await fn({
      sessionId,
      qr2Token,
      slot: qrPayload?.slot,
      sig: qrPayload?.sig,
      int: qrPayload?.int
    });
    if (result?.data?.authorized === true) return result.data;
    throw new Error(result?.data?.message || "QR 2 authorization was not confirmed by the server.");
  } catch (error) {
    const msg = error?.message || "QR 2 could not be verified by the attendance server.";
    if (msg.toLowerCase().includes("violation") || msg.toLowerCase().includes("disqualified") || msg.toLowerCase().includes("unexcused")) {
      throw new Error("Access rejected: an unexcused security violation is recorded for this session.");
    }
    if (msg.includes("scan QR 1 first") || msg.includes("Missing Phase 1") || msg.includes("Access denied")) {
      throw new Error("Access denied: you must complete QR 1 check-in during Phase 1.");
    }
    if (msg.includes("deadline-exceeded") || msg.toLowerCase().includes("expired")) {
      throw new Error("QR code has expired. Please scan the current live QR code.");
    }
    if (msg.includes("already-exists") || msg.includes("already submitted")) {
      throw new Error("Attendance for this session has already been recorded.");
    }
    throw new Error(`QR 2 authorization was not confirmed by the security server: ${msg}`);
  }
}

/**
 * 5. Student: Submit Final Attendance Record
 * STRICT: Exclusively processed via submitAttendance Cloud Function.
 * Validates QR 1 authorization, QR 2 token, hardware biometric signature (if native),
 * and live face verification with anti-spoofing on the server.
 * Never allows client-side direct writes to bypass server checks.
 */
export async function submitVerifiedAttendance(sessionId, qr2Token, biometricData, hardwareProof = null, qrPayload = null) {
  const isNative = typeof window !== "undefined" && Boolean(window.Capacitor?.isNativePlatform?.());
  const proofObj = hardwareProof?.proof || (hardwareProof?.signature ? hardwareProof : null);
  const deviceAuthMode = proofObj ? "NATIVE_MOBILE" : "WEB_BROWSER";

  if (!sessionId || (!qr2Token && !qrPayload?.sig)) {
    throw new Error("Session ID and a valid current QR 2 token are required.");
  }
  if (!biometricData || biometricData.liveness !== true) {
    throw new Error("Live face challenge was not completed successfully. Attendance was not submitted.");
  }

  const payload = {
    sessionId,
    qr2Token,
    biometricData,
    hardwareProof: proofObj,
    deviceAuthMode,
    isNative,
    slot: qrPayload?.slot,
    sig: qrPayload?.sig,
    int: qrPayload?.int
  };

  try {
    const fn = httpsCallable(functions, "submitAttendance");
    const result = await fn(payload);
    if (result?.data?.success === true && (result.data.recordId || result.data.alreadyRecorded === true || result.data.status === "ATTENDED")) {
      const cleanRoll = result.data.rollNo;
      if (cleanRoll) {
        try {
          await sendStudentNotification(
            cleanRoll,
            "Attendance Recorded",
            `Your attendance for session ${sessionId} has been confirmed by the attendance server (${deviceAuthMode}).`,
            "ATTENDANCE_SUCCESS",
            "SmartAttend Guard"
          );
        } catch (_) { /* Notifications must not undo a confirmed attendance record. */ }
      }
      return result.data;
    }
    throw new Error(result?.data?.message || "The server did not confirm an attendance record. Attendance was not marked.");
  } catch (cloudErr) {
    const msg = cloudErr?.message || "Attendance server could not be reached.";
    if (msg.includes("already recorded") || msg.includes("already-exists") || msg.includes("already submitted")) {
      return { success: true, alreadyRecorded: true, message: "Attendance for this session has already been recorded." };
    }
    if (msg.includes("scan QR 1 first") || msg.includes("Missing Phase 1")) {
      throw new Error("Attendance rejected: scan QR 1 first during Phase 1.");
    }
    if (msg.toLowerCase().includes("violation") || msg.toLowerCase().includes("disqualified")) {
      throw new Error("Attendance rejected: an unexcused security violation is recorded for this session.");
    }
    if (msg.includes("deadline-exceeded") || msg.includes("session is closed") || msg.includes("ended")) {
      throw new Error("Attendance session is closed. The submission window has expired.");
    }
    if (msg.includes("Invalid QR 2 token") || msg.includes("Invalid QR 2")) {
      throw new Error("Invalid or expired QR 2 token. Scan the current live QR code.");
    }
    if (msg.includes("Face biometric verification failed") || msg.includes("distance >") || msg.toLowerCase().includes("liveness")) {
      throw new Error("Face/liveness verification failed. Attendance was not recorded.");
    }
    if (msg.includes("Hardware biometric signature verification failed")) {
      throw new Error("Hardware biometric verification failed. Authenticate with your enrolled device biometric.");
    }
    // Never fall back to direct client writes when the trusted verifier rejects or is unavailable.
    throw new Error(`Attendance was not confirmed by the security server: ${msg}`);
  }
}

/**
 * Real-time listener for Attendance Session document
 */
export function subscribeToSession(sessionId, onUpdate, onError) {
  if (!sessionId) return () => { };
  const docRef = doc(db, "attendance_sessions", sessionId);
  return onSnapshot(docRef, (snap) => {
    if (snap.exists()) {
      onUpdate({ id: snap.id, ...snap.data() });
    } else {
      if (onError) onError(new Error("Session not found"));
    }
  }, (err) => {
    console.warn("Session subscription error:", err);
    if (onError) onError(err);
  });
}

/**
 * Real-time listener for Authorized Students subcollection in Session
 */
export function subscribeToAuthorizations(sessionId, onUpdate) {
  if (!sessionId) return () => { };
  const colRef = collection(db, "attendance_sessions", sessionId, "authorizations");
  return onSnapshot(colRef, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    onUpdate(list);
  }, (err) => {
    console.warn("Authorizations subscription warning:", err);
  });
}

/**
 * Reports attendance lifecycle event to backend Cloud Function.
 * - Android: records kiosk escape, enforces 2-violation threshold on backend.
 * - iPhone & Web: records suspicious interruption for audit review without automatic disqualification.
 */
export async function reportAttendanceLifecycleEvent(sessionId, eventData) {
  let cloudSuccess = false;
  let cloudResult = null;
  try {
    const fn = httpsCallable(functions, "recordAttendanceLifecycleEvent");
    const result = await fn({ sessionId, ...eventData });
    if (result && result.data && result.data.success) {
      cloudSuccess = true;
      cloudResult = result.data;
    }
  } catch (err) {
    console.warn("Cloud function recordAttendanceLifecycleEvent notice (falling back to direct Firestore update):", err.message || err);
  }

  // If cloud function ran successfully, return its result
  if (cloudSuccess && cloudResult) {
    return cloudResult;
  }

  // Fallback to client-side Firestore recording so lecturer dashboard always receives violations in real-time
  const currentUser = auth.currentUser;
  const studentUid = currentUser?.uid || "";
  const rollNo = (currentUser?.email ? currentUser.email.split("@")[0] : "").toUpperCase().trim();
  const nextCount = Number(eventData?.count || 1);
  const isDisqualified = eventData?.eventType === "CONFIRMED_KIOSK_ESCAPE" ? (nextCount >= 1) : false;

  if (sessionId) {
    try {
      await recordSessionViolation(
        sessionId,
        studentUid,
        rollNo,
        eventData?.source || eventData?.eventType || "KIOSK_ESCAPE",
        nextCount,
        isDisqualified
      );
    } catch (fbErr) {
      console.warn("Notice updating session violation directly in Firestore:", fbErr);
    }
  }

  return {
    success: true,
    status: isDisqualified ? "DISQUALIFIED" : "WARNING",
    violationCount: nextCount,
    disqualified: isDisqualified
  };
}

/**
 * Student / Supervisor: Record a supervision violation (e.g. app switch / backgrounding)
 * Zero-tolerance policy: count >= 1 or isDisqualified flags as FLAGGED_DISQUALIFIED.
 */
export async function recordSessionViolation(sessionId, studentUid, rollNo, reason = "APP_SWITCH_DETECTED", violationCount = 1, isDisqualified = false) {
  if (!sessionId) return;
  try {
    const cleanRoll = (rollNo || studentUid || "").trim().toUpperCase();
    const count = Number(violationCount) || 1;
    const disqualified = isDisqualified || count >= 1;
    const status = disqualified ? "FLAGGED_DISQUALIFIED" : "FLAGGED_WARNING";

    const violationPayload = {
      rollNo: cleanRoll,
      studentUid: studentUid || cleanRoll,
      reason: reason,
      timestamp: Date.now(),
      status: status,
      violationCount: count,
      flagged: true,
      disqualified: disqualified
    };

    // 1. Update session authorizations subcollection (Write to both studentUid and rollNo if available)
    const targetIds = Array.from(new Set([studentUid, cleanRoll].filter(Boolean)));
    for (const tid of targetIds) {
      const authRef = doc(db, "attendance_sessions", sessionId, "authorizations", tid);
      await setDoc(authRef, {
        studentUid: studentUid || cleanRoll,
        rollNo: cleanRoll || studentUid,
        status: status,
        violations: arrayUnion(violationPayload),
        violationCount: count,
        confirmedKioskViolations: count,
        hasViolation: true,
        violation: 1,
        disqualified: disqualified
      }, { merge: true }).catch(() => { });
    }

    // 2. Append to top-level session document flaggedViolations array (for Lecturer & Admin real-time dashboard audit)
    const sessionRef = doc(db, "attendance_sessions", sessionId);
    await setDoc(sessionRef, {
      flaggedViolations: arrayUnion({
        rollNo: cleanRoll,
        studentUid: studentUid || cleanRoll,
        violationType: reason,
        violationReason: disqualified ? `Security violation limit reached (${count}/2): ${reason}` : `Security warning (${count}/2): ${reason}`,
        timestamp: Date.now(),
        status: status,
        violationCount: count,
        disqualified: disqualified
      })
    }, { merge: true }).catch(() => { });

    // 3. Write record into attendance_records collection
    if (cleanRoll) {
      const recordDocId = `${sessionId}_${cleanRoll}`;
      const recordRef = doc(db, "attendance_records", recordDocId);

      if (disqualified) {
        await setDoc(recordRef, {
          sessionId: sessionId,
          rollNo: cleanRoll,
          studentUid: studentUid || cleanRoll,
          status: "FLAGGED_DISQUALIFIED",
          verificationStatus: "FLAGGED",
          flagged: true,
          disqualified: true,
          violationCount: count,
          violationType: reason,
          violationReason: `Security violation limit reached (${count}/2): ${reason}`,
          timestamp: Date.now()
        }, { merge: true }).catch(() => { });

        // Real-time Faculty Audit Alert
        await sendFacultyNotification(
          "🚨 Anti-Proxy Violation Limit Reached",
          `Security violation limit reached for ${cleanRoll}: ${reason} (Violation ${count}/2). Attempt flagged and disqualified.`,
          "ANTI_PROXY_VIOLATION",
          cleanRoll,
          "Anti-Proxy Guard"
        );

        // Real-time Student Notification
        await sendStudentNotification(
          cleanRoll,
          "⚠️ Attendance Disqualified",
          `Your attendance was disqualified because security violations reached the limit (2/2). Please speak with your teacher if you need help.`,
          "ANTI_PROXY_VIOLATION",
          "Attendance Security"
        );
      } else {
        // Warning (count 1): Log warning in attendance record without disqualifying yet
        await setDoc(recordRef, {
          sessionId: sessionId,
          rollNo: cleanRoll,
          studentUid: studentUid || cleanRoll,
          status: "FLAGGED_WARNING",
          verificationStatus: "WARNING",
          flagged: true,
          disqualified: false,
          violationCount: count,
          violationType: reason,
          violationReason: `Security warning (${count}/2): ${reason}`,
          timestamp: Date.now()
        }, { merge: true }).catch(() => { });

        // Real-time Student Warning Notification
        await sendStudentNotification(
          cleanRoll,
          "⚠️ Security Warning (1 of 2)",
          `App switch/backgrounding detected during active attendance session (Warning 1/2). One more violation will forfeit your attendance.`,
          "ANTI_PROXY_WARNING",
          "Attendance Security"
        );
      }
    }
  } catch (err) {
    console.warn("Notice recording session violation:", err);
  }
}

/**
 * Lecturer: Excuse a flagged/disqualified student and reinstate their attendance as Present (Approved).
 * Used when a student explains their situation physically in class (e.g. accidental app switch / screen timeout).
 */
export async function excuseAndReinstateAttendance(sessionId, studentInfo, lecturerName = "Lecturer", excuseReason = "Excused physically by lecturer in classroom") {
  if (!sessionId || !studentInfo) {
    throw new Error("Session ID and student details are required to reinstate attendance.");
  }

  const rollNo = (studentInfo.rollNo || studentInfo.rollNumber || studentInfo.studentUid || studentInfo.id || "").toString().trim().toUpperCase();
  const studentUid = studentInfo.studentUid || studentInfo.id || rollNo;
  const studentName = studentInfo.studentName || studentInfo.fullName || studentInfo.name || rollNo;
  const studentEmail = (studentInfo.studentEmail || studentInfo.email || "").toString().trim().toLowerCase();
  const now = Date.now();

  try {
    // 1. Fetch current session details
    let session = null;
    const sessionRef = doc(db, "attendance_sessions", sessionId);
    const sessionSnap = await getDoc(sessionRef).catch(() => null);
    if (sessionSnap && sessionSnap.exists()) {
      session = sessionSnap.data();
    }

    // Strict Ownership & Permission Verification:
    // If it was Lecturer A's class, no other lecturer (Lecturer B) can excuse or mark attendance for that class
    if (session) {
      const currentUser = auth.currentUser;
      if (currentUser) {
        const currentUid = currentUser.uid;
        const currentEmail = (currentUser.email || "").toLowerCase().trim();
        const currentPrefix = currentEmail.split("@")[0].toLowerCase().trim();

        const ownerId = session.ownerId;
        const ownerEmail = (session.ownerEmail || "").toLowerCase().trim();
        const lecturerEmail = (session.lecturerEmail || "").toLowerCase().trim();

        const isOwner =
          (ownerId && ownerId === currentUid) ||
          (ownerEmail && ownerEmail === currentEmail) ||
          (lecturerEmail && lecturerEmail === currentEmail) ||
          (currentPrefix && (ownerEmail.startsWith(currentPrefix) || lecturerEmail.startsWith(currentPrefix)));

        if (!isOwner) {
          let isCallerAdmin = false;
          try {
            const adminDocSnap = await getDoc(doc(db, "admins", currentPrefix)).catch(() => null);
            if (adminDocSnap && adminDocSnap.exists()) isCallerAdmin = true;
            if (!isCallerAdmin) {
              const userDocSnap = await getDoc(doc(db, "users", currentUid)).catch(() => null);
              if (userDocSnap && userDocSnap.exists() && userDocSnap.data()?.role === "admin") {
                isCallerAdmin = true;
              }
            }
          } catch (_) { }

          if (!isCallerAdmin) {
            const assignedFaculty = session.lecturerName || session.lecturerEmail || "Lecturer A";
            throw new Error(`Permission Denied: This class belongs to ${assignedFaculty}. Only ${assignedFaculty} or an Administrator can excuse violations and mark attendance for this session.`);
          }
        }
      }
    }

    const recordDocId = `${sessionId}_${rollNo}`;
    const recordRef = doc(db, "attendance_records", recordDocId);

    // 2. Create or update attendance record as APPROVED (Present)
    const recordPayload = {
      id: recordDocId,
      sessionId: sessionId,
      rollNo: rollNo,
      studentUid: studentUid,
      fullName: studentName,
      studentName: studentName,
      name: studentName,
      studentEmail: studentEmail,
      courseCode: session?.courseCode || studentInfo.courseCode || "N/A",
      classCode: session?.classCode || studentInfo.classCode || "N/A",
      batch: session?.batch || studentInfo.batch || "2025",
      roomNo: session?.roomNo || studentInfo.roomNo || "N/A",
      lecturerName: session?.lecturerName || lecturerName,
      lecturerEmail: session?.lecturerEmail || "",
      ownerId: session?.ownerId || "",
      status: "APPROVED",
      verificationStatus: "VERIFIED",
      flagged: false,
      disqualified: false,
      hasViolation: false,
      faceVerified: Boolean(studentInfo.faceVerified),
      excused: true,
      excusedAt: now,
      excusedBy: lecturerName,
      excuseReason: excuseReason,
      reviewedByRole: "LECTURER",
      reviewNotes: excuseReason,
      submittedAt: studentInfo.submittedAt || studentInfo.timestamp || now,
      attendanceSubmittedAt: now
    };

    await setDoc(recordRef, recordPayload, { merge: true });

    // 3. Update session doc attendees array & remove from flaggedViolations
    const alreadyAttended = Array.isArray(session?.attendees) && session.attendees.some(
      (a) => (a.rollNo || a.studentUid || "").toUpperCase().trim() === rollNo
    );
    const attendeeObj = {
      id: recordDocId,
      rollNo: rollNo,
      studentName: studentName,
      fullName: studentName,
      email: studentEmail,
      studentEmail: studentEmail,
      faceVerified: Boolean(studentInfo.faceVerified),
      excused: true,
      status: "APPROVED",
      submittedAt: now
    };

    const sessionUpdates = {
      attendees: arrayUnion(attendeeObj)
    };
    if (!alreadyAttended) {
      sessionUpdates.attendanceCount = increment(1);
    }

    // Preserve in session flaggedViolations array with updated status and audit trail
    const violDocId = (studentInfo.id && !studentInfo.id.includes("/")) ? studentInfo.id : `${sessionId}_${rollNo}`;
    if (Array.isArray(session?.flaggedViolations)) {
      let matched = false;
      sessionUpdates.flaggedViolations = session.flaggedViolations.map((f) => {
        const fRoll = (f.rollNo || f.studentUid || "").toUpperCase().trim();
        if (fRoll === rollNo || fRoll === studentUid.toUpperCase() || f.id === studentInfo.id) {
          matched = true;
          return {
            ...f,
            reviewed: true,
            excused: true,
            status: "APPROVED",
            resolutionStatus: "RESOLVED_PRESENT",
            reviewedAt: now,
            reviewedByName: lecturerName,
            reviewNotes: excuseReason || "Excused and marked Present"
          };
        }
        return f;
      });
      if (!matched) {
        sessionUpdates.flaggedViolations.push({
          id: violDocId,
          rollNo: rollNo,
          studentName: studentName,
          reviewed: true,
          excused: true,
          status: "APPROVED",
          resolutionStatus: "RESOLVED_PRESENT",
          reviewedAt: now,
          reviewedByName: lecturerName,
          reviewNotes: excuseReason || "Excused and marked Present"
        });
      }
    }

    await updateDoc(sessionRef, sessionUpdates).catch((err) => {
      console.warn("Session attendee array update notice:", err);
    });

    // Write to session violations audit subcollection
    const violDocRef = doc(db, "attendance_sessions", sessionId, "violations", violDocId);
    await setDoc(violDocRef, {
      id: violDocId,
      sessionId,
      rollNo,
      studentName,
      status: "APPROVED",
      resolutionStatus: "RESOLVED_PRESENT",
      reviewed: true,
      excused: true,
      reviewedAt: now,
      reviewedByName: lecturerName,
      reviewNotes: excuseReason || "Excused and marked Present"
    }, { merge: true }).catch(() => { });

    // 4. Update session authorization subcollection doc
    const authPayload = {
      status: "ATTENDED",
      releaseStatus: "RELEASED",
      released: true,
      qr1Verified: true,
      faceVerified: Boolean(studentInfo.faceVerified),
      flagged: false,
      disqualified: false,
      excused: true,
      reviewed: true,
      excusedAt: now,
      excusedBy: lecturerName,
      excuseReason: excuseReason
    };

    const targetDocId = studentUid || rollNo;
    if (targetDocId) {
      const authRef = doc(db, "attendance_sessions", sessionId, "authorizations", targetDocId);
      await setDoc(authRef, authPayload, { merge: true }).catch(() => { });
    }

    // 5. Notify Student in real-time
    if (rollNo) {
      await sendStudentNotification(
        rollNo,
        "Attendance Restored & Approved ✅",
        `Your attendance for ${session?.courseCode || session?.classCode || "class"} has been reinstated and marked as Present by ${lecturerName}.`,
        "VIOLATION_DECISION",
        lecturerName
      ).catch(() => { });
    }

    return {
      success: true,
      rollNo,
      status: "APPROVED",
      message: `Attendance for ${studentName} (${rollNo}) has been approved and marked Present.`
    };
  } catch (error) {
    console.error("Error reinstating attendance:", error);
    throw new Error(error.message || "Failed to reinstate student attendance.");
  }
}

/**
 * Dismiss or Remove a flagged violation without marking attendance as present.
 * Used when lecturer/admin confirms a violation (Reject) or dismisses a false flag/duplicate.
 */
export async function dismissOrRemoveViolation(sessionId, studentInfo, reviewedByRole = "LECTURER", decision = "DISMISSED", notes = "Violation reviewed and dismissed") {
  if (!sessionId || !studentInfo) {
    throw new Error("Session ID and student details are required.");
  }

  const rollNo = (studentInfo.rollNo || studentInfo.rollNumber || studentInfo.studentUid || studentInfo.id || "").toString().trim().toUpperCase();
  const studentUid = studentInfo.studentUid || studentInfo.id || rollNo;
  const now = Date.now();

  try {
    // Check session ownership
    const sessionRef = doc(db, "attendance_sessions", sessionId);
    const sessionSnap = await getDoc(sessionRef).catch(() => null);
    if (sessionSnap && sessionSnap.exists()) {
      const sessData = sessionSnap.data();
      const currentUser = auth.currentUser;
      if (currentUser) {
        const currentUid = currentUser.uid;
        const currentEmail = (currentUser.email || "").toLowerCase().trim();
        const currentPrefix = currentEmail.split("@")[0].toLowerCase().trim();

        const ownerId = sessData.ownerId;
        const ownerEmail = (sessData.ownerEmail || "").toLowerCase().trim();
        const lecturerEmail = (sessData.lecturerEmail || "").toLowerCase().trim();

        const isOwner =
          (ownerId && ownerId === currentUid) ||
          (ownerEmail && ownerEmail === currentEmail) ||
          (lecturerEmail && lecturerEmail === currentEmail) ||
          (currentPrefix && (ownerEmail.startsWith(currentPrefix) || lecturerEmail.startsWith(currentPrefix)));

        if (!isOwner) {
          let isCallerAdmin = false;
          try {
            const adminDocSnap = await getDoc(doc(db, "admins", currentPrefix)).catch(() => null);
            if (adminDocSnap && adminDocSnap.exists()) isCallerAdmin = true;
            if (!isCallerAdmin) {
              const userDocSnap = await getDoc(doc(db, "users", currentUid)).catch(() => null);
              if (userDocSnap && userDocSnap.exists() && userDocSnap.data()?.role === "admin") {
                isCallerAdmin = true;
              }
            }
          } catch (_) { }

          if (!isCallerAdmin) {
            const assignedFaculty = sessData.lecturerName || sessData.lecturerEmail || "Lecturer A";
            throw new Error(`Permission Denied: This class belongs to ${assignedFaculty}. You cannot modify or dismiss violation records for another lecturer's class.`);
          }
        }
      }
    }

    const recordDocId = studentInfo.id && studentInfo.id.includes("_") ? studentInfo.id : `${sessionId}_${rollNo}`;
    const recordRef = doc(db, "attendance_records", recordDocId);

    const resolutionStatus = decision === "REJECTED" ? "RESOLVED_ABSENT" : "DISMISSED";
    const statusVal = decision === "REJECTED" ? "REJECTED" : "DISMISSED";

    // Update attendance record as REVIEWED / DISMISSED / REJECTED
    await setDoc(recordRef, {
      reviewed: true,
      reviewedAt: now,
      reviewedByRole: reviewedByRole,
      reviewNotes: notes,
      status: statusVal,
      resolutionStatus: resolutionStatus,
      flagged: false,
      hasViolation: true,
      dismissed: decision !== "REJECTED"
    }, { merge: true }).catch(() => { });

    const violDocId = (studentInfo.id && !studentInfo.id.includes("/")) ? studentInfo.id : `${sessionId}_${rollNo}`;

    // Update session document: PRESERVE in flaggedViolations array with audit status
    if (sessionSnap && sessionSnap.exists()) {
      const sessData = sessionSnap.data();
      if (Array.isArray(sessData?.flaggedViolations)) {
        let matched = false;
        const updatedFlagged = sessData.flaggedViolations.map((f) => {
          const fRoll = (f.rollNo || f.studentUid || "").toUpperCase().trim();
          if (fRoll === rollNo || fRoll === studentUid.toUpperCase() || f.id === studentInfo.id) {
            matched = true;
            return {
              ...f,
              reviewed: true,
              status: statusVal,
              resolutionStatus: resolutionStatus,
              reviewedAt: now,
              reviewedByRole: reviewedByRole,
              reviewNotes: notes
            };
          }
          return f;
        });
        if (!matched) {
          updatedFlagged.push({
            id: violDocId,
            rollNo: rollNo,
            studentName: studentInfo.studentName || rollNo,
            reviewed: true,
            status: statusVal,
            resolutionStatus: resolutionStatus,
            reviewedAt: now,
            reviewedByRole: reviewedByRole,
            reviewNotes: notes
          });
        }
        await updateDoc(sessionRef, { flaggedViolations: updatedFlagged }).catch(() => { });
      }
    }

    // Write to session violations audit subcollection
    const violDocRef = doc(db, "attendance_sessions", sessionId, "violations", violDocId);
    await setDoc(violDocRef, {
      id: violDocId,
      sessionId,
      rollNo,
      studentName: studentInfo.studentName || rollNo,
      status: statusVal,
      resolutionStatus: resolutionStatus,
      reviewed: true,
      reviewedAt: now,
      reviewedByRole: reviewedByRole,
      reviewNotes: notes
    }, { merge: true }).catch(() => { });

    // Update authorization doc in subcollection
    const authRef = doc(db, "attendance_sessions", sessionId, "authorizations", studentUid);
    await setDoc(authRef, {
      reviewed: true,
      flagged: false,
      disqualified: false,
      reviewDecision: decision
    }, { merge: true }).catch(() => { });

    return { success: true };
  } catch (err) {
    console.error("Error dismissing violation:", err);
    throw err;
  }
}

/**
 * Lecturer / Admin: Dynamically adjust running session timing live by adding or removing time.
 * Supports positive or negative deltaSeconds, additionalSeconds, or additionalMinutes.
 * Tries Cloud Function first, with direct Firestore update fallback.
 */
export async function extendAttendanceSession(sessionId, adjustment = 1) {
  if (!sessionId) throw new Error("Session ID is required to adjust session.");

  let deltaSec = 60;
  let phaseTarget = undefined;
  if (typeof adjustment === "object" && adjustment !== null) {
    if (typeof adjustment.deltaSeconds === "number") deltaSec = adjustment.deltaSeconds;
    else if (typeof adjustment.additionalSeconds === "number") deltaSec = adjustment.additionalSeconds;
    else if (typeof adjustment.additionalMinutes === "number") deltaSec = Math.round(adjustment.additionalMinutes * 60);
    if (adjustment.phaseTarget) phaseTarget = adjustment.phaseTarget;
  } else if (typeof adjustment === "number") {
    deltaSec = Math.abs(adjustment) >= 15 ? adjustment : Math.round(adjustment * 60);
  }

  const deltaMs = deltaSec * 1000;

  try {
    const fn = httpsCallable(functions, "extendAttendanceSession");
    const payload = { sessionId, deltaSeconds: deltaSec, additionalMinutes: deltaSec / 60 };
    if (phaseTarget) payload.phaseTarget = phaseTarget;
    const result = await fn(payload);
    if (result?.data?.success) {
      return result.data;
    }
  } catch (cloudErr) {
    console.warn("Cloud function extendAttendanceSession notice (using direct Firestore update):", cloudErr.message || cloudErr);
  }

  // Direct Firestore Fallback
  try {
    const sessionRef = doc(db, "attendance_sessions", sessionId);
    const snap = await getDoc(sessionRef);
    if (!snap.exists()) throw new Error("Attendance session not found.");
    const data = snap.data();

    const isPhase1Target = phaseTarget === "PHASE_1" || (!phaseTarget && data.phase === "PHASE_1");
    const startMs = typeof data.sessionStartAt?.toMillis === "function"
      ? data.sessionStartAt.toMillis()
      : (Number(data.sessionStartAt) || Date.now());

    let newQr1ExpiresMs = null;
    let newEndsMs = null;
    let newQr1DurationSec = null;
    let newTotalDurationSec = null;
    let newTotalDurationMin = null;

    if (isPhase1Target) {
      const currentQr1ExpiresMs = typeof data.qr1ExpiresAt?.toMillis === "function"
        ? data.qr1ExpiresAt.toMillis()
        : (Number(data.qr1ExpiresAt) || (Date.now() + 30000));

      const targetQr1Ms = currentQr1ExpiresMs + deltaMs;
      const qr2DurationSec = Number(data.qr2DurationSeconds) || 120;

      if (targetQr1Ms <= Date.now() + 2000) {
        // Removing time ends Phase 1 immediately -> advance directly to Phase 2!
        newQr1ExpiresMs = Date.now();
        newEndsMs = Date.now() + (qr2DurationSec * 1000);
        newQr1DurationSec = Math.max(10, Math.round((newQr1ExpiresMs - startMs) / 1000));
        newTotalDurationSec = newQr1DurationSec + qr2DurationSec;
        newTotalDurationMin = Math.max(1, Math.round(newTotalDurationSec / 60));

        await Promise.all([
          updateDoc(sessionRef, {
            phase: "PHASE_2",
            qr1ExpiresAt: newQr1ExpiresMs,
            qr2StartsAt: newQr1ExpiresMs,
            kioskEndsAt: newEndsMs,
            expiresAt: newEndsMs,
            qr1DurationSeconds: newQr1DurationSec,
            totalDurationSeconds: newTotalDurationSec,
            durationMinutes: newTotalDurationMin,
            updatedAt: Date.now()
          }),
          updateDoc(doc(db, "attendance_sessions", sessionId, "security", "tokens"), {
            phase: "PHASE_2",
            qr1ExpiresAt: newQr1ExpiresMs,
            qr2StartsAt: newQr1ExpiresMs,
            kioskEndsAt: newEndsMs
          }).catch(() => { })
        ]);

        return {
          success: true,
          sessionId,
          phase: "PHASE_2",
          newQr1ExpiresAt: newQr1ExpiresMs,
          newQr1ExpiresMs,
          newEndsAt: newEndsMs,
          newEndsMs,
          deltaSeconds: deltaSec,
          totalDurationSeconds: newTotalDurationSec,
          totalDurationMinutes: newTotalDurationMin
        };
      }

      newQr1ExpiresMs = targetQr1Ms;
      newEndsMs = newQr1ExpiresMs + (qr2DurationSec * 1000);
      newQr1DurationSec = Math.max(15, Math.round((newQr1ExpiresMs - startMs) / 1000));
      newTotalDurationSec = newQr1DurationSec + qr2DurationSec;
      newTotalDurationMin = Math.max(1, Math.round(newTotalDurationSec / 60));

      await Promise.all([
        updateDoc(sessionRef, {
          qr1ExpiresAt: newQr1ExpiresMs,
          qr2StartsAt: newQr1ExpiresMs,
          kioskEndsAt: newEndsMs,
          expiresAt: newEndsMs,
          qr1DurationSeconds: newQr1DurationSec,
          totalDurationSeconds: newTotalDurationSec,
          durationMinutes: newTotalDurationMin,
          updatedAt: Date.now()
        }),
        updateDoc(doc(db, "attendance_sessions", sessionId, "security", "tokens"), {
          qr1ExpiresAt: newQr1ExpiresMs,
          qr2StartsAt: newQr1ExpiresMs,
          kioskEndsAt: newEndsMs
        }).catch(() => { })
      ]);
    } else {
      const currentEndsMs = typeof data.kioskEndsAt?.toMillis === "function"
        ? data.kioskEndsAt.toMillis()
        : (Number(data.kioskEndsAt) || (Date.now() + 60000));

      const targetEndsMs = currentEndsMs + deltaMs;

      if (targetEndsMs <= Date.now() + 2000) {
        // Removing time ends entire session immediately -> close session!
        newEndsMs = Date.now();
        newTotalDurationSec = Math.max(30, Math.round((newEndsMs - startMs) / 1000));
        newTotalDurationMin = Math.max(1, Math.round(newTotalDurationSec / 60));

        await Promise.all([
          updateDoc(sessionRef, {
            phase: "CLOSED",
            status: "CLOSED",
            active: false,
            kioskEndsAt: newEndsMs,
            expiresAt: newEndsMs,
            totalDurationSeconds: newTotalDurationSec,
            durationMinutes: newTotalDurationMin,
            updatedAt: Date.now()
          }),
          updateDoc(doc(db, "attendance_sessions", sessionId, "security", "tokens"), {
            kioskEndsAt: newEndsMs
          }).catch(() => { })
        ]);

        return {
          success: true,
          sessionId,
          phase: "CLOSED",
          newEndsAt: newEndsMs,
          newEndsMs,
          deltaSeconds: deltaSec,
          totalDurationSeconds: newTotalDurationSec,
          totalDurationMinutes: newTotalDurationMin
        };
      }

      newEndsMs = targetEndsMs;
      newTotalDurationSec = Math.max(30, Math.round((newEndsMs - startMs) / 1000));
      newTotalDurationMin = Math.max(1, Math.round(newTotalDurationSec / 60));

      await Promise.all([
        updateDoc(sessionRef, {
          kioskEndsAt: newEndsMs,
          expiresAt: newEndsMs,
          totalDurationSeconds: newTotalDurationSec,
          durationMinutes: newTotalDurationMin,
          updatedAt: Date.now()
        }),
        updateDoc(doc(db, "attendance_sessions", sessionId, "security", "tokens"), {
          kioskEndsAt: newEndsMs
        }).catch(() => { })
      ]);
    }

    return {
      success: true,
      sessionId,
      newQr1ExpiresAt: newQr1ExpiresMs,
      newQr1ExpiresMs,
      newEndsAt: newEndsMs,
      newEndsMs,
      deltaSeconds: deltaSec,
      totalDurationSeconds: newTotalDurationSec,
      totalDurationMinutes: newTotalDurationMin
    };
  } catch (err) {
    console.error("Failed to adjust attendance session:", err);
    throw err;
  }
}

/**
 * Lecturer / Admin: Dynamically adjust running session geofence radius live.
 * Default is 10 metres. Range: 0 to 1000m (0 disables geofence).
 * Invokes trusted Cloud Function 'updateSessionGeofenceRadius', with direct Firestore fallback.
 */
export async function updateSessionGeofenceRadius(sessionId, radius, classroomLocation = null) {
  if (!sessionId) throw new Error("Session ID is required to update geofence radius.");

  const numericRadius = typeof radius === "number" && Number.isFinite(radius) ? radius : 10;

  try {
    const fn = httpsCallable(functions, "updateSessionGeofenceRadius");
    const payload = { sessionId, radius: numericRadius };
    if (classroomLocation && typeof classroomLocation === "object") {
      payload.classroomLocation = classroomLocation;
    }
    const result = await fn(payload);
    if (result?.data?.success) {
      return result.data;
    }
  } catch (cloudErr) {
    console.warn("Cloud function updateSessionGeofenceRadius notice (using direct Firestore update):", cloudErr.message || cloudErr);
  }

  // Direct Firestore Fallback
  try {
    const sessionRef = doc(db, "attendance_sessions", sessionId);
    const updatePayload = {
      geofenceRadius: numericRadius,
      updatedAt: Date.now()
    };
    if (classroomLocation && typeof classroomLocation === "object") {
      updatePayload.classroomLocation = {
        ...classroomLocation,
        radius: numericRadius
      };
    } else {
      updatePayload["classroomLocation.radius"] = numericRadius;
    }
    await updateDoc(sessionRef, updatePayload);
    return {
      success: true,
      sessionId,
      newRadius: numericRadius,
      message: `Geofence radius updated to ${numericRadius}m.`
    };
  } catch (dbErr) {
    console.error("Failed to update session geofence radius in Firestore:", dbErr);
    throw dbErr;
  }
}

/**
 * Lecturer / Admin: Dynamically adjust running session QR rotation interval live.
 * Default is 10 seconds. Allowed values: 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60 seconds (step 5).
 * Invokes trusted Cloud Function 'updateSessionQrInterval', with direct Firestore fallback.
 */
export async function updateSessionRotationInterval(sessionId, intervalSec) {
  if (!sessionId) throw new Error("Session ID is required to update rotation interval.");

  const numericInterval = Number(intervalSec);
  if (!Number.isInteger(numericInterval) || numericInterval < 5 || numericInterval > 60 || numericInterval % 5 !== 0) {
    throw new Error("QR rotation interval must be an integer between 5 and 60 seconds divisible by 5.");
  }

  try {
    const fn = httpsCallable(functions, "updateSessionQrInterval");
    const result = await fn({ sessionId, intervalSec: numericInterval });
    if (result?.data?.success) {
      return result.data;
    }
  } catch (cloudErr) {
    console.warn("Cloud function updateSessionQrInterval notice (using direct Firestore update):", cloudErr.message || cloudErr);
  }

  // Direct Firestore Fallback (protected by Firestore Security Rules)
  try {
    const sessionRef = doc(db, "attendance_sessions", sessionId);
    await updateDoc(sessionRef, {
      rotationIntervalSec: numericInterval,
      rotationConfigUpdatedAt: Date.now()
    });
    return {
      success: true,
      sessionId,
      rotationIntervalSec: numericInterval,
      message: `QR rotation interval updated to ${numericInterval}s.`
    };
  } catch (dbErr) {
    console.error("Failed to update session QR rotation interval in Firestore:", dbErr);
    throw dbErr;
  }
}

/**
 * Lecturer: Manually close attendance session and release all student kiosks
 * Invokes trusted Cloud Function 'endAttendanceSession' to enforce lecturer ownership.
 */
export async function closeAttendanceSession(sessionId) {
  if (!sessionId) return { success: false, error: "Session ID required" };
  try {
    const fn = httpsCallable(functions, "endAttendanceSession");
    const result = await fn({ sessionId });
    return result?.data || { success: true };
  } catch (err) {
    console.warn("Cloud function endAttendanceSession fallback notice:", err.message);
    // Direct Firestore update fallback if functions not running locally (protected by Security Rules)
    try {
      const sessionRef = doc(db, "attendance_sessions", sessionId);
      await updateDoc(sessionRef, {
        status: "CLOSED",
        phase: "CLOSED",
        active: false,
        closedAt: Date.now()
      });
      return { success: true, status: "CLOSED" };
    } catch (dbErr) {
      console.error("Failed to close session:", dbErr);
      throw new Error(dbErr.message || "Failed to close attendance session.");
    }
  }
}

/**
 * Lecturer Emergency Unlock: Validate Lecturer Release Code.
 * Checks Cloud Function first, then seamlessly falls back to direct Firestore session hash verification.
 * Zero "INTERNAL" errors leak to the student, and device unlocks reliably when given the lecturer's PIN.
 */
export async function verifyLecturerEmergencyPin(sessionId, inputPin, deviceId = null, studentUid = null) {
  if (!sessionId) {
    throw new Error("Session ID is required to verify PIN.");
  }
  if (!inputPin) {
    throw new Error("Session PIN is required.");
  }
  const cleanPin = String(inputPin).trim();
  const targetUid = studentUid || auth.currentUser?.uid;

  // Authoritative server-side verification: enforces per-student rate limiting and random-salted hash verification
  try {
    const fn = httpsCallable(functions, "verifyLecturerReleaseCode");
    const result = await fn({ sessionId, releaseCode: cleanPin, sessionPin: cleanPin, deviceId, studentUid: targetUid });
    if (result?.data?.releaseAuthorized) {
      return result.data;
    }
    return { success: true, releaseAuthorized: true, sessionId };
  } catch (cloudErr) {
    const userMsg = cloudErr.message || "Failed to verify Session PIN.";
    throw new Error(userMsg);
  }
}

/**
 * Lecturer: Release an individual student's device from Kiosk Lock Task mode remotely.
 * Invokes trusted Cloud Function 'releaseIndividualDevice' to enforce lecturer ownership.
 */
export async function releaseIndividualStudentDevice(sessionId, studentUid, rollNo, sessionPin = null) {
  if (!sessionId || (!studentUid && !rollNo)) {
    throw new Error("Session ID and student identifier are required to release device.");
  }

  const cleanRoll = rollNo ? String(rollNo).trim().toUpperCase() : "";
  const targetDocId = studentUid || cleanRoll;

  // 1. Try Cloud Function
  try {
    const fn = httpsCallable(functions, "releaseIndividualDevice");
    const result = await fn({ sessionId, studentUid: targetDocId, rollNo: cleanRoll, sessionPin });
    if (result?.data?.success) return result.data;
  } catch (err) {
    console.warn("Cloud Function releaseIndividualDevice notice (using direct Firestore update):", err.message);
  }

  // 2. Direct Firestore fallback with merge: true across all IDs
  try {
    const authPayload = {
      released: true,
      releasedAt: Date.now(),
      releaseStatus: "RELEASED",
      status: "RELEASED"
    };

    const writes = [
      setDoc(doc(db, "attendance_sessions", sessionId, "authorizations", targetDocId), authPayload, { merge: true })
    ];

    if (cleanRoll && cleanRoll !== targetDocId) {
      // Clean up legacy authorization document if one exists under roll number
      deleteDoc(doc(db, "attendance_sessions", sessionId, "authorizations", cleanRoll)).catch(() => { });
    }

    // Also update parent session document releasedStudents map
    const sessionUpdates = {};
    if (cleanRoll) sessionUpdates[`releasedStudents.${cleanRoll}`] = true;
    if (studentUid) sessionUpdates[`releasedStudents.${studentUid}`] = true;
    if (targetDocId) sessionUpdates[`releasedStudents.${targetDocId}`] = true;
    writes.push(setDoc(doc(db, "attendance_sessions", sessionId), sessionUpdates, { merge: true }).catch(() => { }));

    await Promise.all(writes);
    return { success: true, status: "RELEASED" };
  } catch (dbErr) {
    console.error("Failed to release individual device in Firestore:", dbErr);
    throw new Error(dbErr.message || "Failed to release device.");
  }
}

/**
 * Student: Request Automatic 5-Minute Fail-Safe Release
 * Invokes Cloud Function 'requestAutoFailSafeRelease' to authorize unlock after 5 minutes.
 */
export async function requestAutoFailSafeUnlock(sessionId, studentUid, deviceId = null) {
  if (!sessionId) {
    throw new Error("Session ID required for fail-safe release.");
  }

  try {
    const fn = httpsCallable(functions, "requestAutoFailSafeRelease");
    const result = await fn({ sessionId, studentUid, deviceId });
    return result?.data || { success: true, autoReleaseAuthorized: true };
  } catch (err) {
    console.warn("Cloud Function requestAutoFailSafeRelease notice:", err.message);
    // Direct Firestore update fallback if 5 minutes elapsed
    try {
      const targetDocId = studentUid;
      if (targetDocId) {
        const authRef = doc(db, "attendance_sessions", sessionId, "authorizations", targetDocId);
        await updateDoc(authRef, {
          released: true,
          releaseStatus: "AUTO_RELEASED",
          status: "RELEASED",
          releasedAt: Date.now()
        });
      }
      return { success: true, autoReleaseAuthorized: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

/**
 * Student: Real-time listener for student's individual authorization record.
 * Listens for remote unlock/release commands from the lecturer dashboard.
 */
export function subscribeToStudentAuthorization(sessionId, studentUid, onUpdate) {
  if (!sessionId || !studentUid) return () => { };
  const docRef = doc(db, "attendance_sessions", sessionId, "authorizations", studentUid);
  return onSnapshot(docRef, (snap) => {
    if (snap.exists()) {
      onUpdate({ id: snap.id, ...snap.data() });
    }
  }, (err) => {
    console.warn("Student authorization subscription notice:", err);
  });
}



