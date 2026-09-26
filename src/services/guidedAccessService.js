import { registerPlugin, Capacitor } from '@capacitor/core';

/**
 * Native Capacitor GuidedAccessPlugin Registration with Web/Android Safe Fallback
 */
const NativeGuidedAccessPlugin = registerPlugin('GuidedAccessPlugin', {
    web: {
        isGuidedAccessEnabled: async () => {
            // Check if simulated via localStorage during development/testing
            const isSimulated = typeof window !== 'undefined' && window.sessionStorage?.getItem('mock_guided_access_enabled') === 'true';
            return {
                enabled: isSimulated,
                isSupported: false,
                platform: 'web'
            };
        },
        startGuidedAccessListener: async () => {
            return { listening: true, currentStatus: false };
        },
        stopGuidedAccessListener: async () => {
            return { listening: false };
        }
    }
});

/**
 * Checks if the current operating environment is Apple iOS (iPhone/iPad)
 */
export const isIOSDevice = () => {
    if (Capacitor.isNativePlatform()) {
        return Capacitor.getPlatform() === 'ios';
    }
    // Mobile Safari / iOS Web Detection
    if (typeof navigator !== 'undefined') {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }
    return false;
};

/**
 * Query whether Guided Access is currently turned ON and Active.
 * On non-iOS devices, returns { enabled: true, isIOS: false } to skip iOS-specific blockers.
 * 
 * @returns {Promise<{ enabled: boolean, isIOS: boolean, isSupported: boolean }>}
 */
export const isGuidedAccessEnabled = async () => {
    const isIOS = isIOSDevice();
    
    // If not running on iOS, bypass Guided Access check cleanly
    if (!isIOS) {
        return {
            enabled: true,
            isIOS: false,
            isSupported: false
        };
    }

    try {
        const res = await NativeGuidedAccessPlugin.isGuidedAccessEnabled();
        return {
            enabled: Boolean(res?.enabled),
            isIOS: true,
            isSupported: Boolean(res?.isSupported ?? true)
        };
    } catch (err) {
        console.warn('[GuidedAccessService] Error querying native status:', err);
        return {
            enabled: false,
            isIOS: true,
            isSupported: false,
            error: err.message
        };
    }
};

/**
 * Subscribe to native iOS Guided Access status changes in real-time.
 * 
 * @param {Function} onChangeCallback - Callback receiving ({ enabled: boolean })
 * @returns {Promise<Function>} - Async cleanup function that removes listener
 */
export const addGuidedAccessListener = async (onChangeCallback) => {
    const isIOS = isIOSDevice();
    
    if (!isIOS) {
        // Non-iOS: notify immediately with enabled = true
        if (typeof onChangeCallback === 'function') {
            onChangeCallback({ enabled: true, isIOS: false });
        }
        return () => {};
    }

    let listenerHandle = null;

    try {
        // 1. Start native listener
        await NativeGuidedAccessPlugin.startGuidedAccessListener();

        // 2. Attach Capacitor plugin event listener
        listenerHandle = await NativeGuidedAccessPlugin.addListener(
            'guidedAccessStatusChanged',
            (data) => {
                console.log('[GuidedAccessService] Native event received:', data);
                if (typeof onChangeCallback === 'function') {
                    onChangeCallback({
                        enabled: Boolean(data?.enabled),
                        isIOS: true,
                        timestamp: data?.timestamp || Date.now()
                    });
                }
            }
        );

        // 3. Immediately query current status and trigger initial callback
        const current = await isGuidedAccessEnabled();
        if (typeof onChangeCallback === 'function') {
            onChangeCallback(current);
        }
    } catch (err) {
        console.warn('[GuidedAccessService] Listener attachment notice:', err);
    }

    // Return cleanup function
    return async () => {
        try {
            if (listenerHandle && typeof listenerHandle.remove === 'function') {
                await listenerHandle.remove();
            }
            await NativeGuidedAccessPlugin.stopGuidedAccessListener();
        } catch (e) {
            // Ignore cleanup errors
        }
    };
};

/**
 * Helper for browser / debug simulation of Guided Access toggle
 */
export const setMockGuidedAccess = (enabled) => {
    if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem('mock_guided_access_enabled', enabled ? 'true' : 'false');
    }
};

export default {
    isIOSDevice,
    isGuidedAccessEnabled,
    addGuidedAccessListener,
    setMockGuidedAccess
};
