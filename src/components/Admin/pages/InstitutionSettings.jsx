import React, { useEffect, useState } from "react";
import {
  FaUniversity,
  FaClock,
  FaQrcode,
  FaSave,
  FaLock
} from "react-icons/fa";

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "firebase/firestore";

import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";

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

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
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
    } catch (error) {
      console.error(
        "Error loading institution settings:",
        error
      );
    } finally {
      setLoading(false);
    }
  };

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
          Configure the SmartAttend system for
          IIIT Dharwad.
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

            <p>
              Official institution information.
            </p>
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
          Institution identity is controlled by the
          system and cannot be changed from this page.
        </div>

      </section>


      {/* Attendance Settings */}

      <section className="settings-card">

        <div className="settings-card-header">

          <div className="settings-icon">
            <FaClock />
          </div>

          <div>
            <h2>Attendance Settings</h2>

            <p>
              Configure attendance session behavior.
            </p>
          </div>

        </div>

        <div className="settings-grid">

          <div className="settings-field">

            <label>
              Session Duration
            </label>

            <div className="input-with-unit">

              <input
                type="number"
                min="1"
                max="180"
                name="sessionDuration"
                value={settings.sessionDuration}
                onChange={handleChange}
              />

              <span>minutes</span>

            </div>

            <small>
              How long an attendance session remains
              active.
            </small>

          </div>


          <div className="settings-field">

            <label>
              QR Refresh Interval
            </label>

            <div className="input-with-unit">

              <input
                type="number"
                min="5"
                max="300"
                name="qrRefreshInterval"
                value={settings.qrRefreshInterval}
                onChange={handleChange}
              />

              <span>seconds</span>

            </div>

            <small>
              How frequently the attendance QR code
              changes.
            </small>

          </div>


          <div className="settings-field">

            <label>
              Attendance Window
            </label>

            <div className="input-with-unit">

              <input
                type="number"
                min="1"
                max="30"
                name="attendanceWindow"
                value={settings.attendanceWindow}
                onChange={handleChange}
              />

              <span>minutes</span>

            </div>

            <small>
              Time allowed for students to submit
              attendance.
            </small>

          </div>

        </div>

      </section>


      {/* Late Attendance */}

      <section className="settings-card">

        <div className="settings-card-header">

          <div className="settings-icon">
            <FaQrcode />
          </div>

          <div>
            <h2>Attendance Rules</h2>

            <p>
              Control how attendance is recorded.
            </p>
          </div>

        </div>

        <label className="toggle-setting">

          <input
            type="checkbox"
            name="allowLateAttendance"
            checked={settings.allowLateAttendance}
            onChange={handleChange}
          />

          <span className="toggle-slider"></span>

          <div>
            <strong>
              Allow late attendance
            </strong>

            <p>
              Allow students to mark attendance
              after the normal attendance window.
            </p>
          </div>

        </label>

      </section>


      {/* Save */}

      <div className="settings-actions">

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

          {saving
            ? "Saving..."
            : "Save Settings"}
        </button>

      </div>

    </div>
  );
};

export default InstitutionSettings;