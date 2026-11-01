import { registerPlugin, Capacitor } from '@capacitor/core';

// =========================================================================
// UNIVERSAL WEB BROWSER KIOSK & SUPERVISION ENGINE (All Browsers & Devices)
// Supported: Android (Chrome, Firefox, Samsung), iOS (Safari, Chrome), Desktop
// =========================================================================

let isWebKioskActive = false;
let webWakeLock = null;
let savedBrowserStyles = null;

/**
 * Cross-browser Fullscreen Invoker with vendor prefix fallbacks
 */
function requestBrowserFullscreen(element) {
  const el = element || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!el) return Promise.resolve(false);
  try {
    if (el.requestFullscreen) {
      return el.requestFullscreen().then(() => true).catch((e) => {
        console.warn('[Kiosk Web] requestFullscreen notice:', e?.message || e);
        return false;
      });
    } else if (el.webkitRequestFullscreen) {
      return Promise.resolve(el.webkitRequestFullscreen()).then(() => true).catch(() => false);
    } else if (el.mozRequestFullScreen) {
      return Promise.resolve(el.mozRequestFullScreen()).then(() => true).catch(() => false);
    } else if (el.msRequestFullscreen) {
      return Promise.resolve(el.msRequestFullscreen()).then(() => true).catch(() => false);
    }
  } catch (err) {
    console.warn('[Kiosk Web] Fullscreen invoke notice:', err?.message || err);
  }
  return Promise.resolve(false);
}

/**
 * Cross-browser Fullscreen Exiter with vendor prefix fallbacks
 */
function exitBrowserFullscreen() {
  if (typeof document === 'undefined') return Promise.resolve();
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      return document.exitFullscreen().catch(() => {});
    } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
      return Promise.resolve(document.webkitExitFullscreen()).catch(() => {});
    } else if (document.mozFullScreenElement && document.mozCancelFullScreen) {
      return Promise.resolve(document.mozCancelFullScreen()).catch(() => {});
    } else if (document.msFullscreenElement && document.msExitFullscreen) {
      return Promise.resolve(document.msExitFullscreen()).catch(() => {});
    }
  } catch (_) {}
  return Promise.resolve();
}

/**
 * Cross-browser Fullscreen Detector
 */
function isBrowserFullscreen() {
  if (typeof document === 'undefined') return false;
  return Boolean(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement
  );
}

/**
 * Screen WakeLock Helper with auto-recovery
 */
async function acquireBrowserWakeLock() {
  try {
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && !webWakeLock) {
      webWakeLock = await navigator.wakeLock.request('screen');
      webWakeLock.addEventListener('release', () => {
        webWakeLock = null;
      });
      console.log('[Kiosk Web] Screen wake-lock acquired.');
    }
  } catch (err) {
    console.warn('[Kiosk Web] WakeLock acquisition notice:', err?.message || err);
  }
}

/**
 * Navigation & Tab Close Guard
 */
function handleKioskBeforeUnload(e) {
  if (!isWebKioskActive) return;
  e.preventDefault();
  e.returnValue = '⚠️ Attendance session is currently active. Leaving or refreshing this page will forfeit your attendance.';
  return e.returnValue;
}

/**
 * History PopState / Back Button Trap
 */
function handleKioskPopState() {
  if (!isWebKioskActive) return;
  try {
    window.history.pushState({ smartattend_kiosk: true }, document.title, window.location.href);
  } catch (_) {}
  window.dispatchEvent(new CustomEvent('smartattend_kiosk_back_attempt'));
}

/**
 * Keyboard Shortcuts Shield (DevTools, Reload, Close, Print, Source)
 */
function handleKioskKeyDown(e) {
  if (!isWebKioskActive) return;
  const key = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  if (
    key === 'F5' ||
    key === 'F12' ||
    (ctrl && (key === 'r' || key === 'R' || key === 'w' || key === 'W' || key === 't' || key === 'T' || key === 'n' || key === 'N' || key === 'u' || key === 'U' || key === 'p' || key === 'P' || key === 's' || key === 'S')) ||
    (ctrl && shift && (key === 'i' || key === 'I' || key === 'j' || key === 'J' || key === 'c' || key === 'C'))
  ) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/**
 * Right-Click Context Menu Shield
 */
function handleKioskContextMenu(e) {
  if (!isWebKioskActive) return;
  e.preventDefault();
  return false;
}

let originalWindowOpen = null;

/**
 * Block new tabs/windows and external links during active kiosk session
 */
function handleKioskLinkClick(e) {
  if (!isWebKioskActive) return;
  const target = e.target && typeof e.target.closest === 'function' ? e.target.closest('a') : null;
  if (target) {
    const isTargetBlank = target.target === '_blank' || target.getAttribute('target') === '_blank';
    const isExternal = target.href && !target.href.startsWith(window.location.origin);
    if (isTargetBlank || isExternal) {
      e.preventDefault();
      e.stopPropagation();
      console.warn('[Kiosk Shield] Blocked external link/new tab click during attendance session:', target.href);
      return false;
    }
  }
}

/**
 * Wake Lock Reacquisition & Auto-Redirect on Visibility Change
 * If the student was in another app or tab, instantly redirect back to the attendance page
 */
function handleKioskVisibilityChange() {
  if (!isWebKioskActive) return;
  if (document.visibilityState === 'visible') {
    acquireBrowserWakeLock();
    requestBrowserFullscreen();
    document.title = 'SmartAttend';
    // Automatically redirect back to attendance scanner if on any other page
    if (typeof window !== 'undefined' && window.location) {
      const p = (window.location.pathname || '').toLowerCase();
      if (!p.includes('mark-attendance') && !p.includes('scanqr')) {
        console.log('[Kiosk Engine] Returning from background: automatically redirecting to attendance page');
        window.location.replace('/student/mark-attendance');
      }
    }
  } else if (document.visibilityState === 'hidden') {
    document.title = '🚨 ATTENDANCE IN PROGRESS · RETURN TO SMARTATTEND!';
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate([250, 100, 250, 100, 250]); } catch (_) {}
    }
  }
}

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
    setScreenCaptureDisabled: async (options) => {
      return { success: true, disabled: Boolean(options?.disabled), isWebFallback: true };
    },
    disableCamera: async () => {
      return { success: true, isDeviceOwner: false, cameraDisabled: false, isWebFallback: true };
    },
    enableCamera: async () => {
      return { success: true, isDeviceOwner: false, cameraEnabled: true, isWebFallback: true };
    },
    canDrawOverlays: async () => {
      return { canDrawOverlays: false, isWebFallback: true };
    },
    requestOverlayPermission: async () => {
      return { requested: false, isWebFallback: true };
    },
    isAccessibilityServiceEnabled: async () => {
      return { isEnabled: false, isWebFallback: true };
    },
    requestAccessibilityPermission: async () => {
      return { requested: false, isWebFallback: true };
    },
    getSecurityDiagnostics: async () => {
      return {
        isDeviceOwner: false,
        canDrawOverlays: false,
        isAccessibilityActive: false,
        isKioskEnforced: isWebKioskActive,
        lockTaskModeState: isWebKioskActive ? 1 : 0,
        securityLevel: 'WEB_SUPERVISED',
        isWebFallback: true
      };
    },
    startKiosk: async () => {
      console.log('[KioskPlugin Web] Starting web supervised session on all browser devices');
      isWebKioskActive = true;

      // 1. Acquire Screen Wake Lock to prevent screen sleep while waiting for QR 2
      await acquireBrowserWakeLock();

      // 2. Request Fullscreen across all browser vendors
      await requestBrowserFullscreen();

      // 3. Intercept window.open & link clicks to prevent opening new tabs/apps
      if (typeof window !== 'undefined') {
        try {
          if (!originalWindowOpen) {
            originalWindowOpen = window.open;
            window.open = function(...args) {
              if (isWebKioskActive) {
                console.warn('[Kiosk Shield] Blocked attempt to open new tab/window during attendance session:', args);
                return null;
              }
              return originalWindowOpen.apply(this, args);
            };
          }
          document.removeEventListener('click', handleKioskLinkClick, true);
          document.addEventListener('click', handleKioskLinkClick, true);

          window.history.pushState({ smartattend_kiosk: true }, document.title, window.location.href);
          window.removeEventListener('popstate', handleKioskPopState);
          window.addEventListener('popstate', handleKioskPopState);
          window.removeEventListener('beforeunload', handleKioskBeforeUnload);
          window.addEventListener('beforeunload', handleKioskBeforeUnload);
          window.removeEventListener('keydown', handleKioskKeyDown, true);
          window.addEventListener('keydown', handleKioskKeyDown, true);
          window.removeEventListener('contextmenu', handleKioskContextMenu, true);
          window.addEventListener('contextmenu', handleKioskContextMenu, true);
          document.removeEventListener('visibilitychange', handleKioskVisibilityChange);
          document.addEventListener('visibilitychange', handleKioskVisibilityChange);
          window.removeEventListener('focus', handleKioskVisibilityChange);
          window.addEventListener('focus', handleKioskVisibilityChange);
        } catch (_) {}
      }

      // 4. Lock page overscroll and selection styles to prevent accidental pull-to-refresh
      if (typeof document !== 'undefined') {
        try {
          if (!savedBrowserStyles) {
            savedBrowserStyles = {
              htmlOverscroll: document.documentElement.style.overscrollBehavior,
              bodyOverscroll: document.body.style.overscrollBehavior,
              userSelect: document.body.style.userSelect,
              webkitUserSelect: document.body.style.webkitUserSelect
            };
          }
          document.documentElement.style.overscrollBehavior = 'none';
          document.body.style.overscrollBehavior = 'none';
          document.body.style.userSelect = 'none';
          document.body.style.webkitUserSelect = 'none';
        } catch (_) {}
      }

      return {
        active: true,
        isWebFallback: true,
        isFullscreen: isBrowserFullscreen(),
        message: 'Web supervised kiosk mode active on all devices'
      };
    },
    stopKiosk: async () => {
      console.log('[KioskPlugin Web] Stopping web supervised session');
      isWebKioskActive = false;

      // 1. Release Wake Lock
      if (webWakeLock) {
        try {
          await webWakeLock.release();
        } catch (_) {}
        webWakeLock = null;
      }

      // 2. Exit Fullscreen across all browser vendors
      await exitBrowserFullscreen();

      // 3. Restore window.open and remove window listeners
      if (typeof window !== 'undefined') {
        try {
          if (originalWindowOpen) {
            window.open = originalWindowOpen;
            originalWindowOpen = null;
          }
          document.removeEventListener('click', handleKioskLinkClick, true);
          window.removeEventListener('popstate', handleKioskPopState);
          window.removeEventListener('beforeunload', handleKioskBeforeUnload);
          window.removeEventListener('keydown', handleKioskKeyDown, true);
          window.removeEventListener('contextmenu', handleKioskContextMenu, true);
          document.removeEventListener('visibilitychange', handleKioskVisibilityChange);
          window.removeEventListener('focus', handleKioskVisibilityChange);
        } catch (_) {}
      }

      // 4. Restore original styles
      if (typeof document !== 'undefined' && savedBrowserStyles) {
        try {
          document.documentElement.style.overscrollBehavior = savedBrowserStyles.htmlOverscroll || '';
          document.body.style.overscrollBehavior = savedBrowserStyles.bodyOverscroll || '';
          document.body.style.userSelect = savedBrowserStyles.userSelect || '';
          document.body.style.webkitUserSelect = savedBrowserStyles.webkitUserSelect || '';
          savedBrowserStyles = null;
        } catch (_) {}
      }

      return { active: false, isWebFallback: true, message: 'Web supervised mode ended' };
    },
    isKioskActive: async () => {
      const isFs = isBrowserFullscreen();
      return { active: isWebKioskActive || isFs || Boolean(webWakeLock), isWebFallback: true };
    },
    isVpnActive: async () => {
      return { isVpn: false, details: 'WEB_FALLBACK', isWebFallback: true };
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
   * Device Owner: Enable or disable OS-level screenshots and screen recording
   */
  async setScreenCaptureDisabled(options = { disabled: true }) {
    try {
      const isNative = Capacitor.isNativePlatform();
      if (!isNative) return { success: true, disabled: Boolean(options?.disabled), isWebFallback: true };
      if (typeof NativeKioskPlugin?.setScreenCaptureDisabled === 'function') {
        const result = await NativeKioskPlugin.setScreenCaptureDisabled(options);
        return result || { success: true };
      }
      return { success: true, disabled: Boolean(options?.disabled) };
    } catch (err) {
      console.warn('[Kiosk] setScreenCaptureDisabled notice:', err);
      return { success: false, error: err.message || String(err) };
    }
  },

  /**
   * Device Owner: Disable camera system-wide during attendance session
   */
  async disableCamera() {
    try {
      const isNative = Capacitor.isNativePlatform();
      if (!isNative) return { success: true, isDeviceOwner: false, cameraDisabled: false, isWebFallback: true };
      if (typeof NativeKioskPlugin?.disableCamera === 'function') {
        const result = await NativeKioskPlugin.disableCamera();
        return result || { success: true };
      }
      return { success: true, isDeviceOwner: false };
    } catch (err) {
      console.warn('[Kiosk] disableCamera notice:', err);
      return { success: false, error: err.message || String(err) };
    }
  },

  /**
   * Device Owner: Re-enable camera system-wide after attendance session ends
   */
  async enableCamera() {
    try {
      const isNative = Capacitor.isNativePlatform();
      if (!isNative) return { success: true, isDeviceOwner: false, cameraEnabled: true, isWebFallback: true };
      if (typeof NativeKioskPlugin?.enableCamera === 'function') {
        const result = await NativeKioskPlugin.enableCamera();
        return result || { success: true };
      }
      return { success: true, isDeviceOwner: false };
    } catch (err) {
      console.warn('[Kiosk] enableCamera notice:', err);
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
   * Check if application is in full screen mode across all browsers & native
   */
  isFullscreen() {
    return isBrowserFullscreen();
  },

  /**
   * Request manual fullscreen on user button tap or interaction
   */
  async requestFullscreen(element) {
    return await requestBrowserFullscreen(element);
  },

  /**
   * Exit browser fullscreen
   */
  async exitFullscreen() {
    return await exitBrowserFullscreen();
  },

  /**
   * Check if the application is provisioned as Android Device Owner
   */
  async isDeviceOwner() {
    try {
      const isNative = Capacitor.isNativePlatform();
      if (!isNative) {
        return { isDeviceOwner: false, isWebFallback: true };
      }
      const result = await NativeKioskPlugin.isDeviceOwner();
      return result || { isDeviceOwner: false };
    } catch (err) {
      console.warn('[Kiosk] isDeviceOwner notice:', err);
      return { isDeviceOwner: false, error: err.message || String(err) };
    }
  },

  /**
   * Get unique Android device hardware / installation identity
   */
  async getDeviceIdentity() {
    try {
      const isNative = Capacitor.isNativePlatform();
      if (!isNative) {
        return { deviceId: 'WEB_CLIENT_' + (navigator.userAgent || '').slice(0, 20), isWebFallback: true, isDeviceOwner: false };
      }
      const result = await NativeKioskPlugin.getDeviceIdentity();
      return result || { deviceId: 'UNKNOWN_DEVICE', isDeviceOwner: false };
    } catch (err) {
      console.warn('[Kiosk] getDeviceIdentity notice:', err);
      return { deviceId: 'UNKNOWN_DEVICE', error: err.message || String(err), isDeviceOwner: false };
    }
  },

  /**
   * Check if SYSTEM_ALERT_WINDOW (Display over other apps) permission is granted
   */
  async canDrawOverlays() {
    try {
      const isNative = Capacitor.isNativePlatform();
      if (!isNative) return { canDrawOverlays: false, isWebFallback: true };
      const result = await NativeKioskPlugin.canDrawOverlays();
      return result || { canDrawOverlays: false };
    } catch (err) {
      return { canDrawOverlays: false, error: err.message };
    }
  },

  /**
   * Open system settings for user to grant Display over other apps permission
   */
  async requestOverlayPermission() {
    try {
      const isNative = Capacitor.isNativePlatform();
      if (!isNative) return { requested: false };
      return await NativeKioskPlugin.requestOverlayPermission();
    } catch (err) {
      return { requested: false, error: err.message };
    }
  },

  /**
   * Open App Info directly (Settings -> Apps -> SmartAttend) so user can tap 3 dots and Allow Restricted Settings
   */
  async openAppDetailsSettings() {
    try {
      const isNative = Capacitor.isNativePlatform();
      if (!isNative) return { opened: false };
      return await NativeKioskPlugin.openAppDetailsSettings();
    } catch (err) {
      return { opened: false, error: err.message };
    }
  },

  /**
   * Check if Accessibility Guardian service is enabled
   */
  async isAccessibilityServiceEnabled() {
    try {
      const isNative = Capacitor.isNativePlatform();
      if (!isNative) return { isEnabled: false };
      return await NativeKioskPlugin.isAccessibilityServiceEnabled();
    } catch (err) {
      return { isEnabled: false, error: err.message };
    }
  },

  /**
   * Open system Accessibility Settings
   */
  async requestAccessibilityPermission() {
    try {
      const isNative = Capacitor.isNativePlatform();
      if (!isNative) return { requested: false };
      return await NativeKioskPlugin.requestAccessibilityPermission();
    } catch (err) {
      return { requested: false, error: err.message };
    }
  },

  /**
   * Get full security and kiosk diagnostic telemetry
   */
  async getSecurityDiagnostics() {
    try {
      const isNative = Capacitor.isNativePlatform();
      if (!isNative) {
        return {
          isDeviceOwner: false,
          canDrawOverlays: false,
          isAccessibilityActive: false,
          isKioskEnforced: isWebKioskActive,
          lockTaskModeState: isWebKioskActive ? 1 : 0,
          securityLevel: 'WEB_SUPERVISED'
        };
      }
      return await NativeKioskPlugin.getSecurityDiagnostics();
    } catch (err) {
      return { isDeviceOwner: false, error: err.message };
    }
  },

  /**
   * Check if active VPN / Proxy tunnel is present on the device
   */
  async isVpnActive() {
    try {
      if (Capacitor.isNativePlatform()) {
        return await NativeKioskPlugin.isVpnActive();
      }
      return { isVpn: false, details: 'WEB_FALLBACK' };
    } catch (err) {
      console.warn('[Kiosk] isVpnActive notice:', err);
      return { isVpn: false, error: err.message };
    }
  }
};

export const KioskPlugin = Kiosk;
export default Kiosk;
