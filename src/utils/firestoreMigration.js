import { collection, doc, getDocs, setDoc } from "firebase/firestore";
import { db } from "../firebase";

let migrationRunning = false;

/**
 * Automatically organizes Firestore into separated collections (students, lecturers, admins)
 * and replaces any 'General' department/branch with 'CSE'.
 * Runs safely using client authentication.
 */
export async function autoMigrateAndOrganizeFirestore() {
  if (migrationRunning) return;
  migrationRunning = true;

  try {
    let updatedCount = 0;

    // 1. Process 'users' collection -> Separate into students, lecturers, admins
    const usersSnap = await getDocs(collection(db, "users")).catch(() => ({ docs: [] }));
    for (const docSnap of usersSnap.docs) {
      const d = docSnap.data();
      const currentId = docSnap.id;
      const role = String(d.role || "").toLowerCase().trim();
      const email = (d.email || (currentId.includes("@") ? currentId : "")).toLowerCase().trim();
      const prefix = email ? email.split("@")[0] : currentId.toLowerCase();
      const rollNo = (d.rollNo || (/^\d{2}[a-zA-Z]{3}\d{2,4}$/i.test(currentId) ? currentId : "")).toUpperCase();

      const updates = {};
      if (d.branch && String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
      if (d.department && String(d.department).toLowerCase() === "general") updates.department = "CSE";

      const merged = { ...d, ...updates };

      if (role === "student" || rollNo || merged.semester) {
        merged.role = "student";
        if (!merged.branch || String(merged.branch).toLowerCase() === "general") merged.branch = "CSE";
        const studentId = rollNo || (prefix ? prefix.toUpperCase() : currentId.toUpperCase());
        await setDoc(doc(db, "students", studentId), merged, { merge: true }).catch(() => {});
        await setDoc(doc(db, "users", studentId), merged, { merge: true }).catch(() => {});
        updatedCount++;
      } else if (role === "lecturer" || role === "faculty" || role === "professor") {
        merged.role = "lecturer";
        if (!merged.department || String(merged.department).toLowerCase() === "general") {
          merged.department = "Computer Science & Engineering";
        }
        const lectId = prefix || currentId;
        await setDoc(doc(db, "lecturers", lectId), merged, { merge: true }).catch(() => {});
        if (email && email !== lectId) {
          await setDoc(doc(db, "lecturers", email), merged, { merge: true }).catch(() => {});
        }
        await setDoc(doc(db, "users", lectId), merged, { merge: true }).catch(() => {});
        updatedCount++;
      } else if (role === "admin" || role === "superadmin" || role === "administrator") {
        merged.role = "admin";
        if (!merged.department || String(merged.department).toLowerCase() === "general") {
          merged.department = "Administration";
        }
        const adminId = prefix || currentId;
        await setDoc(doc(db, "admins", adminId), merged, { merge: true }).catch(() => {});
        if (email && email !== adminId) {
          await setDoc(doc(db, "admins", email), merged, { merge: true }).catch(() => {});
        }
        await setDoc(doc(db, "users", adminId), merged, { merge: true }).catch(() => {});
        updatedCount++;
      }
    }

    // 2. Clean & Update 'students' collection
    const studentsSnap = await getDocs(collection(db, "students")).catch(() => ({ docs: [] }));
    for (const docSnap of studentsSnap.docs) {
      const d = docSnap.data();
      const updates = {};
      if (!d.branch || String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
      if (d.department && String(d.department).toLowerCase() === "general") updates.department = "CSE";
      if (Object.keys(updates).length > 0) {
        await setDoc(doc(db, "students", docSnap.id), updates, { merge: true }).catch(() => {});
        updatedCount++;
      }
    }

    // 3. Clean & Update 'lecturers' collection
    const lecturersSnap = await getDocs(collection(db, "lecturers")).catch(() => ({ docs: [] }));
    for (const docSnap of lecturersSnap.docs) {
      const d = docSnap.data();
      const updates = {};
      if (d.branch && String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
      if (d.department && String(d.department).toLowerCase() === "general") {
        updates.department = "Computer Science & Engineering";
      }
      if (Object.keys(updates).length > 0) {
        await setDoc(doc(db, "lecturers", docSnap.id), updates, { merge: true }).catch(() => {});
        updatedCount++;
      }
    }

    // 4. Clean & Update 'admins' collection
    const adminsSnap = await getDocs(collection(db, "admins")).catch(() => ({ docs: [] }));
    for (const docSnap of adminsSnap.docs) {
      const d = docSnap.data();
      const updates = {};
      if (d.branch && String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
      if (d.department && String(d.department).toLowerCase() === "general") {
        updates.department = "Administration";
      }
      if (Object.keys(updates).length > 0) {
        await setDoc(doc(db, "admins", docSnap.id), updates, { merge: true }).catch(() => {});
        updatedCount++;
      }
    }

    // 5. Clean & Update 'authorizedUsers' collection
    const authSnap = await getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] }));
    for (const docSnap of authSnap.docs) {
      const d = docSnap.data();
      const updates = {};
      if (d.branch && String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
      if (d.department && String(d.department).toLowerCase() === "general") updates.department = "CSE";
      if (Object.keys(updates).length > 0) {
        await setDoc(doc(db, "authorizedUsers", docSnap.id), updates, { merge: true }).catch(() => {});
        updatedCount++;
      }
    }

    // 6. Clean & Update 'courses' collection
    const coursesSnap = await getDocs(collection(db, "courses")).catch(() => ({ docs: [] }));
    for (const docSnap of coursesSnap.docs) {
      const d = docSnap.data();
      const updates = {};
      if (!d.department || String(d.department).toLowerCase() === "general") updates.department = "CSE";
      if (d.courseCode && String(d.courseCode).toLowerCase() === "general") updates.courseCode = "CSE";
      if (Object.keys(updates).length > 0) {
        await setDoc(doc(db, "courses", docSnap.id), updates, { merge: true }).catch(() => {});
        updatedCount++;
      }
    }

    // 7. Clean & Update 'attendance_sessions' collection
    const sessionsSnap = await getDocs(collection(db, "attendance_sessions")).catch(() => ({ docs: [] }));
    for (const docSnap of sessionsSnap.docs) {
      const d = docSnap.data();
      const updates = {};
      if (d.lecturerDepartment && String(d.lecturerDepartment).toLowerCase() === "general") updates.lecturerDepartment = "CSE";
      if (d.courseCode && String(d.courseCode).toLowerCase() === "general") updates.courseCode = "CSE";
      if (Object.keys(updates).length > 0) {
        await setDoc(doc(db, "attendance_sessions", docSnap.id), updates, { merge: true }).catch(() => {});
        updatedCount++;
      }
    }

    return updatedCount;
  } catch (err) {
    console.warn("Auto-migration notice:", err);
    return 0;
  } finally {
    migrationRunning = false;
  }
}
