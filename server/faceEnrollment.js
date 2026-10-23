export const FACE_DUPLICATE_DISTANCE = 0.44;
export const FACE_REVIEW_DISTANCE = 0.60;
export const FACE_MATCH_DISTANCE = 0.52;

export class EnrollmentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function normalizeFaceVector(descriptor, fieldName = "Face descriptor") {
  let vector = descriptor;
  if (!Array.isArray(vector) && typeof vector === "object" && vector !== null) {
    const values = Object.values(vector);
    if (values.length === 128) vector = values;
  }

  if (!Array.isArray(vector) || vector.length !== 128) {
    throw new EnrollmentError(400, "invalid-argument", `${fieldName} must contain 128 values.`);
  }

  const normalized = vector.map(Number);
  if (normalized.some((value) => !Number.isFinite(value) || Math.abs(value) > 10)) {
    throw new EnrollmentError(400, "invalid-argument", `${fieldName} contains an invalid value.`);
  }

  const norm = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
  const mean = normalized.reduce((sum, value) => sum + value, 0) / 128;
  const variance = normalized.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 128;
  if (norm < 0.1 || Math.sqrt(variance) < 0.005) {
    throw new EnrollmentError(400, "invalid-argument", `${fieldName} is degenerate.`);
  }
  return normalized;
}

export function faceVectorDistance(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length !== 128 || second.length !== 128) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.sqrt(first.reduce((sum, value, index) => sum + (Number(value) - Number(second[index])) ** 2, 0));
}

function cleanIdentity(value = {}) {
  return {
    rollNo: String(value.rollNo || value.studentRollNo || "").trim().toUpperCase(),
    studentUid: String(value.studentUid || value.uid || value.userUid || "").trim()
  };
}

function sameIdentity(candidate, target) {
  const candidateIdentity = cleanIdentity(candidate);
  const targetIdentity = cleanIdentity(target);
  if (candidateIdentity.studentUid && targetIdentity.studentUid) {
    return candidateIdentity.studentUid === targetIdentity.studentUid;
  }
  return Boolean(
    (targetIdentity.rollNo && candidateIdentity.rollNo === targetIdentity.rollNo) ||
    (targetIdentity.studentUid && candidateIdentity.studentUid === targetIdentity.studentUid)
  );
}

function candidateFromSnapshot(snapshot, collectionName) {
  const data = snapshot.data() || {};
  const rollNo = data.rollNo ||
    (String(snapshot.id).includes("@") ? String(snapshot.id).split("@")[0] : snapshot.id);
  return {
    ...cleanIdentity({ ...data, rollNo }),
    faceDescriptor: data.faceDescriptor || data.descriptor || data.faceVector || data.embedding || null,
    faceRegistered: data.faceRegistered === true,
    status: data.status,
    collectionName,
    docId: snapshot.id
  };
}

export async function matchEnrolledFace(db, caller, input) {
  const liveVector = normalizeFaceVector(input?.faceDescriptor, "Live face descriptor");
  const targetRollNo = String(input?.rollNo || "").trim().toUpperCase();
  if (targetRollNo && targetRollNo.length > 64) {
    throw new EnrollmentError(400, "invalid-argument", "The target roll number is invalid.");
  }
  if (!targetRollNo && !caller.isStaff) {
    throw new EnrollmentError(403, "permission-denied", "Only authorized staff can identify a student from a face scan.");
  }

  let targetIdentity = null;
  let targetStudentData = null;
  if (targetRollNo) {
    const targetSnapshot = await db.collection("students").doc(targetRollNo).get();
    if (!targetSnapshot.exists) {
      throw new EnrollmentError(404, "not-found", "The target student record could not be verified.");
    }
    targetStudentData = targetSnapshot.data() || {};
    const linkedUid = String(targetStudentData.studentUid || targetStudentData.uid || targetStudentData.userUid || "").trim();
    const email = String(targetStudentData.email || "").trim().toLowerCase();
    const callerRoll = caller.emailPrefix.trim().toUpperCase();
    const ownsStudent = linkedUid
      ? linkedUid === caller.uid
      : email === caller.email || callerRoll === targetRollNo;
    if (!caller.isStaff && !ownsStudent) {
      throw new EnrollmentError(403, "permission-denied", "You can only verify your own student face.");
    }
    targetIdentity = {
      rollNo: targetRollNo,
      studentUid: linkedUid || (!caller.isStaff ? caller.uid : "")
    };
  }

  const [enrollments, legacyStudents, legacyUsers, legacyAuthorizedUsers] = targetRollNo
    ? await Promise.all([
      db.collection("face_enrollments").doc(targetRollNo).get(),
      db.collection("students").doc(targetRollNo).get(),
      targetIdentity.studentUid
        ? db.collection("users").doc(targetIdentity.studentUid).get()
        : db.collection("users").where("rollNo", "==", targetRollNo).get(),
      targetStudentData.email
        ? db.collection("authorizedUsers").where("email", "==", String(targetStudentData.email).toLowerCase()).get()
        : db.collection("authorizedUsers").where("rollNo", "==", targetRollNo).get()
    ])
    : await Promise.all([
      db.collection("face_enrollments").get(),
      db.collection("students").get(),
      db.collection("users").get(),
      db.collection("authorizedUsers").get()
    ]);

  const snapshots = [enrollments, legacyStudents, legacyUsers, legacyAuthorizedUsers];
  const candidateMap = new Map();
  for (const snapshot of snapshots) {
    const docs = Array.isArray(snapshot.docs) ? snapshot.docs : (snapshot.exists ? [snapshot] : []);
    for (const docSnapshot of docs) {
      const candidate = candidateFromSnapshot(docSnapshot, docSnapshot.ref.parent.id);
      if (!candidate.rollNo) continue;
      const key = candidate.studentUid || candidate.rollNo || candidate.docId;
      const existing = candidateMap.get(key);
      if (!existing || (candidate.faceDescriptor && !existing.faceDescriptor)) {
        candidateMap.set(key, candidate);
      }
    }
  }

  const matches = [];
  for (const candidate of candidateMap.values()) {
    if (targetIdentity && !sameIdentity(candidate, targetIdentity)) continue;
    if (!candidate.faceDescriptor) continue;
    try {
      const storedVector = normalizeFaceVector(candidate.faceDescriptor, "Stored face descriptor");
      matches.push({ candidate, distance: faceVectorDistance(liveVector, storedVector) });
    } catch {
      continue;
    }
  }
  matches.sort((left, right) => left.distance - right.distance);

  const best = matches[0];
  if (!best) {
    return {
      status: "UNREGISTERED",
      matched: false,
      message: "No enrolled student face was available to compare."
    };
  }
  if (best.distance > FACE_REVIEW_DISTANCE) {
    return {
      status: "NO_MATCH",
      matched: false,
      distance: best.distance,
      message: "No enrolled student face matched this scan."
    };
  }
  if (best.distance > FACE_MATCH_DISTANCE ||
    (matches[1] && matches[1].distance - best.distance < 0.08)) {
    return {
      status: "REVIEW_REQUIRED",
      matched: false,
      ambiguous: true,
      distance: best.distance,
      message: "The face match is uncertain. Verify the student's identity manually."
    };
  }

  const studentSnapshot = await db.collection("students").doc(best.candidate.rollNo).get();
  const studentData = studentSnapshot.exists ? studentSnapshot.data() || {} : {};
  return {
    status: "MATCH",
    matched: true,
    distance: best.distance,
    confidence: Math.max(0, Math.min(100, Math.round((1 - best.distance / FACE_MATCH_DISTANCE) * 100))),
    student: {
      rollNo: best.candidate.rollNo,
      name: studentData.name || studentData.fullName || "",
      email: studentData.email || "",
      branch: studentData.branch || studentData.department || "",
      semester: studentData.semester || "",
      section: studentData.section || "",
      photoURL: typeof studentData.photoURL === "string" ? studentData.photoURL : ""
    }
  };
}

export function evaluateFaceUniqueness(newVector, candidates, targetIdentity) {
  const matches = [];
  let unreadableEnrollment = false;
  const readableCandidates = new Map();
  const readableIdentityKeys = new Set();

  for (const candidate of candidates) {
    const rawVector = candidate?.faceDescriptor;
    if (!rawVector) continue;
    try {
      const vector = normalizeFaceVector(rawVector, "Stored face descriptor");
      readableCandidates.set(candidate, vector);
      const identity = cleanIdentity(candidate);
      if (identity.rollNo) readableIdentityKeys.add(`roll:${identity.rollNo}`);
      if (identity.studentUid) readableIdentityKeys.add(`uid:${identity.studentUid}`);
    } catch {
      // An unreadable enrolled template is handled conservatively below.
    }
  }

  for (const candidate of candidates) {
    if (!candidate || sameIdentity(candidate, targetIdentity)) continue;
    const identity = cleanIdentity(candidate);
    const keys = [
      identity.rollNo ? `roll:${identity.rollNo}` : "",
      identity.studentUid ? `uid:${identity.studentUid}` : ""
    ].filter(Boolean);
    if (!candidate.faceDescriptor) {
      if ((candidate.faceRegistered || candidate.status === "PENDING") &&
        !keys.some((key) => readableIdentityKeys.has(key))) {
        unreadableEnrollment = true;
      }
      continue;
    }

    const vector = readableCandidates.get(candidate);
    if (!vector) {
      if (!keys.some((key) => readableIdentityKeys.has(key))) unreadableEnrollment = true;
      continue;
    }
    matches.push({ candidate, distance: faceVectorDistance(newVector, vector) });
  }

  matches.sort((left, right) => left.distance - right.distance);
  const duplicate = matches.find((match) => match.distance <= FACE_DUPLICATE_DISTANCE);
  if (duplicate) return { decision: "duplicate", match: duplicate };

  const uncertain = matches.find((match) => match.distance <= FACE_REVIEW_DISTANCE);
  if (unreadableEnrollment || uncertain) {
    return { decision: "review", match: uncertain || null };
  }
  return { decision: "unique", match: null };
}

export async function resolveCaller(db, decodedToken) {
  const uid = decodedToken.uid;
  const email = String(decodedToken.email || "").trim().toLowerCase();
  const emailPrefix = email.split("@")[0] || "";
  const lookupIds = [...new Set([uid, email, emailPrefix].filter(Boolean))];
  const [userSnap, adminSnaps, lecturerSnaps, authorizedSnaps] = await Promise.all([
    db.collection("users").doc(uid).get(),
    Promise.all(lookupIds.map((id) => db.collection("admins").doc(id).get())),
    Promise.all(lookupIds.map((id) => db.collection("lecturers").doc(id).get())),
    Promise.all(lookupIds.map((id) => db.collection("authorizedUsers").doc(id).get()))
  ]);

  const adminSnap = adminSnaps.find((snapshot) => snapshot.exists);
  const lecturerSnap = lecturerSnaps.find((snapshot) => snapshot.exists);
  const roleDocs = [userSnap, ...authorizedSnaps].filter((snapshot) => snapshot.exists);
  const roleData = roleDocs.map((snapshot) => snapshot.data() || {});
  const isAdmin = decodedToken.admin === true || Boolean(adminSnap) ||
    roleData.some((data) => ["admin", "administrator", "superadmin"].includes(
      String(data.role || data.designation || "").trim().toLowerCase()
    ) || data.isAdmin === true);
  const isLecturer = Boolean(lecturerSnap) || roleData.some((data) =>
    ["lecturer", "faculty", "professor"].includes(
      String(data.role || data.designation || "").trim().toLowerCase()
    )
  );

  return {
    uid,
    email,
    isStaff: isAdmin || isLecturer,
    isAdmin,
    profile: roleData.at(0) || {},
    emailPrefix
  };
}

export async function registerFaceEnrollment(db, admin, caller, input) {
  const rollNo = String(input?.rollNo || "").trim().toUpperCase();
  if (!rollNo || rollNo.length > 64) {
    throw new EnrollmentError(400, "invalid-argument", "A valid student roll number is required.");
  }

  const vector = normalizeFaceVector(input?.faceDescriptor);
  const studentRef = db.collection("students").doc(rollNo);
  const studentSnapshot = await studentRef.get();
  const studentData = studentSnapshot.exists ? studentSnapshot.data() || {} : {};
  const linkedUid = String(studentData.studentUid || studentData.uid || studentData.userUid || "").trim();
  const studentEmail = String(studentData.email || "").trim().toLowerCase();
  const callerRoll = caller.emailPrefix.trim().toUpperCase();
  const isStaffSelf = caller.isStaff && !studentSnapshot.exists && (
    (await db.collection("users").doc(caller.uid).get()).exists ||
    rollNo === callerRoll ||
    rollNo === caller.uid.toUpperCase()
  );

  if (!studentSnapshot.exists && !isStaffSelf) {
    throw new EnrollmentError(404, "not-found", "The target student record could not be verified.");
  }

  const ownsStudent = linkedUid
    ? linkedUid === caller.uid
    : Boolean((studentEmail && studentEmail === caller.email) || callerRoll === rollNo);
  if (!caller.isStaff && !ownsStudent) {
    throw new EnrollmentError(403, "permission-denied", "You can only enroll your own face.");
  }

  const targetIdentity = {
    rollNo,
    studentUid: linkedUid || (!caller.isStaff ? caller.uid : "")
  };
  const enrollmentRef = db.collection("face_enrollments").doc(rollNo);
  const guardRef = db.collection("face_enrollment_control").doc("global");
  const reviewRef = db.collection("face_enrollment_reviews").doc();
  let permissionUsed = false;
  const result = await db.runTransaction(async (transaction) => {
    const [guardSnap, targetSnap, enrollmentSnap, enrollments, reviews, students, users, authorizedUsers] =
      await Promise.all([
        transaction.get(guardRef),
        studentSnapshot.exists ? transaction.get(studentRef) : Promise.resolve({ exists: true }),
        transaction.get(enrollmentRef),
        transaction.get(db.collection("face_enrollments")),
        transaction.get(db.collection("face_enrollment_reviews").where("status", "==", "PENDING")),
        transaction.get(db.collection("students")),
        transaction.get(db.collection("users")),
        transaction.get(db.collection("authorizedUsers"))
      ]);

    if (!targetSnap.exists && !isStaffSelf) {
      throw new EnrollmentError(404, "not-found", "The target student record could not be verified.");
    }

    const candidateSnapshots = [
      ...enrollments.docs.map((snapshot) => candidateFromSnapshot(snapshot, "face_enrollments")),
      ...reviews.docs.map((snapshot) => candidateFromSnapshot(snapshot, "face_enrollment_reviews")),
      ...students.docs.map((snapshot) => candidateFromSnapshot(snapshot, "students")),
      ...users.docs.map((snapshot) => candidateFromSnapshot(snapshot, "users")),
      ...authorizedUsers.docs.map((snapshot) => candidateFromSnapshot(snapshot, "authorizedUsers"))
    ];
    const uniqueness = evaluateFaceUniqueness(vector, candidateSnapshots, targetIdentity);
    const hasExistingEnrollment = enrollmentSnap.exists || candidateSnapshots.some((candidate) =>
      sameIdentity(candidate, targetIdentity) &&
      (candidate.faceRegistered || candidate.status === "ACTIVE" || candidate.faceDescriptor)
    );

    let activePermission = null;
    if (!caller.isStaff && hasExistingEnrollment) {
      const permissionQuery = db.collection("biometric_reregistration_permissions")
        .where("targetRollNo", "==", rollNo)
        .where("status", "==", "ACTIVE");
      const permissionSnapshots = await transaction.get(permissionQuery);
      const now = Date.now();
      activePermission = permissionSnapshots.docs.find((snapshot) => {
        const data = snapshot.data() || {};
        const type = String(data.registrationType || "").toUpperCase();
        const expiresAt = data.expiresAt?.toMillis?.() ?? new Date(data.expiresAt || 0).getTime();
        const remaining = Number(data.remainingUses ?? 1);
        return (type === "FACE" || type === "BOTH") &&
          (!expiresAt || expiresAt > now) &&
          (String(data.mode || "ONE_TIME").toUpperCase() !== "ONE_TIME" || remaining > 0);
      }) || null;
      if (!activePermission) {
        throw new EnrollmentError(
          409,
          "failed-precondition",
          "Face biometrics are already enrolled. Ask an authorized lecturer or administrator for re-registration access."
        );
      }
    }

    const writeReview = (reason, match) => {
      transaction.set(reviewRef, {
        rollNo,
        studentUid: targetIdentity.studentUid || null,
        requestedBy: caller.uid,
        status: "PENDING",
        reason,
        faceDescriptor: vector,
        candidateRollNo: match?.candidate?.rollNo || null,
        distance: Number.isFinite(match?.distance) ? match.distance : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      transaction.set(guardRef, {
        revision: Number(guardSnap.data()?.revision || 0) + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return {
        success: false,
        status: "REVIEW_REQUIRED",
        message: "This face needs authorized identity review before enrollment. No enrollment was confirmed."
      };
    };

    if (uniqueness.decision === "duplicate") {
      throw new EnrollmentError(
        409,
        "already-exists",
        "This face matches an enrollment belonging to another student. Existing enrollments were not changed."
      );
    }
    if (uniqueness.decision === "review") {
      return writeReview("FACE_MATCH_AMBIGUOUS", uniqueness.match);
    }

    const fieldValue = admin.firestore.FieldValue;
    const publicFaceFields = Object.fromEntries([
      "faceDescriptor", "faceDescriptors", "descriptor", "descriptors",
      "faceVector", "faceVectors", "embedding", "embeddings"
    ].map((field) => [field, fieldValue.delete()]));
    const metadata = {
      rollNo,
      faceRegistered: true,
      biometricEnrolled: true,
      hasFaceRegistered: true,
      faceEnrolledAt: fieldValue.serverTimestamp(),
      faceRemovedAt: fieldValue.delete(),
      ...publicFaceFields,
      ...(targetIdentity.studentUid ? { studentUid: targetIdentity.studentUid } : {})
    };

    transaction.set(enrollmentRef, {
      ...targetIdentity,
      faceDescriptor: vector,
      status: "ACTIVE",
      updatedAt: fieldValue.serverTimestamp()
    });
    if (studentSnapshot.exists) {
      transaction.set(studentRef, metadata, { merge: true });
    } else {
      transaction.set(db.collection("users").doc(caller.uid), metadata, { merge: true });
    }

    if (activePermission) {
      const data = activePermission.data() || {};
      const mode = String(data.mode || "ONE_TIME").toUpperCase();
      const usedCount = Number(data.usedCount || 0) + 1;
      const remaining = Number(data.remainingUses ?? 1) - 1;
      transaction.update(activePermission.ref, {
        usedCount,
        lastUsedAt: fieldValue.serverTimestamp(),
        ...(mode === "ONE_TIME" ? {
          remainingUses: Math.max(0, remaining),
          status: remaining <= 0 ? "EXHAUSTED" : "ACTIVE",
          consumedAt: remaining <= 0 ? fieldValue.serverTimestamp() : null
        } : {})
      });
      permissionUsed = true;
    }

    const staffSelfUserPath = studentSnapshot.exists
      ? ""
      : db.collection("users").doc(caller.uid).path;
    const legacySnapshots = [...students.docs, ...users.docs, ...authorizedUsers.docs];
    for (const snapshot of legacySnapshots) {
      if (sameIdentity(candidateFromSnapshot(snapshot, snapshot.ref.parent.id), targetIdentity) &&
        snapshot.ref.path !== studentRef.path &&
        snapshot.ref.path !== staffSelfUserPath) {
        transaction.update(snapshot.ref, {
          ...publicFaceFields,
          faceRegistered: true,
          biometricEnrolled: true,
          hasFaceRegistered: true,
          faceEnrolledAt: fieldValue.serverTimestamp(),
          faceRemovedAt: fieldValue.delete()
        });
      }
    }
    transaction.set(guardRef, {
      revision: Number(guardSnap.data()?.revision || 0) + 1,
      updatedAt: fieldValue.serverTimestamp()
    }, { merge: true });
    return { success: true, status: "ENROLLED", rollNo };
  });

  if (result.success) {
    await db.collection("biometric_audit_logs").add({
      action: permissionUsed ? "FACE_RE_REGISTRATION" : (caller.isStaff ? "STAFF_FACE_ENROLLMENT" : "INITIAL_FACE_ENROLLMENT"),
      rollNo,
      enrolledBy: caller.uid,
      isStaff: caller.isStaff,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  }
  return result;
}
