import "./Dashboard.css";
import { useEffect, useState } from "react";
import { FaUser, FaCamera, FaTrashAlt, FaSpinner, FaCheck, FaTimes, FaChalkboardTeacher, FaUniversity, FaEnvelope } from "react-icons/fa";
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
import { normalizeBranchName } from "../../../utils/studentDataHelper";

function Dashboard() {
    const { user, profile, updateProfilePhoto, deleteProfilePhoto } = useAuth();
    const [recentSessions, setRecentSessions] = useState([]);
    const [counts, setCounts] = useState({
        sessions: 0,
        activeSessions: 0,
        students: 0,
        attendanceToday: 0
    });

    const [imageFailed, setImageFailed] = useState(false);
    const [showPhotoModal, setShowPhotoModal] = useState(false);
    const [photoUploading, setPhotoUploading] = useState(false);
    const [photoDeleting, setPhotoDeleting] = useState(false);
    const [photoMsg, setPhotoMsg] = useState("");
    const [photoError, setPhotoError] = useState("");

    const lecturerName = profile?.name || user?.displayName || (user?.email ? user.email.split("@")[0] : "Faculty Member");
    const avatarSrc = profile?.photoURL || profile?.image || profile?.photo || user?.photoURL || user?.photoUrl;
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
                    }
                });

                // Also count embedded session attendees
                mySessions.forEach((sess) => {
                    if (Array.isArray(sess.attendees)) {
                        sess.attendees.forEach((att) => {
                            const roll = att.rollNo || att.rollNumber || (typeof att === "string" ? att : null);
                            if (roll) {
                                studentRollNumbers.add(String(roll).toUpperCase().trim());
                            }
                            const t = att.submittedAt || att.timestamp || sess.createdAt || 0;
                            if (t >= startOfTodayMs) {
                                attendanceToday += 1;
                            }
                        });
                    }
                });

                setCounts({
                    sessions: mySessions.length,
                    activeSessions: mySessions.filter((s) => s.active !== false && (s.expiresAt || 0) > now).length,
                    students: studentRollNumbers.size,
                    attendanceToday
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

        return () => {
            unsubSessions();
            unsubRecords();
        };
    }, [user, profile]);

    const dashcards = [
        { icon: <IoAddCircleOutline />, name: "Take Attendance", value: "Start", path: "/lecturer/lecturerpage", description: "New class session" },
        { icon: <SiGoogleclassroom />, name: "Classes", value: counts.sessions, path: "/lecturer/attendance-sessions" },
        { icon: <IoQrCodeOutline />, name: "Active Sessions", value: counts.activeSessions, path: "/lecturer/active-sessions" },
        { icon: <GoPeople />, name: "Total Students", value: counts.students, path: "/lecturer/students" },
        { icon: <LuClipboardList />, name: "Attendance Today", value: counts.attendanceToday, path: "/lecturer/attendance-data" },
    ];
    return (
        <div className="dashboard-page">
            {/* 1. Lecturer Profile Banner */}
            <div className="lecturer-hero-banner">
                <div className="lecturer-hero-main">
                    <div className="lecturer-hero-avatar-wrap" style={{ position: "relative", flexShrink: 0 }}>
                        <div
                            className="lecturer-hero-avatar"
                            onClick={() => setShowPhotoModal(true)}
                            title="Click to view full-size profile photo"
                            style={{ cursor: "pointer" }}
                        >
                            {hasPhoto ? (
                                <img
                                    src={avatarSrc}
                                    alt={lecturerName || "Lecturer"}
                                    onError={() => setImageFailed(true)}
                                    style={{ width: "100%", height: "100%", borderRadius: "16px", objectFit: "cover" }}
                                />
                            ) : (
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", fontSize: "2rem" }}>
                                    <FaUser />
                                </div>
                            )}
                        </div>

                        {/* Profile Photo Action Overlay */}
                        <div style={{ position: "absolute", bottom: "-4px", right: "-6px", display: "flex", gap: "4px", alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                            {hasPhoto && (
                                <button
                                    type="button"
                                    title="Delete Profile Photo"
                                    onClick={handlePhotoDelete}
                                    disabled={photoDeleting || photoUploading}
                                    style={{
                                        background: "#ef4444",
                                        color: "#ffffff",
                                        width: "24px",
                                        height: "24px",
                                        borderRadius: "50%",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        cursor: photoDeleting ? "wait" : "pointer",
                                        boxShadow: "0 2px 8px rgba(239, 68, 68, 0.4)",
                                        fontSize: "10px",
                                        border: "2px solid var(--surface, #ffffff)",
                                        transition: "transform 0.15s ease"
                                    }}
                                >
                                    {photoDeleting ? <FaSpinner className="fa-spin" /> : <FaTrashAlt />}
                                </button>
                            )}

                            <label
                                title="Upload / Change Profile Photo"
                                style={{
                                    background: "linear-gradient(135deg, #0ea5e9, #0284c7)",
                                    color: "#ffffff",
                                    width: "26px",
                                    height: "26px",
                                    borderRadius: "50%",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    cursor: photoUploading ? "wait" : "pointer",
                                    boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
                                    fontSize: "11px",
                                    border: "2px solid var(--surface, #ffffff)",
                                    transition: "transform 0.15s ease"
                                }}
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
                            <div style={{ color: "#10b981", fontSize: "13px", fontWeight: "600", display: "flex", alignItems: "center", gap: "6px", margin: "2px 0" }}>
                                <FaCheck /> {photoMsg}
                            </div>
                        )}
                        {photoError && (
                            <div style={{ color: "#ef4444", fontSize: "13px", fontWeight: "600", display: "flex", alignItems: "center", gap: "6px", margin: "2px 0" }}>
                                <FaTimes /> {photoError}
                            </div>
                        )}
                        <div className="lecturer-hero-badges">
                            <span className="lecturer-badge pill-faculty">
                                <FaChalkboardTeacher /> Faculty Member
                            </span>
                            <span className="lecturer-badge">
                                <FaUniversity /> {normalizeBranchName(profile?.department || "CSE")}
                            </span>
                            <span className="lecturer-badge">
                                <FaEnvelope /> {user?.email || "Faculty Account"}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="dash-cards">
                {dashcards.map((item, index) => (
                    <div key={index}>
                        <Link to={item.path} className="dash-link dash-card">
                            <span className="dash-icons">{item.icon}</span>
                            <div className="card-details">
                                <p>{item.name}</p>
                                <p>{item.value}</p>
                                <p>{item.description || (item.name === "Attendance Today" ? "Submissions today" : "From Database")}</p>
                            </div>
                        </Link>
                    </div>
                ))}
            </div><br></br>
            <div className="dash-recent-activity">
                <h2>Recent Attendance Sessions</h2>
                {recentSessions.length === 0 ? (
                    <div className="recent-card">
                        <SlCalender className="icon" />
                        <p>No sessions yet</p>
                        <p>Start a new attendance session to see it here.</p>
                        <Link to="/lecturer/lecturerpage" className="recent-start-link">Start Attendance</Link>
                    </div>
                ) : (
                    <div className="recent-sessions-list">
                        {recentSessions.map((session) => {
                            const sessionDate = session.createdAt ? new Date(session.createdAt) : null;
                            return (
                                <Link to={`/lecturer/attendance-sessions/${session.id}`} className="recent-session" key={session.id}>
                                    <span className="recent-session-icon"><SlCalender /></span>
                                    <span className="recent-session-info">
                                        <strong>{session.classCode || "Class"}</strong>
                                        <span>Room {session.roomNo || "N/A"}</span>
                                    </span>
                                    <span className="recent-session-time">
                                        {sessionDate ? sessionDate.toLocaleDateString() : "N/A"}
                                        <small>{sessionDate ? sessionDate.toLocaleTimeString() : ""}</small>
                                    </span>
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
        </div>
    );
}
export default Dashboard;