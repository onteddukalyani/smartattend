import React, { useState } from "react";
import { Routes, Route } from "react-router-dom";

import AdminNavbar from "./AdminNavbar";
import AdminSidebar from "./AdminSidebar";

import AdminOverview from "./pages/AdminOverview";
import ManageLecturers from "./pages/ManageLecturers";
import AddLecturer from "./pages/AddLecturer";
import ManageStudents from "./pages/ManageStudents";
import AddStudent from "./pages/AddStudent";
import AttendanceOverview from "./pages/AttendanceOverview";
import InstitutionSettings from "./pages/InstitutionSettings";
import AdminProfile from "./pages/AdminProfile";
import "./AdminDashboard.css";
const AdminDashboard = () => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  return (
    <div
      className={`admin-layout ${sidebarOpen ? "sidebar-is-open" : "sidebar-is-closed"
        }`}
    >
      <AdminSidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="admin-main">
        <AdminNavbar onMenuClick={() => setSidebarOpen(true)} />
        <main className="admin-content">
          <Routes>
            <Route index element={<AdminOverview />} />
            <Route path="students" element={<ManageStudents />} />
            <Route path="students/add" element={<AddStudent />} />
            <Route path="students/bulk" element={<AddStudent />} />
            <Route path="add-student" element={<AddStudent />} />
            <Route path="lecturers" element={<ManageLecturers />} />
            <Route path="lecturers/add" element={<AddLecturer />} />
            <Route path="add-lecturer" element={<AddLecturer />} />
            <Route path="attendance" element={<AttendanceOverview />} />
            <Route path="institution" element={<InstitutionSettings />} />
            <Route path="profile" element={<AdminProfile />} />
          </Routes>
        </main>
      </div>
    </div>
  );
};

export default AdminDashboard;