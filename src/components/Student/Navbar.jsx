import {
    FaBars,
    FaTimes,
    FaUser
} from "react-icons/fa";
import React, { useState } from "react";
import './Navbar.css'
import { useAuth } from "../authcontext";

function Navbar({ sidebarHidden, onMenuClick }) {
    const { user, profile } = useAuth();
    const [profileImageFailed, setProfileImageFailed] = useState(false);
    const profileName = profile?.name || user?.displayName || (user?.isAnonymous ? "Guest" : "Student");
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

            </div>

        </header>
    );
}

export default React.memo(Navbar);