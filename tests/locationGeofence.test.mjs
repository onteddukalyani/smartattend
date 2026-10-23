import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { evaluateGeofence } from "../src/utils/geofence.js";
import {
  acquireAccurateLocation,
  isAccurateLocation,
  isFreshLocation,
  locationFromPosition
} from "../src/utils/location.js";

const require = createRequire(import.meta.url);
const { evaluateServerGeofence } = require("../functions/index.js");

test("locationFromPosition preserves the device fix timestamp and rejects invalid fixes", () => {
  const timestamp = 1_800_000_000_000;
  const location = locationFromPosition({
    timestamp,
    coords: { latitude: 12.9716, longitude: 77.5946, accuracy: 8 }
  });

  assert.equal(location.timestamp, timestamp);
  assert.equal(location.latitude, 12.9716);
  assert.equal(location.accuracy, 8);
  assert.equal(locationFromPosition({ timestamp, coords: { latitude: 100, longitude: 0, accuracy: 5 } }), null);
  assert.equal(locationFromPosition({ timestamp: 0, coords: { latitude: 0, longitude: 0, accuracy: 5 } }), null);
});

test("GPS freshness accepts current fixes only within one minute", () => {
  const now = 1_800_000_000_000;
  const fix = { latitude: 12.9716, longitude: 77.5946, accuracy: 8, timestamp: now - 59000 };

  assert.equal(isFreshLocation(fix, now), true);
  assert.equal(isFreshLocation({ ...fix, timestamp: now - 61000 }, now), false);
  assert.equal(isFreshLocation({ ...fix, timestamp: now + 16000 }, now), false);
  assert.equal(isFreshLocation({ ...fix, accuracy: 0 }, now), false);
});

test("classroom GPS readiness requires a fresh fix with accuracy of 45m or better", () => {
  const now = Date.now();
  const fix = { latitude: 12.9716, longitude: 77.5946, accuracy: 45, timestamp: now };

  assert.equal(isAccurateLocation(fix, now), true);
  assert.equal(isAccurateLocation({ ...fix, accuracy: 46 }, now), false);
  assert.equal(isAccurateLocation({ ...fix, timestamp: now - 61000 }, now), false);
});

test("classroom GPS acquisition waits for an accurate watch fix and clears the watch", async () => {
  let success;
  let clearedWatchId = null;
  const geolocation = {
    watchPosition(onSuccess) {
      success = onSuccess;
      return 7;
    },
    clearWatch(id) {
      clearedWatchId = id;
    }
  };

  const resultPromise = acquireAccurateLocation(geolocation, { timeoutMs: 1000 });
  success({
    timestamp: Date.now(),
    coords: { latitude: 12.9716, longitude: 77.5946, accuracy: 90 }
  });
  success({
    timestamp: Date.now(),
    coords: { latitude: 12.9716, longitude: 77.5946, accuracy: 24 }
  });

  const result = await resultPromise;
  assert.equal(result.accuracy, 24);
  assert.equal(clearedWatchId, 7);
});

test("classroom GPS acquisition returns the best fix if it times out below the accuracy threshold", async () => {
  let success;
  const geolocation = {
    watchPosition(onSuccess) {
      success = onSuccess;
      return 9;
    },
    clearWatch() {}
  };

  const resultPromise = acquireAccurateLocation(geolocation, { timeoutMs: 25 });
  success({
    timestamp: Date.now(),
    coords: { latitude: 12.9716, longitude: 77.5946, accuracy: 80 }
  });

  const result = await resultPromise;
  assert.equal(result.accuracy, 80);
});

test("client geofence mirrors server accuracy and uncertainty policy", () => {
  const classroom = { latitude: 12.9716, longitude: 77.5946, radius: 10 };
  const now = Date.now();
  const at15m = { latitude: 12.9716 + 0.0001349, longitude: 77.5946, accuracy: 10, timestamp: now };
  const lowAccuracyInside = { ...at15m, latitude: classroom.latitude, accuracy: 46 };

  const clientAtBoundary = evaluateGeofence(at15m, classroom);
  const serverAtBoundary = evaluateServerGeofence(at15m, classroom, 10, now);
  assert.equal(clientAtBoundary.status, serverAtBoundary.status);
  assert.equal(clientAtBoundary.status, "PASS");

  const clientLowAccuracy = evaluateGeofence(lowAccuracyInside, classroom);
  const serverLowAccuracy = evaluateServerGeofence(lowAccuracyInside, classroom, 10, now);
  assert.equal(clientLowAccuracy.status, "INCONCLUSIVE_RETRY");
  assert.equal(serverLowAccuracy.status, "INCONCLUSIVE");

  const clientDisabled = evaluateGeofence(at15m, { ...classroom, radius: 0 });
  const serverDisabled = evaluateServerGeofence(at15m, classroom, 0, now);
  assert.equal(clientDisabled.geofenceEnforced, false);
  assert.equal(clientDisabled.status, serverDisabled.status);
  assert.equal(evaluateGeofence(at15m, null).status, "INCONCLUSIVE_RETRY");
});
