import React from "react";

import {
  FaBars,
  FaBell,
  FaUserCircle
} from "react-icons/fa";

import { useAuth } from "../authcontext";

import "./AdminNavbar.css";


const AdminNavbar = ({ onMenuClick }) => {

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


        <div className="admin-brand">

          <div className="admin-brand-logo">
            SA
          </div>

          <div>
            <strong>
              SmartAttend
            </strong>

            <span>
              IIIT Dharwad
            </span>
          </div>

        </div>

      </div>


      {/* ================= RIGHT ================= */}

      <div className="admin-navbar-right">

        <button
          type="button"
          className="admin-notification"
          title="Notifications"
        >
          <FaBell />
          <span className="notification-dot"></span>
        </button>


        <div className="admin-user">

          {user?.photoURL ? (

            <img
              src={user.photoURL}
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

      </div>

    </header>
  );
};


export default AdminNavbar;