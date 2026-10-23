import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFaceUniqueness,
  faceVectorDistance,
  listFaceEnrollmentReviews,
  matchEnrolledFace,
  normalizeFaceVector,
  resolveFaceEnrollmentReview
} from "../server/faceEnrollment.js";
import handler from "../api/face/register.js";
import matchHandler from "../api/face/match.js";
import reviewHandler from "../api/face/review.js";
import { applyCors } from "../server/apiRequest.js";

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

test("face API CORS allows Firebase Hosting, local Vite, and Capacitor origins", () => {
  for (const origin of [
    "https://smart-attendance-ok.web.app",
    "https://smart-attendance-ok.firebaseapp.com",
    "http://localhost:5173",
    "https://localhost",
    "capacitor://localhost"
  ]) {
    const response = responseRecorder();
    assert.equal(applyCors({ headers: { origin } }, response), true);
    assert.equal(response.headers["Access-Control-Allow-Origin"], origin);
  }
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

test("face review API rejects unsupported methods without initializing Admin SDK", async () => {
  const response = responseRecorder();
  await reviewHandler({ method: "GET", headers: {} }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.body.error.code, "method-not-allowed");
});

test("face review API requires a bearer ID token", async () => {
  const response = responseRecorder();
  await reviewHandler({ method: "POST", headers: {}, body: {} }, response);
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

test("face review listing is staff-only and never returns stored descriptors", async () => {
  const review = {
    rollNo: "STUDENT-1",
    candidateRollNo: "STUDENT-2",
    reason: "FACE_MATCH_AMBIGUOUS",
    distance: 0.5,
    faceDescriptor: sampleVector(),
    createdAt: { toMillis: () => 1234 }
  };
  const db = {
    collection(name) {
      if (name === "face_enrollment_reviews") {
        return {
          where() {
            return this;
          },
          limit() {
            return this;
          },
          get: async () => ({
            docs: [{ id: "review-1", data: () => review }]
          })
        };
      }
      return {
        doc(id) {
          return {
            get: async () => ({
              exists: true,
              data: () => ({ name: id === "STUDENT-1" ? "Student One" : "Student Two" })
            })
          };
        }
      };
    }
  };

  await assert.rejects(
    listFaceEnrollmentReviews(db, { uid: "student-uid", isStaff: false }),
    (error) => error.status === 403
  );
  const result = await listFaceEnrollmentReviews(db, { uid: "lecturer-uid", isStaff: true });
  assert.deepEqual(result.reviews[0], {
    id: "review-1",
    rollNo: "STUDENT-1",
    studentName: "Student One",
    candidateRollNo: "STUDENT-2",
    candidateName: "Student Two",
    reason: "FACE_MATCH_AMBIGUOUS",
    distance: 0.5,
    createdAt: 1234
  });
  assert.equal("faceDescriptor" in result.reviews[0], false);
});

test("face review resolution only permits pending requests and safe staff actions", async () => {
  const writes = [];
  const reviewRef = { id: "review-1" };
  const guardRef = { id: "global" };
  const db = {
    collection(name) {
      return {
        doc(id) {
          return name === "face_enrollment_reviews" ? { ...reviewRef, id } : { ...guardRef, id };
        }
      };
    },
    async runTransaction(callback) {
      return callback({
        get: async (ref) => ({
          exists: true,
          data: () => ref.id === "review-1" ? { status: "PENDING" } : { revision: 4 }
        }),
        update: (ref, value) => writes.push({ type: "update", ref, value }),
        set: (ref, value, options) => writes.push({ type: "set", ref, value, options })
      });
    }
  };
  const admin = {
    firestore: {
      FieldValue: {
        delete: () => "DELETE",
        serverTimestamp: () => "SERVER_TIMESTAMP"
      }
    }
  };

  await assert.rejects(
    resolveFaceEnrollmentReview(db, admin, { uid: "student-uid", isStaff: false }, {
      requestId: "review-1",
      action: "RECAPTURE_REQUIRED"
    }),
    (error) => error.status === 403
  );
  await assert.rejects(
    resolveFaceEnrollmentReview(db, admin, { uid: "lecturer-uid", isStaff: true }, {
      requestId: "review-1",
      action: "APPROVE"
    }),
    (error) => error.status === 400
  );

  const result = await resolveFaceEnrollmentReview(
    db,
    admin,
    { uid: "lecturer-uid", isStaff: true },
    { requestId: "review-1", action: "RECAPTURE_REQUIRED" }
  );
  assert.deepEqual(result, { success: true, status: "RECAPTURE_REQUIRED" });
  assert.equal(writes[0].value.status, "RECAPTURE_REQUIRED");
  assert.equal(writes[0].value.faceDescriptor, "DELETE");
  assert.equal(writes[0].value.reviewedBy, "lecturer-uid");
  assert.equal(writes[1].value.revision, 5);
});
