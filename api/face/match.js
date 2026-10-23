import { authenticateApiRequest, applyCors } from "../../server/apiRequest.js";
import { EnrollmentError, matchEnrolledFace } from "../../server/faceEnrollment.js";

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
    const { db, caller } = await authenticateApiRequest(req);
    return res.status(200).json(await matchEnrolledFace(db, caller, req.body));
  } catch (error) {
    if (error instanceof EnrollmentError) {
      return res.status(error.status).json({
        error: { code: error.code, message: error.message }
      });
    }
    if (error?.code === "unauthenticated") {
      return res.status(401).json({ error: { code: error.code, message: error.message } });
    }
    console.error("[api/face/match] Request failed:", error?.code || error?.name || "unknown");
    return res.status(500).json({
      error: { code: "internal", message: "The secure face-matching service failed." }
    });
  }
}
