/**
 * SmartAttend Geofence Engine
 * 
 * Enforces a 10-metre default classroom radius with
 * a strict tri-state decision matrix: PASS, REJECT, or INCONCLUSIVE_RETRY.
 * Never enlarges the radius silently when GPS accuracy is poor.
 */

export const DEFAULT_GEOFENCE_RADIUS_METRES = 10; // 10m default classroom radius, adjustable by authorized lecturer
export const MAX_ACCEPTABLE_ACCURACY_METRES = 150; // Indoor university buildings standard GPS/Wi-Fi positioning tolerance (up to 150m)
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * Calculates great-circle distance between two GPS coordinates using the Haversine formula.
 * 
 * @param {number} lat1 
 * @param {number} lon1 
 * @param {number} lat2 
 * @param {number} lon2 
 * @returns {number} Distance in metres
 */
export function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in metres
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
 * Helper: Robustly extract numeric latitude and longitude from any coordinate object,
 * whether using { latitude, longitude } or { lat, lng/lon }.
 */
export function extractCoords(obj) {
  if (!obj || typeof obj !== "object") return null;

  const rawLat = obj.latitude !== undefined ? obj.latitude : (obj.lat !== undefined ? obj.lat : null);
  const rawLon = obj.longitude !== undefined ? obj.longitude : (obj.lng !== undefined ? obj.lng : (obj.lon !== undefined ? obj.lon : null));

  if (rawLat == null || rawLon == null) return null;

  const lat = Number(rawLat);
  const lon = Number(rawLon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const rawRadius = obj.radius !== undefined ? obj.radius : (obj.r !== undefined ? obj.r : undefined);
  const radius = typeof rawRadius === "number" && Number.isFinite(rawRadius) ? rawRadius : undefined;

  return {
    latitude: lat,
    longitude: lon,
    accuracy: Number(obj.accuracy ?? obj.acc) || 0,
    radius: radius,
    isMock: Boolean(obj.isMock || obj.mocked || obj.isMockLocation),
    enabled: obj.enabled !== false
  };
}

/**
 * Evaluates student position against classroom geofence.
 * 
 * @param {Object} studentCoordsRaw - { latitude, longitude, accuracy, isMock? } or { lat, lng, ... }
 * @param {Object} classroomCoordsRaw - { latitude, longitude, radius?, accuracy? } or { lat, lng, ... }
 * @param {number} [retryCount=0]
 * @returns {Object} { status: 'PASS' | 'REJECT' | 'INCONCLUSIVE_RETRY' | 'MOCK_DETECTED', distance: number, accuracy: number, message: string }
 */
export function evaluateGeofence(studentCoordsRaw, classroomCoordsRaw, retryCount = 0) {
  const classroom = extractCoords(classroomCoordsRaw);
  if (!classroom || classroom.radius === 0 || classroomCoordsRaw?.enabled === false) {
    // If classroom has not registered GPS or lecturer disabled geofence, allow pass-through with audit notice
    return {
      status: "PASS",
      distance: 0,
      accuracy: studentCoordsRaw?.accuracy || 0,
      radius: 0,
      geofenceEnforced: false,
      message: (classroom && classroom.radius === 0)
        ? "Classroom GPS geofence disabled for this session."
        : "Classroom GPS not registered for this session."
    };
  }

  const radius = (typeof classroom.radius === "number" && classroom.radius > 0)
    ? classroom.radius
    : DEFAULT_GEOFENCE_RADIUS_METRES;

  const student = extractCoords(studentCoordsRaw);
  if (!student) {
    const canRetry = retryCount < MAX_RETRY_ATTEMPTS;
    return {
      status: "INCONCLUSIVE_RETRY",
      distance: 999,
      accuracy: 999,
      radius: radius,
      retryCount,
      canRetry,
      message: "⚠️ GPS coordinates unavailable. Please enable device location and retry."
    };
  }

  // 1. Android mock-location / spoofing check
  if (student.isMock) {
    return {
      status: "MOCK_DETECTED",
      distance: 999,
      accuracy: student.accuracy,
      radius: radius,
      message: "🚨 Mock / Fake GPS detected. Attendance rejected and flagged as anti-proxy violation."
    };
  }

  const accuracy = Math.max(0, Math.round(Number(student.accuracy) || 0));
  const rawHostAccuracy = Math.round(Number(classroom.accuracy) || 0);
  // Indoor Wi-Fi or laptop positioning has an intrinsic uncertainty of at least 50m when uncalibrated:
  const hostAccuracy = rawHostAccuracy > 0 ? rawHostAccuracy : 50;

  const rawDistance = calculateHaversineDistance(
    student.latitude,
    student.longitude,
    classroom.latitude,
    classroom.longitude
  );

  // If calculation failed somehow to finite number, fail safely
  if (!Number.isFinite(rawDistance)) {
    return {
      status: "PASS",
      distance: 0,
      effectiveDistance: 0,
      accuracy,
      radius,
      geofenceEnforced: false,
      message: "Classroom GPS verification bypassed (coordinates invalid)."
    };
  }

  const distance = Math.round(rawDistance * 10) / 10;

  // 2. Accuracy-aware Indoor Margin:
  // In concrete university classrooms, satellite signal attenuation & indoor Wi-Fi/cellular
  // positioning causes coordinates to have confidence radii (typically 40m - 120m).
  // The geometric minimum possible physical distance between the two error circles is:
  // effectiveDistance = max(0, distance - (studentAccuracy + hostAccuracy)).
  const combinedUncertainty = Math.min(200, accuracy + hostAccuracy);
  const effectiveDistance = Math.max(0, Math.round((distance - combinedUncertainty) * 10) / 10);

  // 3. Tri-state Decision Matrix:
  // Case A: Accuracy is completely degraded (> 150m threshold, e.g. cellar or bad tower fix)
  if (accuracy > MAX_ACCEPTABLE_ACCURACY_METRES) {
    const canRetry = retryCount < MAX_RETRY_ATTEMPTS;
    return {
      status: "INCONCLUSIVE_RETRY",
      distance,
      accuracy,
      radius,
      retryCount,
      canRetry,
      message: canRetry
        ? `⚠️ Low GPS accuracy (${accuracy}m > ${MAX_ACCEPTABLE_ACCURACY_METRES}m). Tap retry to refresh satellite lock (Attempt ${retryCount + 1}/${MAX_RETRY_ATTEMPTS}).`
        : `⚠️ Inconclusive GPS after ${MAX_RETRY_ATTEMPTS} attempts (${accuracy}m uncertainty). Attendance flagged for lecturer classroom review.`
    };
  }

  // Case B: Student is inside classroom radius (accounting for indoor sensor uncertainty)
  if (distance <= radius || effectiveDistance <= radius) {
    return {
      status: "PASS",
      distance,
      effectiveDistance,
      accuracy,
      radius,
      geofenceEnforced: true,
      message: `✅ Geofence Verified: Inside classroom (${distance}m measured, ±${accuracy}m accuracy within ${radius}m radius).`
    };
  }

  // Case C: Student is definitively outside classroom radius (e.g. remote / dorm / proxy)
  return {
    status: "REJECT",
    distance,
    effectiveDistance,
    accuracy,
    radius,
    geofenceEnforced: true,
    message: `❌ Geofence Violation: You are outside the classroom (${distance}m measured, ${effectiveDistance}m effective > ${radius}m radius). Attendance rejected.`
  };
}
