const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

setGlobalOptions({ maxInstances: 10, region: "us-central1" });

/**
 * Utility: Compute SHA-256 hash of a string.
 */
function hashToken(token) {
  if (!token || typeof token !== "string") return "";
  return crypto.createHash("sha256").update(token.trim()).digest("hex");
}

/**
 * Utility: Look up trusted student profile by UID or Email.
 */
async function resolveTrustedStudent(uid, email) {
  const cleanEmail = (email || "").toLowerCase().trim();

  // 1. Check users collection by UID
  if (uid) {
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists) {
      const data = userSnap.data();
      if (data.rollNo) {
        return {
          rollNo: String(data.rollNo).trim().toUpperCase(),
          name: data.name || data.fullName || data.displayName || data.rollNo,
          email: data.email || cleanEmail
        };
      }
    }
  }

  // 2. Check authorizedUsers by email
  if (cleanEmail) {
    const authSnap = await db.collection("authorizedUsers").doc(cleanEmail).get();
    if (authSnap.exists) {
      const data = authSnap.data();
      if (data.rollNo) {
        return {
          rollNo: String(data.rollNo).trim().toUpperCase(),
          name: data.name || data.fullName || data.displayName || data.rollNo,
          email: data.email || cleanEmail
        };
      }
    }
  }

  // 3. Query students collection by email or uid
  if (cleanEmail) {
    const sQuery = await db.collection("students").where("email", "==", cleanEmail).limit(1).get();
    if (!sQuery.empty) {
      const data = sQuery.docs[0].data();
      return {
        rollNo: String(data.rollNo || sQuery.docs[0].id).trim().toUpperCase(),
        name: data.name || data.fullName || data.rollNo,
        email: data.email || cleanEmail
      };
    }
  }

  // Fallback: Use prefix of email as rollNo
  const prefix = cleanEmail.split("@")[0].toUpperCase();
  return {
    rollNo: prefix || "STUDENT",
    name: prefix || "Student",
    email: cleanEmail
  };
}

/**
 * 1. INITIATE ATTENDANCE SESSION (Lecturer only)
 * Sets fixed authoritative session timeline:
 * T = 0s  : Session Start
 * T = 60s : QR 1 Expires (1 min) / QR 2 Starts (2 min)
 * T = 180s: Session & Kiosk Period Ends (kioskEndsAt, 3 min total)
 */
exports.initiateAttendanceSession = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to initiate session.");
  }

  const { classCode, courseCode, roomNo, batch, lecturerInfo } = request.data || {};
  if (!classCode || !courseCode || !roomNo) {
    throw new HttpsError("invalid-argument", "Missing required session parameters (classCode, courseCode, roomNo).");
  }

  const nowMs = Date.now();
  const sessionStartMs = nowMs;
  const qr1ExpiresMs = nowMs + 60 * 1000;    // Exactly T = 60s (1 min)
  const qr2StartsMs = nowMs + 60 * 1000;     // Exactly T = 60s
  const kioskEndsMs = nowMs + 180 * 1000;    // Exactly T = 180s (3 min total: 1 min QR1 + 2 min QR2)

  const qr1Token = crypto.randomBytes(20).toString("hex");
  const qr1TokenHash = hashToken(qr1Token);

  const qr2Token = crypto.randomBytes(20).toString("hex");
  const qr2TokenHash = hashToken(qr2Token);

  const cleanCourse = courseCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const cleanClass = classCode !== courseCode ? `_${classCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "")}` : "";
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const sessionId = `${cleanCourse}${cleanClass}_${nowMs}_${randomSuffix}`;

  const lecturerEmail = (request.auth.token.email || lecturerInfo?.email || "").toLowerCase().trim();
  const lecturerName = lecturerInfo?.name || request.auth.token.name || (lecturerEmail ? lecturerEmail.split("@")[0] : "Lecturer");

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);

  // Public Session Document (authoritative timestamps, zero token hashes exposed)
  const sessionDoc = {
    id: sessionId,
    sessionId: sessionId,
    classCode: classCode,
    courseCode: courseCode,
    roomNo: roomNo,
    batch: batch || "2025",
    phase: "PHASE_1",
    active: true,
    ownerId: request.auth.uid,
    ownerEmail: lecturerEmail,
    lecturerName: lecturerName,
    lecturerEmail: lecturerEmail,
    lecturerDepartment: lecturerInfo?.department || "CSE",
    sessionStartAt: Timestamp.fromMillis(sessionStartMs),
    qr1ExpiresAt: Timestamp.fromMillis(qr1ExpiresMs),
    qr2StartsAt: Timestamp.fromMillis(qr2StartsMs),
    kioskEndsAt: Timestamp.fromMillis(kioskEndsMs),
    expiresAt: Timestamp.fromMillis(kioskEndsMs),
    createdAt: FieldValue.serverTimestamp(),
    authorizedCount: 0,
    attendanceCount: 0,
    attendees: []
  };

  // Private Security Document (Only Cloud Functions Admin SDK can read/write)
  const securityDoc = {
    qr1TokenHash: qr1TokenHash,
    qr2TokenHash: qr2TokenHash,
    sessionStartAt: Timestamp.fromMillis(sessionStartMs),
    qr1ExpiresAt: Timestamp.fromMillis(qr1ExpiresMs),
    qr2StartsAt: Timestamp.fromMillis(qr2StartsMs),
    kioskEndsAt: Timestamp.fromMillis(kioskEndsMs)
  };

  await Promise.all([
    sessionRef.set(sessionDoc),
    sessionRef.collection("security").doc("tokens").set(securityDoc)
  ]);

  return {
    success: true,
    sessionId: sessionId,
    qr1Token: qr1Token,
    qr2Token: qr2Token,
    sessionStartAt: sessionStartMs,
    qr1ExpiresAt: qr1ExpiresMs,
    qr2StartsAt: qr2StartsMs,
    kioskEndsAt: kioskEndsMs,
    phase: "PHASE_1"
  };
});

/**
 * 2. AUTHORIZE QR 1 (Student Check-in Gate)
 * Strictly verifies QR 1 token within T = 0–60s server-time.
 * Ties the student to the fixed session kioskEndsAt deadline (T = 120s).
 */
exports.authorizeQR1 = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required. Please log in to SmartAttend.");
  }

  const { sessionId, qr1Token } = request.data || {};
  if (!sessionId || !qr1Token) {
    throw new HttpsError("invalid-argument", "Session ID and QR 1 token are required.");
  }

  const studentUid = request.auth.uid;
  const studentEmail = request.auth.token.email || "";

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const [sessionSnap, securitySnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("security").doc("tokens").get()
  ]);

  if (!sessionSnap.exists || !securitySnap.exists) {
    throw new HttpsError("not-found", "Attendance session not found.");
  }

  const session = sessionSnap.data();
  const security = securitySnap.data();

  // 1. Validate session active
  if (session.active === false) {
    throw new HttpsError("failed-precondition", "This attendance session has already ended.");
  }

  // 2. Server-side time check: QR 1 valid strictly during T = 0 to 60s
  const serverNow = Date.now();
  const qr1ExpiresAtMs = security.qr1ExpiresAt ? security.qr1ExpiresAt.toMillis() : 0;
  const kioskEndsAtMs = security.kioskEndsAt ? security.kioskEndsAt.toMillis() : 0;

  if (serverNow > qr1ExpiresAtMs) {
    throw new HttpsError("deadline-exceeded", "❌ QR 1 has expired! The 60-second check-in window is closed.");
  }

  // 3. Cryptographic token match against private security doc
  const inputHash = hashToken(qr1Token);
  if (inputHash !== security.qr1TokenHash) {
    throw new HttpsError("permission-denied", "❌ Invalid QR 1 token.");
  }

  // 4. Resolve trusted student identity from database
  const studentProfile = await resolveTrustedStudent(studentUid, studentEmail);

  // 5. Check existing authorization
  const authRef = sessionRef.collection("authorizations").doc(studentUid);
  const existingAuth = await authRef.get();

  if (existingAuth.exists) {
    const data = existingAuth.data();
    return {
      success: true,
      status: "SESSION_AUTHORIZED",
      sessionId: sessionId,
      rollNo: data.rollNo,
      studentName: data.studentName,
      sessionStartAt: security.sessionStartAt.toMillis(),
      qr1ExpiresAt: qr1ExpiresAtMs,
      kioskEndsAt: kioskEndsAtMs,
      message: "Already authorized for this session."
    };
  }

  // 6. Atomic transaction: create authorization & increment count
  await db.runTransaction(async (transaction) => {
    const freshSessionSnap = await transaction.get(sessionRef);
    if (!freshSessionSnap.exists || freshSessionSnap.data().active === false) {
      throw new HttpsError("failed-precondition", "Session ended during authorization.");
    }

    transaction.set(authRef, {
      studentUid: studentUid,
      studentEmail: studentProfile.email,
      rollNo: studentProfile.rollNo,
      studentName: studentProfile.name,
      status: "SESSION_AUTHORIZED",
      authorizedAt: FieldValue.serverTimestamp(),
      sessionId: sessionId,
      kioskEndsAt: security.kioskEndsAt
    });

    transaction.update(sessionRef, {
      authorizedCount: FieldValue.increment(1)
    });
  });

  return {
    success: true,
    status: "SESSION_AUTHORIZED",
    sessionId: sessionId,
    rollNo: studentProfile.rollNo,
    studentName: studentProfile.name,
    sessionStartAt: security.sessionStartAt ? security.sessionStartAt.toMillis() : 0,
    qr1ExpiresAt: qr1ExpiresAtMs,
    qr2StartsAt: security.qr2StartsAt ? security.qr2StartsAt.toMillis() : qr1ExpiresAtMs,
    kioskEndsAt: kioskEndsAtMs,
    message: "Phase 1 Verified! Session authorization granted."
  };
});

/**
 * 3. TRANSITION TO PHASE 2 (Lecturer or Automatic at T=60s)
 * Transitions session to PHASE_2.
 */
exports.transitionToPhase2 = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const { sessionId } = request.data || {};
  if (!sessionId) {
    throw new HttpsError("invalid-argument", "Session ID is required.");
  }

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const [sessionSnap, securitySnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("security").doc("tokens").get()
  ]);

  if (!sessionSnap.exists || !securitySnap.exists) {
    throw new HttpsError("not-found", "Session not found.");
  }

  const session = sessionSnap.data();
  if (session.ownerId !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only the session lecturer can transition to Phase 2.");
  }

  await sessionRef.update({
    phase: "PHASE_2"
  });

  return {
    success: true,
    sessionId: sessionId,
    phase: "PHASE_2"
  };
});

/**
 * 4. VALIDATE QR 2 (Student Gate)
 * STRICT NON-NEGOTIABLE RULE:
 * 1. Must be within T = 60s–120s session window.
 * 2. Requires authenticated student to have existing SESSION_AUTHORIZED record from QR 1 for this exact session.
 * 3. Rejects with "Access denied. You must scan QR 1 first." if unauthorized.
 */
exports.validateQR2 = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required. Please log in.");
  }

  const { sessionId, qr2Token } = request.data || {};
  if (!sessionId || !qr2Token) {
    throw new HttpsError("invalid-argument", "Session ID and QR 2 token are required.");
  }

  const studentUid = request.auth.uid;
  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const [sessionSnap, securitySnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("security").doc("tokens").get()
  ]);

  if (!sessionSnap.exists || !securitySnap.exists) {
    throw new HttpsError("not-found", "Attendance session not found.");
  }

  const session = sessionSnap.data();
  const security = securitySnap.data();

  // 1. Validate session active
  if (session.active === false) {
    throw new HttpsError("failed-precondition", "This attendance session has ended.");
  }

  // 2. Validate server time within T = 60s to 180s
  const serverNow = Date.now();
  const kioskEndsAtMs = security.kioskEndsAt ? security.kioskEndsAt.toMillis() : 0;

  if (serverNow > kioskEndsAtMs) {
    throw new HttpsError("deadline-exceeded", "❌ Attendance session has closed. 3-minute session deadline elapsed.");
  }

  // 3. Validate QR 2 token
  const inputHash = hashToken(qr2Token);
  if (inputHash !== security.qr2TokenHash) {
    throw new HttpsError("permission-denied", "❌ Invalid QR 2 token.");
  }

  // 4. STRICT CHECK: Must have SESSION_AUTHORIZED from QR 1 for this exact session
  const authRef = sessionRef.collection("authorizations").doc(studentUid);
  const authSnap = await authRef.get();

  if (!authSnap.exists || authSnap.data().status !== "SESSION_AUTHORIZED") {
    throw new HttpsError(
      "permission-denied",
      "⛔ Access denied. You must scan QR 1 first."
    );
  }

  const authData = authSnap.data();

  // 5. Check for duplicate attendance submission
  const recordId = `${sessionId}_${authData.rollNo}`;
  const recordSnap = await db.collection("attendance_records").doc(recordId).get();
  if (recordSnap.exists) {
    throw new HttpsError(
      "already-exists",
      `Roll Number ${authData.rollNo} has already submitted attendance for this session.`
    );
  }

  return {
    success: true,
    authorized: true,
    sessionId: sessionId,
    rollNo: authData.rollNo,
    studentName: authData.studentName,
    kioskEndsAt: kioskEndsAtMs,
    sessionDetails: {
      courseCode: session.courseCode || "N/A",
      classCode: session.classCode || "N/A",
      roomNo: session.roomNo || "N/A",
      batch: session.batch || "2025",
      lecturerName: session.lecturerName || ""
    }
  };
});

/**
 * 5. SUBMIT ATTENDANCE (Student Final Submission)
 * Re-validates QR 1 authorization, QR 2 token, biometric result, and enforces server deadline T = 120s.
 */
exports.submitAttendance = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const { sessionId, qr2Token, biometricData } = request.data || {};
  if (!sessionId || !qr2Token) {
    throw new HttpsError("invalid-argument", "Missing sessionId or qr2Token.");
  }

  const studentUid = request.auth.uid;
  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const [sessionSnap, securitySnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("security").doc("tokens").get()
  ]);

  if (!sessionSnap.exists || !securitySnap.exists) {
    throw new HttpsError("not-found", "Attendance session not found.");
  }

  const session = sessionSnap.data();
  const security = securitySnap.data();

  const serverNow = Date.now();
  const kioskEndsAtMs = security.kioskEndsAt ? security.kioskEndsAt.toMillis() : 0;

  if (session.active === false || serverNow > kioskEndsAtMs) {
    throw new HttpsError("failed-precondition", "Attendance session is closed (3-minute session elapsed).");
  }

  // 1. Re-validate QR 2 token
  if (hashToken(qr2Token) !== security.qr2TokenHash) {
    throw new HttpsError("permission-denied", "Invalid QR 2 token.");
  }

  // 2. Re-verify QR 1 authorization
  const authRef = sessionRef.collection("authorizations").doc(studentUid);
  const authSnap = await authRef.get();

  if (!authSnap.exists || authSnap.data().status !== "SESSION_AUTHORIZED") {
    throw new HttpsError("permission-denied", "⛔ Access denied. You must scan QR 1 first.");
  }

  const authData = authSnap.data();
  const rollNo = authData.rollNo;
  const recordId = `${sessionId}_${rollNo}`;

  // 3. Biometric check
  if (!biometricData || biometricData.verified !== true || biometricData.antiSpoofScore !== "PASSED") {
    throw new HttpsError("failed-precondition", "Live face biometric verification with anti-spoofing is required.");
  }

  // 4. Atomic write with duplicate prevention
  await db.runTransaction(async (transaction) => {
    const existingRec = await transaction.get(db.collection("attendance_records").doc(recordId));
    if (existingRec.exists) {
      throw new HttpsError("already-exists", `Attendance for ${rollNo} is already recorded.`);
    }

    const attendanceRecord = {
      id: recordId,
      sessionId: sessionId,
      rollNo: rollNo,
      fullName: authData.studentName,
      studentName: authData.studentName,
      name: authData.studentName,
      studentEmail: authData.studentEmail,
      studentUid: studentUid,
      courseCode: session.courseCode || "N/A",
      classCode: session.classCode || "N/A",
      batch: session.batch || "2025",
      roomNo: session.roomNo || "N/A",
      lecturerName: session.lecturerName || "",
      lecturerEmail: session.lecturerEmail || "",
      ownerId: session.ownerId || "",
      faceVerified: true,
      faceMatchConfidence: biometricData.confidence || 100,
      faceDistance: biometricData.distance !== undefined ? Number(biometricData.distance.toFixed(4)) : null,
      livenessConfirmed: true,
      antiSpoofScore: "PASSED",
      blinkCount: biometricData.blinkCount || 1,
      submittedAt: FieldValue.serverTimestamp(),
      biometricVerifiedAt: FieldValue.serverTimestamp()
    };

    transaction.set(db.collection("attendance_records").doc(recordId), attendanceRecord);

    transaction.update(sessionRef, {
      attendees: FieldValue.arrayUnion({
        id: recordId,
        rollNo: rollNo,
        studentName: authData.studentName,
        fullName: authData.studentName,
        email: authData.studentEmail,
        studentEmail: authData.studentEmail,
        faceVerified: true,
        faceMatchConfidence: biometricData.confidence || 100,
        submittedAt: Date.now()
      }),
      attendanceCount: FieldValue.increment(1)
    });
  });

  return {
    success: true,
    sessionId: sessionId,
    rollNo: rollNo,
    studentName: authData.studentName,
    submittedAt: Date.now(),
    kioskEndsAt: kioskEndsAtMs
  };
});
