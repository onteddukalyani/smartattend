import { initializeApp } from "firebase/app";

import { getFirestore } from "firebase/firestore";

import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  signOut,
} from "firebase/auth";


const firebaseConfig = {
  apiKey: "AIzaSyD_oqAOLLwS_sYXpTisEXl4qZAiSeIxooM",
  authDomain: "smart-attendance-ok.firebaseapp.com",
  projectId: "smart-attendance-ok",
  storageBucket: "smart-attendance-ok.firebasestorage.app",
  messagingSenderId: "313754116452",
  appId: "1:313754116452:web:ef955c1b662607d4145a71"
};


const app = initializeApp(firebaseConfig);


export const db = getFirestore(app);

export const auth = getAuth(app);


export const googleProvider =
  new GoogleAuthProvider();


googleProvider.setCustomParameters({
  prompt: "select_account"
});


export const loginWithGoogle = () =>
  signInWithPopup(
    auth,
    googleProvider
  );


export const loginAsGuest = () =>
  signInAnonymously(auth);


export const logoutUser = () =>
  signOut(auth);
