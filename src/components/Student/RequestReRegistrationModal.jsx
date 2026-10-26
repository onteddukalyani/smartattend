import { useState, useEffect } from "react";
import {
    FaTimes,
    FaKey,
    FaShieldAlt,
    FaCamera,
    FaFingerprint,
    FaClock,
    FaCheckCircle,
    FaTimesCircle,
    FaExclamationTriangle,
    FaSpinner,
    FaUniversity,
    FaMobileAlt,
    FaSyncAlt
} from "react-icons/fa";
import {
    submitReRegistrationRequest,
    cancelReRegistrationRequest,
    subscribeToStudentReRegistrationRequest
} from "../../services/faceEnrollmentService";
import "./RequestReRegistrationModal.css";

const PREDEFINED_REASONS = [
    {
        id: "new_device",
        title: "Changed or Upgraded Mobile Phone",
        subtitle: "Need to bind new phone hardware sensor & keystore"
    },
    {
        id: "face_mismatch",
        title: "Facial Verification Fails in Class",
        subtitle: "Scan not recognizing or low lighting in original enrollment"
    },
    {
        id: "appearance_change",
        title: "Noticeable Appearance Change",
        subtitle: "Haircut, glasses, facial hair, or appearance update"
    },
    {
        id: "accidental_setup",
        title: "Accidental / Erroneous Initial Setup",
        subtitle: "Incomplete capture or registered on wrong device"
    },
    {
        id: "custom",
        title: "Other Reason / Faculty Instruction",
        subtitle: "Specify your reason in the note below"
    }
];

export default function RequestReRegistrationModal({
    isOpen,
    onClose,
    rollNo,
    studentName = "",
    studentEmail = "",
    initialScope = "both",
    onProceedEnroll
}) {
    const [requestScope, setRequestScope] = useState(initialScope);
    const [selectedReasonId, setSelectedReasonId] = useState("new_device");
    const [customReasonText, setCustomReasonText] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [feedback, setFeedback] = useState(null); // { type: "success" | "error", message: string }
    const [existingRequest, setExistingRequest] = useState(null);

    const cleanRoll = String(rollNo || "").trim().toUpperCase();

    // Listen to real-time status of student's request
    useEffect(() => {
        if (!cleanRoll) return;
        const unsub = subscribeToStudentReRegistrationRequest(cleanRoll, (data) => {
            setExistingRequest(data);
        });
        return () => unsub();
    }, [cleanRoll]);

    if (!isOpen) return null;

    const isPending = existingRequest && existingRequest.status === "pending";
    const isApproved = existingRequest && existingRequest.status === "approved";
    const isRejected = existingRequest && existingRequest.status === "rejected";

    const handleSubmit = async (e) => {
        e.preventDefault();
        setFeedback(null);
        setSubmitting(true);

        try {
            const foundReason = PREDEFINED_REASONS.find((r) => r.id === selectedReasonId);
            const mainReason = foundReason ? foundReason.title : "Re-registration request";
            const details = selectedReasonId === "custom" ? customReasonText.trim() : (customReasonText.trim() || undefined);

            if (selectedReasonId === "custom" && !customReasonText.trim()) {
                throw new Error("Please describe your reason for requesting re-registration.");
            }

            await submitReRegistrationRequest({
                rollNo: cleanRoll,
                studentName,
                studentEmail,
                requestType: requestScope,
                reason: mainReason,
                details
            });

            setFeedback({
                type: "success",
                message: "✅ Re-registration request sent to your Course Lecturer and Administrator!"
            });
        } catch (err) {
            setFeedback({
                type: "error",
                message: err.message || "Failed to submit request."
            });
        } finally {
            setSubmitting(false);
        }
    };

    const handleCancelRequest = async () => {
        if (!window.confirm("Are you sure you want to cancel your pending re-registration request?")) {
            return;
        }

        try {
            setCancelling(true);
            await cancelReRegistrationRequest(cleanRoll);
            setFeedback({
                type: "success",
                message: "Request cancelled."
            });
        } catch (err) {
            alert("Failed to cancel request: " + err.message);
        } finally {
            setCancelling(false);
        }
    };

    return (
        <div className="request-rereg-backdrop" onClick={onClose}>
            <div className="request-rereg-modal" onClick={(e) => e.stopPropagation()}>
                {/* Close Button */}
                <button
                    type="button"
                    className="request-rereg-close-btn"
                    onClick={onClose}
                    title="Close"
                >
                    <FaTimes />
                </button>

                {/* Header */}
                <div className="request-rereg-header">
                    <div className="request-rereg-icon-wrap">
                        <FaKey />
                    </div>
                    <div>
                        <h2>Request Re-Registration Access</h2>
                        <p>
                            Student: <strong>{studentName || cleanRoll}</strong> • Roll No: <strong style={{ color: "#6366f1" }}>{cleanRoll}</strong>
                        </p>
                    </div>
                </div>

                {/* In-Person Physical Reporting Guidance Banner */}
                <div className="in-person-guidance-card">
                    <FaUniversity className="in-person-icon" />
                    <div className="in-person-text">
                        <strong>Physically Report to Lecturer (Immediate Help)</strong>
                        <p>
                            To prevent proxy attendance, initial registrations are globally protected. You can physically report to your <strong>Course Lecturer</strong> during class or cabin hours with your valid <strong>Student ID Card</strong>. Lecturers can grant instant 1-click re-registration or re-enroll you on the spot.
                        </p>
                    </div>
                </div>

                {/* Feedback Banner */}
                {feedback && (
                    <div className={`feedback-banner ${feedback.type}`}>
                        {feedback.type === "success" ? <FaCheckCircle /> : <FaTimesCircle />}
                        <span>{feedback.message}</span>
                    </div>
                )}

                {/* PENDING VIEW */}
                {isPending ? (
                    <div className="pending-request-view">
                        <div className="pending-status-badge">
                            <FaClock />
                        </div>
                        <h3>Request Under Review</h3>
                        <p className="pending-sub">
                            Your re-registration request has been submitted to your Course Lecturer and Administrator.
                        </p>

                        <div className="pending-details-box">
                            <div className="pending-detail-row">
                                <span className="label">Requested Scope:</span>
                                <span className="val">
                                    {existingRequest.requestType === "face"
                                        ? "3D Face Biometrics"
                                        : existingRequest.requestType === "biometric"
                                        ? "Device Fingerprint"
                                        : "Full Biometrics (Face + Device)"}
                                </span>
                            </div>
                            <div className="pending-detail-row">
                                <span className="label">Reason:</span>
                                <span className="val">{existingRequest.reason || "—"}</span>
                            </div>
                            {existingRequest.details && (
                                <div className="pending-detail-row">
                                    <span className="label">Note:</span>
                                    <span className="val">{existingRequest.details}</span>
                                </div>
                            )}
                            <div className="pending-detail-row">
                                <span className="label">Submitted:</span>
                                <span className="val">
                                    {existingRequest.createdAt ? new Date(existingRequest.createdAt).toLocaleString() : "Just now"}
                                </span>
                            </div>
                        </div>

                        <div style={{ margin: "16px 0 6px" }}>
                            <button
                                type="button"
                                className="rereg-cancel-req-btn"
                                onClick={handleCancelRequest}
                                disabled={cancelling}
                            >
                                {cancelling ? <><FaSpinner className="fa-spin" /> Cancelling...</> : "Cancel Pending Request"}
                            </button>
                        </div>
                    </div>
                ) : isApproved ? (
                    /* APPROVED VIEW */
                    <div className="pending-request-view">
                        <div className="pending-status-badge" style={{ background: "#dcfce7", color: "#16a34a" }}>
                            <FaCheckCircle />
                        </div>
                        <h3>Re-Registration Approved!</h3>
                        <p className="pending-sub">
                            Your Course Lecturer has approved your re-registration access. You can now re-enroll your biometrics.
                        </p>

                        <button
                            type="button"
                            className="rereg-submit-btn"
                            onClick={() => {
                                onClose();
                                onProceedEnroll?.();
                            }}
                        >
                            <FaCamera /> Proceed to Re-Enrollment Now
                        </button>
                    </div>
                ) : (
                    /* SUBMISSION FORM */
                    <form onSubmit={handleSubmit} className="rereg-request-form">
                        {isRejected && (
                            <div className="feedback-banner error" style={{ marginBottom: "16px" }}>
                                <FaExclamationTriangle />
                                <div>
                                    <strong>Previous Request Declined:</strong>
                                    <div>{existingRequest?.rejectionReason || "Please physically report to your lecturer."}</div>
                                </div>
                            </div>
                        )}

                        {/* Scope Selector */}
                        <div className="rereg-form-group">
                            <label className="field-title">
                                <FaShieldAlt /> 1. Select Biometrics to Re-Register:
                            </label>
                            <div className="rereg-scope-selector">
                                <button
                                    type="button"
                                    className={`scope-btn ${requestScope === "face" ? "active" : ""}`}
                                    onClick={() => setRequestScope("face")}
                                >
                                    <FaCamera />
                                    <span>Face Only</span>
                                </button>
                                <button
                                    type="button"
                                    className={`scope-btn ${requestScope === "biometric" ? "active" : ""}`}
                                    onClick={() => setRequestScope("biometric")}
                                >
                                    <FaFingerprint />
                                    <span>Fingerprint</span>
                                </button>
                                <button
                                    type="button"
                                    className={`scope-btn ${requestScope === "both" ? "active" : ""}`}
                                    onClick={() => setRequestScope("both")}
                                >
                                    <FaShieldAlt />
                                    <span>Both</span>
                                </button>
                            </div>
                        </div>

                        {/* Reason Selector */}
                        <div className="rereg-form-group">
                            <label className="field-title">
                                <FaClock /> 2. Reason for Re-Registration:
                            </label>
                            <div className="rereg-reasons-grid">
                                {PREDEFINED_REASONS.map((r) => (
                                    <label
                                        key={r.id}
                                        className={`reason-option-card ${selectedReasonId === r.id ? "selected" : ""}`}
                                    >
                                        <input
                                            type="radio"
                                            name="reRegReason"
                                            value={r.id}
                                            checked={selectedReasonId === r.id}
                                            onChange={() => setSelectedReasonId(r.id)}
                                        />
                                        <div className="reason-card-content">
                                            <strong>{r.title}</strong>
                                            <span>{r.subtitle}</span>
                                        </div>
                                    </label>
                                ))}
                            </div>
                        </div>

                        {/* Note / Details */}
                        <div className="rereg-form-group">
                            <label className="field-title">
                                <FaMobileAlt /> 3. Additional Details / Explanation for Faculty (Optional):
                            </label>
                            <textarea
                                rows={2}
                                className="rereg-textarea"
                                placeholder="e.g. Switched to a new OnePlus phone; old phone screen cracked..."
                                value={customReasonText}
                                onChange={(e) => setCustomReasonText(e.target.value)}
                            />
                        </div>

                        <button
                            type="submit"
                            className="rereg-submit-btn"
                            disabled={submitting}
                        >
                            {submitting ? (
                                <><FaSpinner className="fa-spin" /> Submitting Request...</>
                            ) : (
                                <><FaKey /> Submit Re-Registration Request</>
                            )}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
