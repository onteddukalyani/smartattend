#!/usr/bin/env node
/**
 * Fix Student Dashboard update handling:
 * - Remove the inline banner (lines ~1112-1227)  
 * - Replace with auto-show modal once per version
 * - Remove manual showUpdateModal state, auto-open when updateInfo arrives
 */
const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, 'src/components/Student/pages/Dashboard.jsx');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Fix the import to add markAppUpdateNotificationShown + hasAppUpdateNotificationBeenShown
const oldImport = `import { dismissAppUpdate, isAppUpdateDismissed } from "../../../utils/appUpdateDismissal";`;
const newImport = `import { dismissAppUpdate, isAppUpdateDismissed, hasAppUpdateNotificationBeenShown, markAppUpdateNotificationShown } from "../../../utils/appUpdateDismissal";`;
if (content.includes(oldImport)) {
  content = content.replace(oldImport, newImport);
  console.log('[OK] Added hasAppUpdateNotificationBeenShown import');
} else {
  // Try CRLF
  const crlfOld = oldImport.replace(/\n/g, '\r\n');
  if (content.includes(crlfOld)) {
    content = content.replace(crlfOld, newImport);
    console.log('[OK] Added hasAppUpdateNotificationBeenShown import (CRLF)');
  } else {
    console.log('[SKIP] Could not find dismissAppUpdate import');
  }
}

// 2. Replace applyUpdateInfo to use "shown once" logic
const oldApply = `        const applyUpdateInfo = (info) => {
            if (!isMounted) return;
            if (!info?.hasUpdate) {
                setUpdateInfo(null);
                setUpdateDismissed(false);
                return;
            }
            setUpdateInfo(info);
            setUpdateDismissed(!info.isMandatory && isAppUpdateDismissed(info.latestVersion));
        };`;

const newApply = `        const applyUpdateInfo = (info) => {
            if (!isMounted) return;
            if (!info?.hasUpdate) {
                setUpdateInfo(null);
                return;
            }
            // Non-mandatory: only show once per version
            if (!info.isMandatory && (isAppUpdateDismissed(info.latestVersion) || hasAppUpdateNotificationBeenShown(info.latestVersion))) {
                setUpdateInfo(null);
                return;
            }
            setUpdateInfo(info);
            if (!info.isMandatory) markAppUpdateNotificationShown(info.latestVersion);
        };`;

// Try LF and CRLF
const crlfOldApply = oldApply.replace(/\n/g, '\r\n');
if (content.includes(crlfOldApply)) {
  content = content.replace(crlfOldApply, newApply.replace(/\n/g, '\r\n'));
  console.log('[OK] Fixed applyUpdateInfo (CRLF)');
} else if (content.includes(oldApply)) {
  content = content.replace(oldApply, newApply);
  console.log('[OK] Fixed applyUpdateInfo (LF)');
} else {
  console.log('[SKIP] Could not find applyUpdateInfo to patch');
}

// 3. Remove updateDismissed state line
content = content.replace(/\r?\n\s*const \[updateDismissed, setUpdateDismissed\] = useState\(false\);\r?\n/, '\n');
console.log('[OK] Removed updateDismissed state');

// 4. Replace the large inline banner block with nothing (lines 1112–1227 approx)
// We'll find it by a unique start/end marker
const bannerStart = `{/* 0. Student App Update Reminder Banner */}`;
const bannerEnd = `{/* 1. Student Hero Profile Banner */}`;

const bannerStartIdx = content.indexOf(bannerStart);
const bannerEndIdx = content.indexOf(bannerEnd);

if (bannerStartIdx !== -1 && bannerEndIdx !== -1 && bannerEndIdx > bannerStartIdx) {
  content = content.substring(0, bannerStartIdx) + content.substring(bannerEndIdx);
  console.log('[OK] Removed inline update banner block');
} else {
  console.log('[SKIP] Could not find inline banner block to remove');
}

// 5. Replace showUpdateModal state + AppUpdateModal at bottom to auto-show
// Remove the showUpdateModal state
content = content.replace(/\r?\n\s*const \[showUpdateModal, setShowUpdateModal\] = useState\(false\);\r?\n/, '\n');

// Fix the AppUpdateModal at the bottom to use updateInfo directly (auto-show when set)
const oldModal = `            <AppUpdateModal
                updateInfo={showUpdateModal ? updateInfo : null}`;
const newModal = `            <AppUpdateModal
                updateInfo={updateInfo}`;

if (content.includes(oldModal)) {
  content = content.replace(oldModal, newModal);
  console.log('[OK] Fixed AppUpdateModal to auto-show');
} else {
  const crlfOldModal = oldModal.replace(/\n/g, '\r\n');
  if (content.includes(crlfOldModal)) {
    content = content.replace(crlfOldModal, newModal.replace(/\n/g, '\r\n'));
    console.log('[OK] Fixed AppUpdateModal to auto-show (CRLF)');
  } else {
    console.log('[SKIP] Could not find AppUpdateModal updateInfo prop');
  }
}

// 6. Fix onClose in Student Dashboard AppUpdateModal
const oldClose = `                        setUpdateDismissed(true);`;
if (content.includes(oldClose)) {
  content = content.replace(new RegExp(oldClose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
  console.log('[OK] Removed setUpdateDismissed from onClose');
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');
