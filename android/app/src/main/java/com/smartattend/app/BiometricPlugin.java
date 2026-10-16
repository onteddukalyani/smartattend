package com.smartattend.app;

import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.concurrent.Executor;

/**
 * SmartAttend Native Android BiometricPlugin
 * 
 * Provides hardware-backed Android Keystore asymmetric key generation (EC secp256r1)
 * and Class 3 BIOMETRIC_STRONG (Fingerprint) authentication using AndroidX BiometricPrompt.
 * 
 * Enforces per-use biometric authorization, hardware invalidation on enrollment change,
 * and strict prohibition of lock-screen PIN/pattern fallback.
 */
@CapacitorPlugin(name = "BiometricPlugin")
public class BiometricPlugin extends Plugin {

    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String SIGNATURE_ALGORITHM = "SHA256withECDSA";
    private static final String KEY_ALGORITHM_SPEC = "secp256r1";

    /**
     * Checks device hardware biometric capability and enrolled fingerprint status.
     * Evaluates Class 3 BIOMETRIC_STRONG authenticators without fallback.
     */
    @PluginMethod
    public void isHardwareAvailable(PluginCall call) {
        try {
            BiometricManager biometricManager = BiometricManager.from(getContext());
            int canAuth = biometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);

            JSObject ret = new JSObject();
            ret.put("isNativeAndroid", true);

            switch (canAuth) {
                case BiometricManager.BIOMETRIC_SUCCESS:
                    ret.put("isAvailable", true);
                    ret.put("enrolled", true);
                    ret.put("status", "BIOMETRIC_SUCCESS");
                    ret.put("message", "Class 3 strong hardware biometric sensor is ready and fingerprints are enrolled.");
                    break;
                case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                    ret.put("isAvailable", false);
                    ret.put("enrolled", false);
                    ret.put("status", "BIOMETRIC_ERROR_NONE_ENROLLED");
                    ret.put("message", "Biometric sensor hardware detected, but no fingerprints are enrolled in Android Settings.");
                    break;
                case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                    ret.put("isAvailable", false);
                    ret.put("enrolled", false);
                    ret.put("status", "BIOMETRIC_ERROR_NO_HARDWARE");
                    ret.put("message", "No Class 3 hardware biometric sensor is present on this device.");
                    break;
                case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                    ret.put("isAvailable", false);
                    ret.put("enrolled", false);
                    ret.put("status", "BIOMETRIC_ERROR_HW_UNAVAILABLE");
                    ret.put("message", "Biometric hardware is temporarily unavailable or locked out.");
                    break;
                case BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED:
                    ret.put("isAvailable", false);
                    ret.put("enrolled", false);
                    ret.put("status", "BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED");
                    ret.put("message", "Android security update required to use hardware biometric sensor.");
                    break;
                default:
                    ret.put("isAvailable", false);
                    ret.put("enrolled", false);
                    ret.put("status", "BIOMETRIC_ERROR_UNKNOWN");
                    ret.put("message", "Biometric sensor returned status code: " + canAuth);
                    break;
            }

            ret.put("deviceModel", Build.MANUFACTURER + " " + Build.MODEL);
            ret.put("sdkVersion", Build.VERSION.SDK_INT);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to check biometric availability: " + e.getMessage(), "ERROR_CHECK_FAILED", e);
        }
    }

    /**
     * Generates an EC secp256r1 keypair in AndroidKeyStore requiring Class 3 biometric per use,
     * invalidating permanently if new fingerprints are enrolled in the OS.
     * Prompts BiometricPrompt to sign an enrollment challenge to authorize the key.
     */
    @PluginMethod
    public void createBiometricKey(PluginCall call) {
        String keyAlias = call.getString("keyAlias");
        String challenge = call.getString("challenge");
        String promptTitle = call.getString("promptTitle", "SmartAttend Fingerprint Registration");
        String promptSubtitle = call.getString("promptSubtitle", "Touch the fingerprint sensor to bind this device to your student account");

        if (keyAlias == null || keyAlias.trim().isEmpty()) {
            call.reject("Key alias is required", "INVALID_ARGUMENT");
            return;
        }

        if (challenge == null || challenge.trim().isEmpty()) {
            call.reject("Enrollment challenge is required", "INVALID_ARGUMENT");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                // Verify hardware status before key generation
                BiometricManager biometricManager = BiometricManager.from(getContext());
                int canAuth = biometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
                if (canAuth != BiometricManager.BIOMETRIC_SUCCESS) {
                    String msg;
                    String code;
                    switch (canAuth) {
                        case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                            code = "BIOMETRIC_NONE_ENROLLED";
                            msg = "No fingerprints enrolled on this phone. Please add a fingerprint in your phone's Settings > Security > Fingerprint, then return to SmartAttend.";
                            break;
                        case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                            code = "BIOMETRIC_NO_HARDWARE";
                            msg = "No biometric hardware sensor detected on this device.";
                            break;
                        case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                            code = "BIOMETRIC_HW_UNAVAILABLE";
                            msg = "Biometric sensor is temporarily busy or unavailable. Please try again in a moment.";
                            break;
                        case BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED:
                            code = "BIOMETRIC_SECURITY_UPDATE_REQUIRED";
                            msg = "A system security update is required to use the biometric sensor.";
                            break;
                        default:
                            code = "BIOMETRIC_UNAVAILABLE";
                            msg = "Biometric authentication is unavailable on this device (Code: " + canAuth + ").";
                            break;
                    }
                    call.reject(msg, code);
                    return;
                }

                KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
                keyStore.load(null);

                // If key already exists, delete it first to ensure fresh enrollment
                if (keyStore.containsAlias(keyAlias)) {
                    keyStore.deleteEntry(keyAlias);
                }

                // Provision new EC secp256r1 KeyPair
                KeyPairGenerator kpg = KeyPairGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_EC,
                    ANDROID_KEYSTORE
                );

                KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
                    keyAlias,
                    KeyProperties.PURPOSE_SIGN
                )
                .setAlgorithmParameterSpec(new ECGenParameterSpec(KEY_ALGORITHM_SPEC))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
                } else {
                    builder.setUserAuthenticationValidityDurationSeconds(-1);
                }

                kpg.initialize(builder.build());
                kpg.generateKeyPair();

                // Retrieve generated Public Key
                PublicKey publicKey = keyStore.getCertificate(keyAlias).getPublicKey();
                byte[] pubKeyEncoded = publicKey.getEncoded();
                String pubKeyBase64 = Base64.encodeToString(pubKeyEncoded, Base64.NO_WRAP);

                // Verify whether hardware actually resides in secure hardware (TEE / StrongBox)
                boolean secureHardware = false;
                try {
                    KeyFactory keyFactory = KeyFactory.getInstance(publicKey.getAlgorithm(), ANDROID_KEYSTORE);
                    KeyInfo keyInfo = keyFactory.getKeySpec(publicKey, KeyInfo.class);
                    secureHardware = keyInfo.isInsideSecureHardware();
                } catch (Exception ignored) {
                    // KeyInfo inspection can vary across Android vendor implementations
                }
                final boolean isInsideSecureHardware = secureHardware;

                // Prepare signature object with new private key
                PrivateKey privateKey = (PrivateKey) keyStore.getKey(keyAlias, null);
                Signature signature = Signature.getInstance(SIGNATURE_ALGORITHM);
                signature.initSign(privateKey);

                BiometricPrompt.CryptoObject cryptoObject = new BiometricPrompt.CryptoObject(signature);

                // Present BiometricPrompt to authorize the enrollment challenge
                promptBiometricAuthentication(
                    promptTitle,
                    promptSubtitle,
                    cryptoObject,
                    challenge,
                    new BiometricAuthCallback() {
                        @Override
                        public void onSuccess(String signatureBase64) {
                            JSObject ret = new JSObject();
                            ret.put("success", true);
                            ret.put("keyAlias", keyAlias);
                            ret.put("publicKey", pubKeyBase64);
                            ret.put("algorithm", "ECDSA_P256_SHA256");
                            ret.put("signature", signatureBase64);
                            ret.put("isInsideSecureHardware", isInsideSecureHardware);
                            ret.put("deviceModel", Build.MANUFACTURER + " " + Build.MODEL);
                            ret.put("sdkVersion", Build.VERSION.SDK_INT);
                            call.resolve(ret);
                        }

                        @Override
                        public void onError(String errorCode, String errorMessage) {
                            // If enrollment challenge was cancelled or failed, clean up orphaned key
                            try {
                                keyStore.deleteEntry(keyAlias);
                            } catch (Exception ignored) {}
                            call.reject(errorMessage, errorCode);
                        }
                    }
                );
            } catch (Exception e) {
                call.reject("Failed to create biometric key: " + e.getMessage(), "KEY_GENERATION_FAILED", e);
            }
        });
    }

    /**
     * Signs a server-issued challenge using an existing biometric-bound private key.
     * Requires Class 3 biometric unlock; fails on user cancellation, lockout, or key invalidation.
     */
    @PluginMethod
    public void signChallenge(PluginCall call) {
        String keyAlias = call.getString("keyAlias");
        String challenge = call.getString("challenge");
        String promptTitle = call.getString("promptTitle", "SmartAttend Attendance Verification");
        String promptSubtitle = call.getString("promptSubtitle", "Touch the fingerprint sensor to sign attendance proof");

        if (keyAlias == null || keyAlias.trim().isEmpty()) {
            call.reject("Key alias is required", "INVALID_ARGUMENT");
            return;
        }

        if (challenge == null || challenge.trim().isEmpty()) {
            call.reject("Challenge is required", "INVALID_ARGUMENT");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
                keyStore.load(null);

                if (!keyStore.containsAlias(keyAlias)) {
                    call.reject("Biometric key not found for alias: " + keyAlias, "KEY_NOT_FOUND");
                    return;
                }

                PrivateKey privateKey = (PrivateKey) keyStore.getKey(keyAlias, null);
                if (privateKey == null) {
                    call.reject("Private key unavailable in Keystore", "KEY_NOT_FOUND");
                    return;
                }

                Signature signature = Signature.getInstance(SIGNATURE_ALGORITHM);

                try {
                    signature.initSign(privateKey);
                } catch (KeyPermanentlyInvalidatedException e) {
                    // Biometric enrollment has changed in Android Settings since key creation
                    call.reject(
                        "Biometric enrollment has changed on this device. The cryptographic key has been permanently invalidated by the hardware keystore. Please re-enroll in Settings.",
                        "KEY_PERMANENTLY_INVALIDATED",
                        e
                    );
                    return;
                }

                BiometricPrompt.CryptoObject cryptoObject = new BiometricPrompt.CryptoObject(signature);

                promptBiometricAuthentication(
                    promptTitle,
                    promptSubtitle,
                    cryptoObject,
                    challenge,
                    new BiometricAuthCallback() {
                        @Override
                        public void onSuccess(String signatureBase64) {
                            JSObject ret = new JSObject();
                            ret.put("success", true);
                            ret.put("keyAlias", keyAlias);
                            ret.put("signature", signatureBase64);
                            ret.put("algorithm", "ECDSA_P256_SHA256");
                            call.resolve(ret);
                        }

                        @Override
                        public void onError(String errorCode, String errorMessage) {
                            call.reject(errorMessage, errorCode);
                        }
                    }
                );
            } catch (KeyPermanentlyInvalidatedException e) {
                call.reject("Cryptographic key permanently invalidated by new OS biometric enrollment.", "KEY_PERMANENTLY_INVALIDATED", e);
            } catch (Exception e) {
                call.reject("Biometric signing error: " + e.getMessage(), "SIGNING_FAILED", e);
            }
        });
    }

    /**
     * Checks if a key exists in AndroidKeyStore and verifies its status.
     */
    @PluginMethod
    public void getBiometricKeyStatus(PluginCall call) {
        String keyAlias = call.getString("keyAlias");
        if (keyAlias == null || keyAlias.trim().isEmpty()) {
            call.reject("Key alias is required", "INVALID_ARGUMENT");
            return;
        }

        try {
            KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
            keyStore.load(null);

            JSObject ret = new JSObject();
            boolean exists = keyStore.containsAlias(keyAlias);
            ret.put("exists", exists);
            ret.put("keyAlias", keyAlias);

            if (exists) {
                try {
                    PublicKey publicKey = keyStore.getCertificate(keyAlias).getPublicKey();
                    byte[] pubKeyEncoded = publicKey.getEncoded();
                    ret.put("publicKey", Base64.encodeToString(pubKeyEncoded, Base64.NO_WRAP));

                    KeyFactory keyFactory = KeyFactory.getInstance(publicKey.getAlgorithm(), ANDROID_KEYSTORE);
                    KeyInfo keyInfo = keyFactory.getKeySpec(publicKey, KeyInfo.class);
                    ret.put("isInsideSecureHardware", keyInfo.isInsideSecureHardware());
                    ret.put("isPermanentlyInvalidated", false);
                } catch (Exception e) {
                    ret.put("isInsideSecureHardware", false);
                    ret.put("isPermanentlyInvalidated", e instanceof KeyPermanentlyInvalidatedException);
                }
            } else {
                ret.put("isInsideSecureHardware", false);
                ret.put("isPermanentlyInvalidated", false);
            }

            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to inspect key status: " + e.getMessage(), "INSPECTION_FAILED", e);
        }
    }

    /**
     * Deletes a biometric key from AndroidKeyStore upon revocation.
     */
    @PluginMethod
    public void deleteBiometricKey(PluginCall call) {
        String keyAlias = call.getString("keyAlias");
        if (keyAlias == null || keyAlias.trim().isEmpty()) {
            call.reject("Key alias is required", "INVALID_ARGUMENT");
            return;
        }

        try {
            KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
            keyStore.load(null);

            boolean existed = keyStore.containsAlias(keyAlias);
            if (existed) {
                keyStore.deleteEntry(keyAlias);
            }

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("deleted", existed);
            ret.put("keyAlias", keyAlias);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to delete key: " + e.getMessage(), "DELETE_FAILED", e);
        }
    }

    /**
     * Opens system biometric or security settings to allow the user to enroll a fingerprint.
     */
    @PluginMethod
    public void openBiometricSettings(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                Intent intent;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    intent = new Intent(Settings.ACTION_BIOMETRIC_ENROLL);
                    intent.putExtra(
                        Settings.EXTRA_BIOMETRIC_AUTHENTICATORS_ALLOWED,
                        BiometricManager.Authenticators.BIOMETRIC_STRONG
                    );
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    intent = new Intent(Settings.ACTION_FINGERPRINT_ENROLL);
                } else {
                    intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
                }
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                JSObject ret = new JSObject();
                ret.put("success", true);
                call.resolve(ret);
            } catch (Exception e) {
                try {
                    Intent fallback = new Intent(Settings.ACTION_SECURITY_SETTINGS);
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(fallback);
                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    call.resolve(ret);
                } catch (Exception e2) {
                    call.reject("Failed to open device security settings: " + e2.getMessage(), "INTENT_FAILED", e2);
                }
            }
        });
    }

    // ── Helper: Internal BiometricPrompt Presentation ────────────────────────

    private interface BiometricAuthCallback {
        void onSuccess(String signatureBase64);
        void onError(String errorCode, String errorMessage);
    }

    private void promptBiometricAuthentication(
        String title,
        String subtitle,
        BiometricPrompt.CryptoObject cryptoObject,
        String challengeText,
        BiometricAuthCallback callback
    ) {
        FragmentActivity activity = (FragmentActivity) getActivity();
        Executor executor = ContextCompat.getMainExecutor(activity);

        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText("Cancel")
            .build();

        BiometricPrompt biometricPrompt = new BiometricPrompt(activity, executor, new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                super.onAuthenticationError(errorCode, errString);
                String code;
                switch (errorCode) {
                    case BiometricPrompt.ERROR_USER_CANCELED:
                    case BiometricPrompt.ERROR_NEGATIVE_BUTTON:
                    case BiometricPrompt.ERROR_CANCELED:
                        code = "BIOMETRIC_CANCELLED";
                        break;
                    case BiometricPrompt.ERROR_LOCKOUT:
                    case BiometricPrompt.ERROR_LOCKOUT_PERMANENT:
                        code = "BIOMETRIC_LOCKOUT";
                        break;
                    case BiometricPrompt.ERROR_NO_BIOMETRICS:
                        code = "BIOMETRIC_NONE_ENROLLED";
                        break;
                    case BiometricPrompt.ERROR_HW_NOT_PRESENT:
                    case BiometricPrompt.ERROR_HW_UNAVAILABLE:
                        code = "BIOMETRIC_HARDWARE_UNAVAILABLE";
                        break;
                    case BiometricPrompt.ERROR_TIMEOUT:
                        code = "BIOMETRIC_TIMEOUT";
                        break;
                    default:
                        code = "BIOMETRIC_ERROR_" + errorCode;
                        break;
                }
                callback.onError(code, errString.toString());
            }

            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                super.onAuthenticationSucceeded(result);
                try {
                    BiometricPrompt.CryptoObject co = result.getCryptoObject();
                    if (co == null || co.getSignature() == null) {
                        callback.onError("CRYPTO_ERROR", "CryptoObject or Signature missing from biometric result.");
                        return;
                    }

                    Signature sig = co.getSignature();
                    byte[] challengeBytes = challengeText.getBytes(StandardCharsets.UTF_8);
                    sig.update(challengeBytes);
                    byte[] signatureBytes = sig.sign();
                    String signatureBase64 = Base64.encodeToString(signatureBytes, Base64.NO_WRAP);

                    callback.onSuccess(signatureBase64);
                } catch (Exception e) {
                    callback.onError("SIGNING_ERROR", "Failed to sign challenge with unlocked private key: " + e.getMessage());
                }
            }

            @Override
            public void onAuthenticationFailed() {
                super.onAuthenticationFailed();
                // Individual fingerprint mismatch - BiometricPrompt remains open on device for retry
            }
        });

        biometricPrompt.authenticate(promptInfo, cryptoObject);
    }
}
