import React from "react";

import {
  FaBars,
  FaBell,
  FaUserCircle,
  FaHeadset
} from "react-icons/fa";

import { useAuth } from "../authcontext";

import "./AdminNavbar.css";

import { Link } from "react-router-dom";

const AdminNavbar = ({ onMenuClick, unreadCount = 0, onNotifClick }) => {

  const {
    user,
    profile
  } = useAuth();


  return (
    <header className="admin-navbar">

      {/* ================= LEFT ================= */}

      <div className="admin-navbar-left">

        {/* OPEN SIDEBAR */}

        <button
          type="button"
          className="navbar-menu-btn"
          onClick={onMenuClick}
          aria-label="Open sidebar"
        >
          <FaBars />
        </button>

      </div>


      {/* ================= RIGHT ================= */}

      <div className="admin-navbar-right">

        <Link
          to="/admin/support"
          className="nav-support-link-btn"
          title="Helpdesk, Feedback & Ticket Manager"
          style={{
            background: "#f1f5f9",
            borderRadius: "12px",
            width: "40px",
            height: "40px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#475569",
            fontSize: "1.05rem",
            marginRight: "10px",
            textDecoration: "none"
          }}
        >
          <FaHeadset />
        </Link>

        <button
          type="button"
          className="nav-notif-btn"
          onClick={onNotifClick}
          title="View System & Audit Notifications"
          style={{
            position: "relative",
            background: "#f1f5f9",
            border: "none",
            borderRadius: "12px",
            width: "40px",
            height: "40px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#475569",
            cursor: "pointer",
            fontSize: "1.1rem",
            marginRight: "12px"
          }}
        >
          <FaBell />
          {unreadCount > 0 && (
            <span style={{
              position: "absolute",
              top: "-4px",
              right: "-4px",
              background: "#ef4444",
              color: "#ffffff",
              fontSize: "0.7rem",
              fontWeight: "800",
              width: "18px",
              height: "18px",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 2px 6px rgba(239, 68, 68, 0.4)"
            }}>
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>

        <Link to="/admin/settings" style={{ textDecoration: "none", color: "inherit" }} title="Click to view Settings & Edit Name">
          <div className="admin-user">

            {(profile?.photoURL || profile?.photo || profile?.image || user?.photoURL) ? (

              <img
                src={profile?.photoURL || profile?.photo || profile?.image || user?.photoURL}
                alt=""
                className="admin-user-photo"
              />

            ) : (

              <FaUserCircle
                className="admin-user-icon"
              />

            )}


            <div className="admin-user-info">

              <strong>
                {profile?.name ||
                  user?.displayName ||
                  "Administrator"}
              </strong>

              <span>
                Administrator
              </span>

            </div>

          </div>
        </Link>

      </div>

    </header>
  );
};


export default AdminNavbar;