import { useState } from "react";
import {
  FaRocket,
  FaDownload,
  FaTimes,
  FaCheckCircle,
  FaExclamationTriangle,
  FaAndroid,
  FaExternalLinkAlt,
  FaInfoCircle
} from "react-icons/fa";
import { triggerApkDownload } from "../../services/appUpdateService";
import "./AppUpdateModal.css";

export default function AppUpdateModal({ updateInfo, onClose }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadStarted, setDownloadStarted] = useState(false);

  if (!updateInfo || !updateInfo.hasUpdate) return null;

  const {
    currentVersion,
    latestVersion,
    title,
    releaseNotes,
    apkUrl,
    isMandatory,
    releaseDate
  } = updateInfo;

  const handleDownload = () => {
    setDownloading(true);
    triggerApkDownload(apkUrl);
    setDownloadStarted(true);
    setTimeout(() => {
      setDownloading(false);
    }, 2000);
  };

  const handleDismiss = () => {
    // Store dismissal time to avoid prompting every navigation (valid for 24h)
    try {
      localStorage.setItem("smartattend_dismissed_update_version", latestVersion);
      localStorage.setItem("smartattend_dismissed_update_time", String(Date.now()));
    } catch (_) {}
    if (onClose) onClose();
  };

  return (
    <div className="st-update-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
      <div className="st-update-modal-backdrop" onClick={!isMandatory ? handleDismiss : undefined} />

      <div className="st-update-modal-container">
        {/* Glow & Cover Decor */}
        <div className="st-update-glow-orbit" />
        
        {/* Header Ribbon */}
        <div className="st-update-modal-header">
          <div className="st-update-header-badge">
            <FaRocket className="st-update-rocket-icon" />
            <span>New App Update Available</span>
          </div>
          {!isMandatory && (
            <button
              type="button"
              className="st-update-close-btn"
              onClick={handleDismiss}
              title="Remind me later"
              aria-label="Close"
            >
              <FaTimes />
            </button>
          )}
        </div>

        {/* Modal Body */}
        <div className="st-update-modal-body">
          <div className="st-update-hero-icon-wrap">
            <div className="st-update-android-icon">
              <FaAndroid />
            </div>
            <span className="st-update-pulse-ring" />
          </div>

          <h2 id="update-dialog-title" className="st-update-title">
            {title || `Update to SmartAttend v${latestVersion}`}
          </h2>

          <div className="st-update-version-pills">
            <div className="st-ver-pill current">
              <span className="st-ver-label">Current:</span>
              <span className="st-ver-val">v{currentVersion}</span>
            </div>
            <span className="st-ver-arrow">➔</span>
            <div className="st-ver-pill latest">
              <span className="st-ver-label">Latest:</span>
              <span className="st-ver-val">v{latestVersion}</span>
              <span className="st-ver-new-tag">NEW</span>
            </div>
          </div>

          {releaseDate && (
            <p className="st-update-date">Released: {new Date(releaseDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</p>
          )}

          {isMandatory && (
            <div className="st-update-mandatory-banner">
              <FaExclamationTriangle />
              <span>This update contains critical security &amp; system enhancements required to continue using SmartAttend.</span>
            </div>
          )}

          {/* Release Highlights */}
          {releaseNotes && releaseNotes.length > 0 && (
            <div className="st-update-notes-box">
              <h4 className="st-update-notes-heading">What's New in this Build:</h4>
              <ul className="st-update-notes-list">
                {releaseNotes.map((note, index) => (
                  <li key={index}>
                    <FaCheckCircle className="st-note-bullet-icon" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Download Started Feedback Notice */}
          {downloadStarted && (
            <div className="st-update-downloading-notice">
              <FaInfoCircle />
              <div>
                <strong>APK Download Initiated!</strong>
                <p>Check your device's notification bar or downloads folder. Tap the downloaded <code>SmartAttend-release.apk</code> to install.</p>
              </div>
            </div>
          )}

          {/* Installation Steps Quick Guide */}
          <div className="st-update-guide">
            <span className="st-guide-title">How to Install Update:</span>
            <ol className="st-guide-steps">
              <li>Tap <strong>Update &amp; Download APK</strong> below.</li>
              <li>When Android asks, tap <strong>Download anyway</strong> / <strong>Open</strong>.</li>
              <li>Tap <strong>Install</strong> (your saved account data will remain safe).</li>
            </ol>
          </div>
        </div>

        {/* Modal Actions Footer */}
        <div className="st-update-modal-footer">
          <button
            type="button"
            className="st-update-btn-primary"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? (
              <>
                <span className="st-btn-spinner" />
                <span>Starting Download...</span>
              </>
            ) : (
              <>
                <FaDownload />
                <span>{downloadStarted ? "Download Again" : "Update & Download APK (.apk)"}</span>
                <FaExternalLinkAlt className="st-btn-sub-icon" />
              </>
            )}
          </button>

          {!isMandatory && (
            <button
              type="button"
              className="st-update-btn-secondary"
              onClick={handleDismiss}
            >
              Remind Me Later
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
