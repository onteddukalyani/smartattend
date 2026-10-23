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

export function acquireAccurateLocation(
  geolocation,
  {
    timeoutMs = CLASSROOM_LOCATION_ACQUISITION_TIMEOUT_MS,
    maxAccuracy = MAX_CLASSROOM_LOCATION_ACCURACY_METERS
  } = {}
) {
  return new Promise((resolve, reject) => {
    if (!geolocation || typeof geolocation.watchPosition !== "function") {
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
      if (watchId !== null) {
        geolocation.clearWatch(watchId);
      } else {
        clearWatchAfterStart = true;
      }
      resolve(location);
    };

    try {
      watchId = geolocation.watchPosition(
        (position) => {
          const location = locationFromPosition(position);
          if (!location) return;
          if (!bestLocation || location.accuracy < bestLocation.accuracy) {
            bestLocation = location;
          }
          if (isAccurateLocation(location, Date.now(), maxAccuracy)) {
            finish(location);
          }
        },
        () => finish(bestLocation),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
      );
      if (clearWatchAfterStart && watchId !== null) {
        geolocation.clearWatch(watchId);
      }
    } catch (error) {
      settled = true;
      clearTimeout(timeoutId);
      if (watchId !== null) {
        geolocation.clearWatch(watchId);
      }
      reject(error);
    }
  });
}
