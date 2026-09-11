import React, { useEffect } from "react";
import {
  Routes,
  Route,
  Navigate,
  useNavigate
} from "react-router-dom";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

import Login from "./components/login";
import AdminDashboard from "./components/Admin/AdminDashboard";
import QrScannerApp from "./components/Common/Scanner";
import Settings from "./components/Common/Settings";

// Lecturer imports
import LecturerDashboard from "./components/Lecturer/LecturerDashboard";
import LecturerDashboardView from "./components/Lecturer/pages/Dashboard";
import LecturerPage from "./components/Lecturer/pages/Generateqr";
import StudentForm from "./components/Lecturer/pages/StudentForm";
import AttendanceData from "./components/Lecturer/pages/AttendanceData";
import FaceScanner from "./components/Lecturer/pages/FaceScanner";
import ClassesData, { SessionAttendanceData } from "./components/Lecturer/pages/SessionData";
import ActiveSessions from "./components/Lecturer/pages/ActiveSessions";
import StudentsList from "./components/Lecturer/pages/StudentsList";
import LecturerCourses from "./components/Lecturer/pages/LecturerCourses";
import AddStudent from "./components/Admin/pages/AddStudent";

// Student imports
import StudentDashboard from "./components/Student/StudentDashboard";
import StudentDashboardView from "./components/Student/pages/Dashboard";
import Statistics from "./components/Student/pages/Statistics";
import StudentCourses from "./components/Student/pages/StudentCourses";

import ProtectedRoute from "./components/ProtectedRoute";
import { useAuth } from "./components/authcontext";
import { FaGraduationCap } from "react-icons/fa";
import "./App.css";

function App() {
  const navigate = useNavigate();
  const { user, profile, loading } = useAuth();

  // 1. Listen for Native Deep Links & App Links (smartattend:// or https://)
  useEffect(() => {
    let listenerHandle = null;

    if (Capacitor.isNativePlatform()) {
      listenerHandle = CapacitorApp.addListener("appUrlOpen", (event) => {
        try {
          console.log("[DeepLink] App opened with URL:", event.url);
          if (!event.url) return;

          let targetPath = "/student/mark-attendance";
          let searchStr = "";

          if (event.url.startsWith("smartattend://")) {
            const rawPart = event.url.replace("smartattend://", "");
            const parts = rawPart.split("?");
            targetPath = parts[0] ? `/${parts[0].replace(/^\//, "")}` : "/student/mark-attendance";
            if (!targetPath.startsWith("/student/mark-attendance") && !targetPath.startsWith("/scanqr")) {
              targetPath = "/student/mark-attendance";
            }
            searchStr = parts[1] ? `?${parts[1]}` : "";
          } else {
            const parsed = new URL(event.url);
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
    );
  }

  /*
   * Logged in but no role/profile yet.
   */
  if (!profile) {
    return (
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
    );
  }

  /*
   * ADMIN
   */
  if (profile.role === "admin") {
    return (
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
    );
  }

  /*
   * LECTURER
   */
  if (profile.role === "lecturer") {
    return (
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
    );
  }

  /*
   * STUDENT
   */
  if (profile.role === "student") {
    return (
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
    );
  }

  /*
   * Unknown role
   */
  return (
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
  );
}

export default App;