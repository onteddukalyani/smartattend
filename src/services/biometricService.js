import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import { Biometric } from "../plugins/biometric";
import { Capacitor } from "@capacitor/core";

/**
 * SmartAttend Hardware Biometrics Service
 * 
 * Provides cross-platform hardware-backed biometric authentication:
 * - Native Android: AndroidKeyStore (EC secp256r1, Class 3 BIOMETRIC_STRONG)
 * - Native iOS: Apple Secure Enclave (EC secp256r1, Face ID / Touch ID)
 * - Web Browsers (Chrome / Safari): Clean fallback mode without signature fabrication
 */

const DEFAULT_KEY_ALIAS = "smartattend_biometric_key";

/**
 * Checks if hardware biometric sensor is available on the current platform.
 * 
 * @returns {Promise<{ available: boolean, enrolled: boolean, isNative: boolean, platform: string, message: string }>}
 */
export async function isHardwareBiometricAvailable() {
  try {
    const status = await Biometric.isHardwareAvailable();
    return {
      available: Boolean(status.isAvailable),
      enrolled: Boolean(status.enrolled),
      isNative: Boolean(status.isNative),
      platform: status.platform || Capacitor.getPlatform(),
      message: status.message || ""
    };
  } catch (err) {
    return {
      available: false,
      enrolled: false,
      isNative: Capacitor.isNativePlatform(),
      platform: Capacitor.getPlatform(),
      message: err.message || "Unable to inspect biometric hardware"
    };
  }
}

/**
 * Enrolls or registers an initial hardware biometric key for the student.
 * 
 * @param {string} studentUid
 * @returns {Promise<{ success: boolean, platform: string, message: string }>}
 */
export async function enrollHardwareBiometric(studentUid) {
  if (!Capacitor.isNativePlatform()) {
    return {
      success: false,
      platform: "web",
      message: "Hardware biometric enrollment requires the native SmartAttend app on Android or iPhone."
    };
  }

  try {
    // 1. Request single-use challenge from Cloud Function
    const issueFn = httpsCallable(functions, "issueBiometricChallenge");
    const chalRes = await issueFn();
    const { challengeText } = chalRes.data || {};

    if (!challengeText) {
      throw new Error("Failed to receive enrollment challenge from server.");
    }

    // 2. Generate hardware-bound key and sign challenge
    const keyResult = await Biometric.createBiometricKey({
      keyAlias: DEFAULT_KEY_ALIAS,
      challenge: challengeText,
      promptTitle: "SmartAttend Biometric Setup",
      promptSubtitle: "Authorize hardware biometric enrollment"
    });

    if (!keyResult.publicKey) {
      throw new Error("Native biometric key generation returned no public key.");
    }

    // 3. Register public key with Cloud Function
    const registerFn = httpsCallable(functions, "registerInitialBiometricKey");
    const regRes = await registerFn({
      publicKeyDerBase64: keyResult.publicKey,
      platform: Capacitor.getPlatform(),
      keyAlias: DEFAULT_KEY_ALIAS
    });

    return {
      success: true,
      platform: Capacitor.getPlatform(),
      message: regRes.data?.message || "Biometric key registered successfully."
    };
  } catch (err) {
    console.error("[BiometricService] Enrollment error:", err);
    return {
      success: false,
      platform: Capacitor.getPlatform(),
      message: err.message || "Biometric enrollment failed."
    };
  }
}

/**
 * Prompts user for hardware biometric authentication and signs a server challenge.
 * 
 * - On Native Android / iOS: Fetches ephemeral challenge, prompts biometric sensor,
 *   and produces cryptographic proof { challengeId, signature, platform }.
 * - On Web Browser: Confirms browser environment and returns clean WEB_BROWSER
 *   descriptor without fabricating signatures.
 * 
 * @param {string} studentUid
 * @param {string} [promptSubtitle]
 * @returns {Promise<{ success: boolean, method: string, hardwareAvailable: boolean, isNative: boolean, proof: Object|null, message: string, error?: string }>}
 */
export async function verifyHardwareBiometric(studentUid, promptSubtitle = "Confirm attendance with biometrics") {
  const hw = await isHardwareBiometricAvailable();

  // 1. Web Browser Mode: Clean fallback without signature fabrication
  if (!hw.isNative) {
    return {
      success: true,
      method: "WEB_BROWSER",
      hardwareAvailable: false,
      isNative: false,
      proof: null,
      message: "Web browser session active. Live facial biometric verification is required."
    };
  }

  // 2. Native Mobile Platform (Android or iOS)
  if (!hw.available) {
    return {
      success: false,
      error: "HARDWARE_UNAVAILABLE",
      hardwareAvailable: false,
      isNative: true,
      proof: null,
      message: "❌ Biometric hardware is not available on this device."
    };
  }

  if (!hw.enrolled) {
    return {
      success: false,
      error: "BIOMETRIC_NOT_ENROLLED",
      hardwareAvailable: true,
      isNative: true,
      proof: null,
      message: "❌ No biometrics enrolled in device settings. Please register Fingerprint or Face ID in device settings first."
    };
  }

  try {
    // Check if key exists in hardware; if not, initiate initial setup
    const keyStatus = await Biometric.getBiometricKeyStatus({ keyAlias: DEFAULT_KEY_ALIAS });
    if (!keyStatus.exists || keyStatus.isPermanentlyInvalidated) {
      console.info("[BiometricService] Enrolling initial hardware biometric key...");
      const enrollResult = await enrollHardwareBiometric(studentUid);
      if (!enrollResult.success && !enrollResult.message?.includes("already registered")) {
        return {
          success: false,
          error: "ENROLLMENT_FAILED",
          hardwareAvailable: true,
          isNative: true,
          proof: null,
          message: "Biometric setup failed: " + enrollResult.message
        };
      }
    }

    // 3. Request fresh single-use challenge from server
    const issueFn = httpsCallable(functions, "issueBiometricChallenge");
    const chalRes = await issueFn();
    const { challengeId, challengeText } = chalRes.data || {};

    if (!challengeId || !challengeText) {
      throw new Error("Server failed to issue biometric challenge.");
    }

    // 4. Prompt native biometric sensor and sign canonical challenge bytes
    const signResult = await Biometric.signChallenge({
      keyAlias: DEFAULT_KEY_ALIAS,
      challenge: challengeText,
      promptTitle: "SmartAttend Attendance",
      promptSubtitle: promptSubtitle
    });

    if (!signResult.signature) {
      throw new Error("No cryptographic signature produced by biometric prompt.");
    }

    return {
      success: true,
      method: hw.platform === "ios" ? "SECURE_ENCLAVE_ECDSA" : "ANDROID_KEYSTORE_ECDSA",
      hardwareAvailable: true,
      isNative: true,
      proof: {
        challengeId: challengeId,
        signature: signResult.signature,
        platform: hw.platform
      },
      message: "✅ Hardware biometric verified successfully."
    };
  } catch (err) {
    console.warn("[BiometricService] Verification error:", err);

    // Cancelled by student
    if (
      err.code === "BIOMETRIC_CANCELLED" ||
      err.message?.includes("cancelled") ||
      err.message?.includes("dismissed")
    ) {
      return {
        success: false,
        error: "CANCELLED",
        hardwareAvailable: true,
        isNative: true,
        proof: null,
        message: "❌ Biometric verification cancelled. You must authenticate to submit attendance."
      };
    }

    if (err.code === "KEY_PERMANENTLY_INVALIDATED" || err.message?.includes("invalidated")) {
      return {
        success: false,
        error: "KEY_INVALIDATED",
        hardwareAvailable: true,
        isNative: true,
        proof: null,
        message: "⚠️ Biometrics were changed in device settings. Please contact your lecturer or administrator to authorize biometric credential replacement."
      };
    }

    return {
      success: false,
      error: "VERIFICATION_ERROR",
      hardwareAvailable: true,
      isNative: true,
      proof: null,
      message: "Biometric verification failed: " + (err.message || "Unknown error")
    };
  }
}

export default {
  isHardwareBiometricAvailable,
  enrollHardwareBiometric,
  verifyHardwareBiometric
};
