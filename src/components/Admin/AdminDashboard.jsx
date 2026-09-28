import { useState, useEffect } from "react";
import { Routes, Route } from "react-router-dom";

import AdminNavbar from "./AdminNavbar";
import AdminSidebar from "./AdminSidebar";

import AdminOverview from "./pages/AdminOverview";
import ManageAdmins from "./pages/ManageAdmins";
import AddAdmin from "./pages/AddAdmin";
import ManageLecturers from "./pages/ManageLecturers";
import AddLecturer from "./pages/AddLecturer";
import StudentsList from "../Common/StudentsList";
import AddStudent from "./pages/AddStudent";
import AttendanceOverview from "./pages/AttendanceOverview";
import InstitutionSettings from "./pages/InstitutionSettings";
import AdminProfile from "./pages/AdminProfile";
import ManageCourses from "../Common/CoursesManager";
import Settings from "../Common/Settings";
import DeviceSetupPage, { RoleFirstLoginGuide } from "../Common/DeviceSetupPage";
import ClassesData, { SessionAttendanceData } from "../Lecturer/pages/SessionData";
import FaceScanner from "../Lecturer/pages/FaceScanner";
import LecturerPage from "../Lecturer/pages/Generateqr";
import ActiveSessions from "../Lecturer/pages/ActiveSessions";
import QrScannerApp from "../Common/Scanner";
import FaceEnrollPage from "../Student/pages/FaceEnrollPage";
import NotificationHistoryModal from "../Student/NotificationHistoryModal";
import { subscribeToFacultyNotifications } from "../../services/notificationsService";
import "./AdminDashboard.css";
import BottomNav from "./BottomNav";

const AdminDashboard = () => {
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth > 900);
  const [facultyNotifs, setFacultyNotifs] = useState([]);
  const [showNotifModal, setShowNotifModal] = useState(false);

  useEffect(() => {
    const unsub = subscribeToFacultyNotifications((newNotifs) => {
      setFacultyNotifs(newNotifs || []);
    });
    return () => unsub();
  }, []);

  const unreadCount = facultyNotifs.filter(n => !n.read).length;

  return (
    <div
      className={`admin-layout ${sidebarOpen ? "sidebar-is-open" : "sidebar-is-closed"
        }`}
    >
      <AdminSidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="admin-main">
        <AdminNavbar
          onMenuClick={() => setSidebarOpen((prev) => !prev)}
          unreadCount={unreadCount}
          onNotifClick={() => setShowNotifModal(true)}
        />
        <main className="admin-content">
          <Routes>
            <Route index element={<AdminOverview />} />
            <Route path="admins" element={<ManageAdmins />} />
            <Route path="admins/add" element={<AddAdmin />} />
            <Route path="add-admin" element={<AddAdmin />} />
            <Route path="students" element={<StudentsList />} />
            <Route path="students/add" element={<AddStudent />} />
            <Route path="students/bulk" element={<AddStudent />} />
            <Route path="add-student" element={<AddStudent />} />
            <Route path="lecturers" element={<ManageLecturers />} />
            <Route path="lecturers/add" element={<AddLecturer />} />
            <Route path="add-lecturer" element={<AddLecturer />} />
            <Route path="attendance" element={<AttendanceOverview />} />
            <Route path="violations" element={<AttendanceOverview />} />
            <Route path="attendance-data" element={<AttendanceOverview />} />
            <Route path="courses" element={<ManageCourses />} />
            <Route path="classes" element={<ClassesData />} />
            <Route path="classes/:sessionId" element={<SessionAttendanceData />} />
            <Route path="classes/*" element={<SessionAttendanceData />} />
            <Route path="attendance-sessions" element={<ClassesData />} />
            <Route path="attendance-sessions/:sessionId" element={<SessionAttendanceData />} />
            <Route path="attendance-sessions/*" element={<SessionAttendanceData />} />
            <Route path="active-sessions" element={<ActiveSessions />} />
            <Route path="lecturerpage" element={<LecturerPage />} />
            <Route path="facedetection" element={<FaceScanner />} />
            <Route path="scanqr" element={<QrScannerApp />} />
            <Route path="face-enroll" element={<FaceEnrollPage />} />
            <Route path="register-face" element={<FaceEnrollPage />} />
            <Route path="institution" element={<InstitutionSettings />} />
            <Route path="settings" element={<Settings />} />
            <Route path="device-setup" element={<DeviceSetupPage />} />
            <Route path="profile" element={<AdminProfile />} />
          </Routes>
        </main>
      </div>
      <BottomNav />
      <RoleFirstLoginGuide role="admin" basePath="/admin" />

      {/* Faculty & Admin Audit Logs Modal */}
      <NotificationHistoryModal
        isOpen={showNotifModal}
        onClose={() => setShowNotifModal(false)}
        notifications={facultyNotifs}
        isFaculty={true}
      />
    </div>
  );
};

export default AdminDashboard;