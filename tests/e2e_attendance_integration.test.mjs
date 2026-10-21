import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Configure Firestore emulator environment before importing backend functions
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8088";
process.env.GCLOUD_PROJECT = "smartattend-test";
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "smartattend-test" });

const admin = require("../functions/node_modules/firebase-admin");
const fns = require("../functions/index.js");

const db = admin.firestore();

// Test Fixtures
const LECTURER_UID = "lecturer_alice_prod";
const LECTURER_EMAIL = "alice.prof@institution.edu";
const STUDENT_UID = "student_carol_prod";
const STUDENT_EMAIL = "carol.student@institution.edu";
const STUDENT_ROLL = "25BCS108";
const COURSE_CODE = "CS101";

// Helpers
function hashToken(str) {
  return crypto.createHash("sha256").update(String(str).trim()).digest("hex");
}

function generateDynamicQrToken(sessionId, phase, slot, interval, secret) {
  const data = `${sessionId}|${phase}|${slot}|${interval}`;
  return crypto.createHmac("sha256", secret).update(data).digest("hex").slice(0, 16);
}

// Low-level HTTP client simulation for unprivileged client Firestore REST write
function testClientRestWrite(path, documentBody) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(documentBody);
    const options = {
      hostname: "127.0.0.1",
      port: 8088,
      path: `/v1/projects/smartattend-test/databases/(default)/documents/${path}`,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });

    req.on("error", (e) => resolve({ error: e.message }));
    req.write(postData);
    req.end();
  });
}

test("E2E Integration: Complete 10-Step Attendance Flow Against Live Emulator", async (t) => {
  console.log("--> Setting up isolated institutional test entities in Firestore Emulator...");

  // 1. Seed Student Profile
  const enrolledDescriptor = Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.18) * 0.28);
  await db.collection("students").doc(STUDENT_ROLL).set({
    rollNo: STUDENT_ROLL,
    name: "Carol Student",
    fullName: "Carol Student",
    email: STUDENT_EMAIL,
    studentUid: STUDENT_UID,
    faceDescriptor: enrolledDescriptor,
    faceRegistered: true,
    department: "CSE",
    batch: "2025"
  });

  // Seed User Profiles
  await db.collection("users").doc(STUDENT_UID).set({
    uid: STUDENT_UID,
    email: STUDENT_EMAIL,
    role: "STUDENT",
    rollNo: STUDENT_ROLL,
    name: "Carol Student"
  });

  await db.collection("users").doc(LECTURER_UID).set({
    uid: LECTURER_UID,
    email: LECTURER_EMAIL,
    role: "lecturer",
    name: "Prof. Alice"
  });

  await db.collection("lecturers").doc(LECTURER_UID).set({
    uid: LECTURER_UID,
    email: LECTURER_EMAIL,
    role: "lecturer",
    name: "Prof. Alice",
    department: "CSE"
  });

  // Seed Course Assignment
  await db.collection("courses").doc(COURSE_CODE).set({
    code: COURSE_CODE,
    name: "Computer Science 101",
    department: "CSE",
    assignedLecturers: [LECTURER_UID, LECTURER_EMAIL],
    enrolledStudents: [STUDENT_ROLL]
  });

  // --------------------------------------------------------------------------
  // STEP 1: Lecturer starts attendance session via initiateAttendanceSession
  // --------------------------------------------------------------------------
  console.log("--> Step 1: Lecturer initiates attendance session...");
  const initReq = {
    auth: {
      uid: LECTURER_UID,
      token: { email: LECTURER_EMAIL, role: "LECTURER", name: "Prof. Alice" }
    },
    data: {
      classCode: "CSE-A",
      courseCode: COURSE_CODE,
      roomNo: "Hall-101",
      batch: "2025",
      geofenceRadius: 10,
      rotationIntervalSec: 10,
      durationMinutes: 3,
      qr1DurationSeconds: 60,
      qr2DurationSeconds: 120
    }
  };

  const sessionInitResult = await fns.initiateAttendanceSession.run(initReq);
  assert.ok(sessionInitResult.success, "Session creation should succeed");
  const sessionId = sessionInitResult.sessionId;
  const qr1Secret = sessionInitResult.qr1Token;
  const qr2Secret = sessionInitResult.qr2Token;
  assert.ok(sessionId, "Session ID must be returned");
  assert.ok(qr1Secret, "QR1 secret must be generated");
  assert.ok(qr2Secret, "QR2 secret must be generated");

  // Verify Database State for Session
  const sessionSnap = await db.collection("attendance_sessions").doc(sessionId).get();
  assert.ok(sessionSnap.exists, "Session document must exist in database");
  const sessionData = sessionSnap.data();
  assert.equal(sessionData.active, true);
  assert.equal(sessionData.phase, "PHASE_1");
  assert.equal(sessionData.geofenceRadius, 10);
  assert.equal(sessionData.rotationIntervalSec, 10);
  assert.equal(sessionData.ownerId, LECTURER_UID);

  // Set classroom GPS coordinates on the session for geofence enforcement
  const classroomLoc = { latitude: 12.971600, longitude: 77.594600, radius: 10 };
  await db.collection("attendance_sessions").doc(sessionId).update({
    classroomLocation: classroomLoc
  });

  // Verify Security Doc is Protected and Contains No Plaintext PINs
  const secSnap = await db.collection("attendance_sessions").doc(sessionId).collection("security").doc("tokens").get();
  assert.ok(secSnap.exists, "Private security tokens document must exist");
  const secData = secSnap.data();
  assert.ok(secData.pinSalt, "High-entropy random salt must exist");
  assert.ok(secData.saltedReleaseCodeHash, "Salted PIN hash must exist");
  assert.equal(secData.sessionPin, undefined, "Plaintext sessionPin must NOT be stored in security doc");
  assert.equal(secData.lecturerPin, undefined, "Plaintext lecturerPin must NOT be stored in security doc");

  // --------------------------------------------------------------------------
  // STEP 1B: Option A Authoritative First-Device Platform Binding & Recovery Tests
  // --------------------------------------------------------------------------
  console.log("--> Step 1B: Testing Option A Platform Binding & Authorized Recovery...");
  const slotPre = Math.floor(Date.now() / 10000);
  const sigPre = generateDynamicQrToken(sessionId, 1, slotPre, 10, qr1Secret);

  // 1. Unbound Student Rejection (QR1 check-in & attendance submission fail-closed)
  // Carol is initially seeded without registeredPlatform
  await assert.rejects(
    async () => {
      await fns.authorizeQR1.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: {
          sessionId,
          slot: slotPre,
          sig: sigPre,
          int: 10,
          studentLocation: { latitude: 12.971630, longitude: 77.594615, accuracy: 6, timestamp: Date.now() }
        }
      });
    },
    (err) => {
      assert.equal(err.code, "failed-precondition");
      assert.ok(err.message.includes("Device platform onboarding incomplete"), `Expected onboarding incomplete error, got: ${err.message}`);
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await fns.submitAttendance.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: {
          sessionId,
          qr2Token: qr2Secret,
          biometricData: { liveness: true, liveDescriptor: enrolledDescriptor }
        }
      });
    },
    (err) => {
      assert.equal(err.code, "failed-precondition");
      assert.ok(err.message.includes("Device platform onboarding incomplete"), `Expected onboarding incomplete error, got: ${err.message}`);
      return true;
    }
  );

  // 2. Invalid Platform Values Rejected
  await assert.rejects(
    async () => {
      await fns.bindStudentDevicePlatform.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: { platform: "windows" }
      });
    },
    (err) => {
      assert.equal(err.code, "invalid-argument");
      assert.ok(err.message.includes("Only 'android' and 'ios' are supported"));
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await fns.bindStudentDevicePlatform.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: { platform: "" }
      });
    },
    (err) => {
      assert.equal(err.code, "invalid-argument");
      return true;
    }
  );

  // 3. First Valid Binding: Succeeds and is Immutable Through Ordinary Student Requests
  const bindRes = await fns.bindStudentDevicePlatform.run({
    auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
    data: { platform: "ios" }
  });
  assert.ok(bindRes.success);
  assert.equal(bindRes.platform, "ios");
  assert.equal(bindRes.rollNo, STUDENT_ROLL);

  // Verify Database State
  const boundStudentSnap = await db.collection("students").doc(STUDENT_ROLL).get();
  assert.equal(boundStudentSnap.data().registeredPlatform, "ios");
  assert.equal(boundStudentSnap.data().deviceTypeLocked, true);

  // Ordinary student re-binding attempt is rejected
  await assert.rejects(
    async () => {
      await fns.bindStudentDevicePlatform.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: { platform: "android" }
      });
    },
    (err) => {
      assert.equal(err.code, "already-exists");
      assert.ok(err.message.includes("already bound to 'ios'"));
      return true;
    }
  );

  // 4. Concurrent First-Binding Requests (Only one platform assigned atomically)
  const RACE_UID = "student_race_e2e_uid";
  const RACE_ROLL = "25BCS_RACE_E2E";
  const RACE_EMAIL = "race.e2e@institution.edu";
  await db.collection("students").doc(RACE_ROLL).set({
    rollNo: RACE_ROLL,
    name: "Race Student",
    email: RACE_EMAIL,
    studentUid: RACE_UID,
    faceDescriptor: enrolledDescriptor,
    faceRegistered: true
  });
  await db.collection("users").doc(RACE_UID).set({
    uid: RACE_UID,
    email: RACE_EMAIL,
    role: "STUDENT",
    rollNo: RACE_ROLL
  });

  const raceSettled = await Promise.allSettled([
    fns.bindStudentDevicePlatform.run({
      auth: { uid: RACE_UID, token: { email: RACE_EMAIL } },
      data: { platform: "android" }
    }),
    fns.bindStudentDevicePlatform.run({
      auth: { uid: RACE_UID, token: { email: RACE_EMAIL } },
      data: { platform: "ios" }
    })
  ]);

  const fulfilled = raceSettled.filter(r => r.status === "fulfilled");
  const rejected = raceSettled.filter(r => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "Exactly one concurrent binding must succeed");
  assert.equal(rejected.length, 1, "Conflicting concurrent binding must be rejected");
  assert.equal(rejected[0].reason.code, "already-exists");

  const raceStudentSnap = await db.collection("students").doc(RACE_ROLL).get();
  const raceAssigned = raceStudentSnap.data().registeredPlatform;
  assert.ok(raceAssigned === "android" || raceAssigned === "ios");
  assert.equal(raceStudentSnap.data().deviceTypeLocked, true);

  // 5. Direct Firestore Client REST Write to Protected Platform Fields Denied by Rules
  const restWriteAttempt = await testClientRestWrite(`students/${STUDENT_ROLL}`, {
    fields: {
      registeredPlatform: { stringValue: "android" },
      deviceTypeLocked: { booleanValue: false }
    }
  });
  assert.equal(restWriteAttempt.statusCode, 403, "Direct student write to protected student platform fields must be 403 Forbidden");

  const userRestWriteAttempt = await testClientRestWrite(`users/${STUDENT_UID}`, {
    fields: {
      registeredPlatform: { stringValue: "android" },
      deviceTypeLocked: { booleanValue: false }
    }
  });
  assert.equal(userRestWriteAttempt.statusCode, 403, "Direct student write to protected user platform fields must be 403 Forbidden");

  // 6. Unauthorized Recovery / Platform Change Rejected
  // Student calling without requestId
  await assert.rejects(
    async () => {
      await fns.resetStudentDevicePlatform.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: { newPlatform: "android" }
      });
    },
    (err) => {
      assert.equal(err.code, "permission-denied");
      assert.ok(err.message.includes("requires an approved Biometric Change Request ID"));
      return true;
    }
  );

  // Student calling with unapproved/pending requestId
  await db.collection("biometric_change_requests").doc("e2e_pending_req").set({
    studentUid: STUDENT_UID,
    rollNo: STUDENT_ROLL,
    status: "PENDING",
    used: false
  });
  await assert.rejects(
    async () => {
      await fns.resetStudentDevicePlatform.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: { requestId: "e2e_pending_req", newPlatform: "android" }
      });
    },
    (err) => {
      assert.equal(err.code, "permission-denied");
      assert.ok(err.message.includes("Valid, approved Biometric Change Request required"));
      return true;
    }
  );

  // Cross-student request ID rejection: Carol attempts to use Bob's approved change request
  const BOB_UID = "student_bob_cross_uid";
  const BOB_ROLL = "25BCS_BOB";
  const BOB_REQ_ID = "e2e_bob_approved_req";
  await db.collection("students").doc(BOB_ROLL).set({
    rollNo: BOB_ROLL,
    name: "Bob Student",
    studentUid: BOB_UID,
    registeredPlatform: "android",
    deviceTypeLocked: true
  });
  await db.collection("biometric_change_requests").doc(BOB_REQ_ID).set({
    studentUid: BOB_UID,
    rollNo: BOB_ROLL,
    status: "APPROVED",
    used: false,
    createdAt: new Date()
  });

  await assert.rejects(
    async () => {
      await fns.resetStudentDevicePlatform.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: { requestId: BOB_REQ_ID, newPlatform: "android" }
      });
    },
    (err) => {
      assert.equal(err.code, "permission-denied");
      assert.ok(err.message.includes("Valid, approved Biometric Change Request required"));
      return true;
    }
  );
  // Verify Bob's request was NOT consumed
  const bobReqSnap = await db.collection("biometric_change_requests").doc(BOB_REQ_ID).get();
  assert.equal(bobReqSnap.data().used, false);

  // Lecturer not assigned to course calling reset
  await assert.rejects(
    async () => {
      await fns.resetStudentDevicePlatform.run({
        auth: { uid: "unassigned_prof_uid", token: { email: "unassigned.prof@other.edu", role: "LECTURER" } },
        data: { targetRollNo: STUDENT_ROLL, newPlatform: "android" }
      });
    },
    (err) => {
      assert.equal(err.code, "permission-denied");
      return true;
    }
  );

  // 7. Authorized Recovery: Audited, Properly Authorized, Anti-Replay
  // Seed an approved recovery request for Carol
  const APPROVED_REQ_ID = "e2e_approved_req_01";
  await db.collection("biometric_change_requests").doc(APPROVED_REQ_ID).set({
    studentUid: STUDENT_UID,
    rollNo: STUDENT_ROLL,
    status: "APPROVED",
    used: false,
    createdAt: new Date()
  });

  // Seed an active hardware credential before resetting platform
  await db.collection("biometric_credentials").doc(STUDENT_UID).set({
    studentUid: STUDENT_UID,
    rollNo: STUDENT_ROLL,
    status: "ACTIVE",
    platform: "android",
    publicKeyDerBase64: "FAKE_OLD_KEY_DER_64"
  });

  const studentResetRes = await fns.resetStudentDevicePlatform.run({
    auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
    data: { requestId: APPROVED_REQ_ID, newPlatform: "android" }
  });
  assert.ok(studentResetRes.success);
  assert.equal(studentResetRes.newPlatform, "android");

  // Verify request is consumed atomically (used: true)
  const consumedReq = await db.collection("biometric_change_requests").doc(APPROVED_REQ_ID).get();
  assert.equal(consumedReq.data().status, "COMPLETED");
  assert.equal(consumedReq.data().used, true);

  // Replay attempt with same requestId must be rejected
  await assert.rejects(
    async () => {
      await fns.resetStudentDevicePlatform.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: { requestId: APPROVED_REQ_ID, newPlatform: "ios" }
      });
    },
    (err) => {
      assert.equal(err.code, "permission-denied");
      return true;
    }
  );

  // Lecturer (Prof. Alice, assigned to CS101) resets Carol to "ios" for website attendance
  const lecturerResetRes = await fns.resetStudentDevicePlatform.run({
    auth: { uid: LECTURER_UID, token: { email: LECTURER_EMAIL, role: "LECTURER" } },
    data: { targetRollNo: STUDENT_ROLL, newPlatform: "ios", reason: "Student switching to iOS" }
  });
  assert.ok(lecturerResetRes.success);
  assert.equal(lecturerResetRes.newPlatform, "ios");

  // Credential revocation check on Android-to-iOS platform transition:
  // Credentials in biometric_credentials must be marked SUPERSEDED
  const supersededCredSnap = await db.collection("biometric_credentials").doc(STUDENT_UID).get();
  assert.equal(supersededCredSnap.data().status, "SUPERSEDED");

  // Verify Audit Log was recorded
  const auditLogsSnap = await db.collection("biometric_audit_logs").where("rollNo", "==", STUDENT_ROLL).get();
  assert.ok(auditLogsSnap.size >= 2, "Platform binding and resets must be recorded in biometric_audit_logs");

  // 8. Missing / Stale Platform Fallbacks & Legitimate Legacy User Onboarding
  const LEGACY_ROLL = "25BCS_LEGACY_E2E";
  const LEGACY_UID = "legacy_student_e2e_uid";
  const LEGACY_EMAIL = "legacy.e2e@institution.edu";
  await db.collection("students").doc(LEGACY_ROLL).set({
    rollNo: LEGACY_ROLL,
    name: "Legacy Student",
    email: LEGACY_EMAIL,
    studentUid: LEGACY_UID,
    deviceType: "android", // legacy unverified field
    registeredDeviceType: "android",
    // registeredPlatform is intentionally NOT set (unbound)
    faceDescriptor: enrolledDescriptor,
    faceRegistered: true
  });
  await db.collection("users").doc(LEGACY_UID).set({
    uid: LEGACY_UID,
    email: LEGACY_EMAIL,
    role: "STUDENT",
    rollNo: LEGACY_ROLL
  });
  // Active credential without registeredPlatform
  await db.collection("biometric_credentials").doc(LEGACY_UID).set({
    studentUid: LEGACY_UID,
    rollNo: LEGACY_ROLL,
    status: "ACTIVE",
    platform: "android"
  });

  // Stale deviceType or credData.platform MUST NOT bypass fail-closed check
  await assert.rejects(
    async () => {
      await fns.authorizeQR1.run({
        auth: { uid: LEGACY_UID, token: { email: LEGACY_EMAIL } },
        data: { sessionId, slot: slotPre, sig: sigPre, int: 10, studentLocation: { latitude: 12.9716, longitude: 77.5946, accuracy: 5, timestamp: Date.now() } }
      });
    },
    (err) => {
      assert.equal(err.code, "failed-precondition");
      assert.ok(err.message.includes("Device platform onboarding incomplete"));
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await fns.submitAttendance.run({
        auth: { uid: LEGACY_UID, token: { email: LEGACY_EMAIL } },
        data: { sessionId, qr2Token: qr2Secret, biometricData: { liveness: true, liveDescriptor: enrolledDescriptor } }
      });
    },
    (err) => {
      assert.equal(err.code, "failed-precondition");
      assert.ok(err.message.includes("Device platform onboarding incomplete"));
      return true;
    }
  );

  // Legitimate legacy student onboarding: can call bindStudentDevicePlatform to securely establish binding
  const legacyBindRes = await fns.bindStudentDevicePlatform.run({
    auth: { uid: LEGACY_UID, token: { email: LEGACY_EMAIL } },
    data: { platform: "ios" }
  });
  assert.ok(legacyBindRes.success);
  assert.equal(legacyBindRes.platform, "ios");
  const boundLegacySnap = await db.collection("students").doc(LEGACY_ROLL).get();
  assert.equal(boundLegacySnap.data().registeredPlatform, "ios");
  assert.equal(boundLegacySnap.data().deviceTypeLocked, true);

  // 9. Conflicting Platform Fields: registeredPlatform is authoritative
  const CONFLICT_ROLL = "25BCS_CONFLICT_E2E";
  const CONFLICT_UID = "conflict_student_e2e_uid";
  const CONFLICT_EMAIL = "conflict.e2e@institution.edu";
  await db.collection("students").doc(CONFLICT_ROLL).set({
    rollNo: CONFLICT_ROLL,
    name: "Conflict Student",
    email: CONFLICT_EMAIL,
    studentUid: CONFLICT_UID,
    registeredPlatform: "android", // Authoritative
    deviceType: "ios", // Conflicting legacy field
    registeredDeviceType: "ios",
    deviceTypeLocked: true,
    faceDescriptor: enrolledDescriptor,
    faceRegistered: true
  });
  await db.collection("users").doc(CONFLICT_UID).set({
    uid: CONFLICT_UID,
    email: CONFLICT_EMAIL,
    role: "STUDENT",
    rollNo: CONFLICT_ROLL
  });
  await db.collection("attendance_sessions").doc(sessionId).collection("authorizations").doc(CONFLICT_UID).set({
    sessionId,
    studentUid: CONFLICT_UID,
    rollNo: CONFLICT_ROLL,
    qr1Verified: true,
    qr2Verified: true,
    qr2VerifiedAt: new Date()
  });

  // Attempt attendance via browser: registeredPlatform is "android", so web submission without hardware proof is rejected
  await assert.rejects(
    async () => {
      await fns.submitAttendance.run({
        rawRequest: { headers: { "user-agent": "Mozilla/5.0 (iPhone)" } },
        auth: { uid: CONFLICT_UID, token: { email: CONFLICT_EMAIL } },
        data: { sessionId, qr2Token: qr2Secret, biometricData: { liveness: true, liveDescriptor: enrolledDescriptor } }
      });
    },
    (err) => {
      assert.ok(
        err.message.includes("Android attendance requires the authorized native SmartAttend application") ||
        err.code === "permission-denied"
      );
      return true;
    }
  );

  // --------------------------------------------------------------------------
  // STEP 2 & 3: Geofence Proxy Rejection & Authorized Dynamic QR1 Check-In
  // --------------------------------------------------------------------------
  console.log("--> Step 2 & 3: Student geofence enforcement and Phase 1 check-in...");
  const now = Date.now();
  const currentSlot1 = Math.floor(now / 10000);
  const sig1 = generateDynamicQrToken(sessionId, 1, currentSlot1, 10, qr1Secret);

  // A. Proxy attempt from 55m away (outside 10m + 5m = 15m ceiling)
  const proxyLocation = { latitude: 12.972100, longitude: 77.594600, accuracy: 25, timestamp: now };
  await assert.rejects(
    async () => {
      await fns.authorizeQR1.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: {
          sessionId,
          slot: currentSlot1,
          sig: sig1,
          int: 10,
          studentLocation: proxyLocation
        }
      });
    },
    (err) => {
      assert.ok(err.message.includes("Geofence Violation"), `Expected Geofence Violation, got: ${err.message}`);
      return true;
    }
  );

  // Verify no authorization was recorded for proxy attempt
  const proxyAuthCheck = await db.collection("attendance_sessions").doc(sessionId).collection("authorizations").doc(STUDENT_UID).get();
  assert.equal(proxyAuthCheck.exists, false, "Proxy attempt must not create authorization record");

  // B. Legitimate student inside classroom (Haversine ~3.8m <= 10m)
  const legitLocation = { latitude: 12.971630, longitude: 77.594615, accuracy: 6, timestamp: now };
  const auth1Res = await fns.authorizeQR1.run({
    auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
    data: {
      sessionId,
      slot: currentSlot1,
      sig: sig1,
      int: 10,
      studentLocation: legitLocation,
      deviceId: "MOCK_ANDROID_DEVICE_01"
    }
  });

  assert.ok(auth1Res.success, "Phase 1 check-in should succeed");
  assert.equal(auth1Res.status, "QR1_VERIFIED");

  // Verify Database State after Phase 1 Check-In
  const authSnap1 = await db.collection("attendance_sessions").doc(sessionId).collection("authorizations").doc(STUDENT_UID).get();
  assert.ok(authSnap1.exists, "Authorization document must exist");
  const authData1 = authSnap1.data();
  assert.equal(authData1.qr1Verified, true);
  assert.equal(authData1.releaseStatus, "LOCKED");
  assert.equal(authData1.rollNo, STUDENT_ROLL);

  // --------------------------------------------------------------------------
  // STEP 4: Transition to Phase 2
  // --------------------------------------------------------------------------
  console.log("--> Step 4: Transitioning session to Phase 2...");
  const transRes = await fns.transitionToPhase2.run({
    auth: { uid: LECTURER_UID, token: { email: LECTURER_EMAIL, role: "LECTURER" } },
    data: { sessionId }
  });
  assert.ok(transRes.success);
  assert.equal(transRes.phase, "PHASE_2");

  const sessionSnap2 = await db.collection("attendance_sessions").doc(sessionId).get();
  assert.equal(sessionSnap2.data().phase, "PHASE_2");

  // --------------------------------------------------------------------------
  // STEP 5: Phase 2 Dynamic QR2 Validation
  // --------------------------------------------------------------------------
  console.log("--> Step 5: Student scans dynamic Phase 2 QR2...");
  const nowPhase2 = Date.now();
  const currentSlot2 = Math.floor(nowPhase2 / 10000);
  const sig2 = generateDynamicQrToken(sessionId, 2, currentSlot2, 10, qr2Secret);

  const qr2Res = await fns.validateQR2.run({
    auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
    data: {
      sessionId,
      qr2Token: qr2Secret,
      slot: currentSlot2,
      sig: sig2,
      int: 10
    }
  });
  assert.ok(qr2Res.success);
  assert.equal(qr2Res.authorized, true);

  // Verify Database State: qr2Verified stamped with server timestamp
  const authSnap2 = await db.collection("attendance_sessions").doc(sessionId).collection("authorizations").doc(STUDENT_UID).get();
  assert.equal(authSnap2.data().qr2Verified, true);
  assert.ok(authSnap2.data().qr2VerifiedAt, "qr2VerifiedAt timestamp must be set");

  // --------------------------------------------------------------------------
  // STEP 6: Biometric Verification & Proxy Rejection Paths
  // --------------------------------------------------------------------------
  console.log("--> Step 6: Testing biometric rejection paths...");

  // A. Liveness = false (printed photo / static screen spoof)
  await assert.rejects(
    async () => {
      await fns.submitAttendance.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: {
          sessionId,
          qr2Token: qr2Secret,
          biometricData: {
            liveness: false, // failed blink / active liveness
            liveDescriptor: enrolledDescriptor
          }
        }
      });
    },
    (err) => {
      assert.ok(err.message.includes("liveness verification failed"), `Expected liveness failure, got: ${err.message}`);
      return true;
    }
  );

  // B. Impostor face vector (distance > 0.52 threshold)
  const impostorDescriptor = enrolledDescriptor.map((v) => -v); // inverted vector, distance >> 0.52
  await assert.rejects(
    async () => {
      await fns.submitAttendance.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: {
          sessionId,
          qr2Token: qr2Secret,
          biometricData: {
            liveness: true,
            liveDescriptor: impostorDescriptor
          }
        }
      });
    },
    (err) => {
      assert.ok(err.message.includes("Face biometric verification failed"), `Expected face mismatch, got: ${err.message}`);
      return true;
    }
  );

  // C. Forged client authorization: Enrolled student who skipped QR1 calls submitAttendance
  console.log("--> Step 6C: Testing forged authorization rejection (skipped QR1)...");
  const EVE_UID = "student_eve_enrolled";
  const EVE_EMAIL = "eve.student@institution.edu";
  const EVE_ROLL = "25BCS_EVE";
  await db.collection("students").doc(EVE_ROLL).set({
    rollNo: EVE_ROLL,
    name: "Eve Student",
    fullName: "Eve Student",
    email: EVE_EMAIL,
    studentUid: EVE_UID,
    faceDescriptor: enrolledDescriptor,
    faceRegistered: true,
    registeredPlatform: "ios",
    deviceType: "ios",
    deviceTypeLocked: true
  });
  await db.collection("users").doc(EVE_UID).set({
    uid: EVE_UID,
    email: EVE_EMAIL,
    role: "STUDENT",
    rollNo: EVE_ROLL,
    registeredPlatform: "ios",
    deviceType: "ios"
  });

  await assert.rejects(
    async () => {
      await fns.submitAttendance.run({
        auth: { uid: EVE_UID, token: { email: EVE_EMAIL } },
        data: {
          sessionId,
          qr2Token: qr2Secret,
          biometricData: {
            liveness: true,
            liveDescriptor: enrolledDescriptor
          }
        }
      });
    },
    (err) => {
      assert.ok(
        err.message.includes("scan QR 1 first") || err.code === "permission-denied",
        `Expected QR1 check-in required, got: ${err.message}`
      );
      return true;
    }
  );

  // D. Stale QR2 submission window: Stale validation (> 35s ago) cannot submit without fresh QR
  console.log("--> Step 6D: Testing stale QR2 submission window rejection (> 35s)...");
  // Temporarily backdate qr2VerifiedAt on authorizations doc to 45 seconds ago
  const staleAuthRef = db.collection("attendance_sessions").doc(sessionId).collection("authorizations").doc(STUDENT_UID);
  await staleAuthRef.update({
    qr2VerifiedAt: new Date(Date.now() - 45000)
  });

  await assert.rejects(
    async () => {
      await fns.submitAttendance.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: {
          sessionId,
          qr2Token: qr2Secret,
          // Providing stale slot
          slot: currentSlot2 - 5,
          sig: "invalid_stale_sig",
          int: 10,
          biometricData: {
            liveness: true,
            liveDescriptor: enrolledDescriptor
          }
        }
      });
    },
    (err) => {
      assert.ok(
        err.message.includes("expired") || err.message.includes("failed") || err.message.includes("permission-denied"),
        `Expected expired/stale QR2 error, got: ${err.message}`
      );
      return true;
    }
  );

  // Restore qr2VerifiedAt to fresh timestamp for genuine attendance step
  await staleAuthRef.update({
    qr2Verified: true,
    qr2VerifiedAt: new Date()
  });

  // E. Unauthorized Session Modification: Student attempts to alter geofence or session timing
  console.log("--> Step 6E: Testing unauthorized session parameter alteration by student...");
  await assert.rejects(
    async () => {
      await fns.updateSessionGeofenceRadius.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL, role: "STUDENT" } },
        data: { sessionId, radius: 500 }
      });
    },
    (err) => {
      assert.ok(err.code === "permission-denied" || err.message.includes("restricted") || err.message.includes("lecturer"));
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await fns.extendAttendanceSession.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL, role: "STUDENT" } },
        data: { sessionId, deltaSeconds: 300, phaseTarget: "PHASE_2" }
      });
    },
    (err) => {
      assert.ok(err.code === "permission-denied" || err.message.includes("restricted") || err.message.includes("lecturer"));
      return true;
    }
  );

  // F. Hardware Credential Bypass Attempt: Student with active hardware credential attempts bypass without hardware proof
  console.log("--> Step 6F: Testing hardware credential bypass rejection (missing hardware proof)...");
  const HW_STUDENT_UID = "student_hw_enrolled_uid";
  const HW_STUDENT_ROLL = "25BCS777";
  const HW_STUDENT_EMAIL = "hw.student@institution.edu";
  await db.collection("students").doc(HW_STUDENT_ROLL).set({
    rollNo: HW_STUDENT_ROLL,
    name: "Hardware Student",
    fullName: "Hardware Student",
    email: HW_STUDENT_EMAIL,
    studentUid: HW_STUDENT_UID,
    faceDescriptor: enrolledDescriptor,
    faceRegistered: true,
    hardwareBiometricEnrolled: true,
    registeredPlatform: "android",
    deviceType: "android",
    deviceTypeLocked: true
  });
  await db.collection("users").doc(HW_STUDENT_UID).set({
    uid: HW_STUDENT_UID,
    email: HW_STUDENT_EMAIL,
    role: "STUDENT",
    rollNo: HW_STUDENT_ROLL,
    registeredPlatform: "android",
    deviceType: "android"
  });
  await db.collection("biometric_credentials").doc(HW_STUDENT_UID).set({
    studentUid: HW_STUDENT_UID,
    rollNo: HW_STUDENT_ROLL,
    status: "ACTIVE",
    platform: "android",
    publicKeyDerBase64: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12=="
  });
  // Authorize Phase 1 for this student
  await db.collection("attendance_sessions").doc(sessionId).collection("authorizations").doc(HW_STUDENT_UID).set({
    sessionId,
    studentUid: HW_STUDENT_UID,
    rollNo: HW_STUDENT_ROLL,
    qr1Verified: true,
    qr2Verified: true,
    qr2VerifiedAt: new Date()
  });

  // Attempting submitAttendance without hardwareProof must be rejected with permission-denied
  await assert.rejects(
    async () => {
      await fns.submitAttendance.run({
        auth: { uid: HW_STUDENT_UID, token: { email: HW_STUDENT_EMAIL } },
        data: {
          sessionId,
          qr2Token: qr2Secret,
          hardwareProof: null, // Attempting to bypass hardware biometric requirement
          biometricData: {
            liveness: true,
            liveDescriptor: enrolledDescriptor
          }
        }
      });
    },
    (err) => {
      assert.ok(
        err.message.includes("Hardware biometric authentication is required") || err.code === "permission-denied",
        `Expected hardware proof required error, got: ${err.message}`
      );
      return true;
    }
  );

  // Verify zero attendance records created during any of the rejected attempts
  const recordsBeforeSuccess = await db.collection("attendance_records").where("sessionId", "==", sessionId).get();
  assert.equal(recordsBeforeSuccess.size, 0, "No attendance records must exist after rejected attempts");

  // --------------------------------------------------------------------------
  // STEP 7: Successful Attendance Submission & Atomic Write
  // --------------------------------------------------------------------------
  console.log("--> Step 7: Submitting genuine verified attendance...");
  // Legitimate repeat optical capture (e.g. Euclidean distance ~0.14 <= 0.52)
  const legitLiveDescriptor = enrolledDescriptor.map((val, idx) => (idx % 2 === 0 ? val + 0.012 : val - 0.010));

  const submitRes = await fns.submitAttendance.run({
    auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
    data: {
      sessionId,
      qr2Token: qr2Secret,
      slot: currentSlot2,
      sig: sig2,
      int: 10,
      biometricData: {
        liveness: true,
        blinkCount: 2,
        liveDescriptor: legitLiveDescriptor
      }
    }
  });

  assert.ok(submitRes.success, "Submission must succeed");
  assert.equal(submitRes.status, "ATTENDED");
  const expectedRecordId = `${sessionId}_${STUDENT_ROLL}`;
  assert.equal(submitRes.recordId, expectedRecordId);

  // --------------------------------------------------------------------------
  // STEP 8: Database State Verification & Single-Use Token Consumption
  // --------------------------------------------------------------------------
  console.log("--> Step 8: Verifying authoritative database state...");

  // Exactly ONE attendance record exists
  const recordDoc = await db.collection("attendance_records").doc(expectedRecordId).get();
  assert.ok(recordDoc.exists, "Authoritative attendance record must exist");
  const recordData = recordDoc.data();
  assert.equal(recordData.sessionId, sessionId);
  assert.equal(recordData.rollNo, STUDENT_ROLL);
  assert.equal(recordData.studentUid, STUDENT_UID);
  assert.equal(recordData.status, "ATTENDED");
  assert.ok(recordData.submittedAt || recordData.biometricVerifiedAt, "submittedAt/biometricVerifiedAt timestamp must exist");

  // Verify qr2Verified was atomically consumed (reset to false) to prevent token replay
  const postSubmitAuth = await db.collection("attendance_sessions").doc(sessionId).collection("authorizations").doc(STUDENT_UID).get();
  assert.equal(postSubmitAuth.data().qr2Verified, false, "qr2Verified flag must be consumed on submission");

  // --------------------------------------------------------------------------
  // STEP 9: Atomic Duplicate Replay Rejection
  // --------------------------------------------------------------------------
  console.log("--> Step 9: Testing duplicate submission replay rejection...");
  await assert.rejects(
    async () => {
      await fns.submitAttendance.run({
        auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
        data: {
          sessionId,
          qr2Token: qr2Secret,
          slot: currentSlot2,
          sig: sig2,
          int: 10,
          biometricData: {
            liveness: true,
            blinkCount: 2,
            liveDescriptor: legitLiveDescriptor
          }
        }
      });
    },
    (err) => {
      assert.ok(
        err.message.includes("already recorded") || err.message.includes("already-exists"),
        `Expected already-exists error, got: ${err.message}`
      );
      return true;
    }
  );

  // Total records for this session remains strictly 1
  const allRecordsAfter = await db.collection("attendance_records").where("sessionId", "==", sessionId).get();
  assert.equal(allRecordsAfter.size, 1, "Exactly one attendance record must exist in database");

  // --------------------------------------------------------------------------
  // STEP 10: Lecturer Real-Time Roster Verification
  // --------------------------------------------------------------------------
  console.log("--> Step 10: Verifying lecturer live roster view...");
  const lecturerRosterQuery = await db.collection("attendance_records")
    .where("sessionId", "==", sessionId)
    .get();

  assert.equal(lecturerRosterQuery.size, 1);
  const rosterEntry = lecturerRosterQuery.docs[0].data();
  assert.equal(rosterEntry.rollNo, STUDENT_ROLL);
  assert.equal(rosterEntry.status, "ATTENDED");

  // --------------------------------------------------------------------------
  // STEP 11: Emergency Release PIN Verification & Rate-Limiting
  // --------------------------------------------------------------------------
  console.log("--> Step 11: Verifying Release PIN rate-limiting and random-salt security...");
  const validPin = "654321";
  const pinSalt = secData.pinSalt;
  const saltedHash = hashToken(`${pinSalt}:${validPin}`);
  // Update security doc with known salted hash for PIN test
  await db.collection("attendance_sessions").doc(sessionId).collection("security").doc("tokens").update({
    saltedReleaseCodeHash: saltedHash
  });

  const pinReq = (inputPin) => ({
    auth: { uid: STUDENT_UID, token: { email: STUDENT_EMAIL } },
    data: { sessionId, releaseCode: inputPin }
  });

  // 4 incorrect attempts
  for (let i = 1; i <= 4; i++) {
    await assert.rejects(
      async () => { await fns.verifyLecturerReleaseCode.run(pinReq(`00000${i}`)); },
      (err) => {
        assert.ok(err.message.includes("Invalid Session PIN"));
        return true;
      }
    );
  }

  // 5th incorrect attempt triggers 10-minute lockout
  await assert.rejects(
    async () => { await fns.verifyLecturerReleaseCode.run(pinReq("999999")); },
    (err) => {
      assert.ok(err.message.includes("Too many incorrect attempts") || err.message.includes("resource-exhausted"));
      return true;
    }
  );

  // During lockout, even correct PIN is rejected
  await assert.rejects(
    async () => { await fns.verifyLecturerReleaseCode.run(pinReq(validPin)); },
    (err) => {
      assert.ok(err.message.includes("Too many failed Session PIN attempts"));
      return true;
    }
  );

  // --------------------------------------------------------------------------
  // STEP 13: Direct Authoritative Geofence Boundary Verification (fns.evaluateServerGeofence)
  // --------------------------------------------------------------------------
  console.log("--> Step 13: Verifying production evaluateServerGeofence boundary points and formula...");
  const C_LAT = 12.9716;
  const C_LON = 77.5946;
  const step13Now = Date.now();
  const step13ClassroomLoc = { latitude: C_LAT, longitude: C_LON, accuracy: 5 };

  // 13a. Accuracy = 8m (discount 4m -> max raw dist = 14.0m):
  // 13.9m raw dist, 8m accuracy -> effective 9.9m <= 10m -> PASS
  const res13_9 = fns.evaluateServerGeofence({ latitude: C_LAT + 0.00012501, longitude: C_LON, accuracy: 8, timestamp: step13Now }, step13ClassroomLoc, 10, step13Now);
  assert.equal(res13_9.status, "PASS");
  assert.equal(res13_9.distance, 13.9);
  assert.equal(res13_9.effectiveDistance, 9.9);

  // 14.0m raw dist, 8m accuracy -> effective 10.0m <= 10m -> PASS
  const res14_0 = fns.evaluateServerGeofence({ latitude: C_LAT + 0.00012591, longitude: C_LON, accuracy: 8, timestamp: step13Now }, step13ClassroomLoc, 10, step13Now);
  assert.equal(res14_0.status, "PASS");
  assert.equal(res14_0.distance, 14.0);
  assert.equal(res14_0.effectiveDistance, 10.0);

  // 14.1m raw dist, 8m accuracy -> effective 10.1m > 10m -> REJECT
  const res14_1 = fns.evaluateServerGeofence({ latitude: C_LAT + 0.00012680, longitude: C_LON, accuracy: 8, timestamp: step13Now }, step13ClassroomLoc, 10, step13Now);
  assert.equal(res14_1.status, "REJECT");
  assert.equal(res14_1.distance, 14.1);
  assert.equal(res14_1.effectiveDistance, 10.1);

  // 16.7m raw dist, 8m accuracy -> effective 12.7m > 10m -> REJECT
  // Reconciles formula: rawDist - min(accuracy/2, 5) gives 12.7m (REJECT), not 8.7m
  const res16_7 = fns.evaluateServerGeofence({ latitude: C_LAT + 0.00015019, longitude: C_LON, accuracy: 8, timestamp: step13Now }, step13ClassroomLoc, 10, step13Now);
  assert.equal(res16_7.status, "REJECT");
  assert.equal(res16_7.distance, 16.7);
  assert.equal(res16_7.effectiveDistance, 12.7);

  // 13b. Accuracy = 10m (discount capped at 5.0m -> max raw dist = 15.0m):
  // 14.9m raw dist, 10m accuracy -> effective 9.9m <= 10m -> PASS
  const res14_9 = fns.evaluateServerGeofence({ latitude: C_LAT + 0.00013400, longitude: C_LON, accuracy: 10, timestamp: step13Now }, step13ClassroomLoc, 10, step13Now);
  assert.equal(res14_9.status, "PASS");
  assert.equal(res14_9.distance, 14.9);
  assert.equal(res14_9.effectiveDistance, 9.9);

  // 15.0m raw dist, 10m accuracy -> effective 10.0m <= 10m -> PASS
  const res15_0 = fns.evaluateServerGeofence({ latitude: C_LAT + 0.00013490, longitude: C_LON, accuracy: 10, timestamp: step13Now }, step13ClassroomLoc, 10, step13Now);
  assert.equal(res15_0.status, "PASS");
  assert.equal(res15_0.distance, 15.0);
  assert.equal(res15_0.effectiveDistance, 10.0);

  // 15.1m raw dist, 10m accuracy -> effective 10.1m > 10m -> REJECT
  const res15_1 = fns.evaluateServerGeofence({ latitude: C_LAT + 0.00013580, longitude: C_LON, accuracy: 10, timestamp: step13Now }, step13ClassroomLoc, 10, step13Now);
  assert.equal(res15_1.status, "REJECT");
  assert.equal(res15_1.distance, 15.1);
  assert.equal(res15_1.effectiveDistance, 10.1);

  // 13c. Degraded accuracy (> 45m) -> INCONCLUSIVE
  assert.equal(fns.evaluateServerGeofence({ latitude: C_LAT, longitude: C_LON, accuracy: 46, timestamp: step13Now }, step13ClassroomLoc, 10, step13Now).status, "INCONCLUSIVE");
  assert.equal(fns.evaluateServerGeofence({ latitude: C_LAT, longitude: C_LON, accuracy: 60, timestamp: step13Now }, step13ClassroomLoc, 10, step13Now).status, "INCONCLUSIVE");

  // 13d. Invalid coordinates -> LOCATION_UNAVAILABLE
  assert.equal(fns.evaluateServerGeofence(null, step13ClassroomLoc, 10, step13Now).status, "LOCATION_UNAVAILABLE");
  assert.equal(fns.evaluateServerGeofence({ latitude: NaN, longitude: C_LON, timestamp: step13Now }, step13ClassroomLoc, 10, step13Now).status, "LOCATION_UNAVAILABLE");

  // --------------------------------------------------------------------------
  // STEP 14: Direct Authoritative Dynamic QR 12-Interval Boundary Verification
  // --------------------------------------------------------------------------
  console.log("--> Step 14: Verifying production verifyDynamicQrToken across all 12 intervals...");
  const supportedIntervals = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
  const testSecret = "prod_session_secret_hmac_key_999";
  const baseTime = 1700000000000;

  for (const interval of supportedIntervals) {
    const currentSlot = Math.floor(baseTime / (interval * 1000));
    const slotStartTime = currentSlot * interval * 1000;
    const slotEndTime = (currentSlot + 1) * interval * 1000;
    const currentSig = fns.generateDynamicQrToken(sessionId, 2, currentSlot, interval, testSecret);

    // Current slot inside window verifies
    assert.equal(
      fns.verifyDynamicQrToken({
        sig: currentSig,
        sessionId,
        phase: 2,
        clientSlot: currentSlot,
        clientInterval: interval,
        authoritativeInterval: interval,
        serverNow: slotStartTime + 1000,
        secret: testSecret
      }),
      true
    );

    // Previous slot token
    const prevSlot = currentSlot - 1;
    const prevSig = fns.generateDynamicQrToken(sessionId, 2, prevSlot, interval, testSecret);

    if (interval >= 10) {
      // At exactly 5000ms after rotation (within 5s grace) -> accepted
      assert.equal(
        fns.verifyDynamicQrToken({
          sig: prevSig,
          sessionId,
          phase: 2,
          clientSlot: prevSlot,
          clientInterval: interval,
          authoritativeInterval: interval,
          serverNow: slotStartTime + 5000,
          secret: testSecret
        }),
        true
      );
      // Immediately outside 5s grace (+5001ms) -> strictly rejected
      assert.throws(
        () => fns.verifyDynamicQrToken({
          sig: prevSig,
          sessionId,
          phase: 2,
          clientSlot: prevSlot,
          clientInterval: interval,
          authoritativeInterval: interval,
          serverNow: slotStartTime + 5001,
          secret: testSecret
        }),
        (err) => {
          assert.equal(err.code, "deadline-exceeded");
          return true;
        }
      );
    } else {
      // For 5s interval, within slot (+4990ms) accepted; at +5001ms slot advanced by 2 -> rejected
      assert.equal(
        fns.verifyDynamicQrToken({
          sig: prevSig,
          sessionId,
          phase: 2,
          clientSlot: prevSlot,
          clientInterval: interval,
          authoritativeInterval: interval,
          serverNow: slotStartTime + 4990,
          secret: testSecret
        }),
        true
      );
      assert.throws(
        () => fns.verifyDynamicQrToken({
          sig: prevSig,
          sessionId,
          phase: 2,
          clientSlot: prevSlot,
          clientInterval: interval,
          authoritativeInterval: interval,
          serverNow: slotStartTime + 5001,
          secret: testSecret
        }),
        (err) => {
          assert.equal(err.code, "deadline-exceeded");
          return true;
        }
      );
    }

    // Future slot token
    const nextSlot = currentSlot + 1;
    const nextSig = fns.generateDynamicQrToken(sessionId, 2, nextSlot, interval, testSecret);

    // Future slot at exactly 5000ms before slot starts -> accepted
    assert.equal(
      fns.verifyDynamicQrToken({
        sig: nextSig,
        sessionId,
        phase: 2,
        clientSlot: nextSlot,
        clientInterval: interval,
        authoritativeInterval: interval,
        serverNow: slotEndTime - 5000,
        secret: testSecret
      }),
      true
    );

    if (interval >= 10) {
      // Future slot at 5001ms before slot starts -> rejected
      assert.throws(
        () => fns.verifyDynamicQrToken({
          sig: nextSig,
          sessionId,
          phase: 2,
          clientSlot: nextSlot,
          clientInterval: interval,
          authoritativeInterval: interval,
          serverNow: slotEndTime - 5001,
          secret: testSecret
        }),
        (err) => {
          assert.equal(err.code, "deadline-exceeded");
          return true;
        }
      );
    }

    // Invalid HMAC signature -> permission-denied
    assert.throws(
      () => fns.verifyDynamicQrToken({
        sig: "INVALID_SIG_HEX1",
        sessionId,
        phase: 2,
        clientSlot: currentSlot,
        clientInterval: interval,
        authoritativeInterval: interval,
        serverNow: slotStartTime + 1000,
        secret: testSecret
      }),
      (err) => {
        assert.equal(err.code, "permission-denied");
        return true;
      }
    );
  }

  // --------------------------------------------------------------------------
  // STEP 15: Android Profile-Bound Browser Bypass Rejection Test
  // --------------------------------------------------------------------------
  console.log("--> Step 15: Verifying profile-bound Android student cannot bypass native requirement via iPhone User-Agent...");
  const ANDROID_ROSTER_ROLL = "25BCS999";
  const ANDROID_ROSTER_UID = "student_android_roster_uid";
  const ANDROID_ROSTER_EMAIL = "android.roster@institution.edu";

  // Create student in students collection with registeredPlatform: "android"
  await db.collection("students").doc(ANDROID_ROSTER_ROLL).set({
    rollNo: ANDROID_ROSTER_ROLL,
    name: "Android Enrolled Student",
    email: ANDROID_ROSTER_EMAIL,
    studentUid: ANDROID_ROSTER_UID,
    faceDescriptor: enrolledDescriptor,
    faceRegistered: true,
    registeredPlatform: "android",
    deviceType: "android"
  });

  // Authorize Phase 1 for this student
  await db.collection("attendance_sessions").doc(sessionId).collection("authorizations").doc(ANDROID_ROSTER_UID).set({
    sessionId,
    studentUid: ANDROID_ROSTER_UID,
    rollNo: ANDROID_ROSTER_ROLL,
    qr1Verified: true,
    qr2Verified: true,
    qr2VerifiedAt: new Date()
  });

  // Student attempts submitAttendance claiming to be iPhone Safari, omitting hardware proof
  await assert.rejects(
    async () => {
      await fns.submitAttendance.run({
        rawRequest: {
          headers: {
            "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1"
          }
        },
        auth: { uid: ANDROID_ROSTER_UID, token: { email: ANDROID_ROSTER_EMAIL } },
        data: {
          sessionId,
          qr2Token: qr2Secret,
          biometricData: {
            liveness: true,
            liveDescriptor: enrolledDescriptor
          }
        }
      });
    },
    (err) => {
      assert.ok(
        err.message.includes("Android attendance requires the authorized native SmartAttend application") ||
        err.code === "permission-denied",
        `Expected Android native app requirement error, got: ${err.message}`
      );
      return true;
    }
  );

  // --------------------------------------------------------------------------
  // STEP 16: Authorized Native Mobile Flow for Android-Bound Student (Requirement 6)
  // --------------------------------------------------------------------------
  console.log("--> Step 16: Verifying authorized native mobile flow for Android-bound student...");
  const ANDROID_NATIVE_UID = "student_android_native_uid";
  const ANDROID_NATIVE_ROLL = "25BCS789";
  const ANDROID_NATIVE_EMAIL = "native.android@institution.edu";

  // Generate real EC P-256 keypair simulating Android Keystore
  const { publicKey: nativePubKey, privateKey: nativePrivKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubKeyDerBase64 = nativePubKey.export({ type: "spki", format: "der" }).toString("base64");

  await db.collection("students").doc(ANDROID_NATIVE_ROLL).set({
    rollNo: ANDROID_NATIVE_ROLL,
    name: "Native Android Student",
    fullName: "Native Android Student",
    email: ANDROID_NATIVE_EMAIL,
    studentUid: ANDROID_NATIVE_UID,
    faceDescriptor: enrolledDescriptor,
    faceRegistered: true,
    registeredPlatform: "android",
    deviceType: "android",
    deviceTypeLocked: true
  });
  await db.collection("users").doc(ANDROID_NATIVE_UID).set({
    uid: ANDROID_NATIVE_UID,
    email: ANDROID_NATIVE_EMAIL,
    role: "STUDENT",
    rollNo: ANDROID_NATIVE_ROLL,
    registeredPlatform: "android",
    deviceType: "android"
  });
  await db.collection("biometric_credentials").doc(ANDROID_NATIVE_UID).set({
    studentUid: ANDROID_NATIVE_UID,
    rollNo: ANDROID_NATIVE_ROLL,
    status: "ACTIVE",
    platform: "android",
    publicKeyDerBase64: pubKeyDerBase64,
    createdAt: new Date()
  });

  // Authorize Phase 1 check-in for Android student
  await db.collection("attendance_sessions").doc(sessionId).collection("authorizations").doc(ANDROID_NATIVE_UID).set({
    sessionId,
    studentUid: ANDROID_NATIVE_UID,
    rollNo: ANDROID_NATIVE_ROLL,
    qr1Verified: true,
    qr2Verified: true,
    qr2VerifiedAt: new Date(),
    registeredPlatform: "android"
  });

  // Request fresh cryptographic challenge
  const nativeChal = await fns.issueBiometricChallenge.run({
    auth: { uid: ANDROID_NATIVE_UID, token: { email: ANDROID_NATIVE_EMAIL } },
    data: { sessionId, action: "ATTENDANCE_VERIFICATION" }
  });
  assert.ok(nativeChal.success);

  // Sign challengeText with private key
  const signer = crypto.createSign("SHA256");
  signer.update(Buffer.from(nativeChal.challengeText, "utf8"));
  const hardwareSigBase64 = signer.sign(nativePrivKey, "base64");

  // Submit attendance with hardware proof
  const androidSubmitRes = await fns.submitAttendance.run({
    rawRequest: {
      headers: { "user-agent": "SmartAttend-Native-Android/1.0" }
    },
    auth: { uid: ANDROID_NATIVE_UID, token: { email: ANDROID_NATIVE_EMAIL } },
    data: {
      sessionId,
      qr2Token: qr2Secret,
      hardwareProof: {
        challengeId: nativeChal.challengeId,
        signature: hardwareSigBase64
      },
      biometricData: {
        liveness: true,
        liveDescriptor: enrolledDescriptor
      }
    }
  });

  assert.ok(androidSubmitRes.success);
  assert.equal(androidSubmitRes.status, "ATTENDED");
  const nativeRecordDoc = await db.collection("attendance_records").doc(`${sessionId}_${ANDROID_NATIVE_ROLL}`).get();
  assert.ok(nativeRecordDoc.exists);

  console.log("--> ALL 16 END-TO-END FLOW & OPTION A PLATFORM BINDING STEPS VERIFIED AGAINST LIVE EMULATOR SUCCESSFULLY!");
});

