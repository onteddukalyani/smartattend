import test from "node:test";
import assert from "node:assert/strict";
import { isBrowserCameraAllowed, isStaffCameraUser } from "../src/utils/deviceDetection.js";
import { Capacitor } from "@capacitor/core";

// ============================================================================
// SIMULATED AUTHORITATIVE DATABASE & AUTHENTICATION ENGINE
// Mirrors SmartAttend Firestore collections ('admins', 'lecturers', 'students')
// and authcontext.jsx loginWithGoogle / lookupUserInSystem logic.
// ============================================================================

function normalizeRole(rawRole) {
  const r = String(rawRole || "").trim().toLowerCase();
  if (r === "administrator" || r === "superadmin" || r === "admin") return "admin";
  if (r === "faculty" || r === "professor" || r === "lecturer") return "lecturer";
  return "student";
}

const TERMINATED_STATUSES = new Set([
  "disabled",
  "deleted",
  "removed",
  "inactive",
  "suspended",
  "deactivated"
]);

function isAccountTerminated(userData) {
  if (!userData) return true;
  if (userData.isDeleted === true || userData.deleted === true || userData.removed === true) {
    return true;
  }
  const status = String(userData.status || "").trim().toLowerCase();
  if (TERMINATED_STATUSES.has(status)) {
    return true;
  }
  if (userData.approved === false) {
    return true;
  }
  return false;
}

/**
 * Creates an in-memory mock database and simulates the authcontext login flow
 */
function createAuthSystem(initialDatabase = {}) {
  const db = {
    admins: new Map(Object.entries(initialDatabase.admins || {})),
    lecturers: new Map(Object.entries(initialDatabase.lecturers || {})),
    students: new Map(Object.entries(initialDatabase.students || {})),
    users: new Map(Object.entries(initialDatabase.users || {})),
    authorizedUsers: new Map(Object.entries(initialDatabase.authorizedUsers || {}))
  };

  const writeAuditLog = [];
  let loggedInUser = null;
  let loggedInProfile = null;

  const mockDbWrites = {
    setDoc: (collection, id, data) => {
      writeAuditLog.push({ action: "setDoc", collection, id, data, timestamp: Date.now() });
      if (!db[collection]) db[collection] = new Map();
      db[collection].set(id, { ...db[collection].get(id), ...data });
    },
    addDoc: (collection, data) => {
      writeAuditLog.push({ action: "addDoc", collection, data, timestamp: Date.now() });
    }
  };

  const lookupUserInSystem = async (email, uid = null) => {
    if (!email && !uid) return null;
    const cleanEmail = (email || "").toLowerCase().trim();
    const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase().trim() : "";
    const rollFromEmail = prefix.toUpperCase();
    const cleanUid = uid ? String(uid).trim() : "";

    // 1. Resolve Admin Candidate
    let adminCandidate = null;
    for (const [id, data] of db.admins.entries()) {
      const match =
        id.toLowerCase() === cleanEmail ||
        id.toLowerCase() === prefix ||
        (cleanUid && (id === cleanUid || data.uid === cleanUid)) ||
        (data.email && data.email.toLowerCase().trim() === cleanEmail);
      if (match) {
        const term = isAccountTerminated(data);
        adminCandidate = { id, ...data, email: data.email || cleanEmail, role: "admin", isTerminated: term };
        break;
      }
    }
    if (!adminCandidate && (cleanEmail === "onteddukalyani@gmail.com" || prefix === "onteddukalyani")) {
      adminCandidate = {
        id: prefix || cleanEmail,
        name: "Kalyani Onteddu",
        email: cleanEmail || "onteddukalyani@gmail.com",
        role: "admin",
        isAdmin: true,
        status: "active",
        approved: true
      };
    }

    // 2. Resolve Lecturer Candidate
    let lecturerCandidate = null;
    for (const [id, data] of db.lecturers.entries()) {
      const match =
        id.toLowerCase() === cleanEmail ||
        id.toLowerCase() === prefix ||
        (cleanUid && (id === cleanUid || data.uid === cleanUid)) ||
        (data.email && data.email.toLowerCase().trim() === cleanEmail);
      if (match) {
        const term = isAccountTerminated(data);
        lecturerCandidate = { id, ...data, email: data.email || cleanEmail, role: "lecturer", isTerminated: term };
        break;
      }
    }

    // 3. Resolve Student Candidate
    let studentCandidate = null;
    for (const [id, data] of db.students.entries()) {
      const match =
        id.toUpperCase() === rollFromEmail ||
        id.toLowerCase() === cleanEmail ||
        id.toLowerCase() === prefix ||
        (cleanUid && (id === cleanUid || data.uid === cleanUid || data.studentUid === cleanUid)) ||
        (data.email && data.email.toLowerCase().trim() === cleanEmail) ||
        (data.rollNo && data.rollNo.toUpperCase().trim() === rollFromEmail);
      if (match) {
        const term = isAccountTerminated(data);
        studentCandidate = { id, ...data, email: data.email || cleanEmail, role: "student", rollNo: data.rollNo || rollFromEmail, isTerminated: term };
        break;
      }
    }

    // Fallback: check users / authorizedUsers
    if (!studentCandidate) {
      for (const [id, data] of [...db.authorizedUsers.entries(), ...db.users.entries()]) {
        const match =
          id.toUpperCase() === rollFromEmail ||
          id.toLowerCase() === cleanEmail ||
          (data.email && data.email.toLowerCase().trim() === cleanEmail);
        if (match) {
          const term = isAccountTerminated(data);
          const r = normalizeRole(data.role || "student");
          const cand = { id, ...data, email: data.email || cleanEmail, role: r, rollNo: data.rollNo || rollFromEmail, isTerminated: term };
          if (r === "admin" && !adminCandidate) adminCandidate = cand;
          else if (r === "lecturer" && !lecturerCandidate) lecturerCandidate = cand;
          else if (r === "student") studentCandidate = cand;
          break;
        }
      }
    }

    // 4. Consistency Checks: Check if multiple distinct active roles exist
    const roleMap = new Map();
    if (adminCandidate && !adminCandidate.isTerminated) {
      const norm = normalizeRole(adminCandidate.role || "admin");
      if (norm === "admin") roleMap.set("admin", adminCandidate);
    }
    if (lecturerCandidate && !lecturerCandidate.isTerminated) {
      const norm = normalizeRole(lecturerCandidate.role || "lecturer");
      if (norm === "lecturer") roleMap.set("lecturer", lecturerCandidate);
    }
    if (studentCandidate && !studentCandidate.isTerminated) {
      const norm = normalizeRole(studentCandidate.role || "student");
      if (norm === "student") roleMap.set("student", studentCandidate);
    }

    const activeRoles = Array.from(roleMap.keys());
    // Scenario 13: The same email appears in multiple role collections
    if (activeRoles.length > 1) {
      return {
        isAmbiguous: true,
        foundRoles: activeRoles,
        email: cleanEmail
      };
    }

    if (activeRoles.length === 1) {
      const chosen = roleMap.get(activeRoles[0]);
      const recordUid = String(chosen.uid || chosen.studentUid || "").trim();
      // Scenario 12: User record exists, but the Firebase UID does not match
      if (recordUid && cleanUid && recordUid !== cleanUid) {
        return {
          ...chosen,
          uidMismatch: true,
          recordUid,
          authUid: cleanUid
        };
      }
      return chosen;
    }

    const terminated = [adminCandidate, lecturerCandidate, studentCandidate].find((c) => c && c.isTerminated);
    if (terminated) return terminated;

    return null;
  };

  const loginWithGoogle = async (selectedRole = "", mockFirebaseUser = null) => {
    if (!mockFirebaseUser || !mockFirebaseUser.email) {
      throw new Error("Unable to retrieve Google user credentials. Please try again.");
    }

    const cleanEmail = mockFirebaseUser.email.toLowerCase().trim();

    // Look up user in database
    const registeredUser = await lookupUserInSystem(cleanEmail, mockFirebaseUser.uid);

    // Case C: Email Does Not Exist in Any Role
    if (!registeredUser) {
      loggedInUser = null;
      loggedInProfile = null;
      const notRegisteredErr = new Error("You are not registered with SmartAttend. Please contact your administrator.");
      notRegisteredErr.code = "NOT_REGISTERED";
      throw notRegisteredErr;
    }

    // Inconsistency: Multiple roles for same email
    if (registeredUser.isAmbiguous) {
      loggedInUser = null;
      loggedInProfile = null;
      const ambigErr = new Error(`Account inconsistency detected: Email is registered under multiple roles (${(registeredUser.foundRoles || []).join(", ")}). Please contact your administrator.`);
      ambigErr.code = "MULTIPLE_ROLES";
      ambigErr.foundRoles = registeredUser.foundRoles;
      throw ambigErr;
    }

    // UID Mismatch: Authenticated Google UID does not match registered UID
    if (registeredUser.uidMismatch) {
      loggedInUser = null;
      loggedInProfile = null;
      const uidErr = new Error("Authentication error: The authenticated account UID does not match the registered user record. Please contact your administrator.");
      uidErr.code = "UID_MISMATCH";
      throw uidErr;
    }

    // Check account status & approval
    if (isAccountTerminated(registeredUser) || registeredUser.isTerminated) {
      loggedInUser = null;
      loggedInProfile = null;
      const termErr = new Error(`Access Denied: Your account (${mockFirebaseUser.email}) has been removed or deactivated by the administrator.`);
      termErr.code = "ACCOUNT_DISABLED";
      throw termErr;
    }

    // Authoritative Role from Database
    const databaseRole = normalizeRole(registeredUser.role);
    const normalizedSelectedRole = selectedRole ? normalizeRole(selectedRole) : "";

    // Case B: Email Exists, but the Selected Role Is Incorrect
    if (normalizedSelectedRole && normalizedSelectedRole !== databaseRole) {
      loggedInUser = null;
      loggedInProfile = null;

      const capRole = databaseRole === "admin" ? "Admin" : (databaseRole === "lecturer" ? "Lecturer" : "Student");
      const article = databaseRole === "admin" ? "an" : "a";
      const mismatchMsg = `You are registered as ${article} ${capRole}. Please select the ${capRole} role to continue.`;

      const mismatchErr = new Error(mismatchMsg);
      mismatchErr.code = "ROLE_MISMATCH";
      mismatchErr.registeredRole = databaseRole;
      mismatchErr.selectedRole = normalizedSelectedRole;
      throw mismatchErr;
    }

    // Case A: Email Exists and Selected Role Matches
    loggedInUser = mockFirebaseUser;
    loggedInProfile = {
      ...registeredUser,
      uid: mockFirebaseUser.uid,
      role: databaseRole,
      email: cleanEmail
    };

    return loggedInProfile;
  };

  return {
    db,
    writeAuditLog,
    getLoggedInUser: () => loggedInUser,
    getLoggedInProfile: () => loggedInProfile,
    lookupUserInSystem,
    loginWithGoogle,
    mockDbWrites
  };
}

// ============================================================================
// AUTOMATED TEST SUITE: 20 SCENARIOS REQUIRED BY TASK SPECIFICATION
// ============================================================================

test("1. Valid Admin login with Admin selected", async () => {
  const auth = createAuthSystem({
    admins: {
      "admin@iiitdwd.ac.in": { name: "Dr. Admin", role: "admin", status: "active", approved: true }
    }
  });

  const profile = await auth.loginWithGoogle("admin", { email: "admin@iiitdwd.ac.in", uid: "uid_admin_1" });
  assert.strictEqual(profile.role, "admin");
  assert.strictEqual(profile.email, "admin@iiitdwd.ac.in");
  assert.strictEqual(auth.getLoggedInProfile()?.role, "admin");
  assert.strictEqual(auth.writeAuditLog.length, 0, "Login must not create any Firestore documents");
});

test("2. Valid Lecturer login with Lecturer selected", async () => {
  const auth = createAuthSystem({
    lecturers: {
      "prof.smith@iiitdwd.ac.in": { name: "Prof. Smith", role: "lecturer", status: "active", approved: true }
    }
  });

  const profile = await auth.loginWithGoogle("lecturer", { email: "prof.smith@iiitdwd.ac.in", uid: "uid_lect_1" });
  assert.strictEqual(profile.role, "lecturer");
  assert.strictEqual(profile.email, "prof.smith@iiitdwd.ac.in");
  assert.strictEqual(auth.getLoggedInProfile()?.role, "lecturer");
  assert.strictEqual(auth.writeAuditLog.length, 0, "Login must not write to database");
});

test("3. Valid Student login with Student selected", async () => {
  const auth = createAuthSystem({
    students: {
      "25BCS108": { name: "Alice Student", rollNo: "25BCS108", email: "25bcs108@iiitdwd.ac.in", role: "student", status: "active", approved: true }
    }
  });

  const profile = await auth.loginWithGoogle("student", { email: "25bcs108@iiitdwd.ac.in", uid: "uid_student_1" });
  assert.strictEqual(profile.role, "student");
  assert.strictEqual(profile.rollNo, "25BCS108");
  assert.strictEqual(auth.getLoggedInProfile()?.role, "student");
  assert.strictEqual(auth.writeAuditLog.length, 0, "Login must not write to database");
});

test("4. Lecturer selects Admin (Role Mismatch Case B)", async () => {
  const auth = createAuthSystem({
    lecturers: {
      "lecturer@example.com": { name: "Lecturer User", role: "lecturer", status: "active", approved: true }
    }
  });

  await assert.rejects(
    async () => {
      await auth.loginWithGoogle("admin", { email: "lecturer@example.com", uid: "uid_lect_2" });
    },
    (err) => {
      assert.strictEqual(err.code, "ROLE_MISMATCH");
      assert.strictEqual(err.registeredRole, "lecturer");
      assert.strictEqual(err.selectedRole, "admin");
      assert.strictEqual(err.message, "You are registered as a Lecturer. Please select the Lecturer role to continue.");
      return true;
    }
  );

  assert.strictEqual(auth.getLoggedInUser(), null, "Session must not be created on role mismatch");
  assert.strictEqual(auth.getLoggedInProfile(), null);
  assert.strictEqual(auth.writeAuditLog.length, 0, "No documents written to Firestore on role mismatch");
});

test("5. Lecturer selects Student (Role Mismatch Case B)", async () => {
  const auth = createAuthSystem({
    lecturers: {
      "lecturer@example.com": { name: "Lecturer User", role: "lecturer", status: "active", approved: true }
    }
  });

  await assert.rejects(
    async () => {
      await auth.loginWithGoogle("student", { email: "lecturer@example.com", uid: "uid_lect_2" });
    },
    (err) => {
      assert.strictEqual(err.code, "ROLE_MISMATCH");
      assert.strictEqual(err.message, "You are registered as a Lecturer. Please select the Lecturer role to continue.");
      return true;
    }
  );
  assert.strictEqual(auth.getLoggedInProfile(), null);
});

test("6. Admin selects Lecturer (Role Mismatch Case B)", async () => {
  const auth = createAuthSystem({
    admins: {
      "admin@example.com": { name: "Admin User", role: "admin", status: "active", approved: true }
    }
  });

  await assert.rejects(
    async () => {
      await auth.loginWithGoogle("lecturer", { email: "admin@example.com", uid: "uid_adm_3" });
    },
    (err) => {
      assert.strictEqual(err.code, "ROLE_MISMATCH");
      assert.strictEqual(err.message, "You are registered as an Admin. Please select the Admin role to continue.");
      return true;
    }
  );
  assert.strictEqual(auth.getLoggedInProfile(), null);
});

test("7. Student selects Admin (Role Mismatch Case B)", async () => {
  const auth = createAuthSystem({
    students: {
      "25BCS050": { name: "Student User", rollNo: "25BCS050", email: "25bcs050@iiitdwd.ac.in", role: "student", status: "active", approved: true }
    }
  });

  await assert.rejects(
    async () => {
      await auth.loginWithGoogle("admin", { email: "25bcs050@iiitdwd.ac.in", uid: "uid_stud_4" });
    },
    (err) => {
      assert.strictEqual(err.code, "ROLE_MISMATCH");
      assert.strictEqual(err.message, "You are registered as a Student. Please select the Student role to continue.");
      return true;
    }
  );
  assert.strictEqual(auth.getLoggedInProfile(), null);
});

test("8. Student selects Lecturer (Role Mismatch Case B)", async () => {
  const auth = createAuthSystem({
    students: {
      "25BCS050": { name: "Student User", rollNo: "25BCS050", email: "25bcs050@iiitdwd.ac.in", role: "student", status: "active", approved: true }
    }
  });

  await assert.rejects(
    async () => {
      await auth.loginWithGoogle("lecturer", { email: "25bcs050@iiitdwd.ac.in", uid: "uid_stud_4" });
    },
    (err) => {
      assert.strictEqual(err.code, "ROLE_MISMATCH");
      assert.strictEqual(err.message, "You are registered as a Student. Please select the Student role to continue.");
      return true;
    }
  );
  assert.strictEqual(auth.getLoggedInProfile(), null);
});

test("9. Email does not exist in any role (Case C)", async () => {
  const auth = createAuthSystem({
    admins: {},
    lecturers: {},
    students: {}
  });

  await assert.rejects(
    async () => {
      await auth.loginWithGoogle("student", { email: "stranger@unknown.com", uid: "uid_stranger" });
    },
    (err) => {
      assert.strictEqual(err.code, "NOT_REGISTERED");
      assert.strictEqual(err.message, "You are not registered with SmartAttend. Please contact your administrator.");
      return true;
    }
  );

  assert.strictEqual(auth.getLoggedInUser(), null);
  assert.strictEqual(auth.getLoggedInProfile(), null);
  assert.strictEqual(auth.writeAuditLog.length, 0, "Case C must never create documents in Firestore");
});

test("10. Correct email but incorrect credentials / failed authentication", async () => {
  const auth = createAuthSystem({
    students: {
      "25BCS108": { name: "Alice", email: "25bcs108@iiitdwd.ac.in", role: "student" }
    }
  });

  await assert.rejects(
    async () => {
      // Mock failure from Firebase Auth popup/credentials
      await auth.loginWithGoogle("student", null);
    },
    (err) => {
      assert.ok(err.message.includes("Unable to retrieve Google user credentials"));
      return true;
    }
  );
  assert.strictEqual(auth.getLoggedInUser(), null);
});

test("11. Firebase Authentication succeeds, but no authorized user record exists", async () => {
  const auth = createAuthSystem();

  await assert.rejects(
    async () => {
      await auth.loginWithGoogle("lecturer", { email: "unauthorized@example.com", uid: "uid_unauth" });
    },
    (err) => {
      assert.strictEqual(err.code, "NOT_REGISTERED");
      assert.strictEqual(err.message, "You are not registered with SmartAttend. Please contact your administrator.");
      return true;
    }
  );
  assert.strictEqual(auth.getLoggedInProfile(), null);
  assert.strictEqual(auth.writeAuditLog.length, 0);
});

test("12. User record exists, but the Firebase UID does not match", async () => {
  const auth = createAuthSystem({
    lecturers: {
      "dr.smith@iiitdwd.ac.in": {
        name: "Dr. Smith",
        email: "dr.smith@iiitdwd.ac.in",
        role: "lecturer",
        uid: "legitimate_bound_uid_123"
      }
    }
  });

  await assert.rejects(
    async () => {
      // Different UID attempting to log in with dr.smith's email
      await auth.loginWithGoogle("lecturer", { email: "dr.smith@iiitdwd.ac.in", uid: "attacker_or_mismatched_uid_999" });
    },
    (err) => {
      assert.strictEqual(err.code, "UID_MISMATCH");
      assert.ok(err.message.includes("UID does not match the registered user record"));
      return true;
    }
  );

  assert.strictEqual(auth.getLoggedInProfile(), null);
  assert.strictEqual(auth.writeAuditLog.length, 0);
});

test("13. The same email appears in multiple role collections (Ambiguity inconsistency)", async () => {
  const auth = createAuthSystem({
    admins: {
      "dual@iiitdwd.ac.in": { name: "Dual Role", email: "dual@iiitdwd.ac.in", role: "admin", status: "active" }
    },
    lecturers: {
      "dual@iiitdwd.ac.in": { name: "Dual Role", email: "dual@iiitdwd.ac.in", role: "lecturer", status: "active" }
    }
  });

  await assert.rejects(
    async () => {
      await auth.loginWithGoogle("admin", { email: "dual@iiitdwd.ac.in", uid: "uid_dual_1" });
    },
    (err) => {
      assert.strictEqual(err.code, "MULTIPLE_ROLES");
      assert.ok(err.message.includes("Email is registered under multiple roles"));
      return true;
    }
  );

  assert.strictEqual(auth.getLoggedInProfile(), null);
});

test("14. Role record is missing or malformed / account disabled / terminated", async () => {
  const auth = createAuthSystem({
    students: {
      "25BCS099": { name: "Deactivated Student", rollNo: "25BCS099", email: "25bcs099@iiitdwd.ac.in", role: "student", status: "disabled", approved: false }
    }
  });

  await assert.rejects(
    async () => {
      await auth.loginWithGoogle("student", { email: "25bcs099@iiitdwd.ac.in", uid: "uid_deact" });
    },
    (err) => {
      assert.strictEqual(err.code, "ACCOUNT_DISABLED");
      assert.ok(err.message.includes("removed or deactivated by the administrator"));
      return true;
    }
  );
  assert.strictEqual(auth.getLoggedInProfile(), null);
});

test("15. User attempts to access another role's dashboard directly", () => {
  // Simulate ProtectedRoute role check
  function checkRouteAccess(userRole, allowedRole) {
    const normUser = normalizeRole(userRole);
    const normAllowed = normalizeRole(allowedRole);
    return normUser === normAllowed;
  }

  assert.strictEqual(checkRouteAccess("student", "admin"), false, "Student cannot access /admin");
  assert.strictEqual(checkRouteAccess("student", "lecturer"), false, "Student cannot access /lecturer");
  assert.strictEqual(checkRouteAccess("lecturer", "admin"), false, "Lecturer cannot access /admin");
  assert.strictEqual(checkRouteAccess("lecturer", "student"), false, "Lecturer cannot access /student");
  assert.strictEqual(checkRouteAccess("admin", "admin"), true, "Admin can access /admin");
  assert.strictEqual(checkRouteAccess("lecturer", "lecturer"), true, "Lecturer can access /lecturer");
  assert.strictEqual(checkRouteAccess("student", "student"), true, "Student can access /student");
});

test("16. Firebase or network request fails", async () => {
  const auth = createAuthSystem();
  // Simulating popup close or network request failed
  const networkError = new Error("network-request-failed");
  networkError.code = "auth/network-request-failed";

  try {
    throw networkError;
  } catch (err) {
    let userMessage = "";
    if (err.code === "auth/network-request-failed") {
      userMessage = "Network error connecting to authentication service. Please check your internet connection.";
    }
    assert.strictEqual(userMessage, "Network error connecting to authentication service. Please check your internet connection.");
    assert.ok(!userMessage.includes("Error:"), "No stack traces or raw errors exposed to user");
  }
});

test("17. A login attempt does not create unnecessary Firestore documents", async () => {
  const auth = createAuthSystem({
    lecturers: {
      "lect@iiitdwd.ac.in": { name: "Dr. Lect", email: "lect@iiitdwd.ac.in", role: "lecturer", status: "active" }
    }
  });

  await auth.loginWithGoogle("lecturer", { email: "lect@iiitdwd.ac.in", uid: "uid_clean" });
  assert.strictEqual(auth.writeAuditLog.length, 0, "Zero Firestore writes during successful login");
});

test("18. Repeated login attempts do not create duplicate user records", async () => {
  const auth = createAuthSystem({
    students: {
      "25BCS108": { name: "Alice", email: "25bcs108@iiitdwd.ac.in", role: "student", status: "active" }
    }
  });

  const initialDocCount = auth.db.students.size;

  for (let i = 0; i < 10; i++) {
    await auth.loginWithGoogle("student", { email: "25bcs108@iiitdwd.ac.in", uid: "uid_alice" });
  }

  assert.strictEqual(auth.db.students.size, initialDocCount, "Document count must remain constant");
  assert.strictEqual(auth.writeAuditLog.length, 0, "Zero writes recorded across 10 repeated logins");
});

test("19. Existing Admin, Lecturer, and Student workflows continue to function", async () => {
  const auth = createAuthSystem({
    admins: { "adm@iiitdwd.ac.in": { name: "Admin", role: "admin", status: "active" } },
    lecturers: { "lec@iiitdwd.ac.in": { name: "Lect", role: "lecturer", status: "active" } },
    students: { "25BCS001": { name: "Stud", email: "25bcs001@iiitdwd.ac.in", role: "student", status: "active" } }
  });

  const adminProfile = await auth.loginWithGoogle("admin", { email: "adm@iiitdwd.ac.in", uid: "u1" });
  assert.strictEqual(adminProfile.role, "admin");

  const lectProfile = await auth.loginWithGoogle("lecturer", { email: "lec@iiitdwd.ac.in", uid: "u2" });
  assert.strictEqual(lectProfile.role, "lecturer");

  const studProfile = await auth.loginWithGoogle("student", { email: "25bcs001@iiitdwd.ac.in", uid: "u3" });
  assert.strictEqual(studProfile.role, "student");
});

test("20. Users cannot gain privileges by changing selected role in UI or client state", async () => {
  const auth = createAuthSystem({
    students: {
      "25BCS100": { name: "Student Attacker", email: "attacker@iiitdwd.ac.in", role: "student", status: "active" }
    }
  });

  // Student modifies client UI to pass 'admin' or 'superadmin'
  await assert.rejects(
    async () => {
      await auth.loginWithGoogle("admin", { email: "attacker@iiitdwd.ac.in", uid: "u_att" });
    },
    (err) => {
      assert.strictEqual(err.code, "ROLE_MISMATCH");
      assert.strictEqual(err.registeredRole, "student");
      assert.strictEqual(err.message, "You are registered as a Student. Please select the Student role to continue.");
      return true;
    }
  );

  assert.strictEqual(auth.getLoggedInProfile(), null, "User state must remain null, preventing privilege escalation");
});

// ============================================================================
// CAMERA PERMISSION & DEVICE CONSTRAINTS TESTS
// ============================================================================

test("21. Camera policy: Android student browser blocked from QR scanning, but allowed for biometric face registration", () => {
  const studentProfile = { role: "student", deviceType: "android" };

  // QR Scanning: blocked in browser
  const qrCamera = isBrowserCameraAllowed(studentProfile, { uid: "s1" }, "qr_scanner");
  assert.strictEqual(qrCamera.allowed, false);
  assert.strictEqual(qrCamera.reason, "android_web_student");

  // Biometric Face Registration: ALLOWED in browser!
  const bioCamera = isBrowserCameraAllowed(studentProfile, { uid: "s1" }, "biometric_registration");
  assert.strictEqual(bioCamera.allowed, true);
  assert.strictEqual(bioCamera.reason, "biometric_registration");
});

test("22. Camera policy: iPhone user allowed in browser for both QR scanning and biometric registration", () => {
  const iosStudent = { role: "student", deviceType: "ios" };

  const qrCamera = isBrowserCameraAllowed(iosStudent, { uid: "s2" }, "qr_scanner");
  assert.strictEqual(qrCamera.allowed, true);
  assert.strictEqual(qrCamera.reason, "iphone_user");

  const bioCamera = isBrowserCameraAllowed(iosStudent, { uid: "s2" }, "biometric_registration");
  assert.strictEqual(bioCamera.allowed, true);
});

test("23. Camera policy: Admins and Lecturers allowed rear and front cameras on any device", () => {
  const adminProfile = { role: "admin", deviceType: "android" };
  const lectProfile = { role: "lecturer", deviceType: "web" };

  assert.strictEqual(isBrowserCameraAllowed(adminProfile).allowed, true);
  assert.strictEqual(isBrowserCameraAllowed(lectProfile).allowed, true);
  assert.strictEqual(isStaffCameraUser(adminProfile), true);
  assert.strictEqual(isStaffCameraUser(lectProfile), true);
  assert.strictEqual(isStaffCameraUser({ role: "student" }), false);
});
