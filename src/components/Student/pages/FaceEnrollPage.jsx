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
    FaLock
} from "react-icons/fa";
import { doc, setDoc, deleteField, onSnapshot } from "firebase/firestore";
import { Capacitor } from "@capacitor/core";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { LiveFaceEnrollment } from "../../Common/LiveFaceEnrollment";
import { checkDuplicateFaceBiometrics } from "../../../utils/biometricManager";
import {
    isHardwareBiometricAvailable,
    enrollHardwareBiometric,
    verifyHardwareBiometric
} from "../../../services/biometricService";
import "./FaceEnrollPage.css";

export default function FaceEnrollPage() {
    const navigate = useNavigate();
    const { user, profile } = useAuth();
    const [activeTab, setActiveTab] = useState("face"); // "face" | "fingerprint"

    // Real-time Enrollment Status
    const [hasFaceRegistered, setHasFaceRegistered] = useState(false);
    const [hasHwRegistered, setHasHwRegistered] = useState(false);
    const [faceSaving, setFaceSaving] = useState(false);
    const [faceSuccessMsg, setFaceSuccessMsg] = useState("");

    // Hardware Biometrics Enrollment State
    const [hwEnrolling, setHwEnrolling] = useState(false);
    const [hwEnrollMsg, setHwEnrollMsg] = useState("");
    const [hwEnrollError, setHwEnrollError] = useState("");
    const [hwTesting, setHwTesting] = useState(false);
    const [hwTestResult, setHwTestResult] = useState("");

    const emailRoll = (user?.email || "").split("@")[0].trim().toUpperCase();
    const activeRollNo = (profile?.rollNo || emailRoll || "").trim().toUpperCase();
    const studentName = profile?.name || profile?.fullName || activeRollNo || "Student";
    const cleanEmail = (user?.email || "").toLowerCase().trim();
    const isNative = Capacitor.isNativePlatform();
    const platform = Capacitor.getPlatform();

    // Live Snapshot for Real-Time Status Tracking
    useEffect(() => {
        if (!activeRollNo) return;
        const unsub = onSnapshot(doc(db, "students", activeRollNo), (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                setHasFaceRegistered(Boolean(data.faceRegistered || data.hasFaceRegistered || (data.faceDescriptor && data.faceDescriptor.length > 0)));
                setHasHwRegistered(Boolean(data.hardwareBiometricEnrolled || data.biometricEnrolled));
            }
        }, (err) => console.warn("Biometric status snap warning:", err));
        return () => unsub();
    }, [activeRollNo]);

    const handleFaceEnrolled = async (enrollData) => {
        if (!enrollData || !enrollData.faceDescriptor || !activeRollNo) return;

        // Security Lock: Prevent re-enrolling or editing once registered
        if (hasFaceRegistered) {
            alert("🔒 Biometrics Locked:\n\nYour facial biometrics are already registered and permanently protected. Students cannot re-enroll or edit biometrics.\n\nPlease contact your Course Lecturer or Administrator if an authorized reset is needed.");
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
                faceRemovedAt: deleteField(),
                enrolledAt: Date.now()
            };

            await setDoc(doc(db, "students", activeRollNo), updatePayload, { merge: true });
            await setDoc(doc(db, "users", activeRollNo), updatePayload, { merge: true }).catch(() => {});

            setHasFaceRegistered(true);
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
    const handleEnrollFingerprint = async () => {
        // Security Lock: Prevent re-enrolling or editing once registered
        if (hasHwRegistered) {
            alert("🔒 Biometrics Locked:\n\nYour device fingerprint is already registered and permanently protected. Students cannot re-enroll or edit biometrics.\n\nPlease contact your Course Lecturer or Administrator if an authorized reset is needed.");
            return;
        }

        try {
            setHwEnrolling(true);
            setHwEnrollError("");
            setHwEnrollMsg("");

            const res = await enrollHardwareBiometric(user?.uid || activeRollNo);
            if (res.success) {
                // Save hardware biometric enrollment status to Firestore
                const hwPayload = {
                    hardwareBiometricEnrolled: true,
                    hardwareBiometricPlatform: res.platform || platform,
                    hardwareBiometricEnrolledAt: Date.now(),
                    biometricEnrolled: true
                };
                await setDoc(doc(db, "students", activeRollNo), hwPayload, { merge: true });
                await setDoc(doc(db, "users", activeRollNo), hwPayload, { merge: true }).catch(() => {});

                setHasHwRegistered(true);
                setHwEnrollMsg("✅ Fingerprint & Device Biometrics Enrolled In-App Successfully!");
                setTimeout(() => setHwEnrollMsg(""), 4500);
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
                    <FaArrowLeft /> Back to Dashboard
                </button>
                <div className="top-badge">
                    <FaShieldAlt /> Biometric Hub
                </div>
            </div>

            {/* Direct In-App Biometrics Notice */}
            <div className="inapp-bio-guarantee-banner">
                <FaShieldAlt className="guarantee-icon" />
                <div>
                    <strong>100% In-App Biometric Registration</strong>
                    <p>
                        Both your <strong>3D Face Biometrics</strong> and <strong>Device Fingerprint</strong> are captured directly inside SmartAttend. No need to leave the app or change external phone settings.
                    </p>
                </div>
            </div>

            {/* 1. Dual-Biometric Status Overview Cards */}
            <div className="bio-status-overview-grid">
                <div
                    className={`bio-status-card ${hasFaceRegistered ? "enrolled" : "pending"} ${activeTab === "face" ? "active-tab-card" : ""}`}
                    onClick={() => setActiveTab("face")}
                    role="button"
                    tabIndex={0}
                >
                    <div className="bio-status-icon-wrap face-icon-wrap">
                        <FaCamera />
                    </div>
                    <div className="bio-status-info">
                        <div className="bio-status-label">1. Face Biometrics</div>
                        <div className="bio-status-title">
                            {hasFaceRegistered ? (
                                <span className="status-badge-enrolled"><FaCheckCircle /> Registered &amp; Active</span>
                            ) : (
                                <span className="status-badge-pending"><FaExclamationTriangle /> Not Registered</span>
                            )}
                        </div>
                        <p className="bio-status-desc">3D facial vector with live anti-spoofing</p>
                    </div>
                </div>

                <div
                    className={`bio-status-card ${hasHwRegistered ? "enrolled" : "pending"} ${activeTab === "fingerprint" ? "active-tab-card" : ""}`}
                    onClick={() => setActiveTab("fingerprint")}
                    role="button"
                    tabIndex={0}
                >
                    <div className="bio-status-icon-wrap fp-icon-wrap">
                        <FaFingerprint />
                    </div>
                    <div className="bio-status-info">
                        <div className="bio-status-label">2. Device Fingerprint</div>
                        <div className="bio-status-title">
                            {hasHwRegistered ? (
                                <span className="status-badge-enrolled"><FaCheckCircle /> Enrolled on Device</span>
                            ) : (
                                <span className="status-badge-pending"><FaExclamationTriangle /> Not Registered</span>
                            )}
                        </div>
                        <p className="bio-status-desc">Hardware security chip signature</p>
                    </div>
                </div>
            </div>

            {/* All-Set Congratulatory & Permanent Lock Banner */}
            {isAllRegistered && (
                <div className="bio-all-registered-banner bio-permanent-lock-banner">
                    <FaLock className="banner-icon lock-icon-main" />
                    <div>
                        <strong>Biometrics Permanently Locked &amp; Protected 🔒</strong>
                        <p>Both your 3D Face Biometrics and Device Fingerprint are officially registered under Roll No: <strong>{activeRollNo}</strong>. Self-editing and re-enrollment are permanently disabled.</p>
                    </div>
                </div>
            )}

            {/* Main Interactive Card */}
            <div className="face-enroll-card">
                {/* Tab Navigation Switcher */}
                <div className="bio-tabs-switcher" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === "face"}
                        className={`bio-tab-btn ${activeTab === "face" ? "active" : ""}`}
                        onClick={() => setActiveTab("face")}
                    >
                        <FaCamera /> Face Registration {hasFaceRegistered ? <FaLock className="tab-lock" /> : null}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === "fingerprint"}
                        className={`bio-tab-btn ${activeTab === "fingerprint" ? "active" : ""}`}
                        onClick={() => setActiveTab("fingerprint")}
                    >
                        <FaFingerprint /> Device Fingerprint {hasHwRegistered ? <FaLock className="tab-lock" /> : null}
                    </button>
                </div>

                {/* Tab 1: Live 3D Face Enrollment / Locked Card */}
                {activeTab === "face" && (
                    <div className="bio-tab-content">
                        {hasFaceRegistered ? (
                            <div className="bio-locked-state-card">
                                <div className="bio-locked-badge">
                                    <FaLock /> 3D Face Biometrics Locked
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
                                        <strong>One-Time Enrollment Policy Active 🔒</strong>
                                        <p>
                                            Your 128-dimensional facial biometric descriptors are officially registered. To prevent identity fraud and proxy attendance, students cannot re-record, modify, or delete their facial biometrics.
                                        </p>
                                    </div>
                                </div>

                                <div className="bio-locked-help-note">
                                    <FaInfoCircle /> If an authorized biometric reset is required due to hardware or enrollment errors, please contact your Course Lecturer or System Administrator.
                                </div>

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

                                    <div className="fp-interactive-action-area">
                                        <button
                                            type="button"
                                            className="fp-primary-enroll-btn"
                                            onClick={handleEnrollFingerprint}
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
                                        <div className="face-enroll-status-error" style={{ marginTop: "16px" }}>
                                            <FaExclamationTriangle /> {hwEnrollError}
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
