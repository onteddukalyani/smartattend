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
 * - Changes by Admins, Lecturers, or Students sync in real-time across all portals.
 */

const ROLL_PATTERN = /^\d{2}[a-zA-Z]{3}\d{2,4}$/i;

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

export function isStudentDocument(d, docId) {
    if (!d) return false;
    const role = String(d.role || "").toLowerCase().trim();
    if (role === "lecturer" || role === "faculty" || role === "professor" || role === "admin" || role === "superadmin") {
        return false;
    }
    if (role === "student") return true;
    if (d.rollNo || d.semester || d.branch || d.department || d.faceDescriptor || d.biometricEnrolled) return true;
    if (ROLL_PATTERN.test(docId)) return true;
    return false;
}

export function extractCanonicalRoll(data, docId) {
    if (!data) return String(docId || "").trim().toUpperCase();

    // 1. Explicit clean rollNo property
    if (data.rollNo && String(data.rollNo).trim()) {
        let r = String(data.rollNo).trim();
        if (r.includes("@")) r = r.split("@")[0];
        return r.toUpperCase();
    }

    // 2. Doc ID matches standard roll format (e.g. "23BCS055")
    if (docId && ROLL_PATTERN.test(String(docId).trim())) {
        return String(docId).trim().toUpperCase();
    }

    // 3. Email prefix matches standard roll format (e.g. "23bcs055@iiitdwd.ac.in")
    const email = String(data.email || (docId && String(docId).includes("@") ? docId : "")).trim().toLowerCase();
    if (email.includes("@")) {
        const prefix = email.split("@")[0].trim();
        return prefix.toUpperCase();
    }

    // 4. Fallback to doc ID
    if (docId && String(docId).trim()) {
        let cleanId = String(docId).trim();
        if (cleanId.includes("@")) cleanId = cleanId.split("@")[0];
        return cleanId.toUpperCase();
    }

    return "STUDENT";
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

    // PASS 1: Build identity alias mappings (email -> canonicalRoll, prefix -> canonicalRoll, id -> canonicalRoll)
    const aliasToRollMap = new Map();

    allRawDocs.forEach(({ data, id }) => {
        const rawRoll = data.rollNo ? String(data.rollNo).trim().toUpperCase() : (ROLL_PATTERN.test(id) ? id.toUpperCase() : "");
        const email = String(data.email || (id.includes("@") ? id : "")).trim().toLowerCase();
        const prefix = email ? email.split("@")[0].toUpperCase() : "";

        if (rawRoll) {
            if (email) aliasToRollMap.set(email, rawRoll);
            if (prefix) aliasToRollMap.set(prefix, rawRoll);
            if (id) aliasToRollMap.set(id.toUpperCase(), rawRoll);
        }
    });

    // PASS 2: Merge into canonical student records
    const studentsMap = new Map();

    allRawDocs.forEach(({ data, id }) => {
        const email = String(data.email || (id.includes("@") ? id : "")).trim().toLowerCase();
        const prefix = email ? email.split("@")[0].toUpperCase() : "";

        let canonicalRoll = "";
        if (data.rollNo && String(data.rollNo).trim()) {
            canonicalRoll = String(data.rollNo).trim().toUpperCase();
            if (canonicalRoll.includes("@")) canonicalRoll = canonicalRoll.split("@")[0];
        } else if (aliasToRollMap.has(email)) {
            canonicalRoll = aliasToRollMap.get(email);
        } else if (aliasToRollMap.has(prefix)) {
            canonicalRoll = aliasToRollMap.get(prefix);
        } else if (aliasToRollMap.has(id.toUpperCase())) {
            canonicalRoll = aliasToRollMap.get(id.toUpperCase());
        } else {
            canonicalRoll = extractCanonicalRoll(data, id);
        }

        canonicalRoll = canonicalRoll.toUpperCase().trim();
        if (!canonicalRoll) return;

        const existing = studentsMap.get(canonicalRoll) || {};

        // Merge clean email
        const cleanEmail = email || existing.email || (canonicalRoll.toLowerCase() + "@iiitdwd.ac.in");

        // Merge Branch
        let branch = data.branch || data.department || existing.branch || "CSE";
        if (String(branch).toLowerCase() === "general") branch = "CSE";
        branch = String(branch).toUpperCase().trim();

        // Merge Name (prefer actual name over generic fallback or roll number)
        let name = data.name || data.fullName || data.displayName || existing.name || "";
        if ((!name || name.toLowerCase() === "student" || name.toUpperCase() === canonicalRoll) && existing.name && existing.name.toLowerCase() !== "student" && existing.name.toUpperCase() !== canonicalRoll) {
            name = existing.name;
        }
        if (!name) name = canonicalRoll;

        // Merge Facial Biometrics (128-D vector)
        const docVector = normalizeDescriptor(data.faceDescriptor);
        const existingVector = normalizeDescriptor(existing.faceDescriptor);
        const faceDescriptor = docVector || existingVector || null;

        const faceRegistered = Boolean(
            faceDescriptor ||
            data.faceRegistered === true ||
            existing.faceRegistered === true ||
            data.biometricEnrolled === true ||
            existing.biometricEnrolled === true
        );

        const biometricEnrolled = Boolean(
            faceDescriptor ||
            data.biometricEnrolled === true ||
            existing.biometricEnrolled === true ||
            data.faceRegistered === true ||
            existing.faceRegistered === true
        );

        const photoURL = data.photoURL || data.image || data.photo || existing.photoURL || "";

        studentsMap.set(canonicalRoll, {
            ...existing,
            ...data,
            id: canonicalRoll,
            rollNo: canonicalRoll,
            userDocId: canonicalRoll,
            name: name,
            email: cleanEmail,
            branch: branch,
            semester: data.semester || existing.semester || "1",
            phone: data.phone || data.phoneNumber || existing.phone || "",
            gender: data.gender || existing.gender || "",
            status: data.status || existing.status || "active",
            faceRegistered: faceRegistered,
            biometricEnrolled: biometricEnrolled,
            hasFaceRegistered: faceRegistered,
            faceDescriptor: faceDescriptor,
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

