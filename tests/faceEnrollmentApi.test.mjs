import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFaceUniqueness,
  faceVectorDistance,
  matchEnrolledFace,
  normalizeFaceVector
} from "../server/faceEnrollment.js";
import handler from "../api/face/register.js";
import matchHandler from "../api/face/match.js";

function sampleVector(seed = 0) {
  return Array.from({ length: 128 }, (_, index) => Math.sin(index + seed) * 0.4);
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    }
  };
}

test("face enrollment API rejects unsupported methods without initializing Admin SDK", async () => {
  const response = responseRecorder();
  await handler({ method: "GET", headers: {} }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.body.error.code, "method-not-allowed");
});

test("face enrollment API requires a bearer ID token", async () => {
  const response = responseRecorder();
  await handler({ method: "POST", headers: {}, body: {} }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error.code, "unauthenticated");
});

test("face enrollment API rejects unapproved origins", async () => {
  const response = responseRecorder();
  await handler({
    method: "POST",
    headers: { origin: "https://untrusted.example" },
    body: {}
  }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error.code, "origin-not-allowed");
});

test("face match API rejects unsupported methods without initializing Admin SDK", async () => {
  const response = responseRecorder();
  await matchHandler({ method: "GET", headers: {} }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.body.error.code, "method-not-allowed");
});

test("face match API requires a bearer ID token", async () => {
  const response = responseRecorder();
  await matchHandler({ method: "POST", headers: {}, body: {} }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error.code, "unauthenticated");
});

test("face descriptor validation rejects malformed and degenerate input", () => {
  assert.throws(() => normalizeFaceVector([1, 2, 3]), /128 values/);
  assert.throws(() => normalizeFaceVector(Array(128).fill(0.5)), /degenerate/);
  assert.throws(() => normalizeFaceVector(Array(127).fill(0).concat(Number.NaN)), /invalid value/);
});

test("face uniqueness ignores the target identity but rejects matching another identity", () => {
  const vector = sampleVector();
  assert.equal(faceVectorDistance(vector, vector), 0);
  assert.equal(
    evaluateFaceUniqueness(vector, [{ rollNo: "A1", faceDescriptor: vector }], { rollNo: "A1" }).decision,
    "unique"
  );
  assert.equal(
    evaluateFaceUniqueness(vector, [{ rollNo: "B2", faceDescriptor: vector }], { rollNo: "A1" }).decision,
    "duplicate"
  );
  assert.equal(
    evaluateFaceUniqueness(
      vector,
      [{ rollNo: "A1", studentUid: "different-account", faceDescriptor: vector }],
      { rollNo: "A1", studentUid: "target-account" }
    ).decision,
    "duplicate"
  );
});

test("face uniqueness routes enrolled identities with unreadable templates to review", () => {
  const result = evaluateFaceUniqueness(
    sampleVector(),
    [{ rollNo: "B2", faceRegistered: true, faceDescriptor: null }],
    { rollNo: "A1" }
  );
  assert.equal(result.decision, "review");
});

test("face uniqueness routes uncertain similarities to review", () => {
  const enrolled = sampleVector();
  const uncertain = enrolled.slice();
  uncertain[0] += 0.35;
  uncertain[1] += 0.35;
  assert.equal(
    evaluateFaceUniqueness(uncertain, [{ rollNo: "B2", faceDescriptor: enrolled }], { rollNo: "A1" }).decision,
    "review"
  );
});

test("face matching only permits staff to search without a target student", async () => {
  await assert.rejects(
    matchEnrolledFace({}, { isStaff: false }, { faceDescriptor: sampleVector() }),
    (error) => error.status === 403
  );
});

test("staff face matching reports an explicit result when no enrollment exists", async () => {
  const db = { collection: () => ({ get: async () => ({ docs: [] }) }) };
  const result = await matchEnrolledFace(db, { isStaff: true }, { faceDescriptor: sampleVector() });
  assert.equal(result.status, "UNREGISTERED");
  assert.equal(result.matched, false);
  assert.ok(result.message);
});
