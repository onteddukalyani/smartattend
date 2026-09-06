/**
 * Centralized attendance and course calculation engine for Student Portal.
 * Ensures 100% consistency across Student Dashboard, Courses, and Statistics.
 */

export function normalizeCode(str) {
    if (!str) return "";
    return String(str).toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
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

    // 2. Enrich and sort attendance records
    const enrichedRecords = recordsDocs.map((rec) => {
        const session = sessionMap.get(rec.sessionId) || {};
        const rawCourse = rec.courseCode || session.courseCode || rec.classCode || session.classCode || "General";
        const cleanCourse = (rawCourse === "N/A" || !rawCourse) ? "General" : rawCourse.trim();

        return {
            ...rec,
            courseCode: cleanCourse,
            classCode: rec.classCode || session.classCode || cleanCourse,
            roomNo: rec.roomNo || session.roomNo || "N/A",
            lecturerName: rec.lecturerName || session.lecturerName || "Faculty",
            submittedAt: rec.submittedAt || session.createdAt || Date.now()
        };
    });

    // Sort descending by submission time
    enrichedRecords.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

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

        return {
            ...course,
            totalConducted,
            attendedCount,
            percentage,
            status,
            leavesAvailable,
            classesNeeded,
            history: matchingRecords
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
