import { doc, deleteDoc, collection, query, where, getDocs } from "firebase/firestore";
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

        let canonicalRoll = "";
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
        let branch = (data.branch && String(data.branch).toLowerCase() !== "general") ? data.branch : (existing.branch || data.department || "CSE");
        if (String(branch).toLowerCase() === "general") branch = "CSE";
        branch = String(branch).toUpperCase().trim();

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

        // Merge Facial Biometrics (128-D vector)
        const docVector = normalizeDescriptor(data.faceDescriptor) || normalizeDescriptor(data.descriptor);
        const existingVector = normalizeDescriptor(existing.faceDescriptor) || normalizeDescriptor(existing.descriptor);
        const faceDescriptor = docVector || existingVector || null;

        const latestEnrolledAt = Math.max(data.enrolledAt || 0, existing.enrolledAt || 0);
        const latestRemovedAt = Math.max(data.faceRemovedAt || 0, existing.faceRemovedAt || 0);
        const isExplicitlyRemoved = Boolean(latestRemovedAt > 0 && latestRemovedAt > latestEnrolledAt && !docVector);

        const hasValidVector = Boolean(
            !isExplicitlyRemoved &&
            faceDescriptor &&
            Array.isArray(faceDescriptor) &&
            faceDescriptor.length === 128
        );

        const faceRegistered = hasValidVector;
        const biometricEnrolled = hasValidVector;
        const hasFaceRegistered = hasValidVector;

        let photoURL = "";
        if (!isExplicitlyRemoved && hasValidVector) {
            photoURL = (data.photoURL && data.photoURL.length > 5) ? data.photoURL : (existing.photoURL || data.image || data.photo || "");
        }

        // Non-destructive field resolution
        const phone = (data.phone && data.phone !== "-") ? data.phone : (existing.phone || data.phoneNumber || "");
        const gender = data.gender || existing.gender || "";
        const semester = (data.semester && String(data.semester).trim() && String(data.semester).trim() !== "1") ? String(data.semester).trim() : (existing.semester || data.semester || "1");
        const status = (data.status === "inactive" || existing.status === "inactive") ? "inactive" : (data.status || existing.status || "active");

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
            faceRegistered: faceRegistered,
            biometricEnrolled: biometricEnrolled,
            hasFaceRegistered: hasFaceRegistered,
            faceDescriptor: hasValidVector ? faceDescriptor : null,
            photoURL: photoURL,
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

    const collections = ["students", "users", "authorizedUsers"];
    const deletePromises = [];

    // 1. Delete all direct keys across all 3 collections
    for (const coll of collections) {
        for (const key of candidateKeys) {
            deletePromises.push(deleteDoc(doc(db, coll, key)).catch(() => {}));
        }
    }

    // 2. Query any docs by rollNo or email fields across all 3 collections
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

    await Promise.all(deletePromises);
}
