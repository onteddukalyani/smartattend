import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  FaAndroid,
  FaApple,
  FaArrowLeft,
  FaDownload,
  FaInfoCircle,
  FaShieldAlt
} from "react-icons/fa";
import { useAuth } from "../authcontext";
import { isIOSDevice } from "../../services/guidedAccessService";
import "./DeviceSetupPage.css";

const ANDROID_APK_URL = import.meta.env.VITE_ANDROID_APK_URL?.trim() || "/app-release.apk";

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
        <span className="device-setup-kicker"><FaShieldAlt /> DEVICE SETUP</span>
        <h1>Prepare your phone for attendance</h1>
        <p>Choose your phone type to see installation and attendance instructions.</p>
      </header>

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
              <h2>Android app</h2>
              <p>Install the SmartAttend APK before marking attendance.</p>
            </div>
          </div>

          {ANDROID_APK_URL ? (
            <a className="device-apk-link" href={ANDROID_APK_URL} target="_blank" rel="noreferrer">
              <FaDownload /> Download SmartAttend APK
            </a>
          ) : (
            <div className="device-setup-note">
              <FaInfoCircle /> Ask your institution administrator for the current signed SmartAttend APK. This web build has no APK download URL configured; an `.aab` file cannot be installed directly by tapping it.
            </div>
          )}

          <ol className="device-instruction-list">
            <li>Open the APK link on your Android phone and download the installer.</li>
            <li>Open the downloaded APK. If Android asks, allow your browser or file manager to install unknown apps, then confirm Install.</li>
            <li>Open SmartAttend and sign in with your student account.</li>
            <li>Allow camera access. If prompted for attendance lock permissions, follow the Android Settings prompt and return to SmartAttend.</li>
            <li>Scan the lecturer's QR codes in order. Keep SmartAttend open until attendance finishes or the lecturer releases the device.</li>
          </ol>
          <p className="device-setup-caveat">Kiosk lock availability depends on the Android app and device provisioning. If lock mode is unavailable, contact your administrator before class.</p>
        </section>
      ) : (
        <section className="device-instructions" role="tabpanel">
          <div className="device-instructions-heading ios">
            <FaApple />
            <div>
              <h2>iPhone web app</h2>
              <p>Install SmartAttend from Safari, then use Guided Access during attendance.</p>
            </div>
          </div>

          <ol className="device-instruction-list">
            <li>Open the SmartAttend website in Safari. Tap Share, then <strong>Add to Home Screen</strong>.</li>
            <li>Open iPhone Settings → Accessibility → Guided Access. Turn it on and set a passcode.</li>
            <li>Launch SmartAttend from the Home Screen icon and sign in with your student account.</li>
            <li>Before scanning attendance QR codes, triple-click the Side button (or Home button on supported older devices) and tap Start.</li>
            <li>After the lecturer ends the attendance flow, triple-click again and enter your Guided Access passcode to exit.</li>
          </ol>

          <div className="device-setup-note">
            <FaInfoCircle /> Guided Access must be enabled by you and cannot be reliably verified by a web app. iPhone web apps cannot fully lock the device like Android kiosk mode; leaving the attendance screen may invalidate the attempt under the class policy.
          </div>
        </section>
      )}
    </main>
  );
}