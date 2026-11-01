const DISMISSED_VERSION_KEY = "smartattend_dismissed_update_version";
const NOTIFIED_VERSION_KEY = "smartattend_notified_update_version";

function getStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function normalizeVersionStr(v) {
  return String(v || "").replace(/^v/i, "").trim().toLowerCase();
}

export function isAppUpdateDismissed(version, storage) {
  if (!version) return false;
  try {
    const stored = getStorage(storage)?.getItem(DISMISSED_VERSION_KEY);
    return stored ? normalizeVersionStr(stored) === normalizeVersionStr(version) : false;
  } catch {
    return false;
  }
}

export function dismissAppUpdate(version, storage) {
  if (!version) return false;
  try {
    const targetStorage = getStorage(storage);
    if (!targetStorage) return false;
    targetStorage.setItem(DISMISSED_VERSION_KEY, normalizeVersionStr(version));
    targetStorage.removeItem("smartattend_dismissed_update_time");
    return true;
  } catch {
    return false;
  }
}

export function hasAppUpdateNotificationBeenShown(version, storage) {
  if (!version) return false;
  try {
    const stored = getStorage(storage)?.getItem(NOTIFIED_VERSION_KEY);
    return stored ? normalizeVersionStr(stored) === normalizeVersionStr(version) : false;
  } catch {
    return false;
  }
}

export function markAppUpdateNotificationShown(version, storage) {
  if (!version) return false;
  try {
    const targetStorage = getStorage(storage);
    if (!targetStorage) return false;
    targetStorage.setItem(NOTIFIED_VERSION_KEY, normalizeVersionStr(version));
    return true;
  } catch {
    return false;
  }
}
