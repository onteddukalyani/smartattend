/**
 * Centralized attendance and course calculation engine for Student Portal.
 * Ensures 100% consistency across Student Dashboard, Courses, and Statistics.
 */

export function normalizeCode(str) {
    if (!str) return "";
    return String(str).toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
}

export function parseTimestampMillis(ts) {
    if (!ts) return 0;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") {
        const parsed = Date.parse(ts);
        return isNaN(parsed) ? 0 : parsed;
    }
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.toDate === "function") return ts.toDate().getTime();
    if (typeof ts.seconds === "number") return ts.seconds * 1000 + (ts.nanoseconds ? Math.floor(ts.nanoseconds / 1000000) : 0);
    if (ts._seconds) return ts._seconds * 1000;
    return 0;
}

export function getCandidateRolls(user, profile, fetchedStudentData = null) {
    const set = new Set();

    const emailRoll = (user?.email || "").split("@")[0].trim().toUpperCase();
    const activeRollNo = (profile?.rollNo || fetchedStudentData?.rollNo || emailRoll || "").trim().toUpperCase();

    if (activeRollNo) {
        set.add(activeRollNo);
        set.add(activeRollNo.toLowerCase());
        const digits = activeRollNo.replace(/\D/g, "");
        if (digits && digits.length >= 2) set.add(digits);
    }

    if (profile?.rollNo) {
        const r = String(profile.rollNo).trim();
        set.add(r);
        set.add(r.toUpperCase());
        set.add(r.toLowerCase());
        const digits = r.replace(/\D/g, "");
        if (digits && digits.length >= 2) set.add(digits);
    }

    if (fetchedStudentData?.rollNo) {
        const r = String(fetchedStudentData.rollNo).trim();
        set.add(r);
        set.add(r.toUpperCase());
        set.add(r.toLowerCase());
        const digits = r.replace(/\D/g, "");
        if (digits && digits.length >= 2) set.add(digits);
    }

    if (user?.email) {
        const prefix = user.email.split("@")[0].trim();
        set.add(prefix);
        set.add(prefix.toUpperCase());
        set.add(prefix.toLowerCase());
        const digits = prefix.replace(/\D/g, "");
        if (digits && digits.length >= 2) set.add(digits);
    }

    if (user?.uid) {
        set.add(user.uid);
    }

    return Array.from(set).filter(Boolean);
}

/**
 * Computes unified metrics across courses, attendance sessions, and student records.
 */
export function computeStudentMetrics(coursesDocs = [], sessionsDocs = [], recordsDocs = [], studentProfile = {}) {
    // 1. Map sessions by ID
    const sessionMap = new Map();
    sessionsDocs.forEach((s) => {
        const id = s.id || s.sessionId;
        if (id) sessionMap.set(id, s);
    });

    const candidateSet = new Set((studentProfile.candidateRolls || []).map((r) => String(r).toUpperCase().trim()));
    if (studentProfile.rollNo) candidateSet.add(String(studentProfile.rollNo).toUpperCase().trim());
    if (studentProfile.email) candidateSet.add(String(studentProfile.email).split("@")[0].toUpperCase().trim());

    // 2. Enrich and sort attendance records (combining attendance_records AND session.attendees array)
    const recordsMap = new Map();

    recordsDocs.forEach((rec) => {
        const session = sessionMap.get(rec.sessionId) || {};
        const rawCourse = rec.courseCode || session.courseCode || rec.classCode || session.classCode || "General";
        const cleanCourse = (rawCourse === "N/A" || !rawCourse) ? "General" : rawCourse.trim();
        const key = rec.id || `${rec.sessionId}_${rec.rollNo || ""}`;

        recordsMap.set(key, {
            ...rec,
            courseCode: cleanCourse,
            classCode: rec.classCode || session.classCode || cleanCourse,
            roomNo: rec.roomNo || session.roomNo || "N/A",
            lecturerName: rec.lecturerName || session.lecturerName || "Faculty",
            submittedAt: rec.submittedAt || session.createdAt || Date.now()
        });
    });

    // Also ingest embedded attendees on session docs matching this student
    if (candidateSet.size > 0) {
        sessionsDocs.forEach((s) => {
            if (Array.isArray(s.attendees)) {
                s.attendees.forEach((att) => {
                    const roll = (att.rollNo || att.roll || att.studentId || "").toUpperCase().trim();
                    const email = (att.studentEmail || att.email || "").split("@")[0].toUpperCase().trim();
                    if (roll && (candidateSet.has(roll) || (email && candidateSet.has(email)))) {
                        const key = att.id || `${s.id}_${roll}`;
                        if (!recordsMap.has(key)) {
                            const rawCourse = s.courseCode || s.classCode || "General";
                            const cleanCourse = (rawCourse === "N/A" || !rawCourse) ? "General" : rawCourse.trim();
                            recordsMap.set(key, {
                                id: key,
                                sessionId: s.id,
                                rollNo: roll,
                                courseCode: cleanCourse,
                                classCode: s.classCode || cleanCourse,
                                roomNo: s.roomNo || "N/A",
                                lecturerName: s.lecturerName || "Faculty",
                                submittedAt: att.submittedAt || att.timestamp || s.createdAt || Date.now()
                            });
                        }
                    }
                });
            }
        });
    }

    const enrichedRecords = Array.from(recordsMap.values());

    // Sort descending by submission time safely using parseTimestampMillis
    enrichedRecords.sort((a, b) => parseTimestampMillis(b.submittedAt) - parseTimestampMillis(a.submittedAt));

    // 3. Build comprehensive course catalog
    // Start with official courses collection
    const courseMap = new Map();

    coursesDocs.forEach((c) => {
        const rawCode = (c.courseCode || c.code || c.id || "").trim().toUpperCase();
        const norm = normalizeCode(rawCode);
        if (norm) {
            courseMap.set(norm, {
                id: c.id || rawCode,
                courseCode: rawCode,
                courseName: c.courseName || c.name || rawCode,
                lecturerName: c.lecturerName || c.faculty || "Assigned Faculty",
                lecturerEmail: c.lecturerEmail || "",
                department: c.department || c.dept || "",
                semester: c.semester || "",
                batch: c.batch || "",
                defaultRoom: c.defaultRoom || c.roomNo || "Main Hall",
                credits: c.credits || 3,
                description: c.description || "",
                ...c
            });
        }
    });

    // Auto-discover any active courses appearing in sessions or records that aren't in the courses collection yet
    sessionsDocs.forEach((s) => {
        const sCourse = (s.courseCode || s.classCode || "").trim().toUpperCase();
        const norm = normalizeCode(sCourse);
        if (norm && !courseMap.has(norm)) {
            courseMap.set(norm, {
                id: sCourse,
                courseCode: sCourse,
                courseName: sCourse,
                lecturerName: s.lecturerName || "Faculty",
                lecturerEmail: s.lecturerEmail || s.ownerEmail || "",
                department: s.department || studentProfile.branch || studentProfile.department || "General",
                semester: s.semester || studentProfile.semester || "1",
                batch: s.batch || studentProfile.batch || "2025",
                defaultRoom: s.roomNo || "N/A",
                credits: 3,
                description: `Lecture sessions conducted for ${sCourse}`
            });
        }
    });

    enrichedRecords.forEach((r) => {
        const rCourse = (r.courseCode || r.classCode || "").trim().toUpperCase();
        const norm = normalizeCode(rCourse);
        if (norm && !courseMap.has(norm) && norm !== "GENERAL" && norm !== "NA") {
            courseMap.set(norm, {
                id: rCourse,
                courseCode: rCourse,
                courseName: rCourse,
                lecturerName: r.lecturerName || "Faculty",
                lecturerEmail: "",
                department: studentProfile.branch || studentProfile.department || "General",
                semester: studentProfile.semester || "1",
                batch: studentProfile.batch || "2025",
                defaultRoom: r.roomNo || "N/A",
                credits: 3,
                description: `Attended classes for ${rCourse}`
            });
        }
    });

    // 4. Calculate stats for each course
    const allCoursesList = Array.from(courseMap.values());

    const coursesWithStats = allCoursesList.map((course) => {
        const cNorm = normalizeCode(course.courseCode);
        const cNameNorm = normalizeCode(course.courseName);

        // Find all sessions conducted for this course
        const matchingSessions = sessionsDocs.filter((s) => {
            const sCodeNorm = normalizeCode(s.courseCode || s.classCode || "");
            const sIdNorm = normalizeCode(s.id || "");
            return (
                (cNorm && sCodeNorm === cNorm) ||
                (cNorm && sIdNorm.includes(cNorm)) ||
                (cNameNorm && sCodeNorm === cNameNorm)
            );
        });

        // Find student records for this course
        const matchingRecords = enrichedRecords.filter((r) => {
            const rCodeNorm = normalizeCode(r.courseCode || r.classCode || "");
            if (cNorm && rCodeNorm === cNorm) return true;
            if (cNameNorm && rCodeNorm === cNameNorm) return true;

            // Match via sessionId
            if (r.sessionId) {
                const parentSession = sessionMap.get(r.sessionId);
                if (parentSession) {
                    const psNorm = normalizeCode(parentSession.courseCode || parentSession.classCode || "");
                    if (cNorm && psNorm === cNorm) return true;
                }
            }
            return false;
        });

        const attendedCount = matchingRecords.length;
        // Total conducted is at least as large as the sessions found or attended records
        const totalConducted = Math.max(matchingSessions.length, attendedCount);

        let percentage = null;
        if (totalConducted > 0) {
            percentage = Math.min(100, Math.round((attendedCount / totalConducted) * 100));
        }

        // Safety math
        let status = "none";
        let leavesAvailable = 0;
        let classesNeeded = 0;

        if (totalConducted > 0 && percentage !== null) {
            if (percentage >= 75) {
                status = "safe";
                leavesAvailable = Math.floor((attendedCount - 0.75 * totalConducted) / 0.75);
                if (leavesAvailable < 0) leavesAvailable = 0;
            } else if (percentage >= 65) {
                status = "warning";
                classesNeeded = Math.ceil((0.75 * totalConducted - attendedCount) / 0.25);
                if (classesNeeded < 0) classesNeeded = 0;
            } else {
                status = "danger";
                classesNeeded = Math.ceil((0.75 * totalConducted - attendedCount) / 0.25);
                if (classesNeeded < 0) classesNeeded = 0;
            }
        }

        // Build detailed conducted sessions list with student's Present / Absent status
        const attendedSessionIds = new Set(matchingRecords.map((r) => String(r.sessionId || "").trim().toUpperCase()).filter(Boolean));
        const detailedSessions = matchingSessions.map((s) => {
            const sid = String(s.id || "").trim().toUpperCase();
            const myRecord = matchingRecords.find((r) => String(r.sessionId || "").trim().toUpperCase() === sid || (r.id && String(r.id).toUpperCase().startsWith(`${sid}_`)));
            const isPresent = Boolean(myRecord) || attendedSessionIds.has(sid);

            return {
                id: s.id,
                courseCode: s.courseCode || course.courseCode,
                topic: s.topic || s.courseName || course.courseName,
                roomNo: s.roomNo || course.defaultRoom || "Main Hall",
                lecturerName: s.lecturerName || course.lecturerName || "Faculty",
                createdAt: s.createdAt || s.timestamp || Date.now(),
                isPresent,
                submittedAt: myRecord ? (myRecord.submittedAt || s.createdAt) : null,
                faceVerified: myRecord?.faceVerified ?? true
            };
        }).sort((a, b) => parseTimestampMillis(b.createdAt) - parseTimestampMillis(a.createdAt));

        return {
            ...course,
            totalConducted,
            attendedCount,
            percentage,
            status,
            leavesAvailable,
            classesNeeded,
            history: matchingRecords,
            sessions: detailedSessions
        };
    });

    // 5. Aggregate calculations
    const totalAttended = enrichedRecords.length;

    // Total conducted is sum of all conducted sessions for courses the student is involved in / registered
    const activeSubjects = coursesWithStats.filter((c) => c.totalConducted > 0);
    const sumConducted = activeSubjects.reduce((acc, c) => acc + c.totalConducted, 0);
    const totalConducted = Math.max(sumConducted, totalAttended);
    const totalMissed = Math.max(0, totalConducted - totalAttended);

    const overallPercentage = totalConducted > 0
        ? Math.min(100, Math.round((totalAttended / totalConducted) * 100))
        : (totalAttended > 0 ? 100 : 0);

    const neededToReach75 = overallPercentage < 75 && totalConducted > 0
        ? Math.max(0, Math.ceil((0.75 * totalConducted - totalAttended) / 0.25))
        : 0;

    const safeToMiss = overallPercentage >= 75 && totalConducted > 0
        ? Math.max(0, Math.floor((totalAttended - 0.75 * totalConducted) / 0.75))
        : 0;

    const lastAttendedDate = enrichedRecords.length > 0 && enrichedRecords[0].submittedAt
        ? new Date(enrichedRecords[0].submittedAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric"
        })
        : "No classes yet";

    const safeSubjectsCount = activeSubjects.filter((c) => (c.percentage || 0) >= 75).length;
    const shortageSubjectsCount = activeSubjects.filter((c) => (c.percentage || 0) < 75).length;

    return {
        coursesWithStats,
        enrichedRecords,
        totalAttended,
        totalConducted,
        totalMissed,
        overallPercentage,
        neededToReach75,
        safeToMiss,
        lastAttended: lastAttendedDate,
        activeSubjectsCount: activeSubjects.length,
        safeSubjectsCount,
        shortageSubjectsCount,
        totalCoursesCount: coursesWithStats.length
    };
}
