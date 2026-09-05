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

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {

  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  // =========================================================
  // AUTO-PERSIST NEW STUDENTS TO FIRESTORE (USERS & AUTHORIZEDUSERS)
  // =========================================================

  const ensureStudentRegistered = async (email, displayName, existingDoc) => {
    try {
      if (!email) return existingDoc;
      const cleanEmail = email.toLowerCase().trim();
      const roll = (existingDoc?.rollNo || cleanEmail.split("@")[0]).toUpperCase().trim();

      let detectedBranch = existingDoc?.branch || "General";
      if (detectedBranch === "General") {
        if (/bcs/i.test(roll)) detectedBranch = "Computer Science";
        else if (/bds/i.test(roll)) detectedBranch = "Data Science";
        else if (/bec/i.test(roll)) detectedBranch = "Electronics";
      }

      const payload = {
        name: existingDoc?.name || displayName || "Student",
        email: cleanEmail,
        rollNo: roll,
        branch: detectedBranch,
        semester: existingDoc?.semester || "1",
        role: "student",
        status: "active",
        faceRegistered: existingDoc?.faceRegistered ?? false,
        createdAt: existingDoc?.createdAt || Date.now()
      };

      // Ensure user record exists in users collection under Roll Number document ID
      const userRef = doc(db, "users", roll);
      const userSnap = await getDoc(userRef).catch(() => ({ exists: () => false }));
      if (!userSnap.exists()) {
        await setDoc(userRef, payload, { merge: true }).catch((err) => {
          console.warn("Could not auto-create student in users:", err);
        });
      }

      // Also ensure student is present in authorizedUsers
      const authUserRef = doc(db, "authorizedUsers", cleanEmail);
      const authSnap = await getDoc(authUserRef).catch(() => ({ exists: () => false }));
      if (!authSnap.exists()) {
        await setDoc(authUserRef, {
          ...payload,
          approved: true
        }, { merge: true }).catch((err) => {
          console.warn("Could not auto-create student in authorizedUsers:", err);
        });
      }

      return payload;
    } catch (e) {
      console.warn("Error ensuring student registration:", e);
      return existingDoc;
    }
  };

  // =========================================================
  // FIND USER IN authorizedUsers
  // =========================================================

  const findAuthorizedUser = async (email) => {
    if (!email) {
      return null;
    }

    try {
      const userRef = doc(
        db,
        "authorizedUsers",
        email
      );

      const userSnap = await getDoc(userRef);

      if (!userSnap.exists()) {
        return null;
      }

      return {
        id: userSnap.id,
        ...userSnap.data()
      };
    } catch (error) {
      console.error("Error checking authorizedUsers:", error);
      return null;
    }
  };

  // =========================================================
  // FIND STUDENT PROFILE IN users (Roll Number as ID)
  // =========================================================

  const findStudentProfile = async (email) => {
    if (!email) return null;
    const cleanEmail = email.toLowerCase().trim();
    const rollFromEmail = cleanEmail.split("@")[0].toUpperCase();

    try {
      // 1. Direct lookup by Roll Number as Document ID
      const rollDoc = await getDoc(doc(db, "users", rollFromEmail));
      if (rollDoc.exists()) {
        const d = rollDoc.data();
        return {
          id: rollDoc.id,
          ...d,
          rollNo: d.rollNo || rollFromEmail,
          name: d.name || cleanEmail.split("@")[0],
          role: "student",
          approved: true
        };
      }

      // 2. Query users collection by email
      const emailQ = query(
        collection(db, "users"),
        where("email", "==", cleanEmail)
      );
      const emailSnap = await getDocs(emailQ);
      if (!emailSnap.empty) {
        const docSnap = emailSnap.docs[0];
        const d = docSnap.data();
        return {
          id: docSnap.id,
          ...d,
          rollNo: d.rollNo || rollFromEmail,
          name: d.name || cleanEmail.split("@")[0],
          role: "student",
          approved: true
        };
      }

      // 3. Fallback: derived roll number from email
      return {
        id: rollFromEmail,
        rollNo: rollFromEmail,
        email: cleanEmail,
        name: cleanEmail.split("@")[0],
        branch: "General",
        semester: "1",
        role: "student",
        approved: true
      };
    } catch (err) {
      console.error("Error looking up student profile:", err);
      return {
        id: rollFromEmail,
        rollNo: rollFromEmail,
        email: cleanEmail,
        role: "student",
        approved: true
      };
    }
  };

  // =========================================================
  // RESTORE LOGIN AFTER REFRESH
  // =========================================================

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(
      auth,
      async (currentUser) => {
        try {
          if (!currentUser) {
            setUser(null);
            setProfile(null);
            return;
          }

          const authorizedUser = await findAuthorizedUser(currentUser.email);

          // If the account is found in authorizedUsers
          if (authorizedUser) {
            const databaseRole = String(authorizedUser.role || "").trim().toLowerCase();

            if (databaseRole === "admin" || databaseRole === "lecturer") {
              if (authorizedUser.approved !== true) {
                await firebaseLogoutUser();
                setUser(null);
                setProfile(null);
                return;
              }
            }

            const defaultRoll = currentUser.email.split("@")[0].toUpperCase();
            setUser(currentUser);
            const enrichedProfile = {
              rollNo: authorizedUser.rollNo || defaultRoll,
              ...authorizedUser,
              uid: currentUser.uid,
              role: databaseRole || "student",
              approved: true
            };
            setProfile(enrichedProfile);

            // Sync auth UID into authorizedUsers & users in Firestore
            if (currentUser.uid) {
              const cleanEmail = currentUser.email.toLowerCase().trim();
              setDoc(doc(db, "authorizedUsers", cleanEmail), {
                uid: currentUser.uid,
                lastLoginAt: Date.now()
              }, { merge: true }).catch(() => {});

              setDoc(doc(db, "users", cleanEmail), {
                uid: currentUser.uid,
                email: cleanEmail,
                name: authorizedUser.name || currentUser.displayName || cleanEmail.split("@")[0],
                role: databaseRole || "lecturer",
                lastLoginAt: Date.now()
              }, { merge: true }).catch(() => {});
            }
            return;
          }

          // If not in authorizedUsers, retrieve or register full student profile using roll number
          const studentDoc = await findStudentProfile(currentUser.email);
          const registered = await ensureStudentRegistered(currentUser.email, currentUser.displayName, studentDoc);
          const studentProfile = {
            id: registered?.rollNo || studentDoc?.rollNo || currentUser.email,
            email: currentUser.email,
            name: registered?.name || studentDoc?.name || currentUser.displayName || "Student",
            rollNo: registered?.rollNo || studentDoc?.rollNo || currentUser.email.split("@")[0].toUpperCase(),
            branch: registered?.branch || studentDoc?.branch || "General",
            semester: registered?.semester || studentDoc?.semester || "1",
            role: "student",
            approved: true,
            ...studentDoc,
            ...registered
          };

          setUser(currentUser);
          setProfile(studentProfile);

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
  // GOOGLE LOGIN
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

    // -------------------------------------------------------
    // STUDENT: ANY ACCOUNT CAN LOGIN & AUTO-REGISTERS
    // -------------------------------------------------------
    if (selected === "student") {
      const studentDoc = await findStudentProfile(currentUser.email);
      const registered = await ensureStudentRegistered(currentUser.email, currentUser.displayName, studentDoc);
      const studentProfile = {
        id: registered?.rollNo || studentDoc?.rollNo || currentUser.email,
        email: currentUser.email,
        name: registered?.name || studentDoc?.name || currentUser.displayName || "Student",
        rollNo: registered?.rollNo || studentDoc?.rollNo || currentUser.email.split("@")[0].toUpperCase(),
        branch: registered?.branch || studentDoc?.branch || "General",
        semester: registered?.semester || studentDoc?.semester || "1",
        role: "student",
        approved: true,
        ...studentDoc,
        ...registered
      };

      localStorage.setItem("smartattend-user-role", "student");
      setUser(currentUser);
      setProfile(studentProfile);
      return studentProfile;
    }

    // -------------------------------------------------------
    // ADMIN & LECTURER: ENFORCE AUTHORIZATION
    // -------------------------------------------------------
    const authorizedUser = await findAuthorizedUser(currentUser.email);

    if (!authorizedUser) {
      await firebaseLogoutUser();
      throw new Error(`This Google account is not registered as a ${selected} by the institution.`);
    }

    if (authorizedUser.approved !== true) {
      await firebaseLogoutUser();
      throw new Error(`Your ${selected} account has not been approved by the institution.`);
    }

    const databaseRole = String(authorizedUser.role || "").trim().toLowerCase();

    if (databaseRole !== selected) {
      await firebaseLogoutUser();
      throw new Error(`You selected "${selected}", but this account is registered as "${databaseRole}".`);
    }

    localStorage.setItem("smartattend-user-role", selected);
    const enrichedAuthUser = {
      ...authorizedUser,
      uid: currentUser.uid,
      role: databaseRole
    };
    setUser(currentUser);
    setProfile(enrichedAuthUser);

    // Sync auth UID into authorizedUsers & users in Firestore
    const cleanEmail = currentUser.email.toLowerCase().trim();
    setDoc(doc(db, "authorizedUsers", cleanEmail), {
      uid: currentUser.uid,
      lastLoginAt: Date.now()
    }, { merge: true }).catch(() => {});

    setDoc(doc(db, "users", cleanEmail), {
      uid: currentUser.uid,
      email: cleanEmail,
      name: authorizedUser.name || currentUser.displayName || cleanEmail.split("@")[0],
      role: databaseRole,
      lastLoginAt: Date.now()
    }, { merge: true }).catch(() => {});

    return enrichedAuthUser;
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
        logoutUser: handleLogout
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);