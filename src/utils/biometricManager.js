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
import { removeStudentFaceEnrollment } from "../services/faceEnrollmentService";

/**
 * Completely and permanently removes facial biometric vectors and all avatar/enrolled photos for a student
 * across all Firestore collections (students, users, authorizedUsers) and all possible document IDs.
 * 
 * @param {Object|string} studentOrRoll - Student object or roll number string
 * @returns {Promise<{ success: boolean, updatedCount: number }>}
 */
export async function removeStudentFaceAndBiometrics(studentOrRoll, actorName = "Faculty/Admin") {
  try {
    const student = typeof studentOrRoll === "object" ? (studentOrRoll || {}) : { rollNo: studentOrRoll };
    const rawRoll = student.rollNo || student.id || "";
    const cleanRoll = String(rawRoll).trim().toUpperCase();
    if (!cleanRoll) {
      throw new Error("A valid student roll number is required to remove face enrollment.");
    }
    await removeStudentFaceEnrollment(cleanRoll, actorName);
    return { success: true, updatedCount: 1 };
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
    await Promise.all(updatePromises);
    return { success: true };
  } catch (err) {
    console.error("Error in removeStudentPhotoOnly:", err);
    throw err;
  }
}
