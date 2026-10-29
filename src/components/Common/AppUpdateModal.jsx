import { useEffect } from "react";
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
              ? "A new version is available. Tap \"Update Now\" to download and install."
              : "A new version has been deployed. Tap \"Update Now\" to reload the app."}
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
