import { registerPlugin, Capacitor } from '@capacitor/core';

/**
 * Native Capacitor KioskPlugin Registration with Web Fallback
 */
const NativeKioskPlugin = registerPlugin('KioskPlugin', {
  web: {
    startKiosk: async () => {
      console.log('[KioskPlugin Web Fallback] startKiosk called');
      if (typeof document !== 'undefined' && document.documentElement.requestFullscreen) {
        try {
          if (!document.fullscreenElement) {
            await document.documentElement.requestFullscreen();
          }
        } catch (e) {
          console.warn('[KioskPlugin] Fullscreen request rejected:', e);
        }
      }
      return { active: true, isWebFallback: true, message: 'Web supervised mode active' };
    },
    stopKiosk: async () => {
      console.log('[KioskPlugin Web Fallback] stopKiosk called');
      if (typeof document !== 'undefined' && document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch (e) {
          console.warn('[KioskPlugin] Exit fullscreen rejected:', e);
        }
      }
      return { active: false, isWebFallback: true, message: 'Web supervised mode ended' };
    },
    isKioskActive: async () => {
      const isFs = typeof document !== 'undefined' && Boolean(document.fullscreenElement);
      return { active: isFs, isWebFallback: true };
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
      console.warn('[Kiosk] startKiosk error (graceful fallback):', err);
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
      console.warn('[Kiosk] stopKiosk error:', err);
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
      console.warn('[Kiosk] isKioskActive error:', err);
      return { active: false };
    }
  }
};

export default Kiosk;
