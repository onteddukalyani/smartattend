import { initializeApp } from "firebase/app";
import { 
  getFirestore, 
  collection, 
  getDocs, 
  doc, 
  setDoc,
  deleteDoc
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyD_oqAOLLwS_sYXpTisEXl4qZAiSeIxooM",
  authDomain: "smart-attendance-ok.firebaseapp.com",
  projectId: "smart-attendance-ok",
  storageBucket: "smart-attendance-ok.firebasestorage.app",
  messagingSenderId: "313754116452",
  appId: "1:313754116452:web:ef955c1b662607d4145a71"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function runMigration() {
  console.log("🚀 Starting Direct Firestore Migration & Separation...");
  let count = 0;

  try {
    // 1. Ingest users & Separate into students, lecturers, admins
    console.log("📂 Reading 'users' collection...");
    const usersSnap = await getDocs(collection(db, "users"));
    console.log(`Found ${usersSnap.size} documents in 'users'.`);

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

      const mergedData = { ...d, ...updates };

      if (role === "student" || rollNo || mergedData.semester) {
        mergedData.role = "student";
        if (!mergedData.branch || String(mergedData.branch).toLowerCase() === "general") {
          mergedData.branch = "CSE";
        }
        const studentDocId = rollNo || prefix || currentId;
        await setDoc(doc(db, "students", studentDocId), mergedData, { merge: true });
        if (prefix && prefix !== studentDocId) {
          await setDoc(doc(db, "students", prefix), mergedData, { merge: true });
        }
        await setDoc(doc(db, "users", studentDocId), mergedData, { merge: true });
        count++;
      } else if (role === "lecturer" || role === "faculty" || role === "professor") {
        mergedData.role = "lecturer";
        if (!mergedData.department || String(mergedData.department).toLowerCase() === "general") {
          mergedData.department = "Computer Science & Engineering";
        }
        const lectDocId = prefix || currentId;
        await setDoc(doc(db, "lecturers", lectDocId), mergedData, { merge: true });
        if (email && email !== lectDocId) {
          await setDoc(doc(db, "lecturers", email), mergedData, { merge: true });
        }
        await setDoc(doc(db, "users", lectDocId), mergedData, { merge: true });
        count++;
      } else if (role === "admin" || role === "superadmin" || role === "administrator") {
        mergedData.role = "admin";
        const adminDocId = prefix || currentId;
        await setDoc(doc(db, "admins", adminDocId), mergedData, { merge: true });
        if (email && email !== adminDocId) {
          await setDoc(doc(db, "admins", email), mergedData, { merge: true });
        }
        await setDoc(doc(db, "users", adminDocId), mergedData, { merge: true });
        count++;
      }
    }

    // 2. Clean & Update 'students' collection
    console.log("📂 Processing 'students' collection...");
    const studentsSnap = await getDocs(collection(db, "students"));
    for (const docSnap of studentsSnap.docs) {
      const d = docSnap.data();
      const updates = {};
      if (!d.branch || String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
      if (d.department && String(d.department).toLowerCase() === "general") updates.department = "CSE";
      if (Object.keys(updates).length > 0) {
        await setDoc(doc(db, "students", docSnap.id), updates, { merge: true });
        count++;
      }
    }

    // 3. Clean & Update 'lecturers' collection
    console.log("📂 Processing 'lecturers' collection...");
    const lecturersSnap = await getDocs(collection(db, "lecturers"));
    for (const docSnap of lecturersSnap.docs) {
      const d = docSnap.data();
      const updates = {};
      if (d.branch && String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
      if (d.department && String(d.department).toLowerCase() === "general") {
        updates.department = "Computer Science & Engineering";
      }
      if (Object.keys(updates).length > 0) {
        await setDoc(doc(db, "lecturers", docSnap.id), updates, { merge: true });
        count++;
      }
    }

    // 4. Clean & Update 'admins' collection
    console.log("📂 Processing 'admins' collection...");
    const adminsSnap = await getDocs(collection(db, "admins"));
    for (const docSnap of adminsSnap.docs) {
      const d = docSnap.data();
      const updates = {};
      if (d.branch && String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
      if (d.department && String(d.department).toLowerCase() === "general") {
        updates.department = "Administration";
      }
      if (Object.keys(updates).length > 0) {
        await setDoc(doc(db, "admins", docSnap.id), updates, { merge: true });
        count++;
      }
    }

    // 5. Clean & Update 'authorizedUsers' collection
    console.log("📂 Processing 'authorizedUsers' collection...");
    const authSnap = await getDocs(collection(db, "authorizedUsers"));
    for (const docSnap of authSnap.docs) {
      const d = docSnap.data();
      const updates = {};
      if (d.branch && String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
      if (d.department && String(d.department).toLowerCase() === "general") updates.department = "CSE";
      if (Object.keys(updates).length > 0) {
        await setDoc(doc(db, "authorizedUsers", docSnap.id), updates, { merge: true });
        count++;
      }
    }

    // 6. Clean & Update 'courses' collection
    console.log("📂 Processing 'courses' collection...");
    const coursesSnap = await getDocs(collection(db, "courses"));
    for (const docSnap of coursesSnap.docs) {
      const d = docSnap.data();
      const updates = {};
      if (!d.department || String(d.department).toLowerCase() === "general") updates.department = "CSE";
      if (d.courseCode && String(d.courseCode).toLowerCase() === "general") updates.courseCode = "CSE";
      if (Object.keys(updates).length > 0) {
        await setDoc(doc(db, "courses", docSnap.id), updates, { merge: true });
        count++;
      }
    }

    // 7. Clean & Update 'attendance_sessions' collection
    console.log("📂 Processing 'attendance_sessions' collection...");
    const sessionsSnap = await getDocs(collection(db, "attendance_sessions"));
    for (const docSnap of sessionsSnap.docs) {
      const d = docSnap.data();
      const updates = {};
      if (d.lecturerDepartment && String(d.lecturerDepartment).toLowerCase() === "general") updates.lecturerDepartment = "CSE";
      if (d.courseCode && String(d.courseCode).toLowerCase() === "general") updates.courseCode = "CSE";
      if (Object.keys(updates).length > 0) {
        await setDoc(doc(db, "attendance_sessions", docSnap.id), updates, { merge: true });
        count++;
      }
    }

    console.log(`\n🎉 SUCCESS! Firestore Migration Complete.`);
    console.log(`✅ Total documents processed & updated to 'CSE' / separated collections: ${count}`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Migration error:", err);
    process.exit(1);
  }
}

runMigration();
