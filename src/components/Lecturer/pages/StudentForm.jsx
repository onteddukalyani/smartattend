import { doc, getDoc, setDoc, collection, query, where, getDocs } from "firebase/firestore";
import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
    FaUser,
    FaIdCard,
    FaCheckCircle,
    FaSpinner,
    FaChalkboardTeacher,
    FaArrowLeft,
    FaArrowRight,
    FaLock,
    FaShieldAlt
} from "react-icons/fa";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import FaceScanner from "./FaceScanner";
import { LiveFaceEnrollment } from "../../Common/LiveFaceEnrollment";
import './StudentForm.css';

function StudentForm() {
    const navigate = useNavigate();
    const { user, profile } = useAuth();

    const [formData, setFormData] = useState({
        image: "",
        rollNo: "",
        fullName: "",
        email: "",
        phone: "",
        branch: "",
        semester: "",
        dob: "",
        gender: "",
        bio: ""
    });
    const [sessionDetails, setSessionDetails] = useState(null);
    const [checkingSession, setCheckingSession] = useState(true);
    const [expired, setExpired] = useState(false);
    const [sessionError, setSessionError] = useState(false);
    const [sessionErrorMessage, setSessionErrorMessage] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [lookingUp, setLookingUp] = useState(false);
    const [verifiedStudent, setVerifiedStudent] = useState(null);
    const [lookupDone, setLookupDone] = useState(false);

    // Live Face Biometric Verification & Inline Enrollment State
    const [faceVerified, setFaceVerified] = useState(false);
    const [faceVerificationData, setFaceVerificationData] = useState(null);
    const [showInlineEnroll, setShowInlineEnroll] = useState(false);
    const [enrollSaving, setEnrollSaving] = useState(false);
    const [enrollSuccessMsg, setEnrollSuccessMsg] = useState("");

    // After-submission state
    const [submitted, setSubmitted] = useState(false);
    const [submissionDetails, setSubmissionDetails] = useState(null);
    const [countdown, setCountdown] = useState(2);

    const sessionId = new URLSearchParams(window.location.search).get("session");

    // Auto-prefill if student is already logged in or has saved roll number
    useEffect(() => {
        const storedRoll = localStorage.getItem("smartattend_student_roll");
        const rollToUse = profile?.rollNo || storedRoll || "";

        if (rollToUse && !formData.rollNo) {
            const cleanRoll = rollToUse.toUpperCase();
            setFormData((prev) => ({
                ...prev,
                rollNo: cleanRoll,
                fullName: profile?.name || prev.fullName,
                branch: profile?.branch || prev.branch,
                email: profile?.email || prev.email
            }));
            lookupStudentByRoll(cleanRoll);
        }
    }, [profile]);

    // Return to student dashboard countdown after successful submission
    useEffect(() => {
        if (!submitted) return;

        const interval = setInterval(() => {
            setCountdown((prev) => {
                if (prev <= 1) {
                    clearInterval(interval);
                    navigate("/student", { replace: true });
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);

        return () => clearInterval(interval);
    }, [submitted, navigate]);

    useEffect(() => {
        const checkSession = async () => {
            if (!sessionId) {
                setExpired(true);
                setCheckingSession(false);
                return;
            }

            try {
                const sessionRef = doc(
                    db,
                    "attendance_sessions",
                    sessionId
                );

                const sessionSnapshot = await getDoc(sessionRef);

                if (!sessionSnapshot.exists()) {
                    setExpired(true);
                    setCheckingSession(false);
                    return;
                }

                const sessionData = sessionSnapshot.data();
                setSessionDetails(sessionData);

                const currentTime = Date.now();

                if (
                    currentTime >= sessionData.expiresAt ||
                    sessionData.active === false
                ) {
                    setExpired(true);
                } else {
                    setExpired(false);

                    // Check again when the expiry time is reached
                    const remainingTime = sessionData.expiresAt - currentTime;

                    setTimeout(() => {
                        setExpired(true);
                    }, remainingTime);
                }

            } catch (error) {
                console.error("Error checking session:", error);
                setSessionError(true);
                setSessionErrorMessage("Check your internet connection and scan a newly generated QR code.");
            } finally {
                setCheckingSession(false);
            }
        };

        checkSession();
    }, [sessionId]);

    // Lookup registered student in Firestore by Roll Number
    const lookupStudentByRoll = async (rollToSearch) => {
        const targetRoll = (rollToSearch !== undefined ? rollToSearch : formData.rollNo).trim().toUpperCase();
        if (!targetRoll || targetRoll.length < 2) {
            setVerifiedStudent(null);
            setLookupDone(false);
            return;
        }

        setLookingUp(true);
        try {
            // 1. Direct document ID lookup in students collection
            const studentDirectSnap = await getDoc(doc(db, "students", targetRoll)).catch(() => ({ exists: () => false }));
            if (studentDirectSnap.exists()) {
                const studentData = studentDirectSnap.data();
                setVerifiedStudent(studentData);
                setLookupDone(true);
                if (studentData.name) {
                    setFormData((prev) => ({
                        ...prev,
                        fullName: studentData.name,
                        branch: studentData.branch || prev.branch,
                        email: studentData.email || prev.email
                    }));
                }
                return;
            }

            // 2. Direct document ID lookup in users collection
            const directSnap = await getDoc(doc(db, "users", targetRoll)).catch(() => ({ exists: () => false }));
            if (directSnap.exists()) {
                const studentData = directSnap.data();
                setVerifiedStudent(studentData);
                setLookupDone(true);
                if (studentData.name) {
                    setFormData((prev) => ({
                        ...prev,
                        fullName: studentData.name,
                        branch: studentData.branch || prev.branch,
                        email: studentData.email || prev.email
                    }));
                }
                return;
            }

            // 3. Query students collection by uppercase rollNo
            const studentRollQ = query(
                collection(db, "students"),
                where("rollNo", "==", targetRoll)
            );
            const studentRollSnap = await getDocs(studentRollQ).catch(() => ({ empty: true }));
            if (!studentRollSnap.empty) {
                const studentData = studentRollSnap.docs[0].data();
                setVerifiedStudent(studentData);
                setLookupDone(true);
                if (studentData.name) {
                    setFormData((prev) => ({
                        ...prev,
                        fullName: studentData.name,
                        branch: studentData.branch || prev.branch,
                        email: studentData.email || prev.email
                    }));
                }
                return;
            }

            // 4. Query users collection by uppercase rollNo
            const q = query(
                collection(db, "users"),
                where("rollNo", "==", targetRoll)
            );
            const snapshot = await getDocs(q).catch(() => ({ empty: true }));

            if (!snapshot.empty) {
                const studentData = snapshot.docs[0].data();
                setVerifiedStudent(studentData);
                setLookupDone(true);
                if (studentData.name) {
                    setFormData((prev) => ({
                        ...prev,
                        fullName: studentData.name,
                        branch: studentData.branch || prev.branch,
                        email: studentData.email || prev.email
                    }));
                }
                return;
            }

            // 5. Query users collection by lowercase rollNo
            const qLower = query(
                collection(db, "users"),
                where("rollNo", "==", targetRoll.toLowerCase())
            );
            const snapLower = await getDocs(qLower).catch(() => ({ empty: true }));

            if (!snapLower.empty) {
                const studentData = snapLower.docs[0].data();
                setVerifiedStudent(studentData);
                setLookupDone(true);
                if (studentData.name) {
                    setFormData((prev) => ({
                        ...prev,
                        fullName: studentData.name,
                        branch: studentData.branch || prev.branch,
                        email: studentData.email || prev.email
                    }));
                }
                return;
            }

            // 6. Check authorizedUsers by rollNo
            const authRollQuery = query(
                collection(db, "authorizedUsers"),
                where("rollNo", "==", targetRoll)
            );
            const authRollSnap = await getDocs(authRollQuery).catch(() => ({ empty: true }));
            if (!authRollSnap.empty) {
                const studentData = authRollSnap.docs[0].data();
                setVerifiedStudent(studentData);
                setLookupDone(true);
                if (studentData.name) {
                    setFormData((prev) => ({
                        ...prev,
                        fullName: studentData.name,
                        branch: studentData.branch || prev.branch,
                        email: studentData.email || prev.email
                    }));
                }
                return;
            }

            // 7. Check direct prefix / email document IDs in students & authorizedUsers
            const prefix = targetRoll.toLowerCase().trim();
            const possibleEmail = targetRoll.includes("@") ? targetRoll.toLowerCase() : `${prefix}@iiitdwd.ac.in`;

            const [authDocSnap, studentPrefixSnap, studentEmailSnap] = await Promise.all([
                getDoc(doc(db, "authorizedUsers", possibleEmail)).catch(() => ({ exists: () => false })),
                getDoc(doc(db, "students", prefix)).catch(() => ({ exists: () => false })),
                getDoc(doc(db, "students", possibleEmail)).catch(() => ({ exists: () => false }))
            ]);

            const matchedDoc = studentPrefixSnap.exists()
                ? studentPrefixSnap
                : (studentEmailSnap.exists() ? studentEmailSnap : (authDocSnap.exists() ? authDocSnap : null));

            if (matchedDoc) {
                const studentData = matchedDoc.data();
                setVerifiedStudent(studentData);
                setLookupDone(true);
                if (studentData.name) {
                    setFormData((prev) => ({
                        ...prev,
                        fullName: studentData.name,
                        branch: studentData.branch || prev.branch,
                        email: studentData.email || prev.email
                    }));
                }
                return;
            }

            setVerifiedStudent(null);
            setLookupDone(true);
        } catch (err) {
            console.error("Error looking up student by roll number:", err);
        } finally {
            setLookingUp(false);
        }
    };

    // Auto-lookup student as soon as roll number is typed on mobile/desktop
    useEffect(() => {
        if (!formData.rollNo || formData.rollNo.trim().length < 3) return;
        const timer = setTimeout(() => {
            lookupStudentByRoll(formData.rollNo);
        }, 300);
        return () => clearTimeout(timer);
    }, [formData.rollNo]);

    const handleFaceVerificationChange = useCallback((result) => {
        if (result && result.verified) {
            setFaceVerified(true);
            setFaceVerificationData(result);
        } else {
            setFaceVerified(false);
            setFaceVerificationData(result);
        }
    }, []);

    const handleInlineFaceEnrolled = async (enrollData) => {
        if (!enrollData || !enrollData.faceDescriptor) return;
        const targetRoll = formData.rollNo.trim().toUpperCase();
        if (!targetRoll) {
            alert("Please enter your roll number first.");
            return;
        }

        try {
            setEnrollSaving(true);
            const cleanEmail = (formData.email || user?.email || "").toLowerCase().trim();
            const prefix = cleanEmail ? cleanEmail.split("@")[0] : targetRoll.toLowerCase();

            const studentUpdate = {
                faceDescriptor: enrollData.faceDescriptor,
                photoURL: enrollData.photoURL,
                faceRegistered: true,
                biometricEnrolled: true,
                enrolledAt: Date.now()
            };

            // Write to Firestore across collections
            const promises = [
                setDoc(doc(db, "students", targetRoll), studentUpdate, { merge: true }),
                setDoc(doc(db, "users", targetRoll), studentUpdate, { merge: true })
            ];
            if (cleanEmail) {
                promises.push(setDoc(doc(db, "authorizedUsers", cleanEmail), studentUpdate, { merge: true }));
            }
            if (prefix && prefix !== targetRoll.toLowerCase()) {
                promises.push(setDoc(doc(db, "students", prefix), studentUpdate, { merge: true }).catch(() => { }));
            }

            await Promise.all(promises);

            // Update verifiedStudent state
            setVerifiedStudent((prev) => ({
                ...(prev || {}),
                name: prev?.name || formData.fullName || "Student",
                rollNo: targetRoll,
                ...studentUpdate
            }));

            // Mark face as verified for attendance
            setFaceVerified(true);
            setFaceVerificationData({
                verified: true,
                confidence: 99,
                distance: 0.05
            });

            setEnrollSuccessMsg("✅ Facial biometrics registered successfully! You can now submit your attendance.");
            setTimeout(() => {
                setShowInlineEnroll(false);
                setEnrollSuccessMsg("");
            }, 2500);
        } catch (err) {
            console.error("Error saving inline face biometric:", err);
            alert("Failed to save face biometric: " + err.message);
        } finally {
            setEnrollSaving(false);
        }
    };

    const handleRollNoChange = (e) => {
        const upperVal = e.target.value.toUpperCase();
        setFormData((prev) => ({
            ...prev,
            rollNo: upperVal
        }));
        setLookupDone(false);
        setFaceVerified(false);
        setFaceVerificationData(null);
    };

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData((currentData) => ({
            ...currentData,
            [name]: value
        }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        if (submitting) {
            return;
        }

        if (!sessionId) {
            alert("This QR code does not contain a session.");
            return;
        }

        const cleanRollNo = formData.rollNo.trim().toUpperCase();
        const cleanFullName = formData.fullName.trim();

        // 1. Consider Roll Number first
        if (!cleanRollNo) {
            alert("⚠️ Please enter your Roll Number.");
            return;
        }

        // 2. Consider Full Name second
        if (!cleanFullName) {
            alert("⚠️ Please enter your Full Name.");
            return;
        }

        // 3. ENFORCE LIVE FACE BIOMETRIC VERIFICATION
        if (!faceVerified) {
            if (verifiedStudent && (!verifiedStudent.faceDescriptor || !Array.isArray(verifiedStudent.faceDescriptor) || verifiedStudent.faceDescriptor.length !== 128)) {
                alert(`⛔ Face biometric is not registered for ${cleanFullName} (${cleanRollNo}).\n\nAttendance cannot be recorded until an Admin or Lecturer registers your facial biometric data.`);
            } else {
                alert(`❌ Live face biometric verification required!\n\nPlease position your face in the camera frame to match the registered template for Roll Number ${cleanRollNo}.`);
            }
            return;
        }

        setSubmitting(true);

        try {
            // Check session expiry again
            const sessionRef = doc(db, "attendance_sessions", sessionId);
            const sessionSnapshot = await getDoc(sessionRef);

            if (!sessionSnapshot.exists()) {
                alert("❌ QR Code has expired.");
                setExpired(true);
                return;
            }

            const sessionData = sessionSnapshot.data();

            if (
                Date.now() >= sessionData.expiresAt ||
                sessionData.active === false
            ) {
                alert("❌ QR Code has expired. Attendance is closed.");
                setExpired(true);
                return;
            }

            // Primary duplicate check using Roll Number
            const attendanceId = `${sessionId}_${cleanRollNo}`;
            const attendanceRef = doc(db, "attendance_records", attendanceId);
            const existingRecord = await getDoc(attendanceRef);

            if (existingRecord.exists()) {
                alert(`❌ Roll Number ${cleanRollNo} has already submitted attendance for this session.`);
                return;
            }

            const studentEmail = user?.email?.toLowerCase().trim() || formData.email?.toLowerCase().trim() || "";

            const resolvedBatch = (sessionData.batch && sessionData.batch.trim() !== "" && sessionData.batch !== "—") ? sessionData.batch : "2025";

            // Save Attendance record with verified facial biometric telemetry
            await setDoc(attendanceRef, {
                sessionId: sessionId,
                ownerId: sessionData.ownerId || sessionData.ownerEmail || sessionData.lecturerEmail || "system",
                lecturerName: sessionData.lecturerName || "",
                lecturerEmail: sessionData.lecturerEmail || sessionData.ownerEmail || "",
                courseCode: sessionData.courseCode || "N/A",
                classCode: sessionData.classCode || "N/A",
                batch: resolvedBatch,
                roomNo: sessionData.roomNo || "N/A",
                rollNo: cleanRollNo,
                fullName: cleanFullName,
                studentEmail: studentEmail,
                studentUid: user?.uid || "",
                faceVerified: true,
                faceMatchConfidence: faceVerificationData?.confidence || 100,
                faceDistance: faceVerificationData?.distance !== undefined ? Number(faceVerificationData.distance.toFixed(4)) : null,
                biometricVerifiedAt: Date.now(),
                submittedAt: Date.now()
            });

            // Persist the student's active roll number for immediate dashboard recognition
            localStorage.setItem("smartattend_student_roll", cleanRollNo);

            // Set submission success details to return to student dashboard
            setSubmissionDetails({
                rollNo: cleanRollNo,
                fullName: cleanFullName,
                courseCode: sessionData.courseCode || "N/A",
                classCode: sessionData.classCode || "N/A",
                batch: resolvedBatch,
                roomNo: sessionData.roomNo || "N/A"
            });
            setSubmitted(true);

        } catch (error) {
            console.error("Attendance error:", error);
            alert("❌ Could not save attendance: " + error.message);
        } finally {
            setSubmitting(false);
        }
    };

    const handleReset = () => {
        setFormData({
            rollNo: "",
            fullName: "",
            email: "",
            branch: "",
            semester: ""
        });
        setVerifiedStudent(null);
        setLookupDone(false);
        setFaceVerified(false);
        setFaceVerificationData(null);
    };

    // Success Screen: Returns to Student Dashboard
    if (submitted) {
        return (
            <div className="card student-form" style={{ textAlign: "center", padding: "40px 20px" }}>
                <div className="submission-success-card">
                    <div className="success-icon-wrap">
                        <FaCheckCircle className="success-check-icon" />
                    </div>
                    <h2>Attendance Marked Successfully!</h2>
                    <p className="success-subtitle">
                        Your presence has been recorded in the attendance register.
                    </p>

                    <div className="success-details-box">
                        <div className="success-detail-row">
                            <span>Roll Number:</span>
                            <strong>{submissionDetails?.rollNo}</strong>
                        </div>
                        <div className="success-detail-row">
                            <span>Student Name:</span>
                            <strong>{submissionDetails?.fullName}</strong>
                        </div>
                        {submissionDetails?.courseCode !== "N/A" && (
                            <div className="success-detail-row">
                                <span>Class / Subject:</span>
                                <strong>{submissionDetails?.courseCode} ({submissionDetails?.classCode})</strong>
                            </div>
                        )}
                        {submissionDetails?.roomNo !== "N/A" && (
                            <div className="success-detail-row">
                                <span>Room:</span>
                                <strong>Room {submissionDetails?.roomNo}</strong>
                            </div>
                        )}
                    </div>

                    <div className="redirect-countdown">
                        <FaSpinner className="fa-spin" />
                        <span>Returning to Student Dashboard in {countdown}s...</span>
                    </div>

                    <button
                        type="button"
                        className="return-dashboard-btn"
                        onClick={() => navigate("/student", { replace: true })}
                    >
                        Go to Student Dashboard Now <FaArrowRight style={{ marginLeft: "8px" }} />
                    </button>
                </div>
            </div>
        );
    }

    // Checking session
    if (checkingSession) {
        return (
            <div className="card student-form" style={{ textAlign: "center", padding: "60px 20px" }}>
                <h2>Checking QR Session...</h2>
            </div>
        );
    }

    // Expired or invalid QR
    if (sessionError) {
        return (
            <div className="card student-form" style={{ textAlign: "center", padding: "60px 20px" }}>
                <h2>Unable to use this QR session</h2>
                <p>{sessionErrorMessage}</p>
                {user && (
                    <button
                        type="button"
                        className="return-dashboard-btn"
                        style={{ marginTop: "20px" }}
                        onClick={() => navigate("/student")}
                    >
                        <FaArrowLeft style={{ marginRight: "8px" }} /> Return to Student Dashboard
                    </button>
                )}
            </div>
        );
    }

    if (expired) {
        return (
            <div className="card student-form" style={{ textAlign: "center", padding: "60px 20px" }}>
                <h2>❌ QR Code Expired</h2>
                <p>This attendance QR code is no longer valid.</p>
                <p>Please ask the lecturer to generate a new QR code.</p>
                {user && (
                    <button
                        type="button"
                        className="return-dashboard-btn"
                        style={{ marginTop: "20px" }}
                        onClick={() => navigate("/student")}
                    >
                        <FaArrowLeft style={{ marginRight: "8px" }} /> Return to Student Dashboard
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className="card student-form">
            <form onSubmit={handleSubmit}>
                {user && (
                    <div className="form-top-nav">
                        <button
                            type="button"
                            className="form-back-link"
                            onClick={() => navigate("/student")}
                        >
                            <FaArrowLeft /> Back to Student Dashboard
                        </button>
                    </div>
                )}
                {sessionDetails && (
                    <div className="session-badge">
                        <FaChalkboardTeacher />
                        <span>
                            {sessionDetails.courseCode || "Class"} • {sessionDetails.classCode || ""} • Room {sessionDetails.roomNo || "N/A"}
                        </span>
                    </div>
                )}

                <h1 className="form-title">Mark Attendance</h1>
                <p className="form-subtitle">Enter your Roll Number to register your presence.</p>

                <div className="form-grid">
                    {/* 1. Roll Number FIRST */}
                    <div className="input-group">
                        <label>Roll Number *</label>
                        <div className="input-icon">
                            <FaIdCard />
                            <input
                                type="text"
                                name="rollNo"
                                placeholder="Enter Roll Number (e.g. 23BCS001)"
                                value={formData.rollNo}
                                onChange={handleRollNoChange}
                                onBlur={() => lookupStudentByRoll()}
                                autoFocus
                                required
                            />
                        </div>

                        {/* Roll Number Lookup Status */}
                        {lookingUp && (
                            <div className="lookup-status loading">
                                <FaSpinner className="fa-spin" /> Looking up registered student...
                            </div>
                        )}

                        {!lookingUp && verifiedStudent && (
                            <div className="lookup-status verified">
                                <FaCheckCircle /> Verified: {verifiedStudent.name} ({verifiedStudent.branch || "Student"})
                            </div>
                        )}

                        {!lookingUp && lookupDone && !verifiedStudent && formData.rollNo.trim() && (
                            <div className="lookup-status unregistered">
                                Roll number not found in directory — enter your name below.
                            </div>
                        )}
                    </div>

                    {/* 2. Full Name SECOND */}
                    <div className="input-group">
                        <label>Full Name *</label>
                        <div className="input-icon">
                            <FaUser />
                            <input
                                type="text"
                                name="fullName"
                                placeholder="Enter Full Name"
                                value={formData.fullName}
                                onChange={handleChange}
                                required
                            />
                        </div>
                    </div>

                    {/* Biometric Face Verification Section */}
                    <div className="face-verification-section">
                        <label style={{ display: "block", marginBottom: "8px", fontWeight: 700 }}>
                            Live Face Biometric Verification *
                        </label>
                        <FaceScanner
                            verifiedStudent={verifiedStudent}
                            lookingUp={lookingUp}
                            rollNo={formData.rollNo}
                            onVerificationChange={handleFaceVerificationChange}
                            onEnrollRequest={() => setShowInlineEnroll(true)}
                        />

                        {/* Inline Face Enrollment Modal / Card */}
                        {showInlineEnroll && (
                            <div className="inline-enrollment-card" style={{
                                marginTop: "16px",
                                padding: "20px",
                                borderRadius: "16px",
                                background: "var(--surface, #ffffff)",
                                border: "2px solid #6366f1",
                                boxShadow: "0 8px 32px rgba(99, 102, 241, 0.2)",
                                animation: "formFadeIn 0.3s ease-out"
                            }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                                    <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 800, color: "#4f46e5" }}>
                                        📸 Register Biometric Face for {verifiedStudent?.name || formData.fullName || "Student"}
                                    </h3>
                                    <button
                                        type="button"
                                        onClick={() => setShowInlineEnroll(false)}
                                        style={{
                                            background: "transparent",
                                            border: "none",
                                            fontSize: "1.1rem",
                                            color: "var(--text-muted, #64748b)",
                                            cursor: "pointer"
                                        }}
                                    >
                                        ✕
                                    </button>
                                </div>
                                <p style={{ margin: "0 0 14px", fontSize: "0.85rem", color: "var(--text-muted, #64748b)" }}>
                                    Position your face centered in the camera and click <strong>"Capture & Register Biometrics"</strong>.
                                </p>
                                <LiveFaceEnrollment
                                    onFaceEnrolled={handleInlineFaceEnrolled}
                                />
                                {enrollSaving && (
                                    <div style={{ marginTop: "12px", textAlign: "center", color: "#6366f1", fontWeight: 700 }}>
                                        <FaSpinner className="fa-spin" /> Saving biometric vectors to database...
                                    </div>
                                )}
                                {enrollSuccessMsg && (
                                    <div style={{ marginTop: "12px", padding: "10px", background: "#dcfce7", color: "#15803d", borderRadius: "8px", fontWeight: 700, textAlign: "center" }}>
                                        {enrollSuccessMsg}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Buttons */}
                <div className="button-group">
                    <button
                        className="save-btn"
                        type="submit"
                        disabled={submitting || !faceVerified}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: "8px",
                            opacity: (submitting || !faceVerified) ? 0.7 : 1,
                            cursor: (submitting || !faceVerified) ? "not-allowed" : "pointer"
                        }}
                    >
                        {submitting ? (
                            <><FaSpinner className="fa-spin" /> Submitting Attendance...</>
                        ) : faceVerified ? (
                            <><FaCheckCircle /> Submit Attendance (Face Verified)</>
                        ) : (
                            <><FaLock /> Face Verification Required</>
                        )}
                    </button>

                    <button
                        className="reset-btn"
                        type="button"
                        onClick={handleReset}
                    >
                        Reset Form
                    </button>
                </div>
            </form>
        </div>
    );
}

export default StudentForm;