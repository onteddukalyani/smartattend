import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  query,
  where,
  writeBatch
} from "firebase/firestore";
import { db } from "../firebase";
import { GENERIC_IDENTIFIERS, ROLL_PATTERN, broadcastStudentUpdate } from "./studentDataHelper";

/**
 * Global User Management Service
 * Handles unified, cross-collection cascading deletion and deduplication
 * for all user roles: Lecturer, Admin, and Student.
 */

export const USER_DELETED_EVENT = "smartattend_user_purged_globally";

/**
 * Permanently and completely purges a user (Lecturer, Admin, Student, or Generic)
 * from ALL collections and associations across Firestore:
 * - users
 * - lecturers
 * - admins
 * - students
 * - authorizedUsers
 * - devices
 * - biometric_credentials
 * - biometric_challenges
 * - biometric_reregistration_permissions
 * - student_notifications
 * - face_enrollment_reviews
 *
 * Also safely unassigns the user from all courses (assignedLecturers, lecturerEmail, student rosters).
 */
export async function purgeUserCompletelyFromAllDatabases(user, roleHint = "") {
  if (!user) return { success: false, reason: "No user provided" };

  const rawId = String(user.id || user._id || "").trim();
  const rawEmail = String(
    user.email || user.emailKey || (rawId.includes("@") ? rawId : "")
  ).toLowerCase().trim();
  const prefix = rawEmail ? rawEmail.split("@")[0].toLowerCase().trim() : "";
  const uid = String(
    user.uid || user.studentUid || user.deviceBoundUid || (rawId.length >= 20 && !rawId.includes("@") ? rawId : "")
  ).trim();

  // Extract roll number if student or roll-like string
  const rawRoll = String(
    user.rollNo ||
    user.rollNumber ||
    (!rawId.includes("@") && rawId.length <= 15 ? rawId : "")
  ).toUpperCase().trim();

  const isRollValid = rawRoll && !GENERIC_IDENTIFIERS.has(rawRoll.toLowerCase()) && !rawRoll.includes("@");
  const cleanRollNo = isRollValid ? rawRoll : "";
  const rollLower = cleanRollNo ? cleanRollNo.toLowerCase() : "";
  const constructedEmail = rollLower ? `${rollLower}@iiitdwd.ac.in` : "";

  const userDocId = String(user.userDocId || "").trim();
  const lecturerDocId = String(user.lecturerDocId || "").trim();
  const adminDocId = String(user.adminDocId || "").trim();

  // Determine detected role
  const detectedRole = (
    roleHint ||
    user.role ||
    (user.isAdmin ? "admin" : (cleanRollNo ? "student" : (lecturerDocId ? "lecturer" : "")))
  ).toLowerCase().trim();

  // Collect all unique candidate direct document IDs to delete
  const candidateKeys = new Set(
    [
      rawId,
      rawEmail,
      prefix,
      uid,
      cleanRollNo,
      rollLower,
      userDocId,
      lecturerDocId,
      adminDocId,
      constructedEmail
    ].filter(
      (k) =>
        k &&
        k.length > 0 &&
        !GENERIC_IDENTIFIERS.has(k.toLowerCase()) &&
        k !== "undefined" &&
        k !== "null"
    )
  );

  const primaryCollections = [
    "users",
    "lecturers",
    "admins",
    "students",
    "authorizedUsers",
    "devices",
    "biometric_credentials",
    "biometric_challenges",
    "biometric_reregistration_permissions",
    "face_enrollment_reviews"
  ];

  const deletePromises = [];

  // 1. DIRECT KEY DELETIONS ACROSS ALL TARGET COLLECTIONS
  for (const coll of primaryCollections) {
    for (const key of candidateKeys) {
      deletePromises.push(
        deleteDoc(doc(db, coll, key)).catch((err) => {
          console.debug(`[Purge] Direct delete ${coll}/${key}:`, err.message);
        })
      );
    }
  }

  // 2. QUERY-BASED DELETIONS (Catches records keyed by arbitrary UIDs/hashes)
  const queryPromises = [];
  const queryCollections = ["users", "lecturers", "admins", "students", "authorizedUsers", "devices"];

  for (const coll of queryCollections) {
    if (rawEmail) {
      queryPromises.push(
        getDocs(query(collection(db, coll), where("email", "==", rawEmail))).catch(() => ({ docs: [] }))
      );
    }
    if (constructedEmail && constructedEmail !== rawEmail) {
      queryPromises.push(
        getDocs(query(collection(db, coll), where("email", "==", constructedEmail))).catch(() => ({ docs: [] }))
      );
    }
    if (uid) {
      queryPromises.push(
        getDocs(query(collection(db, coll), where("uid", "==", uid))).catch(() => ({ docs: [] }))
      );
      queryPromises.push(
        getDocs(query(collection(db, coll), where("studentUid", "==", uid))).catch(() => ({ docs: [] }))
      );
      queryPromises.push(
        getDocs(query(collection(db, coll), where("deviceBoundUid", "==", uid))).catch(() => ({ docs: [] }))
      );
    }
    if (cleanRollNo) {
      queryPromises.push(
        getDocs(query(collection(db, coll), where("rollNo", "==", cleanRollNo))).catch(() => ({ docs: [] }))
      );
      queryPromises.push(
        getDocs(query(collection(db, coll), where("rollNo", "==", rollLower))).catch(() => ({ docs: [] }))
      );
    }
  }

  // Biometrics & Notifications queries
  if (cleanRollNo) {
    queryPromises.push(
      getDocs(query(collection(db, "student_notifications"), where("rollNo", "==", cleanRollNo))).catch(() => ({ docs: [] }))
    );
    queryPromises.push(
      getDocs(query(collection(db, "student_notifications"), where("recipient", "==", cleanRollNo))).catch(() => ({ docs: [] }))
    );
    queryPromises.push(
      getDocs(query(collection(db, "biometric_credentials"), where("rollNo", "==", cleanRollNo))).catch(() => ({ docs: [] }))
    );
  }
  if (rawEmail) {
    queryPromises.push(
      getDocs(query(collection(db, "student_notifications"), where("email", "==", rawEmail))).catch(() => ({ docs: [] }))
    );
  }
  if (uid) {
    queryPromises.push(
      getDocs(query(collection(db, "biometric_credentials"), where("studentUid", "==", uid))).catch(() => ({ docs: [] }))
    );
    queryPromises.push(
      getDocs(query(collection(db, "biometric_credentials"), where("uid", "==", uid))).catch(() => ({ docs: [] }))
    );
  }

  try {
    const queryResults = await Promise.all(queryPromises);
    for (const snap of queryResults) {
      if (snap && snap.docs && snap.docs.length > 0) {
        for (const docSnap of snap.docs) {
          deletePromises.push(
            deleteDoc(docSnap.ref).catch((err) => {
              console.debug(`[Purge] Query delete ${docSnap.ref.path}:`, err.message);
            })
          );
        }
      }
    }
  } catch (qErr) {
    console.warn("[Purge] Secondary queries warning:", qErr.message);
  }

  // 3. UNASSIGN FROM ALL COURSES (Lecturer assignments & Student enrollments)
  let updatedCoursesCount = 0;
  try {
    const coursesSnap = await getDocs(collection(db, "courses")).catch(() => ({ docs: [] }));
    if (coursesSnap && coursesSnap.docs && coursesSnap.docs.length > 0) {
      const courseBatch = writeBatch(db);
      let batchCount = 0;

      coursesSnap.docs.forEach((courseDoc) => {
        const cData = courseDoc.data() || {};
        let modified = false;
        const updates = {};

        // A. If Student: remove from student rosters
        if (cleanRollNo) {
          const enrolled = Array.isArray(cData.students)
            ? cData.students
            : Array.isArray(cData.enrolledStudents)
              ? cData.enrolledStudents
              : [];

          const updatedEnrolled = enrolled.filter((s) => {
            const sRoll = typeof s === "string"
              ? s.toUpperCase().trim()
              : (s.rollNo || s.rollNumber || "").toUpperCase().trim();
            return !candidateKeys.has(sRoll);
          });

          if (updatedEnrolled.length !== enrolled.length) {
            updates.students = updatedEnrolled;
            updates.enrolledStudents = updatedEnrolled;
            modified = true;
          }
        }

        // B. If Lecturer or Staff: unassign lecturer email & from assignedLecturers array
        if (rawEmail || prefix) {
          const assigned = Array.isArray(cData.assignedLecturers) ? cData.assignedLecturers : [];
          const updatedAssigned = assigned.filter((l) => {
            const lKey = typeof l === "string" ? l.toLowerCase().trim() : (l.email || l.id || "").toLowerCase().trim();
            return !candidateKeys.has(lKey) && lKey !== rawEmail && lKey !== prefix;
          });

          if (updatedAssigned.length !== assigned.length) {
            updates.assignedLecturers = updatedAssigned;
            modified = true;
          }

          const currentLectEmail = String(cData.lecturerEmail || cData.facultyEmail || "").toLowerCase().trim();
          if (currentLectEmail && (candidateKeys.has(currentLectEmail) || currentLectEmail === rawEmail || currentLectEmail === prefix)) {
            updates.lecturerEmail = "";
            updates.facultyEmail = "";
            updates.lecturerName = "Unassigned";
            modified = true;
          }
        }

        if (modified) {
          updates.updatedAt = Date.now();
          courseBatch.update(courseDoc.ref, updates);
          batchCount++;
          updatedCoursesCount++;
        }
      });

      if (batchCount > 0) {
        deletePromises.push(courseBatch.commit().catch((err) => console.warn("[Purge] Course update error:", err)));
      }
    }
  } catch (cErr) {
    console.warn("[Purge] Course unassignment warning:", cErr.message);
  }

  // Await all delete and update operations
  await Promise.allSettled(deletePromises);

  // 4. REAL-TIME BROADCAST & LOCAL SYNC
  try {
    if (cleanRollNo) {
      broadcastStudentUpdate({
        rollNo: cleanRollNo,
        id: cleanRollNo,
        email: rawEmail,
        isDeleted: true,
        status: "deleted"
      });
    }

    // Dispatch global purge event for cross-component and cross-tab UI synchronization
    if (typeof window !== "undefined") {
      const purgeDetail = {
        email: rawEmail,
        prefix,
        uid,
        rollNo: cleanRollNo,
        role: detectedRole,
        candidateKeys: Array.from(candidateKeys),
        timestamp: Date.now()
      };
      window.dispatchEvent(new CustomEvent(USER_DELETED_EVENT, { detail: purgeDetail }));
      localStorage.setItem("smartattend_last_purged_user", JSON.stringify(purgeDetail));
    }
  } catch (_) { }

  return {
    success: true,
    purgedKeys: Array.from(candidateKeys),
    updatedCoursesCount,
    role: detectedRole
  };
}

/**
 * Scans Firestore collections (users, lecturers, admins, authorizedUsers, students)
 * to safely detect, merge, and purge redundant duplicate documents:
 * - Email prefix duplicates (e.g. `onteddukalyani` when `onteddukalyani@gmail.com` exists)
 * - Raw Firebase Auth UID duplicate documents in `users` (e.g. 28-char auth hashes)
 * - Lowercase or redundant student roll number documents in `users`
 */
export async function deduplicateUsersCollection() {
  const result = {
    analyzedCount: 0,
    removedCount: 0,
    mergedCount: 0,
    purgedDocIds: [],
    errors: []
  };

  try {
    const [usersSnap, lecturersSnap, adminsSnap, authSnap, studentsSnap] = await Promise.all([
      getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
      getDocs(collection(db, "lecturers")).catch(() => ({ docs: [] })),
      getDocs(collection(db, "admins")).catch(() => ({ docs: [] })),
      getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] })),
      getDocs(collection(db, "students")).catch(() => ({ docs: [] }))
    ]);

    result.analyzedCount = usersSnap.docs.length;

    // Build directory of all known canonical email addresses across the database
    const knownEmails = new Map();
    const registerKnownEmail = (email, data, source) => {
      if (!email || typeof email !== "string" || !email.includes("@")) return;
      const clean = email.toLowerCase().trim();
      if (!knownEmails.has(clean) || (data && Object.keys(data).length > 2)) {
        knownEmails.set(clean, { email: clean, data: data || {}, source });
      }
    };

    // Scan all collections for valid email addresses
    usersSnap.docs.forEach((d) => {
      const data = d.data() || {};
      if (d.id.includes("@")) registerKnownEmail(d.id, data, "users");
      if (data.email) registerKnownEmail(data.email, data, "users");
    });
    lecturersSnap.docs.forEach((d) => {
      const data = d.data() || {};
      if (d.id.includes("@")) registerKnownEmail(d.id, data, "lecturers");
      if (data.email) registerKnownEmail(data.email, data, "lecturers");
    });
    adminsSnap.docs.forEach((d) => {
      const data = d.data() || {};
      if (d.id.includes("@")) registerKnownEmail(d.id, data, "admins");
      if (data.email) registerKnownEmail(data.email, data, "admins");
    });
    authSnap.docs.forEach((d) => {
      const data = d.data() || {};
      if (d.id.includes("@")) registerKnownEmail(d.id, data, "authorizedUsers");
      if (data.email) registerKnownEmail(data.email, data, "authorizedUsers");
    });
    studentsSnap.docs.forEach((d) => {
      const data = d.data() || {};
      if (data.email) registerKnownEmail(data.email, data, "students");
    });

    const deletePromises = [];

    // Map of canonical email documents already in users
    const userEmailDocs = new Map();
    usersSnap.docs.forEach((d) => {
      if (d.id.includes("@")) {
        userEmailDocs.set(d.id.toLowerCase().trim(), { id: d.id, data: d.data() || {}, ref: d.ref });
      }
    });

    // 1. DEDUPLICATE `users` COLLECTION
    for (const docSnap of usersSnap.docs) {
      const id = docSnap.id.trim();
      const idLower = id.toLowerCase();
      const data = docSnap.data() || {};
      const docEmail = String(data.email || "").toLowerCase().trim();

      // Canonical full email document: keep, this is the primary canonical record
      if (id.includes("@")) {
        continue;
      }

      // Case A: Raw Firebase Auth UID document (e.g. 28 alphanumeric chars like fnV0DobTFvUjJFQt9ExrMcaatIx2)
      if (id.length >= 20 && !id.includes("@") && !id.includes(".")) {
        let targetEmail = docEmail && docEmail.includes("@") ? docEmail : null;
        if (!targetEmail) {
          for (const [knownEmail, info] of knownEmails.entries()) {
            if (info.data.uid === id || info.data.studentUid === id || info.data.deviceBoundUid === id) {
              targetEmail = knownEmail;
              break;
            }
          }
        }

        if (targetEmail && userEmailDocs.has(targetEmail)) {
          const canonical = userEmailDocs.get(targetEmail);
          const mergeData = {};
          if (data.deviceType && !canonical.data.deviceType) mergeData.deviceType = data.deviceType;
          if (data.platformBoundAt && !canonical.data.platformBoundAt) mergeData.platformBoundAt = data.platformBoundAt;
          if (data.hardwareBiometricEnrolled && !canonical.data.hardwareBiometricEnrolled) {
            mergeData.hardwareBiometricEnrolled = data.hardwareBiometricEnrolled;
          }
          if (Object.keys(mergeData).length > 0) {
            deletePromises.push(setDoc(canonical.ref, mergeData, { merge: true }).catch(() => { }));
            result.mergedCount++;
          }
        }

        // Delete raw UID duplicate from `users`
        deletePromises.push(
          deleteDoc(docSnap.ref).then(() => {
            result.removedCount++;
            result.purgedDocIds.push(`users/${id}`);
          }).catch((err) => result.errors.push(`Failed to delete users/${id}: ${err.message}`))
        );
        continue;
      }

      // Case B: Email prefix duplicate (e.g. onteddukalyani, prajwalasrimedisetti, umadevi.vadthya2006, vaishnavibukke21, kalyani2k08)
      let matchedEmail = "";
      if (docEmail && docEmail.includes("@") && docEmail.split("@")[0].toLowerCase() === idLower) {
        matchedEmail = docEmail;
      } else {
        for (const fullEmail of knownEmails.keys()) {
          if (fullEmail.split("@")[0].toLowerCase() === idLower) {
            matchedEmail = fullEmail;
            break;
          }
        }
      }

      // Fallback matching for well-known admin or lecturer prefixes
      if (!matchedEmail && (data.role === "admin" || data.role === "lecturer" || data.isAdmin)) {
        if (docEmail && docEmail.includes("@")) {
          matchedEmail = docEmail;
        } else if (idLower === "onteddukalyani" || idLower === "kalyani2k08") {
          matchedEmail = "onteddukalyani@gmail.com";
        }
      }

      if (matchedEmail) {
        // Ensure canonical full email document exists and has all profile attributes
        const canonicalRef = doc(db, "users", matchedEmail);
        const existingData = userEmailDocs.get(matchedEmail)?.data || {};
        const mergeData = {};
        Object.entries(data).forEach(([key, val]) => {
          if (key !== "id" && key !== "_id" && existingData[key] === undefined) {
            mergeData[key] = val;
          }
        });

        if (Object.keys(mergeData).length > 0 || !userEmailDocs.has(matchedEmail)) {
          deletePromises.push(
            setDoc(canonicalRef, { ...data, ...mergeData, email: matchedEmail, updatedAt: Date.now() }, { merge: true }).catch(() => { })
          );
          result.mergedCount++;
        }

        // Purge the redundant email-prefix duplicate document
        deletePromises.push(
          deleteDoc(docSnap.ref).then(() => {
            result.removedCount++;
            result.purgedDocIds.push(`users/${id}`);
          }).catch((err) => result.errors.push(`Failed to delete users/${id}: ${err.message}`))
        );
        continue;
      }

      // Case C: Student roll number duplicate in `users` (e.g. k22bcs108, 25BCS108)
      const cleanRoll = (data.rollNo || id).toUpperCase().trim();
      const isRollLike = ROLL_PATTERN.test(id) || ROLL_PATTERN.test(cleanRoll) || data.role === "student";
      if (isRollLike) {
        // If canonical record exists in students/ collection, merge & delete redundant user doc
        const existingStudent = studentsSnap.docs.find((s) => s.id.toUpperCase() === cleanRoll);
        if (existingStudent) {
          const mergeData = {};
          if (data.faceDescriptor && !existingStudent.data().faceDescriptor) {
            mergeData.faceDescriptor = data.faceDescriptor;
            mergeData.faceRegistered = true;
          }
          if (data.deviceId && !existingStudent.data().deviceId) {
            mergeData.deviceId = data.deviceId;
          }
          if (Object.keys(mergeData).length > 0) {
            deletePromises.push(setDoc(existingStudent.ref, mergeData, { merge: true }).catch(() => { }));
            result.mergedCount++;
          }
        }

        deletePromises.push(
          deleteDoc(docSnap.ref).then(() => {
            result.removedCount++;
            result.purgedDocIds.push(`users/${id}`);
          }).catch((err) => result.errors.push(`Failed to delete users/${id}: ${err.message}`))
        );
        continue;
      }
    }

    // 2. DEDUPLICATE PREFIXES IN `lecturers`, `admins`, AND `authorizedUsers`
    const staffCollections = [
      { name: "lecturers", snap: lecturersSnap },
      { name: "admins", snap: adminsSnap },
      { name: "authorizedUsers", snap: authSnap }
    ];

    for (const { name: collName, snap } of staffCollections) {
      for (const d of snap.docs) {
        const id = d.id.trim();
        const idLower = id.toLowerCase();
        if (id.includes("@")) continue; // Keep canonical emails

          // Match against known emails
          let matchedEmail = "";
          const docEmail = String(d.data()?.email || "").toLowerCase().trim();
          if (docEmail && docEmail.includes("@")) {
            matchedEmail = docEmail;
          } else {
            for (const fullEmail of knownEmails.keys()) {
              if (fullEmail.split("@")[0].toLowerCase() === idLower) {
                matchedEmail = fullEmail;
                break;
              }
            }
          }

            // Fallback heuristics: check if any document in the same collection has matching prefix
            if (!matchedEmail) {
              const matchInSameSnap = snap.docs.find(
                (sd) => sd.id.includes("@") && sd.id.split("@")[0].toLowerCase() === idLower
              );
              if (matchInSameSnap) {
                matchedEmail = matchInSameSnap.id.toLowerCase().trim();
              }
            }

      // Fallback heuristics: check if well-known institutional or gmail domain matches
      if (!matchedEmail) {
        const candidateEmail = `${idLower}@iiitdwd.ac.in`;
        const candidateGmail = `${idLower}@gmail.com`;
        if (knownEmails.has(candidateEmail)) {
          matchedEmail = candidateEmail;
        } else if (knownEmails.has(candidateGmail)) {
          matchedEmail = candidateGmail;
        }
      }

      if (matchedEmail) {
        const canonicalRef = doc(db, collName, matchedEmail);
        deletePromises.push(
          setDoc(canonicalRef, { ...d.data(), email: matchedEmail, updatedAt: Date.now() }, { merge: true }).catch(() => { })
        );

        deletePromises.push(
          deleteDoc(d.ref).then(() => {
            result.removedCount++;
            result.purgedDocIds.push(`${collName}/${id}`);
          }).catch((err) => result.errors.push(`Failed to delete ${collName}/${id}: ${err.message}`))
        );
      }
    }
  }

      await Promise.allSettled(deletePromises);
  return { success: true, ...result };
} catch (err) {
  console.error("[Deduplicate] Fatal error:", err);
  return { success: false, error: err.message, ...result };
}
  }

