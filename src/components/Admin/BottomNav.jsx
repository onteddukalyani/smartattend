import React from "react";
import { Link, useLocation } from "react-router-dom";
import {
  FaHome,
  FaChalkboardTeacher,
  FaUserGraduate,
  FaClipboardCheck,
  FaCog
} from "react-icons/fa";
import "./BottomNav.css";

function BottomNav() {
  const location = useLocation();

  const items = [
    { path: "/admin", label: "Overview", icon: <FaHome />, end: true },
    { path: "/admin/lecturers", label: "Lecturers", icon: <FaChalkboardTeacher /> },
    { path: "/admin/students", label: "Students", icon: <FaUserGraduate /> },
    { path: "/admin/attendance", label: "Attendance", icon: <FaClipboardCheck /> },
    { path: "/admin/settings", label: "Settings", icon: <FaCog /> }
  ];

  return (
    <nav className="bottom-nav admin-bottom-nav">
      <div className="bottom-nav-container">
        {items.map((item, index) => {
          const isActive = item.end
            ? location.pathname === item.path
            : location.pathname.startsWith(item.path);

          return (
            <Link
              to={item.path}
              className={`bottom-nav-item ${isActive ? "active" : ""}`}
              key={index}
              aria-label={item.label}
            >
              <div className="bottom-nav-icon-wrap">
                {item.icon}
              </div>
              <span className="bottom-nav-label">{item.label}</span>
              {isActive && <span className="bottom-nav-active-pill" />}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export default BottomNav;