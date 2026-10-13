import { registerPlugin, Capacitor } from '@capacitor/core';

/**
 * Native Capacitor BiometricPlugin Registration with Strict Web Isolation
 * 
 * Hardware fingerprint biometric authentication with Android Keystore binding
 * is strictly isolated to the native Android platform. Web browsers do not
 * provide Android Keystore access and will cleanly reject operations without
 * false success fallbacks.
 */
const NativeBiometricPlugin = registerPlugin('BiometricPlugin', {
  web: {
    isHardwareAvailable: async () => {
      return {
        isNativeAndroid: false,
        isAvailable: false,
        enrolled: false,
        status: 'WEB_UNSUPPORTED',
        message: 'Hardware fingerprint authentication is strictly supported on native Android devices only.',
        deviceModel: typeof navigator !== 'undefined' ? navigator.userAgent : 'Web Browser',
        sdkVersion: 0
      };
    },
    createBiometricKey: async () => {
      const err = new Error('Hardware biometric key generation is restricted to the native SmartAttend Android application.');
      err.code = 'PLATFORM_NOT_SUPPORTED';
      throw err;
    },
    signChallenge: async () => {
      const err = new Error('Hardware biometric challenge signing is restricted to the native SmartAttend Android application.');
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
    }
  }
});

/**
 * Universal Biometric Controller Interface for SmartAttend Android
 */
export const Biometric = {
  /**
   * Check if Class 3 BIOMETRIC_STRONG hardware sensor is present and enrolled.
   * @returns {Promise<{ isNativeAndroid: boolean, isAvailable: boolean, enrolled: boolean, status: string, message: string, deviceModel: string, sdkVersion: number }>}
   */
  async isHardwareAvailable() {
    try {
      return await NativeBiometricPlugin.isHardwareAvailable();
    } catch (err) {
      return {
        isNativeAndroid: Capacitor.isNativePlatform(),
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
   * Generate an EC secp256r1 key in AndroidKeyStore requiring fingerprint authentication per use,
   * and sign an enrollment challenge to authorize registration.
   * 
   * @param {{ keyAlias: string, challenge: string, promptTitle?: string, promptSubtitle?: string }} options
   * @returns {Promise<{ success: boolean, keyAlias: string, publicKey: string, algorithm: string, signature: string, isInsideSecureHardware: boolean, deviceModel: string, sdkVersion: number }>}
   */
  async createBiometricKey(options) {
    if (!options?.keyAlias || !options?.challenge) {
      throw new Error('Key alias and enrollment challenge are required.');
    }
    return await NativeBiometricPlugin.createBiometricKey(options);
  },

  /**
   * Sign an attendance challenge using the registered biometric-bound private key.
   * Triggers Android BiometricPrompt for fingerprint verification.
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
   * Check if a biometric key exists in AndroidKeyStore and verify its hardware status.
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
   * Delete a biometric key from AndroidKeyStore upon revocation.
   * 
   * @param {{ keyAlias: string }} options
   * @returns {Promise<{ success: boolean, deleted: boolean, keyAlias: string }>}
   */
  async deleteBiometricKey(options) {
    if (!options?.keyAlias) {
      throw new Error('Key alias is required.');
    }
    return await NativeBiometricPlugin.deleteBiometricKey(options);
  }
};

export default Biometric;
