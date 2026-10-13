import { useState, useRef } from "react";
import {
  FaRocket,
  FaDownload,
  FaTimes,
  FaCheckCircle,
  FaExclamationTriangle,
  FaAndroid,
  FaExternalLinkAlt,
  FaInfoCircle,
  FaServer,
  FaRedo
} from "react-icons/fa";
import {
  triggerApkDownload,
  downloadApkWithStream
} from "../../services/appUpdateService";
import { getApkMirrors } from "../../utils/apkUrl";
import "./AppUpdateModal.css";

export default function AppUpdateModal({ updateInfo, onClose }) {
  const mirrors = updateInfo?.mirrors || getApkMirrors();
  const [selectedMirrorUrl, setSelectedMirrorUrl] = useState(
    updateInfo?.apkUrl || mirrors[0]?.url
  );
  const [downloadState, setDownloadState] = useState("idle"); // 'idle' | 'connecting' | 'downloading' | 'completed' | 'error'
  const [downloadProgress, setDownloadProgress] = useState({
    percent: 0,
    receivedBytes: 0,
    totalBytes: 0,
    speedKBps: 0
  });
  const [errorMessage, setErrorMessage] = useState("");
  const abortControllerRef = useRef(null);

  if (!updateInfo || !updateInfo.hasUpdate) return null;

  const {
    currentVersion,
    latestVersion,
    title,
    releaseNotes,
    isMandatory,
    releaseDate
  } = updateInfo;

  const handleStartDownload = async () => {
    setDownloadState("connecting");
    setErrorMessage("");
    setDownloadProgress({ percent: 0, receivedBytes: 0, totalBytes: 0, speedKBps: 0 });

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      const res = await downloadApkWithStream({
        url: selectedMirrorUrl,
        signal: abortControllerRef.current.signal,
        onProgress: (p) => {
          if (p.stage === "connecting") {
            setDownloadState("connecting");
          } else if (p.stage === "downloading" || p.stage === "processing") {
            setDownloadState("downloading");
          } else if (p.stage === "completed" || p.stage === "direct_triggered" || p.stage === "direct_fallback") {
            setDownloadState("completed");
          }
          setDownloadProgress({
            percent: p.percent || 0,
            receivedBytes: p.receivedBytes || 0,
            totalBytes: p.totalBytes || 0,
            speedKBps: p.speedKBps || 0
          });
        }
      });

      if (!res.success) {
        if (res.error?.includes("cancelled")) {
          setDownloadState("idle");
        } else {
          setDownloadState("error");
          setErrorMessage(res.error || "Download connection interrupted.");
        }
      } else {
        setDownloadState("completed");
      }
    } catch (err) {
      setDownloadState("error");
      setErrorMessage(err.message || "Failed to download update.");
    }
  };

  const handleDirectDownload = () => {
    triggerApkDownload(selectedMirrorUrl);
    setDownloadState("completed");
  };

  const handleDismiss = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    try {
      localStorage.setItem("smartattend_dismissed_update_version", latestVersion);
      localStorage.setItem("smartattend_dismissed_update_time", String(Date.now()));
    } catch (_) {}
    if (onClose) onClose();
  };

  const formatMB = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
  const formatSpeed = (kbps) => {
    if (kbps >= 1024) {
      return `${(kbps / 1024).toFixed(1)} MB/s`;
    }
    return `${kbps} KB/s`;
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

          {/* Download Mirrors Selector */}
          <div className="st-update-mirror-section">
            <div className="st-mirror-header">
              <FaServer className="st-mirror-icon" />
              <span>Download Mirror / CDN:</span>
            </div>
            <div className="st-mirror-chips">
              {mirrors.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`st-mirror-chip ${selectedMirrorUrl === m.url ? 'active' : ''}`}
                  onClick={() => setSelectedMirrorUrl(m.url)}
                  disabled={downloadState === "connecting" || downloadState === "downloading"}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Live Progress Bar Widget */}
          {(downloadState === "connecting" || downloadState === "downloading") && (
            <div className="st-update-progress-container">
              <div className="st-progress-meta">
                <span className="st-progress-state-text">
                  {downloadState === "connecting" ? "Connecting to download server..." : `Downloading APK (${downloadProgress.percent}%)`}
                </span>
                {downloadProgress.speedKBps > 0 && (
                  <span className="st-progress-speed-text">
                    {formatSpeed(downloadProgress.speedKBps)}
                  </span>
                )}
              </div>
              <div className="st-progress-bar-track">
                <div
                  className="st-progress-bar-fill"
                  style={{ width: `${Math.max(4, downloadProgress.percent)}%` }}
                />
              </div>
              {downloadProgress.totalBytes > 0 && (
                <div className="st-progress-bytes-text">
                  {formatMB(downloadProgress.receivedBytes)} MB / {formatMB(downloadProgress.totalBytes)} MB
                </div>
              )}
            </div>
          )}

          {/* Success Banner */}
          {downloadState === "completed" && (
            <div className="st-update-downloading-notice">
              <FaCheckCircle className="st-download-success-icon" />
              <div>
                <strong>APK Ready for Installation!</strong>
                <p>Check your device's notification tray or Downloads folder. Tap <code>SmartAttend-release.apk</code> to complete installation.</p>
              </div>
            </div>
          )}

          {/* Error Banner */}
          {downloadState === "error" && (
            <div className="st-update-error-banner">
              <FaExclamationTriangle />
              <div>
                <strong>Download stalled or interrupted</strong>
                <p>{errorMessage}</p>
              </div>
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

          {/* Installation Steps Quick Guide */}
          <div className="st-update-guide">
            <span className="st-guide-title">How to Install Update:</span>
            <ol className="st-guide-steps">
              <li>Tap <strong>{downloadState === "completed" ? "Download Again" : "Start Fast APK Download"}</strong> below.</li>
              <li>When Android asks, tap <strong>Download anyway</strong> / <strong>Open</strong>.</li>
              <li>Tap <strong>Install</strong> (your saved account data will remain safe).</li>
            </ol>
          </div>
        </div>

        {/* Modal Actions Footer */}
        <div className="st-update-modal-footer">
          {downloadState === "error" ? (
            <button
              type="button"
              className="st-update-btn-primary"
              onClick={handleStartDownload}
            >
              <FaRedo />
              <span>Retry Download</span>
            </button>
          ) : (
            <button
              type="button"
              className="st-update-btn-primary"
              onClick={handleStartDownload}
              disabled={downloadState === "connecting" || downloadState === "downloading"}
            >
              {downloadState === "connecting" || downloadState === "downloading" ? (
                <>
                  <span className="st-btn-spinner" />
                  <span>Downloading ({downloadProgress.percent}%)...</span>
                </>
              ) : (
                <>
                  <FaDownload />
                  <span>{downloadState === "completed" ? "Download Again (.apk)" : "Start Fast APK Download (.apk)"}</span>
                  <FaExternalLinkAlt className="st-btn-sub-icon" />
                </>
              )}
            </button>
          )}

          {/* Fallback Direct Link Button */}
          <button
            type="button"
            className="st-update-btn-direct"
            onClick={handleDirectDownload}
          >
            Direct Browser Download (Backup)
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

