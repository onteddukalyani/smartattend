import { EnrollmentError, resolveCaller } from "./faceEnrollment.js";
import { getFirebaseAdmin } from "./firebaseAdmin.js";

export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;

  const allowedOrigins = (process.env.APP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (process.env.VERCEL_URL) {
    allowedOrigins.push(`https://${process.env.VERCEL_URL}`);
  }

  if (!allowedOrigins.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}

export async function authenticateApiRequest(req) {
  const tokenMatch = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) {
    throw new EnrollmentError(401, "unauthenticated", "Sign in to use this endpoint.");
  }

  const { admin, db } = getFirebaseAdmin();
  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(tokenMatch[1], true);
  } catch {
    throw new EnrollmentError(401, "unauthenticated", "Your sign-in is invalid or expired. Sign in again.");
  }
  const caller = await resolveCaller(db, decodedToken);
  return { admin, db, caller };
}
