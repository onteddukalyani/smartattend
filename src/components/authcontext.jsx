import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef
} from "react";

import { onAuthStateChanged, updateProfile } from "firebase/auth";

import {
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  query,
  where,
  onSnapshot
} from "firebase/firestore";

import {
  auth,
  db,
  loginWithGoogle as firebaseLoginWithGoogle,
  logoutUser as firebaseLogoutUser
} from "../firebase";
import { isGenericName, subscribeToStudentUpdates, PROFILE_UPDATED_EVENT, setGlobalStudent } from "../utils/studentDataHelper";

// Canonical set of statuses that indicate a user has been disabled, deleted, or removed
export const TERMINATED_STATUSES = new Set([
  "disabled",
  "deleted",
  "removed",
  "inactive",
  "suspended",
  "deactivated"
]);

export const isAccountTerminated = (userData) => {
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
};

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {

  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const isForceLoggingOutRef = useRef(false);

  // =========================================================
  // AUTOMATIC FORCE LOGOUT (Instant Invalidation on Removal)
  // Invoked when an account is deleted or disabled in Firestore
  // =========================================================
  const handleForceLogout = async (reason = "Your account has been removed from the database. You have been logged out.") => {
    if (isForceLoggingOutRef.current) return;
    isForceLoggingOutRef.current = true;
    console.warn("[SmartAttend ForceLogout Triggered]:", reason);

    try {
      if (user?.uid) {
        localStorage.removeItem(`smartattend-cached-profile-${user.uid}`);
      }
      localStorage.removeItem("smartattend-user-role");
      localStorage.removeItem("smartattend_student_device_locked");
      localStorage.removeItem("smartattend_device_locked");
      localStorage.removeItem("smartattend_face_enrolled");
      localStorage.removeItem("smartattend_hw_enrolled");
      localStorage.removeItem("smartattend_hardware_biometric_enrolled");
      localStorage.removeItem("smartattend_just_logged_in");
      sessionStorage.clear();
    } catch (_) { }

    try {
      await firebaseLogoutUser();
    } catch (_) { }

    setUser(null);
    setProfile(null);
    setLoading(false);

    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(new CustomEvent("smartattend:forced-logout", { detail: { reason } }));
      } catch (_) { }

      try {
        alert(reason);
      } catch (_) { }

      if (window.location.pathname !== "/login" && window.location.pathname !== "/") {
        window.location.replace("/login");
      }
    }

    setTimeout(() => {
      isForceLoggingOutRef.current = false;
    }, 2500);
  };

  // =========================================================
  // LOOKUP REGISTERED USER IN FIRESTORE (PARALLELIZED READ-ONLY)
  // =========================================================

  const lookupUserInSystem = async (email, uid = null) => {
    if (!email && !uid) return null;
    const cleanEmail = (email || "").toLowerCase().trim();
    const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase().trim() : "";
    const rollFromEmail = prefix.toUpperCase();
    const cleanUid = uid ? String(uid).trim() : "";

    try {
      // 1. Check Admins & Lecturers first (by prefix, email, and UID)
      const [
        adminPrefixSnap, adminEmailSnap, adminUidSnap,
        lectPrefixSnap, lectEmailSnap, lectUidSnap,
        adminQuerySnap, lectQuerySnap
      ] = await Promise.all([
        prefix ? getDoc(doc(db, "admins", prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        cleanEmail ? getDoc(doc(db, "admins", cleanEmail)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        cleanUid ? getDoc(doc(db, "admins", cleanUid)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        prefix ? getDoc(doc(db, "lecturers", prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        cleanEmail ? getDoc(doc(db, "lecturers", cleanEmail)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        cleanUid ? getDoc(doc(db, "lecturers", cleanUid)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        cleanEmail ? getDocs(query(collection(db, "admins"), where("email", "==", cleanEmail))).catch(() => ({ empty: true, docs: [] })) : Promise.resolve({ empty: true, docs: [] }),
        cleanEmail ? getDocs(query(collection(db, "lecturers"), where("email", "==", cleanEmail))).catch(() => ({ empty: true, docs: [] })) : Promise.resolve({ empty: true, docs: [] })
      ]);

      // 1. Resolve Admin candidate
      let adminCandidate = null;
      if (adminPrefixSnap.exists()) {
        const d = adminPrefixSnap.data();
        const term = isAccountTerminated(d);
        const matchesAdminEmail = !d.email || d.email.toLowerCase().trim() === cleanEmail;
        if (matchesAdminEmail) {
          adminCandidate = { id: adminPrefixSnap.id, ...d, email: d.email || cleanEmail, role: "admin", isTerminated: term, status: term ? "disabled" : (d.status || "active"), approved: !term && d.approved !== false };
        }
      }
      if (!adminCandidate && adminEmailSnap.exists()) {
        const d = adminEmailSnap.data();
        const term = isAccountTerminated(d);
        adminCandidate = { id: adminEmailSnap.id, ...d, email: cleanEmail, role: "admin", isTerminated: term, status: term ? "disabled" : (d.status || "active"), approved: !term && d.approved !== false };
      } else if (!adminCandidate && adminUidSnap?.exists()) {
        const d = adminUidSnap.data();
        const term = isAccountTerminated(d);
        adminCandidate = { id: adminUidSnap.id, ...d, email: d.email || cleanEmail, role: "admin", isTerminated: term, status: term ? "disabled" : (d.status || "active"), approved: !term && d.approved !== false };
      } else if (!adminCandidate && !adminQuerySnap.empty && adminQuerySnap.docs?.[0]) {
        const d = adminQuerySnap.docs[0].data();
        const term = isAccountTerminated(d);
        adminCandidate = { id: adminQuerySnap.docs[0].id, ...d, email: cleanEmail, role: "admin", isTerminated: term, status: term ? "disabled" : (d.status || "active"), approved: !term && d.approved !== false };
      } else if (!adminCandidate && (cleanEmail === "onteddukalyani@gmail.com" || prefix === "onteddukalyani")) {
        adminCandidate = {
          id: prefix || cleanEmail,
          name: "Kalyani Onteddu",
          email: cleanEmail || "onteddukalyani@gmail.com",
          role: "admin",
          isAdmin: true,
          status: "active",
          approved: true,
          department: "Administration",
          designation: "System Administrator"
        };
      }

      // 2. Resolve Lecturer candidate
      let lecturerCandidate = null;
      if (lectPrefixSnap.exists()) {
        const d = lectPrefixSnap.data();
        const term = isAccountTerminated(d);
        const matchesLectEmail = !d.email || d.email.toLowerCase().trim() === cleanEmail;
        if (matchesLectEmail) {
          lecturerCandidate = { id: lectPrefixSnap.id, ...d, email: d.email || cleanEmail, role: "lecturer", isTerminated: term, status: term ? "disabled" : (d.status || "active"), approved: !term && d.approved !== false };
        }
      }
      if (!lecturerCandidate && lectEmailSnap.exists()) {
        const d = lectEmailSnap.data();
        const term = isAccountTerminated(d);
        lecturerCandidate = { id: lectEmailSnap.id, ...d, email: cleanEmail, role: "lecturer", isTerminated: term, status: term ? "disabled" : (d.status || "active"), approved: !term && d.approved !== false };
      } else if (!lecturerCandidate && lectUidSnap?.exists()) {
        const d = lectUidSnap.data();
        const term = isAccountTerminated(d);
        lecturerCandidate = { id: lectUidSnap.id, ...d, email: d.email || cleanEmail, role: "lecturer", isTerminated: term, status: term ? "disabled" : (d.status || "active"), approved: !term && d.approved !== false };
      } else if (!lecturerCandidate && !lectQuerySnap.empty && lectQuerySnap.docs?.[0]) {
        const d = lectQuerySnap.docs[0].data();
        const term = isAccountTerminated(d);
        lecturerCandidate = { id: lectQuerySnap.docs[0].id, ...d, email: cleanEmail, role: "lecturer", isTerminated: term, status: term ? "disabled" : (d.status || "active"), approved: !term && d.approved !== false };
      }

      // 3. Resolve Student candidate
      // Helper to detect internal secret IDs / Firebase Auth UIDs (20+ chars, base62/alphanumeric)
      const isInternalSecretOrUid = (val) => {
        if (!val || typeof val !== "string") return false;
        const clean = val.trim();
        return clean.length >= 20 && !clean.includes("@");
      };

      // Canonical priority: check actual academic roll number (e.g. 25BCS108) first!
      const [
        studentRollSnap,
        studentEmailQuerySnap,
        studentEmailDocSnap,
        studentPrefixSnap,
        studentUidSnap,
        studentUidQuerySnap
      ] = await Promise.all([
        rollFromEmail ? getDoc(doc(db, "students", rollFromEmail)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        cleanEmail ? getDocs(query(collection(db, "students"), where("email", "==", cleanEmail))).catch(() => ({ empty: true, docs: [] })) : Promise.resolve({ empty: true, docs: [] }),
        cleanEmail ? getDoc(doc(db, "students", cleanEmail)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        (prefix && prefix !== rollFromEmail.toLowerCase()) ? getDoc(doc(db, "students", prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        cleanUid ? getDoc(doc(db, "students", cleanUid)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        cleanUid ? getDocs(query(collection(db, "students"), where("uid", "==", cleanUid))).catch(() => ({ empty: true, docs: [] })) : Promise.resolve({ empty: true, docs: [] })
      ]);

      let matchedStudentDoc = null;
      let matchedStudentId = "";

      // 1. Direct Roll Number document lookup (Canonical student profile in students collection)
      if (studentRollSnap.exists()) {
        matchedStudentDoc = studentRollSnap.data();
        matchedStudentId = studentRollSnap.id;
      }
      // 2. Query students by exact email
      else if (!studentEmailQuerySnap.empty && studentEmailQuerySnap.docs?.[0]) {
        matchedStudentDoc = studentEmailQuerySnap.docs[0].data();
        matchedStudentId = studentEmailQuerySnap.docs[0].id;
      }
      // 3. Direct document lookup by email
      else if (studentEmailDocSnap.exists()) {
        matchedStudentDoc = studentEmailDocSnap.data();
        matchedStudentId = studentEmailDocSnap.id;
      }
      // 4. Document lookup by prefix
      else if (studentPrefixSnap.exists()) {
        matchedStudentDoc = studentPrefixSnap.data();
        matchedStudentId = studentPrefixSnap.id;
      }
      // 5. Fallback: Direct document lookup by UID or UID query
      else if (studentUidSnap?.exists()) {
        matchedStudentDoc = studentUidSnap.data();
        matchedStudentId = studentUidSnap.id;
      }
      else if (!studentUidQuerySnap.empty && studentUidQuerySnap.docs?.[0]) {
        matchedStudentDoc = studentUidQuerySnap.docs[0].data();
        matchedStudentId = studentUidQuerySnap.docs[0].id;
      }

      let studentCandidate = null;

      // If student is found in database, USE EXACT DATABASE DETAILS!
      if (matchedStudentDoc) {
        const rawDocRoll = String(matchedStudentDoc.rollNo || matchedStudentDoc.rollNumber || "").trim().toUpperCase();
        let authoritativeRollNo = "";

        if (rawDocRoll && !isInternalSecretOrUid(rawDocRoll)) {
          authoritativeRollNo = rawDocRoll;
        } else if (studentRollSnap.exists() && !isInternalSecretOrUid(studentRollSnap.id)) {
          authoritativeRollNo = String(studentRollSnap.id).trim().toUpperCase();
        } else if (matchedStudentId && !matchedStudentId.includes("@") && !isInternalSecretOrUid(matchedStudentId)) {
          authoritativeRollNo = String(matchedStudentId).trim().toUpperCase();
        } else if (rollFromEmail && !isInternalSecretOrUid(rollFromEmail)) {
          authoritativeRollNo = rollFromEmail;
        } else if (prefix && !isInternalSecretOrUid(prefix)) {
          authoritativeRollNo = prefix.toUpperCase();
        }

        const authoritativeName = String(
          matchedStudentDoc.name ||
          matchedStudentDoc.fullName ||
          ""
        ).trim();

        const isRegisteredDirect = Boolean(
          matchedStudentDoc.faceRegistered === true ||
          matchedStudentDoc.biometricEnrolled === true ||
          matchedStudentDoc.hasFaceRegistered === true ||
          matchedStudentDoc.isRegistered === true ||
          matchedStudentDoc.registeredGlobally === true ||
          matchedStudentDoc.registrationStatus === "registered" ||
          (Array.isArray(matchedStudentDoc.faceDescriptor) && matchedStudentDoc.faceDescriptor.length === 128) ||
          (Array.isArray(matchedStudentDoc.descriptor) && matchedStudentDoc.descriptor.length === 128)
        );

        const hasFaceRemoval = Boolean(
          !isRegisteredDirect &&
          matchedStudentDoc.faceRemovedAt &&
          (!matchedStudentDoc.faceEnrolledAt || matchedStudentDoc.faceRemovedAt > matchedStudentDoc.faceEnrolledAt)
        );

        const hasValidFace = Boolean(!hasFaceRemoval && isRegisteredDirect);
        const isStudentTerminated = isAccountTerminated(matchedStudentDoc);

        studentCandidate = {
          id: authoritativeRollNo || matchedStudentId || cleanEmail,
          ...matchedStudentDoc,
          rollNo: authoritativeRollNo,
          name: authoritativeName || authoritativeRollNo,
          fullName: authoritativeName || authoritativeRollNo,
          email: matchedStudentDoc.email || cleanEmail,
          branch: (matchedStudentDoc.branch && String(matchedStudentDoc.branch).toLowerCase() !== "general")
            ? String(matchedStudentDoc.branch).trim()
            : (matchedStudentDoc.department || "CSE"),
          semester: matchedStudentDoc.semester ? String(matchedStudentDoc.semester).trim() : "1",
          role: "student",
          isTerminated: isStudentTerminated,
          status: isStudentTerminated ? "disabled" : (matchedStudentDoc.status || "active"),
          approved: !isStudentTerminated && matchedStudentDoc.approved !== false,
          faceDescriptor: null,
          faceRegistered: hasValidFace,
          biometricEnrolled: hasValidFace,
          hasFaceRegistered: hasValidFace,
          isRegistered: Boolean(matchedStudentDoc.isRegistered || hasValidFace),
          registeredGlobally: Boolean(matchedStudentDoc.registeredGlobally || hasValidFace),
          registrationStatus: (matchedStudentDoc.registrationStatus || (hasValidFace ? "registered" : "pending")),
          faceRemovedAt: hasFaceRemoval ? matchedStudentDoc.faceRemovedAt : null
        };
      } else {
        // Fallback: Check authorizedUsers & users collections if not yet in students
        const [
          userEmailSnap,
          userUidSnap,
          userRollSnap,
          userPrefixSnap,
          authPrefixSnap,
          authEmailSnap,
          qUserEmail,
          qAuthEmail
        ] = await Promise.all([
          cleanEmail ? getDoc(doc(db, "users", cleanEmail)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
          cleanUid ? getDoc(doc(db, "users", cleanUid)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
          getDoc(doc(db, "users", rollFromEmail)).catch(() => ({ exists: () => false })),
          prefix !== rollFromEmail.toLowerCase() ? getDoc(doc(db, "users", prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
          getDoc(doc(db, "authorizedUsers", prefix)).catch(() => ({ exists: () => false })),
          getDoc(doc(db, "authorizedUsers", cleanEmail)).catch(() => ({ exists: () => false })),
          getDocs(query(collection(db, "users"), where("email", "==", cleanEmail))).catch(() => ({ empty: true, docs: [] })),
          getDocs(query(collection(db, "authorizedUsers"), where("email", "==", cleanEmail))).catch(() => ({ empty: true, docs: [] }))
        ]);

        const candidateDocs = [
          userEmailSnap.exists() ? userEmailSnap.data() : null,
          userUidSnap.exists() ? userUidSnap.data() : null,
          authEmailSnap.exists() ? authEmailSnap.data() : null,
          authPrefixSnap.exists() ? authPrefixSnap.data() : null,
          userPrefixSnap.exists() ? userPrefixSnap.data() : null,
          userRollSnap.exists() ? userRollSnap.data() : null,
          !qAuthEmail.empty ? qAuthEmail.docs[0].data() : null,
          !qUserEmail.empty ? qUserEmail.docs[0].data() : null
        ].filter(Boolean);

        if (candidateDocs.length > 0) {
          let merged = {};
          let authoritativeRollNo = "";
          let authoritativeName = "";
          let authoritativeSemester = "";
          let authoritativeBranch = "";
          let isExplicitlyFaceRemoved = false;
          let mostRecentRemovalTime = 0;

          for (const c of candidateDocs) {
            if (!authoritativeRollNo && c.rollNo && !String(c.rollNo).includes("@") && !isInternalSecretOrUid(c.rollNo)) {
              authoritativeRollNo = String(c.rollNo).trim().toUpperCase();
            }
          }

          // If a student roll number was identified in users/auth records, fetch canonical students doc directly
          if (authoritativeRollNo) {
            try {
              const directMasterSnap = await getDoc(doc(db, "students", authoritativeRollNo)).catch(() => ({ exists: () => false }));
              if (directMasterSnap && directMasterSnap.exists && directMasterSnap.exists()) {
                candidateDocs.unshift(directMasterSnap.data());
              }
            } catch (_) { }
          }

          for (const c of candidateDocs) {
            if (!authoritativeRollNo && c.rollNo && !String(c.rollNo).includes("@") && !isInternalSecretOrUid(c.rollNo)) {
              authoritativeRollNo = String(c.rollNo).trim().toUpperCase();
            }
            if (!authoritativeName && c.name && !isGenericName(c.name, authoritativeRollNo, cleanEmail)) {
              authoritativeName = String(c.name).trim();
            }
            if (!authoritativeName && c.fullName && !isGenericName(c.fullName, authoritativeRollNo, cleanEmail)) {
              authoritativeName = String(c.fullName).trim();
            }
            if (!authoritativeSemester && c.semester) {
              authoritativeSemester = String(c.semester).trim();
            }
            if (!authoritativeBranch && c.branch && String(c.branch).toLowerCase() !== "general") {
              authoritativeBranch = String(c.branch).trim();
            }
            const isDocCandidateEnrolled = Boolean(
              c.faceRegistered ||
              c.biometricEnrolled ||
              c.hasFaceRegistered ||
              c.isRegistered ||
              c.registeredGlobally ||
              c.registrationStatus === "registered" ||
              (Array.isArray(c.faceDescriptor) && c.faceDescriptor.length === 128) ||
              (Array.isArray(c.descriptor) && c.descriptor.length === 128)
            );
            if (!isDocCandidateEnrolled && c.faceRemovedAt && (!c.faceEnrolledAt || c.faceRemovedAt > c.faceEnrolledAt)) {
              isExplicitlyFaceRemoved = true;
              if (typeof c.faceRemovedAt === "number" && c.faceRemovedAt > mostRecentRemovalTime) {
                mostRecentRemovalTime = c.faceRemovedAt;
              }
            }
            merged = {
              ...merged,
              ...c,
              faceRegistered: Boolean(
                isDocCandidateEnrolled ||
                merged.faceRegistered
              ),
              isRegistered: Boolean(c.isRegistered || merged.isRegistered || isDocCandidateEnrolled || merged.faceRegistered),
              registeredGlobally: Boolean(c.registeredGlobally || merged.registeredGlobally || isDocCandidateEnrolled || merged.faceRegistered),
              faceDescriptor: ((Array.isArray(c.faceDescriptor) && c.faceDescriptor.length === 128) ? c.faceDescriptor : (Array.isArray(merged.faceDescriptor) ? merged.faceDescriptor : null)),
              photoURL: c.photoURL || c.photo || c.image || merged.photoURL || "",
              branch: authoritativeBranch || (c.branch && String(c.branch).toLowerCase() !== "general" ? c.branch : (merged.branch || "CSE")),
              semester: authoritativeSemester || c.semester || merged.semester || "1",
              rollNo: authoritativeRollNo || (!isInternalSecretOrUid(c.rollNo) ? String(c.rollNo).trim().toUpperCase() : (!isInternalSecretOrUid(merged.rollNo) ? merged.rollNo : "")),
              role: c.role || merged.role || "student"
            };
          }

          if (isExplicitlyFaceRemoved && !merged.faceRegistered && !merged.isRegistered) {
            merged.faceRegistered = false;
            merged.biometricEnrolled = false;
            merged.hasFaceRegistered = false;
            merged.faceRemovedAt = mostRecentRemovalTime || 0;
            merged.faceDescriptor = null;
          }
          merged.hasFaceRegistered = Boolean(merged.faceRegistered);

        const isFallbackTerminated = candidateDocs.some((c) => isAccountTerminated(c));
        const finalRollNo = authoritativeRollNo || (!isInternalSecretOrUid(merged.rollNo) ? merged.rollNo : "") || rollFromEmail || prefix.toUpperCase();
        const finalName = authoritativeName || merged.name || merged.fullName || finalRollNo || "";
        const candidateNormRole = normalizeRole(merged.role || "student");
        const finalCandidate = {
          id: finalRollNo || cleanEmail,
          ...merged,
          name: finalName,
          fullName: finalName,
          email: merged.email || cleanEmail,
          rollNo: finalRollNo,
          role: candidateNormRole,
          isTerminated: isFallbackTerminated,
          status: isFallbackTerminated ? "disabled" : (merged.status || "active"),
          approved: !isFallbackTerminated && merged.approved !== false
        };

        if (candidateNormRole === "admin" && !adminCandidate) {
          adminCandidate = finalCandidate;
        } else if (candidateNormRole === "lecturer" && !lecturerCandidate) {
          lecturerCandidate = finalCandidate;
        } else if (candidateNormRole === "student") {
          studentCandidate = finalCandidate;
        }
      }
    }

      // 4. Evaluate Active Candidates & Authoritative Consistency Checks
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
    // Scenario 13: The same email appears in multiple distinct role collections
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

    // No active records found - check if there is a terminated/deactivated record
    const terminated = [adminCandidate, lecturerCandidate, studentCandidate].find((c) => c && c.isTerminated);
    if (terminated) {
      return terminated;
    }

    return null;
  } catch (err) {
    console.error("Error looking up user in system:", err);
    return null;
  }
};

// Helper to normalize role names
const normalizeRole = (rawRole) => {
  const r = String(rawRole || "").trim().toLowerCase();
  if (r === "administrator" || r === "superadmin" || r === "admin") return "admin";
  if (r === "faculty" || r === "professor" || r === "lecturer") return "lecturer";
  return "student";
};

const buildEnrichedProfile = (registeredUser, currentUser) => {
  if (!registeredUser || !currentUser) return null;

  const databaseRole = normalizeRole(registeredUser.role);
  const cleanEmail = currentUser.email.toLowerCase().trim();
  const prefix = cleanEmail.split("@")[0].toLowerCase().trim();
  const cleanRollNo = registeredUser.rollNo
    ? String(registeredUser.rollNo).trim().toUpperCase()
    : (registeredUser.id && !registeredUser.id.includes("@") ? registeredUser.id.toUpperCase() : (databaseRole === "student" ? (registeredUser.rollNumber || "") : undefined));
  const branch = (registeredUser.branch && String(registeredUser.branch).toLowerCase() !== "general")
    ? registeredUser.branch
    : ((registeredUser.department && String(registeredUser.department).toLowerCase() !== "general") ? registeredUser.department : "CSE");

  // STRICT: Extract name strictly from database record only (never from email or Google account)
  const databaseName = (registeredUser.name && !isGenericName(registeredUser.name, cleanRollNo, cleanEmail))
    ? registeredUser.name.trim()
    : (registeredUser.fullName && !isGenericName(registeredUser.fullName, cleanRollNo, cleanEmail) ? registeredUser.fullName.trim() : "");

  const resolvedName = databaseName || (databaseRole === "student" ? (cleanRollNo || "Student") : prefix);

  // Strict profile photo resolution: Check if photo was explicitly deleted or removed
  const hasPhotoRemoval = Boolean(
    registeredUser.photoRemovedAt ||
    registeredUser.photoDeleted === true ||
    registeredUser.photoURL === "" ||
    registeredUser.photo === ""
  );

  const dbPhoto = registeredUser.photoURL || registeredUser.photo || registeredUser.image || registeredUser.avatar || registeredUser.profilePic || "";
  const resolvedPhoto = hasPhotoRemoval
    ? ""
    : (dbPhoto || currentUser.photoURL || currentUser.providerData?.[0]?.photoURL || "");

  // Strict biometrics check: Only mark false if explicitly removed by admin or reset
  const hasFaceRemoval = Boolean(
    (registeredUser.faceRemovedAt &&
      (!registeredUser.faceEnrolledAt || registeredUser.faceRemovedAt > registeredUser.faceEnrolledAt)) ||
    registeredUser.faceRegistered === false ||
    registeredUser.biometricEnrolled === false
  );

  const hasValidFace = Boolean(
    !hasFaceRemoval &&
    (registeredUser.faceRegistered === true ||
      registeredUser.biometricEnrolled === true ||
      registeredUser.hasFaceRegistered === true ||
      (Array.isArray(registeredUser.faceDescriptor) && registeredUser.faceDescriptor.length === 128))
  );

  if (!hasValidFace && typeof window !== "undefined") {
    try {
      localStorage.removeItem("smartattend_face_enrolled");
      if (cleanRollNo) localStorage.removeItem(`smartattend_face_enrolled_${cleanRollNo}`);
      if (currentUser?.uid) localStorage.removeItem(`smartattend_face_enrolled_${currentUser.uid}`);
    } catch (_) { }
  }

  // Check device reset state
  const hasDeviceReset = Boolean(
    registeredUser.deviceResetAt ||
    registeredUser.deviceTypeLocked === false ||
    registeredUser.isDeviceRegistered === false ||
    !registeredUser.deviceType
  );

  if (hasDeviceReset && typeof window !== "undefined") {
    try {
      localStorage.removeItem("smartattend_student_device_locked");
      localStorage.removeItem("smartattend_device_locked");
      localStorage.removeItem("smartattend_student_device_type");
      localStorage.removeItem("smartattend_device_type");
      localStorage.removeItem("smartattend_device_registered");
      localStorage.removeItem("smartattend_hw_enrolled");
      if (cleanRollNo) localStorage.removeItem(`smartattend_hw_enrolled_${cleanRollNo}`);
      if (currentUser?.uid) localStorage.removeItem(`smartattend_hw_enrolled_${currentUser.uid}`);
      localStorage.removeItem("smartattend_fingerprint_enrolled");
    } catch (_) { }
  }

  const resolvedDeviceType = hasDeviceReset ? null : (registeredUser.deviceType || registeredUser.registeredPlatform || null);
  const resolvedDeviceLocked = hasDeviceReset ? false : Boolean(registeredUser.deviceTypeLocked);
  const resolvedIsDeviceRegistered = hasDeviceReset ? false : Boolean(registeredUser.isDeviceRegistered);
  const resolvedHwEnrolled = hasDeviceReset ? false : Boolean(registeredUser.hardwareBiometricEnrolled);

  const resolvedDescriptor = hasValidFace ? (registeredUser.faceDescriptor || registeredUser.descriptor || null) : null;
  if (cleanRollNo && hasValidFace) {
    setGlobalStudent({
      rollNo: cleanRollNo,
      name: resolvedName,
      email: cleanEmail,
      faceRegistered: true,
      faceDescriptor: resolvedDescriptor,
      photoURL: resolvedPhoto
    });
  }

  return {
    id: registeredUser.id || cleanRollNo || cleanEmail,
    ...registeredUser,
    rollNo: cleanRollNo,
    email: registeredUser.email || cleanEmail,
    name: resolvedName,
    fullName: resolvedName,
    branch: branch,
    semester: registeredUser.semester || "1",
    uid: currentUser.uid,
    role: databaseRole,
    photoURL: resolvedPhoto,
    photo: resolvedPhoto,
    image: resolvedPhoto,
    faceDescriptor: resolvedDescriptor,
    faceRegistered: hasValidFace,
    biometricEnrolled: hasValidFace,
    hasFaceRegistered: hasValidFace,
    faceRemovedAt: registeredUser.faceRemovedAt || (hasFaceRemoval ? Date.now() : null),
    approved: registeredUser.approved !== false,
    status: registeredUser.status || "active",
    deviceType: resolvedDeviceType,
    deviceTypeLocked: resolvedDeviceLocked,
    isDeviceRegistered: resolvedIsDeviceRegistered,
    hardwareBiometricEnrolled: resolvedHwEnrolled,
    registeredPlatform: resolvedDeviceType
  };
};

// =========================================================
// ON AUTH STATE CHANGED (FAST PROFILE CACHE + BACKGROUND REFRESH)
// =========================================================
useEffect(() => {
  let isMounted = true;

  // Safety timeout: Prevent splash screen from hanging on mobile cold boot
  const safetyTimer = setTimeout(() => {
    if (isMounted) {
      setLoading(false);
    }
  }, 1500);

  const unsubscribe = onAuthStateChanged(
    auth,
    async (currentUser) => {
      clearTimeout(safetyTimer);
      if (!isMounted) return;

      try {
        if (!currentUser || !currentUser.email) {
          setUser(null);
          setProfile(null);
          setLoading(false);
          return;
        }

        // 1. Try to load cached profile from localStorage for instantaneous 0ms page load
        const cacheKey = `smartattend-cached-profile-${currentUser.uid}`;
        let hasHydrated = false;
        try {
          const cached = localStorage.getItem(cacheKey);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed && parsed.email?.toLowerCase() === currentUser.email?.toLowerCase()) {
              setUser(currentUser);
              setProfile(parsed);
              setLoading(false);
              hasHydrated = true;
            }
          }
        } catch (e) { }

        // 2. Perform fresh parallel lookup in Firestore (by email and UID)
        const registeredUser = await lookupUserInSystem(currentUser.email, currentUser.uid);

        if (!isMounted) return;

        if (!registeredUser || isAccountTerminated(registeredUser) || registeredUser.isTerminated) {
          console.warn("Unregistered, removed, or deactivated user attempted access on session restore:", currentUser.email);
          try {
            localStorage.removeItem(cacheKey);
            localStorage.removeItem("smartattend-user-role");
            localStorage.removeItem("smartattend_student_device_locked");
            localStorage.removeItem("smartattend_device_locked");
            localStorage.removeItem("smartattend_face_enrolled");
            localStorage.removeItem("smartattend_hw_enrolled");
            localStorage.removeItem("smartattend_hardware_biometric_enrolled");
            localStorage.removeItem("smartattend_just_logged_in");
            sessionStorage.clear();
          } catch (_) { }
          await firebaseLogoutUser().catch(() => { });
          if (isMounted) {
            setUser(null);
            setProfile(null);
            setLoading(false);
          }
          return;
        }

        const enrichedProfile = buildEnrichedProfile(registeredUser, currentUser);

        // Update cache with fresh data
        try {
          localStorage.setItem(cacheKey, JSON.stringify(enrichedProfile));
        } catch (_) { }

        if (isMounted) {
          setUser(currentUser);
          setProfile(enrichedProfile);
          // Strict read-only on login: Use existing database document only, zero writes to database.
        }

      } catch (error) {
        console.error("Error restoring authentication:", error);
        if (isMounted) {
          setUser(null);
          setProfile(null);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }
  );

  return () => {
    isMounted = false;
    clearTimeout(safetyTimer);
    unsubscribe();
  };
}, []);

// =========================================================
// REAL-TIME PROFILE SYNCHRONIZATION & AUTO-LOGOUT ON REMOVAL
// Instantly kicks out deleted/deactivated students or lecturers!
// =========================================================
useEffect(() => {
  if (!user || !user.email) return;

  const cleanEmail = user.email.toLowerCase().trim();
  const isRootOwner = cleanEmail === "onteddukalyani@gmail.com";
  const prefix = cleanEmail.split("@")[0].toLowerCase().trim();
  const role = normalizeRole(profile?.role || "student");
  const rollNo = (profile?.rollNo || (role === "student" ? prefix.toUpperCase() : "")).trim().toUpperCase();

  // Primary authoritative document paths that determine account existence
  const primaryTargets = [];
  if (role === "student") {
    if (rollNo) primaryTargets.push({ coll: "students", id: rollNo });
    if (cleanEmail) primaryTargets.push({ coll: "students", id: cleanEmail });
  } else if (role === "lecturer") {
    primaryTargets.push({ coll: "lecturers", id: cleanEmail });
    if (prefix) primaryTargets.push({ coll: "lecturers", id: prefix });
  } else if (role === "admin" && !isRootOwner) {
    primaryTargets.push({ coll: "admins", id: cleanEmail });
    if (prefix) primaryTargets.push({ coll: "admins", id: prefix });
  }

  // Secondary targets for biometric/field synchronization
  const secondaryTargets = [];
  if (role === "student") {
    if (rollNo) {
      secondaryTargets.push({ coll: "users", id: rollNo });
      secondaryTargets.push({ coll: "authorizedUsers", id: rollNo });
    }
    if (cleanEmail) {
      secondaryTargets.push({ coll: "users", id: cleanEmail });
      secondaryTargets.push({ coll: "authorizedUsers", id: cleanEmail });
    }
    if (user?.uid) {
      secondaryTargets.push({ coll: "students", id: user.uid });
      secondaryTargets.push({ coll: "users", id: user.uid });
    }
  } else {
    secondaryTargets.push({ coll: "users", id: cleanEmail });
    if (user?.uid) secondaryTargets.push({ coll: "users", id: user.uid });
  }

  const unsubs = [];
  const activeConfirmedDocs = new Set();

  // Handle primary listeners (with automatic deletion logout detection)
  primaryTargets.forEach(({ coll, id }) => {
    if (!id) return;
    try {
      const unsub = onSnapshot(
        doc(db, coll, id),
        async (snap) => {
          if (!snap.exists()) {
            // Document does not exist or was just deleted!
            if (!isRootOwner && activeConfirmedDocs.has(`${coll}/${id}`)) {
              console.warn(`[SmartAttend] Primary account document removed: ${coll}/${id}. Verifying user status...`);
              const userInSystem = await lookupUserInSystem(cleanEmail, user.uid);
              if (!userInSystem || isAccountTerminated(userInSystem) || userInSystem.isTerminated) {
                await handleForceLogout(
                  "Your account record was removed from the database by an administrator. You have been automatically logged out."
                );
                return;
              }
            }
            return;
          }

          // Doc exists: record it as confirmed active
          activeConfirmedDocs.add(`${coll}/${id}`);
          const freshData = snap.data();

          // Check if status changed to deleted, disabled, inactive, or unapproved
          if (!isRootOwner && (isAccountTerminated(freshData) || freshData.isDeleted === true)) {
            await handleForceLogout(
              "Your account has been deactivated or removed by an administrator. You have been automatically logged out."
            );
            return;
          }

          // Apply regular updates (face registration, device reset, name edits)
          setProfile((prev) => {
            if (!prev) return prev;
            const isFaceReset = Boolean(
              freshData.faceRemovedAt &&
              (!freshData.faceEnrolledAt || freshData.faceRemovedAt > freshData.faceEnrolledAt)
            );
            const isFaceEnrolled = Boolean(
              !isFaceReset && (
                freshData.faceRegistered === true ||
                freshData.biometricEnrolled === true ||
                freshData.hasFaceRegistered === true ||
                (Array.isArray(freshData.faceDescriptor) && freshData.faceDescriptor.length === 128) ||
                (Array.isArray(freshData.descriptor) && freshData.descriptor.length === 128)
              )
            );

            const isDeviceReset = Boolean(
              freshData.deviceResetAt ||
              freshData.deviceFingerprintResetAt ||
              freshData.deviceTypeLocked === false
            );

            const merged = { ...prev, ...freshData };
            if (isFaceReset) {
              merged.faceRegistered = false;
              merged.biometricEnrolled = false;
              merged.hasFaceRegistered = false;
              merged.faceDescriptor = null;
              merged.descriptor = null;
              merged.photoURL = "";
              merged.photo = "";
              merged.image = "";
            } else if (isFaceEnrolled || prev.faceRegistered) {
              merged.faceRegistered = true;
              merged.biometricEnrolled = true;
              merged.hasFaceRegistered = true;
            }

            if (isDeviceReset) {
              merged.deviceType = null;
              merged.deviceTypeLocked = false;
              merged.isDeviceRegistered = false;
              merged.hardwareBiometricEnrolled = false;
              merged.registeredDevice = null;
              merged.registeredPlatform = null;
              merged.deviceFingerprint = null;
            } else if (freshData.hardwareBiometricEnrolled || prev.hardwareBiometricEnrolled) {
              merged.hardwareBiometricEnrolled = true;
            }
            const enriched = buildEnrichedProfile(merged, user);
            try {
              localStorage.setItem(`smartattend-cached-profile-${user.uid}`, JSON.stringify(enriched));
            } catch (_) { }
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent(PROFILE_UPDATED_EVENT, { detail: enriched }));
            }
            return enriched;
          });
        },
        (err) => {
          // Permission denied usually indicates security rules blocked access because user record was deleted
          if (err?.code === "permission-denied" && !isRootOwner) {
            lookupUserInSystem(cleanEmail, user.uid).then((res) => {
              if (!res || isAccountTerminated(res) || res.isTerminated) {
                handleForceLogout("Your account permissions were revoked or your record was removed. You have been automatically logged out.");
              }
            }).catch(() => { });
          }
        }
      );
      unsubs.push(unsub);
    } catch (_) { }
  });

  // Handle secondary listeners (biometrics / users collection fallback)
  secondaryTargets.forEach(({ coll, id }) => {
    if (!id) return;
    try {
      const unsub = onSnapshot(doc(db, coll, id), (snap) => {
        if (!snap.exists()) return;
        const freshData = snap.data();
        if (!isRootOwner && (isAccountTerminated(freshData) || freshData.isDeleted === true)) {
          handleForceLogout(
            "Your account has been deactivated or removed by an administrator. You have been automatically logged out."
          );
          return;
        }
        setProfile((prev) => {
          if (!prev) return prev;
          const merged = { ...prev, ...freshData };
          const enriched = buildEnrichedProfile(merged, user);
          try {
            localStorage.setItem(`smartattend-cached-profile-${user.uid}`, JSON.stringify(enriched));
          } catch (_) { }
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent(PROFILE_UPDATED_EVENT, { detail: enriched }));
          }
          return enriched;
        });
      }, () => { });
      unsubs.push(unsub);
    } catch (_) { }
  });

  return () => {
    unsubs.forEach((u) => {
      try { u(); } catch (_) { }
    });
  };
}, [user?.uid, user?.email, profile?.role, profile?.rollNo]);

// Periodic heartbeat & window visibility/focus verification
// Safeguards against offline deletions, console-level manual deletions, and background tab drops
useEffect(() => {
  if (!user || !user.email) return;
  const cleanEmail = user.email.toLowerCase().trim();
  if (cleanEmail === "onteddukalyani@gmail.com") return; // Root admin is safe

  let isVerifying = false;
  const verifyUserActive = async () => {
    if (isVerifying || !user?.email) return;
    isVerifying = true;
    try {
      const userInSystem = await lookupUserInSystem(user.email, user.uid);
      if (!userInSystem || isAccountTerminated(userInSystem) || userInSystem.isTerminated) {
        await handleForceLogout(
          "Your account record was removed from the database by an administrator. You have been automatically logged out."
        );
      }
    } catch (_) { } finally {
      isVerifying = false;
    }
  };

  // Check periodically every 25 seconds
  const intervalId = setInterval(verifyUserActive, 25000);

  // Check when user returns to or focuses the window/tab
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      verifyUserActive();
    }
  };
  const handleFocus = () => {
    verifyUserActive();
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", handleFocus);

  return () => {
    clearInterval(intervalId);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("focus", handleFocus);
  };
}, [user?.email, user?.uid]);

// Real-time synchronization with global student updates dispatched from any tab or modal
useEffect(() => {
  if (!user) return;
  const unsub = subscribeToStudentUpdates(async (updatedStudent) => {
    if (!updatedStudent) return;
    const cleanRoll = (profile?.rollNo || "").toUpperCase().trim();
    const updatedRoll = String(updatedStudent.rollNo || updatedStudent.id || "").toUpperCase().trim();
    const updatedEmail = String(updatedStudent.email || "").toLowerCase().trim();
    const userEmail = (user.email || "").toLowerCase().trim();
    const updatedUid = String(updatedStudent.uid || updatedStudent.studentUid || "");

    const isMatch = (
      (cleanRoll && updatedRoll && cleanRoll === updatedRoll) ||
      (userEmail && updatedEmail && userEmail === updatedEmail) ||
      (user.uid && updatedUid && user.uid === updatedUid)
    );

    if (isMatch) {
      if (updatedStudent.isDeleted || isAccountTerminated(updatedStudent) || updatedStudent.isTerminated) {
        await handleForceLogout(
          "Your account record was removed from the database by an administrator. You have been automatically logged out."
        );
        return;
      }

      setProfile((prev) => {
        if (!prev) return prev;
        const merged = { ...prev, ...updatedStudent };
        const enriched = buildEnrichedProfile(merged, user);
        try {
          localStorage.setItem(`smartattend-cached-profile-${user.uid}`, JSON.stringify(enriched));
        } catch (_) { }
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent(PROFILE_UPDATED_EVENT, { detail: enriched }));
        }
        return enriched;
      });
    }
  });
  return () => unsub();
}, [user?.uid, user?.email, profile?.rollNo]);


// =========================================================
// GOOGLE LOGIN (STRICT READ-ONLY: ONLY PRE-REGISTERED USERS ALLOWED, ZERO WRITES)
// =========================================================

const loginWithGoogle = async (selectedRole = "") => {
  // Open Google login popup
  const result = await firebaseLoginWithGoogle();
  const currentUser = result.user;

  if (!currentUser || !currentUser.email) {
    await firebaseLogoutUser();
    throw new Error("Unable to retrieve Google user credentials. Please try again.");
  }

  const cleanEmail = currentUser.email.toLowerCase().trim();

  // -------------------------------------------------------
  // STRICT VERIFICATION: MUST EXIST IN DATABASE (ZERO WRITES)
  // -------------------------------------------------------
  const registeredUser = await lookupUserInSystem(cleanEmail, currentUser.uid);

  // CASE C: Email Does Not Exist in Any Role
  if (!registeredUser) {
    try {
      localStorage.removeItem("smartattend-user-role");
      localStorage.removeItem(`smartattend-cached-profile-${currentUser.uid}`);
      sessionStorage.clear();
    } catch (_) { }
    await firebaseLogoutUser();
    setUser(null);
    setProfile(null);
    const notRegisteredErr = new Error(
      "You are not registered with SmartAttend. Please contact your administrator."
    );
    notRegisteredErr.code = "NOT_REGISTERED";
    throw notRegisteredErr;
  }

  // Inconsistency check: Same email appears in multiple role collections
  if (registeredUser.isAmbiguous) {
    try {
      localStorage.removeItem("smartattend-user-role");
      localStorage.removeItem(`smartattend-cached-profile-${currentUser.uid}`);
      sessionStorage.clear();
    } catch (_) { }
    await firebaseLogoutUser();
    setUser(null);
    setProfile(null);
    const ambigErr = new Error(
      `Account inconsistency detected: Email is registered under multiple roles (${(registeredUser.foundRoles || []).join(", ")}). Please contact your administrator.`
    );
    ambigErr.code = "MULTIPLE_ROLES";
    ambigErr.foundRoles = registeredUser.foundRoles;
    throw ambigErr;
  }

  // UID Mismatch: Authenticated Google UID does not match registered UID
  if (registeredUser.uidMismatch) {
    try {
      localStorage.removeItem("smartattend-user-role");
      localStorage.removeItem(`smartattend-cached-profile-${currentUser.uid}`);
      sessionStorage.clear();
    } catch (_) { }
    await firebaseLogoutUser();
    setUser(null);
    setProfile(null);
    const uidErr = new Error(
      "Authentication error: The authenticated account UID does not match the registered user record. Please contact your administrator."
    );
    uidErr.code = "UID_MISMATCH";
    throw uidErr;
  }

  // Check account status & approval (Deactivated / Terminated accounts)
  if (isAccountTerminated(registeredUser) || registeredUser.isTerminated) {
    try {
      localStorage.removeItem("smartattend-user-role");
      localStorage.removeItem(`smartattend-cached-profile-${currentUser.uid}`);
      sessionStorage.clear();
    } catch (_) { }
    await firebaseLogoutUser();
    setUser(null);
    setProfile(null);
    const termErr = new Error(
      `Access Denied: Your account (${currentUser.email}) has been removed or deactivated by the administrator.`
    );
    termErr.code = "ACCOUNT_DISABLED";
    throw termErr;
  }

  // -------------------------------------------------------
  // AUTHORITATIVE ROLE: DERIVED DIRECTLY FROM DATABASE
  // -------------------------------------------------------
  const databaseRole = normalizeRole(registeredUser.role);
  const normalizedSelectedRole = selectedRole ? normalizeRole(selectedRole) : "";

  // CASE B: Email Exists, but the Selected Role Is Incorrect
  if (normalizedSelectedRole && normalizedSelectedRole !== databaseRole) {
    try {
      localStorage.removeItem("smartattend-user-role");
      localStorage.removeItem(`smartattend-cached-profile-${currentUser.uid}`);
      sessionStorage.clear();
    } catch (_) { }
    await firebaseLogoutUser();
    setUser(null);
    setProfile(null);

    const capRole = databaseRole === "admin" ? "Admin" : (databaseRole === "lecturer" ? "Lecturer" : "Student");
    const article = databaseRole === "admin" ? "an" : "a";
    const mismatchMsg = `You are registered as ${article} ${capRole}. Please select the ${capRole} role to continue.`;

    const mismatchErr = new Error(mismatchMsg);
    mismatchErr.code = "ROLE_MISMATCH";
    mismatchErr.registeredRole = databaseRole;
    mismatchErr.selectedRole = normalizedSelectedRole;
    throw mismatchErr;
  }

  // CASE A: Email Exists and the Selected Role Matches
  localStorage.setItem("smartattend-user-role", databaseRole);
  const enrichedProfile = buildEnrichedProfile(registeredUser, currentUser);

  try {
    localStorage.setItem(`smartattend-cached-profile-${currentUser.uid}`, JSON.stringify(enrichedProfile));
  } catch (_) { }

  // Grant access in React state - Zero database writes!
  setUser(currentUser);
  setProfile(enrichedProfile);

  return enrichedProfile;
};

// =========================================================
// UPDATE PROFILE NAME IN FIRESTORE & REACT STATE
// =========================================================
const updateProfileName = async (newName) => {
  if (!newName || !newName.trim()) {
    throw new Error("Name cannot be empty.");
  }
  const cleanName = newName.trim();
  const cleanEmail = (user?.email || profile?.email || "").toLowerCase().trim();
  const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase().trim() : "";
  const role = normalizeRole(profile?.role || "student");
  const rollNo = (profile?.rollNo || (role === "student" ? prefix.toUpperCase() : "")).trim().toUpperCase();

  const updatePayload = {
    name: cleanName,
    fullName: cleanName,
    updatedAt: Date.now()
  };

  const promises = [];

  if (role === "student") {
    if (rollNo) {
      promises.push(setDoc(doc(db, "students", rollNo), updatePayload, { merge: true }));
    }
  } else if (role === "lecturer") {
    const lectId = (profile?.email || cleanEmail || prefix).toLowerCase().trim();
    if (lectId) {
      promises.push(setDoc(doc(db, "lecturers", lectId), updatePayload, { merge: true }));
    }
  } else if (role === "admin") {
    const adminId = (profile?.email || cleanEmail || prefix).toLowerCase().trim();
    if (adminId) {
      promises.push(setDoc(doc(db, "admins", adminId), updatePayload, { merge: true }));
    }
  }

  await Promise.all(promises);

  // Update React State immediately across the entire application
  setProfile((prev) => ({
    ...(prev || {}),
    name: cleanName,
    fullName: cleanName
  }));

  return cleanName;
};

// =========================================================
// UPDATE PROFILE SEMESTER IN FIRESTORE & REACT STATE
// =========================================================
const updateProfileSemester = async (newSemester) => {
  const cleanSemester = String(newSemester || "1").trim();
  const cleanEmail = (user?.email || profile?.email || "").toLowerCase().trim();
  const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase().trim() : "";
  const role = normalizeRole(profile?.role || "student");
  const rollNo = (profile?.rollNo || (role === "student" ? prefix.toUpperCase() : "")).trim().toUpperCase();

  const updatePayload = {
    semester: cleanSemester,
    updatedAt: Date.now()
  };

  // Strictly update ONLY the student's existing record in students collection
  if (rollNo) {
    await setDoc(doc(db, "students", rollNo), updatePayload, { merge: true }).catch(() => { });
  } else if (cleanEmail) {
    await setDoc(doc(db, "students", cleanEmail), updatePayload, { merge: true }).catch(() => { });
  }

  // Update React State immediately across the entire application
  setProfile((prev) => ({
    ...(prev || {}),
    semester: cleanSemester
  }));

  // Update cache
  if (user?.uid) {
    try {
      const cacheKey = `smartattend-cached-profile-${user.uid}`;
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        parsed.semester = cleanSemester;
        localStorage.setItem(cacheKey, JSON.stringify(parsed));
      }
    } catch (_) { }
  }

  return cleanSemester;
};

// =========================================================
// UPDATE PROFILE PHOTO IN FIRESTORE & REACT STATE
// =========================================================
const updateProfilePhoto = async (photoDataUrl) => {
  if (!photoDataUrl || typeof photoDataUrl !== "string") {
    throw new Error("Invalid photo data.");
  }
  const cleanEmail = (user?.email || profile?.email || "").toLowerCase().trim();
  const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase().trim() : "";
  const role = normalizeRole(profile?.role || "student");
  const rollNo = (profile?.rollNo || (role === "student" ? prefix.toUpperCase() : "")).trim().toUpperCase();

  const photoPayload = {
    photoURL: photoDataUrl,
    photo: photoDataUrl,
    image: photoDataUrl,
    profilePic: photoDataUrl,
    avatar: photoDataUrl,
    updatedAt: Date.now()
  };

  const promises = [];

  if (role === "student") {
    if (rollNo) {
      promises.push(setDoc(doc(db, "students", rollNo), photoPayload, { merge: true }));
    }
  } else if (role === "lecturer") {
    const lectId = (profile?.email || cleanEmail || prefix).toLowerCase().trim();
    if (lectId) {
      promises.push(setDoc(doc(db, "lecturers", lectId), photoPayload, { merge: true }));
    }
  } else if (role === "admin") {
    const adminId = (profile?.email || cleanEmail || prefix).toLowerCase().trim();
    if (adminId) {
      promises.push(setDoc(doc(db, "admins", adminId), photoPayload, { merge: true }));
    }
  }

  if (auth?.currentUser) {
    try {
      await updateProfile(auth.currentUser, { photoURL: photoDataUrl });
    } catch (_) { }
  }

  await Promise.all(promises);

  // Update React State & Cache immediately across the entire application
  setProfile((prev) => {
    const updated = {
      ...(prev || {}),
      photoURL: photoDataUrl,
      photo: photoDataUrl,
      image: photoDataUrl,
      profilePic: photoDataUrl,
      avatar: photoDataUrl
    };
    if (user?.uid) {
      try {
        localStorage.setItem(`smartattend-cached-profile-${user.uid}`, JSON.stringify(updated));
      } catch (_) { }
    }
    return updated;
  });

  return photoDataUrl;
};

// =========================================================
// DELETE PROFILE PHOTO IN FIRESTORE & REACT STATE
// =========================================================
const deleteProfilePhoto = async () => {
  const cleanEmail = (user?.email || profile?.email || "").toLowerCase().trim();
  const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase().trim() : "";
  const role = normalizeRole(profile?.role || "student");
  const rollNo = (profile?.rollNo || (role === "student" ? prefix.toUpperCase() : "")).trim().toUpperCase();

  const clearPayload = {
    photoURL: "",
    photo: "",
    image: "",
    profilePic: "",
    avatar: "",
    updatedAt: Date.now()
  };

  const promises = [];

  if (role === "student") {
    if (rollNo) {
      promises.push(setDoc(doc(db, "students", rollNo), clearPayload, { merge: true }));
    }
  } else if (role === "lecturer") {
    const lectId = (profile?.email || cleanEmail || prefix).toLowerCase().trim();
    if (lectId) {
      promises.push(setDoc(doc(db, "lecturers", lectId), clearPayload, { merge: true }));
    }
  } else if (role === "admin") {
    const adminId = (profile?.email || cleanEmail || prefix).toLowerCase().trim();
    if (adminId) {
      promises.push(setDoc(doc(db, "admins", adminId), clearPayload, { merge: true }));
    }
  }

  if (auth?.currentUser) {
    try {
      await updateProfile(auth.currentUser, { photoURL: "" });
    } catch (_) { }
  }

  await Promise.all(promises);

  // Update React State & Cache immediately across the entire application
  setProfile((prev) => {
    const updated = {
      ...(prev || {}),
      photoURL: "",
      photo: "",
      image: "",
      profilePic: "",
      avatar: ""
    };
    if (user?.uid) {
      try {
        localStorage.setItem(`smartattend-cached-profile-${user.uid}`, JSON.stringify(updated));
      } catch (_) { }
    }
    return updated;
  });
};

// =========================================================
// LOGOUT
// =========================================================

const handleLogout = async () => {
  try {
    if (user?.uid) {
      localStorage.removeItem(`smartattend-cached-profile-${user.uid}`);
    }
    localStorage.removeItem("smartattend-user-role");
    localStorage.removeItem("smartattend_student_device_locked");
    localStorage.removeItem("smartattend_device_locked");
    localStorage.removeItem("smartattend_face_enrolled");
    localStorage.removeItem("smartattend_hw_enrolled");
    localStorage.removeItem("smartattend_hardware_biometric_enrolled");
    localStorage.removeItem("smartattend_just_logged_in");
    sessionStorage.clear();
    await firebaseLogoutUser();
    setUser(null);
    setProfile(null);
  } catch (error) {
    console.error("Logout error:", error);
    throw error;
  }
};

return (
  <AuthContext.Provider
    value={{
      user,
      profile,
      loading,
      loginWithGoogle,
      updateProfileName,
      updateProfileSemester,
      updateProfilePhoto,
      deleteProfilePhoto,
      logoutUser: handleLogout
    }}
  >
    {children}
  </AuthContext.Provider>
);
};

export const useAuth = () => useContext(AuthContext);