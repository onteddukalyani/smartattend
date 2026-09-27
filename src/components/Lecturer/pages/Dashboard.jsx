import "./Dashboard.css";
import { useEffect, useState } from "react";
import { FaUser, FaCamera, FaTrashAlt, FaSpinner, FaCheck, FaTimes, FaChalkboardTeacher, FaUniversity, FaEnvelope, FaExclamationTriangle, FaShieldAlt, FaAndroid, FaDownload } from "react-icons/fa";
import { SiGoogleclassroom } from "react-icons/si";
import { IoQrCodeOutline, IoAddCircleOutline } from "react-icons/io5";
import { GoPeople } from "react-icons/go";
import { LuClipboardList } from "react-icons/lu";
import { SlCalender } from "react-icons/sl";
import { Link } from "react-router-dom";
import { collection, getDocs, onSnapshot } from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import ProfilePhotoModal from "../../Common/ProfilePhotoModal";
import ViolationReviewModal from "../../Common/ViolationReviewModal";
import { normalizeBranchName } from "../../../utils/studentDataHelper";
import { getApkDownloadUrl } from "../../../utils/apkUrl";

function Dashboard() {
    const { user, profile, updateProfilePhoto, deleteProfilePhoto } = useAuth();
    const [recentSessions, setRecentSessions] = useState([]);
    const [flaggedViolations, setFlaggedViolations] = useState([]);
    const [selectedViolation, setSelectedViolation] = useState(null);
    const [counts, setCounts] = useState({
        sessions: 0,
        activeSessions: 0,
        students: 0,
        attendanceToday: 0,
        violations: 0
    });

    const [imageFailed, setImageFailed] = useState(false);
    const [showPhotoModal, setShowPhotoModal] = useState(false);
    const [photoUploading, setPhotoUploading] = useState(false);
    const [photoDeleting, setPhotoDeleting] = useState(false);
    const [photoMsg, setPhotoMsg] = useState("");
    const [photoError, setPhotoError] = useState("");

    const lecturerName = profile?.name || user?.displayName || (user?.email ? user.email.split("@")[0] : "Faculty Member");
    const avatarSrc = profile?.photoURL || profile?.image || profile?.photo || user?.photoURL || user?.photoUrl || user?.providerData?.[0]?.photoURL;
    const hasPhoto = Boolean(avatarSrc && !imageFailed);

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
                    setImageFailed(false);
                    setPhotoMsg("Profile photo updated successfully!");
                    setTimeout(() => setPhotoMsg(""), 3500);
                };
            } catch (err) {
                console.error("Error updating lecturer photo:", err);
                setPhotoError(err.message || "Failed to update profile photo");
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
            setImageFailed(false);
            setPhotoMsg("Profile photo removed!");
            setTimeout(() => setPhotoMsg(""), 3500);
        } catch (err) {
            console.error("Error deleting lecturer photo:", err);
            setPhotoError(err.message || "Failed to remove photo");
            setTimeout(() => setPhotoError(""), 3500);
        } finally {
            setPhotoDeleting(false);
        }
    };

    useEffect(() => {
        if (!user) return;

        const userEmail = (user?.email || "").toLowerCase().trim();
        const userPrefix = userEmail ? userEmail.split("@")[0] : "";
        const userUid = user?.uid || "";
        const isAdmin = profile?.role === "admin" || profile?.role === "administrator" || profile?.role === "superadmin";

        const isMySession = (data) => {
            if (isAdmin) return true;
            const ownerId = String(data.ownerId || "").toLowerCase().trim();
            const ownerEmail = String(data.ownerEmail || data.lecturerEmail || "").toLowerCase().trim();
            if (userUid && (ownerId === userUid.toLowerCase() || ownerEmail === userUid.toLowerCase())) return true;
            if (userEmail && (ownerEmail === userEmail || ownerId === userEmail)) return true;
            if (userPrefix && userPrefix.length >= 3 && (ownerId === userPrefix || ownerEmail === `${userPrefix}@iiitdwd.ac.in` || ownerEmail === `${userPrefix}@gmail.com`)) return true;
            return false;
        };

        let sessionsDocs = [];
        let recordsDocs = [];
        let registeredStudentsCount = 0;

        const recomputeLecturerDashboard = () => {
            try {
                const mySessions = sessionsDocs
                    .map((sessionDoc) => ({
                        id: sessionDoc.id,
                        ...(typeof sessionDoc.data === "function" ? sessionDoc.data() : sessionDoc)
                    }))
                    .filter((s) => isMySession(s))
                    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

                setRecentSessions(mySessions.slice(0, 3));
                const now = Date.now();
                const startOfToday = new Date();
                startOfToday.setHours(0, 0, 0, 0);
                const startOfTodayMs = startOfToday.getTime();

                const studentRollNumbers = new Set();
                let attendanceToday = 0;
                let violationsCount = 0;
                const violationsList = [];

                const mySessionIds = new Set(mySessions.map((s) => s.id));

                recordsDocs.forEach((recordDoc) => {
                    const record = typeof recordDoc.data === "function" ? recordDoc.data() : recordDoc;
                    if (isMySession(record) || mySessionIds.has(record.sessionId)) {
                        if (record.rollNo) {
                            studentRollNumbers.add(String(record.rollNo).toUpperCase().trim());
                        }
                        if ((record.submittedAt || 0) >= startOfTodayMs) {
                            attendanceToday += 1;
                        }
                        if (record.status === "FLAGGED" || record.status === "VIOLATION" || record.hasViolation || record.violationReason) {
                            violationsCount += 1;
                            violationsList.push({ id: recordDoc.id, ...record });
                        }
                    }
                });

                setFlaggedViolations(violationsList);
                setCounts({
                    sessions: mySessions.length,
                    activeSessions: mySessions.filter((s) => s.active !== false && (s.expiresAt || 0) > now).length,
                    students: registeredStudentsCount,
                    attendanceToday,
                    violations: violationsCount
                });
            } catch (err) {
                console.error("Error computing lecturer dashboard counts:", err);
            }
        };

        const unsubSessions = onSnapshot(collection(db, "attendance_sessions"), (snap) => {
            sessionsDocs = snap.docs;
            recomputeLecturerDashboard();
        }, (e) => console.warn("sessions snapshot error:", e));

        const unsubRecords = onSnapshot(collection(db, "attendance_records"), (snap) => {
            recordsDocs = snap.docs;
            recomputeLecturerDashboard();
        }, (e) => console.warn("records snapshot error:", e));

        const unsubStudents = onSnapshot(collection(db, "students"), (snap) => {
            const uniqueStudentIds = new Set();
            snap.docs.forEach((studentDoc) => {
                const student = studentDoc.data();
                const rawId = student.rollNo || student.rollNumber || student.email || studentDoc.id;
                const studentId = String(rawId).split("@")[0].toUpperCase().trim();
                if (studentId) uniqueStudentIds.add(studentId);
            });
            registeredStudentsCount = uniqueStudentIds.size;
            recomputeLecturerDashboard();
        }, (e) => console.warn("students snapshot error:", e));

        return () => {
            unsubSessions();
            unsubRecords();
            unsubStudents();
        };
    }, [user, profile]);

    const formattedToday = new Date().toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

    const dashcards = [
        {
            icon: <IoAddCircleOutline />,
            name: "Take Attendance",
            value: "Start",
            path: "/lecturer/lecturerpage",
            description: "New QR & Location Session"
        },
        {
            icon: <SiGoogleclassroom />,
            name: "Classes",
            value: counts.sessions,
            path: "/lecturer/attendance-sessions",
            description: "Total created classes",
            themeClass: "card-theme-indigo"
        },
        {
            icon: <IoQrCodeOutline />,
            name: "Active Sessions",
            value: counts.activeSessions,
            path: "/lecturer/active-sessions",
            description: counts.activeSessions > 0 ? "Live right now" : "No active session",
            isLive: counts.activeSessions > 0,
            themeClass: "card-theme-cyan"
        },
        {
            icon: <GoPeople />,
            name: "Total Students",
            value: counts.students,
            path: "/lecturer/students",
            description: "Registered learners",
            themeClass: "card-theme-emerald"
        },
        {
            icon: <LuClipboardList />,
            name: "Attendance Today",
            value: counts.attendanceToday,
            path: "/lecturer/attendance-data",
            description: "Submissions today",
            themeClass: "card-theme-amber"
        },
        {
            icon: <FaExclamationTriangle />,
            name: "Violations",
            value: counts.violations,
            path: "/lecturer/violations",
            description: counts.violations > 0 ? "App switch alerts!" : "No flagged violations",
            alert: counts.violations > 0,
            themeClass: "card-theme-rose"
        }
    ];

    return (
        <div className="dashboard-page">
            {/* 1. Lecturer Profile Hero Banner */}
            <div className="lecturer-hero-banner">
                <div className="lecturer-hero-main">
                    <div style={{ display: "flex", alignItems: "center", gap: "22px", flex: 1, minWidth: "280px" }}>
                        <div className="lecturer-hero-avatar-wrap">
                            <div
                                className="lecturer-hero-avatar"
                                onClick={() => setShowPhotoModal(true)}
                                title="Click to view full-size profile photo"
                            >
                                {hasPhoto ? (
                                    <img
                                        src={avatarSrc}
                                        referrerPolicy="no-referrer"
                                        alt={lecturerName || "Lecturer"}
                                        onError={() => setImageFailed(true)}
                                        className="lecturer-avatar-img"
                                    />
                                ) : (
                                    <div className="lecturer-avatar-placeholder">
                                        {lecturerName ? lecturerName.charAt(0).toUpperCase() : <FaUser />}
                                    </div>
                                )}
                            </div>

                            {/* Profile Photo Quick Action Buttons */}
                            <div className="avatar-quick-actions" onClick={(e) => e.stopPropagation()}>
                                {hasPhoto && (
                                    <button
                                        type="button"
                                        title="Delete Profile Photo"
                                        onClick={handlePhotoDelete}
                                        disabled={photoDeleting || photoUploading}
                                        className="avatar-btn avatar-btn-delete"
                                    >
                                        {photoDeleting ? <FaSpinner className="fa-spin" /> : <FaTrashAlt />}
                                    </button>
                                )}

                                <label
                                    title="Upload / Change Profile Photo"
                                    className="avatar-btn avatar-btn-upload"
                                >
                                    {photoUploading ? <FaSpinner className="fa-spin" /> : <FaCamera />}
                                    <input
                                        type="file"
                                        accept="image/*"
                                        onChange={handlePhotoUpload}
                                        disabled={photoUploading || photoDeleting}
                                        style={{ display: "none" }}
                                    />
                                </label>
                            </div>
                        </div>

                        <div className="lecturer-hero-info">
                            <div className="lecturer-hero-title-row">
                                <h1 className="lecturer-hero-title">Welcome, {lecturerName} 👋</h1>
                            </div>
                            {photoMsg && (
                                <div className="photo-msg-banner photo-msg-success">
                                    <FaCheck /> {photoMsg}
                                </div>
                            )}
                            {photoError && (
                                <div className="photo-msg-banner photo-msg-error">
                                    <FaTimes /> {photoError}
                                </div>
                            )}
                            <div className="lecturer-hero-badges">
                                <span className="lecturer-badge pill-faculty">
                                    <FaChalkboardTeacher /> Faculty Member
                                </span>
                                <span className="lecturer-badge pill-dept">
                                    <FaUniversity /> {normalizeBranchName(profile?.department || "CSE")}
                                </span>
                                <span className="lecturer-badge pill-email">
                                    <FaEnvelope /> {user?.email || "Faculty Account"}
                                </span>
                                <a
                                    href={getApkDownloadUrl()}
                                    download="SmartAttend-release.apk"
                                    className="lecturer-badge pill-apk"
                                    title="Download signed SmartAttend Android APK for testing"
                                >
                                    <FaAndroid /> Download APK (.apk) <FaDownload size={10} />
                                </a>
                            </div>
                        </div>
                    </div>

                    {/* Quick CTA Widget */}
                    <div className="lecturer-hero-quick-widget">
                        <span className="hero-widget-date">
                            <SlCalender /> {formattedToday}
                        </span>
                        <Link to="/lecturer/lecturerpage" className="hero-quick-btn">
                            <IoAddCircleOutline size={20} /> Take Attendance
                        </Link>
                    </div>
                </div>
            </div>

            {/* 2. KPI Cards Grid */}
            <div className="dash-cards">
                {dashcards.map((item, index) => (
                    <Link
                        key={index}
                        to={item.path}
                        className={`dash-link dash-card ${item.themeClass || ""} ${item.alert ? "alert-card" : ""}`}
                    >
                        <div className="dash-card-top">
                            <span className="dash-icons">{item.icon}</span>
                            {item.isLive && (
                                <span className="live-pulse-badge">
                                    <span className="live-pulse-dot"></span> LIVE NOW
                                </span>
                            )}
                            {item.alert && (
                                <span className="alert-pulse-badge">
                                    ALERT
                                </span>
                            )}
                        </div>
                        <div className="card-details">
                            <p className="card-name">{item.name}</p>
                            <p className="card-value">{item.value}</p>
                            <p className="card-sub">{item.description}</p>
                        </div>
                    </Link>
                ))}
            </div>

            {/* 3. Flagged Violations Audit Card Section */}
            {flaggedViolations.length > 0 && (
                <div className="flagged-audit-banner">
                    <div className="flagged-audit-header">
                        <div className="flagged-audit-title">
                            <FaExclamationTriangle className="flagged-audit-icon" />
                            <div>
                                <h2>Flagged Anti-Proxy Violations ({flaggedViolations.length})</h2>
                                <p>Students flagged for app switching during active attendance</p>
                            </div>
                        </div>
                        <Link to="/lecturer/violations" className="flagged-audit-link">
                            View All Violations &rarr;
                        </Link>
                    </div>
                    <div className="flagged-audit-grid">
                        {flaggedViolations.slice(0, 4).map((viol) => (
                            <div
                                key={viol.id}
                                onClick={() => setSelectedViolation(viol)}
                                className="flagged-audit-item"
                            >
                                <div className="flagged-item-info">
                                    <strong className="flagged-roll">Roll No: {viol.rollNo || viol.rollNumber || "Student"}</strong>
                                    <div className="flagged-reason">
                                        Reason: {viol.violationReason || viol.reason || "App Switched / Minimised"}
                                    </div>
                                </div>
                                <button type="button" className="flagged-review-btn">
                                    Review Alert
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 4. Recent Attendance Sessions */}
            <div className="dash-recent-activity">
                <div className="dash-recent-header">
                    <h2>Recent Attendance Sessions</h2>
                    <Link to="/lecturer/attendance-sessions" className="dash-recent-view-all">
                        View All Sessions &rarr;
                    </Link>
                </div>

                {recentSessions.length === 0 ? (
                    <div className="recent-empty-card">
                        <SlCalender className="recent-empty-icon" />
                        <h3>No sessions yet</h3>
                        <p>Start a new attendance session with QR Code & Location checking.</p>
                        <Link to="/lecturer/lecturerpage" className="recent-start-link">
                            <IoAddCircleOutline size={18} /> Start Attendance
                        </Link>
                    </div>
                ) : (
                    <div className="recent-sessions-list">
                        {recentSessions.map((session) => {
                            const sessionDate = session.createdAt ? new Date(session.createdAt) : null;
                            const isLive = session.active !== false && (session.expiresAt || 0) > Date.now();
                            return (
                                <Link to={`/lecturer/attendance-sessions/${session.id}`} className="recent-session" key={session.id}>
                                    <span className={`recent-session-icon ${isLive ? "is-live-icon" : ""}`}>
                                        <SlCalender />
                                    </span>
                                    <div className="recent-session-info">
                                        <div className="session-title-row">
                                            <strong>{session.classCode || "Class"}</strong>
                                            {isLive && (
                                                <span className="session-live-tag">
                                                    <span className="live-dot"></span> Active
                                                </span>
                                            )}
                                        </div>
                                        <span>Room {session.roomNo || "N/A"} • {session.subjectName || session.subject || "General Session"}</span>
                                    </div>
                                    <div className="recent-session-time">
                                        <span>{sessionDate ? sessionDate.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "N/A"}</span>
                                        <small>{sessionDate ? sessionDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</small>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* WhatsApp / Instagram Style Full Screen Profile Photo Viewer */}
            <ProfilePhotoModal
                isOpen={showPhotoModal}
                onClose={() => setShowPhotoModal(false)}
                photoSrc={avatarSrc}
                name={lecturerName}
                role="lecturer"
                subtext={`Faculty Member • ${normalizeBranchName(profile?.department || "CSE")}`}
                canEdit={true}
                onUpload={handlePhotoUpload}
                onDelete={handlePhotoDelete}
                uploading={photoUploading}
                deleting={photoDeleting}
            />

            {/* Interactive Violation Audit & Approval/Rejection Modal */}
            <ViolationReviewModal
                violation={selectedViolation}
                onClose={() => setSelectedViolation(null)}
                onActionComplete={(id, status) => {
                    setFlaggedViolations((prev) => prev.filter((v) => v.id !== id));
                    setCounts((prev) => ({ ...prev, violations: Math.max(0, prev.violations - 1) }));
                }}
            />
        </div>
    );
}
export default Dashboard;