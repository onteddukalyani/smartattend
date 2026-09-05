import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "../../../firebase";

export async function createAttendanceSession(classCode, courseCode, roomNo, batch = "", lecturerInfo = {}) {
    const now = Date.now();
    const expiresAt = now + 2 * 60 * 1000;
    const currentUser = auth.currentUser;

    const lecturerName = lecturerInfo?.name || currentUser?.displayName || (currentUser?.email ? currentUser.email.split("@")[0] : "Lecturer");
    const lecturerEmail = (lecturerInfo?.email || currentUser?.email || "").toLowerCase().trim();
    const rawDept = lecturerInfo?.department || lecturerInfo?.branch;
    const lecturerDept = (rawDept && String(rawDept).toLowerCase() !== "general") ? rawDept : "CSE";

    // Build structured, human-readable session Document ID
    // Example: CS201_2026-09-06_1030_kalyani_1234
    const cleanCourse = (courseCode || classCode || "CLASS").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    const cleanClass = classCode && classCode !== courseCode ? `_${classCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "")}` : "";
    const dateObj = new Date(now);
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, "0");
    const day = String(dateObj.getDate()).padStart(2, "0");
    const hours = String(dateObj.getHours()).padStart(2, "0");
    const mins = String(dateObj.getMinutes()).padStart(2, "0");
    const dateStr = `${year}-${month}-${day}`;
    const timeStr = `${hours}${mins}`;
    const lectPrefix = lecturerEmail ? `_${lecturerEmail.split("@")[0].replace(/[^a-zA-Z0-9_-]/g, "")}` : "";
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);

    const sessionId = `${cleanCourse}${cleanClass}_${dateStr}_${timeStr}${lectPrefix}_${randomSuffix}`;

    const sessionRef = doc(db, "attendance_sessions", sessionId);
    await setDoc(sessionRef, {
        classCode: classCode,
        batch: batch || "",
        courseCode: courseCode,
        roomNo: roomNo,
        createdAt: now,
        expiresAt: expiresAt,
        active: true,
        ownerId: currentUser ? currentUser.uid : "",
        ownerEmail: lecturerEmail,
        lecturerName: lecturerName,
        lecturerEmail: lecturerEmail,
        lecturerDepartment: lecturerDept
    });

    // Sync lecturer UID to authorizedUsers & users collections in background
    if (currentUser?.uid && lecturerEmail) {
        const prefix = lecturerEmail.split("@")[0].toLowerCase().trim();
        const lectProfile = {
            uid: currentUser.uid,
            email: lecturerEmail,
            name: lecturerName,
            department: lecturerDept,
            role: "lecturer",
            lastSessionCreated: now
        };

        setDoc(doc(db, "authorizedUsers", lecturerEmail), lectProfile, { merge: true }).catch(() => { });
        if (prefix && prefix !== lecturerEmail) {
            setDoc(doc(db, "authorizedUsers", prefix), lectProfile, { merge: true }).catch(() => { });
        }
        setDoc(doc(db, "users", lecturerEmail), lectProfile, { merge: true }).catch(() => { });
        if (prefix && prefix !== lecturerEmail) {
            setDoc(doc(db, "users", prefix), lectProfile, { merge: true }).catch(() => { });
        }
    }

    return sessionId;
}