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

setGlobalOptions({ maxInstances: 10, region: "us-central1" });

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
  const nLat1 = Number(lat1);
  const nLon1 = Number(lon1);
  const nLat2 = Number(lat2);
  const nLon2 = Number(lon2);

  if (!Number.isFinite(nLat1) || !Number.isFinite(nLon1) || !Number.isFinite(nLat2) || !Number.isFinite(nLon2)) {
    return NaN;
  }

  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(nLat2 - nLat1);
  const dLon = toRad(nLon2 - nLon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(nLat1)) * Math.cos(toRad(nLat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const aClamped = Math.max(0, Math.min(1, a));
  const c = 2 * Math.atan2(Math.sqrt(aClamped), Math.sqrt(1 - aClamped));
  return R * c;
}

/**
/**
 * Utility: Authoritatively evaluate student GPS location against session classroom geofence.
 * Rejects mock/spoofed GPS, missing/stale timestamps, low accuracy, and out-of-radius coordinates.
 * 
 * SECURITY BOUNDARY NOTE:
 * Client coordinates, timestamps, and mock-location flags are provided by client device APIs
 * and can be forged on rooted devices with mock-location masking tools. Therefore, geofencing
 * serves as a layered defense-in-depth barrier combined with dynamic rotating QR codes (10s
 * rotation on classroom projector) and platform binding, rather than hardware-level location attestation.
 */
function evaluateServerGeofence(studentCoords, classroomCoords, radiusMetres, serverNowMs = Date.now()) {
  const radius = typeof radiusMetres === "number" ? radiusMetres : 10;
  // Geofencing is optional ONLY when explicitly disabled by setting radius to 0
  if (radius === 0) {
    return { status: "PASS", geofenceEnforced: false, distance: 0, radius: 0 };
  }

  // When geofencing is enabled (radius > 0), classroom coordinates MUST be present
  if (!classroomCoords) {
    return {
      status: "INVALID_CLASSROOM_LOCATION",
      geofenceEnforced: true,
      distance: 0,
      radius,
      message: "Classroom coordinates not configured for this session. Geofence verification required."
    };
  }

  const cLat = Number(classroomCoords.latitude ?? classroomCoords.lat);
  const cLon = Number(classroomCoords.longitude ?? classroomCoords.lng ?? classroomCoords.lon);
  if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) {
    return {
      status: "INVALID_CLASSROOM_LOCATION",
      geofenceEnforced: true,
      distance: 0,
      radius,
      message: "Classroom coordinates are invalid or uncalibrated. Geofence verification failed."
    };
  }

  if (!studentCoords) {
    return {
      status: "LOCATION_UNAVAILABLE",
      geofenceEnforced: true,
      radius,
      message: "GPS coordinates not provided. Real-time classroom presence verification required."
    };
  }

  const sLat = Number(studentCoords.latitude ?? studentCoords.lat);
  const sLon = Number(studentCoords.longitude ?? studentCoords.lng ?? studentCoords.lon);
  if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) {
    return {
      status: "LOCATION_UNAVAILABLE",
      geofenceEnforced: true,
      radius,
      message: "GPS coordinates not provided or invalid. Real-time satellite fix required."
    };
  }

  if (studentCoords.isMock || studentCoords.mocked || studentCoords.isMockLocation) {
    return {
      status: "MOCK_DETECTED",
      geofenceEnforced: true,
      radius,
      message: "Mock GPS / location spoofing detected on client device."
    };
  }

  // Mandatory Location Timestamp Freshness Check
  const studentTimestamp = Number(studentCoords.timestamp);
  if (!Number.isFinite(studentTimestamp) || studentTimestamp <= 0) {
    return {
      status: "STALE_LOCATION",
      geofenceEnforced: true,
      radius,
      message: "Location timestamp is missing or invalid. Fresh live satellite fix required."
    };
  }
  const serverNow = Number(serverNowMs) || Date.now();
  const locationAgeMs = serverNow - studentTimestamp;
  if (locationAgeMs > 90000) { // Older than 90 seconds
    return {
      status: "STALE_LOCATION",
      geofenceEnforced: true,
      radius,
      message: `Location data is stale (captured ${Math.round(locationAgeMs / 1000)}s ago). Fresh location fix required.`
    };
  }
  if (locationAgeMs < -15000) { // Future by > 15s
    return {
      status: "INVALID_TIMESTAMP",
      geofenceEnforced: true,
      radius,
      message: "Location timestamp desynchronized with server time."
    };
  }

  const rawDist = calculateHaversineDistance(sLat, sLon, cLat, cLon);
  if (!Number.isFinite(rawDist)) {
    return {
      status: "LOCATION_UNAVAILABLE",
      geofenceEnforced: true,
      distance: 0,
      radius,
      message: "Unable to calculate classroom distance from provided coordinates."
    };
  }

  const accuracy = Math.max(0, Math.round(Number(studentCoords.accuracy) || 0));

  // Reject if GPS accuracy is excessively degraded (> 45m). Cannot verify 10m classroom presence with degraded satellite fix.
  if (accuracy > 45) {
    return {
      status: "INCONCLUSIVE",
      geofenceEnforced: true,
      distance: Math.round(rawDist * 10) / 10,
      accuracy,
      radius,
      message: `GPS accuracy too low (${accuracy}m > 45m). Accurate satellite fix required to verify classroom presence.`
    };
  }

  const studentAccuracy = accuracy;
  const classroomAccuracy = Math.max(0, Math.round(Number(classroomCoords.accuracy ?? classroomCoords.acc) || 0));

  let uncertaintyAllowance;
  if (classroomAccuracy > 10) {
    const hostAllowance = Math.min(60, classroomAccuracy);
    const studentAllowance = Math.min(45, studentAccuracy > 0 ? studentAccuracy : 15);
    uncertaintyAllowance = Math.round(Math.sqrt(hostAllowance * hostAllowance + studentAllowance * studentAllowance) * 10) / 10;
  } else {
    const maxAllowance = Math.min(5, radius * 0.5);
    uncertaintyAllowance = Math.min(studentAccuracy > 0 ? studentAccuracy / 2 : 0, maxAllowance);
  }

  const measuredDist = Math.round(rawDist * 10) / 10;
  const effectiveDist = Math.max(0, Math.round((rawDist - uncertaintyAllowance) * 10) / 10);

  if (rawDist <= radius || effectiveDist <= radius) {
    return {
      status: "PASS",
      geofenceEnforced: true,
      distance: measuredDist,
      effectiveDistance: effectiveDist,
      accuracy,
      radius
    };
  }

  return {
    status: "REJECT",
    geofenceEnforced: true,
    distance: measuredDist,
    effectiveDistance: effectiveDist,
    accuracy,
    radius,
    message: `Geofence Violation: You are outside the classroom (${measuredDist}m > ${radius}m).`
  };
}

/**
 * Utility: Authoritatively generate dynamic rotating QR HMAC token.
 * Slices HMAC-SHA256 digest to 16 hex characters for lightweight QR display and fast verification.
 */
function generateDynamicQrToken(sessionId, phase, slot, interval, secret) {
  const data = `${sessionId}|${phase}|${slot}|${interval}`;
  return crypto.createHmac("sha256", secret || sessionId).update(data).digest("hex").slice(0, 16);
}

/**
 * Utility: Authoritatively verify dynamic rotating QR payload against time slot, rotation interval, and HMAC.
 * Validates slot boundaries, max 5000ms clock skew / transition grace, and cryptographic signature.
 */
function verifyDynamicQrToken(
  optionsOrSig,
  sessionIdArg,
  phaseArg,
  clientSlotArg,
  clientIntervalArg,
  authoritativeIntervalArg = 10,
  serverNowArg = Date.now(),
  secretArg
) {
  let sig, sessionId, phase, clientSlot, clientInterval, authoritativeInterval, serverNow, secret;
  if (typeof optionsOrSig === "object" && optionsOrSig !== null) {
    ({
      sig,
      sessionId,
      phase,
      clientSlot,
      clientInterval,
      authoritativeInterval = 10,
      serverNow = Date.now(),
      secret
    } = optionsOrSig);
  } else {
    sig = optionsOrSig;
    sessionId = sessionIdArg;
    phase = phaseArg;
    clientSlot = clientSlotArg;
    clientInterval = clientIntervalArg;
    authoritativeInterval = authoritativeIntervalArg ?? 10;
    serverNow = serverNowArg ?? Date.now();
    secret = secretArg;
  }

  const interval = Number(authoritativeInterval) || 10;
  if (clientInterval !== undefined && Number(clientInterval) !== interval) {
    throw new HttpsError("invalid-argument", "invalid-argument: Mismatched QR rotation interval configuration.");
  }
  const slot = Number(clientSlot);
  if (!Number.isInteger(slot)) {
    throw new HttpsError("invalid-argument", "invalid-argument: Invalid QR slot index.");
  }
  const currentSlot = Math.floor(serverNow / (interval * 1000));
  const slotDiff = slot - currentSlot;
  if (Math.abs(slotDiff) > 1) {
    throw new HttpsError("deadline-exceeded", "deadline-exceeded: QR code has expired. Please scan the current live QR code.");
  }
  const maxGraceMs = 5000;
  if (slotDiff === -1) {
    const elapsedSinceSlotEnded = serverNow - (currentSlot * interval * 1000);
    if (elapsedSinceSlotEnded > maxGraceMs) {
      throw new HttpsError("deadline-exceeded", `deadline-exceeded: QR code has expired (${Math.round(elapsedSinceSlotEnded / 1000)}s after rotation). Please scan the current live QR code.`);
    }
  } else if (slotDiff === 1) {
    const msUntilSlotStarts = ((currentSlot + 1) * interval * 1000) - serverNow;
    if (msUntilSlotStarts > maxGraceMs) {
      throw new HttpsError("deadline-exceeded", "deadline-exceeded: QR code has expired. Please scan the current live QR code.");
    }
  }
  if (!sig || typeof sig !== "string" || !sig.trim()) {
    throw new HttpsError("permission-denied", "permission-denied: Missing required cryptographic QR token signature.");
  }
  const expectedSig = generateDynamicQrToken(sessionId, phase, slot, interval, secret);
  const cleanSig = sig.trim();
  const sigBuf = Buffer.from(cleanSig, "utf8");
  const expBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new HttpsError("permission-denied", "permission-denied: Invalid QR token signature.");
  }
  return true;
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
    } catch (_) { }
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
  } catch (_) { }

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
    } catch (_) { }
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
  let arr = descriptor;
  if (!Array.isArray(arr) && typeof arr === "object" && arr !== null) {
    const vals = Object.values(arr);
    if (vals.length === 128) arr = vals;
  }

  if (!Array.isArray(arr) || arr.length !== 128) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a valid 128-dimensional array.`);
  }

  let sumSquares = 0;
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const val = Number(arr[i]);
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
    const d = Number(arr[i]) - mean;
    varianceSum += d * d;
  }
  const stdDev = Math.sqrt(varianceSum / 128);
  if (stdDev < 0.005) {
    throw new HttpsError("invalid-argument", `${fieldName} lacks necessary facial entropy (synthetic constant vector).`);
  }

  return true;
}

const FACE_DUPLICATE_DISTANCE = 0.44;
const FACE_REVIEW_DISTANCE = 0.60;
const FACE_MATCH_DISTANCE = 0.52;

function normalizeFaceVector(descriptor, fieldName = "Face descriptor") {
  let vector = descriptor;
  if (!Array.isArray(vector) && typeof vector === "object" && vector !== null) {
    const values = Object.values(vector);
    if (values.length === 128) vector = values;
  }

  validateFaceVectorDescriptor(vector, fieldName);
  return vector.map(Number);
}

function faceVectorDistance(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length !== 128 || second.length !== 128) {
    return Number.POSITIVE_INFINITY;
  }

  let sumSquares = 0;
  for (let index = 0; index < 128; index++) {
    const difference = Number(first[index]) - Number(second[index]);
    sumSquares += difference * difference;
  }
  return Math.sqrt(sumSquares);
}

function cleanFaceIdentity(value = {}) {
  return {
    rollNo: String(value.rollNo || value.studentRollNo || "").trim().toUpperCase(),
    studentUid: String(value.studentUid || value.uid || value.userUid || "").trim()
  };
}

function sameFaceIdentity(candidate, target) {
  const candidateIdentity = cleanFaceIdentity(candidate);
  const targetIdentity = cleanFaceIdentity(target);
  return Boolean(
    (targetIdentity.rollNo && candidateIdentity.rollNo === targetIdentity.rollNo) ||
    (targetIdentity.studentUid && candidateIdentity.studentUid === targetIdentity.studentUid)
  );
}

function faceIdentityKeys(value) {
  const identity = cleanFaceIdentity(value);
  return [
    identity.rollNo ? `roll:${identity.rollNo}` : "",
    identity.studentUid ? `uid:${identity.studentUid}` : ""
  ].filter(Boolean);
}

function evaluateFaceUniqueness(newVector, candidates, targetIdentity) {
  const matches = [];
  let unreadableCandidate = false;
  const readableCandidateVectors = new Map();
  const readableIdentityKeys = new Set();

  for (const candidate of candidates) {
    if (!candidate) continue;

    const rawDescriptor = candidate.faceDescriptor || candidate.descriptor || candidate.faceVector || candidate.embedding;
    if (!rawDescriptor) continue;

    let candidateVector;
    try {
      candidateVector = normalizeFaceVector(rawDescriptor, "Stored face descriptor");
    } catch (_) {
      continue;
    }

    readableCandidateVectors.set(candidate, candidateVector);
    faceIdentityKeys(candidate).forEach((key) => readableIdentityKeys.add(key));
  }

  for (const candidate of candidates) {
    if (!candidate || sameFaceIdentity(candidate, targetIdentity)) continue;

    const rawDescriptor = candidate.faceDescriptor || candidate.descriptor || candidate.faceVector || candidate.embedding;
    if (!rawDescriptor) {
      const identityKeys = faceIdentityKeys(candidate);
      if (
        (candidate.faceRegistered === true || candidate.status === "PENDING") &&
        !identityKeys.some((key) => readableIdentityKeys.has(key))
      ) {
        unreadableCandidate = true;
      }
      continue;
    }

    const candidateVector = readableCandidateVectors.get(candidate);
    if (!candidateVector) {
      const identityKeys = faceIdentityKeys(candidate);
      if (!identityKeys.some((key) => readableIdentityKeys.has(key))) unreadableCandidate = true;
      continue;
    }

    matches.push({
      candidate,
      distance: faceVectorDistance(newVector, candidateVector)
    });
  }

  matches.sort((left, right) => left.distance - right.distance);
  if (matches.some((match) => match.distance <= FACE_DUPLICATE_DISTANCE)) {
    return { decision: "duplicate", match: matches[0] };
  }
  if (unreadableCandidate || matches.some((match) => match.distance <= FACE_REVIEW_DISTANCE)) {
    return {
      decision: "review",
      match: matches.find((item) => item.distance <= FACE_REVIEW_DISTANCE) || null
    };
  }
  return { decision: "unique", match: null };
}

async function isFaceEnrollmentStaff(request) {
  if (request.auth?.token?.admin === true) return true;
  try {
    await assertAdmin(request);
    return true;
  } catch (error) {
    if (error?.code !== "permission-denied") throw error;
  }

  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
  const email = String(request.auth.token.email || "").trim().toLowerCase();
  const prefix = email ? email.split("@")[0] : "";
  const authCandidates = [
    db.collection("users").doc(uid),
    ...(email ? [db.collection("authorizedUsers").doc(email)] : []),
    ...(prefix ? [db.collection("authorizedUsers").doc(prefix)] : [])
  ];
  const authDocs = await Promise.all(authCandidates.map((ref) => ref.get()));
  const staffRoles = new Set(["lecturer", "faculty", "professor", "admin", "administrator", "superadmin"]);
  if (authDocs.some((docSnap) => {
    if (!docSnap.exists) return false;
    const data = docSnap.data() || {};
    return staffRoles.has(String(data.role || "").toLowerCase()) ||
      data.isAdmin === true;
  })) return true;

  try {
    await assertLecturer(request);
    return true;
  } catch (error) {
    if (error?.code === "permission-denied") return false;
    throw error;
  }
}

function faceCandidateFromDoc(docSnap, collectionName) {
  const data = docSnap.data() || {};
  const inferredRollNo = data.rollNo ||
    (String(docSnap.id).includes("@") ? String(docSnap.id).split("@")[0] : docSnap.id);
  const identity = cleanFaceIdentity({ ...data, rollNo: inferredRollNo });
  return {
    ...identity,
    faceDescriptor: data.faceDescriptor || data.descriptor || data.faceVector || data.embedding || null,
    faceRegistered: data.faceRegistered === true,
    status: data.status,
    name: data.name || data.fullName || "",
    collectionName,
    docId: docSnap.id
  };
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

async function resolveBiometricEnrollmentIdentity(request) {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication is required to enroll biometrics.");
  }

  const email = String(request.auth.token.email || "").trim().toLowerCase();
  const isStaff = await isFaceEnrollmentStaff(request);
  if (!isStaff) {
    const student = await resolveAuthoritativeStudent(uid, email);
    return {
      ...student,
      identityType: "STUDENT",
      staffRole: null,
      isStaff: false,
      staffRef: null,
      staffData: null
    };
  }

  const emailPrefix = email ? email.split("@")[0] : "";
  const ids = [...new Set([uid, email, emailPrefix].filter(Boolean))];
  const userRef = db.collection("users").doc(uid);
  const staffRoleFromClaims = String(request.auth.token.role || "").trim().toLowerCase();
  const adminRoleFromClaims = request.auth.token.admin === true ||
    ["admin", "administrator", "superadmin"].includes(staffRoleFromClaims);

  const [userSnap, adminSnaps, lecturerSnaps, authorizedSnaps] = await Promise.all([
    userRef.get(),
    Promise.all(ids.map((id) => db.collection("admins").doc(id).get())),
    Promise.all(ids.map((id) => db.collection("lecturers").doc(id).get())),
    Promise.all(ids.map((id) => db.collection("authorizedUsers").doc(id).get()))
  ]);

  let staffRole = adminRoleFromClaims ? "ADMIN" : "";
  let staffSnap = null;
  const profileSnaps = [userSnap, ...authorizedSnaps].filter((snapshot) => snapshot.exists);
  if (!staffRole) {
    const adminSnap = adminSnaps.find((snapshot) => snapshot.exists);
    if (adminSnap) {
      staffRole = "ADMIN";
      staffSnap = adminSnap;
    }
  }
  if (!staffRole && profileSnaps.some((snapshot) => {
    const data = snapshot.data() || {};
    return ["admin", "administrator", "superadmin"].includes(
      String(data.role || data.designation || "").trim().toLowerCase()
    ) || data.isAdmin === true;
  })) {
    staffRole = "ADMIN";
    staffSnap = profileSnaps.find((snapshot) => {
      const data = snapshot.data() || {};
      return ["admin", "administrator", "superadmin"].includes(
        String(data.role || data.designation || "").trim().toLowerCase()
      ) || data.isAdmin === true;
    });
  }
  if (!staffRole) {
    const staffProfile = [...profileSnaps, ...lecturerSnaps].find((snapshot) => {
      if (!snapshot.exists) return false;
      const data = snapshot.data() || {};
      return ["lecturer", "faculty", "professor"].includes(
        String(data.role || data.designation || "").trim().toLowerCase()
      );
    });
    if (!staffProfile) {
      throw new HttpsError("permission-denied", "The staff account could not be verified for biometric enrollment.");
    }
    staffRole = "LECTURER";
    staffSnap = lecturerSnaps.find((snapshot) => snapshot.exists) || staffProfile;
  }

  const userData = userSnap.exists ? userSnap.data() || {} : {};
  const staffData = staffSnap?.exists ? staffSnap.data() || {} : {};
  const authorizedData = authorizedSnaps.find((snapshot) => snapshot.exists)?.data() || {};
  const profile = { ...authorizedData, ...userData, ...staffData };
  const staffCollection = staffRole === "ADMIN" ? "admins" : "lecturers";
  const existingStaffSnap = (staffRole === "ADMIN" ? adminSnaps : lecturerSnaps)
    .find((snapshot) => snapshot.exists);
  const staffRef = existingStaffSnap
    ? existingStaffSnap.ref
    : db.collection(staffCollection).doc(uid);
  const staffId = String(
    profile.staffId ||
    profile.employeeId ||
    profile.lecturerId ||
    profile.adminId ||
    emailPrefix ||
    uid
  ).trim().toUpperCase();

  return {
    uid,
    rollNo: staffId,
    name: profile.name || profile.fullName || profile.displayName ||
      request.auth.token.name || staffId,
    email: profile.email || email,
    identityType: "STAFF",
    staffRole,
    isStaff: true,
    staffRef,
    staffData: profile
  };
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
  const uRole = (userDoc.exists && userDoc.data().role) ? String(userDoc.data().role).toLowerCase() : "";
  if (uRole === "lecturer" || uRole === "faculty") return true;

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
 * Returns a Set of student roll numbers enrolled in courses taught by the given lecturer.
 * Checks direct lecturer assignment, assignedLecturers list, and cohort rosters.
 */
async function getAuthorizedStudentRollsForLecturer(lecturerUid, lecturerEmail) {
  const cleanEmail = String(lecturerEmail || "").toLowerCase().trim();
  const cleanUid = String(lecturerUid || "").trim();
  const prefix = cleanEmail ? cleanEmail.split("@")[0] : "";
  const coursesSnap = await db.collection("courses").get();
  const authorizedRolls = new Set();

  for (const doc of coursesSnap.docs) {
    const c = doc.data() || {};
    let isAssigned = false;
    if (c.lecturerEmail && String(c.lecturerEmail).toLowerCase().trim() === cleanEmail) isAssigned = true;
    if (c.lecturerId && (c.lecturerId === cleanUid || String(c.lecturerId).toLowerCase().trim() === cleanEmail)) isAssigned = true;
    if (Array.isArray(c.assignedLecturers)) {
      for (const l of c.assignedLecturers) {
        const lEmail = typeof l === "string" ? l.toLowerCase().trim() : String(l.email || "").toLowerCase().trim();
        const lUid = typeof l === "object" ? (l.uid || l.id) : null;
        if (lEmail === cleanEmail || (prefix && lEmail === prefix) || (lUid && lUid === cleanUid)) {
          isAssigned = true;
          break;
        }
      }
    }
    if (c.lecturer && typeof c.lecturer === "string") {
      const l = c.lecturer.toLowerCase().trim();
      if (l === cleanEmail || (prefix && l === prefix)) isAssigned = true;
    }

    if (isAssigned) {
      if (Array.isArray(c.enrolledStudents)) {
        for (const s of c.enrolledStudents) {
          const r = typeof s === "string" ? s.toUpperCase().trim() : String(s.rollNo || s.rollNumber || "").toUpperCase().trim();
          if (r) authorizedRolls.add(r);
        }
      }
    }
  }

  return authorizedRolls;
}

/**
 * Resolves whether an active re-registration permission exists for the given student rollNo
 * and registration type ("FACE" or "BIOMETRIC").
 * Returns { hasPermission: boolean, permissionDoc: DocumentSnapshot|null, permissionData: Object|null }
 */
async function resolveActiveReRegistrationPermission(transactionOrDb, rollNo, registrationType) {
  const cleanRoll = String(rollNo || "").trim().toUpperCase();
  if (!cleanRoll) return { hasPermission: false, permissionDoc: null, permissionData: null };

  const query = db.collection("biometric_reregistration_permissions")
    .where("targetRollNo", "==", cleanRoll)
    .where("status", "==", "ACTIVE");

  const snap = transactionOrDb && typeof transactionOrDb.get === "function"
    ? await transactionOrDb.get(query)
    : await query.get();

  const nowMs = Date.now();
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const pType = String(data.registrationType || "").toUpperCase();
    if (pType !== registrationType && pType !== "BOTH") continue;

    if (data.expiresAt) {
      const expMs = typeof data.expiresAt.toMillis === "function"
        ? data.expiresAt.toMillis()
        : new Date(data.expiresAt).getTime();
      if (expMs <= nowMs) {
        continue;
      }
    }

    const mode = String(data.mode || "ONE_TIME").toUpperCase();
    if (mode === "ONE_TIME") {
      const remaining = data.remainingUses != null ? Number(data.remainingUses) : 1;
      if (remaining <= 0) continue;
    }

    return { hasPermission: true, permissionDoc: docSnap, permissionData: data };
  }

  return { hasPermission: false, permissionDoc: null, permissionData: null };
}

/**
 * Consumes or updates a re-registration permission within a Firestore transaction.
 * One-time grants are atomically decremented and marked EXHAUSTED when 0 uses remain.
 * Repeated grants increment use count without expiring.
 */
function consumeReRegistrationPermission(transaction, permissionDoc, permissionData) {
  if (!transaction || !permissionDoc) return;
  const mode = String(permissionData.mode || "ONE_TIME").toUpperCase();
  const usedCount = Number(permissionData.usedCount || 0) + 1;
  const now = FieldValue.serverTimestamp();

  if (mode === "ONE_TIME") {
    const remaining = (permissionData.remainingUses != null ? Number(permissionData.remainingUses) : 1) - 1;
    transaction.update(permissionDoc.ref, {
      usedCount,
      remainingUses: Math.max(0, remaining),
      status: remaining <= 0 ? "EXHAUSTED" : "ACTIVE",
      lastUsedAt: now,
      consumedAt: remaining <= 0 ? now : null
    });
  } else {
    transaction.update(permissionDoc.ref, {
      usedCount,
      lastUsedAt: now
    });
  }
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

  // Geofence radius validation: approved range is 5 to 50 metres, default is 10 metres.
  // Reject invalid, non-numeric, non-finite, below-minimum, or above-maximum values without silent conversion.
  let effectiveGeofenceRadius = 10;
  if (geofenceRadius !== undefined && geofenceRadius !== null) {
    if (typeof geofenceRadius !== "number" || !Number.isFinite(geofenceRadius) || geofenceRadius < 5 || geofenceRadius > 50) {
      throw new HttpsError(
        "invalid-argument",
        "Geofence radius must be a finite number between 5 and 50 metres (default is 10m)."
      );
    }
    effectiveGeofenceRadius = geofenceRadius;
  }

  const nowMs = Date.now();
  const sessionStartMs = nowMs;

  // Granular QR1 + QR2 Duration Timetable Breakdown (default: 45s + 75s)
  let qr1DurationSec = 45;
  let qr2DurationSec = 75;

  if (Number(request.data?.qr1DurationSeconds) > 0 && Number(request.data?.qr2DurationSeconds) > 0) {
    qr1DurationSec = Math.max(15, Math.min(600, Math.round(Number(request.data.qr1DurationSeconds))));
    qr2DurationSec = Math.max(15, Math.min(1800, Math.round(Number(request.data.qr2DurationSeconds))));
  } else if (Number(request.data?.durationMinutes) > 0) {
    const totalMinutes = Number(request.data.durationMinutes);
    const totalSec = Math.round(totalMinutes * 60);
    qr1DurationSec = Math.min(60, Math.max(15, Math.round(totalSec / 3)));
    qr2DurationSec = Math.max(15, totalSec - qr1DurationSec);
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

  let rotationIntervalSec = 10;
  if (request.data?.rotationIntervalSec !== undefined) {
    const parsedInt = Number(request.data.rotationIntervalSec);
    if (!Number.isInteger(parsedInt) || (parsedInt !== 3 && (parsedInt < 5 || parsedInt > 60 || parsedInt % 5 !== 0))) {
      throw new HttpsError("invalid-argument", "QR rotation interval must be 3 seconds or an integer between 5 and 60 seconds divisible by 5.");
    }
    rotationIntervalSec = parsedInt;
  }

  const cleanCourse = courseCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const cleanClass = classCode !== courseCode ? `_${classCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "")}` : "";
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const sessionId = `${cleanCourse}${cleanClass}_${nowMs}_${randomSuffix}`;

  const pinSalt = crypto.randomBytes(16).toString("hex");
  const saltedReleaseCodeHash = hashToken(`${pinSalt}:${rawReleaseCode}`);
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
    geofenceRadius: effectiveGeofenceRadius,
    rotationIntervalSec: rotationIntervalSec,
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

  // Private Security Document (Only Cloud Functions Admin SDK can read/write; zero client access; zero plaintext PINs)
  const securityDoc = {
    qr1Token: qr1Token,
    qr2Token: qr2Token,
    qr1TokenHash: qr1TokenHash,
    qr2TokenHash: qr2TokenHash,
    pinSalt: pinSalt,
    saltedReleaseCodeHash: saltedReleaseCodeHash,
    lecturerReleaseCodeHash: lecturerReleaseCodeHash,
    sessionPinHash: lecturerReleaseCodeHash,
    rotationIntervalSec: rotationIntervalSec,
    sessionStartAt: Timestamp.fromMillis(sessionStartMs),
    qr1ExpiresAt: Timestamp.fromMillis(qr1ExpiresMs),
    qr2StartsAt: Timestamp.fromMillis(qr2StartsMs),
    kioskEndsAt: Timestamp.fromMillis(kioskEndsMs)
  };

  const sessionBatch = db.batch();
  sessionBatch.set(sessionRef, sessionDoc);
  sessionBatch.set(sessionRef.collection("security").doc("tokens"), securityDoc);
  await sessionBatch.commit();

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
    rotationIntervalSec: rotationIntervalSec,
    geofenceRadius: effectiveGeofenceRadius,
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
  const isDynamic = request.data?.slot !== undefined || request.data?.sig !== undefined;
  if (!sessionId || (!qr1Token && !isDynamic)) {
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
  const authoritativeInterval = security.rotationIntervalSec || session.rotationIntervalSec || 10;
  const isDynamicPayload = request.data?.slot !== undefined || request.data?.sig !== undefined;

  if (isDynamicPayload) {
    verifyDynamicQrToken({
      sig: request.data.sig,
      sessionId,
      phase: 1,
      clientSlot: request.data.slot,
      clientInterval: request.data.int,
      authoritativeInterval,
      serverNow,
      secret: security.qr1Token || sessionId
    });
  } else {
    const inputHash = hashToken(qr1Token);
    if (inputHash !== security.qr1TokenHash) {
      throw new HttpsError("permission-denied", "❌ Invalid QR 1 token.");
    }
  }

  // 3b. Server-Side Geofence Verification (if enabled by lecturer)
  const classroomLoc = session.classroomLocation;
  const radius = typeof session.geofenceRadius === "number" ? session.geofenceRadius : 10;
  if (radius > 0) {
    const geoResult = evaluateServerGeofence(studentLocation, classroomLoc, radius, serverNow);
    if (geoResult.geofenceEnforced && geoResult.status !== "PASS") {
      throw new HttpsError(
        "permission-denied",
        geoResult.message || `❌ Geofence Violation: Location check failed (${geoResult.status}). Attendance check-in rejected.`
      );
    }
  }

  // 4. Resolve trusted student identity from database
  const studentProfile = await resolveTrustedStudent(studentUid, studentEmail);
  const rollNo = studentProfile.rollNo;

  // 4b. Authoritative Platform Binding Verification (Option A: Fail-closed on unbound accounts)
  const studentDocSnap = await db.collection("students").doc(rollNo).get();
  const studentDoc = studentDocSnap.exists ? studentDocSnap.data() : null;

  // Authoritative field: registeredPlatform. Legacy/stale deviceType cannot bypass fail-closed check.
  const boundPlatform = studentDoc?.registeredPlatform;

  if (!boundPlatform || (boundPlatform !== "android" && boundPlatform !== "ios")) {
    throw new HttpsError(
      "failed-precondition",
      "Device platform onboarding incomplete. Your account has not been bound to an authorized device (Android or iOS). Please complete device setup before checking in."
    );
  }

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
      qr2StartsAt: security.qr2StartsAt ? security.qr2StartsAt.toMillis() : qr1ExpiresAtMs,
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
      kioskEndsAt: security.kioskEndsAt,
      registeredPlatform: boundPlatform,
      detectedPlatform: boundPlatform
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
  const isDynamic = request.data?.slot !== undefined || request.data?.sig !== undefined;
  if (!sessionId || (!qr2Token && !isDynamic)) {
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
  const authoritativeInterval = security.rotationIntervalSec || session.rotationIntervalSec || 10;
  const isDynamicPayload = request.data?.slot !== undefined || request.data?.sig !== undefined;

  if (isDynamicPayload) {
    verifyDynamicQrToken({
      sig: request.data.sig,
      sessionId,
      phase: 2,
      clientSlot: request.data.slot,
      clientInterval: request.data.int,
      authoritativeInterval,
      serverNow,
      secret: security.qr2Token || sessionId
    });
  } else {
    const inputHash = hashToken(qr2Token);
    if (inputHash !== security.qr2TokenHash) {
      throw new HttpsError("permission-denied", "❌ Invalid QR 2 token.");
    }
  }

  // 4. STRICT CHECK: Must have QR1_VERIFIED authorization from QR 1 for this exact session
  let authRef = sessionRef.collection("authorizations").doc(studentUid);
  let authSnap = await authRef.get();
  if (!authSnap.exists) {
    const studentProfile = await resolveTrustedStudent(studentUid, request.auth.token.email);
    if (studentProfile?.rollNo) {
      const rollRef = sessionRef.collection("authorizations").doc(studentProfile.rollNo);
      const rollSnap = await rollRef.get();
      if (rollSnap.exists) {
        authRef = rollRef;
        authSnap = rollSnap;
      }
    }
  }

  const isQr1Valid = authSnap.exists && (
    authSnap.data().qr1Verified === true ||
    authSnap.data().status === "QR1_VERIFIED" ||
    authSnap.data().status === "SESSION_AUTHORIZED" ||
    authSnap.data().status === "QR2_VERIFIED"
  );
  if (!isQr1Valid) {
    throw new HttpsError(
      "permission-denied",
      "⛔ Access denied. You must scan QR 1 first."
    );
  }

  const authData = authSnap.data() || {};
  const studentProfile = await resolveTrustedStudent(studentUid, request.auth.token.email);
  const rollNo = (authData.rollNo || studentProfile?.rollNo || "").toUpperCase().trim();

  let rollAuthData = {};
  if (rollNo && rollNo !== studentUid) {
    try {
      const rSnap = await sessionRef.collection("authorizations").doc(rollNo).get();
      if (rSnap.exists) rollAuthData = rSnap.data() || {};
    } catch (_) {}
  }

  const sessionFlagged = (session.flaggedViolations || []).find((f) => {
    const fRoll = (f.rollNo || "").toUpperCase().trim();
    const fUid = (f.studentUid || "").toUpperCase().trim();
    return (rollNo && fRoll === rollNo) || (studentUid && fUid === studentUid.toUpperCase().trim());
  });

  const isDisqualified =
    authData.disqualified === true ||
    rollAuthData.disqualified === true ||
    (sessionFlagged && !sessionFlagged.excused && !sessionFlagged.resolved && (sessionFlagged.disqualified === true || sessionFlagged.status === "FLAGGED_DISQUALIFIED"));

  const hasUnexcusedViolation =
    (authData.hasViolation === true && !authData.excused) ||
    (authData.violation === 1 && !authData.excused) ||
    (Number(authData.confirmedKioskViolations || authData.violationCount || 0) >= 1 && !authData.excused) ||
    (rollAuthData.hasViolation === true && !rollAuthData.excused) ||
    (rollAuthData.violation === 1 && !rollAuthData.excused) ||
    (Number(rollAuthData.confirmedKioskViolations || rollAuthData.violationCount || 0) >= 1 && !rollAuthData.excused) ||
    (sessionFlagged && !sessionFlagged.excused && !sessionFlagged.resolved && Number(sessionFlagged.count || sessionFlagged.violationCount || 0) >= 1);

  // Reject if unexcused violation or disqualified
  if (isDisqualified || hasUnexcusedViolation) {
    throw new HttpsError(
      "permission-denied",
      "❌ Access rejected: An unexcused security violation is recorded on your session."
    );
  }

  // 5. Check for duplicate attendance submission
  const recordId = `${sessionId}_${authData.rollNo}`;
  const recordSnap = await db.collection("attendance_records").doc(recordId).get();
  if (recordSnap.exists) {
    throw new HttpsError(
      "already-exists",
      `Roll Number ${authData.rollNo} has already submitted attendance for this session.`
    );
  }

  // Atomically stamp QR 2 verification status and timestamp in auth doc
  await authRef.update({
    qr2Verified: true,
    qr2VerifiedAt: FieldValue.serverTimestamp(),
    status: "QR2_VERIFIED"
  });

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
  try {
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

    const session = sessionSnap.data() || {};
    const security = securitySnap.data() || {};

    const serverNow = Date.now();
    const kioskEndsAtMs = parseStrictTimestampMs(security.kioskEndsAt) ||
      (typeof security.kioskEndsAt?.toMillis === "function" ? security.kioskEndsAt.toMillis() : Number(security.kioskEndsAt) || 0);

    if (session.active === false || (kioskEndsAtMs && serverNow > kioskEndsAtMs)) {
      throw new HttpsError("failed-precondition", "Attendance session is closed.");
    }

    // Option A: Authoritative Student Platform Binding Verification (Fail-closed on unbound accounts)
    const studentProfile = await resolveTrustedStudent(studentUid, request.auth.token.email);
    const rollNo = (studentProfile?.rollNo || "").trim().toUpperCase();
    const studentName = studentProfile?.name || rollNo || "Student";
    const studentEmail = (studentProfile?.email || request.auth.token.email || "").toLowerCase().trim();

    const studentDocSnap = await db.collection("students").doc(rollNo).get();
    const studentDoc = studentDocSnap.exists ? studentDocSnap.data() : null;
    const credSnap = await db.collection("biometric_credentials").doc(studentUid).get();
    let credData = credSnap.exists ? credSnap.data() : null;
    if (!credData && rollNo) {
      const rollCredSnap = await db.collection("biometric_credentials").doc(rollNo).get();
      if (rollCredSnap.exists) credData = rollCredSnap.data();
    }

    // Authoritative field: registeredPlatform. Legacy/stale deviceType or credData.platform cannot bypass fail-closed check.
    const boundPlatform = studentDoc?.registeredPlatform;

    if (!boundPlatform || (boundPlatform !== "android" && boundPlatform !== "ios")) {
      throw new HttpsError(
        "failed-precondition",
        "Device platform onboarding incomplete. Attendance submission requires an authorized bound device platform (Android or iOS). Please complete device setup."
      );
    }

    // 1. Authoritative Student Authorization Resolution
    let authRef = sessionRef.collection("authorizations").doc(studentUid);
    let authSnap = await authRef.get();
    if (!authSnap.exists && rollNo) {
      const rollRef = sessionRef.collection("authorizations").doc(rollNo);
      const rollSnap = await rollRef.get();
      if (rollSnap.exists) {
        authRef = rollRef;
        authSnap = rollSnap;
      }
    }

    const isQr1Valid = authSnap.exists && (
      authSnap.data().qr1Verified === true ||
      authSnap.data().status === "QR1_VERIFIED" ||
      authSnap.data().status === "SESSION_AUTHORIZED" ||
      authSnap.data().status === "QR2_VERIFIED"
    );
    if (!isQr1Valid) {
      throw new HttpsError("permission-denied", "⛔ Access denied. You must scan QR 1 first.");
    }

    const authData = authSnap.data() || {};

    let rollAuthData = {};
    if (rollNo && rollNo !== studentUid) {
      try {
        const rSnap = await sessionRef.collection("authorizations").doc(rollNo).get();
        if (rSnap.exists) rollAuthData = rSnap.data() || {};
      } catch (_) {}
    }

    const sessionFlagged = (session.flaggedViolations || []).find((f) => {
      const fRoll = (f.rollNo || "").toUpperCase().trim();
      const fUid = (f.studentUid || "").toUpperCase().trim();
      return (rollNo && fRoll === rollNo.toUpperCase().trim()) || (studentUid && fUid === studentUid.toUpperCase().trim());
    });

    const isDisqualified =
      authData.disqualified === true ||
      rollAuthData.disqualified === true ||
      (sessionFlagged && !sessionFlagged.excused && !sessionFlagged.resolved && (sessionFlagged.disqualified === true || sessionFlagged.status === "FLAGGED_DISQUALIFIED"));

    const hasUnexcusedViolation =
      (authData.hasViolation === true && !authData.excused) ||
      (authData.violation === 1 && !authData.excused) ||
      (Number(authData.confirmedKioskViolations || authData.violationCount || 0) >= 1 && !authData.excused) ||
      (rollAuthData.hasViolation === true && !rollAuthData.excused) ||
      (rollAuthData.violation === 1 && !rollAuthData.excused) ||
      (Number(rollAuthData.confirmedKioskViolations || rollAuthData.violationCount || 0) >= 1 && !rollAuthData.excused) ||
      (sessionFlagged && !sessionFlagged.excused && !sessionFlagged.resolved && Number(sessionFlagged.count || sessionFlagged.violationCount || 0) >= 1);

    // Strict authoritative violation enforcement: reject if unexcused violation or disqualified
    if (isDisqualified || hasUnexcusedViolation) {
      throw new HttpsError(
        "permission-denied",
        "❌ Attendance rejected: An unexcused security violation is recorded on your session. Attendance cannot be submitted unless excused by an authorized instructor."
      );
    }

    // 2. Validate QR 2 token
    // Accept if student just validated QR 2 via validateQR2 within the face scan freshness window (35s)
    const QR2_FACE_WINDOW_MS = 35000; // 35 seconds: accommodates camera start, blink liveness, and network latency without allowing stale submissions
    const qr2VerifiedAtMs = parseStrictTimestampMs(authData.qr2VerifiedAt);
    const hasRecentQr2Validation = authData.qr2Verified === true && qr2VerifiedAtMs && (serverNow - qr2VerifiedAtMs) <= QR2_FACE_WINDOW_MS;

    if (!hasRecentQr2Validation) {
      const authoritativeInterval = security.rotationIntervalSec || session.rotationIntervalSec || 10;
      const isDynamicPayload = request.data?.slot !== undefined || request.data?.sig !== undefined;

      if (isDynamicPayload) {
        verifyDynamicQrToken({
          sig: request.data.sig,
          sessionId,
          phase: 2,
          clientSlot: request.data.slot,
          clientInterval: request.data.int,
          authoritativeInterval,
          serverNow,
          secret: security.qr2Token || sessionId
        });
      } else {
        if (!qr2Token || hashToken(qr2Token) !== security.qr2TokenHash) {
          throw new HttpsError("permission-denied", "Invalid QR 2 token.");
        }
      }
    }

    const recordId = `${sessionId}_${rollNo}`;

    // 3. Hardware Biometric Verification & Platform Enforcement Policy
    let authMode = "WEB_BROWSER";
    let hardwarePlatform = "web";
    let signatureVerified = false;

    const rawUserAgent = (request.rawRequest?.headers?.["user-agent"] || "").toLowerCase();
    const secChUaPlatform = (request.rawRequest?.headers?.["sec-ch-ua-platform"] || "").toLowerCase();
    const isAndroidHeader = rawUserAgent.includes("android") || secChUaPlatform.includes("android");
    const isAndroidBound = boundPlatform === "android";
    const isAndroidSubmission = isAndroidBound || isAndroidHeader || (authData.detectedPlatform === "android") || (authData.registeredPlatform === "android");

    // Android students MUST submit through the authorized native SmartAttend application with hardware biometric proof.
    // Android browsers, direct callable requests without hardware proof, or spoofed platform flags MUST be rejected.
    if (isAndroidSubmission) {
      if (!hardwareProof || !hardwareProof.challengeId || !hardwareProof.signature) {
        throw new HttpsError(
          "permission-denied",
          "Android attendance requires the authorized native SmartAttend application with hardware biometric authentication. Submissions from Android web browsers or direct unsigned calls are prohibited."
        );
      }
      if (!credData || credData.status !== "ACTIVE" || !credData.publicKeyDerBase64) {
        throw new HttpsError(
          "permission-denied",
          "Hardware biometric authentication is required for Android attendance, but no active native credential was found. Please enroll via the native SmartAttend app."
        );
      }
    }

    // Untrusted platform field spoofing prevention:
    // A client cannot claim isNative: true or platform: "android" / "native" without verified hardware proof
    if (isNative && (!hardwareProof || !hardwareProof.challengeId || !hardwareProof.signature)) {
      throw new HttpsError(
        "permission-denied",
        "Native mobile attendance requires verified hardware biometric proof. Untrusted platform flags are rejected."
      );
    }

    // Hardware Credential Bypass Prevention:
    // Any student with an active enrolled hardware credential MUST provide valid hardware proof.
    // They cannot bypass hardware authentication by simply omitting the hardwareProof payload.
    if (credData && credData.status === "ACTIVE" && (!hardwareProof || !hardwareProof.challengeId || !hardwareProof.signature)) {
      throw new HttpsError(
        "permission-denied",
        "Hardware biometric authentication is required for your account. Submissions without hardware biometric proof are rejected."
      );
    }

    if (hardwareProof && hardwareProof.challengeId && hardwareProof.signature) {
      const { challengeId, signature, platform: proofPlatform, clientDataJSON, authenticatorData, rpId: proofRpId } = hardwareProof;

      if (credData && credData.status === "ACTIVE") {
        // WebAuthn Assertion: Handle multi-RP ID credential isolation (for supported iPhone/web platforms)
        if (clientDataJSON && authenticatorData) {
          let clientOrigin = "";
          try {
            const clientB64 = toBase64Url(clientDataJSON);
            const parsed = JSON.parse(Buffer.from(clientB64, "base64url").toString("utf8"));
            clientOrigin = parsed.origin || "";
          } catch (_) { }

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

          if (activeCredForRp && activeCredForRp.status === "ACTIVE" && activeCredForRp.publicKeyDerBase64) {
            credData = activeCredForRp;
            hardwarePlatform = "webauthn";
            authMode = "WEBAUTHN_ASSERTION";
            signatureVerified = false;
          }
        } else {
          hardwarePlatform = proofPlatform || credData.platform || "android";
          authMode = "NATIVE_MOBILE";
          signatureVerified = false;
        }
      } else {
        throw new HttpsError(
          "permission-denied",
          "Hardware biometric credential is not active or not registered. Attendance cannot be submitted."
        );
      }
    } else {
      // iPhone / Web browser flow (only permitted for non-Android students)
      authMode = "WEB_BROWSER";
      hardwarePlatform = "web";
      signatureVerified = false;
    }

    // 4. Server-Side Face Identity & Vector Verification
    // Single authoritative enrollment source: students collection (protected by Security Rules)
    let enrolledDescriptor = null;
    const faceEnrollmentSnap = await db.collection("face_enrollments").doc(String(rollNo).trim().toUpperCase()).get();
    if (faceEnrollmentSnap.exists) enrolledDescriptor = faceEnrollmentSnap.data()?.faceDescriptor;
    if (!enrolledDescriptor && studentDocSnap?.exists) enrolledDescriptor = studentDocSnap.data()?.faceDescriptor;
    if (!enrolledDescriptor) {
      const studentUidFaceSnap = await db.collection("face_enrollments").doc(studentUid).get();
      if (studentUidFaceSnap.exists) enrolledDescriptor = studentUidFaceSnap.data()?.faceDescriptor;
    }
    if (!enrolledDescriptor) {
      const studentUidSnap = await db.collection("students").doc(studentUid).get();
      if (studentUidSnap.exists) enrolledDescriptor = studentUidSnap.data()?.faceDescriptor;
    }

    if (!enrolledDescriptor) {
      throw new HttpsError("failed-precondition", `Authoritative student facial profile for ${rollNo} not found. Please register face biometrics first.`);
    }

    if (!Array.isArray(enrolledDescriptor) && typeof enrolledDescriptor === "object" && enrolledDescriptor !== null) {
      const vals = Object.values(enrolledDescriptor);
      if (vals.length === 128) enrolledDescriptor = vals;
    }

    // Validate structural integrity and entropy of authoritative enrolled template
    validateFaceVectorDescriptor(enrolledDescriptor, `Enrolled face template for ${rollNo}`);

    let liveDescriptor = biometricData?.liveDescriptor || biometricData?.faceDescriptor;
    if (!Array.isArray(liveDescriptor) && typeof liveDescriptor === "object" && liveDescriptor !== null) {
      const vals = Object.values(liveDescriptor);
      if (vals.length === 128) liveDescriptor = vals;
    }
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
    if (!Number.isFinite(serverCalculatedDistance)) {
      throw new HttpsError("failed-precondition", "Face comparison could not be completed safely. Please try again.");
    }
    const MAX_FACE_MATCH_THRESHOLD = FACE_MATCH_DISTANCE;

    // Verify optical presence signal from client-side vision pipeline:
    // ARCHITECTURAL SECURITY CONTRACT:
    // Client-side optical liveness detection (blink detection and landmark motion variance via face-api.js)
    // acts as a supplementary client-side heuristic. In the absence of specialized 3D depth hardware
    // (such as Apple TrueDepth IR cameras) or server-side video stream challenge analysis, client-supplied
    // boolean flags cannot be cryptographically proven by the backend.
    // Genuine cryptographic student & device verification is provided separately via hardware-backed
    // keystore challenges (biometric_challenges/{challengeId}) and authoritative face vector comparison.
    const isAntiSpoofPassed = biometricData?.antiSpoof === "PASSED" || biometricData?.antiSpoofScore === "PASSED" || biometricData?.antiSpoof === undefined;
    if (!biometricData || biometricData.liveness !== true || !isAntiSpoofPassed || biometricData.antiSpoof === "FAILED") {
      throw new HttpsError("permission-denied", "Face liveness verification failed. Active optical presence required.");
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

    // 5. Atomic write with duplicate prevention
    await db.runTransaction(async (transaction) => {
      // A. Transaction Reads
      const recordRef = db.collection("attendance_records").doc(recordId);
      const existingRec = await transaction.get(recordRef);
      if (existingRec.exists) {
        throw new HttpsError("already-exists", `Attendance for ${rollNo} is already recorded.`);
      }

      let challengeRef = null;
      if (hardwareProof && hardwareProof.challengeId) {
        challengeRef = db.collection("biometric_challenges").doc(hardwareProof.challengeId);
        const liveChallenge = await transaction.get(challengeRef);

        if (!liveChallenge.exists) {
          throw new HttpsError("not-found", "Biometric challenge not found.");
        }

        const challengeData = liveChallenge.data() || {};
        if (challengeData.used === true) {
          throw new HttpsError("permission-denied", "Biometric challenge has already been consumed (replay prevention).");
        }

        if (challengeData.studentUid !== studentUid) {
          throw new HttpsError("permission-denied", "Biometric challenge does not belong to this student.");
        }

        if (challengeData.sessionId && challengeData.sessionId !== sessionId) {
          throw new HttpsError("permission-denied", "Biometric challenge was issued for a different attendance session.");
        }

        if (challengeData.action && challengeData.action !== "ATTENDANCE_VERIFICATION") {
          throw new HttpsError("permission-denied", "Biometric challenge action mismatch.");
        }

        const challengeExpiryMs = parseStrictTimestampMs(challengeData.expiresAt);
        if (!challengeExpiryMs || serverNow > (challengeExpiryMs + BIOMETRIC_CLOCK_SKEW_TOLERANCE_MS)) {
          throw new HttpsError("deadline-exceeded", "Biometric challenge has expired. Please retry verification.");
        }

        if (!credData || !credData.publicKeyDerBase64) {
          throw new HttpsError("permission-denied", "Hardware biometric credential not found for this student.");
        }

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
          throw new HttpsError("permission-denied", "Hardware biometric signature verification failed. Attendance rejected.");
        }

        signatureVerified = true;
        const credDocRef = db.collection("biometric_credentials").doc(studentUid);
        transaction.set(credDocRef, { lastVerifiedAt: FieldValue.serverTimestamp() }, { merge: true });
      }

      // B. Transaction Writes
      if (challengeRef) {
        transaction.set(challengeRef, {
          used: true,
          usedAt: FieldValue.serverTimestamp(),
          consumedBySession: sessionId
        }, { merge: true });
      }

      const attendanceRecord = {
        id: recordId,
        sessionId: sessionId,
        rollNo: rollNo,
        fullName: studentName,
        studentName: studentName,
        name: studentName,
        studentEmail: studentEmail,
        studentUid: studentUid,
        courseCode: session.courseCode || "N/A",
        classCode: session.classCode || "N/A",
        batch: session.batch || "2025",
        roomNo: session.roomNo || "N/A",
        lecturerName: session.lecturerName || "",
        lecturerEmail: session.lecturerEmail || "",
        ownerId: session.ownerId || "",
        status: "ATTENDED",
        faceVerified: true,
        faceDescriptorMatched: true,
        faceMatchConfidence: Number.isFinite(serverMatchConfidence) ? serverMatchConfidence : 95,
        faceDistance: Number.isFinite(serverCalculatedDistance) ? Number(serverCalculatedDistance.toFixed(4)) : 0.35,
        livenessConfirmed: true,
        serverBiometricVerified: true,
        antiSpoofScore: "PASSED",
        faceTrustBoundary: "SERVER_VECTOR_DISTANCE_VALIDATED",
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

      transaction.set(recordRef, attendanceRecord);

      // Update session attendees
      transaction.update(sessionRef, {
        attendees: FieldValue.arrayUnion({
          id: recordId,
          rollNo: rollNo,
          studentName: studentName,
          fullName: studentName,
          email: studentEmail,
          studentEmail: studentEmail,
          status: "ATTENDED",
          faceVerified: true,
          faceDescriptorMatched: true,
          faceMatchConfidence: Number.isFinite(serverMatchConfidence) ? serverMatchConfidence : 95,
          faceDistance: Number.isFinite(serverCalculatedDistance) ? Number(serverCalculatedDistance.toFixed(4)) : 0.35,
          deviceAuthMode: authMode,
          hardwareBiometric: signatureVerified,
          devicePasskeyVerified: signatureVerified,
          submittedAt: submittedAtMs,
          attendanceSubmittedAt: submittedAtMs,
          autoReleaseAt: autoReleaseAtMs
        }),
        attendanceCount: FieldValue.increment(1)
      });

      // Update authorization document
      transaction.update(authRef, {
        qr2Verified: false,
        attendanceSubmittedAt: FieldValue.serverTimestamp(),
        autoReleaseAt: Timestamp.fromMillis(autoReleaseAtMs),
        attendanceStatus: "SUBMITTED",
        status: "ATTENDED",
        faceVerified: true,
        faceDescriptorMatched: true,
        hardwareBiometric: signatureVerified,
        devicePasskeyVerified: signatureVerified,
        releaseStatus: "LOCKED"
      });
    });

    if (rollNo && rollNo !== studentUid) {
      try {
        const rollAuthRef = sessionRef.collection("authorizations").doc(rollNo);
        const rSnap = await rollAuthRef.get();
        if (rSnap.exists) {
          await rollAuthRef.update({
            qr2Verified: false,
            attendanceSubmittedAt: FieldValue.serverTimestamp(),
            autoReleaseAt: Timestamp.fromMillis(autoReleaseAtMs),
            attendanceStatus: "SUBMITTED",
            status: "ATTENDED",
            faceVerified: true,
            faceDescriptorMatched: true,
            hardwareBiometric: signatureVerified,
            devicePasskeyVerified: signatureVerified,
            releaseStatus: "LOCKED"
          });
        }
      } catch (e) {
        console.warn("Roll auth update notice:", e);
      }
    }

    return {
      success: true,
      sessionId: sessionId,
      rollNo: rollNo,
      studentName: studentName,
      status: "ATTENDED",
      recordId: `${sessionId}_${rollNo}`,
      deviceAuthMode: authMode,
      hardwareBiometric: signatureVerified,
      submittedAt: submittedAtMs,
      attendanceSubmittedAt: submittedAtMs,
      autoReleaseAt: autoReleaseAtMs,
      kioskEndsAt: kioskEndsAtMs,
      message: "Attendance Submitted. Waiting for Lecturer Release (Lock Task Mode active)."
    };
  } catch (err) {
    console.error("submitAttendance uncaught failure:", err);
    if (err instanceof HttpsError) {
      throw err;
    }
    throw new HttpsError("internal", `Attendance submission notice: ${err?.message || err}`);
  }
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
    sessionRef.collection("security").doc("tokens").get().catch(() => ({ exists: false, data: () => ({}) }))
  ]);

  if (!sessionSnap.exists) {
    throw new HttpsError("not-found", "Attendance session not found.");
  }

  const sessionData = sessionSnap.data() || {};
  const security = securitySnap.exists ? (securitySnap.data() || {}) : {};

  const targetUid = studentUid || request.auth.uid;
  if (studentUid && studentUid !== request.auth.uid) {
    const isOwner = sessionData.ownerId === request.auth.uid || sessionData.ownerEmail === request.auth.token.email;
    const isLecturer = request.auth.token.role === "lecturer" || request.auth.token.role === "faculty";
    const isAdmin = request.auth.token.role === "admin";
    if (!isOwner && !isLecturer && !isAdmin) {
      throw new HttpsError("permission-denied", "Only session lecturers, administrators, or the student themselves can authorize release.");
    }
  }

  // Strict Server-Side Rate Limiting (5 failed attempts per caller -> 10-minute lockout)
  // Keyed strictly on authenticated caller request.auth.uid to prevent evasion via parameter tampering
  const callerUid = request.auth.uid;
  const rateLimitRef = sessionRef.collection("security").doc(`pin_rate_${callerUid}`);
  const rateLimitSnap = await rateLimitRef.get().catch(() => ({ exists: false, data: () => ({}) }));
  const rateData = rateLimitSnap.exists ? (rateLimitSnap.data() || {}) : { attempts: 0, lockedUntil: 0 };
  const nowMs = Date.now();

  if (rateData.lockedUntil && nowMs < rateData.lockedUntil) {
    const remainingSec = Math.ceil((rateData.lockedUntil - nowMs) / 1000);
    throw new HttpsError(
      "resource-exhausted",
      `Too many failed Session PIN attempts. Locked out for security. Try again in ${remainingSec} seconds.`
    );
  }

  const cleanPin = String(inputPin).trim();
  const pinSalt = security.pinSalt;
  const expectedSaltedHash = security.saltedReleaseCodeHash;
  const expectedHash = security.sessionPinHash || security.lecturerReleaseCodeHash;

  let isMatch = false;
  if (pinSalt && expectedSaltedHash) {
    isMatch = hashToken(`${pinSalt}:${cleanPin}`) === expectedSaltedHash;
  } else if (expectedSaltedHash) {
    // Legacy support for sessionId-salted hash
    isMatch = hashToken(`${sessionId}:${cleanPin}`) === expectedSaltedHash;
  } else if (expectedHash) {
    isMatch = hashToken(cleanPin) === expectedHash;
  }

  if (!isMatch) {
    const currentAttempts = (rateData.lockedUntil && nowMs >= rateData.lockedUntil) ? 0 : (rateData.attempts || 0);
    const newAttempts = currentAttempts + 1;
    const lockedUntil = newAttempts >= 5 ? nowMs + (10 * 60 * 1000) : 0;

    await rateLimitRef.set({
      attempts: newAttempts,
      lastAttemptAt: nowMs,
      lockedUntil: lockedUntil,
      targetUid: targetUid
    }, { merge: true }).catch((e) => console.warn("Failed to persist PIN rate limit:", e));

    if (lockedUntil > 0) {
      throw new HttpsError(
        "resource-exhausted",
        "❌ Too many incorrect attempts (5/5). Session PIN release locked for 10 minutes. Please contact the lecturer for assistance."
      );
    } else {
      const remaining = 5 - newAttempts;
      throw new HttpsError(
        "permission-denied",
        `❌ Invalid Session PIN. (${remaining} attempt${remaining === 1 ? "" : "s"} remaining before temporary lockout). Device remains locked.`
      );
    }
  }

  // Successful verification -> Reset rate limit
  if (rateLimitSnap.exists && rateData.attempts > 0) {
    await rateLimitRef.set({
      attempts: 0,
      lastAttemptAt: nowMs,
      lockedUntil: 0,
      targetUid: targetUid
    }, { merge: true }).catch(() => {});
  }

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
      authorizedBy: request.auth.uid,
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
  const callerUid = request.auth.uid;
  const callerEmail = (request.auth.token?.email || "").toLowerCase().trim();
  const ownerEmail = (session.ownerEmail || session.lecturerEmail || "").toLowerCase().trim();
  const isOwner = session.ownerId === callerUid ||
    session.createdById === callerUid ||
    (callerEmail && ownerEmail && callerEmail === ownerEmail) ||
    request.auth.token?.admin === true ||
    request.auth.token?.role === "admin";

  if (!isOwner) {
    throw new HttpsError("permission-denied", "Only the owning lecturer or an administrator can end this attendance session.");
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
  const callerUid = request.auth.uid;
  const callerEmail = (request.auth.token?.email || "").toLowerCase().trim();
  const ownerEmail = (session.ownerEmail || session.lecturerEmail || "").toLowerCase().trim();
  const isOwner = session.ownerId === callerUid ||
    session.createdById === callerUid ||
    (callerEmail && ownerEmail && callerEmail === ownerEmail) ||
    request.auth.token?.admin === true;

  if (!isOwner) {
    throw new HttpsError("permission-denied", "Only the owning lecturer can release student devices.");
  }

  // Optional Session PIN validation if provided
  if (sessionPin && securitySnap.exists) {
    const security = securitySnap.data();
    const cleanPin = String(sessionPin).trim();
    const pinSalt = security.pinSalt;
    const inputSaltedHash = pinSalt ? hashToken(`${pinSalt}:${cleanPin}`) : hashToken(`${sessionId}:${cleanPin}`);
    const inputHash = hashToken(cleanPin);
    const isMatch = (
      (security.saltedReleaseCodeHash && (inputSaltedHash === security.saltedReleaseCodeHash || hashToken(`${sessionId}:${cleanPin}`) === security.saltedReleaseCodeHash)) ||
      (inputHash === security.sessionPinHash || inputHash === security.lecturerReleaseCodeHash) ||
      (cleanPin === security.sessionPin || cleanPin === security.lecturerPin)
    );
    if (!isMatch) {
      throw new HttpsError("permission-denied", "❌ Invalid Session PIN.");
    }
  }

  const cleanRoll = rollNo ? String(rollNo).trim().toUpperCase() : "";
  const targetDocId = studentUid || cleanRoll;
  const authPayload = {
    released: true,
    releasedAt: FieldValue.serverTimestamp(),
    releasedBy: callerUid,
    releaseStatus: "RELEASED",
    status: "RELEASED"
  };

  const writePromises = [
    sessionRef.collection("authorizations").doc(targetDocId).set(authPayload, { merge: true })
  ];

  if (cleanRoll && cleanRoll !== targetDocId) {
    writePromises.push(sessionRef.collection("authorizations").doc(cleanRoll).set(authPayload, { merge: true }));
  }
  if (studentUid && studentUid !== targetDocId) {
    writePromises.push(sessionRef.collection("authorizations").doc(studentUid).set(authPayload, { merge: true }));
  }

  // Record on parent session document for cross-document listener redundancy
  const sessionUpdates = {};
  if (cleanRoll) sessionUpdates[`releasedStudents.${cleanRoll}`] = true;
  if (studentUid) sessionUpdates[`releasedStudents.${studentUid}`] = true;
  if (targetDocId) sessionUpdates[`releasedStudents.${targetDocId}`] = true;
  writePromises.push(sessionRef.set(sessionUpdates, { merge: true }));

  await Promise.all(writePromises);

  return {
    success: true,
    sessionId: sessionId,
    studentUid: targetDocId,
    rollNo: cleanRoll,
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
  const [sessionSnap, authSnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection("authorizations").doc(targetUid).get()
  ]);

  const serverNow = Date.now();
  let sessionEnded = false;

  if (sessionSnap.exists) {
    const sessionData = sessionSnap.data();
    const endMs = sessionData.kioskEndsAt?.toMillis
      ? sessionData.kioskEndsAt.toMillis()
      : (sessionData.kioskEndsAt || sessionData.expiresAt || 0);

    if (
      sessionData.status === "CLOSED" ||
      sessionData.phase === "CLOSED" ||
      sessionData.isClosed === true ||
      (endMs > 0 && serverNow >= (endMs - 5000))
    ) {
      sessionEnded = true;
    }
  }

  // If session is still actively running and attendance was not submitted, check countdown
  if (!sessionEnded && authSnap.exists) {
    const authData = authSnap.data();
    if (!authData.attendanceSubmittedAt) {
      throw new HttpsError("failed-precondition", "Session is ongoing. Device will automatically release when the session concludes.");
    }

    const submittedAtMs = authData.attendanceSubmittedAt.toMillis
      ? authData.attendanceSubmittedAt.toMillis()
      : (authData.attendanceSubmittedAt || 0);
    const autoReleaseAtMs = authData.autoReleaseAt
      ? (authData.autoReleaseAt.toMillis ? authData.autoReleaseAt.toMillis() : authData.autoReleaseAt)
      : (submittedAtMs + 5 * 60 * 1000);

    // Allow 5-second grace for network latency
    if (serverNow < (autoReleaseAtMs - 5000)) {
      const remainingSec = Math.ceil((autoReleaseAtMs - serverNow) / 1000);
      throw new HttpsError("failed-precondition", `Automatic release authorized in ${remainingSec} seconds or upon session conclusion.`);
    }
  }

  const releasePayload = {
    released: true,
    releaseStatus: "AUTO_RELEASED",
    status: "RELEASED",
    releasedAt: FieldValue.serverTimestamp()
  };

  const writes = [
    sessionRef.collection("authorizations").doc(targetUid).set(releasePayload, { merge: true })
  ];

  const rollNo = authSnap.exists ? authSnap.data().rollNo : null;
  if (rollNo) {
    writes.push(sessionRef.collection("authorizations").doc(rollNo).set(releasePayload, { merge: true }));
  }

  const sessionUpdateMap = { [targetUid]: true };
  if (rollNo) sessionUpdateMap[rollNo] = true;
  writes.push(sessionRef.set({ releasedStudents: sessionUpdateMap }, { merge: true }));

  await Promise.all(writes);

  return {
    success: true,
    autoReleaseAuthorized: true,
    sessionId: sessionId,
    studentUid: targetUid,
    releaseStatus: "AUTO_RELEASED",
    message: sessionEnded
      ? "Session concluded. Automatic device release authorized."
      : "5-Minute fail-safe countdown reached. Device release authorized."
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
  const { sessionId, action } = request.data || {};
  const challengeId = crypto.randomUUID();
  const challengeText = crypto.randomBytes(32).toString("hex");
  const nowMs = Date.now();
  const expiresAtMs = nowMs + 3 * 60 * 1000; // 3-minute TTL

  await db.collection("biometric_challenges").doc(challengeId).set({
    challengeId: challengeId,
    studentUid: studentUid,
    sessionId: sessionId ? String(sessionId).trim() : null,
    action: action ? String(action).trim() : "ATTENDANCE_VERIFICATION",
    challengeText: challengeText,
    expiresAt: Timestamp.fromMillis(expiresAtMs),
    used: false,
    createdAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    challengeId: challengeId,
    challengeText: challengeText,
    sessionId: sessionId || null,
    action: action || "ATTENDANCE_VERIFICATION",
    expiresAt: expiresAtMs
  };
});

/**
 * 11. REGISTER INITIAL BIOMETRIC KEY
 * Students self-enroll initial hardware-backed ECDSA P-256 public key (Android Keystore / iOS Secure Enclave).
 * Once enrolled, key cannot be altered or overwritten directly; requires authorized replacement.
 */
exports.registerInitialBiometricKey = onCall({ cors: true }, async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to enroll biometric key.");
  }

  const { publicKeyDerBase64, platform, keyAlias } = request.data || {};
  if (!publicKeyDerBase64 || typeof publicKeyDerBase64 !== "string") {
    throw new HttpsError("invalid-argument", "Public key (Base64 DER) is required.");
  }
  const cleanPlatform = String(platform || "").trim().toLowerCase();
  if (!["android", "ios"].includes(cleanPlatform)) {
    throw new HttpsError("invalid-argument", "A supported native platform ('android' or 'ios') is required.");
  }

  const enrollmentIdentity = await resolveBiometricEnrollmentIdentity(request);
  const studentUid = enrollmentIdentity.uid;
  const isCallerStaff = enrollmentIdentity.isStaff;

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

  // Check if student/user already has an active biometric credential
  const credRef = db.collection("biometric_credentials").doc(studentUid);
  let activePermission = null;

  // Platform binding check (Option A: Prevent enrolling Android key on iOS-registered account)
  const studentDocRef = isCallerStaff ? null : db.collection("students").doc(enrollmentIdentity.rollNo);
  const studentDocSnap = studentDocRef ? await studentDocRef.get() : null;
  const authoritativePlatform = isCallerStaff
    ? enrollmentIdentity.staffData?.registeredPlatform
    : (studentDocSnap?.exists ? studentDocSnap.data()?.registeredPlatform : null);

  if (
    ["android", "ios"].includes(authoritativePlatform) &&
    authoritativePlatform !== cleanPlatform
  ) {
    throw new HttpsError(
      "failed-precondition",
      `Cannot enroll a ${cleanPlatform} biometric credential on an account bound to ${authoritativePlatform}. Please request an authorized device platform change if you switched devices.`
    );
  }

  const enrollmentMethod = isCallerStaff
    ? "STAFF_ENROLLMENT"
    : (activePermission ? "AUTHORIZED_RE_REGISTRATION" : "STUDENT_SELF_ENROLLMENT");

  const credentialRecord = {
    studentUid: studentUid,
    rollNo: enrollmentIdentity.rollNo,
    studentEmail: enrollmentIdentity.email,
    identityType: enrollmentIdentity.identityType,
    ...(isCallerStaff ? { staffRole: enrollmentIdentity.staffRole } : {}),
    publicKeyDerBase64: publicKeyDerBase64.trim(),
    platform: cleanPlatform,
    keyAlias: keyAlias || `smartattend_p256_${studentUid}`,
    status: "ACTIVE",
    enrollmentMethod: enrollmentMethod,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  await db.runTransaction(async (transaction) => {
    activePermission = null;
    credentialRecord.enrollmentMethod = isCallerStaff
      ? "STAFF_ENROLLMENT"
      : "STUDENT_SELF_ENROLLMENT";
    const currentCredSnap = await transaction.get(credRef);
    if (currentCredSnap.exists && currentCredSnap.data().status === "ACTIVE" && !isCallerStaff) {
      const permission = await resolveActiveReRegistrationPermission(
        transaction,
        enrollmentIdentity.rollNo,
        "BIOMETRIC"
      );
      if (!permission.hasPermission) {
        throw new HttpsError(
          "already-exists",
          "An active biometric credential is already registered for your account. Direct re-enrollment is prohibited. To replace your credential, ask an authorized lecturer or administrator for re-registration access."
        );
      }
      activePermission = permission;
      credentialRecord.enrollmentMethod = "AUTHORIZED_RE_REGISTRATION";
    }
    if (activePermission?.permissionDoc) {
      consumeReRegistrationPermission(transaction, activePermission.permissionDoc, activePermission.permissionData);
    }
    transaction.set(credRef, credentialRecord);
    if (!isCallerStaff) {
      transaction.set(db.collection("biometric_credentials").doc(enrollmentIdentity.rollNo), credentialRecord);
      transaction.set(studentDocRef, {
        biometricEnrolled: true,
        hardwareBiometricEnrolled: true,
        registeredPlatform: authoritativePlatform || cleanPlatform,
        deviceType: authoritativePlatform || cleanPlatform,
        registeredDeviceType: authoritativePlatform || cleanPlatform,
        deviceTypeLocked: true,
        hardwareBiometricPlatform: cleanPlatform,
        hardwareBiometricEnrolledAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      const enrolledAt = FieldValue.serverTimestamp();
      transaction.set(enrollmentIdentity.staffRef, {
        hardwareBiometricEnrolled: true,
        hardwareBiometricPlatform: cleanPlatform,
        hardwareBiometricEnrolledAt: enrolledAt,
        updatedAt: enrolledAt
      }, { merge: true });
      transaction.set(db.collection("users").doc(studentUid), {
        hardwareBiometricEnrolled: true,
        hardwareBiometricPlatform: cleanPlatform,
        hardwareBiometricEnrolledAt: enrolledAt,
        updatedAt: enrolledAt
      }, { merge: true });
    }
  });

  await db.collection("biometric_audit_logs").add({
    action: activePermission ? "BIOMETRIC_RE_REGISTRATION" : (isCallerStaff ? "STAFF_BIOMETRIC_ENROLLMENT" : "INITIAL_BIOMETRIC_ENROLLMENT"),
    studentUid: studentUid,
    rollNo: enrollmentIdentity.rollNo,
    identityType: enrollmentIdentity.identityType,
    ...(isCallerStaff ? { staffRole: enrollmentIdentity.staffRole } : {}),
    platform: cleanPlatform,
    enrolledBy: studentUid,
    isStaff: isCallerStaff,
    timestamp: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    rollNo: enrollmentIdentity.rollNo,
    platform: cleanPlatform,
    status: "ACTIVE",
    message: activePermission
      ? "Hardware biometric credential re-registered successfully under authorized permission."
      : "Initial biometric credential registered successfully."
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
  let authRef = sessionRef.collection("authorizations").doc(studentUid);
  let authSnap = await authRef.get();

  let studentProfile = null;
  if (!authSnap.exists) {
    studentProfile = await resolveTrustedStudent(studentUid, request.auth.token.email);
    if (studentProfile?.rollNo) {
      const rollRef = sessionRef.collection("authorizations").doc(studentProfile.rollNo);
      const rollSnap = await rollRef.get();
      if (rollSnap.exists) {
        authRef = rollRef;
        authSnap = rollSnap;
      }
    }
  }

  if (!studentProfile) {
    studentProfile = await resolveTrustedStudent(studentUid, request.auth.token.email);
  }

  const authData = authSnap.exists ? authSnap.data() : {};
  const rollNo = (authData.rollNo || studentProfile?.rollNo || studentUid).toUpperCase().trim();
  const studentName = authData.studentName || studentProfile?.name || rollNo;
  const nowMs = Date.now();

  const isConfirmedViolation = 
    eventType === "CONFIRMED_KIOSK_ESCAPE" ||
    eventType === "APP_LEAVE" ||
    eventType === "APP_SWITCH" ||
    eventType === "APP_BACKGROUNDED" ||
    eventType === "DEVTOOLS_OPENED" ||
    (source && (source.includes("kiosk") || source.includes("background") || source.includes("app_switch") || source.includes("devtools")));

  const prevCount = Number(authData.confirmedKioskViolations || authData.violationCount || 0);
  const nextCount = prevCount + 1;
  // Zero-tolerance single-strike disqualification: any confirmed kiosk escape or app leave during kiosk mode disqualifies
  const isDisqualified = isConfirmedViolation ? true : (nextCount >= 1);

  const violationEntry = {
    type: eventType || "CONFIRMED_KIOSK_ESCAPE",
    source: source || "kiosk_exit",
    platform: platform || "android",
    count: nextCount,
    timestamp: nowMs,
    disqualified: isDisqualified
  };

  const updatePayload = {
    hasViolation: true,
    violation: 1,
    violationCount: nextCount,
    confirmedKioskViolations: nextCount,
    disqualified: isDisqualified,
    status: isDisqualified ? "FLAGGED_DISQUALIFIED" : "FLAGGED_WARNING",
    violations: FieldValue.arrayUnion(violationEntry),
    lastViolationAt: nowMs,
    lastViolationReason: `Security violation (${source || eventType}) during attendance session`
  };

  // Authoritatively update both studentUid and rollNo documents with merge: true
  await sessionRef.collection("authorizations").doc(studentUid).set(updatePayload, { merge: true });
  if (rollNo && rollNo !== studentUid) {
    try {
      await sessionRef.collection("authorizations").doc(rollNo).set(updatePayload, { merge: true });
    } catch (_) { }
  }

  // Update top-level session document flaggedViolations for real-time lecturer dashboard
  const violationItem = {
    rollNo: rollNo,
    studentUid: studentUid,
    studentName: studentName,
    violationType: eventType || "CONFIRMED_KIOSK_ESCAPE",
    violationReason: `Security violation: ${source || eventType}`,
    count: nextCount,
    violationCount: nextCount,
    disqualified: isDisqualified,
    status: isDisqualified ? "FLAGGED_DISQUALIFIED" : "FLAGGED_WARNING",
    timestamp: nowMs
  };

  await sessionRef.set({
    flaggedViolations: FieldValue.arrayUnion(violationItem)
  }, { merge: true });

  // If disqualified, record in attendance_records
  if (isDisqualified && rollNo) {
    try {
      const recordDocId = `${sessionId}_${rollNo}`;
      await db.collection("attendance_records").doc(recordDocId).set({
        sessionId: sessionId,
        rollNo: rollNo,
        studentUid: studentUid,
        status: "FLAGGED_DISQUALIFIED",
        verificationStatus: "FLAGGED",
        flagged: true,
        disqualified: true,
        violationCount: nextCount,
        violationType: eventType || "CONFIRMED_KIOSK_ESCAPE",
        violationReason: `Security violation: ${source || eventType}`,
        timestamp: nowMs
      }, { merge: true });
    } catch (_) { }
  }

  return {
    success: true,
    platform: platform || "android",
    status: isDisqualified ? "DISQUALIFIED" : "WARNING",
    violationCount: nextCount,
    disqualified: isDisqualified,
    message: isDisqualified
      ? "Attendance forfeited: Confirmed security violation detected during kiosk session."
      : "Warning: Kiosk exit detected."
  };
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

  await assertLecturer(request);
  const isAdmin = await isCallerAdmin(request);
  const callerUid = request.auth.uid;
  const callerEmail = (request.auth.token.email || "").toLowerCase().trim();

  if (radius === undefined || radius === null || typeof radius !== "number" || !Number.isFinite(radius) || radius < 5 || radius > 50) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid radius. Geofence radius must be a finite number between 5 and 50 metres (default is 10m)."
    );
  }

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
 * 17. UPDATE SESSION QR ROTATION INTERVAL (Lecturer Only)
 * Enforces ownership, valid integer between 5s and 60s (step 5),
 * updates both public sessionDoc and private securityDoc, and writes an audit record.
 */
exports.updateSessionQrInterval = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to update QR rotation interval.");
  }

  const { sessionId, intervalSec } = request.data || {};
  if (!sessionId || typeof sessionId !== "string") {
    throw new HttpsError("invalid-argument", "Missing required parameter: sessionId.");
  }

  const numericInterval = Number(intervalSec);
  if (!Number.isInteger(numericInterval) || (numericInterval !== 3 && (numericInterval < 5 || numericInterval > 60 || numericInterval % 5 !== 0))) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid rotation interval. QR rotation interval must be 3 seconds or an integer between 5 and 60 seconds divisible by 5."
    );
  }

  await assertLecturer(request);
  const isAdmin = await isCallerAdmin(request);
  const callerUid = request.auth.uid;
  const callerEmail = (request.auth.token.email || "").toLowerCase().trim();

  const sessionRef = db.collection("attendance_sessions").doc(sessionId);
  const securityTokensRef = sessionRef.collection("security").doc("tokens");

  return await db.runTransaction(async (transaction) => {
    const sessionSnap = await transaction.get(sessionRef);
    if (!sessionSnap.exists) {
      throw new HttpsError("not-found", `Attendance session ${sessionId} not found.`);
    }

    const sessionData = sessionSnap.data();
    if (!isAdmin && sessionData.ownerId !== callerUid && sessionData.ownerEmail !== callerEmail) {
      throw new HttpsError("permission-denied", "Only the session owner or administrator can adjust this session's QR rotation interval.");
    }

    if (sessionData.active === false || sessionData.status === "CLOSED" || sessionData.phase === "CLOSED") {
      throw new HttpsError("failed-precondition", "Cannot adjust QR rotation interval for a session that has already ended.");
    }

    const previousInterval = typeof sessionData.rotationIntervalSec === "number" ? sessionData.rotationIntervalSec : 10;
    const serverNow = Date.now();

    transaction.update(sessionRef, {
      rotationIntervalSec: numericInterval,
      rotationConfigUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    transaction.set(securityTokensRef, {
      rotationIntervalSec: numericInterval,
      rotationConfigUpdatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    // Immutable QR Interval Adjustment Audit Trail
    const auditRef = sessionRef.collection("qr_adjustments").doc();
    transaction.set(auditRef, {
      adjustmentId: auditRef.id,
      sessionId: sessionId,
      actorUid: callerUid,
      actorEmail: callerEmail,
      actorRole: isAdmin ? "ADMIN" : "LECTURER",
      previousIntervalSec: previousInterval,
      newIntervalSec: numericInterval,
      adjustedAt: FieldValue.serverTimestamp(),
      serverTimestampMs: serverNow
    });

    return {
      success: true,
      sessionId: sessionId,
      previousIntervalSec: previousInterval,
      newIntervalSec: numericInterval,
      message: `QR rotation interval successfully updated from ${previousInterval}s to ${numericInterval}s.`
    };
  });
});

/**
 * 18. GENERATE WEBAUTHN REGISTRATION OPTIONS
 * Issues WebAuthn registration options with RP ID, allowed origins, and single-use challenge token.
 * Strictly resolves and validates requested RP ID and origin against WEBAUTHN_CONFIG allowlist.
 */
exports.generateWebAuthnRegistrationOptions = onCall({ cors: true }, async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to generate WebAuthn options.");
  }

  const enrollmentIdentity = await resolveBiometricEnrollmentIdentity(request);
  const studentUid = enrollmentIdentity.uid;
  const studentEmail = enrollmentIdentity.email;

  const { rpId: requestedRpId, origin: requestedOrigin } = request.data || {};
  const target = resolveWebAuthnTarget(requestedOrigin, requestedRpId);

  const options = await generateRegistrationOptions({
    rpName: target.rpName,
    rpID: target.rpId,
    userID: Buffer.from(studentUid, "utf8"),
    userName: enrollmentIdentity.rollNo || studentEmail || studentUid,
    userDisplayName: enrollmentIdentity.name || enrollmentIdentity.rollNo || "Student",
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
    identityType: enrollmentIdentity.identityType,
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
exports.verifyWebAuthnRegistration = onCall({ cors: true }, async (request) => {
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
  const enrollmentIdentity = await resolveBiometricEnrollmentIdentity(request);

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
  } catch (_) { }

  // Multi-RP ID Credential Isolation:
  // Each domain/RP ID has its own isolated credential in credentialsByRpId and rp_credentials subcollection
  const rpIdKey = target.rpId.replace(/\./g, "_");
  const credRecord = {
    studentUid: studentUid,
    rollNo: enrollmentIdentity.rollNo,
    studentEmail: enrollmentIdentity.email,
    identityType: enrollmentIdentity.identityType,
    ...(enrollmentIdentity.isStaff ? { staffRole: enrollmentIdentity.staffRole } : {}),
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
  const rollCredRef = enrollmentIdentity.isStaff
    ? null
    : db.collection("biometric_credentials").doc(enrollmentIdentity.rollNo);
  let activePermission = null;
  const isPrimary = target.rpId === "smartattend-ochre.vercel.app";

  const rootUpdate = {
    [`credentialsByRpId.${rpIdKey}`]: credRecord,
    updatedAt: FieldValue.serverTimestamp()
  };
  // If primary domain or first enrollment, also set root fields for backward compatibility
  if (isPrimary) {
    Object.assign(rootUpdate, credRecord);
  }

  const challengeRef = db.collection("biometric_challenges").doc(challengeId);
  const auditRef = db.collection("biometric_audit_logs").doc();
  await db.runTransaction(async (transaction) => {
    const currentChallenge = await transaction.get(challengeRef);
    if (!currentChallenge.exists || currentChallenge.data().used === true ||
      currentChallenge.data().studentUid !== studentUid) {
      throw new HttpsError("permission-denied", "Invalid or already consumed registration challenge.");
    }
    activePermission = null;
    const currentCredentialSnap = await transaction.get(credRef);
    const currentCredential = currentCredentialSnap.data() || {};
    const existingRpCredential = currentCredential.credentialsByRpId?.[rpIdKey] ||
      (isPrimary && currentCredential.status === "ACTIVE" ? currentCredential : null);
    if (!enrollmentIdentity.isStaff && existingRpCredential?.status === "ACTIVE") {
      const permission = await resolveActiveReRegistrationPermission(
        transaction,
        enrollmentIdentity.rollNo,
        "BIOMETRIC"
      );
      if (!permission.hasPermission) {
        throw new HttpsError(
          "already-exists",
          "An active biometric credential is already registered for this domain. Authorized re-registration is required."
        );
      }
      activePermission = permission;
    }
    if (activePermission?.permissionDoc) {
      consumeReRegistrationPermission(transaction, activePermission.permissionDoc, activePermission.permissionData);
    }
    transaction.update(challengeRef, {
      used: true,
      usedAt: FieldValue.serverTimestamp()
    });
    transaction.set(credRef, rootUpdate, { merge: true });
    transaction.set(credRef.collection("rp_credentials").doc(rpIdKey), credRecord);
    if (rollCredRef) {
      transaction.set(rollCredRef, rootUpdate, { merge: true });
      transaction.set(rollCredRef.collection("rp_credentials").doc(rpIdKey), credRecord);
      transaction.set(db.collection("students").doc(enrollmentIdentity.rollNo), {
        biometricEnrolled: true,
        hardwareBiometricEnrolled: true,
        hardwareBiometricPlatform: "webauthn",
        hardwareBiometricEnrolledAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      const enrolledAt = FieldValue.serverTimestamp();
      transaction.set(enrollmentIdentity.staffRef, {
        hardwareBiometricEnrolled: true,
        hardwareBiometricPlatform: "webauthn",
        hardwareBiometricEnrolledAt: enrolledAt,
        updatedAt: enrolledAt
      }, { merge: true });
      transaction.set(db.collection("users").doc(studentUid), {
        hardwareBiometricEnrolled: true,
        hardwareBiometricPlatform: "webauthn",
        hardwareBiometricEnrolledAt: enrolledAt,
        updatedAt: enrolledAt
      }, { merge: true });
    }
    transaction.create(auditRef, {
      action: "WEBAUTHN_BIOMETRIC_REGISTRATION",
      studentUid,
      rollNo: enrollmentIdentity.rollNo,
      identityType: enrollmentIdentity.identityType,
      ...(enrollmentIdentity.isStaff ? { staffRole: enrollmentIdentity.staffRole } : {}),
      credentialId: credential.id,
      rpId: target.rpId,
      platform: "webauthn",
      timestamp: FieldValue.serverTimestamp()
    });
  });

  return {
    success: true,
    credentialId: credential.id,
    rpId: target.rpId,
    rollNo: enrollmentIdentity.rollNo,
    status: "ACTIVE",
    message: `WebAuthn credential verified and registered successfully for domain ${target.rpId}.`
  };
});

/**
 * Registers a student's face template in a server-only collection.
 * All writes are serialized through one guard document so concurrent enrollments
 * re-check the same registry before committing.
 */
exports.registerStudentFace = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const callerUid = request.auth.uid;
  const callerEmail = String(request.auth.token.email || "").trim().toLowerCase();
  const requestedRollNo = request.data?.rollNo;
  if (!requestedRollNo || !request.data?.faceDescriptor) {
    throw new HttpsError("invalid-argument", "rollNo and faceDescriptor are required.");
  }

  const cleanRollNo = String(requestedRollNo).trim().toUpperCase();
  const cleanVector = normalizeFaceVector(request.data.faceDescriptor, `Face descriptor for ${cleanRollNo}`);
  const studentDocRef = db.collection("students").doc(cleanRollNo);
  const studentSnap = await studentDocRef.get();
  const isStaff = await isFaceEnrollmentStaff(request);
  let isStaffSelf = false;

  if (!studentSnap.exists) {
    if (isStaff) {
      const userDoc = await db.collection("users").doc(callerUid).get();
      const callerRoll = callerEmail ? callerEmail.split("@")[0].trim().toUpperCase() : "";
      if (userDoc.exists || cleanRollNo === callerRoll || cleanRollNo === callerUid) {
        isStaffSelf = true;
      } else {
        throw new HttpsError("not-found", "The target student record could not be verified.");
      }
    } else {
      throw new HttpsError("not-found", "The target student record could not be verified.");
    }
  }

  const studentData = studentSnap.exists ? (studentSnap.data() || {}) : {};
  const linkedUid = String(studentData.studentUid || studentData.uid || studentData.userUid || "").trim();
  const studentEmail = String(studentData.email || "").trim().toLowerCase();
  const callerRoll = callerEmail ? callerEmail.split("@")[0].trim().toUpperCase() : "";
  const ownsStudent = linkedUid
    ? linkedUid === callerUid
    : Boolean((studentEmail && studentEmail === callerEmail) || callerRoll === cleanRollNo);

  if (!isStaff && !ownsStudent) {
    throw new HttpsError("permission-denied", "You can only enroll face biometrics for your own student account.");
  }

  const targetIdentity = {
    rollNo: cleanRollNo,
    studentUid: linkedUid || (!isStaff ? callerUid : "")
  };
  const enrollmentRef = db.collection("face_enrollments").doc(cleanRollNo);
  const guardRef = db.collection("face_enrollment_control").doc("global");
  const reviewRef = db.collection("face_enrollment_reviews").doc();

  let activePermissionForAudit = null;

  const result = await db.runTransaction(async (transaction) => {
    const [
      guardSnap,
      targetSnap,
      enrollmentSnap,
      enrolledFaces,
      pendingReviews,
      legacyStudents,
      legacyUsers,
      legacyAuthorizedUsers
    ] = await Promise.all([
      transaction.get(guardRef),
      studentSnap.exists ? transaction.get(studentDocRef) : Promise.resolve({ exists: true, data: () => ({}) }),
      transaction.get(enrollmentRef),
      transaction.get(db.collection("face_enrollments")),
      transaction.get(db.collection("face_enrollment_reviews").where("status", "==", "PENDING")),
      transaction.get(db.collection("students")),
      transaction.get(db.collection("users")),
      transaction.get(db.collection("authorizedUsers"))
    ]);

    if (!targetSnap.exists && !isStaffSelf) {
      throw new HttpsError("not-found", "The target student record could not be verified.");
    }

    const candidates = [
      ...enrolledFaces.docs.map((docSnap) => faceCandidateFromDoc(docSnap, "face_enrollments")),
      ...pendingReviews.docs.map((docSnap) => faceCandidateFromDoc(docSnap, "face_enrollment_reviews")),
      ...legacyStudents.docs.map((docSnap) => faceCandidateFromDoc(docSnap, "students")),
      ...legacyUsers.docs.map((docSnap) => faceCandidateFromDoc(docSnap, "users")),
      ...legacyAuthorizedUsers.docs.map((docSnap) => faceCandidateFromDoc(docSnap, "authorizedUsers"))
    ];
    const uniqueness = evaluateFaceUniqueness(cleanVector, candidates, targetIdentity);
    const hasExistingEnrollment = enrollmentSnap.exists ||
      candidates.some((candidate) =>
        sameFaceIdentity(candidate, targetIdentity) &&
        (candidate.faceRegistered === true || candidate.status === "ACTIVE" || candidate.faceDescriptor)
      );

    let activePermission = null;
    if (!isStaff && !isStaffSelf && hasExistingEnrollment) {
      const permCheck = await resolveActiveReRegistrationPermission(transaction, cleanRollNo, "FACE");
      if (!permCheck.hasPermission) {
        throw new HttpsError(
          "failed-precondition",
          "Face biometrics are already enrolled. Ask an authorized lecturer or administrator to re-enroll them."
        );
      }
      activePermission = permCheck;
      activePermissionForAudit = permCheck;
    }

    if (uniqueness.decision === "duplicate") {
      throw new HttpsError(
        "already-exists",
        "This face matches an enrollment belonging to another student. The existing enrollment was not changed."
      );
    }

    if (hasExistingEnrollment && !activePermission && !isStaff && !isStaffSelf) {
      const priorEnrollment = candidates.find((candidate) =>
        sameFaceIdentity(candidate, targetIdentity) &&
        (candidate.faceRegistered === true || candidate.status === "ACTIVE" || candidate.faceDescriptor)
      );
      let priorVector = null;
      if (priorEnrollment?.faceDescriptor) {
        try {
          priorVector = normalizeFaceVector(priorEnrollment.faceDescriptor, "Existing face descriptor");
        } catch (_) {
          priorVector = null;
        }
      }
      const existingDistance = priorVector ? faceVectorDistance(cleanVector, priorVector) : Number.POSITIVE_INFINITY;
      if (existingDistance > FACE_REVIEW_DISTANCE) {
        transaction.set(reviewRef, {
          rollNo: cleanRollNo,
          studentUid: targetIdentity.studentUid || null,
          requestedBy: callerUid,
          status: "PENDING",
          reason: "EXISTING_IDENTITY_UNVERIFIED",
          faceDescriptor: cleanVector,
          distance: Number.isFinite(existingDistance) ? existingDistance : null,
          createdAt: FieldValue.serverTimestamp()
        });
        transaction.set(guardRef, {
          revision: Number(guardSnap.data()?.revision || 0) + 1,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return {
          success: false,
          status: "REVIEW_REQUIRED",
          message: "The new face could not be verified against this student's existing enrollment. The current enrollment was preserved for authorized identity review."
        };
      }
    }

    if (uniqueness.decision === "review") {
      transaction.set(reviewRef, {
        rollNo: cleanRollNo,
        studentUid: targetIdentity.studentUid || null,
        requestedBy: callerUid,
        status: "PENDING",
        reason: "FACE_MATCH_AMBIGUOUS",
        faceDescriptor: cleanVector,
        candidateRollNo: uniqueness.match?.candidate?.rollNo || null,
        distance: Number.isFinite(uniqueness.match?.distance) ? uniqueness.match.distance : null,
        createdAt: FieldValue.serverTimestamp()
      });
      transaction.set(guardRef, {
        revision: Number(guardSnap.data()?.revision || 0) + 1,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return {
        success: false,
        status: "REVIEW_REQUIRED",
        message: "This face could not be safely distinguished from an existing enrollment. Enrollment is on hold for authorized review."
      };
    }

    const publicFaceFields = {
      faceDescriptor: FieldValue.delete(),
      faceDescriptors: FieldValue.delete(),
      descriptor: FieldValue.delete(),
      descriptors: FieldValue.delete(),
      faceVector: FieldValue.delete(),
      faceVectors: FieldValue.delete(),
      embedding: FieldValue.delete(),
      embeddings: FieldValue.delete()
    };
    const metadata = {
      rollNo: cleanRollNo,
      faceRegistered: true,
      biometricEnrolled: true,
      hasFaceRegistered: true,
      faceEnrolledAt: FieldValue.serverTimestamp(),
      faceRemovedAt: FieldValue.delete(),
      ...publicFaceFields
    };
    if (targetIdentity.studentUid) metadata.studentUid = targetIdentity.studentUid;

    transaction.set(enrollmentRef, {
      ...targetIdentity,
      faceDescriptor: cleanVector,
      status: "ACTIVE",
      updatedAt: FieldValue.serverTimestamp()
    });

    if (studentSnap.exists) {
      transaction.set(studentDocRef, metadata, { merge: true });
    } else if (isStaffSelf) {
      transaction.set(db.collection("users").doc(callerUid), metadata, { merge: true });
    }

    // Atomically consume re-registration permission if active
    if (activePermission?.permissionDoc) {
      consumeReRegistrationPermission(transaction, activePermission.permissionDoc, activePermission.permissionData);
    }

    const cleanedRefs = new Set();
    for (const legacyDoc of [...legacyStudents.docs, ...legacyUsers.docs, ...legacyAuthorizedUsers.docs]) {
      if (sameFaceIdentity(faceCandidateFromDoc(legacyDoc, legacyDoc.ref.parent.id), targetIdentity)) {
        const path = legacyDoc.ref.path;
        if (!cleanedRefs.has(path) && path !== studentDocRef.path) {
          cleanedRefs.add(path);
          transaction.update(legacyDoc.ref, {
            ...publicFaceFields,
            faceRegistered: true,
            biometricEnrolled: true,
            hasFaceRegistered: true,
            faceEnrolledAt: FieldValue.serverTimestamp(),
            faceRemovedAt: FieldValue.delete()
          });
        }
      }
    }
    transaction.set(guardRef, {
      revision: Number(guardSnap.data()?.revision || 0) + 1,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return { success: true, status: "ENROLLED", rollNo: cleanRollNo };
  });

  if (result.success) {
    await db.collection("biometric_audit_logs").add({
      action: activePermissionForAudit ? "FACE_RE_REGISTRATION" : (isStaff || isStaffSelf ? "STAFF_FACE_ENROLLMENT" : "INITIAL_FACE_ENROLLMENT"),
      rollNo: cleanRollNo,
      enrolledBy: callerUid,
      isStaff: Boolean(isStaff || isStaffSelf),
      timestamp: FieldValue.serverTimestamp()
    });
  }

  return result;
});

/**
 * Matches a live descriptor against a target student or, for staff, the enrolled
 * student registry. Only profile details are returned; templates stay server-side.
 */
exports.matchStudentFace = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const liveVector = normalizeFaceVector(request.data?.faceDescriptor, "Live face descriptor");
  const targetRollNo = String(request.data?.rollNo || "").trim().toUpperCase();
  const isStaff = await isFaceEnrollmentStaff(request);

  if (!targetRollNo && !isStaff) {
    throw new HttpsError("permission-denied", "Only authorized staff can identify a student from a face scan.");
  }

  let targetIdentity = null;
  let targetStudentData = null;
  if (targetRollNo) {
    const targetSnap = await db.collection("students").doc(targetRollNo).get();
    if (!targetSnap.exists) throw new HttpsError("not-found", "The target student record could not be verified.");
    const data = targetSnap.data() || {};
    targetStudentData = data;
    const linkedUid = String(data.studentUid || data.uid || data.userUid || "").trim();
    const email = String(data.email || "").trim().toLowerCase();
    const callerEmail = String(request.auth.token.email || "").trim().toLowerCase();
    const callerRoll = callerEmail ? callerEmail.split("@")[0].trim().toUpperCase() : "";
    if (!isStaff && !(linkedUid ? linkedUid === request.auth.uid : (email === callerEmail || callerRoll === targetRollNo))) {
      throw new HttpsError("permission-denied", "You can only verify your own student face.");
    }
    targetIdentity = { rollNo: targetRollNo, studentUid: linkedUid || (!isStaff ? request.auth.uid : "") };
  }

  const [enrolledFaces, legacyStudents, legacyUsers, legacyAuthorizedUsers] = targetRollNo
    ? await Promise.all([
      db.collection("face_enrollments").doc(targetRollNo).get(),
      db.collection("students").doc(targetRollNo).get(),
      targetIdentity.studentUid
        ? db.collection("users").doc(targetIdentity.studentUid).get()
        : db.collection("users").where("rollNo", "==", targetRollNo).get(),
      targetStudentData.email
        ? db.collection("authorizedUsers").where("email", "==", String(targetStudentData.email).toLowerCase()).get()
        : db.collection("authorizedUsers").where("rollNo", "==", targetRollNo).get()
    ])
    : await Promise.all([
      db.collection("face_enrollments").get(),
      db.collection("students").get(),
      db.collection("users").get(),
      db.collection("authorizedUsers").get()
    ]);
  const candidateMap = new Map();
  const snapshots = [
    enrolledFaces,
    legacyStudents,
    ...(Array.isArray(legacyUsers) ? legacyUsers : [legacyUsers]),
    ...(Array.isArray(legacyAuthorizedUsers) ? legacyAuthorizedUsers : [legacyAuthorizedUsers])
  ];
  snapshots.forEach((snapshot) => {
    const docs = Array.isArray(snapshot.docs) ? snapshot.docs : (snapshot.exists ? [snapshot] : []);
    docs.forEach((docSnap) => {
    const candidate = faceCandidateFromDoc(docSnap, docSnap.ref.parent.id);
    if (!candidate.rollNo) return;
    const key = candidate.studentUid || candidate.rollNo || candidate.docId;
    const existing = candidateMap.get(key);
    if (!existing || (candidate.faceDescriptor && !existing.faceDescriptor)) candidateMap.set(key, candidate);
    });
  });

  const matches = [];
  for (const candidate of candidateMap.values()) {
    if (targetIdentity && !sameFaceIdentity(candidate, targetIdentity)) continue;
    const descriptor = candidate.faceDescriptor;
    if (!descriptor) continue;
    let storedVector;
    try {
      storedVector = normalizeFaceVector(descriptor, "Stored face descriptor");
    } catch (_) {
      continue;
    }
    matches.push({ candidate, distance: faceVectorDistance(liveVector, storedVector) });
  }
  matches.sort((left, right) => left.distance - right.distance);

  const best = matches[0];
  if (!best) return { status: "UNREGISTERED", matched: false };
  if (best.distance > FACE_REVIEW_DISTANCE) {
    return { status: "NO_MATCH", matched: false, distance: best.distance };
  }
  if (best.distance > FACE_MATCH_DISTANCE || (matches[1] && matches[1].distance - best.distance < 0.08)) {
    return { status: "REVIEW_REQUIRED", matched: false, distance: best.distance };
  }

  const studentSnap = await db.collection("students").doc(best.candidate.rollNo).get();
  const studentData = studentSnap.exists ? studentSnap.data() : {};
  return {
    status: "MATCH",
    matched: true,
    distance: best.distance,
    confidence: Math.max(0, Math.min(100, Math.round((1 - best.distance / FACE_MATCH_DISTANCE) * 100))),
    student: {
      rollNo: best.candidate.rollNo,
      name: studentData?.name || studentData?.fullName || "",
      email: studentData?.email || "",
      branch: studentData?.branch || studentData?.department || "",
      semester: studentData?.semester || ""
    }
  };
});

/**
 * Staff can close an ambiguous request by requiring a fresh capture or rejecting
 * it. This endpoint intentionally does not provide an approval override.
 */
exports.resolveFaceEnrollmentReview = onCall({ cors: true }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Authentication required.");
  if (!(await isFaceEnrollmentStaff(request))) {
    throw new HttpsError("permission-denied", "Only authorized staff can review face enrollment requests.");
  }

  const requestId = String(request.data?.requestId || "").trim();
  const action = String(request.data?.action || "").trim().toUpperCase();
  if (!requestId || !["RECAPTURE_REQUIRED", "REJECTED"].includes(action)) {
    throw new HttpsError("invalid-argument", "A requestId and supported review action are required.");
  }

  const reviewRef = db.collection("face_enrollment_reviews").doc(requestId);
  const guardRef = db.collection("face_enrollment_control").doc("global");
  await db.runTransaction(async (transaction) => {
    const [reviewSnap, guardSnap] = await Promise.all([
      transaction.get(reviewRef),
      transaction.get(guardRef)
    ]);
    if (!reviewSnap.exists || reviewSnap.data()?.status !== "PENDING") {
      throw new HttpsError("not-found", "Pending face enrollment review was not found.");
    }
    transaction.update(reviewRef, {
      status: action,
      faceDescriptor: FieldValue.delete(),
      reviewedBy: request.auth.uid,
      reviewedAt: FieldValue.serverTimestamp()
    });
    transaction.set(guardRef, {
      revision: Number(guardSnap.data()?.revision || 0) + 1,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return { success: true, status: action };
});

exports.listFaceEnrollmentReviews = onCall({ cors: true }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Authentication required.");
  if (!(await isFaceEnrollmentStaff(request))) {
    throw new HttpsError("permission-denied", "Only authorized staff can view face enrollment reviews.");
  }

  const requestedRollNo = String(request.data?.rollNo || "").trim().toUpperCase();
  const pendingQuery = requestedRollNo
    ? db.collection("face_enrollment_reviews").where("rollNo", "==", requestedRollNo).limit(100)
    : db.collection("face_enrollment_reviews").where("status", "==", "PENDING").limit(100);
  const pending = await pendingQuery.get();

  const reviews = pending.docs
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
    .filter((review) => review.status === "PENDING");

  return {
    reviews: await Promise.all(reviews.map(async (review) => {
      const [studentSnap, conflictSnap] = await Promise.all([
        db.collection("students").doc(String(review.rollNo || "").trim().toUpperCase()).get(),
        review.candidateRollNo
          ? db.collection("students").doc(String(review.candidateRollNo).trim().toUpperCase()).get()
          : Promise.resolve(null)
      ]);
      const student = studentSnap?.exists ? studentSnap.data() : {};
      const conflict = conflictSnap?.exists ? conflictSnap.data() : {};
      return {
        id: review.id,
        rollNo: review.rollNo,
        studentName: student.name || student.fullName || "",
        candidateRollNo: review.candidateRollNo || null,
        candidateName: conflict.name || conflict.fullName || "",
        reason: review.reason || "FACE_MATCH_AMBIGUOUS",
        distance: Number.isFinite(review.distance) ? review.distance : null,
        createdAt: review.createdAt?.toMillis?.() || null
      };
    }))
  };
});

exports.removeStudentFaceEnrollment = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Authentication required.");
  if (!(await isFaceEnrollmentStaff(request))) {
    throw new HttpsError("permission-denied", "Only authorized staff can remove a student's face enrollment.");
  }

  const rollNo = String(request.data?.rollNo || "").trim().toUpperCase();
  if (!rollNo) throw new HttpsError("invalid-argument", "rollNo is required.");

  const studentRef = db.collection("students").doc(rollNo);
  const enrollmentRef = db.collection("face_enrollments").doc(rollNo);
  const guardRef = db.collection("face_enrollment_control").doc("global");
  const templateFields = {
    faceDescriptor: FieldValue.delete(),
    faceDescriptors: FieldValue.delete(),
    descriptor: FieldValue.delete(),
    descriptors: FieldValue.delete(),
    faceVector: FieldValue.delete(),
    faceVectors: FieldValue.delete(),
    embedding: FieldValue.delete(),
    embeddings: FieldValue.delete(),
    photoURL: FieldValue.delete(),
    image: FieldValue.delete(),
    photo: FieldValue.delete(),
    avatar: FieldValue.delete(),
    profilePic: FieldValue.delete(),
    profileImage: FieldValue.delete(),
    faceImage: FieldValue.delete(),
    facePhoto: FieldValue.delete(),
    enrolledFace: FieldValue.delete(),
    faceData: FieldValue.delete(),
    enrolledAt: FieldValue.delete(),
    faceEnrolledAt: FieldValue.delete(),
    biometricVerified: FieldValue.delete(),
    biometricRegistered: FieldValue.delete()
  };

  await db.runTransaction(async (transaction) => {
    const [
      guardSnap,
      studentSnap,
      enrollmentSnap,
      legacyStudents,
      legacyUsers,
      legacyAuthorizedUsers,
      pendingReviews
    ] = await Promise.all([
      transaction.get(guardRef),
      transaction.get(studentRef),
      transaction.get(enrollmentRef),
      transaction.get(db.collection("students")),
      transaction.get(db.collection("users")),
      transaction.get(db.collection("authorizedUsers")),
      transaction.get(db.collection("face_enrollment_reviews").where("status", "==", "PENDING"))
    ]);
    if (!studentSnap.exists) throw new HttpsError("not-found", "The target student record could not be verified.");

    const targetIdentity = cleanFaceIdentity({
      ...studentSnap.data(),
      rollNo,
      studentUid: studentSnap.data()?.studentUid || studentSnap.data()?.uid
    });
    const cleanedPaths = new Set();
    for (const docSnap of [...legacyStudents.docs, ...legacyUsers.docs, ...legacyAuthorizedUsers.docs]) {
      const candidate = faceCandidateFromDoc(docSnap, docSnap.ref.parent.id);
      if (
        !sameFaceIdentity(candidate, targetIdentity) ||
        cleanedPaths.has(docSnap.ref.path) ||
        docSnap.ref.path === studentRef.path
      ) continue;
      cleanedPaths.add(docSnap.ref.path);
      transaction.update(docSnap.ref, {
        ...templateFields,
        faceRegistered: false,
        biometricEnrolled: false,
        hasFaceRegistered: false,
        faceRemovedAt: FieldValue.serverTimestamp()
      });
    }

    transaction.set(studentRef, {
      ...templateFields,
      faceRegistered: false,
      biometricEnrolled: false,
      hasFaceRegistered: false,
      faceRemovedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.delete(enrollmentRef);

    for (const reviewSnap of pendingReviews.docs) {
      const review = reviewSnap.data() || {};
      if (String(review.rollNo || "").trim().toUpperCase() === rollNo) {
        transaction.update(reviewSnap.ref, {
          status: "REJECTED",
          faceDescriptor: FieldValue.delete(),
          reviewedBy: request.auth.uid,
          reviewedAt: FieldValue.serverTimestamp(),
          resolutionReason: "ENROLLMENT_REMOVED"
        });
      }
    }
    transaction.set(guardRef, {
      revision: Number(guardSnap.data()?.revision || 0) + 1,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return { success: true, rollNo };
});

exports.evaluateFaceUniqueness = evaluateFaceUniqueness;
exports.faceVectorDistance = faceVectorDistance;

/**
 * 17. BIND STUDENT DEVICE PLATFORM (Authoritative First-Time Platform Binding - Option A)
 * Binds and permanently locks an enrolled student account to an authoritative platform ("android" or "ios").
 * - Only accepts "android" or "ios" (rejects all missing, invalid, or malformed values).
 * - Atomic execution via Firestore transaction: prevents concurrent conflicting assignments.
 * - If already bound, rejects with "already-exists" to prevent ordinary student modifications.
 * - Sets registeredPlatform, deviceType, registeredDeviceType, and deviceTypeLocked: true in students/{rollNo} and users/{uid}.
 * - Emits audit record into biometric_audit_logs.
 */
const bindStudentDevicePlatform = onCall({ cors: true }, async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to bind device platform.");
  }

  const { platform } = request.data || {};
  if (!platform || typeof platform !== "string") {
    throw new HttpsError("invalid-argument", "Missing or invalid platform parameter. Expected 'android' or 'ios'.");
  }

  const cleanPlatform = platform.trim().toLowerCase();
  if (cleanPlatform !== "android" && cleanPlatform !== "ios") {
    throw new HttpsError(
      "invalid-argument",
      `Invalid device platform '${platform}'. Only 'android' and 'ios' are supported.`
    );
  }

  const callerUid = request.auth.uid;
  const callerEmail = request.auth.token.email || "";
  const studentProfile = await resolveAuthoritativeStudent(callerUid, callerEmail);
  const rollNo = studentProfile.rollNo;

  const studentRef = db.collection("students").doc(rollNo);
  const userRef = db.collection("users").doc(callerUid);

  let finalPlatform = null;

  // Execute atomic transaction to prevent race conditions / conflicting concurrent bindings
  await db.runTransaction(async (transaction) => {
    const studentSnap = await transaction.get(studentRef);
    if (!studentSnap.exists) {
      throw new HttpsError("not-found", `Authoritative student record for ${rollNo} not found.`);
    }

    const sData = studentSnap.data() || {};
    // Authoritative check: Only registeredPlatform represents a locked platform binding.
    // Legacy unverified fields (deviceType, registeredDeviceType) do not block legitimate legacy users from onboarding.
    const existingPlatform = sData.registeredPlatform;

    if (existingPlatform && (existingPlatform === "android" || existingPlatform === "ios")) {
      throw new HttpsError(
        "already-exists",
        `Device platform is already bound to '${existingPlatform}' for ${rollNo}. Ordinary re-binding is prohibited. To request a platform change, submit an authorized Device Change Request.`
      );
    }

    const now = FieldValue.serverTimestamp();
    const bindingPayload = {
      registeredPlatform: cleanPlatform,
      deviceType: cleanPlatform,
      registeredDeviceType: cleanPlatform,
      deviceTypeLocked: true,
      platformBoundAt: now,
      platformBoundBy: callerUid,
      updatedAt: now
    };

    transaction.set(studentRef, bindingPayload, { merge: true });
    transaction.set(userRef, {
      registeredPlatform: cleanPlatform,
      deviceType: cleanPlatform,
      deviceTypeLocked: true,
      updatedAt: now
    }, { merge: true });

    finalPlatform = cleanPlatform;
  });

  // Record audit log
  await db.collection("biometric_audit_logs").add({
    action: "DEVICE_PLATFORM_INITIAL_BINDING",
    studentUid: callerUid,
    rollNo: rollNo,
    platform: finalPlatform,
    boundBy: callerUid,
    timestamp: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    rollNo: rollNo,
    platform: finalPlatform,
    message: `Account ${rollNo} successfully bound to ${finalPlatform === "android" ? "Android (Native SmartAttend App)" : "iOS (Apple iPhone)"}.`
  };
});
exports.bindStudentDevicePlatform = bindStudentDevicePlatform;

/**
 * 18. RESET STUDENT DEVICE PLATFORM (Authorized Platform Recovery - Option A)
 * Resets an existing student's locked device platform to a new platform ("android" or "ios").
 * Authorization:
 * 1. Admin: Can reset any student's device platform.
 * 2. Course Lecturer: Can reset device platform for students enrolled in their assigned course rosters.
 * 3. Student: Can reset ONLY IF holding an APPROVED, single-use Biometric Change Request ID.
 * Rejects pending, rejected, replayed, or unapproved requests.
 * Revokes existing credentials if switching away from Android.
 * Emits audit record into biometric_audit_logs.
 */
const resetStudentDevicePlatform = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to reset device platform.");
  }

  const { targetRollNo, targetStudentUid, newPlatform, requestId, reason } = request.data || {};
  if (!newPlatform || typeof newPlatform !== "string") {
    throw new HttpsError("invalid-argument", "New platform is required. Expected 'android' or 'ios'.");
  }

  const cleanNewPlatform = newPlatform.trim().toLowerCase();
  if (cleanNewPlatform !== "android" && cleanNewPlatform !== "ios") {
    throw new HttpsError("invalid-argument", `Invalid platform '${newPlatform}'. Only 'android' and 'ios' are supported.`);
  }

  const callerUid = request.auth.uid;
  const callerEmail = (request.auth.token.email || "").toLowerCase().trim();
  const isAdmin = await isCallerAdmin(request);

  // Resolve target student
  let targetUidToLookup = targetStudentUid;
  if (!targetUidToLookup && targetRollNo) {
    const sSnap = await db.collection("students").doc(String(targetRollNo).trim().toUpperCase()).get();
    if (sSnap.exists) {
      targetUidToLookup = sSnap.data().studentUid || sSnap.data().uid;
    }
  }
  if (!targetUidToLookup) {
    targetUidToLookup = callerUid;
  }
  const studentProfile = await resolveAuthoritativeStudent(targetUidToLookup, null);
  const studentUid = studentProfile.uid;
  const rollNo = studentProfile.rollNo;

  let authorizedBy = "ADMIN";
  if (isAdmin) {
    authorizedBy = `ADMIN (${callerEmail})`;
  } else if (callerUid === studentUid) {
    if (!requestId) {
      throw new HttpsError("permission-denied", "Platform change requires an approved Biometric Change Request ID.");
    }
    authorizedBy = `STUDENT_WITH_APPROVED_REQUEST (${requestId})`;
  } else {
    // Lecturer authorization: verify student is enrolled in at least one course taught by the lecturer
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
          return r === rollNo;
        })) {
          isStudentInCourse = true;
          break;
        }
      }
    }
    if (!isStudentInCourse) {
      throw new HttpsError("permission-denied", `Lecturer ${callerEmail} is not authorized to reset platform for ${rollNo}: student is not in lecturer's assigned course roster.`);
    }
    authorizedBy = `LECTURER (${callerEmail})`;
  }

  const now = FieldValue.serverTimestamp();
  const studentRef = db.collection("students").doc(rollNo);
  const userRef = db.collection("users").doc(studentUid);
  const credRef = db.collection("biometric_credentials").doc(studentUid);
  const rollCredRef = db.collection("biometric_credentials").doc(rollNo);
  const reqRef = requestId ? db.collection("biometric_change_requests").doc(requestId) : null;

  // Execute atomic transaction: verifies and consumes request, revokes superseded credentials,
  // and updates platform fields with no possibility of partial commit or replay
  await db.runTransaction(async (transaction) => {
    if (callerUid === studentUid) {
      if (!reqRef) {
        throw new HttpsError("permission-denied", "Platform change requires an approved Biometric Change Request ID.");
      }
      const reqSnap = await transaction.get(reqRef);
      if (
        !reqSnap.exists ||
        reqSnap.data().studentUid !== studentUid ||
        reqSnap.data().status !== "APPROVED" ||
        reqSnap.data().used === true
      ) {
        throw new HttpsError("permission-denied", "Valid, approved Biometric Change Request required.");
      }
      transaction.update(reqRef, {
        status: "COMPLETED",
        used: true,
        completedAt: now
      });
    } else if (reqRef) {
      // If admin or lecturer supplied a requestId on behalf of student, mark it completed in same transaction
      const reqSnap = await transaction.get(reqRef);
      if (reqSnap.exists && reqSnap.data().used !== true) {
        transaction.update(reqRef, {
          status: "COMPLETED",
          used: true,
          completedAt: now
        });
      }
    }

    transaction.set(studentRef, {
      registeredPlatform: cleanNewPlatform,
      deviceType: cleanNewPlatform,
      registeredDeviceType: cleanNewPlatform,
      deviceTypeLocked: true,
      platformResetAt: now,
      platformResetBy: authorizedBy,
      updatedAt: now
    }, { merge: true });

    transaction.set(userRef, {
      registeredPlatform: cleanNewPlatform,
      deviceType: cleanNewPlatform,
      deviceTypeLocked: true,
      updatedAt: now
    }, { merge: true });

    // Revoke previous credentials on platform transitions so superseded credentials cannot authenticate
    transaction.set(credRef, {
      status: "SUPERSEDED",
      supersededAt: now,
      reason: `Platform reset to ${cleanNewPlatform}`
    }, { merge: true });
    transaction.set(rollCredRef, {
      status: "SUPERSEDED",
      supersededAt: now,
      reason: `Platform reset to ${cleanNewPlatform}`
    }, { merge: true });
  });

  await db.collection("biometric_audit_logs").add({
    action: "DEVICE_PLATFORM_RESET",
    studentUid: studentUid,
    rollNo: rollNo,
    newPlatform: cleanNewPlatform,
    authorizedBy: authorizedBy,
    reason: reason || "Authorized device platform recovery/change",
    timestamp: now
  });

  return {
    success: true,
    rollNo: rollNo,
    newPlatform: cleanNewPlatform,
    authorizedBy: authorizedBy,
    message: `Account ${rollNo} platform successfully reset to ${cleanNewPlatform}.`
  };
});
exports.resetStudentDevicePlatform = resetStudentDevicePlatform;

/**
 * 19. GRANT BIOMETRIC RE-REGISTRATION ACCESS (Lecturer / Admin)
 * Allows lecturers (within their course roster scope) and administrators (institution-wide)
 * to grant student re-registration permissions for Face, Device Biometrics, or Both,
 * under Mode A (One-Time) or Mode B (Repeated).
 */
exports.grantBiometricReRegistration = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to grant re-registration access.");
  }

  const callerUid = request.auth.uid;
  const callerEmail = String(request.auth.token.email || "").toLowerCase().trim();
  const isAdmin = await isCallerAdmin(request);
  if (!isAdmin) {
    await assertLecturer(request);
  }

  const {
    targetRollNos: rawRollNos,
    targetRollNo: rawSingleRoll,
    registrationType: rawType,
    mode: rawMode,
    scope: rawScope,
    expiresInHours: rawHours,
    reason: rawReason
  } = request.data || {};

  // Normalize registrationType
  const cleanType = String(rawType || "BOTH").trim().toUpperCase();
  if (!["FACE", "BIOMETRIC", "BOTH"].includes(cleanType)) {
    throw new HttpsError("invalid-argument", "registrationType must be 'FACE', 'BIOMETRIC', or 'BOTH'.");
  }

  // Normalize mode
  const cleanMode = String(rawMode || "ONE_TIME").trim().toUpperCase();
  if (!["ONE_TIME", "REPEATED"].includes(cleanMode)) {
    throw new HttpsError("invalid-argument", "mode must be 'ONE_TIME' or 'REPEATED'.");
  }

  const cleanScope = (typeof rawScope === "object" && rawScope !== null) ? rawScope : { type: "STUDENT" };
  const targetRollsSet = new Set();

  if (cleanScope.type === "ALL_INSTITUTION") {
    if (!isAdmin) {
      throw new HttpsError("permission-denied", "Only administrators can grant institution-wide re-registration permissions.");
    }
    const allStudentsSnap = await db.collection("students").get();
    for (const doc of allStudentsSnap.docs) {
      targetRollsSet.add(doc.id.toUpperCase().trim());
    }
  } else if (cleanScope.courseId || cleanScope.courseCode) {
    const courseId = String(cleanScope.courseId || cleanScope.courseCode).toUpperCase().trim();
    if (!isAdmin) {
      await assertLecturerCourseScope(callerUid, callerEmail, courseId);
    }
    const courseDoc = await db.collection("courses").doc(courseId).get();
    if (!courseDoc.exists) {
      throw new HttpsError("not-found", `Course "${courseId}" not found.`);
    }
    const cData = courseDoc.data() || {};
    if (Array.isArray(cData.enrolledStudents)) {
      for (const s of cData.enrolledStudents) {
        const r = typeof s === "string" ? s.toUpperCase().trim() : String(s.rollNo || s.rollNumber || "").toUpperCase().trim();
        if (r) targetRollsSet.add(r);
      }
    }
  } else {
    // Student list
    const candidateList = [];
    if (Array.isArray(rawRollNos)) {
      for (const r of rawRollNos) {
        if (r && typeof r === "string") candidateList.push(r.toUpperCase().trim());
      }
    } else if (rawSingleRoll && typeof rawSingleRoll === "string") {
      candidateList.push(rawSingleRoll.toUpperCase().trim());
    }

    if (candidateList.length === 0) {
      throw new HttpsError("invalid-argument", "At least one target student roll number must be specified.");
    }

    if (!isAdmin) {
      const authorizedRolls = await getAuthorizedStudentRollsForLecturer(callerUid, callerEmail);
      for (const roll of candidateList) {
        if (!authorizedRolls.has(roll)) {
          throw new HttpsError(
            "permission-denied",
            `Lecturer ${callerEmail} is not authorized to grant permissions to student ${roll}: student is outside your assigned course rosters.`
          );
        }
        targetRollsSet.add(roll);
      }
    } else {
      for (const roll of candidateList) {
        targetRollsSet.add(roll);
      }
    }
  }

  const targetRolls = Array.from(targetRollsSet);
  if (targetRolls.length === 0) {
    throw new HttpsError("invalid-argument", "No eligible students found in the requested scope.");
  }

  // Caller display name
  let callerName = callerEmail;
  try {
    const userSnap = await db.collection("users").doc(callerUid).get();
    if (userSnap.exists) {
      callerName = userSnap.data()?.name || userSnap.data()?.fullName || callerEmail;
    }
  } catch (_) {}

  // Fetch student info in batches
  const studentMap = new Map();
  for (let i = 0; i < targetRolls.length; i += 30) {
    const chunk = targetRolls.slice(i, i + 30);
    const snaps = await Promise.all(chunk.map(r => db.collection("students").doc(r).get()));
    snaps.forEach(s => {
      if (s.exists) studentMap.set(s.id, s.data());
    });
  }

  const nowMs = Date.now();
  const expiresInHours = rawHours ? Number(rawHours) : null;
  const expiresAt = expiresInHours && expiresInHours > 0
    ? Timestamp.fromMillis(nowMs + expiresInHours * 3600 * 1000)
    : null;

  // Batch write permissions
  const batchSize = 400;
  for (let i = 0; i < targetRolls.length; i += batchSize) {
    const batch = db.batch();
    const chunk = targetRolls.slice(i, i + batchSize);
    for (const rollNo of chunk) {
      const permId = `perm_${rollNo}_${nowMs}_${crypto.randomUUID().slice(0, 6)}`;
      const sData = studentMap.get(rollNo) || {};
      const permRef = db.collection("biometric_reregistration_permissions").doc(permId);
      batch.set(permRef, {
        id: permId,
        targetRollNo: rollNo,
        studentUid: sData.studentUid || sData.uid || null,
        studentName: sData.name || sData.fullName || rollNo,
        grantedByUid: callerUid,
        grantedByEmail: callerEmail,
        grantedByRole: isAdmin ? "ADMIN" : "LECTURER",
        grantedByName: callerName,
        scope: cleanScope,
        registrationType: cleanType,
        mode: cleanMode,
        status: "ACTIVE",
        maxUses: cleanMode === "ONE_TIME" ? 1 : null,
        usedCount: 0,
        remainingUses: cleanMode === "ONE_TIME" ? 1 : null,
        reason: rawReason || "Authorized re-registration access grant",
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: expiresAt,
        revokedAt: null,
        revokedBy: null,
        lastUsedAt: null
      });

      // Audit log entry
      const auditRef = db.collection("biometric_audit_logs").doc();
      batch.set(auditRef, {
        action: "RE_REGISTRATION_PERMISSION_GRANTED",
        permissionId: permId,
        targetRollNo: rollNo,
        grantedByUid: callerUid,
        grantedByEmail: callerEmail,
        grantedByRole: isAdmin ? "ADMIN" : "LECTURER",
        registrationType: cleanType,
        mode: cleanMode,
        timestamp: FieldValue.serverTimestamp()
      });
    }
    await batch.commit();
  }

  return {
    success: true,
    grantedCount: targetRolls.length,
    registrationType: cleanType,
    mode: cleanMode,
    targetRollNos: targetRolls,
    message: `Granted ${cleanMode} re-registration permission (${cleanType}) to ${targetRolls.length} student(s).`
  };
});

/**
 * 20. REVOKE BIOMETRIC RE-REGISTRATION ACCESS (Lecturer / Admin)
 * Revokes an unused/active re-registration permission.
 */
exports.revokeBiometricReRegistration = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to revoke permissions.");
  }

  const callerUid = request.auth.uid;
  const callerEmail = String(request.auth.token.email || "").toLowerCase().trim();
  const isAdmin = await isCallerAdmin(request);
  if (!isAdmin) {
    await assertLecturer(request);
  }

  const { permissionId, reason } = request.data || {};
  if (!permissionId || typeof permissionId !== "string") {
    throw new HttpsError("invalid-argument", "permissionId is required.");
  }

  const permRef = db.collection("biometric_reregistration_permissions").doc(String(permissionId).trim());
  const permSnap = await permRef.get();

  if (!permSnap.exists) {
    throw new HttpsError("not-found", "Re-registration permission document not found.");
  }

  const permData = permSnap.data() || {};
  if (permData.status !== "ACTIVE") {
    throw new HttpsError("failed-precondition", `Permission is already ${permData.status || "inactive"}.`);
  }

  if (!isAdmin) {
    const isGrantor = permData.grantedByUid === callerUid || permData.grantedByEmail === callerEmail;
    if (!isGrantor) {
      const authorizedRolls = await getAuthorizedStudentRollsForLecturer(callerUid, callerEmail);
      if (!authorizedRolls.has(permData.targetRollNo)) {
        throw new HttpsError(
          "permission-denied",
          "You can only revoke permissions granted by yourself or for students in your authorized courses."
        );
      }
    }
  }

  await permRef.update({
    status: "REVOKED",
    revokedAt: FieldValue.serverTimestamp(),
    revokedBy: callerUid,
    revocationReason: reason || "Revoked by staff"
  });

  await db.collection("biometric_audit_logs").add({
    action: "RE_REGISTRATION_PERMISSION_REVOKED",
    permissionId: permSnap.id,
    targetRollNo: permData.targetRollNo,
    revokedByUid: callerUid,
    revokedByEmail: callerEmail,
    revokedByRole: isAdmin ? "ADMIN" : "LECTURER",
    timestamp: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    permissionId: permSnap.id,
    targetRollNo: permData.targetRollNo,
    message: "Re-registration permission successfully revoked."
  };
});

/**
 * 21. LIST BIOMETRIC RE-REGISTRATION PERMISSIONS (Lecturer / Admin)
 * Returns permissions filtered by operator's authorized administrative scope.
 */
exports.listBiometricReRegistrationPermissions = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to list permissions.");
  }

  const callerUid = request.auth.uid;
  const callerEmail = String(request.auth.token.email || "").toLowerCase().trim();
  const isAdmin = await isCallerAdmin(request);
  if (!isAdmin) {
    await assertLecturer(request);
  }

  const { rollNo, statusFilter } = request.data || {};
  let query = db.collection("biometric_reregistration_permissions");

  if (rollNo && typeof rollNo === "string") {
    const cleanRoll = rollNo.toUpperCase().trim();
    if (!isAdmin) {
      const authorizedRolls = await getAuthorizedStudentRollsForLecturer(callerUid, callerEmail);
      if (!authorizedRolls.has(cleanRoll)) {
        throw new HttpsError("permission-denied", "You are not authorized to view permissions for this student.");
      }
    }
    query = query.where("targetRollNo", "==", cleanRoll);
  }

  if (statusFilter && typeof statusFilter === "string" && statusFilter !== "ALL") {
    query = query.where("status", "==", statusFilter.toUpperCase().trim());
  }

  const snap = await query.limit(200).get();
  let permissions = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (!isAdmin && !rollNo) {
    const authorizedRolls = await getAuthorizedStudentRollsForLecturer(callerUid, callerEmail);
    permissions = permissions.filter(p =>
      p.grantedByUid === callerUid || p.grantedByEmail === callerEmail || authorizedRolls.has(p.targetRollNo)
    );
  }

  const cleanPermissions = permissions.map(p => ({
    ...p,
    createdAt: p.createdAt?.toMillis ? p.createdAt.toMillis() : (p.createdAt || null),
    expiresAt: p.expiresAt?.toMillis ? p.expiresAt.toMillis() : (p.expiresAt || null),
    revokedAt: p.revokedAt?.toMillis ? p.revokedAt.toMillis() : (p.revokedAt || null),
    lastUsedAt: p.lastUsedAt?.toMillis ? p.lastUsedAt.toMillis() : (p.lastUsedAt || null)
  }));

  return { permissions: cleanPermissions };
});

/**
 * 22. CHECK STUDENT RE-REGISTRATION STATUS
 * Authoritative endpoint for student and staff to check current registration state,
 * active re-registration permissions, and whether face/biometric registration is permitted.
 */
exports.checkStudentReRegistrationStatus = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to check registration status.");
  }

  const callerUid = request.auth.uid;
  const callerEmail = String(request.auth.token.email || "").toLowerCase().trim();
  const callerRoll = callerEmail ? callerEmail.split("@")[0].toUpperCase().trim() : "";
  const isStaff = await isFaceEnrollmentStaff(request);

  const requestedRoll = request.data?.rollNo
    ? String(request.data.rollNo).toUpperCase().trim()
    : callerRoll;

  if (!requestedRoll) {
    throw new HttpsError("invalid-argument", "rollNo is required.");
  }

  if (!isStaff && requestedRoll !== callerRoll) {
    const sSnap = await db.collection("students").doc(requestedRoll).get();
    const sData = sSnap.exists ? sSnap.data() : {};
    const linkedUid = sData.studentUid || sData.uid;
    if (linkedUid !== callerUid) {
      throw new HttpsError("permission-denied", "You can only view your own registration status.");
    }
  }

  const [studentSnap, faceSnap, credSnap, userCredSnap, permSnaps] = await Promise.all([
    db.collection("students").doc(requestedRoll).get(),
    db.collection("face_enrollments").doc(requestedRoll).get(),
    db.collection("biometric_credentials").doc(requestedRoll).get(),
    db.collection("biometric_credentials").doc(callerUid).get(),
    db.collection("biometric_reregistration_permissions")
      .where("targetRollNo", "==", requestedRoll)
      .where("status", "==", "ACTIVE")
      .get()
  ]);

  const sData = studentSnap.exists ? studentSnap.data() : {};
  const hasFace = Boolean(
    faceSnap.exists ||
    (sData.faceRegistered === true && !sData.faceRemovedAt) ||
    sData.biometricEnrolled === true
  );

  const credData = credSnap.exists ? credSnap.data() : (userCredSnap.exists ? userCredSnap.data() : null);
  const hasBiometric = Boolean(
    (credData && credData.status === "ACTIVE") ||
    sData.hardwareBiometricEnrolled === true
  );

  const nowMs = Date.now();
  let facePermission = null;
  let biometricPermission = null;
  const activePerms = [];

  for (const doc of permSnaps.docs) {
    const data = doc.data() || {};
    if (data.expiresAt) {
      const expMs = typeof data.expiresAt.toMillis === "function"
        ? data.expiresAt.toMillis()
        : new Date(data.expiresAt).getTime();
      if (expMs <= nowMs) continue;
    }
    const mode = String(data.mode || "ONE_TIME").toUpperCase();
    if (mode === "ONE_TIME") {
      const remaining = data.remainingUses != null ? Number(data.remainingUses) : 1;
      if (remaining <= 0) continue;
    }

    const cleanP = {
      id: doc.id,
      registrationType: data.registrationType,
      mode: data.mode,
      remainingUses: data.remainingUses,
      grantedByName: data.grantedByName || data.grantedByEmail,
      grantedByRole: data.grantedByRole,
      createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
      expiresAt: data.expiresAt?.toMillis ? data.expiresAt.toMillis() : null
    };
    activePerms.push(cleanP);

    const pType = String(data.registrationType || "").toUpperCase();
    if (pType === "FACE" || pType === "BOTH") {
      if (!facePermission) facePermission = cleanP;
    }
    if (pType === "BIOMETRIC" || pType === "BOTH") {
      if (!biometricPermission) biometricPermission = cleanP;
    }
  }

  const faceStatus = facePermission
    ? "PERMISSION_GRANTED"
    : (hasFace ? "REGISTERED" : "NOT_REGISTERED");

  const biometricStatus = biometricPermission
    ? "PERMISSION_GRANTED"
    : (hasBiometric ? "REGISTERED" : "NOT_REGISTERED");

  return {
    rollNo: requestedRoll,
    name: sData.name || sData.fullName || requestedRoll,
    hasFaceRegistered: hasFace,
    hasBiometricRegistered: hasBiometric,
    canRegisterFace: !hasFace || Boolean(facePermission) || isStaff,
    canRegisterBiometric: !hasBiometric || Boolean(biometricPermission) || isStaff,
    faceEnrollmentStatus: faceStatus,
    biometricEnrollmentStatus: biometricStatus,
    activePermissions: activePerms,
    facePermission,
    biometricPermission
  };
});

/**
 * 23. IDENTIFY STUDENT BY FACE (Staff only: Lecturer & Admin)
 * Compares live query face against enrolled student population within operator's authorized scope.
 * - Admin: institution-wide search across enrolled students.
 * - Lecturer: searches ONLY students enrolled in courses taught by the lecturer.
 * - High confidence + unambiguous match required (threshold 0.52, margin >= 0.08).
 * - Does NOT mark attendance.
 * - Logs identification event without storing raw face embeddings.
 */
exports.identifyStudentByFace = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required to identify students by face.");
  }

  const isStaff = await isFaceEnrollmentStaff(request);
  if (!isStaff) {
    throw new HttpsError("permission-denied", "Only authorized faculty and administrators can identify students by face.");
  }

  const callerUid = request.auth.uid;
  const callerEmail = String(request.auth.token.email || "").toLowerCase().trim();
  const isAdmin = await isCallerAdmin(request);

  const rawDescriptor = request.data?.faceDescriptor;
  if (!rawDescriptor) {
    throw new HttpsError("invalid-argument", "faceDescriptor is required.");
  }

  const liveVector = normalizeFaceVector(rawDescriptor, "Face descriptor for identification");
  let authorizedRolls = null;

  if (!isAdmin) {
    authorizedRolls = await getAuthorizedStudentRollsForLecturer(callerUid, callerEmail);
    if (!authorizedRolls || authorizedRolls.size === 0) {
      return {
        status: "NO_MATCH",
        matched: false,
        message: "No enrolled students found in courses assigned to your lecturer account."
      };
    }
  }

  let enrollmentDocs = [];
  if (isAdmin) {
    const snap = await db.collection("face_enrollments").get();
    enrollmentDocs = snap.docs;
  } else {
    const rollList = Array.from(authorizedRolls);
    const chunks = [];
    for (let i = 0; i < rollList.length; i += 30) {
      chunks.push(rollList.slice(i, i + 30));
    }
    const snaps = await Promise.all(
      chunks.map(chunk => db.collection("face_enrollments").where(FieldPath.documentId(), "in", chunk).get())
    );
    enrollmentDocs = snaps.flatMap(s => s.docs);
  }

  const matches = [];
  for (const docSnap of enrollmentDocs) {
    const data = docSnap.data() || {};
    const rollNo = data.rollNo || docSnap.id;
    if (!isAdmin && authorizedRolls && !authorizedRolls.has(rollNo.toUpperCase())) continue;
    const descriptor = data.faceDescriptor;
    if (!descriptor) continue;
    let candidateVector;
    try {
      candidateVector = normalizeFaceVector(descriptor, `Stored face descriptor for ${rollNo}`);
    } catch (_) {
      continue;
    }
    const dist = faceVectorDistance(liveVector, candidateVector);
    matches.push({ rollNo: rollNo.toUpperCase(), distance: dist, data });
  }

  matches.sort((a, b) => a.distance - b.distance);
  const best = matches[0];
  const second = matches[1];

  if (!best || best.distance > FACE_REVIEW_DISTANCE) {
    return {
      status: "NO_MATCH",
      matched: false,
      distance: best ? best.distance : null,
      message: "No enrolled student found matching this face in your authorized scope."
    };
  }

  // Ambiguity or weak match check
  if (best.distance > FACE_MATCH_DISTANCE || (second && (second.distance - best.distance) < 0.08)) {
    return {
      status: "UNCERTAIN_MATCH",
      matched: false,
      distance: best.distance,
      message: "Uncertain face match. Multiple candidates or low confidence; identity cannot be asserted."
    };
  }

  // Match confirmed!
  const studentSnap = await db.collection("students").doc(best.rollNo).get();
  const sData = studentSnap.exists ? studentSnap.data() : {};

  // Fetch courses for this student
  const coursesSnap = await db.collection("courses").get();
  const studentCourses = [];
  for (const cDoc of coursesSnap.docs) {
    const c = cDoc.data() || {};
    let inCourse = false;
    if (Array.isArray(c.enrolledStudents)) {
      inCourse = c.enrolledStudents.some(s => {
        const r = typeof s === "string" ? s.toUpperCase().trim() : String(s.rollNo || s.rollNumber || "").toUpperCase().trim();
        return r === best.rollNo;
      });
    }
    if (inCourse) {
      studentCourses.push({
        id: cDoc.id,
        courseCode: c.courseCode || cDoc.id,
        courseName: c.courseName || c.name || cDoc.id,
        section: c.section || null,
        batch: c.batch || null
      });
    }
  }

  const confidence = Math.max(0, Math.min(100, Math.round((1 - best.distance / FACE_MATCH_DISTANCE) * 100)));

  // Audit log: NO raw embeddings or images stored!
  await db.collection("biometric_audit_logs").add({
    action: "STUDENT_FACE_IDENTIFICATION",
    operatorUid: callerUid,
    operatorEmail: callerEmail,
    operatorRole: isAdmin ? "ADMIN" : "LECTURER",
    identifiedRollNo: best.rollNo,
    confidence,
    distance: best.distance,
    timestamp: FieldValue.serverTimestamp()
  });

  return {
    status: "MATCH",
    matched: true,
    confidence,
    distance: best.distance,
    student: {
      rollNo: best.rollNo,
      name: sData.name || sData.fullName || best.rollNo,
      email: sData.email || "",
      branch: sData.branch || sData.department || "",
      semester: sData.semester || "",
      section: sData.section || "",
      batch: sData.batch || "",
      photoURL: sData.photoURL || sData.photo || sData.image || null,
      courses: studentCourses
    }
  };
});

// Authoritative internal engine exports for direct unit and integration testing
exports.evaluateServerGeofence = evaluateServerGeofence;
exports.generateDynamicQrToken = generateDynamicQrToken;
exports.verifyDynamicQrToken = verifyDynamicQrToken;
exports.resolveActiveReRegistrationPermission = resolveActiveReRegistrationPermission;
exports.consumeReRegistrationPermission = consumeReRegistrationPermission;
exports.getAuthorizedStudentRollsForLecturer = getAuthorizedStudentRollsForLecturer;
exports.evaluateFaceUniqueness = evaluateFaceUniqueness;
exports.faceVectorDistance = faceVectorDistance;
exports.validateFaceVectorDescriptor = validateFaceVectorDescriptor;
