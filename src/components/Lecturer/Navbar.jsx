import {
    FaBars,
    FaTimes,
    FaUser,
    FaBell,
    FaHeadset
} from "react-icons/fa";
import React, { useState } from "react";
import { Link } from "react-router-dom";
import './Navbar.css'
import { useAuth } from "../authcontext";

function Navbar({ sidebarHidden, onMenuClick, unreadCount = 0, onNotifClick }) {
    const { user, profile } = useAuth();
    const [profileImageFailed, setProfileImageFailed] = useState(false);
    const profileName = profile?.name || user?.displayName || (user?.isAnonymous ? "Guest" : "Lecturer");
    const profileImage = profile?.photoURL || profile?.photo || profile?.image || user?.photoURL || user?.providerData?.[0]?.photoURL;
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
                <Link
                    to="/lecturer/support"
                    className="nav-support-link-btn"
                    title="Helpdesk, Feedback & Issue Reporting"
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
                        marginRight: "8px",
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
                        marginRight: "10px"
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

                <Link to="/lecturer/settings" className="nav-profile-btn-link" title="Click to view Settings & Edit Name" style={{ textDecoration: "none" }}>
                    <div className="profile">
                        {profileImage && !profileImageFailed ? (
                            <img
                                src={profileImage}
                                referrerPolicy="no-referrer"
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