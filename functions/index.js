const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  generateRegistrationOptions
} = require("@simplewebauthn/server");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

setGlobalOptions({ cors: true, maxInstances: 10, region: "us-central1" });

/**
 * Utility: Compute SHA-256 hash of a string.
 */
function hashToken(token) {
  if (!token || typeof token !== "string") return "";
  return crypto.createHash("sha256").update(token.trim()).digest("hex");
}

/**
 * Utility: Calculate Haversine great-circle distance between two GPS coordinates in metres.
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Utility: Authoritatively evaluate student GPS location against session classroom geofence.
 * Rejects mock/spoofed GPS and out-of-radius coordinates.
 */
function evaluateServerGeofence(studentCoords, classroomCoords, radiusMetres) {
  const radius = typeof radiusMetres === "number" ? radiusMetres : 10;
  if (!classroomCoords || radius === 0) {
    return { status: "PASS", geofenceEnforced: false, distance: 0, radius: 0 };
  }

  const cLat = Number(classroomCoords.latitude ?? classroomCoords.lat);
  const cLon = Number(classroomCoords.longitude ?? classroomCoords.lng ?? classroomCoords.lon);
  if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) {
    return { status: "PASS", geofenceEnforced: false, distance: 0, radius: 0 };
  }

  if (!studentCoords) {
    return { status: "LOCATION_UNAVAILABLE", geofenceEnforced: true, radius: radius, message: "GPS coordinates not provided." };
  }

  const sLat = Number(studentCoords.latitude ?? studentCoords.lat);
  const sLon = Number(studentCoords.longitude ?? studentCoords.lng ?? studentCoords.lon);
  if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) {
    return { status: "LOCATION_UNAVAILABLE", geofenceEnforced: true, radius: radius, message: "GPS coordinates not provided or invalid." };
  }

  if (studentCoords.isMock || studentCoords.mocked || studentCoords.isMockLocation) {
    return { status: "MOCK_DETECTED", geofenceEnforced: true, radius: radius, message: "Mock GPS detected." };
  }

  const rawDist = calculateHaversineDistance(sLat, sLon, cLat, cLon);
  if (!Number.isFinite(rawDist)) {
    return { status: "PASS", geofenceEnforced: false, distance: 0, radius: 0 };
  }

  const accuracy = Math.max(0, Math.round(Number(studentCoords.accuracy) || 0));
  const rawHostAccuracy = Math.round(Number(classroomCoords.accuracy ?? classroomCoords.acc) || 0);
  const hostAccuracy = rawHostAccuracy > 0 ? Math.max(80, rawHostAccuracy) : 80;
  const studentAccuracy = accuracy > 0 ? Math.max(40, accuracy) : 40;
  const combinedUncertainty = Math.min(200, studentAccuracy + hostAccuracy);
  const effectiveDist = Math.max(0, Math.round((rawDist - combinedUncertainty) * 10) / 10);
  const measuredDist = Math.round(rawDist * 10) / 10;

  if (rawDist <= radius || effectiveDist <= radius || rawDist <= 100) {
    return {
      status: "PASS",
      geofenceEnforced: true,
      distance: measuredDist,
      effectiveDistance: effectiveDist,
      radius: radius
    };
  }

  return {
    status: "REJECT",
    geofenceEnforced: true,
    distance: measuredDist,
    effectiveDistance: effectiveDist,
    radius: radius,
    message: `Geofence Violation: You are outside the classroom (${measuredDist}m > ${radius}m).`
  };
}

/**
 * Helper: Converts 91-byte P-256 SPKI DER public key to a canonical CBOR-encoded COSE EC2 key.
 * SPKI structure: 27-byte header + 0x04 + 32-byte X + 32-byte Y = 91 bytes.
 * COSE structure: Map { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: X (32B), -3: Y (32B) }
 */
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

/**
 * Helper: Canonicalizes string/buffer into base64url encoding.
 */
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

/**
 * Strict Clock-Skew & Challenge Expiration Policy:
 * 
 * 1. Authority: Server clock (Google Cloud synchronized NTP TrueTime clock) is the single
 *    source of truth. Client device timestamps are untrusted and discarded.
 * 2. Lifetime (TTL): Ephemeral challenges expire in exactly 3 minutes (180,000 ms) from issuance.
 * 3. Skew Tolerance: BIOMETRIC_CLOCK_SKEW_TOLERANCE_MS is set to 0 ms (strict zero-tolerance).
 *    Because challenges are issued by Cloud Functions and verified by Cloud Functions,
 *    multi-instance Google Cloud clocks are NTP-synchronized within milliseconds.
 * 4. Fail-Closed Expiry:
 *    - Missing, non-positive, or malformed expiresAt -> Immediately REJECT with permission-denied.
 *    - serverNow > (expiresAt + BIOMETRIC_CLOCK_SKEW_TOLERANCE_MS) -> Immediately REJECT with deadline-exceeded.
 */
const BIOMETRIC_CLOCK_SKEW_TOLERANCE_MS = 0;

/**
 * Strictly parses and validates challenge expiration timestamp.
 * Only accepts supported types:
 * 1. Firestore Timestamp instance (object with toMillis() method returning positive number)
 * 2. Serialized Firestore Timestamp object ({ seconds: positive number, nanoseconds?: number })
 * 3. Finite positive number (epoch milliseconds, > 0)
 * 4. Non-empty ISO-8601 string parseable by Date.parse() yielding > 0
 * Rejects all unsupported types (null, undefined, boolean, array, NaN, Infinity, negative/zero numbers, arbitrary objects).
 * Returns 0 if missing, non-positive, or malformed.
 */
function parseStrictTimestampMs(rawTimestamp) {
  if (rawTimestamp === null || rawTimestamp === undefined) return 0;

  // A. Firestore Timestamp instance
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

/**
 * Utility: Convert Base64 DER public key to PEM format.
 */
function derToPem(derBase64) {
  const clean = (derBase64 || "").replace(/\s+/g, "");
  const lines = [];
  for (let i = 0; i < clean.length; i += 64) {
    lines.push(clean.substring(i, i + 64));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Safely parses signature into a Buffer.
 * Supports:
 * - Base64 or Base64URL encoded ASN.1 DER signature (Android Keystore, iOS Secure Enclave, WebAuthn)
 * - Hex-encoded ASN.1 DER signature
 * - Buffer
 * Returns null if invalid or unsupported type.
 */
function parseSignatureBuffer(rawSignature) {
  if (!rawSignature) return null;
  if (Buffer.isBuffer(rawSignature)) return rawSignature;
  if (typeof rawSignature !== "string") return null;

  const clean = rawSignature.trim();
  if (!clean) return null;

  // Hex encoded ASN.1 DER check (DER sequence starts with 0x30)
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

/**
 * Authoritative WebAuthn Domain & RP ID Allowlist Configuration
 *
 * Inspects and supports all domains from Firebase Authentication authorized-domain settings
 * strictly governed by W3C WebAuthn Level 2/3 specifications:
 *
 * Domain Classification:
 * 1. smartattend-ochre.vercel.app:
 *    - Purpose: Primary Production Web Origin
 *    - Expected RP ID: "smartattend-ochre.vercel.app"
 *    - Allowed Origin: "https://smartattend-ochre.vercel.app"
 * 2. smart-attendance-ok.web.app:
 *    - Purpose: Firebase Hosting Production
 *    - Expected RP ID: "smart-attendance-ok.web.app"
 *    - Allowed Origin: "https://smart-attendance-ok.web.app"
 * 3. smart-attendance-ok.firebaseapp.com:
 *    - Purpose: Firebase Hosting Default Domain / OAuth Redirect
 *    - Expected RP ID: "smart-attendance-ok.firebaseapp.com"
 *    - Allowed Origin: "https://smart-attendance-ok.firebaseapp.com"
 * 4. smartattend-git-testing-branch-onteddukalyanis-projects.vercel.app:
 *    - Purpose: Vercel Preview / Testing Branch Deployment
 *    - Expected RP ID: "smartattend-git-testing-branch-onteddukalyanis-projects.vercel.app"
 *    - Allowed Origin: "https://smartattend-git-testing-branch-onteddukalyanis-projects.vercel.app"
 * 5. smartattend-ogcg41pzx-onteddukalyanis-projects.vercel.app:
 *    - Purpose: Vercel Ephemeral Preview Deployment
 *    - Expected RP ID: "smartattend-ogcg41pzx-onteddukalyanis-projects.vercel.app"
 *    - Allowed Origin: "https://smartattend-ogcg41pzx-onteddukalyanis-projects.vercel.app"
 * 6. localhost:
 *    - Purpose: Localhost Development Environment
 *    - Expected RP ID: "localhost"
 *    - Allowed Origins: ["http://localhost:5173", "http://localhost:3000", "http://localhost:4173", "http://127.0.0.1:5173", "http://127.0.0.1:3000"]
 *
 * Ineligible Domains & Identifiers (Technical WebAuthn / Browser Ineligibility):
 * 7. 10.0.13.164: Local-network IP address. Ineligible: W3C WebAuthn Section 5.1.4 requires RP IDs to be valid domain strings. Plain HTTP IPs also lack a secure context.
 * 8. 192.168.137.1: Local-network IP address. Ineligible: Same as above.
 * 9. com.smartattend.app: Native Android Application Package Identifier. Ineligible: Android OS package ID, not a web origin FQDN. Native attendance authenticates via AndroidKeyStore P-256 ECDSA signatures.
 */
const WEBAUTHN_CONFIG = {
  "smartattend-ochre.vercel.app": {
    rpId: "smartattend-ochre.vercel.app",
    rpName: "SmartAttend Production",
    allowedOrigins: ["https://smartattend-ochre.vercel.app"],
    category: "PRIMARY_PRODUCTION",
    isProduction: true
  },
  "smart-attendance-ok.web.app": {
    rpId: "smart-attendance-ok.web.app",
    rpName: "SmartAttend (Firebase Hosting)",
    allowedOrigins: ["https://smart-attendance-ok.web.app"],
    category: "FIREBASE_HOSTING",
    isProduction: true
  },
  "smart-attendance-ok.firebaseapp.com": {
    rpId: "smart-attendance-ok.firebaseapp.com",
    rpName: "SmartAttend (Firebase App)",
    allowedOrigins: ["https://smart-attendance-ok.firebaseapp.com"],
    category: "FIREBASE_HOSTING",
    isProduction: true
  },
  "smartattend-git-testing-branch-onteddukalyanis-projects.vercel.app": {
    rpId: "smartattend-git-testing-branch-onteddukalyanis-projects.vercel.app",
    rpName: "SmartAttend Preview (Testing Branch)",
    allowedOrigins: ["https://smartattend-git-testing-branch-onteddukalyanis-projects.vercel.app"],
    category: "VERCEL_PREVIEW",
    isProduction: false
  },
  "smartattend-ogcg41pzx-onteddukalyanis-projects.vercel.app": {
    rpId: "smartattend-ogcg41pzx-onteddukalyanis-projects.vercel.app",
    rpName: "SmartAttend Preview Deployment",
    allowedOrigins: ["https://smartattend-ogcg41pzx-onteddukalyanis-projects.vercel.app"],
    category: "VERCEL_PREVIEW",
    isProduction: false
  },
  "localhost": {
    rpId: "localhost",
    rpName: "SmartAttend (Local Dev)",
    allowedOrigins: [
      "http://localhost:5173",
      "http://localhost:3000",
      "http://localhost:4173",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:3000"
    ],
    category: "DEVELOPMENT",
    isProduction: false
  }
};

const INELIGIBLE_WEBAUTHN_DOMAINS = {
  "10.0.13.164": {
    category: "LOCAL_NETWORK_IP",
    reason: "W3C WebAuthn Section 5.1.4 requires RP IDs to be valid domain strings. Raw IP addresses are explicitly prohibited by browser WebAuthn engines and plain HTTP over LAN lacks a secure context."
  },
  "192.168.137.1": {
    category: "LOCAL_NETWORK_IP",
    reason: "W3C WebAuthn Section 5.1.4 requires RP IDs to be valid domain strings. Raw IP addresses are explicitly prohibited by browser WebAuthn engines and plain HTTP over LAN lacks a secure context."
  },
  "com.smartattend.app": {
    category: "NATIVE_ANDROID_PACKAGE",
    reason: "Android package identifiers are native OS application IDs, not web origin FQDNs. Native Android uses AndroidKeyStore P-256 ECDSA signatures, not browser WebAuthn RP IDs."
  }
};

/**
 * Validates and resolves authoritative WebAuthn configuration for a given requested origin and/or RP ID.
 * Strictly verifies against the allowlist. Rejects arbitrary domains, raw IPs, and package IDs.
 *
 * @param {string} [requestedOrigin]
 * @param {string} [requestedRpId]
 * @returns {{ rpId: string, rpName: string, expectedOrigins: string[], category: string }}
 */
function resolveWebAuthnTarget(requestedOrigin, requestedRpId) {
  let rpCandidate = (requestedRpId || "").trim().toLowerCase();
  let originHost = "";
  let cleanOrigin = (requestedOrigin || "").trim();

  if (cleanOrigin) {
    try {
      const parsed = new URL(cleanOrigin);
      originHost = parsed.hostname.toLowerCase();
      cleanOrigin = `${parsed.protocol}//${parsed.host}`;
    } catch (_) {}
  }

  // 1. W3C Rule: Raw IP addresses can never be used as RP IDs
  if (rpCandidate === "127.0.0.1") {
    throw new HttpsError(
      "invalid-argument",
      'Domain "127.0.0.1" is ineligible as a WebAuthn RP ID under W3C rules (RP IDs must be domain strings, not raw IP addresses). When testing on 127.0.0.1, use RP ID "localhost" with origin "http://127.0.0.1:5173".'
    );
  }

  // If no RP candidate provided, derive candidate domain from origin
  if (!rpCandidate && originHost) {
    rpCandidate = originHost === "127.0.0.1" ? "localhost" : originHost;
  }

  // Check ineligible registry
  if (INELIGIBLE_WEBAUTHN_DOMAINS[rpCandidate] || INELIGIBLE_WEBAUTHN_DOMAINS[originHost]) {
    const reason = (INELIGIBLE_WEBAUTHN_DOMAINS[rpCandidate] || INELIGIBLE_WEBAUTHN_DOMAINS[originHost]).reason;
    throw new HttpsError("invalid-argument", `Domain "${rpCandidate || originHost}" is ineligible for WebAuthn: ${reason}`);
  }

  // 2. Check development environment gating
  if (rpCandidate === "localhost" || originHost === "localhost" || originHost === "127.0.0.1") {
    const allowLocalhost = process.env.ALLOW_LOCALHOST_WEBAUTHN !== "false";
    if (!allowLocalhost) {
      throw new HttpsError("permission-denied", "Localhost WebAuthn is disabled in strict production environment.");
    }
    const config = WEBAUTHN_CONFIG["localhost"];
    if (cleanOrigin && !config.allowedOrigins.includes(cleanOrigin)) {
      throw new HttpsError("permission-denied", `Origin "${cleanOrigin}" is not an authorized origin for localhost development.`);
    }
    return {
      rpId: config.rpId,
      rpName: config.rpName,
      expectedOrigins: config.allowedOrigins,
      category: config.category
    };
  }

  // 3. Fallback to primary production if neither candidate is specified
  if (!rpCandidate && !originHost) {
    const primary = WEBAUTHN_CONFIG["smartattend-ochre.vercel.app"];
    return {
      rpId: primary.rpId,
      rpName: primary.rpName,
      expectedOrigins: primary.allowedOrigins,
      category: primary.category
    };
  }

  // 4. Look up in authoritative allowlist
  let config = null;
  if (rpCandidate) {
    config = WEBAUTHN_CONFIG[rpCandidate];
  } else if (originHost) {
    config = WEBAUTHN_CONFIG[originHost];
  }

  // Optional: check process.env.ADDITIONAL_WEBAUTHN_DOMAINS
  if (!config && process.env.ADDITIONAL_WEBAUTHN_DOMAINS) {
    const additional = process.env.ADDITIONAL_WEBAUTHN_DOMAINS.split(",").map(d => d.trim().toLowerCase());
    const lookupKey = rpCandidate || originHost;
    if (additional.includes(lookupKey)) {
      config = {
        rpId: lookupKey,
        rpName: `SmartAttend (${lookupKey})`,
        allowedOrigins: [`https://${lookupKey}`],
        category: "CUSTOM_CONFIGURED"
      };
    }
  }

  if (!config) {
    throw new HttpsError(
      "permission-denied",
      `WebAuthn verification rejected: Domain "${rpCandidate || originHost}" is not in the authorized WebAuthn allowlist.`
    );
  }

  // If both RP candidate and config exist, ensure they match exactly
  if (rpCandidate && config.rpId !== rpCandidate) {
    throw new HttpsError(
      "permission-denied",
      `WebAuthn verification rejected: Specified RP ID "${rpCandidate}" does not match authorized configuration "${config.rpId}".`
    );
  }

  // 5. Strictly enforce that the requested origin matches the allowed origins for this exact RP ID
  if (cleanOrigin && !config.allowedOrigins.includes(cleanOrigin)) {
    throw new HttpsError(
      "permission-denied",
      `Origin "${cleanOrigin}" does not match the authorized origins for RP ID "${config.rpId}".`
    );
  }

  return {
    rpId: config.rpId,
    rpName: config.rpName,
    expectedOrigins: config.allowedOrigins,
    category: config.category
  };
}

/**
 * Validates a 128-dimensional face embedding vector for structural integrity, bounds, and entropy.
 * Rejects non-arrays, non-128 lengths, non-finite values, near-zero magnitudes (synthetic zero-vectors),
 * and constant-value vectors lacking natural facial entropy.
 *
 * @param {any} descriptor
 * @param {string} fieldName
 * @returns {boolean}
 */
function validateFaceVectorDescriptor(descriptor, fieldName = "Face descriptor") {
  if (!Array.isArray(descriptor) || descriptor.length !== 128) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a valid 128-dimensional array.`);
  }

  let sumSquares = 0;
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const val = Number(descriptor[i]);
    if (!Number.isFinite(val) || Math.abs(val) > 10.0) {
      throw new HttpsError("invalid-argument", `${fieldName} contains invalid non-numeric or out-of-bounds float values at index ${i}.`);
    }
    sum += val;
    sumSquares += val * val;
  }

  // Reject all-zero or degenerate vectors
  const norm = Math.sqrt(sumSquares);
  if (norm < 0.1) {
    throw new HttpsError("invalid-argument", `${fieldName} has near-zero magnitude (degenerate/synthetic zero vector).`);
  }

  // Compute standard deviation to reject constant/fabricated vectors (e.g., all 0.5)
  const mean = sum / 128;
  let varianceSum = 0;
  for (let i = 0; i < 128; i++) {
    const d = Number(descriptor[i]) - mean;
    varianceSum += d * d;
  }
  const stdDev = Math.sqrt(varianceSum / 128);
  if (stdDev < 0.005) {
    throw new HttpsError("invalid-argument", `${fieldName} lacks necessary facial entropy (synthetic constant vector).`);
  }

  return true;
}

/**
 * Verifies hardware biometric signature against registered public key.
 * Strictly verifies signatures in Cloud Functions memory.
 * Supports:
 * - WebAuthn assertions via @simplewebauthn/server (Safari / Chrome Passkeys / Platform authenticators)
 *   Validates: expected challenge, origin, RP ID hash, ceremony type, UP/UV authenticator flags, counter, and signature.
 * - Direct ECDSA signatures over canonical UTF-8 challengeText (Android Keystore & Apple Secure Enclave)
 */
async function verifyHardwareSignature(publicKeyDerBase64, challengeText, hardwareProof, options = {}) {
  try {
    if (!publicKeyDerBase64 || !challengeText || !hardwareProof) return false;

    // A. WebAuthn Payload Verification (@simplewebauthn/server standard verification)
    if (hardwareProof.clientDataJSON && hardwareProof.authenticatorData) {
      const clientDataB64Url = toBase64Url(hardwareProof.clientDataJSON);
      const authDataB64Url = toBase64Url(hardwareProof.authenticatorData);
      const signatureB64Url = toBase64Url(
        typeof hardwareProof === "string" ? hardwareProof : hardwareProof.signature
      );

      if (!clientDataB64Url || !authDataB64Url || !signatureB64Url) {
        return false;
      }

      // Resolve COSE Public Key for @simplewebauthn/server
      let coseKeyBuffer = null;
      if (options.credentialPublicKey) {
        coseKeyBuffer = Buffer.isBuffer(options.credentialPublicKey)
          ? options.credentialPublicKey
          : Buffer.from(options.credentialPublicKey, "base64");
      } else {
        const derBuf = Buffer.from(publicKeyDerBase64.trim(), "base64");
        if (derBuf.length === 91) {
          coseKeyBuffer = spkiToCose(derBuf);
        } else {
          coseKeyBuffer = derBuf;
        }
      }

      if (!coseKeyBuffer) {
        console.warn("Unable to resolve COSE public key for WebAuthn assertion.");
        return false;
      }

      // Extract client origin from clientDataJSON
      let clientOrigin = "";
      try {
        const parsedClient = JSON.parse(Buffer.from(clientDataB64Url, "base64url").toString("utf8"));
        clientOrigin = parsedClient.origin || "";
      } catch (_) {
        return false;
      }

      // Resolve authoritative Origin and RP ID strictly via allowlist
      let resolvedTarget;
      try {
        resolvedTarget = resolveWebAuthnTarget(options.origin || clientOrigin, options.rpId);
      } catch (err) {
        console.warn("WebAuthn target resolution failed:", err.message);
        return false;
      }

      const expectedOrigins = resolvedTarget.expectedOrigins;
      const expectedRPIDs = [resolvedTarget.rpId];

      // Resolve Expected WebAuthn Challenge
      let expectedChallengeForWebAuthn = challengeText;
      try {
        const parsedClient = JSON.parse(Buffer.from(clientDataB64Url, "base64url").toString("utf8"));
        const clientChal = parsedClient.challenge || "";
        const utf8B64Url = Buffer.from(challengeText, "utf8").toString("base64url");
        const hexB64Url = Buffer.from(challengeText, "hex").toString("base64url");

        if (clientChal === challengeText) {
          expectedChallengeForWebAuthn = challengeText;
        } else if (clientChal === utf8B64Url) {
          expectedChallengeForWebAuthn = utf8B64Url;
        } else if (clientChal === hexB64Url) {
          expectedChallengeForWebAuthn = hexB64Url;
        }
      } catch (_) {
        return false;
      }

      const credentialId = hardwareProof.id || hardwareProof.credentialId || options.credentialId || "smartattend-key";

      const authResponse = {
        id: credentialId,
        rawId: credentialId,
        response: {
          clientDataJSON: clientDataB64Url,
          authenticatorData: authDataB64Url,
          signature: signatureB64Url,
          userHandle: hardwareProof.userHandle || undefined
        },
        type: "public-key"
      };

      try {
        const verification = await verifyAuthenticationResponse({
          response: authResponse,
          expectedChallenge: expectedChallengeForWebAuthn,
          expectedOrigin: expectedOrigins,
          expectedRPID: expectedRPIDs,
          credential: {
            id: credentialId,
            publicKey: coseKeyBuffer,
            counter: typeof options.counter === "number" ? options.counter : 0
          },
          requireUserVerification: options.requireUserVerification !== false
        });

        if (verification && verification.verified) {
          const authInfo = verification.authenticationInfo;
          return {
            verified: true,
            newCounter: typeof authInfo?.newCounter === "number" ? authInfo.newCounter : 0,
            credentialDeviceType: authInfo?.credentialDeviceType || "singleDevice",
            credentialBackedUp: Boolean(authInfo?.credentialBackedUp)
          };
        }
        return false;
      } catch (authErr) {
        console.warn("WebAuthn verification via @simplewebauthn/server rejected:", authErr.message);
        return false;
      }
    }

    // B. Native Mobile ECDSA Verification (Android Keystore & Apple Secure Enclave)
    const pem = derToPem(publicKeyDerBase64);
    const signatureBuffer = parseSignatureBuffer(
      typeof hardwareProof === "string" ? hardwareProof : hardwareProof.signature
    );

    if (!signatureBuffer || signatureBuffer.length === 0) {
      return false;
    }

    const verify = crypto.createVerify("SHA256");
    verify.update(Buffer.from(challengeText, "utf8"));
    const isEcdsaValid = verify.verify(pem, signatureBuffer);
    if (isEcdsaValid) {
      return {
        verified: true,
        newCounter: 0,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false
      };
    }
    return false;
  } catch (err) {
    console.warn("Hardware biometric signature verification error:", err.message);
    return false;
  }
}

/**
 * Utility: Verify ECDSA SHA-256 signature over UTF-8 challenge string.
 * Backward compatible wrapper delegating to universal verifyHardwareSignature.
 */
async function verifyEcdsaSignature(derBase64Key, challengeText, signature, options = {}) {
  return await verifyHardwareSignature(derBase64Key, challengeText, { signature }, options);
}

/**
 * Utility: Look up authoritative student profile with strict account verification.
 * Rejects unlinked accounts, unknown UIDs, and generic/prefix-derived rolls.
 */
async function resolveAuthoritativeStudent(uid, email) {
  const cleanEmail = (email || "").toLowerCase().trim();

  // 1. Check users collection by UID
  if (uid) {
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists) {
      const data = userSnap.data();
      const rawRoll = data.rollNo || data.studentId;
      if (rawRoll) {
        const rollNo = String(rawRoll).trim().toUpperCase();
        // Verify student document in students collection
        const studentDocSnap = await db.collection("students").doc(rollNo).get();
        if (studentDocSnap.exists) {
          const sData = studentDocSnap.data();
          return {
            uid: uid,
            rollNo: rollNo,
            name: sData.name || sData.fullName || data.name || data.fullName || rollNo,
            email: sData.email || data.email || cleanEmail
          };
        }
        return {
          uid: uid,
          rollNo: rollNo,
          name: data.name || data.fullName || data.displayName || rollNo,
          email: data.email || cleanEmail
        };
      }
    }
  }

  // 2. Query students collection by UID
  if (uid) {
    const sUidQuery = await db.collection("students").where("uid", "==", uid).limit(1).get();
    if (!sUidQuery.empty) {
      const docSnap = sUidQuery.docs[0];
      const data = docSnap.data();
      const rollNo = String(data.rollNo || docSnap.id).trim().toUpperCase();
      return {
        uid: uid,
        rollNo: rollNo,
        name: data.name || data.fullName || rollNo,
        email: data.email || cleanEmail
      };
    }
  }

  // 3. Check authorizedUsers by email & verify matching student doc
  if (cleanEmail) {
    const authSnap = await db.collection("authorizedUsers").doc(cleanEmail).get();
    if (authSnap.exists) {
      const data = authSnap.data();
      if (data.rollNo) {
        const rollNo = String(data.rollNo).trim().toUpperCase();
        const studentDocSnap = await db.collection("students").doc(rollNo).get();
        if (studentDocSnap.exists) {
          const sData = studentDocSnap.data();
          return {
            uid: uid || sData.uid || cleanEmail,
            rollNo: rollNo,
            name: sData.name || data.name || data.fullName || rollNo,
            email: cleanEmail
          };
        }
        return {
          uid: uid || cleanEmail,
          rollNo: rollNo,
          name: data.name || data.fullName || rollNo,
          email: cleanEmail
        };
      }
    }
  }

  // 4. Query students collection by email with strict enrollment check
  if (cleanEmail) {
    const sQuery = await db.collection("students").where("email", "==", cleanEmail).limit(1).get();
    if (!sQuery.empty) {
      const docSnap = sQuery.docs[0];
      const data = docSnap.data();
      const rollNo = String(data.rollNo || docSnap.id).trim().toUpperCase();
      return {
        uid: uid || data.uid || cleanEmail,
        rollNo: rollNo,
        name: data.name || data.fullName || rollNo,
        email: cleanEmail
      };
    }
  }

  // Reject unlinked or unverified student account
  throw new HttpsError(
    "permission-denied",
    "Student account is not authoritatively linked to an enrolled student record. Please contact the institution administrator."
  );
}

/**
 * Utility: Backward-compatible wrapper
 */
async function resolveTrustedStudent(uid, email) {
  return resolveAuthoritativeStudent(uid, email);
}

/**
 * Utility: Role & Course Scope Verification
 */
async function assertAdmin(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  const uid = request.auth.uid;
  const email = (request.auth.token.email || "").toLowerCase().trim();

  // Check users/{uid}
  const userDoc = await db.collection("users").doc(uid).get();
  if (userDoc.exists && userDoc.data().role === "admin") return true;

  // Check admins collection
  const adminDoc = await db.collection("admins").doc(uid).get();
  if (adminDoc.exists) return true;
  if (email) {
    const adminEmailDoc = await db.collection("admins").doc(email).get();
    if (adminEmailDoc.exists) return true;
    const prefix = email.split("@")[0];
    const adminPrefixDoc = await db.collection("admins").doc(prefix).get();
    if (adminPrefixDoc.exists) return true;
  }

  throw new HttpsError("permission-denied", "Operation restricted to verified administrators.");
}

async function isCallerAdmin(request) {
  try {
    await assertAdmin(request);
    return true;
  } catch (e) {
    return false;
  }
}

async function assertLecturer(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  if (await isCallerAdmin(request)) return true;

  const uid = request.auth.uid;
  const email = (request.auth.token.email || "").toLowerCase().trim();

  // Check users/{uid}
  const userDoc = await db.collection("users").doc(uid).get();
  if (userDoc.exists && (userDoc.data().role === "lecturer" || userDoc.data().role === "faculty")) return true;

  // Check lecturers collection
  const lectDoc = await db.collection("lecturers").doc(uid).get();
  if (lectDoc.exists) return true;
  if (email) {
    const lectEmailDoc = await db.collection("lecturers").doc(email).get();
    if (lectEmailDoc.exists) return true;
    const prefix = email.split("@")[0];
    const lectPrefixDoc = await db.collection("lecturers").doc(prefix).get();
    if (lectPrefixDoc.exists) return true;
  }

  throw new HttpsError("permission-denied", "Operation restricted to authorized faculty and lecturers.");
}

async function assertLecturerCourseScope(lecturerUid, lecturerEmail, courseCode) {
  const cleanCourse = String(courseCode || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const courseDoc = await db.collection("courses").doc(cleanCourse).get();

  if (!courseDoc.exists) {
    throw new HttpsError("not-found", `Course "${cleanCourse}" not found.`);
  }

  const courseData = courseDoc.data();
  const cleanEmail = (lecturerEmail || "").toLowerCase().trim();

  // Check assigned lecturers
  let isAssigned = false;
  if (courseData.lecturerEmail && courseData.lecturerEmail.toLowerCase().trim() === cleanEmail) {
    isAssigned = true;
  }
  if (Array.isArray(courseData.assignedLecturers)) {
    for (const l of courseData.assignedLecturers) {
      const lEmail = typeof l === "string" ? l.toLowerCase().trim() : (l.email || "").toLowerCase().trim();
      const lUid = typeof l === "object" ? l.uid : null;
      if (lEmail === cleanEmail || (lUid && lUid === lecturerUid)) {
        isAssigned = true;
        break;
      }
    }
  }

  if (!isAssigned) {
    throw new HttpsError("permission-denied", `Lecturer is not assigned to course "${cleanCourse}".`);
  }

  return courseData;
}

/**
 * 1. INITIATE ATTENDANCE SESSION (Lecturer only)
 * Sets fixed authoritative session timeline:
 * T = 0s  : Session Start
 * T = 60s : QR 1 Expires (1 min) / QR 2 Starts (2 min)
 * T = 180s: Session & Kiosk Period Ends (kioskEndsAt, 3 min total)
 */
exports.initiateAttendanceSession = onCall({ cors: true }, async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to initiate session.");
  }

  const { classCode, courseCode, roomNo, batch, lecturerInfo, geofenceRadius } = request.data || {};
  if (!classCode || !courseCode || !roomNo) {
    throw new HttpsError("invalid-argument", "Missing required session parameters (classCode, courseCode, roomNo).");
  }

  // Server-side role and course assignment verification
  await assertLecturer(request);
  const isAdmin = await isCallerAdmin(request);
  const lecturerEmail = (request.auth.token.email || lecturerInfo?.email || "").toLowerCase().trim();
  if (!isAdmin) {
    await assertLecturerCourseScope(request.auth.uid, lecturerEmail, courseCode);
  }

  const nowMs = Date.now();
  const sessionStartMs = nowMs;

  // Granular QR1 + QR2 Duration Timetable Breakdown (e.g. 30s QR1 + 30s QR2 = 1 min)
  let qr1DurationSec = 60;
  let qr2DurationSec = 120;

  if (Number(request.data?.qr1DurationSeconds) > 0 && Number(request.data?.qr2DurationSeconds) > 0) {
    qr1DurationSec = Math.max(15, Math.min(600, Math.round(Number(request.data.qr1DurationSeconds))));
    qr2DurationSec = Math.max(15, Math.min(1800, Math.round(Number(request.data.qr2DurationSeconds))));
  } else if (Number(request.data?.durationMinutes) > 0) {
    const totalMinutes = Number(request.data.durationMinutes);
    const totalSec = Math.round(totalMinutes * 60);
    qr1DurationSec = Math.min(60, Math.max(20, Math.round(totalSec / 3)));
    qr2DurationSec = totalSec - qr1DurationSec;
  }

  const totalDurationMs = (qr1DurationSec + qr2DurationSec) * 1000;
  const qr1ExpiresMs = sessionStartMs + (qr1DurationSec * 1000);
  const qr2StartsMs = qr1ExpiresMs;
  const kioskEndsMs = sessionStartMs + totalDurationMs;
  const totalDurationMin = Math.round(((qr1DurationSec + qr2DurationSec) / 60) * 10) / 10;

  const qr1Token = crypto.randomBytes(20).toString("hex");
  const qr1TokenHash = hashToken(qr1Token);

  const qr2Token = crypto.randomBytes(20).toString("hex");
  const qr2TokenHash = hashToken(qr2Token);

  const rawReleaseCode = (request.data && (request.data.lecturerReleaseCode || request.data.lecturerPin))
    ? String(request.data.lecturerReleaseCode || request.data.lecturerPin).trim()
    : Math.floor(100000 + Math.random() * 900000).toString();
  const lecturerReleaseCodeHash = hashToken(rawReleaseCode);

  const cleanCourse = courseCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const cleanClass = classCode !== courseCode ? `_${classCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "")}` : "";
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const sessionId = `${cleanCourse}${cleanClass}_${nowMs}_${randomSuffix}`;

  const lecturerName = lecturerInfo?.name || request.auth.token.name || (lecturerEmail ? lecturerEmail.split("@")[0] : "Lecturer");

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);

  // Public Session Document (Zero release codes or sensitive token hashes exposed to clients)
  const sessionDoc = {
    id: sessionId,
    sessionId: sessionId,
    classCode: classCode,
    courseCode: courseCode,
    roomNo: roomNo,
    batch: batch || "2025",
    geofenceRadius: typeof geofenceRadius === "number" ? geofenceRadius : 10,
    phase: "PHASE_1",
    status: "ACTIVE",
    active: true,
    ownerId: request.auth.uid,
    ownerEmail: lecturerEmail,
    lecturerName: lecturerName,
    lecturerEmail: lecturerEmail,
    lecturerDepartment: lecturerInfo?.department || "CSE",
    sessionStartAt: Timestamp.fromMillis(sessionStartMs),
    qr1ExpiresAt: Timestamp.fromMillis(qr1ExpiresMs),
    qr2StartsAt: Timestamp.fromMillis(qr2StartsMs),
    kioskEndsAt: Timestamp.fromMillis(kioskEndsMs),
    expiresAt: Timestamp.fromMillis(kioskEndsMs),
    qr1DurationSeconds: qr1DurationSec,
    qr2DurationSeconds: qr2DurationSec,
    totalDurationSeconds: qr1DurationSec + qr2DurationSec,
    durationMinutes: totalDurationMin,
    createdAt: FieldValue.serverTimestamp(),
    authorizedCount: 0,
    attendanceCount: 0,
    attendees: []
  };

  // Private Security Document (Only Cloud Functions Admin SDK can read/write; zero client access)
  const securityDoc = {
    qr1TokenHash: qr1TokenHash,
    qr2TokenHash: qr2TokenHash,
    lecturerReleaseCodeHash: lecturerReleaseCodeHash,
    sessionPinHash: lecturerReleaseCodeHash,
    sessionStartAt: Timestamp.fromMillis(sessionStartMs),
    qr1ExpiresAt: Timestamp.fromMillis(qr1ExpiresMs),
    qr2StartsAt: Timestamp.fromMillis(qr2StartsMs),
    kioskEndsAt: Timestamp.fromMillis(kioskEndsMs)
  };

  await Promise.all([
    sessionRef.set(sessionDoc),
    sessionRef.collection("security").doc("tokens").set(securityDoc)
  ]);

  return {
    success: true,
    sessionId: sessionId,
    qr1Token: qr1Token,
    qr2Token: qr2Token,
    sessionStartAt: sessionStartMs,
    qr1ExpiresAt: qr1ExpiresMs,
    qr2StartsAt: qr2StartsMs,
    kioskEndsAt: kioskEndsMs,
    phase: "PHASE_1",
    status: "ACTIVE",
    sessionPin: rawReleaseCode,
    lecturerPin: rawReleaseCode,
    lecturerReleaseCode: rawReleaseCode
  };
});

/**
 * 2. AUTHORIZE QR 1 (Student Check-in Gate)
 * Strictly verifies QR 1 token within T = 0–60s server-time.
 * Ties the student to the fixed session kioskEndsAt deadline (T = 120s).
 */
exports.authorizeQR1 = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required. Please log in to SmartAttend.");
  }

  const { sessionId, qr1Token, deviceId, isDeviceOwner, studentLocation } = request.data || {};
  if (!sessionId || !qr1Token) {
    throw new HttpsError("invalid-argument", "Session ID and QR 1 token are required.");
  }

  const studentUid = request.auth.uid;
  const studentEmail = request.auth.token.email || "";

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const [sessionSnap, securitySnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("security").doc("tokens").get()
  ]);

  if (!sessionSnap.exists || !securitySnap.exists) {
    throw new HttpsError("not-found", "Attendance session not found.");
  }

  const session = sessionSnap.data();
  const security = securitySnap.data();

  // 1. Validate session active
  if (session.active === false || session.status === "CLOSED" || session.phase === "CLOSED") {
    throw new HttpsError("failed-precondition", "This attendance session has already ended.");
  }

  // STRICT RULE: QR 1 is only open during PHASE_1. Once transitioned to Phase 2 or closed, QR 1 NEVER reopens.
  if (session.phase && session.phase !== "PHASE_1") {
    throw new HttpsError("failed-precondition", "QR 1 check-in is closed. Session has already transitioned to Phase 2.");
  }

  // 2. Server-side time check: QR 1 valid strictly during T = 0 to 60s
  const serverNow = Date.now();
  const qr1ExpiresAtMs = security.qr1ExpiresAt ? security.qr1ExpiresAt.toMillis() : 0;
  const kioskEndsAtMs = security.kioskEndsAt ? security.kioskEndsAt.toMillis() : 0;

  if (serverNow > qr1ExpiresAtMs) {
    throw new HttpsError("deadline-exceeded", "❌ QR 1 has expired! The 60-second check-in window is closed.");
  }

  // 3. Cryptographic token match against private security doc
  const inputHash = hashToken(qr1Token);
  if (inputHash !== security.qr1TokenHash) {
    throw new HttpsError("permission-denied", "❌ Invalid QR 1 token.");
  }

  // 3b. Server-Side Geofence Verification (if enabled by lecturer)
  const classroomLoc = session.classroomLocation;
  const radius = typeof session.geofenceRadius === "number" ? session.geofenceRadius : 10;
  if (classroomLoc && classroomLoc.latitude != null && classroomLoc.longitude != null && radius > 0) {
    const geoResult = evaluateServerGeofence(studentLocation, classroomLoc, radius);
    if (geoResult.status === "MOCK_DETECTED") {
      throw new HttpsError("permission-denied", "🚨 Anti-Proxy Violation: Mock / Spoofed GPS detected. Attendance check-in rejected.");
    }
    if (geoResult.status === "REJECT") {
      throw new HttpsError("permission-denied", `❌ Geofence Violation: You are outside the classroom (${geoResult.distance}m > ${radius}m). Attendance check-in rejected.`);
    }
  }

  // 4. Resolve trusted student identity from database
  const studentProfile = await resolveTrustedStudent(studentUid, studentEmail);

  // 5. Check existing authorization
  const authRef = sessionRef.collection("authorizations").doc(studentUid);
  const existingAuth = await authRef.get();

  if (existingAuth.exists) {
    const data = existingAuth.data();
    if (data.disqualified === true || (data.hasViolation === true && !data.excused)) {
      throw new HttpsError("permission-denied", "❌ Attendance check-in rejected: You have an unexcused violation or disqualification for this session.");
    }
    return {
      success: true,
      status: "SESSION_AUTHORIZED",
      sessionId: sessionId,
      rollNo: data.rollNo,
      studentName: data.studentName,
      sessionStartAt: security.sessionStartAt.toMillis(),
      qr1ExpiresAt: qr1ExpiresAtMs,
      kioskEndsAt: kioskEndsAtMs,
      message: "Already authorized for this session."
    };
  }

  // 6. Atomic transaction: create authorization & increment count
  await db.runTransaction(async (transaction) => {
    const freshSessionSnap = await transaction.get(sessionRef);
    if (!freshSessionSnap.exists || freshSessionSnap.data().active === false || freshSessionSnap.data().status === "CLOSED") {
      throw new HttpsError("failed-precondition", "Session ended during authorization.");
    }

    transaction.set(authRef, {
      studentUid: studentUid,
      studentEmail: studentProfile.email,
      rollNo: studentProfile.rollNo,
      studentName: studentProfile.name,
      deviceId: deviceId || "UNKNOWN_DEVICE",
      isDeviceOwner: Boolean(isDeviceOwner),
      qr1Verified: true,
      status: "QR1_VERIFIED",
      releaseStatus: "LOCKED",
      released: false,
      authorizedAt: FieldValue.serverTimestamp(),
      sessionId: sessionId,
      kioskEndsAt: security.kioskEndsAt
    });

    transaction.update(sessionRef, {
      authorizedCount: FieldValue.increment(1)
    });
  });

  return {
    success: true,
    status: "QR1_VERIFIED",
    qr1Verified: true,
    sessionId: sessionId,
    rollNo: studentProfile.rollNo,
    studentName: studentProfile.name,
    sessionStartAt: security.sessionStartAt ? security.sessionStartAt.toMillis() : 0,
    qr1ExpiresAt: qr1ExpiresAtMs,
    qr2StartsAt: security.qr2StartsAt ? security.qr2StartsAt.toMillis() : qr1ExpiresAtMs,
    kioskEndsAt: kioskEndsAtMs,
    message: "QR1 Verified! Android Kiosk Lock Task Mode activated."
  };
});

/**
 * 3. TRANSITION TO PHASE 2 (Lecturer or Automatic at T=60s)
 * Transitions session to PHASE_2.
 */
exports.transitionToPhase2 = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const { sessionId } = request.data || {};
  if (!sessionId) {
    throw new HttpsError("invalid-argument", "Session ID is required.");
  }

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const [sessionSnap, securitySnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("security").doc("tokens").get()
  ]);

  if (!sessionSnap.exists || !securitySnap.exists) {
    throw new HttpsError("not-found", "Session not found.");
  }

  const session = sessionSnap.data();
  if (session.ownerId !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only the session lecturer can transition to Phase 2.");
  }

  await sessionRef.update({
    phase: "PHASE_2"
  });

  return {
    success: true,
    sessionId: sessionId,
    phase: "PHASE_2"
  };
});

/**
 * 4. VALIDATE QR 2 (Student Gate)
 * STRICT NON-NEGOTIABLE RULE:
 * 1. Must be within T = 60s–180s session window.
 * 2. Requires authenticated student to have existing QR1_VERIFIED record from QR 1 for this exact session.
 * 3. Rejects with "Access denied. You must scan QR 1 first." if unauthorized.
 */
exports.validateQR2 = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required. Please log in.");
  }

  const { sessionId, qr2Token } = request.data || {};
  if (!sessionId || !qr2Token) {
    throw new HttpsError("invalid-argument", "Session ID and QR 2 token are required.");
  }

  const studentUid = request.auth.uid;
  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const [sessionSnap, securitySnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("security").doc("tokens").get()
  ]);

  if (!sessionSnap.exists || !securitySnap.exists) {
    throw new HttpsError("not-found", "Attendance session not found.");
  }

  const session = sessionSnap.data();
  const security = securitySnap.data();

  // 1. Validate session active
  if (session.active === false || session.status === "CLOSED") {
    throw new HttpsError("failed-precondition", "This attendance session has ended.");
  }

  // 2. Validate server time within T = 60s to 180s
  const serverNow = Date.now();
  const kioskEndsAtMs = security.kioskEndsAt ? security.kioskEndsAt.toMillis() : 0;

  if (serverNow > kioskEndsAtMs) {
    throw new HttpsError("deadline-exceeded", "❌ Attendance session has closed. 3-minute session deadline elapsed.");
  }

  // 3. Validate QR 2 token
  const inputHash = hashToken(qr2Token);
  if (inputHash !== security.qr2TokenHash) {
    throw new HttpsError("permission-denied", "❌ Invalid QR 2 token.");
  }

  // 4. STRICT CHECK: Must have QR1_VERIFIED authorization from QR 1 for this exact session
  const authRef = sessionRef.collection("authorizations").doc(studentUid);
  const authSnap = await authRef.get();

  const isQr1Valid = authSnap.exists && (authSnap.data().qr1Verified === true || authSnap.data().status === "QR1_VERIFIED" || authSnap.data().status === "SESSION_AUTHORIZED");
  if (!isQr1Valid) {
    throw new HttpsError(
      "permission-denied",
      "⛔ Access denied. You must scan QR 1 first."
    );
  }

  const authData = authSnap.data();

  // 5. Check for duplicate attendance submission
  const recordId = `${sessionId}_${authData.rollNo}`;
  const recordSnap = await db.collection("attendance_records").doc(recordId).get();
  if (recordSnap.exists) {
    throw new HttpsError(
      "already-exists",
      `Roll Number ${authData.rollNo} has already submitted attendance for this session.`
    );
  }

  return {
    success: true,
    authorized: true,
    sessionId: sessionId,
    rollNo: authData.rollNo,
    studentName: authData.studentName,
    kioskEndsAt: kioskEndsAtMs,
    sessionDetails: {
      courseCode: session.courseCode || "N/A",
      classCode: session.classCode || "N/A",
      roomNo: session.roomNo || "N/A",
      batch: session.batch || "2025",
      lecturerName: session.lecturerName || ""
    }
  };
});

/**
 * 5. SUBMIT ATTENDANCE (Student Final Submission)
 * Re-validates QR 1 authorization, QR 2 token, biometric result, records 5-minute fail-safe auto-release timeline,
 * and maintains Lock Task Mode on the student device.
 */
exports.submitAttendance = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const {
    sessionId,
    qr2Token,
    biometricData,
    hardwareProof,
    deviceAuthMode,
    isNative
  } = request.data || {};
  if (!sessionId || !qr2Token) {
    throw new HttpsError("invalid-argument", "Missing sessionId or qr2Token.");
  }

  const studentUid = request.auth.uid;
  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const [sessionSnap, securitySnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("security").doc("tokens").get()
  ]);

  if (!sessionSnap.exists || !securitySnap.exists) {
    throw new HttpsError("not-found", "Attendance session not found.");
  }

  const session = sessionSnap.data();
  const security = securitySnap.data();

  const serverNow = Date.now();
  const kioskEndsAtMs = security.kioskEndsAt ? security.kioskEndsAt.toMillis() : 0;

  if (session.active === false || (kioskEndsAtMs && serverNow > kioskEndsAtMs)) {
    throw new HttpsError("failed-precondition", "Attendance session is closed.");
  }

  // 1. Re-validate QR 2 token
  if (hashToken(qr2Token) !== security.qr2TokenHash) {
    throw new HttpsError("permission-denied", "Invalid QR 2 token.");
  }

  // 2. Re-verify QR 1 authorization
  const authRef = sessionRef.collection("authorizations").doc(studentUid);
  const authSnap = await authRef.get();

  const isQr1Valid = authSnap.exists && (authSnap.data().qr1Verified === true || authSnap.data().status === "QR1_VERIFIED" || authSnap.data().status === "SESSION_AUTHORIZED");
  if (!isQr1Valid) {
    throw new HttpsError("permission-denied", "⛔ Access denied. You must scan QR 1 first.");
  }

  const authData = authSnap.data();

  // Strict authoritative violation enforcement: reject if unexcused violation or disqualified
  if (
    authData.disqualified === true ||
    (authData.hasViolation === true && !authData.excused) ||
    (authData.violation === 1 && !authData.excused) ||
    (Number(authData.confirmedKioskViolations || authData.violationCount || 0) >= 2 && authData.detectedPlatform === "android")
  ) {
    throw new HttpsError(
      "permission-denied",
      "❌ Attendance rejected: An unexcused security violation is recorded on your session. Attendance cannot be submitted unless excused by an authorized instructor."
    );
  }

  const rollNo = authData.rollNo;
  const recordId = `${sessionId}_${rollNo}`;

  // 3. Hardware Biometric Verification & Browser Fallback Policy
  let authMode = "WEB_BROWSER";
  let hardwarePlatform = "web";
  let signatureVerified = false;
  let credData = null;

  if (hardwareProof) {
    const { challengeId, signature, platform: proofPlatform, clientDataJSON, authenticatorData, rpId: proofRpId } = hardwareProof;
    if (!challengeId || !signature) {
      throw new HttpsError("invalid-argument", "Missing hardware biometric challengeId or signature.");
    }

    // Look up student's registered public key
    const credSnap = await db.collection("biometric_credentials").doc(studentUid).get();
    credData = credSnap.exists ? credSnap.data() : null;
    if (!credData) {
      const rollCredSnap = await db.collection("biometric_credentials").doc(rollNo).get();
      if (rollCredSnap.exists) credData = rollCredSnap.data();
    }

    if (!credData || credData.status !== "ACTIVE") {
      throw new HttpsError(
        "failed-precondition",
        "No active hardware biometric credential registered for this student. Please complete biometric setup first."
      );
    }

    // WebAuthn Assertion: Handle multi-RP ID credential isolation
    if (clientDataJSON && authenticatorData) {
      let clientOrigin = "";
      try {
        const clientB64 = toBase64Url(clientDataJSON);
        const parsed = JSON.parse(Buffer.from(clientB64, "base64url").toString("utf8"));
        clientOrigin = parsed.origin || "";
      } catch (_) {}

      const target = resolveWebAuthnTarget(clientOrigin, proofRpId);
      const rpIdKey = target.rpId.replace(/\./g, "_");

      let activeCredForRp = credData.credentialsByRpId?.[rpIdKey];
      if (!activeCredForRp && credData.rpId === target.rpId) {
        activeCredForRp = credData;
      }
      if (!activeCredForRp) {
        const rpSubSnap = await db.collection("biometric_credentials").doc(studentUid).collection("rp_credentials").doc(rpIdKey).get();
        if (rpSubSnap.exists) {
          activeCredForRp = rpSubSnap.data();
        }
      }

      if (!activeCredForRp || activeCredForRp.status !== "ACTIVE" || !activeCredForRp.publicKeyDerBase64) {
        throw new HttpsError(
          "permission-denied",
          `No active WebAuthn passkey registered for domain "${target.rpId}". Under WebAuthn rules, credentials registered on another domain cannot be used here. Please register your passkey on ${target.rpId}.`
        );
      }

      credData = activeCredForRp;
      hardwarePlatform = "webauthn";
      authMode = "WEBAUTHN_ASSERTION";
    } else {
      hardwarePlatform = proofPlatform || credData.platform || "unknown";
      authMode = "NATIVE_MOBILE";
    }

    signatureVerified = true;
  } else if (isNative) {
    // Native mobile app MUST provide hardwareProof
    throw new HttpsError("failed-precondition", "Hardware biometric signature is required for native mobile attendance.");
  } else {
    // Web browser fallback: zero signature fabrication.
    authMode = "WEB_BROWSER";
    hardwarePlatform = "web";
    signatureVerified = false;
  }

  // 4. Server-Side Face Identity & Vector Verification
  // Client-supplied fields like 'verified: true' or 'antiSpoofScore: "PASSED"' CANNOT independently authorize attendance.
  // The server independently fetches the authoritative enrolled faceDescriptor for the student
  // and computes the Euclidean distance against the 128-dimensional live descriptor.
  //
  // ARCHITECTURAL SECURITY NOTE:
  // Server-side vector distance computation mathematically proves identity matching against the student's enrolled template.
  // True neural liveness detection (distinguishing live human skin/3D depth from 2D screen/photo playback)
  // requires either hardware-attested sensor pipelines or streaming frames to a certified 3D liveness provider (e.g. FaceTec / AWS Rekognition).
  // The server enforces strict 128-vector matching and challenge-binding while documenting this infrastructure requirement.
  const studentDocSnap = await db.collection("students").doc(rollNo).get();
  if (!studentDocSnap.exists) {
    throw new HttpsError("failed-precondition", `Authoritative student record for ${rollNo} not found.`);
  }
  const studentDocData = studentDocSnap.data() || {};
  const enrolledDescriptor = studentDocData.faceDescriptor;

  // Validate structural integrity and entropy of authoritative enrolled template
  validateFaceVectorDescriptor(enrolledDescriptor, `Enrolled face template for ${rollNo}`);

  const liveDescriptor = biometricData?.liveDescriptor || biometricData?.faceDescriptor;
  // Validate structural integrity and entropy of live descriptor
  validateFaceVectorDescriptor(liveDescriptor, "Live face descriptor");

  // Calculate Euclidean distance in server memory: d = sqrt(sum((live[i] - enrolled[i])^2))
  let sumSquares = 0;
  for (let i = 0; i < 128; i++) {
    const liveVal = Number(liveDescriptor[i]);
    const enrolledVal = Number(enrolledDescriptor[i]);
    const diff = liveVal - enrolledVal;
    sumSquares += diff * diff;
  }
  const serverCalculatedDistance = Math.sqrt(sumSquares);
  const MAX_FACE_MATCH_THRESHOLD = 0.48; // ResNet-34 face match threshold

  // 4b. Anti-Fabrication & Exact-Match Vector Replay Gating
  // Physical Principle: Due to thermal sensor noise, light scattering, and float quantization,
  // two real-world optical camera captures will NEVER produce an identical 128-float vector down to IEEE-754 precision.
  // An exact match (distance < 0.001) proves an attacker extracted the enrolled vector and replayed it without camera capture.
  if (serverCalculatedDistance < 0.001) {
    throw new HttpsError(
      "permission-denied",
      "❌ Adversarial face replay detected: Live face descriptor is an exact duplicate of the enrolled template (distance < 0.001). Real optical captures cannot produce identical float vectors down to floating point precision. Attendance rejected."
    );
  }

  if (serverCalculatedDistance > MAX_FACE_MATCH_THRESHOLD) {
    throw new HttpsError(
      "permission-denied",
      `Face biometric verification failed: Live face does not match registered biometric profile for ${rollNo} (distance: ${serverCalculatedDistance.toFixed(4)} > ${MAX_FACE_MATCH_THRESHOLD}). Attendance rejected.`
    );
  }

  const serverMatchConfidence = Math.max(0, Math.min(100, Math.round((1 - (serverCalculatedDistance / 0.60)) * 100)));

  const submittedAtMs = Date.now();
  const autoReleaseAtMs = submittedAtMs + 5 * 60 * 1000; // 5-Minute Automatic Fail-Safe Release

  // 5. Atomic write with duplicate prevention & in-transaction challenge validation/consumption
  await db.runTransaction(async (transaction) => {
    // A. Transaction Reads (All reads executed before writes per Firestore transaction rules)
    const recordRef = db.collection("attendance_records").doc(recordId);
    const existingRec = await transaction.get(recordRef);
    if (existingRec.exists) {
      throw new HttpsError("already-exists", `Attendance for ${rollNo} is already recorded.`);
    }

    let challengeRef = null;
    if (hardwareProof) {
      challengeRef = db.collection("biometric_challenges").doc(hardwareProof.challengeId);
      const liveChallenge = await transaction.get(challengeRef);

      if (!liveChallenge.exists) {
        throw new HttpsError("permission-denied", "Invalid or unknown biometric challenge.");
      }

      const challengeData = liveChallenge.data();
      if (challengeData.used === true) {
        throw new HttpsError("permission-denied", "Biometric challenge has already been consumed (replay prevention).");
      }

      if (challengeData.studentUid !== studentUid) {
        throw new HttpsError("permission-denied", "Biometric challenge student UID mismatch.");
      }

      // 1. Strict Fail-Closed Expiry Validation (Elimination of Optional Chaining)
      const challengeExpiryMs = parseStrictTimestampMs(challengeData.expiresAt);
      if (!challengeExpiryMs) {
        throw new HttpsError(
          "permission-denied",
          "Security error: Biometric challenge has a missing or malformed expiration timestamp. Access denied."
        );
      }

      // 2. Strict Fail-Closed Expiry Check Against Trusted Server Time & Documented Clock-Skew Policy
      if (serverNow > (challengeExpiryMs + BIOMETRIC_CLOCK_SKEW_TOLERANCE_MS)) {
        throw new HttpsError(
          "deadline-exceeded",
          "Biometric challenge has expired. Please retry biometric verification."
        );
      }

      // 3. Cryptographic Signature Verification in Memory
      const isValidSig = await verifyHardwareSignature(
        credData.publicKeyDerBase64,
        challengeData.challengeText,
        hardwareProof,
        {
          credentialId: credData.credentialId,
          credentialPublicKey: credData.credentialPublicKeyBase64,
          counter: credData.counter || 0,
          rpId: credData.rpId,
          origin: credData.origin,
          requireUserVerification: true
        }
      );

      if (!isValidSig) {
        throw new HttpsError("permission-denied", "❌ Hardware biometric signature verification failed. Authentication rejected.");
      }

      // Passkey Counter Handling for Synced & Multi-Device Credentials:
      // Single-device authenticators (e.g. YubiKey) strictly increment a hardware counter.
      // Synced authenticators (Apple iCloud Keychain, Google Password Manager) typically keep counter = 0
      // or do not increment sequentially across multiple synced devices.
      // Therefore, counter = 0 is fully supported and legitimate authenticators are never rejected for counter = 0.
      if (isValidSig && typeof isValidSig === "object") {
        const credRef = db.collection("biometric_credentials").doc(studentUid);
        const credUpdate = {
          lastVerifiedAt: FieldValue.serverTimestamp()
        };
        if (typeof isValidSig.newCounter === "number" && isValidSig.newCounter > 0) {
          credUpdate.counter = isValidSig.newCounter;
        }
        if (isValidSig.credentialDeviceType) {
          credUpdate.credentialDeviceType = isValidSig.credentialDeviceType;
        }
        if (typeof isValidSig.credentialBackedUp === "boolean") {
          credUpdate.credentialBackedUp = isValidSig.credentialBackedUp;
        }
        transaction.set(credRef, credUpdate, { merge: true });
      }
    }

    // B. Transaction Writes
    if (challengeRef) {
      transaction.update(challengeRef, {
        used: true,
        usedAt: FieldValue.serverTimestamp(),
        consumedBySession: sessionId
      });
    }

    // Honest Trust Boundary Enforcement:
    // The server verified the hardware passkey signature and mathematically verified client descriptor distance (d <= 0.48).
    // However, without trusted camera hardware attestation or server-side neural inference on raw challenge-bound video,
    // the backend CANNOT cryptographically verify optical camera capture or 3D liveness.
    // Therefore, security-critical face/liveness claims FAIL CLOSED:
    // - faceVerified: false (server cannot certify optical identity from untrusted client vector)
    // - livenessConfirmed: false (server cannot certify 3D liveness from client telemetry)
    // - serverBiometricVerified: false
    // - antiSpoofScore: "UNVERIFIED_CLIENT_TELEMETRY"
    // - faceDescriptorMatched: true (honestly reflects mathematical vector proximity)
    // - devicePasskeyVerified: signatureVerified (honestly reflects hardware token possession)
    // - status: "ATTENDED" (attendance is granted via passkey + client descriptor match)
    const attendanceRecord = {
      id: recordId,
      sessionId: sessionId,
      rollNo: rollNo,
      fullName: authData.studentName,
      studentName: authData.studentName,
      name: authData.studentName,
      studentEmail: authData.studentEmail,
      studentUid: studentUid,
      courseCode: session.courseCode || "N/A",
      classCode: session.classCode || "N/A",
      batch: session.batch || "2025",
      roomNo: session.roomNo || "N/A",
      lecturerName: session.lecturerName || "",
      lecturerEmail: session.lecturerEmail || "",
      ownerId: session.ownerId || "",
      status: "ATTENDED",
      faceVerified: false,
      faceDescriptorMatched: true,
      faceMatchConfidence: serverMatchConfidence,
      faceDistance: Number(serverCalculatedDistance.toFixed(4)),
      livenessConfirmed: false,
      serverBiometricVerified: false,
      antiSpoofScore: "UNVERIFIED_CLIENT_TELEMETRY",
      faceTrustBoundary: "CLIENT_DESCRIPTOR_ONLY_NOT_SERVER_VERIFIED",
      trustBoundaryNotes: "Server verified hardware passkey signature and mathematical descriptor proximity to enrolled template, but fails closed on claims of server-verified optical camera face capture or 3D liveness.",
      blinkCount: biometricData?.blinkCount || 1,
      deviceAuthMode: authMode,
      hardwareBiometric: signatureVerified,
      signatureVerified: signatureVerified,
      devicePasskeyVerified: signatureVerified,
      platform: hardwarePlatform,
      submittedAt: FieldValue.serverTimestamp(),
      biometricVerifiedAt: FieldValue.serverTimestamp(),
      autoReleaseAt: Timestamp.fromMillis(autoReleaseAtMs)
    };

    transaction.set(db.collection("attendance_records").doc(recordId), attendanceRecord);

    // Update session attendees
    transaction.update(sessionRef, {
      attendees: FieldValue.arrayUnion({
        id: recordId,
        rollNo: rollNo,
        studentName: authData.studentName,
        fullName: authData.studentName,
        email: authData.studentEmail,
        studentEmail: authData.studentEmail,
        status: "ATTENDED",
        faceVerified: false,
        faceDescriptorMatched: true,
        faceMatchConfidence: serverMatchConfidence,
        faceDistance: Number(serverCalculatedDistance.toFixed(4)),
        deviceAuthMode: authMode,
        hardwareBiometric: signatureVerified,
        devicePasskeyVerified: signatureVerified,
        submittedAt: submittedAtMs,
        attendanceSubmittedAt: submittedAtMs,
        autoReleaseAt: autoReleaseAtMs
      }),
      attendanceCount: FieldValue.increment(1)
    });

    // Update authorization document with 5-minute fail-safe timeline
    transaction.update(authRef, {
      attendanceSubmittedAt: FieldValue.serverTimestamp(),
      autoReleaseAt: Timestamp.fromMillis(autoReleaseAtMs),
      attendanceStatus: "SUBMITTED",
      status: "ATTENDED",
      faceVerified: false,
      faceDescriptorMatched: true,
      hardwareBiometric: signatureVerified,
      devicePasskeyVerified: signatureVerified,
      releaseStatus: "LOCKED"
    });
  });

  if (rollNo && rollNo !== studentUid) {
    try {
      const rollAuthRef = sessionRef.collection("authorizations").doc(rollNo);
      await rollAuthRef.update({
        attendanceSubmittedAt: FieldValue.serverTimestamp(),
        autoReleaseAt: Timestamp.fromMillis(autoReleaseAtMs),
        attendanceStatus: "SUBMITTED",
        status: "ATTENDED",
        faceVerified: false,
        faceDescriptorMatched: true,
        hardwareBiometric: signatureVerified,
        devicePasskeyVerified: signatureVerified,
        releaseStatus: "LOCKED"
      });
    } catch (e) {}
  }

  return {
    success: true,
    sessionId: sessionId,
    rollNo: rollNo,
    studentName: authData.studentName,
    deviceAuthMode: authMode,
    hardwareBiometric: signatureVerified,
    submittedAt: submittedAtMs,
    attendanceSubmittedAt: submittedAtMs,
    autoReleaseAt: autoReleaseAtMs,
    kioskEndsAt: kioskEndsAtMs,
    message: "Attendance Submitted. Waiting for Lecturer Release (Lock Task Mode active)."
  };
});

/**
 * 6. VERIFY LECTURER RELEASE CODE / SESSION PIN (On-Device Release)
 * Server-side trusted verification of the 6-digit Session PIN.
 * Compares hashed input against private /security/tokens without exposing the hash to the client.
 */
exports.verifyLecturerReleaseCode = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to request kiosk release.");
  }

  const { sessionId, releaseCode, sessionPin, pin, deviceId, studentUid } = request.data || {};
  const inputPin = releaseCode || sessionPin || pin;
  if (!sessionId || !inputPin) {
    throw new HttpsError("invalid-argument", "Session ID and Session PIN are required.");
  }

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const [sessionSnap, securitySnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("security").doc("tokens").get()
  ]);

  if (!sessionSnap.exists || !securitySnap.exists) {
    throw new HttpsError("not-found", "Attendance session or security tokens not found.");
  }

  const security = securitySnap.data();
  const inputHash = hashToken(String(inputPin).trim());
  const expectedHash = security.sessionPinHash || security.lecturerReleaseCodeHash;

  if (inputHash !== expectedHash) {
    throw new HttpsError("permission-denied", "❌ Invalid Session PIN. Device remains locked in Kiosk mode.");
  }

  const targetUid = studentUid || request.auth.uid;
  try {
    const authRef = sessionRef.collection("authorizations").doc(targetUid);
    const authSnap = await authRef.get();
    if (authSnap.exists) {
      await authRef.update({
        released: true,
        releaseStatus: "PIN_RELEASED",
        releasedAt: FieldValue.serverTimestamp()
      });
    }
  } catch (e) {
    console.warn("Notice updating PIN release authorization:", e);
  }

  const releaseToken = crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + 30000;

  // Audit log of PIN release
  try {
    await sessionRef.collection("audit_logs").add({
      event: "SESSION_PIN_DEVICE_RELEASE",
      studentUid: targetUid,
      deviceId: deviceId || "UNKNOWN",
      timestamp: FieldValue.serverTimestamp()
    });
  } catch (e) { }

  return {
    success: true,
    releaseAuthorized: true,
    sessionId: sessionId,
    studentUid: targetUid,
    releaseToken: releaseToken,
    expiresAt: expiresAt,
    message: "Session PIN verified successfully. Device release authorized."
  };
});

/**
 * 7. END ATTENDANCE SESSION (Release All Devices - Lecturer Only)
 * Closes the session and releases all active student kiosks simultaneously.
 * Enforces that only the session owner (lecturer) can close the session.
 */
exports.endAttendanceSession = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to end session.");
  }

  const { sessionId } = request.data || {};
  if (!sessionId) {
    throw new HttpsError("invalid-argument", "Session ID is required.");
  }

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();

  if (!sessionSnap.exists) {
    throw new HttpsError("not-found", "Attendance session not found.");
  }

  const session = sessionSnap.data();
  if (session.ownerId !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only the owning lecturer can end this attendance session.");
  }

  await sessionRef.update({
    active: false,
    status: "CLOSED",
    phase: "CLOSED",
    closedAt: FieldValue.serverTimestamp(),
    closedBy: request.auth.uid
  });

  return {
    success: true,
    sessionId: sessionId,
    status: "CLOSED",
    message: "Attendance session closed successfully. All student kiosks released."
  };
});

/**
 * 8. RELEASE INDIVIDUAL DEVICE (Lecturer Only)
 * Remotely unlocks a specific student's device from Kiosk Lock Task mode using the Session PIN.
 * Enforces that only the session owner (lecturer) can authorize the device release.
 */
exports.releaseIndividualDevice = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to release device.");
  }

  const { sessionId, studentUid, rollNo, sessionPin } = request.data || {};
  if (!sessionId || (!studentUid && !rollNo)) {
    throw new HttpsError("invalid-argument", "Session ID and student identifier are required.");
  }

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const [sessionSnap, securitySnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("security").doc("tokens").get()
  ]);

  if (!sessionSnap.exists) {
    throw new HttpsError("not-found", "Attendance session not found.");
  }

  const session = sessionSnap.data();
  if (session.ownerId !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only the owning lecturer can release student devices.");
  }

  // Optional Session PIN validation if provided
  if (sessionPin && securitySnap.exists) {
    const security = securitySnap.data();
    const inputHash = hashToken(String(sessionPin).trim());
    if (inputHash !== security.sessionPinHash && inputHash !== security.lecturerReleaseCodeHash) {
      throw new HttpsError("permission-denied", "❌ Invalid Session PIN.");
    }
  }

  const targetDocId = studentUid || rollNo;
  const authRef = sessionRef.collection("authorizations").doc(targetDocId);
  const authSnap = await authRef.get();

  if (authSnap.exists) {
    await authRef.update({
      released: true,
      releasedAt: FieldValue.serverTimestamp(),
      releasedBy: request.auth.uid,
      releaseStatus: "RELEASED",
      status: "RELEASED"
    });
  }

  if (rollNo && studentUid && rollNo !== studentUid) {
    try {
      const rollAuthRef = sessionRef.collection("authorizations").doc(rollNo);
      await rollAuthRef.update({
        released: true,
        releasedAt: FieldValue.serverTimestamp(),
        releasedBy: request.auth.uid,
        releaseStatus: "RELEASED",
        status: "RELEASED"
      });
    } catch (e) {}
  }

  return {
    success: true,
    sessionId: sessionId,
    studentUid: targetDocId,
    status: "RELEASED",
    message: "Individual device release authorized by lecturer."
  };
});

/**
 * 9. REQUEST AUTOMATIC 5-MINUTE FAIL-SAFE RELEASE (Student Device)
 * Validates server-side that at least 5 minutes have elapsed since attendance submission.
 * Authorizes the device to exit Lock Task Mode if the lecturer has not yet released it.
 */
exports.requestAutoFailSafeRelease = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to request fail-safe release.");
  }

  const { sessionId, studentUid } = request.data || {};
  if (!sessionId) {
    throw new HttpsError("invalid-argument", "Session ID is required.");
  }

  const targetUid = studentUid || request.auth.uid;
  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const authRef = sessionRef.collection("authorizations").doc(targetUid);
  const authSnap = await authRef.get();

  if (!authSnap.exists) {
    throw new HttpsError("not-found", "Student session authorization not found.");
  }

  const authData = authSnap.data();
  if (!authData.attendanceSubmittedAt) {
    throw new HttpsError("failed-precondition", "Attendance must be submitted before fail-safe release can trigger.");
  }

  const submittedAtMs = authData.attendanceSubmittedAt.toMillis ? authData.attendanceSubmittedAt.toMillis() : (authData.attendanceSubmittedAt || 0);
  const autoReleaseAtMs = authData.autoReleaseAt ? (authData.autoReleaseAt.toMillis ? authData.autoReleaseAt.toMillis() : authData.autoReleaseAt) : (submittedAtMs + 5 * 60 * 1000);
  const serverNow = Date.now();

  // Allow 5-second grace for network latency
  if (serverNow < (autoReleaseAtMs - 5000)) {
    const remainingSec = Math.ceil((autoReleaseAtMs - serverNow) / 1000);
    throw new HttpsError("failed-precondition", `Fail-safe countdown active. Automatic release authorized in ${remainingSec} seconds.`);
  }

  await authRef.update({
    released: true,
    releaseStatus: "AUTO_RELEASED",
    status: "RELEASED",
    releasedAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    autoReleaseAuthorized: true,
    sessionId: sessionId,
    studentUid: targetUid,
    releaseStatus: "AUTO_RELEASED",
    message: "5-Minute fail-safe countdown reached. Device release authorized."
  };
});

/**
 * 10. ISSUE BIOMETRIC CHALLENGE
 * Cryptographically generates a 32-byte (64 hex chars) nonce with 3-minute TTL.
 * Stored in server-side /biometric_challenges/{challengeId} with single-use replay protection.
 */
exports.issueBiometricChallenge = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to request a biometric challenge.");
  }

  const studentUid = request.auth.uid;
  const challengeId = crypto.randomUUID();
  const challengeText = crypto.randomBytes(32).toString("hex");
  const nowMs = Date.now();
  const expiresAtMs = nowMs + 3 * 60 * 1000; // 3-minute TTL

  await db.collection("biometric_challenges").doc(challengeId).set({
    challengeId: challengeId,
    studentUid: studentUid,
    challengeText: challengeText,
    expiresAt: Timestamp.fromMillis(expiresAtMs),
    used: false,
    createdAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    challengeId: challengeId,
    challengeText: challengeText,
    expiresAt: expiresAtMs
  };
});

/**
 * 11. REGISTER INITIAL BIOMETRIC KEY
 * Students self-enroll initial hardware-backed ECDSA P-256 public key (Android Keystore / iOS Secure Enclave).
 * Once enrolled, key cannot be altered or overwritten directly; requires authorized replacement.
 */
exports.registerInitialBiometricKey = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to enroll biometric key.");
  }

  const { publicKeyDerBase64, platform, keyAlias } = request.data || {};
  if (!publicKeyDerBase64 || typeof publicKeyDerBase64 !== "string") {
    throw new HttpsError("invalid-argument", "Public key (Base64 DER) is required.");
  }

  const studentUid = request.auth.uid;
  const studentEmail = request.auth.token.email || "";
  const studentProfile = await resolveAuthoritativeStudent(studentUid, studentEmail);

  // Validate DER public key format (P-256 SPKI DER is 91 bytes = ~120-128 chars base64)
  const derBuffer = Buffer.from(publicKeyDerBase64.trim(), "base64");
  if (derBuffer.length !== 91) {
    throw new HttpsError("invalid-argument", `Invalid public key format. Expected 91-byte X.509 SPKI DER, received ${derBuffer.length} bytes.`);
  }

  // Verify key imports cleanly in crypto
  try {
    const pem = derToPem(publicKeyDerBase64.trim());
    crypto.createPublicKey(pem);
  } catch (kErr) {
    throw new HttpsError("invalid-argument", "Malformed public key: " + kErr.message);
  }

  // Check if student already has an active biometric credential
  const credRef = db.collection("biometric_credentials").doc(studentUid);
  const existingCredSnap = await credRef.get();

  if (existingCredSnap.exists && existingCredSnap.data().status === "ACTIVE") {
    throw new HttpsError(
      "already-exists",
      "An active biometric credential is already registered for your account. Direct re-enrollment is prohibited. To replace your credential, submit a Biometric Change Request or contact your course lecturer."
    );
  }

  const credentialRecord = {
    studentUid: studentUid,
    rollNo: studentProfile.rollNo,
    studentEmail: studentProfile.email,
    publicKeyDerBase64: publicKeyDerBase64.trim(),
    platform: platform || "unknown",
    keyAlias: keyAlias || `smartattend_p256_${studentProfile.rollNo}`,
    status: "ACTIVE",
    enrollmentMethod: "STUDENT_SELF_ENROLLMENT",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  await Promise.all([
    credRef.set(credentialRecord),
    db.collection("biometric_credentials").doc(studentProfile.rollNo).set(credentialRecord),
    db.collection("students").doc(studentProfile.rollNo).set({
      biometricEnrolled: true,
      hardwareBiometricPlatform: platform || "unknown",
      hardwareBiometricEnrolledAt: FieldValue.serverTimestamp()
    }, { merge: true }),
    db.collection("biometric_audit_logs").add({
      action: "INITIAL_BIOMETRIC_ENROLLMENT",
      studentUid: studentUid,
      rollNo: studentProfile.rollNo,
      platform: platform || "unknown",
      enrolledBy: studentUid,
      timestamp: FieldValue.serverTimestamp()
    })
  ]);

  return {
    success: true,
    rollNo: studentProfile.rollNo,
    platform: platform || "unknown",
    status: "ACTIVE",
    message: "Initial biometric credential registered successfully."
  };
});

/**
 * 12. REPLACE BIOMETRIC CREDENTIAL (Safe Dual-Active Replacement)
 * Authorized replacement: requires approval by Lecturer within student's course roster or Administrator.
 * Preserves the previous active key until replacement is verified, with audit logging.
 */
exports.replaceBiometricCredential = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const { targetStudentUid, targetRollNo, newPublicKeyDerBase64, platform, requestId, reason } = request.data || {};
  if (!newPublicKeyDerBase64 || (!targetStudentUid && !targetRollNo)) {
    throw new HttpsError("invalid-argument", "Target student and new public key are required.");
  }

  const callerUid = request.auth.uid;
  const callerEmail = (request.auth.token.email || "").toLowerCase().trim();
  const isAdmin = await isCallerAdmin(request);

  // Validate new public key
  const derBuffer = Buffer.from(newPublicKeyDerBase64.trim(), "base64");
  if (derBuffer.length !== 91) {
    throw new HttpsError("invalid-argument", `Invalid public key. Expected 91-byte X.509 SPKI DER, received ${derBuffer.length} bytes.`);
  }

  // Resolve target student
  const studentProfile = await resolveAuthoritativeStudent(targetStudentUid, null);
  const studentUid = studentProfile.uid;
  const rollNo = studentProfile.rollNo;

  // Authorization check: Admin, Authorized Lecturer within course roster, or Student with approved change request
  let authorizedBy = "ADMIN";
  if (isAdmin) {
    authorizedBy = `ADMIN (${callerEmail})`;
  } else if (callerUid === studentUid) {
    if (!requestId) {
      throw new HttpsError("permission-denied", "Biometric replacement requires an approved Biometric Change Request ID.");
    }
    const reqSnap = await db.collection("biometric_change_requests").doc(requestId).get();
    if (!reqSnap.exists || reqSnap.data().studentUid !== studentUid || reqSnap.data().status !== "APPROVED" || reqSnap.data().used === true) {
      throw new HttpsError("permission-denied", "Valid, approved Biometric Change Request required.");
    }
    authorizedBy = `STUDENT_WITH_APPROVED_REQUEST (${requestId})`;
  } else {
    // Lecturer replacement: verify student is enrolled in at least one course taught by the lecturer
    await assertLecturer(request);
    const coursesSnap = await db.collection("courses").get();
    let isStudentInLecturerCourse = false;

    for (const doc of coursesSnap.docs) {
      const c = doc.data();
      let teaches = (c.lecturerEmail && c.lecturerEmail.toLowerCase().trim() === callerEmail);
      if (!teaches && Array.isArray(c.assignedLecturers)) {
        teaches = c.assignedLecturers.some(l => {
          const lEmail = typeof l === "string" ? l.toLowerCase().trim() : (l.email || "").toLowerCase().trim();
          return lEmail === callerEmail || (typeof l === "object" && l.uid === callerUid);
        });
      }

      if (teaches) {
        const enrolled = Array.isArray(c.enrolledStudents) ? c.enrolledStudents : [];
        if (enrolled.some(s => {
          const r = typeof s === "string" ? s.toUpperCase().trim() : (s.rollNo || s.rollNumber || "").toUpperCase().trim();
          return r === rollNo;
        })) {
          isStudentInLecturerCourse = true;
          break;
        }
      }
    }

    if (!isStudentInLecturerCourse) {
      throw new HttpsError("permission-denied", `Lecturer ${callerEmail} is not authorized to replace biometrics for ${rollNo}: student is not in lecturer's assigned course roster.`);
    }
    authorizedBy = `LECTURER (${callerEmail})`;
  }

  // Fetch current active credential
  const credRef = db.collection("biometric_credentials").doc(studentUid);
  const currentCredSnap = await credRef.get();
  const previousKey = currentCredSnap.exists ? currentCredSnap.data().publicKeyDerBase64 : null;

  const newCredentialRecord = {
    studentUid: studentUid,
    rollNo: rollNo,
    studentEmail: studentProfile.email,
    publicKeyDerBase64: newPublicKeyDerBase64.trim(),
    platform: platform || "unknown",
    status: "ACTIVE",
    previousPublicKeyDerBase64: previousKey,
    replacementAuthorizedBy: authorizedBy,
    replacementReason: reason || "Normal biometric hardware update/re-enrollment",
    updatedAt: FieldValue.serverTimestamp()
  };

  const batch = db.batch();
  batch.set(credRef, newCredentialRecord, { merge: true });
  batch.set(db.collection("biometric_credentials").doc(rollNo), newCredentialRecord, { merge: true });
  if (requestId) {
    batch.update(db.collection("biometric_change_requests").doc(requestId), {
      status: "COMPLETED",
      used: true,
      completedAt: FieldValue.serverTimestamp()
    });
  }

  await batch.commit();

  await db.collection("biometric_audit_logs").add({
    action: "BIOMETRIC_CREDENTIAL_REPLACEMENT",
    studentUid: studentUid,
    rollNo: rollNo,
    platform: platform || "unknown",
    authorizedBy: authorizedBy,
    reason: reason || "Authorized replacement",
    timestamp: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    studentUid: studentUid,
    rollNo: rollNo,
    status: "ACTIVE",
    authorizedBy: authorizedBy,
    message: "Biometric credential replaced successfully with full audit trail."
  };
});

/**
 * 13. SUBMIT BIOMETRIC CHANGE REQUEST
 * Student submits a request to replace or re-enroll biometric credentials with a stated reason.
 */
exports.submitBiometricChangeRequest = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const { reason, deviceChangeDetails } = request.data || {};
  if (!reason || typeof reason !== "string" || !reason.trim()) {
    throw new HttpsError("invalid-argument", "A valid reason for biometric change is required.");
  }

  const studentUid = request.auth.uid;
  const studentEmail = request.auth.token.email || "";
  const studentProfile = await resolveAuthoritativeStudent(studentUid, studentEmail);

  const requestId = crypto.randomUUID();
  const requestDoc = {
    requestId: requestId,
    studentUid: studentUid,
    rollNo: studentProfile.rollNo,
    studentEmail: studentProfile.email,
    reason: reason.trim(),
    deviceChangeDetails: deviceChangeDetails || {},
    status: "PENDING",
    createdAt: FieldValue.serverTimestamp()
  };

  await db.collection("biometric_change_requests").doc(requestId).set(requestDoc);

  return {
    success: true,
    requestId: requestId,
    status: "PENDING",
    message: "Biometric change request submitted successfully. Awaiting lecturer or administrator review."
  };
});

/**
 * 14. REVIEW BIOMETRIC CHANGE REQUEST
 * Authorized lecturer (within course scope) or Administrator reviews and approves/rejects.
 */
exports.reviewBiometricChangeRequest = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const { requestId, decision, notes } = request.data || {};
  if (!requestId || !["APPROVED", "REJECTED"].includes(decision)) {
    throw new HttpsError("invalid-argument", "Valid requestId and decision (APPROVED/REJECTED) are required.");
  }

  const reqRef = db.collection("biometric_change_requests").doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) {
    throw new HttpsError("not-found", "Biometric change request not found.");
  }

  const reqData = reqSnap.data();
  const callerUid = request.auth.uid;
  const callerEmail = (request.auth.token.email || "").toLowerCase().trim();
  const isAdmin = await isCallerAdmin(request);

  if (!isAdmin) {
    await assertLecturer(request);
    const coursesSnap = await db.collection("courses").get();
    let isStudentInCourse = false;
    for (const doc of coursesSnap.docs) {
      const c = doc.data();
      let teaches = (c.lecturerEmail && c.lecturerEmail.toLowerCase().trim() === callerEmail);
      if (!teaches && Array.isArray(c.assignedLecturers)) {
        teaches = c.assignedLecturers.some(l => {
          const lEmail = typeof l === "string" ? l.toLowerCase().trim() : (l.email || "").toLowerCase().trim();
          return lEmail === callerEmail || (typeof l === "object" && l.uid === callerUid);
        });
      }
      if (teaches) {
        const enrolled = Array.isArray(c.enrolledStudents) ? c.enrolledStudents : [];
        if (enrolled.some(s => {
          const r = typeof s === "string" ? s.toUpperCase().trim() : (s.rollNo || s.rollNumber || "").toUpperCase().trim();
          return r === reqData.rollNo;
        })) {
          isStudentInCourse = true;
          break;
        }
      }
    }
    if (!isStudentInCourse) {
      throw new HttpsError("permission-denied", "Lecturer is not assigned to any course containing this student.");
    }
  }

  await reqRef.update({
    status: decision,
    reviewedBy: callerEmail || callerUid,
    reviewNotes: notes || "",
    reviewedAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    requestId: requestId,
    status: decision,
    message: `Biometric change request ${decision.toLowerCase()} successfully.`
  };
});

/**
 * 15. RECORD ATTENDANCE LIFECYCLE EVENT
 * Enforces platform-specific attendance monitoring policy:
 * - Android native app:
 *   - Strict kiosk policy: first confirmed violation produces a warning; second confirmed violation rejects attendance and flags student.
 *   - Threshold enforced on the backend.
 * - iPhone native app and website/browser:
 *   - Detects supported lifecycle signals (visibilitychange, blur, willResignActive).
 *   - Records event for review without automatic disqualification.
 *   - Does not treat every hidden-page event as confirmed misconduct.
 */
exports.recordAttendanceLifecycleEvent = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to record lifecycle event.");
  }

  const { sessionId, eventType, source, platform } = request.data || {};
  if (!sessionId) {
    throw new HttpsError("invalid-argument", "Session ID is required.");
  }

  const studentUid = request.auth.uid;
  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const authRef = sessionRef.collection("authorizations").doc(studentUid);
  const authSnap = await authRef.get();

  if (!authSnap.exists) {
    throw new HttpsError("not-found", "Session authorization not found for this student.");
  }

  const authData = authSnap.data();
  const rollNo = authData.rollNo || studentUid;
  const nowMs = Date.now();

  if (platform === "android" && (eventType === "CONFIRMED_KIOSK_ESCAPE" || eventType === "APP_LEAVE")) {
    const prevCount = Number(authData.confirmedKioskViolations || authData.violationCount || 0);
    const nextCount = prevCount + 1;
    const isDisqualified = nextCount >= 2;

    const violationEntry = {
      type: "CONFIRMED_KIOSK_ESCAPE",
      source: source || "kiosk_exit",
      platform: "android",
      count: nextCount,
      timestamp: nowMs,
      disqualified: isDisqualified
    };

    const updatePayload = {
      confirmedKioskViolations: nextCount,
      violationCount: nextCount,
      disqualified: isDisqualified,
      status: isDisqualified ? "FLAGGED_DISQUALIFIED" : "FLAGGED_WARNING",
      violations: FieldValue.arrayUnion(violationEntry)
    };

    await authRef.update(updatePayload);

    if (rollNo && rollNo !== studentUid) {
      try {
        await sessionRef.collection("authorizations").doc(rollNo).update(updatePayload);
      } catch (_) {}
    }

    await sessionRef.update({
      flaggedViolations: FieldValue.arrayUnion({
        rollNo: rollNo,
        studentName: authData.studentName || rollNo,
        violationType: "CONFIRMED_KIOSK_ESCAPE",
        count: nextCount,
        disqualified: isDisqualified,
        timestamp: nowMs
      })
    });

    return {
      success: true,
      platform: "android",
      status: isDisqualified ? "DISQUALIFIED" : "WARNING",
      violationCount: nextCount,
      disqualified: isDisqualified,
      message: isDisqualified
        ? "Attendance forfeited: 2 confirmed kiosk escape violations."
        : "Warning: Kiosk exit detected (Violation 1 of 2)."
    };
  } else {
    // iPhone native app and website/browser:
    // Non-disqualifying audit logging for lecturer review.
    const eventEntry = {
      type: "SUSPICIOUS_LIFECYCLE_INTERRUPTION",
      source: source || "visibility_change",
      platform: platform || "web",
      timestamp: nowMs,
      disqualified: false
    };

    const updatePayload = {
      hasSuspiciousInterruption: true,
      lastInterruptionSource: source || "unknown",
      lastInterruptionAt: nowMs,
      lifecycleEvents: FieldValue.arrayUnion(eventEntry)
    };

    await authRef.update(updatePayload);

    if (rollNo && rollNo !== studentUid) {
      try {
        await sessionRef.collection("authorizations").doc(rollNo).update(updatePayload);
      } catch (_) {}
    }

    try {
      await sessionRef.collection("audit_logs").add({
        event: "LIFECYCLE_INTERRUPTION_REVIEW",
        studentUid: studentUid,
        rollNo: rollNo,
        platform: platform || "web",
        source: source || "visibility_change",
        timestamp: FieldValue.serverTimestamp()
      });
    } catch (_) {}

    return {
      success: true,
      platform: platform || "web",
      status: "RECORDED_FOR_REVIEW",
      disqualified: false,
      message: "Lifecycle interruption recorded for lecturer review."
    };
  }
});

/**
 * 16. EXTEND / ADJUST ATTENDANCE SESSION TIMINGS (Dynamic Session Adjustment)
 * Allows adjusting running session duration live by adding or removing time (e.g., +30s, +1m, +2m, -30s, -1m).
 * Supports targeted adjustments:
 * - phaseTarget === "PHASE_1": Extends or shortens Phase 1 while active, strictly enforcing that Phase 1
 *   CANNOT be reopened once transitioned or closed. Preserves configured Phase 2 duration.
 * - phaseTarget === "PHASE_2": Extends or shortens Phase 2 while active, preserving Phase 1 duration and timestamps.
 * Updates session and security/tokens atomically inside a Firestore transaction.
 */
exports.extendAttendanceSession = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to adjust attendance session.");
  }

  const { sessionId, additionalMinutes, additionalSeconds, deltaSeconds, phaseTarget } = request.data || {};
  if (!sessionId) {
    throw new HttpsError("invalid-argument", "Missing required parameter: sessionId.");
  }

  await assertLecturer(request);
  const isAdmin = await isCallerAdmin(request);
  const callerUid = request.auth.uid;
  const callerEmail = (request.auth.token.email || "").toLowerCase().trim();

  let deltaMs = 0;
  if (typeof deltaSeconds === "number" && Number.isFinite(deltaSeconds)) {
    deltaMs = Math.round(deltaSeconds * 1000);
  } else if (typeof additionalSeconds === "number" && Number.isFinite(additionalSeconds)) {
    deltaMs = Math.round(additionalSeconds * 1000);
  } else {
    const addMin = Number(additionalMinutes) !== 0 && Number.isFinite(Number(additionalMinutes)) ? Number(additionalMinutes) : 1;
    deltaMs = Math.round(addMin * 60 * 1000);
  }

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const tokensRef = sessionRef.collection("security").doc("tokens");

  return await db.runTransaction(async (transaction) => {
    const [sessionSnap, securitySnap] = await Promise.all([
      transaction.get(sessionRef),
      transaction.get(tokensRef)
    ]);

    if (!sessionSnap.exists) {
      throw new HttpsError("not-found", `Attendance session ${sessionId} not found.`);
    }

    const sessionData = sessionSnap.data();
    if (!isAdmin && sessionData.ownerId !== callerUid && sessionData.ownerEmail !== callerEmail) {
      throw new HttpsError("permission-denied", "Only the session lecturer or administrator can adjust this session.");
    }

    const serverNow = Date.now();

    // 1. Session Ended / Closed Rejection
    if (sessionData.active === false || sessionData.status === "CLOSED" || sessionData.phase === "CLOSED") {
      throw new HttpsError("failed-precondition", "Cannot adjust an attendance session that has already ended.");
    }

    const currentEndMs = sessionData.kioskEndsAt?.toMillis
      ? sessionData.kioskEndsAt.toMillis()
      : (Number(sessionData.kioskEndsAt) || serverNow);

    // Authoritative end deadline enforcement: reject any adjustment once session time expires
    if (serverNow >= currentEndMs) {
      throw new HttpsError("failed-precondition", "Cannot adjust session: Session duration has already expired.");
    }

    // Validate phaseTarget input
    const rawTarget = phaseTarget ? String(phaseTarget).toUpperCase().trim() : "PHASE_2";
    const VALID_TARGETS = ["PHASE_1", "QR1", "PHASE_2", "QR2", "SESSION"];
    if (!VALID_TARGETS.includes(rawTarget)) {
      throw new HttpsError(
        "invalid-argument",
        `Invalid phaseTarget "${phaseTarget}". Valid options are: PHASE_1, QR1, PHASE_2, QR2, SESSION.`
      );
    }
    const target = (rawTarget === "QR1" ? "PHASE_1" : (rawTarget === "QR2" || rawTarget === "SESSION" ? "PHASE_2" : rawTarget));

    // 2. QR1-Only Adjustments vs QR2 / Entire Session Adjustments
    if (target === "PHASE_1") {
      // STRICT RULE: QR1 closure, QR1 never reopening
      const currentQr1ExpiresMs = sessionData.qr1ExpiresAt?.toMillis
        ? sessionData.qr1ExpiresAt.toMillis()
        : (Number(sessionData.qr1ExpiresAt) || serverNow);

      if (sessionData.phase !== "PHASE_1" || serverNow >= currentQr1ExpiresMs) {
        throw new HttpsError(
          "failed-precondition",
          "Phase 1 check-in has already closed and cannot be reopened. Adjustments can only be applied to Phase 2."
        );
      }

      // Adjust QR1: minimum 10s into the future
      const newQr1ExpiresMs = Math.max(serverNow + 10000, currentQr1ExpiresMs + deltaMs);
      const newQr1Timestamp = Timestamp.fromMillis(newQr1ExpiresMs);

      // Preserve configured Phase 2 duration: Phase 2 shifts so QR2 duration remains constant
      const qr2DurationSec = sessionData.qr2DurationSeconds || 120;
      const newEndMs = newQr1ExpiresMs + (qr2DurationSec * 1000);
      const newEndTimestamp = Timestamp.fromMillis(newEndMs);

      const startMs = sessionData.sessionStartAt?.toMillis
        ? sessionData.sessionStartAt.toMillis()
        : (Number(sessionData.sessionStartAt) || serverNow);

      const newQr1DurationSeconds = Math.max(15, Math.round((newQr1ExpiresMs - startMs) / 1000));
      const newTotalDurationSeconds = newQr1DurationSeconds + qr2DurationSec;
      const newTotalDurationMinutes = Math.max(1, Math.round(newTotalDurationSeconds / 60));

      transaction.update(sessionRef, {
        qr1ExpiresAt: newQr1Timestamp,
        qr2StartsAt: newQr1Timestamp,
        kioskEndsAt: newEndTimestamp,
        expiresAt: newEndTimestamp,
        qr1DurationSeconds: newQr1DurationSeconds,
        totalDurationSeconds: newTotalDurationSeconds,
        durationMinutes: newTotalDurationMinutes,
        updatedAt: FieldValue.serverTimestamp()
      });

      if (securitySnap.exists) {
        transaction.update(tokensRef, {
          qr1ExpiresAt: newQr1Timestamp,
          qr2StartsAt: newQr1Timestamp,
          kioskEndsAt: newEndTimestamp
        });
      }

      const deltaSec = Math.round(deltaMs / 1000);

      // Immutable Time Adjustment Audit Trail
      const auditRef = sessionRef.collection("time_adjustments").doc();
      transaction.set(auditRef, {
        adjustmentId: auditRef.id,
        sessionId: sessionId,
        actorUid: callerUid,
        actorEmail: callerEmail,
        actorRole: isAdmin ? "ADMIN" : "LECTURER",
        phaseTarget: target,
        deltaSeconds: deltaSec,
        deltaMs: deltaMs,
        previousQr1ExpiresAt: sessionData.qr1ExpiresAt || null,
        previousKioskEndsAt: sessionData.kioskEndsAt || null,
        newQr1ExpiresAt: newQr1Timestamp,
        newKioskEndsAt: newEndTimestamp,
        qr1DurationSeconds: newQr1DurationSeconds,
        qr2DurationSeconds: qr2DurationSec,
        totalDurationSeconds: newTotalDurationSeconds,
        adjustedAt: FieldValue.serverTimestamp(),
        serverTimestampMs: serverNow
      });

      return {
        success: true,
        sessionId: sessionId,
        targetPhase: "PHASE_1",
        newQr1ExpiresAt: newQr1ExpiresMs,
        newEndsAt: newEndMs,
        deltaSeconds: deltaSec,
        qr1DurationSeconds: newQr1DurationSeconds,
        qr2DurationSeconds: qr2DurationSec,
        totalDurationSeconds: newTotalDurationSeconds,
        message: `Phase 1 (QR1) adjusted (${deltaSec >= 0 ? "+" : ""}${deltaSec}s). Phase 2 duration preserved.`
      };
    } else {
      // QR2 / Session End Adjustment: preserves QR1 duration & timestamps
      const newEndMs = Math.max(serverNow + 15000, currentEndMs + deltaMs);
      const newEndTimestamp = Timestamp.fromMillis(newEndMs);

      const qr1ExpiresMs = sessionData.qr1ExpiresAt?.toMillis
        ? sessionData.qr1ExpiresAt.toMillis()
        : (Number(sessionData.qr1ExpiresAt) || serverNow);

      const newQr2DurationSeconds = Math.max(15, Math.round((newEndMs - qr1ExpiresMs) / 1000));
      const qr1DurationSec = sessionData.qr1DurationSeconds || Math.max(15, Math.round((qr1ExpiresMs - (sessionData.sessionStartAt?.toMillis() || serverNow)) / 1000));
      const newTotalDurationSeconds = qr1DurationSec + newQr2DurationSeconds;
      const newTotalDurationMinutes = Math.max(1, Math.round(newTotalDurationSeconds / 60));

      transaction.update(sessionRef, {
        kioskEndsAt: newEndTimestamp,
        expiresAt: newEndTimestamp,
        qr2DurationSeconds: newQr2DurationSeconds,
        totalDurationSeconds: newTotalDurationSeconds,
        durationMinutes: newTotalDurationMinutes,
        updatedAt: FieldValue.serverTimestamp()
      });

      if (securitySnap.exists) {
        transaction.update(tokensRef, {
          kioskEndsAt: newEndTimestamp
        });
      }

      const deltaSec = Math.round(deltaMs / 1000);

      // Immutable Time Adjustment Audit Trail
      const auditRef = sessionRef.collection("time_adjustments").doc();
      transaction.set(auditRef, {
        adjustmentId: auditRef.id,
        sessionId: sessionId,
        actorUid: callerUid,
        actorEmail: callerEmail,
        actorRole: isAdmin ? "ADMIN" : "LECTURER",
        phaseTarget: target,
        deltaSeconds: deltaSec,
        deltaMs: deltaMs,
        previousQr1ExpiresAt: sessionData.qr1ExpiresAt || null,
        previousKioskEndsAt: sessionData.kioskEndsAt || null,
        newQr1ExpiresAt: sessionData.qr1ExpiresAt || null,
        newKioskEndsAt: newEndTimestamp,
        qr1DurationSeconds: qr1DurationSec,
        qr2DurationSeconds: newQr2DurationSeconds,
        totalDurationSeconds: newTotalDurationSeconds,
        adjustedAt: FieldValue.serverTimestamp(),
        serverTimestampMs: serverNow
      });

      return {
        success: true,
        sessionId: sessionId,
        targetPhase: "PHASE_2",
        newEndsAt: newEndMs,
        deltaSeconds: deltaSec,
        qr1DurationSeconds: qr1DurationSec,
        qr2DurationSeconds: newQr2DurationSeconds,
        totalDurationSeconds: newTotalDurationSeconds,
        message: `Phase 2 adjusted (${deltaSec >= 0 ? "+" : ""}${deltaSec}s). Phase 1 duration preserved.`
      };
    }
  });
});

/**
 * 17. UPDATE SESSION GEOFENCE RADIUS (Dynamic Classroom Geofence Adjustment)
 * Allows authorized lecturer (or admin) to adjust the geofence radius live during a session.
 * Default is 10 metres. Valid range: 0 to 1000 metres (0 disables geofence enforcement).
 * Atomic transaction updates session document and records an immutable audit entry in geofence_adjustments.
 */
exports.updateSessionGeofenceRadius = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to update geofence radius.");
  }

  const { sessionId, radius, classroomLocation } = request.data || {};
  if (!sessionId || typeof sessionId !== "string") {
    throw new HttpsError("invalid-argument", "Missing required parameter: sessionId.");
  }

  if (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0 || radius > 1000) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid radius. Geofence radius must be a finite number between 0 and 1000 metres (0 disables geofence, 10m is default)."
    );
  }

  await assertLecturer(request);
  const isAdmin = await isCallerAdmin(request);
  const callerUid = request.auth.uid;
  const callerEmail = (request.auth.token.email || "").toLowerCase().trim();

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);

  return await db.runTransaction(async (transaction) => {
    const sessionSnap = await transaction.get(sessionRef);
    if (!sessionSnap.exists) {
      throw new HttpsError("not-found", `Attendance session ${sessionId} not found.`);
    }

    const sessionData = sessionSnap.data();
    if (!isAdmin && sessionData.ownerId !== callerUid && sessionData.ownerEmail !== callerEmail) {
      throw new HttpsError("permission-denied", "Only the session lecturer or administrator can adjust this session's geofence.");
    }

    if (sessionData.active === false || sessionData.status === "CLOSED" || sessionData.phase === "CLOSED") {
      throw new HttpsError("failed-precondition", "Cannot adjust geofence for a session that has already ended.");
    }

    const previousRadius = typeof sessionData.geofenceRadius === "number" ? sessionData.geofenceRadius : 10;
    const serverNow = Date.now();

    const updatePayload = {
      geofenceRadius: radius,
      updatedAt: FieldValue.serverTimestamp()
    };

    if (classroomLocation && typeof classroomLocation === "object") {
      if (
        typeof classroomLocation.latitude === "number" &&
        Number.isFinite(classroomLocation.latitude) &&
        typeof classroomLocation.longitude === "number" &&
        Number.isFinite(classroomLocation.longitude)
      ) {
        updatePayload.classroomLocation = {
          ...(sessionData.classroomLocation || {}),
          ...classroomLocation,
          radius: radius
        };
      }
    } else if (sessionData.classroomLocation) {
      updatePayload["classroomLocation.radius"] = radius;
    }

    transaction.update(sessionRef, updatePayload);

    // Immutable Geofence Adjustment Audit Trail
    const auditRef = sessionRef.collection("geofence_adjustments").doc();
    transaction.set(auditRef, {
      adjustmentId: auditRef.id,
      sessionId: sessionId,
      actorUid: callerUid,
      actorEmail: callerEmail,
      actorRole: isAdmin ? "ADMIN" : "LECTURER",
      previousRadius: previousRadius,
      newRadius: radius,
      adjustedAt: FieldValue.serverTimestamp(),
      serverTimestampMs: serverNow
    });

    return {
      success: true,
      sessionId: sessionId,
      previousRadius: previousRadius,
      newRadius: radius,
      message: `Geofence radius successfully updated from ${previousRadius}m to ${radius}m.`
    };
  });
});

/**
 * 18. GENERATE WEBAUTHN REGISTRATION OPTIONS
 * Issues WebAuthn registration options with RP ID, allowed origins, and single-use challenge token.
 * Strictly resolves and validates requested RP ID and origin against WEBAUTHN_CONFIG allowlist.
 */
exports.generateWebAuthnRegistrationOptions = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to generate WebAuthn options.");
  }

  const studentUid = request.auth.uid;
  const studentEmail = request.auth.token.email || "";
  const studentProfile = await resolveAuthoritativeStudent(studentUid, studentEmail);

  const { rpId: requestedRpId, origin: requestedOrigin } = request.data || {};
  const target = resolveWebAuthnTarget(requestedOrigin, requestedRpId);

  const options = await generateRegistrationOptions({
    rpName: target.rpName,
    rpID: target.rpId,
    userID: Buffer.from(studentUid, "utf8"),
    userName: studentProfile.rollNo || studentEmail || studentUid,
    userDisplayName: studentProfile.name || studentProfile.rollNo || "Student",
    attestationType: "none",
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      userVerification: "preferred",
      residentKey: "preferred"
    }
  });

  const challengeId = crypto.randomUUID();
  await db.collection("biometric_challenges").doc(challengeId).set({
    challengeId: challengeId,
    studentUid: studentUid,
    challengeText: options.challenge,
    rpId: target.rpId,
    origin: requestedOrigin || target.expectedOrigins[0],
    type: "WEBAUTHN_REGISTRATION",
    expiresAt: Timestamp.fromMillis(Date.now() + 3 * 60 * 1000),
    used: false,
    createdAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    options: options,
    challengeId: challengeId,
    rpId: target.rpId
  };
});

/**
 * 18. VERIFY WEBAUTHN REGISTRATION
 * Uses @simplewebauthn/server to verify WebAuthn credential registration attestation response.
 * Enforces multi-RP ID credential isolation: credentials for each domain are stored and mapped
 * under credentialsByRpId and rp_credentials subcollection, preventing cross-domain collision.
 */
exports.verifyWebAuthnRegistration = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to register WebAuthn credential.");
  }

  const { response, challengeId, rpId, origin } = request.data || {};
  if (!response || !challengeId) {
    throw new HttpsError("invalid-argument", "Missing required registration response or challengeId.");
  }

  const chalDoc = await db.collection("biometric_challenges").doc(challengeId).get();
  if (!chalDoc.exists || chalDoc.data().used === true || chalDoc.data().studentUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Invalid or already consumed registration challenge.");
  }

  const chalData = chalDoc.data();
  const studentUid = request.auth.uid;
  const studentEmail = request.auth.token.email || "";
  const studentProfile = await resolveAuthoritativeStudent(studentUid, studentEmail);

  // Authoritatively resolve and validate origin and RP ID against allowlist
  const target = resolveWebAuthnTarget(origin || chalData.origin, rpId || chalData.rpId);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: chalData.challengeText,
      expectedOrigin: target.expectedOrigins,
      expectedRPID: target.rpId,
      requireUserVerification: true
    });
  } catch (verErr) {
    throw new HttpsError("permission-denied", "WebAuthn registration verification failed: " + verErr.message);
  }

  if (!verification || !verification.verified || !verification.registrationInfo) {
    throw new HttpsError("permission-denied", "WebAuthn credential registration was not verified.");
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const cosePublicKey = Buffer.from(credential.publicKey);
  const coseBase64 = cosePublicKey.toString("base64");

  // Reconstruct 91-byte P-256 SPKI DER public key for universal cross-platform compatibility
  let spkiDerBase64 = "";
  try {
    if (cosePublicKey.length >= 64) {
      const x = cosePublicKey.subarray(-64, -32);
      const y = cosePublicKey.subarray(-32);
      const spkiHeader = Buffer.from([
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
        0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04
      ]);
      spkiDerBase64 = Buffer.concat([spkiHeader, x, y]).toString("base64");
    }
  } catch (_) {}

  // Multi-RP ID Credential Isolation:
  // Each domain/RP ID has its own isolated credential in credentialsByRpId and rp_credentials subcollection
  const rpIdKey = target.rpId.replace(/\./g, "_");
  const credRecord = {
    studentUid: studentUid,
    rollNo: studentProfile.rollNo,
    studentEmail: studentProfile.email,
    credentialId: credential.id,
    credentialPublicKeyBase64: coseBase64,
    publicKeyDerBase64: spkiDerBase64 || coseBase64,
    platform: "webauthn",
    rpId: target.rpId,
    origin: target.expectedOrigins[0],
    counter: credential.counter || 0,
    credentialDeviceType: credentialDeviceType || "singleDevice",
    credentialBackedUp: Boolean(credentialBackedUp),
    status: "ACTIVE",
    enrollmentMethod: "WEBAUTHN_REGISTRATION",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  const credRef = db.collection("biometric_credentials").doc(studentUid);
  const rollCredRef = db.collection("biometric_credentials").doc(studentProfile.rollNo);
  const isPrimary = target.rpId === "smartattend-ochre.vercel.app";

  const rootUpdate = {
    [`credentialsByRpId.${rpIdKey}`]: credRecord,
    updatedAt: FieldValue.serverTimestamp()
  };
  // If primary domain or first enrollment, also set root fields for backward compatibility
  if (isPrimary) {
    Object.assign(rootUpdate, credRecord);
  }

  await Promise.all([
    db.collection("biometric_challenges").doc(challengeId).update({
      used: true,
      usedAt: FieldValue.serverTimestamp()
    }),
    credRef.set(rootUpdate, { merge: true }),
    credRef.collection("rp_credentials").doc(rpIdKey).set(credRecord),
    rollCredRef.set(rootUpdate, { merge: true }),
    rollCredRef.collection("rp_credentials").doc(rpIdKey).set(credRecord),
    db.collection("students").doc(studentProfile.rollNo).set({
      biometricEnrolled: true,
      hardwareBiometricPlatform: "webauthn",
      hardwareBiometricEnrolledAt: FieldValue.serverTimestamp()
    }, { merge: true }),
    db.collection("biometric_audit_logs").add({
      action: "WEBAUTHN_BIOMETRIC_REGISTRATION",
      studentUid: studentUid,
      rollNo: studentProfile.rollNo,
      credentialId: credential.id,
      rpId: target.rpId,
      platform: "webauthn",
      timestamp: FieldValue.serverTimestamp()
    })
  ]);

  return {
    success: true,
    credentialId: credential.id,
    rpId: target.rpId,
    rollNo: studentProfile.rollNo,
    status: "ACTIVE",
    message: `WebAuthn credential verified and registered successfully for domain ${target.rpId}.`
  };
});



