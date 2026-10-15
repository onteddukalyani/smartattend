import { initiateSession } from "../../../services/sessionAuthService";
import { auth } from "../../../firebase";
import { normalizeBranchName } from "../../../utils/studentDataHelper";

/**
 * Creates a new 2-Phase Attendance Session via Cloud Functions / Firestore
 * Returns session object with sessionId, secure qr1Token, and 60-second qr1ExpiresAt.
 */
export async function createAttendanceSession(
    classCode,
    courseCode,
    roomNo,
    batch = "",
    lecturerInfo = {},
    lectureHours = 1.0,
    geofenceRadius = 30,
    durationMinutes = 3,
    timetableOptions = {}
) {
    const currentUser = auth.currentUser;
    const lecturerName = lecturerInfo?.name || currentUser?.displayName || (currentUser?.email ? currentUser.email.split("@")[0] : "Lecturer");
    const lecturerEmail = (lecturerInfo?.email || currentUser?.email || "").toLowerCase().trim();
    const rawDept = lecturerInfo?.department || lecturerInfo?.branch;
    const lecturerDept = normalizeBranchName(rawDept || "CSE");
    const finalBatch = (batch && String(batch).trim() !== "" && batch !== "—") ? String(batch).trim() : "2025";
    const parsedHours = Number(lectureHours) > 0 ? Number(lectureHours) : 1.0;
    const finalClassCode = normalizeBranchName(classCode || "CSE");
    const parsedRadius = typeof geofenceRadius === "number" ? geofenceRadius : 30;
    const parsedDuration = Number(durationMinutes) > 0 ? Number(durationMinutes) : 3;

    const qr1Sec = Number(timetableOptions?.qr1DurationSeconds) > 0
        ? Number(timetableOptions.qr1DurationSeconds)
        : Math.min(60, Math.round((parsedDuration * 60) / 3));
    const qr2Sec = Number(timetableOptions?.qr2DurationSeconds) > 0
        ? Number(timetableOptions.qr2DurationSeconds)
        : Math.max(15, (parsedDuration * 60) - qr1Sec);

    const sessionParams = {
        classCode: finalClassCode,
        courseCode: courseCode,
        roomNo: roomNo,
        batch: finalBatch,
        lectureHours: parsedHours,
        geofenceRadius: parsedRadius,
        durationMinutes: Math.round(((qr1Sec + qr2Sec) / 60) * 10) / 10,
        qr1DurationSeconds: qr1Sec,
        qr2DurationSeconds: qr2Sec,
        lecturerInfo: {
            name: lecturerName,
            email: lecturerEmail,
            department: lecturerDept
        }
    };

    const result = await initiateSession(sessionParams);
    return result;
}