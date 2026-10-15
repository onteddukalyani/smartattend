/**
 * Test: Geofence Indoor Accuracy & Proximity Verification
 *
 * Validates:
 * 1. Realistic indoor classroom scenarios (standing before projector with 15-30m GPS jitter) PASS.
 * 2. Remote proxy attendees (300m - 2km away) are strictly REJECTED.
 * 3. Mock GPS / Fake GPS locations are strictly caught as MOCK_DETECTED.
 * 4. Disabled geofence (radius = 0) passes without restrictions.
 * 5. Host PC accuracy factoring prevents false rejections when lecturer PC is on Wi-Fi.
 */

import assert from "assert";
import { evaluateGeofence, calculateHaversineDistance, DEFAULT_GEOFENCE_RADIUS_METRES, MAX_ACCEPTABLE_ACCURACY_METRES } from "../src/utils/geofence.js";

console.log("================================================================================");
console.log("RUNNING: Geofence Indoor Accuracy & Proximity Verification Test Suite");
console.log("================================================================================\n");

console.log(`Default Geofence Radius: ${DEFAULT_GEOFENCE_RADIUS_METRES}m`);
console.log(`Max Acceptable Accuracy: ${MAX_ACCEPTABLE_ACCURACY_METRES}m\n`);

assert.strictEqual(DEFAULT_GEOFENCE_RADIUS_METRES, 30, "Default radius must be 30m");
assert.strictEqual(MAX_ACCEPTABLE_ACCURACY_METRES, 60, "Max accuracy threshold must be 60m");

// Classroom location (e.g. Lecturer laptop near the projector)
const classroomOrigin = {
  latitude: 15.392900,
  longitude: 75.025300,
  radius: 30,
  accuracy: 15
};

// Test 1: Student right before projector (indoor GPS drift ~18m, phone accuracy 20m)
console.log("Test 1: Student in front of projector with standard indoor GPS drift");
const studentInClass = {
  latitude: 15.393040, // ~16m away due to indoor multipath reflection
  longitude: 75.025380,
  accuracy: 20
};
const eval1 = evaluateGeofence(studentInClass, classroomOrigin);
console.log("  Result:", eval1.status, `(measured: ${eval1.distance}m, effective: ${eval1.effectiveDistance}m, accuracy: ±${eval1.accuracy}m)`);
assert.strictEqual(eval1.status, "PASS", "Student in front of projector must pass geofence");
console.log("  ✓ PASS: Indoor student accepted cleanly!\n");

// Test 2: Student sitting in back row of lecture hall (measured distance ~28m, accuracy ~25m)
console.log("Test 2: Student in lecture hall back row");
const studentBackRow = {
  latitude: 15.393120, // ~26m away
  longitude: 75.025420,
  accuracy: 25
};
const eval2 = evaluateGeofence(studentBackRow, classroomOrigin);
console.log("  Result:", eval2.status, `(measured: ${eval2.distance}m, effective: ${eval2.effectiveDistance}m, accuracy: ±${eval2.accuracy}m)`);
assert.strictEqual(eval2.status, "PASS", "Student in lecture hall back row must pass");
console.log("  ✓ PASS: Back-row student accepted cleanly!\n");

// Test 3: Remote student at hostel/home (350m away)
console.log("Test 3: Remote student 350m away");
const studentRemote = {
  latitude: 15.396000,
  longitude: 75.025300,
  accuracy: 15
};
const eval3 = evaluateGeofence(studentRemote, classroomOrigin);
console.log("  Result:", eval3.status, `(measured: ${eval3.distance}m, effective: ${eval3.effectiveDistance}m)`);
assert.strictEqual(eval3.status, "REJECT", "Remote student must be rejected");
console.log("  ✓ REJECT: Remote student strictly blocked!\n");

// Test 4: Mock GPS / Location Spoofing detection
console.log("Test 4: Mock Location Detection");
const studentSpoofed = {
  latitude: 15.392900,
  longitude: 75.025300,
  accuracy: 5,
  isMock: true
};
const eval4 = evaluateGeofence(studentSpoofed, classroomOrigin);
console.log("  Result:", eval4.status);
assert.strictEqual(eval4.status, "MOCK_DETECTED", "Spoofed GPS must be flagged as MOCK_DETECTED");
console.log("  ✓ MOCK_DETECTED: Fake location rejected and flagged!\n");

// Test 5: Geofence Disabled by Lecturer (radius = 0)
console.log("Test 5: Geofence Disabled (radius = 0)");
const classroomDisabled = {
  latitude: 15.392900,
  longitude: 75.025300,
  radius: 0
};
const eval5 = evaluateGeofence(studentRemote, classroomDisabled);
console.log("  Result:", eval5.status, `(enforced: ${eval5.geofenceEnforced})`);
assert.strictEqual(eval5.status, "PASS", "Disabled geofence must pass all");
assert.strictEqual(eval5.geofenceEnforced, false, "Enforced flag must be false");
console.log("  ✓ PASS: Disabled geofence allows pass-through without blocking!\n");

// Test 6: Host PC on Wi-Fi with coarse accuracy
console.log("Test 6: Lecturer PC with Wi-Fi accuracy (±35m)");
const classroomCoarseHost = {
  latitude: 15.392900,
  longitude: 75.025300,
  radius: 30,
  accuracy: 35
};
const studentNearCoarseHost = {
  latitude: 15.393150, // ~30m measured
  longitude: 75.025450,
  accuracy: 25
};
const eval6 = evaluateGeofence(studentNearCoarseHost, classroomCoarseHost);
console.log("  Result:", eval6.status, `(measured: ${eval6.distance}m, effective: ${eval6.effectiveDistance}m)`);
assert.strictEqual(eval6.status, "PASS", "Wi-Fi host drift must be absorbed by uncertainty margin");
console.log("  ✓ PASS: Wi-Fi host uncertainty absorbed!\n");

console.log("================================================================================");
console.log("ALL GEOFENCE INDOOR VERIFICATION TESTS PASSED!");
console.log("================================================================================\n");
