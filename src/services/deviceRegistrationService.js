import { doc, setDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { Capacitor } from "@capacitor/core";
import { detectDeviceType, getClientIpAddress } from "../utils/deviceDetection";

/**
 * Authoritatively register and lock device for ANY user role (Student, Lecturer, Admin)
 * directly into Firestore database.
 * 
 * Target collections:
 * - Student: students/{rollNo}, users/{uid}, students/{uid}
 * - Lecturer: lecturers/{lecturerId}, users/{uid}, lecturers/{uid}
 * - Admin: admins/{adminId}, users/{uid}, admins/{uid}
 */
export async function registerUserDevice({
  role = "student",
  id = null,
  rollNo = null,
  user = null,
  profile = null,
  platform = null,
  ip = null
}) {
  const normRole = String(role || profile?.role || "student").trim().toLowerCase();
  const uid = user?.uid || profile?.uid || null;
  const cleanEmail = (user?.email || profile?.email || "").trim().toLowerCase();
  const cleanId = String(id || rollNo || profile?.rollNo || profile?.id || cleanEmail.split("@")[0] || uid || "").trim().toUpperCase();

  const detectedPlatform = detectDeviceType();
  const cleanPlatform = String(platform || detectedPlatform || "web").trim().toLowerCase();

  // Resolve client IP if not passed
  let clientIp = ip;
  if (!clientIp || clientIp === "Detecting IP..." || clientIp === "Unknown IP") {
    try {
      clientIp = await getClientIpAddress();
    } catch (_) {
      clientIp = "Unknown IP";
    }
  }

  // Persist locally immediately for offline and instant UI responsiveness
  try {
    localStorage.setItem(`smartattend_${normRole}_device_type`, cleanPlatform);
    localStorage.setItem("smartattend_student_device_type", cleanPlatform);
    localStorage.setItem("smartattend_device_type", cleanPlatform);
    localStorage.setItem("smartattend_device_locked", "true");
    localStorage.setItem("smartattend_student_device_locked", "true");
    localStorage.setItem("smartattend_device_registered", "true");
    if (clientIp && clientIp !== "Unknown IP") {
      localStorage.setItem("smartattend_device_ip", clientIp);
    }
  } catch (_) {}

  // Payload for Firestore
  const now = Date.now();
  const devicePayload = {
    deviceType: cleanPlatform,
    registeredPlatform: cleanPlatform,
    registeredDeviceType: cleanPlatform,
    deviceTypeLocked: true,
    isDeviceRegistered: true,
    deviceSelectedAt: now,
    platformBoundAt: now,
    deviceIp: clientIp || null,
    registrationIp: clientIp || null,
    updatedAt: now
  };

  if (uid) {
    devicePayload.deviceBoundUid = uid;
    devicePayload.studentUid = uid;
    devicePayload.platformBoundBy = uid;
  }
  if (cleanEmail) {
    devicePayload.email = cleanEmail;
  }

  const writePromises = [];

  // 1. Role-specific collection write
  if (normRole === "lecturer" || normRole === "faculty") {
    const lectPayload = { ...devicePayload, role: "lecturer" };
    const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase().trim() : null;
    const targetDocId = cleanEmail || uid || cleanId;
    if (targetDocId) {
      writePromises.push(
        setDoc(doc(db, "lecturers", targetDocId), lectPayload, { merge: true })
          .catch((err) => console.warn("Lecturer device registration notice:", err.message))
      );
    }
    if (prefix && prefix !== targetDocId && prefix !== uid) {
      writePromises.push(
        setDoc(doc(db, "lecturers", prefix), lectPayload, { merge: true })
          .catch(() => {})
      );
    }
    if (uid && targetDocId !== uid) {
      writePromises.push(
        setDoc(doc(db, "lecturers", uid), lectPayload, { merge: true })
          .catch(() => {})
      );
    }
  } else if (normRole === "admin" || normRole === "superadmin") {
    const targetDocId = cleanEmail || uid || cleanId;
    if (targetDocId) {
      writePromises.push(
        setDoc(doc(db, "admins", targetDocId), devicePayload, { merge: true })
          .catch((err) => console.warn("Admin device registration notice:", err.message))
      );
    }
    if (uid && targetDocId !== uid) {
      writePromises.push(
        setDoc(doc(db, "admins", uid), devicePayload, { merge: true })
          .catch(() => {})
      );
    }
  } else {
    // Student collection write
    if (cleanId) {
      writePromises.push(
        setDoc(doc(db, "students", cleanId), devicePayload, { merge: true })
          .catch((err) => console.warn("Student device registration notice:", err.message))
      );
    }
    if (uid && cleanId !== uid) {
      writePromises.push(
        setDoc(doc(db, "students", uid), devicePayload, { merge: true })
          .catch(() => {})
      );
    }
  }

  // 2. Generic users collection write for all authenticated accounts
  if (uid) {
    const userPayload = { ...devicePayload };
    if (normRole === "student" && cleanId && !cleanId.includes("@")) {
      userPayload.rollNo = cleanId;
    }
    writePromises.push(
      setDoc(doc(db, "users", uid), userPayload, { merge: true }).catch(() => {})
    );
  }

  if (cleanEmail && cleanEmail !== uid) {
    writePromises.push(
      setDoc(doc(db, "users", cleanEmail), devicePayload, { merge: true }).catch(() => {})
    );
  }

  await Promise.allSettled(writePromises);

  // 3. Optional Cloud Function platform binding for students
  if (
    normRole === "student" &&
    Capacitor.isNativePlatform() &&
    (cleanPlatform === "android" || cleanPlatform === "ios")
  ) {
    try {
      const bindFn = httpsCallable(functions, "bindStudentDevicePlatform");
      bindFn({ platform: cleanPlatform }).catch((err) => {
        console.warn("Student device platform binding notice:", err.message || err);
      });
    } catch (err) {
      console.warn("Student device platform binding notice:", err.message || err);
    }
  }

  return {
    success: true,
    role: normRole,
    platform: cleanPlatform,
    id: cleanId,
    ip: clientIp
  };
}

/**
 * Backward compatibility alias for registerStudentDevice
 */
export async function registerStudentDevice(params) {
  return registerUserDevice({
    ...params,
    role: "student"
  });
}
