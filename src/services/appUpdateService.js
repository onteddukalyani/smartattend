import { doc, getDoc, setDoc, onSnapshot, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { getApkDownloadUrl, GITHUB_RELEASE_APK_URL, getApkMirrors } from "../utils/apkUrl";
import { sendBroadcastNotification } from "./notificationsService";
import { triggerRealAppNotification } from "./nativeNotificationService";

export const CURRENT_APP_VERSION = "1.0.4";
export const CURRENT_APP_VERSION_CODE = 6;
export const APP_BUILD_DATE = "2026-10-23";

let cachedRunningVersion = null;
let cachedRunningVersionCode = null;

/**
 * Dynamically resolves the true running version of the app.
 * On native Android APK, queries native package manager via @capacitor/app App.getInfo().
 */
export async function getRunningAppVersion() {
  if (cachedRunningVersion) {
    return { version: cachedRunningVersion, versionCode: cachedRunningVersionCode };
  }
  let v = CURRENT_APP_VERSION;
  let code = CURRENT_APP_VERSION_CODE;
  if (Capacitor.isNativePlatform()) {
    try {
      const info = await App.getInfo();
      if (info && info.version) {
        v = String(info.version).trim();
      }
      if (info && info.build) {
        const parsed = parseInt(info.build, 10);
        if (Number.isFinite(parsed) && parsed > 0) code = parsed;
      }
    } catch (_) {}
  }
  cachedRunningVersion = v;
  cachedRunningVersionCode = code;
  return { version: v, versionCode: code };
}

const GITHUB_VERSION_JSON_URL = "https://raw.githubusercontent.com/onteddukalyani/smartattend/main/version.json";
const UPDATE_CHECK_CACHE_MS = 15000;
let updateCheckPromise = null;
let cachedUpdateCheck = null;
let cachedUpdateCheckAt = 0;

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

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });
    return response.ok ? await response.json() : null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Shares concurrent checks and briefly caches successful results so lifecycle
 * events and the periodic poll do not launch duplicate network requests.
 */
export function checkForAppUpdate() {
  if (updateCheckPromise) return updateCheckPromise;
  if (cachedUpdateCheck && Date.now() - cachedUpdateCheckAt < UPDATE_CHECK_CACHE_MS) {
    return Promise.resolve(cachedUpdateCheck);
  }

  updateCheckPromise = performAppUpdateCheck()
    .then((info) => {
      if (info?.success && !info.isOffline) {
        cachedUpdateCheck = info;
        cachedUpdateCheckAt = Date.now();
      }
      return info;
    })
    .finally(() => {
      updateCheckPromise = null;
    });

  return updateCheckPromise;
}

async function performAppUpdateCheck() {
  const running = await getRunningAppVersion();

  // 1. Immediate offline check
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return {
      success: false,
      isOffline: true,
      hasUpdate: false,
      currentVersion: running.version,
      currentVersionCode: running.versionCode,
      latestVersion: running.version,
      message: "Device is offline. Connect to the internet to check for updates."
    };
  }

  let remoteData = null;

  // 2. Try Firestore first, but keep update checks responsive when it is unavailable.
  try {
    let timeoutId;
    const firestorePromise = getDoc(doc(db, "app_updates", "latest"))
      .then((snapshot) => ({ snapshot }));
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve({ timedOut: true }), 1200);
    });
    let firestoreResult;
    try {
      firestoreResult = await Promise.race([firestorePromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
    if (firestoreResult?.timedOut) {
      console.debug("[AppUpdate] Firestore check timed out; using the version-file fallback.");
    }
    const snap = firestoreResult?.snapshot;
    if (snap && snap.exists && snap.exists()) {
      remoteData = snap.data();
    }
  } catch (err) {
    console.debug("[AppUpdate] Firestore update check unavailable:", err.message);
  }

  // 3. The deployed site's version file is the fastest public fallback.
  if (!remoteData) {
    try {
      remoteData = await fetchJsonWithTimeout(`/version.json?_nocache=${Date.now()}`, 2500);
    } catch (err) {
      console.debug("[AppUpdate] Site version file unavailable:", err.message);
    }
  }

  // 4. Use GitHub only when the current host cannot serve its version file.
  if (!remoteData) {
    try {
      remoteData = await fetchJsonWithTimeout(
        `${GITHUB_VERSION_JSON_URL}?_nocache=${Date.now()}`,
        4000
      );
    } catch (err) {
      console.warn("[AppUpdate] Public version fallback unavailable:", err.message);
    }
  }

  if (!remoteData) {
    return {
      success: false,
      hasUpdate: false,
      currentVersion: running.version,
      currentVersionCode: running.versionCode,
      latestVersion: running.version,
      message: "Unable to reach update servers at this time."
    };
  }

  return parseRemoteUpdateData(remoteData, running.version, running.versionCode);
}

/**
 * Standardize and evaluate remote update data against current app build.
 */
export function parseRemoteUpdateData(remoteData, activeVersion = null, activeVersionCode = null) {
  if (!remoteData) return null;
  const isNative = Capacitor.isNativePlatform();
  const currentVer = activeVersion || cachedRunningVersion || CURRENT_APP_VERSION;
  const currentCode = activeVersionCode || cachedRunningVersionCode || CURRENT_APP_VERSION_CODE;
  const latestVersion = remoteData.version || currentVer;
  const latestVersionCode = remoteData.versionCode || currentCode;
  const minRequiredVersion = remoteData.minRequiredVersion || "1.0.0";

  const hasNewerVersion =
    compareVersions(latestVersion, currentVer) > 0 ||
    (latestVersionCode > currentCode && compareVersions(latestVersion, currentVer) >= 0);

  const isMandatory =
    Boolean(remoteData.isMandatory) ||
    compareVersions(minRequiredVersion, currentVer) > 0;

  const apkUrl = remoteData.apkUrl || getApkDownloadUrl() || GITHUB_RELEASE_APK_URL;

  return {
    success: true,
    hasUpdate: hasNewerVersion,
    isNative,
    currentVersion: currentVer,
    currentVersionCode: currentCode,
    latestVersion,
    latestVersionCode,
    minRequiredVersion,
    isMandatory,
    mandatoryReason: remoteData.mandatoryReason || (isMandatory ? `Version v${minRequiredVersion} or higher is required to continue.` : ""),
    releaseDate: remoteData.releaseDate || APP_BUILD_DATE,
    title: remoteData.title || `SmartAttend v${latestVersion} Available`,
    releaseNotes: Array.isArray(remoteData.releaseNotes)
      ? remoteData.releaseNotes
      : (typeof remoteData.releaseNotes === "string" ? [remoteData.releaseNotes] : ["Performance improvements and general bug fixes."]),
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
    // If Capacitor native Android, open URL in system browser/DownloadManager
    if (Capacitor.isNativePlatform()) {
      try {
        window.open(url, "_system");
        return;
      } catch (_) {
        window.location.href = url;
        return;
      }
    }

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

    // On native Android, also trigger system browser/DownloadManager for direct package installer prompt
    if (Capacitor.isNativePlatform()) {
      triggerApkDownload(targetUrl);
    }

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

/**
 * Real-time active subscription for app updates.
 * Directly listens to Firestore app_updates/latest with onSnapshot,
 * and maintains a periodic background poll for remote releases.
 * Whoever has the app open will immediately receive the update notification.
 *
 * @param {function} onUpdateDetected - Callback invoked with updateInfo when a newer version is active.
 * @returns {function} Unsubscribe cleanup function.
 */
export function subscribeToAppUpdates(onUpdateDetected) {
  if (typeof onUpdateDetected !== "function") return () => { };

  let isMounted = true;
  let lastReportedVersion = null;

  const notifyIfNew = (info) => {
    if (!isMounted || !info || !info.hasUpdate) return;
    if (lastReportedVersion !== info.latestVersion) {
      lastReportedVersion = info.latestVersion;
      onUpdateDetected(info);
    }
  };

  // 1. Live Firestore onSnapshot (instant real-time push to all active users)
  let unsubFirestore = () => { };
  try {
    const updateDocRef = doc(db, "app_updates", "latest");
    unsubFirestore = onSnapshot(
      updateDocRef,
      (snapshot) => {
        if (!isMounted) return;
        if (snapshot && snapshot.exists && snapshot.exists()) {
          const info = parseRemoteUpdateData(snapshot.data());
          if (info && info.hasUpdate) {
            notifyIfNew(info);
          }
        }
      },
      (err) => {
        console.info("[AppUpdate] Realtime listener notice:", err.message);
      }
    );
  } catch (err) {
    console.warn("[AppUpdate] Firestore snapshot setup notice:", err.message);
  }

  // 2. Initial proactive check
  checkForAppUpdate().then((info) => {
    if (isMounted && info && info.hasUpdate) {
      notifyIfNew(info);
    }
  }).catch(() => { });

  // 3. Heartbeat polling (every 60 seconds) to catch CDN / version.json updates
  const pollInterval = setInterval(() => {
    if (!isMounted) return;
    checkForAppUpdate().then((info) => {
      if (isMounted && info && info.hasUpdate) {
        notifyIfNew(info);
      }
    }).catch(() => { });
  }, 60000);

  return () => {
    isMounted = false;
    try { unsubFirestore(); } catch (_) { }
    clearInterval(pollInterval);
  };
}

/**
 * Admin action: Publish an update release to Firestore and broadcast a real-time
 * update notification to all connected users (Students, Lecturers, Admins).
 */
export async function publishAppUpdate({
  version,
  versionCode,
  minRequiredVersion,
  isMandatory = false,
  mandatoryReason = "",
  releaseNotes = [],
  title = "",
  apkUrl = "",
  fileSizeBytes = 0,
  sha256Checksum = "",
  publisherEmail = "Admin"
}) {
  const cleanVersion = String(version || "").trim();
  if (!cleanVersion) {
    throw new Error("Version string is required to publish an update.");
  }

  const cleanVersionCode = Number(versionCode) || 1;
  const notesArray = Array.isArray(releaseNotes)
    ? releaseNotes.filter(Boolean)
    : (typeof releaseNotes === "string"
      ? releaseNotes.split("\n").map(s => s.trim()).filter(Boolean)
      : ["Performance improvements and general bug fixes."]);

  const targetApkUrl = apkUrl || getApkDownloadUrl() || GITHUB_RELEASE_APK_URL;

  const payload = {
    version: cleanVersion,
    versionCode: cleanVersionCode,
    minRequiredVersion: String(minRequiredVersion || "1.0.0").trim(),
    isMandatory: Boolean(isMandatory),
    mandatoryReason: mandatoryReason || (isMandatory ? `Version v${minRequiredVersion || cleanVersion} or higher is required.` : ""),
    releaseNotes: notesArray.length > 0 ? notesArray : ["Performance improvements and general bug fixes."],
    title: title || `SmartAttend v${cleanVersion} Available`,
    apkUrl: targetApkUrl,
    fileSizeBytes: Number(fileSizeBytes) || 0,
    sha256Checksum: (sha256Checksum || "").trim(),
    platform: "android",
    releaseDate: new Date().toISOString().split("T")[0],
    updatedAt: serverTimestamp(),
    publishedBy: publisherEmail || "Admin"
  };

  // 1. Write to Firestore app_updates/latest
  const docRef = doc(db, "app_updates", "latest");
  await setDoc(docRef, payload, { merge: true });

  // 2. Broadcast notification to all active users and all roles
  try {
    await sendBroadcastNotification(
      `🚀 SmartAttend Update (v${cleanVersion}) Available`,
      `A new update for SmartAttend (v${cleanVersion}) is available. Please update your app to continue.`,
      "APP_UPDATE",
      publisherEmail || "System Administrator",
      ["student", "lecturer", "admin", "all"],
      {
        version: cleanVersion,
        apkUrl: targetApkUrl,
        isMandatory: Boolean(isMandatory),
        actionable: true,
        actionType: "APP_UPDATE"
      }
    );
  } catch (err) {
    console.warn("[AppUpdate] Broadcast notice:", err.message);
  }

  // 3. Local OS notification trigger
  try {
    await triggerRealAppNotification({
      id: `pub_update_${cleanVersion}_${Date.now()}`,
      title: `🚀 Update Available (v${cleanVersion})`,
      message: `A new version of SmartAttend is ready to install. Tap to update.`,
      type: "APP_UPDATE",
      timestamp: Date.now()
    });
  } catch (_) { }

  return { success: true, version: cleanVersion };
}
