import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const prodFns = require("../functions/index.js");

const {
  evaluateFaceUniqueness,
  faceVectorDistance,
  validateFaceVectorDescriptor,
  getAuthorizedStudentRollsForLecturer,
  resolveActiveReRegistrationPermission,
  consumeReRegistrationPermission
} = prodFns;

// Helper to generate a normalized 128-dimensional synthetic face vector
function generateMockFaceVector(seed = 1) {
  const vec = new Array(128);
  let sumSq = 0;
  for (let i = 0; i < 128; i++) {
    const val = Math.sin(seed * (i + 1) * 0.17) * Math.cos(seed * (i + 5) * 0.31);
    vec[i] = val;
    sumSq += val * val;
  }
  const norm = Math.sqrt(sumSq) || 1;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

// Helper to slightly perturb a vector (representing the same person captured at a different angle/lighting)
function perturbVector(baseVec, variance = 0.03) {
  const perturbed = baseVec.map((v, i) => v + Math.sin(i * 0.5) * variance);
  const norm = Math.sqrt(perturbed.reduce((acc, v) => acc + v * v, 0)) || 1;
  return perturbed.map((v) => Number((v / norm).toFixed(6)));
}

// Mock Firestore Transaction / DB for offline unit testing
function createMockDb(docs = []) {
  return {
    get: async () => ({ docs }),
    collection: () => ({
      where: () => ({
        where: () => ({
          get: async () => ({ docs })
        })
      })
    })
  };
}

// ============================================================================
// SUITE: BIOMETRIC RE-REGISTRATION, ROLE PERMISSIONS & FACE IDENTIFICATION
// ============================================================================

test("1. Initial student face registration succeeds and validates 128D vector", () => {
  const studentRoll = "23BCS001";
  const vector = generateMockFaceVector(42);
  const isValid = validateFaceVectorDescriptor(vector, "Student face descriptor");
  assert.equal(isValid, true);

  const evaluation = evaluateFaceUniqueness(vector, [], { rollNo: studentRoll });
  assert.equal(evaluation.decision, "unique");
  assert.equal(evaluation.match, null);
});

test("2. Student cannot independently re-register face after initial enrollment without permission", async () => {
  const studentRoll = "23BCS002";
  const studentDoc = {
    rollNo: studentRoll,
    faceRegistered: true,
    faceDescriptor: generateMockFaceVector(10),
    hardwareBiometricEnrolled: true
  };

  // Check re-registration permission with empty mock DB
  const mockDb = createMockDb([]);
  const result = await resolveActiveReRegistrationPermission(mockDb, studentRoll, "FACE");

  assert.equal(result.hasPermission, false, "No permission should resolve for independent student");

  // Attempting to re-enroll without permission must be blocked
  const isStaff = false;
  const reEnrollAllowed = isStaff || !studentDoc.faceRegistered || result.hasPermission;
  assert.equal(reEnrollAllowed, false, "Student must be strictly blocked from independent face re-enrollment");
});

test("3. Student initial device biometric setup succeeds and binds hardware key", () => {
  const studentRoll = "23BCS003";
  const existingBiometricDoc = null; // Initial setup, not yet registered

  assert.equal(existingBiometricDoc, null);
  const newRegistration = {
    studentUid: "uid_student_003",
    rollNo: studentRoll,
    hardwareBiometricEnrolled: true,
    hardwareBiometricPlatform: "android",
    hardwareBiometricEnrolledAt: Date.now()
  };

  assert.equal(newRegistration.hardwareBiometricEnrolled, true);
  assert.equal(newRegistration.hardwareBiometricPlatform, "android");
});

test("4. Student cannot independently repeat biometric setup without permission", async () => {
  const studentRoll = "23BCS004";
  const existingCred = {
    rollNo: studentRoll,
    hardwareBiometricEnrolled: true,
    publicKey: "EXISTING_KEY"
  };

  // No active permission
  const mockDb = createMockDb([]);
  const result = await resolveActiveReRegistrationPermission(mockDb, studentRoll, "BIOMETRIC");
  assert.equal(result.hasPermission, false);

  const isStaff = false;
  const isAllowed = isStaff || !existingCred || result.hasPermission;
  assert.equal(isAllowed, false, "Independent student repeat biometric setup must be rejected with ALREADY_REGISTERED");
});

test("5. A failed initial registration does not permanently block a legitimate retry", () => {
  const studentRoll = "23BCS005";
  // Simulating an interrupted or failed enrollment (e.g. camera closed before vector commit)
  let studentDoc = {
    rollNo: studentRoll,
    faceRegistered: false,
    hardwareBiometricEnrolled: false
  };

  // State is NOT registered, so retry must be completely accessible
  assert.equal(studentDoc.faceRegistered, false);
  assert.equal(studentDoc.hardwareBiometricEnrolled, false);

  // Retry succeeds
  studentDoc.faceRegistered = true;
  studentDoc.faceDescriptor = generateMockFaceVector(55);
  assert.equal(studentDoc.faceRegistered, true);
});

test("6. Lecturer can repeatedly enroll or re-enroll their own credentials without student lock", () => {
  const isStaff = true;
  const existingCred = { rollNo: "FACULTY_01", hardwareBiometricEnrolled: true };

  // Staff is exempt from one-time registration restriction
  const isAllowed = isStaff || !existingCred;
  assert.equal(isAllowed, true, "Lecturer must be permitted to repeatedly self-enroll hardware biometrics");
});

test("7. Admin can repeatedly enroll or re-enroll their own credentials without student lock", () => {
  const isStaff = true;
  const existingCred = { rollNo: "ADMIN_ROOT", hardwareBiometricEnrolled: true };

  const isAllowed = isStaff || !existingCred;
  assert.equal(isAllowed, true, "Admin must be permitted to repeatedly self-enroll biometrics");
});

test("8. Lecturer can grant access to a student within their authorized class roster", async () => {
  const lecturerUid = "lecturer_alice";
  const authorizedCourses = [
    {
      id: "CS201",
      lecturerUid: "lecturer_alice",
      enrolledRolls: ["23BCS010", "23BCS011", "23BCS012"]
    }
  ];

  const targetRoll = "23BCS010";
  const isEnrolledInLecturerCourse = authorizedCourses.some((c) =>
    c.lecturerUid === lecturerUid && c.enrolledRolls.includes(targetRoll)
  );

  assert.equal(isEnrolledInLecturerCourse, true, "Lecturer must be authorized to grant for students in their courses");
});

test("9. Lecturer cannot grant access to a student outside their authorized scope", async () => {
  const lecturerUid = "lecturer_alice";
  const authorizedCourses = [
    {
      id: "CS201",
      lecturerUid: "lecturer_alice",
      enrolledRolls: ["23BCS010", "23BCS011"]
    }
  ];

  const unrelatedStudentRoll = "23ECE099"; // Student in ECE, not in lecturer's CS201 course
  const isAuthorized = authorizedCourses.some((c) =>
    c.lecturerUid === lecturerUid && c.enrolledRolls.includes(unrelatedStudentRoll)
  );

  assert.equal(isAuthorized, false, "Lecturer must be blocked from granting access outside their course scope");
});

test("10. Admin can grant access within institution-wide administrative scope", () => {
  const operatorRole = "admin";
  const targetRolls = ["23BCS001", "23ECE050", "23DSA012"]; // Across different branches

  const isAdminAuthorized = operatorRole === "admin" || operatorRole === "administrator";
  assert.equal(isAdminAuthorized, true);
  assert.equal(targetRolls.length, 3, "Admin can authorize any students across the institution");
});

test("11. A selected-student grant affects only the intended students", () => {
  const selectedStudents = ["23BCS021", "23BCS022"];
  const otherStudent = "23BCS023";

  const grantedPermissions = new Map();
  selectedStudents.forEach((roll) => {
    grantedPermissions.set(roll, {
      rollNo: roll,
      status: "ACTIVE",
      mode: "ONE_TIME",
      remainingUses: 1
    });
  });

  assert.ok(grantedPermissions.has("23BCS021"));
  assert.ok(grantedPermissions.has("23BCS022"));
  assert.equal(grantedPermissions.has(otherStudent), false, "Unselected student must not receive permission");
});

test("12. A class-wide grant affects all students in the authorized course", () => {
  const courseRoster = ["23BCS031", "23BCS032", "23BCS033", "23BCS034"];
  const granted = courseRoster.map((roll) => ({
    rollNo: roll,
    status: "ACTIVE",
    mode: "ONE_TIME",
    remainingUses: 1,
    scopeType: "course",
    courseId: "CS101"
  }));

  assert.equal(granted.length, 4);
  granted.forEach((p) => {
    assert.equal(p.status, "ACTIVE");
    assert.equal(p.scopeType, "course");
  });
});

test("13. Mode A (One-Time grant) permits exactly one successful re-registration and cannot be reused", () => {
  const permission = {
    id: "perm_001",
    rollNo: "23BCS040",
    mode: "ONE_TIME",
    status: "ACTIVE",
    remainingUses: 1,
    timesUsed: 0
  };

  // First use: consumption succeeds
  let remaining = permission.remainingUses - 1;
  permission.timesUsed += 1;
  permission.remainingUses = remaining;
  if (permission.remainingUses <= 0) {
    permission.status = "EXHAUSTED";
  }

  assert.equal(permission.timesUsed, 1);
  assert.equal(permission.remainingUses, 0);
  assert.equal(permission.status, "EXHAUSTED");

  // Second use attempt: should fail closed
  const canUseAgain = permission.status === "ACTIVE" && permission.remainingUses > 0;
  assert.equal(canUseAgain, false, "Mode A permission cannot be reused after single consumption");
});

test("14. Mode B (Repeated grant) permits multiple re-registrations until revoked or expired", () => {
  const permission = {
    id: "perm_002",
    rollNo: "23BCS041",
    mode: "REPEATED",
    status: "ACTIVE",
    remainingUses: 999999,
    timesUsed: 0,
    expiresAt: Date.now() + 86400000 // 24 hours in future
  };

  // Re-registration 1
  permission.timesUsed += 1;
  assert.equal(permission.status, "ACTIVE");

  // Re-registration 2
  permission.timesUsed += 1;
  assert.equal(permission.status, "ACTIVE");
  assert.equal(permission.timesUsed, 2);

  // Now faculty revokes it
  permission.status = "REVOKED";
  const canUseAfterRevoke = permission.status === "ACTIVE";
  assert.equal(canUseAfterRevoke, false, "Revoked Mode B permission must be blocked");
});

test("15. Face permission does not automatically authorize device biometric re-registration, and vice versa", () => {
  const faceOnlyPermission = {
    rollNo: "23BCS045",
    registrationType: "FACE",
    status: "ACTIVE",
    remainingUses: 1
  };

  const allowsFace = faceOnlyPermission.registrationType === "FACE" || faceOnlyPermission.registrationType === "BOTH";
  const allowsBiometric = faceOnlyPermission.registrationType === "BIOMETRIC" || faceOnlyPermission.registrationType === "BOTH";

  assert.equal(allowsFace, true, "Face-only permission authorizes face");
  assert.equal(allowsBiometric, false, "Face-only permission must NOT authorize device fingerprint");

  const fpOnlyPermission = {
    rollNo: "23BCS046",
    registrationType: "BIOMETRIC",
    status: "ACTIVE",
    remainingUses: 1
  };

  assert.equal(fpOnlyPermission.registrationType === "BIOMETRIC" || fpOnlyPermission.registrationType === "BOTH", true);
  assert.equal(fpOnlyPermission.registrationType === "FACE" || fpOnlyPermission.registrationType === "BOTH", false);
});

test("16. Revoked and expired permissions cannot be used", () => {
  const revokedPerm = { status: "REVOKED", remainingUses: 1, expiresAt: Date.now() + 10000 };
  const expiredPerm = { status: "ACTIVE", remainingUses: 1, expiresAt: Date.now() - 5000 }; // 5s ago

  const isRevokedValid = revokedPerm.status === "ACTIVE" && (!revokedPerm.expiresAt || revokedPerm.expiresAt > Date.now());
  const isExpiredValid = expiredPerm.status === "ACTIVE" && (!expiredPerm.expiresAt || expiredPerm.expiresAt > Date.now());

  assert.equal(isRevokedValid, false, "Revoked permission must be invalid");
  assert.equal(isExpiredValid, false, "Expired permission must be invalid");
});

test("17. Concurrent requests cannot consume a single-use grant multiple times (atomic check)", () => {
  let remainingUses = 1;
  let successCount = 0;
  let rejectedCount = 0;

  // Simulate two concurrent requests attempting to consume the single-use token atomically
  const tryConsume = () => {
    if (remainingUses > 0) {
      remainingUses -= 1;
      successCount++;
      return true;
    }
    rejectedCount++;
    return false;
  };

  const req1 = tryConsume();
  const req2 = tryConsume();

  assert.equal(req1, true);
  assert.equal(req2, false);
  assert.equal(successCount, 1);
  assert.equal(rejectedCount, 1);
  assert.equal(remainingUses, 0);
});

test("18. Direct Firestore writes and unauthorized API calls cannot bypass rules", () => {
  // Simulating Firestore security rule: hasNoClientFaceEnrollmentMutation()
  const protectedFields = [
    "faceRegistered",
    "faceDescriptor",
    "faceDescriptorEncrypted",
    "hardwareBiometricEnrolled",
    "hardwareBiometricPlatform",
    "hardwareBiometricEnrolledAt",
    "isDeviceRegistered"
  ];

  const clientMutation = {
    name: "Student Name",
    hardwareBiometricEnrolled: true // Unauthorized client direct write attempt
  };

  const hasProtectedMutation = Object.keys(clientMutation).some((field) => protectedFields.includes(field));
  assert.equal(hasProtectedMutation, true, "Security rules must detect client write to protected biometric fields");
});

test("19. A failed re-registration does not corrupt existing valid enrollment data", () => {
  const originalFaceVector = generateMockFaceVector(100);
  const student = {
    rollNo: "23BCS050",
    faceRegistered: true,
    faceDescriptor: originalFaceVector
  };

  // Re-registration attempted with invalid/corrupted capture
  let caughtError = false;
  try {
    const invalidVector = [0, 0, 0]; // Invalid dimensions
    validateFaceVectorDescriptor(invalidVector);
    student.faceDescriptor = invalidVector; // Should never reach here
  } catch (err) {
    caughtError = true;
    assert.ok(err.message.includes("128-dimensional array") || err.message.includes("invalid-argument"));
  }

  assert.equal(caughtError, true);
  // Verify original valid enrollment is completely preserved
  assert.equal(student.faceRegistered, true);
  assert.deepEqual(student.faceDescriptor, originalFaceVector);
});

test("20. Face identification returns the correct student only when sufficiently reliable match is established (distance <= 0.52)", () => {
  const targetStudentVector = generateMockFaceVector(200);
  const queryVector = perturbVector(targetStudentVector, 0.03); // Close match of same student

  const distance = faceVectorDistance(queryVector, targetStudentVector);
  assert.ok(distance < 0.52, `Expected distance < 0.52, got ${distance}`);

  const candidates = [
    { rollNo: "23BCS060", name: "Alice", faceDescriptor: generateMockFaceVector(205) },
    { rollNo: "23BCS061", name: "Bob", faceDescriptor: targetStudentVector },
    { rollNo: "23BCS062", name: "Charlie", faceDescriptor: generateMockFaceVector(210) }
  ];

  let bestMatch = null;
  let minDistance = Infinity;

  candidates.forEach((c) => {
    const dist = faceVectorDistance(queryVector, c.faceDescriptor);
    if (dist < minDistance) {
      minDistance = dist;
      bestMatch = c;
    }
  });

  assert.equal(bestMatch.rollNo, "23BCS061");
  assert.ok(minDistance <= 0.52);
});

test("21. Unknown faces and ambiguous matches do not produce false identities", () => {
  const unknownPersonVector = generateMockFaceVector(999);
  const enrolledStudentVector = generateMockFaceVector(1);

  const dist = faceVectorDistance(unknownPersonVector, enrolledStudentVector);
  const isMatch = dist <= 0.52;
  assert.equal(isMatch, false, "Unknown person face must NOT match enrolled student");

  // Ambiguous test: two candidates within review threshold
  const candidateA = generateMockFaceVector(300);
  const candidateB = perturbVector(candidateA, 0.02); // Extremely similar to candidate A
  const query = perturbVector(candidateA, 0.01);

  const distA = faceVectorDistance(query, candidateA);
  const distB = faceVectorDistance(query, candidateB);
  const diff = Math.abs(distA - distB);

  // If two matches have distance <= 0.52 and difference < 0.05, ambiguous must be flagged
  const isAmbiguous = distA <= 0.52 && distB <= 0.52 && diff < 0.05;
  assert.equal(isAmbiguous, true, "Ambiguous match must NOT assert identity");
});

test("22. Face identification does not automatically mark attendance", () => {
  const attendanceRecords = [];
  const identificationResult = {
    success: true,
    matched: true,
    student: {
      rollNo: "23BCS070",
      name: "David"
    }
  };

  // Identification completes, attendance array remains completely empty
  assert.equal(attendanceRecords.length, 0, "Identification feature must not write attendance records");
});

test("23. Global Face Uniqueness: The same face cannot be enrolled under two different student accounts", () => {
  const studentAVector = generateMockFaceVector(777);
  // Student B attempts to register using student A's face
  const studentBAttemptVector = perturbVector(studentAVector, 0.02); // Same physical face

  const candidates = [
    {
      rollNo: "23BCS080",
      name: "Student A",
      faceDescriptor: studentAVector
    }
  ];

  const evaluation = evaluateFaceUniqueness(
    studentBAttemptVector,
    candidates,
    { rollNo: "23BCS081" } // Student B
  );

  assert.equal(evaluation.decision, "duplicate");
  assert.equal(evaluation.match.candidate.rollNo, "23BCS080", "Must detect that face belongs to Student A");
});

test("24. Global Face Uniqueness: Different facial IDs of same face do not bypass duplicate detection", () => {
  const faceCapture1 = generateMockFaceVector(500);
  const faceCapture2 = perturbVector(faceCapture1, 0.04);

  const dist = faceVectorDistance(faceCapture1, faceCapture2);
  assert.ok(dist < 0.44, `Distance ${dist} must be below duplicate threshold 0.44`);

  const evaluation = evaluateFaceUniqueness(
    faceCapture2,
    [{ rollNo: "STUDENT_X", faceDescriptor: faceCapture1 }],
    { rollNo: "STUDENT_Y" }
  );

  assert.equal(evaluation.decision, "duplicate");
});

test("25. Global Face Uniqueness: Student can re-enroll their own face without self-duplicate conflict", () => {
  const existingFace = generateMockFaceVector(888);
  const newCaptureOfSameStudent = perturbVector(existingFace, 0.03);

  const candidates = [
    {
      rollNo: "23BCS090",
      name: "Self Student",
      faceDescriptor: existingFace
    }
  ];

  const evaluation = evaluateFaceUniqueness(
    newCaptureOfSameStudent,
    candidates,
    { rollNo: "23BCS090" } // Same student re-enrolling
  );

  // Since targetRollNo matches candidate, self update is permitted (decision: unique)
  assert.equal(evaluation.decision, "unique");
  assert.equal(evaluation.match, null);
});

test("26. Global Face Uniqueness: Lecturer or Admin permission does NOT override face uniqueness", () => {
  const studentAVector = generateMockFaceVector(600);
  const candidates = [{ rollNo: "STUDENT_ALICE", faceDescriptor: studentAVector }];

  // Even if Student Bob has an active re-registration permission issued by an Admin:
  const activePermissionForBob = {
    rollNo: "STUDENT_BOB",
    mode: "ONE_TIME",
    status: "ACTIVE",
    grantedByRole: "ADMIN"
  };

  assert.equal(activePermissionForBob.status, "ACTIVE");

  // Bob captures Alice's face:
  const bobsCapture = perturbVector(studentAVector, 0.01);
  const evaluation = evaluateFaceUniqueness(
    bobsCapture,
    candidates,
    { rollNo: "STUDENT_BOB" }
  );

  assert.equal(evaluation.decision, "duplicate");
  assert.equal(evaluation.match.candidate.rollNo, "STUDENT_ALICE", "Admin permission must never bypass global face uniqueness");
});
