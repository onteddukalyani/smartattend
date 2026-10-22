import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";

const registerFaceCallable = httpsCallable(functions, "registerStudentFace");
const matchFaceCallable = httpsCallable(functions, "matchStudentFace");
const removeFaceCallable = httpsCallable(functions, "removeStudentFaceEnrollment");
const reviewFaceCallable = httpsCallable(functions, "resolveFaceEnrollmentReview");
const listFaceReviewsCallable = httpsCallable(functions, "listFaceEnrollmentReviews");

export async function registerStudentFace(rollNo, faceDescriptor) {
  const response = await registerFaceCallable({ rollNo, faceDescriptor });
  const result = response.data;

  if (result?.status === "REVIEW_REQUIRED") {
    throw new Error(result.message || "Face enrollment requires authorized review.");
  }
  if (!result?.success) {
    throw new Error("Face enrollment was not completed by the server.");
  }

  return result;
}

export async function matchStudentFace(faceDescriptor, rollNo = "") {
  const response = await matchFaceCallable({ faceDescriptor, rollNo });
  return response.data;
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

const grantReRegCallable = httpsCallable(functions, "grantBiometricReRegistration");
const revokeReRegCallable = httpsCallable(functions, "revokeBiometricReRegistration");
const listReRegCallable = httpsCallable(functions, "listBiometricReRegistrationPermissions");
const checkReRegStatusCallable = httpsCallable(functions, "checkStudentReRegistrationStatus");
const identifyStudentCallable = httpsCallable(functions, "identifyStudentByFace");

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
  const response = await identifyStudentCallable({ faceDescriptor });
  return response.data;
}

