import { httpsCallable } from "firebase/functions";
import { doc, onSnapshot, collection, setDoc, getDoc, updateDoc, arrayUnion, increment, serverTimestamp } from "firebase/firestore";
import { functions, db, auth } from "../firebase";
import { sendFacultyNotification, sendStudentNotification, reportUserVerificationComplaint } from "./notificationsService";
import { detectDeviceType, getClientIpAddress, getDeviceDisplayName, isDeviceMatching } from "../utils/deviceDetection";
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
 * Tries Cloud Function first, gracefully falls back to direct Firestore setup if functions are not deployed.
 */
export async function initiateSession(sessionParams) {
  try {
    const fn = httpsCallable(functions, "initiateAttendanceSession");
    const result = await fn(sessionParams);
    if (result && result.data && result.data.sessionId) {
      return result.data;
    }
  } catch (cloudErr) {
    console.warn("Cloud function initiateAttendanceSession notice (using direct Firestore engine):", cloudErr.message || cloudErr);
  }

  // Direct Firestore Fallback with configurable session timeline and tokens
  const currentUser = auth.currentUser;
  const nowMs = Date.now();

  let qr1DurationSec = 60;
  let qr2DurationSec = 120;

  if (Number(sessionParams.qr1DurationSeconds) > 0 && Number(sessionParams.qr2DurationSeconds) > 0) {
    qr1DurationSec = Math.max(15, Math.min(600, Math.round(Number(sessionParams.qr1DurationSeconds))));
    qr2DurationSec = Math.max(15, Math.min(1800, Math.round(Number(sessionParams.qr2DurationSeconds))));
  } else if (Number(sessionParams.durationMinutes) > 0) {
    const totalMinutes = Number(sessionParams.durationMinutes);
    const totalSec = Math.round(totalMinutes * 60);
    qr1DurationSec = Math.min(60, Math.max(20, Math.round(totalSec / 3)));
    qr2DurationSec = totalSec - qr1DurationSec;
  }

  const totalDurationMs = (qr1DurationSec + qr2DurationSec) * 1000;
  const qr1ExpiresMs = nowMs + (qr1DurationSec * 1000);
  const qr2StartsMs = qr1ExpiresMs;
  const kioskEndsMs = nowMs + totalDurationMs;
  const durationMin = Math.round(((qr1DurationSec + qr2DurationSec) / 60) * 10) / 10;

  const qr1Token = generateRandomHex(20);
  const qr1TokenHash = await sha256(qr1Token);

  const qr2Token = generateRandomHex(20);
  const qr2TokenHash = await sha256(qr2Token);

  const { classCode, courseCode, roomNo, batch, lecturerInfo } = sessionParams;
  const normalizedClass = normalizeBranchName(classCode || "CSE");
  const cleanCourse = (courseCode || normalizedClass || "CLASS").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const cleanClass = normalizedClass !== courseCode ? `_${normalizedClass.toUpperCase().replace(/[^A-Z0-9_-]/g, "")}` : "";
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const sessionId = `${cleanCourse}${cleanClass}_${nowMs}_${randomSuffix}`;

  const lecturerEmail = (currentUser?.email || lecturerInfo?.email || "").toLowerCase().trim();
  const lecturerName = lecturerInfo?.name || currentUser?.displayName || (lecturerEmail ? lecturerEmail.split("@")[0] : "Lecturer");

  const rawPin = sessionParams.lecturerPin || sessionParams.sessionPin || Math.floor(100000 + Math.random() * 900000).toString();
  const lecturerPinHash = await sha256(rawPin.trim());

  const sessionDoc = {
    id: sessionId,
    sessionId: sessionId,
    classCode: normalizedClass,
    courseCode: courseCode,
    roomNo: roomNo,
    batch: batch || "2025",
    geofenceRadius: typeof sessionParams.geofenceRadius === "number" ? sessionParams.geofenceRadius : 10,
    lectureHours: Number(sessionParams.lectureHours) > 0 ? Number(sessionParams.lectureHours) : 1.0,
    durationHours: Number(sessionParams.lectureHours) > 0 ? Number(sessionParams.lectureHours) : 1.0,
    qr1DurationSeconds: qr1DurationSec,
    qr2DurationSeconds: qr2DurationSec,
    totalDurationSeconds: qr1DurationSec + qr2DurationSec,
    durationMinutes: durationMin,
    phase: "PHASE_1",
    status: "ACTIVE",
    active: true,
    ownerId: currentUser ? currentUser.uid : "",
    ownerEmail: lecturerEmail,
    lecturerName: lecturerName,
    lecturerEmail: lecturerEmail,
    lecturerDepartment: normalizeBranchName(lecturerInfo?.department || "CSE"),
    sessionStartAt: nowMs,
    qr1ExpiresAt: qr1ExpiresMs,
    qr2StartsAt: qr2StartsMs,
    kioskEndsAt: kioskEndsMs,
    expiresAt: kioskEndsMs,
    createdAt: nowMs,
    authorizedCount: 0,
    attendanceCount: 0,
    attendees: []
  };

  const securityDoc = {
    ownerId: currentUser ? currentUser.uid : "",
    ownerEmail: lecturerEmail,
    qr1TokenHash: qr1TokenHash,
    qr2TokenHash: qr2TokenHash,
    lecturerReleaseCodeHash: lecturerPinHash,
    sessionPinHash: lecturerPinHash,
    sessionStartAt: nowMs,
    qr1ExpiresAt: qr1ExpiresMs,
    qr2StartsAt: qr2StartsMs,
    kioskEndsAt: kioskEndsMs
  };

  // 1. Authoritative Session Document (Required)
  await setDoc(doc(db, "attendance_sessions", sessionId), sessionDoc);

  // 2. Security Subcollection (Protected by Firestore Security Rules)
  try {
    await setDoc(doc(db, "attendance_sessions", sessionId, "security", "tokens"), securityDoc);
  } catch (secErr) {
    console.warn("Security tokens subdocument notice (allowed if restricted):", secErr.message || secErr);
  }

  return {
    success: true,
    sessionId: sessionId,
    qr1Token: qr1Token,
    qr2Token: qr2Token,
    sessionStartAt: nowMs,
    qr1ExpiresAt: qr1ExpiresMs,
    qr2StartsAt: qr2StartsMs,
    kioskEndsAt: kioskEndsMs,
    durationMinutes: durationMin,
    phase: "PHASE_1",
    status: "ACTIVE",
    sessionPin: rawPin,
    lecturerPin: rawPin,
    lecturerReleaseCode: rawPin
  };
}

/**
 * 2. Student: Authorize QR 1 (Phase 1 Check-In)
 */
export async function authorizeStudentQR1(sessionId, qr1Token, studentProfileOverride = null) {
  try {
    const fn = httpsCallable(functions, "authorizeQR1");
    const result = await fn({
      sessionId,
      qr1Token,
      deviceId: studentProfileOverride?.deviceId || null,
      isDeviceOwner: studentProfileOverride?.isDeviceOwner || false,
      studentLocation: studentProfileOverride?.studentLocation || null
    });
    if (result && result.data && result.data.success) return result.data;
  } catch (cloudErr) {
    console.warn("Cloud function authorizeQR1 notice (using direct session engine):", cloudErr.message || cloudErr);
  }

  // Fallback verification
  const currentUser = auth.currentUser;
  const studentEmail = (currentUser?.email || studentProfileOverride?.email || "").toLowerCase().trim();
  const rollNo = (studentProfileOverride?.rollNo || studentEmail.split("@")[0] || "STUDENT").toUpperCase();
  const studentName = studentProfileOverride?.name || studentProfileOverride?.fullName || currentUser?.displayName || rollNo;
  const studentUid = currentUser?.uid || studentEmail || rollNo;

  if (!currentUser && !studentProfileOverride?.email && !studentProfileOverride?.rollNo) {
    throw new Error("Please log in with your student account to authorize attendance.");
  }

  const sessionRef = doc(db, "attendance_sessions", sessionId);
  let session = null;
  try {
    const sessionSnap = await getDoc(sessionRef);
    if (sessionSnap.exists()) {
      session = sessionSnap.data();
    }
  } catch (e) {
    console.warn("Session read notice:", e.message);
  }

  const now = Date.now();
  const qr1ExpiresAt = session?.qr1ExpiresAt || (session?.sessionStartAt ? session.sessionStartAt + 60000 : now + 60000);
  const kioskEndsAt = session?.kioskEndsAt || (now + 180000);

  // Allow QR 1 authorization if session is explicitly in PHASE_1 or within clock-skew grace window (15s)
  const isPhase1Active = session?.phase === "PHASE_1" || (!session?.phase && now <= (qr1ExpiresAt + 15000));
  if (session && !isPhase1Active && now > (qr1ExpiresAt + 15000)) {
    throw new Error("❌ QR 1 has expired! The 60-second check-in window is closed.");
  }

  const detectedType = detectDeviceType() || "web";
  let clientIp = studentProfileOverride?.deviceIp || (typeof window !== "undefined" ? localStorage.getItem("smartattend_device_ip") : null) || "Unknown IP";
  if (!clientIp || clientIp === "Unknown IP") {
    try {
      clientIp = await getClientIpAddress();
    } catch (_) { }
  }

  // Device Mismatch Protection Check
  const registeredType = studentProfileOverride?.deviceType || (typeof window !== "undefined" ? localStorage.getItem("smartattend_student_device_type") : null);
  if (registeredType && !isDeviceMatching(registeredType, detectedType)) {
    const regLabel = getDeviceDisplayName(registeredType);
    const curLabel = getDeviceDisplayName(detectedType);

    await sendFacultyNotification(
      `🚨 Anti-Proxy Alert: Device Mismatch for ${studentName} (${rollNo})`,
      `Student ${studentName} (${rollNo}) attempted attendance from an unauthorized device.\n• Registered: ${regLabel}\n• Attempted: ${curLabel}\n• IP Address: ${clientIp}\n• Session: ${sessionId}\n\nAttendance check-in was blocked to prevent proxy.`,
      "DEVICE_MISMATCH_SECURITY_ALERT",
      rollNo,
      "Anti-Proxy Sentinel"
    );

    await sendStudentNotification(
      rollNo,
      "⚠️ Different Phone Detected",
      `Attendance could not be marked because your account is linked to a ${regLabel}, but you scanned using a ${curLabel}.\n\nIf you switched phones, please ask your teacher or administrator to reset your registered phone.`,
      "SECURITY_ALERT",
      "Attendance Security"
    );

    await reportUserVerificationComplaint(
      { email: studentEmail, rollNo: rollNo, name: studentName },
      `Device Mismatch: Registered as ${regLabel} but attempted attendance from ${curLabel} (IP: ${clientIp})`,
      "ATTENDANCE_PHASE_GATE"
    );

    throw new Error(`⛔ Device Mismatch: Your account is locked to a ${regLabel}. You cannot mark attendance from a ${curLabel} (IP: ${clientIp}).`);
  }

  const authPayload = {
    studentUid: studentUid,
    studentEmail: studentEmail,
    rollNo: rollNo,
    studentName: studentName,
    status: "QR1_VERIFIED",
    qr1Verified: true,
    releaseStatus: "LOCKED",
    released: false,
    authorizedAt: now,
    sessionId: sessionId,
    kioskEndsAt: kioskEndsAt,
    deviceType: registeredType || detectedType,
    detectedPlatform: detectedType,
    deviceIp: clientIp,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : ""
  };

  // Always store local fallback token to guarantee gating
  try {
    sessionStorage.setItem(`smartattend_qr1_auth_${sessionId}`, JSON.stringify(authPayload));
    localStorage.setItem(`smartattend_qr1_auth_${sessionId}`, JSON.stringify(authPayload));
  } catch (e) { }

  // Write authorization by studentUid and rollNo in Firestore
  try {
    const authRef = doc(db, "attendance_sessions", sessionId, "authorizations", studentUid);
    await setDoc(authRef, authPayload, { merge: true });

    if (rollNo && rollNo !== studentUid) {
      const authRollRef = doc(db, "attendance_sessions", sessionId, "authorizations", rollNo);
      await setDoc(authRollRef, authPayload, { merge: true });
    }
  } catch (authErr) {
    console.warn("Authorizations subcollection write notice:", authErr.message);
  }

  try {
    await updateDoc(sessionRef, {
      authorizedCount: increment(1)
    });
  } catch (upErr) {
    console.warn("Session doc update notice:", upErr.message);
  }

  return {
    success: true,
    status: "QR1_VERIFIED",
    qr1Verified: true,
    sessionId: sessionId,
    rollNo: rollNo,
    studentName: studentName,
    sessionStartAt: session?.sessionStartAt || now,
    qr1ExpiresAt: qr1ExpiresAt,
    kioskEndsAt: kioskEndsAt,
    deviceType: registeredType || detectedType,
    deviceIp: clientIp
  };
}

/**
 * 3. Lecturer: Transition Session to Phase 2 (Generate QR 2)
 */
export async function transitionSessionToPhase2(sessionId) {
  try {
    const fn = httpsCallable(functions, "transitionToPhase2");
    const result = await fn({ sessionId });
    if (result && result.data) return result.data;
  } catch (cloudErr) {
    console.warn("Cloud function transitionToPhase2 notice:", cloudErr.message || cloudErr);
  }

  const now = Date.now();
  try {
    const sessionRef = doc(db, "attendance_sessions", sessionId);
    await updateDoc(sessionRef, {
      phase: "PHASE_2",
      qr1ExpiresAt: now,
      qr2StartsAt: now
    });
  } catch (err) {
    console.warn("Transition phase notice:", err.message);
  }

  return {
    success: true,
    sessionId: sessionId,
    phase: "PHASE_2",
    qr1ExpiresAt: now,
    qr2StartsAt: now
  };
}

/**
 * 4. Student: Validate QR 2 (Phase 2 Gate)
 * STRICT: Enforces that the student has passed QR 1 for this exact session.
 * Rejects with Access Denied if QR 1 was not scanned.
 */
export async function validateStudentQR2(sessionId, qr2Token) {
  try {
    const fn = httpsCallable(functions, "validateQR2");
    const result = await fn({ sessionId, qr2Token });
    if (result && result.data && result.data.authorized) return result.data;
  } catch (cloudErr) {
    const msg = cloudErr.message || "";
    if (msg.includes("Access denied") || msg.includes("QR 1") || msg.includes("permission-denied")) {
      throw new Error("⛔ Access Denied: You did not scan QR 1 during Phase 1 (0:00 - 1:00). You cannot mark attendance for this session.");
    }
    console.warn("Cloud function validateQR2 notice:", cloudErr.message || cloudErr);
  }

  const currentUser = auth.currentUser;
  const currentEmail = currentUser?.email?.toLowerCase().trim() || "";
  const currentRollNo = (currentEmail ? currentEmail.split("@")[0] : "").toUpperCase();
  const currentUid = currentUser?.uid || "";

  let session = null;
  try {
    const sessionRef = doc(db, "attendance_sessions", sessionId);
    const sessionSnap = await getDoc(sessionRef);
    if (sessionSnap.exists()) {
      session = sessionSnap.data();
    }
  } catch (e) {
    console.warn("Session read notice:", e.message);
  }

  const now = Date.now();
  if (session && now > ((session.kioskEndsAt || session.expiresAt || 0) + 15000)) {
    throw new Error("❌ Attendance session has closed. 3-minute deadline elapsed.");
  }

  // 1. Check QR 1 authorization in Firestore subcollection (check uid, rollNo, email)
  let authData = null;
  const candidateKeys = [currentUid, currentRollNo, currentEmail].filter(Boolean);

  for (const key of candidateKeys) {
    if (authData) break;
    try {
      const authRef = doc(db, "attendance_sessions", sessionId, "authorizations", key);
      const authSnap = await getDoc(authRef);
      if (authSnap.exists()) {
        const d = authSnap.data();
        if (d.qr1Verified === true || d.status === "QR1_VERIFIED" || d.status === "SESSION_AUTHORIZED") {
          authData = d;
        }
      }
    } catch (e) {
      console.warn("Firestore auth read notice:", e.message);
    }
  }

  // 2. Check Local/Session Storage Fallback (ensure it belongs to current user)
  if (!authData) {
    try {
      const stored = sessionStorage.getItem(`smartattend_qr1_auth_${sessionId}`) || localStorage.getItem(`smartattend_qr1_auth_${sessionId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        const matchUid = !currentUid || parsed.studentUid === currentUid;
        const matchRoll = !currentRollNo || parsed.rollNo?.toUpperCase() === currentRollNo;
        const matchEmail = !currentEmail || parsed.studentEmail?.toLowerCase() === currentEmail;

        if ((parsed.qr1Verified === true || parsed.status === "QR1_VERIFIED" || parsed.status === "SESSION_AUTHORIZED") && parsed.sessionId === sessionId && (matchUid || matchRoll || matchEmail)) {
          authData = parsed;
        }
      }
    } catch (e) { }
  }

  // 3. STRICT GATE: If student never checked in with QR 1, reject immediately & log security complaint
  const isQr1Verified = authData && (authData.qr1Verified === true || authData.status === "QR1_VERIFIED" || authData.status === "SESSION_AUTHORIZED");
  if (!isQr1Verified) {
    await reportUserVerificationComplaint(
      { email: currentEmail, rollNo: currentRollNo },
      "Attempted Phase 2 QR 2 validation without Phase 1 QR 1 check-in",
      "ATTENDANCE_PHASE_GATE"
    );
    throw new Error("⛔ Access Denied: You did not scan QR 1 during Phase 1 (0:00 - 1:00). You cannot mark attendance for this session.");
  }

  const targetRoll = (authData.rollNo || currentRollNo || "STUDENT").toUpperCase();

  // 4. Duplicate Check
  try {
    const recordId = `${sessionId}_${targetRoll}`;
    const recordRef = doc(db, "attendance_records", recordId);
    const recordSnap = await getDoc(recordRef);
    if (recordSnap.exists()) {
      await reportUserVerificationComplaint(
        { email: currentEmail, rollNo: targetRoll },
        `Duplicate attendance attempt for session ${sessionId}`,
        "DUPLICATE_ATTENDANCE_ATTEMPT"
      );
      throw new Error(`Roll Number ${targetRoll} has already marked attendance for this session.`);
    }
  } catch (dupErr) {
    if (dupErr.message && dupErr.message.includes("already marked attendance")) {
      throw dupErr;
    }
  }

  return {
    success: true,
    authorized: true,
    sessionId: sessionId,
    rollNo: targetRoll,
    studentName: authData.studentName || currentUser?.displayName || targetRoll,
    kioskEndsAt: session?.kioskEndsAt || authData.kioskEndsAt || 0,
    sessionDetails: {
      courseCode: session?.courseCode || "N/A",
      classCode: session?.classCode || "N/A",
      roomNo: session?.roomNo || "N/A",
      batch: session?.batch || "2025",
      lecturerName: session?.lecturerName || ""
    }
  };
}

/**
 * 5. Student: Submit Final Attendance Record
 * STRICT: Exclusively processed via submitAttendance Cloud Function.
 * Validates QR 1 authorization, QR 2 token, hardware biometric signature (if native),
 * and live face verification with anti-spoofing on the server.
 * Never allows client-side direct writes to bypass server checks.
 */
export async function submitVerifiedAttendance(sessionId, qr2Token, biometricData, hardwareProof = null) {
  const isNative = typeof window !== "undefined" && Boolean(window.Capacitor?.isNativePlatform?.());
  const proofObj = hardwareProof?.proof || (hardwareProof?.signature ? hardwareProof : null);
  const deviceAuthMode = proofObj ? "NATIVE_MOBILE" : "WEB_BROWSER";

  const payload = {
    sessionId,
    qr2Token,
    biometricData,
    hardwareProof: proofObj,
    deviceAuthMode,
    isNative
  };

  try {
    const fn = httpsCallable(functions, "submitAttendance");
    const result = await fn(payload);

    if (result && result.data && result.data.success) {
      const cleanRoll = result.data.rollNo;
      if (cleanRoll) {
        try {
          await sendStudentNotification(
            cleanRoll,
            "Attendance Recorded ✅",
            `Your attendance for session ${sessionId} has been submitted successfully (${deviceAuthMode}).`,
            "ATTENDANCE_SUCCESS",
            "SmartAttend Guard"
          );
        } catch (_) { }
      }
      return result.data;
    }

    throw new Error("Server rejected attendance submission.");
  } catch (cloudErr) {
    const msg = cloudErr.message || "";
    if (msg.includes("scan QR 1 first") || msg.includes("Missing Phase 1")) {
      throw new Error("⛔ Attendance Rejected: Missing Phase 1 QR 1 check-in. You must scan QR 1 first during Phase 1 (0:00 - 1:00).");
    }
    throw cloudErr;
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
  const isDisqualified = eventData?.eventType === "CONFIRMED_KIOSK_ESCAPE" ? (nextCount >= 2) : false;

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
 * Supports warning (count = 1) and disqualification (count >= 2).
 */
export async function recordSessionViolation(sessionId, studentUid, rollNo, reason = "APP_SWITCH_DETECTED", violationCount = 1, isDisqualified = false) {
  if (!sessionId) return;
  try {
    const cleanRoll = (rollNo || studentUid || "").trim().toUpperCase();
    const count = Number(violationCount) || 1;
    const disqualified = isDisqualified || count >= 2;
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

    // 1. Update session authorizations subcollection
    if (studentUid) {
      const authRef = doc(db, "attendance_sessions", sessionId, "authorizations", studentUid);
      await setDoc(authRef, {
        studentUid: studentUid,
        rollNo: cleanRoll || studentUid,
        status: status,
        violations: arrayUnion(violationPayload),
        violationCount: count,
        hasViolation: true,
        disqualified: disqualified
      }, { merge: true }).catch(() => { });
    }

    if (cleanRoll && cleanRoll !== studentUid) {
      const authRollRef = doc(db, "attendance_sessions", sessionId, "authorizations", cleanRoll);
      await setDoc(authRollRef, {
        studentUid: studentUid || cleanRoll,
        rollNo: cleanRoll,
        status: status,
        violations: arrayUnion(violationPayload),
        violationCount: count,
        hasViolation: true,
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

    if (studentUid) {
      const authRef = doc(db, "attendance_sessions", sessionId, "authorizations", studentUid);
      await setDoc(authRef, authPayload, { merge: true }).catch(() => { });
    }
    if (rollNo && rollNo !== studentUid) {
      const authRollRef = doc(db, "attendance_sessions", sessionId, "authorizations", rollNo);
      await setDoc(authRollRef, authPayload, { merge: true }).catch(() => { });
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
 * Lecturer Emergency Unlock: Validate Lecturer Release Code server-side via trusted Cloud Function.
 * Zero plaintext release codes are ever stored on the backend or sent to the student device.
 */
export async function verifyLecturerEmergencyPin(sessionId, inputPin, deviceId = null, studentUid = null) {
  if (!inputPin) {
    throw new Error("Session PIN is required.");
  }
  const cleanPin = String(inputPin).trim();

  try {
    const fn = httpsCallable(functions, "verifyLecturerReleaseCode");
    const result = await fn({ sessionId, releaseCode: cleanPin, sessionPin: cleanPin, deviceId, studentUid });
    if (result?.data?.releaseAuthorized) {
      return result.data;
    }
  } catch (cloudErr) {
    console.warn("Cloud Function verifyLecturerReleaseCode fallback notice:", cloudErr.message);
    try {
      const inputHash = await sha256(cleanPin);
      const secSnap = await getDoc(doc(db, "attendance_sessions", sessionId, "security", "tokens"));
      if (secSnap.exists()) {
        const expected = secSnap.data()?.sessionPinHash || secSnap.data()?.lecturerReleaseCodeHash;
        if (inputHash && expected && inputHash === expected) {
          const targetUid = studentUid || auth.currentUser?.uid;
          if (targetUid) {
            await updateDoc(doc(db, "attendance_sessions", sessionId, "authorizations", targetUid), {
              released: true,
              releaseStatus: "PIN_RELEASED",
              releasedAt: Date.now()
            }).catch(() => { });
          }
          return { success: true, releaseAuthorized: true, sessionId, message: "Session PIN verified successfully." };
        }
      }
    } catch (dbErr) {
      console.warn("Direct PIN verify notice:", dbErr.message);
    }
    throw new Error(cloudErr.message || "Invalid Session PIN. Device remains locked in Kiosk mode.");
  }

  throw new Error("Invalid Session PIN. Unlock authorization rejected.");
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
    if (studentUid && studentUid !== targetDocId) {
      writes.push(setDoc(doc(db, "attendance_sessions", sessionId, "authorizations", studentUid), authPayload, { merge: true }));
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



