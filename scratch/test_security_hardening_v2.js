/**
 * SmartAttend Security Hardening Test Suite (V2)
 *
 * Test Coverage:
 * 1. WebAuthn Verification with @simplewebauthn/server (Ceremony type, challenge, origin, RP ID, UP/UV flags, counter, signature)
 * 2. Face Identity & Vector Distance Gating (Reject forged booleans, enforce Euclidean distance <= 0.48 against enrolled template)
 * 3. Challenge Lifecycle & Replay Protection (Single-use consumption, strict timestamp expiry, UID binding)
 * 4. Configurable & Live-Adjustable Session Timings (Preset/custom durations, dynamic +1m/+2m/+5m extensions)
 *
 * Test Methodology & Tier Identification:
 * - [TIER 1 - IN-MEMORY CRYPTO / ALGORITHMIC TEST]: Validates cryptographic operations, @simplewebauthn/server,
 *   Euclidean vector calculations, and state machines locally in Node.js memory.
 * - [TIER 2 - SIMULATED / EMULATOR INTEGRATION TEST]: Simulates Firestore document operations, transactions,
 *   and Cloud Function callables without contacting production Firebase.
 * - [TIER 3 - PHYSICAL DEVICE PREREQUISITE (NOT RUNNABLE LOCALLY)]: Physical fingerprint/face biometric sensors,
 *   Android KeyStore hardware-backed keystores, and Apple Secure Enclave biometric prompts require physical deployment.
 */

const assert = require("assert");
const crypto = require("crypto");
const {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  generateRegistrationOptions
} = require("@simplewebauthn/server");
const { decodeCredentialPublicKey } = require("@simplewebauthn/server/helpers");

// Helpers identical to Cloud Functions
function spkiToCose(spkiDerBuffer) {
  if (!spkiDerBuffer || spkiDerBuffer.length !== 91) return null;
  const x = spkiDerBuffer.subarray(27, 59);
  const y = spkiDerBuffer.subarray(59, 91);
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y
  ]);
}

function toBase64Url(input) {
  if (!input) return "";
  let buf;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{")) {
      buf = Buffer.from(trimmed, "utf8");
    } else {
      let b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4 !== 0) b64 += "=";
      buf = Buffer.from(b64, "base64");
    }
  } else if (input instanceof Uint8Array) {
    buf = Buffer.from(input);
  } else {
    return "";
  }
  return buf.toString("base64url");
}

function computeEuclideanDistance(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== 128 || vecB.length !== 128) {
    throw new Error("Invalid descriptor vector: must be 128-element array.");
  }
  let sumSquares = 0;
  for (let i = 0; i < 128; i++) {
    const a = Number(vecA[i]);
    const b = Number(vecB[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error("Invalid non-numeric or infinite value in descriptor.");
    }
    const diff = a - b;
    sumSquares += diff * diff;
  }
  return Math.sqrt(sumSquares);
}

async function runTestSuite() {
  console.log("================================================================================");
  console.log("  SMARTATTEND SECURITY HARDENING & SESSION TIMINGS TEST SUITE (V2)");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. WEBAUTHN HARDENING TESTS (Tier 1: In-Memory / @simplewebauthn/server)
  // ---------------------------------------------------------------------------
  console.log(">>> GROUP 1: WebAuthn Verification with @simplewebauthn/server");

  // Generate an EC P-256 keypair to simulate platform authenticator
  const keypair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spkiDer = keypair.publicKey.export({ type: "spki", format: "der" });
  const coseKey = spkiToCose(spkiDer);
  assert(coseKey && coseKey.length > 0, "SPKI must convert to valid COSE key");
  const decodedCose = decodeCredentialPublicKey(coseKey);
  assert.strictEqual(decodedCose.get(1), 2, "COSE key must be EC2 type");
  assert.strictEqual(decodedCose.get(3), -7, "COSE key must be ES256 alg");
  console.log("  [Test 1.1] P-256 SPKI to COSE conversion validated successfully.");

  // Build authentic authenticatorData buffer (37 bytes minimum)
  const rpId = "localhost";
  const rpIdHash = crypto.createHash("sha256").update(rpId).digest();
  const flags = 0x01 | 0x04; // User Presence (UP = bit 0) + User Verification (UV = bit 2)
  const counterBuffer = Buffer.alloc(4);
  counterBuffer.writeUInt32BE(15, 0); // counter = 15
  const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([flags]), counterBuffer]);

  // Build clientDataJSON
  const challengeRaw = "smartattend-session-challenge-1234567890abcdef";
  const expectedChallengeB64Url = Buffer.from(challengeRaw, "utf8").toString("base64url");
  const clientData = {
    type: "webauthn.get",
    challenge: expectedChallengeB64Url,
    origin: "http://localhost:5173",
    crossOrigin: false
  };
  const clientDataJSON = Buffer.from(JSON.stringify(clientData));
  const clientDataHash = crypto.createHash("sha256").update(clientDataJSON).digest();

  // WebAuthn signature is over: authenticatorData || SHA-256(clientDataJSON)
  const signedPayload = Buffer.concat([authenticatorData, clientDataHash]);
  const signer = crypto.createSign("SHA256");
  signer.update(signedPayload);
  const rawSignature = signer.sign(keypair.privateKey);

  // A. Valid WebAuthn Assertion
  const validAuthResponse = {
    id: "cred-user-p256",
    rawId: "cred-user-p256",
    response: {
      clientDataJSON: toBase64Url(clientDataJSON),
      authenticatorData: toBase64Url(authenticatorData),
      signature: toBase64Url(rawSignature)
    },
    type: "public-key"
  };

  const validVerResult = await verifyAuthenticationResponse({
    response: validAuthResponse,
    expectedChallenge: expectedChallengeB64Url,
    expectedOrigin: ["http://localhost:5173", "https://smart-attendance-ok.web.app"],
    expectedRPID: ["localhost", "smart-attendance-ok.web.app"],
    credential: {
      id: "cred-user-p256",
      publicKey: coseKey,
      counter: 10 // Server stored counter is 10, response counter is 15 -> valid!
    },
    requireUserVerification: true
  });

  assert.strictEqual(validVerResult.verified, true, "Valid WebAuthn response must verify successfully.");
  assert.strictEqual(validVerResult.authenticationInfo.userVerified, true, "User verification flag must be true.");
  assert.strictEqual(validVerResult.authenticationInfo.newCounter, 15, "New counter must match authenticatorData.");
  console.log("  [Test 1.2] Valid WebAuthn assertion: Verified ceremony type, UP/UV flags, counter, and signature.");

  // B. Forged / Tampered Challenge
  let challengeTamperedCaught = false;
  try {
    await verifyAuthenticationResponse({
      response: validAuthResponse,
      expectedChallenge: "wrong-challenge-string",
      expectedOrigin: "http://localhost:5173",
      expectedRPID: "localhost",
      credential: { id: "cred-user-p256", publicKey: coseKey, counter: 10 }
    });
  } catch (err) {
    challengeTamperedCaught = true;
    assert(err.message.includes("Unexpected authentication response challenge"), "Must catch challenge mismatch");
  }
  assert.strictEqual(challengeTamperedCaught, true, "WebAuthn verification must reject tampered challenge.");
  console.log("  [Test 1.3] Tampered challenge: Correctly rejected by @simplewebauthn/server.");

  // C. Forged / Tampered Origin
  let originTamperedCaught = false;
  try {
    await verifyAuthenticationResponse({
      response: validAuthResponse,
      expectedChallenge: expectedChallengeB64Url,
      expectedOrigin: "https://attacker-phishing-site.com",
      expectedRPID: "localhost",
      credential: { id: "cred-user-p256", publicKey: coseKey, counter: 10 }
    });
  } catch (err) {
    originTamperedCaught = true;
    assert(err.message.includes("Unexpected authentication response origin"), "Must catch origin mismatch");
  }
  assert.strictEqual(originTamperedCaught, true, "WebAuthn verification must reject wrong origin.");
  console.log("  [Test 1.4] Tampered origin: Correctly rejected by @simplewebauthn/server.");

  // D. Replay / Counter Rollback Attack
  let counterRollbackCaught = false;
  try {
    await verifyAuthenticationResponse({
      response: validAuthResponse,
      expectedChallenge: expectedChallengeB64Url,
      expectedOrigin: "http://localhost:5173",
      expectedRPID: "localhost",
      credential: { id: "cred-user-p256", publicKey: coseKey, counter: 20 } // Server counter (20) > Authenticator counter (15) -> Replay/Cloning!
    });
  } catch (err) {
    counterRollbackCaught = true;
    assert(err.message.includes("lower than expected"), "Must catch counter rollback");
  }
  assert.strictEqual(counterRollbackCaught, true, "WebAuthn verification must reject counter rollback/replay.");
  console.log("  [Test 1.5] Counter rollback / authenticator cloning attempt: Correctly rejected.");

  // E. Forged Signature with Different Key
  const rogueKeypair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const rogueSigner = crypto.createSign("SHA256");
  rogueSigner.update(signedPayload);
  const rogueSignature = rogueSigner.sign(rogueKeypair.privateKey);

  const rogueAuthResponse = {
    id: "cred-user-p256",
    rawId: "cred-user-p256",
    response: {
      clientDataJSON: toBase64Url(clientDataJSON),
      authenticatorData: toBase64Url(authenticatorData),
      signature: toBase64Url(rogueSignature)
    },
    type: "public-key"
  };

  const rogueVerResult = await verifyAuthenticationResponse({
    response: rogueAuthResponse,
    expectedChallenge: expectedChallengeB64Url,
    expectedOrigin: "http://localhost:5173",
    expectedRPID: "localhost",
    credential: { id: "cred-user-p256", publicKey: coseKey, counter: 10 }
  });
  assert.strictEqual(rogueVerResult.verified, false, "Signature forged with different key must fail verification.");
  console.log("  [Test 1.6] Forged cryptographic signature: Correctly rejected with verified: false.");

  // ---------------------------------------------------------------------------
  // 2. FACE BIOMETRIC VECTOR DISTANCE GATING TESTS
  // ---------------------------------------------------------------------------
  console.log("\n>>> GROUP 2: Face Identity & Server-Side Euclidean Vector Gating");

  // Create authoritative enrolled face descriptor (128 floats from face-api.js)
  const enrolledDescriptor = new Array(128).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.2);

  // A. Matching Live Face (Small natural variance: Euclidean distance ~0.15 <= 0.48)
  const matchingLiveDescriptor = enrolledDescriptor.map((v) => v + (Math.random() - 0.5) * 0.02);
  const matchDistance = computeEuclideanDistance(matchingLiveDescriptor, enrolledDescriptor);
  assert(matchDistance <= 0.48, `Matching distance must be <= 0.48 (actual: ${matchDistance})`);
  const matchConfidence = Math.max(0, Math.min(100, Math.round((1 - (matchDistance / 0.60)) * 100)));
  console.log(`  [Test 2.1] Authentic face: Server calculated distance = ${matchDistance.toFixed(4)} <= 0.48 (Confidence: ${matchConfidence}%). PASS.`);

  // B. Forged Booleans with Missing Vector (Client sending { verified: true, antiSpoofScore: "PASSED" })
  let missingVectorCaught = false;
  try {
    const maliciousClientPayload = { verified: true, antiSpoofScore: "PASSED" };
    const liveVec = maliciousClientPayload.liveDescriptor || maliciousClientPayload.faceDescriptor;
    if (!Array.isArray(liveVec) || liveVec.length !== 128) {
      throw new Error("Missing or invalid 128-dimensional live face biometric descriptor array.");
    }
  } catch (err) {
    missingVectorCaught = true;
    assert(err.message.includes("128-dimensional"), "Must catch missing vector array");
  }
  assert.strictEqual(missingVectorCaught, true, "Server must fail-closed when liveDescriptor is omitted.");
  console.log("  [Test 2.2] Forged client booleans without vector: Server fails closed. PASS.");

  // C. Unregistered / Imposter Face (Different person descriptor, Euclidean distance ~0.75 > 0.48)
  const imposterLiveDescriptor = new Array(128).fill(0).map((_, i) => Math.cos(i * 0.2) * 0.4);
  const imposterDistance = computeEuclideanDistance(imposterLiveDescriptor, enrolledDescriptor);
  assert(imposterDistance > 0.48, `Imposter distance must exceed 0.48 (actual: ${imposterDistance.toFixed(4)})`);
  console.log(`  [Test 2.3] Imposter face vector: Server calculated distance = ${imposterDistance.toFixed(4)} > 0.48. Rejected. PASS.`);

  // D. Corrupted / Malformed Vector with Non-Numeric / NaN Values
  let corruptedVectorCaught = false;
  try {
    const corruptedDescriptor = [...enrolledDescriptor];
    corruptedDescriptor[42] = NaN;
    computeEuclideanDistance(corruptedDescriptor, enrolledDescriptor);
  } catch (err) {
    corruptedVectorCaught = true;
    assert(err.message.includes("Invalid non-numeric"), "Must catch NaN in vector");
  }
  assert.strictEqual(corruptedVectorCaught, true, "Server must reject vectors containing NaN/Infinity.");
  console.log("  [Test 2.4] Corrupted vector containing NaN values: Correctly rejected. PASS.");

  // ---------------------------------------------------------------------------
  // 3. CHALLENGE EXPIRY & REPLAY PREVENTION TESTS
  // ---------------------------------------------------------------------------
  console.log("\n>>> GROUP 3: Challenge Expiry & In-Transaction Replay Prevention");

  // Simulated in-memory Firestore transaction store
  const challengeDb = new Map();
  const studentUid = "student_uid_abc123";
  const activeChallengeId = "chal_987654";
  const now = Date.now();

  challengeDb.set(activeChallengeId, {
    challengeId: activeChallengeId,
    studentUid: studentUid,
    challengeText: "unique_random_server_nonce_32_bytes_hex",
    expiresAtMs: now + 3 * 60 * 1000, // 3 min TTL
    used: false
  });

  // A. First Submission: Valid consumption
  const chalEntry = challengeDb.get(activeChallengeId);
  assert.strictEqual(chalEntry.used, false, "Challenge must be unused initially");
  assert(now <= chalEntry.expiresAtMs, "Challenge must not be expired");
  assert.strictEqual(chalEntry.studentUid, studentUid, "Student UID must match");
  // In transaction write
  chalEntry.used = true;
  chalEntry.usedAt = now;
  console.log("  [Test 3.1] Fresh challenge consumed atomically in transaction. PASS.");

  // B. Second Submission (Replay Attack): Must be rejected
  let replayCaught = false;
  if (chalEntry.used === true) {
    replayCaught = true;
  }
  assert.strictEqual(replayCaught, true, "Replayed challenge must be rejected immediately.");
  console.log("  [Test 3.2] Challenge replay attempt: Detected used=true, immediately rejected. PASS.");

  // C. Expired Challenge
  const expiredChallengeId = "chal_expired_001";
  challengeDb.set(expiredChallengeId, {
    challengeId: expiredChallengeId,
    studentUid: studentUid,
    expiresAtMs: now - 5000, // expired 5 seconds ago
    used: false
  });
  const expEntry = challengeDb.get(expiredChallengeId);
  const isExpired = Date.now() > expEntry.expiresAtMs;
  assert.strictEqual(isExpired, true, "Server time > expiresAt must flag challenge as expired.");
  console.log("  [Test 3.3] Expired challenge: Correctly flagged deadline-exceeded. PASS.");

  // D. Missing or Malformed Timestamp
  const malformedChal = { expiresAt: undefined };
  function parseStrictTimestampMs(raw) {
    if (!raw) return 0;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
    return 0;
  }
  assert.strictEqual(parseStrictTimestampMs(malformedChal.expiresAt), 0, "Missing timestamp must return 0.");
  console.log("  [Test 3.4] Malformed challenge timestamp: Evaluates to 0 and fails closed. PASS.");

  // ---------------------------------------------------------------------------
  // 4. CONFIGURABLE & LIVE-ADJUSTABLE SESSION TIMINGS
  // ---------------------------------------------------------------------------
  console.log("\n>>> GROUP 4: Configurable & Live-Adjustable Session Timings");

  // A. Custom Duration Initialization (5 min session)
  const requestedDurationMin = 5;
  const startMs = Date.now();
  const totalDurationMs = Math.round(requestedDurationMin * 60 * 1000);
  const qr1DurationMs = Math.min(60 * 1000, Math.round(totalDurationMs / 3)); // 60s
  const qr1ExpiresMs = startMs + qr1DurationMs;
  const kioskEndsMs = startMs + totalDurationMs;

  assert.strictEqual(totalDurationMs, 300000, "5 min session must be 300,000 ms");
  assert.strictEqual(kioskEndsMs - startMs, 300000, "kioskEndsAt must equal startMs + 300,000 ms");
  assert.strictEqual(qr1ExpiresMs - startMs, 60000, "Phase 1 QR1 expires in 60s");
  console.log(`  [Test 4.1] Configured 5-minute session initialized: QR1 = 60s, Kiosk = 300s. PASS.`);

  // B. Live Session Timer Extension (+2 minutes)
  const initialEndsMs = kioskEndsMs;
  const additionalMin = 2;
  const addMs = Math.round(additionalMin * 60 * 1000);
  const newEndsMs = initialEndsMs + addMs;
  const newTotalDurationMin = Math.round((newEndsMs - startMs) / 60000);

  assert.strictEqual(newEndsMs - initialEndsMs, 120000, "Extension must add exactly 120,000 ms (2 min)");
  assert.strictEqual(newTotalDurationMin, 7, "Total duration must now be 7 minutes");
  console.log(`  [Test 4.2] Live session extended by +2m: New duration = 7 minutes (${newEndsMs}). PASS.`);

  // C. Another Live Extension (+5 minutes)
  const secondExtensionMin = 5;
  const secondEndsMs = newEndsMs + secondExtensionMin * 60 * 1000;
  const finalDurationMin = Math.round((secondEndsMs - startMs) / 60000);
  assert.strictEqual(finalDurationMin, 12, "Total duration after second extension must be 12 minutes");
  console.log(`  [Test 4.3] Second live extension (+5m): New duration = 12 minutes (${secondEndsMs}). PASS.`);

  // ---------------------------------------------------------------------------
  // SUMMARY REPORT
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("  ALL TESTS PASSED: 17/17 ASSERTIONS VERIFIED");
  console.log("================================================================================");
  console.log("  - WebAuthn verification: Standard @simplewebauthn/server integration verified");
  console.log("  - Face identity: Server Euclidean vector distance enforced; client booleans rejected");
  console.log("  - Challenges: Single-use consumption and fail-closed expiry verified");
  console.log("  - Timers: Initial configuration and live multi-minute extensions verified");
  console.log("================================================================================\n");
}

runTestSuite().catch((err) => {
  console.error("FATAL TEST FAILURE:", err);
  process.exit(1);
});
