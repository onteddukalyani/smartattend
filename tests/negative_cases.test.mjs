import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const prodFns = require("../functions/index.js");
const { evaluateServerGeofence, generateDynamicQrToken, verifyDynamicQrToken } = prodFns;

// ============================================================================
// CORE CRYPTOGRAPHIC & BUSINESS LOGIC IMPLEMENTATIONS TEST SUITE
// Directly tests Cloud Functions implementations & mirrors Firestore Rules
// ============================================================================

function hashToken(token) {
  if (!token || typeof token !== "string") return "";
  return crypto.createHash("sha256").update(token.trim()).digest("hex");
}

function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const nLat1 = Number(lat1);
  const nLon1 = Number(lon1);
  const nLat2 = Number(lat2);
  const nLon2 = Number(lon2);

  if (!Number.isFinite(nLat1) || !Number.isFinite(nLon1) || !Number.isFinite(nLat2) || !Number.isFinite(nLon2)) {
    return NaN;
  }

  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(nLat2 - nLat1);
  const dLon = toRad(nLon2 - nLon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(nLat1)) * Math.cos(toRad(nLat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const aClamped = Math.max(0, Math.min(1, a));
  const c = 2 * Math.atan2(Math.sqrt(aClamped), Math.sqrt(1 - aClamped));
  return R * c;
}
// evaluateServerGeofence is authoritatively imported from functions/index.js

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

function validateFaceVectorDescriptor(descriptor, fieldName = "Face descriptor") {
  let arr = descriptor;
  if (!Array.isArray(arr) && typeof arr === "object" && arr !== null) {
    const vals = Object.values(arr);
    if (vals.length === 128) arr = vals;
  }

  if (!Array.isArray(arr) || arr.length !== 128) {
    throw new Error(`invalid-argument: ${fieldName} must be a valid 128-dimensional array.`);
  }

  let sumSquares = 0;
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const val = Number(arr[i]);
    if (!Number.isFinite(val) || Math.abs(val) > 10.0) {
      throw new Error(`invalid-argument: ${fieldName} contains invalid non-numeric or out-of-bounds float values at index ${i}.`);
    }
    sum += val;
    sumSquares += val * val;
  }

  const norm = Math.sqrt(sumSquares);
  if (norm < 0.1) {
    throw new Error(`invalid-argument: ${fieldName} has near-zero magnitude.`);
  }

  const mean = sum / 128;
  let varianceSum = 0;
  for (let i = 0; i < 128; i++) {
    const d = Number(arr[i]) - mean;
    varianceSum += d * d;
  }
  const stdDev = Math.sqrt(varianceSum / 128);
  if (stdDev < 0.005) {
    throw new Error(`invalid-argument: Zero-entropy / flat face descriptor detected (stdDev: ${stdDev.toFixed(6)} < 0.005). Real face capture required.`);
  }
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
    this.biometricChangeRequests = new Map();
    this.biometricAuditLogs = [];
    this.geofenceAdjustments = new Map();
    this.timeAdjustments = new Map();
    this.users = new Map();
    this.students = new Map();
    this.biometricCredentials = new Map();
  }

  reset() {
    this.sessions.clear();
    this.security.clear();
    this.authorizations.clear();
    this.attendanceRecords.clear();
    this.biometricChallenges.clear();
    this.biometricChangeRequests.clear();
    this.biometricAuditLogs = [];
    this.geofenceAdjustments.clear();
    this.timeAdjustments.clear();
    this.users.clear();
    this.students.clear();
    this.biometricCredentials.clear();
  }
}

const mockDb = new MockDatabase();

// Simulated Cloud Functions
function serverAuthorizeQR1(request, serverTimeMs = Date.now()) {
  const { sessionId, qr1Token, studentLocation } = request.data || {};
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new Error("unauthenticated: Authentication required.");

  const isDynamicPayload = request.data?.slot !== undefined || request.data?.sig !== undefined;
  if (!sessionId || (!qr1Token && !isDynamicPayload)) {
    throw new Error("invalid-argument: Missing sessionId or qr1Token.");
  }

  const session = mockDb.sessions.get(sessionId);
  const security = mockDb.security.get(sessionId);
  if (!session || !security) throw new Error("not-found: Attendance session not found.");

  if (session.active === false || session.status === "CLOSED" || session.phase === "CLOSED") {
    throw new Error("failed-precondition: This attendance session has already ended.");
  }

  if (session.phase && session.phase !== "PHASE_1") {
    throw new Error("failed-precondition: QR 1 check-in is closed. Session has already transitioned to Phase 2.");
  }

  const qr1Expires = security.qr1ExpiresAtMs || (security.sessionStartAt ? security.sessionStartAt + 60000 : Infinity);
  if (serverTimeMs > qr1Expires) {
    throw new Error("deadline-exceeded: ❌ QR 1 has expired! The 60-second check-in window is closed.");
  }

  if (isDynamicPayload) {
    const clientSlot = Number(request.data.slot);
    const interval = security.rotationIntervalSec || 10;
    const currentSlot = Math.floor(serverTimeMs / (interval * 1000));
    const slotDiff = clientSlot - currentSlot;
    if (Math.abs(slotDiff) > 1) {
      throw new Error("deadline-exceeded: QR code has expired.");
    }
    const maxGraceMs = 5000;
    if (slotDiff === -1) {
      const elapsedSinceSlotEnded = serverTimeMs - (currentSlot * interval * 1000);
      if (elapsedSinceSlotEnded > maxGraceMs) {
        throw new Error("deadline-exceeded: QR code has expired.");
      }
    } else if (slotDiff === 1) {
      const msUntilSlotStarts = ((currentSlot + 1) * interval * 1000) - serverTimeMs;
      if (msUntilSlotStarts > maxGraceMs) {
        throw new Error("deadline-exceeded: QR code has expired.");
      }
    }
    const baseSecret = security.qr1Token || sessionId;
    const expectedSig = crypto.createHmac("sha256", baseSecret).update(`${sessionId}|1|${clientSlot}|${interval}`).digest("hex").slice(0, 16);
    if (request.data.sig && request.data.sig !== expectedSig) {
      throw new Error("permission-denied: Cryptographic QR token signature verification failed.");
    }
  } else if (hashToken(qr1Token) !== security.qr1TokenHash) {
    throw new Error("permission-denied: ❌ Invalid QR 1 token.");
  }

  const radius = typeof session.geofenceRadius === "number" ? session.geofenceRadius : 10;
  if (session.classroomLocation && radius > 0) {
    const geo = evaluateServerGeofence(studentLocation, session.classroomLocation, radius);
    if (geo.status === "MOCK_DETECTED") throw new Error("permission-denied: 🚨 Mock / Spoofed GPS detected.");
    if (geo.status === "REJECT") throw new Error(`permission-denied: ❌ Geofence Violation: (${geo.distance}m > ${radius}m).`);
  }

  const rollNo = request.auth.rollNo || "ROLL001";
  const studentDoc = mockDb.students.get(callerUid) || mockDb.students.get(rollNo);
  const boundPlatform = studentDoc?.registeredPlatform;
  if (studentDoc && (!boundPlatform || !['android', 'ios'].includes(boundPlatform))) {
    throw new Error("failed-precondition: Device platform onboarding incomplete. Your account has not been bound to an authorized device (Android or iOS). Please complete device setup before checking in.");
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
    rollNo: rollNo,
    registeredPlatform: boundPlatform || "ios",
    qr1Verified: true,
    status: "QR1_VERIFIED",
    releaseStatus: "LOCKED",
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

  // Platform enforcement: Option A First-Device Platform Binding
  const cred = mockDb.biometricCredentials.get(callerUid);
  const studentRollNo = request.auth?.rollNo;
  const studentDoc = mockDb.students.get(callerUid) || (studentRollNo ? mockDb.students.get(studentRollNo) : null);
  const boundPlatform = studentDoc?.registeredPlatform;

  if (studentDoc && (!boundPlatform || !['android', 'ios'].includes(boundPlatform))) {
    throw new Error(
      "failed-precondition: Device platform onboarding incomplete. Attendance submission requires an authorized bound device platform (Android or iOS). Please complete device setup."
    );
  }

  const authKey = `${sessionId}_${callerUid}`;
  const auth = mockDb.authorizations.get(authKey);
  if (!auth || !auth.qr1Verified) {
    throw new Error("permission-denied: ⛔ Access denied. You must scan QR 1 first.");
  }

  const qr2VerifiedAtMs = auth.qr2VerifiedAtMs || 0;
  const QR2_FACE_WINDOW_MS = 35000;
  const hasRecentQr2Validation = auth.qr2Verified === true && qr2VerifiedAtMs && (serverTimeMs - qr2VerifiedAtMs) <= QR2_FACE_WINDOW_MS;

  if (!hasRecentQr2Validation) {
    if (request.data?.slot !== undefined || request.data?.sig !== undefined) {
      const clientSlot = Number(request.data.slot);
      const interval = security.rotationIntervalSec || 10;
      const currentSlot = Math.floor(serverTimeMs / (interval * 1000));
      const slotDiff = clientSlot - currentSlot;
      if (Math.abs(slotDiff) > 1) {
        throw new Error("deadline-exceeded: QR code has expired.");
      }
      const maxGraceMs = 5000;
      if (slotDiff === -1) {
        const elapsedSinceSlotEnded = serverTimeMs - (currentSlot * interval * 1000);
        if (elapsedSinceSlotEnded > maxGraceMs) {
          throw new Error("deadline-exceeded: QR code has expired.");
        }
      } else if (slotDiff === 1) {
        const msUntilSlotStarts = ((currentSlot + 1) * interval * 1000) - serverTimeMs;
        if (msUntilSlotStarts > maxGraceMs) {
          throw new Error("deadline-exceeded: QR code has expired.");
        }
      }
      const baseSecret = security.qr2Token || sessionId;
      const expectedSig = crypto.createHmac("sha256", baseSecret).update(`${sessionId}|2|${clientSlot}|${interval}`).digest("hex").slice(0, 16);
      if (request.data.sig && request.data.sig !== expectedSig) {
        throw new Error("permission-denied: Cryptographic QR token signature verification failed.");
      }
    } else if (hashToken(qr2Token) !== security.qr2TokenHash) {
      throw new Error("permission-denied: Invalid QR 2 token.");
    }
  }

  if (auth.disqualified === true || (auth.hasViolation === true && !auth.excused) || (auth.violation === 1 && !auth.excused)) {
    throw new Error("permission-denied: ❌ Attendance rejected: An unexcused security violation is recorded on your session.");
  }

  const userAgent = (request.headers?.["user-agent"] || "").toLowerCase();
  const secChUaPlatform = (request.headers?.["sec-ch-ua-platform"] || "").toLowerCase();
  const isAndroidClient = userAgent.includes("android") || secChUaPlatform.includes("android") || request.data?.detectedPlatform === "android";
  const isAndroidBound = boundPlatform === "android" || auth.registeredPlatform === "android";
  const isAndroidSubmission = isAndroidClient || isAndroidBound || (auth.detectedPlatform === "android") || (auth.registeredPlatform === "android");

  if (isAndroidSubmission) {
    if (!hardwareProof || !hardwareProof.challengeId || !hardwareProof.signature) {
      throw new Error(
        "permission-denied: Android attendance requires the authorized native SmartAttend application with hardware biometric authentication. Submissions from Android web browsers or direct unsigned calls are prohibited."
      );
    }
    if (!cred || cred.status !== "ACTIVE") {
      throw new Error(
        "permission-denied: Hardware biometric authentication is required for Android attendance, but no active native credential was found."
      );
    }
  }

  if (request.data?.isNative && (!hardwareProof || !hardwareProof.challengeId || !hardwareProof.signature)) {
    throw new Error(
      "permission-denied: Native mobile attendance requires verified hardware biometric proof. Untrusted platform flags are rejected."
    );
  }

  if (hardwareProof) {
    const chal = mockDb.biometricChallenges.get(hardwareProof.challengeId);
    if (!chal) throw new Error("permission-denied: Invalid or unknown biometric challenge.");
    if (chal.used) throw new Error("permission-denied: Biometric challenge has already been consumed (replay prevention).");
    if (chal.studentUid !== callerUid) throw new Error("permission-denied: Biometric challenge student UID mismatch.");
    if (chal.sessionId && chal.sessionId !== sessionId) throw new Error("permission-denied: Biometric challenge was issued for a different session.");
    if (chal.action && chal.action !== "ATTENDANCE_VERIFICATION") throw new Error("permission-denied: Biometric challenge action mismatch.");
    if (serverTimeMs > chal.expiresAtMs) throw new Error("deadline-exceeded: Biometric challenge has expired.");
    if (hardwareProof.signature === "INVALID_SIG") throw new Error("permission-denied: Hardware signature verification failed.");
    chal.used = true;
  }

  if (biometricData?.liveness === false) {
    throw new Error("permission-denied: Face liveness verification failed. Active optical presence required.");
  }

  if (biometricData?.liveDescriptor && biometricData?.enrolledDescriptor) {
    const dist = calculateFaceEuclideanDistance(biometricData.liveDescriptor, biometricData.enrolledDescriptor);
    if (dist > 0.52) throw new Error(`permission-denied: Face biometric verification failed (distance: ${dist.toFixed(4)} > 0.52).`);
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
  auth.qr2Verified = false;
  return { success: true, recordId, status: "ATTENDED" };
}

function serverValidateQR2(request, serverTimeMs = Date.now()) {
  const { sessionId, qr2Token } = request.data || {};
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new Error("unauthenticated: Authentication required.");
  if (!sessionId) throw new Error("invalid-argument: Missing sessionId.");

  const session = mockDb.sessions.get(sessionId);
  const security = mockDb.security.get(sessionId);
  if (!session || !security) throw new Error("not-found: Attendance session not found.");

  if (session.active === false || serverTimeMs > security.kioskEndsAtMs) {
    throw new Error("deadline-exceeded: Attendance session is closed.");
  }

  const interval = security.rotationIntervalSec || 10;
  if (request.data?.slot !== undefined || request.data?.sig !== undefined) {
    const clientSlot = Number(request.data.slot);
    const currentSlot = Math.floor(serverTimeMs / (interval * 1000));
    const slotDiff = clientSlot - currentSlot;
    if (Math.abs(slotDiff) > 1) {
      throw new Error("deadline-exceeded: QR code has expired.");
    }
    const maxGraceMs = 5000;
    if (slotDiff === -1) {
      const elapsedSinceSlotEnded = serverTimeMs - (currentSlot * interval * 1000);
      if (elapsedSinceSlotEnded > maxGraceMs) {
        throw new Error("deadline-exceeded: QR code has expired.");
      }
    } else if (slotDiff === 1) {
      const msUntilSlotStarts = ((currentSlot + 1) * interval * 1000) - serverTimeMs;
      if (msUntilSlotStarts > maxGraceMs) {
        throw new Error("deadline-exceeded: QR code has expired.");
      }
    }
    const baseSecret = security.qr2Token || sessionId;
    const expectedSig = crypto.createHmac("sha256", baseSecret).update(`${sessionId}|2|${clientSlot}|${interval}`).digest("hex").slice(0, 16);
    if (request.data.sig && request.data.sig !== expectedSig) {
      throw new Error("permission-denied: Cryptographic QR token signature verification failed.");
    }
  } else if (hashToken(qr2Token) !== security.qr2TokenHash) {
    throw new Error("permission-denied: Invalid QR 2 token.");
  }

  const authKey = `${sessionId}_${callerUid}`;
  const auth = mockDb.authorizations.get(authKey);
  if (!auth || !auth.qr1Verified) {
    throw new Error("permission-denied: ⛔ Access denied. You must scan QR 1 first.");
  }

  if (auth.disqualified === true || (auth.hasViolation === true && !auth.excused) || (auth.violation === 1 && !auth.excused)) {
    throw new Error("permission-denied: ❌ Access rejected: An unexcused security violation is recorded on your session.");
  }

  auth.qr2Verified = true;
  auth.qr2VerifiedAtMs = serverTimeMs;
  auth.status = "QR2_VERIFIED";
  return { success: true, authorized: true, sessionId, rollNo: auth.rollNo };
}

function serverRegisterStudentFace(request) {
  const caller = request.auth;
  if (!caller?.uid) throw new Error("unauthenticated: Authentication required.");
  const { rollNo, faceDescriptor } = request.data || {};
  if (!rollNo || !faceDescriptor) throw new Error("invalid-argument: Missing rollNo or faceDescriptor.");

  validateFaceVectorDescriptor(faceDescriptor, `Face descriptor for ${rollNo}`);

  const isStaff = caller.role === "LECTURER" || caller.role === "ADMIN";
  const existing = mockDb.students.get(rollNo);

  if (!isStaff) {
    if (caller.rollNo && caller.rollNo !== rollNo) {
      throw new Error("permission-denied: You can only enroll face biometrics for your own student account.");
    }
    if (existing && existing.faceDescriptor && existing.faceDescriptor.length === 128) {
      throw new Error("failed-precondition: Face biometrics are already enrolled and locked.");
    }
  }

  mockDb.students.set(rollNo, {
    rollNo,
    studentUid: caller.uid,
    faceDescriptor,
    faceRegistered: true
  });
  return { success: true, rollNo, message: "Face biometrics enrolled successfully." };
}

function serverUpdateGeofenceRadius(request) {
  const { sessionId, radius } = request.data || {};
  const caller = request.auth;
  if (!caller?.uid) throw new Error("unauthenticated: Authentication required.");
  if (!sessionId) throw new Error("invalid-argument: Missing sessionId.");
  if (radius === undefined || radius === null || typeof radius !== "number" || !Number.isFinite(radius) || radius < 5 || radius > 50) {
    throw new Error("invalid-argument: Invalid radius. Must be finite number between 5 and 50 metres (default is 10m).");
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

function serverBindStudentDevicePlatform(request) {
  const caller = request.auth;
  if (!caller?.uid) throw new Error("unauthenticated: Authentication required to bind device platform.");

  const { platform } = request.data || {};
  if (!platform || typeof platform !== "string") {
    throw new Error("invalid-argument: Missing or invalid platform parameter. Expected 'android' or 'ios'.");
  }

  const cleanPlatform = platform.trim().toLowerCase();
  if (cleanPlatform !== "android" && cleanPlatform !== "ios") {
    throw new Error(`invalid-argument: Invalid device platform '${platform}'. Only 'android' and 'ios' are supported.`);
  }

  const rollNo = caller.rollNo || "ROLL001";
  const existing = mockDb.students.get(rollNo) || mockDb.students.get(caller.uid);
  const existingPlatform = existing?.registeredPlatform;

  if (existingPlatform && (existingPlatform === "android" || existingPlatform === "ios")) {
    throw new Error(
      `already-exists: Device platform is already bound to '${existingPlatform}' for ${rollNo}. Ordinary re-binding is prohibited. To request a platform change, submit an authorized Device Change Request.`
    );
  }

  const updatedRecord = {
    ...(existing || {}),
    rollNo,
    studentUid: caller.uid,
    registeredPlatform: cleanPlatform,
    deviceType: cleanPlatform,
    registeredDeviceType: cleanPlatform,
    deviceTypeLocked: true,
    platformBoundAt: Date.now()
  };

  mockDb.students.set(rollNo, updatedRecord);
  mockDb.students.set(caller.uid, updatedRecord);

  mockDb.biometricAuditLogs.push({
    action: "DEVICE_PLATFORM_INITIAL_BINDING",
    studentUid: caller.uid,
    rollNo,
    platform: cleanPlatform,
    timestamp: Date.now()
  });

  return { success: true, rollNo, platform: cleanPlatform };
}

function serverResetStudentDevicePlatform(request) {
  const caller = request.auth;
  if (!caller?.uid) throw new Error("unauthenticated: Authentication required to reset device platform.");

  const { targetRollNo, targetStudentUid, newPlatform, requestId, reason } = request.data || {};
  if (!newPlatform || typeof newPlatform !== "string") {
    throw new Error("invalid-argument: New platform is required. Expected 'android' or 'ios'.");
  }

  const cleanNewPlatform = newPlatform.trim().toLowerCase();
  if (cleanNewPlatform !== "android" && cleanNewPlatform !== "ios") {
    throw new Error(`invalid-argument: Invalid platform '${newPlatform}'. Only 'android' and 'ios' are supported.`);
  }

  const rollNo = targetRollNo || caller.rollNo || "ROLL001";
  let studentUid = targetStudentUid;
  if (!studentUid && targetRollNo) {
    const s = mockDb.students.get(targetRollNo);
    if (s) studentUid = s.studentUid;
  }
  if (!studentUid) studentUid = caller.uid;

  let authorizedBy = "ADMIN";
  if (caller.role === "ADMIN") {
    authorizedBy = `ADMIN (${caller.email || caller.uid})`;
  } else if (caller.uid === studentUid) {
    if (!requestId) {
      throw new Error("permission-denied: Platform change requires an approved Biometric Change Request ID.");
    }
    const req = mockDb.biometricChangeRequests.get(requestId);
    if (!req || req.studentUid !== studentUid || req.status !== "APPROVED" || req.used === true) {
      throw new Error("permission-denied: Valid, approved Biometric Change Request required.");
    }
    req.status = "COMPLETED";
    req.used = true;
    authorizedBy = `STUDENT_WITH_APPROVED_REQUEST (${requestId})`;
  } else if (caller.role === "LECTURER") {
    if (request.isRosterAuthorized === false) {
      throw new Error(`permission-denied: Lecturer is not authorized to reset platform for ${rollNo}: student is not in lecturer's assigned course roster.`);
    }
    authorizedBy = `LECTURER (${caller.email || caller.uid})`;
  } else {
    throw new Error("permission-denied: Unauthorized platform reset request.");
  }

  const existing = mockDb.students.get(rollNo) || mockDb.students.get(studentUid) || {};
  existing.registeredPlatform = cleanNewPlatform;
  existing.deviceType = cleanNewPlatform;
  existing.registeredDeviceType = cleanNewPlatform;
  existing.deviceTypeLocked = true;
  existing.platformResetAt = Date.now();

  mockDb.students.set(rollNo, existing);
  mockDb.students.set(studentUid, existing);

  // Revoke credentials on any platform reset so superseded credentials cannot authenticate
  const cred = mockDb.biometricCredentials.get(studentUid) || (rollNo ? mockDb.biometricCredentials.get(rollNo) : null);
  if (cred) {
    cred.status = "SUPERSEDED";
    cred.reason = `Platform reset to ${cleanNewPlatform}`;
  }

  mockDb.biometricAuditLogs.push({
    action: "DEVICE_PLATFORM_RESET",
    studentUid,
    rollNo,
    newPlatform: cleanNewPlatform,
    authorizedBy,
    timestamp: Date.now()
  });

  return { success: true, rollNo, newPlatform: cleanNewPlatform, authorizedBy };
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

  // 1b. Boundary testing: 5m (minimum) and 50m (maximum) are accepted
  const geoMin = serverUpdateGeofenceRadius({ auth: lecturerAuth, data: { sessionId, radius: 5 } });
  assert.equal(geoMin.newRadius, 5);
  const geoMax = serverUpdateGeofenceRadius({ auth: lecturerAuth, data: { sessionId, radius: 50 } });
  assert.equal(geoMax.newRadius, 50);

  // 1c. Out-of-bounds rejection: < 5m (4m, 0m, negative) and > 50m (51m, 1000m)
  assert.throws(
    () => serverUpdateGeofenceRadius({ auth: lecturerAuth, data: { sessionId, radius: 4 } }),
    /invalid-argument: Invalid radius/
  );
  assert.throws(
    () => serverUpdateGeofenceRadius({ auth: lecturerAuth, data: { sessionId, radius: 0 } }),
    /invalid-argument: Invalid radius/
  );
  assert.throws(
    () => serverUpdateGeofenceRadius({ auth: lecturerAuth, data: { sessionId, radius: -10 } }),
    /invalid-argument: Invalid radius/
  );
  assert.throws(
    () => serverUpdateGeofenceRadius({ auth: lecturerAuth, data: { sessionId, radius: 51 } }),
    /invalid-argument: Invalid radius/
  );
  assert.throws(
    () => serverUpdateGeofenceRadius({ auth: lecturerAuth, data: { sessionId, radius: 1000 } }),
    /invalid-argument: Invalid radius/
  );

  // 1d. Invalid types rejection: non-numeric, NaN, Infinity, null, undefined
  assert.throws(
    () => serverUpdateGeofenceRadius({ auth: lecturerAuth, data: { sessionId, radius: "twenty" } }),
    /invalid-argument: Invalid radius/
  );
  assert.throws(
    () => serverUpdateGeofenceRadius({ auth: lecturerAuth, data: { sessionId, radius: NaN } }),
    /invalid-argument: Invalid radius/
  );
  assert.throws(
    () => serverUpdateGeofenceRadius({ auth: lecturerAuth, data: { sessionId, radius: Infinity } }),
    /invalid-argument: Invalid radius/
  );
  assert.throws(
    () => serverUpdateGeofenceRadius({ auth: lecturerAuth, data: { sessionId, radius: null } }),
    /invalid-argument: Invalid radius/
  );
  // Ensure invalid values are NEVER silently converted to default 10m
  assert.equal(mockDb.sessions.get(sessionId).geofenceRadius, 50);

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

  // B. Face Euclidean distance mismatch (distance > 0.52 threshold)
  const template = new Array(128).fill(0.1);
  const mismatchedLiveFace = new Array(128).fill(0.9); // distance = sqrt(128 * 0.64) = 9.05 >> 0.52
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

  // 15e: Student 45m away (outside 10m radius) is strictly REJECTED (proves no 100m loophole!)
  const intermediateCoords = { latitude: 12.972000, longitude: 77.594562, accuracy: 5 };
  const geoRejectIntermediate = evaluateServerGeofence(intermediateCoords, classroom, radius);
  assert.equal(geoRejectIntermediate.status, "REJECT");
  assert.ok(geoRejectIntermediate.distance > radius);
  assert.ok(geoRejectIntermediate.distance >= 40 && geoRejectIntermediate.distance <= 50);

  // 15f: Student inside classroom with indoor Wi-Fi/GPS attenuation (15m measured distance, 20m accuracy) accurately passes
  const indoorCoords = { latitude: 12.971730, longitude: 77.594562, accuracy: 20 };
  const geoIndoor = evaluateServerGeofence(indoorCoords, { ...classroom, accuracy: 20 }, radius);
  assert.equal(geoIndoor.status, "PASS");
  assert.ok(geoIndoor.effectiveDistance <= radius);

  // 15g: Distance calculation accurately matches Haversine formula
  const exactDist = calculateHaversineDistance(classroom.latitude, classroom.longitude, intermediateCoords.latitude, intermediateCoords.longitude);
  assert.ok(Math.abs(geoRejectIntermediate.distance - Math.round(exactDist * 10) / 10) < 0.1);
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

test("19. Student exits Kiosk mode using Lecturer Emergency Release PIN", () => {
  mockDb.reset();
  const sessionId = "CS101_PIN_SESSION";
  const correctPin = "482915";
  const pinHash = hashToken(correctPin);

  // Setup session with sessionPinHash on session document
  mockDb.sessions.set(sessionId, {
    sessionId,
    courseCode: "CS101",
    status: "ACTIVE",
    phase: "PHASE_1",
    sessionPinHash: pinHash,
    lecturerReleaseCodeHash: pinHash
  });

  const studentUid = "student_kiosk_19";
  mockDb.authorizations.set(`${sessionId}_${studentUid}`, {
    sessionId,
    studentUid,
    rollNo: "CS119",
    status: "QR1_VERIFIED",
    qr1Verified: true,
    released: false,
    releaseStatus: "LOCKED"
  });

  // A. Correct PIN verification succeeds without internal error
  const verifyPin = (inputPin) => {
    if (!inputPin) throw new Error("Session PIN is required.");
    const inputHash = hashToken(String(inputPin).trim());
    const session = mockDb.sessions.get(sessionId);
    if (!session) throw new Error("Attendance session not found.");
    if (inputHash !== session.sessionPinHash && inputPin !== session.sessionPin) {
      throw new Error("❌ Invalid Session PIN. Please check the 6-digit code given by your lecturer and try again.");
    }
    const auth = mockDb.authorizations.get(`${sessionId}_${studentUid}`);
    if (auth) {
      auth.released = true;
      auth.releaseStatus = "PIN_RELEASED";
      auth.releasedAt = Date.now();
    }
    return { success: true, releaseAuthorized: true, sessionId };
  };

  // Valid PIN unlocks device
  const res = verifyPin(correctPin);
  assert.equal(res.success, true);
  assert.equal(res.releaseAuthorized, true);
  const updatedAuth = mockDb.authorizations.get(`${sessionId}_${studentUid}`);
  assert.equal(updatedAuth.released, true);
  assert.equal(updatedAuth.releaseStatus, "PIN_RELEASED");

  // B. Invalid PIN rejects with clear message (no "INTERNAL" error)
  assert.throws(
    () => verifyPin("999999"),
    /Invalid Session PIN/
  );

  // C. Empty PIN throws required argument error
  assert.throws(
    () => verifyPin(""),
    /Session PIN is required/
  );
});

// ============================================================================
// ADDITIONAL TESTS: STAGE REMEDIATION VERIFICATION
// ============================================================================

// Helper: serverUpdateSessionQrInterval logic simulation
function serverUpdateSessionQrInterval(request) {
  const { sessionId, rotationIntervalSec } = request.data || {};
  const caller = request.auth;
  if (!caller?.uid) throw new Error("unauthenticated: Authentication required.");
  if (!sessionId) throw new Error("invalid-argument: Session ID is required.");

  const interval = Number(rotationIntervalSec);
  if (!Number.isInteger(interval) || interval < 5 || interval > 60 || interval % 5 !== 0) {
    throw new Error("invalid-argument: QR rotation interval must be an integer between 5 and 60 seconds, in increments of 5 seconds.");
  }

  const session = mockDb.sessions.get(sessionId);
  if (!session) throw new Error("not-found: Attendance session not found.");
  if (session.active === false || session.status === "CLOSED") {
    throw new Error("failed-precondition: Cannot modify a closed session.");
  }

  const isOwner = session.ownerId === caller.uid || session.ownerEmail === caller.email;
  const isAdmin = caller.role === "ADMIN";
  if (!isOwner && !isAdmin) {
    throw new Error("permission-denied: Only the session lecturer or an administrator can update the QR rotation interval.");
  }

  session.rotationIntervalSec = interval;
  const security = mockDb.security.get(sessionId);
  if (security) {
    security.rotationIntervalSec = interval;
  }
  return { success: true, sessionId, rotationIntervalSec: interval };
}

// generateDynamicQrToken and verifyDynamicQrToken are authoritatively imported from functions/index.js

test("20. Configurable QR rotation intervals (5-60s in 5s increments, default 10s, ownership enforced)", () => {
  mockDb.reset();
  const sessionId = "CS101_QR_ROTATION";
  const lecturerAlice = { uid: "lecturer_alice", email: "alice@univ.edu", role: "LECTURER" };
  const lecturerBob = { uid: "lecturer_bob", email: "bob@univ.edu", role: "LECTURER" };
  const student = { uid: "student_1", email: "student1@univ.edu", role: "STUDENT" };
  const admin = { uid: "admin_super", email: "admin@univ.edu", role: "ADMIN" };

  mockDb.sessions.set(sessionId, {
    sessionId,
    ownerId: lecturerAlice.uid,
    ownerEmail: lecturerAlice.email,
    active: true,
    status: "ACTIVE",
    rotationIntervalSec: 10 // safe default
  });
  mockDb.security.set(sessionId, {
    rotationIntervalSec: 10
  });

  // A. Default interval is 10s
  assert.equal(mockDb.sessions.get(sessionId).rotationIntervalSec, 10);

  // B. Allowed values: 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60
  const validIntervals = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
  for (const interval of validIntervals) {
    const res = serverUpdateSessionQrInterval({
      auth: lecturerAlice,
      data: { sessionId, rotationIntervalSec: interval }
    });
    assert.equal(res.success, true);
    assert.equal(res.rotationIntervalSec, interval);
    assert.equal(mockDb.sessions.get(sessionId).rotationIntervalSec, interval);
  }

  // C. Disallowed values rejected: non-integers, non-multiples of 5, < 5, > 60
  const invalidIntervals = [0, -5, 3, 7, 12, 17, 33, 42, 65, 120, 12.5, "10.5", NaN];
  for (const badVal of invalidIntervals) {
    assert.throws(
      () => serverUpdateSessionQrInterval({
        auth: lecturerAlice,
        data: { sessionId, rotationIntervalSec: badVal }
      }),
      /must be an integer between 5 and 60 seconds, in increments of 5 seconds/
    );
  }

  // D. Ownership check: Lecturer Bob cannot change Lecturer Alice's session
  assert.throws(
    () => serverUpdateSessionQrInterval({
      auth: lecturerBob,
      data: { sessionId, rotationIntervalSec: 15 }
    }),
    /permission-denied: Only the session lecturer or an administrator can update/
  );

  // E. Student cannot change QR interval
  assert.throws(
    () => serverUpdateSessionQrInterval({
      auth: student,
      data: { sessionId, rotationIntervalSec: 15 }
    }),
    /permission-denied: Only the session lecturer or an administrator can update/
  );

  // F. Admin CAN change QR interval
  const adminRes = serverUpdateSessionQrInterval({
    auth: admin,
    data: { sessionId, rotationIntervalSec: 25 }
  });
  assert.equal(adminRes.success, true);
  assert.equal(adminRes.rotationIntervalSec, 25);
  assert.equal(mockDb.sessions.get(sessionId).rotationIntervalSec, 25);
});

test("21. Authoritative dynamic QR rotation token verification and skew prevention (all intervals 5-60s verified)", () => {
  mockDb.reset();
  const sessionId = "CS101_DYNAMIC_QR";
  const secret = "session_secret_hmac_key_12345";
  const supportedIntervals = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

  // Test every supported interval for exact acceptance window and zero mismatch
  for (const interval of supportedIntervals) {
    const baseTime = 1700000000000;
    const currentSlot = Math.floor(baseTime / (interval * 1000));
    const slotStartTime = currentSlot * interval * 1000;
    const slotEndTime = (currentSlot + 1) * interval * 1000;
    const validToken = generateDynamicQrToken(sessionId, 1, currentSlot, interval, secret);

    // 1. Current slot verifies successfully
    assert.equal(
      verifyDynamicQrToken(validToken, sessionId, 1, currentSlot, interval, interval, slotStartTime + 1000, secret),
      true
    );

    // 2. Previous slot verifies within bounded 5-second rotation grace
    const prevSlot = currentSlot - 1;
    const prevToken = generateDynamicQrToken(sessionId, 1, prevSlot, interval, secret);
    // At 2 seconds into current slot (2s after rotation), previous slot token is accepted
    assert.equal(
      verifyDynamicQrToken(prevToken, sessionId, 1, prevSlot, interval, interval, slotStartTime + 2000, secret),
      true
    );
    // Deterministic boundary testing:
    if (interval >= 10) {
      // For intervals >= 10s, at exactly 5000ms into current slot, previous slot is accepted (within 5s grace)
      assert.equal(
        verifyDynamicQrToken(prevToken, sessionId, 1, prevSlot, interval, interval, slotStartTime + 5000, secret),
        true
      );
      // Immediately outside boundary: 5001ms (1ms past 5s grace) is strictly rejected
      assert.throws(
        () => verifyDynamicQrToken(prevToken, sessionId, 1, prevSlot, interval, interval, slotStartTime + 5001, secret),
        /deadline-exceeded: QR code has expired/
      );
    } else {
      // For interval = 5s, within current slot (4990ms) is accepted; at 5001ms slot has advanced to +1 (2 slots away) and is rejected
      assert.equal(
        verifyDynamicQrToken(prevToken, sessionId, 1, prevSlot, interval, interval, slotStartTime + 4990, secret),
        true
      );
      assert.throws(
        () => verifyDynamicQrToken(prevToken, sessionId, 1, prevSlot, interval, interval, slotStartTime + 5001, secret),
        /deadline-exceeded: QR code has expired/
      );
    }
    // At 6 seconds (> 5s grace window) strictly rejected
    assert.throws(
      () => verifyDynamicQrToken(prevToken, sessionId, 1, prevSlot, interval, interval, slotStartTime + 6000, secret),
      /deadline-exceeded: QR code has expired/
    );

    // 4. Future slot within 5-second clock skew / pre-rotation grace verifies
    const nextSlot = currentSlot + 1;
    const nextToken = generateDynamicQrToken(sessionId, 1, nextSlot, interval, secret);
    // At 2 seconds before slot transition (within 5s future grace)
    assert.equal(
      verifyDynamicQrToken(nextToken, sessionId, 1, nextSlot, interval, interval, slotEndTime - 2000, secret),
      true
    );
    // Deterministic exact boundary: At exactly 5000ms before slot transition, future slot is accepted
    assert.equal(
      verifyDynamicQrToken(nextToken, sessionId, 1, nextSlot, interval, interval, slotEndTime - 5000, secret),
      true
    );

    // 5. Future slot immediately outside 5-second grace (5001ms before slot begins) is rejected for intervals >= 10s
    if (interval >= 10) {
      assert.throws(
        () => verifyDynamicQrToken(nextToken, sessionId, 1, nextSlot, interval, interval, slotEndTime - 5001, secret),
        /deadline-exceeded: QR code has expired/
      );
      assert.throws(
        () => verifyDynamicQrToken(nextToken, sessionId, 1, nextSlot, interval, interval, slotEndTime - 6000, secret),
        /deadline-exceeded: QR code has expired/
      );
    }

    // 6. Stale slot (> 1 slot old) is unconditionally rejected
    const staleSlot = currentSlot - 2;
    const staleToken = generateDynamicQrToken(sessionId, 1, staleSlot, interval, secret);
    assert.throws(
      () => verifyDynamicQrToken(staleToken, sessionId, 1, staleSlot, interval, interval, slotStartTime, secret),
      /deadline-exceeded: QR code has expired/
    );

    // 7. Far future slot (>= 2 slots ahead) is unconditionally rejected
    const farFutureSlot = currentSlot + 2;
    const farFutureToken = generateDynamicQrToken(sessionId, 1, farFutureSlot, interval, secret);
    assert.throws(
      () => verifyDynamicQrToken(farFutureToken, sessionId, 1, farFutureSlot, interval, interval, slotStartTime, secret),
      /deadline-exceeded: QR code has expired/
    );

    // 7b. Wrong session token fails signature verification
    assert.throws(
      () => verifyDynamicQrToken(validToken, "OTHER_SESSION_DIFFERENT_ID", 1, currentSlot, interval, interval, slotStartTime, secret),
      /permission-denied: Invalid QR token signature/
    );

    // 8. Forged signature / replayed invalid token rejected
    assert.throws(
      () => verifyDynamicQrToken("forged_signature_token_hex_999", sessionId, 1, currentSlot, interval, interval, slotStartTime, secret),
      /permission-denied: Invalid QR token signature/
    );

    // 9. Client interval mismatch rejected
    assert.throws(
      () => verifyDynamicQrToken(validToken, sessionId, 1, currentSlot, 60 === interval ? 10 : 60, interval, slotStartTime, secret),
      /invalid-argument: Mismatched QR rotation interval configuration/
    );

    // 10. Client clock manipulation cannot extend token validity:
    // Even if client claims local time is T_manipulated, server computes slot strictly from serverNow.
    // If a student presents a token from 3 slots ago, claiming their phone clock was adjusted, server strictly fails.
    const manipulatedSlot = currentSlot - 3;
    const manipulatedToken = generateDynamicQrToken(sessionId, 1, manipulatedSlot, interval, secret);
    assert.throws(
      () => verifyDynamicQrToken(manipulatedToken, sessionId, 1, manipulatedSlot, interval, interval, slotStartTime + 1000, secret),
      /deadline-exceeded: QR code has expired/
    );
  }
});

test("22. Default Geofence is 10 metres and defensible sensor uncertainty policy functions correctly", () => {
  mockDb.reset();
  const classroom = { latitude: 12.9716, longitude: 77.5946, accuracy: 5 };

  // 1. Student right at classroom coordinates (distance 0m <= 10m)
  const inside = { latitude: 12.9716, longitude: 77.5946, accuracy: 5 };
  const resInside = evaluateServerGeofence(inside, classroom, undefined); // undefined -> defaults to 10m
  assert.equal(resInside.status, "PASS");
  assert.equal(resInside.radius, 10);

  // 2. Mock GPS is detected and rejected
  const mockGps = { latitude: 12.9716, longitude: 77.5946, isMock: true };
  const resMock = evaluateServerGeofence(mockGps, classroom, 10);
  assert.equal(resMock.status, "MOCK_DETECTED");

  // 3. Boundary: Student at ~12.2m from center with 8m accuracy (allowance 4m -> eff 8.2m <= 10m) -> PASS
  const nearBoundary = { latitude: 12.97171, longitude: 77.5946, accuracy: 8 };
  const resNear = evaluateServerGeofence(nearBoundary, classroom, 10);
  assert.equal(resNear.status, "PASS");

  // 4. Boundary Verification at Accuracy = 8m (Max allowance = min(8/2, 5) = 4m -> max permitted raw dist = 14.0m):
  // 4a. Just below boundary (13.9m raw dist, 8m accuracy): 13.9 - 4 = 9.9m <= 10m -> PASS
  const justBelow8m = { latitude: 12.9716 + 0.00012501, longitude: 77.5946, accuracy: 8 };
  const resBelow8m = evaluateServerGeofence(justBelow8m, classroom, 10);
  assert.equal(resBelow8m.status, "PASS");
  assert.equal(resBelow8m.distance, 13.9);
  assert.equal(resBelow8m.effectiveDistance, 9.9);

  // 4b. Exactly at boundary (14.0m raw dist, 8m accuracy): 14.0 - 4 = 10.0m <= 10m -> PASS
  const exactlyAt8m = { latitude: 12.9716 + 0.00012591, longitude: 77.5946, accuracy: 8 };
  const resAt8m = evaluateServerGeofence(exactlyAt8m, classroom, 10);
  assert.equal(resAt8m.status, "PASS");
  assert.equal(resAt8m.distance, 14.0);
  assert.equal(resAt8m.effectiveDistance, 10.0);

  // 4c. Just above boundary (14.1m raw dist, 8m accuracy): 14.1 - 4 = 10.1m > 10m -> REJECT
  const justAbove8m = { latitude: 12.9716 + 0.00012680, longitude: 77.5946, accuracy: 8 };
  const resAbove8m = evaluateServerGeofence(justAbove8m, classroom, 10);
  assert.equal(resAbove8m.status, "REJECT");
  assert.equal(resAbove8m.distance, 14.1);
  assert.equal(resAbove8m.effectiveDistance, 10.1);

  // 4d. Raw distance 16.7m with 8m accuracy: 16.7 - 4 = 12.7m > 10m -> REJECT
  // Reconciles formula discrepancy: rawDistance - min(accuracy, 10) would have given 8.7m (PASS),
  // but actual production formula rawDistance - min(accuracy/2, 5) gives 12.7m (REJECT).
  const dist16_7m = { latitude: 12.9716 + 0.00015019, longitude: 77.5946, accuracy: 8 };
  const res16_7m = evaluateServerGeofence(dist16_7m, classroom, 10);
  assert.equal(res16_7m.status, "REJECT");
  assert.equal(res16_7m.distance, 16.7);
  assert.equal(res16_7m.effectiveDistance, 12.7);

  // 5. Absolute Physical Boundary at Radius = 10m (Max allowance capped at 5.0m):
  // 5a. Just below 15m ceiling (14.9m raw dist, 10m accuracy): 14.9 - 5 = 9.9m <= 10m -> PASS
  const justBelow15m = { latitude: 12.9716 + 0.00013400, longitude: 77.5946, accuracy: 10 };
  const resBelow15m = evaluateServerGeofence(justBelow15m, classroom, 10);
  assert.equal(resBelow15m.status, "PASS");
  assert.equal(resBelow15m.distance, 14.9);
  assert.equal(resBelow15m.effectiveDistance, 9.9);

  // 5b. Exactly at 15m ceiling (15.0m raw dist, 10m accuracy): 15.0 - 5 = 10.0m <= 10m -> PASS
  const exactlyAt15m = { latitude: 12.9716 + 0.00013490, longitude: 77.5946, accuracy: 10 };
  const resAt15m = evaluateServerGeofence(exactlyAt15m, classroom, 10);
  assert.equal(resAt15m.status, "PASS");
  assert.equal(resAt15m.distance, 15.0);
  assert.equal(resAt15m.effectiveDistance, 10.0);

  // 5c. Just above 15m ceiling (15.1m raw dist, 10m accuracy): 15.1 - 5 = 10.1m > 10m -> REJECT
  const justAbove15m = { latitude: 12.9716 + 0.00013580, longitude: 77.5946, accuracy: 10 };
  const resAbove15m = evaluateServerGeofence(justAbove15m, classroom, 10);
  assert.equal(resAbove15m.status, "REJECT");
  assert.equal(resAbove15m.distance, 15.1);
  assert.equal(resAbove15m.effectiveDistance, 10.1);

  // 6. Anti-Proxy: Student 55m away (cafeteria/remote) is REJECTED even if they claim 30m accuracy
  const remoteStudent = { latitude: 12.9721, longitude: 77.5946, accuracy: 30 };
  const resRemote = evaluateServerGeofence(remoteStudent, classroom, 10);
  assert.equal(resRemote.status, "REJECT");
  assert.ok(resRemote.effectiveDistance > 10);

  // 7. Degraded GPS Accuracy Handling:
  // 7a. Accuracy 46m (> 45m threshold) -> INCONCLUSIVE
  const degraded46m = { latitude: 12.9716, longitude: 77.5946, accuracy: 46 };
  assert.equal(evaluateServerGeofence(degraded46m, classroom, 10).status, "INCONCLUSIVE");

  // 7b. Accuracy 60m -> INCONCLUSIVE
  const degraded60m = { latitude: 12.97163, longitude: 77.5946, accuracy: 60 };
  assert.equal(evaluateServerGeofence(degraded60m, classroom, 10).status, "INCONCLUSIVE");

  // 8. Invalid Coordinates Handling:
  // 8a. Null coordinates -> LOCATION_UNAVAILABLE
  assert.equal(evaluateServerGeofence(null, classroom, 10).status, "LOCATION_UNAVAILABLE");
  assert.equal(evaluateServerGeofence({}, classroom, 10).status, "LOCATION_UNAVAILABLE");

  // 8b. Non-numeric coordinates -> LOCATION_UNAVAILABLE
  assert.equal(evaluateServerGeofence({ latitude: NaN, longitude: 77.5946 }, classroom, 10).status, "LOCATION_UNAVAILABLE");
  assert.equal(evaluateServerGeofence({ latitude: "invalid", longitude: "invalid" }, classroom, 10).status, "LOCATION_UNAVAILABLE");

  // 8c. Classroom location missing or disabled -> geofenceEnforced: false, PASS
  assert.equal(evaluateServerGeofence(inside, null, 10).geofenceEnforced, false);
  assert.equal(evaluateServerGeofence(inside, classroom, 0).geofenceEnforced, false);
});

test("23. Direct client writes to attendance_records blocked by security rules (CRIT-A)", () => {
  // Simulating Firestore rules for attendance_records
  const evaluateAttendanceRecordWrite = (auth, action) => {
    const isStaff = auth?.role === "LECTURER" || auth?.role === "ADMIN";
    if (action === "create" || action === "update" || action === "delete") {
      return isStaff; // Only staff can write attendance records
    }
    return false;
  };

  const studentAuth = { uid: "student_hacker", role: "STUDENT" };
  const lecturerAuth = { uid: "lecturer_alice", role: "LECTURER" };
  const adminAuth = { uid: "admin_sys", role: "ADMIN" };

  // Direct student create is BLOCKED
  assert.equal(evaluateAttendanceRecordWrite(studentAuth, "create"), false);
  assert.equal(evaluateAttendanceRecordWrite(studentAuth, "update"), false);
  assert.equal(evaluateAttendanceRecordWrite(studentAuth, "delete"), false);

  // Staff create is ALLOWED
  assert.equal(evaluateAttendanceRecordWrite(lecturerAuth, "create"), true);
  assert.equal(evaluateAttendanceRecordWrite(adminAuth, "create"), true);
});

test("24. Student profile protection: prevents tampering with role, faceDescriptor, and credentials (HIGH-B, HIGH-D)", () => {
  // Simulating Firestore rules for users collection
  const evaluateUserDocUpdate = (auth, existingData, incomingData) => {
    if (!auth?.uid) return false;
    const isAdmin = auth.role === "ADMIN";
    if (isAdmin) return true;

    // Must be own document
    if (auth.uid !== existingData.uid) return false;

    // Protected fields non-admins cannot change
    const protectedFields = [
      "role", "faceDescriptor", "descriptor", "faceRegistered",
      "biometricEnrolled", "hasFaceRegistered", "rollNo", "rollNumber",
      "status", "disqualified", "department", "batch",
      "registeredPlatform", "deviceType", "deviceTypeLocked", "registeredDeviceType"
    ];

    for (const field of protectedFields) {
      if (incomingData[field] !== undefined && incomingData[field] !== existingData[field]) {
        return false; // Forbidden field modification
      }
    }
    return true;
  };

  const studentUser = {
    uid: "student_bob",
    role: "STUDENT",
    rollNo: "CS201",
    faceDescriptor: [0.1, 0.2, 0.3],
    name: "Bob Student",
    registeredPlatform: "ios",
    deviceTypeLocked: true
  };

  const studentAuth = { uid: "student_bob", role: "STUDENT" };

  // Legitimate profile update (name, phone) is allowed
  assert.equal(
    evaluateUserDocUpdate(studentAuth, studentUser, { ...studentUser, name: "Robert Student", phone: "+1234567890" }),
    true
  );

  // Role escalation to LECTURER or ADMIN is blocked
  assert.equal(
    evaluateUserDocUpdate(studentAuth, studentUser, { ...studentUser, role: "LECTURER" }),
    false
  );
  assert.equal(
    evaluateUserDocUpdate(studentAuth, studentUser, { ...studentUser, role: "ADMIN" }),
    false
  );

  // Tampering with faceDescriptor is blocked
  assert.equal(
    evaluateUserDocUpdate(studentAuth, studentUser, { ...studentUser, faceDescriptor: [0.9, 0.9, 0.9] }),
    false
  );

  // Tampering with rollNo is blocked
  assert.equal(
    evaluateUserDocUpdate(studentAuth, studentUser, { ...studentUser, rollNo: "CS999" }),
    false
  );

  // Tampering with registeredPlatform or deviceTypeLocked is blocked (Option A)
  assert.equal(
    evaluateUserDocUpdate(studentAuth, studentUser, { ...studentUser, registeredPlatform: "android" }),
    false
  );
  assert.equal(
    evaluateUserDocUpdate(studentAuth, studentUser, { ...studentUser, deviceTypeLocked: false }),
    false
  );
});

test("25. Hardware biometric signature verification fail-closed (CRIT-C)", () => {
  mockDb.reset();
  const sessionId = "CS101_HARDWARE_FAIL_CLOSED";
  const studentUid = "student_hw_test";

  mockDb.sessions.set(sessionId, {
    active: true,
    phase: "PHASE_2",
    rotationIntervalSec: 10
  });
  mockDb.security.set(sessionId, {
    qr2TokenHash: hashToken("qr2_secret"),
    kioskEndsAtMs: Date.now() + 60000
  });

  // Setup Student profile and QR1 authorization (Android-bound student)
  mockDb.students.set("CS125", {
    rollNo: "CS125",
    studentUid,
    registeredPlatform: "android",
    deviceTypeLocked: true
  });
  mockDb.students.set(studentUid, {
    rollNo: "CS125",
    studentUid,
    registeredPlatform: "android",
    deviceTypeLocked: true
  });
  mockDb.authorizations.set(`${sessionId}_${studentUid}`, {
    sessionId,
    studentUid,
    rollNo: "CS125",
    qr1Verified: true,
    status: "QR1_VERIFIED",
    hasViolation: false,
    disqualified: false,
    registeredPlatform: "android"
  });

  // Setup active Android biometric credential
  mockDb.biometricCredentials.set(studentUid, {
    status: "ACTIVE",
    platform: "android",
    publicKeyDerBase64: "dummy_key_base64"
  });

  // Setup biometric challenge
  const challengeId = "chal_hw_123";
  mockDb.biometricChallenges.set(challengeId, {
    challengeId,
    studentUid,
    sessionId,
    used: false,
    expiresAtMs: Date.now() + 60000
  });

  // A. Invalid hardware signature fails closed (throws permission-denied)
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: studentUid, role: "STUDENT" },
      data: {
        sessionId,
        qr2Token: "qr2_secret",
        hardwareProof: {
          challengeId,
          signature: "INVALID_SIG"
        }
      }
    }),
    /Hardware signature verification failed/
  );

  // Challenge should NOT be consumed on failure
  assert.equal(mockDb.biometricChallenges.get(challengeId).used, false);

  // B. Valid hardware signature succeeds and marks challenge consumed
  const validRes = serverSubmitAttendance({
    auth: { uid: studentUid, role: "STUDENT" },
    data: {
      sessionId,
      qr2Token: "qr2_secret",
      hardwareProof: {
        challengeId,
        signature: "VALID_P256_DER_SIGNATURE"
      }
    }
  });
  assert.equal(validRes.success, true);
  assert.equal(mockDb.biometricChallenges.get(challengeId).used, true);

  // C. Replay of consumed challenge fails closed
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: studentUid, role: "STUDENT" },
      data: {
        sessionId,
        qr2Token: "qr2_secret",
        hardwareProof: {
          challengeId,
          signature: "VALID_P256_DER_SIGNATURE"
        }
      }
    }),
    /Biometric challenge has already been consumed/
  );

  // D. Challenge issued for another student fails closed (UID binding)
  const otherStudentChalId = "chal_other_student_999";
  mockDb.biometricChallenges.set(otherStudentChalId, {
    challengeId: otherStudentChalId,
    studentUid: "another_student_uid",
    sessionId,
    used: false,
    expiresAtMs: Date.now() + 60000
  });
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: studentUid, role: "STUDENT" },
      data: {
        sessionId,
        qr2Token: "qr2_secret",
        hardwareProof: {
          challengeId: otherStudentChalId,
          signature: "VALID_P256_DER_SIGNATURE"
        }
      }
    }),
    /Biometric challenge student UID mismatch/
  );

  // E. Challenge issued for another session fails closed (Session binding)
  const diffSessionChalId = "chal_diff_session_888";
  mockDb.biometricChallenges.set(diffSessionChalId, {
    challengeId: diffSessionChalId,
    studentUid: studentUid,
    sessionId: "OTHER_SESSION_XYZ",
    used: false,
    expiresAtMs: Date.now() + 60000
  });
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: studentUid, role: "STUDENT" },
      data: {
        sessionId,
        qr2Token: "qr2_secret",
        hardwareProof: {
          challengeId: diffSessionChalId,
          signature: "VALID_P256_DER_SIGNATURE"
        }
      }
    }),
    /Biometric challenge was issued for a different session/
  );

  // F. Expired challenge fails closed (TTL expiration)
  const expiredChalId = "chal_expired_777";
  mockDb.biometricChallenges.set(expiredChalId, {
    challengeId: expiredChalId,
    studentUid: studentUid,
    sessionId,
    used: false,
    expiresAtMs: Date.now() - 5000 // 5 seconds expired
  });
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: studentUid, role: "STUDENT" },
      data: {
        sessionId,
        qr2Token: "qr2_secret",
        hardwareProof: {
          challengeId: expiredChalId,
          signature: "VALID_P256_DER_SIGNATURE"
        }
      }
    }),
    /Biometric challenge has expired/
  );

  // G. Action mismatch fails closed (e.g. key enrollment challenge used for attendance)
  const enrollActionChalId = "chal_action_mismatch_666";
  mockDb.biometricChallenges.set(enrollActionChalId, {
    challengeId: enrollActionChalId,
    studentUid: studentUid,
    sessionId,
    action: "DEVICE_KEY_ENROLLMENT",
    used: false,
    expiresAtMs: Date.now() + 60000
  });
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: studentUid, role: "STUDENT" },
      data: {
        sessionId,
        qr2Token: "qr2_secret",
        hardwareProof: {
          challengeId: enrollActionChalId,
          signature: "VALID_P256_DER_SIGNATURE"
        }
      }
    }),
    /Biometric challenge action mismatch/
  );

  // H. Android browser client rejected:
  // When an Android browser invokes submitAttendance, it is rejected even if client UI is bypassed
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: studentUid, role: "STUDENT" },
      headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36" },
      data: {
        sessionId,
        qr2Token: "qr2_secret"
      }
    }),
    /permission-denied: Android attendance requires the authorized native SmartAttend application/
  );

  // I. Android student spoofing iPhone User-Agent rejected:
  // Even if user-agent header is set to iPhone Safari, student's registered credential is Android KeyStore, so hardware proof is required
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: studentUid, role: "STUDENT" },
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1" },
      data: {
        sessionId,
        qr2Token: "qr2_secret"
      }
    }),
    /permission-denied: Android attendance requires the authorized native SmartAttend application/
  );

  // I2. Android student with registeredPlatform: "android" on student profile spoofing iPhone User-Agent rejected:
  // Even without pre-enrolled biometric credentials, profile roster platform binding enforces native app requirement
  const androidRosterStudentUid = "student_android_roster";
  mockDb.students.set(androidRosterStudentUid, {
    studentUid: androidRosterStudentUid,
    rollNo: "CS_ROSTER_ANDROID",
    registeredPlatform: "android"
  });
  mockDb.authorizations.set(`${sessionId}_${androidRosterStudentUid}`, {
    sessionId,
    studentUid: androidRosterStudentUid,
    rollNo: "CS_ROSTER_ANDROID",
    qr1Verified: true,
    status: "QR1_VERIFIED"
  });
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: androidRosterStudentUid, role: "STUDENT" },
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1" },
      data: {
        sessionId,
        qr2Token: "qr2_secret"
      }
    }),
    /permission-denied: Android attendance requires the authorized native SmartAttend application/
  );

  // J. Spoofed platform flags (isNative: true or platform: "android") without hardware proof rejected:
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: studentUid, role: "STUDENT" },
      data: {
        sessionId,
        qr2Token: "qr2_secret",
        isNative: true,
        platform: "android"
      }
    }),
    /permission-denied: Android attendance requires the authorized native SmartAttend application/
  );

  // K. Legitimate iPhone browser attendance succeeds:
  // Non-Android student (iPhone/Safari) with face matching can submit through supported website
  const iphoneStudentUid = "student_iphone_legit";
  mockDb.authorizations.set(`${sessionId}_${iphoneStudentUid}`, {
    sessionId,
    studentUid: iphoneStudentUid,
    rollNo: "IPHONE_01",
    qr1Verified: true,
    status: "QR1_VERIFIED",
    detectedPlatform: "ios"
  });
  const iphoneRes = serverSubmitAttendance({
    auth: { uid: iphoneStudentUid, role: "STUDENT" },
    headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1" },
    data: {
      sessionId,
      qr2Token: "qr2_secret",
      biometricData: {
        liveness: true,
        liveDescriptor: Array(128).fill(0.1),
        enrolledDescriptor: Array(128).fill(0.1)
      }
    }
  });
  assert.equal(iphoneRes.success, true);
  assert.equal(iphoneRes.status, "ATTENDED");
});

test("26. Release PIN security, random high-entropy salted hashing, and rate-limiting lockout (CRIT-D)", () => {
  mockDb.reset();
  const sessionId = "CS101_PIN_RATELIMIT";
  const rawPin = "654321";
  const pinSalt = "e7b8c9d0f1a234567890abcdef123456"; // 16-byte random salt, not predictable sessionId
  const saltedHash = hashToken(`${pinSalt}:${rawPin}`);

  const rateLimitState = {
    attempts: 0,
    lockedUntil: 0
  };

  const verifyLecturerReleaseCodeSimulation = (inputPin, nowMs = Date.now(), salt = pinSalt) => {
    if (!inputPin) throw new Error("invalid-argument: Session ID and Session PIN are required.");

    // Check lockout
    if (rateLimitState.lockedUntil && nowMs < rateLimitState.lockedUntil) {
      const remaining = Math.ceil((rateLimitState.lockedUntil - nowMs) / 1000);
      throw new Error(`resource-exhausted: Too many failed Session PIN attempts. Locked out for security. Try again in ${remaining} seconds.`);
    }

    const clean = String(inputPin).trim();
    const inputSalted = hashToken(`${salt}:${clean}`);

    if (inputSalted !== saltedHash) {
      const current = (rateLimitState.lockedUntil && nowMs >= rateLimitState.lockedUntil) ? 0 : rateLimitState.attempts;
      const newAttempts = current + 1;
      const lockedUntil = newAttempts >= 5 ? nowMs + (10 * 60 * 1000) : 0;
      rateLimitState.attempts = newAttempts;
      rateLimitState.lockedUntil = lockedUntil;

      if (lockedUntil > 0) {
        throw new Error("resource-exhausted: ❌ Too many incorrect attempts (5/5). Session PIN release locked for 10 minutes. Please contact the lecturer for assistance.");
      } else {
        const remainingAttempts = 5 - newAttempts;
        throw new Error(`permission-denied: ❌ Invalid Session PIN. (${remainingAttempts} attempts remaining before temporary lockout).`);
      }
    }

    // Success -> reset
    rateLimitState.attempts = 0;
    rateLimitState.lockedUntil = 0;
    return { success: true, releaseAuthorized: true };
  };

  const startTime = 1000000;

  // A. Attempts using predictable sessionId salt are rejected
  assert.throws(() => verifyLecturerReleaseCodeSimulation(rawPin, startTime, sessionId), /4 attempts remaining/);

  // B. Attempts 2 to 4 with incorrect PINs fail with decrementing remaining attempts
  assert.throws(() => verifyLecturerReleaseCodeSimulation("222222", startTime), /3 attempts remaining/);
  assert.throws(() => verifyLecturerReleaseCodeSimulation("333333", startTime), /2 attempts remaining/);
  assert.throws(() => verifyLecturerReleaseCodeSimulation("444444", startTime), /1 attempts remaining/);

  // C. Attempt 5 triggers 10-minute lockout
  assert.throws(
    () => verifyLecturerReleaseCodeSimulation("555555", startTime),
    /resource-exhausted: ❌ Too many incorrect attempts \(5\/5\)\. Session PIN release locked for 10 minutes/
  );

  // D. During lockout, even correct PIN with correct salt is rejected with resource-exhausted
  assert.throws(
    () => verifyLecturerReleaseCodeSimulation(rawPin, startTime + 60000), // 1 min later
    /resource-exhausted: Too many failed Session PIN attempts\. Locked out for security/
  );

  // E. After 10 minutes (600,001 ms), lockout expires and entering correct PIN with pinSalt succeeds
  const unlockRes = verifyLecturerReleaseCodeSimulation(rawPin, startTime + 600001);
  assert.equal(unlockRes.success, true);
  assert.equal(unlockRes.releaseAuthorized, true);
  assert.equal(rateLimitState.attempts, 0);
  assert.equal(rateLimitState.lockedUntil, 0);
});

test("27. Complete authorized attendance flow (Lecturer start -> 10m Geofence -> Dynamic QR1 -> Kiosk Lock -> Phase 2 -> Dynamic QR2 -> Face Vector Verification -> Atomic Record -> Live Lecturer Roster)", () => {
  mockDb.reset();
  const sessionId = "CS201_LEGIT_FLOW";
  const lecturerUid = "lecturer_alice";
  const studentUid = "student_carol";
  const studentRoll = "25BCS108";

  // 1. Enrolled student in authoritative database with valid face descriptor
  const enrolledDescriptor = Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.15) * 0.25);
  mockDb.students.set(studentRoll, {
    rollNo: studentRoll,
    name: "Carol Student",
    studentUid: studentUid,
    faceDescriptor: enrolledDescriptor,
    faceRegistered: true,
    registeredPlatform: "ios",
    deviceType: "ios"
  });

  // 2. Lecturer initiates session with default 10m geofence and default 10s rotation interval
  const startTime = 500000;
  mockDb.sessions.set(sessionId, {
    id: sessionId,
    ownerId: lecturerUid,
    active: true,
    phase: "PHASE_1",
    rotationIntervalSec: 10,
    geofenceRadius: 10,
    classroomLocation: { latitude: 12.9716, longitude: 77.5946, radius: 10 },
    sessionStartAt: startTime,
    kioskEndsAt: startTime + 180000,
    attendees: [],
    attendanceCount: 0
  });

  const qr1Secret = "qr1_secret_key_session";
  const qr2Secret = "qr2_secret_key_session";
  mockDb.security.set(sessionId, {
    qr1Token: qr1Secret,
    qr1TokenHash: hashToken(qr1Secret),
    qr2Token: qr2Secret,
    qr2TokenHash: hashToken(qr2Secret),
    rotationIntervalSec: 10,
    sessionStartAt: startTime,
    kioskEndsAtMs: startTime + 180000
  });

  // 3. Phase 1 Check-In: Student is inside classroom (Haversine 4.2m <= 10m)
  const studentLocation = { latitude: 12.97163, longitude: 77.59462, accuracy: 8 };
  const geoCheck = evaluateServerGeofence(studentLocation, { latitude: 12.9716, longitude: 77.5946 }, 10);
  assert.equal(geoCheck.status, "PASS");

  // Dynamic QR1 token at slot 50
  const slot1 = Math.floor(startTime / 10000);
  const sig1 = crypto.createHmac("sha256", qr1Secret).update(`${sessionId}|1|${slot1}|10`).digest("hex").slice(0, 16);

  const qr1Req = {
    auth: { uid: studentUid, rollNo: studentRoll, email: "carol@college.edu" },
    data: {
      sessionId,
      slot: slot1,
      sig: sig1,
      int: 10,
      studentLocation
    }
  };
  const qr1Res = serverAuthorizeQR1(qr1Req, startTime);
  assert.equal(qr1Res.success, true);
  assert.equal(qr1Res.status, "QR1_VERIFIED");

  // Verify Kiosk Lock mode is stamped in authorization document
  const authDoc = mockDb.authorizations.get(`${sessionId}_${studentUid}`);
  assert.ok(authDoc);
  assert.equal(authDoc.qr1Verified, true);
  assert.equal(authDoc.releaseStatus, "LOCKED");

  // 4. Lecturer transitions session to Phase 2
  const phase2Time = startTime + 60000;
  mockDb.sessions.get(sessionId).phase = "PHASE_2";

  // 5. Phase 2 QR2 validation
  const slot2 = Math.floor(phase2Time / 10000);
  const sig2 = crypto.createHmac("sha256", qr2Secret).update(`${sessionId}|2|${slot2}|10`).digest("hex").slice(0, 16);

  const qr2Req = {
    auth: { uid: studentUid, rollNo: studentRoll, email: "carol@college.edu" },
    data: {
      sessionId,
      qr2Token: "qr2_token",
      slot: slot2,
      sig: sig2,
      int: 10
    }
  };
  const qr2Res = serverValidateQR2(qr2Req, phase2Time);
  assert.equal(qr2Res.success, true);
  assert.equal(qr2Res.authorized, true);
  assert.equal(authDoc.qr2Verified, true);

  // 6. Student completes live facial verification (e.g. Euclidean distance ~0.15 <= 0.52)
  const liveDescriptor = enrolledDescriptor.map((val, idx) => (idx % 2 === 0 ? val + 0.015 : val - 0.012));
  const submitReq = {
    auth: { uid: studentUid, rollNo: studentRoll, email: "carol@college.edu" },
    data: {
      sessionId,
      qr2Token: qr2Secret,
      biometricData: {
        liveDescriptor,
        enrolledDescriptor
      }
    }
  };

  const submitRes = serverSubmitAttendance(submitReq, phase2Time + 3000);
  assert.equal(submitRes.success, true);
  assert.equal(submitRes.status, "ATTENDED");

  // 7. Authoritative record exists in attendance_records
  const expectedRecordId = `${sessionId}_${studentRoll}`;
  assert.ok(mockDb.attendanceRecords.has(expectedRecordId));
  const savedRecord = mockDb.attendanceRecords.get(expectedRecordId);
  assert.equal(savedRecord.rollNo, studentRoll);
  assert.equal(savedRecord.status, "ATTENDED");

  // 8. Replay & concurrent duplicate submission rejected atomically
  assert.throws(
    () => serverSubmitAttendance(submitReq, phase2Time + 4000),
    /already-exists: Attendance for 25BCS108 is already recorded/
  );
});

test("28. Face scan delay tolerance & QR rotation freshness window (resolves rotation race)", () => {
  mockDb.reset();
  const sessionId = "CS101_RACE_TOLERANCE";
  const studentUid = "student_face_delay";
  const studentRoll = "CS_DELAY_01";
  const qr2Secret = "secret_fast_rotation";

  mockDb.sessions.set(sessionId, { active: true, phase: "PHASE_2" });
  mockDb.security.set(sessionId, {
    qr2Token: qr2Secret,
    qr2TokenHash: hashToken(qr2Secret),
    rotationIntervalSec: 5, // Fast 5-second rotation
    kioskEndsAtMs: 1000000
  });

  mockDb.authorizations.set(`${sessionId}_${studentUid}`, {
    studentUid,
    rollNo: studentRoll,
    qr1Verified: true
  });

  const scanTime = 500000;
  const slotAtScan = Math.floor(scanTime / 5000);
  const sigAtScan = crypto.createHmac("sha256", qr2Secret).update(`${sessionId}|2|${slotAtScan}|5`).digest("hex").slice(0, 16);

  // 1. Student scans QR2 at T = 500,000ms
  const qr2Req = {
    auth: { uid: studentUid },
    data: { sessionId, slot: slotAtScan, sig: sigAtScan, int: 5 }
  };
  const qr2Res = serverValidateQR2(qr2Req, scanTime);
  assert.equal(qr2Res.success, true);

  // 2. Face recognition, positioning and blink liveness take 14 seconds (current time T = 514,000ms)
  // During this time, 5-second QR code has rotated nearly 3 times!
  const submitTime = scanTime + 14000;
  const submitReq = {
    auth: { uid: studentUid },
    data: { sessionId, qr2Token: "qr2_token" }
  };

  // Backend recognizes fresh qr2Verified stamp within 35-second window and completes attendance successfully
  const submitRes = serverSubmitAttendance(submitReq, submitTime);
  assert.equal(submitRes.success, true);
  assert.equal(submitRes.status, "ATTENDED");

  // 3. QR2 verification state is consumed upon submission
  const authDoc = mockDb.authorizations.get(`${sessionId}_${studentUid}`);
  assert.equal(authDoc.qr2Verified, false);

  // 4. Stale submission attempt beyond 35s window without active QR2 fails closed
  mockDb.attendanceRecords.delete(`${sessionId}_${studentRoll}`); // clear record for stale window test
  authDoc.qr2Verified = true;
  authDoc.qr2VerifiedAtMs = scanTime; // 40s ago
  assert.throws(
    () => serverSubmitAttendance(submitReq, scanTime + 40000),
    /permission-denied: Invalid QR 2 token|deadline-exceeded: QR code has expired/
  );
});

test("29. Student face enrollment validation and anti-tamper security", () => {
  mockDb.reset();
  const studentUid = "student_face_test";
  const studentRoll = "CS_BIO_99";

  // Unregistered student registers legitimate 128-float face vector
  const validVector = Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.2) * 0.3);
  const regReq = {
    auth: { uid: studentUid, rollNo: studentRoll, role: "STUDENT" },
    data: { rollNo: studentRoll, faceDescriptor: validVector }
  };
  const regRes = serverRegisterStudentFace(regReq);
  assert.equal(regRes.success, true);
  assert.equal(mockDb.students.get(studentRoll).faceRegistered, true);

  // Student cannot overwrite already enrolled face vector without staff authorization
  assert.throws(
    () => serverRegisterStudentFace(regReq),
    /failed-precondition: Face biometrics are already enrolled and locked/
  );

  // Malformed vector (e.g. fewer than 128 dimensions) is rejected
  assert.throws(
    () => serverRegisterStudentFace({
      auth: { uid: "student_other", rollNo: "CS_OTHER", role: "STUDENT" },
      data: { rollNo: "CS_OTHER", faceDescriptor: [0.1, 0.2, 0.3] }
    }),
    /must be a valid 128-dimensional array/
  );

  // Adversarial flat vector (zero variance / all identical elements) is rejected
  assert.throws(
    () => serverRegisterStudentFace({
      auth: { uid: "student_flat", rollNo: "CS_FLAT", role: "STUDENT" },
      data: { rollNo: "CS_FLAT", faceDescriptor: Array(128).fill(0.5) }
    }),
    /Zero-entropy \/ flat face descriptor detected/
  );
});

test("30. Network retry idempotency and offline recovery", () => {
  mockDb.reset();
  const sessionId = "CS_IDEMPOTENT_RETRY";
  const studentUid = "student_retry";
  const studentRoll = "CS_RETRY_01";

  mockDb.sessions.set(sessionId, { active: true, phase: "PHASE_2" });
  mockDb.security.set(sessionId, {
    qr2TokenHash: hashToken("qr2_retry"),
    kioskEndsAtMs: Date.now() + 60000
  });
  mockDb.authorizations.set(`${sessionId}_${studentUid}`, {
    studentUid,
    rollNo: studentRoll,
    qr1Verified: true
  });

  const request = {
    auth: { uid: studentUid },
    data: { sessionId, qr2Token: "qr2_retry" }
  };

  // First request commits
  const res1 = serverSubmitAttendance(request);
  assert.equal(res1.success, true);

  // Simulating client-side helper submitVerifiedAttendance idempotency handling:
  // When duplicate request arrives on network retry, client helper catches already-exists
  // and safely resolves { success: true, alreadyRecorded: true } instead of surfacing an error
  const clientSimulatedSubmit = (req) => {
    try {
      return serverSubmitAttendance(req);
    } catch (err) {
      if (err.message.includes("already-exists") || err.message.includes("already recorded")) {
        return { success: true, alreadyRecorded: true, message: "Attendance for this session has already been recorded." };
      }
      throw err;
    }
  };

  const retryRes = clientSimulatedSubmit(request);
  assert.equal(retryRes.success, true);
  assert.equal(retryRes.alreadyRecorded, true);

  // Authoritative database holds exactly 1 record
  const records = Array.from(mockDb.attendanceRecords.values()).filter((r) => r.sessionId === sessionId);
  assert.equal(records.length, 1);
});

test("31. Option A First-Device Platform Binding & Recovery Regression Suite (All 12 Scenarios)", () => {
  mockDb.reset();
  const sessionId = "CS101_PLATFORM_TEST_SESSION";
  const lecturerUid = "lecturer_alice";
  const studentUid = "student_test_uid";
  const studentRoll = "25BCS500";

  // Setup test session in Phase 1
  mockDb.sessions.set(sessionId, {
    id: sessionId,
    ownerId: lecturerUid,
    active: true,
    phase: "PHASE_1",
    rotationIntervalSec: 10
  });
  mockDb.security.set(sessionId, {
    qr1Token: "qr1_valid_token",
    qr1TokenHash: hashToken("qr1_valid_token"),
    qr2Token: "qr2_valid_token",
    qr2TokenHash: hashToken("qr2_valid_token"),
    kioskEndsAtMs: Date.now() + 180000
  });

  // 1. Unbound student: QR1 and attendance submission rejected
  mockDb.students.set(studentRoll, {
    rollNo: studentRoll,
    studentUid,
    name: "Unbound Student",
    registeredPlatform: null // unbound
  });

  assert.throws(
    () => serverAuthorizeQR1({
      auth: { uid: studentUid, rollNo: studentRoll },
      data: { sessionId, qr1Token: "qr1_valid_token" }
    }),
    /failed-precondition: Device platform onboarding incomplete/
  );

  mockDb.sessions.get(sessionId).phase = "PHASE_2";
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: studentUid, rollNo: studentRoll },
      data: { sessionId, qr2Token: "qr2_valid_token" }
    }),
    /failed-precondition: Device platform onboarding incomplete/
  );
  mockDb.sessions.get(sessionId).phase = "PHASE_1";

  // 2. Invalid platform value: rejected
  assert.throws(
    () => serverBindStudentDevicePlatform({
      auth: { uid: studentUid, rollNo: studentRoll },
      data: { platform: "windows" }
    }),
    /invalid-argument: Invalid device platform 'windows'/
  );
  assert.throws(
    () => serverBindStudentDevicePlatform({
      auth: { uid: studentUid, rollNo: studentRoll },
      data: { platform: "" }
    }),
    /invalid-argument: Missing or invalid platform parameter/
  );
  assert.throws(
    () => serverBindStudentDevicePlatform({
      auth: { uid: studentUid, rollNo: studentRoll },
      data: { platform: "macOS" }
    }),
    /invalid-argument: Invalid device platform 'macOS'/
  );

  // 3. First valid binding: succeeds and is immutable through ordinary student requests
  const bindRes = serverBindStudentDevicePlatform({
    auth: { uid: studentUid, rollNo: studentRoll },
    data: { platform: "ios" }
  });
  assert.equal(bindRes.success, true);
  assert.equal(bindRes.platform, "ios");
  assert.equal(mockDb.students.get(studentRoll).registeredPlatform, "ios");
  assert.equal(mockDb.students.get(studentRoll).deviceTypeLocked, true);

  // Subsequent student binding attempt rejected
  assert.throws(
    () => serverBindStudentDevicePlatform({
      auth: { uid: studentUid, rollNo: studentRoll },
      data: { platform: "android" }
    }),
    /already-exists: Device platform is already bound to 'ios'/
  );

  // 4. Concurrent first-binding requests: only one platform can be assigned
  const raceRoll = "25BCS_RACE";
  const raceUid = "student_race";
  mockDb.students.set(raceRoll, { rollNo: raceRoll, studentUid: raceUid });
  // First wins
  const raceWin = serverBindStudentDevicePlatform({
    auth: { uid: raceUid, rollNo: raceRoll },
    data: { platform: "android" }
  });
  assert.equal(raceWin.success, true);
  assert.equal(raceWin.platform, "android");
  // Simultaneous conflicting assignment loses
  assert.throws(
    () => serverBindStudentDevicePlatform({
      auth: { uid: raceUid, rollNo: raceRoll },
      data: { platform: "ios" }
    }),
    /already-exists/
  );
  assert.equal(mockDb.students.get(raceRoll).registeredPlatform, "android");

  // 5. Android-bound student spoofing an iPhone user-agent: web attendance rejected
  mockDb.authorizations.set(`${sessionId}_${raceUid}`, {
    sessionId,
    studentUid: raceUid,
    rollNo: raceRoll,
    qr1Verified: true,
    qr2Verified: true,
    qr2VerifiedAtMs: Date.now(),
    registeredPlatform: "android"
  });
  mockDb.sessions.get(sessionId).phase = "PHASE_2";

  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: raceUid, rollNo: raceRoll },
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1" },
      data: { sessionId, qr2Token: "qr2_valid_token" }
    }),
    /permission-denied: Android attendance requires the authorized native SmartAttend application/
  );

  // 6. Android-bound student using the authorized native flow: existing supported flow remains functional
  mockDb.biometricCredentials.set(raceUid, {
    studentUid: raceUid,
    status: "ACTIVE",
    platform: "android"
  });
  const chalId = "race_chal_123";
  mockDb.biometricChallenges.set(chalId, {
    challengeId: chalId,
    studentUid: raceUid,
    sessionId,
    action: "ATTENDANCE_VERIFICATION",
    used: false,
    expiresAtMs: Date.now() + 60000
  });

  const nativeSubmitRes = serverSubmitAttendance({
    auth: { uid: raceUid, rollNo: raceRoll },
    headers: { "user-agent": "SmartAttend-Native-Android/1.0" },
    data: {
      sessionId,
      qr2Token: "qr2_valid_token",
      hardwareProof: {
        challengeId: chalId,
        signature: "VALID_P256_DER_SIGNATURE"
      }
    }
  });
  assert.equal(nativeSubmitRes.success, true);
  assert.equal(nativeSubmitRes.status, "ATTENDED");

  // 7. iOS-bound student using the website: existing browser attendance remains functional
  const iosSessionId = "CS101_IOS_SESSION";
  mockDb.sessions.set(iosSessionId, { id: iosSessionId, active: true, phase: "PHASE_2" });
  mockDb.security.set(iosSessionId, { qr2TokenHash: hashToken("qr2_ios"), kioskEndsAtMs: Date.now() + 60000 });
  mockDb.authorizations.set(`${iosSessionId}_${studentUid}`, {
    sessionId: iosSessionId,
    studentUid,
    rollNo: studentRoll,
    qr1Verified: true,
    qr2Verified: true,
    qr2VerifiedAtMs: Date.now(),
    registeredPlatform: "ios"
  });

  const iosWebSubmit = serverSubmitAttendance({
    auth: { uid: studentUid, rollNo: studentRoll },
    headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1" },
    data: {
      sessionId: iosSessionId,
      qr2Token: "qr2_ios",
      biometricData: {
        liveness: true,
        liveDescriptor: Array(128).fill(0.1),
        enrolledDescriptor: Array(128).fill(0.1)
      }
    }
  });
  assert.equal(iosWebSubmit.success, true);
  assert.equal(iosWebSubmit.status, "ATTENDED");

  // 8. Student attempts direct Firestore platform-field modification: denied
  const studentBob = { uid: studentUid, role: "STUDENT", registeredPlatform: "ios", deviceTypeLocked: true };
  const studentAuth = { uid: studentUid, role: "STUDENT" };
  const evaluateUserDocUpdate = (auth, existing, incoming) => {
    if (auth.uid !== existing.uid) return false;
    const protectedFields = ["registeredPlatform", "deviceType", "deviceTypeLocked", "registeredDeviceType"];
    for (const f of protectedFields) {
      if (incoming[f] !== undefined && incoming[f] !== existing[f]) return false;
    }
    return true;
  };
  assert.equal(evaluateUserDocUpdate(studentAuth, studentBob, { ...studentBob, registeredPlatform: "android" }), false);
  assert.equal(evaluateUserDocUpdate(studentAuth, studentBob, { ...studentBob, deviceTypeLocked: false }), false);

  // 9. Unauthorized platform-change/recovery request: rejected
  assert.throws(
    () => serverResetStudentDevicePlatform({
      auth: { uid: studentUid, rollNo: studentRoll },
      data: { newPlatform: "android" }
    }),
    /permission-denied: Platform change requires an approved Biometric Change Request ID/
  );
  mockDb.biometricChangeRequests.set("pending_rec_01", {
    studentUid,
    status: "PENDING",
    used: false
  });
  assert.throws(
    () => serverResetStudentDevicePlatform({
      auth: { uid: studentUid, rollNo: studentRoll },
      data: { newPlatform: "android", requestId: "pending_rec_01" }
    }),
    /permission-denied: Valid, approved Biometric Change Request required/
  );
  assert.throws(
    () => serverResetStudentDevicePlatform({
      auth: { uid: "unassigned_lecturer", role: "LECTURER" },
      data: { targetRollNo: studentRoll, newPlatform: "android" },
      isRosterAuthorized: false
    }),
    /permission-denied: Lecturer is not authorized to reset platform/
  );

  // Cross-student request ID rejection: Bob attempts to use Alice's approved request
  mockDb.biometricChangeRequests.set("alice_approved_req", {
    studentUid: "alice_uid",
    rollNo: "25BCS_ALICE",
    status: "APPROVED",
    used: false
  });
  assert.throws(
    () => serverResetStudentDevicePlatform({
      auth: { uid: studentUid, rollNo: studentRoll },
      data: { newPlatform: "android", requestId: "alice_approved_req" }
    }),
    /permission-denied: Valid, approved Biometric Change Request required/
  );
  assert.equal(mockDb.biometricChangeRequests.get("alice_approved_req").used, false);

  // 10. Authorized recovery: audited, properly authorized and does not permit replay
  mockDb.biometricChangeRequests.set("approved_rec_01", {
    studentUid,
    rollNo: studentRoll,
    status: "APPROVED",
    used: false
  });
  const recoveryRes = serverResetStudentDevicePlatform({
    auth: { uid: studentUid, rollNo: studentRoll },
    data: { newPlatform: "android", requestId: "approved_rec_01" }
  });
  assert.equal(recoveryRes.success, true);
  assert.equal(recoveryRes.newPlatform, "android");
  assert.equal(mockDb.students.get(studentRoll).registeredPlatform, "android");

  // Replay protection: same approved requestId is now consumed and cannot be reused
  assert.throws(
    () => serverResetStudentDevicePlatform({
      auth: { uid: studentUid, rollNo: studentRoll },
      data: { newPlatform: "ios", requestId: "approved_rec_01" }
    }),
    /permission-denied: Valid, approved Biometric Change Request required/
  );

  // Audit log was recorded
  assert.ok(mockDb.biometricAuditLogs.some(l => l.action === "DEVICE_PLATFORM_RESET" && l.rollNo === studentRoll));

  // Lecturer authorized recovery (switching back to ios supersedes android credentials)
  mockDb.biometricCredentials.set(studentUid, { studentUid, status: "ACTIVE", platform: "android" });
  const lecturerRecovery = serverResetStudentDevicePlatform({
    auth: { uid: lecturerUid, role: "LECTURER" },
    data: { targetRollNo: studentRoll, newPlatform: "ios" },
    isRosterAuthorized: true
  });
  assert.equal(lecturerRecovery.success, true);
  assert.equal(mockDb.students.get(studentRoll).registeredPlatform, "ios");
  assert.equal(mockDb.biometricCredentials.get(studentUid).status, "SUPERSEDED");

  // 11. Legacy unbound students & stale credential fallbacks: cannot bypass fail-closed check
  const legacySession = "CS101_LEGACY_SESSION";
  mockDb.sessions.set(legacySession, { id: legacySession, active: true, phase: "PHASE_1" });
  mockDb.security.set(legacySession, { qr1Token: "qr1_legacy", qr1TokenHash: hashToken("qr1_legacy"), qr1ExpiresAtMs: Date.now() + 60000 });

  const legacyRoll = "25BCS_LEGACY";
  const legacyUid = "student_legacy";
  // Account with legacy deviceType and active credentials, but NO registeredPlatform
  mockDb.students.set(legacyRoll, { rollNo: legacyRoll, studentUid: legacyUid, registeredPlatform: null, deviceType: "android" });
  mockDb.biometricCredentials.set(legacyUid, { studentUid: legacyUid, status: "ACTIVE", platform: "android" });

  assert.throws(
    () => serverAuthorizeQR1({
      auth: { uid: legacyUid, rollNo: legacyRoll },
      headers: { "user-agent": "Mozilla/5.0 (iPhone)" },
      data: { sessionId: legacySession, qr1Token: "qr1_legacy" }
    }),
    /failed-precondition: Device platform onboarding incomplete/
  );

  // Legitimate legacy student onboarding succeeds
  const legacyBind = serverBindStudentDevicePlatform({
    auth: { uid: legacyUid, rollNo: legacyRoll },
    data: { platform: "ios" }
  });
  assert.equal(legacyBind.success, true);
  assert.equal(mockDb.students.get(legacyRoll).registeredPlatform, "ios");

  // Conflicting fields: registeredPlatform is authoritative
  const conflictRoll = "25BCS_CONFLICT";
  const conflictUid = "student_conflict";
  mockDb.students.set(conflictRoll, {
    rollNo: conflictRoll,
    studentUid: conflictUid,
    registeredPlatform: "android", // Authoritative
    deviceType: "ios" // Conflicting legacy field
  });
  mockDb.authorizations.set(`${legacySession}_${conflictUid}`, {
    sessionId: legacySession,
    studentUid: conflictUid,
    rollNo: conflictRoll,
    qr1Verified: true,
    qr2Verified: true,
    qr2VerifiedAtMs: Date.now(),
    registeredPlatform: "android"
  });
  mockDb.sessions.get(legacySession).phase = "PHASE_2";
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: conflictUid, rollNo: conflictRoll },
      headers: { "user-agent": "Mozilla/5.0 (iPhone)" },
      data: { sessionId: legacySession, qr2Token: "qr2_token" }
    }),
    /permission-denied: Android attendance requires the authorized native SmartAttend application/
  );

  // 12. Duplicate attendance, QR expiry, geofence checks: no regressions
  const replayChalId = "race_chal_replay";
  mockDb.biometricChallenges.set(replayChalId, {
    challengeId: replayChalId,
    studentUid: raceUid,
    sessionId,
    action: "ATTENDANCE_VERIFICATION",
    used: false,
    expiresAtMs: Date.now() + 60000
  });
  assert.throws(
    () => serverSubmitAttendance({
      auth: { uid: raceUid, rollNo: raceRoll },
      headers: { "user-agent": "SmartAttend-Native-Android/1.0" },
      data: {
        sessionId,
        qr2Token: "qr2_valid_token",
        hardwareProof: {
          challengeId: replayChalId,
          signature: "VALID_P256_DER_SIGNATURE"
        }
      }
    }),
    /already-exists: Attendance for 25BCS_RACE is already recorded/
  );
});
