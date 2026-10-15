import assert from "node:assert";

console.log("=================================================================");
console.log("TEST SUITE: REAL-APP NOTIFICATION & ANNOUNCEMENT TARGETING ENGINE");
console.log("=================================================================\n");

// 1. TEST ROLE MATCHING FOR FACULTY (subscribeToFacultyNotifications)
function createFacultyRoleMatcher(roleFilter = "faculty", currentLecturerEmail = "") {
  const cleanLecturerEmail = String(currentLecturerEmail || "").toLowerCase().trim();
  const lecturerPrefix = cleanLecturerEmail ? cleanLecturerEmail.split("@")[0] : "";
  const filterRoleNorm = String(roleFilter).toLowerCase();

  return function isRoleMatching(n) {
    // 1. Direct targeted notification to specific lecturer
    const targetLecturer = String(n.targetLecturer || n.recipientEmail || "").toLowerCase().trim();
    if (targetLecturer) {
      if (!cleanLecturerEmail) return false;
      return targetLecturer === cleanLecturerEmail || targetLecturer === lecturerPrefix;
    }

    // 2. Direct student notifications should not appear in faculty announcements
    if (n.recipientRollNo && !n.targetRole && !n.targetRoles && n.recipientRole === "student") {
      return false;
    }

    // 3. Target role filtering
    const rawRoles = n.targetRoles || n.targetRole || [];
    const roles = Array.isArray(rawRoles)
      ? rawRoles.map(r => String(r).toLowerCase().trim())
      : (rawRoles ? [String(rawRoles).toLowerCase().trim()] : []);

    // Exclude notifications designated strictly for students only
    if (roles.length > 0 && roles.every(r => ["student", "students"].includes(r))) {
      return false;
    }

    if (roles.length === 0) return true;
    if (filterRoleNorm === "admin") {
      return roles.some(r => ["admin", "admins", "faculty", "all", "everyone", ""].includes(r));
    } else {
      return roles.some(r => ["lecturer", "lecturers", "faculty", "professors", "all", "everyone", ""].includes(r));
    }
  };
}

// 2. TEST ROLE MATCHING FOR STUDENTS (subscribeToStudentNotifications)
function createStudentMatcher(cleanRoll, rollPrefix, emailPrefix) {
  return function isStudentMatching(n) {
    const targetRoll = (n.studentRollNo || n.recipientRollNo || n.recipientRollPrefix || "").toUpperCase().trim();
    if (targetRoll) {
      return targetRoll === cleanRoll || targetRoll === rollPrefix || targetRoll === emailPrefix || targetRoll === "ALL";
    }
    const rawRoles = n.targetRoles || n.targetRole || [];
    const roles = Array.isArray(rawRoles)
      ? rawRoles.map(r => String(r).toLowerCase().trim())
      : (rawRoles ? [String(rawRoles).toLowerCase().trim()] : []);
    if (roles.length === 0) return true;
    return roles.some(r => ["student", "students", "all", "everyone", ""].includes(r));
  };
}

// 3. TEST PROFILE PHOTO RESOLUTION
function resolveProfilePhoto(registeredUser, currentUser) {
  const hasPhotoRemoval = Boolean(
    registeredUser.photoRemovedAt ||
    registeredUser.photoDeleted === true ||
    registeredUser.photoURL === "" ||
    registeredUser.photo === ""
  );

  const dbPhoto = registeredUser.photoURL || registeredUser.photo || registeredUser.image || registeredUser.avatar || registeredUser.profilePic || "";
  return hasPhotoRemoval
    ? ""
    : (dbPhoto || currentUser?.photoURL || currentUser?.providerData?.[0]?.photoURL || "");
}

// ==========================================
// TEST 1: Faculty Notification Filtering
// ==========================================
console.log("--- TEST 1: Faculty Notification Filtering ---");
const matchDrSmith = createFacultyRoleMatcher("lecturer", "dr.smith@university.edu");
const matchProfJones = createFacultyRoleMatcher("lecturer", "prof.jones@university.edu");
const matchAdmin = createFacultyRoleMatcher("admin", "admin@university.edu");

// Announcement for all students only
const studentAnnouncement = {
  id: "notif_1",
  title: "Exam Schedule for Students",
  targetRoles: ["student"],
  targetRole: "student"
};
assert.strictEqual(matchDrSmith(studentAnnouncement), false, "Lecturer should NOT receive student-only announcement");
assert.strictEqual(matchAdmin(studentAnnouncement), false, "Admin should NOT receive student-only announcement");

// Announcement for all campus
const campusAnnouncement = {
  id: "notif_2",
  title: "Campus Holiday",
  targetRoles: ["student", "lecturer", "faculty", "admin", "all"],
  targetRole: "all"
};
assert.strictEqual(matchDrSmith(campusAnnouncement), true, "Lecturer should receive all-campus announcement");
assert.strictEqual(matchAdmin(campusAnnouncement), true, "Admin should receive all-campus announcement");

// Direct Notice to Dr. Smith
const directSmithNotice = {
  id: "notif_3",
  title: "Department Meeting Memo",
  targetLecturer: "dr.smith@university.edu",
  targetRoles: ["lecturer"]
};
assert.strictEqual(matchDrSmith(directSmithNotice), true, "Dr. Smith should receive notice directed to him");
assert.strictEqual(matchProfJones(directSmithNotice), false, "Prof. Jones should NOT receive notice directed to Dr. Smith");

// Direct Notice to a Student
const studentDirectNotice = {
  id: "notif_4",
  title: "Profile Photo Removed",
  recipientRollNo: "25BCS001",
  recipientRole: "student"
};
assert.strictEqual(matchDrSmith(studentDirectNotice), false, "Faculty should not receive direct student photo removal notice");
console.log("✅ TEST 1 PASSED: Faculty role matching correctly isolates student-only and lecturer-specific notices.");

// ==========================================
// TEST 2: Student Notification Filtering
// ==========================================
console.log("\n--- TEST 2: Student Notification Filtering ---");
const matchStudent1 = createStudentMatcher("25BCS001", "25BCS001", "25BCS001");
const matchStudent2 = createStudentMatcher("25BCS002", "25BCS002", "25BCS002");

// Notice sent specifically to Student 1
const noticeForStudent1 = {
  id: "notif_5",
  title: "Your Profile Photo Removed",
  recipientRollNo: "25BCS001",
  targetRoles: ["student"]
};
assert.strictEqual(matchStudent1(noticeForStudent1), true, "Student 1 should receive their direct notice");
assert.strictEqual(matchStudent2(noticeForStudent1), false, "Student 2 should NEVER receive Student 1's direct notice");

// Student Announcement
assert.strictEqual(matchStudent1(studentAnnouncement), true, "Student 1 should receive student announcement");
assert.strictEqual(matchStudent2(studentAnnouncement), true, "Student 2 should receive student announcement");

// Lecturer-only announcement
const lecturerAnnouncement = {
  id: "notif_6",
  title: "Faculty Senate Meeting",
  targetRoles: ["lecturer", "faculty"],
  targetRole: "faculty"
};
assert.strictEqual(matchStudent1(lecturerAnnouncement), false, "Student should NOT receive faculty announcement");
console.log("✅ TEST 2 PASSED: Student matching strictly isolates personal notices and delivers student announcements.");

// ==========================================
// TEST 3: Profile Photo Removal & Fallback Elimination
// ==========================================
console.log("\n--- TEST 3: Profile Photo Removal & Fallback Elimination ---");
const mockGoogleUser = {
  email: "student@university.edu",
  photoURL: "https://lh3.googleusercontent.com/a/google-avatar.jpg"
};

// Case A: Fresh student with Google photo
const profileBeforeRemoval = {
  name: "Alice",
  photoURL: "https://storage.googleapis.com/smartattend/custom-pic.jpg"
};
assert.strictEqual(
  resolveProfilePhoto(profileBeforeRemoval, mockGoogleUser),
  "https://storage.googleapis.com/smartattend/custom-pic.jpg",
  "Custom photo should be returned when present"
);

// Case B: Student whose photo was deleted by Admin (photoRemovedAt set, photoURL set to empty string)
const profileAfterAdminRemoval = {
  name: "Alice",
  photoURL: "",
  photoRemovedAt: Date.now()
};
assert.strictEqual(
  resolveProfilePhoto(profileAfterAdminRemoval, mockGoogleUser),
  "",
  "Photo must be empty string after admin removal - MUST NOT fall back to Google photo"
);

// Case C: Student whose photo was deleted by self (photoDeleted = true)
const profileAfterSelfRemoval = {
  name: "Alice",
  photoDeleted: true
};
assert.strictEqual(
  resolveProfilePhoto(profileAfterSelfRemoval, mockGoogleUser),
  "",
  "Photo must be empty string when photoDeleted flag is set"
);
console.log("✅ TEST 3 PASSED: Removed photos never fall back to Google account images.");

console.log("\n=================================================================");
console.log("🎉 ALL TESTS PASSED SUCCESSFULLY!");
console.log("=================================================================");
