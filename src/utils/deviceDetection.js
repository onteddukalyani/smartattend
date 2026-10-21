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

/**
 * Enforces browser camera authorization policy:
 * - Native Mobile App (Capacitor APK): Camera is available.
 * - Browser (!Capacitor.isNativePlatform()):
 *   * Lecturer: Camera IS available.
 *   * Admin: Camera IS available.
 *   * iPhone / iOS Users: Camera IS available (Safari/PWA + Guided Access).
 *   * Android / PC Web Students: Camera is NOT available in browser!
 *     (Must use official SmartAttend Android App (.apk) with Lock Task Kiosk mode).
 * 
 * @param {Object} profile - User profile from authcontext
 * @param {Object} user - Firebase auth user
 * @returns {{ allowed: boolean, reason: string, message?: string }}
 */
export function isBrowserCameraAllowed(profile = {}, user = {}) {
  // If running inside native mobile app (Capacitor APK), camera is always allowed
  if (Capacitor.isNativePlatform()) {
    return { allowed: true, reason: "native_app" };
  }

  // Lecturer: Camera is allowed in browser
  const role = String(profile?.role || user?.role || "").trim().toLowerCase();
  if (role === "lecturer" || role === "faculty" || role === "teacher") {
    return { allowed: true, reason: "lecturer" };
  }

  // Admin: Camera is allowed in browser
  if (role === "admin" || role === "administrator" || role === "superadmin") {
    return { allowed: true, reason: "admin" };
  }

  // iPhone / iPad (iOS): Camera is allowed in browser (iOS uses Safari/PWA + Guided Access)
  const isIOS =
    detectDeviceType() === "ios" ||
    (typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))) ||
    profile?.deviceType === "ios" ||
    (typeof localStorage !== "undefined" && (localStorage.getItem("smartattend_student_device_type") === "ios" || localStorage.getItem("smartattend_device_type") === "ios"));

  if (isIOS) {
    return { allowed: true, reason: "iphone_user" };
  }

  // Android web browser or desktop student: Camera is NOT available in browser
  return {
    allowed: false,
    reason: "android_web_student",
    message: "Camera in browser is only available for Lecturers, Admins, and iPhone users. Android students must use the official SmartAttend Android App (.apk) with Lock Task Kiosk mode."
  };
}