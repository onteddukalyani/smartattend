import { authenticateApiRequest, applyCors } from "../../server/apiRequest.js";
import {
  EnrollmentError,
  listFaceEnrollmentReviews,
  resolveFaceEnrollmentReview
} from "../../server/faceEnrollment.js";

export default async function handler(req, res) {
  if (!applyCors(req, res)) {
    return res.status(403).json({ error: { code: "origin-not-allowed", message: "This app origin is not allowed." } });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: { code: "method-not-allowed", message: "Use POST." } });
  }

  try {
    const { admin, db, caller } = await authenticateApiRequest(req);
    const operation = String(req.body?.operation || "").trim().toLowerCase();
    if (operation === "list") {
      return res.status(200).json(await listFaceEnrollmentReviews(db, caller, req.body));
    }
    if (operation === "resolve") {
      return res.status(200).json(
        await resolveFaceEnrollmentReview(db, admin, caller, req.body)
      );
    }
    throw new EnrollmentError(400, "invalid-argument", "A supported review operation is required.");
  } catch (error) {
    if (error instanceof EnrollmentError) {
      return res.status(error.status).json({
        error: { code: error.code, message: error.message }
      });
    }
    if (error?.code === "unauthenticated") {
      return res.status(401).json({ error: { code: error.code, message: error.message } });
    }
    console.error("[api/face/review] Request failed:", error?.code || error?.name || "unknown");
    return res.status(500).json({
      error: { code: "internal", message: "The secure face-review service failed." }
    });
  }
}
