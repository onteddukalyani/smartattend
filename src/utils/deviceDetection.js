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

/**
 * Fetch client's public IP address with multiple fast fallbacks
 */
export async function getClientIpAddress() {
  const endpoints = [
    "https://api.ipify.org?format=json",
    "https://api64.ipify.org?format=json",
    "https://httpbin.org/ip"
  ];

  for (const url of endpoints) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        const ip = data.ip || (data.origin ? data.origin.split(",")[0].trim() : null);
        if (ip && typeof ip === "string" && ip.length >= 7) {
          return ip.trim();
        }
      }
    } catch (_) {}
  }
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