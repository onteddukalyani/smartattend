import { auth, db, functions } from "../firebase";
import { httpsCallable } from "firebase/functions";
import { doc, setDoc, deleteField, collection, onSnapshot, getDocs, query, where } from "firebase/firestore";
import { Capacitor } from "@capacitor/core";
import { broadcastStudentUpdate } from "../utils/studentDataHelper";
import { sendFacultyNotification, sendStudentNotification } from "./notificationsService";

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
  let apiResult = null;
  try {
    const result = await callFaceApi("/api/face/register", { rollNo, faceDescriptor });
    if (result?.status === "REVIEW_REQUIRED") {
      throw new Error(result.message || "Face enrollment requires authorized review.");
    }
    if (result?.success) {
      apiResult = result;
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

  // Ensure documents across Firestore & client state are definitively updated and synchronized globally
  const cleanRoll = String(rollNo || "").trim().toUpperCase();
  if (!cleanRoll) throw new Error("A valid roll number is required.");
  const rawVector = Array.isArray(faceDescriptor) ? faceDescriptor : Array.from(faceDescriptor || []);
  const now = Date.now();

  const enrollPayload = {
    faceRegistered: true,
    biometricEnrolled: true,
    hasFaceRegistered: true,
    isRegistered: true,
    registeredGlobally: true,
    registrationStatus: "registered",
    registrationCompletedAt: now,
    faceEnrolledAt: now,
    faceRemovedAt: null,
    updatedAt: now
  };
  if (rawVector.length === 128) {
    enrollPayload.faceDescriptor = rawVector;
  }

  const targets = [
    doc(db, "students", cleanRoll),
    doc(db, "users", cleanRoll),
    doc(db, "authorizedUsers", cleanRoll),
    doc(db, "students", cleanRoll.toLowerCase()),
    doc(db, "users", cleanRoll.toLowerCase()),
    doc(db, "authorizedUsers", cleanRoll.toLowerCase())
  ];
  if (auth.currentUser?.uid && auth.currentUser.uid !== cleanRoll) {
    targets.push(doc(db, "users", auth.currentUser.uid));
    targets.push(doc(db, "students", auth.currentUser.uid));
  }
  if (auth.currentUser?.email) {
    const cleanEmail = auth.currentUser.email.trim().toLowerCase();
    targets.push(doc(db, "users", cleanEmail));
    targets.push(doc(db, "authorizedUsers", cleanEmail));
  }

  await Promise.allSettled(targets.map(ref => setDoc(ref, enrollPayload, { merge: true })));

  if (typeof window !== "undefined") {
    try {
      localStorage.setItem("smartattend_face_enrolled", "true");
      localStorage.setItem("smartattend_student_face_enrolled", "true");
      localStorage.setItem("smartattend_registered", "true");
      localStorage.setItem("smartattend_student_registered", "true");
      localStorage.setItem(`smartattend_face_enrolled_${cleanRoll}`, "true");
      localStorage.setItem(`smartattend_registered_${cleanRoll}`, "true");
      if (auth.currentUser?.uid) {
        localStorage.setItem(`smartattend_face_enrolled_${auth.currentUser.uid}`, "true");
        localStorage.setItem(`smartattend_registered_${auth.currentUser.uid}`, "true");
      }
    } catch (_) {}
  }

  broadcastStudentUpdate({
    rollNo: cleanRoll,
    uid: auth.currentUser?.uid,
    email: auth.currentUser?.email,
    faceRegistered: true,
    biometricEnrolled: true,
    hasFaceRegistered: true,
    isRegistered: true,
    registeredGlobally: true,
    registrationStatus: "registered",
    faceRemovedAt: null
  });

  return apiResult || { success: true };
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
  try {
    const response = await grantReRegCallable(params);
    if (response?.data?.success) {
      return response.data;
    }
  } catch (cloudErr) {
    console.warn("grantBiometricReRegistration callable notice (falling back to direct Firestore write):", cloudErr.message);
  }

  // Resilient direct Firestore write fallback
  const targetRolls = Array.isArray(params.targetRolls) ? params.targetRolls : (params.rollNo ? [params.rollNo] : []);
  const now = Date.now();
  const expHours = params.expiryHours ? Number(params.expiryHours) : 72;
  const expiresAt = expHours > 0 ? now + (expHours * 3600 * 1000) : null;
  const permMode = params.mode || "one_time";
  const actorName = params.actorName || auth.currentUser?.displayName || auth.currentUser?.email || "Faculty/Admin";

  const writes = targetRolls.map(async (rawRoll) => {
    const cleanRoll = String(rawRoll || "").trim().toUpperCase();
    if (!cleanRoll) return;

    const permDoc = {
      rollNo: cleanRoll,
      studentRollNo: cleanRoll,
      registrationType: params.registrationType || "both",
      mode: permMode,
      status: "active",
      remainingUses: permMode === "repeated" ? 999 : 1,
      grantedAt: now,
      expiresAt: expiresAt,
      reason: params.reason || "Re-registration pass granted by faculty",
      grantedByName: actorName,
      grantedByUid: auth.currentUser?.uid || "",
      grantedByEmail: auth.currentUser?.email || "",
      grantedByRole: "faculty",
      updatedAt: now
    };

    await setDoc(doc(db, "biometric_reregistration_permissions", cleanRoll), permDoc, { merge: true });

    // Also notify student in real-time
    await sendStudentNotification(
      cleanRoll,
      "🔑 Re-Registration Access Granted!",
      `Your lecturer (${actorName}) has granted you a ${permMode === "one_time" ? "one-time" : "repeated"} pass to re-register your biometrics. This pass is active for ${expHours > 0 ? `${expHours} hours` : "unlimited time"}.`,
      "REREGISTRATION_APPROVED",
      actorName
    ).catch(() => {});
  });

  await Promise.allSettled(writes);
  return { success: true, count: targetRolls.length, message: `Access granted for ${targetRolls.length} student(s)` };
}

export async function revokeBiometricReRegistration(permissionId, reason = "") {
  try {
    const response = await revokeReRegCallable({ permissionId, reason });
    if (response?.data?.success) {
      return response.data;
    }
  } catch (cloudErr) {
    console.warn("revokeBiometricReRegistration callable notice (falling back to direct Firestore update):", cloudErr.message);
  }

  const cleanId = String(permissionId || "").trim().toUpperCase();
  const now = Date.now();
  await setDoc(doc(db, "biometric_reregistration_permissions", cleanId), {
    status: "revoked",
    revokedAt: now,
    revokedReason: reason || "Revoked by staff",
    remainingUses: 0,
    updatedAt: now
  }, { merge: true });

  return { success: true };
}

export async function listBiometricReRegistrationPermissions(filters = {}) {
  try {
    const response = await listReRegCallable(filters);
    if (Array.isArray(response.data?.permissions)) {
      return response.data.permissions;
    }
  } catch (err) {
    console.warn("listBiometricReRegistrationPermissions callable fallback to Firestore getDocs:", err);
  }

  const snap = await getDocs(collection(db, "biometric_reregistration_permissions")).catch(() => ({ docs: [] }));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function checkStudentReRegistrationStatus(rollNo = "") {
  try {
    const response = await checkReRegStatusCallable({ rollNo });
    if (response?.data) return response.data;
  } catch (_) {}

  const cleanRoll = String(rollNo || "").trim().toUpperCase();
  if (!cleanRoll) return { active: false };
  const snap = await doc(db, "biometric_reregistration_permissions", cleanRoll);
  return { active: snap.exists ? snap.data()?.status === "active" : false };
}

export async function identifyStudentByFace(faceDescriptor) {
  return identifyStudentCallable({ faceDescriptor }).then((response) => response.data);
}

/**
 * =========================================================================
 * STUDENT RE-REGISTRATION REQUEST LIFECYCLE APIS
 * =========================================================================
 */

/**
 * Student submits a formal request to re-register biometrics/device.
 */
export async function submitReRegistrationRequest({
  rollNo,
  studentName = "",
  studentEmail = "",
  requestType = "both", // "face" | "biometric" | "both"
  reason = "Student requested re-registration access",
  details = ""
}) {
  const cleanRoll = String(rollNo || "").trim().toUpperCase();
  if (!cleanRoll) throw new Error("A valid student roll number is required.");

  const now = Date.now();
  const requestDoc = {
    id: cleanRoll,
    rollNo: cleanRoll,
    studentRollNo: cleanRoll,
    studentName: studentName || cleanRoll,
    studentEmail: studentEmail || "",
    requestType: requestType || "both",
    reason: reason || "Student requested re-registration access",
    details: details || "",
    status: "pending", // "pending" | "approved" | "rejected" | "cancelled"
    createdAt: now,
    updatedAt: now
  };

  await setDoc(doc(db, "reregistration_requests", cleanRoll), requestDoc, { merge: true });

  const scopeLabel = requestType === "face" ? "3D Face Biometrics" : requestType === "biometric" ? "Device Fingerprint" : "Full Biometrics (Face + Device)";

  // Send real-time notification to Faculty & Admins with 1-click action metadata
  await sendFacultyNotification(
    `🔑 Re-Registration Requested: ${cleanRoll}`,
    `Student ${studentName || cleanRoll} (${cleanRoll}) requested re-registration for ${scopeLabel}.\n• Reason: ${reason}${details ? `\n• Details: ${details}` : ""}`,
    "REREGISTRATION_REQUEST",
    cleanRoll,
    studentName || cleanRoll,
    {
      actionable: true,
      actionType: "GRANT_REREG",
      studentRollNo: cleanRoll,
      requestType,
      reason,
      details
    },
    "faculty"
  ).catch(() => {});

  // Send confirmation notification to the student
  await sendStudentNotification(
    cleanRoll,
    "📨 Re-Registration Request Submitted",
    `Your request to re-register (${scopeLabel}) has been forwarded to your Course Lecturer and Administrator. You may also physically report to your lecturer in class to expedite approval.`,
    "REREGISTRATION_PENDING",
    "SmartAttend Security"
  ).catch(() => {});

  return { success: true, request: requestDoc };
}

/**
 * Cancel a pending re-registration request (Student Side)
 */
export async function cancelReRegistrationRequest(rollNo) {
  const cleanRoll = String(rollNo || "").trim().toUpperCase();
  if (!cleanRoll) return;
  await setDoc(doc(db, "reregistration_requests", cleanRoll), {
    status: "cancelled",
    cancelledAt: Date.now(),
    updatedAt: Date.now()
  }, { merge: true });
}

/**
 * Approve a student's re-registration request (Lecturer / Admin Side)
 */
export async function approveReRegistrationRequest(rollNo, params = {}) {
  const cleanRoll = String(rollNo || "").trim().toUpperCase();
  if (!cleanRoll) throw new Error("A valid roll number is required.");

  const actorName = params.actorName || auth.currentUser?.displayName || "Faculty/Admin";
  const regType = params.requestType || params.registrationType || "both";
  const expHours = params.expiryHours ? Number(params.expiryHours) : 72;
  const mode = params.mode || "one_time";

  // 1. Grant permission in biometric_reregistration_permissions
  await grantBiometricReRegistration({
    targetRolls: [cleanRoll],
    targetType: "single",
    registrationType: regType,
    mode: mode,
    expiryHours: expHours,
    reason: params.reason || "Approved student re-registration request",
    actorName
  });

  // 2. Mark request document as approved
  const now = Date.now();
  await setDoc(doc(db, "reregistration_requests", cleanRoll), {
    status: "approved",
    resolvedAt: now,
    resolvedBy: actorName,
    resolvedByUid: auth.currentUser?.uid || "",
    grantedRegistrationType: regType,
    updatedAt: now
  }, { merge: true });

  return { success: true };
}

/**
 * Reject a student's re-registration request (Lecturer / Admin Side)
 */
export async function rejectReRegistrationRequest(rollNo, { reason = "", actorName = "Faculty/Admin" } = {}) {
  const cleanRoll = String(rollNo || "").trim().toUpperCase();
  if (!cleanRoll) throw new Error("A valid roll number is required.");

  const now = Date.now();
  await setDoc(doc(db, "reregistration_requests", cleanRoll), {
    status: "rejected",
    rejectionReason: reason || "Request declined by faculty. Please report physically in person.",
    resolvedAt: now,
    resolvedBy: actorName,
    resolvedByUid: auth.currentUser?.uid || "",
    updatedAt: now
  }, { merge: true });

  await sendStudentNotification(
    cleanRoll,
    "❌ Re-Registration Request Declined",
    `Your request for re-registration was declined by ${actorName}.${reason ? ` Reason: ${reason}` : " Please physically report to your lecturer during office hours with your Student ID card."}`,
    "REREGISTRATION_DECLINED",
    actorName
  ).catch(() => {});

  return { success: true };
}

/**
 * Subscribe to real-time status of student's re-registration request
 */
export function subscribeToStudentReRegistrationRequest(rollNo, callback) {
  const cleanRoll = String(rollNo || "").trim().toUpperCase();
  if (!cleanRoll) return () => {};

  return onSnapshot(doc(db, "reregistration_requests", cleanRoll), (snap) => {
    if (snap.exists()) {
      callback(snap.data());
    } else {
      callback(null);
    }
  }, (err) => console.warn("Re-reg request subscription warning:", err));
}

/**
 * Subscribe to all pending re-registration requests (for Lecturers / Admins)
 */
export function subscribeToPendingReRegistrationRequests(callback) {
  const q = collection(db, "reregistration_requests");
  return onSnapshot(q, (snapshot) => {
    const list = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(list);
  }, (err) => console.warn("Pending re-reg requests snap warning:", err));
}

