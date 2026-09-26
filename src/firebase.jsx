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
  const isNative = Capacitor.isNativePlatform() || (Capacitor.getPlatform && Capacitor.getPlatform() !== 'web');
  console.log("loginWithGoogle triggered. isNative:", isNative, "Platform:", Capacitor.getPlatform ? Capacitor.getPlatform() : 'web');

  if (isNative) {
    try {
      // 1. Try Native Google Sign-In for Android / iOS in Capacitor
      const result = await FirebaseAuthentication.signInWithGoogle();
      console.log("Native Google Sign-In result:", result);
      
      const idToken = result.credential?.idToken || result.idToken;
      if (idToken) {
        const credential = GoogleAuthProvider.credential(idToken);
        return await signInWithCredential(auth, credential);
      }

      if (result.user) {
        return { user: result.user };
      }
      throw new Error("No credential tokens returned from native Google Sign-In.");
    } catch (nativeErr) {
      console.warn("Native Google Sign-In notice (attempting Web Popup fallback):", nativeErr.message || nativeErr);
      // 2. Seamless fallback to Firebase Web popup
      try {
        return await signInWithPopup(auth, googleProvider);
      } catch (webErr) {
        console.error("Web Google popup failed:", webErr);
        throw (nativeErr.message && !webErr.message ? nativeErr : webErr);
      }
    }
  } else {
    // 2. Standard Web Browser Popup Authentication
    return await signInWithPopup(auth, googleProvider);
  }
};

export const loginAsGuest = async () => {
  if (Capacitor.isNativePlatform()) {
    try {
      return await FirebaseAuthentication.signInAnonymously();
    } catch (err) {
      console.warn("Native guest login fallback:", err);
    }
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
