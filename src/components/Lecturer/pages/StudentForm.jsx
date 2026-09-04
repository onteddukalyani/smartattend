import { doc, getDoc, setDoc, collection, query, where, getDocs } from "firebase/firestore";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
    FaUser,
    FaIdCard,
    FaCheckCircle,
    FaSpinner,
    FaChalkboardTeacher,
    FaArrowLeft,
    FaArrowRight
} from "react-icons/fa";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import FaceScanner from "./FaceScanner";
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

                if (!sessionData.ownerId) {
                    setSessionErrorMessage("This QR code is outdated. Please ask the lecturer to generate a new QR code.");
                    setSessionError(true);
                    setCheckingSession(false);
                    return;
                }

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
            // 1. Direct document ID lookup first
            const directSnap = await getDoc(doc(db, "users", targetRoll));
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

            // 2. Query users collection by uppercase rollNo
            const q = query(
                collection(db, "users"),
                where("rollNo", "==", targetRoll)
            );
            const snapshot = await getDocs(q);

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

            // 3. Query users collection by lowercase rollNo
            const qLower = query(
                collection(db, "users"),
                where("rollNo", "==", targetRoll.toLowerCase())
            );
            const snapLower = await getDocs(qLower);

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

            // 4. Check authorizedUsers by rollNo
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

            // 5. Check authorizedUsers direct document ID (email, e.g., 25bcs108@iiitdwd.ac.in)
            const possibleEmail = targetRoll.includes("@") ? targetRoll.toLowerCase() : `${targetRoll.toLowerCase()}@iiitdwd.ac.in`;
            const authDocSnap = await getDoc(doc(db, "authorizedUsers", possibleEmail)).catch(() => ({ exists: () => false }));
            if (authDocSnap.exists()) {
                const studentData = authDocSnap.data();
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

    const handleRollNoChange = (e) => {
        const upperVal = e.target.value.toUpperCase();
        setFormData((prev) => ({
            ...prev,
            rollNo: upperVal
        }));
        setLookupDone(false);
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

            if (!sessionData.ownerId) {
                alert("This QR code is outdated. Please ask the lecturer to generate a new QR code.");
                return;
            }

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

            // Save Attendance record with Roll Number considered first
            await setDoc(attendanceRef, {
                sessionId: sessionId,
                ownerId: sessionData.ownerId,
                courseCode: sessionData.courseCode || "N/A",
                classCode: sessionData.classCode || "N/A",
                roomNo: sessionData.roomNo || "N/A",
                rollNo: cleanRollNo,
                fullName: cleanFullName,
                studentEmail: user?.email?.toLowerCase().trim() || formData.email?.toLowerCase().trim() || "",
                studentUid: user?.uid || "",
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
            fullName: ""
        });
        setVerifiedStudent(null);
        setLookupDone(false);
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
                            Face Biometric Verification
                        </label>
                        <FaceScanner />
                    </div>
                </div>

                {/* Buttons */}
                <div className="button-group">
                    <button
                        className="save-btn"
                        type="submit"
                        disabled={submitting}
                    >
                        {submitting ? "Submitting..." : "Submit Attendance"}
                    </button>

                    <button
                        className="reset-btn"
                        type="button"
                        onClick={handleReset}
                    >
                        Reset
                    </button>
                </div>
            </form>
        </div>
    );
}

export default StudentForm;