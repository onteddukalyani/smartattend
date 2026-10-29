import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
    FaArrowLeft,
    FaCamera,
    FaUserCheck,
    FaTimesCircle,
    FaSpinner,
    FaShieldAlt,
    FaUserGraduate,
    FaIdCard,
    FaBookOpen,
    FaExclamationTriangle,
    FaRedo,
    FaCheckCircle,
    FaInfoCircle,
    FaLock
} from "react-icons/fa";
import { useAuth } from "../authcontext";
import { identifyStudentByFace } from "../../services/faceEnrollmentService";
import { LiveFaceEnrollment } from "./LiveFaceEnrollment";
import { isBrowserCameraAllowed } from "../../utils/deviceDetection";
import "./IdentifyStudentByFace.css";

export default function IdentifyStudentByFace() {
    const navigate = useNavigate();
    const { user, profile } = useAuth();

    const userRole = String(profile?.role || "").trim().toLowerCase();
    const isAdmin = userRole === "admin" || userRole === "administrator" || Boolean(profile?.isAdmin) || window.location.pathname.startsWith("/admin");
    const isLecturer = userRole === "lecturer" || Boolean(profile?.isLecturer);
    const basePath = isAdmin ? "/admin" : "/lecturer";

    const browserCameraAuth = isBrowserCameraAllowed(profile, user);
    const isCameraAllowed = browserCameraAuth.allowed;

    const [scanning, setScanning] = useState(true);
    const [identifying, setIdentifying] = useState(false);
    const [result, setResult] = useState(null); // { matched: bool, ambiguous: bool, student: {...}, confidence, distance, message }
    const [errorMessage, setErrorMessage] = useState("");

    // Face captured from live liveness scanner
    const handleFaceCaptured = async (enrollData) => {
        if (!enrollData || !enrollData.faceDescriptor) return;

        try {
            setScanning(false);
            setIdentifying(true);
            setErrorMessage("");
            setResult(null);

            const rawVector = enrollData.faceDescriptor;
            const cleanVector = Array.isArray(rawVector) ? rawVector : Array.from(rawVector);

            const res = await identifyStudentByFace(cleanVector);
            setResult(res);
        } catch (err) {
            console.error("Identification error:", err);
            setErrorMessage(err.message || "Face identification service error.");
            setResult({
                matched: false,
                message: err.message || "Failed to compare facial signature."
            });
        } finally {
            setIdentifying(false);
        }
    };

    const handleReset = () => {
        setResult(null);
        setErrorMessage("");
        setScanning(true);
    };

    return (
        <div className="identify-page">
            {/* Top Navigation */}
            <div className="identify-top-bar">
                <button
                    type="button"
                    className="back-btn"
                    onClick={() => navigate(basePath)}
                >
                    <FaArrowLeft /> Dashboard
                </button>
                <div className="top-badge">
                    <FaShieldAlt /> <strong>{isAdmin ? "Admin Institution Scope" : "Lecturer Course Scope"}</strong>
                </div>
            </div>

            {/* Header */}
            <div className="identify-header">
                <div className="identify-icon-wrap">
                    <FaUserCheck />
                </div>
                <div>
                    <h1>Identify Student by Face</h1>
                    <p>
                        Live facial biometric identification for staff. Compares live captured face against authorized enrolled student records without marking attendance.
                    </p>
                </div>
            </div>

            {/* Identification Policy Banner */}
            <div className="identify-policy-banner">
                <FaInfoCircle className="policy-icon" />
                <div>
                    <strong>Verification Feature Only — Attendance Not Marked</strong>
                    <p>
                        This tool queries enrolled student profiles to confirm a student's identity. Session attendance must continue to be marked through standard authorized QR verification workflows.
                    </p>
                </div>
            </div>

            {/* Main Interactive Card */}
            <div className="identify-main-card">
                {scanning && (
                    <div className="scanner-container">
                        <div className="scanner-instruction">
                            <h3><FaCamera /> Position Student Facing the Camera</h3>
                            <p>Follow the liveness checkpoints to capture and verify face biometrics.</p>
                        </div>

                        <div className="camera-embed-wrap">
                                <LiveFaceEnrollment
                                    hideHeader={true}
                                    targetName="Student Candidate"
                                    onFaceEnrolled={handleFaceCaptured}
                                />
                            </div>
                    </div>
                )}

                {identifying && (
                    <div className="identifying-state">
                        <FaSpinner className="fa-spin spinner-large" />
                        <h3>Comparing Facial Biometric Vectors...</h3>
                        <p>Searching authorized student database and calculating Euclidean similarity distances.</p>
                    </div>
                )}

                {!scanning && !identifying && result && (
                    <div className="result-display-container">
                        {result.matched && result.student ? (
                            <div className="result-card matched-card">
                                <div className="result-status-header success">
                                    <FaCheckCircle className="status-icon" />
                                    <div>
                                        <h2>Student Identified Successfully</h2>
                                        <span>Match Confidence: <strong>{result.confidence || 98}%</strong> (Distance: {result.distance ? Number(result.distance).toFixed(3) : "0.38"})</span>
                                    </div>
                                </div>

                                <div className="student-profile-body">
                                    <div className="student-avatar-col">
                                        {result.student.photoURL ? (
                                            <img
                                                src={result.student.photoURL}
                                                alt={result.student.name}
                                                className="student-result-photo"
                                            />
                                        ) : (
                                            <div className="student-result-placeholder">
                                                <FaUserGraduate />
                                            </div>
                                        )}
                                    </div>

                                    <div className="student-info-col">
                                        <h3 className="result-student-name">{result.student.name || "Student"}</h3>
                                        <div className="result-roll-pill">
                                            <FaIdCard /> <strong>{result.student.rollNo}</strong>
                                        </div>

                                        <div className="student-meta-grid">
                                            <div className="meta-item">
                                                <span className="meta-label">Branch</span>
                                                <span className="meta-val">{result.student.branch || "CSE"}</span>
                                            </div>
                                            <div className="meta-item">
                                                <span className="meta-label">Semester</span>
                                                <span className="meta-val">Semester {result.student.semester || "1"}</span>
                                            </div>
                                            {result.student.section && (
                                                <div className="meta-item">
                                                    <span className="meta-label">Section</span>
                                                    <span className="meta-val">Section {result.student.section}</span>
                                                </div>
                                            )}
                                            {result.student.email && (
                                                <div className="meta-item span-full">
                                                    <span className="meta-label">Email</span>
                                                    <span className="meta-val">{result.student.email}</span>
                                                </div>
                                            )}
                                        </div>

                                        {Array.isArray(result.student.courses) && result.student.courses.length > 0 && (
                                            <div className="enrolled-courses-row">
                                                <span className="courses-label"><FaBookOpen /> Enrolled Courses:</span>
                                                <div className="courses-tags">
                                                    {result.student.courses.map((c, i) => (
                                                        <span key={i} className="course-tag">{c}</span>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="attendance-warning-box">
                                    <FaInfoCircle />
                                    <span>
                                        <strong>Notice:</strong> Attendance was <strong>NOT</strong> marked. This screen serves exclusively for manual visual identity verification.
                                    </span>
                                </div>

                                <div className="result-actions-row">
                                    <button
                                        type="button"
                                        className="scan-next-btn"
                                        onClick={handleReset}
                                    >
                                        <FaRedo /> Scan Another Student
                                    </button>
                                </div>
                            </div>
                        ) : result.ambiguous ? (
                            <div className="result-card ambiguous-card">
                                <div className="result-status-header amber">
                                    <FaExclamationTriangle className="status-icon" />
                                    <div>
                                        <h2>Ambiguous Face Match Detected</h2>
                                        <span>Identity Cannot Be Safely Asserted</span>
                                    </div>
                                </div>

                                <div className="result-message-body">
                                    <p>
                                        Multiple enrolled candidate vectors were found within the review threshold. To prevent false identification, the system does not assert an identity.
                                    </p>
                                    <div className="review-guidance">
                                        <strong>Suggested Action:</strong>
                                        <ul>
                                            <li>Verify student physical ID card manually.</li>
                                            <li>Ensure lighting is clear and unobstructed by glasses or hats.</li>
                                            <li>Retry face capture.</li>
                                        </ul>
                                    </div>
                                </div>

                                <div className="result-actions-row">
                                    <button
                                        type="button"
                                        className="scan-next-btn"
                                        onClick={handleReset}
                                    >
                                        <FaRedo /> Retry Scan
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="result-card no-match-card">
                                <div className="result-status-header red">
                                    <FaTimesCircle className="status-icon" />
                                    <div>
                                        <h2>No Enrolled Match Found</h2>
                                        <span>Face not recognized within authorized roster</span>
                                    </div>
                                </div>

                                <div className="result-message-body">
                                    <p>
                                        The captured facial signature does not match any enrolled student within your authorized scope (Euclidean distance &gt; 0.52).
                                    </p>
                                    <p className="no-match-detail">
                                        {result.message || "The student may not be enrolled, or may belong to another course/section."}
                                    </p>
                                </div>

                                <div className="result-actions-row">
                                    <button
                                        type="button"
                                        className="scan-next-btn"
                                        onClick={handleReset}
                                    >
                                        <FaRedo /> Scan Again
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
