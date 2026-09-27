import { registerPlugin, Capacitor } from '@capacitor/core';

const NativeGuidedAccessPlugin = registerPlugin('GuidedAccessPlugin', {
    web: {
        isGuidedAccessEnabled: async () => {
            const isSimulated = typeof window !== 'undefined' && window.sessionStorage?.getItem('mock_guided_access_enabled') === 'true';
            return { enabled: isSimulated, isSupported: false, platform: 'web' };
        },
        startGuidedAccessListener: async () => ({ listening: true, currentStatus: false }),
        stopGuidedAccessListener: async () => ({ listening: false })
    }
});

export const isIOSDevice = () => {
    if (Capacitor.isNativePlatform()) return Capacitor.getPlatform() === 'ios';
    if (typeof navigator !== 'undefined') {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }
    return false;
};

export const isGuidedAccessEnabled = async () => {
    const isIOS = isIOSDevice();
    if (!isIOS) return { enabled: true, isIOS: false, isSupported: false };
    try {
        const res = await NativeGuidedAccessPlugin.isGuidedAccessEnabled();
        return { enabled: Boolean(res?.enabled), isIOS: true, isSupported: Boolean(res?.isSupported ?? true) };
    } catch (err) {
        console.warn('[GuidedAccessService] Error querying native status:', err);
        return { enabled: false, isIOS: true, isSupported: false, error: err.message };
    }
};

export const addGuidedAccessListener = async (onChangeCallback) => {
    const isIOS = isIOSDevice();
    if (!isIOS) {
        if (typeof onChangeCallback === 'function') onChangeCallback({ enabled: true, isIOS: false });
        return () => {};
    }
    let listenerHandle = null;
    try {
        await NativeGuidedAccessPlugin.startGuidedAccessListener();
        listenerHandle = await NativeGuidedAccessPlugin.addListener('guidedAccessStatusChanged', (data) => {
            console.log('[GuidedAccessService] Native event received:', data);
            if (typeof onChangeCallback === 'function') {
                onChangeCallback({ enabled: Boolean(data?.enabled), isIOS: true, timestamp: data?.timestamp || Date.now() });
            }
        });
        const current = await isGuidedAccessEnabled();
        if (typeof onChangeCallback === 'function') onChangeCallback(current);
    } catch (err) {
        console.warn('[GuidedAccessService] Listener attachment notice:', err);
    }
    return async () => {
        try {
            if (listenerHandle && typeof listenerHandle.remove === 'function') await listenerHandle.remove();
            await NativeGuidedAccessPlugin.stopGuidedAccessListener();
        } catch (e) {}
    };
};

/**
 * Subscribe to native iOS app-switching events emitted by GuidedAccessPlugin.
 * Fires on WILL_RESIGN_ACTIVE (swipe-up begins) and DID_ENTER_BACKGROUND (fully switched away).
 * Works independently of Guided Access being enabled.
 */
export const addAppSwitchListener = async (onSwitchCallback) => {
    const isIOS = isIOSDevice();
    if (!isIOS || !Capacitor.isNativePlatform()) return () => {};
    let listenerHandle = null;
    try {
        listenerHandle = await NativeGuidedAccessPlugin.addListener('appSwitchDetected', (data) => {
            console.warn('[GuidedAccessService] App switch detected on iOS:', data);
            if (typeof onSwitchCallback === 'function') {
                onSwitchCallback({ event: data?.event || 'UNKNOWN', guidedAccessActive: Boolean(data?.guidedAccessActive), timestamp: data?.timestamp || Date.now() });
            }
        });
    } catch (err) {
        console.warn('[GuidedAccessService] App switch listener notice:', err);
    }
    return async () => {
        try {
            if (listenerHandle && typeof listenerHandle.remove === 'function') await listenerHandle.remove();
        } catch (e) {}
    };
};


/**
 * Subscribe to iOS screen capture/recording detection.
 * Fires when student starts screen recording, AirPlay mirroring, or QuickTime capture.
 * iOS 11+ native app only.
 */
export const addScreenCaptureListener = async (onCaptureCallback) => {
    const isIOS = isIOSDevice();
    if (!isIOS || !Capacitor.isNativePlatform()) return () => {};
    let listenerHandle = null;
    try {
        listenerHandle = await NativeGuidedAccessPlugin.addListener('screenCaptureDetected', (data) => {
            console.warn('[GuidedAccessService] Screen capture detected on iOS:', data);
            if (typeof onCaptureCallback === 'function') {
                onCaptureCallback({ isCaptured: Boolean(data?.isCaptured), timestamp: data?.timestamp || Date.now() });
            }
        });
    } catch (err) {
        console.warn('[GuidedAccessService] Screen capture listener notice:', err);
    }
    return async () => {
        try {
            if (listenerHandle && typeof listenerHandle.remove === 'function') await listenerHandle.remove();
        } catch (e) {}
    };
};
export const setMockGuidedAccess = (enabled) => {
    if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem('mock_guided_access_enabled', enabled ? 'true' : 'false');
    }
};

export default { isIOSDevice, isGuidedAccessEnabled, addGuidedAccessListener, addAppSwitchListener, addScreenCaptureListener, setMockGuidedAccess };

