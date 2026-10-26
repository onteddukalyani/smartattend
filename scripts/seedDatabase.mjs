/**
 * SmartAttend Database Seeder
 * 
 * Run with: node scripts/seedDatabase.mjs
 * 
 * Initializes all required Firestore collections and sample documents
 * with exact canonical schemas expected by SmartAttend and firestore.rules.
 */

import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";

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

const NOW = Date.now();

console.log("🚀 Starting SmartAttend Canonical Database Setup on project 'smart-attendance-ok'...\n");

async function seed() {
  try {
    // 1. MASTER ADMIN ACCOUNTS
    console.log("1️⃣ Seeding Master Admin...");
    const adminData = {
      name: "Kalyani Onteddu",
      email: "onteddukalyani@gmail.com",
      role: "admin",
      isAdmin: true,
      status: "active",
      approved: true,
      department: "Administration",
      designation: "System Administrator",
      phone: "+91 9876543210",
      cabin: "Admin Office",
      createdAt: NOW,
      updatedAt: NOW
    };
    await setDoc(doc(db, "admins", "onteddukalyani"), adminData, { merge: true });
    await setDoc(doc(db, "admins", "onteddukalyani@gmail.com"), adminData, { merge: true });
    console.log("   ✅ admins/onteddukalyani & admins/onteddukalyani@gmail.com created.");

    // 2. INSTITUTION SETTINGS
    console.log("\n2️⃣ Seeding Institution Settings...");
    const institutionSettings = {
      name: "Indian Institute of Information Technology, Dharwad",
      shortName: "IIIT Dharwad",
      domain: "iiitdwd.ac.in",
      sessionDuration: 10,
      qrRefreshInterval: 10,
      attendanceWindow: 5,
      allowLateAttendance: true,
      defaultGeofenceRadius: 10,
      qr1Interval: 10,
      qr2Interval: 10,
      updatedAt: NOW
    };
    await setDoc(doc(db, "institution", "settings"), institutionSettings, { merge: true });
    console.log("   ✅ institution/settings created.");

    // 3. APP UPDATES
    console.log("\n3️⃣ Seeding App Updates Registry...");
    const updateRegistry = {
      version: "1.0.4",
      versionCode: 6,
      releaseDate: "2026-10-23",
      minRequiredVersion: "1.0.1",
      apkUrl: "https://raw.githubusercontent.com/onteddukalyani/smartattend/main/SmartAttend-release.apk",
      sha256Checksum: "8afe7f2f1614cce4eae87f0f4d970fe3be789f7961c5ad837afe7fad964490bc",
      fileSizeBytes: 15578324,
      title: "SmartAttend Release (v1.0.4)",
      releaseNotes: [
        "Official Version 1 Release of SmartAttend",
        "Modern glassmorphism UI & responsive dark mode styling",
        "Multi-role security (Admin, Faculty, Student) with device verification"
      ],
      isMandatory: false,
      updatedAt: NOW
    };
    await setDoc(doc(db, "app_updates", "latest"), updateRegistry, { merge: true });
    console.log("   ✅ app_updates/latest created.");

    // 4. SAMPLE LECTURER
    console.log("\n4️⃣ Seeding Sample Lecturer...");
    const lecturerEmail = "faculty@iiitdwd.ac.in";
    const lecturerPrefix = "faculty";
    const lecturerData = {
      name: "Dr. Faculty Member",
      email: lecturerEmail,
      department: "CSE",
      designation: "Associate Professor",
      phone: "+91 9876543211",
      cabin: "CSE Dept Cabin 101",
      role: "lecturer",
      status: "active",
      approved: true,
      createdAt: NOW,
      updatedAt: NOW
    };
    await setDoc(doc(db, "lecturers", lecturerPrefix), lecturerData, { merge: true });
    await setDoc(doc(db, "lecturers", lecturerEmail), lecturerData, { merge: true });
    console.log(`   ✅ lecturers/${lecturerPrefix} & lecturers/${lecturerEmail} created.`);

    // 5. SAMPLE COURSE
    console.log("\n5️⃣ Seeding Sample Course...");
    const courseCode = "CS301";
    const courseData = {
      code: courseCode,
      name: "Artificial Intelligence & Data Analytics",
      classCode: "C003",
      classNumber: "C003",
      defaultRoom: "C003",
      roomNo: "C003",
      room: "C003",
      department: "CSE",
      semester: 5,
      credits: 4,
      description: "Core computer science course on AI and intelligent agents.",
      assignedLecturers: [lecturerEmail],
      lecturer: "Dr. Faculty Member",
      lecturerEmail: lecturerEmail,
      enrolledStudents: ["22BCS001", "22BCS002"],
      createdAt: NOW,
      updatedAt: NOW
    };
    await setDoc(doc(db, "courses", courseCode), courseData, { merge: true });
    console.log(`   ✅ courses/${courseCode} created.`);

    // 6. SAMPLE STUDENTS
    console.log("\n6️⃣ Seeding Sample Students (stored strictly under students/{rollNo})...");
    const sampleStudents = [
      {
        rollNo: "22BCS001",
        name: "Aarav Sharma",
        email: "22bcs001@iiitdwd.ac.in",
        branch: "CSE",
        semester: "5",
        gender: "Male",
        phone: "+91 9123456781",
        role: "student",
        status: "active",
        approved: true,
        faceRegistered: false,
        biometricEnrolled: false,
        hasFaceRegistered: false,
        deviceTypeLocked: false,
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        rollNo: "22BCS002",
        name: "Priya Patel",
        email: "22bcs002@iiitdwd.ac.in",
        branch: "CSE",
        semester: "5",
        gender: "Female",
        phone: "+91 9123456782",
        role: "student",
        status: "active",
        approved: true,
        faceRegistered: false,
        biometricEnrolled: false,
        hasFaceRegistered: false,
        deviceTypeLocked: false,
        createdAt: NOW,
        updatedAt: NOW
      }
    ];

    for (const student of sampleStudents) {
      await setDoc(doc(db, "students", student.rollNo), student, { merge: true });
      console.log(`   ✅ students/${student.rollNo} created.`);
    }

    console.log("\n🎉 Database structure initialized successfully with zero errors!");
    console.log("Your database now has clean, canonical collections matching all security rules.\n");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Error during database seeding:", err);
    process.exit(1);
  }
}

seed();
