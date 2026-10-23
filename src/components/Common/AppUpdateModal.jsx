import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
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
  FaRedo,
  FaBookOpen,
  FaHistory,
  FaShieldAlt,
  FaQuestionCircle,
  FaLifeRing
} from "react-icons/fa";
import {
  triggerApkDownload,
  downloadApkWithStream
} from "../../services/appUpdateService";
import { dismissAppUpdate } from "../../utils/appUpdateDismissal";
import { getApkMirrors } from "../../utils/apkUrl";
import "./AppUpdateModal.css";

export default function AppUpdateModal({ updateInfo, onClose }) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("update"); // "update" | "help" | "history"

  const mirrors = updateInfo?.mirrors || getApkMirrors();
  const [selectedMirrorUrl, setSelectedMirrorUrl] = useState(
    updateInfo?.apkUrl || mirrors[0]?.url
  );
  const [downloadState, setDownloadState] = useState("idle"); // 'idle' | 'connecting' | 'downloading' | 'verifying_checksum' | 'checksum_mismatch' | 'completed' | 'error'
  const [downloadProgress, setDownloadProgress] = useState({
    percent: 0,
    receivedBytes: 0,
    totalBytes: 0,
    speedKBps: 0,
    hasContentLength: true,
    actualChecksum: null
  });
  const [errorMessage, setErrorMessage] = useState("");
  const abortControllerRef = useRef(null);

  if (!updateInfo || (!updateInfo.hasUpdate && !updateInfo.isOpen)) return null;

  const {
    currentVersion,
    latestVersion,
    minRequiredVersion,
    title,
    releaseNotes,
    history = [],
    isMandatory,
    mandatoryReason,
    sha256Checksum,
    releaseDate
  } = updateInfo;

  const handleStartDownload = async () => {
    setDownloadState("connecting");
    setErrorMessage("");
    setDownloadProgress({
      percent: 0,
      receivedBytes: 0,
      totalBytes: 0,
      speedKBps: 0,
      hasContentLength: true,
      actualChecksum: null
    });

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      const res = await downloadApkWithStream({
        url: selectedMirrorUrl,
        expectedChecksum: sha256Checksum,
        signal: abortControllerRef.current.signal,
        onProgress: (p) => {
          if (p.stage === "connecting") {
            setDownloadState("connecting");
          } else if (p.stage === "downloading" || p.stage === "processing") {
            setDownloadState("downloading");
          } else if (p.stage === "verifying_checksum") {
            setDownloadState("verifying_checksum");
          } else if (p.stage === "checksum_mismatch") {
            setDownloadState("checksum_mismatch");
          } else if (p.stage === "completed" || p.stage === "direct_triggered" || p.stage === "direct_fallback") {
            setDownloadState("completed");
          }
          setDownloadProgress({
            percent: p.percent || 0,
            receivedBytes: p.receivedBytes || 0,
            totalBytes: p.totalBytes || 0,
            speedKBps: p.speedKBps || 0,
            hasContentLength: p.hasContentLength !== false,
            actualChecksum: p.actualChecksum || null
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
    if (!isMandatory) {
      dismissAppUpdate(latestVersion);
    }
    if (onClose) onClose();
  };

  const handleNavigateSupport = () => {
    if (onClose) onClose();
    try {
      navigate("/student/support");
    } catch (_) {
      window.location.href = "/student/support";
    }
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
            <span>{isMandatory ? "Required App Update" : (!updateInfo.hasUpdate ? "App Version & Guide" : "App Update Available")}</span>
          </div>
          {!isMandatory && (
            <button
              type="button"
              className="st-update-close-btn"
              onClick={handleDismiss}
              title="Close"
              aria-label="Close"
            >
              <FaTimes />
            </button>
          )}
        </div>

        {/* Navigation Tabs */}
        <div className="st-update-tabs-bar">
          <button
            type="button"
            className={`st-update-tab-btn ${activeTab === 'update' ? 'active' : ''}`}
            onClick={() => setActiveTab('update')}
          >
            <FaDownload />
            <span>Update</span>
          </button>
          <button
            type="button"
            className={`st-update-tab-btn ${activeTab === 'help' ? 'active' : ''}`}
            onClick={() => setActiveTab('help')}
          >
            <FaBookOpen />
            <span>Installation Help</span>
          </button>
          <button
            type="button"
            className={`st-update-tab-btn ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            <FaHistory />
            <span>Changelog</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="st-update-modal-body">
          {activeTab === 'update' && (
            <>
              <div className="st-update-hero-icon-wrap">
                <div className="st-update-android-icon">
                  <FaAndroid />
                </div>
                <span className="st-update-pulse-ring" />
              </div>

              <h2 id="update-dialog-title" className="st-update-title">
                {!updateInfo.hasUpdate
                  ? `SmartAttend is Up to Date (v${currentVersion})`
                  : (title || `Update to SmartAttend v${latestVersion}`)}
              </h2>

              <div className="st-update-version-pills">
                <div className="st-ver-pill current">
                  <span className="st-ver-label">Current:</span>
                  <span className="st-ver-val">v{currentVersion}</span>
                </div>
                {updateInfo.hasUpdate && (
                  <>
                    <span className="st-ver-arrow">➔</span>
                    <div className="st-ver-pill latest">
                      <span className="st-ver-label">Latest:</span>
                      <span className="st-ver-val">v{latestVersion}</span>
                      <span className="st-ver-new-tag">NEW</span>
                    </div>
                  </>
                )}
              </div>

              {releaseDate && (
                <p className="st-update-date">
                  Released: {new Date(releaseDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                </p>
              )}

              {/* Mandatory Update Explanation */}
              {isMandatory && (
                <div className="st-update-mandatory-banner">
                  <FaExclamationTriangle className="st-mandatory-icon" />
                  <div>
                    <strong>Mandatory Protocol Update Required</strong>
                    <p>{mandatoryReason || `SmartAttend v${minRequiredVersion || latestVersion} is required to mark attendance and maintain security compliance.`}</p>
                  </div>
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
                      disabled={downloadState === "connecting" || downloadState === "downloading" || downloadState === "verifying_checksum"}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Live Progress Bar Widget */}
              {(downloadState === "connecting" || downloadState === "downloading" || downloadState === "verifying_checksum") && (
                <div className="st-update-progress-container">
                  <div className="st-progress-meta">
                    <span className="st-progress-state-text">
                      {downloadState === "connecting" && "Connecting to download server..."}
                      {downloadState === "downloading" && (
                        downloadProgress.hasContentLength
                          ? `Downloading APK (${downloadProgress.percent}%)`
                          : "Downloading APK (Stream in progress)..."
                      )}
                      {downloadState === "verifying_checksum" && "Verifying cryptographic SHA-256 integrity..."}
                    </span>
                    {downloadProgress.speedKBps > 0 && (
                      <span className="st-progress-speed-text">
                        {formatSpeed(downloadProgress.speedKBps)}
                      </span>
                    )}
                  </div>

                  <div className="st-progress-bar-track">
                    <div
                      className={`st-progress-bar-fill ${!downloadProgress.hasContentLength && downloadState === 'downloading' ? 'indeterminate' : ''}`}
                      style={{
                        width: downloadProgress.hasContentLength
                          ? `${Math.max(4, downloadProgress.percent)}%`
                          : '100%'
                      }}
                    />
                  </div>

                  <div className="st-progress-footer-row">
                    <span className="st-progress-bytes-text">
                      {downloadProgress.hasContentLength && downloadProgress.totalBytes > 0
                        ? `${formatMB(downloadProgress.receivedBytes)} MB / ${formatMB(downloadProgress.totalBytes)} MB`
                        : `${formatMB(downloadProgress.receivedBytes)} MB downloaded`}
                    </span>
                    {downloadState === "verifying_checksum" && (
                      <span className="st-progress-checksum-tag">
                        <FaShieldAlt /> Validating Hash
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* SHA-256 Verified Banner */}
              {downloadState === "completed" && (
                <div className="st-update-downloading-notice">
                  <FaCheckCircle className="st-download-success-icon" />
                  <div>
                    <strong>APK Downloaded &amp; Ready to Install!</strong>
                    {downloadProgress.actualChecksum && (
                      <p className="st-checksum-pass-text">
                        <FaShieldAlt /> Cryptographic SHA-256 verified ({downloadProgress.actualChecksum.slice(0, 12)}...)
                      </p>
                    )}
                    <p>Open device notifications or your Downloads folder and tap <code>SmartAttend-release.apk</code> to complete installation.</p>
                  </div>
                </div>
              )}

              {/* Checksum Mismatch Alert */}
              {downloadState === "checksum_mismatch" && (
                <div className="st-update-error-banner">
                  <FaShieldAlt className="st-error-shield-icon" />
                  <div>
                    <strong>Security Verification Failed!</strong>
                    <p>The downloaded file's SHA-256 checksum did not match the official release metadata. The download has been blocked to protect your device. Please retry using an alternative mirror.</p>
                  </div>
                </div>
              )}

              {/* Generic Error Banner */}
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
            </>
          )}

          {/* TAB 2: STEP-BY-STEP INSTALLATION GUIDANCE */}
          {activeTab === 'help' && (
            <div className="st-update-help-container">
              <div className="st-help-hero">
                <FaBookOpen className="st-help-hero-icon" />
                <h3>Android Installation Guide</h3>
                <p>Follow these steps to successfully install or update SmartAttend on your Android phone.</p>
              </div>

              <div className="st-help-step-card">
                <div className="st-step-badge">Step 1</div>
                <div className="st-step-content">
                  <strong>Download the Verified APK</strong>
                  <p>Tap <strong>Start Fast APK Download</strong> on the Update tab. SmartAttend automatically streams and validates the cryptographic package in memory.</p>
                </div>
              </div>

              <div className="st-help-step-card">
                <div className="st-step-badge">Step 2</div>
                <div className="st-step-content">
                  <strong>Locate the Downloaded APK</strong>
                  <p>Swipe down from the top of your screen to open the notification tray and tap <code>SmartAttend-release.apk</code>, or open your phone's <strong>Files / Downloads</strong> folder.</p>
                </div>
              </div>

              <div className="st-help-step-card">
                <div className="st-step-badge">Step 3</div>
                <div className="st-step-content">
                  <strong>Allow Installation from this Source</strong>
                  <p>If Android prompts <em>"For your security, your phone is not allowed to install unknown apps from this source"</em>, tap <strong>Settings</strong> and toggle <strong>Allow from this source</strong> to ON.</p>
                </div>
              </div>

              <div className="st-help-step-card">
                <div className="st-step-badge">Step 4</div>
                <div className="st-step-content">
                  <strong>Tap "Install" / "Update"</strong>
                  <p>Return to the installer and tap <strong>Install</strong> or <strong>Update</strong>. Your existing login session, biometric profile, and student records will remain completely intact.</p>
                </div>
              </div>

              <div className="st-help-step-card warning">
                <div className="st-step-badge warn">Important</div>
                <div className="st-step-content">
                  <strong>Troubleshooting &amp; App Compatibility</strong>
                  <p>If Android displays <em>"App not installed"</em>:</p>
                  <ul>
                    <li>Ensure you have at least <strong>100 MB</strong> of free storage space.</li>
                    <li>Ensure you are updating the official release build signed with the same certificate.</li>
                    <li><strong>Do not uninstall the existing app</strong> as a first resort, as this clears your biometric enrollments. Contact your faculty administrator if signing errors persist.</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: RELEASE HISTORY / CHANGELOG */}
          {activeTab === 'history' && (
            <div className="st-update-history-container">
              <h3 className="st-history-title">Release History &amp; Changelog</h3>
              {history && history.length > 0 ? (
                <div className="st-history-timeline">
                  {history.map((h, idx) => (
                    <div key={idx} className="st-history-item">
                      <div className="st-history-dot" />
                      <div className="st-history-header">
                        <span className="st-history-ver">v{h.version}</span>
                        {h.releaseDate && <span className="st-history-date">{h.releaseDate}</span>}
                      </div>
                      <h4 className="st-history-item-title">{h.title || `SmartAttend v${h.version}`}</h4>
                      {Array.isArray(h.releaseNotes) && (
                        <ul className="st-history-notes">
                          {h.releaseNotes.map((rn, rIdx) => (
                            <li key={rIdx}>{rn}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="st-history-empty">
                  <p>You are viewing release notes for SmartAttend v{latestVersion}.</p>
                  <ul className="st-history-notes">
                    {releaseNotes.map((rn, rIdx) => (
                      <li key={rIdx}>{rn}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Actions Footer */}
        <div className="st-update-modal-footer">
          {activeTab === 'update' ? (
            <>
              {downloadState === "error" || downloadState === "checksum_mismatch" ? (
                <button
                  type="button"
                  className="st-update-btn-primary"
                  onClick={handleStartDownload}
                >
                  <FaRedo />
                  <span>Retry Download with Selected Mirror</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="st-update-btn-primary"
                  onClick={handleStartDownload}
                  disabled={downloadState === "connecting" || downloadState === "downloading" || downloadState === "verifying_checksum"}
                >
                  {downloadState === "connecting" || downloadState === "downloading" ? (
                    <>
                      <span className="st-btn-spinner" />
                      <span>Downloading ({downloadProgress.percent}%)...</span>
                    </>
                  ) : downloadState === "verifying_checksum" ? (
                    <>
                      <span className="st-btn-spinner" />
                      <span>Verifying Checksum...</span>
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

              <div className="st-footer-links-row">
                <button
                  type="button"
                  className="st-update-link-btn"
                  onClick={() => setActiveTab('help')}
                >
                  <FaQuestionCircle />
                  <span>Installation Instructions</span>
                </button>
                <button
                  type="button"
                  className="st-update-link-btn"
                  onClick={handleDirectDownload}
                >
                  <span>Direct Browser Download</span>
                </button>
              </div>

              {/* Support & Recovery Link */}
              <button
                type="button"
                className="st-support-recovery-btn"
                onClick={handleNavigateSupport}
              >
                <FaLifeRing />
                <span>Having trouble? Contact Support or Report Issue</span>
              </button>

              {!isMandatory && (
                <button
                  type="button"
                  className="st-update-btn-secondary"
                  onClick={handleDismiss}
                >
                  Remind Me Later (24h)
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="st-update-btn-primary"
              onClick={() => setActiveTab('update')}
            >
              <FaDownload />
              <span>Back to Update Download</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

