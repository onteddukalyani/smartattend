import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FaArrowLeft, FaCamera, FaSpinner, FaCheckCircle, FaShieldAlt } from "react-icons/fa";
import { doc, setDoc, deleteField } from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { LiveFaceEnrollment } from "../../Common/LiveFaceEnrollment";
import { checkDuplicateFaceBiometrics } from "../../../utils/biometricManager";
import "./FaceEnrollPage.css";

export default function FaceEnrollPage() {
    const navigate = useNavigate();
    const { user, profile } = useAuth();
    const [faceSaving, setFaceSaving] = useState(false);
    const [faceSuccessMsg, setFaceSuccessMsg] = useState("");

    const emailRoll = (user?.email || "").split("@")[0].trim().toUpperCase();
    const activeRollNo = (profile?.rollNo || emailRoll || "").trim().toUpperCase();
    const studentName = profile?.name || profile?.fullName || activeRollNo || "Student";
    const cleanEmail = (user?.email || "").toLowerCase().trim();

    const handleFaceEnrolled = async (enrollData) => {
        if (!enrollData || !enrollData.faceDescriptor || !activeRollNo) return;

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

            setFaceSuccessMsg("✅ Face biometrics registered & saved successfully! Redirecting to dashboard...");
            setTimeout(() => {
                navigate("/student");
            }, 2000);
        } catch (err) {
            console.error("Error saving face biometrics:", err);
            alert("Failed to save face biometrics: " + err.message);
        } finally {
            setFaceSaving(false);
        }
    };

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
                    <FaShieldAlt /> Biometric Security
                </div>
            </div>

            <div className="face-enroll-card">
                <div className="face-enroll-header">
                    <div className="face-enroll-icon">
                        <FaCamera />
                    </div>
                    <h1>Face Biometrics Registration</h1>
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
            </div>
        </div>
    );
}
