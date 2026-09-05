import React, { useState } from "react";
import { Routes, Route } from "react-router-dom";

import AdminNavbar from "./AdminNavbar";
import AdminSidebar from "./AdminSidebar";

import AdminOverview from "./pages/AdminOverview";
import ManageAdmins from "./pages/ManageAdmins";
import AddAdmin from "./pages/AddAdmin";
import ManageLecturers from "./pages/ManageLecturers";
import AddLecturer from "./pages/AddLecturer";
import ManageStudents from "./pages/ManageStudents";
import AddStudent from "./pages/AddStudent";
import AttendanceOverview from "./pages/AttendanceOverview";
import InstitutionSettings from "./pages/InstitutionSettings";
import AdminProfile from "./pages/AdminProfile";
import Settings from "../Common/Settings";
import ClassesData, { SessionAttendanceData } from "../Lecturer/pages/SessionData";
import "./AdminDashboard.css";

const AdminDashboard = () => {
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth > 900);
  return (
    <div
      className={`admin-layout ${sidebarOpen ? "sidebar-is-open" : "sidebar-is-closed"
        }`}
    >
      <AdminSidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="admin-main">
        <AdminNavbar onMenuClick={() => setSidebarOpen((prev) => !prev)} />
        <main className="admin-content">
          <Routes>
            <Route index element={<AdminOverview />} />
            <Route path="admins" element={<ManageAdmins />} />
            <Route path="admins/add" element={<AddAdmin />} />
            <Route path="add-admin" element={<AddAdmin />} />
            <Route path="students" element={<ManageStudents />} />
            <Route path="students/add" element={<AddStudent />} />
            <Route path="students/bulk" element={<AddStudent />} />
            <Route path="add-student" element={<AddStudent />} />
            <Route path="lecturers" element={<ManageLecturers />} />
            <Route path="lecturers/add" element={<AddLecturer />} />
            <Route path="add-lecturer" element={<AddLecturer />} />
            <Route path="attendance" element={<AttendanceOverview />} />
            <Route path="classes" element={<ClassesData />} />
            <Route path="classes/:sessionId" element={<SessionAttendanceData />} />
            <Route path="institution" element={<InstitutionSettings />} />
            <Route path="settings" element={<Settings />} />
            <Route path="profile" element={<AdminProfile />} />
          </Routes>
        </main>
      </div>
    </div>
  );
};

export default AdminDashboard;