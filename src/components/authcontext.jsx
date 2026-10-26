import React, {
  createContext,
  useContext,
  useEffect,
  useState
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
import { isGenericName, subscribeToStudentUpdates, PROFILE_UPDATED_EVENT } from "../utils/studentDataHelper";
import { reportUserVerificationComplaint } from "../services/notificationsService";
import { registerUserDevice } from "../services/deviceRegistrationService";

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {

  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

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

      // Check Admin
      if (adminPrefixSnap.exists()) {
        const d = adminPrefixSnap.data();
        return { id: adminPrefixSnap.id, ...d, email: d.email || cleanEmail, role: "admin" };
      }
      if (adminEmailSnap.exists()) {
        const d = adminEmailSnap.data();
        return { id: adminEmailSnap.id, ...d, email: cleanEmail, role: "admin" };
      }
      if (adminUidSnap?.exists()) {
        const d = adminUidSnap.data();
        return { id: adminUidSnap.id, ...d, email: d.email || cleanEmail, role: "admin" };
      }
      if (!adminQuerySnap.empty) {
        const d = adminQuerySnap.docs[0].data();
        return { id: adminQuerySnap.docs[0].id, ...d, email: cleanEmail, role: "admin" };
      }

      // Check Lecturer
      if (lectPrefixSnap.exists()) {
        const d = lectPrefixSnap.data();
        return { id: lectPrefixSnap.id, ...d, email: d.email || cleanEmail, role: "lecturer" };
      }
      if (lectEmailSnap.exists()) {
        const d = lectEmailSnap.data();
        return { id: lectEmailSnap.id, ...d, email: cleanEmail, role: "lecturer" };
      }
      if (lectUidSnap?.exists()) {
        const d = lectUidSnap.data();
        return { id: lectUidSnap.id, ...d, email: d.email || cleanEmail, role: "lecturer" };
      }
      if (!lectQuerySnap.empty) {
        const d = lectQuerySnap.docs[0].data();
        return { id: lectQuerySnap.docs[0].id, ...d, email: cleanEmail, role: "lecturer" };
      }

      // 2. CHECK STUDENTS DATABASE COLLECTION BY LOGGED IN EMAIL ID, ROLL, AND UID
      const [
        studentEmailQuerySnap,
        studentEmailDocSnap,
        studentRollSnap,
        studentPrefixSnap,
        studentUidSnap,
        studentUidQuerySnap
      ] = await Promise.all([
        cleanEmail ? getDocs(query(collection(db, "students"), where("email", "==", cleanEmail))).catch(() => ({ empty: true, docs: [] })) : Promise.resolve({ empty: true, docs: [] }),
        cleanEmail ? getDoc(doc(db, "students", cleanEmail)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        rollFromEmail ? getDoc(doc(db, "students", rollFromEmail)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        (prefix && prefix !== rollFromEmail.toLowerCase()) ? getDoc(doc(db, "students", prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        cleanUid ? getDoc(doc(db, "students", cleanUid)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        cleanUid ? getDocs(query(collection(db, "students"), where("uid", "==", cleanUid))).catch(() => ({ empty: true, docs: [] })) : Promise.resolve({ empty: true, docs: [] })
      ]);

      let matchedStudentDoc = null;
      let matchedStudentId = "";

      // A. Query students by exact email
      if (!studentEmailQuerySnap.empty && studentEmailQuerySnap.docs?.[0]) {
        matchedStudentDoc = studentEmailQuerySnap.docs[0].data();
        matchedStudentId = studentEmailQuerySnap.docs[0].id;
      }
      // B. Direct document lookup by email
      else if (studentEmailDocSnap.exists()) {
        matchedStudentDoc = studentEmailDocSnap.data();
        matchedStudentId = studentEmailDocSnap.id;
      }
      // C. Direct document lookup by UID or UID query
      else if (studentUidSnap?.exists()) {
        matchedStudentDoc = studentUidSnap.data();
        matchedStudentId = studentUidSnap.id;
      }
      else if (!studentUidQuerySnap.empty && studentUidQuerySnap.docs?.[0]) {
        matchedStudentDoc = studentUidQuerySnap.docs[0].data();
        matchedStudentId = studentUidQuerySnap.docs[0].id;
      }
      // D. Roll number document lookup in students
      else if (studentRollSnap.exists()) {
        matchedStudentDoc = studentRollSnap.data();
        matchedStudentId = studentRollSnap.id;
      }
      else if (studentPrefixSnap.exists()) {
        matchedStudentDoc = studentPrefixSnap.data();
        matchedStudentId = studentPrefixSnap.id;
      }

      // If student is found in database, USE EXACT DATABASE DETAILS!
      if (matchedStudentDoc) {
        const authoritativeRollNo = String(
          matchedStudentDoc.rollNo ||
          (!matchedStudentId.includes("@") ? matchedStudentId : "")
        ).trim().toUpperCase();

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

        return {
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
          status: matchedStudentDoc.status || "active",
          approved: matchedStudentDoc.approved !== false,
          faceDescriptor: null,
          faceRegistered: hasValidFace,
          biometricEnrolled: hasValidFace,
          hasFaceRegistered: hasValidFace,
          isRegistered: Boolean(matchedStudentDoc.isRegistered || hasValidFace),
          registeredGlobally: Boolean(matchedStudentDoc.registeredGlobally || hasValidFace),
          registrationStatus: (matchedStudentDoc.registrationStatus || (hasValidFace ? "registered" : "pending")),
          faceRemovedAt: hasFaceRemoval ? matchedStudentDoc.faceRemovedAt : null
        };
      }

      // 3. Fallback: Check authorizedUsers & users collections if not yet in students
      const [userRollSnap, userPrefixSnap, authPrefixSnap, authEmailSnap, qUserEmail, qAuthEmail] = await Promise.all([
        getDoc(doc(db, "users", rollFromEmail)).catch(() => ({ exists: () => false })),
        prefix !== rollFromEmail.toLowerCase() ? getDoc(doc(db, "users", prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
        getDoc(doc(db, "authorizedUsers", prefix)).catch(() => ({ exists: () => false })),
        getDoc(doc(db, "authorizedUsers", cleanEmail)).catch(() => ({ exists: () => false })),
        getDocs(query(collection(db, "users"), where("email", "==", cleanEmail))).catch(() => ({ empty: true, docs: [] })),
        getDocs(query(collection(db, "authorizedUsers"), where("email", "==", cleanEmail))).catch(() => ({ empty: true, docs: [] }))
      ]);

      const candidateDocs = [
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
          if (!authoritativeRollNo && c.rollNo && !String(c.rollNo).includes("@")) {
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
            faceDescriptor: null,
            photoURL: c.photoURL || c.photo || c.image || merged.photoURL || "",
            branch: authoritativeBranch || (c.branch && String(c.branch).toLowerCase() !== "general" ? c.branch : (merged.branch || "CSE")),
            semester: authoritativeSemester || c.semester || merged.semester || "1",
            rollNo: authoritativeRollNo || (c.rollNo ? String(c.rollNo).trim().toUpperCase() : (merged.rollNo || "")),
            role: c.role || merged.role || "student"
          };
        }

        if (isExplicitlyFaceRemoved && !merged.faceRegistered && !merged.isRegistered) {
          merged.faceRegistered = false;
          merged.biometricEnrolled = false;
          merged.hasFaceRegistered = false;
          merged.faceRemovedAt = mostRecentRemovalTime || Date.now();
        }
        merged.faceDescriptor = null;
        merged.hasFaceRegistered = Boolean(merged.faceRegistered);

        const finalRollNo = authoritativeRollNo || merged.rollNo || "";
        const finalName = authoritativeName || merged.name || merged.fullName || finalRollNo || "";
        return {
          id: finalRollNo || cleanEmail,
          ...merged,
          name: finalName,
          fullName: finalName,
          email: merged.email || cleanEmail,
          rollNo: finalRollNo,
          role: String(merged.role || "student").trim().toLowerCase()
        };
      }

      // If not registered in authoritative collections (students, users, authorizedUsers), require enrollment
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
      } catch (_) {}
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
      } catch (_) {}
    }

    const resolvedDeviceType = hasDeviceReset ? null : (registeredUser.deviceType || registeredUser.registeredPlatform || null);
    const resolvedDeviceLocked = hasDeviceReset ? false : Boolean(registeredUser.deviceTypeLocked);
    const resolvedIsDeviceRegistered = hasDeviceReset ? false : Boolean(registeredUser.isDeviceRegistered);
    const resolvedHwEnrolled = hasDeviceReset ? false : Boolean(registeredUser.hardwareBiometricEnrolled);

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
      faceDescriptor: null,
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
          } catch (e) {}

          // 2. Perform fresh parallel lookup in Firestore (by email and UID)
          const registeredUser = await lookupUserInSystem(currentUser.email, currentUser.uid);

          if (!isMounted) return;

          if (!registeredUser) {
            console.warn("Unregistered user attempted access on session restore:", currentUser.email);
            try { localStorage.removeItem(cacheKey); } catch (_) {}
            await firebaseLogoutUser();
            setUser(null);
            setProfile(null);
            setLoading(false);
            return;
          }

          // If account is deactivated or unapproved, deny access
          if (registeredUser.status === "disabled" || registeredUser.approved === false) {
            console.warn("Deactivated or unapproved user attempted access:", currentUser.email);
            try { localStorage.removeItem(cacheKey); } catch (_) {}
            await firebaseLogoutUser();
            setUser(null);
            setProfile(null);
            setLoading(false);
            return;
          }

          const enrichedProfile = buildEnrichedProfile(registeredUser, currentUser);

          // Update cache with fresh data
          try {
            localStorage.setItem(cacheKey, JSON.stringify(enrichedProfile));
          } catch (_) {}

          if (isMounted) {
            setUser(currentUser);
            setProfile(enrichedProfile);

            // If user already exists in database, give immediate access without re-storing or re-writing to database
            if (!enrichedProfile.isDeviceRegistered && !registeredUser.deviceType && !registeredUser.deviceTypeLocked) {
              registerUserDevice({
                role: enrichedProfile.role,
                id: enrichedProfile.id,
                rollNo: enrichedProfile.rollNo,
                user: currentUser,
                profile: enrichedProfile
              }).catch(() => {});
            }
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
  // REAL-TIME PROFILE SYNCHRONIZATION (Instant onSnapshot Sync)
  // Reflects staff photo removal, name edits, device resets instantly!
  // =========================================================
  useEffect(() => {
    if (!user || !user.email) return;

    const cleanEmail = user.email.toLowerCase().trim();
    const prefix = cleanEmail.split("@")[0].toLowerCase().trim();
    const role = normalizeRole(profile?.role || "student");
    const rollNo = (profile?.rollNo || (role === "student" ? prefix.toUpperCase() : "")).trim().toUpperCase();

    const targets = [];
    if (role === "student") {
      if (rollNo) {
        targets.push({ coll: "students", id: rollNo });
        targets.push({ coll: "students", id: rollNo.toLowerCase() });
        targets.push({ coll: "users", id: rollNo });
        targets.push({ coll: "users", id: rollNo.toLowerCase() });
        targets.push({ coll: "authorizedUsers", id: rollNo });
        targets.push({ coll: "authorizedUsers", id: rollNo.toLowerCase() });
      }
      if (cleanEmail) {
        targets.push({ coll: "students", id: cleanEmail });
        targets.push({ coll: "users", id: cleanEmail });
        targets.push({ coll: "authorizedUsers", id: cleanEmail });
      }
      if (prefix && prefix !== rollNo.toLowerCase()) {
        targets.push({ coll: "authorizedUsers", id: prefix });
      }
      if (user?.uid) {
        targets.push({ coll: "students", id: user.uid });
        targets.push({ coll: "users", id: user.uid });
      }
    } else {
      if (role === "lecturer") {
        targets.push({ coll: "lecturers", id: cleanEmail });
        targets.push({ coll: "lecturers", id: prefix });
      }
      if (role === "admin") {
        targets.push({ coll: "admins", id: cleanEmail });
        targets.push({ coll: "admins", id: prefix });
      }
      targets.push({ coll: "users", id: cleanEmail });
      if (user?.uid) targets.push({ coll: "users", id: user.uid });
    }

    const unsubs = [];
    targets.forEach(({ coll, id }) => {
      if (!id) return;
      try {
        const unsub = onSnapshot(doc(db, coll, id), (snap) => {
          if (!snap.exists()) return;
          const freshData = snap.data();
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
            } catch (_) {}
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent(PROFILE_UPDATED_EVENT, { detail: enriched }));
            }
            return enriched;
          });
        }, () => {});
        unsubs.push(unsub);
      } catch (_) {}
    });

    return () => {
      unsubs.forEach(u => {
        try { u(); } catch (_) {}
      });
    };
  }, [user?.uid, user?.email, profile?.role, profile?.rollNo]);

  // Real-time synchronization with global student updates dispatched from any tab or modal
  useEffect(() => {
    if (!user) return;
    const unsub = subscribeToStudentUpdates((updatedStudent) => {
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
        setProfile((prev) => {
          if (!prev) return prev;
          const merged = { ...prev, ...updatedStudent };
          const enriched = buildEnrichedProfile(merged, user);
          try {
            localStorage.setItem(`smartattend-cached-profile-${user.uid}`, JSON.stringify(enriched));
          } catch (_) {}
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
    const registeredUser = await lookupUserInSystem(cleanEmail, currentUser.uid);

    if (!registeredUser) {
      // User is completely unregistered - report complaint to Admin & Lecturer and kick out immediately
      await reportUserVerificationComplaint(
        { email: cleanEmail, name: currentUser.displayName || "Unknown User" },
        "Unregistered user attempted access to platform",
        "GOOGLE_LOGIN"
      );
      await firebaseLogoutUser();
      throw new Error(
        `Access Denied: This Google account (${currentUser.email}) is not registered in the system. Only pre-registered students and staff can log in. Please contact the administrator to get your account registered.`
      );
    }

    // Check account status & approval
    if (registeredUser.status === "disabled") {
      await reportUserVerificationComplaint(
        { email: cleanEmail, name: registeredUser.name, rollNo: registeredUser.rollNo },
        "Disabled account attempted login",
        "DEACTIVATED_LOGIN"
      );
      await firebaseLogoutUser();
      throw new Error(
        `Access Denied: Your account (${currentUser.email}) has been deactivated by the administrator.`
      );
    }

    if (registeredUser.approved === false) {
      await reportUserVerificationComplaint(
        { email: cleanEmail, name: registeredUser.name, rollNo: registeredUser.rollNo },
        "Unapproved account attempted login",
        "PENDING_APPROVAL_LOGIN"
      );
      await firebaseLogoutUser();
      throw new Error(
        `Access Denied: Your account (${currentUser.email}) is pending approval by the institution administrator.`
      );
    }

    // Role verification
    const databaseRole = normalizeRole(registeredUser.role);
    if (databaseRole !== selected) {
      await reportUserVerificationComplaint(
        { email: cleanEmail, name: registeredUser.name, rollNo: registeredUser.rollNo },
        `Role Mismatch: User selected "${selected}" but registered as "${databaseRole}"`,
        "ROLE_MISMATCH_LOGIN"
      );
      await firebaseLogoutUser();
      const mismatchErr = new Error(
        `Role Mismatch: You selected "${selected}", but your account is registered as "${databaseRole}". Please select "${databaseRole}" to log in.`
      );
      mismatchErr.code = "ROLE_MISMATCH";
      mismatchErr.selectedRole = selected;
      mismatchErr.registeredRole = databaseRole;
      mismatchErr.email = cleanEmail;
      throw mismatchErr;
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
      faceDescriptor: null,
      faceRegistered: Boolean(
        !registeredUser.faceRemovedAt &&
        (registeredUser.faceRegistered === true ||
          registeredUser.biometricEnrolled === true ||
          registeredUser.hasFaceRegistered === true ||
          (Array.isArray(registeredUser.faceDescriptor) && registeredUser.faceDescriptor.length === 128))
      ),
      biometricEnrolled: Boolean(
        !registeredUser.faceRemovedAt &&
        (registeredUser.faceRegistered === true ||
          registeredUser.biometricEnrolled === true ||
          registeredUser.hasFaceRegistered === true ||
          (Array.isArray(registeredUser.faceDescriptor) && registeredUser.faceDescriptor.length === 128))
      ),
      hasFaceRegistered: Boolean(
        !registeredUser.faceRemovedAt &&
        (registeredUser.faceRegistered === true ||
          registeredUser.biometricEnrolled === true ||
          registeredUser.hasFaceRegistered === true ||
          (Array.isArray(registeredUser.faceDescriptor) && registeredUser.faceDescriptor.length === 128))
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

    const promises = [];

    if (rollNo) {
      promises.push(setDoc(doc(db, "students", rollNo), updatePayload, { merge: true }).catch(() => {}));
      promises.push(setDoc(doc(db, "users", rollNo), updatePayload, { merge: true }).catch(() => {}));
    }
    if (user?.uid) {
      promises.push(setDoc(doc(db, "users", user.uid), updatePayload, { merge: true }).catch(() => {}));
    }
    if (prefix && prefix !== rollNo.toLowerCase()) {
      promises.push(setDoc(doc(db, "students", prefix), updatePayload, { merge: true }).catch(() => {}));
      promises.push(setDoc(doc(db, "users", prefix), updatePayload, { merge: true }).catch(() => {}));
    }
    if (cleanEmail) {
      promises.push(setDoc(doc(db, "authorizedUsers", cleanEmail), updatePayload, { merge: true }).catch(() => {}));
    }

    await Promise.all(promises);

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
      } catch (_) {}
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
      } catch (_) {}
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
        } catch (_) {}
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
      } catch (_) {}
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
        } catch (_) {}
      }
      return updated;
    });
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