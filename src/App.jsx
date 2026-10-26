import { useEffect, useState, lazy, Suspense } from "react";
import {
  Routes,
  Route,
  Navigate,
  useNavigate
} from "react-router-dom";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { FaGraduationCap, FaSpinner } from "react-icons/fa";
import ProtectedRoute from "./components/ProtectedRoute";
import { useAuth } from "./components/authcontext";
import AppUpdateModal from "./components/Common/AppUpdateModal";
import AppUpdateBanner from "./components/Common/AppUpdateBanner";
import HeadsUpNotification from "./components/Common/HeadsUpNotification";
import AndroidOverlayPermissionModal from "./components/Common/AndroidOverlayPermissionModal";
import { checkForAppUpdate, subscribeToAppUpdates } from "./services/appUpdateService";
import { requestAppNotificationPermissions, triggerRealAppNotification } from "./services/nativeNotificationService";
import {
  dismissAppUpdate,
  hasAppUpdateNotificationBeenShown,
  isAppUpdateDismissed,
  markAppUpdateNotificationShown
} from "./utils/appUpdateDismissal";
import "./App.css";

// Lazy-loaded components for instant initial page loads and code splitting
const Login = lazy(() => import("./components/login"));
const AdminDashboard = lazy(() => import("./components/Admin/AdminDashboard"));
const QrScannerApp = lazy(() => import("./components/Common/Scanner"));
const Settings = lazy(() => import("./components/Common/Settings"));

// Lecturer lazy imports
const LecturerDashboard = lazy(() => import("./components/Lecturer/LecturerDashboard"));
const LecturerDashboardView = lazy(() => import("./components/Lecturer/pages/Dashboard"));
const LecturerPage = lazy(() => import("./components/Lecturer/pages/Generateqr"));
const StudentForm = lazy(() => import("./components/Lecturer/pages/StudentForm"));
const AttendanceData = lazy(() => import("./components/Admin/pages/AttendanceOverview"));
const FaceScanner = lazy(() => import("./components/Lecturer/pages/FaceScanner"));
const ClassesData = lazy(() => import("./components/Lecturer/pages/SessionData"));
const SessionAttendanceData = lazy(() =>
  import("./components/Lecturer/pages/SessionData").then((m) => ({ default: m.SessionAttendanceData }))
);
const ActiveSessions = lazy(() => import("./components/Lecturer/pages/ActiveSessions"));
const StudentsList = lazy(() => import("./components/Common/StudentsList"));
const LecturerCourses = lazy(() => import("./components/Common/CoursesManager"));
const AddStudent = lazy(() => import("./components/Admin/pages/AddStudent"));
const ReadOnlyAdminList = lazy(() => import("./components/Admin/pages/ManageAdmins"));
const ReadOnlyLecturerList = lazy(() => import("./components/Admin/pages/ManageLecturers"));
const DeviceSetupPage = lazy(() => import("./components/Common/DeviceSetupPage"));
const ManageBiometricReRegistration = lazy(() => import("./components/Common/ManageBiometricReRegistration"));
const IdentifyStudentByFace = lazy(() => import("./components/Common/IdentifyStudentByFace"));

// Student lazy imports
const StudentDashboard = lazy(() => import("./components/Student/StudentDashboard"));
const StudentDashboardView = lazy(() => import("./components/Student/pages/Dashboard"));
const Statistics = lazy(() => import("./components/Student/pages/Statistics"));
const StudentCourses = lazy(() => import("./components/Student/pages/StudentCourses"));
const FaceEnrollPage = lazy(() => import("./components/Student/pages/FaceEnrollPage"));
const SupportFeedbackPage = lazy(() => import("./components/Common/SupportFeedbackPage"));

const PageLoadingFallback = () => (
  <div style={{
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "60vh",
    gap: "12px",
    color: "var(--accent, #6366f1)"
  }}>
    <FaSpinner className="fa-spin" style={{ fontSize: "2rem" }} />
    <span style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--text-muted, #64748b)" }}>Loading page...</span>
  </div>
);


function App() {
  const navigate = useNavigate();
  const { user, profile, loading } = useAuth();
  const [updateInfo, setUpdateInfo] = useState(null);
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false);

  // 0. Real-time Live Subscription & Auto-check for APK / App Updates
  useEffect(() => {
    let isMounted = true;
    let resumeCheckTimeout = null;

    const handleUpdateDetected = async (info) => {
      if (!isMounted || !info || !info.hasUpdate) return;

      if (!info.isMandatory && isAppUpdateDismissed(info.latestVersion)) {
        setUpdateInfo(null);
        setIsUpdateModalOpen(false);
        return;
      }

      setUpdateInfo(info);
      setIsUpdateModalOpen(true);

      if (!hasAppUpdateNotificationBeenShown(info.latestVersion)) {
        markAppUpdateNotificationShown(info.latestVersion);
        try {
          const now = Date.now();
          await triggerRealAppNotification({
            id: `sys_update_${info.latestVersion}`,
            title: `🚀 Update Available (v${info.latestVersion})`,
            message: `A new version of SmartAttend is available. Tap to download and install now!`,
            type: "APP_UPDATE",
            url: "/help",
            timestamp: now
          });
        } catch (_) {}
      }
    };

    // Live subscription to Firestore app_updates and 60s background heartbeat
    const unsubscribe = subscribeToAppUpdates(handleUpdateDetected);

    // Lifecycle resume & online reconnection triggers
    const scheduleUpdateCheck = () => {
      if (resumeCheckTimeout !== null) clearTimeout(resumeCheckTimeout);
      resumeCheckTimeout = setTimeout(() => {
        resumeCheckTimeout = null;
        checkForAppUpdate()
          .then(handleUpdateDetected)
          .catch((err) => console.warn("[AppUpdate] Resume check failed:", err));
      }, 200);
    };
    const handleResume = () => {
      if (document.visibilityState === "visible") {
        scheduleUpdateCheck();
      }
    };
    const handleFocus = () => {
      scheduleUpdateCheck();
    };
    const handleOnline = () => {
      scheduleUpdateCheck();
    };

    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);

    return () => {
      isMounted = false;
      if (resumeCheckTimeout !== null) clearTimeout(resumeCheckTimeout);
      if (typeof unsubscribe === "function") unsubscribe();
      document.removeEventListener("visibilitychange", handleResume);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  // Request native Android 13+ and Web Notification permissions when user is authenticated
  useEffect(() => {
    if (user) {
      requestAppNotificationPermissions().catch(() => {});
    }
  }, [user]);

  // 1. Listen for Native Deep Links & App Links (smartattend:// or https://)
  useEffect(() => {
    let listenerHandle = null;

    const handleDeepLink = (rawUrl) => {
      try {
        if (!rawUrl) return;
        console.log("[DeepLink] Processing incoming URL:", rawUrl);

        let targetPath = "/student/mark-attendance";
        let searchStr = "";

        if (rawUrl.startsWith("smartattend://")) {
          const rawPart = rawUrl.replace("smartattend://", "");
          const parts = rawPart.split("?");
          targetPath = parts[0] ? `/${parts[0].replace(/^\//, "")}` : "/student/mark-attendance";
          if (!targetPath.startsWith("/student/mark-attendance") && !targetPath.startsWith("/scanqr")) {
            targetPath = "/student/mark-attendance";
          }
          searchStr = parts[1] ? `?${parts[1]}` : "";
        } else if (rawUrl.startsWith("intent://")) {
          // Parse Android Intent URI
          const match = rawUrl.match(/intent:\/\/(.*?)(#Intent|\?|$)/);
          const path = match ? match[1] : "student/mark-attendance";
          targetPath = `/${path.replace(/^\//, "")}`;
          const qMatch = rawUrl.match(/\?(.*?)(#Intent|$)/);
          searchStr = qMatch ? `?${qMatch[1]}` : "";
        } else {
          const parsed = new URL(rawUrl);
          targetPath = parsed.pathname || "/student/mark-attendance";
          searchStr = parsed.search || "";
        }

        const fullRoute = `${targetPath}${searchStr}`;
        console.log("[DeepLink] Routing to:", fullRoute);

        if (typeof window !== "undefined") {
          sessionStorage.setItem("smartattend_redirect_after_login", fullRoute);
        }
        if (user) {
          navigate(fullRoute, { replace: true });
        } else {
          navigate(fullRoute, { replace: true });
        }
      } catch (err) {
        console.warn("[DeepLink] Error parsing deep link URL:", err);
      }
    };

    if (Capacitor.isNativePlatform()) {
      // Check cold-start launch URL
      CapacitorApp.getLaunchUrl()
        .then((launchUrl) => {
          if (launchUrl && launchUrl.url) {
            console.log("[DeepLink] Cold start launch URL:", launchUrl.url);
            handleDeepLink(launchUrl.url);
          }
        })
        .catch((err) => console.warn("[DeepLink] getLaunchUrl notice:", err));

      // Listen for warm-start app URL events
      CapacitorApp.addListener("appUrlOpen", (event) => {
        if (event && event.url) {
          handleDeepLink(event.url);
        }
      }).then((handle) => {
        listenerHandle = handle;
      });
    }

    return () => {
      if (listenerHandle && typeof listenerHandle.remove === "function") {
        listenerHandle.remove();
      }
    };
  }, [user, navigate]);

  // 1.8 Global Android Hardware/Software Back Button Handler
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let backHandler = null;
    CapacitorApp.addListener("backButton", ({ canGoBack }) => {
      const path = (window.location.pathname || "").toLowerCase();
      // If user is actively scanning QR/biometrics in kiosk mode, Scanner.jsx handles/blocks it
      const hasActiveKioskScan = Boolean(
        localStorage.getItem("smartattend_kiosk_session_state") &&
        (path.includes("mark-attendance") || path.includes("scanqr"))
      );
      if (hasActiveKioskScan) {
        return;
      }

      // Root portal pages where pressing back cleanly exits the Android app:
      const isRootPortalPage =
        path === "/student" || path === "/student/" ||
        path === "/lecturer" || path === "/lecturer/" ||
        path === "/admin" || path === "/admin/" ||
        path === "/login" || path === "/" || path === "";

      if (isRootPortalPage || !canGoBack) {
        console.log("[App] Exiting Android app via Back button on root page:", path);
        CapacitorApp.exitApp();
      } else {
        navigate(-1);
      }
    }).then((h) => {
      backHandler = h;
    });

    return () => {
      if (backHandler && typeof backHandler.remove === "function") {
        backHandler.remove();
      }
    };
  }, [navigate]);

  // 1.5 Restore preserved attendance deep-link once user auth is resolved
  useEffect(() => {
    if (!loading && user && typeof window !== "undefined") {
      const pendingRedirect = sessionStorage.getItem("smartattend_redirect_after_login");
      if (pendingRedirect) {
        sessionStorage.removeItem("smartattend_redirect_after_login");
        console.log("[DeepLink] Restoring pending attendance route after login:", pendingRedirect);
        navigate(pendingRedirect, { replace: true });
      }
    }
  }, [loading, user, navigate]);

  // 2. Preserve unauthenticated incoming attendance URL in sessionStorage
  useEffect(() => {
    if (!loading && !user && typeof window !== "undefined") {
      const currentPath = window.location.pathname;
      const currentSearch = window.location.search;
      if (currentSearch.includes("session=") || currentPath.includes("mark-attendance") || currentPath.includes("scanqr")) {
        const redirectUrl = `${currentPath}${currentSearch}`;
        sessionStorage.setItem("smartattend_redirect_after_login", redirectUrl);
      }
    }
  }, [loading, user]);

  // Wait until Firebase checks the current login
  if (loading) {
    return (
      <div className="app-loading-screen" role="status" aria-live="polite">
        <div className="app-loading-card">
          <div className="app-loading-logo-wrap">
            <div className="app-loading-pulse-ring"></div>
            <div className="app-loading-logo-badge">
              <FaGraduationCap />
            </div>
          </div>
          <div className="app-loading-text">
            <p className="app-loading-status">Loading SmartAttend...</p>
          </div>
          <div className="app-loading-progress-bar">
            <div className="app-loading-progress-indeterminate"></div>
          </div>
        </div>
      </div>
    );
  }

  /*
   * Not logged in
   */
  if (!user) {
    return (
      <>
        <Suspense fallback={<PageLoadingFallback />}>
          <Routes>
            <Route
              path="/student-form"
              element={<StudentForm />}
            />

            <Route
              path="/login"
              element={<Login />}
            />

            <Route
              path="*"
              element={
                <Navigate
                  to="/login"
                  replace
                />
              }
            />
          </Routes>
        </Suspense>
        <AppUpdateModal updateInfo={updateInfo} onClose={() => setUpdateInfo(null)} />
      </>
    );
  }

  /*
   * Logged in but no role/profile yet.
   */
  if (!profile) {
    return (
      <>
        <Suspense fallback={<PageLoadingFallback />}>
          <Routes>
            <Route
              path="/student-form"
              element={<StudentForm />}
            />

            <Route
              path="/login"
              element={<Login />}
            />

            <Route
              path="*"
              element={
                <Navigate
                  to="/login"
                  replace
                />
              }
            />
          </Routes>
        </Suspense>
        <AppUpdateModal updateInfo={updateInfo} onClose={() => setUpdateInfo(null)} />
      </>
    );
  }

  /*
   * AUTHENTICATED USER (All roles unified under ProtectedRoute)
   */
  const currentRole = String(profile.role || "").trim().toLowerCase();
  const defaultDashboard =
    currentRole === "admin"
      ? "/admin"
      : currentRole === "lecturer"
      ? "/lecturer"
      : "/student";

  return (
    <>
      <Suspense fallback={<PageLoadingFallback />}>
        <Routes>
          {/* Public / Common Routes */}
          <Route path="/student-form" element={<StudentForm />} />
          <Route
            path="/login"
            element={
              (() => {
                const pending = typeof window !== "undefined" ? sessionStorage.getItem("smartattend_redirect_after_login") : null;
                if (pending) {
                  sessionStorage.removeItem("smartattend_redirect_after_login");
                  return <Navigate to={pending} replace />;
                }
                return <Navigate to={defaultDashboard} replace />;
              })()
            }
          />

        {/* ==========================================
            1. ADMIN PORTAL (Strictly for Admin role)
           ========================================== */}
        <Route
          path="/admin/*"
          element={
            <ProtectedRoute allowedRole="admin">
              <AdminDashboard />
            </ProtectedRoute>
          }
        />

        {/* ==========================================
            2. LECTURER PORTAL (Strictly for Lecturer role)
           ========================================== */}
        <Route
          path="/lecturer"
          element={
            <ProtectedRoute allowedRole="lecturer">
              <LecturerDashboard />
            </ProtectedRoute>
          }
        >
          <Route index element={<LecturerDashboardView />} />
          <Route path="lecturerpage" element={<LecturerPage />} />
          <Route path="student-form" element={<StudentForm />} />
          <Route path="settings" element={<Settings />} />
          <Route path="profile" element={<Settings />} />
          <Route path="attendance-data" element={<AttendanceData />} />
          <Route path="violations" element={<AttendanceData />} />
          <Route path="facedetection" element={<FaceScanner />} />
          <Route path="attendance-sessions" element={<ClassesData />} />
          <Route path="attendance-sessions/:sessionId" element={<SessionAttendanceData />} />
          <Route path="attendance-sessions/*" element={<SessionAttendanceData />} />
          <Route path="classes" element={<ClassesData />} />
          <Route path="classes/:sessionId" element={<SessionAttendanceData />} />
          <Route path="classes/*" element={<SessionAttendanceData />} />
          <Route path="active-sessions" element={<ActiveSessions />} />
          <Route path="students" element={<StudentsList />} />
          <Route path="device-setup" element={<DeviceSetupPage />} />
          <Route path="students/add" element={<AddStudent />} />
          <Route path="students/bulk" element={<AddStudent />} />
          <Route path="add-student" element={<AddStudent />} />
          <Route path="courses" element={<LecturerCourses />} />
          <Route path="admins" element={<ReadOnlyAdminList readOnly />} />
          <Route path="lecturers" element={<ReadOnlyLecturerList readOnly />} />
          <Route path="scanqr" element={<QrScannerApp />} />
          <Route path="face-enroll" element={<FaceEnrollPage />} />
          <Route path="register-face" element={<FaceEnrollPage />} />
          <Route path="manage-reregistration" element={<ManageBiometricReRegistration />} />
          <Route path="reregistration" element={<ManageBiometricReRegistration />} />
          <Route path="identify-student" element={<IdentifyStudentByFace />} />
          <Route path="face-identification" element={<IdentifyStudentByFace />} />
          <Route path="support" element={<SupportFeedbackPage />} />
          <Route path="feedback" element={<SupportFeedbackPage />} />
          <Route path="contact" element={<SupportFeedbackPage />} />
          <Route path="help" element={<SupportFeedbackPage />} />
        </Route>

        {/* Nested Wildcard for /lecturer/* so role mismatch screen renders on deep URL access */}
        <Route
          path="/lecturer/*"
          element={
            <ProtectedRoute allowedRole="lecturer">
              <Navigate to="/lecturer" replace />
            </ProtectedRoute>
          }
        />

        {/* ==========================================
            3. STUDENT PORTAL (Strictly for Student role)
           ========================================== */}
        <Route
          path="/student"
          element={
            <ProtectedRoute allowedRole="student">
              <StudentDashboard />
            </ProtectedRoute>
          }
        >
          <Route index element={<StudentDashboardView />} />
          <Route path="courses" element={<StudentCourses />} />
          <Route path="mark-attendance" element={<QrScannerApp />} />
          <Route path="scanqr" element={<QrScannerApp />} />
          <Route path="statistics" element={<Statistics />} />
          <Route path="settings" element={<Settings />} />
          <Route path="profile" element={<Settings />} />
          <Route path="device-setup" element={<DeviceSetupPage />} />
          <Route path="face-enroll" element={<FaceEnrollPage />} />
          <Route path="register-face" element={<FaceEnrollPage />} />
          <Route path="live-face-enroll" element={<FaceEnrollPage />} />
          <Route path="biometrics" element={<FaceEnrollPage />} />
          <Route path="fingerprint" element={<FaceEnrollPage />} />
          <Route path="fingerprint-enroll" element={<FaceEnrollPage />} />
          <Route path="support" element={<SupportFeedbackPage />} />
          <Route path="feedback" element={<SupportFeedbackPage />} />
          <Route path="contact" element={<SupportFeedbackPage />} />
          <Route path="help" element={<SupportFeedbackPage />} />
        </Route>

        {/* Nested Wildcard for /student/* so role mismatch screen renders on deep URL access */}
        <Route
          path="/student/*"
          element={
            <ProtectedRoute allowedRole="student">
              <Navigate to="/student" replace />
            </ProtectedRoute>
          }
        />

        {/* ==========================================
            4. TOP-LEVEL SHORTCUT ALIASES (Role-Aware)
           ========================================== */}
        <Route
          path="/courses"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/courses"
                  : currentRole === "lecturer"
                  ? "/lecturer/courses"
                  : "/student/courses"
              }
              replace
            />
          }
        />
        <Route
          path="/classes"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/classes"
                  : currentRole === "lecturer"
                  ? "/lecturer/attendance-sessions"
                  : "/student/courses"
              }
              replace
            />
          }
        />
        <Route
          path="/classes/:sessionId"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/classes"
                  : currentRole === "lecturer"
                  ? "/lecturer/attendance-sessions"
                  : "/student/courses"
              }
              replace
            />
          }
        />
        <Route
          path="/attendance-sessions"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/attendance-sessions"
                  : currentRole === "lecturer"
                  ? "/lecturer/attendance-sessions"
                  : "/student/statistics"
              }
              replace
            />
          }
        />
        <Route
          path="/attendance-sessions/:sessionId"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/attendance-sessions"
                  : currentRole === "lecturer"
                  ? "/lecturer/attendance-sessions"
                  : "/student/statistics"
              }
              replace
            />
          }
        />
        <Route
          path="/attendance"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/attendance"
                  : currentRole === "lecturer"
                  ? "/lecturer/attendance-data"
                  : "/student/statistics"
              }
              replace
            />
          }
        />
        <Route
          path="/attendance-data"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/attendance"
                  : currentRole === "lecturer"
                  ? "/lecturer/attendance-data"
                  : "/student/statistics"
              }
              replace
            />
          }
        />
        <Route
          path="/violations"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/violations"
                  : currentRole === "lecturer"
                  ? "/lecturer/violations"
                  : "/student/statistics"
              }
              replace
            />
          }
        />
        <Route
          path="/scanqr"
          element={
            <Navigate
              to={
                currentRole === "student"
                  ? "/student/mark-attendance"
                  : currentRole === "lecturer"
                  ? "/lecturer/scanqr"
                  : "/admin/classes"
              }
              replace
            />
          }
        />
        <Route
          path="/mark-attendance"
          element={
            <Navigate
              to={
                currentRole === "student"
                  ? "/student/mark-attendance"
                  : currentRole === "lecturer"
                  ? "/lecturer/scanqr"
                  : "/admin/classes"
              }
              replace
            />
          }
        />
        <Route
          path="/face-enroll"
          element={
            <Navigate
              to={
                currentRole === "student"
                  ? "/student/face-enroll"
                  : currentRole === "lecturer"
                  ? "/lecturer/face-enroll"
                  : "/admin/face-enroll"
              }
              replace
            />
          }
        />
        <Route
          path="/register-face"
          element={
            <Navigate
              to={
                currentRole === "student"
                  ? "/student/face-enroll"
                  : currentRole === "lecturer"
                  ? "/lecturer/face-enroll"
                  : "/admin/face-enroll"
              }
              replace
            />
          }
        />
        <Route
          path="/live-face-enroll"
          element={
            <Navigate
              to={
                currentRole === "student"
                  ? "/student/face-enroll"
                  : currentRole === "lecturer"
                  ? "/lecturer/face-enroll"
                  : "/admin/face-enroll"
              }
              replace
            />
          }
        />
        <Route
          path="/biometrics"
          element={
            <Navigate
              to={
                currentRole === "student"
                  ? "/student/face-enroll"
                  : currentRole === "lecturer"
                  ? "/lecturer/face-enroll"
                  : "/admin/face-enroll"
              }
              replace
            />
          }
        />
        <Route
          path="/fingerprint"
          element={
            <Navigate
              to={
                currentRole === "student"
                  ? "/student/face-enroll"
                  : currentRole === "lecturer"
                  ? "/lecturer/face-enroll"
                  : "/admin/face-enroll"
              }
              replace
            />
          }
        />
        <Route
          path="/biometric-enroll"
          element={
            <Navigate
              to={
                currentRole === "student"
                  ? "/student/face-enroll"
                  : currentRole === "lecturer"
                  ? "/lecturer/face-enroll"
                  : "/admin/face-enroll"
              }
              replace
            />
          }
        />
        <Route
          path="/manage-reregistration"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/manage-reregistration"
                  : "/lecturer/manage-reregistration"
              }
              replace
            />
          }
        />
        <Route
          path="/reregistration"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/manage-reregistration"
                  : "/lecturer/manage-reregistration"
              }
              replace
            />
          }
        />
        <Route
          path="/identify-student"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/identify-student"
                  : "/lecturer/identify-student"
              }
              replace
            />
          }
        />
        <Route
          path="/face-identification"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/identify-student"
                  : "/lecturer/identify-student"
              }
              replace
            />
          }
        />
        <Route
          path="/statistics"
          element={
            <Navigate
              to={
                currentRole === "student"
                  ? "/student/statistics"
                  : currentRole === "lecturer"
                  ? "/lecturer/attendance-data"
                  : "/admin/attendance"
              }
              replace
            />
          }
        />
        <Route
          path="/students"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/students"
                  : currentRole === "lecturer"
                  ? "/lecturer/students"
                  : "/student"
              }
              replace
            />
          }
        />
        <Route
          path="/students/add"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/students/add"
                  : currentRole === "lecturer"
                  ? "/lecturer/students/add"
                  : "/student"
              }
              replace
            />
          }
        />
        <Route
          path="/lecturers"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/lecturers"
                  : currentRole === "lecturer"
                  ? "/lecturer/lecturers"
                  : "/student"
              }
              replace
            />
          }
        />
        <Route
          path="/admins"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/admins"
                  : currentRole === "lecturer"
                  ? "/lecturer/admins"
                  : "/student"
              }
              replace
            />
          }
        />
        <Route
          path="/active-sessions"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/active-sessions"
                  : currentRole === "lecturer"
                  ? "/lecturer/active-sessions"
                  : "/student"
              }
              replace
            />
          }
        />
        <Route
          path="/settings"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/settings"
                  : currentRole === "lecturer"
                  ? "/lecturer/settings"
                  : "/student/settings"
              }
              replace
            />
          }
        />
        <Route
          path="/profile"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/profile"
                  : currentRole === "lecturer"
                  ? "/lecturer/profile"
                  : "/student/profile"
              }
              replace
            />
          }
        />
        <Route
          path="/device-setup"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/device-setup"
                  : currentRole === "lecturer"
                  ? "/lecturer/device-setup"
                  : "/student/device-setup"
              }
              replace
            />
          }
        />
        <Route
          path="/support"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/support"
                  : currentRole === "lecturer"
                  ? "/lecturer/support"
                  : "/student/support"
              }
              replace
            />
          }
        />
        <Route
          path="/feedback"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/support"
                  : currentRole === "lecturer"
                  ? "/lecturer/support"
                  : "/student/support"
              }
              replace
            />
          }
        />
        <Route
          path="/contact"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/support"
                  : currentRole === "lecturer"
                  ? "/lecturer/support"
                  : "/student/support"
              }
              replace
            />
          }
        />
        <Route
          path="/contact-us"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/support"
                  : currentRole === "lecturer"
                  ? "/lecturer/support"
                  : "/student/support"
              }
              replace
            />
          }
        />
        <Route
          path="/help"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/support"
                  : currentRole === "lecturer"
                  ? "/lecturer/support"
                  : "/student/support"
              }
              replace
            />
          }
        />
        <Route path="/institution" element={<Navigate to="/admin/institution" replace />} />
        <Route
          path="/profile"
          element={
            <Navigate
              to={
                currentRole === "admin"
                  ? "/admin/profile"
                  : currentRole === "lecturer"
                  ? "/lecturer/settings"
                  : "/student/settings"
              }
              replace
            />
          }
        />

        {/* Fallback to user's registered home dashboard */}
        <Route path="/" element={<Navigate to={defaultDashboard} replace />} />
        <Route path="*" element={<Navigate to={defaultDashboard} replace />} />
      </Routes>
    </Suspense>
    <AppUpdateBanner
      updateInfo={updateInfo}
      onOpenModal={() => setIsUpdateModalOpen(true)}
      onDismiss={() => {
        dismissAppUpdate(updateInfo?.latestVersion);
        setUpdateInfo(null);
        setIsUpdateModalOpen(false);
      }}
    />
    <HeadsUpNotification />
    <AppUpdateModal
      updateInfo={isUpdateModalOpen ? updateInfo : null}
      onClose={() => {
        if (!updateInfo?.isMandatory) {
          dismissAppUpdate(updateInfo?.latestVersion);
          setUpdateInfo(null);
        }
        setIsUpdateModalOpen(false);
      }}
    />
    <AndroidOverlayPermissionModal />
    </>
  );
}

export default App;
