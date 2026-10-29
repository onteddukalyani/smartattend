#!/usr/bin/env node
/**
 * Fix test 35 in negative_cases.test.mjs (CRLF file)
 */
const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, 'tests/negative_cases.test.mjs');
let content = fs.readFileSync(filePath, 'utf8');

const oldTitle = 'test("35. Browser Camera Authorization: Only lecturer, admin, and iPhone users can access camera in browser; Android web students blocked"';
const newTitle = 'test("35. Browser Camera Authorization: All users (lecturer, admin, student, Android, iOS, desktop) can access camera in browser"';

// Fix test title
content = content.replace(oldTitle, newTitle);

// Fix Case D assertions (Android web student)
const oldCaseD = `  // Case D: Android web student in browser (Must be BLOCKED from browser camera)\r\n  const androidWebStudent = isBrowserCameraAllowed({ role: "student", deviceType: "android" });\r\n  assert.strictEqual(androidWebStudent.allowed, false);\r\n  assert.strictEqual(androidWebStudent.reason, "android_web_student");\r\n  assert.ok(androidWebStudent.message.includes("Camera in browser is only available for Lecturers, Admins, and iPhone users"));\r\n\r\n  // Desktop / PC browser student (Must also be BLOCKED)\r\n  const desktopWebStudent = isBrowserCameraAllowed({ role: "student", deviceType: "web" });\r\n  assert.strictEqual(desktopWebStudent.allowed, false);\r\n  assert.strictEqual(desktopWebStudent.reason, "android_web_student");`;

const newCaseD = `  // Case D: Android web student in browser — NOW ALLOWED for all devices\r\n  const androidWebStudent = isBrowserCameraAllowed({ role: "student", deviceType: "android" });\r\n  assert.strictEqual(androidWebStudent.allowed, true);\r\n\r\n  // Desktop / PC browser student — also ALLOWED\r\n  const desktopWebStudent = isBrowserCameraAllowed({ role: "student", deviceType: "web" });\r\n  assert.strictEqual(desktopWebStudent.allowed, true);`;

if (content.includes(oldCaseD)) {
  content = content.replace(oldCaseD, newCaseD);
  console.log('[OK] Fixed Case D assertions');
} else {
  console.log('[SKIP] Case D not found with exact CRLF match, trying LF...');
  const oldCaseDLF = oldCaseD.replace(/\r\n/g, '\n');
  if (content.includes(oldCaseDLF)) {
    content = content.replace(oldCaseDLF, newCaseD.replace(/\r\n/g, '\n'));
    console.log('[OK] Fixed Case D assertions (LF)');
  } else {
    console.log('[ERR] Could not find Case D to fix');
    // Show context around line 3082
    const lines = content.split('\n');
    console.log('Context around line 3082:');
    lines.slice(3079, 3094).forEach((l, i) => console.log(`${3080+i}: ${JSON.stringify(l)}`));
  }
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');

