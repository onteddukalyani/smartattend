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