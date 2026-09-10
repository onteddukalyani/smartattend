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

    // Also query collections by rollNo and email to catch any docs keyed with random IDs
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
    const [studentsSnap, usersSnap, authSnap] = await Promise.all([
      getDocs(collection(db, "students")),
      getDocs(collection(db, "users")),
      getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] }))
    ]);

    // Map unique registered profiles by rollNo or primary docId
    const registeredProfiles = new Map();

    [...studentsSnap.docs, ...usersSnap.docs, ...authSnap.docs].forEach((docSnap) => {
      const data = docSnap.data();
      if (data && Array.isArray(data.faceDescriptor) && data.faceDescriptor.length === 128) {
        let roll = String(data.rollNo || docSnap.id || "").trim().toUpperCase();
        if (roll.includes("@")) roll = roll.split("@")[0].toUpperCase();
        const email = String(data.email || "").trim().toLowerCase();
        const name = data.name || data.fullName || "Registered Student";

        // Skip if this doc belongs to the target student being enrolled/updated
        const isSameStudent =
          (cleanTargetRoll && roll === cleanTargetRoll) ||
          (cleanTargetEmail && email === cleanTargetEmail) ||
          (targetPrefix && roll === targetPrefix) ||
          (cleanTargetRoll && docSnap.id.toUpperCase() === cleanTargetRoll) ||
          (cleanTargetEmail && docSnap.id.toLowerCase() === cleanTargetEmail);

        if (!isSameStudent && !registeredProfiles.has(roll)) {
          registeredProfiles.set(roll, {
            rollNo: roll,
            name: name,
            email: email,
            faceDescriptor: data.faceDescriptor
          });
        }
      }
    });

    // Compare newDescriptor against all other registered profiles
    for (const profile of registeredProfiles.values()) {
      const dist = calculateFaceDistance(newDescriptor, profile.faceDescriptor);
      if (dist <= threshold) {
        const confidence = Math.max(0, Math.min(100, Math.round((1 - (dist / 0.60)) * 100)));
        return {
          isDuplicate: true,
          conflictStudent: {
            name: profile.name,
            rollNo: profile.rollNo,
            email: profile.email,
            distance: dist,
            confidence: confidence
          }
        };
      }
    }

    return { isDuplicate: false };
  } catch (err) {
    console.error("Error during checkDuplicateFaceBiometrics:", err);
    return { isDuplicate: false };
  }
}
