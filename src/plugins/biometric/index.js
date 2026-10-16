import { registerPlugin, Capacitor } from '@capacitor/core';

/**
 * Native Capacitor BiometricPlugin Registration with Strict Web Isolation
 * 
 * Hardware asymmetric biometric authentication is supported on:
 * - Native Android: AndroidKeyStore (EC secp256r1, Class 3 BIOMETRIC_STRONG)
 * - Native iOS: Apple Secure Enclave (EC secp256r1, Face ID / Touch ID)
 * 
 * Web browsers (Desktop / Mobile Safari / Chrome) do not provide hardware Keystore/Secure Enclave
 * access and cleanly report WEB_UNSUPPORTED without false success fallbacks.
 */
const NativeBiometricPlugin = registerPlugin('BiometricPlugin', {
  web: {
    isHardwareAvailable: async () => {
      return {
        isNative: false,
        isNativeAndroid: false,
        isNativeIOS: false,
        platform: 'web',
        isAvailable: false,
        enrolled: false,
        status: 'WEB_UNSUPPORTED',
        message: 'Hardware biometric authentication is supported on native Android and iOS applications only.',
        deviceModel: typeof navigator !== 'undefined' ? navigator.userAgent : 'Web Browser',
        sdkVersion: 0
      };
    },
    createBiometricKey: async () => {
      const err = new Error('Hardware biometric key generation is restricted to native mobile applications.');
      err.code = 'PLATFORM_NOT_SUPPORTED';
      throw err;
    },
    signChallenge: async () => {
      const err = new Error('Hardware biometric challenge signing is restricted to native mobile applications.');
      err.code = 'PLATFORM_NOT_SUPPORTED';
      throw err;
    },
    getBiometricKeyStatus: async () => {
      return {
        exists: false,
        keyAlias: '',
        isInsideSecureHardware: false,
        isPermanentlyInvalidated: false
      };
    },
    deleteBiometricKey: async () => {
      return {
        success: true,
        deleted: false,
        keyAlias: ''
      };
    },
    openBiometricSettings: async () => {
      return {
        success: false,
        message: 'Opening biometric settings is only supported on native mobile devices.'
      };
    }
  }
});

/**
 * Universal Cross-Platform Biometric Controller Interface for SmartAttend (Android & iOS)
 */
export const Biometric = {
  /**
   * Check if hardware biometric sensor is present and enrolled.
   * On Android: Class 3 BIOMETRIC_STRONG (Fingerprint)
   * On iOS: Face ID / Touch ID
   * @returns {Promise<{ isNative?: boolean, isNativeAndroid?: boolean, isNativeIOS?: boolean, platform?: string, isAvailable: boolean, enrolled: boolean, status: string, message: string, deviceModel: string, sdkVersion?: number, biometryType?: string }>}
   */
  async isHardwareAvailable() {
    try {
      const result = await NativeBiometricPlugin.isHardwareAvailable();
      const currentPlatform = Capacitor.getPlatform();
      return {
        ...result,
        isNative: Capacitor.isNativePlatform(),
        isNativeAndroid: currentPlatform === 'android',
        isNativeIOS: currentPlatform === 'ios',
        platform: currentPlatform
      };
    } catch (err) {
      const currentPlatform = Capacitor.getPlatform();
      return {
        isNative: Capacitor.isNativePlatform(),
        isNativeAndroid: currentPlatform === 'android',
        isNativeIOS: currentPlatform === 'ios',
        platform: currentPlatform,
        isAvailable: false,
        enrolled: false,
        status: 'CHECK_ERROR',
        message: err.message || 'Failed to inspect biometric hardware.',
        deviceModel: 'Unknown',
        sdkVersion: 0
      };
    }
  },

  /**
   * Generate an EC secp256r1 key in AndroidKeyStore / Apple Secure Enclave requiring biometric authorization per use,
   * invalidating permanently if new biometrics are added in OS Settings.
   * Signs an enrollment challenge to authorize registration.
   * 
   * @param {{ keyAlias: string, challenge: string, promptTitle?: string, promptSubtitle?: string }} options
   * @returns {Promise<{ success: boolean, keyAlias: string, publicKey: string, algorithm: string, signature: string, isInsideSecureHardware: boolean, deviceModel: string, sdkVersion?: number }>}
   */
  async createBiometricKey(options) {
    if (!options?.keyAlias || !options?.challenge) {
      throw new Error('Key alias and enrollment challenge are required.');
    }
    return await NativeBiometricPlugin.createBiometricKey(options);
  },

  /**
   * Sign an attendance challenge using the registered biometric-bound private key.
   * Triggers Android BiometricPrompt or Apple Face ID / Touch ID.
   * 
   * @param {{ keyAlias: string, challenge: string, promptTitle?: string, promptSubtitle?: string }} options
   * @returns {Promise<{ success: boolean, keyAlias: string, signature: string, algorithm: string }>}
   */
  async signChallenge(options) {
    if (!options?.keyAlias || !options?.challenge) {
      throw new Error('Key alias and challenge are required.');
    }
    return await NativeBiometricPlugin.signChallenge(options);
  },

  /**
   * Check if a biometric key exists in KeyStore / Keychain and verify its hardware status.
   * 
   * @param {{ keyAlias: string }} options
   * @returns {Promise<{ exists: boolean, keyAlias: string, publicKey?: string, isInsideSecureHardware: boolean, isPermanentlyInvalidated: boolean }>}
   */
  async getBiometricKeyStatus(options) {
    if (!options?.keyAlias) {
      throw new Error('Key alias is required.');
    }
    return await NativeBiometricPlugin.getBiometricKeyStatus(options);
  },

  /**
   * Delete a biometric key from KeyStore / Keychain.
   * 
   * @param {{ keyAlias: string }} options
   * @returns {Promise<{ success: boolean, deleted: boolean, keyAlias: string }>}
   */
  async deleteBiometricKey(options) {
    if (!options?.keyAlias) {
      throw new Error('Key alias is required.');
    }
    return await NativeBiometricPlugin.deleteBiometricKey(options);
  },

  /**
   * Open native OS security/biometric settings to enroll a fingerprint or biometrics.
   * 
   * @returns {Promise<{ success: boolean, message?: string }>}
   */
  async openBiometricSettings() {
    try {
      return await NativeBiometricPlugin.openBiometricSettings();
    } catch (err) {
      return { success: false, message: err.message };
    }
  }
};

export default Biometric;
