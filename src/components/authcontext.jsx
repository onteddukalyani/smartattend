import React, {
  createContext,
  useContext,
  useEffect,
  useState
} from "react";

import { onAuthStateChanged } from "firebase/auth";

import {
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  query,
  where
} from "firebase/firestore";

import {
  auth,
  db,
  loginWithGoogle as firebaseLoginWithGoogle,
  logoutUser as firebaseLogoutUser
} from "../firebase";
import { isGenericName } from "../utils/studentDataHelper";

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {

  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  // =========================================================
  // LOOKUP REGISTERED USER IN FIRESTORE (READ-ONLY VERIFICATION)
  // =========================================================

  const lookupUserInSystem = async (email) => {
    if (!email) return null;
    const cleanEmail = email.toLowerCase().trim();
    const prefix = cleanEmail.split("@")[0].toLowerCase().trim(); // Before @
    const rollFromEmail = prefix.toUpperCase();

    try {
      // Candidate result
      let matchedResult = null;

      // 1. Check admins collection by prefix
      const adminPrefixSnap = await getDoc(doc(db, "admins", prefix)).catch(() => ({ exists: () => false }));
      if (adminPrefixSnap.exists()) {
        const d = adminPrefixSnap.data();
        matchedResult = { id: adminPrefixSnap.id, ...d, email: d.email || cleanEmail, role: "admin" };
      } else {
        // 2. Check admins collection by email doc ID
        const adminEmailSnap = await getDoc(doc(db, "admins", cleanEmail)).catch(() => ({ exists: () => false }));
        if (adminEmailSnap.exists()) {
          const d = adminEmailSnap.data();
          matchedResult = { id: adminEmailSnap.id, ...d, email: cleanEmail, role: "admin" };
        }
      }

      if (!matchedResult) {
        // 3. Query admins collection by email field
        const adminQuery = query(collection(db, "admins"), where("email", "==", cleanEmail));
        const adminQuerySnap = await getDocs(adminQuery).catch(() => ({ empty: true }));
        if (!adminQuerySnap.empty) {
          const d = adminQuerySnap.docs[0].data();
          matchedResult = { id: adminQuerySnap.docs[0].id, ...d, email: cleanEmail, role: "admin" };
        }
      }

      if (matchedResult) return matchedResult;

      // 4. Check lecturers collection by prefix
      const lectPrefixSnap = await getDoc(doc(db, "lecturers", prefix)).catch(() => ({ exists: () => false }));
      if (lectPrefixSnap.exists()) {
        const d = lectPrefixSnap.data();
        matchedResult = { id: lectPrefixSnap.id, ...d, email: d.email || cleanEmail, role: "lecturer" };
      } else {
        // 5. Check lecturers collection by email doc ID
        const lectEmailSnap = await getDoc(doc(db, "lecturers", cleanEmail)).catch(() => ({ exists: () => false }));
        if (lectEmailSnap.exists()) {
          const d = lectEmailSnap.data();
          matchedResult = { id: lectEmailSnap.id, ...d, email: cleanEmail, role: "lecturer" };
        }
      }

      if (!matchedResult) {
        // 6. Query lecturers collection by email field
        const lectQuery = query(collection(db, "lecturers"), where("email", "==", cleanEmail));
        const lectQuerySnap = await getDocs(lectQuery).catch(() => ({ empty: true }));
        if (!lectQuerySnap.empty) {
          const d = lectQuerySnap.docs[0].data();
          matchedResult = { id: lectQuerySnap.docs[0].id, ...d, email: cleanEmail, role: "lecturer" };
        }
      }

      if (matchedResult) return matchedResult;

      // 7. Check student records across students, users, and authorizedUsers simultaneously
      const [studentRollSnap, studentPrefixSnap, studentEmailDocSnap, userRollSnap, userPrefixSnap, authPrefixSnap, authEmailSnap] = await Promise.all([
        getDoc(doc(db, "students", rollFromEmail)).catch(() => ({ exists: () => false })),
        prefix !== rollFromEmail.toLowerCase() ? getDoc(doc(db, "students", prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        getDoc(doc(db, "students", cleanEmail)).catch(() => ({ exists: () => false })),
        getDoc(doc(db, "users", rollFromEmail)).catch(() => ({ exists: () => false })),
        prefix !== rollFromEmail.toLowerCase() ? getDoc(doc(db, "users", prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        getDoc(doc(db, "authorizedUsers", prefix)).catch(() => ({ exists: () => false })),
        getDoc(doc(db, "authorizedUsers", cleanEmail)).catch(() => ({ exists: () => false }))
      ]);

      const candidateDocs = [
        authEmailSnap.exists() ? authEmailSnap.data() : null,
        authPrefixSnap.exists() ? authPrefixSnap.data() : null,
        userPrefixSnap.exists() ? userPrefixSnap.data() : null,
        userRollSnap.exists() ? userRollSnap.data() : null,
        studentEmailDocSnap.exists() ? studentEmailDocSnap.data() : null,
        studentPrefixSnap.exists() ? studentPrefixSnap.data() : null,
        studentRollSnap.exists() ? studentRollSnap.data() : null
      ].filter(Boolean);

      if (candidateDocs.length > 0) {
        let merged = {};
        let authoritativeName = "";
        let isExplicitlyFaceRemoved = false;
        let mostRecentRemovalTime = 0;

        for (const c of candidateDocs) {
          if (!authoritativeName && c.name && !isGenericName(c.name, rollFromEmail, cleanEmail)) {
            authoritativeName = String(c.name).trim();
          }
          if (!authoritativeName && c.fullName && !isGenericName(c.fullName, rollFromEmail, cleanEmail)) {
            authoritativeName = String(c.fullName).trim();
          }
          if (!authoritativeName && c.displayName && !isGenericName(c.displayName, rollFromEmail, cleanEmail)) {
            authoritativeName = String(c.displayName).trim();
          }
          if (c.faceRemovedAt || c.faceRegistered === false || c.biometricEnrolled === false || c.hasFaceRegistered === false) {
            isExplicitlyFaceRemoved = true;
            if (typeof c.faceRemovedAt === "number" && c.faceRemovedAt > mostRecentRemovalTime) {
              mostRecentRemovalTime = c.faceRemovedAt;
            }
          }
          merged = {
            ...merged,
            ...c,
            faceDescriptor: c.faceDescriptor || merged.faceDescriptor,
            photoURL: c.photoURL || c.photo || c.image || merged.photoURL || "",
            branch: (c.branch && String(c.branch).toLowerCase() !== "general") ? c.branch : (merged.branch || "CSE"),
            semester: c.semester || merged.semester,
            rollNo: c.rollNo || merged.rollNo || rollFromEmail,
            role: c.role || merged.role || "student"
          };
        }

        if (isExplicitlyFaceRemoved) {
          merged.faceDescriptor = null;
          merged.faceRegistered = false;
          merged.biometricEnrolled = false;
          merged.hasFaceRegistered = false;
          merged.faceRemovedAt = mostRecentRemovalTime || Date.now();
        }

        const finalName = authoritativeName || merged.name || merged.fullName || "";
        return {
          id: rollFromEmail || cleanEmail,
          ...merged,
          name: finalName,
          fullName: finalName,
          email: merged.email || cleanEmail,
          rollNo: merged.rollNo || rollFromEmail,
          role: String(merged.role || "student").trim().toLowerCase()
        };
      }

      // 8. Query by email / rollNo fields as fallback
      const [qStudentEmail, qStudentRoll, qUserEmail, qAuthEmail] = await Promise.all([
        getDocs(query(collection(db, "students"), where("email", "==", cleanEmail))).catch(() => ({ empty: true })),
        getDocs(query(collection(db, "students"), where("rollNo", "==", rollFromEmail))).catch(() => ({ empty: true })),
        getDocs(query(collection(db, "users"), where("email", "==", cleanEmail))).catch(() => ({ empty: true })),
        getDocs(query(collection(db, "authorizedUsers"), where("email", "==", cleanEmail))).catch(() => ({ empty: true }))
      ]);

      const fieldDocs = [
        !qAuthEmail.empty ? qAuthEmail.docs[0].data() : null,
        !qUserEmail.empty ? qUserEmail.docs[0].data() : null,
        !qStudentEmail.empty ? qStudentEmail.docs[0].data() : null,
        !qStudentRoll.empty ? qStudentRoll.docs[0].data() : null
      ].filter(Boolean);

      if (fieldDocs.length > 0) {
        let merged = {};
        let authoritativeName = "";
        let isExplicitlyFaceRemoved = false;
        let mostRecentRemovalTime = 0;

        for (const c of fieldDocs) {
          if (!authoritativeName && c.name && !isGenericName(c.name, rollFromEmail, cleanEmail)) {
            authoritativeName = String(c.name).trim();
          }
          if (!authoritativeName && c.fullName && !isGenericName(c.fullName, rollFromEmail, cleanEmail)) {
            authoritativeName = String(c.fullName).trim();
          }
          if (!authoritativeName && c.displayName && !isGenericName(c.displayName, rollFromEmail, cleanEmail)) {
            authoritativeName = String(c.displayName).trim();
          }
          if (c.faceRemovedAt || c.faceRegistered === false || c.biometricEnrolled === false || c.hasFaceRegistered === false) {
            isExplicitlyFaceRemoved = true;
            if (typeof c.faceRemovedAt === "number" && c.faceRemovedAt > mostRecentRemovalTime) {
              mostRecentRemovalTime = c.faceRemovedAt;
            }
          }
          merged = {
            ...merged,
            ...c,
            faceDescriptor: c.faceDescriptor || merged.faceDescriptor,
            photoURL: c.photoURL || c.photo || c.image || merged.photoURL || "",
            branch: (c.branch && String(c.branch).toLowerCase() !== "general") ? c.branch : (merged.branch || "CSE"),
            semester: c.semester || merged.semester,
            rollNo: c.rollNo || merged.rollNo || rollFromEmail,
            role: c.role || merged.role || "student"
          };
        }

        if (isExplicitlyFaceRemoved) {
          merged.faceDescriptor = null;
          merged.faceRegistered = false;
          merged.biometricEnrolled = false;
          merged.hasFaceRegistered = false;
          merged.faceRemovedAt = mostRecentRemovalTime || Date.now();
        }

        const finalName = authoritativeName || merged.name || merged.fullName || "";
        return {
          id: rollFromEmail || cleanEmail,
          ...merged,
          name: finalName,
          fullName: finalName,
          email: merged.email || cleanEmail,
          rollNo: merged.rollNo || rollFromEmail,
          role: String(merged.role || "student").trim().toLowerCase()
        };
      }

      // Not found anywhere in admins, lecturers, students, authorizedUsers, or users -> NOT REGISTERED
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
    const cleanRollNo = registeredUser.rollNo || (databaseRole === "student" ? prefix.toUpperCase() : undefined);
    const branch = (registeredUser.branch && String(registeredUser.branch).toLowerCase() !== "general")
      ? registeredUser.branch
      : ((registeredUser.department && String(registeredUser.department).toLowerCase() !== "general") ? registeredUser.department : "CSE");

    // STRICT: Extract name strictly from database record only (never from email or Google account)
    const databaseName = (registeredUser.name && !isGenericName(registeredUser.name, cleanRollNo, cleanEmail))
      ? registeredUser.name.trim()
      : (registeredUser.fullName && !isGenericName(registeredUser.fullName, cleanRollNo, cleanEmail) ? registeredUser.fullName.trim() : "");

    const resolvedName = databaseName || (databaseRole === "student" ? (cleanRollNo || "Student") : prefix);

    // Use profile photo from database if present, or fallback to photo from the login email (Google account)
    const resolvedPhoto = registeredUser.photoURL || registeredUser.photo || registeredUser.image || registeredUser.avatar || registeredUser.profilePic || currentUser.photoURL || "";

    // Strict biometrics check: If removed by admin or invalid vector, immediately mark false
    const hasFaceRemoval = Boolean(
      registeredUser.faceRemovedAt ||
      registeredUser.faceRegistered === false ||
      registeredUser.biometricEnrolled === false ||
      registeredUser.hasFaceRegistered === false ||
      !registeredUser.faceDescriptor ||
      (Array.isArray(registeredUser.faceDescriptor) && registeredUser.faceDescriptor.length !== 128)
    );

    const hasValidFace = Boolean(
      !hasFaceRemoval &&
      Array.isArray(registeredUser.faceDescriptor) &&
      registeredUser.faceDescriptor.length === 128
    );

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
      faceDescriptor: hasValidFace ? registeredUser.faceDescriptor : null,
      faceRegistered: hasValidFace,
      biometricEnrolled: hasValidFace,
      hasFaceRegistered: hasValidFace,
      faceRemovedAt: registeredUser.faceRemovedAt || (hasFaceRemoval ? Date.now() : null),
      approved: registeredUser.approved !== false,
      status: registeredUser.status || "active"
    };
  };

  // =========================================================
  // ON AUTH STATE CHANGED (STRICT READ-ONLY: ZERO DATABASE WRITES)
  // =========================================================
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(
      auth,
      async (currentUser) => {
        try {
          if (!currentUser || !currentUser.email) {
            setUser(null);
            setProfile(null);
            return;
          }

          const registeredUser = await lookupUserInSystem(currentUser.email);

          if (!registeredUser) {
            console.warn("Unregistered user attempted access on session restore:", currentUser.email);
            await firebaseLogoutUser();
            setUser(null);
            setProfile(null);
            return;
          }

          // If account is deactivated or unapproved, deny access
          if (registeredUser.status === "disabled" || registeredUser.approved === false) {
            console.warn("Deactivated or unapproved user attempted access:", currentUser.email);
            await firebaseLogoutUser();
            setUser(null);
            setProfile(null);
            return;
          }

          const enrichedProfile = buildEnrichedProfile(registeredUser, currentUser);

          // Grant access without modifying or writing to the database
          setUser(currentUser);
          setProfile(enrichedProfile);

        } catch (error) {
          console.error("Error restoring authentication:", error);
          setUser(null);
          setProfile(null);
        } finally {
          setLoading(false);
        }
      }
    );

    return () => unsubscribe();
  }, []);

  // =========================================================
  // GOOGLE LOGIN (STRICT READ-ONLY: ONLY PRE-REGISTERED USERS ALLOWED, ZERO WRITES)
  // =========================================================

  const loginWithGoogle = async (selectedRole) => {
    const selected = String(selectedRole || "").trim().toLowerCase();

    if (
      selected !== "admin" &&
      selected !== "lecturer" &&
      selected !== "student"
    ) {
      throw new Error("Please select a valid role before signing in.");
    }

    // Open Google login popup
    const result = await firebaseLoginWithGoogle();
    const currentUser = result.user;

    if (!currentUser || !currentUser.email) {
      await firebaseLogoutUser();
      throw new Error("Unable to retrieve Google user credentials. Please try again.");
    }

    const cleanEmail = currentUser.email.toLowerCase().trim();

    // -------------------------------------------------------
    // STRICT VERIFICATION: MUST EXIST IN DATABASE
    // -------------------------------------------------------
    const registeredUser = await lookupUserInSystem(cleanEmail);

    if (!registeredUser) {
      // User is completely unregistered - kick out immediately, do NOT save to database
      await firebaseLogoutUser();
      throw new Error(
        `Access Denied: This Google account (${currentUser.email}) is not registered in the system. Only pre-registered students and staff can log in. Please contact the administrator to get your account registered.`
      );
    }

    // Check account status & approval
    if (registeredUser.status === "disabled") {
      await firebaseLogoutUser();
      throw new Error(
        `Access Denied: Your account (${currentUser.email}) has been deactivated by the administrator.`
      );
    }

    if (registeredUser.approved === false) {
      await firebaseLogoutUser();
      throw new Error(
        `Access Denied: Your account (${currentUser.email}) is pending approval by the institution administrator.`
      );
    }

    // Role verification
    const databaseRole = normalizeRole(registeredUser.role);
    if (databaseRole !== selected) {
      await firebaseLogoutUser();
      throw new Error(
        `Role Mismatch: You selected "${selected}", but your account is registered as "${databaseRole}". Please select "${databaseRole}" to log in.`
      );
    }

    // Set role & session in local storage
    localStorage.setItem("smartattend-user-role", selected);

    const prefix = cleanEmail.split("@")[0].toLowerCase().trim();
    const cleanRollNo = registeredUser.rollNo || (databaseRole === "student" ? prefix.toUpperCase() : undefined);
    const branch = (registeredUser.branch && String(registeredUser.branch).toLowerCase() !== "general")
      ? registeredUser.branch
      : ((registeredUser.department && String(registeredUser.department).toLowerCase() !== "general") ? registeredUser.department : "CSE");

    // STRICT: Extract name strictly from database record only (never from email or Google account)
    const databaseName = (registeredUser.name && !isGenericName(registeredUser.name, cleanRollNo, cleanEmail))
      ? registeredUser.name.trim()
      : (registeredUser.fullName && !isGenericName(registeredUser.fullName, cleanRollNo, cleanEmail) ? registeredUser.fullName.trim() : "");

    const resolvedName = databaseName || (databaseRole === "student" ? (cleanRollNo || "Student") : prefix);

    // Use profile photo from database if present, or fallback to photo from the login email (Google account)
    const resolvedPhoto = registeredUser.photoURL || registeredUser.photo || registeredUser.image || registeredUser.avatar || registeredUser.profilePic || currentUser.photoURL || "";

    const enrichedProfile = {
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
      faceDescriptor: registeredUser.faceDescriptor || null,
      faceRegistered: Boolean(
        (Array.isArray(registeredUser.faceDescriptor) && registeredUser.faceDescriptor.length === 128) ||
        ((registeredUser.faceRegistered || registeredUser.biometricEnrolled) && Array.isArray(registeredUser.faceDescriptor) && registeredUser.faceDescriptor.length > 0)
      ),
      biometricEnrolled: Boolean(
        (Array.isArray(registeredUser.faceDescriptor) && registeredUser.faceDescriptor.length === 128) ||
        ((registeredUser.faceRegistered || registeredUser.biometricEnrolled) && Array.isArray(registeredUser.faceDescriptor) && registeredUser.faceDescriptor.length > 0)
      ),
      approved: registeredUser.approved !== false,
      status: registeredUser.status || "active"
    };

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
        promises.push(setDoc(doc(db, "users", rollNo), updatePayload, { merge: true }));
      }
    } else if (role === "lecturer") {
      const lectId = profile?.id || prefix || cleanEmail;
      promises.push(setDoc(doc(db, "lecturers", lectId), updatePayload, { merge: true }));
      promises.push(setDoc(doc(db, "users", lectId), updatePayload, { merge: true }));
    } else if (role === "admin") {
      const adminId = profile?.id || prefix || cleanEmail;
      promises.push(setDoc(doc(db, "admins", adminId), updatePayload, { merge: true }));
      promises.push(setDoc(doc(db, "users", adminId), updatePayload, { merge: true }));
    }

    if (cleanEmail) {
      promises.push(setDoc(doc(db, "authorizedUsers", cleanEmail), updatePayload, { merge: true }).catch(() => { }));
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
  // LOGOUT
  // =========================================================

  const handleLogout = async () => {
    try {
      localStorage.removeItem("smartattend-user-role");
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
        logoutUser: handleLogout
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);