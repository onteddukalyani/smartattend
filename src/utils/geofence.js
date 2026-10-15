/**
 * SmartAttend Geofence Engine
 * 
 * Enforces a 5-metre default classroom radius with
 * a strict tri-state decision matrix: PASS, REJECT, or INCONCLUSIVE_RETRY.
 * Never enlarges the radius silently when GPS accuracy is poor.
 */

export const DEFAULT_GEOFENCE_RADIUS_METRES = 30; // 30m standard classroom/hall radius
export const MAX_ACCEPTABLE_ACCURACY_METRES = 60; // Standard smartphones indoors report 15m-45m accuracy
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
 * @param {Object} classroomCoords - { latitude, longitude, radius?, accuracy? }
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
  const hostAccuracy = Math.round(classroomCoords.accuracy || 0);

  const rawDistance = calculateHaversineDistance(
    studentCoords.latitude,
    studentCoords.longitude,
    classroomCoords.latitude,
    classroomCoords.longitude
  );
  const distance = Math.round(rawDistance * 10) / 10;

  // 2. Accuracy-aware Indoor Margin:
  // In indoor concrete classrooms, multi-path reflections cause GPS readings to wander.
  // The true physical distance is bounded by: effectiveDistance = max(0, distance - accuracyMargin).
  const uncertaintyMargin = Math.min(accuracy, 30) + (hostAccuracy > 15 ? Math.min(hostAccuracy, 35) : 0);
  const effectiveDistance = Math.max(0, Math.round((distance - uncertaintyMargin) * 10) / 10);

  // 3. Tri-state Decision Matrix:
  // Case A: Accuracy is completely degraded (> 60m threshold, e.g. IP-only or cellar)
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
    message: `❌ Geofence Violation: You are outside the classroom (${distance}m > ${radius}m radius). Attendance rejected.`
  };
}
