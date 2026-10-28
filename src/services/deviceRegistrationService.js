import { doc, setDoc, deleteDoc } from "firebase/firestore";
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

  // 1. Role-specific collection write (strictly target the existing document only, zero hash/UID docs)
  if (normRole === "lecturer" || normRole === "faculty") {
    const lectPayload = { ...devicePayload, role: "lecturer" };
    const targetDocId = cleanEmail || (cleanId.includes("@") ? cleanId : null);
    if (targetDocId) {
      writePromises.push(
        setDoc(doc(db, "lecturers", targetDocId), lectPayload, { merge: true })
          .catch((err) => console.warn("Lecturer device registration notice:", err.message))
      );
    }
  } else if (normRole === "admin" || normRole === "superadmin") {
    const targetDocId = cleanEmail || (cleanId.includes("@") ? cleanId : null);
    if (targetDocId) {
      writePromises.push(
        setDoc(doc(db, "admins", targetDocId), devicePayload, { merge: true })
          .catch((err) => console.warn("Admin device registration notice:", err.message))
      );
    }
  } else {
    // Student collection write (strictly target canonical uppercase roll number, never raw UID/hash)
    const emailPrefix = cleanEmail && cleanEmail.includes("@") ? cleanEmail.split("@")[0].trim().toUpperCase() : "";
    const cleanRoll = String(rollNo || profile?.rollNo || "").trim().toUpperCase();
    const isIdAStudentRoll = cleanId && !cleanId.includes("@") && cleanId.length <= 15;
    const targetDocId = cleanRoll || (isIdAStudentRoll ? cleanId : emailPrefix);

    if (targetDocId) {
      writePromises.push(
        setDoc(doc(db, "students", targetDocId), devicePayload, { merge: true })
          .catch((err) => console.warn("Student device registration notice:", err.message))
      );
      // Clean up any stray student document previously created under raw user.uid (hash/salt)
      const strayUid = user?.uid || profile?.uid || (cleanId && cleanId.length > 20 ? cleanId : null);
      if (strayUid && strayUid !== targetDocId) {
        deleteDoc(doc(db, "students", strayUid)).catch(() => { });
      }
    }
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
