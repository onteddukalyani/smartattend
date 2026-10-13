import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

console.log("=== RUNNING PHASE 2 TEST SUITE: BIOMETRIC SECURITY & HARDENING ===");

// 1. Test cryptographic functions
function derToPem(derBase64) {
  const clean = (derBase64 || "").replace(/\s+/g, "");
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
    console.warn("ECDSA signature verification error:", err.message);
    return false;
  }
}

console.log("\n[1] Testing ECDSA P-256 Signature Verification:");
// Generate standard prime256v1 (P-256) keypair
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});

const derSpkiBuffer = publicKey.export({ type: "spki", format: "der" });
const derSpkiBase64 = derSpkiBuffer.toString("base64");
assert.strictEqual(derSpkiBuffer.length, 91, "X.509 SPKI DER for P-256 must be exactly 91 bytes");

const challengeText = crypto.randomBytes(32).toString("hex");
assert.strictEqual(challengeText.length, 64, "Challenge text must be 64 hex characters (32 bytes)");

const signer = crypto.createSign("SHA256");
signer.update(Buffer.from(challengeText, "utf8"));
const signatureHex = signer.sign(privateKey).toString("hex");

// Test valid signature
const valid = verifyEcdsaSignature(derSpkiBase64, challengeText, signatureHex);
assert.strictEqual(valid, true, "Valid ECDSA signature must verify");

// Test tampered challenge rejection
const tamperedChallenge = challengeText.slice(0, 62) + "ff";
const tamperedValid = verifyEcdsaSignature(derSpkiBase64, tamperedChallenge, signatureHex);
assert.strictEqual(tamperedValid, false, "Tampered challenge must fail verification");

// Test wrong key rejection
const otherKey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const otherSpkiBase64 = otherKey.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const wrongKeyValid = verifyEcdsaSignature(otherSpkiBase64, challengeText, signatureHex);
assert.strictEqual(wrongKeyValid, false, "Signature with wrong key must fail verification");

// Test iOS ASN.1 Header Reconstruction
const rawPoint65 = derSpkiBuffer.subarray(26);
assert.strictEqual(rawPoint65.length, 65, "Raw uncompressed EC point must be 65 bytes");
const p256Asn1Header = Buffer.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
]);
const reconstructedDerBase64 = Buffer.concat([p256Asn1Header, rawPoint65]).toString("base64");
assert.strictEqual(reconstructedDerBase64, derSpkiBase64, "Reconstructed iOS DER must match Android SPKI DER");
const iosValid = verifyEcdsaSignature(reconstructedDerBase64, challengeText, signatureHex);
assert.strictEqual(iosValid, true, "iOS reconstructed key must verify signature perfectly");
console.log("  ✓ Valid signature verified successfully");
console.log("  ✓ Tampered challenge rejected");
console.log("  ✓ Wrong key rejected");
console.log("  ✓ iOS 65-byte EC point reconstruction to 91-byte DER verified");

console.log("\n[2] Testing Firestore Rules Security Constraints:");
const firestoreRulesPath = path.resolve(process.cwd(), "firestore.rules");
assert.ok(fs.existsSync(firestoreRulesPath), "firestore.rules file must exist");
const rulesContent = fs.readFileSync(firestoreRulesPath, "utf-8");

// A. Check biometric_credentials rule
assert.ok(
  rulesContent.includes("match /biometric_credentials/{docId}"),
  "firestore.rules must contain match /biometric_credentials/{docId}"
);
const credBlockMatch = rulesContent.match(/match \/biometric_credentials\/\{docId\}[\s\S]*?\n\s*\}/);
assert.ok(credBlockMatch, "biometric_credentials block must exist");
assert.ok(
  /allow\s+read,\s*write:\s*if\s+false;/.test(credBlockMatch[0]),
  "biometric_credentials must strictly deny all client read and write (allow read, write: if false;)"
);
console.log("  ✓ /biometric_credentials client access strictly blocked: allow read, write: if false;");

// B. Check biometric_challenges rule
assert.ok(
  rulesContent.includes("match /biometric_challenges/{docId}"),
  "firestore.rules must contain match /biometric_challenges/{docId}"
);
const chalBlockMatch = rulesContent.match(/match \/biometric_challenges\/\{docId\}[\s\S]*?\n\s*\}/);
assert.ok(chalBlockMatch, "biometric_challenges block must exist");
assert.ok(
  /allow\s+read,\s*write:\s*if\s+false;/.test(chalBlockMatch[0]),
  "biometric_challenges must strictly deny all client read and write (allow read, write: if false;)"
);
console.log("  ✓ /biometric_challenges client access strictly blocked: allow read, write: if false;");

// C. Check attendance_records client write lockdown
assert.ok(
  rulesContent.includes("match /attendance_records/{recordId}"),
  "firestore.rules must contain match /attendance_records/{recordId}"
);
const attBlockMatch = rulesContent.match(/match \/attendance_records\/\{recordId\}[\s\S]*?\n\s*\}/);
assert.ok(attBlockMatch, "attendance_records block must exist");
assert.ok(
  /allow\s+create:\s*if\s+false;/.test(attBlockMatch[0]),
  "attendance_records must strictly disallow client-side creation (allow create: if false;)"
);
console.log("  ✓ /attendance_records direct client creation strictly blocked: allow create: if false;");

// D. Check biometric_change_requests protection
assert.ok(
  rulesContent.includes("match /biometric_change_requests/{requestId}"),
  "firestore.rules must define biometric_change_requests"
);
const chgBlockMatch = rulesContent.match(/match \/biometric_change_requests\/\{requestId\}[\s\S]*?\n\s*\}/);
assert.ok(chgBlockMatch, "biometric_change_requests block must exist");
assert.ok(
  /allow\s+delete:\s*if\s+false;/.test(chgBlockMatch[0]),
  "biometric_change_requests must disallow deletion (allow delete: if false;)"
);
assert.ok(
  chgBlockMatch[0].includes('request.resource.data.status == "PENDING"'),
  "biometric_change_requests must enforce initial status == 'PENDING' on student creation"
);
console.log("  ✓ /biometric_change_requests protected: deletion blocked, status PENDING enforced");

console.log("\n[3] Testing Role & Course Scope Authorization Rules:");
function checkLecturerCourseAccess({ courseData, lecturerEmail, lecturerUid }) {
  const cleanEmail = (lecturerEmail || "").toLowerCase().trim();
  if (courseData.lecturerEmail && courseData.lecturerEmail.toLowerCase().trim() === cleanEmail) {
    return true;
  }
  if (Array.isArray(courseData.assignedLecturers)) {
    return courseData.assignedLecturers.some((l) => {
      const lEmail = typeof l === "string" ? l.toLowerCase().trim() : (l.email || "").toLowerCase().trim();
      return lEmail === cleanEmail || (typeof l === "object" && l.uid === lecturerUid);
    });
  }
  return false;
}

const assignedCourse = {
  code: "CS301",
  lecturerEmail: "prof.sharma@iiitdwd.ac.in",
  assignedLecturers: [{ email: "prof.sharma@iiitdwd.ac.in", uid: "lect_101" }]
};

assert.strictEqual(
  checkLecturerCourseAccess({ courseData: assignedCourse, lecturerEmail: "prof.sharma@iiitdwd.ac.in", lecturerUid: "lect_101" }),
  true,
  "Assigned lecturer must have access to their course"
);

assert.strictEqual(
  checkLecturerCourseAccess({ courseData: assignedCourse, lecturerEmail: "intruder.faculty@iiitdwd.ac.in", lecturerUid: "lect_999" }),
  false,
  "Unassigned lecturer MUST be denied access to unassigned course"
);
console.log("  ✓ Lecturer course scoping strictly verified");

console.log("\n=== ALL PHASE 2 TESTS PASSED SUCCESSFULLY! ===");
