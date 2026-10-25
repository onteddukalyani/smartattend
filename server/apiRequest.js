import { EnrollmentError, resolveCaller } from "./faceEnrollment.js";
import { getFirebaseAdmin } from "./firebaseAdmin.js";

export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;

  const allowedOrigins = new Set([
    "https://smart-attendance-ok.web.app",
    "https://smart-attendance-ok.firebaseapp.com",
    "https://smartattend-ochre.vercel.app",
    "https://smartattend.vercel.app",
    "https://smartattend-app.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:4173",
    "https://localhost",
    "capacitor://localhost",
    ...(process.env.APP_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  ]);
  if (process.env.VERCEL_URL) {
    allowedOrigins.add(`https://${process.env.VERCEL_URL}`);
  }

  const isVercelOrigin = /^https:\/\/[a-zA-Z0-9_-]+\.vercel\.app$/i.test(origin);

  if (!allowedOrigins.has(origin) && !isVercelOrigin) return false;
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
