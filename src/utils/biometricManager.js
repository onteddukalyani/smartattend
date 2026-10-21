import {
  collection,
  doc,
  getDocs,
  query,
  where,
  setDoc,
  deleteDoc,
  deleteField
} from "firebase/firestore";
import { db } from "../firebase";

/**
 * Completely and permanently removes facial biometric vectors and all avatar/enrolled photos for a student
 * across all Firestore collections (students, users, authorizedUsers) and all possible document IDs.
 * 
 * @param {Object|string} studentOrRoll - Student object or roll number string
 * @returns {Promise<{ success: boolean, updatedCount: number }>}
 */
export async function removeStudentFaceAndBiometrics(studentOrRoll) {
  try {
    const student = typeof studentOrRoll === "object" ? (studentOrRoll || {}) : { rollNo: studentOrRoll };
    const rawRoll = student.rollNo || student.id || "";
    const cleanRoll = String(rawRoll).trim().toUpperCase();
    const cleanEmail = String(student.email || "").trim().toLowerCase();
    const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase() : (cleanRoll ? cleanRoll.toLowerCase() : "");
    const studentId = student.id ? String(student.id).trim() : "";
    const userDocId = student.userDocId ? String(student.userDocId).trim() : "";
    const uid = student.uid || student.studentUid || "";

    // Comprehensive payload that permanently deletes all biometric & photo fields in Firestore
    const resetPayload = {
      faceDescriptor: deleteField(),
      faceDescriptors: deleteField(),
      descriptor: deleteField(),
      descriptors: deleteField(),
      faceVector: deleteField(),
      faceVectors: deleteField(),
      embedding: deleteField(),
      embeddings: deleteField(),
      photoURL: deleteField(),
      image: deleteField(),
      photo: deleteField(),
      avatar: deleteField(),
      profilePic: deleteField(),
      profileImage: deleteField(),
      faceImage: deleteField(),
      facePhoto: deleteField(),
      enrolledFace: deleteField(),
      faceData: deleteField(),
      faceEnrolled: deleteField(),
      isFaceRegistered: deleteField(),
      faceEnrolledAt: deleteField(),
      enrolledAt: deleteField(),
      biometricVerified: deleteField(),
      biometricRegistered: deleteField(),
      faceRegistered: false,
      biometricEnrolled: false,
      hasFaceRegistered: false,
      faceRemovedAt: Date.now()
    };

    // Candidate direct document IDs across collections
    const studentDocKeys = new Set();
    const userDocKeys = new Set();
    const authUserDocKeys = new Set();
    const legacyDocKeysToDelete = [];

    if (cleanRoll) {
      studentDocKeys.add(cleanRoll);
      userDocKeys.add(cleanRoll);
      authUserDocKeys.add(cleanRoll);
      if (cleanRoll.toLowerCase() !== cleanRoll) {
        studentDocKeys.add(cleanRoll.toLowerCase());
        userDocKeys.add(cleanRoll.toLowerCase());
        authUserDocKeys.add(cleanRoll.toLowerCase());
      }
    }
    if (studentId) {
      studentDocKeys.add(studentId);
      userDocKeys.add(studentId);
      authUserDocKeys.add(studentId);
      if (studentId.includes("@")) {
        legacyDocKeysToDelete.push({ coll: "students", id: studentId });
        legacyDocKeysToDelete.push({ coll: "users", id: studentId });
      }
    }
    if (userDocId) {
      userDocKeys.add(userDocId);
      studentDocKeys.add(userDocId);
      authUserDocKeys.add(userDocId);
    }
    if (uid) {
      userDocKeys.add(uid);
      studentDocKeys.add(uid);
      authUserDocKeys.add(uid);
    }
    if (cleanEmail) {
      authUserDocKeys.add(cleanEmail);
      studentDocKeys.add(cleanEmail);
      userDocKeys.add(cleanEmail);
      legacyDocKeysToDelete.push({ coll: "students", id: cleanEmail });
      legacyDocKeysToDelete.push({ coll: "users", id: cleanEmail });
    }
    if (prefix && prefix !== cleanRoll.toLowerCase()) {
      studentDocKeys.add(prefix);
      userDocKeys.add(prefix);
      authUserDocKeys.add(prefix);
      legacyDocKeysToDelete.push({ coll: "students", id: prefix });
      legacyDocKeysToDelete.push({ coll: "users", id: prefix });
    }

    // Also query collections by rollNo, email, and uid fields
    const queryPromises = [];
    if (cleanRoll) {
      queryPromises.push(getDocs(query(collection(db, "students"), where("rollNo", "==", cleanRoll))).catch(() => ({ docs: [] })));
      queryPromises.push(getDocs(query(collection(db, "students"), where("rollNo", "==", cleanRoll.toLowerCase()))).catch(() => ({ docs: [] })));
      queryPromises.push(getDocs(query(collection(db, "users"), where("rollNo", "==", cleanRoll))).catch(() => ({ docs: [] })));
      queryPromises.push(getDocs(query(collection(db, "users"), where("rollNo", "==", cleanRoll.toLowerCase()))).catch(() => ({ docs: [] })));
      queryPromises.push(getDocs(query(collection(db, "authorizedUsers"), where("rollNo", "==", cleanRoll))).catch(() => ({ docs: [] })));
      queryPromises.push(getDocs(query(collection(db, "authorizedUsers"), where("rollNo", "==", cleanRoll.toLowerCase()))).catch(() => ({ docs: [] })));
    }
    if (cleanEmail) {
      queryPromises.push(getDocs(query(collection(db, "students"), where("email", "==", cleanEmail))).catch(() => ({ docs: [] })));
      queryPromises.push(getDocs(query(collection(db, "users"), where("email", "==", cleanEmail))).catch(() => ({ docs: [] })));
      queryPromises.push(getDocs(query(collection(db, "authorizedUsers"), where("email", "==", cleanEmail))).catch(() => ({ docs: [] })));
    }
    if (uid) {
      queryPromises.push(getDocs(query(collection(db, "students"), where("uid", "==", uid))).catch(() => ({ docs: [] })));
      queryPromises.push(getDocs(query(collection(db, "users"), where("uid", "==", uid))).catch(() => ({ docs: [] })));
      queryPromises.push(getDocs(query(collection(db, "authorizedUsers"), where("uid", "==", uid))).catch(() => ({ docs: [] })));
    }

    const queryResults = await Promise.all(queryPromises);
    queryResults.forEach((snap) => {
      snap.docs?.forEach((d) => {
        const collName = d.ref.parent.id;
        if (collName === "students") studentDocKeys.add(d.id);
        else if (collName === "users") userDocKeys.add(d.id);
        else if (collName === "authorizedUsers") authUserDocKeys.add(d.id);
      });
    });

    const updatePromises = [];

    // Write reset payload to all identified student docs
    studentDocKeys.forEach((k) => {
      if (k) updatePromises.push(setDoc(doc(db, "students", k), resetPayload, { merge: true }).catch(() => { }));
    });

    // Write reset payload to all identified user docs
    userDocKeys.forEach((k) => {
      if (k) updatePromises.push(setDoc(doc(db, "users", k), resetPayload, { merge: true }).catch(() => { }));
    });

    // Write reset payload to all identified authorizedUsers docs
    authUserDocKeys.forEach((k) => {
      if (k) updatePromises.push(setDoc(doc(db, "authorizedUsers", k), resetPayload, { merge: true }).catch(() => { }));
    });

    // Also delete any redundant email-keyed duplicate docs in students/users collections
    legacyDocKeysToDelete.forEach(({ coll, id }) => {
      if (id && id !== cleanRoll) {
        updatePromises.push(deleteDoc(doc(db, coll, id)).catch(() => { }));
      }
    });

    await Promise.all(updatePromises);
    clearFaceProfilesCache();

    return {
      success: true,
      updatedCount: updatePromises.length
    };
  } catch (err) {
    console.error("Error in removeStudentFaceAndBiometrics:", err);
    throw err;
  }
}

/**
 * Removes only the avatar/display photo for a student while leaving facial biometric vectors intact.
 * 
 * @param {Object|string} studentOrRoll - Student object or roll number string
 * @returns {Promise<{ success: boolean }>}
 */
export async function removeStudentPhotoOnly(studentOrRoll) {
  try {
    const student = typeof studentOrRoll === "object" ? (studentOrRoll || {}) : { rollNo: studentOrRoll };
    const rawRoll = student.rollNo || student.id || "";
    const cleanRoll = String(rawRoll).trim().toUpperCase();
    const cleanEmail = String(student.email || "").trim().toLowerCase();
    const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase() : (cleanRoll ? cleanRoll.toLowerCase() : "");
    const studentId = student.id ? String(student.id).trim() : "";
    const userDocId = student.userDocId ? String(student.userDocId).trim() : "";

    const photoResetPayload = {
      photoURL: deleteField(),
      image: deleteField(),
      photo: deleteField(),
      avatar: deleteField(),
      profilePic: deleteField(),
      profileImage: deleteField(),
      faceImage: deleteField(),
      facePhoto: deleteField(),
      photoRemovedAt: Date.now()
    };

    const studentDocKeys = new Set();
    const userDocKeys = new Set();
    const authUserDocKeys = new Set();

    if (cleanRoll) {
      studentDocKeys.add(cleanRoll);
      userDocKeys.add(cleanRoll);
      authUserDocKeys.add(cleanRoll);
    }
    if (studentId) {
      studentDocKeys.add(studentId);
      userDocKeys.add(studentId);
    }
    if (userDocId) {
      userDocKeys.add(userDocId);
      studentDocKeys.add(userDocId);
    }
    if (cleanEmail) {
      authUserDocKeys.add(cleanEmail);
      studentDocKeys.add(cleanEmail);
      userDocKeys.add(cleanEmail);
    }
    if (prefix) {
      studentDocKeys.add(prefix);
      userDocKeys.add(prefix);
      authUserDocKeys.add(prefix);
    }

    const queryPromises = [];
    if (cleanRoll) {
      queryPromises.push(getDocs(query(collection(db, "students"), where("rollNo", "==", cleanRoll))).catch(() => ({ docs: [] })));
      queryPromises.push(getDocs(query(collection(db, "users"), where("rollNo", "==", cleanRoll))).catch(() => ({ docs: [] })));
    }
    if (cleanEmail) {
      queryPromises.push(getDocs(query(collection(db, "students"), where("email", "==", cleanEmail))).catch(() => ({ docs: [] })));
      queryPromises.push(getDocs(query(collection(db, "users"), where("email", "==", cleanEmail))).catch(() => ({ docs: [] })));
    }

    const queryResults = await Promise.all(queryPromises);
    queryResults.forEach((snap) => {
      snap.docs?.forEach((d) => {
        const collName = d.ref.parent.id;
        if (collName === "students") studentDocKeys.add(d.id);
        else if (collName === "users") userDocKeys.add(d.id);
        else if (collName === "authorizedUsers") authUserDocKeys.add(d.id);
      });
    });

    const updatePromises = [];

    studentDocKeys.forEach((k) => {
      if (k) updatePromises.push(setDoc(doc(db, "students", k), photoResetPayload, { merge: true }).catch(() => { }));
    });
    userDocKeys.forEach((k) => {
      if (k) updatePromises.push(setDoc(doc(db, "users", k), photoResetPayload, { merge: true }).catch(() => { }));
    });
    authUserDocKeys.forEach((k) => {
      if (k) updatePromises.push(setDoc(doc(db, "authorizedUsers", k), photoResetPayload, { merge: true }).catch(() => { }));
    });

    await Promise.all(updatePromises);
    clearFaceProfilesCache();
    return { success: true };
  } catch (err) {
    console.error("Error in removeStudentPhotoOnly:", err);
    throw err;
  }
}

/**
 * Calculates Euclidean distance between two 128-dimensional facial vectors.
 * A distance <= 0.50 indicates the exact same human face.
 * 
 * @param {Array<number>|Float32Array} v1 
 * @param {Array<number>|Float32Array} v2 
 * @returns {number}
 */
export function calculateFaceDistance(v1, v2) {
  if (!v1 || !v2 || v1.length !== 128 || v2.length !== 128) return 1.0;
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const diff = v1[i] - v2[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Checks whether a new 128-D facial vector matches any existing student's face in the database.
 * Prevents multiple students from sharing the same facial biometric template.
 * 
 * @param {Array<number>|Float32Array} newDescriptor - 128-element facial descriptor
 * @param {string} targetRollNo - Roll Number of the student currently being enrolled
 * @param {string} targetEmail - Email of the student currently being enrolled
 * @param {number} threshold - Match threshold (default: 0.50)
 * @returns {Promise<{ isDuplicate: boolean, conflictStudent?: { name: string, rollNo: string, email: string, distance: number, confidence: number } }>}
 */
// In-memory cache for fast duplicate biometrics verification (avoids repeating slow Firestore collection downloads)
let cachedFaceProfiles = null;
let cachedFaceProfilesTimestamp = 0;
const FACE_CACHE_TTL_MS = 60 * 1000; // 60 seconds TTL

export function clearFaceProfilesCache() {
  cachedFaceProfiles = null;
  cachedFaceProfilesTimestamp = 0;
}

/**
 * Checks if a captured 128-D face biometric vector matches any other student in the registry.
 * Uses in-memory caching and targeted indexed queries for near-instant (0-200ms) execution.
 * 
 * @param {Float32Array|Array<number>} newDescriptor - 128-D face embedding
 * @param {string} targetRollNo - Roll number of the student currently being enrolled
 * @param {string} targetEmail - Email of the student currently being enrolled
 * @param {number} threshold - Match threshold (default: 0.50)
 * @returns {Promise<{ isDuplicate: boolean, conflictStudent?: { name: string, rollNo: string, email: string, distance: number, confidence: number } }>}
 */
export async function checkDuplicateFaceBiometrics(
  newDescriptor,
  targetRollNo = "",
  targetEmail = "",
  threshold = 0.50
) {
  if (!newDescriptor || (Array.isArray(newDescriptor) && newDescriptor.length !== 128) || (newDescriptor.length !== 128)) {
    return { isDuplicate: false };
  }

  const cleanTargetRoll = String(targetRollNo || "").trim().toUpperCase();
  const cleanTargetEmail = String(targetEmail || "").trim().toLowerCase();
  const targetPrefix = cleanTargetEmail ? cleanTargetEmail.split("@")[0].toUpperCase() : "";

  try {
    const now = Date.now();
    let profileList = [];

    // Use fast in-memory cache if available (0ms execution on repeat calls)
    if (cachedFaceProfiles && (now - cachedFaceProfilesTimestamp) < FACE_CACHE_TTL_MS) {
      profileList = cachedFaceProfiles;
    } else {
      // Fast targeted fetch: query only students who have face biometrics registered
      const fetchPromise = (async () => {
        let docs = [];
        try {
          const registeredSnap = await getDocs(
            query(collection(db, "students"), where("faceRegistered", "==", true))
          );
          if (!registeredSnap.empty) {
            docs = registeredSnap.docs;
          }
        } catch (_) {
          // Fallback if index is not present
        }

        if (docs.length === 0) {
          const allStudentsSnap = await getDocs(collection(db, "students"));
          docs = allStudentsSnap.docs;
        }

        return docs.map((docSnap) => {
          const data = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
          return {
            id: docSnap.id,
            rollNo: data.rollNo || docSnap.id || "",
            email: data.email || "",
            name: data.name || data.fullName || "Registered Student",
            faceDescriptor: data.faceDescriptor
          };
        }).filter((item) => Array.isArray(item.faceDescriptor) && item.faceDescriptor.length === 128);
      })();

      // Network guard: 3.5s timeout prevents network stalling from blocking face registration
      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve([]), 3500));
      profileList = await Promise.race([fetchPromise, timeoutPromise]);

      if (profileList.length > 0) {
        cachedFaceProfiles = profileList;
        cachedFaceProfilesTimestamp = now;
      } else if (cachedFaceProfiles) {
        profileList = cachedFaceProfiles;
      }
    }

    // Compare newDescriptor against all other registered profiles
    for (const profile of profileList) {
      let roll = String(profile.rollNo || profile.id || "").trim().toUpperCase();
      if (roll.includes("@")) roll = roll.split("@")[0].toUpperCase();
      const email = String(profile.email || "").trim().toLowerCase();

      // Skip matching against the student's own existing record
      const isSameStudent =
        (cleanTargetRoll && roll === cleanTargetRoll) ||
        (cleanTargetEmail && email === cleanTargetEmail) ||
        (targetPrefix && roll === targetPrefix) ||
        (cleanTargetRoll && profile.id && String(profile.id).toUpperCase() === cleanTargetRoll) ||
        (cleanTargetEmail && profile.id && String(profile.id).toLowerCase() === cleanTargetEmail);

      if (isSameStudent) continue;

      const dist = calculateFaceDistance(newDescriptor, profile.faceDescriptor);
      if (dist <= threshold) {
        const confidence = Math.max(65, Math.min(99, Math.round(100 - (dist / 0.60) * 35)));
        return {
          isDuplicate: true,
          conflictStudent: {
            name: profile.name,
            rollNo: roll,
            email: email,
            distance: dist,
            confidence: confidence
          }
        };
      }
    }

    return { isDuplicate: false };
  } catch (err) {
    console.warn("Fast duplicate biometric check warning:", err);
    return { isDuplicate: false };
  }
}
