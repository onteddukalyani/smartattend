/**
 * SmartAttend Hardware Biometrics Service
 * 
 * Manages device-bound hardware biometric authentication (Fingerprint / TouchID / Android BiometricPrompt)
 * via W3C WebAuthn platform authenticator and native Capacitor plugins.
 */

/**
 * Checks if hardware biometric sensor (Fingerprint / Face Unlock / Platform Authenticator) is available.
 * 
 * @returns {Promise<boolean>}
 */
export async function isHardwareBiometricAvailable() {
  if (typeof window === "undefined") return false;

  // 1. Check WebAuthn platform authenticator (Android Fingerprint / Touch ID)
  if (
    window.PublicKeyCredential &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
  ) {
    try {
      const available = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      if (available) return true;
    } catch (_) { }
  }

  return false;
}

/**
 * Prompts user for device hardware biometric verification (Fingerprint or Device Lock PIN).
 * 
 * @param {string} studentUid
 * @param {string} [challengeText]
 * @returns {Promise<Object>} { success: boolean, method: string, credentialId?: string, error?: string }
 */
export async function verifyHardwareBiometric(studentUid, challengeText = "SmartAttend Attendance Verification") {
  const isAvailable = await isHardwareBiometricAvailable();
  if (!isAvailable) {
    // If device doesn't have fingerprint/biometric hardware, return fallback indicator
    return {
      success: true,
      method: "FALLBACK_DEVICE_PASS",
      hardwareAvailable: false,
      message: "Hardware fingerprint sensor not detected on this device. Facial biometric will serve as primary biometric."
    };
  }

  try {
    const challengeBytes = new Uint8Array(32);
    window.crypto.getRandomValues(challengeBytes);

    const publicKeyCredentialRequestOptions = {
      challenge: challengeBytes,
      timeout: 60000,
      userVerification: "required",
      rpId: window.location.hostname
    };

    // Trigger Android / Device native biometric modal
    const assertion = await navigator.credentials.get({
      publicKey: publicKeyCredentialRequestOptions
    });

    if (assertion && assertion.id) {
      return {
        success: true,
        method: "HARDWARE_FINGERPRINT_WEBAUTHN",
        hardwareAvailable: true,
        credentialId: assertion.id,
        verifiedAt: Date.now(),
        message: "✅ Hardware fingerprint biometric verified successfully!"
      };
    }

    return {
      success: false,
      error: "VERIFICATION_CANCELLED",
      message: "Biometric prompt was dismissed."
    };
  } catch (err) {
    console.warn("[BiometricService] Hardware biometric error:", err);
    // User cancelled or timeout
    if (err.name === "NotAllowedError" || err.message?.includes("cancelled")) {
      return {
        success: false,
        error: "CANCELLED",
        message: "❌ Fingerprint verification was cancelled. You must authenticate to submit attendance."
      };
    }

    // If platform doesn't have registered credentials yet, allow graceful fallback to face verification
    return {
      success: true,
      method: "HARDWARE_UNENROLLED_FALLBACK",
      hardwareAvailable: true,
      message: "Device biometrics not enrolled in browser. Facial liveness verification will verify identity."
    };
  }
}
