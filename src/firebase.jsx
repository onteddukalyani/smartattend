import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  getFirestore
} from "firebase/firestore";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  signInWithCredential,
  signOut,
} from "firebase/auth";
import { getFunctions } from "firebase/functions";
import { Capacitor } from "@capacitor/core";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";

const firebaseConfig = {
  apiKey: "AIzaSyD_oqAOLLwS_sYXpTisEXl4qZAiSeIxooM",
  authDomain: "smart-attendance-ok.firebaseapp.com",
  projectId: "smart-attendance-ok",
  storageBucket: "smart-attendance-ok.firebasestorage.app",
  messagingSenderId: "313754116452",
  appId: "1:313754116452:web:ef955c1b662607d4145a71"
};

const app = initializeApp(firebaseConfig);

let firestoreDb;
try {
  firestoreDb = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  });
} catch (err) {
  firestoreDb = getFirestore(app);
}

export const db = firestoreDb;
export const auth = getAuth(app);
export const functions = getFunctions(app);

export const googleProvider = new GoogleAuthProvider();

googleProvider.setCustomParameters({
  prompt: "select_account"
});

export const loginWithGoogle = async () => {
  const isNative = Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'web';
  console.log("loginWithGoogle triggered. isNative:", isNative, "Platform:", Capacitor.getPlatform());

  if (isNative) {
    // 1. Native Google Sign-In for Android / iOS in Capacitor
    const result = await FirebaseAuthentication.signInWithGoogle();
    console.log("Native Google Sign-In result:", result);
    // Extract ID token from credential
    const idToken = result.credential?.idToken || result.idToken;
    if (idToken) {
      const credential = GoogleAuthProvider.credential(idToken);
      return await signInWithCredential(auth, credential);
    }

    // Fallback if result has user object directly
    if (result.user) {
      return { user: result.user };
    }

    throw new Error("Failed to receive authentication tokens from native Google Sign-In.");
  } else {
    // 2. Standard Web Browser Popup Authentication
    return await signInWithPopup(auth, googleProvider);
  }
};

export const loginAsGuest = async () => {
  if (Capacitor.isNativePlatform()) {
    return await FirebaseAuthentication.signInAnonymously();
  }
  return await signInAnonymously(auth);
};

export const logoutUser = async () => {
  if (Capacitor.isNativePlatform()) {
    try {
      await FirebaseAuthentication.signOut();
    } catch (err) {
      console.warn("Native sign-out notice:", err);
    }
  }
  return await signOut(auth);
};
