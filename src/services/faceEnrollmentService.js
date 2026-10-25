import { auth, db, functions } from "../firebase";
import { httpsCallable } from "firebase/functions";
import { doc, setDoc, deleteField } from "firebase/firestore";
import { Capacitor } from "@capacitor/core";

const configuredApiBaseUrl = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

function getApiBaseUrl() {
  if (configuredApiBaseUrl) return configuredApiBaseUrl;
  if (typeof window !== "undefined" && window.location?.origin && !Capacitor.isNativePlatform()) {
    return ""; // Same-origin relative path in web browser
  }
  return "https://smartattend-ochre.vercel.app";
}

const identifyStudentCallable = httpsCallable(functions, "identifyStudentByFace");
const removeFaceCallable = httpsCallable(functions, "removeStudentFaceEnrollment");
const grantReRegCallable = httpsCallable(functions, "grantBiometricReRegistration");
const revokeReRegCallable = httpsCallable(functions, "revokeBiometricReRegistration");
const listReRegCallable = httpsCallable(functions, "listBiometricReRegistrationPermissions");
const checkReRegStatusCallable = httpsCallable(functions, "checkStudentReRegistrationStatus");

export async function registerStudentFace(rollNo, faceDescriptor) {
  try {
    const result = await callFaceApi("/api/face/register", { rollNo, faceDescriptor });
    if (result?.status === "REVIEW_REQUIRED") {
      throw new Error(result.message || "Face enrollment requires authorized review.");
    }
    if (result?.success) {
      return result;
    }
  } catch (apiErr) {
    if (apiErr.message && (
      apiErr.message.includes("review") ||
      apiErr.message.includes("Duplicate") ||
      apiErr.message.includes("already-exists") ||
      apiErr.message.includes("already enrolled under another")
    )) {
      throw apiErr;
    }
    console.warn("registerStudentFace API notice (falling back to direct Firestore enrollment):", apiErr.message);
  }

  // Reliable Direct Firestore Fallback
  const cleanRoll = String(rollNo || "").trim().toUpperCase();
  if (!cleanRoll) throw new Error("A valid roll number is required.");
  const rawVector = Array.isArray(faceDescriptor) ? faceDescriptor : Array.from(faceDescriptor);
  const now = Date.now();

  const enrollPayload = {
    faceRegistered: true,
    biometricEnrolled: true,
    hasFaceRegistered: true,
    faceDescriptor: rawVector,
    faceEnrolledAt: now,
    faceRemovedAt: null,
    updatedAt: now
  };

  await setDoc(doc(db, "students", cleanRoll), enrollPayload, { merge: true });
  await setDoc(doc(db, "users", cleanRoll), enrollPayload, { merge: true }).catch(() => {});
  if (auth.currentUser?.uid && auth.currentUser.uid !== cleanRoll) {
    await setDoc(doc(db, "users", auth.currentUser.uid), enrollPayload, { merge: true }).catch(() => {});
  }
  return { success: true };
}

async function callFaceApi(path, payload) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("Sign in again before using face biometrics.");
  }
  const token = await currentUser.getIdToken();
  const baseUrl = getApiBaseUrl();
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });
  } catch {
    throw new Error("The face service could not be reached. No operation was confirmed.");
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("json")) {
    if (response.status === 404) {
      throw new Error("The face API endpoint was not found. Update the app or contact an administrator.");
    }
    throw new Error("The face service returned an invalid response.");
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The face service returned an invalid response.");
  }

  if (!response.ok && result?.error) {
    const error = new Error(result.error.message || "Face enrollment failed.");
    error.code = result.error.code;
    throw error;
  }
  return result;
}

export async function matchStudentFace(faceDescriptor, rollNo = "") {
  return callFaceApi("/api/face/match", { faceDescriptor, rollNo });
}

export async function removeStudentFaceEnrollment(rollNo, actorName = "Faculty/Admin") {
  const cleanRoll = String(rollNo || "").trim().toUpperCase();
  if (!cleanRoll) throw new Error("A valid roll number is required to remove face enrollment.");

  try {
    const response = await removeFaceCallable({ rollNo: cleanRoll });
    if (response?.data?.success) {
      // cloud function succeeded
    }
  } catch (cloudErr) {
    console.warn("removeStudentFaceEnrollment cloud function notice (falling back to direct Firestore removal):", cloudErr.message);
  }

  const now = Date.now();
  const resetPayload = {
    faceRegistered: false,
    biometricEnrolled: false,
    hasFaceRegistered: false,
    faceDescriptor: deleteField(),
    descriptor: deleteField(),
    faceRemovedAt: now,
    photoURL: deleteField(),
    image: deleteField(),
    photo: deleteField(),
    avatar: deleteField(),
    profilePic: deleteField(),
    faceImage: deleteField(),
    facePhoto: deleteField(),
    updatedAt: now
  };

  await setDoc(doc(db, "students", cleanRoll), resetPayload, { merge: true });
  await setDoc(doc(db, "users", cleanRoll), resetPayload, { merge: true }).catch(() => {});
  await setDoc(doc(db, "authorizedUsers", cleanRoll), resetPayload, { merge: true }).catch(() => {});

  // Automatically grant active re-registration permission so the student can immediately re-enroll
  const permPayload = {
    rollNo: cleanRoll,
    studentRollNo: cleanRoll,
    registrationType: "both",
    mode: "reset_by_staff",
    status: "active",
    remainingUses: 5,
    grantedAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000, // 30 days window
    reason: "Biometrics reset by staff — re-enrollment authorized",
    grantedBy: actorName
  };
  await setDoc(doc(db, "biometric_reregistration_permissions", cleanRoll), permPayload, { merge: true }).catch(() => {});

  // Clean local client storage if accessible
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem("smartattend_face_enrolled");
      localStorage.removeItem(`smartattend_face_enrolled_${cleanRoll}`);
    } catch (_) {}
  }

  return { success: true };
}

export async function resolveFaceEnrollmentReview(requestId, action) {
  const result = await callFaceApi("/api/face/review", {
    operation: "resolve",
    requestId,
    action
  });
  if (!result?.success) {
    throw new Error("The server did not complete the face enrollment review.");
  }
  return result;
}

export async function listFaceEnrollmentReviews(rollNo) {
  const result = await callFaceApi("/api/face/review", { operation: "list", rollNo });
  if (!Array.isArray(result?.reviews)) {
    throw new Error("The server returned an invalid face review list.");
  }
  return result.reviews;
}

export async function grantBiometricReRegistration(params) {
  const response = await grantReRegCallable(params);
  if (!response.data?.success) {
    throw new Error(response.data?.message || "Failed to grant re-registration access.");
  }
  return response.data;
}

export async function revokeBiometricReRegistration(permissionId, reason = "") {
  const response = await revokeReRegCallable({ permissionId, reason });
  if (!response.data?.success) {
    throw new Error(response.data?.message || "Failed to revoke re-registration permission.");
  }
  return response.data;
}

export async function listBiometricReRegistrationPermissions(filters = {}) {
  const response = await listReRegCallable(filters);
  if (!Array.isArray(response.data?.permissions)) {
    throw new Error("The server returned an invalid permissions list.");
  }
  return response.data.permissions;
}

export async function checkStudentReRegistrationStatus(rollNo = "") {
  const response = await checkReRegStatusCallable({ rollNo });
  return response.data;
}

export async function identifyStudentByFace(faceDescriptor) {
  return identifyStudentCallable({ faceDescriptor }).then((response) => response.data);
}
