/**
 * SmartAttend Geofence Engine
 * 
 * Enforces a 10-metre default classroom radius with
 * a strict tri-state decision matrix: PASS, REJECT, or INCONCLUSIVE_RETRY.
 * Never enlarges the radius silently when GPS accuracy is poor.
 */

export const DEFAULT_GEOFENCE_RADIUS_METRES = 10; // 10m standard classroom radius, adjustable by authorized lecturer
export const MAX_ACCEPTABLE_ACCURACY_METRES = 45;
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
  const nLat1 = Number(lat1);
  const nLon1 = Number(lon1);
  const nLat2 = Number(lat2);
  const nLon2 = Number(lon2);

  if (!Number.isFinite(nLat1) || !Number.isFinite(nLon1) || !Number.isFinite(nLat2) || !Number.isFinite(nLon2)) {
    return NaN;
  }

  const R = 6371000; // Earth mean radius in metres (WGS84 spherical approximation)
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
  const geofenceDisabled = classroomCoordsRaw?.enabled === false ||
    Number(classroomCoordsRaw?.radius ?? classroomCoordsRaw?.r) === 0;
  if (geofenceDisabled) {
    return {
      status: "PASS",
      distance: 0,
      accuracy: studentCoordsRaw?.accuracy || 0,
      radius: 0,
      geofenceEnforced: false,
      message: (
        classroomCoordsRaw?.enabled === false ||
        classroomCoordsRaw?.radius === 0 ||
        classroomCoordsRaw?.r === 0
      )
        ? "Classroom GPS geofence disabled for this session."
        : "Classroom GPS not registered for this session."
    };
  }

  if (!classroom) {
    return {
      status: "INCONCLUSIVE_RETRY",
      distance: null,
      accuracy: studentCoordsRaw?.accuracy || 0,
      radius: DEFAULT_GEOFENCE_RADIUS_METRES,
      geofenceEnforced: true,
      locationAcquiring: true,
      message: "Classroom GPS location is not ready. Ask the lecturer to refresh the session location."
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
      distance: null,
      effectiveDistance: null,
      accuracy: null,
      radius: radius,
      retryCount,
      canRetry,
      locationAcquiring: true,
      classroomCoords: { latitude: classroom.latitude, longitude: classroom.longitude, radius },
      message: "📍 GPS coordinates acquiring. Please ensure device location is enabled and hold camera steady."
    };
  }

  // 1. Android mock-location / spoofing check
  if (student.isMock) {
    return {
      status: "MOCK_DETECTED",
      distance: 999,
      accuracy: student.accuracy,
      radius: radius,
      studentCoords: { latitude: student.latitude, longitude: student.longitude, accuracy: student.accuracy },
      classroomCoords: { latitude: classroom.latitude, longitude: classroom.longitude, radius },
      message: "🚨 Mock / Fake GPS detected. Attendance rejected and flagged as anti-proxy violation."
    };
  }

  const accuracy = Math.max(0, Math.round(Number(student.accuracy) || 0));

  // 2. Exact physical distance calculation
  const rawDistance = calculateHaversineDistance(
    student.latitude,
    student.longitude,
    classroom.latitude,
    classroom.longitude
  );

  // Invalid coordinate pairs cannot establish classroom presence.
  if (!Number.isFinite(rawDistance)) {
    return {
      status: "INCONCLUSIVE_RETRY",
      distance: null,
      accuracy,
      radius,
      studentCoords: { latitude: student.latitude, longitude: student.longitude, accuracy },
      classroomCoords: { latitude: classroom.latitude, longitude: classroom.longitude, radius },
      geofenceEnforced: true,
      message: "GPS coordinates are invalid. Wait for a fresh location fix and scan again."
    };
  }

  const distance = Math.round(rawDistance * 10) / 10;

  if (accuracy > MAX_ACCEPTABLE_ACCURACY_METRES) {
    const canRetry = retryCount < MAX_RETRY_ATTEMPTS;
    return {
      status: "INCONCLUSIVE_RETRY",
      distance,
      accuracy,
      radius,
      retryCount,
      canRetry,
      studentCoords: { latitude: student.latitude, longitude: student.longitude, accuracy },
      classroomCoords: { latitude: classroom.latitude, longitude: classroom.longitude, radius },
      message: `GPS accuracy is too low (${accuracy}m > ${MAX_ACCEPTABLE_ACCURACY_METRES}m). Wait for a better GPS fix and scan again.`
    };
  }

  const uncertaintyAllowance = Math.min(accuracy > 0 ? accuracy / 2 : 0, Math.min(5, radius * 0.5));
  const effectiveDistance = Math.max(0, Math.round((distance - uncertaintyAllowance) * 10) / 10);

  const telemetry = {
    distance,
    effectiveDistance,
    accuracy,
    radius,
    studentCoords: { latitude: student.latitude, longitude: student.longitude, accuracy },
    classroomCoords: { latitude: classroom.latitude, longitude: classroom.longitude, radius }
  };

  // Case A: Student is verified inside classroom radius:
  // - Direct geometric presence (distance <= radius)
  // - Effective distance inside radius considering sensor confidence circles (effectiveDistance <= radius)
  if (distance <= radius || effectiveDistance <= radius) {
    return {
      status: "PASS",
      ...telemetry,
      geofenceEnforced: true,
      message: `✅ Geofence Verified: Inside classroom (${distance}m measured distance within ${radius}m boundary).`
    };
  }

  // Case C: Student is definitively outside classroom radius (e.g. remote / dorm / proxy)
  return {
    status: "REJECT",
    ...telemetry,
    geofenceEnforced: true,
    message: `❌ Geofence Violation: You are outside the classroom (${distance}m away > ${radius}m radius). Attendance rejected.`
  };
}
