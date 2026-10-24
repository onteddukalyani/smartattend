import { useCallback, useMemo, useState } from "react";
import { FaCheckCircle, FaTimes, FaUserCheck } from "react-icons/fa";
import FaceScanner from "../Lecturer/pages/FaceScanner";

export default function ExcuseFaceVerification({ student, onCancel, onVerified }) {
  const rollNo = String(student?.rollNo || student?.id || "").trim().toUpperCase();
  const studentName = student?.name || student?.studentName || student?.fullName || rollNo;
  const [verification, setVerification] = useState(null);
  const verifiedStudent = useMemo(
    () => ({ name: studentName, rollNo, faceRegistered: true }),
    [rollNo, studentName]
  );

  const handleVerificationChange = useCallback((result) => {
    const verifiedRoll = String(result?.student?.rollNo || "").trim().toUpperCase();
    if (
      result?.verified === true &&
      result.liveness === true &&
      result.antiSpoof === "PASSED" &&
      verifiedRoll === rollNo
    ) {
      setVerification({
        verified: true,
        confidence: result.confidence,
        distance: result.distance
      });
      return;
    }
    setVerification(null);
  }, [rollNo]);

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10050,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "max(12px, env(safe-area-inset-top)) 12px max(12px, env(safe-area-inset-bottom))",
        background: "rgba(15, 23, 42, 0.78)",
        backdropFilter: "blur(5px)"
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="excuse-face-verification-title"
        style={{
          width: "min(100%, 760px)",
          maxHeight: "100%",
          overflowY: "auto",
          padding: "clamp(14px, 3vw, 24px)",
          borderRadius: "18px",
          background: "var(--surface, #ffffff)",
          color: "var(--text-main, #0f172a)",
          boxShadow: "0 24px 70px rgba(0,0,0,.35)"
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 id="excuse-face-verification-title" style={{ margin: 0, fontSize: "1.15rem" }}>
              Verify student before excusing
            </h2>
            <p style={{ margin: "6px 0 0", color: "var(--text-muted, #64748b)", lineHeight: 1.45 }}>
              Scan <strong>{studentName}</strong> ({rollNo}) live. A matching enrolled face and liveness check are required.
              Use the camera switch to choose the front or rear camera.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel face verification"
            style={{
              minWidth: 40,
              minHeight: 40,
              display: "inline-grid",
              placeItems: "center",
              border: "1px solid var(--border, #cbd5e1)",
              borderRadius: 10,
              background: "var(--surface, #fff)",
              color: "var(--text-main, #334155)",
              cursor: "pointer"
            }}
          >
            <FaTimes />
          </button>
        </div>

        <FaceScanner
          verifiedStudent={verifiedStudent}
          rollNo={rollNo}
          allowRearCamera
          onVerificationChange={handleVerificationChange}
        />

        {verification && (
          <div
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 12,
              padding: 12,
              borderRadius: 10,
              background: "#ecfdf5",
              color: "#047857",
              fontWeight: 700
            }}
          >
            <FaCheckCircle />
            <span>Live face verified for {rollNo} ({verification.confidence}% match).</span>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              minHeight: 44,
              padding: "10px 16px",
              border: "1px solid var(--border, #cbd5e1)",
              borderRadius: 10,
              background: "var(--surface, #fff)",
              color: "var(--text-main, #334155)",
              fontWeight: 700,
              cursor: "pointer"
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!verification}
            onClick={() => onVerified(verification)}
            style={{
              minHeight: 44,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "10px 16px",
              border: 0,
              borderRadius: 10,
              background: verification ? "#059669" : "#94a3b8",
              color: "#fff",
              fontWeight: 750,
              cursor: verification ? "pointer" : "not-allowed"
            }}
          >
            <FaUserCheck /> Confirm face and continue
          </button>
        </div>
      </section>
    </div>
  );
}
