#!/usr/bin/env node
/**
 * Fix script that handles CRLF line endings
 */
const fs = require('fs');
const path = require('path');

function fixFile(filePath, target, replacement, label) {
  const abs = path.resolve(__dirname, filePath);
  let raw = fs.readFileSync(abs);
  let content = raw.toString('utf8');
  
  // Try both CRLF and LF versions of target
  const crlfTarget = target.replace(/\n/g, '\r\n');
  const lfTarget = target;
  
  let found = false;
  if (content.includes(crlfTarget)) {
    // Preserve the original line ending style in replacement
    const crlfReplacement = replacement.replace(/\n/g, '\r\n');
    content = content.replace(crlfTarget, crlfReplacement);
    found = true;
  } else if (content.includes(lfTarget)) {
    content = content.replace(lfTarget, replacement);
    found = true;
  }
  
  if (!found) {
    console.log(`  [SKIP] ${label} — target not found`);
    return false;
  }
  
  fs.writeFileSync(abs, content, 'utf8');
  console.log(`  [OK] ${label}`);
  return true;
}

// ─── FIX 1: deviceDetection.js — allow camera for all browser users ───────────
fixFile(
  'src/utils/deviceDetection.js',
  `  // Android web browser or desktop student: Camera is NOT available in browser for QR scanning
  return {
    allowed: false,
    reason: "android_web_student",
    message: "Camera in browser is only available for Lecturers, Admins, and iPhone users. Android students must use the official SmartAttend Android App (.apk) with Lock Task Kiosk mode."
  };
}`,
  `  // Camera is allowed in browser for all devices and users
  return { allowed: true, reason: "browser_allowed" };
}`,
  'deviceDetection.js: allow camera for all browser users'
);

// ─── FIX 2: CoursesManager.jsx — filter unnamed / UID-based students ───────────
fixFile(
  'src/components/Common/CoursesManager.jsx',
  `  const availableStudents = allStudents.filter((student) => {
    const roll = String(student.rollNo || student.rollNumber || (student.id && student.id.length <= 15 ? student.id : "") || "").trim().toUpperCase();
    const email = String(student.email || "").trim().toLowerCase();
    // Exclude if already enrolled by roll number OR by student email
    if (!roll || enrolledRollSet.has(roll) || (email && enrolledEmailSet.has(email))) return false;
    if (!availableStudentSearch.trim()) return true;
    const query = availableStudentSearch.toLowerCase().trim();
    return [roll, student.name, student.fullName, student.email, student.branch, student.department]
      .some((value) => String(value || "").toLowerCase().includes(query));
  });`,
  `  const availableStudents = allStudents.filter((student) => {
    const roll = String(student.rollNo || student.rollNumber || (student.id && student.id.length <= 15 ? student.id : "") || "").trim().toUpperCase();
    const email = String(student.email || "").trim().toLowerCase();
    // Exclude UID-based / hash documents that have no proper roll number pattern (e.g. Firebase UIDs)
    if (!roll || roll.length > 15 || !/^\\d{2}[A-Z]{2,4}\\d+$/i.test(roll)) return false;
    // Exclude if already enrolled by roll number OR by student email
    if (enrolledRollSet.has(roll) || (email && enrolledEmailSet.has(email))) return false;
    // Exclude students with no real name to avoid showing "Unnamed student" entries
    const realName = (student.name || student.fullName || "").trim();
    if (!realName || realName === roll || realName.length < 2) return false;
    if (!availableStudentSearch.trim()) return true;
    const query = availableStudentSearch.toLowerCase().trim();
    return [roll, student.name, student.fullName, student.email, student.branch, student.department]
      .some((value) => String(value || "").toLowerCase().includes(query));
  });`,
  'CoursesManager.jsx: filter UID/unnamed students from Add Students list'
);

console.log('\nDone!');

