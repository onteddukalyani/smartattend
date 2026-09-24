import React, { useEffect, lazy, Suspense } from "react";
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
const AttendanceData = lazy(() => import("./components/Lecturer/pages/AttendanceData"));
const FaceScanner = lazy(() => import("./components/Lecturer/pages/FaceScanner"));
const ClassesData = lazy(() => import("./components/Lecturer/pages/SessionData"));
const SessionAttendanceData = lazy(() =>
  import("./components/Lecturer/pages/SessionData").then((m) => ({ default: m.SessionAttendanceData }))
);
const ActiveSessions = lazy(() => import("./components/Lecturer/pages/ActiveSessions"));
const StudentsList = lazy(() => import("./components/Lecturer/pages/StudentsList"));
const LecturerCourses = lazy(() => import("./components/Lecturer/pages/LecturerCourses"));
const AddStudent = lazy(() => import("./components/Admin/pages/AddStudent"));

// Student lazy imports
const StudentDashboard = lazy(() => import("./components/Student/StudentDashboard"));
const StudentDashboardView = lazy(() => import("./components/Student/pages/Dashboard"));
const Statistics = lazy(() => import("./components/Student/pages/Statistics"));
const StudentCourses = lazy(() => import("./components/Student/pages/StudentCourses"));

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

        if (!user) {
          sessionStorage.setItem("smartattend_redirect_after_login", fullRoute);
          navigate("/login", { replace: true });
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
    );
  }

  /*
   * Logged in but no role/profile yet.
   */
  if (!profile) {
    return (
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
    );
  }

  /*
   * ADMIN
   */
  if (profile.role === "admin") {
    return (
      <Suspense fallback={<PageLoadingFallback />}>
        <Routes>
          <Route
            path="/student-form"
            element={<StudentForm />}
          />

          <Route
            path="/admin/*"
            element={
              <ProtectedRoute allowedRole="admin">
                <AdminDashboard />
              </ProtectedRoute>
            }
          />

          <Route
            path="*"
            element={
              <Navigate
                to="/admin"
                replace
              />
            }
          />
        </Routes>
      </Suspense>
    );
  }

  /*
   * LECTURER
   */
  if (profile.role === "lecturer") {
    return (
      <Suspense fallback={<PageLoadingFallback />}>
        <Routes>
          <Route path="/student-form" element={<StudentForm />} />
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
            <Route path="attendance-data" element={<AttendanceData />} />
            <Route path="facedetection" element={<FaceScanner />} />
            <Route path="attendance-sessions" element={<ClassesData />} />
            <Route path="attendance-sessions/:sessionId" element={<SessionAttendanceData />} />
            <Route path="attendance-sessions/*" element={<SessionAttendanceData />} />
            <Route path="classes" element={<ClassesData />} />
            <Route path="classes/:sessionId" element={<SessionAttendanceData />} />
            <Route path="classes/*" element={<SessionAttendanceData />} />
            <Route path="active-sessions" element={<ActiveSessions />} />
            <Route path="students" element={<StudentsList />} />
            <Route path="students/add" element={<AddStudent />} />
            <Route path="students/bulk" element={<AddStudent />} />
            <Route path="add-student" element={<AddStudent />} />
            <Route path="courses" element={<LecturerCourses />} />
            <Route path="scanqr" element={<QrScannerApp />} />
          </Route>
          <Route path="*" element={<Navigate to="/lecturer" replace />} />
        </Routes>
      </Suspense>
    );
  }

  /*
   * STUDENT
   */
  if (profile.role === "student") {
    return (
      <Suspense fallback={<PageLoadingFallback />}>
        <Routes>
          <Route path="/student-form" element={<StudentForm />} />
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
            <Route path="statistics" element={<Statistics />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/student" replace />} />
        </Routes>
      </Suspense>
    );
  }

  /*
   * Unknown role
   */
  return (
    <Suspense fallback={<PageLoadingFallback />}>
      <Routes>
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
  );
}

export default App;