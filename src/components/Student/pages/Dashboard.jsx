import React, { useEffect, useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
    collection,
    doc,
    getDoc,
    getDocs,
    setDoc,
    onSnapshot,
    query,
    where
} from "firebase/firestore";
import {
    FaUserGraduate,
    FaIdCard,
    FaCalendarCheck,
    FaChalkboardTeacher,
    FaHistory,
    FaSearch,
    FaFileDownload,
    FaCheckCircle,
    FaBookOpen,
    FaClock,
    FaSyncAlt,
    FaTimes,
    FaInfoCircle,
    FaQrcode,
    FaCamera,
    FaExclamationTriangle,
    FaUserCheck,
    FaSpinner,
    FaLock,
    FaTrashAlt,
    FaPercentage,
    FaArrowRight,
    FaEdit,
    FaCheck
} from "react-icons/fa";
import { MdQrCodeScanner } from "react-icons/md";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import { LiveFaceEnrollment } from "../../Common/LiveFaceEnrollment";
import { removeStudentPhotoOnly } from "../../../utils/biometricManager";
import { getCandidateRolls, computeStudentMetrics } from "../studentAttendanceHelper";
import "./Dashboard.css";

export default function StudentDashboard() {
    const { user, profile, updateProfileName } = useAuth();
    const navigate = useNavigate();

    const [courses, setCourses] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [search, setSearch] = useState("");


    // Face Biometric Registration Modal State
    const [showFaceModal, setShowFaceModal] = useState(false);
    const [showLockedFaceModal, setShowLockedFaceModal] = useState(false);
    const [faceSaving, setFaceSaving] = useState(false);
    const [faceSuccessMsg, setFaceSuccessMsg] = useState("");

    // Profile Photo Upload State
    const [photoUploading, setPhotoUploading] = useState(false);
    const [photoSuccessMsg, setPhotoSuccessMsg] = useState("");
    const [photoDeleting, setPhotoDeleting] = useState(false);

    // Edit Name Modal State
    const [showEditNameModal, setShowEditNameModal] = useState(false);
    const [editNameInput, setEditNameInput] = useState("");
    const [savingStudentName, setSavingStudentName] = useState(false);
    const [nameEditError, setNameEditError] = useState("");
    const [nameEditSuccess, setNameEditSuccess] = useState("");

    // Identify primary student roll number
    const emailRoll = (user?.email || "").split("@")[0].trim().toUpperCase();
    const activeRollNo = (profile?.rollNo || emailRoll || "").trim().toUpperCase();

    const [fetchedStudentData, setFetchedStudentData] = useState(null);

    // Resolve student profile name directly if not loaded
    useEffect(() => {
        if (!activeRollNo) return;
        Promise.all([
            getDoc(doc(db, "students", activeRollNo)).catch(() => ({ exists: () => false })),
            getDoc(doc(db, "users", activeRollNo)).catch(() => ({ exists: () => false }))
        ]).then(([studentSnap, userSnap]) => {
            if (studentSnap.exists()) {
                setFetchedStudentData(studentSnap.data());
            } else if (userSnap.exists()) {
                setFetchedStudentData(userSnap.data());
            }
        }).catch(() => { });
    }, [activeRollNo]);

    const studentName = fetchedStudentData?.name || profile?.name || activeRollNo || "Student";
    const rawBranch = profile?.branch || fetchedStudentData?.branch;
    const studentBranch = (rawBranch && String(rawBranch).toLowerCase() !== "general") ? rawBranch : "CSE";
    const studentSemester = profile?.semester || fetchedStudentData?.semester || "1";

    const hasFaceRegistered = Boolean(
        fetchedStudentData?.faceRegistered === true ||
        profile?.faceRegistered === true ||
        fetchedStudentData?.isFaceEnrolled === true ||
        profile?.isFaceEnrolled === true ||
        fetchedStudentData?.hasFaceRegistered === true ||
        profile?.hasFaceRegistered === true ||
        (Array.isArray(fetchedStudentData?.faceDescriptor) && fetchedStudentData.faceDescriptor.length > 0) ||
        (Array.isArray(profile?.faceDescriptor) && profile.faceDescriptor.length > 0) ||
        (fetchedStudentData?.photoURL && String(fetchedStudentData.photoURL).length > 0) ||
        (profile?.photoURL && String(profile.photoURL).length > 0)
    );

    // Build candidate roll numbers to guarantee matching
    const candidateRolls = useMemo(() => {
        return getCandidateRolls(user, profile, fetchedStudentData);
    }, [user, profile, fetchedStudentData]);

    // 1. Real-time Courses listener
    useEffect(() => {
        const unsubscribeCourses = onSnapshot(
            collection(db, "courses"),
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
                setCourses(list);
            },
            (err) => console.warn("Error listening to courses:", err)
        );
        return () => unsubscribeCourses();
    }, []);

    // 2. Real-time Sessions listener
    useEffect(() => {
        const unsubscribeSessions = onSnapshot(
            collection(db, "attendance_sessions"),
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
                setSessions(list);
            },
            (err) => console.warn("Error listening to sessions:", err)
        );
        return () => unsubscribeSessions();
    }, []);

    // 3. Real-time Attendance Records listener
    useEffect(() => {
        if (!candidateRolls || candidateRolls.length === 0) {
            setLoading(false);
            return;
        }

        setLoading(true);

        const recordsQ = query(
            collection(db, "attendance_records"),
            where("rollNo", "in", candidateRolls)
        );

        const unsubscribeRecords = onSnapshot(
            recordsQ,
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
                setRecords(list);
                setLoading(false);
                setRefreshing(false);
            },
            (err) => {
                console.error("Error listening to student attendance records:", err);
                setLoading(false);
                setRefreshing(false);
            }
        );

        return () => unsubscribeRecords();
    }, [candidateRolls]);

    // Manual Refresh Handler
    const handleManualRefresh = async () => {
        setRefreshing(true);
        try {
            const [coursesSnap, sessionsSnap, recordsSnap] = await Promise.all([
                getDocs(collection(db, "courses")).catch(() => ({ docs: [] })),
                getDocs(collection(db, "attendance_sessions")).catch(() => ({ docs: [] })),
                candidateRolls.length > 0
                    ? getDocs(query(collection(db, "attendance_records"), where("rollNo", "in", candidateRolls))).catch(() => ({ docs: [] }))
                    : { docs: [] }
            ]);

            setCourses(coursesSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
            setSessions(sessionsSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
            setRecords(recordsSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
        } catch (err) {
            console.error("Manual refresh error:", err);
        } finally {
            setRefreshing(false);
        }
    };

    // Unified metrics computation
    const metrics = useMemo(() => {
        return computeStudentMetrics(courses, sessions, records, {
            branch: studentBranch,
            semester: studentSemester
        });
    }, [courses, sessions, records, studentBranch, studentSemester]);

    // Initial Face Biometric Enrollment
    const handleEnrollStudentFace = async (enrollData) => {
        if (!enrollData || !enrollData.faceDescriptor || !activeRollNo) return;

        if (hasFaceRegistered) {
            alert("🔒 Your facial biometrics are already registered and locked. Only a Lecturer or Admin can update your biometric data.");
            setShowFaceModal(false);
            return;
        }

        try {
            setFaceSaving(true);
            const cleanEmail = (user?.email || "").toLowerCase().trim();
            const prefix = cleanEmail ? cleanEmail.split("@")[0] : activeRollNo.toLowerCase();

            const updatePayload = {
                faceDescriptor: enrollData.faceDescriptor,
                photoURL: enrollData.photoURL || fetchedStudentData?.photoURL || "",
                faceRegistered: true,
                biometricEnrolled: true,
                enrolledAt: Date.now()
            };

            const promises = [
                setDoc(doc(db, "students", activeRollNo), updatePayload, { merge: true }),
                setDoc(doc(db, "users", activeRollNo), updatePayload, { merge: true })
            ];
            if (cleanEmail) {
                promises.push(setDoc(doc(db, "authorizedUsers", cleanEmail), updatePayload, { merge: true }).catch(() => { }));
            }

            await Promise.all(promises);

            setFetchedStudentData((prev) => ({
                ...(prev || {}),
                ...updatePayload
            }));

            setFaceSuccessMsg("✅ Face biometrics enrolled successfully! You can now mark attendance.");
            setTimeout(() => {
                setShowFaceModal(false);
                setFaceSuccessMsg("");
            }, 2500);
        } catch (err) {
            console.error("Error saving student face:", err);
            alert("Failed to save face biometrics: " + err.message);
        } finally {
            setFaceSaving(false);
        }
    };

    // Profile Photo Update
    const handleProfilePhotoUpload = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            alert("Please upload a valid image file (PNG, JPG, JPEG, WEBP).");
            return;
        }

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                setPhotoUploading(true);
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

                    const cleanEmail = (user?.email || "").toLowerCase().trim();
                    const prefix = cleanEmail ? cleanEmail.split("@")[0] : activeRollNo.toLowerCase();

                    const photoPayload = {
                        photoURL: compressedDataUrl,
                        updatedAt: Date.now()
                    };

                    const promises = [
                        setDoc(doc(db, "students", activeRollNo), photoPayload, { merge: true }),
                        setDoc(doc(db, "users", activeRollNo), photoPayload, { merge: true })
                    ];
                    if (cleanEmail) {
                        promises.push(setDoc(doc(db, "authorizedUsers", cleanEmail), photoPayload, { merge: true }).catch(() => { }));
                    }
                    if (prefix && prefix !== activeRollNo.toLowerCase()) {
                        promises.push(setDoc(doc(db, "students", prefix), photoPayload, { merge: true }).catch(() => { }));
                    }

                    await Promise.all(promises);

                    setFetchedStudentData((prev) => ({
                        ...(prev || {}),
                        photoURL: compressedDataUrl
                    }));

                    setPhotoSuccessMsg("✅ Profile photo updated successfully!");
                    setTimeout(() => setPhotoSuccessMsg(""), 3000);
                };
            } catch (err) {
                console.error("Error updating profile photo:", err);
                alert("Failed to update profile photo: " + err.message);
            } finally {
                setPhotoUploading(false);
            }
        };
        reader.readAsDataURL(file);
    };

    const handleDeleteProfilePhoto = async () => {
        const confirm = window.confirm("Are you sure you want to remove your profile photo?");
        if (!confirm) return;

        try {
            setPhotoDeleting(true);
            await removeStudentPhotoOnly({ rollNo: activeRollNo, email: user?.email });
            setFetchedStudentData((prev) => ({
                ...(prev || {}),
                photoURL: "",
                image: "",
                photo: ""
            }));
            setPhotoSuccessMsg("🗑️ Profile photo removed!");
            setTimeout(() => setPhotoSuccessMsg(""), 3000);
        } catch (err) {
            console.error("Error removing photo:", err);
            alert("Failed to remove photo: " + err.message);
        } finally {
            setPhotoDeleting(false);
        }
    };

    // Filtered records for table
    const filteredRecords = useMemo(() => {
        const term = search.toLowerCase().trim();
        if (!term) return metrics.enrichedRecords;
        return metrics.enrichedRecords.filter((r) => {
            return (
                (r.courseCode || "").toLowerCase().includes(term) ||
                (r.classCode || "").toLowerCase().includes(term) ||
                (r.roomNo || "").toLowerCase().includes(term) ||
                (r.rollNo || "").toLowerCase().includes(term) ||
                (r.lecturerName || "").toLowerCase().includes(term)
            );
        });
    }, [metrics.enrichedRecords, search]);

    // Sorting
    const { sortedItems: sortedRecords, sortConfig, requestSort } = useTableSort(filteredRecords, "submittedAt", "desc");

    const handleExport = () => {
        downloadExcel(
            "student-attended-table",
            `${activeRollNo || "Student"}_My_Attendance_${new Date().toISOString().slice(0, 10)}`
        );
    };

    return (
        <div className="student-dashboard">
            {/* 1. Student Hero Profile Banner */}
            <div className="student-hero-banner">
                <div className="student-hero-main">
                    <div className="student-hero-avatar-wrap" style={{ position: "relative", flexShrink: 0 }}>
                        {(() => {
                            const hasActivePhoto = Boolean(
                                fetchedStudentData?.photoURL ||
                                (fetchedStudentData === null && (profile?.photoURL || user?.photoURL))
                            );
                            const photoSrc = fetchedStudentData?.photoURL || (fetchedStudentData === null ? (profile?.photoURL || user?.photoURL) : "");

                            return (
                                <>
                                    <div className="student-hero-avatar" style={{
                                        overflow: "hidden",
                                        background: hasActivePhoto && photoSrc ? "#0f172a" : "linear-gradient(135deg, var(--accent, #6366f1), #4338ca)"
                                    }}>
                                        {hasActivePhoto && photoSrc ? (
                                            <img
                                                src={photoSrc}
                                                alt={studentName}
                                                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                                            />
                                        ) : (
                                            studentName.charAt(0).toUpperCase()
                                        )}
                                    </div>

                                    {/* Profile Photo Actions */}
                                    <div style={{ position: "absolute", bottom: "-4px", right: "-6px", display: "flex", gap: "4px", alignItems: "center" }}>
                                        {hasActivePhoto && (
                                            <button
                                                type="button"
                                                className="student-avatar-delete-btn"
                                                title="Delete Profile Photo"
                                                onClick={handleDeleteProfilePhoto}
                                                disabled={photoDeleting}
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
                                            className="student-avatar-upload-btn"
                                            title="Upload / Change Profile Photo"
                                            style={{
                                                background: "linear-gradient(135deg, #6366f1, #4f46e5)",
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
                                                onChange={handleProfilePhotoUpload}
                                                disabled={photoUploading}
                                                style={{ display: "none" }}
                                            />
                                        </label>
                                    </div>
                                </>
                            );
                        })()}
                    </div>

                    <div className="student-hero-info">
                        <div className="student-hero-title-row">
                            <h1 className="student-hero-welcome-title">Welcome, {studentName} 👋</h1>
                        </div>

                        {photoSuccessMsg && (
                            <div className="student-hero-toast success">
                                {photoSuccessMsg}
                            </div>
                        )}

                        <div className="student-hero-badges">
                            <span className="student-role-pill-badge" title="Student Account">
                                <FaUserGraduate /> Student
                            </span>
                            <span
                                className="student-roll-badge non-editable"
                                title={`Verified Roll Number: ${activeRollNo}`}
                            >
                                <FaIdCard /> {activeRollNo || "Student"}
                            </span>
                            <span className="student-sub-badge">
                                {studentBranch} • Semester {studentSemester}
                            </span>
                            <span className="student-sub-badge">
                                {user?.email || "Student Account"}
                            </span>
                            <span
                                className="student-sub-badge"
                                onClick={() => {
                                    if (hasFaceRegistered) {
                                        setShowLockedFaceModal(true);
                                    } else {
                                        setShowFaceModal(true);
                                    }
                                }}
                                style={{
                                    cursor: "pointer",
                                    background: hasFaceRegistered ? "#dcfce7" : "#fef3c7",
                                    color: hasFaceRegistered ? "#15803d" : "#b45309",
                                    border: hasFaceRegistered ? "1px solid #bbf7d0" : "1px solid #fde68a",
                                    fontWeight: 700,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "5px"
                                }}
                                title={hasFaceRegistered ? "Facial biometrics registered and secured in database (Protected)" : "Click to register your face biometrics"}
                            >
                                {hasFaceRegistered ? (
                                    <><FaLock size={11} /> Face Registered (Protected)</>
                                ) : (
                                    <><FaCamera size={11} /> Face Pending (Click to Enroll)</>
                                )}
                            </span>
                        </div>
                    </div>
                </div>

                <div className="student-hero-action">
                    <Link to="/student/mark-attendance" className="scan-qr-cta">
                        <MdQrCodeScanner size={20} />
                        <span>Scan Class QR Code</span>
                    </Link>
                </div>
            </div>

            {/* Face Registration Pending Banner */}
            {!hasFaceRegistered && (
                <div className="face-pending-alert-banner" style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "16px",
                    padding: "16px 20px",
                    borderRadius: "14px",
                    background: "linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)",
                    border: "1.5px solid #fde68a",
                    marginBottom: "8px",
                    flexWrap: "wrap",
                    boxShadow: "0 4px 12px rgba(245, 158, 11, 0.1)"
                }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        <FaExclamationTriangle style={{ color: "#d97706", fontSize: "1.4rem" }} />
                        <div>
                            <h4 style={{ margin: 0, fontSize: "0.98rem", fontWeight: 800, color: "#92400e" }}>
                                Facial Biometrics Enrollment Required
                            </h4>
                            <p style={{ margin: "2px 0 0", fontSize: "0.85rem", color: "#b45309" }}>
                                You haven't registered your face yet. Register your biometric data once to mark attendance in class sessions.
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowFaceModal(true)}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "9px 18px",
                            borderRadius: "10px",
                            background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                            color: "#ffffff",
                            border: "none",
                            fontWeight: 700,
                            fontSize: "0.88rem",
                            cursor: "pointer",
                            boxShadow: "0 4px 12px rgba(99, 102, 241, 0.25)"
                        }}
                    >
                        <FaCamera /> 📸 Register Face Now
                    </button>
                </div>
            )}

            {/* 2. Unified Attendance Summary Statistics */}
            <div className="student-stats-grid">
                <Link to="/student/statistics" className="student-stat-card" style={{ textDecoration: "none" }} title="Click to view detailed attendance logs">
                    <div className="student-stat-icon blue">
                        <FaCalendarCheck />
                    </div>
                    <div className="student-stat-content">
                        <span>Classes Attended / Conducted</span>
                        <strong>{loading ? "..." : `${metrics.totalAttended} / ${metrics.totalConducted}`}</strong>
                    </div>
                </Link>

                <Link to="/student/statistics" className="student-stat-card" style={{ textDecoration: "none" }} title="Click to view full attendance analytics">
                    <div className={`student-stat-icon ${metrics.overallPercentage >= 75 ? "green" : "purple"}`}>
                        <FaPercentage />
                    </div>
                    <div className="student-stat-content">
                        <span>Overall Attendance</span>
                        <strong>{loading ? "..." : `${metrics.overallPercentage}%`}</strong>
                    </div>
                </Link>

                <Link to="/student/courses" className="student-stat-card green" style={{ textDecoration: "none" }} title="Click to view enrolled courses & syllabus">
                    <div className="student-stat-icon green">
                        <FaBookOpen />
                    </div>
                    <div className="student-stat-content">
                        <span>Enrolled Courses</span>
                        <strong>{loading ? "..." : metrics.coursesWithStats.length}</strong>
                    </div>
                </Link>

                <Link to="/student/statistics" className="student-stat-card purple" style={{ textDecoration: "none" }} title="Click to view recent class history">
                    <div className="student-stat-icon purple">
                        <FaClock />
                    </div>
                    <div className="student-stat-content">
                        <span>Last Attended Class</span>
                        <strong style={{ fontSize: "1.05rem" }}>{loading ? "..." : metrics.lastAttended}</strong>
                    </div>
                </Link>
            </div>

            {/* 3. Course Quick Attendance Overview */}
            {metrics.coursesWithStats.length > 0 && (
                <div className="student-course-quick-section">
                    <div className="student-course-quick-header">
                        <div>
                            <h2>My Courses & Attendance Progress</h2>
                            <p>Overview of all academic courses and current attendance status</p>
                        </div>
                        <Link to="/student/courses" className="student-course-quick-link">
                            View Detailed Syllabus & Logs <FaArrowRight />
                        </Link>
                    </div>

                    <div className="student-courses-quick-grid">
                        {metrics.coursesWithStats.slice(0, 6).map((course) => {
                            const isSafe = course.percentage !== null && course.percentage >= 75;
                            const isWarning = course.percentage !== null && course.percentage >= 65 && course.percentage < 75;
                            const isDanger = course.percentage !== null && course.percentage < 65;

                            return (
                                <Link
                                    to="/student/courses"
                                    key={course.id || course.courseCode}
                                    className="student-quick-course-card"
                                >
                                    <div className="student-quick-course-top">
                                        <span className="student-quick-course-code">{course.courseCode}</span>
                                        <span className={`student-quick-course-badge ${isSafe ? "safe" : isDanger ? "danger" : isWarning ? "warning" : "none"}`}>
                                            {course.percentage !== null ? `${course.percentage}%` : "No classes"}
                                        </span>
                                    </div>

                                    <h4 className="student-quick-course-title">{course.courseName}</h4>

                                    <div className="student-quick-course-bar-bg">
                                        <div
                                            className={`student-quick-course-bar-fill ${isSafe ? "safe" : isDanger ? "danger" : isWarning ? "warning" : ""}`}
                                            style={{ width: `${course.percentage !== null ? course.percentage : 0}%` }}
                                        />
                                    </div>

                                    <div className="student-quick-course-footer">
                                        <span>Attended: <strong>{course.attendedCount} / {course.totalConducted}</strong></span>
                                        <span>
                                            {course.totalConducted === 0 ? (
                                                "Pending"
                                            ) : isSafe ? (
                                                <span style={{ color: "#059669", fontWeight: 700 }}>+{course.leavesAvailable} Leaves Safe</span>
                                            ) : (
                                                <span style={{ color: "#dc2626", fontWeight: 700 }}>Need +{course.classesNeeded} Classes</span>
                                            )}
                                        </span>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* 4. Attended Classes Log */}
            <div className="student-records-card">
                <div className="records-header-row">
                    <div className="records-header-left">
                        <div className="records-header-icon-pill">
                            <FaCalendarCheck />
                        </div>
                        <div>
                            <h2>Classes You Have Attended ({metrics.enrichedRecords.length})</h2>
                            <p>Real-time attendance register for Roll No: <strong className="header-roll-highlight">{activeRollNo}</strong></p>
                        </div>
                    </div>

                    <div className="records-controls">
                        <button
                            type="button"
                            className="dashboard-refresh-btn"
                            onClick={handleManualRefresh}
                            disabled={refreshing}
                            title="Check for newly registered attendance"
                        >
                            <FaSyncAlt className={refreshing ? "fa-spin" : ""} />
                            <span>{refreshing ? "Updating..." : "Refresh"}</span>
                        </button>

                        {metrics.enrichedRecords.length > 0 && (
                            <div className="records-search">
                                <FaSearch className="records-search-icon" />
                                <input
                                    type="text"
                                    placeholder="Search subject, class, room or lecturer..."
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                />
                                {search && (
                                    <button
                                        type="button"
                                        className="records-search-clear"
                                        onClick={() => setSearch("")}
                                    >
                                        <FaTimes />
                                    </button>
                                )}
                            </div>
                        )}

                        {metrics.enrichedRecords.length > 0 && (
                            <button
                                type="button"
                                className="download-export-btn"
                                onClick={handleExport}
                                title="Download Excel report of your attendance"
                            >
                                <FaFileDownload /> <span>Export Excel</span>
                            </button>
                        )}
                    </div>
                </div>

                {loading ? (
                    <div className="student-empty-state">
                        <div className="empty-state-icon-wrap">
                            <FaSyncAlt className="fa-spin" />
                        </div>
                        <h3>Loading Attendance Stream</h3>
                        <p>Fetching your real-time verified attendance records from Firestore...</p>
                    </div>
                ) : filteredRecords.length === 0 ? (
                    <div className="student-empty-state">
                        <div className="empty-state-icon-wrap">
                            <FaHistory />
                        </div>
                        <h3>{search ? "No Matching Classes Found" : "No Attendance Recorded Yet"}</h3>
                        <p>
                            {search
                                ? `No classes matched your search filter "${search}". Try searching by course code or lecturer name.`
                                : `No attendance entries found under Roll Number "${activeRollNo}". Classes you attend and submit attendance for via QR Code or Face Verification will automatically appear here in real time.`}
                        </p>

                        {!search ? (
                            <div className="empty-state-actions">
                                <Link to="/student/mark-attendance" className="scan-qr-cta empty-cta-btn">
                                    <MdQrCodeScanner size={18} />
                                    <span>Scan Class QR Code</span>
                                </Link>
                                <Link to="/student/courses" className="empty-secondary-btn">
                                    <FaBookOpen />
                                    <span>Browse My Courses</span>
                                </Link>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className="empty-secondary-btn"
                                onClick={() => setSearch("")}
                            >
                                Clear Search Filter
                            </button>
                        )}

                        <div className="empty-state-footer-pill">
                            <span className="live-pulse-dot" />
                            <span>Live Sync Active • Instant Update on Submission</span>
                        </div>
                    </div>
                ) : (
                    <div className="student-table-wrap">
                        <table className="student-att-table" id="student-attended-table">
                            <thead>
                                <tr>
                                    <th className="sortable-th" onClick={() => requestSort("rollNo")} title="Click to sort by Roll Number">
                                        Roll Number <SortIcon sortConfig={sortConfig} columnKey="rollNo" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("fullName")} title="Click to sort by Student Name">
                                        Student Name <SortIcon sortConfig={sortConfig} columnKey="fullName" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("courseCode")} title="Click to sort by Course">
                                        Course / Subject <SortIcon sortConfig={sortConfig} columnKey="courseCode" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("classCode")} title="Click to sort by Class Code">
                                        Class Code <SortIcon sortConfig={sortConfig} columnKey="classCode" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("roomNo")} title="Click to sort by Room">
                                        Room <SortIcon sortConfig={sortConfig} columnKey="roomNo" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Date">
                                        Date <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Time">
                                        Time <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                                    </th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sortedRecords.map((item) => (
                                    <tr key={item.id}>
                                        <td><strong>{item.rollNo || activeRollNo}</strong></td>
                                        <td><strong>{item.fullName || studentName}</strong></td>
                                        <td><strong>{item.courseCode}</strong></td>
                                        <td>{item.classCode}</td>
                                        <td>Room {item.roomNo}</td>
                                        <td>
                                            {item.submittedAt
                                                ? new Date(item.submittedAt).toLocaleDateString(undefined, {
                                                    weekday: "short",
                                                    month: "short",
                                                    day: "numeric",
                                                    year: "numeric"
                                                })
                                                : "N/A"}
                                        </td>
                                        <td>
                                            {item.submittedAt
                                                ? new Date(item.submittedAt).toLocaleTimeString([], {
                                                    hour: "2-digit",
                                                    minute: "2-digit"
                                                })
                                                : "N/A"}
                                        </td>
                                        <td>
                                            <span className="present-tag">
                                                <FaCheckCircle /> Present
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* 5. Security Dialog: Locked Face Biometrics Information */}
            {showLockedFaceModal && (
                <div className="modal-backdrop" onClick={() => setShowLockedFaceModal(false)} style={{
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
                    <div className="student-modal-container" onClick={(e) => e.stopPropagation()} style={{
                        background: "var(--surface, #ffffff)",
                        borderRadius: "20px",
                        maxWidth: "520px",
                        width: "100%",
                        padding: "28px",
                        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                        position: "relative",
                        textAlign: "center"
                    }}>
                        <button
                            type="button"
                            onClick={() => setShowLockedFaceModal(false)}
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

                        <div style={{
                            width: "60px",
                            height: "60px",
                            borderRadius: "50%",
                            background: "#dcfce7",
                            color: "#16a34a",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "26px",
                            margin: "0 auto 16px"
                        }}>
                            <FaLock />
                        </div>

                        <h2 style={{ margin: "0 0 8px", fontSize: "1.3rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                            Facial Biometrics Registered &amp; Protected
                        </h2>

                        <div style={{
                            background: "var(--surface-soft, #f8fafc)",
                            border: "1px solid var(--border, #e2e8f0)",
                            borderRadius: "14px",
                            padding: "16px 18px",
                            margin: "16px 0",
                            textAlign: "left",
                            fontSize: "0.88rem",
                            lineHeight: 1.6,
                            color: "var(--text-main, #334155)"
                        }}>
                            <p style={{ margin: "0 0 10px" }}>
                                ✅ Your 128-dimensional facial biometric vectors are officially registered under Roll Number <strong style={{ color: "#6366f1" }}>{activeRollNo}</strong> for attendance authentication.
                            </p>
                            <p style={{ margin: 0, color: "var(--text-muted, #64748b)" }}>
                                🔒 <strong>Institutional Security Policy:</strong> To protect attendance integrity, students cannot alter or re-record registered facial biometric vectors. If your biometrics need updating, please contact your Course Lecturer or System Administrator.
                            </p>
                        </div>

                        <button
                            type="button"
                            onClick={() => setShowLockedFaceModal(false)}
                            style={{
                                padding: "10px 24px",
                                borderRadius: "10px",
                                background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                                color: "#ffffff",
                                border: "none",
                                fontWeight: 700,
                                fontSize: "0.9rem",
                                cursor: "pointer",
                                width: "100%",
                                boxShadow: "0 4px 12px rgba(99, 102, 241, 0.25)"
                            }}
                        >
                            Understood
                        </button>
                    </div>
                </div>
            )}

            {/* 6. Initial Face Biometrics Registration Modal */}
            {showFaceModal && !hasFaceRegistered && (
                <div className="modal-backdrop" onClick={() => setShowFaceModal(false)} style={{
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
                    <div className="student-modal-container" onClick={(e) => e.stopPropagation()} style={{
                        background: "var(--surface, #ffffff)",
                        borderRadius: "24px",
                        maxWidth: "960px",
                        width: "96%",
                        maxHeight: "92vh",
                        overflowY: "auto",
                        padding: "28px 24px",
                        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.35)",
                        position: "relative"
                    }}>
                        <button
                            type="button"
                            onClick={() => setShowFaceModal(false)}
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

                        <div style={{ marginBottom: "20px" }}>
                            <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "6px 14px", borderRadius: "20px", background: "rgba(99, 102, 241, 0.1)", color: "#6366f1", fontWeight: 700, fontSize: "0.85rem", marginBottom: "8px" }}>
                                <FaCamera /> Biometric AI Recognition
                            </div>
                            <h2 style={{ margin: "0 0 6px", fontSize: "1.35rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                                Register Facial Biometrics
                            </h2>
                            <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--text-muted, #64748b)" }}>
                                Roll Number: <strong style={{ color: "#6366f1" }}>{activeRollNo}</strong> • Student: <strong>{studentName}</strong>
                            </p>
                        </div>

                        <LiveFaceEnrollment
                            hideHeader={true}
                            onFaceEnrolled={handleEnrollStudentFace}
                        />

                        {faceSaving && (
                            <div style={{ marginTop: "16px", textAlign: "center", color: "#6366f1", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                                <FaSpinner className="fa-spin" /> Saving biometric facial descriptors to database...
                            </div>
                        )}

                        {faceSuccessMsg && (
                            <div style={{
                                marginTop: "16px",
                                padding: "12px 16px",
                                background: "#dcfce7",
                                color: "#15803d",
                                borderRadius: "10px",
                                fontWeight: 700,
                                textAlign: "center",
                                fontSize: "0.95rem"
                            }}>
                                {faceSuccessMsg}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* 7. Dedicated Edit Student Name Modal */}
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
                    <div className="student-modal-container student-name-edit-modal-box" onClick={(e) => e.stopPropagation()} style={{
                        background: "var(--surface, #ffffff)",
                        borderRadius: "20px",
                        maxWidth: "500px",
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
                            <FaEdit /> Student Profile Management
                        </div>

                        <h2 style={{ margin: "0 0 6px", fontSize: "1.35rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                            Edit Display Name
                        </h2>
                        <p style={{ margin: "0 0 20px", fontSize: "0.88rem", color: "var(--text-muted, #64748b)", lineHeight: 1.5 }}>
                            This name will be saved permanently in the database across all attendance records, class rosters, and certificates.
                        </p>

                        <div style={{
                            background: "var(--surface-soft, #f8fafc)",
                            border: "1px solid var(--border, #e2e8f0)",
                            borderRadius: "12px",
                            padding: "10px 14px",
                            marginBottom: "18px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            fontSize: "0.86rem"
                        }}>
                            <span style={{ color: "var(--text-muted, #64748b)", fontWeight: 600 }}>Verified Roll Number:</span>
                            <span style={{ fontWeight: 800, color: "#6366f1", fontFamily: "monospace", fontSize: "0.95rem" }}>{activeRollNo}</span>
                        </div>

                        <form onSubmit={async (e) => {
                            e.preventDefault();
                            if (!editNameInput.trim()) return;
                            try {
                                setSavingStudentName(true);
                                setNameEditError("");
                                await updateProfileName(editNameInput.trim());
                                setFetchedStudentData((prev) => ({ ...(prev || {}), name: editNameInput.trim() }));
                                setShowEditNameModal(false);
                                setNameEditSuccess("Name updated and saved successfully!");
                                setTimeout(() => setNameEditSuccess(""), 3500);
                            } catch (err) {
                                setNameEditError(err.message || "Failed to save name");
                            } finally {
                                setSavingStudentName(false);
                            }
                        }}>
                            <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main, #334155)", marginBottom: "6px" }}>
                                Full Name
                            </label>
                            <input
                                type="text"
                                value={editNameInput}
                                onChange={(e) => setEditNameInput(e.target.value)}
                                placeholder="Enter your full name"
                                autoFocus
                                required
                                disabled={savingStudentName}
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

                            {nameEditError && (
                                <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: "10px", fontSize: "0.85rem", fontWeight: 600, marginBottom: "14px" }}>
                                    ⚠️ {nameEditError}
                                </div>
                            )}

                            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                                <button
                                    type="button"
                                    onClick={() => { setShowEditNameModal(false); setNameEditError(""); }}
                                    disabled={savingStudentName}
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
                                    disabled={savingStudentName || !editNameInput.trim()}
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
                                    {savingStudentName ? <FaSpinner className="fa-spin" /> : <><FaCheck /> Save Name</>}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}