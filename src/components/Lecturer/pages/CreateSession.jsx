import { collection, addDoc, doc, setDoc } from "firebase/firestore";
import { auth, db } from "../../../firebase";

export async function createAttendanceSession(classCode, courseCode, roomNo, batch = "", lecturerInfo = {}) {
    const now = Date.now();
    const expiresAt = now + 2 * 60 * 1000;
    const currentUser = auth.currentUser;

    const lecturerName = lecturerInfo?.name || currentUser?.displayName || (currentUser?.email ? currentUser.email.split("@")[0] : "Lecturer");
    const lecturerEmail = (lecturerInfo?.email || currentUser?.email || "").toLowerCase().trim();
    const lecturerDept = lecturerInfo?.department || lecturerInfo?.branch || "General";

    const docRef = await addDoc(
        collection(db, "attendance_sessions"),
        {
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
        }
    );

    // Sync lecturer UID to authorizedUsers & users collections in background
    if (currentUser?.uid && lecturerEmail) {
        setDoc(doc(db, "authorizedUsers", lecturerEmail), {
            uid: currentUser.uid,
            name: lecturerName,
            department: lecturerDept,
            lastSessionCreated: now
        }, { merge: true }).catch(() => {});

        setDoc(doc(db, "users", lecturerEmail), {
            uid: currentUser.uid,
            email: lecturerEmail,
            name: lecturerName,
            department: lecturerDept,
            role: "lecturer",
            lastSessionCreated: now
        }, { merge: true }).catch(() => {});
    }

    return docRef.id;
}