import { useEffect, useState } from "react";
import {
    FaGoogle,
    FaUserCircle,
    FaUserShield,
    FaChalkboardTeacher,
    FaUserGraduate,
    FaCheckCircle,
    FaIdCard
} from "react-icons/fa";
import { useAuth } from "../authcontext";
import "./Settings.css";

function Settings() {
    const { user, profile, loginWithGoogle } = useAuth();
    const [theme, setTheme] = useState(() => {
        const savedTheme = localStorage.getItem("smartattend-theme");
        return savedTheme === "midnight" ? "midnight" : "light";
    });
    const [profileImageFailed, setProfileImageFailed] = useState(false);
    const [loginError, setLoginError] = useState("");
    const [loginLoading, setLoginLoading] = useState(false);

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

    const rawRole = (profile?.role || localStorage.getItem("smartattend-user-role") || (user?.isAnonymous ? "guest" : "student")).toLowerCase();

    // Normalized role info
    const getRoleInfo = (r) => {
        switch (r) {
            case "admin":
            case "administrator":
            case "superadmin":
                return {
                    label: "Administrator",
                    fullTitle: "Administrator Account",
                    icon: <FaUserShield />,
                    badgeClass: "role-badge-admin",
                    tag: "Super Admin & Access Control"
                };
            case "lecturer":
            case "faculty":
            case "teacher":
                return {
                    label: "Lecturer / Faculty",
                    fullTitle: "Faculty Account",
                    icon: <FaChalkboardTeacher />,
                    badgeClass: "role-badge-lecturer",
                    tag: "Attendance Host & Analytics"
                };
            case "student":
            default:
                return {
                    label: "Student",
                    fullTitle: "Student Account",
                    icon: <FaUserGraduate />,
                    badgeClass: "role-badge-student",
                    tag: "Attendance & History"
                };
        }
    };

    const roleInfo = getRoleInfo(rawRole);
    const displayName = profile?.name || user?.displayName || (user?.isAnonymous ? "Guest student" : "Profile not set");
    const provider = user?.isAnonymous ? "Guest access" : user?.providerData?.[0]?.providerId === "google.com" ? "Google" : "Authenticated account";
    const studentRoll = profile?.rollNo || (user?.email ? user.email.split("@")[0].toUpperCase() : "N/A");

    return (
        <main className="settings-page">
            <header className="settings-header">
                <p className="settings-eyebrow">ACCOUNT & PREFERENCES</p>
                <h1>Settings</h1>
                <p>Manage your profile, account type, and workspace appearance.</p>
            </header>

            <div className="settings-grid">
                <section className="settings-card">
                    <h2>Profile Details</h2>
                    <p>Information provided by your authenticated account.</p>

                    <div className="profile-summary">
                        {user?.photoURL && !profileImageFailed ? (
                            <img className="profile-avatar" src={user.photoURL} alt="Profile" onError={() => setProfileImageFailed(true)} />
                        ) : (
                            <div className="profile-avatar-fallback" aria-hidden="true"><FaUserCircle /></div>
                        )}
                        <div className="profile-summary-info">
                            <div className="profile-name-row">
                                <h3>{displayName}</h3>
                                <span className={`role-badge ${roleInfo.badgeClass}`}>
                                    {roleInfo.icon}
                                    <span>{roleInfo.label}</span>
                                </span>
                            </div>
                            <p className="profile-email">{user?.email || "No email available"}</p>
                        </div>
                    </div>

                    <dl className="profile-details">
                        <div className="profile-detail">
                            <dt>Account Type / Role</dt>
                            <dd>
                                <span className={`account-type-pill ${roleInfo.badgeClass}`}>
                                    {roleInfo.icon} {roleInfo.fullTitle}
                                </span>
                            </dd>
                        </div>

                        {/* Student-specific details */}
                        {rawRole === "student" && (
                            <>
                                <div className="profile-detail">
                                    <dt>Roll Number</dt>
                                    <dd><strong>{studentRoll}</strong></dd>
                                </div>
                                <div className="profile-detail">
                                    <dt>Branch / Program</dt>
                                    <dd>{profile?.branch || "General"}</dd>
                                </div>
                                <div className="profile-detail">
                                    <dt>Semester</dt>
                                    <dd>{profile?.semester ? `Semester ${profile.semester}` : "Semester 1"}</dd>
                                </div>
                            </>
                        )}

                        {/* Lecturer / Faculty-specific details */}
                        {(rawRole === "lecturer" || rawRole === "faculty") && (
                            <>
                                <div className="profile-detail">
                                    <dt>Department</dt>
                                    <dd>{profile?.department || "General"}</dd>
                                </div>
                                <div className="profile-detail">
                                    <dt>Designation</dt>
                                    <dd>{profile?.designation || "Faculty Member"}</dd>
                                </div>
                                {profile?.cabin && (
                                    <div className="profile-detail">
                                        <dt>Office / Cabin</dt>
                                        <dd>{profile.cabin}</dd>
                                    </div>
                                )}
                            </>
                        )}

                        {/* Admin-specific details */}
                        {(rawRole === "admin" || rawRole === "administrator" || rawRole === "superadmin") && (
                            <>
                                <div className="profile-detail">
                                    <dt>Department</dt>
                                    <dd>{profile?.department || "Administration"}</dd>
                                </div>
                                <div className="profile-detail">
                                    <dt>Designation</dt>
                                    <dd>{profile?.designation || "System Administrator"}</dd>
                                </div>
                                <div className="profile-detail">
                                    <dt>Security Scope</dt>
                                    <dd>Full Administrative Access</dd>
                                </div>
                            </>
                        )}

                        <div className="profile-detail">
                            <dt>Sign-in method</dt>
                            <dd>{provider}</dd>
                        </div>
                        <div className="profile-detail">
                            <dt>Account Status</dt>
                            <dd className="account-status-active">
                                <FaCheckCircle /> Active &amp; Verified
                            </dd>
                        </div>
                    </dl>

                    {user?.isAnonymous && (
                        <div className="guest-login">
                            <button className="settings-login-button" type="button" onClick={handleGoogleLogin} disabled={loginLoading}>
                                <FaGoogle aria-hidden="true" />
                                <span>{loginLoading ? "Signing in..." : "Sign in with Google"}</span>
                            </button>
                            {loginError && <p className="settings-login-error" role="alert">{loginError}</p>}
                        </div>
                    )}
                </section>

                <section className="settings-card">
                    <h2>Appearance</h2>
                    <p>Choose a workspace theme for this device.</p>
                    <div className="theme-options" role="radiogroup" aria-label="Workspace theme">
                        <div className="theme-option">
                            <input id="theme-light" type="radio" name="theme" value="light" checked={theme === "light"} onChange={() => setTheme("light")} />
                            <label htmlFor="theme-light">Light workspace</label>
                        </div>
                        <div className="theme-option">
                            <input id="theme-midnight" type="radio" name="theme" value="midnight" checked={theme === "midnight"} onChange={() => setTheme("midnight")} />
                            <label htmlFor="theme-midnight">Midnight workspace</label>
                        </div>
                    </div>
                    <p className="theme-note">Your preference is saved on this device.</p>
                </section>
            </div>
        </main>
    );
}

export default Settings;