import { useCallback, useEffect, useState } from "react";
import {
  listFaceEnrollmentReviews,
  resolveFaceEnrollmentReview
} from "../../services/faceEnrollmentService";

export default function FaceEnrollmentReviewPanel({ rollNo }) {
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setReviews(await listFaceEnrollmentReviews(rollNo));
    } catch (err) {
      console.error("Unable to load face enrollment reviews:", err);
      setError(err.message || "Unable to load face enrollment reviews.");
    } finally {
      setLoading(false);
    }
  }, [rollNo]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleResolve = async (reviewId, action) => {
    setWorkingId(reviewId);
    setError("");
    try {
      await resolveFaceEnrollmentReview(reviewId, action);
      await refresh();
    } catch (err) {
      console.error("Unable to resolve face enrollment review:", err);
      setError(err.message || "Unable to resolve the face enrollment review.");
    } finally {
      setWorkingId("");
    }
  };

  return (
    <section style={{ margin: "12px 0", padding: "12px", border: "1px solid #f59e0b", borderRadius: "10px", background: "#fffbeb" }}>
      <h4 style={{ margin: "0 0 8px", color: "#92400e" }}>Face enrollment review</h4>
      {loading ? (
        <p style={{ margin: 0 }}>Loading pending reviews...</p>
      ) : reviews.length === 0 ? (
        <p style={{ margin: 0 }}>No pending face enrollment reviews for this student.</p>
      ) : reviews.map((review) => (
        <div key={review.id} style={{ padding: "10px 0", borderTop: "1px solid #fde68a" }}>
          <p style={{ margin: "0 0 8px" }}>
            {review.reason === "EXISTING_IDENTITY_UNVERIFIED"
              ? "The new capture does not sufficiently match this student's existing enrollment."
              : "The new capture may match another enrolled identity and needs an in-person identity check."}
            {review.candidateRollNo && ` Possible match: ${review.candidateName || "Student"} (${review.candidateRollNo}).`}
          </p>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={Boolean(workingId)}
              onClick={() => handleResolve(review.id, "RECAPTURE_REQUIRED")}
            >
              {workingId === review.id ? "Updating..." : "Require fresh capture"}
            </button>
            <button
              type="button"
              disabled={Boolean(workingId)}
              onClick={() => handleResolve(review.id, "REJECTED")}
            >
              Reject enrollment
            </button>
          </div>
        </div>
      ))}
      {error && <p role="alert" style={{ color: "#b91c1c", margin: "8px 0 0" }}>{error}</p>}
    </section>
  );
}
