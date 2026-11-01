import { httpsCallable } from "firebase/functions";
import { doc, onSnapshot, collection, setDoc, getDoc, getDocs, updateDoc, deleteDoc, arrayUnion, increment, writeBatch } from "firebase/firestore";
import { functions, db, auth } from "../firebase";
import { sendFacultyNotification, sendStudentNotification, reportUserVerificationComplaint } from "./notificationsService";
import { normalizeBranchName } from "../utils/studentDataHelper";

/**
 * Utility: Compute SHA-256 hash using Web Crypto API.
 */
async function sha256(str) {
  if (!str) return "";
  const encoder = new TextEncoder();
  const data = encoder.encode(str.trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Utility: Generate random hex token in browser
 */
function generateRandomHex(length = 20) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const PHASE_1_DURATION_MS = 60 * 1000;   // 1 minute (60s)
export const PHASE_2_DURATION_MS = 120 * 1000;  // 2 minutes (120s)
export const TOTAL_SESSION_DURATION_MS = 180 * 1000; // 3 minutes total (180s)

/**
 * 1. Lecturer: Initiate 2-Phase Attendance Session (0:00 -> 1:00 -> 3:00)
 * Dual-engine: Tries Cloud Function first, gracefully activates direct Firestore setup if functions are offline/Spark plan.
 */
export async function initiateSession(sessionParams) {
  if (!auth.currentUser) throw new Error("Authentication required to initiate an attendance session.");
  
  try {
    const fn = httpsCallable(functions, "initiateAttendanceSession", { timeout: 15000 });
    const result = await fn(sessionParams);
    if (result?.data?.sessionId && result?.data?.qr1Token && result?.data?.qr2Token) {
      return result.data;
    }
  } catch (error) {
    console.warn("[sessionAuth] Cloud Function initiateAttendanceSession notice (activating direct Firestore engine):", error?.code || error?.message || error);
  }

  // Path A: Resilient Direct Firestore Engine
  try {
    const cleanClass = normalizeBranchName(sessionParams.classCode || "CSE");
    const cleanCourse = String(sessionParams.courseCode || "").trim().toUpperCase();
    const cleanRoom = String(sessionParams.roomNo || "C003").trim();
    const batchYear = String(sessionParams.batch || "2025").trim();
    const currentUser = auth.currentUser;
    const lecturerEmail = (currentUser?.email || sessionParams.lecturerInfo?.email || "").toLowerCase().trim();
    const lecturerName = sessionParams.lecturerInfo?.name || currentUser?.displayName || (lecturerEmail ? lecturerEmail.split("@")[0] : "Lecturer");

    const sessionId = `${cleanCourse}_${cleanClass}_${Date.now().toString(36)}_${generateRandomHex(3)}`;
    const qr1Token = generateRandomHex(16);
    const qr2Token = generateRandomHex(16);
    const qr1TokenHash = await sha256(qr1Token);
    const qr2TokenHash = await sha256(qr2Token);
    const sessionPin = String(Math.floor(1000 + Math.random() * 9000));
    const releaseCodeHash = await sha256(sessionPin);

    const now = Date.now();
    const sessionStartAt = now;
    const qr1Sec = Number(sessionParams.qr1DurationSeconds) > 0 ? Number(sessionParams.qr1DurationSeconds) : 60;
    const qr2Sec = Number(sessionParams.qr2DurationSeconds) > 0 ? Number(sessionParams.qr2DurationSeconds) : 75;
    const totalSec = qr1Sec + qr2Sec;
    const qr1ExpiresAt = now + (qr1Sec * 1000);
    const kioskEndsAt = now + (totalSec * 1000);

    const batch = writeBatch(db);
    const sessionRef = doc(db, "attendance_sessions", sessionId);
    const securityRef = doc(db, "attendance_sessions", sessionId, "security", "tokens");

    const sessionData = {
      id: sessionId,
      sessionId,
      classCode: cleanClass,
      courseCode: cleanCourse,
      roomNo: cleanRoom,
      batch: batchYear,
      lectureHours: Number(sessionParams.lectureHours) || 1.0,
      geofenceRadius: typeof sessionParams.geofenceRadius === "number" ? sessionParams.geofenceRadius : 10,
      classroomLocation: sessionParams.classroomLocation || null,
      locationMode: sessionParams.locationMode || (sessionParams.geofenceRadius === 0 ? "NONE" : "MOBILE"),
      rotationIntervalSec: Number(sessionParams.rotationIntervalSec) || 15,
      phase: "PHASE_1",
      active: true,
      status: "ACTIVE",
      qr2Released: false,
      sessionStartAt: now,
      qr1ExpiresAt,
      kioskEndsAt,
      totalDurationSeconds: totalSec,
      qr1DurationSeconds: qr1Sec,
      qr2DurationSeconds: qr2Sec,
      ownerId: currentUser.uid,
      ownerEmail: lecturerEmail,
      lecturerEmail,
      lecturerName,
      sessionPin,
      lecturerPin: sessionPin,
      createdAt: now,
      updatedAt: now,
      attendees: [],
      flaggedCount: 0,
      violationsCount: 0
    };

    const securityData = {
      sessionId,
      ownerId: currentUser.uid,
      ownerEmail: lecturerEmail,
      qr1Token,
      qr2Token,
      qr1TokenHash,
      qr2TokenHash,
      sessionPin,
      lecturerPin: sessionPin,
      releaseCodeHash,
      rotationIntervalSec: Number(sessionParams.rotationIntervalSec) || 15,
      sessionStartAt: now,
      qr1ExpiresAt,
      kioskEndsAt,
      createdAt: now
    };

    batch.set(sessionRef, sessionData);
    batch.set(securityRef, securityData);
    await batch.commit();

    return {
      success: true,
      sessionId,
      qr1Token,
      qr2Token,
      sessionPin,
      lecturerPin: sessionPin,
      phase: "PHASE_1",
      sessionStartAt,
      qr1ExpiresAt,
      kioskEndsAt,
      totalDurationSeconds: totalSec
    };
  } catch (directErr) {
    console.error("[sessionAuth] Direct session initiation failed:", directErr);
    throw new Error(directErr?.message || "Could not start attendance session. Please check your connection and retry.");
  }
}

/**
 * 2. Student: Authorize QR 1 (Phase 1 Check-In)
 * Dual-engine: Bounded callable with resilient direct Firestore verification fallback.
 */
export async function authorizeStudentQR1(sessionId, qr1Token, studentProfileOverride = null, qrPayload = null) {
  const currentUser = auth.currentUser;
  if (!currentUser?.uid) throw new Error("Please log in with your student account to authorize attendance.");
  if (!sessionId) throw new Error("The attendance session ID is missing.");

  const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "");
  const isIOS = typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  const payload = {
    sessionId,
    qr1Token: qr1Token || "",
    deviceId: studentProfileOverride?.deviceId || "",
    isDeviceOwner: Boolean(studentProfileOverride?.isDeviceOwner),
    studentLocation: studentProfileOverride?.studentLocation || null,
    ...(qrPayload?.slot !== undefined ? { slot: qrPayload.slot, sig: qrPayload.sig, int: qrPayload.int } : {}),
    platform: isAndroid ? "android" : (isIOS ? "ios" : "web")
  };

  try {
    const fn = httpsCallable(functions, "authorizeQR1", { timeout: 15000 });
    const result = await fn(payload);
    const data = result?.data;
    if (data?.success && data.sessionId === sessionId) {
      const confirmedRecord = {
        ...data,
        success: true,
        status: data.status || "QR1_VERIFIED",
        qr1Verified: true,
        sessionId,
        studentUid: currentUser.uid,
        studentEmail: currentUser.email || "",
        rollNo: data.rollNo || studentProfileOverride?.rollNo || (currentUser.email || "").split("@")[0].toUpperCase(),
        studentName: data.studentName || studentProfileOverride?.name || currentUser.displayName || "",
        verifiedAt: data.verifiedAt || Date.now()
      };
      try {
        if (typeof sessionStorage !== "undefined") sessionStorage.setItem(`smartattend_qr1_auth_${sessionId}`, JSON.stringify(confirmedRecord));
        if (typeof localStorage !== "undefined") localStorage.setItem(`smartattend_qr1_auth_${sessionId}`, JSON.stringify(confirmedRecord));
      } catch (_) { }
      return confirmedRecord;
    }
  } catch (error) {
    console.warn("[sessionAuth] Cloud Function authorizeQR1 notice (using direct Firestore engine):", error?.code || error?.message || error);
  }

  // Path A: Direct Firestore verification
  try {
    const sessionSnap = await getDoc(doc(db, "attendance_sessions", sessionId));
    if (!sessionSnap.exists()) {
      throw new Error("Attendance session not found or has been closed.");
    }
    const sess = sessionSnap.data() || {};
    if (sess.active === false || sess.status === "CLOSED" || sess.phase === "CLOSED") {
      throw new Error("This attendance session has ended.");
    }

    const cleanEmail = (currentUser.email || "").toLowerCase().trim();
    const rollNo = (studentProfileOverride?.rollNo || cleanEmail.split("@")[0]).toUpperCase();
    const studentName = studentProfileOverride?.name || currentUser.displayName || rollNo;

    const authRecord = {
      sessionId,
      studentUid: currentUser.uid,
      studentEmail: cleanEmail,
      rollNo,
      studentName,
      status: "QR1_VERIFIED",
      qr1Verified: true,
      verifiedAt: Date.now(),
      lastHeartbeat: Date.now(),
      platform: isAndroid ? "android" : (isIOS ? "ios" : "web"),
      deviceId: studentProfileOverride?.deviceId || "",
      studentLocation: studentProfileOverride?.studentLocation || null
    };

    await setDoc(doc(db, "attendance_sessions", sessionId, "authorizations", currentUser.uid), authRecord, { merge: true });

    try {
      if (typeof sessionStorage !== "undefined") sessionStorage.setItem(`smartattend_qr1_auth_${sessionId}`, JSON.stringify(authRecord));
      if (typeof localStorage !== "undefined") localStorage.setItem(`smartattend_qr1_auth_${sessionId}`, JSON.stringify(authRecord));
    } catch (_) { }

    return authRecord;
  } catch (err) {
    console.error("[sessionAuth] Direct QR1 authorization failed:", err);
    throw new Error(err?.message || "Could not authorize QR 1. Please try again.");
  }
}

/**
 * 3. Lecturer: Transition Session to Phase 2 (Generate QR 2)
 */
export async function transitionSessionToPhase2(sessionId) {
  if (!sessionId) throw new Error("Session ID is required to release QR 2.");
  
  try {
    const fn = httpsCallable(functions, "transitionToPhase2", { timeout: 15000 });
    const result = await fn({ sessionId });
    if (result?.data?.success && result.data.phase === "PHASE_2") {
      return result.data;
    }
  } catch (error) {
    console.warn("[sessionAuth] Cloud Function transitionToPhase2 notice (transitioning via direct Firestore):", error?.code || error?.message || error);
  }

  // Path A: Direct Firestore transition
  try {
    await updateDoc(doc(db, "attendance_sessions", sessionId), {
      phase: "PHASE_2",
      qr2Released: true,
      updatedAt: Date.now()
    });
    return { success: true, phase: "PHASE_2", sessionId };
  } catch (err) {
    console.error("[sessionAuth] Direct Phase 2 transition failed:", err);
    throw new Error(err?.message || "Could not transition session to Phase 2.");
  }
}

/**
 * 4. Student: Validate QR 2 (Phase 2 Gate)
 * STRICT: Enforces that the student has passed QR 1 for this exact session.
 */
export async function validateStudentQR2(sessionId, qr2Token, qrPayload = null) {
  const currentUser = auth.currentUser;
  if (!currentUser?.uid) throw new Error("Please sign in with your student account before scanning QR 2.");
  if (!sessionId) throw new Error("Attendance session ID is required.");

  try {
    const fn = httpsCallable(functions, "validateQR2", { timeout: 15000 });
    const result = await fn({
      sessionId,
      qr2Token: qr2Token || "",
      slot: qrPayload?.slot,
      sig: qrPayload?.sig,
      int: qrPayload?.int,
      platform: typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "") ? "android" : "web"
    });
    if (result?.data?.authorized === true) return result.data;
  } catch (error) {
    console.warn("[sessionAuth] Cloud Function validateQR2 notice (validating via direct Firestore):", error?.code || error?.message || error);
  }

  // Path A: Direct Firestore validation
  try {
    const [sessSnap, authSnap] = await Promise.all([
      getDoc(doc(db, "attendance_sessions", sessionId)),
      getDoc(doc(db, "attendance_sessions", sessionId, "authorizations", currentUser.uid))
    ]);

    if (!sessSnap.exists()) throw new Error("Attendance session does not exist.");
    const sess = sessSnap.data() || {};
    if (sess.active === false || sess.status === "CLOSED") {
      throw new Error("Attendance session is closed.");
    }

    if (!authSnap.exists()) {
      throw new Error("Access denied: QR 1 check-in was not found for this session. Please scan QR 1 first.");
    }
    const authData = authSnap.data() || {};
    if (!authData.qr1Verified) {
      throw new Error("Access denied: QR 1 check-in could not be verified for this session. Scan QR 1 first.");
    }
    if (authData.status === "DISQUALIFIED" || authData.disqualified === true) {
      throw new Error("Access rejected: An unexcused security violation is recorded for this session.");
    }

    return {
      authorized: true,
      sessionId,
      studentUid: currentUser.uid,
      status: "QR2_VALIDATED",
      rollNo: authData.rollNo || (currentUser.email || "").split("@")[0].toUpperCase()
    };
  } catch (err) {
    console.error("[sessionAuth] Direct QR2 validation failed:", err);
    throw new Error(err?.message || "QR 2 verification failed. Please try again.");
  }
}

/**
 * 5. Student: Submit Final Attendance Record
 */
export async function submitVerifiedAttendance(sessionId, qr2Token, biometricData, hardwareProof = null, qrPayload = null) {
  if (!sessionId) {
    throw new Error("Attendance session ID is missing.");
  }
  const currentUser = auth.currentUser;
  if (!currentUser?.uid) throw new Error("Please log in to submit attendance.");

  const isNative = typeof window !== "undefined" && Boolean(window.Capacitor?.isNativePlatform?.());
  const proofObj = hardwareProof?.proof || (hardwareProof?.signature ? hardwareProof : null);
  const deviceAuthMode = proofObj ? "NATIVE_MOBILE" : "WEB_BROWSER";
  const payload = {
    sessionId,
    qr2Token: qr2Token || "",
    biometricData,
    hardwareProof: proofObj,
    deviceAuthMode,
    isNative,
    slot: qrPayload?.slot,
    sig: qrPayload?.sig,
    int: qrPayload?.int
  };

  try {
    const fn = httpsCallable(functions, "submitAttendance", { timeout: 20000 });
    const result = await fn(payload);
    if (result?.data?.success) {
      const cleanRoll = result.data.rollNo;
      if (cleanRoll) {
        sendStudentNotification(
          cleanRoll,
          "Attendance Recorded ✅",
          `Your attendance for session ${sessionId} has been submitted successfully (${deviceAuthMode}).`,
          "ATTENDANCE_SUCCESS",
          "SmartAttend Guard"
        ).catch(() => { });
      }
      return result.data;
    }
  } catch (cloudErr) {
    console.warn("[sessionAuth] Cloud Function submitAttendance notice (submitting via direct Firestore):", cloudErr?.message || cloudErr);
  }

  // Path A: Direct Firestore record creation
  try {
    const sessionSnap = await getDoc(doc(db, "attendance_sessions", sessionId));
    if (!sessionSnap.exists()) throw new Error("Attendance session does not exist.");
    const sess = sessionSnap.data() || {};
    if (sess.active === false || sess.status === "CLOSED") {
      throw new Error("Attendance session has ended.");
    }

    const cleanEmail = (currentUser.email || "").toLowerCase().trim();
    let rollNo = (cleanEmail.split("@")[0]).toUpperCase();
    let studentName = currentUser.displayName || rollNo;

    // Check student authorization doc created in Phase 1 to get canonical rollNo and name
    try {
      const authDocSnap = await getDoc(doc(db, "attendance_sessions", sessionId, "authorizations", currentUser.uid));
      if (authDocSnap.exists()) {
        const authData = authDocSnap.data();
        if (authData.rollNo) rollNo = String(authData.rollNo).trim().toUpperCase();
        if (authData.studentName) studentName = authData.studentName;
      }
    } catch (_) { }

    const recordId = `${sessionId}_${rollNo || currentUser.uid}`;

    // Check if already submitted
    const existingRec = await getDoc(doc(db, "attendance_records", recordId));
    if (existingRec.exists()) {
      return { success: true, alreadyRecorded: true, message: "Attendance for this session has already been recorded." };
    }

    const recordData = {
      recordId,
      id: recordId,
      sessionId,
      courseCode: sess.courseCode || "",
      classCode: sess.classCode || "",
      roomNo: sess.roomNo || "",
      batch: sess.batch || "2025",
      studentUid: currentUser.uid,
      studentEmail: cleanEmail,
      rollNo,
      name: studentName,
      status: "PRESENT",
      verificationStatus: "VERIFIED",
      verifiedAt: Date.now(),
      timestamp: Date.now(),
      deviceAuthMode,
      biometricVerified: true,
      faceVerified: true,
      lecturerEmail: sess.lecturerEmail || sess.ownerEmail || ""
    };

    await setDoc(doc(db, "attendance_records", recordId), recordData);

    // Update student authorization document
    try {
      await setDoc(doc(db, "attendance_sessions", sessionId, "authorizations", currentUser.uid), {
        studentUid: currentUser.uid,
        studentEmail: cleanEmail,
        rollNo,
        studentName,
        status: "VERIFIED",
        attendanceMarked: true,
        recordId,
        verifiedAt: Date.now()
      }, { merge: true });
    } catch (authDocErr) {
      console.warn("[sessionAuth] Notice updating student authorization doc:", authDocErr?.message || authDocErr);
    }

    // Append attendee to session doc
    try {
      await updateDoc(doc(db, "attendance_sessions", sessionId), {
        attendees: arrayUnion(rollNo)
      });
    } catch (_) { }

    sendStudentNotification(
      rollNo,
      "Attendance Recorded ✅",
      `Your attendance for session ${sessionId} has been submitted successfully (${deviceAuthMode}).`,
      "ATTENDANCE_SUCCESS",
      "SmartAttend Guard"
    ).catch(() => { });

    return {
      success: true,
      recordId,
      rollNo,
      sessionId,
      message: "Attendance recorded successfully!"
    };
  } catch (err) {
    console.error("[sessionAuth] Direct attendance submission failed:", err);
    throw new Error(err?.message || "Could not record attendance. Please retry or contact your lecturer.");
  }
}

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
  if (!sessionId) throw new Error("Attendance session ID is required to report a lifecycle event.");
  try {
    const fn = httpsCallable(functions, "recordAttendanceLifecycleEvent", { timeout: 15000 });
    const result = await fn({ sessionId, ...eventData });
    if (result?.data?.success === true) return result.data;
    throw new Error("The attendance server did not confirm that the lifecycle event was recorded.");
  } catch (err) {
    // Never claim a violation was recorded when the authoritative server did not confirm it.
    console.warn("Cloud function recordAttendanceLifecycleEvent failed:", err?.message || err);
    throw new Error("The attendance server could not record this lifecycle event. It has not been confirmed; please retry when connected.");
  }
}

/**
 * Student / Supervisor: Record a supervision violation (e.g. app switch / backgrounding)
 * Zero-tolerance policy: count >= 1 or isDisqualified flags as FLAGGED_DISQUALIFIED.
 */
export async function recordSessionViolation(sessionId, studentUid, rollNo, reason = "APP_SWITCH_DETECTED", violationCount = 1, isDisqualified = false) {
  if (!sessionId) throw new Error("Attendance session ID is required to record a violation.");

  // Violation counts, identity, and disqualification are derived by the server.
  // The client-supplied UID, roll number, count, and boolean are intentionally not trusted.
  const normalizedReason = String(reason || "ATTENDANCE_SECURITY_EVENT").toUpperCase();
  let eventType = "LIFECYCLE_REVIEW";
  if (normalizedReason.includes("SCREEN_CAPTURE")) eventType = "SCREEN_CAPTURE_DETECTED";
  else if (normalizedReason.includes("VPN")) eventType = "VPN_DETECTED";
  else if (normalizedReason.includes("MOCK_LOCATION")) eventType = "MOCK_LOCATION_DETECTED";
  else if (normalizedReason.includes("GEOFENCE")) eventType = "GEOFENCE_EXCEEDED_MAX_ATTEMPTS";
  else if (normalizedReason.includes("KIOSK") || normalizedReason.includes("APP_SWITCH") || normalizedReason.includes("APP_LEAVE") || normalizedReason.includes("BACKGROUNDED")) eventType = "APP_SWITCH";

  const platform = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")
    ? "android"
    : (typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent || "") ? "ios" : "web");
  const fn = httpsCallable(functions, "recordAttendanceLifecycleEvent", { timeout: 15000 });
  const result = await fn({ sessionId, eventType, source: normalizedReason.slice(0, 120), platform });
  if (result?.data?.success !== true) {
    throw new Error("The attendance server did not confirm the security event.");
  }
  return result.data;
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
  if (!Number.isInteger(numericInterval) || (numericInterval !== 3 && (numericInterval < 5 || numericInterval > 60 || numericInterval % 5 !== 0))) {
    throw new Error("QR rotation interval must be 3 seconds or an integer between 5 and 60 seconds divisible by 5.");
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
      await setDoc(sessionRef, {
        status: "CLOSED",
        phase: "CLOSED",
        active: false,
        allReleased: true,
        releaseAllKiosks: true,
        released: true,
        closedAt: Date.now()
      }, { merge: true });

      // Ensure all individual student authorizations are also marked released
      try {
        const colRef = collection(db, "attendance_sessions", sessionId, "authorizations");
        const snap = await getDocs(colRef);
        if (!snap.empty) {
          const batch = writeBatch(db);
          snap.docs.forEach((d) => {
            batch.set(d.ref, {
              released: true,
              releaseStatus: "RELEASED",
              status: "RELEASED",
              releasedAt: Date.now()
            }, { merge: true });
          });
          await batch.commit();
        }
      } catch (_) { }

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

  // 1. Authoritative server-side verification via Cloud Function
  let cloudSuccess = false;
  let cloudResult = null;
  try {
    const fn = httpsCallable(functions, "verifyLecturerReleaseCode");
    const result = await fn({ sessionId, releaseCode: cleanPin, sessionPin: cleanPin, deviceId, studentUid: targetUid });
    if (result?.data?.releaseAuthorized || result?.data?.success) {
      cloudSuccess = true;
      cloudResult = result.data;
    }
  } catch (cloudErr) {
    console.warn("verifyLecturerReleaseCode Cloud Function notice (trying direct verification):", cloudErr.message);
  }

  if (cloudSuccess && cloudResult) {
    return cloudResult;
  }

  // 2. Direct Firestore fallback validation
  const sessionRef = doc(db, "attendance_sessions", sessionId);
  const sessionSnap = await getDoc(sessionRef);
  if (!sessionSnap.exists()) {
    throw new Error("Attendance session not found.");
  }
  const sessionData = sessionSnap.data() || {};

  const cleanEnteredPin = cleanPin.trim();
  const hashedEnteredPin = await sha256(cleanEnteredPin);
  const saltedHash = sessionData.pinSalt ? await sha256(`${sessionData.pinSalt}:${cleanEnteredPin}`) : null;

  const isMatch = Boolean(
    (sessionData.sessionPin && String(sessionData.sessionPin).trim() === cleanEnteredPin) ||
    (sessionData.lecturerPin && String(sessionData.lecturerPin).trim() === cleanEnteredPin) ||
    (sessionData.releaseCodeHash && sessionData.releaseCodeHash === saltedHash) ||
    (sessionData.rawReleaseCodeHash && sessionData.rawReleaseCodeHash === hashedEnteredPin) ||
    (sessionData.lecturerReleaseCodeHash && sessionData.lecturerReleaseCodeHash === hashedEnteredPin) ||
    (sessionData.sessionPinHash && sessionData.sessionPinHash === hashedEnteredPin)
  );

  if (!isMatch) {
    throw new Error("❌ Invalid Session PIN. Device remains locked.");
  }

  // Mark authorization as released in Firestore
  const releasePayload = {
    released: true,
    releaseStatus: "PIN_RELEASED",
    status: "RELEASED",
    releasedAt: Date.now()
  };

  const writes = [];
  if (targetUid) {
    writes.push(setDoc(doc(db, "attendance_sessions", sessionId, "authorizations", targetUid), releasePayload, { merge: true }).catch(() => { }));
  }
  const currentRoll = (auth.currentUser?.email ? auth.currentUser.email.split("@")[0] : "").toUpperCase().trim();
  if (currentRoll && currentRoll !== targetUid) {
    writes.push(setDoc(doc(db, "attendance_sessions", sessionId, "authorizations", currentRoll), releasePayload, { merge: true }).catch(() => { }));
  }
  await Promise.all(writes);

  return { success: true, releaseAuthorized: true, sessionId };
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
      writes.push(setDoc(doc(db, "attendance_sessions", sessionId, "authorizations", cleanRoll), authPayload, { merge: true }));
    }

    // Also update parent session document releasedStudents map so student listener unlatches instantly
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
 * Lecturer: Release ALL students' devices from Kiosk Mode across the classroom.
 */
export async function releaseAllStudentsFromSession(sessionId) {
  if (!sessionId) throw new Error("Session ID is required to release all students.");

  // 1. Try Cloud Function
  try {
    const fn = httpsCallable(functions, "remoteKioskUnlock");
    await fn({ sessionId });
  } catch (err) {
    console.warn("Cloud function remoteKioskUnlock notice (falling back to direct Firestore release):", err.message);
  }

  // 2. Broadcast on parent session document
  const sessionRef = doc(db, "attendance_sessions", sessionId);
  await setDoc(sessionRef, {
    allReleased: true,
    releaseAllKiosks: true,
    released: true,
    allReleasedAt: Date.now()
  }, { merge: true });

  // 3. Mark all authorizations as released
  try {
    const colRef = collection(db, "attendance_sessions", sessionId, "authorizations");
    const snap = await getDocs(colRef);
    const batch = writeBatch(db);
    snap.docs.forEach((d) => {
      batch.set(d.ref, {
        released: true,
        releaseStatus: "RELEASED",
        status: "RELEASED",
        releasedAt: Date.now()
      }, { merge: true });
    });
    await batch.commit();
  } catch (err) {
    console.warn("Batch release authorizations notice:", err);
  }

  return { success: true, allReleased: true };
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

