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




      </div>


      {/* ================= RIGHT ================= */}

      <div className="admin-navbar-right">

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