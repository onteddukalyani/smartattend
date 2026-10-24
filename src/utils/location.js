export const MAX_LOCATION_AGE_MS = 60000;
export const MAX_CLASSROOM_LOCATION_ACCURACY_METERS = 45;
export const CLASSROOM_LOCATION_ACQUISITION_TIMEOUT_MS = 15000;
const MAX_FUTURE_LOCATION_SKEW_MS = 15000;

export function locationFromPosition(position) {
  const latitude = Number(position?.coords?.latitude);
  const longitude = Number(position?.coords?.longitude);
  const accuracy = Number(position?.coords?.accuracy);
  const timestamp = Number(position?.timestamp);

  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    !Number.isFinite(accuracy) ||
    accuracy <= 0 ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0
  ) {
    return null;
  }

  return {
    latitude,
    longitude,
    lat: latitude,
    lng: longitude,
    accuracy,
    timestamp
  };
}

export function isFreshLocation(location, now = Date.now(), maxAgeMs = MAX_LOCATION_AGE_MS) {
  const latitude = Number(location?.latitude ?? location?.lat);
  const longitude = Number(location?.longitude ?? location?.lng ?? location?.lon);
  const accuracy = Number(location?.accuracy ?? location?.acc);
  const timestamp = Number(location?.timestamp);
  const age = now - timestamp;

  return (
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    Number.isFinite(accuracy) &&
    accuracy > 0 &&
    Number.isFinite(age) &&
    age <= maxAgeMs &&
    age >= -MAX_FUTURE_LOCATION_SKEW_MS
  );
}

export function isAccurateLocation(
  location,
  now = Date.now(),
  maxAccuracy = MAX_CLASSROOM_LOCATION_ACCURACY_METERS
) {
  return isFreshLocation(location, now) && Number(location.accuracy ?? location.acc) <= maxAccuracy;
}

/**
 * Selects the highest quality, most defensible student GPS fix from available candidates.
 * Prioritizes fixes meeting the classroom accuracy threshold (<= 45m), tie-broken by
 * precision and freshness. Never discards an accurate fix in favor of a newer degraded fix.
 */
export function pickBestStudentLocation(
  candidates = [],
  maxAccuracy = MAX_CLASSROOM_LOCATION_ACCURACY_METERS,
  now = Date.now()
) {
  const validCandidates = (Array.isArray(candidates) ? candidates : [candidates])
    .filter((loc) => isFreshLocation(loc, now));

  if (validCandidates.length === 0) return null;

  const accurate = validCandidates.filter((loc) => isAccurateLocation(loc, now, maxAccuracy));
  if (accurate.length > 0) {
    accurate.sort((a, b) => {
      const accA = Number(a.accuracy ?? a.acc);
      const accB = Number(b.accuracy ?? b.acc);
      const diff = accA - accB;
      if (Math.abs(diff) > 5) return diff; // Significant accuracy gain
      return Number(b.timestamp) - Number(a.timestamp); // Fresher fix
    });
    return accurate[0];
  }

  // Fallback: pick the best precision among fresh fixes
  validCandidates.sort((a, b) => {
    const accA = Number(a.accuracy ?? a.acc);
    const accB = Number(b.accuracy ?? b.acc);
    return accA - accB;
  });
  return validCandidates[0];
}

export function acquireAccurateLocation(
  geolocation,
  {
    timeoutMs = CLASSROOM_LOCATION_ACQUISITION_TIMEOUT_MS,
    maxAccuracy = MAX_CLASSROOM_LOCATION_ACCURACY_METERS,
    maximumAge = 0
  } = {}
) {
  return new Promise((resolve, reject) => {
    if (
      !geolocation ||
      (typeof geolocation.watchPosition !== "function" &&
        typeof geolocation.getCurrentPosition !== "function")
    ) {
      resolve(null);
      return;
    }

    let watchId = null;
    let settled = false;
    let clearWatchAfterStart = false;
    let bestLocation = null;
    const timeoutId = setTimeout(() => finish(bestLocation), timeoutMs);

    const finish = (location) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (watchId !== null && typeof geolocation.clearWatch === "function") {
        geolocation.clearWatch(watchId);
      } else {
        clearWatchAfterStart = true;
      }
      resolve(location);
    };

    const handlePosition = (position) => {
      const location = locationFromPosition(position);
      if (!location) return;
      if (!bestLocation || location.accuracy < bestLocation.accuracy) {
        bestLocation = location;
      }
      if (isAccurateLocation(location, Date.now(), maxAccuracy)) {
        finish(location);
      }
    };

    // Fast-path 1: Parallel getCurrentPosition for rapid one-shot GNSS prime
    if (typeof geolocation.getCurrentPosition === "function") {
      try {
        geolocation.getCurrentPosition(
          handlePosition,
          () => {},
          {
            enableHighAccuracy: true,
            timeout: timeoutMs,
            maximumAge: typeof maximumAge === "number" ? maximumAge : 0
          }
        );
      } catch (_) {}
    }

    // Fast-path 2: watchPosition for continuous refining lock
    if (typeof geolocation.watchPosition === "function") {
      try {
        watchId = geolocation.watchPosition(
          handlePosition,
          () => finish(bestLocation),
          {
            enableHighAccuracy: true,
            timeout: timeoutMs,
            maximumAge: typeof maximumAge === "number" ? maximumAge : 0
          }
        );
        if (clearWatchAfterStart && watchId !== null && typeof geolocation.clearWatch === "function") {
          geolocation.clearWatch(watchId);
        }
      } catch (error) {
        if (!settled && typeof geolocation.getCurrentPosition !== "function") {
          settled = true;
          clearTimeout(timeoutId);
          reject(error);
        }
      }
    }
  });
}
