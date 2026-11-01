import { db } from "../firebase";
import { doc, getDoc, setDoc, onSnapshot, serverTimestamp } from "firebase/firestore";

export const ATTENDANCE_PLATFORM_POLICIES = {
  HYBRID_SECURITY: {
    id: "HYBRID_SECURITY",
    label: "Hybrid Security (Android APK Required, iPhone on Web)",
    badge: "Standard Anti-Proxy",
    badgeColor: "#6366f1",
    description: "Android students must use the official SmartAttend APK (with Kiosk Mode). iPhone students and desktop users can mark attendance in Safari/Chrome web.",
    recommended: true
  },
  ALL_WEB: {
    id: "ALL_WEB",
    label: "Universal Web Access (All Students Can Scan in Web)",
    badge: "Web Friendly",
    badgeColor: "#10b981",
    description: "All students (Android, iPhone, iPad, PC) can scan QR codes and submit attendance directly in any mobile web browser. No APK installation required.",
    recommended: false
  },
  NATIVE_ONLY: {
    id: "NATIVE_ONLY",
    label: "Strict Native App Only (All Mobile Students Must Use App)",
    badge: "Maximum Lockdown",
    badgeColor: "#ef4444",
    description: "All students on mobile devices must use the native app. Mobile browser attendance scanning is blocked for both Android and iOS.",
    recommended: false
  }
};

export const DEFAULT_INSTITUTION_SETTINGS = {
  institutionName: "IIIT Dharwad",
  institutionCode: "IIIT-DWD",
  sessionDuration: 10,
  qrRefreshInterval: 30,
  attendanceWindow: 5,
  allowLateAttendance: true,
  attendancePlatformPolicy: "HYBRID_SECURITY"
};

const STORAGE_KEY = "smartattend_platform_policy";
let inMemoryPolicy = null;

/**
 * Returns current platform policy synchronously from memory / localStorage
 */
export function getAttendancePlatformPolicy() {
  if (inMemoryPolicy) return inMemoryPolicy;
  try {
    if (typeof localStorage !== "undefined") {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached && ATTENDANCE_PLATFORM_POLICIES[cached]) {
        inMemoryPolicy = cached;
        return cached;
      }
    }
  } catch (_) { }
  return DEFAULT_INSTITUTION_SETTINGS.attendancePlatformPolicy;
}

/**
 * Persists the active policy locally
 */
export function setCachedAttendancePlatformPolicy(policy) {
  if (policy && ATTENDANCE_PLATFORM_POLICIES[policy]) {
    inMemoryPolicy = policy;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, policy);
      }
    } catch (_) { }
  }
}

/**
 * Fetches current institution settings from Firestore
 */
export async function getInstitutionSettings() {
  try {
    const snap = await getDoc(doc(db, "institution", "settings"));
    if (snap.exists()) {
      const data = snap.data();
      if (data?.attendancePlatformPolicy) {
        setCachedAttendancePlatformPolicy(data.attendancePlatformPolicy);
      }
      return { ...DEFAULT_INSTITUTION_SETTINGS, ...data };
    }
  } catch (err) {
    console.warn("[institutionService] Error fetching institution settings:", err);
  }
  return DEFAULT_INSTITUTION_SETTINGS;
}

/**
 * Subscribes to real-time changes in institution settings
 * @param {Function} callback - called with updated settings
 * @returns {Function} unsubscribe function
 */
export function subscribeToInstitutionSettings(callback) {
  if (!callback || typeof callback !== "function") return () => { };

  // Immediately call with cached policy if available
  const initialPolicy = getAttendancePlatformPolicy();
  callback({ ...DEFAULT_INSTITUTION_SETTINGS, attendancePlatformPolicy: initialPolicy });

  try {
    const unsub = onSnapshot(
      doc(db, "institution", "settings"),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() || {};
          if (data.attendancePlatformPolicy) {
            setCachedAttendancePlatformPolicy(data.attendancePlatformPolicy);
          }
          callback({ ...DEFAULT_INSTITUTION_SETTINGS, ...data });
        }
      },
      (err) => {
        console.warn("[institutionService] Live subscription notice:", err?.message || err);
      }
    );
    return unsub;
  } catch (subErr) {
    console.warn("[institutionService] Realtime listener setup error:", subErr);
    return () => { };
  }
}

/**
 * Saves institution settings and broadcasts change
 */
export async function saveInstitutionSettings(newSettings, user = null) {
  const settingsRef = doc(db, "institution", "settings");
  const payload = {
    ...DEFAULT_INSTITUTION_SETTINGS,
    ...newSettings,
    updatedAt: serverTimestamp(),
    updatedBy: user?.uid || user?.email || "Admin"
  };

  await setDoc(settingsRef, payload, { merge: true });
  if (payload.attendancePlatformPolicy) {
    setCachedAttendancePlatformPolicy(payload.attendancePlatformPolicy);
  }
  return payload;
}
