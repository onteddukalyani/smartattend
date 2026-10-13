/**
 * SmartAttend Geofence Engine
 * 
 * Enforces a 5-metre default classroom radius with
 * a strict tri-state decision matrix: PASS, REJECT, or INCONCLUSIVE_RETRY.
 * Never enlarges the radius silently when GPS accuracy is poor.
 */

export const DEFAULT_GEOFENCE_RADIUS_METRES = 5;
export const MAX_ACCEPTABLE_ACCURACY_METRES = 12; // Readings with accuracy > 12m are inconclusive
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
 * Evaluates student position against classroom geofence.
 * 
 * @param {Object} studentCoords - { latitude, longitude, accuracy, isMock? }
 * @param {Object} classroomCoords - { latitude, longitude, radius? }
 * @param {number} [retryCount=0]
 * @returns {Object} { status: 'PASS' | 'REJECT' | 'INCONCLUSIVE_RETRY' | 'MOCK_DETECTED', distance: number, accuracy: number, message: string }
 */
export function evaluateGeofence(studentCoords, classroomCoords, retryCount = 0) {
  if (!classroomCoords || !classroomCoords.latitude || !classroomCoords.longitude || classroomCoords.radius === 0 || classroomCoords.enabled === false) {
    // If classroom has not registered GPS or lecturer disabled geofence, allow pass-through with audit notice
    return {
      status: "PASS",
      distance: 0,
      accuracy: studentCoords?.accuracy || 0,
      radius: 0,
      geofenceEnforced: false,
      message: classroomCoords?.radius === 0 ? "Classroom GPS geofence disabled for this session." : "Classroom GPS not registered for this session."
    };
  }

  const radius = (typeof classroomCoords.radius === 'number' && classroomCoords.radius > 0)
    ? classroomCoords.radius
    : DEFAULT_GEOFENCE_RADIUS_METRES;

  if (!studentCoords || studentCoords.latitude == null || studentCoords.longitude == null) {
    return {
      status: "INCONCLUSIVE_RETRY",
      distance: 999,
      accuracy: 999,
      radius: radius,
      retryCount,
      canRetry: retryCount < MAX_RETRY_ATTEMPTS,
      message: "⚠️ GPS coordinates unavailable. Please enable device location and retry."
    };
  }

  // 1. Android mock-location / spoofing check
  if (studentCoords.isMock || studentCoords.mocked || studentCoords.isMockLocation) {
    return {
      status: "MOCK_DETECTED",
      distance: 999,
      accuracy: studentCoords.accuracy || 0,
      radius: radius,
      message: "🚨 Mock / Fake GPS detected. Attendance rejected and flagged as anti-proxy violation."
    };
  }

  const accuracy = Math.round(studentCoords.accuracy || 0);
  const distance = Math.round(
    calculateHaversineDistance(
      studentCoords.latitude,
      studentCoords.longitude,
      classroomCoords.latitude,
      classroomCoords.longitude
    ) * 10
  ) / 10;

  // 2. Tri-state Decision Matrix:
  // Case A: Accuracy is too poor (> 12m) to make a definitive boundary determination
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
        ? `⚠️ GPS accuracy uncertain (${accuracy}m > 12m threshold). Move closer to classroom windows and retry (Attempt ${retryCount + 1}/${MAX_RETRY_ATTEMPTS}).`
        : `⚠️ Inconclusive GPS after ${MAX_RETRY_ATTEMPTS} attempts (${accuracy}m uncertainty). Attendance flagged for lecturer classroom review.`
    };
  }

  // Case B: Accurate reading inside configured radius (default 10m)
  if (distance <= radius) {
    return {
      status: "PASS",
      distance,
      accuracy,
      radius,
      geofenceEnforced: true,
      message: `✅ Geofence Verified: Inside classroom (${distance}m <= ${radius}m radius, ±${accuracy}m accuracy).`
    };
  }

  // Case C: Accurate reading outside configured radius (> 10m)
  return {
    status: "REJECT",
    distance,
    accuracy,
    radius,
    geofenceEnforced: true,
    message: `❌ Geofence Violation: You are outside the classroom (${distance}m > ${radius}m radius). Attendance rejected.`
  };
}
