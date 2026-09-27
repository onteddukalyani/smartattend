/**
 * SmartAttend APK Download URL Resolver
 * 
 * Firebase Hosting on the Spark (free) plan blocks hosting executable files (.apk).
 * Therefore, when running in production (e.g. smart-attendance-ok.web.app), the download link
 * points directly to the GitHub raw release binary.
 * When running in local development (localhost, 127.0.0.1, or local port 5173), it uses the local /SmartAttend-release.apk.
 */

export const GITHUB_RELEASE_APK_URL = 'https://github.com/onteddukalyani/smartattend/raw/main/SmartAttend-release.apk';

export function getApkDownloadUrl() {
  const envUrl = import.meta.env.VITE_ANDROID_APK_URL?.trim();
  if (envUrl) {
    return envUrl;
  }

  if (typeof window !== 'undefined') {
    const { hostname, port } = window.location;
    // Local dev server check
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      port === '5173' ||
      port === '8080'
    ) {
      return '/SmartAttend-release.apk';
    }
  }

  return GITHUB_RELEASE_APK_URL;
}
