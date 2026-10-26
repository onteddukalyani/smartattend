import { doc, deleteDoc, collection, query, where, getDocs, setDoc } from "firebase/firestore";
import { db } from "../firebase";

/**
 * =========================================================
 * UNIFIED STUDENT MERGE & NORMALIZATION ENGINE
 * =========================================================
 * Merges raw Firestore document snapshots from:
 * 1. 'students' collection
 * 2. 'users' collection
 * 3. 'authorizedUsers' collection
 * 
 * Guarantees that:
 * - Each student appears EXACTLY ONCE (canonical Roll Number).
 * - Face biometrics (128-D vector & photoURL) merge seamlessly from whichever doc has it.
 * - Profile details (Name, Branch, Semester, Email, Phone, Status) are fully unified.
 * - Prevents data collisions between different students.
 */

// Supports: 25bcs108, 23BCS055, 24DSAI012, 25CS108, 25AI050, 2025BCS108, 25-BCS-108, etc.
export const ROLL_PATTERN = /^(\d{2,4}[-_]?[a-zA-Z]{2,5}[-_]?\d{2,4}|\d{5,12})$/i;

/**
 * Normalizes branch and department names into standard short forms consistently:
 * - Computer Science and Engineering -> CSE
 * - Artificial Intelligence and Computing -> AIC
 * - Data Science and Artificial Intelligence -> DSAI
 * - Electronics and Communication Engineering -> ECE
 */
export function normalizeBranchName(branch) {
    if (!branch) return "CSE";
    const str = String(branch).trim().toUpperCase();
    if (!str) return "CSE";

    if (str === "CSE" || str === "CE" || str === "CSE-A" || str === "CSE-B" || str === "GENERAL") return "CSE";
    if (str === "ECE") return "ECE";
    if (str === "DSAI" || str === "DS & AI" || str === "DS/AI" || str === "DS-AI") return "DSAI";
    if (str === "AIC" || str === "AI & COMPUTING" || str === "AI/COMPUTING" || str === "AI-C") return "AIC";

    const clean = str.replace(/[^A-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

    // 1. Check Data Science & AI (DSAI)
    if (clean.includes("DATA SCIENCE") || clean.includes("DSAI") || (clean.includes("DATA") && clean.includes("AI")) || (clean.includes("DS") && clean.includes("AI"))) return "DSAI";

    // 2. Check Artificial Intelligence & Computing (AIC)
    if (clean.includes("CYBERNETIC") || clean.includes("AIC") || (clean.includes("COMPUTING") && (clean.includes("AI") || clean.includes("ARTIFICIAL"))) || clean.includes("INTELLIGENCE AND COMPUTING") || clean.includes("AI COMPUTING")) return "AIC";

    // 3. Check Electronics & Communication Engineering (ECE)
    if (clean.includes("ELECTRONIC") || clean.includes("COMMUNICATION") || clean.includes("ECE") || clean.includes("EC")) return "ECE";

    // 4. Check Computer Science and Engineering (CSE)
    if (clean.includes("COMPUTER") || clean.includes("CSE") || clean.includes("SOFTWARE") || clean === "CS" || clean === "CE") return "CSE";

    // 5. Fallback for standalone AI / Data
    if (clean.includes("DATA")) return "DSAI";
    if (clean.includes("ARTIFICIAL") || clean.includes("INTELLIGENCE") || clean.includes("AI")) return "AIC";

    return "CSE";
}

const GENERIC_IDENTIFIERS = new Set([
    "student",
    "user",
    "admin",
    "lecturer",
    "faculty",
    "professor",
    "staff",
    "test",
    "demo",
    "sample",
    "info",
    "contact"
]);

/**
 * Validates if a given string is a generic identifier, placeholder, or email prefix rather than a real human name.
 */
export function isGenericName(n, rollNo = "", email = "") {
    if (!n) return true;
    const str = String(n).trim();
    if (!str) return true;
    const lower = str.toLowerCase();
    const cleanRoll = String(rollNo || "").trim().toLowerCase();
    const cleanEmail = String(email || "").trim().toLowerCase();
    const emailPrefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase() : "";

    if (
        GENERIC_IDENTIFIERS.has(lower) ||
        lower === "null" ||
        lower === "undefined" ||
        lower === "n/a" ||
        lower === "na" ||
        lower === "none" ||
        lower.includes("@") ||
        (cleanRoll && lower === cleanRoll) ||
        (cleanRoll && lower.replace(/[-_]/g, "") === cleanRoll.replace(/[-_]/g, "")) ||
        (emailPrefix && lower === emailPrefix)
    ) {
        return true;
    }
    return false;
}

/**
 * Normalizes any 128-D face descriptor (Array, Float32Array, or indexed object).
 */
export function normalizeDescriptor(desc) {
    if (!desc) return null;
    if (Array.isArray(desc) && desc.length === 128) return desc;
    if (desc instanceof Float32Array && desc.length === 128) return Array.from(desc);
    if (typeof desc === "object") {
        const values = Object.values(desc);
        if (values.length === 128 && typeof values[0] === "number") {
            return values;
        }
    }
    return null;
}

/**
 * Checks if a document belongs to a student rather than admin/lecturer.
 */
export function isStudentDocument(d, docId) {
    if (!d) return false;
    const role = String(d.role || "").toLowerCase().trim();
    if (role === "lecturer" || role === "faculty" || role === "professor" || role === "admin" || role === "superadmin" || role === "staff") {
        return false;
    }
    if (d.cabin || d.cabinNumber || d.designation) {
        return false;
    }
    if (role === "student") return true;
    if (d.rollNo || d.semester || d.faceDescriptor || d.biometricEnrolled) return true;
    if (docId && ROLL_PATTERN.test(String(docId).trim())) return true;
    return false;
}

/**
 * Extracts canonical uppercase Roll Number from document data or docId.
 */
export function extractCanonicalRoll(data, docId) {
    if (!data && !docId) return "";

    // 1. Explicit clean rollNo property
    if (data?.rollNo && String(data.rollNo).trim()) {
        let r = String(data.rollNo).trim();
        if (r.includes("@")) r = r.split("@")[0];
        const cleaned = r.toUpperCase().replace(/\s+/g, "");
        if (!GENERIC_IDENTIFIERS.has(cleaned.toLowerCase())) {
            return cleaned;
        }
    }

    // 2. Doc ID matches standard roll format (e.g. "25BCS108")
    const cleanId = String(docId || "").trim();
    if (cleanId && ROLL_PATTERN.test(cleanId)) {
        return cleanId.toUpperCase();
    }

    // 3. Email prefix matches standard roll format (e.g. "25bcs108@iiitdwd.ac.in")
    const email = String(data?.email || (cleanId.includes("@") ? cleanId : "")).trim().toLowerCase();
    if (email.includes("@")) {
        const prefix = email.split("@")[0].trim();
        if (ROLL_PATTERN.test(prefix)) {
            return prefix.toUpperCase();
        }
    }

    // 4. Fallback: If docId is valid and not a generic keyword or UID
    if (cleanId && !cleanId.includes("@") && cleanId.length <= 20 && !GENERIC_IDENTIFIERS.has(cleanId.toLowerCase())) {
        return cleanId.toUpperCase();
    }

    // 5. If email prefix is not generic
    if (email.includes("@")) {
        const prefix = email.split("@")[0].trim();
        if (prefix && !GENERIC_IDENTIFIERS.has(prefix.toLowerCase())) {
            return prefix.toUpperCase();
        }
    }

    return "";
}

/**
 * Merges multi-collection document snapshots into a unified, deduplicated student array.
 */
export function mergeAllStudentRecords(authDocs = [], studentsDocs = [], usersDocs = []) {
    // If students collection in Firestore is empty (0 docs), return empty array so UI immediately reflects database state
    if (Array.isArray(studentsDocs) && studentsDocs.length === 0) {
        return [];
    }

    const allRawDocs = [];

    const addDoc = (docSnap) => {
        if (!docSnap) return;
        const data = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
        const id = docSnap.id || data.id || data.rollNo || "";
        if (isStudentDocument(data, id)) {
            allRawDocs.push({ data, id: String(id).trim() });
        }
    };

    authDocs.forEach(addDoc);
    studentsDocs.forEach(addDoc);
    usersDocs.forEach(addDoc);

    // PASS 1: Build strict identity alias mappings (exact specific email -> canonicalRoll)
    // Uses extractCanonicalRoll so email-based IDs and prefixes map immediately to canonical roll
    const emailToRollMap = new Map();
    const docIdToRollMap = new Map();

    allRawDocs.forEach(({ data, id }) => {
        const canonical = extractCanonicalRoll(data, id);
        const email = String(data.email || (id.includes("@") ? id : "")).trim().toLowerCase();

        if (canonical && !GENERIC_IDENTIFIERS.has(canonical.toLowerCase())) {
            if (email && email.includes("@")) {
                emailToRollMap.set(email, canonical);
            }
            if (id && id.toUpperCase() !== canonical && id.length > 3 && !GENERIC_IDENTIFIERS.has(id.toLowerCase())) {
                docIdToRollMap.set(id.toUpperCase(), canonical);
            }
        }
    });

    // PASS 2: Merge into canonical student records
    const studentsMap = new Map();

    allRawDocs.forEach(({ data, id }) => {
        const email = String(data.email || (id.includes("@") ? id : "")).trim().toLowerCase();

        let canonicalRoll;
        if (email && emailToRollMap.has(email)) {
            canonicalRoll = emailToRollMap.get(email);
        } else if (docIdToRollMap.has(id.toUpperCase())) {
            canonicalRoll = docIdToRollMap.get(id.toUpperCase());
        } else {
            canonicalRoll = extractCanonicalRoll(data, id);
        }

        canonicalRoll = String(canonicalRoll || "").toUpperCase().trim();
        if (canonicalRoll.includes("@")) {
            canonicalRoll = canonicalRoll.split("@")[0].toUpperCase().trim();
        }
        if (!canonicalRoll || GENERIC_IDENTIFIERS.has(canonicalRoll.toLowerCase())) return;

        const existing = studentsMap.get(canonicalRoll) || {};

        // Merge clean email
        const cleanEmail = (email && email.includes("@")) ? email : (existing.email || (canonicalRoll.toLowerCase() + "@iiitdwd.ac.in"));

        // Merge Branch
        let rawBranch = (data.branch && String(data.branch).toLowerCase() !== "general") ? data.branch : (existing.branch || data.department || "CSE");
        let branch = normalizeBranchName(rawBranch);

        // Merge Name (prefer authoritative human name over generic placeholder, email prefix, or roll number)
        let name = existing.name;
        if (isGenericName(name, canonicalRoll, cleanEmail) && !isGenericName(data.name, canonicalRoll, cleanEmail)) name = String(data.name).trim();
        if (isGenericName(name, canonicalRoll, cleanEmail) && !isGenericName(data.fullName, canonicalRoll, cleanEmail)) name = String(data.fullName).trim();
        if (isGenericName(name, canonicalRoll, cleanEmail) && !isGenericName(data.displayName, canonicalRoll, cleanEmail)) name = String(data.displayName).trim();
        if (!name || isGenericName(name, canonicalRoll, cleanEmail)) {
            name = (!isGenericName(data.name, canonicalRoll, cleanEmail) ? data.name : null) ||
                   (!isGenericName(data.fullName, canonicalRoll, cleanEmail) ? data.fullName : null) ||
                   (!isGenericName(data.displayName, canonicalRoll, cleanEmail) ? data.displayName : null) ||
                   existing.name ||
                   canonicalRoll;
        }

        const hasStoredFace = Boolean(
            data.faceRegistered || data.biometricEnrolled || data.hasFaceRegistered ||
            existing.faceRegistered || existing.biometricEnrolled || existing.hasFaceRegistered ||
            normalizeDescriptor(data.faceDescriptor) || normalizeDescriptor(data.descriptor) ||
            normalizeDescriptor(existing.faceDescriptor) || normalizeDescriptor(existing.descriptor)
        );

        const docEnrolledAt = Number(data.enrolledAt || data.faceEnrolledAt || 0) || 0;
        const existingEnrolledAt = Number(existing.enrolledAt || existing.faceEnrolledAt || 0) || 0;
        const latestEnrolledAt = Math.max(docEnrolledAt, existingEnrolledAt);

        const latestRemovedAt = data.faceRemovedAt || existing.faceRemovedAt || null;

        const isExplicitlyRemoved = Boolean(
            latestRemovedAt && (!latestEnrolledAt || latestRemovedAt > latestEnrolledAt) &&
            !data.isRegistered && !existing.isRegistered && !data.registeredGlobally && !existing.registeredGlobally
        );

        const faceRegistered = Boolean(!isExplicitlyRemoved && (hasStoredFace || data.isRegistered || existing.isRegistered || data.registeredGlobally || existing.registeredGlobally));
        const biometricEnrolled = faceRegistered;
        const hasFaceRegistered = faceRegistered;

        let photoURL = "";
        if (!isExplicitlyRemoved) {
            photoURL = (data.photoURL && data.photoURL.length > 5) ? data.photoURL : (existing.photoURL || data.image || data.photo || "");
        }

        // Non-destructive field resolution
        const phone = (data.phone && data.phone !== "-") ? data.phone : (existing.phone || data.phoneNumber || "");
        const gender = data.gender || existing.gender || "";
        const semester = (data.semester && String(data.semester).trim() && String(data.semester).trim() !== "1") ? String(data.semester).trim() : (existing.semester || data.semester || "1");
        const status = (data.status === "inactive" || existing.status === "inactive") ? "inactive" : (data.status || existing.status || "active");
        const latestResetAt = Math.max(
            Number(data.deviceResetAt || 0),
            Number(existing.deviceResetAt || 0),
            Number(data.deviceFingerprintResetAt || 0),
            Number(existing.deviceFingerprintResetAt || 0)
        );
        const latestSelectedAt = Math.max(
            Number(data.deviceSelectedAt || data.platformBoundAt || 0),
            Number(existing.deviceSelectedAt || existing.platformBoundAt || 0)
        );

        const isResetExplicit = Boolean(
            data.deviceTypeLocked === false ||
            existing.deviceTypeLocked === false ||
            data.isDeviceRegistered === false ||
            existing.isDeviceRegistered === false ||
            (latestResetAt > 0 && latestResetAt >= latestSelectedAt)
        );

        const deviceType = isResetExplicit ? null : (data.deviceType || existing.deviceType || null);
        const deviceTypeLocked = isResetExplicit ? false : Boolean(data.deviceTypeLocked ?? existing.deviceTypeLocked ?? false);
        const deviceSelectedAt = isResetExplicit ? null : (data.deviceSelectedAt || existing.deviceSelectedAt || null);
        const deviceResetAt = latestResetAt > 0 ? latestResetAt : null;
        const hwBioEnrolled = isResetExplicit ? false : Boolean(
            data.hardwareBiometricEnrolled !== false && existing.hardwareBiometricEnrolled !== false &&
            (data.hardwareBiometricEnrolled || existing.hardwareBiometricEnrolled)
        );

        const isRegisteredGlobally = Boolean(
            data.isRegistered || existing.isRegistered ||
            data.registeredGlobally || existing.registeredGlobally ||
            data.registrationStatus === "registered" || existing.registrationStatus === "registered" ||
            faceRegistered || hwBioEnrolled || (deviceType && deviceTypeLocked)
        );

        studentsMap.set(canonicalRoll, {
            ...existing,
            ...data,
            id: canonicalRoll,
            rollNo: canonicalRoll,
            userDocId: canonicalRoll,
            name: name,
            fullName: name,
            email: cleanEmail,
            branch: branch,
            semester: semester,
            phone: phone,
            gender: gender,
            status: status,
            deviceType: deviceType,
            deviceTypeLocked: deviceTypeLocked,
            deviceSelectedAt: deviceSelectedAt,
            deviceResetAt: deviceResetAt,
            hardwareBiometricEnrolled: hwBioEnrolled,
            isDeviceRegistered: isResetExplicit ? false : Boolean(data.isDeviceRegistered ?? existing.isDeviceRegistered ?? (deviceType ? true : false)),
            faceRegistered: faceRegistered,
            biometricEnrolled: biometricEnrolled,
            hasFaceRegistered: hasFaceRegistered,
            isRegistered: isRegisteredGlobally,
            registeredGlobally: isRegisteredGlobally,
            registrationStatus: isRegisteredGlobally ? "registered" : "pending",
            faceDescriptor: null,
            photoURL: photoURL,
            enrolledAt: latestEnrolledAt,
            faceRemovedAt: isExplicitlyRemoved ? latestRemovedAt : null,
            role: "student"
        });
    });

    const studentList = Array.from(studentsMap.values());

    // Sort canonically by Roll Number
    studentList.sort((a, b) => {
        const rollA = a.rollNo || "";
        const rollB = b.rollNo || "";
        return rollA.localeCompare(rollB, undefined, { numeric: true, sensitivity: "base" });
    });

    return studentList;
}

/**
 * Permanently and completely deletes a student record across all Firestore collections
 * (students, users, authorizedUsers) for every potential identifier (Roll Number, lowercase roll, email, prefix, UID).
 */
export async function deleteStudentRecordCompletely(student) {
    if (!student) return;
    const roll = String(student.rollNo || student.id || "").trim().toUpperCase();
    const rollLower = roll.toLowerCase();
    const id = String(student.id || "").trim();
    const userDocId = String(student.userDocId || "").trim();
    const uid = String(student.uid || student.studentUid || "").trim();
    const email = student.email ? String(student.email).toLowerCase().trim() : "";
    const prefix = email ? email.split("@")[0].toLowerCase().trim() : (rollLower || "");
    const constructedEmail = rollLower ? `${rollLower}@iiitdwd.ac.in` : "";

    const candidateKeys = new Set(
        [
            roll,
            rollLower,
            id,
            userDocId,
            uid,
            email,
            prefix,
            constructedEmail
        ].filter((k) => k && k.length > 0 && !GENERIC_IDENTIFIERS.has(k.toLowerCase()))
    );

    const collections = ["students", "users", "authorizedUsers", "devices"];
    const deletePromises = [];

    // 1. Delete all direct keys across all primary collections
    for (const coll of collections) {
        for (const key of candidateKeys) {
            deletePromises.push(deleteDoc(doc(db, coll, key)).catch(() => {}));
        }
    }

    // 2. Query any docs by rollNo, email, or uid fields across primary collections
    const queryPromises = [];
    for (const coll of collections) {
        if (roll && !GENERIC_IDENTIFIERS.has(roll.toLowerCase())) {
            queryPromises.push(getDocs(query(collection(db, coll), where("rollNo", "==", roll))).catch(() => ({ docs: [] })));
            queryPromises.push(getDocs(query(collection(db, coll), where("rollNo", "==", rollLower))).catch(() => ({ docs: [] })));
        }
        if (email) {
            queryPromises.push(getDocs(query(collection(db, coll), where("email", "==", email))).catch(() => ({ docs: [] })));
        }
        if (constructedEmail && constructedEmail !== email) {
            queryPromises.push(getDocs(query(collection(db, coll), where("email", "==", constructedEmail))).catch(() => ({ docs: [] })));
        }
        if (uid) {
            queryPromises.push(getDocs(query(collection(db, coll), where("uid", "==", uid))).catch(() => ({ docs: [] })));
        }
    }

    const queryResults = await Promise.all(queryPromises);
    for (const snap of queryResults) {
        if (snap && snap.docs) {
            for (const d of snap.docs) {
                for (const coll of collections) {
                    deletePromises.push(deleteDoc(doc(db, coll, d.id)).catch(() => {}));
                }
            }
        }
    }

    // 3. Remove student from all enrolled courses
    try {
        const coursesSnap = await getDocs(collection(db, "courses"));
        coursesSnap.docs.forEach((courseDoc) => {
            const data = courseDoc.data();
            const enrolled = Array.isArray(data.students) ? data.students : (Array.isArray(data.enrolledStudents) ? data.enrolledStudents : []);
            
            const updatedEnrolled = enrolled.filter((s) => {
                const sRoll = typeof s === "string" ? s.toUpperCase().trim() : (s.rollNo || s.rollNumber || "").toUpperCase().trim();
                return !candidateKeys.has(sRoll);
            });

            if (updatedEnrolled.length !== enrolled.length) {
                deletePromises.push(setDoc(doc(db, "courses", courseDoc.id), {
                    students: updatedEnrolled,
                    enrolledStudents: updatedEnrolled,
                    updatedAt: Date.now()
                }, { merge: true }));
            }
        });
    } catch (_) {}

    await Promise.all(deletePromises);
}

/**
 * Purges any orphaned student documents in users/ or authorizedUsers/ 
 * if students collection was manually wiped or if student records are unlinked.
 */
export async function purgeOrphanedStudentDocuments() {
    try {
        const [studentsSnap, usersSnap, authSnap] = await Promise.all([
            getDocs(collection(db, "students")).catch(() => ({ docs: [] })),
            getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
            getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] }))
        ]);

        const validStudentRolls = new Set();
        studentsSnap.docs.forEach((docSnap) => {
            const data = docSnap.data();
            const roll = (data.rollNo || docSnap.id || "").toUpperCase().trim();
            if (roll) validStudentRolls.add(roll);
        });

        // If students collection is completely empty (0 docs), clean up lingering student role docs in users/ & authorizedUsers/
        if (studentsSnap.docs.length === 0) {
            const deletePromises = [];
            usersSnap.docs.forEach((docSnap) => {
                const data = docSnap.data();
                if (data.role === "student" || (data.rollNo && isStudentDocument(data, docSnap.id))) {
                    deletePromises.push(deleteDoc(doc(db, "users", docSnap.id)).catch(() => {}));
                }
            });
            authSnap.docs.forEach((docSnap) => {
                const data = docSnap.data();
                if (data.role === "student" || (data.rollNo && isStudentDocument(data, docSnap.id))) {
                    deletePromises.push(deleteDoc(doc(db, "authorizedUsers", docSnap.id)).catch(() => {}));
                }
            });
            await Promise.all(deletePromises);
            return { purgedCount: deletePromises.length };
        }
        return { purgedCount: 0 };
    } catch (err) {
        console.error("Error purging orphaned student documents:", err);
        return { purgedCount: 0, error: err.message };
    }
}

/**
 * =========================================================
 * REAL-TIME GLOBAL CROSS-PAGE & CROSS-TAB STATE SYNCHRONIZATION
 * =========================================================
 */
export const STUDENT_UPDATED_EVENT = "smartattend_student_updated";
export const PROFILE_UPDATED_EVENT = "smartattend_profile_updated";
export const STUDENT_STORAGE_KEY = "smartattend_last_student_update";

/**
 * Dispatches student updates across current window and all other browser tabs in real time.
 * Synchronizes local storage flags so Scanner, Dashboard, and Admin/Lecturer tables reflect changes immediately.
 */
export function broadcastStudentUpdate(updatedStudent) {
    if (!updatedStudent) return;
    try {
        const roll = String(updatedStudent.rollNo || updatedStudent.id || "").trim().toUpperCase();
        const uid = String(updatedStudent.uid || updatedStudent.studentUid || "").trim();
        const email = String(updatedStudent.email || "").trim().toLowerCase();
        const emailRoll = email ? email.split("@")[0].trim().toUpperCase() : "";

        // Synchronize browser localStorage state to prevent stale cached locks
        if (typeof window !== "undefined") {
            const isHwReset = Boolean(
                updatedStudent.deviceResetAt ||
                updatedStudent.deviceFingerprintResetAt ||
                updatedStudent.deviceTypeLocked === false ||
                updatedStudent.hardwareBiometricEnrolled === false ||
                updatedStudent.isDeviceRegistered === false
            );

            if (isHwReset) {
                try {
                    localStorage.removeItem("smartattend_student_device_locked");
                    localStorage.removeItem("smartattend_device_locked");
                    localStorage.removeItem("smartattend_student_device_type");
                    localStorage.removeItem("smartattend_device_type");
                    localStorage.removeItem("smartattend_device_registered");
                    localStorage.removeItem("smartattend_hw_enrolled");
                    localStorage.removeItem("smartattend_fingerprint_enrolled");
                    if (roll) localStorage.removeItem(`smartattend_hw_enrolled_${roll}`);
                    if (emailRoll) localStorage.removeItem(`smartattend_hw_enrolled_${emailRoll}`);
                    if (uid) localStorage.removeItem(`smartattend_hw_enrolled_${uid}`);
                } catch (_) {}
            } else if (updatedStudent.hardwareBiometricEnrolled) {
                try {
                    if (roll) localStorage.setItem(`smartattend_hw_enrolled_${roll}`, "true");
                    if (emailRoll) localStorage.setItem(`smartattend_hw_enrolled_${emailRoll}`, "true");
                    if (uid) localStorage.setItem(`smartattend_hw_enrolled_${uid}`, "true");
                    localStorage.setItem("smartattend_hw_enrolled", "true");
                    if (updatedStudent.deviceType) {
                        localStorage.setItem("smartattend_student_device_type", updatedStudent.deviceType);
                    }
                    localStorage.setItem("smartattend_student_device_locked", "true");
                    localStorage.setItem("smartattend_device_registered", "true");
                } catch (_) {}
            }

            const isFaceReset = Boolean(
                updatedStudent.faceRemovedAt ||
                updatedStudent.faceRegistered === false ||
                updatedStudent.biometricEnrolled === false ||
                updatedStudent.hasFaceRegistered === false
            );

            if (isFaceReset) {
                try {
                    localStorage.removeItem("smartattend_face_enrolled");
                    localStorage.removeItem("smartattend_student_face_enrolled");
                    if (roll) localStorage.removeItem(`smartattend_face_enrolled_${roll}`);
                    if (emailRoll) localStorage.removeItem(`smartattend_face_enrolled_${emailRoll}`);
                    if (uid) localStorage.removeItem(`smartattend_face_enrolled_${uid}`);
                } catch (_) {}
            } else if (updatedStudent.faceRegistered || updatedStudent.biometricEnrolled || updatedStudent.hasFaceRegistered) {
                try {
                    if (roll) localStorage.setItem(`smartattend_face_enrolled_${roll}`, "true");
                    if (emailRoll) localStorage.setItem(`smartattend_face_enrolled_${emailRoll}`, "true");
                    if (uid) localStorage.setItem(`smartattend_face_enrolled_${uid}`, "true");
                    localStorage.setItem("smartattend_face_enrolled", "true");
                    localStorage.setItem("smartattend_student_face_enrolled", "true");
                } catch (_) {}
            }

            // 1. Dispatch custom event in current window
            window.dispatchEvent(new CustomEvent(STUDENT_UPDATED_EVENT, { detail: updatedStudent }));

            // 2. Broadcast across tabs via storage event
            try {
                localStorage.setItem(STUDENT_STORAGE_KEY, JSON.stringify({
                    student: updatedStudent,
                    timestamp: Date.now()
                }));
            } catch (_) {}
        }
    } catch (err) {
        console.warn("Failed to broadcast student update:", err);
    }
}

/**
 * Subscribes to student updates across the current window and all browser tabs.
 * Returns an unsubscribe cleanup callback.
 */
export function subscribeToStudentUpdates(callback) {
    if (typeof window === "undefined" || typeof callback !== "function") {
        return () => {};
    }

    const handleCustomEvent = (event) => {
        if (event && event.detail) {
            callback(event.detail);
        }
    };

    const handleStorageEvent = (event) => {
        if (event.key === STUDENT_STORAGE_KEY && event.newValue) {
            try {
                const data = JSON.parse(event.newValue);
                if (data && data.student) {
                    callback(data.student);
                }
            } catch (_) {}
        }
    };

    window.addEventListener(STUDENT_UPDATED_EVENT, handleCustomEvent);
    window.addEventListener("storage", handleStorageEvent);

    return () => {
        window.removeEventListener(STUDENT_UPDATED_EVENT, handleCustomEvent);
        window.removeEventListener("storage", handleStorageEvent);
    };
}

/**
 * Resets student device locks, device types, and hardware fingerprint bindings globally
 * across all Firestore collections and informs every open page/tab in real time.
 */
export async function resetStudentDeviceLockGlobally(student, actorName = "Faculty/Admin") {
    if (!student) return null;
    const cleanRoll = String(student.rollNo || student.id || "").trim().toUpperCase();
    const studentUid = String(student.studentUid || student.uid || student.userDocId || "").trim();
    const cleanEmail = (student.email || "").toLowerCase().trim();
    const emailPrefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase().trim() : "";
    const now = Date.now();

    const resetPayload = {
        deviceType: null,
        deviceTypeLocked: false,
        deviceResetAt: now,
        deviceSelectedAt: null,
        hardwareBiometricEnrolled: false,
        hardwareBiometricPlatform: null,
        hardwareBiometricEnrolledAt: null,
        deviceFingerprint: null,
        biometricKeyAlias: null,
        isDeviceRegistered: false,
        registeredDevice: null,
        registeredPlatform: null,
        registeredDeviceType: null,
        deviceUUID: null,
        deviceModel: null,
        deviceIp: null,
        registrationIp: null,
        deviceResetBy: actorName
    };

    if (cleanRoll) {
        await setDoc(doc(db, "students", cleanRoll), resetPayload, { merge: true });
    }

    // Authorize student to immediately re-select and register new device & biometrics
    const permPayload = {
        rollNo: cleanRoll,
        studentRollNo: cleanRoll,
        registrationType: "both",
        mode: "reset_by_staff",
        status: "active",
        remainingUses: 5,
        grantedAt: now,
        expiresAt: now + 30 * 24 * 60 * 60 * 1000,
        reason: "Device lock reset by staff — re-registration authorized",
        grantedBy: actorName
    };

    if (cleanRoll) {
        await setDoc(doc(db, "biometric_reregistration_permissions", cleanRoll), permPayload, { merge: true }).catch(() => {});
    }

    const updated = {
        ...student,
        deviceType: null,
        deviceTypeLocked: false,
        hardwareBiometricEnrolled: false,
        hardwareBiometricPlatform: null,
        hardwareBiometricEnrolledAt: null,
        deviceFingerprint: null,
        biometricKeyAlias: null,
        isDeviceRegistered: false,
        deviceResetAt: now,
        deviceResetBy: actorName
    };

    broadcastStudentUpdate(updated);
    return updated;
}

