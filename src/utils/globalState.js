/**
 * SmartAttend Global Synchronized State Engine
 * 
 * Provides global variables and synchronized reactive storage across all pages and tabs.
 * Whenever any student, biometric vector, device binding, or session parameter is updated,
 * all open pages and components receive the update instantly.
 */

const GLOBAL_STORE_KEY = "smartattend_global_store_v1";

// In-memory global store attached to window for cross-component access
if (typeof window !== "undefined") {
    if (!window.__SMARTATTEND_GLOBAL_STORE__) {
        window.__SMARTATTEND_GLOBAL_STORE__ = {
            students: new Map(),
            variables: new Map(),
            subscribers: new Set()
        };
    }
}

function getStore() {
    if (typeof window === "undefined") {
        return { students: new Map(), variables: new Map(), subscribers: new Set() };
    }
    if (!window.__SMARTATTEND_GLOBAL_STORE__) {
        window.__SMARTATTEND_GLOBAL_STORE__ = {
            students: new Map(),
            variables: new Map(),
            subscribers: new Set()
        };
    }
    return window.__SMARTATTEND_GLOBAL_STORE__;
}

/**
 * Set a global variable accessible across all pages
 * @param {string} key 
 * @param {any} value 
 * @param {boolean} persistAcrossTabs 
 */
export function setGlobalVariable(key, value, persistAcrossTabs = true) {
    if (!key) return;
    const store = getStore();
    store.variables.set(key, value);

    // Notify in-memory subscribers
    store.subscribers.forEach((cb) => {
        try { cb(key, value); } catch (_) {}
    });

    if (typeof window !== "undefined") {
        try {
            window.dispatchEvent(new CustomEvent("smartattend:global-variable-changed", {
                detail: { key, value, timestamp: Date.now() }
            }));

            if (persistAcrossTabs) {
                localStorage.setItem(`smartattend_global_var_${key}`, JSON.stringify({
                    value,
                    timestamp: Date.now()
                }));
            }
        } catch (_) {}
    }
}

/**
 * Get a global variable
 * @param {string} key 
 * @param {any} defaultValue 
 */
export function getGlobalVariable(key, defaultValue = null) {
    if (!key) return defaultValue;
    const store = getStore();
    if (store.variables.has(key)) {
        return store.variables.get(key);
    }
    if (typeof window !== "undefined") {
        try {
            const raw = localStorage.getItem(`smartattend_global_var_${key}`);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.value !== undefined) {
                    store.variables.set(key, parsed.value);
                    return parsed.value;
                }
            }
        } catch (_) {}
    }
    return defaultValue;
}

/**
 * Set or update a student in the global store.
 * Immediately synchronizes across memory, window events, and cross-tab storage.
 * @param {object} studentData 
 */
export function setGlobalStudent(studentData) {
    if (!studentData) return;
    const store = getStore();
    const cleanRoll = String(studentData.rollNo || studentData.id || "").trim().toUpperCase();
    const cleanEmail = String(studentData.email || "").trim().toLowerCase();

    const existing = cleanRoll ? (store.students.get(cleanRoll) || {}) : {};
    const merged = { ...existing, ...studentData };
    if (cleanRoll) merged.rollNo = cleanRoll;
    if (cleanEmail) merged.email = cleanEmail;

    if (cleanRoll) {
        store.students.set(cleanRoll, merged);
    }
    if (cleanEmail) {
        store.students.set(cleanEmail, merged);
    }

    setGlobalVariable(`student_${cleanRoll || cleanEmail}`, merged, true);
    return merged;
}

/**
 * Get student data from global store (memory first, then storage)
 * @param {string} rollOrEmail 
 */
export function getGlobalStudent(rollOrEmail) {
    if (!rollOrEmail) return null;
    const key = String(rollOrEmail).trim();
    const upperKey = key.toUpperCase();
    const lowerKey = key.toLowerCase();
    const store = getStore();

    if (store.students.has(upperKey)) return store.students.get(upperKey);
    if (store.students.has(lowerKey)) return store.students.get(lowerKey);

    return getGlobalVariable(`student_${upperKey}`) || getGlobalVariable(`student_${lowerKey}`) || null;
}

/**
 * Subscribe to global state changes across components & pages
 * @param {Function} callback (key, value) => void
 * @returns {Function} unsubscribe cleanup
 */
export function subscribeToGlobalState(callback) {
    if (typeof window === "undefined" || typeof callback !== "function") {
        return () => {};
    }
    const store = getStore();
    store.subscribers.add(callback);

    const handleCustomEvent = (e) => {
        if (e && e.detail) {
            callback(e.detail.key, e.detail.value);
        }
    };

    const handleStorageEvent = (e) => {
        if (e.key && e.key.startsWith("smartattend_global_var_") && e.newValue) {
            try {
                const varName = e.key.replace("smartattend_global_var_", "");
                const parsed = JSON.parse(e.newValue);
                if (parsed && parsed.value !== undefined) {
                    store.variables.set(varName, parsed.value);
                    callback(varName, parsed.value);
                }
            } catch (_) {}
        }
    };

    window.addEventListener("smartattend:global-variable-changed", handleCustomEvent);
    window.addEventListener("storage", handleStorageEvent);

    return () => {
        store.subscribers.delete(callback);
        window.removeEventListener("smartattend:global-variable-changed", handleCustomEvent);
        window.removeEventListener("storage", handleStorageEvent);
    };
}
