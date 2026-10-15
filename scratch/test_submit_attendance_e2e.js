import crypto from "node:crypto";
import assert from "node:assert";

console.log("=== RUNNING SUBMIT_ATTENDANCE END-TO-END SECURITY SIMULATION ===");

// ── Mock & Core Engine Logic Extracted from functions/index.js ─────────────────

const BIOMETRIC_CLOCK_SKEW_TOLERANCE_MS = 0;

function parseStrictTimestampMs(rawTimestamp) {
  if (rawTimestamp === null || rawTimestamp === undefined) return 0;

  if (typeof rawTimestamp === "object" && typeof rawTimestamp.toMillis === "function") {
    try {
      const ms = rawTimestamp.toMillis();
      return (typeof ms === "number" && Number.isFinite(ms) && ms > 0) ? Math.floor(ms) : 0;
    } catch (_) {
      return 0;
    }
  }

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

  if (typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp) && rawTimestamp > 0) {
    return Math.floor(rawTimestamp);
  }

  if (typeof rawTimestamp === "string" && rawTimestamp.trim().length > 0) {
    const parsed = Date.parse(rawTimestamp.trim());
    return (!isNaN(parsed) && Number.isFinite(parsed) && parsed > 0) ? parsed : 0;
  }

  return 0;
}

function derToPem(derBase64) {
  const clean = (derBase64 || "").replace(/\s+/g, "");
  const lines = [];
  for (let i = 0; i < clean.length; i += 64) {
    lines.push(clean.substring(i, i + 64));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

function parseSignatureBuffer(rawSignature) {
  if (!rawSignature) return null;
  if (Buffer.isBuffer(rawSignature)) return rawSignature;
  if (typeof rawSignature !== "string") return null;

  const clean = rawSignature.trim();
  if (!clean) return null;

  if (/^[0-9a-fA-F]+$/.test(clean) && clean.length % 2 === 0) {
    try {
      const hexBuf = Buffer.from(clean, "hex");
      if (hexBuf.length > 0 && hexBuf[0] === 0x30) return hexBuf;
    } catch (_) {}
  }

  try {
    let b64 = clean.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const b64Buf = Buffer.from(b64, "base64");
    if (b64Buf.length > 0) return b64Buf;
  } catch (_) {}

  return null;
}

function verifyHardwareSignature(publicKeyDerBase64, challengeText, hardwareProof) {
  try {
    if (!publicKeyDerBase64 || !challengeText || !hardwareProof) return false;

    const pem = derToPem(publicKeyDerBase64);
    const signatureBuffer = parseSignatureBuffer(
      typeof hardwareProof === "string" ? hardwareProof : hardwareProof.signature
    );

    if (!signatureBuffer || signatureBuffer.length === 0) return false;

    // WebAuthn
    if (hardwareProof.clientDataJSON && hardwareProof.authenticatorData) {
      let clientDataBuf;
      let authDataBuf;

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

      if (Buffer.isBuffer(hardwareProof.authenticatorData)) {
        authDataBuf = hardwareProof.authenticatorData;
      } else if (typeof hardwareProof.authenticatorData === "string") {
        let b64 = hardwareProof.authenticatorData.trim().replace(/-/g, "+").replace(/_/g, "/");
        while (b64.length % 4 !== 0) b64 += "=";
        authDataBuf = Buffer.from(b64, "base64");
      } else {
        return false;
      }

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

      const clientDataHash = crypto.createHash("sha256").update(clientDataBuf).digest();
      const signedData = Buffer.concat([authDataBuf, clientDataHash]);

      const verify = crypto.createVerify("SHA256");
      verify.update(signedData);
      return verify.verify(pem, signatureBuffer);
    }

    // Direct ECDSA (Android Keystore / iOS Secure Enclave)
    const verify = crypto.createVerify("SHA256");
    verify.update(Buffer.from(challengeText, "utf8"));
    return verify.verify(pem, signatureBuffer);
  } catch (err) {
    return false;
  }
}

// ── In-Memory Transactional Simulation Function ───────────────────────────────

class MockHttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function simulateSubmitAttendanceTransaction({
  state,
  sessionId,
  studentUid,
  rollNo,
  hardwareProof,
  biometricData,
  isNative,
  serverNow
}) {
  const recordId = `${sessionId}_${rollNo}`;

  // 1. Hardware biometric / platform check
  let authMode = "WEB_BROWSER";
  let hardwarePlatform = "web";
  let signatureVerified = false;
  let credData = null;

  if (hardwareProof) {
    const { challengeId, signature, platform: proofPlatform } = hardwareProof;
    if (!challengeId || !signature) {
      throw new MockHttpsError("invalid-argument", "Missing hardware biometric challengeId or signature.");
    }

    credData = state.biometric_credentials[studentUid] || state.biometric_credentials[rollNo];
    if (!credData || credData.status !== "ACTIVE" || !credData.publicKeyDerBase64) {
      throw new MockHttpsError("failed-precondition", "No active hardware biometric credential registered for this student.");
    }

    signatureVerified = true;
    authMode = "NATIVE_MOBILE";
    hardwarePlatform = proofPlatform || credData.platform || "unknown";
  } else if (isNative) {
    throw new MockHttpsError("failed-precondition", "Hardware biometric signature is required for native mobile attendance.");
  } else {
    authMode = "WEB_BROWSER";
    hardwarePlatform = "web";
    signatureVerified = false;
  }

  // 2. Face Biometric check
  if (!biometricData || biometricData.verified !== true || biometricData.antiSpoofScore !== "PASSED") {
    throw new MockHttpsError("failed-precondition", "Live face biometric verification with anti-spoofing is required.");
  }

  // 3. ATOMIC TRANSACTION EXECUTION
  // Read stage:
  if (state.attendance_records[recordId]) {
    throw new MockHttpsError("already-exists", `Attendance for ${rollNo} is already recorded.`);
  }

  let challengeData = null;
  if (hardwareProof) {
    challengeData = state.biometric_challenges[hardwareProof.challengeId];
    if (!challengeData) {
      throw new MockHttpsError("permission-denied", "Invalid or unknown biometric challenge.");
    }
    if (challengeData.used === true) {
      throw new MockHttpsError("permission-denied", "Biometric challenge has already been consumed (replay prevention).");
    }
    if (challengeData.studentUid !== studentUid) {
      throw new MockHttpsError("permission-denied", "Biometric challenge student UID mismatch.");
    }

    const challengeExpiryMs = parseStrictTimestampMs(challengeData.expiresAt);
    if (!challengeExpiryMs) {
      throw new MockHttpsError("permission-denied", "Security error: Biometric challenge has a missing or malformed expiration timestamp. Access denied.");
    }

    if (serverNow > (challengeExpiryMs + BIOMETRIC_CLOCK_SKEW_TOLERANCE_MS)) {
      throw new MockHttpsError("deadline-exceeded", "Biometric challenge has expired. Please retry biometric verification.");
    }

    const isValidSig = verifyHardwareSignature(
      credData.publicKeyDerBase64,
      challengeData.challengeText,
      hardwareProof
    );
    if (!isValidSig) {
      throw new MockHttpsError("permission-denied", "❌ Hardware biometric signature verification failed. Authentication rejected.");
    }
  }

  // Write stage (Atomic commit):
  if (hardwareProof) {
    state.biometric_challenges[hardwareProof.challengeId].used = true;
    state.biometric_challenges[hardwareProof.challengeId].consumedBySession = sessionId;
  }

  state.attendance_records[recordId] = {
    id: recordId,
    sessionId,
    rollNo,
    studentUid,
    deviceAuthMode: authMode,
    hardwareBiometric: signatureVerified,
    signatureVerified: signatureVerified,
    platform: hardwarePlatform,
    faceVerified: true,
    antiSpoofScore: "PASSED"
  };

  return { success: true, recordId, authMode, signatureVerified };
}

// ── Test Scenarios ────────────────────────────────────────────────────────────

// Setup test keys
const ecKeypair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const derSpkiBase64 = ecKeypair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const studentUid = "student_uid_12345";
const rollNo = "23BCS045";
const sessionId = "sess_oct14_01";
const serverNow = 1729000000000;

function createCleanState() {
  const challengeText = crypto.randomBytes(32).toString("hex");
  const challengeId = "chal_" + crypto.randomUUID();

  return {
    state: {
      biometric_credentials: {
        [studentUid]: {
          studentUid,
          rollNo,
          status: "ACTIVE",
          publicKeyDerBase64: derSpkiBase64,
          platform: "android"
        }
      },
      biometric_challenges: {
        [challengeId]: {
          challengeId,
          challengeText,
          studentUid,
          expiresAt: { toMillis: () => serverNow + 180000 },
          used: false
        }
      },
      attendance_records: {}
    },
    challengeId,
    challengeText
  };
}

// TEST 1: Valid Android Submission with Base64 DER Signature
console.log("\n[TEST 1] Testing Valid Android Submission (Base64 DER signature + Live Face):");
{
  const { state, challengeId, challengeText } = createCleanState();
  const signer = crypto.createSign("SHA256");
  signer.update(Buffer.from(challengeText, "utf8"));
  const signatureBase64 = signer.sign(ecKeypair.privateKey).toString("base64");

  const res = await simulateSubmitAttendanceTransaction({
    state,
    sessionId,
    studentUid,
    rollNo,
    hardwareProof: { challengeId, signature: signatureBase64, platform: "android" },
    biometricData: { verified: true, antiSpoofScore: "PASSED", confidence: 99 },
    isNative: true,
    serverNow
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.authMode, "NATIVE_MOBILE");
  assert.strictEqual(res.signatureVerified, true);
  assert.strictEqual(state.biometric_challenges[challengeId].used, true, "Challenge must be atomically marked used");
  assert.ok(state.attendance_records[`${sessionId}_${rollNo}`], "Attendance record must be created");
  console.log("  ✓ Valid submission succeeded and challenge was atomically consumed");
}

// TEST 2: Replay Attack (Second attempt with same challengeId)
console.log("\n[TEST 2] Testing Replay Attack Prevention:");
{
  const { state, challengeId, challengeText } = createCleanState();
  const signer = crypto.createSign("SHA256");
  signer.update(Buffer.from(challengeText, "utf8"));
  const signatureBase64 = signer.sign(ecKeypair.privateKey).toString("base64");

  // First call succeeds
  await simulateSubmitAttendanceTransaction({
    state,
    sessionId,
    studentUid,
    rollNo,
    hardwareProof: { challengeId, signature: signatureBase64, platform: "android" },
    biometricData: { verified: true, antiSpoofScore: "PASSED" },
    isNative: true,
    serverNow
  });

  // Second call with same challenge (even with different session or student) MUST be rejected
  let replayError = null;
  try {
    await simulateSubmitAttendanceTransaction({
      state,
      sessionId: "different_sess",
      studentUid,
      rollNo,
      hardwareProof: { challengeId, signature: signatureBase64, platform: "android" },
      biometricData: { verified: true, antiSpoofScore: "PASSED" },
      isNative: true,
      serverNow
    });
  } catch (err) {
    replayError = err;
  }

  assert.ok(replayError, "Replay attack must throw an error");
  assert.strictEqual(replayError.code, "permission-denied");
  assert.ok(replayError.message.includes("already been consumed"), "Must cite replay prevention");
  console.log("  ✓ Replay attack strictly blocked with permission-denied");
}

// TEST 3: Strict Fail-Closed Expiry (Missing or Malformed Timestamp)
console.log("\n[TEST 3] Testing Strict Fail-Closed Expiry (Missing or Malformed Timestamp):");
{
  const malformedTestCases = [
    undefined,
    null,
    "malformed-string",
    { toMillis: "not-a-func" },
    -1000,
    0,
    NaN
  ];

  for (const badExpiry of malformedTestCases) {
    const { state, challengeId, challengeText } = createCleanState();
    state.biometric_challenges[challengeId].expiresAt = badExpiry;

    const signer = crypto.createSign("SHA256");
    signer.update(Buffer.from(challengeText, "utf8"));
    const signatureBase64 = signer.sign(ecKeypair.privateKey).toString("base64");

    let err = null;
    try {
      await simulateSubmitAttendanceTransaction({
        state,
        sessionId,
        studentUid,
        rollNo,
        hardwareProof: { challengeId, signature: signatureBase64, platform: "android" },
        biometricData: { verified: true, antiSpoofScore: "PASSED" },
        isNative: true,
        serverNow
      });
    } catch (e) {
      err = e;
    }

    assert.ok(err, `Malformed timestamp (${JSON.stringify(badExpiry)}) must be rejected`);
    assert.strictEqual(err.code, "permission-denied");
    assert.ok(err.message.includes("missing or malformed expiration timestamp"), "Must fail closed with explicit message");
  }
  console.log("  ✓ All malformed/missing timestamp edge cases failed closed (permission-denied)");
}

// TEST 4: Expired Challenge Rejection (Server Time > Expiry)
console.log("\n[TEST 4] Testing Expired Challenge Rejection:");
{
  const { state, challengeId, challengeText } = createCleanState();
  // Expired 5 seconds ago
  state.biometric_challenges[challengeId].expiresAt = { toMillis: () => serverNow - 5000 };

  const signer = crypto.createSign("SHA256");
  signer.update(Buffer.from(challengeText, "utf8"));
  const signatureBase64 = signer.sign(ecKeypair.privateKey).toString("base64");

  let err = null;
  try {
    await simulateSubmitAttendanceTransaction({
      state,
      sessionId,
      studentUid,
      rollNo,
      hardwareProof: { challengeId, signature: signatureBase64, platform: "android" },
      biometricData: { verified: true, antiSpoofScore: "PASSED" },
      isNative: true,
      serverNow
    });
  } catch (e) {
    err = e;
  }

  assert.ok(err, "Expired challenge must be rejected");
  assert.strictEqual(err.code, "deadline-exceeded");
  assert.ok(err.message.includes("Biometric challenge has expired"));
  console.log("  ✓ Expired challenge rejected with deadline-exceeded");
}

// TEST 5: Face Anti-Spoof Rejection
console.log("\n[TEST 5] Testing Face Anti-Spoof Enforcement:");
{
  const { state, challengeId, challengeText } = createCleanState();
  const signer = crypto.createSign("SHA256");
  signer.update(Buffer.from(challengeText, "utf8"));
  const signatureBase64 = signer.sign(ecKeypair.privateKey).toString("base64");

  let err = null;
  try {
    await simulateSubmitAttendanceTransaction({
      state,
      sessionId,
      studentUid,
      rollNo,
      hardwareProof: { challengeId, signature: signatureBase64, platform: "android" },
      biometricData: { verified: false, antiSpoofScore: "FAILED" },
      isNative: true,
      serverNow
    });
  } catch (e) {
    err = e;
  }

  assert.ok(err, "Failed face spoof must be rejected");
  assert.strictEqual(err.code, "failed-precondition");
  assert.ok(err.message.includes("anti-spoofing is required"));
  console.log("  ✓ Face anti-spoof check strictly enforced");
}

// TEST 6: WebAuthn Assertion Payload Submission
console.log("\n[TEST 6] Testing WebAuthn Assertion Payload Submission:");
{
  const { state, challengeId, challengeText } = createCleanState();

  const clientDataObj = {
    type: "webauthn.get",
    challenge: Buffer.from(challengeText, "utf8").toString("base64url"),
    origin: "https://smartattend.app"
  };
  const clientDataJSON = JSON.stringify(clientDataObj);
  const clientDataJSONBase64 = Buffer.from(clientDataJSON, "utf8").toString("base64");

  const authenticatorData = crypto.randomBytes(37);
  authenticatorData[32] = 0x05;

  const clientDataHash = crypto.createHash("sha256").update(Buffer.from(clientDataJSON, "utf8")).digest();
  const webAuthnSignedData = Buffer.concat([authenticatorData, clientDataHash]);

  const webAuthnSigner = crypto.createSign("SHA256");
  webAuthnSigner.update(webAuthnSignedData);
  const webAuthnSignatureBase64 = webAuthnSigner.sign(ecKeypair.privateKey).toString("base64");

  const res = await simulateSubmitAttendanceTransaction({
    state,
    sessionId,
    studentUid,
    rollNo,
    hardwareProof: {
      challengeId,
      signature: webAuthnSignatureBase64,
      authenticatorData: authenticatorData.toString("base64"),
      clientDataJSON: clientDataJSONBase64,
      platform: "web"
    },
    biometricData: { verified: true, antiSpoofScore: "PASSED", confidence: 98 },
    isNative: false,
    serverNow
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.signatureVerified, true);
  console.log("  ✓ WebAuthn assertion payload submission verified successfully");
}

console.log("\n=== ALL E2E SECURITY SIMULATION TESTS PASSED! ===");
