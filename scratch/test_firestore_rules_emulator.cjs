/**
 * Local Firestore Emulator Rules Verification Script
 * Uses the Firestore Emulator's HTTP REST API to execute requests under different auth contexts
 * and verify that firestore.rules correctly permits or denies operations.
 */

const http = require("http");
const assert = require("assert");

const EMULATOR_HOST = "127.0.0.1";
const EMULATOR_PORT = process.env.FIRESTORE_EMULATOR_PORT || 8088;
const PROJECT_ID = process.env.GCLOUD_PROJECT || "smart-attendance-ok";

function createMockJwt(userId, email, role) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    user_id: userId,
    uid: userId,
    email: email,
    role: role,
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    auth_time: Math.floor(Date.now() / 1000)
  })).toString("base64url");
  return `${header}.${payload}.`;
}

function makeRequest({ method, path, auth, body }) {
  return new Promise((resolve, reject) => {
    const headers = {
      "Content-Type": "application/json"
    };

    if (auth === "admin") {
      headers["Authorization"] = "Bearer owner";
    } else if (auth && typeof auth === "object") {
      const jwt = createMockJwt(auth.user_id, auth.email, auth.role);
      headers["Authorization"] = `Bearer ${jwt}`;
    }

    const dataString = body ? JSON.stringify(body) : "";
    if (dataString) {
      headers["Content-Length"] = Buffer.byteLength(dataString);
    }

    const req = http.request(
      {
        hostname: EMULATOR_HOST,
        port: EMULATOR_PORT,
        path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`,
        method: method,
        headers: headers
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(responseBody);
          } catch (_) {
            parsed = responseBody;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );

    req.on("error", (err) => reject(err));
    if (dataString) {
      req.write(dataString);
    }
    req.end();
  });
}

async function main() {
  console.log(`\n================================================================================`);
  console.log(`  FIREBASE FIRESTORE EMULATOR RUNTIME RULES VERIFICATION`);
  console.log(`  Target: http://${EMULATOR_HOST}:${EMULATOR_PORT} (Project: ${PROJECT_ID})`);
  console.log(`================================================================================\n`);

  let passedCount = 0;
  let totalCount = 0;

  async function test(name, fn) {
    totalCount++;
    try {
      await fn();
      passedCount++;
      console.log(`  ✓ [EMULATOR PASSED] ${name}`);
    } catch (err) {
      console.error(`  ✗ [EMULATOR FAILED] ${name}: ${err.message}`);
      throw err;
    }
  }

  // Set up test documents via admin credentials (bypasses rules)
  const sessionId = "sess_emulator_test_101";
  const lecturerUid = "lecturer_alice";
  const studentUid = "student_bob";
  const otherStudentUid = "student_charlie";

  // 0. Seed a session doc as admin
  const seedRes = await makeRequest({
    method: "PATCH",
    path: `attendance_sessions/${sessionId}`,
    auth: "admin",
    body: {
      fields: {
        ownerId: { stringValue: lecturerUid },
        ownerEmail: { stringValue: "alice@college.edu" },
        kioskEndsAt: { integerValue: "1800000" },
        active: { booleanValue: true },
        status: { stringValue: "ACTIVE" },
        authorizedCount: { integerValue: "0" }
      }
    }
  });

  // Test 1: Unauthenticated user CANNOT read session doc
  await test("1. Unauthenticated read of /attendance_sessions is DENIED (403)", async () => {
    const res = await makeRequest({
      method: "GET",
      path: `attendance_sessions/${sessionId}`,
      auth: null
    });
    assert.strictEqual(res.status, 403, `Expected status 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 2: Authenticated student CAN read session doc
  await test("2. Authenticated student read of /attendance_sessions is ALLOWED (200)", async () => {
    const res = await makeRequest({
      method: "GET",
      path: `attendance_sessions/${sessionId}`,
      auth: { user_id: studentUid, email: "bob@student.college.edu" }
    });
    assert.strictEqual(res.status, 200, `Expected status 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 3: Student attempting to update restricted key 'kioskEndsAt' is DENIED
  await test("3. Student updating security-sensitive key 'kioskEndsAt' is DENIED (403)", async () => {
    const res = await makeRequest({
      method: "PATCH",
      path: `attendance_sessions/${sessionId}?updateMask.fieldPaths=kioskEndsAt`,
      auth: { user_id: studentUid, email: "bob@student.college.edu" },
      body: {
        fields: {
          kioskEndsAt: { integerValue: "2500000" }
        }
      }
    });
    assert.strictEqual(res.status, 403, `Expected status 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 4: Student attempting to update session ownership 'ownerId' is DENIED
  await test("4. Student updating session ownership 'ownerId' is DENIED (403)", async () => {
    const res = await makeRequest({
      method: "PATCH",
      path: `attendance_sessions/${sessionId}?updateMask.fieldPaths=ownerId`,
      auth: { user_id: studentUid, email: "bob@student.college.edu" },
      body: {
        fields: {
          ownerId: { stringValue: studentUid }
        }
      }
    });
    assert.strictEqual(res.status, 403, `Expected status 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 5: Student updating legitimate non-restricted key 'authorizedCount' is ALLOWED
  await test("5. Student incrementing 'authorizedCount' on /attendance_sessions is ALLOWED (200)", async () => {
    const res = await makeRequest({
      method: "PATCH",
      path: `attendance_sessions/${sessionId}?updateMask.fieldPaths=authorizedCount`,
      auth: { user_id: studentUid, email: "bob@student.college.edu" },
      body: {
        fields: {
          authorizedCount: { integerValue: "1" }
        }
      }
    });
    assert.strictEqual(res.status, 200, `Expected status 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 6: Lecturer owner updating 'kioskEndsAt' is ALLOWED
  await test("6. Session owner lecturer updating 'kioskEndsAt' is ALLOWED (200)", async () => {
    const res = await makeRequest({
      method: "PATCH",
      path: `attendance_sessions/${sessionId}?updateMask.fieldPaths=kioskEndsAt`,
      auth: { user_id: lecturerUid, email: "alice@college.edu" },
      body: {
        fields: {
          kioskEndsAt: { integerValue: "2000000" }
        }
      }
    });
    assert.strictEqual(res.status, 200, `Expected status 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 7: Student writing to /attendance_sessions/{sessionId}/security/tokens is DENIED
  await test("7. Client write to /attendance_sessions/{id}/security/tokens is DENIED (403)", async () => {
    const res = await makeRequest({
      method: "PATCH",
      path: `attendance_sessions/${sessionId}/security/tokens`,
      auth: { user_id: studentUid, email: "bob@student.college.edu" },
      body: {
        fields: {
          qr1Token: { stringValue: "hacked_token" }
        }
      }
    });
    assert.strictEqual(res.status, 403, `Expected status 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 8: Client write to /attendance_sessions/{sessionId}/time_adjustments/adj1 is DENIED
  await test("8. Client write to /attendance_sessions/{id}/time_adjustments/adj1 is DENIED (403)", async () => {
    const res = await makeRequest({
      method: "PATCH",
      path: `attendance_sessions/${sessionId}/time_adjustments/adj1`,
      auth: { user_id: studentUid, email: "bob@student.college.edu" },
      body: {
        fields: {
          deltaSeconds: { integerValue: "60" }
        }
      }
    });
    assert.strictEqual(res.status, 403, `Expected status 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 9: Student writing own authorization document /authorizations/{studentUid} is ALLOWED
  await test("9. Student writing OWN authorization /authorizations/{studentUid} is ALLOWED (200)", async () => {
    const res = await makeRequest({
      method: "PATCH",
      path: `attendance_sessions/${sessionId}/authorizations/${studentUid}`,
      auth: { user_id: studentUid, email: "bob@student.college.edu" },
      body: {
        fields: {
          studentUid: { stringValue: studentUid },
          rollNo: { stringValue: "BOB01" },
          status: { stringValue: "QR1_VERIFIED" }
        }
      }
    });
    assert.strictEqual(res.status, 200, `Expected status 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 10: Student writing ANOTHER student's authorization /authorizations/{otherStudentUid} is DENIED
  await test("10. Student writing ANOTHER student's authorization /authorizations/{otherUid} is DENIED (403)", async () => {
    const res = await makeRequest({
      method: "PATCH",
      path: `attendance_sessions/${sessionId}/authorizations/${otherStudentUid}`,
      auth: { user_id: studentUid, email: "bob@student.college.edu" },
      body: {
        fields: {
          studentUid: { stringValue: otherStudentUid },
          status: { stringValue: "QR1_VERIFIED" }
        }
      }
    });
    assert.strictEqual(res.status, 403, `Expected status 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 11: Direct client creation of /attendance_records/{recordId} is DENIED
  await test("11. Direct client creation of /attendance_records/{recId} is DENIED (403)", async () => {
    const res = await makeRequest({
      method: "PATCH",
      path: `attendance_records/${sessionId}_${studentUid}`,
      auth: { user_id: studentUid, email: "bob@student.college.edu" },
      body: {
        fields: {
          status: { stringValue: "ATTENDED" },
          faceVerified: { booleanValue: true }
        }
      }
    });
    assert.strictEqual(res.status, 403, `Expected status 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 12: Direct client write to /biometric_credentials/{studentUid} is DENIED
  await test("12. Direct client write to /biometric_credentials/{studentUid} is DENIED (403)", async () => {
    const res = await makeRequest({
      method: "PATCH",
      path: `biometric_credentials/${studentUid}`,
      auth: { user_id: studentUid, email: "bob@student.college.edu" },
      body: {
        fields: {
          publicKey: { stringValue: "forged_key" }
        }
      }
    });
    assert.strictEqual(res.status, 403, `Expected status 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 13: Direct client write to /biometric_challenges/{chalId} is DENIED
  await test("13. Direct client write to /biometric_challenges/chal_1 is DENIED (403)", async () => {
    const res = await makeRequest({
      method: "PATCH",
      path: `biometric_challenges/chal_1`,
      auth: { user_id: studentUid, email: "bob@student.college.edu" },
      body: {
        fields: {
          challengeText: { stringValue: "forged_challenge" }
        }
      }
    });
    assert.strictEqual(res.status, 403, `Expected status 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  console.log(`\n================================================================================`);
  console.log(`  ALL ${passedCount}/${totalCount} EMULATOR TESTS PASSED SUCCESSFULLY!`);
  console.log(`================================================================================\n`);
}

main().catch((err) => {
  console.error("Emulator test failed:", err);
  process.exit(1);
});
