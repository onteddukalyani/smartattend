#!/usr/bin/env node
/**
 * Rewrites AppUpdateModal.jsx to a simple one-time blocking alert:
 * - Native Android APK → "Update Now" auto-triggers APK download
 * - Web/browser → "Update Now" reloads the page
 * - Shows ONCE per version (tracked via localStorage)
 * - No tabs, no complex download UI, no changelog
 */
const fs = require('fs');
const path = require('path');

// ─── New AppUpdateModal.jsx ────────────────────────────────────────────────────
const newModal = `import { useEffect } from "react";
import { FaDownload, FaRedo, FaExclamationTriangle, FaRocket } from "react-icons/fa";
import { Capacitor } from "@capacitor/core";
import { triggerApkDownload } from "../../services/appUpdateService";
import { getApkDownloadUrl } from "../../utils/apkUrl";
import "./AppUpdateModal.css";

/**
 * AppUpdateModal — simple one-time blocking alert.
 * Native APK: clicking Update Now auto-downloads the APK.
 * Web browser: clicking Update Now reloads the page.
 * Shows only once per version (parent must handle "shown" tracking).
 */
export default function AppUpdateModal({ updateInfo, onClose }) {
  if (!updateInfo || (!updateInfo.hasUpdate && !updateInfo.isOpen)) return null;

  const isNative = Capacitor.isNativePlatform();
  const isMandatory = Boolean(updateInfo.isMandatory);
  const latestVersion = updateInfo.latestVersion || "";
  const currentVersion = updateInfo.currentVersion || "";
  const apkUrl = updateInfo.apkUrl || getApkDownloadUrl();

  // Trap scroll when open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const handleUpdate = () => {
    if (isNative) {
      // Native APK: trigger direct download
      triggerApkDownload(apkUrl);
    } else {
      // Web browser: hard reload to pick up latest deployment
      try {
        if ("serviceWorker" in navigator) {
          navigator.serviceWorker.getRegistrations().then((regs) => {
            regs.forEach((r) => r.update());
          });
        }
      } catch (_) {}
      window.location.reload(true);
    }
  };

  const handleDismiss = () => {
    if (!isMandatory && onClose) onClose();
  };

  return (
    <div
      className="st-update-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-dialog-title"
      onClick={!isMandatory ? handleDismiss : undefined}
    >
      <div
        className="stu-alert-box"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Icon */}
        <div className="stu-alert-icon-wrap">
          {isMandatory
            ? <FaExclamationTriangle className="stu-alert-icon mandatory" />
            : <FaRocket className="stu-alert-icon" />}
        </div>

        {/* Title */}
        <h2 id="update-dialog-title" className="stu-alert-title">
          {isMandatory ? "Update Required" : "Update Available"}
        </h2>

        {/* Version info */}
        <p className="stu-alert-version">
          SmartAttend <strong>v{latestVersion}</strong> is now available
          {currentVersion ? <> (you have v{currentVersion})</> : null}.
        </p>

        {/* Message */}
        <p className="stu-alert-msg">
          {isMandatory
            ? "You must update to continue using SmartAttend. Please update now."
            : isNative
              ? "A new version is available. Tap \\\"Update Now\\\" to download and install."
              : "A new version has been deployed. Tap \\\"Update Now\\\" to reload the app."}
        </p>

        {/* Notes (first bullet only) */}
        {updateInfo.releaseNotes?.length > 0 && (
          <p className="stu-alert-note">
            ✨ {updateInfo.releaseNotes[0]}
          </p>
        )}

        {/* Actions */}
        <div className="stu-alert-actions">
          <button
            type="button"
            className="stu-alert-btn-update"
            onClick={handleUpdate}
          >
            {isNative ? <><FaDownload /> Update Now</> : <><FaRedo /> Update Now</>}
          </button>

          {!isMandatory && (
            <button
              type="button"
              className="stu-alert-btn-later"
              onClick={handleDismiss}
            >
              Later
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
`;

// ─── CSS additions for stu-alert-* ────────────────────────────────────────────
const additionalCss = `
/* ── Simple Update Alert Box (replaces complex modal) ── */
.stu-alert-box {
  background: var(--surface, #1e293b);
  border: 1.5px solid rgba(99,102,241,0.35);
  border-radius: 20px;
  padding: 32px 28px 24px;
  max-width: 380px;
  width: 92vw;
  text-align: center;
  box-shadow: 0 24px 64px rgba(0,0,0,0.45);
  position: relative;
  z-index: 1;
}
.stu-alert-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: linear-gradient(135deg,#6366f1,#8b5cf6);
  margin: 0 auto 18px;
  box-shadow: 0 8px 24px rgba(99,102,241,0.4);
}
.stu-alert-icon {
  font-size: 1.7rem;
  color: #fff;
}
.stu-alert-icon.mandatory {
  color: #fef08a;
}
.stu-alert-title {
  font-size: 1.25rem;
  font-weight: 800;
  color: var(--text-main, #f1f5f9);
  margin: 0 0 8px;
}
.stu-alert-version {
  font-size: 0.88rem;
  color: var(--text-muted, #94a3b8);
  margin: 0 0 10px;
}
.stu-alert-msg {
  font-size: 0.9rem;
  color: var(--text-secondary, #cbd5e1);
  line-height: 1.55;
  margin: 0 0 12px;
}
.stu-alert-note {
  font-size: 0.82rem;
  color: #818cf8;
  background: rgba(99,102,241,0.1);
  border-radius: 10px;
  padding: 8px 12px;
  margin: 0 0 20px;
  text-align: left;
}
.stu-alert-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.stu-alert-btn-update {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 13px 20px;
  background: linear-gradient(135deg,#6366f1 0%,#4f46e5 100%);
  color: #fff;
  border: none;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: 800;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(79,70,229,0.4);
  transition: opacity .15s;
}
.stu-alert-btn-update:hover { opacity: 0.9; }
.stu-alert-btn-later {
  width: 100%;
  padding: 11px 20px;
  background: transparent;
  border: 1px solid rgba(148,163,184,0.3);
  border-radius: 12px;
  color: var(--text-muted, #94a3b8);
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  transition: background .15s;
}
.stu-alert-btn-later:hover { background: rgba(255,255,255,0.05); }
`;

// Write new modal
const modalPath = path.resolve(__dirname, 'src/components/Common/AppUpdateModal.jsx');
fs.writeFileSync(modalPath, newModal, 'utf8');
console.log('[OK] AppUpdateModal.jsx rewritten');

// Append CSS additions
const cssPath = path.resolve(__dirname, 'src/components/Common/AppUpdateModal.css');
let css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
if (!css.includes('stu-alert-box')) {
  fs.appendFileSync(cssPath, additionalCss, 'utf8');
  console.log('[OK] AppUpdateModal.css updated');
} else {
  console.log('[SKIP] CSS already has stu-alert-box');
}

console.log('Done!');
