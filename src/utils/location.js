export const MAX_LOCATION_AGE_MS = 60000;
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
