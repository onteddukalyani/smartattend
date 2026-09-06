import {
    FaBars,
    FaTimes,
    FaUser
} from "react-icons/fa";
import React, { useState } from "react";
import { Link } from "react-router-dom";
import './Navbar.css'
import { useAuth } from "../authcontext";

function Navbar({ sidebarHidden, onMenuClick }) {
    const { user, profile } = useAuth();
    const [profileImageFailed, setProfileImageFailed] = useState(false);
    const profileName = profile?.name || (user?.isAnonymous ? "Guest" : (profile?.rollNo || "Student"));
    const profileImage = user?.photoURL;
    return (
        <header className="navbar">

            <div className="left-nav">

                <button
                    className="menu-btn"
                    onClick={onMenuClick}
                    aria-label="Open sidebar"
                >
                    <FaBars />
                </button>

            </div>

            <div className="right-nav">
                <Link to="/student/settings" className="nav-profile-btn-link" title="Click to view Settings & Edit Name" style={{ textDecoration: "none" }}>
                    <div className="profile">
                        {profileImage && !profileImageFailed ? (
                            <img
                                src={profileImage}
                                alt="Profile"
                                className="nav-profile-img"
                                onError={() => setProfileImageFailed(true)}
                            />
                        ) : (
                            <div className="nav-profile-placeholder">
                                <FaUser />
                            </div>
                        )}
                        <span>{profileName}</span>
                    </div>
                </Link>
            </div>

        </header>
    );
}

export default React.memo(Navbar);