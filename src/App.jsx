import React from "react";
import {
  Routes,
  Route,
  Navigate
} from "react-router-dom";

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

// Student imports
import StudentDashboard from "./components/Student/StudentDashboard";
import StudentDashboardView from "./components/Student/pages/Dashboard";
import Statistics from "./components/Student/pages/Statistics";

import ProtectedRoute from "./components/ProtectedRoute";
import { useAuth } from "./components/authcontext";
import "./App.css";

function App() {
  const { user, profile, loading } = useAuth();

  // Wait until Firebase checks the current login
  if (loading) {
    return (
      <div className="app-loading">
        <h2>Loading SmartAttend...</h2>
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
          <Route path="active-sessions" element={<ActiveSessions />} />
          <Route path="attendance-sessions/:sessionId" element={<SessionAttendanceData />} />
          <Route path="students" element={<StudentsList />} />
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