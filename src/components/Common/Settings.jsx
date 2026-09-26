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
    FaLock,
    FaEdit,
    FaSpinner,
    FaTimes,
    FaCamera,
    FaTrashAlt
} from "react-icons/fa";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../authcontext";
import ProfilePhotoModal from "./ProfilePhotoModal";
import "./Settings.css";

function Settings() {
    const {
        user,
        profile,
        loginWithGoogle,
        logoutUser,
        updateProfileName,
        updateProfileSemester,
        updateProfilePhoto,
        deleteProfilePhoto
    } = useAuth();
    const [theme, setTheme] = useState(() => {
        const savedTheme = localStorage.getItem("smartattend-theme");
        return savedTheme === "midnight" ? "midnight" : "light";
    });
    const [profileImageFailed, setProfileImageFailed] = useState(false);
    const [showPhotoModal, setShowPhotoModal] = useState(false);
    const [loginError, setLoginError] = useState("");
    const [loginLoading, setLoginLoading] = useState(false);
    const [copiedField, setCopiedField] = useState("");

    // Photo Uploading & Deletion State
    const [photoUploading, setPhotoUploading] = useState(false);
    const [photoDeleting, setPhotoDeleting] = useState(false);
    const [photoMsg, setPhotoMsg] = useState("");
    const [photoError, setPhotoError] = useState("");

    // Name Editing State
    const [isEditingName, setIsEditingName] = useState(false);
    const [showEditNameModal, setShowEditNameModal] = useState(false);
    const [nameInput, setNameInput] = useState("");
    const [savingName, setSavingName] = useState(false);
    const [nameSuccess, setNameSuccess] = useState("");
    const [nameError, setNameError] = useState("");

    // Semester Live Sync & Editing State
    const [fetchedStudentData, setFetchedStudentData] = useState(null);
    const [showEditSemesterModal, setShowEditSemesterModal] = useState(false);
    const [semesterInput, setSemesterInput] = useState("1");
    const [savingSemester, setSavingSemester] = useState(false);
    const [semesterSuccess, setSemesterSuccess] = useState("");
    const [semesterError, setSemesterError] = useState("");

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

    const handlePhotoUpload = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            setPhotoError("Please select a valid image file (JPEG, PNG, WEBP).");
            setTimeout(() => setPhotoError(""), 3500);
            return;
        }

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                setPhotoUploading(true);
                setPhotoError("");
                setPhotoMsg("");

                const img = new Image();
                img.src = event.target.result;
                img.onload = async () => {
                    const canvas = document.createElement("canvas");
                    const MAX_DIM = 400;
                    let width = img.width;
                    let height = img.height;
                    if (width > height) {
                        if (width > MAX_DIM) {
                            height = Math.round((height * MAX_DIM) / width);
                            width = MAX_DIM;
                        }
                    } else {
                        if (height > MAX_DIM) {
                            width = Math.round((width * MAX_DIM) / height);
                            height = MAX_DIM;
                        }
                    }
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(img, 0, 0, width, height);
                    const compressedDataUrl = canvas.toDataURL("image/jpeg", 0.85);

                    await updateProfilePhoto(compressedDataUrl);
                    setProfileImageFailed(false);
                    setPhotoMsg("Profile photo updated successfully!");
                    setTimeout(() => setPhotoMsg(""), 3500);
                };
            } catch (err) {
                console.error("Error updating profile photo:", err);
                setPhotoError(err.message || "Failed to upload profile photo");
                setTimeout(() => setPhotoError(""), 3500);
            } finally {
                setPhotoUploading(false);
            }
        };
        reader.readAsDataURL(file);
    };

    const handlePhotoDelete = async () => {
        const confirm = window.confirm("Are you sure you want to remove your profile photo?");
        if (!confirm) return;

        try {
            setPhotoDeleting(true);
            setPhotoError("");
            setPhotoMsg("");
            await deleteProfilePhoto();
            setProfileImageFailed(false);
            setPhotoMsg("Profile photo removed!");
            setTimeout(() => setPhotoMsg(""), 3500);
        } catch (err) {
            console.error("Error deleting profile photo:", err);
            setPhotoError(err.message || "Failed to remove photo");
            setTimeout(() => setPhotoError(""), 3500);
        } finally {
            setPhotoDeleting(false);
        }
    };

    const handleSaveName = async (e) => {
        e?.preventDefault();
        if (!nameInput.trim()) return;
        try {
            setSavingName(true);
            setNameError("");
            setNameSuccess("");
            await updateProfileName(nameInput.trim());
            setNameSuccess("Name updated and saved to database!");
            setIsEditingName(false);
            setTimeout(() => setNameSuccess(""), 3500);
        } catch (err) {
            setNameError(err.message || "Failed to update name");
        } finally {
            setSavingName(false);
        }
    };

    const handleSaveSemester = async (e) => {
        e?.preventDefault();
        if (!semesterInput) return;
        try {
            setSavingSemester(true);
            setSemesterError("");
            setSemesterSuccess("");
            await updateProfileSemester(semesterInput);
            setSemesterSuccess(`Enrolled semester updated to Semester ${semesterInput}!`);
            setShowEditSemesterModal(false);
            setTimeout(() => setSemesterSuccess(""), 3500);
        } catch (err) {
            setSemesterError(err.message || "Failed to update semester");
        } finally {
            setSavingSemester(false);
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

    // Real-time Firestore sync for student account details (Semester, Branch, Name)
    useEffect(() => {
        if (rawRole !== "student" || !studentRoll || studentRoll === "N/A") return;
        const cleanEmail = (user?.email || "").toLowerCase().trim();
        const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase().trim() : studentRoll.toLowerCase().trim();

        const unsubs = [];

        const handleDocUpdate = (snap) => {
            if (snap.exists()) {
                const d = snap.data();
                setFetchedStudentData((prev) => ({
                    ...(prev || {}),
                    ...d,
                    branch: (d.branch && String(d.branch).toLowerCase() !== "general") ? d.branch : (prev?.branch || d.department || "CSE"),
                    semester: (d.semester !== undefined && d.semester !== null && String(d.semester).trim() !== "") ? String(d.semester).trim() : (prev?.semester || "1")
                }));
            }
        };

        if (studentRoll) {
            unsubs.push(onSnapshot(doc(db, "students", studentRoll), handleDocUpdate, (e) => console.warn("student doc snap error:", e)));
            unsubs.push(onSnapshot(doc(db, "users", studentRoll), handleDocUpdate, (e) => console.warn("users roll snap error:", e)));
        }
        if (prefix && prefix !== studentRoll.toLowerCase()) {
            unsubs.push(onSnapshot(doc(db, "students", prefix), handleDocUpdate, (e) => console.warn("student prefix snap error:", e)));
        }
        if (cleanEmail) {
            unsubs.push(onSnapshot(doc(db, "authorizedUsers", cleanEmail), handleDocUpdate, (e) => console.warn("auth snap error:", e)));
        }

        return () => {
            unsubs.forEach((u) => u && u());
        };
    }, [rawRole, studentRoll, user?.email]);

    // Authoritative semester & branch resolution
    const studentSemester = (fetchedStudentData?.semester !== undefined && fetchedStudentData?.semester !== null && String(fetchedStudentData?.semester).trim() !== "")
        ? String(fetchedStudentData.semester).trim()
        : (profile?.semester ? String(profile.semester).trim() : "1");

    const rawDept = fetchedStudentData?.branch || profile?.branch || fetchedStudentData?.department || profile?.department;
    const studentBranch = (rawDept && String(rawDept).toLowerCase() !== "general") ? rawDept : "CSE";

    const currentPhoto = profile?.photoURL || profile?.photo || profile?.image || user?.photoURL;
    const hasPhoto = Boolean(currentPhoto && !profileImageFailed);
    const initial = displayName ? displayName.charAt(0).toUpperCase() : "U";

    return (
        <main className="st-settings-page">
            {/* 1. Hero Profile Card Banner */}
            <div className="st-profile-hero-card">
                <div className="st-hero-cover-gradient" />
                <div className="st-hero-body">
                    <div className="st-hero-profile-group">
                        <div
                            className="st-avatar-container"
                            onClick={() => setShowPhotoModal(true)}
                            title="Click to view full-size profile photo"
                            style={{ cursor: "pointer" }}
                        >
                            {hasPhoto ? (
                                <img
                                    className="st-hero-avatar-img"
                                    src={currentPhoto}
                                    alt="Profile Avatar"
                                    onError={() => setProfileImageFailed(true)}
                                />
                            ) : (
                                <div className="st-hero-avatar-initial" aria-hidden="true">
                                    {initial}
                                </div>
                            )}
                            <span className="st-avatar-online-badge" title="Active & Verified Account" />

                            {/* Profile Photo Action Overlay */}
                            <div className="st-avatar-actions-overlay" onClick={(e) => e.stopPropagation()}>
                                <label className="st-avatar-btn st-avatar-upload-btn" title="Change Profile Photo">
                                    {photoUploading ? <FaSpinner className="st-spin-icon" /> : <FaCamera />}
                                    <input
                                        type="file"
                                        accept="image/*"
                                        onChange={handlePhotoUpload}
                                        disabled={photoUploading || photoDeleting}
                                        style={{ display: "none" }}
                                    />
                                </label>
                                {hasPhoto && (
                                    <button
                                        type="button"
                                        className="st-avatar-btn st-avatar-delete-btn"
                                        title="Remove Profile Photo"
                                        onClick={handlePhotoDelete}
                                        disabled={photoUploading || photoDeleting}
                                    >
                                        {photoDeleting ? <FaSpinner className="st-spin-icon" /> : <FaTrashAlt />}
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="st-hero-info">
                            <div className="st-hero-title-row">
                                <div className="st-name-display-wrap">
                                    <h1 className="st-user-name">{displayName}</h1>
                                    <button
                                        type="button"
                                        className="st-edit-name-btn"
                                        onClick={() => {
                                            setNameInput(displayName);
                                            setShowEditNameModal(true);
                                        }}
                                        title="Edit your display name"
                                    >
                                        <FaEdit /> <span>Edit Name</span>
                                    </button>
                                </div>
                                <span className={`st-role-pill ${roleInfo.badgeClass}`}>
                                    {roleInfo.icon}
                                    <span>{roleInfo.label}</span>
                                </span>
                            </div>

                            {nameSuccess && (
                                <div className="st-name-toast-msg success">
                                    <FaCheck /> {nameSuccess}
                                </div>
                            )}
                            {nameError && (
                                <div className="st-name-toast-msg error">
                                    <FaTimes /> {nameError}
                                </div>
                            )}
                            {semesterSuccess && (
                                <div className="st-name-toast-msg success">
                                    <FaCheck /> {semesterSuccess}
                                </div>
                            )}
                            {semesterError && (
                                <div className="st-name-toast-msg error">
                                    <FaTimes /> {semesterError}
                                </div>
                            )}
                            {photoMsg && (
                                <div className="st-name-toast-msg success">
                                    <FaCheck /> {photoMsg}
                                </div>
                            )}
                            {photoError && (
                                <div className="st-name-toast-msg error">
                                    <FaTimes /> {photoError}
                                </div>
                            )}

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

                        {/* Full Name / Display Name */}
                        <div className="st-detail-row">
                            <div className="st-detail-left">
                                <div className="st-detail-icon-wrap">
                                    <FaUserCircle />
                                </div>
                                <div className="st-detail-info">
                                    <span className="st-detail-title">Full Name</span>
                                    <span className="st-detail-desc">Registered display name</span>
                                </div>
                            </div>
                            <div className="st-detail-value" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                <span className="st-text-bold">{displayName}</span>
                                <button
                                    type="button"
                                    className="st-btn-mini-edit"
                                    onClick={() => {
                                        setNameInput(displayName);
                                        setShowEditNameModal(true);
                                    }}
                                    title="Edit Full Name"
                                >
                                    <FaEdit /> Edit
                                </button>
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
                                        <span className="st-text-bold">{studentBranch}</span>
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
                                    <div className="st-detail-value" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                        <span className="st-badge-light">
                                            Semester {studentSemester}
                                        </span>
                                        <button
                                            type="button"
                                            className="st-btn-mini-edit"
                                            onClick={() => {
                                                setSemesterInput(studentSemester);
                                                setShowEditSemesterModal(true);
                                            }}
                                            title="Edit Enrolled Semester"
                                        >
                                            <FaEdit /> Edit
                                        </button>
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

            {/* Dedicated Edit Name Modal */}
            {showEditNameModal && (
                <div className="modal-backdrop" onClick={() => setShowEditNameModal(false)} style={{
                    position: "fixed",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: "rgba(15, 23, 42, 0.75)",
                    backdropFilter: "blur(6px)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: 9999,
                    padding: "20px"
                }}>
                    <div className="student-modal-container st-name-modal-box" onClick={(e) => e.stopPropagation()} style={{
                        background: "var(--surface, #ffffff)",
                        borderRadius: "20px",
                        maxWidth: "480px",
                        width: "100%",
                        padding: "28px 24px",
                        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                        position: "relative",
                        border: "1px solid var(--border, #e2e8f0)"
                    }}>
                        <button
                            type="button"
                            onClick={() => setShowEditNameModal(false)}
                            style={{
                                position: "absolute",
                                top: "18px",
                                right: "18px",
                                background: "var(--surface-soft, #f1f5f9)",
                                border: "none",
                                borderRadius: "50%",
                                width: "36px",
                                height: "36px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "1.1rem",
                                cursor: "pointer",
                                color: "var(--text-muted, #64748b)"
                            }}
                        >
                            ✕
                        </button>

                        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "6px 14px", borderRadius: "20px", background: "rgba(99, 102, 241, 0.1)", color: "#6366f1", fontWeight: 700, fontSize: "0.85rem", marginBottom: "12px" }}>
                            <FaEdit /> Profile Management
                        </div>

                        <h2 style={{ margin: "0 0 6px", fontSize: "1.35rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                            Edit Account Name
                        </h2>
                        <p style={{ margin: "0 0 20px", fontSize: "0.88rem", color: "var(--text-muted, #64748b)", lineHeight: 1.5 }}>
                            Update your official display name. This will be updated across all attendance records, class rosters, and system tables.
                        </p>

                        <form onSubmit={handleSaveName}>
                            <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main, #334155)", marginBottom: "6px" }}>
                                Full Name
                            </label>
                            <input
                                type="text"
                                value={nameInput}
                                onChange={(e) => setNameInput(e.target.value)}
                                placeholder="Enter your full name"
                                autoFocus
                                required
                                disabled={savingName}
                                style={{
                                    width: "100%",
                                    padding: "12px 14px",
                                    borderRadius: "12px",
                                    border: "2px solid #6366f1",
                                    fontSize: "1.05rem",
                                    fontWeight: 600,
                                    outline: "none",
                                    boxSizing: "border-box",
                                    background: "var(--surface, #ffffff)",
                                    color: "var(--text-main, #0f172a)",
                                    marginBottom: "14px"
                                }}
                            />

                            {nameError && (
                                <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: "10px", fontSize: "0.85rem", fontWeight: 600, marginBottom: "14px" }}>
                                    ⚠️ {nameError}
                                </div>
                            )}

                            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                                <button
                                    type="button"
                                    onClick={() => { setShowEditNameModal(false); setNameError(""); }}
                                    disabled={savingName}
                                    style={{
                                        padding: "10px 18px",
                                        borderRadius: "10px",
                                        background: "var(--surface-soft, #f1f5f9)",
                                        color: "var(--text-muted, #64748b)",
                                        border: "1px solid var(--border, #cbd5e1)",
                                        fontWeight: 700,
                                        fontSize: "0.9rem",
                                        cursor: "pointer"
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={savingName || !nameInput.trim()}
                                    style={{
                                        padding: "10px 22px",
                                        borderRadius: "10px",
                                        background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                                        color: "#ffffff",
                                        border: "none",
                                        fontWeight: 700,
                                        fontSize: "0.9rem",
                                        cursor: "pointer",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "8px",
                                        boxShadow: "0 4px 14px rgba(99, 102, 241, 0.3)"
                                    }}
                                >
                                    {savingName ? <FaSpinner className="fa-spin" /> : <><FaCheck /> Save Name</>}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Edit Semester Modal */}
            {showEditSemesterModal && (
                <div className="st-custom-modal-overlay" onClick={() => { if (!savingSemester) setShowEditSemesterModal(false); }}>
                    <div
                        className="st-custom-modal-content"
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            maxWidth: "460px",
                            width: "92%",
                            padding: "2rem",
                            borderRadius: "20px",
                            background: "var(--surface, #ffffff)",
                            boxShadow: "0 25px 60px rgba(0, 0, 0, 0.35)",
                            border: "1px solid var(--border, #e2e8f0)",
                            position: "relative"
                        }}
                    >
                        <button
                            type="button"
                            onClick={() => { setShowEditSemesterModal(false); setSemesterError(""); }}
                            style={{
                                position: "absolute",
                                top: "16px",
                                right: "16px",
                                background: "var(--surface-soft, #f1f5f9)",
                                border: "none",
                                width: "32px",
                                height: "32px",
                                borderRadius: "50%",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                cursor: "pointer",
                                color: "var(--text-muted, #64748b)"
                            }}
                        >
                            <FaTimes />
                        </button>

                        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "6px 14px", borderRadius: "20px", background: "rgba(16, 185, 129, 0.1)", color: "#10b981", fontWeight: 700, fontSize: "0.85rem", marginBottom: "12px" }}>
                            <FaLayerGroup /> Academic Details
                        </div>

                        <h2 style={{ margin: "0 0 6px", fontSize: "1.35rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                            Update Enrolled Semester
                        </h2>
                        <p style={{ margin: "0 0 20px", fontSize: "0.88rem", color: "var(--text-muted, #64748b)", lineHeight: 1.5 }}>
                            Select your current semester. This updates your attendance courses, eligible sessions, and academic records across the platform.
                        </p>

                        <form onSubmit={handleSaveSemester}>
                            <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main, #334155)", marginBottom: "8px" }}>
                                Select Semester
                            </label>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px", marginBottom: "16px" }}>
                                {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => {
                                    const isSelected = String(semesterInput) === String(s);
                                    return (
                                        <button
                                            key={s}
                                            type="button"
                                            onClick={() => setSemesterInput(String(s))}
                                            disabled={savingSemester}
                                            style={{
                                                padding: "12px 6px",
                                                borderRadius: "10px",
                                                border: isSelected ? "2px solid #10b981" : "1.5px solid var(--border, #e2e8f0)",
                                                background: isSelected ? "rgba(16, 185, 129, 0.12)" : "var(--surface-soft, #f8fafc)",
                                                color: isSelected ? "#059669" : "var(--text-main, #1e293b)",
                                                fontWeight: isSelected ? 800 : 600,
                                                fontSize: "0.95rem",
                                                cursor: "pointer",
                                                transition: "all 0.15s ease",
                                                textAlign: "center"
                                            }}
                                        >
                                            Sem {s}
                                        </button>
                                    );
                                })}
                            </div>

                            {semesterError && (
                                <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: "10px", fontSize: "0.85rem", fontWeight: 600, marginBottom: "14px" }}>
                                    ⚠️ {semesterError}
                                </div>
                            )}

                            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                                <button
                                    type="button"
                                    onClick={() => { setShowEditSemesterModal(false); setSemesterError(""); }}
                                    disabled={savingSemester}
                                    style={{
                                        padding: "10px 18px",
                                        borderRadius: "10px",
                                        background: "var(--surface-soft, #f1f5f9)",
                                        color: "var(--text-muted, #64748b)",
                                        border: "1px solid var(--border, #cbd5e1)",
                                        fontWeight: 700,
                                        fontSize: "0.9rem",
                                        cursor: "pointer"
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={savingSemester || !semesterInput}
                                    style={{
                                        padding: "10px 22px",
                                        borderRadius: "10px",
                                        background: "linear-gradient(135deg, #10b981, #059669)",
                                        color: "#ffffff",
                                        border: "none",
                                        fontWeight: 700,
                                        fontSize: "0.9rem",
                                        cursor: "pointer",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "8px",
                                        boxShadow: "0 4px 14px rgba(16, 185, 129, 0.3)"
                                    }}
                                >
                                    {savingSemester ? <FaSpinner className="fa-spin" /> : <><FaCheck /> Save Semester</>}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* WhatsApp / Instagram Style Full Screen Profile Photo Viewer */}
            <ProfilePhotoModal
                isOpen={showPhotoModal}
                onClose={() => setShowPhotoModal(false)}
                photoSrc={currentPhoto}
                name={displayName}
                role={rawRole}
                subtext={studentRoll && studentRoll !== "N/A" ? studentRoll : (user?.email || "")}
                canEdit={true}
                onUpload={handlePhotoUpload}
                onDelete={handlePhotoDelete}
                uploading={photoUploading}
                deleting={photoDeleting}
            />
        </main>
    );
}

export default Settings;