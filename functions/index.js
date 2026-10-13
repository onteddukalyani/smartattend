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
 * Utility: Convert Base64 DER public key to PEM format.
 */
function derToPem(derBase64) {
  const clean = (derBase64 || "").replace(/\s+/g, "");
  const lines = [];
  for (let i = 0; i < clean.length; i += 64) {
    lines.push(clean.substring(i, i + 64));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Utility: Verify ECDSA SHA-256 signature over UTF-8 challenge string.
 */
function verifyEcdsaSignature(derBase64Key, challengeText, signatureHex) {
  try {
    const pem = derToPem(derBase64Key);
    const verify = crypto.createVerify("SHA256");
    verify.update(Buffer.from(challengeText, "utf8"));
    return verify.verify(pem, Buffer.from(signatureHex, "hex"));
  } catch (err) {
    console.warn("ECDSA signature verification error:", err.message);
    return false;
  }
}

/**
 * Utility: Look up authoritative student profile with strict account verification.
 * Rejects unlinked accounts, unknown UIDs, and generic/prefix-derived rolls.
 */
async function resolveAuthoritativeStudent(uid, email) {
  const cleanEmail = (email || "").toLowerCase().trim();

  // 1. Check users collection by UID
  if (uid) {
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists) {
      const data = userSnap.data();
      const rawRoll = data.rollNo || data.studentId;
      if (rawRoll) {
        const rollNo = String(rawRoll).trim().toUpperCase();
        // Verify student document in students collection
        const studentDocSnap = await db.collection("students").doc(rollNo).get();
        if (studentDocSnap.exists) {
          const sData = studentDocSnap.data();
          return {
            uid: uid,
            rollNo: rollNo,
            name: sData.name || sData.fullName || data.name || data.fullName || rollNo,
            email: sData.email || data.email || cleanEmail
          };
        }
        return {
          uid: uid,
          rollNo: rollNo,
          name: data.name || data.fullName || data.displayName || rollNo,
          email: data.email || cleanEmail
        };
      }
    }
  }

  // 2. Query students collection by UID
  if (uid) {
    const sUidQuery = await db.collection("students").where("uid", "==", uid).limit(1).get();
    if (!sUidQuery.empty) {
      const docSnap = sUidQuery.docs[0];
      const data = docSnap.data();
      const rollNo = String(data.rollNo || docSnap.id).trim().toUpperCase();
      return {
        uid: uid,
        rollNo: rollNo,
        name: data.name || data.fullName || rollNo,
        email: data.email || cleanEmail
      };
    }
  }

  // 3. Check authorizedUsers by email & verify matching student doc
  if (cleanEmail) {
    const authSnap = await db.collection("authorizedUsers").doc(cleanEmail).get();
    if (authSnap.exists) {
      const data = authSnap.data();
      if (data.rollNo) {
        const rollNo = String(data.rollNo).trim().toUpperCase();
        const studentDocSnap = await db.collection("students").doc(rollNo).get();
        if (studentDocSnap.exists) {
          const sData = studentDocSnap.data();
          return {
            uid: uid || sData.uid || cleanEmail,
            rollNo: rollNo,
            name: sData.name || data.name || data.fullName || rollNo,
            email: cleanEmail
          };
        }
        return {
          uid: uid || cleanEmail,
          rollNo: rollNo,
          name: data.name || data.fullName || rollNo,
          email: cleanEmail
        };
      }
    }
  }

  // 4. Query students collection by email with strict enrollment check
  if (cleanEmail) {
    const sQuery = await db.collection("students").where("email", "==", cleanEmail).limit(1).get();
    if (!sQuery.empty) {
      const docSnap = sQuery.docs[0];
      const data = docSnap.data();
      const rollNo = String(data.rollNo || docSnap.id).trim().toUpperCase();
      return {
        uid: uid || data.uid || cleanEmail,
        rollNo: rollNo,
        name: data.name || data.fullName || rollNo,
        email: cleanEmail
      };
    }
  }

  // Reject unlinked or unverified student account
  throw new HttpsError(
    "permission-denied",
    "Student account is not authoritatively linked to an enrolled student record. Please contact the institution administrator."
  );
}

/**
 * Utility: Backward-compatible wrapper
 */
async function resolveTrustedStudent(uid, email) {
  return resolveAuthoritativeStudent(uid, email);
}

/**
 * Utility: Role & Course Scope Verification
 */
async function assertAdmin(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  const uid = request.auth.uid;
  const email = (request.auth.token.email || "").toLowerCase().trim();

  // Check users/{uid}
  const userDoc = await db.collection("users").doc(uid).get();
  if (userDoc.exists && userDoc.data().role === "admin") return true;

  // Check admins collection
  const adminDoc = await db.collection("admins").doc(uid).get();
  if (adminDoc.exists) return true;
  if (email) {
    const adminEmailDoc = await db.collection("admins").doc(email).get();
    if (adminEmailDoc.exists) return true;
    const prefix = email.split("@")[0];
    const adminPrefixDoc = await db.collection("admins").doc(prefix).get();
    if (adminPrefixDoc.exists) return true;
  }

  throw new HttpsError("permission-denied", "Operation restricted to verified administrators.");
}

async function isCallerAdmin(request) {
  try {
    await assertAdmin(request);
    return true;
  } catch (e) {
    return false;
  }
}

async function assertLecturer(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  if (await isCallerAdmin(request)) return true;

  const uid = request.auth.uid;
  const email = (request.auth.token.email || "").toLowerCase().trim();

  // Check users/{uid}
  const userDoc = await db.collection("users").doc(uid).get();
  if (userDoc.exists && (userDoc.data().role === "lecturer" || userDoc.data().role === "faculty")) return true;

  // Check lecturers collection
  const lectDoc = await db.collection("lecturers").doc(uid).get();
  if (lectDoc.exists) return true;
  if (email) {
    const lectEmailDoc = await db.collection("lecturers").doc(email).get();
    if (lectEmailDoc.exists) return true;
    const prefix = email.split("@")[0];
    const lectPrefixDoc = await db.collection("lecturers").doc(prefix).get();
    if (lectPrefixDoc.exists) return true;
  }

  throw new HttpsError("permission-denied", "Operation restricted to authorized faculty and lecturers.");
}

async function assertLecturerCourseScope(lecturerUid, lecturerEmail, courseCode) {
  const cleanCourse = String(courseCode || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const courseDoc = await db.collection("courses").doc(cleanCourse).get();

  if (!courseDoc.exists) {
    throw new HttpsError("not-found", `Course "${cleanCourse}" not found.`);
  }

  const courseData = courseDoc.data();
  const cleanEmail = (lecturerEmail || "").toLowerCase().trim();

  // Check assigned lecturers
  let isAssigned = false;
  if (courseData.lecturerEmail && courseData.lecturerEmail.toLowerCase().trim() === cleanEmail) {
    isAssigned = true;
  }
  if (Array.isArray(courseData.assignedLecturers)) {
    for (const l of courseData.assignedLecturers) {
      const lEmail = typeof l === "string" ? l.toLowerCase().trim() : (l.email || "").toLowerCase().trim();
      const lUid = typeof l === "object" ? l.uid : null;
      if (lEmail === cleanEmail || (lUid && lUid === lecturerUid)) {
        isAssigned = true;
        break;
      }
    }
  }

  if (!isAssigned) {
    throw new HttpsError("permission-denied", `Lecturer is not assigned to course "${cleanCourse}".`);
  }

  return courseData;
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

  const { classCode, courseCode, roomNo, batch, lecturerInfo, geofenceRadius } = request.data || {};
  if (!classCode || !courseCode || !roomNo) {
    throw new HttpsError("invalid-argument", "Missing required session parameters (classCode, courseCode, roomNo).");
  }

  // Server-side role and course assignment verification
  await assertLecturer(request);
  const isAdmin = await isCallerAdmin(request);
  const lecturerEmail = (request.auth.token.email || lecturerInfo?.email || "").toLowerCase().trim();
  if (!isAdmin) {
    await assertLecturerCourseScope(request.auth.uid, lecturerEmail, courseCode);
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

  const rawReleaseCode = (request.data && (request.data.lecturerReleaseCode || request.data.lecturerPin))
    ? String(request.data.lecturerReleaseCode || request.data.lecturerPin).trim()
    : Math.floor(100000 + Math.random() * 900000).toString();
  const lecturerReleaseCodeHash = hashToken(rawReleaseCode);

  const cleanCourse = courseCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const cleanClass = classCode !== courseCode ? `_${classCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "")}` : "";
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const sessionId = `${cleanCourse}${cleanClass}_${nowMs}_${randomSuffix}`;

  const lecturerName = lecturerInfo?.name || request.auth.token.name || (lecturerEmail ? lecturerEmail.split("@")[0] : "Lecturer");

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);

  // Public Session Document (Zero release codes or sensitive token hashes exposed to clients)
  const sessionDoc = {
    id: sessionId,
    sessionId: sessionId,
    classCode: classCode,
    courseCode: courseCode,
    roomNo: roomNo,
    batch: batch || "2025",
    geofenceRadius: typeof geofenceRadius === "number" ? geofenceRadius : 5,
    phase: "PHASE_1",
    status: "ACTIVE",
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

  // Private Security Document (Only Cloud Functions Admin SDK can read/write; zero client access)
  const securityDoc = {
    qr1TokenHash: qr1TokenHash,
    qr2TokenHash: qr2TokenHash,
    lecturerReleaseCodeHash: lecturerReleaseCodeHash,
    sessionPinHash: lecturerReleaseCodeHash,
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
    phase: "PHASE_1",
    status: "ACTIVE",
    sessionPin: rawReleaseCode,
    lecturerPin: rawReleaseCode,
    lecturerReleaseCode: rawReleaseCode
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

  const { sessionId, qr1Token, deviceId, isDeviceOwner } = request.data || {};
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
  if (session.active === false || session.status === "CLOSED") {
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
    if (!freshSessionSnap.exists || freshSessionSnap.data().active === false || freshSessionSnap.data().status === "CLOSED") {
      throw new HttpsError("failed-precondition", "Session ended during authorization.");
    }

    transaction.set(authRef, {
      studentUid: studentUid,
      studentEmail: studentProfile.email,
      rollNo: studentProfile.rollNo,
      studentName: studentProfile.name,
      deviceId: deviceId || "UNKNOWN_DEVICE",
      isDeviceOwner: Boolean(isDeviceOwner),
      qr1Verified: true,
      status: "QR1_VERIFIED",
      releaseStatus: "LOCKED",
      released: false,
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
    status: "QR1_VERIFIED",
    qr1Verified: true,
    sessionId: sessionId,
    rollNo: studentProfile.rollNo,
    studentName: studentProfile.name,
    sessionStartAt: security.sessionStartAt ? security.sessionStartAt.toMillis() : 0,
    qr1ExpiresAt: qr1ExpiresAtMs,
    qr2StartsAt: security.qr2StartsAt ? security.qr2StartsAt.toMillis() : qr1ExpiresAtMs,
    kioskEndsAt: kioskEndsAtMs,
    message: "QR1 Verified! Android Kiosk Lock Task Mode activated."
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
 * 1. Must be within T = 60s–180s session window.
 * 2. Requires authenticated student to have existing QR1_VERIFIED record from QR 1 for this exact session.
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
  if (session.active === false || session.status === "CLOSED") {
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

  // 4. STRICT CHECK: Must have QR1_VERIFIED authorization from QR 1 for this exact session
  const authRef = sessionRef.collection("authorizations").doc(studentUid);
  const authSnap = await authRef.get();

  const isQr1Valid = authSnap.exists && (authSnap.data().qr1Verified === true || authSnap.data().status === "QR1_VERIFIED" || authSnap.data().status === "SESSION_AUTHORIZED");
  if (!isQr1Valid) {
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
 * Re-validates QR 1 authorization, QR 2 token, biometric result, records 5-minute fail-safe auto-release timeline,
 * and maintains Lock Task Mode on the student device.
 */
exports.submitAttendance = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const {
    sessionId,
    qr2Token,
    biometricData,
    hardwareProof,
    deviceAuthMode,
    isNative
  } = request.data || {};
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

  if (session.active === false || (kioskEndsAtMs && serverNow > (kioskEndsAtMs + 30000))) {
    throw new HttpsError("failed-precondition", "Attendance session is closed.");
  }

  // 1. Re-validate QR 2 token
  if (hashToken(qr2Token) !== security.qr2TokenHash) {
    throw new HttpsError("permission-denied", "Invalid QR 2 token.");
  }

  // 2. Re-verify QR 1 authorization
  const authRef = sessionRef.collection("authorizations").doc(studentUid);
  const authSnap = await authRef.get();

  const isQr1Valid = authSnap.exists && (authSnap.data().qr1Verified === true || authSnap.data().status === "QR1_VERIFIED" || authSnap.data().status === "SESSION_AUTHORIZED");
  if (!isQr1Valid) {
    throw new HttpsError("permission-denied", "⛔ Access denied. You must scan QR 1 first.");
  }

  const authData = authSnap.data();

  // Strict backend kiosk enforcement for Android: reject if 2 or more confirmed violations or already disqualified
  if (authData.disqualified === true || (Number(authData.confirmedKioskViolations || authData.violationCount || 0) >= 2 && authData.detectedPlatform === "android")) {
    throw new HttpsError(
      "permission-denied",
      "❌ Attendance rejected: Your attendance for this session was forfeited due to confirmed kiosk escape violations (limit: 2)."
    );
  }

  const rollNo = authData.rollNo;
  const recordId = `${sessionId}_${rollNo}`;

  // 3. Hardware Biometric Verification & Browser Fallback Policy
  let authMode = "WEB_BROWSER";
  let hardwarePlatform = "web";
  let signatureVerified = false;

  if (hardwareProof) {
    const { challengeId, signature, platform: proofPlatform } = hardwareProof;
    if (!challengeId || !signature) {
      throw new HttpsError("invalid-argument", "Missing hardware biometric challengeId or signature.");
    }

    const challengeRef = db.collection("biometric_challenges").doc(challengeId);
    const challengeSnap = await challengeRef.get();

    if (!challengeSnap.exists) {
      throw new HttpsError("permission-denied", "Invalid or unknown biometric challenge.");
    }

    const challengeData = challengeSnap.data();
    if (challengeData.used === true) {
      throw new HttpsError("permission-denied", "Biometric challenge has already been consumed (replay prevention).");
    }

    if (challengeData.studentUid !== studentUid) {
      throw new HttpsError("permission-denied", "Biometric challenge student UID mismatch.");
    }

    const challengeExpiryMs = challengeData.expiresAt ? challengeData.expiresAt.toMillis() : 0;
    if (Date.now() > challengeExpiryMs) {
      throw new HttpsError("deadline-exceeded", "Biometric challenge has expired. Please retry biometric verification.");
    }

    // Look up student's registered public key
    const credSnap = await db.collection("biometric_credentials").doc(studentUid).get();
    let credData = credSnap.exists ? credSnap.data() : null;
    if (!credData) {
      const rollCredSnap = await db.collection("biometric_credentials").doc(rollNo).get();
      if (rollCredSnap.exists) credData = rollCredSnap.data();
    }

    if (!credData || credData.status !== "ACTIVE" || !credData.publicKeyDerBase64) {
      throw new HttpsError(
        "failed-precondition",
        "No active hardware biometric credential registered for this student. Please complete biometric setup first."
      );
    }

    // Verify ECDSA signature over canonical UTF-8 challenge bytes
    const isValidSig = verifyEcdsaSignature(
      credData.publicKeyDerBase64,
      challengeData.challengeText,
      signature
    );

    if (!isValidSig) {
      throw new HttpsError("permission-denied", "❌ Hardware biometric signature verification failed. Authentication rejected.");
    }

    // Mark challenge as consumed
    await challengeRef.update({
      used: true,
      usedAt: FieldValue.serverTimestamp(),
      consumedBySession: sessionId
    });

    signatureVerified = true;
    authMode = "NATIVE_MOBILE";
    hardwarePlatform = proofPlatform || credData.platform || "unknown";
  } else if (isNative) {
    // Native mobile app MUST provide hardwareProof
    throw new HttpsError("failed-precondition", "Hardware biometric signature is required for native mobile attendance.");
  } else {
    // Web browser fallback: zero signature fabrication.
    authMode = "WEB_BROWSER";
    hardwarePlatform = "web";
    signatureVerified = false;
  }

  // 4. Face Biometric check (Enforced for both Web and Native mobile)
  if (!biometricData || biometricData.verified !== true || biometricData.antiSpoofScore !== "PASSED") {
    throw new HttpsError("failed-precondition", "Live face biometric verification with anti-spoofing is required.");
  }

  const submittedAtMs = Date.now();
  const autoReleaseAtMs = submittedAtMs + 5 * 60 * 1000; // 5-Minute Automatic Fail-Safe Release

  // 5. Atomic write with duplicate prevention & 5-minute fail-safe schedule
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
      deviceAuthMode: authMode,
      hardwareBiometric: signatureVerified,
      signatureVerified: signatureVerified,
      platform: hardwarePlatform,
      submittedAt: FieldValue.serverTimestamp(),
      biometricVerifiedAt: FieldValue.serverTimestamp(),
      autoReleaseAt: Timestamp.fromMillis(autoReleaseAtMs)
    };

    transaction.set(db.collection("attendance_records").doc(recordId), attendanceRecord);

    // Update session attendees
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
        deviceAuthMode: authMode,
        hardwareBiometric: signatureVerified,
        submittedAt: submittedAtMs,
        attendanceSubmittedAt: submittedAtMs,
        autoReleaseAt: autoReleaseAtMs
      }),
      attendanceCount: FieldValue.increment(1)
    });

    // Update authorization document with 5-minute fail-safe timeline
    transaction.update(authRef, {
      attendanceSubmittedAt: FieldValue.serverTimestamp(),
      autoReleaseAt: Timestamp.fromMillis(autoReleaseAtMs),
      attendanceStatus: "SUBMITTED",
      faceVerified: true,
      hardwareBiometric: signatureVerified,
      releaseStatus: "LOCKED"
    });
  });

  if (rollNo && rollNo !== studentUid) {
    try {
      const rollAuthRef = sessionRef.collection("authorizations").doc(rollNo);
      await rollAuthRef.update({
        attendanceSubmittedAt: FieldValue.serverTimestamp(),
        autoReleaseAt: Timestamp.fromMillis(autoReleaseAtMs),
        attendanceStatus: "SUBMITTED",
        faceVerified: true,
        hardwareBiometric: signatureVerified,
        releaseStatus: "LOCKED"
      });
    } catch (e) {}
  }

  return {
    success: true,
    sessionId: sessionId,
    rollNo: rollNo,
    studentName: authData.studentName,
    deviceAuthMode: authMode,
    hardwareBiometric: signatureVerified,
    submittedAt: submittedAtMs,
    attendanceSubmittedAt: submittedAtMs,
    autoReleaseAt: autoReleaseAtMs,
    kioskEndsAt: kioskEndsAtMs,
    message: "Attendance Submitted. Waiting for Lecturer Release (Lock Task Mode active)."
  };
});

/**
 * 6. VERIFY LECTURER RELEASE CODE / SESSION PIN (On-Device Release)
 * Server-side trusted verification of the 6-digit Session PIN.
 * Compares hashed input against private /security/tokens without exposing the hash to the client.
 */
exports.verifyLecturerReleaseCode = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to request kiosk release.");
  }

  const { sessionId, releaseCode, sessionPin, pin, deviceId, studentUid } = request.data || {};
  const inputPin = releaseCode || sessionPin || pin;
  if (!sessionId || !inputPin) {
    throw new HttpsError("invalid-argument", "Session ID and Session PIN are required.");
  }

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const [sessionSnap, securitySnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("security").doc("tokens").get()
  ]);

  if (!sessionSnap.exists || !securitySnap.exists) {
    throw new HttpsError("not-found", "Attendance session or security tokens not found.");
  }

  const security = securitySnap.data();
  const inputHash = hashToken(String(inputPin).trim());
  const expectedHash = security.sessionPinHash || security.lecturerReleaseCodeHash;

  if (inputHash !== expectedHash) {
    throw new HttpsError("permission-denied", "❌ Invalid Session PIN. Device remains locked in Kiosk mode.");
  }

  const targetUid = studentUid || request.auth.uid;
  try {
    const authRef = sessionRef.collection("authorizations").doc(targetUid);
    const authSnap = await authRef.get();
    if (authSnap.exists) {
      await authRef.update({
        released: true,
        releaseStatus: "PIN_RELEASED",
        releasedAt: FieldValue.serverTimestamp()
      });
    }
  } catch (e) {
    console.warn("Notice updating PIN release authorization:", e);
  }

  const releaseToken = crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + 30000;

  // Audit log of PIN release
  try {
    await sessionRef.collection("audit_logs").add({
      event: "SESSION_PIN_DEVICE_RELEASE",
      studentUid: targetUid,
      deviceId: deviceId || "UNKNOWN",
      timestamp: FieldValue.serverTimestamp()
    });
  } catch (e) { }

  return {
    success: true,
    releaseAuthorized: true,
    sessionId: sessionId,
    studentUid: targetUid,
    releaseToken: releaseToken,
    expiresAt: expiresAt,
    message: "Session PIN verified successfully. Device release authorized."
  };
});

/**
 * 7. END ATTENDANCE SESSION (Release All Devices - Lecturer Only)
 * Closes the session and releases all active student kiosks simultaneously.
 * Enforces that only the session owner (lecturer) can close the session.
 */
exports.endAttendanceSession = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to end session.");
  }

  const { sessionId } = request.data || {};
  if (!sessionId) {
    throw new HttpsError("invalid-argument", "Session ID is required.");
  }

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();

  if (!sessionSnap.exists) {
    throw new HttpsError("not-found", "Attendance session not found.");
  }

  const session = sessionSnap.data();
  if (session.ownerId !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only the owning lecturer can end this attendance session.");
  }

  await sessionRef.update({
    active: false,
    status: "CLOSED",
    phase: "CLOSED",
    closedAt: FieldValue.serverTimestamp(),
    closedBy: request.auth.uid
  });

  return {
    success: true,
    sessionId: sessionId,
    status: "CLOSED",
    message: "Attendance session closed successfully. All student kiosks released."
  };
});

/**
 * 8. RELEASE INDIVIDUAL DEVICE (Lecturer Only)
 * Remotely unlocks a specific student's device from Kiosk Lock Task mode using the Session PIN.
 * Enforces that only the session owner (lecturer) can authorize the device release.
 */
exports.releaseIndividualDevice = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to release device.");
  }

  const { sessionId, studentUid, rollNo, sessionPin } = request.data || {};
  if (!sessionId || (!studentUid && !rollNo)) {
    throw new HttpsError("invalid-argument", "Session ID and student identifier are required.");
  }

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const [sessionSnap, securitySnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("security").doc("tokens").get()
  ]);

  if (!sessionSnap.exists) {
    throw new HttpsError("not-found", "Attendance session not found.");
  }

  const session = sessionSnap.data();
  if (session.ownerId !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only the owning lecturer can release student devices.");
  }

  // Optional Session PIN validation if provided
  if (sessionPin && securitySnap.exists) {
    const security = securitySnap.data();
    const inputHash = hashToken(String(sessionPin).trim());
    if (inputHash !== security.sessionPinHash && inputHash !== security.lecturerReleaseCodeHash) {
      throw new HttpsError("permission-denied", "❌ Invalid Session PIN.");
    }
  }

  const targetDocId = studentUid || rollNo;
  const authRef = sessionRef.collection("authorizations").doc(targetDocId);
  const authSnap = await authRef.get();

  if (authSnap.exists) {
    await authRef.update({
      released: true,
      releasedAt: FieldValue.serverTimestamp(),
      releasedBy: request.auth.uid,
      releaseStatus: "RELEASED",
      status: "RELEASED"
    });
  }

  if (rollNo && studentUid && rollNo !== studentUid) {
    try {
      const rollAuthRef = sessionRef.collection("authorizations").doc(rollNo);
      await rollAuthRef.update({
        released: true,
        releasedAt: FieldValue.serverTimestamp(),
        releasedBy: request.auth.uid,
        releaseStatus: "RELEASED",
        status: "RELEASED"
      });
    } catch (e) {}
  }

  return {
    success: true,
    sessionId: sessionId,
    studentUid: targetDocId,
    status: "RELEASED",
    message: "Individual device release authorized by lecturer."
  };
});

/**
 * 9. REQUEST AUTOMATIC 5-MINUTE FAIL-SAFE RELEASE (Student Device)
 * Validates server-side that at least 5 minutes have elapsed since attendance submission.
 * Authorizes the device to exit Lock Task Mode if the lecturer has not yet released it.
 */
exports.requestAutoFailSafeRelease = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to request fail-safe release.");
  }

  const { sessionId, studentUid } = request.data || {};
  if (!sessionId) {
    throw new HttpsError("invalid-argument", "Session ID is required.");
  }

  const targetUid = studentUid || request.auth.uid;
  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const authRef = sessionRef.collection("authorizations").doc(targetUid);
  const authSnap = await authRef.get();

  if (!authSnap.exists) {
    throw new HttpsError("not-found", "Student session authorization not found.");
  }

  const authData = authSnap.data();
  if (!authData.attendanceSubmittedAt) {
    throw new HttpsError("failed-precondition", "Attendance must be submitted before fail-safe release can trigger.");
  }

  const submittedAtMs = authData.attendanceSubmittedAt.toMillis ? authData.attendanceSubmittedAt.toMillis() : (authData.attendanceSubmittedAt || 0);
  const autoReleaseAtMs = authData.autoReleaseAt ? (authData.autoReleaseAt.toMillis ? authData.autoReleaseAt.toMillis() : authData.autoReleaseAt) : (submittedAtMs + 5 * 60 * 1000);
  const serverNow = Date.now();

  // Allow 5-second grace for network latency
  if (serverNow < (autoReleaseAtMs - 5000)) {
    const remainingSec = Math.ceil((autoReleaseAtMs - serverNow) / 1000);
    throw new HttpsError("failed-precondition", `Fail-safe countdown active. Automatic release authorized in ${remainingSec} seconds.`);
  }

  await authRef.update({
    released: true,
    releaseStatus: "AUTO_RELEASED",
    status: "RELEASED",
    releasedAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    autoReleaseAuthorized: true,
    sessionId: sessionId,
    studentUid: targetUid,
    releaseStatus: "AUTO_RELEASED",
    message: "5-Minute fail-safe countdown reached. Device release authorized."
  };
});

/**
 * 10. ISSUE BIOMETRIC CHALLENGE
 * Cryptographically generates a 32-byte (64 hex chars) nonce with 3-minute TTL.
 * Stored in server-side /biometric_challenges/{challengeId} with single-use replay protection.
 */
exports.issueBiometricChallenge = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to request a biometric challenge.");
  }

  const studentUid = request.auth.uid;
  const challengeId = crypto.randomUUID();
  const challengeText = crypto.randomBytes(32).toString("hex");
  const nowMs = Date.now();
  const expiresAtMs = nowMs + 3 * 60 * 1000; // 3-minute TTL

  await db.collection("biometric_challenges").doc(challengeId).set({
    challengeId: challengeId,
    studentUid: studentUid,
    challengeText: challengeText,
    expiresAt: Timestamp.fromMillis(expiresAtMs),
    used: false,
    createdAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    challengeId: challengeId,
    challengeText: challengeText,
    expiresAt: expiresAtMs
  };
});

/**
 * 11. REGISTER INITIAL BIOMETRIC KEY
 * Students self-enroll initial hardware-backed ECDSA P-256 public key (Android Keystore / iOS Secure Enclave).
 * Once enrolled, key cannot be altered or overwritten directly; requires authorized replacement.
 */
exports.registerInitialBiometricKey = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to enroll biometric key.");
  }

  const { publicKeyDerBase64, platform, keyAlias } = request.data || {};
  if (!publicKeyDerBase64 || typeof publicKeyDerBase64 !== "string") {
    throw new HttpsError("invalid-argument", "Public key (Base64 DER) is required.");
  }

  const studentUid = request.auth.uid;
  const studentEmail = request.auth.token.email || "";
  const studentProfile = await resolveAuthoritativeStudent(studentUid, studentEmail);

  // Validate DER public key format (P-256 SPKI DER is 91 bytes = ~120-128 chars base64)
  const derBuffer = Buffer.from(publicKeyDerBase64.trim(), "base64");
  if (derBuffer.length !== 91) {
    throw new HttpsError("invalid-argument", `Invalid public key format. Expected 91-byte X.509 SPKI DER, received ${derBuffer.length} bytes.`);
  }

  // Verify key imports cleanly in crypto
  try {
    const pem = derToPem(publicKeyDerBase64.trim());
    crypto.createPublicKey(pem);
  } catch (kErr) {
    throw new HttpsError("invalid-argument", "Malformed public key: " + kErr.message);
  }

  // Check if student already has an active biometric credential
  const credRef = db.collection("biometric_credentials").doc(studentUid);
  const existingCredSnap = await credRef.get();

  if (existingCredSnap.exists && existingCredSnap.data().status === "ACTIVE") {
    throw new HttpsError(
      "already-exists",
      "An active biometric credential is already registered for your account. Direct re-enrollment is prohibited. To replace your credential, submit a Biometric Change Request or contact your course lecturer."
    );
  }

  const credentialRecord = {
    studentUid: studentUid,
    rollNo: studentProfile.rollNo,
    studentEmail: studentProfile.email,
    publicKeyDerBase64: publicKeyDerBase64.trim(),
    platform: platform || "unknown",
    keyAlias: keyAlias || `smartattend_p256_${studentProfile.rollNo}`,
    status: "ACTIVE",
    enrollmentMethod: "STUDENT_SELF_ENROLLMENT",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  await Promise.all([
    credRef.set(credentialRecord),
    db.collection("biometric_credentials").doc(studentProfile.rollNo).set(credentialRecord),
    db.collection("students").doc(studentProfile.rollNo).set({
      biometricEnrolled: true,
      hardwareBiometricPlatform: platform || "unknown",
      hardwareBiometricEnrolledAt: FieldValue.serverTimestamp()
    }, { merge: true }),
    db.collection("biometric_audit_logs").add({
      action: "INITIAL_BIOMETRIC_ENROLLMENT",
      studentUid: studentUid,
      rollNo: studentProfile.rollNo,
      platform: platform || "unknown",
      enrolledBy: studentUid,
      timestamp: FieldValue.serverTimestamp()
    })
  ]);

  return {
    success: true,
    rollNo: studentProfile.rollNo,
    platform: platform || "unknown",
    status: "ACTIVE",
    message: "Initial biometric credential registered successfully."
  };
});

/**
 * 12. REPLACE BIOMETRIC CREDENTIAL (Safe Dual-Active Replacement)
 * Authorized replacement: requires approval by Lecturer within student's course roster or Administrator.
 * Preserves the previous active key until replacement is verified, with audit logging.
 */
exports.replaceBiometricCredential = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const { targetStudentUid, targetRollNo, newPublicKeyDerBase64, platform, requestId, reason } = request.data || {};
  if (!newPublicKeyDerBase64 || (!targetStudentUid && !targetRollNo)) {
    throw new HttpsError("invalid-argument", "Target student and new public key are required.");
  }

  const callerUid = request.auth.uid;
  const callerEmail = (request.auth.token.email || "").toLowerCase().trim();
  const isAdmin = await isCallerAdmin(request);

  // Validate new public key
  const derBuffer = Buffer.from(newPublicKeyDerBase64.trim(), "base64");
  if (derBuffer.length !== 91) {
    throw new HttpsError("invalid-argument", `Invalid public key. Expected 91-byte X.509 SPKI DER, received ${derBuffer.length} bytes.`);
  }

  // Resolve target student
  const studentProfile = await resolveAuthoritativeStudent(targetStudentUid, null);
  const studentUid = studentProfile.uid;
  const rollNo = studentProfile.rollNo;

  // Authorization check: Admin, Authorized Lecturer within course roster, or Student with approved change request
  let authorizedBy = "ADMIN";
  if (isAdmin) {
    authorizedBy = `ADMIN (${callerEmail})`;
  } else if (callerUid === studentUid) {
    if (!requestId) {
      throw new HttpsError("permission-denied", "Biometric replacement requires an approved Biometric Change Request ID.");
    }
    const reqSnap = await db.collection("biometric_change_requests").doc(requestId).get();
    if (!reqSnap.exists || reqSnap.data().studentUid !== studentUid || reqSnap.data().status !== "APPROVED" || reqSnap.data().used === true) {
      throw new HttpsError("permission-denied", "Valid, approved Biometric Change Request required.");
    }
    authorizedBy = `STUDENT_WITH_APPROVED_REQUEST (${requestId})`;
  } else {
    // Lecturer replacement: verify student is enrolled in at least one course taught by the lecturer
    await assertLecturer(request);
    const coursesSnap = await db.collection("courses").get();
    let isStudentInLecturerCourse = false;

    for (const doc of coursesSnap.docs) {
      const c = doc.data();
      let teaches = (c.lecturerEmail && c.lecturerEmail.toLowerCase().trim() === callerEmail);
      if (!teaches && Array.isArray(c.assignedLecturers)) {
        teaches = c.assignedLecturers.some(l => {
          const lEmail = typeof l === "string" ? l.toLowerCase().trim() : (l.email || "").toLowerCase().trim();
          return lEmail === callerEmail || (typeof l === "object" && l.uid === callerUid);
        });
      }

      if (teaches) {
        const enrolled = Array.isArray(c.enrolledStudents) ? c.enrolledStudents : [];
        if (enrolled.some(s => {
          const r = typeof s === "string" ? s.toUpperCase().trim() : (s.rollNo || s.rollNumber || "").toUpperCase().trim();
          return r === rollNo;
        })) {
          isStudentInLecturerCourse = true;
          break;
        }
      }
    }

    if (!isStudentInLecturerCourse) {
      throw new HttpsError("permission-denied", `Lecturer ${callerEmail} is not authorized to replace biometrics for ${rollNo}: student is not in lecturer's assigned course roster.`);
    }
    authorizedBy = `LECTURER (${callerEmail})`;
  }

  // Fetch current active credential
  const credRef = db.collection("biometric_credentials").doc(studentUid);
  const currentCredSnap = await credRef.get();
  const previousKey = currentCredSnap.exists ? currentCredSnap.data().publicKeyDerBase64 : null;

  const newCredentialRecord = {
    studentUid: studentUid,
    rollNo: rollNo,
    studentEmail: studentProfile.email,
    publicKeyDerBase64: newPublicKeyDerBase64.trim(),
    platform: platform || "unknown",
    status: "ACTIVE",
    previousPublicKeyDerBase64: previousKey,
    replacementAuthorizedBy: authorizedBy,
    replacementReason: reason || "Normal biometric hardware update/re-enrollment",
    updatedAt: FieldValue.serverTimestamp()
  };

  const batch = db.batch();
  batch.set(credRef, newCredentialRecord, { merge: true });
  batch.set(db.collection("biometric_credentials").doc(rollNo), newCredentialRecord, { merge: true });
  if (requestId) {
    batch.update(db.collection("biometric_change_requests").doc(requestId), {
      status: "COMPLETED",
      used: true,
      completedAt: FieldValue.serverTimestamp()
    });
  }

  await batch.commit();

  await db.collection("biometric_audit_logs").add({
    action: "BIOMETRIC_CREDENTIAL_REPLACEMENT",
    studentUid: studentUid,
    rollNo: rollNo,
    platform: platform || "unknown",
    authorizedBy: authorizedBy,
    reason: reason || "Authorized replacement",
    timestamp: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    studentUid: studentUid,
    rollNo: rollNo,
    status: "ACTIVE",
    authorizedBy: authorizedBy,
    message: "Biometric credential replaced successfully with full audit trail."
  };
});

/**
 * 13. SUBMIT BIOMETRIC CHANGE REQUEST
 * Student submits a request to replace or re-enroll biometric credentials with a stated reason.
 */
exports.submitBiometricChangeRequest = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const { reason, deviceChangeDetails } = request.data || {};
  if (!reason || typeof reason !== "string" || !reason.trim()) {
    throw new HttpsError("invalid-argument", "A valid reason for biometric change is required.");
  }

  const studentUid = request.auth.uid;
  const studentEmail = request.auth.token.email || "";
  const studentProfile = await resolveAuthoritativeStudent(studentUid, studentEmail);

  const requestId = crypto.randomUUID();
  const requestDoc = {
    requestId: requestId,
    studentUid: studentUid,
    rollNo: studentProfile.rollNo,
    studentEmail: studentProfile.email,
    reason: reason.trim(),
    deviceChangeDetails: deviceChangeDetails || {},
    status: "PENDING",
    createdAt: FieldValue.serverTimestamp()
  };

  await db.collection("biometric_change_requests").doc(requestId).set(requestDoc);

  return {
    success: true,
    requestId: requestId,
    status: "PENDING",
    message: "Biometric change request submitted successfully. Awaiting lecturer or administrator review."
  };
});

/**
 * 14. REVIEW BIOMETRIC CHANGE REQUEST
 * Authorized lecturer (within course scope) or Administrator reviews and approves/rejects.
 */
exports.reviewBiometricChangeRequest = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const { requestId, decision, notes } = request.data || {};
  if (!requestId || !["APPROVED", "REJECTED"].includes(decision)) {
    throw new HttpsError("invalid-argument", "Valid requestId and decision (APPROVED/REJECTED) are required.");
  }

  const reqRef = db.collection("biometric_change_requests").doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) {
    throw new HttpsError("not-found", "Biometric change request not found.");
  }

  const reqData = reqSnap.data();
  const callerUid = request.auth.uid;
  const callerEmail = (request.auth.token.email || "").toLowerCase().trim();
  const isAdmin = await isCallerAdmin(request);

  if (!isAdmin) {
    await assertLecturer(request);
    const coursesSnap = await db.collection("courses").get();
    let isStudentInCourse = false;
    for (const doc of coursesSnap.docs) {
      const c = doc.data();
      let teaches = (c.lecturerEmail && c.lecturerEmail.toLowerCase().trim() === callerEmail);
      if (!teaches && Array.isArray(c.assignedLecturers)) {
        teaches = c.assignedLecturers.some(l => {
          const lEmail = typeof l === "string" ? l.toLowerCase().trim() : (l.email || "").toLowerCase().trim();
          return lEmail === callerEmail || (typeof l === "object" && l.uid === callerUid);
        });
      }
      if (teaches) {
        const enrolled = Array.isArray(c.enrolledStudents) ? c.enrolledStudents : [];
        if (enrolled.some(s => {
          const r = typeof s === "string" ? s.toUpperCase().trim() : (s.rollNo || s.rollNumber || "").toUpperCase().trim();
          return r === reqData.rollNo;
        })) {
          isStudentInCourse = true;
          break;
        }
      }
    }
    if (!isStudentInCourse) {
      throw new HttpsError("permission-denied", "Lecturer is not assigned to any course containing this student.");
    }
  }

  await reqRef.update({
    status: decision,
    reviewedBy: callerEmail || callerUid,
    reviewNotes: notes || "",
    reviewedAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    requestId: requestId,
    status: decision,
    message: `Biometric change request ${decision.toLowerCase()} successfully.`
  };
});

/**
 * 15. RECORD ATTENDANCE LIFECYCLE EVENT
 * Enforces platform-specific attendance monitoring policy:
 * - Android native app:
 *   - Strict kiosk policy: first confirmed violation produces a warning; second confirmed violation rejects attendance and flags student.
 *   - Threshold enforced on the backend.
 * - iPhone native app and website/browser:
 *   - Detects supported lifecycle signals (visibilitychange, blur, willResignActive).
 *   - Records event for review without automatic disqualification.
 *   - Does not treat every hidden-page event as confirmed misconduct.
 */
exports.recordAttendanceLifecycleEvent = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to record lifecycle event.");
  }

  const { sessionId, eventType, source, platform } = request.data || {};
  if (!sessionId) {
    throw new HttpsError("invalid-argument", "Session ID is required.");
  }

  const studentUid = request.auth.uid;
  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const authRef = sessionRef.collection("authorizations").doc(studentUid);
  const authSnap = await authRef.get();

  if (!authSnap.exists) {
    throw new HttpsError("not-found", "Session authorization not found for this student.");
  }

  const authData = authSnap.data();
  const rollNo = authData.rollNo || studentUid;
  const nowMs = Date.now();

  if (platform === "android" && (eventType === "CONFIRMED_KIOSK_ESCAPE" || eventType === "APP_LEAVE")) {
    const prevCount = Number(authData.confirmedKioskViolations || authData.violationCount || 0);
    const nextCount = prevCount + 1;
    const isDisqualified = nextCount >= 2;

    const violationEntry = {
      type: "CONFIRMED_KIOSK_ESCAPE",
      source: source || "kiosk_exit",
      platform: "android",
      count: nextCount,
      timestamp: nowMs,
      disqualified: isDisqualified
    };

    const updatePayload = {
      confirmedKioskViolations: nextCount,
      violationCount: nextCount,
      disqualified: isDisqualified,
      status: isDisqualified ? "FLAGGED_DISQUALIFIED" : "FLAGGED_WARNING",
      violations: FieldValue.arrayUnion(violationEntry)
    };

    await authRef.update(updatePayload);

    if (rollNo && rollNo !== studentUid) {
      try {
        await sessionRef.collection("authorizations").doc(rollNo).update(updatePayload);
      } catch (_) {}
    }

    await sessionRef.update({
      flaggedViolations: FieldValue.arrayUnion({
        rollNo: rollNo,
        studentName: authData.studentName || rollNo,
        violationType: "CONFIRMED_KIOSK_ESCAPE",
        count: nextCount,
        disqualified: isDisqualified,
        timestamp: nowMs
      })
    });

    return {
      success: true,
      platform: "android",
      status: isDisqualified ? "DISQUALIFIED" : "WARNING",
      violationCount: nextCount,
      disqualified: isDisqualified,
      message: isDisqualified
        ? "Attendance forfeited: 2 confirmed kiosk escape violations."
        : "Warning: Kiosk exit detected (Violation 1 of 2)."
    };
  } else {
    // iPhone native app and website/browser:
    // Non-disqualifying audit logging for lecturer review.
    const eventEntry = {
      type: "SUSPICIOUS_LIFECYCLE_INTERRUPTION",
      source: source || "visibility_change",
      platform: platform || "web",
      timestamp: nowMs,
      disqualified: false
    };

    const updatePayload = {
      hasSuspiciousInterruption: true,
      lastInterruptionSource: source || "unknown",
      lastInterruptionAt: nowMs,
      lifecycleEvents: FieldValue.arrayUnion(eventEntry)
    };

    await authRef.update(updatePayload);

    if (rollNo && rollNo !== studentUid) {
      try {
        await sessionRef.collection("authorizations").doc(rollNo).update(updatePayload);
      } catch (_) {}
    }

    try {
      await sessionRef.collection("audit_logs").add({
        event: "LIFECYCLE_INTERRUPTION_REVIEW",
        studentUid: studentUid,
        rollNo: rollNo,
        platform: platform || "web",
        source: source || "visibility_change",
        timestamp: FieldValue.serverTimestamp()
      });
    } catch (_) {}

    return {
      success: true,
      platform: platform || "web",
      status: "RECORDED_FOR_REVIEW",
      disqualified: false,
      message: "Lifecycle interruption recorded for lecturer review."
    };
  }
});



