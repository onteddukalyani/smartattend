import { useState, useEffect } from "react";
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
    FaCog
} from "react-icons/fa";
import { doc, setDoc, deleteField, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { Capacitor } from "@capacitor/core";
import { db, functions } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { LiveFaceEnrollment } from "../../Common/LiveFaceEnrollment";
import FaceScanner from "../../Lecturer/pages/FaceScanner";
import { checkDuplicateFaceBiometrics } from "../../../utils/biometricManager";
import { Biometric } from "../../../plugins/biometric";
import {
    isHardwareBiometricAvailable,
    enrollHardwareBiometric,
    verifyHardwareBiometric,
    openBiometricSettings
} from "../../../services/biometricService";
import "./FaceEnrollPage.css";

export default function FaceEnrollPage() {
    const navigate = useNavigate();
    const { user, profile } = useAuth();
    const [activeTab, setActiveTab] = useState("face"); // "face" | "fingerprint"

    // Real-time Enrollment Status
    const [hasFaceRegistered, setHasFaceRegistered] = useState(false);
    const [registeredDescriptor, setRegisteredDescriptor] = useState(null);
    const [showFaceTest, setShowFaceTest] = useState(false);
    const [faceTestResult, setFaceTestResult] = useState("");
    const [isReEnrolling, setIsReEnrolling] = useState(false);
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

    const emailRoll = (user?.email || "").split("@")[0].trim().toUpperCase();
    const activeRollNo = (profile?.rollNo || emailRoll || "").trim().toUpperCase();
    const studentName = profile?.name || profile?.fullName || activeRollNo || "Student";
    const cleanEmail = (user?.email || "").toLowerCase().trim();
    const isNative = Capacitor.isNativePlatform();
    const platform = Capacitor.getPlatform();

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

    // Live Snapshot for Real-Time Status Tracking
    useEffect(() => {
        if (!activeRollNo) return;
        const localHwStatus = (
            localStorage.getItem(`smartattend_hw_enrolled_${activeRollNo}`) === "true" ||
            (user?.uid && localStorage.getItem(`smartattend_hw_enrolled_${user.uid}`) === "true") ||
            localStorage.getItem("smartattend_hw_enrolled") === "true"
        );
        if (localHwStatus) {
            setHasHwRegistered(true);
        }

        const unsub = onSnapshot(doc(db, "students", activeRollNo), (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                const validDescriptor = (
                    data.faceDescriptor &&
                    Array.isArray(data.faceDescriptor) &&
                    data.faceDescriptor.length === 128
                ) ? data.faceDescriptor : null;

                setRegisteredDescriptor(validDescriptor);
                setHasFaceRegistered(Boolean(validDescriptor));
                const hwEnrolled = Boolean(data.hardwareBiometricEnrolled) || localHwStatus;
                setHasHwRegistered(hwEnrolled);
                if (data.hardwareBiometricEnrolled) {
                    try {
                        localStorage.setItem(`smartattend_hw_enrolled_${activeRollNo}`, "true");
                        if (user?.uid) localStorage.setItem(`smartattend_hw_enrolled_${user.uid}`, "true");
                        localStorage.setItem("smartattend_hw_enrolled", "true");
                    } catch (_) {}
                }
            } else {
                setRegisteredDescriptor(null);
                setHasFaceRegistered(false);
                setHasHwRegistered(localHwStatus);
            }
        }, (err) => {
            console.warn("Biometric status snap warning:", err);
            if (localHwStatus) setHasHwRegistered(true);
        });
        return () => unsub();
    }, [activeRollNo, user?.uid]);

    const handleFaceEnrolled = async (enrollData) => {
        if (!enrollData || !enrollData.faceDescriptor || !activeRollNo) return;

        // Security Lock: Allow if not registered or if explicitly re-enrolling
        if (hasFaceRegistered && !isReEnrolling) {
            alert("🔒 Biometrics Locked:\n\nYour facial biometrics are already registered and permanently protected. To update, tap 'Re-Enroll Face Biometrics'.");
            return;
        }

        try {
            setFaceSaving(true);
            const rawVector = enrollData.faceDescriptor;
            const cleanVector = Array.isArray(rawVector) ? rawVector : Array.from(rawVector);

            // Check duplicate face biometrics against registry
            const duplicateCheck = await checkDuplicateFaceBiometrics(cleanVector, activeRollNo, cleanEmail);
            if (duplicateCheck.isDuplicate && duplicateCheck.conflictStudent) {
                const cs = duplicateCheck.conflictStudent;
                alert(`⛔ Duplicate Face Detected!\n\nThis face matches registered student "${cs.name}" (${cs.rollNo} • ${cs.confidence}% Match).\n\nSystem policy strictly prohibits multiple students from using the same facial biometrics.`);
                setFaceSaving(false);
                return;
            }

            let cloudSaved = false;
            try {
                const regFn = httpsCallable(functions, "registerStudentFace");
                const res = await regFn({
                    rollNo: activeRollNo,
                    faceDescriptor: cleanVector,
                    photoURL: enrollData.photoURL || profile?.photoURL || ""
                });
                if (res && res.data && res.data.success) {
                    cloudSaved = true;
                }
            } catch (cloudErr) {
                console.warn("Cloud function registerStudentFace fallback notice:", cloudErr.message || cloudErr);
            }

            if (!cloudSaved) {
                const updatePayload = {
                    rollNo: activeRollNo,
                    name: studentName,
                    email: cleanEmail,
                    branch: profile?.branch || "CSE",
                    semester: profile?.semester || "1",
                    role: "student",
                    status: "active",
                    faceDescriptor: cleanVector,
                    photoURL: enrollData.photoURL || profile?.photoURL || "",
                    faceRegistered: true,
                    biometricEnrolled: true,
                    hasFaceRegistered: true,
                    studentUid: user?.uid || null,
                    faceRemovedAt: deleteField(),
                    enrolledAt: Date.now()
                };

                await setDoc(doc(db, "students", activeRollNo), updatePayload, { merge: true });
                if (user?.uid) {
                    await setDoc(doc(db, "users", user.uid), updatePayload, { merge: true }).catch(() => {});
                }
                await setDoc(doc(db, "users", activeRollNo), updatePayload, { merge: true }).catch(() => {});
            }

            setHasFaceRegistered(true);
            setRegisteredDescriptor(cleanVector);
            setIsReEnrolling(false);
            setShowFaceTest(false);
            setFaceSuccessMsg("✅ Face biometrics registered & saved! Next: Register your Device Fingerprint below.");
            setTimeout(() => {
                setFaceSuccessMsg("");
                setActiveTab("fingerprint");
            }, 2500);
        } catch (err) {
            console.error("Error saving face biometrics:", err);
            alert("Failed to save face biometrics: " + err.message);
        } finally {
            setFaceSaving(false);
        }
    };

    // In-App Fingerprint / Device Biometrics Registration Handler
    const handleEnrollFingerprint = async (isRebind = false) => {
        // Security Lock: Prevent re-enrolling or editing once registered unless re-binding this phone's keystore
        if (hasHwRegistered && !isRebind) {
            alert("🔒 Biometrics Locked:\n\nYour device fingerprint is already registered and permanently protected. Students cannot re-enroll or edit biometrics.\n\nPlease contact your Course Lecturer or Administrator if an authorized reset is needed.");
            return;
        }

        try {
            setHwEnrolling(true);
            setHwEnrollError("");
            setHwEnrollMsg("");

            const res = await enrollHardwareBiometric(user?.uid || activeRollNo);
            if (res.success) {
                // Save hardware biometric enrollment and device registration status to Firestore
                const regPlatform = res.platform || platform || (isNative ? "android" : "web");
                const hwPayload = {
                    hardwareBiometricEnrolled: true,
                    hardwareBiometricPlatform: regPlatform,
                    hardwareBiometricEnrolledAt: Date.now(),
                    biometricEnrolled: true,
                    studentUid: user?.uid || null,
                    isDeviceRegistered: true,
                    deviceType: regPlatform,
                    registeredPlatform: regPlatform,
                    registeredDeviceType: regPlatform,
                    deviceTypeLocked: true,
                    deviceSelectedAt: Date.now(),
                    updatedAt: Date.now()
                };

                // Link to canonical students/{activeRollNo}
                if (activeRollNo) {
                    await setDoc(doc(db, "students", activeRollNo), hwPayload, { merge: true }).catch((err) => {
                        console.warn("Could not save to students/" + activeRollNo, err);
                    });
                }

                // Link to users/{user.uid} (authenticated Firebase user doc)
                if (user?.uid) {
                    await setDoc(doc(db, "users", user.uid), hwPayload, { merge: true }).catch((err) => {
                        console.warn("Could not save to users/" + user.uid, err);
                    });
                }

                // Also try users/{activeRollNo} if distinct
                if (activeRollNo && user?.uid !== activeRollNo) {
                    await setDoc(doc(db, "users", activeRollNo), hwPayload, { merge: true }).catch(() => {});
                }

                // Link to students/{user.uid} if distinct
                if (user?.uid && user.uid !== activeRollNo) {
                    await setDoc(doc(db, "students", user.uid), hwPayload, { merge: true }).catch(() => {});
                }

                // Persist locally so it's instantly active across restarts and UI components
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
                setHwEnrollError(res.message || "Failed to register fingerprint. Please try again.");
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
                                
                                <div className="bio-locked-alert-box">
                                    <FaLock className="lock-inline-icon" />
                                    <div>
                                        <strong>Biometric Vector Authenticated 🛡️</strong>
                                        <p>
                                            Your 128-dimensional facial biometric profile is active and verified for attendance. You can test face recognition below or update your biometrics if needed.
                                        </p>
                                    </div>
                                </div>

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

                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (window.confirm("Do you want to re-record your 3D facial biometrics? This will replace your previous facial template with a fresh live scan.")) {
                                                setShowFaceTest(false);
                                                setIsReEnrolling(true);
                                            }
                                        }}
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "8px",
                                            padding: "10px 18px",
                                            borderRadius: "10px",
                                            background: "var(--surface-soft, #f1f5f9)",
                                            color: "var(--text-main, #0f172a)",
                                            border: "1.5px solid var(--border, #cbd5e1)",
                                            fontWeight: 700,
                                            fontSize: "0.88rem",
                                            cursor: "pointer"
                                        }}
                                    >
                                        <FaRedo /> Re-Enroll Face Biometrics
                                    </button>
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

                                        <FaceScanner
                                            verifiedStudent={{
                                                name: studentName,
                                                rollNo: activeRollNo,
                                                faceDescriptor: registeredDescriptor || profile?.faceDescriptor
                                            }}
                                            rollNo={activeRollNo}
                                            onVerificationChange={(res) => {
                                                if (res && res.verified) {
                                                    setFaceTestResult(`✅ Face Verified! Match Confidence: ${res.confidence}% • Liveness Confirmed 🛡️`);
                                                }
                                            }}
                                        />

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
                                        targetRollNo={activeRollNo}
                                        targetEmail={cleanEmail}
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

                                <div className="bio-locked-alert-box">
                                    <FaLock className="lock-inline-icon" />
                                    <div>
                                        <strong>Hardware Signature Locked 🔒</strong>
                                        <p>
                                            This physical device is cryptographically bound to Roll No: <strong>{activeRollNo}</strong>. Students cannot re-register, switch, or overwrite the registered biometric key. Attendance must be signed from this authorized device.
                                        </p>
                                    </div>
                                </div>

                                {isNative && !keyExistsOnDevice && (
                                    <div className="fp-rebind-warning-box">
                                        <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
                                            <FaExclamationTriangle style={{ color: "#d97706", fontSize: "1.4rem", flexShrink: 0, marginTop: "2px" }} />
                                            <div>
                                                <strong style={{ color: "#92400e", fontSize: "0.95rem" }}>Phone Keystore Not Yet Initialized</strong>
                                                <p style={{ margin: "4px 0 10px", fontSize: "0.85rem", color: "#b45309", lineHeight: 1.45 }}>
                                                    Your account has hardware biometrics enrolled in the database, but this phone does not have the hardware signature key in its keystore yet. Tap below to bind this phone now:
                                                </p>
                                                <button
                                                    type="button"
                                                    className="fp-primary-enroll-btn"
                                                    onClick={() => handleEnrollFingerprint(true)}
                                                    disabled={hwEnrolling}
                                                    style={{ padding: "10px 18px", fontSize: "0.9rem" }}
                                                >
                                                    {hwEnrolling ? (
                                                        <><FaSpinner className="fa-spin" /> <span>Waiting for Fingerprint...</span></>
                                                    ) : (
                                                        <><FaFingerprint /> <span>Touch Sensor to Bind This Phone</span></>
                                                    )}
                                                </button>
                                            </div>
                                        </div>
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
                                    <FaInfoCircle /> If you lost or replaced your physical phone, request a device reset through your Course Lecturer or Administrator.
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
