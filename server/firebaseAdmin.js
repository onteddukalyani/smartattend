import admin from "firebase-admin";

let initializedApp;

export function getFirebaseAdmin() {
  if (initializedApp) {
    return { admin, db: admin.firestore() };
  }

  const serviceAccountValue = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!serviceAccountValue || !projectId) {
    throw new Error("Firebase Admin server environment is not configured.");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountValue);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid JSON.");
  }

  if (serviceAccount.project_id !== projectId) {
    throw new Error("Firebase Admin credentials do not match FIREBASE_PROJECT_ID.");
  }

  initializedApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId
  });

  return { admin, db: admin.firestore() };
}
