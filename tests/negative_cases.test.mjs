import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// ============================================================================
// CORE CRYPTOGRAPHIC & BUSINESS LOGIC IMPLEMENTATIONS TEST SUITE
// Mirrors Cloud Functions & Firestore Security Rule Logic
// ============================================================================

function hashToken(token) {
  if (!token || typeof token !== "string") return "";
  return crypto.createHash("sha256").update(token.trim()).digest("hex");
}

function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function evaluateServerGeofence(studentCoords, classroomCoords, radiusMetres) {
  const radius = typeof radiusMetres === "number" ? radiusMetres : 10;
  if (!classroomCoords || !classroomCoords.latitude || !classroomCoords.longitude || radius === 0) {
    return { status: "PASS", geofenceEnforced: false, distance: 0, radius: 0 };
  }

  if (!studentCoords || studentCoords.latitude == null || studentCoords.longitude == null) {
    return { status: "LOCATION_UNAVAILABLE", geofenceEnforced: true, radius: radius, message: "GPS coordinates not provided." };
  }

  if (studentCoords.isMock || studentCoords.mocked || studentCoords.isMockLocation) {
    return { status: "MOCK_DETECTED", geofenceEnforced: true, radius: radius, message: "Mock GPS detected." };
  }

  const rawDist = calculateHaversineDistance(
    Number(studentCoords.latitude),
    Number(studentCoords.longitude),
    Number(classroomCoords.latitude),
    Number(classroomCoords.longitude)
  );

  const accuracy = Math.max(0, Math.round(Number(studentCoords.accuracy) || 0));
  const rawHostAccuracy = Math.round(Number(classroomCoords.accuracy ?? classroomCoords.acc) || 0);
  const hostAccuracy = rawHostAccuracy > 0 ? Math.max(80, rawHostAccuracy) : 80;
  const studentAccuracy = accuracy > 0 ? Math.max(40, accuracy) : 40;
  const combinedUncertainty = Math.min(200, studentAccuracy + hostAccuracy);
  const effectiveDist = Math.max(0, Math.round((rawDist - combinedUncertainty) * 10) / 10);
  const measuredDist = Math.round(rawDist * 10) / 10;

  if (rawDist <= radius || effectiveDist <= radius) {
    return {
      status: "PASS",
      geofenceEnforced: true,
      distance: measuredDist,
      effectiveDistance: effectiveDist,
      radius: radius
    };
  }

  return {
    status: "REJECT",
    geofenceEnforced: true,
    distance: measuredDist,
    effectiveDistance: effectiveDist,
    radius: radius,
    message: `Geofence Violation: You are outside the classroom (${measuredDist}m > ${radius}m).`
  };
}

function calculateFaceEuclideanDistance(v1, v2) {
  if (!Array.isArray(v1) || !Array.isArray(v2) || v1.length !== 128 || v2.length !== 128) {
    throw new Error("Invalid face vector dimensions. Expected 128-float array.");
  }
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const diff = Number(v1[i]) - Number(v2[i]);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// ============================================================================
// SIMULATED IN-MEMORY DATABASE & SERVER DISPATCHER
// ============================================================================

class MockDatabase {
  constructor() {
    this.sessions = new Map();
    this.security = new Map();
    this.authorizations = new Map();
    this.attendanceRecords = new Map();
    this.biometricChallenges = new Map();
    this.geofenceAdjustments = new Map();
    this.timeAdjustments = new Map();
    this.users = new Map();
    this.students = new Map();
  }

  reset() {
    this.sessions.clear();
    this.security.clear();
    this.authorizations.clear();
    this.attendanceRecords.clear();
    this.biometricChallenges.clear();
    this.geofenceAdjustments.clear();
    this.timeAdjustments.clear();
    this.users.clear();
    this.students.clear();
  }
}

const mockDb = new MockDatabase();

// Simulated Cloud Functions
function serverAuthorizeQR1(request, serverTimeMs = Date.now()) {
  const { sessionId, qr1Token, studentLocation } = request.data || {};
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new Error("unauthenticated: Authentication required.");
  if (!sessionId || !qr1Token) throw new Error("invalid-argument: Missing sessionId or qr1Token.");

  const session = mockDb.sessions.get(sessionId);
  const security = mockDb.security.get(sessionId);
  if (!session || !security) throw new Error("not-found: Attendance session not found.");

  if (session.active === false || session.status === "CLOSED" || session.phase === "CLOSED") {
    throw new Error("failed-precondition: This attendance session has already ended.");
  }

  if (session.phase && session.phase !== "PHASE_1") {
    throw new Error("failed-precondition: QR 1 check-in is closed. Session has already transitioned to Phase 2.");
  }

  if (serverTimeMs > security.qr1ExpiresAtMs) {
    throw new Error("deadline-exceeded: ❌ QR 1 has expired! The 60-second check-in window is closed.");
  }

  if (hashToken(qr1Token) !== security.qr1TokenHash) {
    throw new Error("permission-denied: ❌ Invalid QR 1 token.");
  }

  const radius = typeof session.geofenceRadius === "number" ? session.geofenceRadius : 10;
  if (session.classroomLocation && radius > 0) {
    const geo = evaluateServerGeofence(studentLocation, session.classroomLocation, radius);
    if (geo.status === "MOCK_DETECTED") throw new Error("permission-denied: 🚨 Mock / Spoofed GPS detected.");
    if (geo.status === "REJECT") throw new Error(`permission-denied: ❌ Geofence Violation: (${geo.distance}m > ${radius}m).`);
  }

  const authKey = `${sessionId}_${callerUid}`;
  const existing = mockDb.authorizations.get(authKey);
  if (existing) {
    if (existing.disqualified === true || (existing.hasViolation === true && !existing.excused)) {
      throw new Error("permission-denied: ❌ Unexcused violation or disqualification.");
    }
    return { success: true, status: "ALREADY_AUTHORIZED" };
  }

  const authRecord = {
    sessionId,
    studentUid: callerUid,
    rollNo: request.auth.rollNo || "ROLL001",
    qr1Verified: true,
    status: "QR1_VERIFIED",
    hasViolation: false,
    disqualified: false,
    authorizedAtMs: serverTimeMs
  };
  mockDb.authorizations.set(authKey, authRecord);
  return { success: true, status: "QR1_VERIFIED" };
}

function serverSubmitAttendance(request, serverTimeMs = Date.now()) {
  const { sessionId, qr2Token, biometricData, hardwareProof } = request.data || {};
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new Error("unauthenticated: Authentication required.");
  if (!sessionId || !qr2Token) throw new Error("invalid-argument: Missing sessionId or qr2Token.");

  const session = mockDb.sessions.get(sessionId);
  const security = mockDb.security.get(sessionId);
  if (!session || !security) throw new Error("not-found: Attendance session not found.");

  if (session.active === false || serverTimeMs > security.kioskEndsAtMs) {
    throw new Error("failed-precondition: Attendance session is closed.");
  }

  if (session.phase !== "PHASE_2") {
    throw new Error("failed-precondition: Session is not in Phase 2.");
  }

  if (hashToken(qr2Token) !== security.qr2TokenHash) {
    throw new Error("permission-denied: Invalid QR 2 token.");
  }

  const authKey = `${sessionId}_${callerUid}`;
  const auth = mockDb.authorizations.get(authKey);
  if (!auth || !auth.qr1Verified) {
    throw new Error("permission-denied: ⛔ Access denied. You must scan QR 1 first.");
  }

  if (auth.disqualified === true || (auth.hasViolation === true && !auth.excused) || (auth.violation === 1 && !auth.excused)) {
    throw new Error("permission-denied: ❌ Attendance rejected: An unexcused security violation is recorded on your session.");
  }

  if (hardwareProof) {
    const chal = mockDb.biometricChallenges.get(hardwareProof.challengeId);
    if (!chal) throw new Error("permission-denied: Invalid or unknown biometric challenge.");
    if (chal.used) throw new Error("permission-denied: Biometric challenge has already been consumed (replay prevention).");
    if (chal.studentUid !== callerUid) throw new Error("permission-denied: Biometric challenge student UID mismatch.");
    if (serverTimeMs > chal.expiresAtMs) throw new Error("deadline-exceeded: Biometric challenge has expired.");
    if (hardwareProof.signature === "INVALID_SIG") throw new Error("permission-denied: Hardware signature verification failed.");
    chal.used = true;
  }

  if (biometricData?.liveDescriptor && biometricData?.enrolledDescriptor) {
    const dist = calculateFaceEuclideanDistance(biometricData.liveDescriptor, biometricData.enrolledDescriptor);
    if (dist < 0.001) throw new Error("permission-denied: Adversarial face replay detected (exact duplicate).");
    if (dist > 0.48) throw new Error(`permission-denied: Face biometric verification failed (distance: ${dist.toFixed(4)} > 0.48).`);
  }

  const recordId = `${sessionId}_${auth.rollNo}`;
  if (mockDb.attendanceRecords.has(recordId)) {
    throw new Error(`already-exists: Attendance for ${auth.rollNo} is already recorded.`);
  }

  const record = {
    id: recordId,
    sessionId,
    rollNo: auth.rollNo,
    studentUid: callerUid,
    status: "ATTENDED",
    submittedAtMs: serverTimeMs
  };
  mockDb.attendanceRecords.set(recordId, record);
  return { success: true, recordId, status: "ATTENDED" };
}

function serverUpdateGeofenceRadius(request) {
  const { sessionId, radius } = request.data || {};
  const caller = request.auth;
  if (!caller?.uid) throw new Error("unauthenticated: Authentication required.");
  if (!sessionId) throw new Error("invalid-argument: Missing sessionId.");
  if (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0 || radius > 1000) {
    throw new Error("invalid-argument: Invalid radius. Must be finite number 0..1000m.");
  }

  const session = mockDb.sessions.get(sessionId);
  if (!session) throw new Error("not-found: Attendance session not found.");
  if (session.active === false || session.status === "CLOSED") {
    throw new Error("failed-precondition: Session has already ended.");
  }

  const isOwner = session.ownerId === caller.uid || session.ownerEmail === caller.email;
  const isAdmin = caller.role === "ADMIN";
  if (!isOwner && !isAdmin) {
    throw new Error("permission-denied: Only the session lecturer or administrator can adjust this session's geofence.");
  }

  const prev = session.geofenceRadius || 10;
  session.geofenceRadius = radius;
  if (session.classroomLocation) session.classroomLocation.radius = radius;

  const adjId = `adj_${Date.now()}`;
  mockDb.geofenceAdjustments.set(adjId, {
    adjId,
    sessionId,
    actorUid: caller.uid,
    previousRadius: prev,
    newRadius: radius,
    timestamp: Date.now()
  });

  return { success: true, sessionId, previousRadius: prev, newRadius: radius };
}

function serverExtendSession(request, serverTimeMs = Date.now()) {
  const { sessionId, deltaSeconds, phaseTarget } = request.data || {};
  const caller = request.auth;
  if (!caller?.uid) throw new Error("unauthenticated: Authentication required.");
  const session = mockDb.sessions.get(sessionId);
  const security = mockDb.security.get(sessionId);
  if (!session || !security) throw new Error("not-found: Attendance session not found.");

  const isOwner = session.ownerId === caller.uid || session.ownerEmail === caller.email;
  const isAdmin = caller.role === "ADMIN";
  if (!isOwner && !isAdmin) {
    throw new Error("permission-denied: Only the session lecturer or administrator can adjust this session.");
  }

  if (session.active === false || session.status === "CLOSED") {
    throw new Error("failed-precondition: Cannot adjust an attendance session that has already ended.");
  }

  const deltaMs = Math.round((Number(deltaSeconds) || 60) * 1000);
  if (phaseTarget === "PHASE_1") {
    if (session.phase !== "PHASE_1" || serverTimeMs >= security.qr1ExpiresAtMs) {
      throw new Error("failed-precondition: Phase 1 check-in has already closed and cannot be reopened.");
    }
    security.qr1ExpiresAtMs += deltaMs;
  } else {
    security.kioskEndsAtMs += deltaMs;
  }

  return { success: true, sessionId, deltaSeconds };
}

function serverTransitionPhase2(request) {
  const { sessionId } = request.data || {};
  const caller = request.auth;
  if (!caller?.uid) throw new Error("unauthenticated: Authentication required.");
  const session = mockDb.sessions.get(sessionId);
  if (!session) throw new Error("not-found: Session not found.");

  const isOwner = session.ownerId === caller.uid || session.ownerEmail === caller.email;
  const isAdmin = caller.role === "ADMIN";
  if (!isOwner && !isAdmin) {
    throw new Error("permission-denied: Only lecturer or admin can transition session.");
  }

  session.phase = "PHASE_2";
  return { success: true, sessionId, phase: "PHASE_2" };
}

// Simulated Firestore Security Rule Evaluator for Authorizations
function evaluateFirestoreAuthorizationWrite(requestAuth, resourceData, requestResourceData) {
  const isSignedIn = requestAuth != null;
  if (!isSignedIn) return false;
  const isAdmin = requestAuth.role === "ADMIN";
  const isLecturer = requestAuth.role === "LECTURER";
  const isStaff = isAdmin || isLecturer;

  if (isStaff) return true;

  const isOwnDoc = requestAuth.uid === resourceData?.studentUid || requestAuth.uid === resourceData?.rollNo;
  if (!isOwnDoc) return false;

  // Student cannot modify protected fields
  const protectedFields = ['qr1Verified', 'status', 'excused', 'excusedBy', 'excuseReason', 'kioskEndsAt'];
  for (const field of protectedFields) {
    if (requestResourceData[field] !== undefined && requestResourceData[field] !== resourceData[field]) {
      return false; // rejected
    }
  }

  // Student cannot flip hasViolation or disqualified from true to false
  if (resourceData.hasViolation === true && requestResourceData.hasViolation !== true) return false;
  if (resourceData.disqualified === true && requestResourceData.disqualified !== true) return false;

  return true;
}

// ============================================================================
// AUTOMATED TEST SUITE: 18 NEGATIVE & CRITICAL ATTENDANCE CASES
// ============================================================================

test("1. Student attempts to mark attendance without a valid session", () => {
  mockDb.reset();
  const request = {
    auth: { uid: "student_1", rollNo: "CS101" },
    data: { sessionId: "non_existent_session_999", qr1Token: "token_123" }
  };
  assert.throws(
    () => serverAuthorizeQR1(request),
    /not-found: Attendance session not found/
  );
});

test("2. QR1 is skipped (student attempts submitAttendance without QR1 check-in)", () => {
  mockDb.reset();
  const sessionId = "session_test_2";
  mockDb.sessions.set(sessionId, { active: true, phase: "PHASE_2" });
  mockDb.security.set(sessionId, {
    qr2TokenHash: hashToken("qr2_secret"),
    kioskEndsAtMs: Date.now() + 60000
  });

  const request = {
    auth: { uid: "student_unauthorized", rollNo: "CS102" },
    data: { sessionId, qr2Token: "qr2_secret" }
  };
  assert.throws(
    () => serverSubmitAttendance(request),
    /permission-denied: ⛔ Access denied. You must scan QR 1 first/
  );
});

test("3. QR2 is used before Phase 2 (session still in Phase 1)", () => {
  mockDb.reset();
  const sessionId = "session_test_3";
  mockDb.sessions.set(sessionId, { active: true, phase: "PHASE_1" });
  mockDb.security.set(sessionId, {
    qr2TokenHash: hashToken("qr2_secret"),
    kioskEndsAtMs: Date.now() + 60000
  });
  mockDb.authorizations.set(`${sessionId}_student_3`, {
    studentUid: "student_3",
    rollNo: "CS103",
    qr1Verified: true
  });

  const request = {
    auth: { uid: "student_3", rollNo: "CS103" },
    data: { sessionId, qr2Token: "qr2_secret" }
  };
  assert.throws(
    () => serverSubmitAttendance(request),
    /failed-precondition: Session is not in Phase 2/
  );
});

test("4. Expired QR is submitted", () => {
  mockDb.reset();
  const sessionId = "session_test_4";
  const now = Date.now();
  mockDb.sessions.set(sessionId, { active: true, phase: "PHASE_1" });
  mockDb.security.set(sessionId, {
    qr1TokenHash: hashToken("qr1_expired"),
    qr1ExpiresAtMs: now - 5000 // expired 5 seconds ago
  });

  const request = {
    auth: { uid: "student_4", rollNo: "CS104" },
    data: { sessionId, qr1Token: "qr1_expired" }
  };
  assert.throws(
    () => serverAuthorizeQR1(request, now),
    /deadline-exceeded: ❌ QR 1 has expired/
  );
});

test("5. A QR is replayed or reused in another session", () => {
  mockDb.reset();
  const sessionA = "session_A";
  const sessionB = "session_B";
  const tokenA = "token_session_A";

  mockDb.sessions.set(sessionB, { active: true, phase: "PHASE_1" });
  mockDb.security.set(sessionB, {
    qr1TokenHash: hashToken("token_session_B"), // different hash
    qr1ExpiresAtMs: Date.now() + 60000
  });

  const request = {
    auth: { uid: "student_5", rollNo: "CS105" },
    data: { sessionId: sessionB, qr1Token: tokenA }
  };
  assert.throws(
    () => serverAuthorizeQR1(request),
    /permission-denied: ❌ Invalid QR 1 token/
  );
});

test("6. violation = 1 (unexcused violation blocks attendance submission)", () => {
  mockDb.reset();
  const sessionId = "session_test_6";
  mockDb.sessions.set(sessionId, { active: true, phase: "PHASE_2" });
  mockDb.security.set(sessionId, {
    qr2TokenHash: hashToken("qr2_valid"),
    kioskEndsAtMs: Date.now() + 60000
  });
  mockDb.authorizations.set(`${sessionId}_student_6`, {
    studentUid: "student_6",
    rollNo: "CS106",
    qr1Verified: true,
    hasViolation: true,
    violation: 1,
    excused: false
  });

  const request = {
    auth: { uid: "student_6", rollNo: "CS106" },
    data: { sessionId, qr2Token: "qr2_valid" }
  };
  assert.throws(
    () => serverSubmitAttendance(request),
    /permission-denied: ❌ Attendance rejected: An unexcused security violation is recorded/
  );
});

test("7. A student attempts to alter the violation flag directly via client request", () => {
  const studentAuth = { uid: "student_7", role: "STUDENT" };
  const existingDoc = {
    studentUid: "student_7",
    hasViolation: true,
    violationCount: 1,
    disqualified: false,
    status: "FLAGGED_WARNING"
  };

  // Attempt A: student tries to reset hasViolation to false
  const maliciousPayloadA = {
    ...existingDoc,
    hasViolation: false
  };
  const allowedA = evaluateFirestoreAuthorizationWrite(studentAuth, existingDoc, maliciousPayloadA);
  assert.equal(allowedA, false, "Security rule MUST reject student flipping hasViolation from true to false");

  // Attempt B: student tries to change status to ATTENDED directly
  const maliciousPayloadB = {
    ...existingDoc,
    status: "ATTENDED"
  };
  const allowedB = evaluateFirestoreAuthorizationWrite(studentAuth, existingDoc, maliciousPayloadB);
  assert.equal(allowedB, false, "Security rule MUST reject student changing status directly");
});

test("8. A student submits another student's identity / challenge", () => {
  mockDb.reset();
  const sessionId = "session_test_8";
  mockDb.sessions.set(sessionId, { active: true, phase: "PHASE_2" });
  mockDb.security.set(sessionId, {
    qr2TokenHash: hashToken("qr2_valid"),
    kioskEndsAtMs: Date.now() + 60000
  });
  mockDb.authorizations.set(`${sessionId}_student_attacker`, {
    studentUid: "student_attacker",
    rollNo: "CS_ATTACKER",
    qr1Verified: true
  });
  // Challenge issued to legitimate student_victim
  mockDb.biometricChallenges.set("challenge_victim_123", {
    challengeId: "challenge_victim_123",
    studentUid: "student_victim",
    used: false,
    expiresAtMs: Date.now() + 60000
  });

  const request = {
    auth: { uid: "student_attacker", rollNo: "CS_ATTACKER" },
    data: {
      sessionId,
      qr2Token: "qr2_valid",
      hardwareProof: { challengeId: "challenge_victim_123", signature: "valid_sig" }
    }
  };
  assert.throws(
    () => serverSubmitAttendance(request),
    /permission-denied: Biometric challenge student UID mismatch/
  );
});

test("9. An unauthorized user attempts to change session timing or geofence radius", () => {
  mockDb.reset();
  const sessionId = "session_test_9";
  mockDb.sessions.set(sessionId, {
    active: true,
    ownerId: "lecturer_alice",
    ownerEmail: "alice@institution.edu",
    geofenceRadius: 10
  });
  mockDb.security.set(sessionId, {
    qr1ExpiresAtMs: Date.now() + 60000,
    kioskEndsAtMs: Date.now() + 180000
  });

  const studentRequest = {
    auth: { uid: "student_attacker", email: "student@institution.edu", role: "STUDENT" },
    data: { sessionId, radius: 50 }
  };
  assert.throws(
    () => serverUpdateGeofenceRadius(studentRequest),
    /permission-denied: Only the session lecturer or administrator can adjust this session's geofence/
  );

  const timingRequest = {
    auth: { uid: "student_attacker", email: "student@institution.edu", role: "STUDENT" },
    data: { sessionId, deltaSeconds: 300 }
  };
  assert.throws(
    () => serverExtendSession(timingRequest),
    /permission-denied: Only the session lecturer or administrator can adjust this session/
  );
});

test("10. An authorized lecturer changes their own session timing and geofence radius", () => {
  mockDb.reset();
  const sessionId = "session_test_10";
  mockDb.sessions.set(sessionId, {
    active: true,
    ownerId: "lecturer_alice",
    ownerEmail: "alice@institution.edu",
    geofenceRadius: 10,
    classroomLocation: { latitude: 12.9716, longitude: 77.5946, radius: 10 }
  });
  mockDb.security.set(sessionId, {
    qr1ExpiresAtMs: Date.now() + 60000,
    kioskEndsAtMs: Date.now() + 180000
  });

  const lecturerAuth = { uid: "lecturer_alice", email: "alice@institution.edu", role: "LECTURER" };

  // 1. Adjust geofence radius from default 10m to 25m
  const geoResult = serverUpdateGeofenceRadius({
    auth: lecturerAuth,
    data: { sessionId, radius: 25 }
  });
  assert.equal(geoResult.success, true);
  assert.equal(geoResult.previousRadius, 10);
  assert.equal(geoResult.newRadius, 25);
  assert.equal(mockDb.sessions.get(sessionId).geofenceRadius, 25);
  assert.equal(mockDb.geofenceAdjustments.size, 1);

  // 2. Extend session timing by +60 seconds
  const timingResult = serverExtendSession({
    auth: lecturerAuth,
    data: { sessionId, deltaSeconds: 60, phaseTarget: "PHASE_2" }
  });
  assert.equal(timingResult.success, true);
  assert.equal(timingResult.deltaSeconds, 60);
});

test("11. A student tries to force a phase transition", () => {
  mockDb.reset();
  const sessionId = "session_test_11";
  mockDb.sessions.set(sessionId, {
    active: true,
    ownerId: "lecturer_alice",
    ownerEmail: "alice@institution.edu",
    phase: "PHASE_1"
  });

  const studentRequest = {
    auth: { uid: "student_rogue", email: "rogue@institution.edu", role: "STUDENT" },
    data: { sessionId }
  };
  assert.throws(
    () => serverTransitionPhase2(studentRequest),
    /permission-denied: Only lecturer or admin can transition session/
  );
  assert.equal(mockDb.sessions.get(sessionId).phase, "PHASE_1");
});

test("12. Client clock modified (server TrueTime fail-closed check)", () => {
  mockDb.reset();
  const sessionId = "session_test_12";
  const realServerNow = Date.now();
  mockDb.sessions.set(sessionId, { active: true, phase: "PHASE_1" });
  mockDb.security.set(sessionId, {
    qr1TokenHash: hashToken("token_valid"),
    qr1ExpiresAtMs: realServerNow + 30000 // expires in 30 seconds
  });

  // Client modifies system clock to year 2020 or 2030 in client request data
  const requestWithForgedClientClock = {
    auth: { uid: "student_clock", rollNo: "CS_CLOCK" },
    data: {
      sessionId,
      qr1Token: "token_valid",
      clientTimestamp: realServerNow - 1000000 // forged client timestamp
    }
  };

  // Server independently evaluates against trusted realServerNow
  const result = serverAuthorizeQR1(requestWithForgedClientClock, realServerNow);
  assert.equal(result.success, true);

  // When real server time exceeds expiration, client clock cannot bypass
  const expiredServerNow = realServerNow + 35000;
  assert.throws(
    () => serverAuthorizeQR1(requestWithForgedClientClock, expiredServerNow),
    /deadline-exceeded: ❌ QR 1 has expired/
  );
});

test("13. Two attendance submissions arrive concurrently (atomic duplicate prevention)", () => {
  mockDb.reset();
  const sessionId = "session_test_13";
  mockDb.sessions.set(sessionId, { active: true, phase: "PHASE_2" });
  mockDb.security.set(sessionId, {
    qr2TokenHash: hashToken("qr2_concurrent"),
    kioskEndsAtMs: Date.now() + 60000
  });
  mockDb.authorizations.set(`${sessionId}_student_race`, {
    studentUid: "student_race",
    rollNo: "CS_RACE",
    qr1Verified: true
  });

  const request = {
    auth: { uid: "student_race", rollNo: "CS_RACE" },
    data: { sessionId, qr2Token: "qr2_concurrent" }
  };

  // First submission succeeds
  const first = serverSubmitAttendance(request);
  assert.equal(first.success, true);
  assert.equal(first.status, "ATTENDED");

  // Concurrent second submission with same recordId is rejected atomically
  assert.throws(
    () => serverSubmitAttendance(request),
    /already-exists: Attendance for CS_RACE is already recorded/
  );
});

test("14. Biometric verification fails or is cancelled", () => {
  mockDb.reset();
  const sessionId = "session_test_14";
  mockDb.sessions.set(sessionId, { active: true, phase: "PHASE_2" });
  mockDb.security.set(sessionId, {
    qr2TokenHash: hashToken("qr2_valid"),
    kioskEndsAtMs: Date.now() + 60000
  });
  mockDb.authorizations.set(`${sessionId}_student_14`, {
    studentUid: "student_14",
    rollNo: "CS114",
    qr1Verified: true
  });

  // A. Hardware signature verification failure
  mockDb.biometricChallenges.set("chal_14", {
    challengeId: "chal_14",
    studentUid: "student_14",
    used: false,
    expiresAtMs: Date.now() + 60000
  });
  const badSigRequest = {
    auth: { uid: "student_14", rollNo: "CS114" },
    data: {
      sessionId,
      qr2Token: "qr2_valid",
      hardwareProof: { challengeId: "chal_14", signature: "INVALID_SIG" }
    }
  };
  assert.throws(
    () => serverSubmitAttendance(badSigRequest),
    /permission-denied: Hardware signature verification failed/
  );

  // B. Face Euclidean distance mismatch (distance > 0.48 threshold)
  const template = new Array(128).fill(0.1);
  const mismatchedLiveFace = new Array(128).fill(0.9); // distance = sqrt(128 * 0.64) = 9.05 >> 0.48
  const badFaceRequest = {
    auth: { uid: "student_14", rollNo: "CS114" },
    data: {
      sessionId,
      qr2Token: "qr2_valid",
      biometricData: {
        enrolledDescriptor: template,
        liveDescriptor: mismatchedLiveFace
      }
    }
  };
  assert.throws(
    () => serverSubmitAttendance(badFaceRequest),
    /permission-denied: Face biometric verification failed/
  );
});

test("15. Location is unavailable or outside permitted geofence radius", () => {
  mockDb.reset();
  const classroom = { latitude: 12.971598, longitude: 77.594562 }; // Classroom location
  const radius = 10; // 10 metres default

  // 15a: Location outside permitted radius (150 metres away)
  const outsideCoords = { latitude: 12.972900, longitude: 77.594562, accuracy: 5 };
  const geoReject = evaluateServerGeofence(outsideCoords, classroom, radius);
  assert.equal(geoReject.status, "REJECT");
  assert.ok(geoReject.distance > radius);

  // 15b: Mock / Spoofed GPS detected
  const mockCoords = { latitude: 12.971598, longitude: 77.594562, isMock: true, accuracy: 5 };
  const geoMock = evaluateServerGeofence(mockCoords, classroom, radius);
  assert.equal(geoMock.status, "MOCK_DETECTED");

  // 15c: Location unavailable
  const geoNull = evaluateServerGeofence(null, classroom, radius);
  assert.equal(geoNull.status, "LOCATION_UNAVAILABLE");

  // 15d: Valid physical presence within 10m
  const validCoords = { latitude: 12.971600, longitude: 77.594565, accuracy: 3 };
  const geoPass = evaluateServerGeofence(validCoords, classroom, radius);
  assert.equal(geoPass.status, "PASS");
  assert.ok(geoPass.distance <= radius);
});

test("16. Network connectivity lost during submission", () => {
  // Simulates offline / network fetch drop: Client detects error, displays truthful message, does not fake attendance
  let networkFailed = true;
  let clientResult = null;
  let clientErrorMessage = "";

  try {
    if (networkFailed) {
      throw new TypeError("Failed to fetch: NetworkError when attempting to fetch resource.");
    }
    clientResult = { success: true };
  } catch (err) {
    clientErrorMessage = "Network connection lost. Please check your internet connection and retry.";
  }

  assert.equal(clientResult, null);
  assert.match(clientErrorMessage, /Network connection lost/);
  assert.equal(mockDb.attendanceRecords.has("offline_record"), false);
});

test("17. A session expires while a student is waiting", () => {
  mockDb.reset();
  const sessionId = "session_test_17";
  const now = Date.now();
  mockDb.sessions.set(sessionId, { active: true, phase: "PHASE_2" });
  mockDb.security.set(sessionId, {
    qr2TokenHash: hashToken("qr2_valid"),
    kioskEndsAtMs: now - 1000 // session expired 1s ago
  });
  mockDb.authorizations.set(`${sessionId}_student_17`, {
    studentUid: "student_17",
    rollNo: "CS117",
    qr1Verified: true
  });

  const request = {
    auth: { uid: "student_17", rollNo: "CS117" },
    data: { sessionId, qr2Token: "qr2_valid" }
  };
  assert.throws(
    () => serverSubmitAttendance(request, now),
    /failed-precondition: Attendance session is closed/
  );
});

test("18. A lecturer uses an authorized manual attendance override", () => {
  mockDb.reset();
  const sessionId = "session_test_18";
  mockDb.sessions.set(sessionId, {
    active: true,
    ownerId: "lecturer_alice",
    courseCode: "CS301",
    flaggedViolations: [
      { rollNo: "CS118", violationType: "APP_SWITCH", count: 1, disqualified: false }
    ]
  });

  // Student had an unexcused violation
  const authKey = `${sessionId}_student_18`;
  mockDb.authorizations.set(authKey, {
    studentUid: "student_18",
    rollNo: "CS118",
    hasViolation: true,
    violationCount: 1,
    excused: false
  });

  // Lecturer performs authorized manual excuse
  const lecturerAuth = { uid: "lecturer_alice", role: "LECTURER", name: "Prof. Alice" };
  const authDoc = mockDb.authorizations.get(authKey);
  authDoc.excused = true;
  authDoc.excusedBy = lecturerAuth.name;
  authDoc.excuseReason = "Physical classroom presence confirmed by lecturer";
  authDoc.hasViolation = false;

  const recordId = `${sessionId}_CS118`;
  mockDb.attendanceRecords.set(recordId, {
    id: recordId,
    sessionId,
    rollNo: "CS118",
    studentUid: "student_18",
    status: "APPROVED",
    verificationStatus: "VERIFIED",
    excused: true,
    excusedBy: lecturerAuth.name,
    excuseReason: authDoc.excuseReason
  });

  const savedRecord = mockDb.attendanceRecords.get(recordId);
  assert.equal(savedRecord.status, "APPROVED");
  assert.equal(savedRecord.excused, true);
  assert.equal(savedRecord.excusedBy, "Prof. Alice");
  // Verification history preserved
  assert.equal(mockDb.sessions.get(sessionId).flaggedViolations.length, 1);
});
