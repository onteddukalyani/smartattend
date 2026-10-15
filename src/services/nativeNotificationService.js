import { registerPlugin, Capacitor } from "@capacitor/core";
import { playNotificationChime } from "./notificationsService";

// Register custom native Android notification plugin if on native platform
const NativeNotificationPlugin = registerPlugin("NativeNotificationPlugin");

// Track recently alerted notification IDs to prevent duplicate popups within session
const seenAlertIds = new Set();
let isInitialized = false;
let sessionStartTime = Date.now();

/**
 * Request notification permissions across Android 13+ and Desktop Web
 */
export async function requestAppNotificationPermissions() {
  // 1. Android Native via Capacitor Plugin
  if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("NativeNotificationPlugin")) {
    try {
      await NativeNotificationPlugin.requestPermissions();
    } catch (_) {}
  }

  // 2. Web Notifications API
  if (typeof window !== "undefined" && "Notification" in window) {
    try {
      if (Notification.permission === "default") {
        await Notification.requestPermission();
      }
    } catch (_) {}
  }
}

/**
 * Post a Real App Notification:
 * 1. Native Android status bar notification (if running in APK)
 * 2. Web desktop notification (if permitted in browser)
 * 3. In-App Heads-Up Dynamic Island banner (floating top card)
 * 4. Melodic chime sound
 * 5. Gentle haptic vibration
 */
export async function triggerRealAppNotification({
  id = "",
  title = "SmartAttend Notification",
  message = "",
  body = "",
  type = "GENERAL_NOTICE",
  senderName = "",
  metadata = {},
  force = false
}) {
  const finalMessage = message || body || "";
  const notifId = String(id || `${title}_${finalMessage}`).trim();

  // Deduplication check unless forced
  if (!force && notifId) {
    if (seenAlertIds.has(notifId)) return;
    seenAlertIds.add(notifId);
  }

  const payload = {
    id: notifId,
    title: title || "SmartAttend Notice",
    message: finalMessage,
    type: type || "GENERAL_NOTICE",
    senderName: senderName || "SmartAttend",
    timestamp: Date.now(),
    metadata: metadata || {}
  };

  // 1. Play pleasant melodic notification chime
  try {
    playNotificationChime();
  } catch (_) {}

  // 2. Trigger subtle haptic pulse on mobile devices
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([120, 60, 120]);
    }
  } catch (_) {}

  // 3. Dispatch In-App Heads-Up floating banner event
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(
        new CustomEvent("smartattend:headsup_notification", {
          detail: payload
        })
      );
    } catch (_) {}
  }

  // 4. Android Native System Notification (shows in phone status bar & drawer)
  if (Capacitor.isNativePlatform()) {
    try {
      const numericId = Math.abs(
        Array.from(notifId).reduce((acc, char) => (acc << 5) - acc + char.charCodeAt(0), 0)
      ) % 2147483647;

      await NativeNotificationPlugin.showNotification({
        title: title || "SmartAttend Notice",
        body: finalMessage,
        type: type,
        id: numericId || (Date.now() % 100000)
      });
    } catch (err) {
      console.warn("[NativeNotification] Capacitor notification notice:", err);
    }
  }

  // 5. Desktop Web Notification (Browser Notification API)
  if (
    typeof window !== "undefined" &&
    !Capacitor.isNativePlatform() &&
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    try {
      const desktopNotif = new Notification(title || "SmartAttend", {
        body: finalMessage,
        icon: "/pwa-192x192.png",
        badge: "/favicon.ico",
        tag: notifId
      });
      desktopNotif.onclick = () => {
        window.focus();
        desktopNotif.close();
      };
    } catch (_) {}
  }
}

/**
 * Initialize notification engine with pre-existing notification IDs
 * so historical notifications on login don't trigger mass popups.
 */
export function seedExistingNotificationIds(notifList = []) {
  if (!Array.isArray(notifList)) return;
  notifList.forEach(n => {
    if (n && n.id) {
      seenAlertIds.add(String(n.id).trim());
    }
  });
}
