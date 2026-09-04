import { collection, addDoc } from "firebase/firestore";
import { auth, db } from "../../../firebase";

export async function createAttendanceSession(classCode, courseCode, roomNo) {
    const now = Date.now();
    const expiresAt = now + 2 * 60 * 1000;
    const docRef = await addDoc(
        collection(db, "attendance_sessions"),
        {
            classCode: classCode,
            courseCode: courseCode,
            roomNo: roomNo,
            createdAt: now,
            expiresAt: expiresAt,
            active: true,
            ownerId: auth.currentUser.uid
        }
    );
    return docRef.id;
}