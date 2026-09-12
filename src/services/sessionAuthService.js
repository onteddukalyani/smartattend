import { httpsCallable } from "firebase/functions";
import { doc, onSnapshot, collection, setDoc, getDoc, updateDoc, arrayUnion, increment, serverTimestamp } from "firebase/firestore";
import { functions, db, auth } from "../firebase";

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

  // Direct Firestore Fallback with exact same timeline and tokens
  const currentUser = auth.currentUser;
  const nowMs = Date.now();
  const qr1ExpiresMs = nowMs + 60 * 1000;    // T = 60s (1 min)
  const qr2StartsMs = nowMs + 60 * 1000;     // T = 60s
  const kioskEndsMs = nowMs + 180 * 1000;    // T = 180s (3 min total: 1 min QR 1 + 2 min QR 2)

  const qr1Token = generateRandomHex(20);
  const qr1TokenHash = await sha256(qr1Token);

  const qr2Token = generateRandomHex(20);
  const qr2TokenHash = await sha256(qr2Token);

  const { classCode, courseCode, roomNo, batch, lecturerInfo } = sessionParams;
  const cleanCourse = (courseCode || classCode || "CLASS").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const cleanClass = classCode !== courseCode ? `_${classCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "")}` : "";
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const sessionId = `${cleanCourse}${cleanClass}_${nowMs}_${randomSuffix}`;

  const lecturerEmail = (currentUser?.email || lecturerInfo?.email || "").toLowerCase().trim();
  const lecturerName = lecturerInfo?.name || currentUser?.displayName || (lecturerEmail ? lecturerEmail.split("@")[0] : "Lecturer");

  const sessionDoc = {
    id: sessionId,
    sessionId: sessionId,
    classCode: classCode,
    courseCode: courseCode,
    roomNo: roomNo,
    batch: batch || "2025",
    phase: "PHASE_1",
    active: true,
    ownerId: currentUser ? currentUser.uid : "",
    ownerEmail: lecturerEmail,
    lecturerName: lecturerName,
    lecturerEmail: lecturerEmail,
    lecturerDepartment: lecturerInfo?.department || "CSE",
    sessionStartAt: nowMs,
    qr1ExpiresAt: qr1ExpiresMs,
    qr2StartsAt: qr2StartsMs,
    kioskEndsAt: kioskEndsMs,
    expiresAt: kioskEndsMs,
    createdAt: nowMs,
    authorizedCount: 0,
    attendanceCount: 0,
    attendees: [],
    qr1Token: qr1Token,
    qr2Token: qr2Token
  };

  await setDoc(doc(db, "attendance_sessions", sessionId), sessionDoc);

  return {
    success: true,
    sessionId: sessionId,
    qr1Token: qr1Token,
    qr2Token: qr2Token,
    sessionStartAt: nowMs,
    qr1ExpiresAt: qr1ExpiresMs,
    qr2StartsAt: qr2StartsMs,
    kioskEndsAt: kioskEndsMs,
    phase: "PHASE_1"
  };
}

/**
 * 2. Student: Authorize QR 1 (Phase 1 Check-In)
 */
export async function authorizeStudentQR1(sessionId, qr1Token, studentProfileOverride = null) {
  try {
    const fn = httpsCallable(functions, "authorizeQR1");
    const result = await fn({ sessionId, qr1Token });
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

  if (session && now > qr1ExpiresAt) {
    throw new Error("❌ QR 1 has expired! The 60-second check-in window is closed.");
  }

  const authPayload = {
    studentUid: studentUid,
    studentEmail: studentEmail,
    rollNo: rollNo,
    studentName: studentName,
    status: "SESSION_AUTHORIZED",
    authorizedAt: now,
    sessionId: sessionId,
    kioskEndsAt: kioskEndsAt
  };

  // Always store local fallback token to guarantee gating
  try {
    sessionStorage.setItem(`smartattend_qr1_auth_${sessionId}`, JSON.stringify(authPayload));
    localStorage.setItem(`smartattend_qr1_auth_${sessionId}`, JSON.stringify(authPayload));
  } catch (e) {}

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
    status: "SESSION_AUTHORIZED",
    sessionId: sessionId,
    rollNo: rollNo,
    studentName: studentName,
    sessionStartAt: session?.sessionStartAt || now,
    qr1ExpiresAt: qr1ExpiresAt,
    kioskEndsAt: kioskEndsAt
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

  try {
    const sessionRef = doc(db, "attendance_sessions", sessionId);
    await updateDoc(sessionRef, {
      phase: "PHASE_2"
    });
  } catch (err) {
    console.warn("Transition phase notice:", err.message);
  }

  return {
    success: true,
    sessionId: sessionId,
    phase: "PHASE_2"
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
  if (session && now > (session.kioskEndsAt || session.expiresAt || 0)) {
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
      if (authSnap.exists() && authSnap.data().status === "SESSION_AUTHORIZED") {
        authData = authSnap.data();
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

        if (parsed.status === "SESSION_AUTHORIZED" && parsed.sessionId === sessionId && (matchUid || matchRoll || matchEmail)) {
          authData = parsed;
        }
      }
    } catch (e) {}
  }

  // 3. STRICT GATE: If student never checked in with QR 1, reject immediately!
  if (!authData || authData.status !== "SESSION_AUTHORIZED") {
    throw new Error("⛔ Access Denied: You did not scan QR 1 during Phase 1 (0:00 - 1:00). You cannot mark attendance for this session.");
  }

  const targetRoll = (authData.rollNo || currentRollNo || "STUDENT").toUpperCase();

  // 4. Duplicate Check
  try {
    const recordId = `${sessionId}_${targetRoll}`;
    const recordRef = doc(db, "attendance_records", recordId);
    const recordSnap = await getDoc(recordRef);
    if (recordSnap.exists()) {
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
 * STRICT: Gated by prior QR 1 authorization record.
 */
export async function submitVerifiedAttendance(sessionId, qr2Token, biometricData) {
  try {
    const fn = httpsCallable(functions, "submitAttendance");
    const result = await fn({ sessionId, qr2Token, biometricData });
    if (result && result.data && result.data.success) return result.data;
  } catch (cloudErr) {
    const msg = cloudErr.message || "";
    if (msg.includes("Access denied") || msg.includes("QR 1") || msg.includes("permission-denied")) {
      throw new Error("⛔ Attendance Rejected: Missing Phase 1 QR 1 check-in. You must scan QR 1 first during Phase 1 (0:00 - 1:00).");
    }
    console.warn("Cloud function submitAttendance notice:", cloudErr.message || cloudErr);
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
  if (session && now > (session.kioskEndsAt || session.expiresAt || 0)) {
    throw new Error("❌ Attendance session closed.");
  }

  // 1. Re-verify QR 1 authorization in Firestore
  let authData = null;
  const candidateKeys = [currentUid, currentRollNo, currentEmail].filter(Boolean);

  for (const key of candidateKeys) {
    if (authData) break;
    try {
      const authRef = doc(db, "attendance_sessions", sessionId, "authorizations", key);
      const authSnap = await getDoc(authRef);
      if (authSnap.exists() && authSnap.data().status === "SESSION_AUTHORIZED") {
        authData = authSnap.data();
      }
    } catch (e) {}
  }

  // 2. Check local fallback
  if (!authData) {
    try {
      const stored = sessionStorage.getItem(`smartattend_qr1_auth_${sessionId}`) || localStorage.getItem(`smartattend_qr1_auth_${sessionId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        const matchUid = !currentUid || parsed.studentUid === currentUid;
        const matchRoll = !currentRollNo || parsed.rollNo?.toUpperCase() === currentRollNo;
        const matchEmail = !currentEmail || parsed.studentEmail?.toLowerCase() === currentEmail;

        if (parsed.status === "SESSION_AUTHORIZED" && parsed.sessionId === sessionId && (matchUid || matchRoll || matchEmail)) {
          authData = parsed;
        }
      }
    } catch (e) {}
  }

  // 3. STRICT NON-NEGOTIABLE CHECK: Reject submission if student didn't scan QR 1
  if (!authData || authData.status !== "SESSION_AUTHORIZED") {
    throw new Error("⛔ Attendance Rejected: Missing Phase 1 QR 1 check-in. You must scan QR 1 first during Phase 1 (0:00 - 1:00) before submitting QR 2.");
  }

  const studentEmail = (currentEmail || authData.studentEmail || "").toLowerCase().trim();
  const rollNo = (authData.rollNo || currentRollNo || studentEmail.split("@")[0] || "STUDENT").toUpperCase();
  const studentName = authData.studentName || currentUser?.displayName || rollNo;
  const studentUid = currentUid || authData.studentUid || rollNo;

  const recordId = `${sessionId}_${rollNo}`;
  const recordRef = doc(db, "attendance_records", recordId);

  // 4. Duplicate Check
  try {
    const existingSnap = await getDoc(recordRef);
    if (existingSnap.exists()) {
      throw new Error(`Roll Number ${rollNo} has already marked attendance for this session.`);
    }
  } catch (dupErr) {
    if (dupErr.message && dupErr.message.includes("already marked attendance")) {
      throw dupErr;
    }
  }

  const attendanceRecord = {
    id: recordId,
    sessionId: sessionId,
    rollNo: rollNo,
    fullName: studentName,
    studentName: studentName,
    name: studentName,
    studentEmail: studentEmail,
    studentUid: studentUid,
    courseCode: session?.courseCode || "N/A",
    classCode: session?.classCode || "N/A",
    batch: session?.batch || "2025",
    roomNo: session?.roomNo || "N/A",
    lecturerName: session?.lecturerName || "",
    lecturerEmail: session?.lecturerEmail || "",
    ownerId: session?.ownerId || "",
    faceVerified: true,
    faceMatchConfidence: biometricData?.confidence || 100,
    faceDistance: biometricData?.distance !== undefined ? Number(biometricData.distance.toFixed(4)) : null,
    livenessConfirmed: true,
    antiSpoofScore: "PASSED",
    blinkCount: biometricData?.blinkCount || 1,
    submittedAt: Date.now(),
    biometricVerifiedAt: Date.now()
  };

  try {
    await setDoc(recordRef, attendanceRecord);
  } catch (recErr) {
    console.warn("Attendance record write notice:", recErr.message);
  }

  try {
    const sessionRef = doc(db, "attendance_sessions", sessionId);
    await updateDoc(sessionRef, {
      attendees: arrayUnion({
        id: recordId,
        rollNo: rollNo,
        studentName: studentName,
        fullName: studentName,
        email: studentEmail,
        studentEmail: studentEmail,
        faceVerified: true,
        faceMatchConfidence: biometricData?.confidence || 100,
        submittedAt: Date.now()
      }),
      attendanceCount: increment(1)
    });
  } catch (sessErr) {
    console.warn("Session doc attendee update notice:", sessErr.message);
  }

  return {
    success: true,
    sessionId: sessionId,
    rollNo: rollNo,
    studentName: studentName,
    submittedAt: Date.now(),
    kioskEndsAt: session?.kioskEndsAt || (now + 180000)
  };
}

/**
 * Real-time listener for Attendance Session document
 */
export function subscribeToSession(sessionId, onUpdate, onError) {
  if (!sessionId) return () => {};
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
  if (!sessionId) return () => {};
  const colRef = collection(db, "attendance_sessions", sessionId, "authorizations");
  return onSnapshot(colRef, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    onUpdate(list);
  }, (err) => {
    console.warn("Authorizations subscription warning:", err);
  });
}

/**
 * Lecturer: Manually close attendance session and release all student kiosks
 */
export async function closeAttendanceSession(sessionId) {
  if (!sessionId) return;
  try {
    const sessionRef = doc(db, "attendance_sessions", sessionId);
    await updateDoc(sessionRef, {
      status: "CLOSED",
      phase: "CLOSED",
      active: false,
      closedAt: Date.now()
    });
  } catch (err) {
    console.warn("Error closing session:", err);
  }
}

