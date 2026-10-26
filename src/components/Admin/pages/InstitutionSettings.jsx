import React, { useEffect, useState } from "react";
import {
  FaUniversity,
  FaClock,
  FaQrcode,
  FaSave,
  FaLock,
  FaRocket,
  FaDownload,
  FaSyncAlt,
  FaCheckCircle,
  FaExclamationTriangle,
  FaBullhorn
} from "react-icons/fa";

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "firebase/firestore";

import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { sendFacultyNotification } from "../../../services/notificationsService";
import {
  CURRENT_APP_VERSION,
  CURRENT_APP_VERSION_CODE,
  checkForAppUpdate,
  publishAppUpdate
} from "../../../services/appUpdateService";
import { getApkDownloadUrl } from "../../../utils/apkUrl";

import "./InstitutionSettings.css";

const InstitutionSettings = () => {
  const { user } = useAuth();

  const [settings, setSettings] = useState({
    sessionDuration: 10,
    qrRefreshInterval: 30,
    attendanceWindow: 5,
    allowLateAttendance: true
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  // App Updates & In-App Release State
  const [publishedUpdate, setPublishedUpdate] = useState(null);
  const [updateForm, setUpdateForm] = useState({
    version: "1.0.1",
    versionCode: 2,
    minRequiredVersion: "1.0.0",
    isMandatory: false,
    mandatoryReason: "",
    title: "SmartAttend v1.0.1 Available",
    releaseNotes: "• Real-time update notifications for all active users\n• Enhanced GPS indoor precision\n• Streamlined notification center",
    apkUrl: getApkDownloadUrl()
  });
  const [publishingUpdate, setPublishingUpdate] = useState(false);
  const [updateFeedback, setUpdateFeedback] = useState({ success: "", error: "" });

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const settingsRef = doc(
        db,
        "institution",
        "settings"
      );

      const snapshot = await getDoc(settingsRef);

      if (snapshot.exists()) {
        setSettings((previous) => ({
          ...previous,
          ...snapshot.data()
        }));
      }

      try {
        const updateInfo = await checkForAppUpdate();
        if (updateInfo) {
          setPublishedUpdate(updateInfo);
        }
      } catch (_) {}
    } catch (error) {
      console.error(
        "Error loading institution settings:",
        error
      );
    } finally {
      setLoading(false);
    }
  }

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;

    setSettings((previous) => ({
      ...previous,
      [name]:
        type === "checkbox"
          ? checked
          : Number(value)
    }));

    setMessage("");
  };

  const handleUpdateFormChange = (e) => {
    const { name, value, type, checked } = e.target;
    setUpdateForm((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value
    }));
    setUpdateFeedback({ success: "", error: "" });
  };

  const handlePublishUpdate = async (e) => {
    e.preventDefault();
    setUpdateFeedback({ success: "", error: "" });

    if (!updateForm.version.trim()) {
      setUpdateFeedback({ success: "", error: "Please enter a valid version string (e.g. 1.0.1)." });
      return;
    }

    try {
      setPublishingUpdate(true);
      await publishAppUpdate({
        version: updateForm.version.trim(),
        versionCode: Number(updateForm.versionCode) || 1,
        minRequiredVersion: updateForm.minRequiredVersion.trim() || "1.0.0",
        isMandatory: Boolean(updateForm.isMandatory),
        mandatoryReason: updateForm.mandatoryReason.trim(),
        releaseNotes: updateForm.releaseNotes.split("\n").map(s => s.trim()).filter(Boolean),
        title: updateForm.title.trim() || `SmartAttend v${updateForm.version} Available`,
        apkUrl: updateForm.apkUrl.trim() || getApkDownloadUrl(),
        publisherEmail: user?.email || "Administrator"
      });

      const refreshed = await checkForAppUpdate();
      setPublishedUpdate(refreshed);

      setUpdateFeedback({
        success: `🚀 Update v${updateForm.version.trim()} published successfully! All users currently using the app on Android and Web have been notified in real time.`,
        error: ""
      });
    } catch (err) {
      setUpdateFeedback({
        success: "",
        error: `Failed to broadcast update: ${err.message}`
      });
    } finally {
      setPublishingUpdate(false);
    }
  };

  const saveSettings = async () => {
    try {
      setSaving(true);
      setMessage("");

      const settingsRef = doc(
        db,
        "institution",
        "settings"
      );

      await setDoc(
        settingsRef,
        {
          ...settings,
          institutionName: "IIIT Dharwad",
          updatedAt: serverTimestamp(),
          updatedBy: user?.uid || null
        },
        { merge: true }
      );

      await sendFacultyNotification(
        "⚙️ Institutional Parameters Updated",
        `Institutional campus parameters and university identity were updated by ${user?.email || 'Administrator'}.`,
        "SYSTEM_UPDATE",
        "",
        user?.email || "Admin",
        {},
        "faculty"
      );

      setMessage(
        "Institution settings saved successfully."
      );
    } catch (error) {
      console.error(
        "Error saving settings:",
        error
      );

      setMessage(
        "Unable to save settings."
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="institution-settings-page">
        <div className="settings-loading">
          Loading settings...
        </div>
      </div>
    );
  }

  return (
    <div className="institution-settings-page">

      <div className="settings-header">
        <h1>Institution Settings</h1>

        <p>
          Configure the SmartAttend system policies and manage in-app release updates.
        </p>
      </div>

      {/* Institution Information */}
      <section className="settings-card">
        <div className="settings-card-header">
          <div className="settings-icon">
            <FaUniversity />
          </div>
          <div>
            <h2>Institution Information</h2>
            <p>Official institution information.</p>
          </div>
        </div>

        <div className="institution-info">
          <div className="settings-field">
            <label>Institution Name</label>
            <div className="locked-input">
              <input
                value="IIIT Dharwad"
                readOnly
              />
              <FaLock />
            </div>
          </div>

          <div className="settings-field">
            <label>Institution Code</label>
            <div className="locked-input">
              <input
                value="IIIT-DWD"
                readOnly
              />
              <FaLock />
            </div>
          </div>
        </div>

        <div className="settings-note">
          Institution identity is controlled by the system and cannot be changed from this page.
        </div>
      </section>

      {/* Attendance Session Policy (Faculty Governed) */}
      <section className="settings-card">
        <div className="settings-card-header">
          <div className="settings-icon" style={{ background: "rgba(99, 102, 241, 0.12)", color: "#6366f1" }}>
            <FaClock />
          </div>
          <div>
            <h2>Attendance Session Timings &amp; Rules</h2>
            <p>Configured directly and manually by Faculty / Lecturers per classroom session.</p>
          </div>
        </div>

        <div style={{
          padding: "16px 20px",
          background: "var(--surface-hover, #f8fafc)",
          borderRadius: "14px",
          border: "1px solid var(--border, #e2e8f0)",
          display: "flex",
          flexDirection: "column",
          gap: "10px"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "700", color: "var(--text-main, #0f172a)" }}>
            <FaLock style={{ color: "#6366f1" }} />
            <span>Faculty-Governed Classroom Timings</span>
          </div>
          <p style={{ margin: 0, fontSize: "14px", lineHeight: "1.6", color: "var(--text-muted, #64748b)" }}>
            In accordance with institutional academic policy, attendance session durations, dual-QR rotation intervals, and submission windows are set up manually by faculty instructors at the start of each class. Administrators do not alter active session timings.
          </p>
          <div style={{ display: "flex", gap: "10px", marginTop: "4px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "12px", fontWeight: "700", padding: "4px 12px", borderRadius: "16px", background: "rgba(99, 102, 241, 0.12)", color: "#6366f1" }}>
              Session Duration: Configured by Lecturer
            </span>
            <span style={{ fontSize: "12px", fontWeight: "700", padding: "4px 12px", borderRadius: "16px", background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}>
              QR Rotation: Dynamic Classroom Screen
            </span>
          </div>
        </div>
      </section>

      {/* Save Settings Actions */}
      <div className="settings-actions" style={{ marginBottom: "26px" }}>
        {message && (
          <span className="settings-message">
            {message}
          </span>
        )}

        <button
          type="button"
          className="save-settings-btn"
          onClick={saveSettings}
          disabled={saving}
        >
          <FaSave />
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>

      {/* =========================================================
          APP RELEASES & IN-APP UPDATE DISPATCH SECTION
          Whenever an update is published, active users are notified immediately.
          ========================================================= */}
      <section className="settings-card" id="app-releases">
        <div className="settings-card-header">
          <div className="settings-icon" style={{ background: "rgba(16, 185, 129, 0.1)", color: "#10b981" }}>
            <FaRocket />
          </div>
          <div>
            <h2>App Updates &amp; Broadcast Dispatch</h2>
            <p>Publish an application update. Whoever is currently using the app on Android or Web will receive an instant real-time notification to update.</p>
          </div>
        </div>

        {/* Status badges */}
        <div className="update-status-badges">
          <div className="update-status-pill installed">
            <FaSyncAlt />
            <span>Installed Client Build: <strong>v{CURRENT_APP_VERSION}</strong> (Code: {CURRENT_APP_VERSION_CODE})</span>
          </div>
          <div className="update-status-pill published">
            <FaCheckCircle />
            <span>Active Published Version: <strong>v{publishedUpdate?.latestVersion || CURRENT_APP_VERSION}</strong></span>
          </div>
          {publishedUpdate?.isMandatory && (
            <div className="update-status-pill mandatory">
              <FaExclamationTriangle />
              <span>Mandatory Update Enforced (Min: v{publishedUpdate?.minRequiredVersion})</span>
            </div>
          )}
        </div>

        {/* Update Publisher Form */}
        <form onSubmit={handlePublishUpdate}>
          <div className="settings-grid">
            <div className="settings-field">
              <label>New Version String</label>
              <input
                type="text"
                name="version"
                placeholder="e.g. 1.0.1"
                value={updateForm.version}
                onChange={handleUpdateFormChange}
                required
              />
              <small>Semantic version string for the new release.</small>
            </div>

            <div className="settings-field">
              <label>Version Code</label>
              <input
                type="number"
                min="1"
                name="versionCode"
                value={updateForm.versionCode}
                onChange={handleUpdateFormChange}
                required
              />
              <small>Integer increment for Android packaging.</small>
            </div>

            <div className="settings-field">
              <label>Minimum Required Version</label>
              <input
                type="text"
                name="minRequiredVersion"
                placeholder="1.0.0"
                value={updateForm.minRequiredVersion}
                onChange={handleUpdateFormChange}
              />
              <small>Clients below this version will be blocked from attendance.</small>
            </div>
          </div>

          <div className="settings-grid" style={{ marginTop: "16px" }}>
            <div className="settings-field" style={{ gridColumn: "span 2" }}>
              <label>Release Title / Announcement</label>
              <input
                type="text"
                name="title"
                placeholder="e.g. SmartAttend v1.0.1 Available"
                value={updateForm.title}
                onChange={handleUpdateFormChange}
                required
              />
            </div>

            <div className="settings-field">
              <label>APK Download URL</label>
              <input
                type="url"
                name="apkUrl"
                value={updateForm.apkUrl}
                onChange={handleUpdateFormChange}
                required
              />
            </div>
          </div>

          <div className="settings-field" style={{ marginTop: "16px" }}>
            <label>Release Notes / Changelog</label>
            <textarea
              rows="4"
              name="releaseNotes"
              value={updateForm.releaseNotes}
              onChange={handleUpdateFormChange}
              placeholder="Enter bullet points for this release..."
              style={{
                width: "100%",
                padding: "10px 14px",
                borderRadius: "10px",
                border: "1px solid #cbd5e1",
                fontFamily: "inherit",
                fontSize: "13.5px",
                boxSizing: "border-box"
              }}
            />
            <small>Highlights displayed in the user update modal.</small>
          </div>

          <label className="toggle-setting" style={{ marginTop: "16px" }}>
            <input
              type="checkbox"
              name="isMandatory"
              checked={updateForm.isMandatory}
              onChange={handleUpdateFormChange}
            />
            <span className="toggle-slider"></span>
            <div>
              <strong>Force Mandatory Update</strong>
              <p>Block access to attendance scanning until users install this update.</p>
            </div>
          </label>

          {updateForm.isMandatory && (
            <div className="settings-field" style={{ marginTop: "12px" }}>
              <label>Mandatory Reason Message</label>
              <input
                type="text"
                name="mandatoryReason"
                placeholder="e.g. Critical security update required for attendance validation."
                value={updateForm.mandatoryReason}
                onChange={handleUpdateFormChange}
              />
            </div>
          )}

          {updateFeedback.success && (
            <div className="update-feedback-msg success">
              <FaCheckCircle style={{ marginRight: "6px" }} />
              {updateFeedback.success}
            </div>
          )}

          {updateFeedback.error && (
            <div className="update-feedback-msg error">
              <FaExclamationTriangle style={{ marginRight: "6px" }} />
              {updateFeedback.error}
            </div>
          )}

          <div style={{ marginTop: "20px", display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="submit"
              className="publish-update-btn"
              disabled={publishingUpdate}
            >
              <FaRocket />
              <span>{publishingUpdate ? "Transmitting Update Notice..." : "Publish Update & Notify All Active Users"}</span>
            </button>
            <a
              href={getApkDownloadUrl()}
              download="SmartAttend-release.apk"
              className="publish-update-btn"
              style={{ background: "#334155", textDecoration: "none" }}
            >
              <FaDownload />
              <span>Download Current APK</span>
            </a>
          </div>
        </form>
      </section>

    </div>
  );
};

export default InstitutionSettings;