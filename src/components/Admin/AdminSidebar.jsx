import React from "react";
import { NavLink } from "react-router-dom";

import {
  FaHome,
  FaUserShield,
  FaChalkboardTeacher,
  FaUserGraduate,
  FaClipboardCheck,
  FaChalkboard,
  FaBookOpen,
  FaCog,
  FaUserCircle,
  FaSignOutAlt,
  FaTimes,
  FaGraduationCap
} from "react-icons/fa";
import { useAuth } from "../authcontext";

import "./AdminSidebar.css";


const AdminSidebar = ({ isOpen, onClose }) => {

  const { logoutUser } = useAuth();

  const handleLinkClick = () => {
    if (window.innerWidth <= 900 && onClose) {
      onClose();
    }
  };

  const menuItems = [
    { path: "/admin", label: "Dashboard", icon: FaHome, end: true },
    { path: "/admin/admins", label: "Manage Admins", icon: FaUserShield },
    { path: "/admin/lecturers", label: "Manage Lecturers", icon: FaChalkboardTeacher },
    { path: "/admin/students", label: "Manage Students", icon: FaUserGraduate },
    { path: "/admin/courses", label: "Courses", icon: FaBookOpen },
    { path: "/admin/attendance", label: "Attendance", icon: FaClipboardCheck },
    { path: "/admin/classes", label: "Classes", icon: FaChalkboard },
    { path: "/admin/settings", label: "Settings", icon: FaCog }
  ];


  return (
    <aside
      className={`admin-sidebar ${isOpen ? "sidebar-open" : "sidebar-closed"
        }`}
    >

      {/* ================= HEADER ================= */}

      <div className="admin-sidebar-header">

        <div className="admin-brand">

          <div className="admin-logo-icon">
            <FaGraduationCap />
          </div>

          <div className="admin-brand-text">
            <h2><strong>SmartAttend</strong></h2>
            <span>Administration</span>
          </div>

        </div>


        {/* CLOSE BUTTON */}

        <button
          type="button"
          className="sidebar-close-btn"
          onClick={onClose}
          aria-label="Close sidebar"
        >
          <FaTimes />
        </button>

      </div>


      {/* ================= NAVIGATION ================= */}

      <nav className="admin-sidebar-nav">

        {menuItems.map((item) => {

          const Icon = item.icon;

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.end}
              onClick={handleLinkClick}
              className={({ isActive }) =>
                `admin-nav-link ${isActive ? "active" : ""
                }`
              }
            >

              <Icon />

              <span>
                {item.label}
              </span>

            </NavLink>
          );

        })}

      </nav>


      {/* ================= BOTTOM NAV ================= */}

      <div className="admin-sidebar-bottom">

        <NavLink
          to="/admin/profile"
          onClick={handleLinkClick}
          className={({ isActive }) =>
            `admin-bottom-link ${isActive ? "active" : ""
            }`
          }
        >
          <FaUserCircle />

          <span>
            Profile
          </span>

        </NavLink>


        <button
          type="button"
          className="admin-logout"
          onClick={logoutUser}
        >
          <FaSignOutAlt />

          <span>
            Logout
          </span>

        </button>

      </div>

    </aside>
  );
};


export default AdminSidebar;