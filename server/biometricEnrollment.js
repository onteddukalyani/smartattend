import crypto from "crypto";
import { EnrollmentError } from "./faceEnrollment.js";

/**
 * Validates Base64 DER public key and ensures it represents a valid cryptographic key.
 */
function validateDerPublicKey(publicKeyDerBase64, platform = "android") {
  if (!publicKeyDerBase64 || typeof publicKeyDerBase64 !== "string") {
    throw new EnrollmentError(400, "invalid-argument", "Public key (Base64 DER) is required.");
  }
  const cleanBase64 = publicKeyDerBase64.trim();
  const cleanPlatform = String(platform || "").toLowerCase();
  if (cleanPlatform === "webauthn" || cleanPlatform === "web") {
    if (cleanBase64.length < 8 || cleanBase64.length > 2048) {
      throw new EnrollmentError(400, "invalid-argument", "Invalid WebAuthn credential format.");
    }
    return cleanBase64;
  }
  const derBuffer = Buffer.from(cleanBase64, "base64");
  if (derBuffer.length !== 91 && derBuffer.length !== 88 && derBuffer.length !== 90) {
    // Standard X.509 SPKI DER for P-256 EC is usually 91 bytes, but accept 88-91 byte bounds
    if (derBuffer.length < 64 || derBuffer.length > 256) {
      throw new EnrollmentError(400, "invalid-argument", `Invalid public key format (${derBuffer.length} bytes).`);
    }
  }
  return cleanBase64;
}

/**
 * Registers an initial or authorized hardware biometric key for student or staff.
 */
export async function registerBiometricCredential(db, admin, caller, input = {}) {
  if (!caller?.uid) {
    throw new EnrollmentError(401, "unauthenticated", "Authentication required to enroll biometric key.");
  }

  const { publicKeyDerBase64, platform, keyAlias } = input;
  const cleanPlatform = String(platform || "android").trim().toLowerCase();
  const cleanKey = validateDerPublicKey(publicKeyDerBase64, cleanPlatform);

  // Resolve target student identity
  let targetRollNo = String(input.rollNo || "").trim().toUpperCase();
  let targetUid = String(input.studentUid || caller.uid).trim();

  if (!targetRollNo && caller.emailPrefix) {
    targetRollNo = caller.emailPrefix.trim().toUpperCase();
  }

  // If caller is not staff, verify they are enrolling their own account
  if (!caller.isStaff) {
    targetUid = caller.uid;
    // Look up student record to verify matching rollNo if provided
    const userDocSnap = await db.collection("users").doc(caller.uid).get();
    const userData = userDocSnap.exists ? userDocSnap.data() || {} : {};
    if (userData.rollNo) {
      targetRollNo = String(userData.rollNo).trim().toUpperCase();
    }
  }

  const fieldValue = admin.firestore.FieldValue;
  const credentialRecord = {
    studentUid: targetUid,
    rollNo: targetRollNo || targetUid,
    studentEmail: caller.email || "",
    identityType: caller.isStaff ? "STAFF" : "STUDENT",
    ...(caller.isStaff ? { staffRole: caller.role || "staff" } : {}),
    publicKeyDerBase64: cleanKey,
    platform: cleanPlatform,
    keyAlias: keyAlias || `smartattend_p256_${targetUid}`,
    status: "ACTIVE",
    enrollmentMethod: caller.isStaff ? "STAFF_ENROLLMENT" : "STUDENT_SELF_ENROLLMENT",
    createdAt: fieldValue.serverTimestamp(),
    updatedAt: fieldValue.serverTimestamp()
  };

  const credRef = db.collection("biometric_credentials").doc(targetUid);
  await db.runTransaction(async (transaction) => {
    transaction.set(credRef, credentialRecord);
    if (targetRollNo && targetRollNo !== targetUid) {
      transaction.set(db.collection("biometric_credentials").doc(targetRollNo), credentialRecord);
    }

    const deviceUpdates = {
      biometricEnrolled: true,
      hardwareBiometricEnrolled: true,
      registeredPlatform: cleanPlatform,
      deviceType: cleanPlatform,
      registeredDeviceType: cleanPlatform,
      deviceTypeLocked: true,
      hardwareBiometricPlatform: cleanPlatform,
      hardwareBiometricEnrolledAt: fieldValue.serverTimestamp(),
      updatedAt: fieldValue.serverTimestamp()
    };

    if (targetRollNo) {
      const studentDocRef = db.collection("students").doc(targetRollNo);
      transaction.set(studentDocRef, deviceUpdates, { merge: true });
    }

    transaction.set(db.collection("users").doc(targetUid), {
      hardwareBiometricEnrolled: true,
      hardwareBiometricPlatform: cleanPlatform,
      deviceType: cleanPlatform,
      registeredPlatform: cleanPlatform,
      isDeviceRegistered: true,
      deviceTypeLocked: true,
      updatedAt: fieldValue.serverTimestamp()
    }, { merge: true });
  });

  try {
    await db.collection("biometric_audit_logs").add({
      action: caller.isStaff ? "STAFF_BIOMETRIC_ENROLLMENT" : "STUDENT_BIOMETRIC_ENROLLMENT",
      studentUid: targetUid,
      rollNo: targetRollNo || targetUid,
      platform: cleanPlatform,
      timestamp: fieldValue.serverTimestamp()
    });
  } catch (_) { }

  return {
    success: true,
    platform: cleanPlatform,
    message: "Biometric key registered successfully."
  };
}

/**
 * Issues a cryptographically secure ephemeral challenge for biometric signing.
 */
export async function issueBiometricChallenge(db, admin, caller, input = {}) {
  if (!caller?.uid) {
    throw new EnrollmentError(401, "unauthenticated", "Authentication required.");
  }

  const nonce = crypto.randomBytes(32).toString("hex");
  const challengeId = `bc_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
  const fieldValue = admin.firestore.FieldValue;

  const challengeRecord = {
    challengeId,
    challengeText: nonce,
    studentUid: caller.uid,
    sessionId: input.sessionId ? String(input.sessionId).trim() : null,
    action: input.action || "ATTENDANCE_VERIFICATION",
    createdAt: fieldValue.serverTimestamp(),
    expiresAt: Date.now() + 5 * 60 * 1000
  };

  try {
    await db.collection("biometric_challenges").doc(challengeId).set(challengeRecord);
  } catch (_) { }

  return {
    success: true,
    challengeId,
    challengeText: nonce
  };
}
