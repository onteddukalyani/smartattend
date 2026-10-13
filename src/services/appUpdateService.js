import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Capacitor } from "@capacitor/core";
import { getApkDownloadUrl, GITHUB_RELEASE_APK_URL, getApkMirrors } from "../utils/apkUrl";

export const CURRENT_APP_VERSION = "1.0.0";
export const CURRENT_APP_VERSION_CODE = 1;
export const APP_BUILD_DATE = "2026-10-01";

const GITHUB_VERSION_JSON_URL = "https://raw.githubusercontent.com/onteddukalyani/smartattend/main/version.json";

/**
 * Compare two semver version strings (e.g. '1.0.7' > '1.0.6', '1.0.0' > '1.0.0-rc.1')
 * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0;
  const clean1 = String(v1).replace(/^v/i, "").trim();
  const clean2 = String(v2).replace(/^v/i, "").trim();

  // Split core semver from pre-release tag (e.g., "1.0.0-rc.1")
  const [core1, pre1] = clean1.split("-");
  const [core2, pre2] = clean2.split("-");

  const p1 = core1.split(".").map((n) => parseInt(n, 10) || 0);
  const p2 = core2.split(".").map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  // Core versions are equal. Normal release is newer than pre-release
  if (pre1 && !pre2) return -1;
  if (!pre1 && pre2) return 1;
  if (pre1 && pre2) {
    if (pre1 > pre2) return 1;
    if (pre1 < pre2) return -1;
  }

  return 0;
}

/**
 * Computes SHA-256 digest of an ArrayBuffer or Blob using standard Web Crypto API.
 */
export async function computeSha256(data) {
  try {
    if (typeof window === "undefined" || !window.crypto || !window.crypto.subtle) {
      return null;
    }

    let buffer;
    if (data instanceof ArrayBuffer) {
      buffer = data;
    } else if (data instanceof Blob) {
      buffer = await data.arrayBuffer();
    } else if (ArrayBuffer.isView(data)) {
      buffer = data.buffer;
    } else {
      return null;
    }

    const hashBuffer = await window.crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (err) {
    console.warn("[AppUpdate] SHA-256 computation warning:", err);
    return null;
  }
}

/**
 * Checks for the latest version of SmartAttend with timeout, offline detection, and multi-tier fallback.
 */
export async function checkForAppUpdate() {
  const isNative = Capacitor.isNativePlatform();

  // 1. Immediate offline check
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return {
      success: false,
      isOffline: true,
      hasUpdate: false,
      currentVersion: CURRENT_APP_VERSION,
      currentVersionCode: CURRENT_APP_VERSION_CODE,
      latestVersion: CURRENT_APP_VERSION,
      message: "Device is offline. Connect to the internet to check for updates."
    };
  }

  let remoteData = null;

  // 2. Try fetching from Firestore first (Instant admin control) with 7s timeout
  try {
    const firestorePromise = getDoc(doc(db, "app_updates", "latest"));
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Firestore check timed out")), 7000)
    );
    const snap = await Promise.race([firestorePromise, timeoutPromise]);
    if (snap && snap.exists && snap.exists()) {
      remoteData = snap.data();
    }
  } catch (err) {
    console.warn("[AppUpdate] Firestore check notice, falling back to public version.json:", err.message);
  }

  // 3. Fallback to GitHub raw version.json
  if (!remoteData) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      const fetchUrl = `${GITHUB_VERSION_JSON_URL}?_nocache=${Date.now()}`;
      const res = await fetch(fetchUrl, { cache: "no-store", signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        remoteData = await res.json();
      }
    } catch (err) {
      console.warn("[AppUpdate] GitHub version check notice:", err.message);
    }
  }

  // 4. Fallback to bundled local public version.json
  if (!remoteData) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`/version.json?_nocache=${Date.now()}`, { cache: "no-store", signal: controller.signal });
      clearTimeout(timeoutId);
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
      message: "Unable to reach update servers at this time."
    };
  }

  const latestVersion = remoteData.version || CURRENT_APP_VERSION;
  const latestVersionCode = remoteData.versionCode || CURRENT_APP_VERSION_CODE;
  const minRequiredVersion = remoteData.minRequiredVersion || "1.0.0";

  const hasNewerVersion =
    compareVersions(latestVersion, CURRENT_APP_VERSION) > 0 ||
    (latestVersionCode > CURRENT_APP_VERSION_CODE && compareVersions(latestVersion, CURRENT_APP_VERSION) >= 0);

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
    minRequiredVersion,
    isMandatory,
    mandatoryReason: remoteData.mandatoryReason || (isMandatory ? `Version v${minRequiredVersion} or higher is required to continue.` : ""),
    releaseDate: remoteData.releaseDate || APP_BUILD_DATE,
    title: remoteData.title || `SmartAttend v${latestVersion} Available`,
    releaseNotes: Array.isArray(remoteData.releaseNotes)
      ? remoteData.releaseNotes
      : ["Performance improvements and general bug fixes."],
    history: Array.isArray(remoteData.history) ? remoteData.history : [],
    sha256Checksum: remoteData.sha256Checksum || "",
    fileSizeBytes: remoteData.fileSizeBytes || 0,
    platform: remoteData.platform || "android",
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
 * SHA-256 integrity verification, and indeterminate progress handling.
 * 
 * @param {Object} options
 * @param {string} options.url - The APK download URL
 * @param {string} [options.expectedChecksum] - SHA-256 hex checksum to verify against
 * @param {function} options.onProgress - Callback ({ percent, receivedBytes, totalBytes, speedKBps, stage, hasContentLength, actualChecksum })
 * @param {AbortSignal} [options.signal] - Optional AbortSignal
 * @returns {Promise<{ success: boolean, fallback?: boolean, error?: string, warning?: string, actualChecksum?: string }>}
 */
export async function downloadApkWithStream({ url, expectedChecksum, onProgress, signal }) {
  const targetUrl = url || getApkDownloadUrl();
  const startTime = Date.now();
  let lastSpeedCheckTime = startTime;
  let lastSpeedCheckBytes = 0;
  let currentSpeedKBps = 0;

  try {
    if (onProgress) {
      onProgress({ percent: 0, receivedBytes: 0, totalBytes: 0, speedKBps: 0, stage: 'connecting', hasContentLength: true });
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
    const hasContentLength = totalBytes > 0;
    const reader = response.body?.getReader();

    if (!reader) {
      // Fallback to direct browser download
      triggerApkDownload(targetUrl);
      if (onProgress) {
        onProgress({ percent: 100, receivedBytes: totalBytes, totalBytes, speedKBps: 0, stage: 'direct_triggered', hasContentLength });
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

      const percent = hasContentLength ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;

      if (onProgress) {
        onProgress({
          percent,
          receivedBytes,
          totalBytes,
          speedKBps: currentSpeedKBps,
          stage: 'downloading',
          hasContentLength
        });
      }
    }

    // Assemble blob
    const blob = new Blob(chunks, { type: 'application/vnd.android.package-archive' });

    // Cryptographic SHA-256 Checksum Verification (if expectedChecksum is configured)
    const cleanExpected = (expectedChecksum || "").trim().toLowerCase();
    const isChecksumEnforced = cleanExpected.length === 64 && !cleanExpected.includes("<");

    let computedHash = null;
    if (isChecksumEnforced) {
      if (onProgress) {
        onProgress({
          percent: 100,
          receivedBytes,
          totalBytes: receivedBytes,
          speedKBps: 0,
          stage: 'verifying_checksum',
          hasContentLength: true
        });
      }

      computedHash = await computeSha256(blob);

      if (computedHash && computedHash.toLowerCase() !== cleanExpected) {
        const errMsg = `Security Alert: SHA-256 checksum mismatch! Expected ${cleanExpected.slice(0, 8)}... but computed ${computedHash.slice(0, 8)}... File may be corrupted or modified.`;
        if (onProgress) {
          onProgress({
            percent: 100,
            receivedBytes,
            totalBytes: receivedBytes,
            speedKBps: 0,
            stage: 'checksum_mismatch',
            hasContentLength: true,
            actualChecksum: computedHash
          });
        }
        return {
          success: false,
          error: errMsg,
          actualChecksum: computedHash,
          expectedChecksum: cleanExpected
        };
      }
    }

    if (onProgress) {
      onProgress({
        percent: 100,
        receivedBytes,
        totalBytes: receivedBytes,
        speedKBps: currentSpeedKBps,
        stage: 'processing',
        hasContentLength: true,
        actualChecksum: computedHash
      });
    }

    // Trigger file save to device
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
        stage: 'completed',
        hasContentLength: true,
        actualChecksum: computedHash
      });
    }

    return { success: true, actualChecksum: computedHash };
  } catch (err) {
    if (signal?.aborted) {
      return { success: false, error: 'Download cancelled by user' };
    }
    console.warn('[AppUpdate] Streamed download notice, falling back to direct browser download:', err.message);
    triggerApkDownload(targetUrl);
    if (onProgress) {
      onProgress({
        percent: 100,
        receivedBytes: 0,
        totalBytes: 0,
        speedKBps: 0,
        stage: 'direct_fallback',
        hasContentLength: false
      });
    }
    return { success: true, fallback: true, warning: err.message };
  }
}


