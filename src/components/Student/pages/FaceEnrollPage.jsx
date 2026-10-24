import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
    FaArrowLeft,
    FaCamera,
    FaSpinner,
    FaCheckCircle,
    FaShieldAlt,
    FaFingerprint,
    FaMobileAlt,
    FaCheck,
    FaRedo,
    FaExclamationTriangle,
    FaInfoCircle,
    FaLock,
    FaCog,
    FaKey,
    FaUserShield
} from "react-icons/fa";
import { doc, onSnapshot } from "firebase/firestore";
import { Capacitor } from "@capacitor/core";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { LiveFaceEnrollment } from "../../Common/LiveFaceEnrollment";
import FaceScanner from "../../Lecturer/pages/FaceScanner";
import { registerStudentFace } from "../../../services/faceEnrollmentService";
import { Biometric } from "../../../plugins/biometric";
import {
    isHardwareBiometricAvailable,
    enrollHardwareBiometric,
    verifyHardwareBiometric,
    openBiometricSettings
} from "../../../services/biometricService";
import { isBrowserCameraAllowed } from "../../../utils/deviceDetection";
import { getApkDownloadUrl } from "../../../utils/apkUrl";
import "./FaceEnrollPage.css";

export default function FaceEnrollPage() {
    const navigate = useNavigate();
    const { user, profile } = useAuth();
    const [activeTab, setActiveTab] = useState("face"); // "face" | "fingerprint"

    // Real-time Enrollment Status
    const [hasFaceRegistered, setHasFaceRegistered] = useState(() => {
        try {
            return Boolean(
                profile?.faceRegistered ||
                profile?.biometricEnrolled ||
                profile?.hasFaceRegistered ||
                localStorage.getItem(`smartattend_face_enrolled_${profile?.rollNo || ""}`) === "true" ||
                localStorage.getItem("smartattend_face_enrolled") === "true"
            );
        } catch (_) {
            return false;
        }
    });
    const [showFaceTest, setShowFaceTest] = useState(false);
    const [faceTestResult, setFaceTestResult] = useState("");
    const [isReEnrolling, setIsReEnrolling] = useState(false);
    const [reRegPermission, setReRegPermission] = useState(null);
    const [hasHwRegistered, setHasHwRegistered] = useState(() => {
        try {
            return (
                localStorage.getItem(`smartattend_hw_enrolled_${profile?.rollNo || ""}`) === "true" ||
                localStorage.getItem("smartattend_hw_enrolled") === "true" ||
                Boolean(profile?.hardwareBiometricEnrolled)
            );
        } catch (_) {
            return false;
        }
    });
    const [faceSaving, setFaceSaving] = useState(false);
    const [faceSuccessMsg, setFaceSuccessMsg] = useState("");

    // Hardware Biometrics Enrollment State
    const [hwEnrolling, setHwEnrolling] = useState(false);
    const [hwEnrollMsg, setHwEnrollMsg] = useState("");
    const [hwEnrollError, setHwEnrollError] = useState("");
    const [hwTesting, setHwTesting] = useState(false);
    const [hwTestResult, setHwTestResult] = useState("");
    const [hwInfo, setHwInfo] = useState(null);
    const [keyExistsOnDevice, setKeyExistsOnDevice] = useState(true);

    const cleanEmail = String(user?.email || profile?.email || "").trim().toLowerCase();
    const emailRoll = cleanEmail.split("@")[0].trim().toUpperCase();
    const activeRollNo = (profile?.rollNo || emailRoll || "").trim().toUpperCase();
    const studentName = profile?.name || profile?.fullName || activeRollNo || "Student";
    const isNative = Capacitor.isNativePlatform();
    const platform = Capacitor.getPlatform();
    const browserCameraAuth = isBrowserCameraAllowed(profile, user);
    const isCameraAllowed = browserCameraAuth.allowed;

    const userRole = String(profile?.role || "").trim().toLowerCase();
    const isStaff = userRole === "lecturer" || userRole === "admin" || userRole === "administrator" || Boolean(profile?.isLecturer || profile?.isAdmin);

    const refreshHwStatus = async () => {
        try {
            const info = await isHardwareBiometricAvailable();
            setHwInfo(info);
            if (isNative) {
                const st = await Biometric.getBiometricKeyStatus({ keyAlias: "smartattend_biometric_key" });
                setKeyExistsOnDevice(Boolean(st.exists && !st.isPermanentlyInvalidated));
            }
        } catch (e) {
            console.warn("HW status check notice:", e);
        }
    };

    useEffect(() => {
        refreshHwStatus();
    }, [isNative, hasHwRegistered]);

    // Live Snapshot for Real-Time Status Tracking from student & user records
    useEffect(() => {
        if (!activeRollNo) return;
        const localFaceStatus = (
            profile?.faceRegistered ||
            profile?.biometricEnrolled ||
            profile?.hasFaceRegistered ||
            localStorage.getItem(`smartattend_face_enrolled_${activeRollNo}`) === "true" ||
            (user?.uid && localStorage.getItem(`smartattend_face_enrolled_${user.uid}`) === "true") ||
            localStorage.getItem("smartattend_face_enrolled") === "true"
        );
        if (localFaceStatus) {
            setHasFaceRegistered(true);
        }

        const localHwStatus = (
            profile?.hardwareBiometricEnrolled ||
            localStorage.getItem(`smartattend_hw_enrolled_${activeRollNo}`) === "true" ||
            (user?.uid && localStorage.getItem(`smartattend_hw_enrolled_${user.uid}`) === "true") ||
            localStorage.getItem("smartattend_hw_enrolled") === "true"
        );
        if (localHwStatus) {
            setHasHwRegistered(true);
        }

        const handleDocUpdate = (data) => {
            if (!data) return;
            const faceEnrolled = Boolean(
                !data.faceRemovedAt &&
                (data.faceRegistered || data.biometricEnrolled || data.hasFaceRegistered)
            );
            if (faceEnrolled) {
                setHasFaceRegistered(true);
                try {
                    localStorage.setItem(`smartattend_face_enrolled_${activeRollNo}`, "true");
                    if (user?.uid) localStorage.setItem(`smartattend_face_enrolled_${user.uid}`, "true");
                    localStorage.setItem("smartattend_face_enrolled", "true");
                } catch (_) {}
            }

            const hwEnrolled = Boolean(data.hardwareBiometricEnrolled) || localHwStatus;
            if (hwEnrolled) {
                setHasHwRegistered(true);
                try {
                    localStorage.setItem(`smartattend_hw_enrolled_${activeRollNo}`, "true");
                    if (user?.uid) localStorage.setItem(`smartattend_hw_enrolled_${user.uid}`, "true");
                    localStorage.setItem("smartattend_hw_enrolled", "true");
                } catch (_) {}
            }
        };

        const unsubs = [];
        unsubs.push(onSnapshot(doc(db, "students", activeRollNo), (snap) => {
            if (snap.exists()) {
                handleDocUpdate(snap.data());
            } else if (localFaceStatus) {
                setHasFaceRegistered(true);
            }
        }, (err) => console.warn("Biometric student snap warning:", err)));

        unsubs.push(onSnapshot(doc(db, "users", activeRollNo), (snap) => {
            if (snap.exists()) {
                handleDocUpdate(snap.data());
            }
        }, (err) => console.warn("Biometric user roll snap warning:", err)));

        if (user?.uid && user.uid !== activeRollNo) {
            unsubs.push(onSnapshot(doc(db, "users", user.uid), (snap) => {
                if (snap.exists()) {
                    handleDocUpdate(snap.data());
                }
            }, (err) => console.warn("Biometric user uid snap warning:", err)));
        }

        return () => {
            unsubs.forEach((u) => u && u());
        };
    }, [activeRollNo, user?.uid, profile]);

    // Live Subscription to Re-registration Permissions
    useEffect(() => {
        if (!activeRollNo) return;
        const unsubPerm = onSnapshot(doc(db, "biometric_reregistration_permissions", activeRollNo), (snap) => {
            if (snap.exists()) {
                setReRegPermission(snap.data());
            } else {
                setReRegPermission(null);
            }
        }, (err) => {
            console.warn("Biometric permissions snap notice:", err);
        });
        return () => unsubPerm();
    }, [activeRollNo]);

    // Permission Authorization Logic
    const isPermActive = Boolean(
        reRegPermission &&
        reRegPermission.status === "active" &&
        (reRegPermission.remainingUses === undefined || reRegPermission.remainingUses === null || reRegPermission.remainingUses > 0) &&
        (!reRegPermission.expiresAt || reRegPermission.expiresAt > Date.now())
    );

    const canReEnrollFace = isStaff || !hasFaceRegistered || (
        isPermActive && (reRegPermission.registrationType === "face" || reRegPermission.registrationType === "both")
    );

    const canReEnrollHw = isStaff || !hasHwRegistered || (
        isPermActive && (reRegPermission.registrationType === "biometric" || reRegPermission.registrationType === "both")
    );

    // Phase 7: Authoritative Registration State & Labels
    const canonicalState = useMemo(() => {
        if (faceSaving || hwEnrolling) {
            return {
                code: isReEnrolling ? "REREG_IN_PROGRESS" : "INITIAL_IN_PROGRESS",
                label: isReEnrolling ? "Re-Registration in Progress..." : "Initial Registration in Progress...",
                ribbonClass: "status-pending"
            };
        }
        if (hasFaceRegistered && hasHwRegistered) {
            if (isPermActive) {
                return {
                    code: "PERMISSION_GRANTED",
                    label: `Re-Registration Authorized (${reRegPermission.mode === "one_time" ? "Mode A: 1-Time Pass" : "Mode B: Repeated Access"} • ${reRegPermission.remainingUses ?? 1} left)`,
                    ribbonClass: "status-permission-granted"
                };
            }
            if (reRegPermission?.status === "revoked") {
                return {
                    code: "PERMISSION_REVOKED",
                    label: "Re-Registration Pass Revoked by Faculty",
                    ribbonClass: "status-registered"
                };
            }
            if (reRegPermission?.expiresAt && reRegPermission.expiresAt <= Date.now()) {
                return {
                    code: "PERMISSION_EXPIRED",
                    label: "Re-Registration Pass Expired",
                    ribbonClass: "status-registered"
                };
            }
            return {
                code: "COMPLETED",
                label: "All Biometrics Registered & Locked",
                ribbonClass: "status-registered"
            };
        }
        if (hasFaceRegistered || hasHwRegistered) {
            if (isPermActive) {
                return {
                    code: "PERMISSION_GRANTED",
                    label: `Re-Registration Authorized (${reRegPermission.mode === "one_time" ? "Mode A" : "Mode B"})`,
                    ribbonClass: "status-permission-granted"
                };
            }
            return {
                code: "PARTIALLY_REGISTERED",
                label: hasFaceRegistered ? "Face Enrolled • Fingerprint Pending" : "Fingerprint Enrolled • Face Pending",
                ribbonClass: "status-pending"
            };
        }
        if (hwEnrollError) {
            return {
                code: "FAILED_RETRY_AVAILABLE",
                label: "Registration Interrupted • Retry Available",
                ribbonClass: "status-pending"
            };
        }
        return {
            code: "NOT_REGISTERED",
            label: "Not Registered (Setup Required)",
            ribbonClass: "status-pending"
        };
    }, [faceSaving, hwEnrolling, isReEnrolling, hasFaceRegistered, hasHwRegistered, isPermActive, reRegPermission, hwEnrollError]);

    const handleFaceEnrolled = async (enrollData) => {
        if (!enrollData || !enrollData.faceDescriptor || !activeRollNo) return;

        // Security Lock: Allow if not registered, or if staff, or if re-registration permitted
        if (hasFaceRegistered && !canReEnrollFace) {
            alert("🔒 Biometrics Locked:\n\nInitial face registration is complete and permanently protected. Students cannot independently re-register face biometrics.\n\nPlease contact your Course Lecturer or Administrator to request an authorized Re-Registration Pass.");
            return;
        }

        try {
            setFaceSaving(true);
            const rawVector = enrollData.faceDescriptor;
            const cleanVector = Array.isArray(rawVector) ? rawVector : Array.from(rawVector);
            await registerStudentFace(activeRollNo, cleanVector);
            setHasFaceRegistered(true);
            setIsReEnrolling(false);
            setShowFaceTest(false);
            setFaceSuccessMsg("✅ Face biometrics registered & saved! Next: Register your Device Fingerprint below.");
            setTimeout(() => {
                setFaceSuccessMsg("");
                setActiveTab("fingerprint");
            }, 2500);
        } catch (err) {
            console.error("Error saving face biometrics:", err);
            const msg = err.message || "";
            if (msg.includes("already-exists") || msg.includes("Duplicate") || msg.includes("already enrolled under another")) {
                alert("❌ Duplicate Face Detected:\n\nThis face matches another enrolled student account in the institution. Global face uniqueness requires one unique face per student identity.\n\nPlease enroll your own face or contact your Administrator.");
            } else if (msg.includes("permission-denied") || msg.includes("re-registration permission") || msg.includes("already enrolled")) {
                alert("🔒 Biometrics Locked:\n\n" + msg);
            } else {
                alert("Failed to save face biometrics: " + msg);
            }
        } finally {
            setFaceSaving(false);
        }
    };

    // In-App Fingerprint / Device Biometrics Registration Handler
    const handleEnrollFingerprint = async (isRebind = false) => {
        // Security Lock: Prevent re-enrolling once registered unless staff, re-registration authorized, or keystore rebind
        if (hasHwRegistered && !canReEnrollHw && !isRebind) {
            alert("🔒 Biometrics Locked:\n\nYour device fingerprint is already registered and permanently protected. Students cannot independently re-register biometrics.\n\nPlease contact your Course Lecturer or Administrator if an authorized reset is needed.");
            return;
        }

        try {
            setHwEnrolling(true);
            setHwEnrollError("");
            setHwEnrollMsg("");

            const res = await enrollHardwareBiometric(user?.uid || activeRollNo);
            if (res.success) {
                // Persist locally for immediate offline client responsiveness
                const regPlatform = res.platform || platform || (isNative ? "android" : "web");
                try {
                    if (activeRollNo) localStorage.setItem(`smartattend_hw_enrolled_${activeRollNo}`, "true");
                    if (user?.uid) localStorage.setItem(`smartattend_hw_enrolled_${user.uid}`, "true");
                    localStorage.setItem("smartattend_hw_enrolled", "true");
                    localStorage.setItem("smartattend_student_device_type", regPlatform);
                    localStorage.setItem("smartattend_student_device_locked", "true");
                    localStorage.setItem("smartattend_device_registered", "true");
                } catch (_) {}

                setHasHwRegistered(true);
                setKeyExistsOnDevice(true);
                setHwEnrollMsg("✅ Fingerprint & Device Biometrics Enrolled In-App Successfully!");
                setTimeout(() => setHwEnrollMsg(""), 4500);
                refreshHwStatus();
            } else {
                if (res.code === "ALREADY_REGISTERED") {
                    setHwEnrollError("🔒 Biometrics Locked: Your hardware biometric is already enrolled. Contact your Course Lecturer or Administrator to grant an authorized re-registration pass.");
                } else {
                    setHwEnrollError(res.message || "Failed to register fingerprint. Please try again.");
                }
            }
        } catch (err) {
            console.error("Fingerprint enrollment error:", err);
            setHwEnrollError(err.message || "Failed to register fingerprint.");
        } finally {
            setHwEnrolling(false);
        }
    };

    // Test Biometric Verification Handler
    const handleTestFingerprint = async () => {
        try {
            setHwTesting(true);
            setHwTestResult("");
            const res = await verifyHardwareBiometric(user?.uid, "SmartAttend In-App Biometric Test");
            if (res.success) {
                setHwTestResult("✅ Fingerprint Verified 100%! Device hardware is authenticated and ready for attendance.");
            } else {
                setHwTestResult(res.message || "❌ Verification cancelled or failed.");
            }
        } catch (err) {
            setHwTestResult("❌ Test error: " + err.message);
        } finally {
            setHwTesting(false);
        }
    };

    const isAllRegistered = hasFaceRegistered && hasHwRegistered;

    return (
        <div className="face-enroll-page">
            <div className="face-enroll-top-bar">
                <button
                    type="button"
                    className="back-btn"
                    onClick={() => navigate("/student")}
                >
                    <FaArrowLeft /> Dashboard
                </button>
                <div className="top-badge">
                    <FaShieldAlt /> <strong>{activeRollNo}</strong> ({studentName})
                </div>
            </div>

            {/* Main Interactive Card */}
            <div className="face-enroll-card">
                {/* Phase 7: Authoritative Registration State Ribbon */}
                <div className={`bio-status-ribbon ${canonicalState.ribbonClass}`}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <FaShieldAlt />
                        <span>Status: <strong>{canonicalState.label}</strong></span>
                    </div>
                    {isStaff && (
                        <span style={{ fontSize: "0.78rem", background: "rgba(99, 102, 241, 0.2)", padding: "2px 8px", borderRadius: "6px", color: "#4f46e5" }}>
                            <FaUserShield /> Staff Self-Enrollment Mode
                        </span>
                    )}
                </div>

                {/* Tab Navigation Switcher with Live Status */}
                <div className="bio-tabs-switcher" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === "face"}
                        className={`bio-tab-btn ${activeTab === "face" ? "active" : ""}`}
                        onClick={() => setActiveTab("face")}
                    >
                        <FaCamera /> 1. Face Biometrics {hasFaceRegistered ? <span style={{ color: '#10b981', fontWeight: 800, fontSize: '0.82rem' }}>✓ Active</span> : <span style={{ color: '#d97706', fontSize: '0.78rem' }}>(Not Set)</span>}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === "fingerprint"}
                        className={`bio-tab-btn ${activeTab === "fingerprint" ? "active" : ""}`}
                        onClick={() => setActiveTab("fingerprint")}
                    >
                        <FaFingerprint /> 2. Fingerprint {hasHwRegistered ? <span style={{ color: '#10b981', fontWeight: 800, fontSize: '0.82rem' }}>✓ Active</span> : <span style={{ color: '#d97706', fontSize: '0.78rem' }}>(Not Set)</span>}
                    </button>
                </div>

                {/* Tab 1: Live 3D Face Enrollment / Locked Card */}
                {activeTab === "face" && (
                    <div className="bio-tab-content">
                        {hasFaceRegistered && !isReEnrolling ? (
                            <div className="bio-locked-state-card">
                                <div className="bio-locked-badge">
                                    <FaLock /> 3D Face Biometrics Registered
                                </div>
                                <div className="bio-locked-avatar-wrap">
                                    {profile?.photoURL ? (
                                        <img src={profile.photoURL} alt="Registered Face" className="bio-locked-photo" />
                                    ) : (
                                        <div className="bio-locked-placeholder">
                                            <FaCamera />
                                        </div>
                                    )}
                                </div>
                                <h2>Facial Biometrics Registered &amp; Protected</h2>
                                <p className="bio-locked-student-info">
                                    Student: <strong>{studentName}</strong> • Roll No: <strong style={{ color: "var(--accent, #6366f1)" }}>{activeRollNo}</strong>
                                </p>
                                
                                {isStaff ? (
                                    <div className="bio-permission-alert-box">
                                        <FaUserShield className="perm-icon" />
                                        <div>
                                            <strong>Staff Biometrics Authorized</strong>
                                            <p>As a faculty member or administrator, you may test face recognition or update and re-enroll your biometrics whenever needed.</p>
                                        </div>
                                    </div>
                                ) : canReEnrollFace ? (
                                    <div className="bio-permission-alert-box">
                                        <FaKey className="perm-icon" />
                                        <div>
                                            <strong>Re-Registration Pass Authorized 🔑</strong>
                                            <p>
                                                You have been granted permission to re-enroll your facial biometrics.
                                            </p>
                                            <div className="bio-permission-tags">
                                                <span className="bio-perm-tag">
                                                    Grantor: {reRegPermission?.grantedByName || reRegPermission?.grantedByRole || "Faculty"}
                                                </span>
                                                <span className="bio-perm-tag">
                                                    Mode: {reRegPermission?.mode === "one_time" ? "Mode A (One-Time)" : "Mode B (Repeated)"}
                                                </span>
                                                <span className="bio-perm-tag">
                                                    Remaining Uses: {reRegPermission?.remainingUses ?? 1}
                                                </span>
                                                {reRegPermission?.expiresAt && (
                                                    <span className="bio-perm-tag">
                                                        Expires: {new Date(reRegPermission.expiresAt).toLocaleDateString()}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="bio-locked-alert-box">
                                        <FaLock className="lock-inline-icon" />
                                        <div>
                                            <strong>Student Biometrics Locked 🔒</strong>
                                            <p>
                                                Your 128-dimensional facial biometric profile is active and permanently protected for institutional attendance. Under policy, students cannot independently re-register face biometrics.
                                                <br />
                                                If you need to update your registered face (e.g. appearance changes, camera issues), please contact your Course Lecturer or Administrator to grant an authorized Re-Registration Pass.
                                            </p>
                                        </div>
                                    </div>
                                )}

                                {/* Action Buttons: Test Live Verification & Re-Enroll */}
                                <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap", margin: "16px 0" }}>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowFaceTest((prev) => !prev);
                                            setFaceTestResult("");
                                        }}
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "8px",
                                            padding: "10px 18px",
                                            borderRadius: "10px",
                                            background: "linear-gradient(135deg, #4f46e5 0%, #6366f1 100%)",
                                            color: "#ffffff",
                                            border: "none",
                                            fontWeight: 700,
                                            fontSize: "0.88rem",
                                            cursor: "pointer"
                                        }}
                                    >
                                        <FaCamera /> {showFaceTest ? "Close Face Test" : "Test Live Face Verification"}
                                    </button>

                                    {canReEnrollFace ? (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setShowFaceTest(false);
                                                setIsReEnrolling(true);
                                            }}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "8px",
                                                padding: "10px 18px",
                                                borderRadius: "10px",
                                                background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                                                color: "#ffffff",
                                                border: "none",
                                                fontWeight: 700,
                                                fontSize: "0.88rem",
                                                cursor: "pointer",
                                                boxShadow: "0 4px 12px rgba(16, 185, 129, 0.25)"
                                            }}
                                        >
                                            <FaRedo /> {isStaff ? "Re-Enroll Face Biometrics" : "Re-Enroll Face Biometrics (Pass Active)"}
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            className="bio-locked-disabled-btn"
                                            onClick={() => alert("🔒 Re-Registration Locked:\n\nInitial face registration is complete. To re-register your face, request an authorized Re-Registration Pass from your course lecturer or administrator.")}
                                        >
                                            <FaLock /> Re-Registration Locked (Requires Faculty Pass)
                                        </button>
                                    )}
                                </div>

                                {/* Live Face Test View */}
                                {showFaceTest && (
                                    <div style={{
                                        margin: "16px 0",
                                        padding: "18px 16px",
                                        borderRadius: "16px",
                                        background: "var(--surface-soft, #f8fafc)",
                                        border: "1.5px solid var(--border, #e2e8f0)",
                                        textAlign: "left"
                                    }}>
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                                            <h4 style={{ margin: 0, fontWeight: 800, fontSize: "1rem" }}>
                                                🧪 Live Face Biometric Test
                                            </h4>
                                            <button
                                                type="button"
                                                onClick={() => setShowFaceTest(false)}
                                                style={{ background: "transparent", border: "none", color: "#64748b", fontWeight: 700, cursor: "pointer" }}
                                            >
                                                ✕ Close
                                            </button>
                                        </div>
                                        <p style={{ margin: "0 0 14px", fontSize: "0.84rem", color: "#64748b" }}>
                                            Look directly into the camera. SmartAttend will match your live face against your registered profile.
                                        </p>

                                        {isCameraAllowed ? (
                                            <FaceScanner
                                                verifiedStudent={{
                                                    name: studentName,
                                                    rollNo: activeRollNo,
                                                    faceRegistered: hasFaceRegistered
                                                }}
                                                rollNo={activeRollNo}
                                                onVerificationChange={(res) => {
                                                    if (res && res.verified) {
                                                        setFaceTestResult(`✅ Face Verified! Match Confidence: ${res.confidence}% • Liveness Confirmed 🛡️`);
                                                    }
                                                }}
                                            />
                                        ) : (
                                            <div style={{ textAlign: "center", padding: "16px", background: "#fee2e2", borderRadius: "12px", border: "1px solid #fecaca" }}>
                                                <FaLock style={{ color: "#dc2626", fontSize: "24px", marginBottom: "8px" }} />
                                                <div style={{ fontWeight: 800, color: "#991b1b", marginBottom: "6px" }}>Camera Blocked in Web Browser</div>
                                                <div style={{ fontSize: "0.85rem", color: "#7f1d1d" }}>
                                                    Camera in browser is only available for Lecturers, Admins, and iPhone users. Please use the SmartAttend Android App (.apk) to test face verification.
                                                </div>
                                            </div>
                                        )}

                                        {faceTestResult && (
                                            <div style={{
                                                marginTop: "12px",
                                                padding: "12px 16px",
                                                borderRadius: "10px",
                                                background: "#dcfce7",
                                                color: "#15803d",
                                                fontWeight: 800,
                                                textAlign: "center"
                                            }}>
                                                {faceTestResult}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {!hasHwRegistered && (
                                    <button
                                        type="button"
                                        className="bio-locked-switch-btn"
                                        onClick={() => setActiveTab("fingerprint")}
                                    >
                                        <FaFingerprint /> Next Step: Register Device Fingerprint
                                    </button>
                                )}
                            </div>
                        ) : (
                            <>
                                <div className="face-enroll-header">
                                    <div className="face-enroll-icon">
                                        <FaCamera />
                                    </div>
                                    <h1>3D Face Biometrics Registration</h1>
                                    <p>
                                        Roll Number: <strong style={{ color: "var(--accent, #6366f1)" }}>{activeRollNo}</strong> • Student: <strong>{studentName}</strong>
                                    </p>
                                    {!isCameraAllowed && (
                                        <div style={{
                                            margin: "12px 0 6px",
                                            padding: "12px 16px",
                                            borderRadius: "12px",
                                            background: "#fef2f2",
                                            border: "1px solid #fecaca",
                                            color: "#991b1b",
                                            fontSize: "0.86rem",
                                            textAlign: "center"
                                        }}>
                                            <strong>Android Web Browser:</strong> Camera is only available in browser for Lecturers, Admins, and iPhone users. Please use the official <strong>SmartAttend Android App (.apk)</strong> for facial biometrics registration.
                                        </div>
                                    )}
                                    {isReEnrolling && (
                                        <div style={{ marginTop: "8px" }}>
                                            <button
                                                type="button"
                                                onClick={() => setIsReEnrolling(false)}
                                                style={{
                                                    background: "transparent",
                                                    border: "none",
                                                    color: "#ef4444",
                                                    fontWeight: 700,
                                                    fontSize: "0.85rem",
                                                    cursor: "pointer"
                                                }}
                                            >
                                                ← Cancel Re-Enrollment &amp; Keep Current Profile
                                            </button>
                                        </div>
                                    )}
                                </div>

                                <div className="face-enroll-camera-wrap">
                                    <LiveFaceEnrollment
                                        hideHeader={true}
                                        targetName={studentName}
                                        onFaceEnrolled={handleFaceEnrolled}
                                    />
                                </div>

                                {faceSaving && (
                                    <div className="face-enroll-status-saving">
                                        <FaSpinner className="fa-spin" /> Saving biometric facial vectors to database...
                                    </div>
                                )}

                                {faceSuccessMsg && (
                                    <div className="face-enroll-status-success">
                                        <FaCheckCircle /> {faceSuccessMsg}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}

                {/* Tab 2: In-App Fingerprint & Device Biometrics Registration / Locked Card */}
                {activeTab === "fingerprint" && (
                    <div className="bio-tab-content fingerprint-tab-content">
                        {hasHwRegistered ? (
                            <div className="bio-locked-state-card hw-locked">
                                <div className="bio-locked-badge hw-badge">
                                    <FaLock /> Device Fingerprint Bound &amp; Locked
                                </div>
                                <div className="bio-locked-avatar-wrap hw-icon-avatar">
                                    <FaFingerprint />
                                </div>
                                <h2>Hardware Biometric Signature Active</h2>
                                <p className="bio-locked-student-info">
                                    Bound to: <strong>{isNative ? (platform === "android" ? "Android Keystore (Hardware Chip)" : "Apple Secure Enclave (Face ID / Touch ID)") : "Platform Authenticator (Web Security)"}</strong>
                                </p>

                                {isStaff ? (
                                    <div className="bio-permission-alert-box">
                                        <FaUserShield className="perm-icon" />
                                        <div>
                                            <strong>Staff Device Biometrics Authorized</strong>
                                            <p>As a faculty member or administrator, you may re-register or update device biometrics at any time.</p>
                                        </div>
                                    </div>
                                ) : canReEnrollHw ? (
                                    <div className="bio-permission-alert-box">
                                        <FaKey className="perm-icon" />
                                        <div>
                                            <strong>Re-Registration Pass Authorized 🔑</strong>
                                            <p>
                                                You have been granted permission to re-register your device fingerprint.
                                            </p>
                                            <div className="bio-permission-tags">
                                                <span className="bio-perm-tag">
                                                    Grantor: {reRegPermission?.grantedByName || reRegPermission?.grantedByRole || "Faculty"}
                                                </span>
                                                <span className="bio-perm-tag">
                                                    Mode: {reRegPermission?.mode === "one_time" ? "Mode A (One-Time)" : "Mode B (Repeated)"}
                                                </span>
                                                <span className="bio-perm-tag">
                                                    Remaining Uses: {reRegPermission?.remainingUses ?? 1}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="bio-locked-alert-box">
                                        <FaLock className="lock-inline-icon" />
                                        <div>
                                            <strong>Hardware Signature Locked 🔒</strong>
                                            <p>
                                                This physical device is cryptographically bound to Roll No: <strong>{activeRollNo}</strong>. Students cannot independently re-register or overwrite the registered biometric key. Attendance must be signed from this authorized device.
                                                <br />
                                                If you changed or lost your phone, request a Re-Registration Pass from your Course Lecturer or Administrator.
                                            </p>
                                        </div>
                                    </div>
                                )}

                                {canReEnrollHw && (
                                    <div style={{ margin: "16px 0" }}>
                                        <button
                                            type="button"
                                            className="fp-primary-enroll-btn"
                                            onClick={() => handleEnrollFingerprint(true)}
                                            disabled={hwEnrolling}
                                            style={{ padding: "12px 20px", fontSize: "0.95rem" }}
                                        >
                                            {hwEnrolling ? (
                                                <><FaSpinner className="fa-spin" /> <span>Waiting for Fingerprint...</span></>
                                            ) : (
                                                <><FaRedo /> <span>{isStaff ? "Re-Register Fingerprint (Staff)" : "Re-Register Fingerprint (Pass Active)"}</span></>
                                            )}
                                        </button>
                                    </div>
                                )}

                                <div className="fp-test-area-locked">
                                    <p style={{ margin: "0 0 10px", fontSize: "0.85rem", color: "var(--text-muted, #64748b)" }}>
                                        You can test your sensor anytime to confirm your fingerprint hardware is authenticated:
                                    </p>
                                    <button
                                        type="button"
                                        className="fp-test-btn"
                                        onClick={handleTestFingerprint}
                                        disabled={hwTesting}
                                    >
                                        {hwTesting ? <FaSpinner className="fa-spin" /> : <FaRedo />}
                                        <span>Test Fingerprint Verification</span>
                                    </button>
                                </div>

                                {hwTestResult && (
                                    <div className={`face-enroll-status-test ${hwTestResult.includes("Verified") || hwTestResult.includes("Passed") ? "success" : "fail"}`} style={{ marginTop: "16px" }}>
                                        {hwTestResult}
                                    </div>
                                )}

                                <div className="bio-locked-help-note" style={{ marginTop: "20px" }}>
                                    <FaInfoCircle /> If you lost or replaced your physical phone, request an authorized reset from your Course Lecturer or Administrator.
                                </div>
                            </div>
                        ) : (
                            <>
                                <div className="face-enroll-header">
                                    <div className="face-enroll-icon fp-large-icon">
                                        <FaFingerprint />
                                    </div>
                                    <h1>Device Fingerprint Registration</h1>
                                    <p>
                                        Roll Number: <strong style={{ color: "var(--accent, #6366f1)" }}>{activeRollNo}</strong> • Device: <strong>{isNative ? (platform === "android" ? "Android Phone" : "iPhone (iOS)") : "Web Browser"}</strong>
                                    </p>
                                </div>

                                <div className="fp-enrollment-box">
                                    <div className="fp-instruction-text">
                                        <p>
                                            Tap the button below to trigger your device's biometric sensor. Touching your <strong>fingerprint sensor</strong> (or <strong>Face ID / Touch ID</strong>) binds this physical phone directly to your student account with cryptographic security.
                                        </p>
                                    </div>

                                    {isNative && hwInfo && !hwInfo.enrolled && (
                                        <div className="fp-settings-guidance-card">
                                            <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
                                                <FaInfoCircle style={{ color: "#0284c7", fontSize: "1.3rem", flexShrink: 0, marginTop: "2px" }} />
                                                <div style={{ flex: 1 }}>
                                                    <strong style={{ color: "#0369a1", fontSize: "0.92rem" }}>Fingerprint Setup Required in Phone Settings</strong>
                                                    <p style={{ margin: "4px 0 10px", fontSize: "0.84rem", color: "#0c4a6e", lineHeight: 1.45 }}>
                                                        Your phone requires at least one fingerprint registered in device settings before SmartAttend can bind your phone.
                                                    </p>
                                                    <button
                                                        type="button"
                                                        className="fp-open-settings-cta-btn"
                                                        onClick={async () => {
                                                            await openBiometricSettings();
                                                            setTimeout(refreshHwStatus, 3000);
                                                        }}
                                                    >
                                                        <FaCog /> Open Phone Security Settings to Add Fingerprint
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    <div className="fp-interactive-action-area">
                                        <button
                                            type="button"
                                            className="fp-primary-enroll-btn"
                                            onClick={() => handleEnrollFingerprint(false)}
                                            disabled={hwEnrolling}
                                        >
                                            {hwEnrolling ? (
                                                <>
                                                    <FaSpinner className="fa-spin" />
                                                    <span>Waiting for Fingerprint Sensor...</span>
                                                </>
                                            ) : (
                                                <>
                                                    <FaFingerprint className="pulse-icon" />
                                                    <span>Touch Sensor to Register Fingerprint In-App</span>
                                                </>
                                            )}
                                        </button>
                                    </div>

                                    {hwEnrollMsg && (
                                        <div className="face-enroll-status-success" style={{ marginTop: "16px" }}>
                                            <FaCheckCircle /> {hwEnrollMsg}
                                        </div>
                                    )}

                                    {hwEnrollError && (
                                        <div className="face-enroll-status-error-container" style={{ marginTop: "16px" }}>
                                            <div className="face-enroll-status-error">
                                                <FaExclamationTriangle /> <span>{hwEnrollError}</span>
                                            </div>
                                            {isNative && (hwEnrollError.includes("Settings") || hwEnrollError.includes("enrolled") || hwEnrollError.includes("No fingerprints")) && (
                                                <button
                                                    type="button"
                                                    className="fp-open-settings-cta-btn"
                                                    style={{ marginTop: "10px", width: "100%", justifyContent: "center" }}
                                                    onClick={async () => {
                                                        await openBiometricSettings();
                                                        setTimeout(refreshHwStatus, 3000);
                                                    }}
                                                >
                                                    <FaCog /> Open Phone Settings to Enroll Fingerprint
                                                </button>
                                            )}
                                        </div>
                                    )}

                                    <div className="fp-security-note">
                                        <FaInfoCircle />
                                        <span>
                                            <strong>Important Notice:</strong> Biometrics can only be enrolled once. After registration, this device is permanently locked to your account.
                                        </span>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
