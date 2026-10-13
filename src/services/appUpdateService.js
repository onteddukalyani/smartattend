import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Capacitor } from "@capacitor/core";
import { getApkDownloadUrl, GITHUB_RELEASE_APK_URL, getApkMirrors } from "../utils/apkUrl";

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
    apkUrl,
    mirrors: getApkMirrors()
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

/**
 * Stream APK download with progress tracking, transfer speed calculation,
 * and automatic fallback if streaming or CORS is blocked.
 * 
 * @param {Object} options
 * @param {string} options.url - The APK download URL
 * @param {function} options.onProgress - Callback ({ percent, receivedBytes, totalBytes, speedKBps, stage })
 * @param {AbortSignal} [options.signal] - Optional AbortSignal
 * @returns {Promise<{ success: boolean, fallback?: boolean, error?: string, warning?: string }>}
 */
export async function downloadApkWithStream({ url, onProgress, signal }) {
  const targetUrl = url || getApkDownloadUrl();
  const startTime = Date.now();
  let lastSpeedCheckTime = startTime;
  let lastSpeedCheckBytes = 0;
  let currentSpeedKBps = 0;

  try {
    if (onProgress) {
      onProgress({ percent: 0, receivedBytes: 0, totalBytes: 0, speedKBps: 0, stage: 'connecting' });
    }

    const response = await fetch(targetUrl, {
      signal,
      headers: {
        'Accept': 'application/vnd.android.package-archive, application/octet-stream, */*'
      }
    });

    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status} ${response.statusText}`);
    }

    const contentLengthHeader = response.headers.get('content-length');
    const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;
    const reader = response.body?.getReader();

    if (!reader) {
      // If ReadableStream is not supported or null, trigger direct browser download
      triggerApkDownload(targetUrl);
      if (onProgress) {
        onProgress({ percent: 100, receivedBytes: totalBytes, totalBytes, speedKBps: 0, stage: 'direct_triggered' });
      }
      return { success: true, fallback: true };
    }

    let receivedBytes = 0;
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      receivedBytes += value.length;

      const now = Date.now();
      const timeDelta = (now - lastSpeedCheckTime) / 1000;
      if (timeDelta >= 0.4) {
        const bytesDelta = receivedBytes - lastSpeedCheckBytes;
        currentSpeedKBps = Math.round((bytesDelta / 1024) / timeDelta);
        lastSpeedCheckTime = now;
        lastSpeedCheckBytes = receivedBytes;
      }

      const percent = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;

      if (onProgress) {
        onProgress({
          percent,
          receivedBytes,
          totalBytes,
          speedKBps: currentSpeedKBps,
          stage: 'downloading'
        });
      }
    }

    if (onProgress) {
      onProgress({
        percent: 100,
        receivedBytes,
        totalBytes: receivedBytes,
        speedKBps: currentSpeedKBps,
        stage: 'processing'
      });
    }

    // Assemble blob and trigger file save
    const blob = new Blob(chunks, { type: 'application/vnd.android.package-archive' });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = 'SmartAttend-release.apk';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 60000);

    if (onProgress) {
      onProgress({
        percent: 100,
        receivedBytes,
        totalBytes: receivedBytes,
        speedKBps: 0,
        stage: 'completed'
      });
    }

    return { success: true };
  } catch (err) {
    if (signal?.aborted) {
      return { success: false, error: 'Download cancelled by user' };
    }
    console.warn('[AppUpdate] Streamed download failed, falling back to direct browser download:', err);
    // Graceful fallback to browser's native download manager
    triggerApkDownload(targetUrl);
    if (onProgress) {
      onProgress({
        percent: 100,
        receivedBytes: 0,
        totalBytes: 0,
        speedKBps: 0,
        stage: 'direct_fallback'
      });
    }
    return { success: true, fallback: true, warning: err.message };
  }
}

