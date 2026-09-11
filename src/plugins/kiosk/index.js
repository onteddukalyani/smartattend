import { registerPlugin, Capacitor } from '@capacitor/core';

let webWakeLock = null;

/**
 * Native Capacitor KioskPlugin Registration with Web Fallback
 */
const NativeKioskPlugin = registerPlugin('KioskPlugin', {
  web: {
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
          // Normal if called from async promise without direct touch gesture
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
 * Universal Kiosk Controller Interface for SmartAttend
 */
export const Kiosk = {
  /**
   * Start native Android Lock Task / Supervised Kiosk mode
   */
  async startKiosk() {
    try {
      const isNative = Capacitor.isNativePlatform();
      console.log(`[Kiosk] Starting kiosk mode (isNative: ${isNative}, platform: ${Capacitor.getPlatform()})`);
      const result = await NativeKioskPlugin.startKiosk();
      return result;
    } catch (err) {
      console.warn('[Kiosk] startKiosk notice:', err);
      return { active: false, error: err.message || String(err), fallback: true };
    }
  },

  /**
   * Exit native Android Lock Task mode
   */
  async stopKiosk() {
    try {
      console.log('[Kiosk] Stopping kiosk mode');
      const result = await NativeKioskPlugin.stopKiosk();
      return result;
    } catch (err) {
      console.warn('[Kiosk] stopKiosk notice:', err);
      return { active: false, error: err.message || String(err) };
    }
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
