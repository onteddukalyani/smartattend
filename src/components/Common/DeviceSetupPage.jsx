import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  FaAndroid,
  FaApple,
  FaArrowLeft,
  FaDownload,
  FaInfoCircle,
  FaShieldAlt,
  FaFingerprint,
  FaCamera
} from "react-icons/fa";
import { useAuth } from "../authcontext";
import { isIOSDevice } from "../../services/guidedAccessService";
import { getApkDownloadUrl } from "../../utils/apkUrl";
import "./DeviceSetupPage.css";

const ANDROID_APK_URL = getApkDownloadUrl();

function getRoleHome(pathname) {
  if (pathname.startsWith("/admin")) return "/admin";
  if (pathname.startsWith("/lecturer")) return "/lecturer";
  return "/student";
}

export function RoleFirstLoginGuide({ role, basePath }) {
  const { user } = useAuth();
  const [dismissedKey, setDismissedKey] = useState("");
  const normalizedRole = String(role || "").toLowerCase();
  const accountId = user?.uid || user?.email || "account";
  const storageKey = `smartattend:first-login-guide:${normalizedRole}:${accountId}`;
  const alreadySeen = (() => {
    try {
      return localStorage.getItem(storageKey) === "done";
    } catch {
      return false;
    }
  })();

  const isAdmin = ["admin", "administrator", "superadmin"].includes(normalizedRole);
  const isLecturer = ["lecturer", "faculty", "teacher"].includes(normalizedRole);
  if ((!isAdmin && !isLecturer) || !user || alreadySeen || dismissedKey === storageKey) return null;

  const guide = isAdmin
    ? {
      title: "Administrator first-login guide",
      intro: "Set up your institutional workspace and keep account access, courses, and attendance records organized.",
      steps: [
        "Review the dashboard for student, lecturer, course, and attendance activity.",
        "Use Manage Admins and Manage Lecturers to add or maintain staff access.",
        "Use Manage Students to create or update student records and check their approval or account status.",
        "Create courses, assign lecturers, and maintain each course's student roster.",
        "Review Classes and Attendance for session records and attendance issues.",
        "Open Settings to review your profile and the Android/iPhone device instructions."
      ],
      links: [
        { to: "/admin/students", label: "Manage students" },
        { to: "/admin/courses", label: "Manage courses" }
      ]
    }
    : {
      title: "Lecturer first-login guide",
      intro: "Use your assigned courses to manage student rosters, run attendance sessions, and review your class records.",
      steps: [
        "Open Courses to review courses assigned to your lecturer account.",
        "Manage student details and add or remove students only within courses assigned to you.",
        "Use New Session to start attendance and present the QR codes in the requested order.",
        "Use Classes, Active Sessions, and Attendance to review your sessions and student records.",
        "Admin and Lecturer lists are view-only; only administrators can manage those accounts.",
        "Open Settings to review your profile and the Android/iPhone device instructions."
      ],
      links: [
        { to: "/lecturer/courses", label: "Review my courses" },
        { to: "/lecturer/lecturerpage", label: "Start a session" }
      ]
    };

  const dismiss = () => {
    try {
      localStorage.setItem(storageKey, "done");
    } catch {
      // Keep the guide dismissible if browser storage is unavailable.
    }
    setDismissedKey(storageKey);
  };

  return (
    <div className="role-guide-overlay" role="presentation">
      <section className="role-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="role-guide-title">
        <span className="role-guide-kicker"><FaShieldAlt /> SMARTATTEND QUICK START</span>
        <h2 id="role-guide-title">{guide.title}</h2>
        <p className="role-guide-intro">{guide.intro}</p>
        <ol className="role-guide-steps">
          {guide.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <Link
          className="role-guide-device-link"
          to={`${basePath}/device-setup`}
          onClick={dismiss}
        >
          Read Android and iPhone setup instructions
        </Link>
        <div className="role-guide-actions">
          {guide.links.map((link) => (
            <Link key={link.to} to={link.to} className="role-guide-secondary" onClick={dismiss}>
              {link.label}
            </Link>
          ))}
          <button type="button" className="role-guide-primary" onClick={dismiss}>
            Continue to dashboard
          </button>
        </div>
      </section>
    </div>
  );
}

export default function DeviceSetupPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [platform, setPlatform] = useState(() => {
    try {
      const savedDevice = localStorage.getItem("smartattend_student_device_type");
      if (savedDevice === "android" || savedDevice === "ios") return savedDevice;
    } catch {
      // Use platform detection when local storage is unavailable.
    }
    return isIOSDevice() ? "ios" : "android";
  });
  const roleHome = getRoleHome(location.pathname);
  const roleName = profile?.role === "admin" ? "Administrator" : profile?.role === "lecturer" ? "Lecturer" : "Student";

  return (
    <main className="device-setup-page">
      <button type="button" className="device-setup-back" onClick={() => navigate(roleHome)}>
        <FaArrowLeft /> Back to {roleName} dashboard
      </button>

      <header className="device-setup-header">
        <span className="device-setup-kicker"><FaShieldAlt /> DEVICE SETUP &amp; BIOMETRIC VERIFICATION</span>
        <h1>Prepare your phone for attendance</h1>
        <p>Choose your phone type below to see installation, lock mode, and biometric instructions.</p>
      </header>

      {/* Mandatory Dual-Biometric Banner (Both Android and iPhone) */}
      <section className="device-dual-bio-banner" aria-label="Biometric Requirements">
        <div className="device-dual-bio-badge">
          <FaShieldAlt /> DUAL-BIOMETRIC REGISTRATION
        </div>
        <p className="device-dual-bio-intro">
          To prevent proxy attendance, every student must register <strong>BOTH</strong> biometrics directly inside the SmartAttend app before scanning. You do not need to navigate out of the app:
        </p>
        <div className="device-dual-bio-grid">
          <div className="device-dual-bio-card">
            <div className="bio-card-icon-wrap inapp-bio">
              <FaCamera />
            </div>
            <div className="bio-card-text">
              <h3>1. SmartAttend 3D Face Registration</h3>
              <p>
                Complete your live <strong>3D Face Scan</strong> right inside SmartAttend with active anti-spoofing (blink, head turn, smile). Encrypted facial vectors are securely saved.
              </p>
              {profile?.role === "student" && (
                <Link to="/student/face-enroll" className="bio-quick-enroll-link">
                  Open Face Registration <FaArrowLeft style={{ transform: "rotate(180deg)" }} />
                </Link>
              )}
            </div>
          </div>

          <div className="device-dual-bio-card">
            <div className="bio-card-icon-wrap phone-bio">
              <FaFingerprint />
            </div>
            <div className="bio-card-text">
              <h3>2. In-App Device Fingerprint</h3>
              <p>
                Register your <strong>Fingerprint / Touch ID</strong> directly in SmartAttend. Tapping the in-app button prompts your device sensor and binds your physical phone cryptographically.
              </p>
              {profile?.role === "student" && (
                <Link to="/student/face-enroll" className="bio-quick-enroll-link">
                  Open Fingerprint Registration <FaArrowLeft style={{ transform: "rotate(180deg)" }} />
                </Link>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="device-platform-tabs" role="tablist" aria-label="Phone type">
        <button
          type="button"
          role="tab"
          aria-selected={platform === "android"}
          className={platform === "android" ? "active" : ""}
          onClick={() => setPlatform("android")}
        >
          <FaAndroid /> Android
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={platform === "ios"}
          className={platform === "ios" ? "active" : ""}
          onClick={() => setPlatform("ios")}
        >
          <FaApple /> iPhone
        </button>
      </div>

      {platform === "android" ? (
        <section className="device-instructions" role="tabpanel">
          <div className="device-instructions-heading android">
            <FaAndroid />
            <div>
              <h2>Android Setup Checklist</h2>
              <p>Install the SmartAttend APK and register both face and fingerprint biometrics directly inside the app.</p>
            </div>
          </div>

          {ANDROID_APK_URL ? (
            <a className="device-apk-link" href={ANDROID_APK_URL} download="SmartAttend-release.apk">
              <FaDownload /> Download SmartAttend APK (.apk)
            </a>
          ) : (
            <div className="device-setup-note">
              <FaInfoCircle /> Ask your institution administrator for the current signed SmartAttend APK. This web build has no APK download URL configured; an `.aab` file cannot be installed directly by tapping it.
            </div>
          )}

          <ol className="device-instruction-list">
            <li>
              <strong>1. Download APK Installer:</strong> Tap the download button above to download <span className="device-step-tag">SmartAttend-release.apk</span> onto your Android phone.
            </li>
            <li>
              <strong>2. Google Play Protect Prompt (Before Installation):</strong> Because the app is downloaded directly outside the Play Store, Google Play Protect may display a warning dialog: <em>"Unsafe app blocked"</em> or <em>"Play Protect doesn't recognise this app's developer"</em>:
              <div style={{ marginTop: "6px", padding: "8px 12px", background: "rgba(99, 102, 241, 0.08)", borderRadius: "8px", fontSize: "0.88rem", color: "#312e81", fontWeight: 600 }}>
                👉 Tap <strong>More details</strong> (small dropdown arrow) <span className="device-path-arrow">→</span> Tap <strong>Install anyway</strong>.
                <div style={{ fontWeight: 400, marginTop: "4px", fontSize: "0.82rem", color: "#475569" }}>
                  (If installation remains blocked: Open Google Play Store <span className="device-path-arrow">→</span> tap profile icon <span className="device-path-arrow">→</span> Play Protect <span className="device-path-arrow">→</span> ⚙️ Settings <span className="device-path-arrow">→</span> temporarily disable <em>"Scan apps with Play Protect"</em> while installing).
                </div>
              </div>
            </li>
            <li>
              <strong>3. Allow Restricted Settings (Android 13, 14, 15+):</strong> Sideloaded APKs have settings locked by default (<em>"Restricted setting: currently unavailable"</em>). To unlock:
              <div style={{ marginTop: "6px", padding: "8px 12px", background: "rgba(245, 158, 11, 0.1)", borderRadius: "8px", fontSize: "0.86rem", color: "#78350f" }}>
                • Long-press the <strong>SmartAttend</strong> icon on your phone's home screen <span className="device-path-arrow">→</span> Tap <strong>App info (ℹ️)</strong>.<br />
                • In the top-right corner, tap the <strong>3 DOTS (⋮)</strong> menu.<br />
                • Tap <strong>"Allow restricted settings"</strong> and verify your lock screen PIN or Fingerprint.
              </div>
            </li>
            <li>
              <strong>4. Turn ON Display Over Other Apps:</strong> After allowing restricted settings:
              <div style={{ marginTop: "6px", padding: "8px 12px", background: "rgba(16, 185, 129, 0.08)", borderRadius: "8px", fontSize: "0.86rem", color: "#065f46" }}>
                • On that same App info page (or when SmartAttend prompts you), tap <strong>Display over other apps</strong>.<br />
                • Turn the toggle switch <strong>ON</strong> so SmartAttend can secure your attendance session with Kiosk Lock mode.
              </div>
            </li>
            <li>
              <strong>5. Register 3D Face Biometrics In-App:</strong> Launch SmartAttend, sign in, open <span className="device-step-tag">Sidebar</span> <span className="device-path-arrow">→</span> <span className="device-step-tag">Biometric Registration</span>, and complete your live 3D face scan with the front camera.
            </li>
            <li>
              <strong>6. Register Device Fingerprint In-App:</strong> On the same page, tap the <span className="device-step-tag">Device Fingerprint</span> tab and tap <span className="device-step-tag">Touch Sensor to Register Fingerprint In-App</span>. Touch your phone's sensor to bind your phone cryptographically.
            </li>
            <li>
              <strong>7. Mark Attendance:</strong> Scan the lecturer's QR code. Touch the in-app fingerprint sensor when prompted, verify your face, and your attendance is recorded!
            </li>
          </ol>
          <p className="device-setup-caveat">Kiosk lock availability depends on the Android app and device provisioning. If lock mode is unavailable, contact your administrator before class.</p>
        </section>
      ) : (
        <section className="device-instructions" role="tabpanel">
          <div className="device-instructions-heading ios">
            <FaApple />
            <div>
              <h2>iPhone Setup Checklist</h2>
              <p>Install the Home Screen web app, enable Guided Access, and register both biometrics directly in the app.</p>
            </div>
          </div>

          <ol className="device-instruction-list">
            <li>
              <strong>Install to Home Screen:</strong> Open the SmartAttend website in Safari. Tap the Share icon, then select <span className="device-step-tag">Add to Home Screen</span> (PWA Mode).
            </li>
            <li>
              <strong>Turn On Guided Access:</strong> Open <span className="device-step-tag">iPhone Settings</span> <span className="device-path-arrow">→</span> <span className="device-step-tag">Accessibility</span> <span className="device-path-arrow">→</span> <span className="device-step-tag">Guided Access</span>. Turn it on and set a passcode.
            </li>
            <li>
              <strong>Register Face Biometrics In-App:</strong> Launch SmartAttend from the Home Screen, sign in, open <span className="device-step-tag">Sidebar</span> <span className="device-path-arrow">→</span> <span className="device-step-tag">Biometric Registration</span>, and complete your live 3D face scan.
            </li>
            <li>
              <strong>Register Device Biometrics In-App:</strong> Switch to the <span className="device-step-tag">Device Fingerprint</span> tab and tap <span className="device-step-tag">Touch Sensor to Register Fingerprint In-App</span> to authorize Face ID / Touch ID directly within the app.
            </li>
            <li>
              <strong>Start Guided Access Before Scanning:</strong> Before scanning attendance QR codes, triple-click the Side button (or Home button) and tap Start.
            </li>
            <li>
              <strong>Mark Attendance:</strong> Scan the lecturer's QR codes and complete the live face scan. Keep SmartAttend active in the foreground throughout attendance.
            </li>
            <li>
              <strong>Exit After Session:</strong> After the lecturer ends attendance, triple-click again and enter your Guided Access passcode to exit.
            </li>
          </ol>

          <div className="device-setup-note">
            <FaInfoCircle /> Guided Access must be enabled by you and cannot be reliably verified by a web app. iPhone web apps cannot fully lock the device like Android kiosk mode; leaving the attendance screen may invalidate the attempt under the class policy.
          </div>
        </section>
      )}
    </main>
  );
}