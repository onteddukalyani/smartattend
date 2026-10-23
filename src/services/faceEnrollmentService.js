import { auth } from "../firebase";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";

const apiBaseUrl = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const registerFaceCallable = httpsCallable(functions, "registerStudentFace");
const matchFaceCallable = httpsCallable(functions, "matchStudentFace");
const identifyStudentCallable = httpsCallable(functions, "identifyStudentByFace");
const removeFaceCallable = httpsCallable(functions, "removeStudentFaceEnrollment");
const reviewFaceCallable = httpsCallable(functions, "resolveFaceEnrollmentReview");
const listFaceReviewsCallable = httpsCallable(functions, "listFaceEnrollmentReviews");
const grantReRegCallable = httpsCallable(functions, "grantBiometricReRegistration");
const revokeReRegCallable = httpsCallable(functions, "revokeBiometricReRegistration");
const listReRegCallable = httpsCallable(functions, "listBiometricReRegistrationPermissions");
const checkReRegStatusCallable = httpsCallable(functions, "checkStudentReRegistrationStatus");

export async function registerStudentFace(rollNo, faceDescriptor) {
  const result = await callFaceApi(
    "/api/face/register",
    { rollNo, faceDescriptor },
    registerFaceCallable
  );
  if (result?.status === "REVIEW_REQUIRED") {
    throw new Error(result.message || "Face enrollment requires authorized review.");
  }
  if (!result?.success) {
    throw new Error("Face enrollment was not completed by the server.");
  }
  return result;
}

async function callFaceApi(path, payload, fallbackCallable) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("Sign in again before using face biometrics.");
  }
  const token = await currentUser.getIdToken();
  let response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
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
  if (!contentType.toLowerCase().includes("json") && (response.status === 404 || response.ok)) {
    const fallbackResponse = await fallbackCallable(payload);
    return fallbackResponse.data;
  }

  let result;
  try {
    result = await response.json();
  } catch {
    if (response.status === 404) {
      const fallbackResponse = await fallbackCallable(payload);
      return fallbackResponse.data;
    }
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
  return callFaceApi(
    "/api/face/match",
    { faceDescriptor, rollNo },
    matchFaceCallable
  );
}

export async function removeStudentFaceEnrollment(rollNo) {
  const response = await removeFaceCallable({ rollNo });
  if (!response.data?.success) {
    throw new Error("The server did not remove the student's face enrollment.");
  }
  return response.data;
}

export async function resolveFaceEnrollmentReview(requestId, action) {
  const response = await reviewFaceCallable({ requestId, action });
  if (!response.data?.success) {
    throw new Error("The server did not complete the face enrollment review.");
  }
  return response.data;
}

export async function listFaceEnrollmentReviews(rollNo) {
  const response = await listFaceReviewsCallable({ rollNo });
  if (!Array.isArray(response.data?.reviews)) {
    throw new Error("The server returned an invalid face review list.");
  }
  return response.data.reviews;
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
