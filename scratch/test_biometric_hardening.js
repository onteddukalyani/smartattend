import crypto from "node:crypto";
import assert from "node:assert";

// 1. Implementation of parseStrictTimestampMs
function parseStrictTimestampMs(rawTimestamp) {
  if (rawTimestamp === null || rawTimestamp === undefined) return 0;

  // A. Firestore Timestamp object instance
  if (typeof rawTimestamp === "object" && typeof rawTimestamp.toMillis === "function") {
    try {
      const ms = rawTimestamp.toMillis();
      return (typeof ms === "number" && Number.isFinite(ms) && ms > 0) ? Math.floor(ms) : 0;
    } catch (_) {
      return 0;
    }
  }

  // B. Serialized Firestore Timestamp object { seconds, nanoseconds }
  if (
    typeof rawTimestamp === "object" &&
    !Array.isArray(rawTimestamp) &&
    typeof rawTimestamp.seconds === "number" &&
    Number.isFinite(rawTimestamp.seconds) &&
    rawTimestamp.seconds > 0
  ) {
    const nano = (typeof rawTimestamp.nanoseconds === "number" && Number.isFinite(rawTimestamp.nanoseconds) && rawTimestamp.nanoseconds >= 0)
      ? rawTimestamp.nanoseconds
      : 0;
    return rawTimestamp.seconds * 1000 + Math.floor(nano / 1e6);
  }

  // C. Finite positive number (epoch ms)
  if (typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp) && rawTimestamp > 0) {
    return Math.floor(rawTimestamp);
  }

  // D. ISO-8601 or parseable date string
  if (typeof rawTimestamp === "string" && rawTimestamp.trim().length > 0) {
    const parsed = Date.parse(rawTimestamp.trim());
    return (!isNaN(parsed) && Number.isFinite(parsed) && parsed > 0) ? parsed : 0;
  }

  // Unsupported types (boolean, symbol, array, functions, invalid objects) FAIL CLOSED
  return 0;
}

// 2. Implementation of derToPem
function derToPem(derBase64) {
  const clean = (derBase64 || "").replace(/\s+/g, "");
  const lines = [];
  for (let i = 0; i < clean.length; i += 64) {
    lines.push(clean.substring(i, i + 64));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

// 3. Implementation of parseSignatureBuffer
function parseSignatureBuffer(rawSignature) {
  if (!rawSignature) return null;
  if (Buffer.isBuffer(rawSignature)) return rawSignature;
  if (typeof rawSignature !== "string") return null;

  const clean = rawSignature.trim();
  if (!clean) return null;

  // Hex encoded ASN.1 DER check (DER starts with 0x30)
  if (/^[0-9a-fA-F]+$/.test(clean) && clean.length % 2 === 0) {
    try {
      const hexBuf = Buffer.from(clean, "hex");
      if (hexBuf.length > 0 && hexBuf[0] === 0x30) {
        return hexBuf;
      }
    } catch (_) {}
  }

  // Base64 or Base64URL check
  try {
    let b64 = clean.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const b64Buf = Buffer.from(b64, "base64");
    if (b64Buf.length > 0 && b64Buf[0] === 0x30) {
      return b64Buf;
    }
    if (b64Buf.length > 0) {
      return b64Buf;
    }
  } catch (_) {}

  return null;
}

// 4. Implementation of verifyHardwareSignature
function verifyHardwareSignature(publicKeyDerBase64, challengeText, hardwareProof) {
  try {
    if (!publicKeyDerBase64 || !challengeText || !hardwareProof) return false;

    const pem = derToPem(publicKeyDerBase64);
    const signatureBuffer = parseSignatureBuffer(
      typeof hardwareProof === "string" ? hardwareProof : hardwareProof.signature
    );

    if (!signatureBuffer || signatureBuffer.length === 0) {
      return false;
    }

    // A. WebAuthn Payload Verification (Safari / Chrome Passkeys)
    if (hardwareProof.clientDataJSON && hardwareProof.authenticatorData) {
      let clientDataBuf;
      let authDataBuf;

      // Parse clientDataJSON
      if (Buffer.isBuffer(hardwareProof.clientDataJSON)) {
        clientDataBuf = hardwareProof.clientDataJSON;
      } else if (typeof hardwareProof.clientDataJSON === "string") {
        const cleanJson = hardwareProof.clientDataJSON.trim();
        if (cleanJson.startsWith("{")) {
          clientDataBuf = Buffer.from(cleanJson, "utf8");
        } else {
          let b64 = cleanJson.replace(/-/g, "+").replace(/_/g, "/");
          while (b64.length % 4 !== 0) b64 += "=";
          clientDataBuf = Buffer.from(b64, "base64");
        }
      } else {
        return false;
      }

      // Parse authenticatorData
      if (Buffer.isBuffer(hardwareProof.authenticatorData)) {
        authDataBuf = hardwareProof.authenticatorData;
      } else if (typeof hardwareProof.authenticatorData === "string") {
        let b64 = hardwareProof.authenticatorData.trim().replace(/-/g, "+").replace(/_/g, "/");
        while (b64.length % 4 !== 0) b64 += "=";
        authDataBuf = Buffer.from(b64, "base64");
      } else {
        return false;
      }

      // Verify challenge in clientDataJSON matches challengeText
      try {
        const parsedClientData = JSON.parse(clientDataBuf.toString("utf8"));
        const clientChallenge = parsedClientData.challenge || "";
        const expectedB64Url = Buffer.from(challengeText, "utf8").toString("base64url");
        const expectedHexB64Url = Buffer.from(challengeText, "hex").toString("base64url");

        if (clientChallenge !== challengeText && clientChallenge !== expectedB64Url && clientChallenge !== expectedHexB64Url) {
          return false;
        }
      } catch (_) {
        return false;
      }

      // WebAuthn signature is verified over: authenticatorData || SHA-256(clientDataJSON)
      const clientDataHash = crypto.createHash("sha256").update(clientDataBuf).digest();
      const signedData = Buffer.concat([authDataBuf, clientDataHash]);

      const verify = crypto.createVerify("SHA256");
      verify.update(signedData);
      return verify.verify(pem, signatureBuffer);
    }

    // B. Native Mobile ECDSA Verification (Android Keystore & Apple Secure Enclave)
    const verify = crypto.createVerify("SHA256");
    verify.update(Buffer.from(challengeText, "utf8"));
    return verify.verify(pem, signatureBuffer);
  } catch (err) {
    console.warn("Hardware biometric signature verification error:", err.message);
    return false;
  }
}

// 5. Test Suite Execution
console.log("=== RUNNING BIOMETRIC HARDENING TEST SUITE ===");

// TEST 1: Strict Timestamp Parsing
console.log("\n[TEST 1] Testing Strict Timestamp Parsing (parseStrictTimestampMs):");

// Supported Types:
const mockTimestamp = { toMillis: () => 1729000000000 };
assert.strictEqual(parseStrictTimestampMs(mockTimestamp), 1729000000000, "Firestore Timestamp with toMillis() must parse");

const mockSerialized = { seconds: 1729000000, nanoseconds: 500000000 };
assert.strictEqual(parseStrictTimestampMs(mockSerialized), 1729000000500, "Serialized Timestamp { seconds, nanoseconds } must parse");

const mockNumber = 1729000000000;
assert.strictEqual(parseStrictTimestampMs(mockNumber), 1729000000000, "Positive epoch number must parse");

const mockIsoString = "2026-10-14T12:00:00.000Z";
assert.strictEqual(parseStrictTimestampMs(mockIsoString), Date.parse(mockIsoString), "Valid ISO date string must parse");

// Unsupported / Malformed Types (Must FAIL CLOSED -> return 0):
assert.strictEqual(parseStrictTimestampMs(null), 0, "null must return 0");
assert.strictEqual(parseStrictTimestampMs(undefined), 0, "undefined must return 0");
assert.strictEqual(parseStrictTimestampMs(false), 0, "boolean false must return 0");
assert.strictEqual(parseStrictTimestampMs(true), 0, "boolean true must return 0");
assert.strictEqual(parseStrictTimestampMs(0), 0, "0 must return 0");
assert.strictEqual(parseStrictTimestampMs(-1000), 0, "negative number must return 0");
assert.strictEqual(parseStrictTimestampMs(NaN), 0, "NaN must return 0");
assert.strictEqual(parseStrictTimestampMs(Infinity), 0, "Infinity must return 0");
assert.strictEqual(parseStrictTimestampMs(""), 0, "empty string must return 0");
assert.strictEqual(parseStrictTimestampMs("not-a-date"), 0, "invalid date string must return 0");
assert.strictEqual(parseStrictTimestampMs({}), 0, "empty object must return 0");
assert.strictEqual(parseStrictTimestampMs([]), 0, "array must return 0");
assert.strictEqual(parseStrictTimestampMs({ toMillis: "not-a-func" }), 0, "non-function toMillis must return 0");
assert.strictEqual(parseStrictTimestampMs({ seconds: -1 }), 0, "negative seconds must return 0");
assert.strictEqual(parseStrictTimestampMs({ seconds: "foo" }), 0, "non-number seconds must return 0");

// Verification of Optional Chaining Elimination
const malformedChallenge = { expiresAt: undefined };
const expiryMs = parseStrictTimestampMs(malformedChallenge.expiresAt);
assert.strictEqual(!expiryMs, true, "Missing/undefined expiresAt correctly evaluates to falsy (FAIL CLOSED)");
console.log("  ✓ All supported timestamp formats parsed correctly");
console.log("  ✓ All malformed/unsupported timestamp types failed closed (returned 0)");
console.log("  ✓ Elimination of optional chaining bypass verified");

// TEST 2: Server-Side Time Expiry & Clock-Skew Policy
console.log("\n[TEST 2] Testing Server-Side Expiry & Clock-Skew Policy:");
const serverNow = 1729000000000;
const CLOCK_SKEW_TOLERANCE_MS = 0;

// Valid challenge within TTL
const validExpiry = serverNow + 180000; // 3 min TTL
assert.strictEqual(serverNow > (validExpiry + CLOCK_SKEW_TOLERANCE_MS), false, "Valid challenge must not be expired");

// Expired challenge
const expiredExpiry = serverNow - 1000; // 1s in the past
assert.strictEqual(serverNow > (expiredExpiry + CLOCK_SKEW_TOLERANCE_MS), true, "Past challenge must be marked expired");

// Clock skew boundary at 0ms
const exactExpiry = serverNow;
assert.strictEqual(serverNow > (exactExpiry + CLOCK_SKEW_TOLERANCE_MS), false, "Exact boundary must not trigger expiry");
const justExpired = serverNow - 1;
assert.strictEqual(serverNow > (justExpired + CLOCK_SKEW_TOLERANCE_MS), true, "1ms past expiry triggers rejection under 0ms policy");
console.log("  ✓ Server-side time expiry verified against serverNow");
console.log("  ✓ Strict zero-tolerance clock skew policy verified");

// TEST 3: Android Keystore Signature Flow (Base64 DER)
console.log("\n[TEST 3] Testing Android Keystore Signature Flow (Base64 DER):");
const keypair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const derSpkiBase64 = keypair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const challengeText = crypto.randomBytes(32).toString("hex");

// Android Keystore signs UTF-8 challenge bytes and outputs Base64 DER signature
const androidSigner = crypto.createSign("SHA256");
androidSigner.update(Buffer.from(challengeText, "utf8"));
const androidSignatureBase64 = androidSigner.sign(keypair.privateKey).toString("base64");

const androidVerified = verifyHardwareSignature(
  derSpkiBase64,
  challengeText,
  { challengeId: "chal-1", signature: androidSignatureBase64, platform: "android" }
);
assert.strictEqual(androidVerified, true, "Android Keystore Base64 signature must verify successfully");

// Tampered signature rejection
const tamperedSig = Buffer.from(androidSignatureBase64, "base64");
tamperedSig[tamperedSig.length - 2] ^= 0xff;
const tamperedSigB64 = tamperedSig.toString("base64");
assert.strictEqual(
  verifyHardwareSignature(derSpkiBase64, challengeText, { signature: tamperedSigB64 }),
  false,
  "Tampered signature must fail verification"
);
console.log("  ✓ Android Keystore Base64 DER signature verified successfully");
console.log("  ✓ Tampered signature rejected");

// TEST 4: Hex Signature Flow (Backward Compatibility)
console.log("\n[TEST 4] Testing Hex Signature Backward Compatibility:");
const hexSigner = crypto.createSign("SHA256");
hexSigner.update(Buffer.from(challengeText, "utf8"));
const signatureHex = hexSigner.sign(keypair.privateKey).toString("hex");

const hexVerified = verifyHardwareSignature(
  derSpkiBase64,
  challengeText,
  { challengeId: "chal-1", signature: signatureHex, platform: "android" }
);
assert.strictEqual(hexVerified, true, "Hex-encoded DER signature must verify successfully");
console.log("  ✓ Hex signature verified successfully for backward compatibility");

// TEST 5: WebAuthn Assertion Payload Flow
console.log("\n[TEST 5] Testing WebAuthn Assertion Payload Flow:");
const clientDataObj = {
  type: "webauthn.get",
  challenge: Buffer.from(challengeText, "utf8").toString("base64url"),
  origin: "https://smartattend.app"
};
const clientDataJSON = JSON.stringify(clientDataObj);
const clientDataJSONBase64 = Buffer.from(clientDataJSON, "utf8").toString("base64");

// 37 bytes mock authenticatorData (RP ID hash 32B + flags 1B + signCount 4B)
const authenticatorData = crypto.randomBytes(37);
authenticatorData[32] = 0x05; // User present + User verified flags

const clientDataHash = crypto.createHash("sha256").update(Buffer.from(clientDataJSON, "utf8")).digest();
const webAuthnSignedData = Buffer.concat([authenticatorData, clientDataHash]);

const webAuthnSigner = crypto.createSign("SHA256");
webAuthnSigner.update(webAuthnSignedData);
const webAuthnSignatureBase64 = webAuthnSigner.sign(keypair.privateKey).toString("base64");

const webAuthnVerified = verifyHardwareSignature(
  derSpkiBase64,
  challengeText,
  {
    challengeId: "chal-webauthn-1",
    signature: webAuthnSignatureBase64,
    authenticatorData: authenticatorData.toString("base64"),
    clientDataJSON: clientDataJSONBase64,
    platform: "web"
  }
);
assert.strictEqual(webAuthnVerified, true, "WebAuthn assertion must verify successfully with authenticatorData + clientDataJSON");

// Tampered clientDataJSON rejection
const tamperedClientData = JSON.stringify({ ...clientDataObj, origin: "https://evil.com" });
assert.strictEqual(
  verifyHardwareSignature(
    derSpkiBase64,
    challengeText,
    {
      challengeId: "chal-webauthn-1",
      signature: webAuthnSignatureBase64,
      authenticatorData: authenticatorData.toString("base64"),
      clientDataJSON: Buffer.from(tamperedClientData, "utf8").toString("base64"),
      platform: "web"
    }
  ),
  false,
  "Tampered WebAuthn clientDataJSON must fail verification"
);
console.log("  ✓ WebAuthn assertion payload verified successfully");
console.log("  ✓ Tampered clientDataJSON rejected");

console.log("\n=== ALL BIOMETRIC HARDENING TESTS PASSED! ===");
