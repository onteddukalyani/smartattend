import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import admin from "firebase-admin";
import { registerFaceEnrollment } from "../server/faceEnrollment.js";

function randomFaceVector() {
  return Array.from(crypto.randomBytes(128), (value) => ((value / 255) * 2 - 1) * 0.4);
}

test("face enrollment transactions serialize duplicate registrations and preserve existing enrollments", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST
}, async () => {
  const projectId = process.env.GCLOUD_PROJECT || "demo-smartattend";
  const app = admin.initializeApp({ projectId }, `face-enrollment-test-${crypto.randomUUID()}`);
  const db = app.firestore();
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const rollNos = [`TEST-FACE-A-${suffix}`, `TEST-FACE-B-${suffix}`];
  const initialFace = randomFaceVector();
  const nearDuplicate = initialFace.map((value, index) => value + Math.cos(index) * 0.001);
  const replacementFace = randomFaceVector();
  const staff = {
    uid: `test-admin-${suffix}`,
    email: `test-admin-${suffix}@example.invalid`,
    emailPrefix: `test-admin-${suffix}`,
    isStaff: true,
    isAdmin: true
  };

  try {
    await Promise.all(rollNos.map((rollNo) =>
      db.collection("students").doc(rollNo).set({ rollNo, name: rollNo })
    ));

    const concurrentResults = await Promise.allSettled([
      registerFaceEnrollment(db, admin, staff, { rollNo: rollNos[0], faceDescriptor: initialFace }),
      registerFaceEnrollment(db, admin, staff, { rollNo: rollNos[1], faceDescriptor: nearDuplicate })
    ]);
    const accepted = concurrentResults.filter((result) => result.status === "fulfilled");
    const rejected = concurrentResults.filter((result) => result.status === "rejected");
    assert.equal(accepted.length, 1, "Only one concurrent enrollment may claim the same face");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, "already-exists");

    const winnerRoll = accepted[0].value.rollNo;
    const loserRoll = rollNos.find((rollNo) => rollNo !== winnerRoll);
    const winnerRef = db.collection("face_enrollments").doc(winnerRoll);
    const oldEnrollment = (await winnerRef.get()).data();
    assert.equal(oldEnrollment.status, "ACTIVE");

    await registerFaceEnrollment(db, admin, staff, {
      rollNo: winnerRoll,
      faceDescriptor: replacementFace
    });
    const replacement = (await winnerRef.get()).data();
    assert.deepEqual(replacement.faceDescriptor, replacementFace);

    await assert.rejects(
      registerFaceEnrollment(db, admin, staff, {
        rollNo: loserRoll,
        faceDescriptor: replacementFace
      }),
      (error) => error.code === "already-exists"
    );
    assert.deepEqual((await winnerRef.get()).data().faceDescriptor, replacementFace);
    assert.equal((await db.collection("face_enrollments").doc(loserRoll).get()).exists, false);
  } finally {
    const auditLogs = await db.collection("biometric_audit_logs")
      .where("rollNo", "in", rollNos)
      .get();
    const cleanup = db.batch();
    for (const rollNo of rollNos) {
      cleanup.delete(db.collection("students").doc(rollNo));
      cleanup.delete(db.collection("face_enrollments").doc(rollNo));
    }
    for (const log of auditLogs.docs) cleanup.delete(log.ref);
    await cleanup.commit();
    await app.delete();
  }
});
