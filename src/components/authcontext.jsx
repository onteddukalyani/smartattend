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
      // 1. Check admins collection by prefix
      const adminPrefixSnap = await getDoc(doc(db, "admins", prefix)).catch(() => ({ exists: () => false }));
      if (adminPrefixSnap.exists()) {
        const d = adminPrefixSnap.data();
        return { id: adminPrefixSnap.id, ...d, email: d.email || cleanEmail, role: "admin" };
      }

      // 2. Check admins collection by email doc ID
      const adminEmailSnap = await getDoc(doc(db, "admins", cleanEmail)).catch(() => ({ exists: () => false }));
      if (adminEmailSnap.exists()) {
        const d = adminEmailSnap.data();
        return { id: adminEmailSnap.id, ...d, email: cleanEmail, role: "admin" };
      }

      // 3. Query admins collection by email field
      const adminQuery = query(collection(db, "admins"), where("email", "==", cleanEmail));
      const adminQuerySnap = await getDocs(adminQuery).catch(() => ({ empty: true }));
      if (!adminQuerySnap.empty) {
        const d = adminQuerySnap.docs[0].data();
        return { id: adminQuerySnap.docs[0].id, ...d, email: cleanEmail, role: "admin" };
      }

      // 4. Check lecturers collection by prefix
      const lectPrefixSnap = await getDoc(doc(db, "lecturers", prefix)).catch(() => ({ exists: () => false }));
      if (lectPrefixSnap.exists()) {
        const d = lectPrefixSnap.data();
        return { id: lectPrefixSnap.id, ...d, email: d.email || cleanEmail, role: "lecturer" };
      }

      // 5. Check lecturers collection by email doc ID
      const lectEmailSnap = await getDoc(doc(db, "lecturers", cleanEmail)).catch(() => ({ exists: () => false }));
      if (lectEmailSnap.exists()) {
        const d = lectEmailSnap.data();
        return { id: lectEmailSnap.id, ...d, email: cleanEmail, role: "lecturer" };
      }

      // 6. Query lecturers collection by email field
      const lectQuery = query(collection(db, "lecturers"), where("email", "==", cleanEmail));
      const lectQuerySnap = await getDocs(lectQuery).catch(() => ({ empty: true }));
      if (!lectQuerySnap.empty) {
        const d = lectQuerySnap.docs[0].data();
        return { id: lectQuerySnap.docs[0].id, ...d, email: cleanEmail, role: "lecturer" };
      }

      // 7. Check students collection by direct Roll Number ID (e.g. "23BCS001")
      const studentRollSnap = await getDoc(doc(db, "students", rollFromEmail)).catch(() => ({ exists: () => false }));
      if (studentRollSnap.exists()) {
        const d = studentRollSnap.data();
        return { id: studentRollSnap.id, ...d, rollNo: d.rollNo || rollFromEmail, email: d.email || cleanEmail, role: "student" };
      }

      // 8. Check students collection by prefix before @
      const studentPrefixSnap = await getDoc(doc(db, "students", prefix)).catch(() => ({ exists: () => false }));
      if (studentPrefixSnap.exists()) {
        const d = studentPrefixSnap.data();
        return { id: studentPrefixSnap.id, ...d, rollNo: d.rollNo || rollFromEmail, email: d.email || cleanEmail, role: "student" };
      }

      // 9. Check students collection by email doc ID
      const studentEmailDocSnap = await getDoc(doc(db, "students", cleanEmail)).catch(() => ({ exists: () => false }));
      if (studentEmailDocSnap.exists()) {
        const d = studentEmailDocSnap.data();
        return { id: studentEmailDocSnap.id, ...d, rollNo: d.rollNo || rollFromEmail, email: d.email || cleanEmail, role: "student" };
      }

      // 10. Query students collection by email field
      const studentEmailQ = query(collection(db, "students"), where("email", "==", cleanEmail));
      const studentEmailQuerySnap = await getDocs(studentEmailQ).catch(() => ({ empty: true }));
      if (!studentEmailQuerySnap.empty) {
        const d = studentEmailQuerySnap.docs[0].data();
        return { id: studentEmailQuerySnap.docs[0].id, ...d, rollNo: d.rollNo || rollFromEmail, email: d.email || cleanEmail, role: "student" };
      }

      // 11. Query students collection by rollNo field
      const studentRollFieldQ = query(collection(db, "students"), where("rollNo", "==", rollFromEmail));
      const studentRollFieldSnap = await getDocs(studentRollFieldQ).catch(() => ({ empty: true }));
      if (!studentRollFieldSnap.empty) {
        const d = studentRollFieldSnap.docs[0].data();
        return { id: studentRollFieldSnap.docs[0].id, ...d, rollNo: d.rollNo || rollFromEmail, email: d.email || cleanEmail, role: "student" };
      }

      // 12. Check authorizedUsers direct doc ID (prefix before @)
      const authPrefixSnap = await getDoc(doc(db, "authorizedUsers", prefix)).catch(() => ({ exists: () => false }));
      if (authPrefixSnap.exists()) {
        const d = authPrefixSnap.data();
        return { id: authPrefixSnap.id, ...d, email: d.email || cleanEmail, role: String(d.role || "admin").trim().toLowerCase() };
      }

      // 13. Check authorizedUsers direct doc ID (full email)
      const authRef = doc(db, "authorizedUsers", cleanEmail);
      const authSnap = await getDoc(authRef).catch(() => ({ exists: () => false }));
      if (authSnap.exists()) {
        const d = authSnap.data();
        return { id: authSnap.id, ...d, email: cleanEmail, role: String(d.role || "").trim().toLowerCase() };
      }

      // 14. Check users collection by prefix before @
      const userPrefixRef = doc(db, "users", prefix);
      const userPrefixSnap = await getDoc(userPrefixRef).catch(() => ({ exists: () => false }));
      if (userPrefixSnap.exists()) {
        const d = userPrefixSnap.data();
        return { id: userPrefixSnap.id, ...d, rollNo: d.rollNo || (d.role === "student" ? rollFromEmail : undefined), email: d.email || cleanEmail, role: String(d.role || (d.rollNo ? "student" : "admin")).trim().toLowerCase() };
      }

      // 15. Check users collection by direct Roll Number ID
      const userRollRef = doc(db, "users", rollFromEmail);
      const userRollSnap = await getDoc(userRollRef).catch(() => ({ exists: () => false }));
      if (userRollSnap.exists()) {
        const d = userRollSnap.data();
        return { id: userRollSnap.id, ...d, rollNo: d.rollNo || rollFromEmail, email: d.email || cleanEmail, role: String(d.role || (d.rollNo ? "student" : "")).trim().toLowerCase() };
      }

      // 16. Check users collection by full email doc ID
      const userEmailRef = doc(db, "users", cleanEmail);
      const userEmailSnap = await getDoc(userEmailRef).catch(() => ({ exists: () => false }));
      if (userEmailSnap.exists()) {
        const d = userEmailSnap.data();
        return { id: userEmailSnap.id, ...d, email: cleanEmail, role: String(d.role || "").trim().toLowerCase() };
      }

      // 17. Query users collection by email field
      const emailQ = query(collection(db, "users"), where("email", "==", cleanEmail));
      const emailSnap = await getDocs(emailQ).catch(() => ({ empty: true }));
      if (!emailSnap.empty) {
        const docSnap = emailSnap.docs[0];
        const d = docSnap.data();
        return { id: docSnap.id, ...d, email: cleanEmail, role: String(d.role || (d.rollNo ? "student" : "")).trim().toLowerCase() };
      }

      // 18. Query authorizedUsers collection by email field
      const authEmailQ = query(collection(db, "authorizedUsers"), where("email", "==", cleanEmail));
      const authEmailSnap = await getDocs(authEmailQ).catch(() => ({ empty: true }));
      if (!authEmailSnap.empty) {
        const docSnap = authEmailSnap.docs[0];
        const d = docSnap.data();
        return { id: docSnap.id, ...d, email: cleanEmail, role: String(d.role || "").trim().toLowerCase() };
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

  // =========================================================
  // RESTORE LOGIN AFTER REFRESH (READ-ONLY: ZERO DATABASE WRITES)
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

          // If user is NOT registered in the system, deny access and sign out immediately
          if (!registeredUser) {
            console.warn("Unregistered user attempted access:", currentUser.email);
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

          const databaseRole = normalizeRole(registeredUser.role);
          const cleanEmail = currentUser.email.toLowerCase().trim();
          const prefix = cleanEmail.split("@")[0].toLowerCase().trim();
          const cleanRollNo = registeredUser.rollNo || (databaseRole === "student" ? prefix.toUpperCase() : undefined);
          const branch = (registeredUser.branch && String(registeredUser.branch).toLowerCase() !== "general")
            ? registeredUser.branch
            : ((registeredUser.department && String(registeredUser.department).toLowerCase() !== "general") ? registeredUser.department : "CSE");

          const studentRegisteredName = (registeredUser.name && registeredUser.name.trim())
            ? registeredUser.name.trim()
            : (registeredUser.fullName && registeredUser.fullName.trim() ? registeredUser.fullName.trim() : "");

          const resolvedName = studentRegisteredName || (databaseRole === "student" ? (cleanRollNo || "Student") : (registeredUser.name || currentUser.displayName || prefix));

          const enrichedProfile = {
            id: registeredUser.id || cleanRollNo || cleanEmail,
            ...registeredUser,
            rollNo: cleanRollNo,
            email: cleanEmail,
            name: resolvedName,
            branch: branch,
            semester: registeredUser.semester || "1",
            uid: currentUser.uid,
            role: databaseRole,
            approved: true,
            status: registeredUser.status || "active"
          };

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

    const studentRegisteredName = (registeredUser.name && registeredUser.name.trim())
      ? registeredUser.name.trim()
      : (registeredUser.fullName && registeredUser.fullName.trim() ? registeredUser.fullName.trim() : "");

    const resolvedName = studentRegisteredName || (databaseRole === "student" ? (cleanRollNo || "Student") : (registeredUser.name || currentUser.displayName || prefix));

    const enrichedProfile = {
      id: registeredUser.id || cleanRollNo || cleanEmail,
      ...registeredUser,
      rollNo: cleanRollNo,
      email: cleanEmail,
      name: resolvedName,
      branch: branch,
      semester: registeredUser.semester || "1",
      uid: currentUser.uid,
      role: databaseRole,
      approved: true,
      status: "active"
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