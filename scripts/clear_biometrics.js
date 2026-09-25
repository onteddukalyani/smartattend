import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  setDoc,
  deleteField
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyD_oqAOLLwS_sYXpTisEXl4qZAiSeIxooM",
  authDomain: "smart-attendance-ok.firebaseapp.com",
  projectId: "smart-attendance-ok",
  storageBucket: "smart-attendance-ok.firebasestorage.app",
  messagingSenderId: "313754116452",
  appId: "1:313754116452:web:ef955c1b662607d4145a71"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const resetBiometricsPayload = {
  faceDescriptor: deleteField(),
  faceDescriptors: deleteField(),
  descriptor: deleteField(),
  descriptors: deleteField(),
  faceVector: deleteField(),
  faceVectors: deleteField(),
  embedding: deleteField(),
  embeddings: deleteField(),
  photoURL: deleteField(),
  image: deleteField(),
  photo: deleteField(),
  avatar: deleteField(),
  profilePic: deleteField(),
  profileImage: deleteField(),
  faceImage: deleteField(),
  facePhoto: deleteField(),
  enrolledFace: deleteField(),
  faceData: deleteField(),
  faceEnrolled: deleteField(),
  isFaceRegistered: deleteField(),
  faceEnrolledAt: deleteField(),
  enrolledAt: deleteField(),
  faceRegistered: false,
  biometricEnrolled: false,
  hasFaceRegistered: false,
  faceRemovedAt: Date.now()
};

async function clearAllBiometrics() {
  console.log("Starting full biometrics clearance across database collections...");

  const collections = ["students", "users", "authorizedUsers"];
  let totalCleared = 0;

  for (const collName of collections) {
    try {
      console.log(`\nScanning collection: '${collName}'...`);
      const snap = await getDocs(collection(db, collName));
      console.log(`Found ${snap.docs.length} documents in '${collName}'.`);

      let collCleared = 0;
      for (const d of snap.docs) {
        const data = d.data();
        const hasBiometrics = Boolean(
          data.faceDescriptor ||
          data.descriptor ||
          data.faceVector ||
          data.photoURL ||
          data.image ||
          data.photo ||
          data.faceRegistered === true ||
          data.biometricEnrolled === true ||
          data.hasFaceRegistered === true
        );

        if (hasBiometrics) {
          try {
            await setDoc(doc(db, collName, d.id), resetBiometricsPayload, { merge: true });
            collCleared++;
            totalCleared++;
            console.log(`  ✓ Cleared biometrics for [${collName}/${d.id}] (${data.name || data.rollNo || "Student"})`);
          } catch (err) {
            console.warn(`  ✗ Failed to clear [${collName}/${d.id}]:`, err.message);
          }
        }
      }
      console.log(`Total cleared in '${collName}': ${collCleared}`);
    } catch (collErr) {
      console.error(`Error querying '${collName}':`, collErr.message);
    }
  }

  console.log(`\n========================================`);
  console.log(`BIOMETRICS REMOVAL COMPLETE!`);
  console.log(`Total student profiles reset: ${totalCleared}`);
  console.log(`========================================\n`);
  process.exit(0);
}

clearAllBiometrics().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
