import { initiateSession } from "../../../services/sessionAuthService";
import { auth } from "../../../firebase";

/**
 * Creates a new 2-Phase Attendance Session via Cloud Functions / Firestore
 * Returns session object with sessionId, secure qr1Token, and 60-second qr1ExpiresAt.
 */
export async function createAttendanceSession(classCode, courseCode, roomNo, batch = "", lecturerInfo = {}, lectureHours = 1.0) {
    const currentUser = auth.currentUser;
    const lecturerName = lecturerInfo?.name || currentUser?.displayName || (currentUser?.email ? currentUser.email.split("@")[0] : "Lecturer");
    const lecturerEmail = (lecturerInfo?.email || currentUser?.email || "").toLowerCase().trim();
    const rawDept = lecturerInfo?.department || lecturerInfo?.branch;
    const lecturerDept = (rawDept && String(rawDept).toLowerCase() !== "general") ? rawDept : "CSE";
    const finalBatch = (batch && String(batch).trim() !== "" && batch !== "—") ? String(batch).trim() : "2025";
    const parsedHours = Number(lectureHours) > 0 ? Number(lectureHours) : 1.0;

    const sessionParams = {
        classCode: classCode,
        courseCode: courseCode,
        roomNo: roomNo,
        batch: finalBatch,
        lectureHours: parsedHours,
        lecturerInfo: {
            name: lecturerName,
            email: lecturerEmail,
            department: lecturerDept
        }
    };

    const result = await initiateSession(sessionParams);
    return result;
}