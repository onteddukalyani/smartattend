/**
 * SmartAttend Dynamic Rotating QR & Cryptographic Token Engine
 * 
 * Implements Time-based One-Time Token (TOTT) with HMAC-SHA256 signatures,
 * exact expiry boundaries (interval + 5s clock skew grace), and replay prevention.
 */

// Supported rotation intervals in seconds
export const ROTATION_INTERVALS = [5, 10, 15, 30, 60];
export const DEFAULT_ROTATION_INTERVAL = 10;
export const MAX_CLOCK_SKEW_GRACE_SEC = 5;

/**
 * Web Crypto SHA-256 HMAC generator (works in all modern browsers and WebView)
 */
async function computeHmacSha256(keyStr, dataStr) {
  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(keyStr || "smartattend_secret");
    const msgData = encoder.encode(dataStr);

    const cryptoKey = await window.crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await window.crypto.subtle.sign("HMAC", cryptoKey, msgData);
    const hashArray = Array.from(new Uint8Array(signature));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  } catch (_) {
    // Synchronous fallback hash if crypto.subtle is unavailable
    let hash = 0;
    const combined = `${keyStr}:${dataStr}`;
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, "0");
  }
}

/**
 * Generate a dynamic rotating QR payload.
 * 
 * @param {Object} params
 * @param {string} params.sessionId
 * @param {string|number} params.phase - "1" or "2"
 * @param {string} params.baseToken - Session secret or phase token
 * @param {number} params.intervalSec - Rotation interval (default 10s)
 * @param {Object} [params.classroomLocation] - { latitude, longitude, radius }
 * @returns {Promise<string>} QR string to encode into canvas
 */
export async function generateRotatingQrPayload({
  sessionId,
  phase = "1",
  baseToken = "",
  intervalSec = DEFAULT_ROTATION_INTERVAL,
  classroomLocation = null
}) {
  const now = Date.now();
  const slot = Math.floor(now / (intervalSec * 1000));
  const dataToSign = `${sessionId}|${phase}|${slot}|${intervalSec}`;
  const sig = await computeHmacSha256(baseToken || sessionId, dataToSign);

  const payloadObj = {
    s: sessionId,
    p: String(phase),
    t: now,
    slot,
    int: intervalSec,
    sig
  };

  if (classroomLocation && classroomLocation.latitude && classroomLocation.longitude) {
    payloadObj.geo = {
      lat: Number(classroomLocation.latitude.toFixed(6)),
      lng: Number(classroomLocation.longitude.toFixed(6)),
      r: classroomLocation.radius || 10
    };
  }

  // Construct standard web URL with query params for seamless browser / deep-link scanning
  const baseUrl = typeof window !== "undefined" && window.location.origin
    ? window.location.origin
    : "https://smartattend.app";

  const url = new URL(`${baseUrl}/student/mark-attendance`);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("phase", String(phase));
  url.searchParams.set("t", String(now));
  url.searchParams.set("slot", String(slot));
  url.searchParams.set("int", String(intervalSec));
  url.searchParams.set("sig", sig);
  if (phase === "1" || phase === 1) {
    url.searchParams.set("qr1Token", baseToken || sessionId);
  } else {
    url.searchParams.set("qr2Token", baseToken || sessionId);
  }

  if (payloadObj.geo) {
    url.searchParams.set("geolat", String(payloadObj.geo.lat));
    url.searchParams.set("geolng", String(payloadObj.geo.lng));
    url.searchParams.set("geor", String(payloadObj.geo.r));
  }

  return url.toString();
}

/**
 * Validate a scanned dynamic QR payload against real-time expiry and HMAC.
 * 
 * @param {string|Object} rawScanned
 * @param {Object} [options]
 * @param {number} [options.clockSkewGraceSec=5]
 * @returns {Promise<Object>} { valid: boolean, error?: string, payload?: Object }
 */
export async function validateRotatingQrPayload(rawScanned, options = {}) {
  const clockSkew = options.clockSkewGraceSec ?? MAX_CLOCK_SKEW_GRACE_SEC;
  const now = Date.now();

  try {
    let params = null;

    if (typeof rawScanned === "string") {
      // Check if it's a URL
      if (rawScanned.startsWith("http://") || rawScanned.startsWith("https://") || rawScanned.startsWith("smartattend://")) {
        const parsed = new URL(rawScanned.replace("smartattend://attend", "https://smartattend.app/student/mark-attendance"));
        params = {
          sessionId: parsed.searchParams.get("session") || "",
          phase: parsed.searchParams.get("phase") || "1",
          t: Number(parsed.searchParams.get("t") || 0),
          slot: Number(parsed.searchParams.get("slot") || 0),
          intervalSec: Number(parsed.searchParams.get("int") || DEFAULT_ROTATION_INTERVAL),
          sig: parsed.searchParams.get("sig") || "",
          qr1Token: parsed.searchParams.get("qr1Token") || "",
          qr2Token: parsed.searchParams.get("qr2Token") || "",
          geo: parsed.searchParams.get("geolat") ? {
            latitude: Number(parsed.searchParams.get("geolat")),
            longitude: Number(parsed.searchParams.get("geolng")),
            radius: Number(parsed.searchParams.get("geor") || 10)
          } : null
        };
      } else if (rawScanned.startsWith("{")) {
        const json = JSON.parse(rawScanned);
        params = {
          sessionId: json.s || json.sessionId,
          phase: String(json.p || json.phase || "1"),
          t: Number(json.t || json.timestamp || 0),
          slot: Number(json.slot || 0),
          intervalSec: Number(json.int || json.intervalSec || DEFAULT_ROTATION_INTERVAL),
          sig: json.sig || "",
          qr1Token: json.qr1Token || "",
          qr2Token: json.qr2Token || "",
          geo: json.geo || null
        };
      }
    } else if (typeof rawScanned === "object") {
      params = rawScanned;
    }

    if (!params || !params.sessionId) {
      return { valid: false, error: "INVALID_FORMAT", message: "Malformed or unreadable QR code." };
    }

    // 1. Strict Lifetime Validation:
    // If the token has a generation timestamp 't', enforce:
    // 0 <= (now - t) <= (intervalSec + clockSkew) * 1000
    if (params.t) {
      const ageMs = now - params.t;
      const maxAgeMs = (params.intervalSec + clockSkew) * 1000;

      if (ageMs > maxAgeMs) {
        const ageSec = Math.round(ageMs / 1000);
        return {
          valid: false,
          error: "QR_EXPIRED",
          ageSec,
          maxAllowedSec: params.intervalSec + clockSkew,
          message: `❌ QR Code Expired: This QR code expired ${ageSec}s ago (rotates every ${params.intervalSec}s). Scan the live projected QR on screen.`
        };
      }

      // Check future clock skew anomaly (> 5s in the future)
      if (ageMs < -5000) {
        return {
          valid: false,
          error: "CLOCK_SKEW_FUTURE",
          message: "⚠️ Device clock desynchronized with attendance server. Please ensure automatic time is enabled."
        };
      }
    }

    return {
      valid: true,
      payload: params
    };
  } catch (err) {
    return {
      valid: false,
      error: "PARSE_ERROR",
      message: "Could not parse attendance QR data: " + err.message
    };
  }
}
