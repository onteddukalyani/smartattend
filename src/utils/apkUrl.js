/**
 * SmartAttend Resilient APK Download URL Resolver
 * 
 * Provides multiple resilient mirrors (GitHub Raw, GitHub Releases, Local Dev)
 * with automatic fallback to prevent stalled downloads in restricted network environments.
 */

export const GITHUB_RAW_APK_URL = 'https://raw.githubusercontent.com/onteddukalyani/smartattend/main/SmartAttend-release.apk';
export const GITHUB_RELEASE_APK_URL = 'https://github.com/onteddukalyani/smartattend/raw/main/SmartAttend-release.apk';

export const APK_MIRRORS = [
  {
    id: 'raw_cdn',
    label: 'Primary CDN (Fast Raw)',
    url: GITHUB_RAW_APK_URL,
    description: 'High-speed raw content delivery'
  },
  {
    id: 'github_main',
    label: 'Mirror 1 (GitHub Direct)',
    url: GITHUB_RELEASE_APK_URL,
    description: 'Direct GitHub repository binary'
  }
];

export function getApkMirrors() {
  if (typeof window !== 'undefined') {
    const { hostname, port } = window.location;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      port === '5173' ||
      port === '8080'
    ) {
      return [
        {
          id: 'local_dev',
          label: 'Local Dev Server',
          url: '/SmartAttend-release.apk',
          description: 'Locally bundled APK binary'
        },
        ...APK_MIRRORS
      ];
    }
  }
  return APK_MIRRORS;
}

export function getApkDownloadUrl(preferredMirrorId) {
  const envUrl = import.meta.env.VITE_ANDROID_APK_URL?.trim();
  if (envUrl) {
    return envUrl;
  }

  if (preferredMirrorId) {
    const match = getApkMirrors().find((m) => m.id === preferredMirrorId);
    if (match) return match.url;
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

  // Use fast raw CDN as primary for higher reliability
  return GITHUB_RAW_APK_URL;
}

