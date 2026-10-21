import { doc, setDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { detectDeviceType, getClientIpAddress } from "../utils/deviceDetection";

/**
 * Authoritatively register and lock student device directly into Firestore database.
 * Writes to:
 * - students/{rollNo}
 * - users/{uid}
 * - users/{rollNo}
 * - students/{uid}
 * - localStorage
 * Also attempts Cloud Function bindStudentDevicePlatform as optional enhancement without throwing.
 */
export async function registerStudentDevice({ rollNo, user, profile, platform = null, ip = null }) {
  const cleanRoll = String(rollNo || profile?.rollNo || user?.email?.split("@")[0] || "").trim().toUpperCase();
  const uid = user?.uid || null;
  const cleanEmail = (user?.email || profile?.email || "").trim().toLowerCase();
  const detectedPlatform = detectDeviceType();
  const cleanPlatform = String(platform || detectedPlatform || "android").trim().toLowerCase();

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
    localStorage.setItem("smartattend_student_device_type", cleanPlatform);
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
    devicePayload.studentUid = uid;
    devicePayload.platformBoundBy = uid;
  }
  if (cleanEmail) {
    devicePayload.email = cleanEmail;
  }

  const writePromises = [];

  // 1. Write to students/{cleanRoll} (canonical student profile)
  if (cleanRoll) {
    writePromises.push(
      setDoc(doc(db, "students", cleanRoll), devicePayload, { merge: true })
        .catch((err) => console.warn("Failed to register device on students/" + cleanRoll, err))
    );
  }

  // 2. Write to users/{uid} (authenticated user profile)
  if (uid) {
    writePromises.push(
      setDoc(doc(db, "users", uid), {
        ...devicePayload,
        rollNo: cleanRoll || undefined
      }, { merge: true })
        .catch((err) => console.warn("Failed to register device on users/" + uid, err))
    );
  }

  // 3. Write to users/{cleanRoll} if distinct
  if (cleanRoll && uid !== cleanRoll) {
    writePromises.push(
      setDoc(doc(db, "users", cleanRoll), devicePayload, { merge: true })
        .catch(() => {})
    );
  }

  // 4. Write to students/{uid} if distinct
  if (uid && uid !== cleanRoll) {
    writePromises.push(
      setDoc(doc(db, "students", uid), devicePayload, { merge: true })
        .catch(() => {})
    );
  }

  await Promise.allSettled(writePromises);

  // 5. Also attempt Cloud Function binding in background (non-blocking)
  try {
    if (functions) {
      const bindFn = httpsCallable(functions, "bindStudentDevicePlatform");
      bindFn({ platform: cleanPlatform }).catch((e) => {
        console.info("Cloud Function bind notice:", e?.message);
      });
    }
  } catch (_) {}

  return {
    success: true,
    platform: cleanPlatform,
    rollNo: cleanRoll,
    ip: clientIp
  };
}
