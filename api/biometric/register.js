import { authenticateApiRequest, applyCors } from "../../server/apiRequest.js";
import { EnrollmentError } from "../../server/faceEnrollment.js";
import { registerBiometricCredential } from "../../server/biometricEnrollment.js";

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
    const result = await registerBiometricCredential(db, admin, caller, req.body);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof EnrollmentError) {
      return res.status(error.status).json({
        error: { code: error.code, message: error.message }
      });
    }

    if (error?.code === "unauthenticated") {
      return res.status(401).json({ error: { code: error.code, message: error.message } });
    }
    console.error("[api/biometric/register] Request failed:", error?.code || error?.name || error?.message || "unknown");
    return res.status(500).json({
      error: {
        code: "internal",
        message: error?.message || "Biometric registration failed on the server."
      }
    });
  }
}
