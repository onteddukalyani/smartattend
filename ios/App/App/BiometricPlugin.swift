import Foundation
import UIKit
import Capacitor
import LocalAuthentication
import Security

/**
 * SmartAttend Native iOS BiometricPlugin
 *
 * Implements hardware-backed Apple Secure Enclave asymmetric key generation (EC secp256r1 / NIST P-256)
 * and biometric authentication (Face ID / Touch ID) using Apple LocalAuthentication and Security frameworks.
 *
 * Enforces:
 * - Hardware Secure Enclave key generation (kSecAttrTokenIDSecureEnclave)
 * - Strict biometric-only access control (.biometryCurrentSet)
 * - Automatic permanent key invalidation when Face ID / Touch ID enrollment changes in iOS Settings
 * - Zero device passcode fallback
 * - Canonical X.509 SubjectPublicKeyInfo DER public-key export
 * - Canonical ANSI X9.62 ASN.1 DER ECDSA challenge signing
 */
@objc(BiometricPlugin)
public class BiometricPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BiometricPlugin"
    public let jsName = "BiometricPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isHardwareAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createBiometricKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signChallenge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBiometricKeyStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteBiometricKey", returnType: CAPPluginReturnPromise)
    ]

    private let tagPrefix = "com.smartattend.biometric."

    // Fixed 26-byte ASN.1 SubjectPublicKeyInfo header for NIST P-256 (secp256r1)
    // SEQUENCE { SEQUENCE { OID ecPublicKey, OID prime256v1 }, BIT STRING uncompressed point }
    private let p256X509Header = Data([
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
        0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
    ])

    /**
     * Checks device biometric hardware capability and enrollment status via LocalAuthentication.
     */
    @objc func isHardwareAvailable(_ call: CAPPluginCall) {
        let context = LAContext()
        var authError: NSError?
        let canAuth = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError)

        var biometryType = "NONE"
        if #available(iOS 11.0, *) {
            switch context.biometryType {
            case .faceID:
                biometryType = "FACE_ID"
            case .touchID:
                biometryType = "TOUCH_ID"
            case .opticID:
                biometryType = "OPTIC_ID"
            default:
                biometryType = "NONE"
            }
        }

        var ret: [String: Any] = [
            "isNative": true,
            "platform": "ios",
            "biometryType": biometryType,
            "deviceModel": UIDevice.current.model,
            "systemVersion": UIDevice.current.systemVersion
        ]

        if canAuth {
            ret["isAvailable"] = true
            ret["enrolled"] = true
            ret["status"] = "BIOMETRIC_SUCCESS"
            ret["message"] = "Apple \(biometryType) biometric sensor is available and enrolled."
        } else {
            ret["isAvailable"] = false
            let errorCode = authError?.code ?? 0
            switch errorCode {
            case LAError.biometryNotEnrolled.rawValue:
                ret["enrolled"] = false
                ret["status"] = "BIOMETRIC_ERROR_NONE_ENROLLED"
                ret["message"] = "Biometric hardware detected, but no Face ID / Touch ID enrolled in iOS Settings."
            case LAError.biometryNotAvailable.rawValue:
                ret["enrolled"] = false
                ret["status"] = "BIOMETRIC_ERROR_NO_HARDWARE"
                ret["message"] = "No biometric hardware or Secure Enclave available on this device."
            case LAError.biometryLockout.rawValue:
                ret["enrolled"] = true
                ret["status"] = "BIOMETRIC_LOCKOUT"
                ret["message"] = "Biometrics are locked due to multiple failed attempts. Device passcode required to re-enable."
            default:
                ret["enrolled"] = false
                ret["status"] = "BIOMETRIC_ERROR_\(errorCode)"
                ret["message"] = authError?.localizedDescription ?? "Biometric check failed."
            }
        }

        call.resolve(ret)
    }

    /**
     * Generates an EC secp256r1 keypair in the Apple Secure Enclave requiring biometrics per use,
     * invalidating permanently if new biometric appearances/fingerprints are added in iOS Settings.
     * Prompts Face ID / Touch ID to sign an enrollment challenge to authorize the key.
     */
    @objc func createBiometricKey(_ call: CAPPluginCall) {
        guard let keyAlias = call.getString("keyAlias"), !keyAlias.trimmingCharacters(in: .whitespaces).isEmpty else {
            call.reject("Key alias is required", "INVALID_ARGUMENT")
            return
        }
        guard let challenge = call.getString("challenge"), !challenge.trimmingCharacters(in: .whitespaces).isEmpty else {
            call.reject("Enrollment challenge is required", "INVALID_ARGUMENT")
            return
        }
        let promptTitle = call.getString("promptTitle") ?? "SmartAttend Biometric Registration"

        let tagString = tagPrefix + keyAlias
        guard let tagData = tagString.data(using: .utf8) else {
            call.reject("Failed to encode key tag", "ENCODING_ERROR")
            return
        }

        // Delete any existing key with same tag to ensure fresh enrollment
        deleteKeyFromKeychain(tagData: tagData)

        // Enforce Secure Enclave access control: strictly biometryCurrentSet (no passcode fallback)
        var accessError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            [.biometryCurrentSet, .privateKeyUsage],
            &accessError
        ) else {
            let errStr = (accessError?.takeRetainedValue() as Error?)?.localizedDescription ?? "Unknown"
            call.reject("Failed to create Secure Enclave access control: \(errStr)", "ACCESS_CONTROL_FAILED")
            return
        }

        let keyAttributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave, // Strict: hardware Secure Enclave only
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tagData,
                kSecAttrAccessControl as String: accessControl
            ]
        ]

        var keyGenError: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(keyAttributes as CFDictionary, &keyGenError) else {
            let errStr = (keyGenError?.takeRetainedValue() as Error?)?.localizedDescription ?? "Unknown"
            call.reject("Secure Enclave key generation failed: \(errStr)", "KEY_GENERATION_FAILED")
            return
        }

        // Retrieve public key and export in canonical X.509 SubjectPublicKeyInfo DER
        guard let publicKey = SecKeyCopyPublicKey(privateKey),
              let rawPublicKeyData = SecKeyCopyExternalRepresentation(publicKey, &keyGenError) as Data? else {
            deleteKeyFromKeychain(tagData: tagData)
            call.reject("Failed to export Secure Enclave public key", "KEY_EXPORT_FAILED")
            return
        }

        // Prepend 26-byte ASN.1 header to 65-byte uncompressed point
        var x509Der = Data()
        x509Der.append(p256X509Header)
        x509Der.append(rawPublicKeyData)
        let pubKeyBase64 = x509Der.base64EncodedString()

        // Sign enrollment challenge to authorize initial registration
        guard let challengeData = challenge.data(using: .utf8) else {
            deleteKeyFromKeychain(tagData: tagData)
            call.reject("Challenge string cannot be UTF-8 encoded", "INVALID_ARGUMENT")
            return
        }

        // Configure authentication context with prompt message
        let context = LAContext()
        context.localizedReason = promptTitle

        var signError: Unmanaged<CFError>?
        guard let signatureData = SecKeyCreateSignature(
            privateKey,
            .ecdsaSignatureMessageX962SHA256,
            challengeData as CFData,
            &signError
        ) as Data? else {
            // If user cancels or biometrics fail, purge newly generated key
            deleteKeyFromKeychain(tagData: tagData)
            let err = signError?.takeRetainedValue() as Error?
            handleSigningError(err, call: call)
            return
        }

        let signatureBase64 = signatureData.base64EncodedString()

        call.resolve([
            "success": true,
            "keyAlias": keyAlias,
            "publicKey": pubKeyBase64,
            "algorithm": "ECDSA_P256_SHA256",
            "signature": signatureBase64,
            "isInsideSecureHardware": true,
            "deviceModel": UIDevice.current.model,
            "systemVersion": UIDevice.current.systemVersion
        ])
    }

    /**
     * Signs a server-issued challenge using an existing Secure Enclave biometric-bound private key.
     * Triggers Face ID / Touch ID; fails on user cancellation, lockout, or key invalidation.
     */
    @objc func signChallenge(_ call: CAPPluginCall) {
        guard let keyAlias = call.getString("keyAlias"), !keyAlias.trimmingCharacters(in: .whitespaces).isEmpty else {
            call.reject("Key alias is required", "INVALID_ARGUMENT")
            return
        }
        guard let challenge = call.getString("challenge"), !challenge.trimmingCharacters(in: .whitespaces).isEmpty else {
            call.reject("Challenge is required", "INVALID_ARGUMENT")
            return
        }
        let promptTitle = call.getString("promptTitle") ?? "SmartAttend Attendance Verification"

        let tagString = tagPrefix + keyAlias
        guard let tagData = tagString.data(using: .utf8) else {
            call.reject("Invalid key alias encoding", "INVALID_ARGUMENT")
            return
        }

        guard let privateKey = loadKeyFromKeychain(tagData: tagData) else {
            call.reject("Biometric key not found for alias: \(keyAlias)", "KEY_NOT_FOUND")
            return
        }

        guard let challengeData = challenge.data(using: .utf8) else {
            call.reject("Invalid challenge encoding", "INVALID_ARGUMENT")
            return
        }

        let context = LAContext()
        context.localizedReason = promptTitle

        var signError: Unmanaged<CFError>?
        guard let signatureData = SecKeyCreateSignature(
            privateKey,
            .ecdsaSignatureMessageX962SHA256,
            challengeData as CFData,
            &signError
        ) as Data? else {
            let err = signError?.takeRetainedValue() as Error?
            handleSigningError(err, call: call)
            return
        }

        let signatureBase64 = signatureData.base64EncodedString()

        call.resolve([
            "success": true,
            "keyAlias": keyAlias,
            "signature": signatureBase64,
            "algorithm": "ECDSA_P256_SHA256"
        ])
    }

    /**
     * Checks if a key exists in Keychain and retrieves public key info.
     */
    @objc func getBiometricKeyStatus(_ call: CAPPluginCall) {
        guard let keyAlias = call.getString("keyAlias"), !keyAlias.trimmingCharacters(in: .whitespaces).isEmpty else {
            call.reject("Key alias is required", "INVALID_ARGUMENT")
            return
        }

        let tagString = tagPrefix + keyAlias
        guard let tagData = tagString.data(using: .utf8) else {
            call.reject("Invalid key alias encoding", "INVALID_ARGUMENT")
            return
        }

        guard let privateKey = loadKeyFromKeychain(tagData: tagData) else {
            call.resolve([
                "exists": false,
                "keyAlias": keyAlias,
                "isInsideSecureHardware": false,
                "isPermanentlyInvalidated": false
            ])
            return
        }

        var keyError: Unmanaged<CFError>?
        guard let publicKey = SecKeyCopyPublicKey(privateKey),
              let rawKeyData = SecKeyCopyExternalRepresentation(publicKey, &keyError) as Data? else {
            call.resolve([
                "exists": true,
                "keyAlias": keyAlias,
                "isInsideSecureHardware": true,
                "isPermanentlyInvalidated": true
            ])
            return
        }

        var x509Der = Data()
        x509Der.append(p256X509Header)
        x509Der.append(rawKeyData)

        call.resolve([
            "exists": true,
            "keyAlias": keyAlias,
            "publicKey": x509Der.base64EncodedString(),
            "isInsideSecureHardware": true,
            "isPermanentlyInvalidated": false
        ])
    }

    /**
     * Deletes a biometric key from Keychain.
     */
    @objc func deleteBiometricKey(_ call: CAPPluginCall) {
        guard let keyAlias = call.getString("keyAlias"), !keyAlias.trimmingCharacters(in: .whitespaces).isEmpty else {
            call.reject("Key alias is required", "INVALID_ARGUMENT")
            return
        }

        let tagString = tagPrefix + keyAlias
        guard let tagData = tagString.data(using: .utf8) else {
            call.reject("Invalid key alias encoding", "INVALID_ARGUMENT")
            return
        }

        let deleted = deleteKeyFromKeychain(tagData: tagData)
        call.resolve([
            "success": true,
            "deleted": deleted,
            "keyAlias": keyAlias
        ])
    }

    // ── Internal Helpers ────────────────────────────────────────────────────────

    private func loadKeyFromKeychain(tagData: Data) -> SecKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tagData,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let keyRef = item else {
            return nil
        }
        return (keyRef as! SecKey)
    }

    @discardableResult
    private func deleteKeyFromKeychain(tagData: Data) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tagData
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess
    }

    private func handleSigningError(_ error: Error?, call: CAPPluginCall) {
        guard let nsError = error as NSError? else {
            call.reject("Biometric signing failed with unknown error", "SIGNING_FAILED")
            return
        }

        // Check for user cancellation (errSecUserCanceled = -128)
        if nsError.domain == NSOSStatusErrorDomain && nsError.code == errSecUserCanceled {
            call.reject("Biometric authentication was cancelled by user.", "BIOMETRIC_CANCELLED")
            return
        }

        // Check for permanent biometric invalidation (errSecAuthFailed = -25293)
        // With .biometryCurrentSet, any change in Face ID / Touch ID enrolled in OS permanently invalidates the key
        if nsError.domain == NSOSStatusErrorDomain && nsError.code == errSecAuthFailed {
            call.reject(
                "Biometric enrollment has changed on this device. The cryptographic key has been permanently invalidated by the Secure Enclave. Please re-enroll in Settings.",
                "KEY_PERMANENTLY_INVALIDATED"
            )
            return
        }

        call.reject("Biometric signature error: \(nsError.localizedDescription) (Code: \(nsError.code))", "SIGNING_FAILED")
    }
}
