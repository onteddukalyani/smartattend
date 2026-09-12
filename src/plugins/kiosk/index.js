import { registerPlugin, Capacitor } from '@capacitor/core';

let webWakeLock = null;

/**
 * Native Capacitor KioskPlugin Registration with Web Fallback
 */
const NativeKioskPlugin = registerPlugin('KioskPlugin', {
  web: {
    startKioskMode: async () => {
      return NativeKioskPlugin.startKiosk();
    },
    stopKioskMode: async () => {
      return NativeKioskPlugin.stopKiosk();
    },
    setAttendanceRestrictions: async () => {
      return { success: true, isWebFallback: true, message: 'Web attendance restrictions active' };
    },
    clearAttendanceRestrictions: async () => {
      return { success: true, isWebFallback: true, message: 'Web attendance restrictions cleared' };
    },
    startKiosk: async () => {
      console.log('[KioskPlugin Web] Starting web supervised session');
      
      // 1. Attempt Screen Wake Lock on modern mobile browsers
      try {
        if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && !webWakeLock) {
          webWakeLock = await navigator.wakeLock.request('screen');
          webWakeLock.addEventListener('release', () => {
            webWakeLock = null;
          });
        }
      } catch (wakeErr) {
        console.warn('[Kiosk Web] WakeLock notice:', wakeErr);
      }

      // 2. Attempt Fullscreen if user gesture is available
      if (typeof document !== 'undefined' && document.documentElement.requestFullscreen) {
        try {
          if (!document.fullscreenElement) {
            await document.documentElement.requestFullscreen();
          }
        } catch (e) {
          console.warn('[Kiosk Web] Fullscreen notice (requires direct user tap):', e.message);
        }
      }
      return { active: true, isWebFallback: true, message: 'Web supervised mode active' };
    },
    stopKiosk: async () => {
      console.log('[KioskPlugin Web] Stopping web supervised session');

      // Release Wake Lock
      if (webWakeLock) {
        try {
          await webWakeLock.release();
        } catch (_) {}
        webWakeLock = null;
      }

      // Exit Fullscreen
      if (typeof document !== 'undefined' && document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch (e) {
          console.warn('[Kiosk Web] Exit fullscreen notice:', e.message);
        }
      }
      return { active: false, isWebFallback: true, message: 'Web supervised mode ended' };
    },
    isKioskActive: async () => {
      const isFs = typeof document !== 'undefined' && Boolean(document.fullscreenElement);
      return { active: isFs || Boolean(webWakeLock), isWebFallback: true };
    }
  }
});

/**
 * Universal Kiosk & Device Management Controller Interface for SmartAttend
 */
export const Kiosk = {
  /**
   * Start native Android Lock Task / Supervised Kiosk mode
   */
  async startKioskMode() {
    try {
      const isNative = Capacitor.isNativePlatform();
      console.log(`[Kiosk] Starting kiosk mode (isNative: ${isNative}, platform: ${Capacitor.getPlatform()})`);
      const result = await NativeKioskPlugin.startKioskMode();
      return result;
    } catch (err) {
      console.warn('[Kiosk] startKioskMode notice:', err);
      return { active: false, error: err.message || String(err), fallback: true };
    }
  },

  /**
   * Exit native Android Lock Task mode
   */
  async stopKioskMode() {
    try {
      console.log('[Kiosk] Stopping kiosk mode');
      const result = await NativeKioskPlugin.stopKioskMode();
      return result;
    } catch (err) {
      console.warn('[Kiosk] stopKioskMode notice:', err);
      return { active: false, error: err.message || String(err) };
    }
  },

  /**
   * Apply Device Policy Manager & Hardware Attendance Restrictions
   */
  async setAttendanceRestrictions() {
    try {
      const result = await NativeKioskPlugin.setAttendanceRestrictions();
      return result;
    } catch (err) {
      console.warn('[Kiosk] setAttendanceRestrictions notice:', err);
      return { success: false, error: err.message || String(err) };
    }
  },

  /**
   * Clear Device Policy Manager Restrictions
   */
  async clearAttendanceRestrictions() {
    try {
      const result = await NativeKioskPlugin.clearAttendanceRestrictions();
      return result;
    } catch (err) {
      console.warn('[Kiosk] clearAttendanceRestrictions notice:', err);
      return { success: false, error: err.message || String(err) };
    }
  },

  /**
   * Backward-compatible start alias
   */
  async startKiosk() {
    return this.startKioskMode();
  },

  /**
   * Backward-compatible stop alias
   */
  async stopKiosk() {
    return this.stopKioskMode();
  },

  /**
   * Check if Lock Task or Kiosk mode is currently active
   */
  async isKioskActive() {
    try {
      const result = await NativeKioskPlugin.isKioskActive();
      return result;
    } catch (err) {
      console.warn('[Kiosk] isKioskActive notice:', err);
      return { active: false };
    }
  },

  /**
   * Request manual fullscreen on user button tap
   */
  async requestFullscreen() {
    if (typeof document !== 'undefined' && document.documentElement.requestFullscreen) {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
          return true;
        }
      } catch (err) {
        console.warn('[Kiosk] Fullscreen request rejected:', err);
      }
    }
    return false;
  }
};

export default Kiosk;
