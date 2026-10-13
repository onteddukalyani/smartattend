const crypto = require("crypto");
const assert = require("assert");

function derToPem(derBase64) {
  const clean = derBase64.replace(/\s+/g, "");
  const lines = [];
  for (let i = 0; i < clean.length; i += 64) {
    lines.push(clean.substring(i, i + 64));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

function verifyEcdsaSignature(derBase64Key, challengeText, signatureHex) {
  try {
    const pem = derToPem(derBase64Key);
    const verify = crypto.createVerify("SHA256");
    verify.update(Buffer.from(challengeText, "utf8"));
    return verify.verify(pem, Buffer.from(signatureHex, "hex"));
  } catch (err) {
    console.warn("Signature verification error:", err.message);
    return false;
  }
}

// 1. Generate standard prime256v1 (P-256) keypair
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});

// Export DER SPKI Base64 (same format as Android Keystore & iOS Secure Enclave with ASN.1 header)
const derSpkiBuffer = publicKey.export({ type: "spki", format: "der" });
const derSpkiBase64 = derSpkiBuffer.toString("base64");
console.log("SPKI DER buffer length:", derSpkiBuffer.length, "bytes (Expected: 91)");
assert.strictEqual(derSpkiBuffer.length, 91, "X.509 SPKI DER for P-256 should be exactly 91 bytes");

// 2. Generate a 32-byte hex challenge string (64 characters)
const challengeText = crypto.randomBytes(32).toString("hex");
console.log("Challenge text (64 hex chars):", challengeText);

// 3. Sign UTF-8 bytes of the challenge (matching Android and iOS native behavior)
const signer = crypto.createSign("SHA256");
signer.update(Buffer.from(challengeText, "utf8"));
const signatureDerBuffer = signer.sign(privateKey);
const signatureHex = signatureDerBuffer.toString("hex");
console.log("Signature hex length:", signatureHex.length, "chars (~140-144 chars for DER)");

// 4. Verify valid signature
const isValid = verifyEcdsaSignature(derSpkiBase64, challengeText, signatureHex);
console.log("Verification result with valid signature:", isValid);
assert.strictEqual(isValid, true, "Signature must verify successfully");

// 5. Verify that tampered challenge is rejected
const tamperedChallenge = challengeText.substring(0, 62) + "aa";
const isTamperedValid = verifyEcdsaSignature(derSpkiBase64, tamperedChallenge, signatureHex);
console.log("Verification result with tampered challenge:", isTamperedValid);
assert.strictEqual(isTamperedValid, false, "Tampered challenge must fail verification");

// 6. Verify that wrong key is rejected
const otherKeyPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const otherDerSpki = otherKeyPair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const isWrongKeyValid = verifyEcdsaSignature(otherDerSpki, challengeText, signatureHex);
console.log("Verification result with wrong key:", isWrongKeyValid);
assert.strictEqual(isWrongKeyValid, false, "Signature with wrong key must fail verification");

// 7. Verify iOS ASN.1 reconstruction:
// iOS SecKeyCopyExternalRepresentation gives 65-byte uncompressed point (04 || X || Y)
// Prepended 26-byte ASN.1 header:
const iosRaw65Point = derSpkiBuffer.subarray(26);
assert.strictEqual(iosRaw65Point.length, 65, "Raw EC point must be 65 bytes");
const p256Asn1Header = Buffer.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
]);
const reconstructedDer = Buffer.concat([p256Asn1Header, iosRaw65Point]);
assert.deepStrictEqual(reconstructedDer, derSpkiBuffer, "Reconstructed iOS DER must match SPKI DER exactly");
const isIosReconstructedValid = verifyEcdsaSignature(reconstructedDer.toString("base64"), challengeText, signatureHex);
assert.strictEqual(isIosReconstructedValid, true, "Reconstructed iOS key must verify signature perfectly");

console.log("ALL CRYPTOGRAPHIC LOGIC VERIFIED SUCCESSFULLY!");
