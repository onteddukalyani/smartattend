import React, { useEffect, useState } from "react";
import {
    FaGoogle,
    FaUserCircle,
    FaUserShield,
    FaChalkboardTeacher,
    FaUserGraduate,
    FaCheckCircle,
    FaIdCard,
    FaMoon,
    FaSun,
    FaCopy,
    FaCheck,
    FaShieldAlt,
    FaUniversity,
    FaLayerGroup,
    FaClock,
    FaEnvelope,
    FaSignOutAlt,
    FaDatabase,
    FaMobileAlt,
    FaLock
} from "react-icons/fa";
import { useAuth } from "../authcontext";
import "./Settings.css";

function Settings() {
    const { user, profile, loginWithGoogle, logoutUser } = useAuth();
    const [theme, setTheme] = useState(() => {
        const savedTheme = localStorage.getItem("smartattend-theme");
        return savedTheme === "midnight" ? "midnight" : "light";
    });
    const [profileImageFailed, setProfileImageFailed] = useState(false);
    const [loginError, setLoginError] = useState("");
    const [loginLoading, setLoginLoading] = useState(false);
    const [copiedField, setCopiedField] = useState("");

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem("smartattend-theme", theme);
    }, [theme]);

    const handleGoogleLogin = async () => {
        setLoginError("");
        setLoginLoading(true);

        try {
            await loginWithGoogle("student");
        } catch (error) {
            setLoginError(error.code ? `${error.code}: ${error.message}` : error.message);
        } finally {
            setLoginLoading(false);
        }
    };

    const handleCopy = (text, fieldName) => {
        if (!text) return;
        navigator.clipboard.writeText(text);
        setCopiedField(fieldName);
        setTimeout(() => setCopiedField(""), 2000);
    };

    const rawRole = (profile?.role || localStorage.getItem("smartattend-user-role") || (user?.isAnonymous ? "guest" : "student")).toLowerCase();

    // Normalized role info
    const getRoleInfo = (r) => {
        switch (r) {
            case "admin":
            case "administrator":
            case "superadmin":
                return {
                    label: "Administrator",
                    fullTitle: "System Administrator",
                    icon: <FaUserShield />,
                    badgeClass: "badge-admin",
                    accentColor: "#6366f1"
                };
            case "lecturer":
            case "faculty":
            case "teacher":
                return {
                    label: "Faculty",
                    fullTitle: "Lecturer / Faculty",
                    icon: <FaChalkboardTeacher />,
                    badgeClass: "badge-lecturer",
                    accentColor: "#0ea5e9"
                };
            case "student":
            default:
                return {
                    label: "Student",
                    fullTitle: "Enrolled Student",
                    icon: <FaUserGraduate />,
                    badgeClass: "badge-student",
                    accentColor: "#10b981"
                };
        }
    };

    const roleInfo = getRoleInfo(rawRole);
    const displayName = profile?.name || user?.displayName || (user?.isAnonymous ? "Guest Student" : (user?.email ? user.email.split("@")[0] : "Student"));
    const provider = user?.isAnonymous ? "Guest Access" : user?.providerData?.[0]?.providerId === "google.com" ? "Google Account" : "Email & Password";
    const studentRoll = (profile?.rollNo || (user?.email ? user.email.split("@")[0].toUpperCase() : "N/A")).trim().toUpperCase();

    const initial = displayName ? displayName.charAt(0).toUpperCase() : "U";

    return (
        <main className="st-settings-page">
            {/* 1. Hero Profile Card Banner */}
            <div className="st-profile-hero-card">
                <div className="st-hero-cover-gradient" />
                <div className="st-hero-body">
                    <div className="st-hero-profile-group">
                        <div className="st-avatar-container">
                            {user?.photoURL && !profileImageFailed ? (
                                <img
                                    className="st-hero-avatar-img"
                                    src={user.photoURL}
                                    alt="Profile Avatar"
                                    onError={() => setProfileImageFailed(true)}
                                />
                            ) : (
                                <div className="st-hero-avatar-initial" aria-hidden="true">
                                    {initial}
                                </div>
                            )}
                            <span className="st-avatar-online-badge" title="Active & Verified Account" />
                        </div>

                        <div className="st-hero-info">
                            <div className="st-hero-title-row">
                                <h1 className="st-user-name">{displayName}</h1>
                                <span className={`st-role-pill ${roleInfo.badgeClass}`}>
                                    {roleInfo.icon}
                                    <span>{roleInfo.label}</span>
                                </span>
                            </div>

                            <div className="st-hero-meta-row">
                                <span className="st-meta-item">
                                    <FaEnvelope className="st-meta-icon" />
                                    <span className="st-meta-text">{user?.email || "No email available"}</span>
                                    {user?.email && (
                                        <button
                                            type="button"
                                            className="st-mini-copy"
                                            onClick={() => handleCopy(user.email, "email")}
                                            title="Copy Email"
                                        >
                                            {copiedField === "email" ? <FaCheck className="st-copied" /> : <FaCopy />}
                                        </button>
                                    )}
                                </span>

                                {rawRole === "student" && studentRoll && studentRoll !== "N/A" && (
                                    <span className="st-meta-item st-roll-chip">
                                        <FaIdCard className="st-meta-icon" />
                                        <span>{studentRoll}</span>
                                        <button
                                            type="button"
                                            className="st-mini-copy"
                                            onClick={() => handleCopy(studentRoll, "roll")}
                                            title="Copy Roll Number"
                                        >
                                            {copiedField === "roll" ? <FaCheck className="st-copied" /> : <FaCopy />}
                                        </button>
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="st-hero-quick-kpis">
                        <div className="st-kpi-chip">
                            <span className="st-kpi-label">Account Status</span>
                            <span className="st-kpi-val st-text-success">
                                <FaCheckCircle /> Active &amp; Verified
                            </span>
                        </div>
                        <div className="st-kpi-chip">
                            <span className="st-kpi-label">Role Scope</span>
                            <span className="st-kpi-val">{roleInfo.fullTitle}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* 2. Main Content Grid (Two Balanced Cards) */}
            <div className="st-settings-grid">
                {/* Left Card: Account & Academic Identity */}
                <section className="st-card st-details-card">
                    <div className="st-card-header">
                        <div className="st-card-header-icon blue">
                            <FaIdCard />
                        </div>
                        <div>
                            <h2 className="st-card-title">Account &amp; Identity</h2>
                            <p className="st-card-subtitle">Verified institutional credentials and access details</p>
                        </div>
                    </div>

                    <div className="st-details-list">
                        {/* Account Type */}
                        <div className="st-detail-row">
                            <div className="st-detail-left">
                                <div className="st-detail-icon-wrap">
                                    {roleInfo.icon}
                                </div>
                                <div className="st-detail-info">
                                    <span className="st-detail-title">Account Type</span>
                                    <span className="st-detail-desc">Platform authorization role</span>
                                </div>
                            </div>
                            <div className="st-detail-value">
                                <span className={`st-role-pill ${roleInfo.badgeClass}`}>
                                    {roleInfo.fullTitle}
                                </span>
                            </div>
                        </div>

                        {/* Student Details */}
                        {rawRole === "student" && (
                            <>
                                <div className="st-detail-row">
                                    <div className="st-detail-left">
                                        <div className="st-detail-icon-wrap">
                                            <FaIdCard />
                                        </div>
                                        <div className="st-detail-info">
                                            <span className="st-detail-title">Student Roll No</span>
                                            <span className="st-detail-desc">University identifier</span>
                                        </div>
                                    </div>
                                    <div className="st-detail-value">
                                        <span className="st-code-val">{studentRoll}</span>
                                    </div>
                                </div>

                                <div className="st-detail-row">
                                    <div className="st-detail-left">
                                        <div className="st-detail-icon-wrap">
                                            <FaUniversity />
                                        </div>
                                        <div className="st-detail-info">
                                            <span className="st-detail-title">Branch / Program</span>
                                            <span className="st-detail-desc">Academic department</span>
                                        </div>
                                    </div>
                                    <div className="st-detail-value">
                                        <span className="st-text-bold">{profile?.branch || profile?.department || "General"}</span>
                                    </div>
                                </div>

                                <div className="st-detail-row">
                                    <div className="st-detail-left">
                                        <div className="st-detail-icon-wrap">
                                            <FaLayerGroup />
                                        </div>
                                        <div className="st-detail-info">
                                            <span className="st-detail-title">Semester</span>
                                            <span className="st-detail-desc">Current enrolled term</span>
                                        </div>
                                    </div>
                                    <div className="st-detail-value">
                                        <span className="st-badge-light">
                                            {profile?.semester ? `Semester ${profile.semester}` : "Semester 1"}
                                        </span>
                                    </div>
                                </div>
                            </>
                        )}

                        {/* Lecturer Details */}
                        {(rawRole === "lecturer" || rawRole === "faculty") && (
                            <>
                                <div className="st-detail-row">
                                    <div className="st-detail-left">
                                        <div className="st-detail-icon-wrap">
                                            <FaUniversity />
                                        </div>
                                        <div className="st-detail-info">
                                            <span className="st-detail-title">Department</span>
                                            <span className="st-detail-desc">Faculty unit</span>
                                        </div>
                                    </div>
                                    <div className="st-detail-value">
                                        <span className="st-text-bold">{profile?.department || "Computer Science"}</span>
                                    </div>
                                </div>

                                <div className="st-detail-row">
                                    <div className="st-detail-left">
                                        <div className="st-detail-icon-wrap">
                                            <FaChalkboardTeacher />
                                        </div>
                                        <div className="st-detail-info">
                                            <span className="st-detail-title">Designation</span>
                                            <span className="st-detail-desc">Academic rank</span>
                                        </div>
                                    </div>
                                    <div className="st-detail-value">
                                        <span className="st-text-bold">{profile?.designation || "Faculty Member"}</span>
                                    </div>
                                </div>

                                {profile?.cabin && (
                                    <div className="st-detail-row">
                                        <div className="st-detail-left">
                                            <div className="st-detail-icon-wrap">
                                                <FaClock />
                                            </div>
                                            <div className="st-detail-info">
                                                <span className="st-detail-title">Office / Cabin</span>
                                                <span className="st-detail-desc">Faculty location</span>
                                            </div>
                                        </div>
                                        <div className="st-detail-value">
                                            <span className="st-text-bold">{profile.cabin}</span>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}

                        {/* Admin Details */}
                        {(rawRole === "admin" || rawRole === "administrator" || rawRole === "superadmin") && (
                            <>
                                <div className="st-detail-row">
                                    <div className="st-detail-left">
                                        <div className="st-detail-icon-wrap">
                                            <FaShieldAlt />
                                        </div>
                                        <div className="st-detail-info">
                                            <span className="st-detail-title">Administration Unit</span>
                                            <span className="st-detail-desc">Governance branch</span>
                                        </div>
                                    </div>
                                    <div className="st-detail-value">
                                        <span className="st-text-bold">{profile?.department || "Central Administration"}</span>
                                    </div>
                                </div>

                                <div className="st-detail-row">
                                    <div className="st-detail-left">
                                        <div className="st-detail-icon-wrap">
                                            <FaLock />
                                        </div>
                                        <div className="st-detail-info">
                                            <span className="st-detail-title">Access Scope</span>
                                            <span className="st-detail-desc">System permissions</span>
                                        </div>
                                    </div>
                                    <div className="st-detail-value">
                                        <span className="st-role-pill badge-admin">Master Control</span>
                                    </div>
                                </div>
                            </>
                        )}

                        {/* Auth Provider */}
                        <div className="st-detail-row">
                            <div className="st-detail-left">
                                <div className="st-detail-icon-wrap">
                                    <FaGoogle />
                                </div>
                                <div className="st-detail-info">
                                    <span className="st-detail-title">Authentication Method</span>
                                    <span className="st-detail-desc">Security credential</span>
                                </div>
                            </div>
                            <div className="st-detail-value">
                                <span className="st-text-bold">{provider}</span>
                            </div>
                        </div>
                    </div>

                    {user?.isAnonymous && (
                        <div className="st-guest-connect-box">
                            <button
                                className="st-btn-google-connect"
                                type="button"
                                onClick={handleGoogleLogin}
                                disabled={loginLoading}
                            >
                                <FaGoogle />
                                <span>{loginLoading ? "Connecting..." : "Connect Official Google Account"}</span>
                            </button>
                            {loginError && <p className="st-login-err">{loginError}</p>}
                        </div>
                    )}
                </section>

                {/* Right Card: Appearance & Preferences */}
                <section className="st-card st-appearance-card">
                    <div className="st-card-header">
                        <div className="st-card-header-icon purple">
                            <FaSun />
                        </div>
                        <div>
                            <h2 className="st-card-title">Appearance &amp; Theme</h2>
                            <p className="st-card-subtitle">Choose your preferred workspace aesthetic</p>
                        </div>
                    </div>

                    <div className="st-theme-selector-grid">
                        {/* Light Theme Card */}
                        <div
                            className={`st-theme-tile ${theme === "light" ? "active" : ""}`}
                            onClick={() => setTheme("light")}
                            role="button"
                            tabIndex={0}
                        >
                            <div className="st-theme-preview-box light-preview">
                                <div className="st-prev-header" />
                                <div className="st-prev-body">
                                    <div className="st-prev-side" />
                                    <div className="st-prev-main">
                                        <div className="st-prev-line short" />
                                        <div className="st-prev-line long" />
                                        <div className="st-prev-line med" />
                                    </div>
                                </div>
                            </div>

                            <div className="st-theme-tile-footer">
                                <div className="st-theme-name-group">
                                    <FaSun className="st-theme-icon light-sun" />
                                    <span className="st-theme-title">Light Workspace</span>
                                </div>
                                <span className="st-theme-desc">Crisp, high-contrast daytime interface</span>
                            </div>

                            {theme === "light" && (
                                <div className="st-theme-active-check">
                                    <FaCheckCircle />
                                </div>
                            )}
                        </div>

                        {/* Midnight Theme Card */}
                        <div
                            className={`st-theme-tile ${theme === "midnight" ? "active" : ""}`}
                            onClick={() => setTheme("midnight")}
                            role="button"
                            tabIndex={0}
                        >
                            <div className="st-theme-preview-box dark-preview">
                                <div className="st-prev-header" />
                                <div className="st-prev-body">
                                    <div className="st-prev-side" />
                                    <div className="st-prev-main">
                                        <div className="st-prev-line short" />
                                        <div className="st-prev-line long" />
                                        <div className="st-prev-line med" />
                                    </div>
                                </div>
                            </div>

                            <div className="st-theme-tile-footer">
                                <div className="st-theme-name-group">
                                    <FaMoon className="st-theme-icon dark-moon" />
                                    <span className="st-theme-title">Midnight Workspace</span>
                                </div>
                                <span className="st-theme-desc">Deep slate &amp; obsidian dark mode</span>
                            </div>

                            {theme === "midnight" && (
                                <div className="st-theme-active-check">
                                    <FaCheckCircle />
                                </div>
                            )}
                        </div>
                    </div>

                    {/* System Status Indicators */}
                    <div className="st-system-panel">
                        <div className="st-sys-row">
                            <span className="st-sys-label">
                                <FaDatabase className="st-sys-icon" /> Cloud Database
                            </span>
                            <span className="st-sys-val online">
                                <span className="st-live-dot" /> Firestore Connected
                            </span>
                        </div>
                        <div className="st-sys-row">
                            <span className="st-sys-label">
                                <FaMobileAlt className="st-sys-icon" /> Storage
                            </span>
                            <span className="st-sys-val">Local Persistence Active</span>
                        </div>
                        <div className="st-sys-row">
                            <span className="st-sys-label">
                                <FaShieldAlt className="st-sys-icon" /> Build Version
                            </span>
                            <span className="st-sys-val st-code-sm">v2.4.0 (Release)</span>
                        </div>
                    </div>

                    {/* Logout Action */}
                    <div className="st-settings-actions">
                        <button
                            type="button"
                            className="st-logout-btn"
                            onClick={logoutUser}
                        >
                            <FaSignOutAlt />
                            <span>Sign Out of SmartAttend</span>
                        </button>
                    </div>
                </section>
            </div>
        </main>
    );
}

export default Settings;