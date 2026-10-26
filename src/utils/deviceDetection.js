import { Capacitor } from "@capacitor/core";

export function detectDeviceType(environment = {}) {
  const native = environment.native ?? Capacitor.isNativePlatform();
  const nativePlatform = environment.nativePlatform ?? Capacitor.getPlatform();

  if (native) {
    if (nativePlatform === "ios" || nativePlatform === "android") return nativePlatform;
    return null;
  }

  const userAgent = environment.userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const platform = environment.platform ?? (typeof navigator !== "undefined" ? navigator.platform : "");
  const touchPoints = environment.maxTouchPoints ?? (typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0);

  if (/iPhone|iPad|iPod/i.test(userAgent) || (platform === "MacIntel" && touchPoints > 1)) return "ios";
  if (/Android/i.test(userAgent) || /Android/i.test(platform)) return "android";
  return null;
}

// Fast in-memory IP address cache (5 minutes TTL) to eliminate network lag during QR verification
let cachedClientIp = null;
let cachedClientIpTimestamp = 0;
const IP_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch client's public IP address with multiple fast fallbacks and 0ms in-memory cache
 */
export async function getClientIpAddress() {
  const now = Date.now();
  if (cachedClientIp && (now - cachedClientIpTimestamp) < IP_CACHE_TTL_MS) {
    return cachedClientIp;
  }

  const endpoints = [
    "https://api.ipify.org?format=json",
    "https://api64.ipify.org?format=json",
    "https://httpbin.org/ip"
  ];

  try {
    const fetchSingle = async (url) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1200);
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          const ip = data.ip || (data.origin ? data.origin.split(",")[0].trim() : null);
          if (ip && typeof ip === "string" && ip.length >= 7) {
            return ip.trim();
          }
        }
      } catch (_) {
        clearTimeout(timeoutId);
      }
      throw new Error("endpoint failed");
    };

    const resolvedIp = await Promise.any(endpoints.map(fetchSingle));
    if (resolvedIp) {
      cachedClientIp = resolvedIp;
      cachedClientIpTimestamp = Date.now();
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem("smartattend_device_ip", resolvedIp);
        }
      } catch (_) {}
      return resolvedIp;
    }
  } catch (_) {}

  // Local storage fallback if offline or timeout
  try {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem("smartattend_device_ip") : null;
    if (stored && stored.length >= 7) return stored;
  } catch (_) {}

  return "Unknown IP";
}

/**
 * Gather full device fingerprint including IP, platform, userAgent, screen dimensions
 */
export async function getDeviceFingerprint() {
  const deviceType = detectDeviceType() || "web";
  let ip = "Unknown IP";
  try {
    ip = await getClientIpAddress();
  } catch (_) {}

  return {
    deviceType,
    ip,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    platform: typeof navigator !== "undefined" ? navigator.platform : "",
    screenWidth: typeof window !== "undefined" ? window.screen?.width : 0,
    screenHeight: typeof window !== "undefined" ? window.screen?.height : 0,
    timestamp: Date.now()
  };
}

export function getDeviceDisplayName(deviceType) {
  if (!deviceType) return "Unregistered Device";
  const norm = String(deviceType).toLowerCase().trim();
  if (norm === "android") return "Android Device (Native APK)";
  if (norm === "ios" || norm === "iphone" || norm === "ipad") return "iPhone / iOS (Guided Access)";
  if (norm === "web") return "Web Browser / Desktop";
  return norm.toUpperCase();
}

export function isDeviceMatching(registeredType, currentType) {
  if (!registeredType) return true; // not locked yet
  const reg = String(registeredType).toLowerCase().trim();
  const cur = String(currentType || "web").toLowerCase().trim();
  if (reg === cur) return true;
  if ((reg === "ios" || reg === "iphone") && (cur === "ios" || cur === "iphone")) return true;
  return false;
}

export function isStaffCameraUser(profile = {}, user = {}) {
  // 1. Direct profile / user object roles & flags
  const roleValues = [
    profile?.role,
    profile?.designation,
    profile?.userType,
    profile?.type,
    user?.role,
    user?.claims?.role,
    user?.customClaims?.role
  ].map((value) => String(value || "").trim().toLowerCase());

  if (roleValues.some((role) =>
    ["admin", "administrator", "superadmin", "lecturer", "faculty", "professor", "teacher", "instructor", "staff"].includes(role)
  ) || profile?.isAdmin === true || profile?.isLecturer === true ||
    user?.isAdmin === true || user?.isLecturer === true) {
    return true;
  }

  // 2. Local storage / session storage role cached at login
  try {
    const cachedRole = (
      (typeof localStorage !== "undefined" ? (localStorage.getItem("smartattend_user_role") || localStorage.getItem("user_role") || localStorage.getItem("role") || localStorage.getItem("smartattend_role")) : "") ||
      (typeof sessionStorage !== "undefined" ? (sessionStorage.getItem("smartattend_user_role") || sessionStorage.getItem("user_role") || sessionStorage.getItem("role") || sessionStorage.getItem("smartattend_role")) : "")
    ).toLowerCase().trim();
    if (["admin", "administrator", "superadmin", "lecturer", "faculty", "professor", "teacher", "instructor", "staff"].includes(cachedRole)) {
      return true;
    }
  } catch (_) { }

  // 3. Current active route pathname (Lecturer and Admin sections)
  if (typeof window !== "undefined" && window.location?.pathname) {
    const path = window.location.pathname.toLowerCase();
    if (path.includes("/lecturer") || path.includes("/admin") || path.includes("/faculty") || path.includes("/staff")) {
      return true;
    }
  }

  // 4. Staff email pattern detection (e.g. staff keywords or non-student domain)
  const email = String(profile?.email || user?.email || "").toLowerCase().trim();
  if (email && (email.includes("lecturer") || email.includes("faculty") || email.includes("admin") || email.includes("prof") || email.includes("teacher") || email.includes("staff"))) {
    return true;
  }

  return false;
}

/**
 * Enforces browser camera authorization policy:
 * - Native Mobile App (Capacitor APK): Camera is available.
 * - Browser (!Capacitor.isNativePlatform()):
 *   * Lecturer / Admin: Camera IS available across ALL devices (front + rear switch).
 *   * iPhone / iOS Users: Camera IS available (Safari/PWA + Guided Access).
 *   * Android / PC Web Students: Camera is NOT available in browser!
 *     (Must use official SmartAttend Android App (.apk) with Lock Task Kiosk mode).
 * 
 * @param {Object} profile - User profile from authcontext
 * @param {Object} user - Firebase auth user
 * @returns {{ allowed: boolean, reason: string, message?: string }}
 */
export function isBrowserCameraAllowed(profile = {}, user = {}, context = "qr_scanner") {
  // If running inside native mobile app (Capacitor APK), camera is always allowed
  if (Capacitor.isNativePlatform()) {
    return { allowed: true, reason: "native_app" };
  }

  const roleValues = [
    profile?.role,
    profile?.designation,
    profile?.userType,
    profile?.type,
    user?.role,
    user?.claims?.role,
    user?.customClaims?.role
  ].map((value) => String(value || "").trim().toLowerCase());

  // Lecturer: Camera is allowed in browser across any device (front + rear switch)
  const isLecturer = roleValues.some((role) =>
    ["lecturer", "faculty", "professor", "teacher", "instructor", "staff"].includes(role)
  ) || profile?.isLecturer === true || user?.isLecturer === true;
  if (isLecturer) {
    return { allowed: true, reason: "lecturer" };
  }

  // Admin: Camera is allowed in browser across any device (front + rear switch)
  const isAdmin = roleValues.some((role) =>
    ["admin", "administrator", "superadmin"].includes(role)
  ) || profile?.isAdmin === true || user?.isAdmin === true;
  if (isAdmin) {
    return { allowed: true, reason: "admin" };
  }

  // Lecturer & Admin: Camera is always allowed in browser on all devices (Android, iOS, PC, Mac, tablets)
  if (isStaffCameraUser(profile, user)) {
    return { allowed: true, reason: isAdmin ? "admin" : "lecturer" };
  }

  // iPhone / iPad (iOS): Camera is allowed in browser for everything (Safari/PWA + Guided Access)
  const isIOS =
    detectDeviceType() === "ios" ||
    (typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))) ||
    profile?.deviceType === "ios" ||
    (typeof localStorage !== "undefined" && (localStorage.getItem("smartattend_student_device_type") === "ios" || localStorage.getItem("smartattend_device_type") === "ios"));

  if (isIOS) {
    return { allowed: true, reason: "iphone_user" };
  }

  // Students can use browser for biometric face registration / enrollment!
  const isBiometricRegistration =
    context === "biometric_registration" ||
    context === "face_enrollment" ||
    (typeof window !== "undefined" && window.location?.pathname?.includes("face-enroll"));

  if (isBiometricRegistration) {
    return { allowed: true, reason: "biometric_registration" };
  }

  // Android web browser or desktop student: Camera is NOT available in browser for QR scanning
  return {
    allowed: false,
    reason: "android_web_student",
    message: "Camera in browser is only available for Lecturers, Admins, and iPhone users. Android students must use the official SmartAttend Android App (.apk) with Lock Task Kiosk mode."
  };
}