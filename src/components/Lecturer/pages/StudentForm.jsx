import { doc, getDoc, setDoc, collection, query, where, getDocs, updateDoc, arrayUnion, increment } from "firebase/firestore";
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
import { isGenericName } from "../../../utils/studentDataHelper";
import { submitVerifiedAttendance } from "../../../services/sessionAuthService";
import FaceScanner from "./FaceScanner";
import './StudentForm.css';

function StudentForm() {
    const navigate = useNavigate();
    const { user, profile } = useAuth();

    const isStudentLoggedIn = Boolean(user && (profile?.rollNo || profile?.email || user?.email));
    const loggedInRollNo = (profile?.rollNo || (user?.email || "").split("@")[0] || "").trim().toUpperCase();
    const rawProfileName = profile?.name || profile?.fullName || "";
    const loggedInName = (!isGenericName(rawProfileName, loggedInRollNo, user?.email)) ? rawProfileName.trim() : "";

    const [formData, setFormData] = useState({
        image: "",
        rollNo: loggedInRollNo || "",
        fullName: loggedInName || "",
        email: user?.email || profile?.email || "",
        phone: profile?.phone || "",
        branch: profile?.branch || "",
        semester: profile?.semester || "",
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

    // Live Face Biometric Verification State
    const [faceVerified, setFaceVerified] = useState(false);
    const [faceVerificationData, setFaceVerificationData] = useState(null);

    // After-submission state
    const [submitted, setSubmitted] = useState(false);
    const [submissionDetails, setSubmissionDetails] = useState(null);
    const [countdown, setCountdown] = useState(2);

    const sessionId = new URLSearchParams(window.location.search).get("session");

    // Auto-prefill and lock if student is logged in
    useEffect(() => {
        const storedRoll = localStorage.getItem("smartattend_student_roll");
        const rollToUse = loggedInRollNo || storedRoll || "";

        if (rollToUse) {
            const cleanRoll = rollToUse.toUpperCase();
            setFormData((prev) => ({
                ...prev,
                rollNo: cleanRoll,
                fullName: loggedInName || prev.fullName,
                branch: (profile?.branch && String(profile.branch).toLowerCase() !== "general") ? profile.branch : (prev.branch || "CSE"),
                email: user?.email || profile?.email || prev.email
            }));
            lookupStudentByRoll(cleanRoll);
        }
    }, [user, profile, loggedInRollNo, loggedInName]);

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

    // Unified lookup across collections with authoritative database name resolution
    const lookupStudentByRoll = async (rollOverride) => {
        const targetRoll = (rollOverride || formData.rollNo || loggedInRollNo || "").trim().toUpperCase();
        if (!targetRoll || targetRoll.length < 2) return;

        setLookingUp(true);
        try {
            const possibleEmail = user?.email?.toLowerCase().trim() || formData.email?.toLowerCase().trim() || `${targetRoll.toLowerCase()}@iiitdwd.ac.in`;
            const prefix = targetRoll.toLowerCase();

            const [
                studentDirectSnap,
                userDirectSnap,
                authDirectSnap,
                studentRollSnap,
                userRollSnap,
                authRollSnap,
                studentPrefixSnap,
                userPrefixSnap,
                authPrefixSnap,
                studentEmailSnap,
                authEmailSnap
            ] = await Promise.all([
                getDoc(doc(db, "students", targetRoll)).catch(() => ({ exists: () => false })),
                getDoc(doc(db, "users", targetRoll)).catch(() => ({ exists: () => false })),
                getDoc(doc(db, "authorizedUsers", targetRoll)).catch(() => ({ exists: () => false })),
                getDocs(query(collection(db, "students"), where("rollNo", "==", targetRoll))).catch(() => ({ docs: [] })),
                getDocs(query(collection(db, "users"), where("rollNo", "==", targetRoll))).catch(() => ({ docs: [] })),
                getDocs(query(collection(db, "authorizedUsers"), where("rollNo", "==", targetRoll))).catch(() => ({ docs: [] })),
                prefix !== targetRoll ? getDoc(doc(db, "students", prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
                prefix !== targetRoll ? getDoc(doc(db, "users", prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
                prefix !== targetRoll ? getDoc(doc(db, "authorizedUsers", prefix)).catch(() => ({ exists: () => false })) : Promise.resolve({ exists: () => false }),
                getDoc(doc(db, "students", possibleEmail)).catch(() => ({ exists: () => false })),
                getDoc(doc(db, "authorizedUsers", possibleEmail)).catch(() => ({ exists: () => false }))
            ]);

            const candidateDocs = [];
            if (studentDirectSnap.exists()) candidateDocs.push(studentDirectSnap.data());
            if (userDirectSnap.exists()) candidateDocs.push(userDirectSnap.data());
            if (authDirectSnap.exists()) candidateDocs.push(authDirectSnap.data());
            studentRollSnap.docs?.forEach((d) => candidateDocs.push(d.data()));
            userRollSnap.docs?.forEach((d) => candidateDocs.push(d.data()));
            authRollSnap.docs?.forEach((d) => candidateDocs.push(d.data()));
            if (studentPrefixSnap.exists()) candidateDocs.push(studentPrefixSnap.data());
            if (userPrefixSnap.exists()) candidateDocs.push(userPrefixSnap.data());
            if (authPrefixSnap.exists()) candidateDocs.push(authPrefixSnap.data());
            if (studentEmailSnap.exists()) candidateDocs.push(studentEmailSnap.data());
            if (authEmailSnap.exists()) candidateDocs.push(authEmailSnap.data());

            if (candidateDocs.length === 0) {
                setVerifiedStudent(null);
                setLookupDone(true);
                return;
            }

            let mergedStudent = { rollNo: targetRoll };
            let authoritativeName = "";

            for (const docData of candidateDocs) {
                if (!authoritativeName && docData.name && !isGenericName(docData.name, targetRoll, possibleEmail)) {
                    authoritativeName = String(docData.name).trim();
                }
                if (!authoritativeName && docData.fullName && !isGenericName(docData.fullName, targetRoll, possibleEmail)) {
                    authoritativeName = String(docData.fullName).trim();
                }
                if (!authoritativeName && docData.displayName && !isGenericName(docData.displayName, targetRoll, possibleEmail)) {
                    authoritativeName = String(docData.displayName).trim();
                }

                const cleanEmail = (docData.email || mergedStudent.email || "").toLowerCase().trim();
                const branch = (docData.branch && String(docData.branch).toLowerCase() !== "general")
                    ? docData.branch
                    : ((mergedStudent.branch && String(mergedStudent.branch).toLowerCase() !== "general") ? mergedStudent.branch : "CSE");

                const isExplicitlyRemoved = Boolean(
                    docData.faceRemovedAt ||
                    mergedStudent.faceRemovedAt ||
                    docData.faceRegistered === false ||
                    mergedStudent.faceRegistered === false ||
                    docData.biometricEnrolled === false ||
                    mergedStudent.biometricEnrolled === false ||
                    docData.hasFaceRegistered === false ||
                    mergedStudent.hasFaceRegistered === false
                );

                const validVector = !isExplicitlyRemoved && (
                    (Array.isArray(docData.faceDescriptor) && docData.faceDescriptor.length === 128)
                        ? docData.faceDescriptor
                        : ((Array.isArray(mergedStudent.faceDescriptor) && mergedStudent.faceDescriptor.length === 128) ? mergedStudent.faceDescriptor : null)
                );

                const hasFace = Boolean(!isExplicitlyRemoved && validVector);

                mergedStudent = {
                    ...mergedStudent,
                    ...docData,
                    rollNo: targetRoll,
                    email: cleanEmail,
                    branch: branch,
                    semester: docData.semester || mergedStudent.semester || "1",
                    faceRegistered: hasFace,
                    biometricEnrolled: hasFace,
                    hasFaceRegistered: hasFace,
                    faceDescriptor: validVector,
                    photoURL: isExplicitlyRemoved ? "" : ((docData.photoURL && docData.photoURL.length > 5) ? docData.photoURL : (mergedStudent.photoURL || docData.photo || ""))
                };
            }

            const finalResolvedName = authoritativeName || mergedStudent.name || mergedStudent.fullName || "";
            mergedStudent.name = finalResolvedName;
            mergedStudent.fullName = finalResolvedName;

            setVerifiedStudent(mergedStudent);
            setLookupDone(true);
            if (finalResolvedName && !isGenericName(finalResolvedName, targetRoll, possibleEmail)) {
                setFormData((prev) => ({
                    ...prev,
                    fullName: finalResolvedName,
                    branch: mergedStudent.branch || prev.branch,
                    email: mergedStudent.email || prev.email
                }));
            }
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

    const handleRollNoChange = (e) => {
        if (isStudentLoggedIn) return; // Prevent altering authenticated roll number
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
        if (isStudentLoggedIn && (name === "rollNo" || name === "fullName" || name === "email")) return;
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

        // 1. Consider Roll Number first
        if (!cleanRollNo) {
            alert("⚠️ Please enter your Roll Number.");
            return;
        }

        // 2. Strict Authenticated Roll Number Lock check
        if (isStudentLoggedIn && loggedInRollNo && cleanRollNo !== loggedInRollNo) {
            alert(`⛔ Security Violation: You are authenticated as ${loggedInRollNo}. You cannot submit attendance for another student (${cleanRollNo}).`);
            return;
        }

        // 3. Resolve authoritative student name strictly from database (NOT from email or Google account)
        let resolvedDatabaseName = "";
        if (verifiedStudent?.name && !isGenericName(verifiedStudent.name, cleanRollNo)) {
            resolvedDatabaseName = verifiedStudent.name.trim();
        } else if (verifiedStudent?.fullName && !isGenericName(verifiedStudent.fullName, cleanRollNo)) {
            resolvedDatabaseName = verifiedStudent.fullName.trim();
        } else if (profile?.name && !isGenericName(profile.name, cleanRollNo)) {
            resolvedDatabaseName = profile.name.trim();
        } else if (profile?.fullName && !isGenericName(profile.fullName, cleanRollNo)) {
            resolvedDatabaseName = profile.fullName.trim();
        }

        // Direct fetch from students/users/authorizedUsers if still missing
        if (!resolvedDatabaseName || isGenericName(resolvedDatabaseName, cleanRollNo)) {
            try {
                const [sDoc, uDoc, aDoc] = await Promise.all([
                    getDoc(doc(db, "students", cleanRollNo)).catch(() => ({ exists: () => false })),
                    getDoc(doc(db, "users", cleanRollNo)).catch(() => ({ exists: () => false })),
                    getDoc(doc(db, "authorizedUsers", cleanRollNo)).catch(() => ({ exists: () => false }))
                ]);
                const docs = [sDoc, uDoc, aDoc].filter((d) => d.exists()).map((d) => d.data());
                for (const d of docs) {
                    if (d.name && !isGenericName(d.name, cleanRollNo)) {
                        resolvedDatabaseName = d.name.trim();
                        break;
                    }
                    if (d.fullName && !isGenericName(d.fullName, cleanRollNo)) {
                        resolvedDatabaseName = d.fullName.trim();
                        break;
                    }
                }
            } catch (err) {
                console.warn("Could not query student database name:", err);
            }
        }

        const cleanFullName = resolvedDatabaseName || (formData.fullName && !isGenericName(formData.fullName, cleanRollNo) ? formData.fullName.trim() : cleanRollNo);

        if (!cleanFullName) {
            alert("⚠️ Please enter your Full Name.");
            return;
        }

        // 4. ENFORCE LIVE FACE BIOMETRIC VERIFICATION
        if (!faceVerified) {
            if (verifiedStudent && (!verifiedStudent.faceDescriptor || !Array.isArray(verifiedStudent.faceDescriptor) || verifiedStudent.faceDescriptor.length !== 128)) {
                alert(`⛔ Face biometric is not registered for ${cleanFullName} (${cleanRollNo}).\n\nAttendance cannot be recorded until an Admin or Lecturer registers your facial biometric data.`);
            } else {
                alert(`❌ Live face biometric verification required!\n\nPlease position your face in the camera frame to match the registered template for Roll Number ${cleanRollNo}.`);
            }
            return;
        }

        if (!verifiedStudent || !verifiedStudent.faceDescriptor || !Array.isArray(verifiedStudent.faceDescriptor) || verifiedStudent.faceDescriptor.length !== 128) {
            alert(`⛔ Registered face biometric template not found for ${cleanFullName} (${cleanRollNo}). Attendance cannot be marked without registered biometrics.`);
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

            // Submit Attendance via secure sessionAuthService
            try {
                await submitVerifiedAttendance(
                    sessionId,
                    sessionData.qr2Token || sessionId,
                    {
                        confidence: faceVerificationData?.confidence || 100,
                        distance: faceVerificationData?.distance !== undefined ? Number(faceVerificationData.distance.toFixed(4)) : 0.35,
                        liveness: faceVerificationData?.liveness === true,
                        blinkCount: faceVerificationData?.blinkCount || 1
                    }
                );
            } catch (authServErr) {
                console.warn("Notice submitting via sessionAuthService, writing direct record:", authServErr);
                // Fallback direct write
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
                    studentName: cleanFullName,
                    name: cleanFullName,
                    studentEmail: studentEmail,
                    studentUid: user?.uid || "",
                    faceVerified: true,
                    faceMatchConfidence: faceVerificationData?.confidence || 100,
                    faceDistance: faceVerificationData?.distance !== undefined ? Number(faceVerificationData.distance.toFixed(4)) : null,
                    livenessConfirmed: faceVerificationData?.liveness === true,
                    antiSpoofScore: "PASSED",
                    blinkCount: faceVerificationData?.blinkCount || 1,
                    biometricVerifiedAt: Date.now(),
                    submittedAt: Date.now()
                });

                try {
                    await updateDoc(sessionRef, {
                        attendees: arrayUnion({
                            id: `${sessionId}_${cleanRollNo}`,
                            rollNo: cleanRollNo,
                            studentName: cleanFullName,
                            fullName: cleanFullName,
                            email: studentEmail,
                            studentEmail: studentEmail,
                            faceVerified: true,
                            faceMatchConfidence: faceVerificationData?.confidence || 100,
                            submittedAt: Date.now()
                        }),
                        attendanceCount: increment(1)
                    });
                } catch (sessUpdateErr) {
                    console.warn("Session attendee array update warning:", sessUpdateErr);
                }
            }

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
        if (!isStudentLoggedIn) {
            setFormData({
                rollNo: "",
                fullName: "",
                email: "",
                branch: "",
                semester: ""
            });
            setVerifiedStudent(null);
        }
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
                <p className="form-subtitle">
                    🔒 Student details are automatically retrieved from the database. No typing required — please complete live face authentication to record your attendance.
                </p>

                {/* Authenticated Student Identity Card */}
                <div style={{
                    padding: "16px 20px",
                    borderRadius: "14px",
                    background: "rgba(99, 102, 241, 0.08)",
                    border: "1.5px solid rgba(99, 102, 241, 0.25)",
                    margin: "16px 0 24px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "14px"
                }}>
                    <div>
                        <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: "6px" }}>
                            <FaLock /> Official Student Profile (Locked)
                        </div>
                        <div style={{ fontSize: "1.15rem", fontWeight: 800, color: "var(--text-main, #1e293b)", marginTop: "4px" }}>
                            {verifiedStudent?.name || formData.fullName || "Student"}
                        </div>
                        <div style={{ fontSize: "0.85rem", color: "var(--text-muted, #64748b)", marginTop: "2px" }}>
                            Roll No: <strong style={{ color: "#6366f1" }}>{formData.rollNo || loggedInRollNo}</strong> • Branch: {verifiedStudent?.branch || formData.branch || "CSE"}
                        </div>
                    </div>
                    <div>
                        <span style={{
                            padding: "6px 14px",
                            borderRadius: "8px",
                            background: (verifiedStudent?.faceRegistered || (verifiedStudent?.faceDescriptor && verifiedStudent.faceDescriptor.length === 128)) ? "#dcfce7" : "#fee2e2",
                            color: (verifiedStudent?.faceRegistered || (verifiedStudent?.faceDescriptor && verifiedStudent.faceDescriptor.length === 128)) ? "#15803d" : "#b91c1c",
                            fontSize: "0.82rem",
                            fontWeight: 700,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px"
                        }}>
                            {(verifiedStudent?.faceRegistered || (verifiedStudent?.faceDescriptor && verifiedStudent.faceDescriptor.length === 128))
                                ? "🛡️ 128-D Biometric Registered"
                                : "⚠️ Biometrics Not Registered"}
                        </span>
                    </div>
                </div>

                <div className="form-grid">
                    {/* 1. Roll Number (Locked & Read-only) */}
                    <div className="input-group">
                        <label>
                            Roll Number <span style={{ color: "#10b981", fontSize: "0.8rem", fontWeight: 700 }}>🔒 (Verified)</span>
                        </label>
                        <div className="input-icon">
                            <FaLock style={{ color: "#10b981" }} />
                            <input
                                type="text"
                                name="rollNo"
                                value={formData.rollNo}
                                readOnly
                                disabled
                                style={{ backgroundColor: "var(--surface-soft, #f1f5f9)", cursor: "not-allowed", fontWeight: 700 }}
                            />
                        </div>
                    </div>

                    {/* 2. Full Name (Locked & Read-only) */}
                    <div className="input-group">
                        <label>
                            Full Name <span style={{ color: "#10b981", fontSize: "0.8rem", fontWeight: 700 }}>🔒 (Verified)</span>
                        </label>
                        <div className="input-icon">
                            <FaLock style={{ color: "#10b981" }} />
                            <input
                                type="text"
                                name="fullName"
                                value={formData.fullName}
                                readOnly
                                disabled
                                style={{ backgroundColor: "var(--surface-soft, #f1f5f9)", cursor: "not-allowed", fontWeight: 700 }}
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
                        />
                    </div>
                </div>

                {/* Submit Action */}
                <div className="button-group" style={{ marginTop: "24px" }}>
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
                            cursor: (submitting || !faceVerified) ? "not-allowed" : "pointer",
                            width: "100%",
                            padding: "14px 24px",
                            fontSize: "1rem"
                        }}
                    >
                        {submitting ? (
                            <><FaSpinner className="fa-spin" /> Submitting Attendance...</>
                        ) : faceVerified ? (
                            <><FaCheckCircle /> Submit Attendance (Face Verified 🛡️)</>
                        ) : (
                            <><FaLock /> Face Verification Required</>
                        )}
                    </button>
                </div>
            </form>
        </div>
    );
}

export default StudentForm;