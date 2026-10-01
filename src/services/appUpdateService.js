import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Capacitor } from "@capacitor/core";
import { getApkDownloadUrl, GITHUB_RELEASE_APK_URL } from "../utils/apkUrl";

export const CURRENT_APP_VERSION = "1.0.0";
export const CURRENT_APP_VERSION_CODE = 1;
export const APP_BUILD_DATE = "2026-10-01";

const GITHUB_VERSION_JSON_URL = "https://raw.githubusercontent.com/onteddukalyani/smartattend/main/version.json";

/**
 * Compare two semver version strings (e.g. '1.0.7' > '1.0.6')
 * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0;
  const p1 = String(v1).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const p2 = String(v2).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

/**
 * Checks for the latest version of SmartAttend from Firestore or GitHub.
 * Returns update details.
 */
export async function checkForAppUpdate() {
  const isNative = Capacitor.isNativePlatform();
  let remoteData = null;

  // 1. Try fetching from Firestore first (Instant admin control)
  try {
    const updateDocRef = doc(db, "app_updates", "latest");
    const snap = await getDoc(updateDocRef);
    if (snap.exists()) {
      remoteData = snap.data();
    }
  } catch (err) {
    console.warn("[AppUpdate] Firestore check failed, falling back to GitHub/public version.json:", err);
  }

  // 2. Fallback to GitHub raw version.json or local static version.json
  if (!remoteData) {
    try {
      const fetchUrl = `${GITHUB_VERSION_JSON_URL}?_nocache=${Date.now()}`;
      const res = await fetch(fetchUrl, { cache: "no-store" });
      if (res.ok) {
        remoteData = await res.json();
      }
    } catch (err) {
      console.warn("[AppUpdate] GitHub version check failed:", err);
    }
  }

  // 3. Fallback to bundled public version.json
  if (!remoteData) {
    try {
      const res = await fetch(`/version.json?_nocache=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        remoteData = await res.json();
      }
    } catch (_) {}
  }

  if (!remoteData) {
    return {
      success: false,
      hasUpdate: false,
      currentVersion: CURRENT_APP_VERSION,
      currentVersionCode: CURRENT_APP_VERSION_CODE,
      latestVersion: CURRENT_APP_VERSION,
      message: "Unable to verify version at this time."
    };
  }

  const latestVersion = remoteData.version || CURRENT_APP_VERSION;
  const latestVersionCode = remoteData.versionCode || CURRENT_APP_VERSION_CODE;
  const minRequiredVersion = remoteData.minRequiredVersion || "1.0.0";

  const hasNewerVersion =
    compareVersions(latestVersion, CURRENT_APP_VERSION) > 0 ||
    latestVersionCode > CURRENT_APP_VERSION_CODE;

  const isMandatory =
    Boolean(remoteData.isMandatory) ||
    compareVersions(minRequiredVersion, CURRENT_APP_VERSION) > 0;

  const apkUrl = remoteData.apkUrl || getApkDownloadUrl() || GITHUB_RELEASE_APK_URL;

  return {
    success: true,
    hasUpdate: hasNewerVersion,
    isNative,
    currentVersion: CURRENT_APP_VERSION,
    currentVersionCode: CURRENT_APP_VERSION_CODE,
    latestVersion,
    latestVersionCode,
    isMandatory,
    releaseDate: remoteData.releaseDate || APP_BUILD_DATE,
    title: remoteData.title || `SmartAttend v${latestVersion} Available`,
    releaseNotes: Array.isArray(remoteData.releaseNotes)
      ? remoteData.releaseNotes
      : ["Performance improvements and general bug fixes."],
    apkUrl
  };
}

/**
 * Trigger APK download / update in device browser
 */
export function triggerApkDownload(downloadUrl) {
  const url = downloadUrl || getApkDownloadUrl();
  if (typeof window !== "undefined") {
    // Open in external browser or trigger file download
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", "SmartAttend-release.apk");
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
