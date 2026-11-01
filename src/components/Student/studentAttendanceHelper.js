export function normalizeBranchName(branch) {
    if (!branch) return "";
    const str = String(branch).trim().toUpperCase();
    if (!str) return "";
    if (str === "GENERAL" || str === "ALL") return "GENERAL";
    if (str === "CSE" || str === "CE" || str === "CSE-A" || str === "CSE-B") return "CSE";
    if (str === "ECE") return "ECE";
    if (str === "DSAI" || str === "DS & AI" || str === "DS/AI" || str === "DS-AI") return "DSAI";
    if (str === "AIC" || str === "AI & COMPUTING" || str === "AI/COMPUTING" || str === "AI-C") return "AIC";
    const clean = str.replace(/[^A-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (clean === "GENERAL" || clean === "ALL") return "GENERAL";
    if (clean.includes("DATA SCIENCE") || clean.includes("DSAI") || (clean.includes("DATA") && clean.includes("AI")) || (clean.includes("DS") && clean.includes("AI"))) return "DSAI";
    if (clean.includes("CYBERNETIC") || clean.includes("AIC") || (clean.includes("COMPUTING") && (clean.includes("AI") || clean.includes("ARTIFICIAL"))) || clean.includes("INTELLIGENCE AND COMPUTING") || clean.includes("AI COMPUTING")) return "AIC";
    if (clean.includes("ELECTRONIC") || clean.includes("ECE") || clean.includes("COMMUNICATION")) return "ECE";
    if (clean.includes("COMPUTER") || clean.includes("CSE") || clean.includes("SOFTWARE") || clean.includes("PROGRAMMING") || clean.includes("INFORMATION") || clean.includes("IT")) return "CSE";
    return str;
}

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
    if (ts instanceof Date) return ts.getTime();
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

export function isStudentEnrolledInCourse(course, studentIdentifiers, studentProfile = {}, enrichedRecords = []) {
    if (!course) return false;
    const rawCourseCode = normalizeCode(course.courseCode || course.code || course.id || "");

    // 1. Check explicit roster if available
    const roster = [
        ...(Array.isArray(course.enrolledStudents) ? course.enrolledStudents : []),
        ...(Array.isArray(course.students) ? course.students : [])
    ];

    if (roster.length > 0) {
        const inRoster = roster.some((entry) => {
            const identifiers = entry && typeof entry === "object"
                ? [entry.rollNo, entry.rollNumber, entry.studentId, entry.uid, entry.email, entry.id]
                : [entry];

            return identifiers.some((value) => {
                const identifier = String(value || "").trim().toUpperCase();
                if (!identifier) return false;
                if (studentIdentifiers.has(identifier)) return true;
                const emailPrefix = identifier.split("@")[0];
                return emailPrefix !== identifier && studentIdentifiers.has(emailPrefix);
            });
        });
        if (inRoster) return true;
    }

    // 2. Check if student has attendance records for this course
    if (rawCourseCode && Array.isArray(enrichedRecords)) {
        const hasRecord = enrichedRecords.some((r) => {
            const rCode = normalizeCode(r.courseCode || r.classCode || "");
            return rCode === rawCourseCode;
        });
        if (hasRecord) return true;
    }

    // 3. If roster is empty / not configured: fallback to branch/department, semester, batch matching
    if (roster.length === 0) {
        const studentBranch = normalizeBranchName(studentProfile?.branch || studentProfile?.department || "");
        const courseBranch = normalizeBranchName(course.department || course.branch || course.classCode || "");

        // If course specifies a department/branch, it must match the student's branch (unless "ALL" or "GENERAL")
        if (courseBranch && courseBranch !== "GENERAL" && courseBranch !== "ALL" && studentBranch) {
            if (courseBranch !== studentBranch) return false;
        }

        // If course specifies batch, check match
        if (course.batch && studentProfile?.batch) {
            const cBatch = String(course.batch).trim();
            const sBatch = String(studentProfile.batch).trim();
            if (cBatch && sBatch && cBatch !== sBatch && cBatch.toUpperCase() !== "ALL") return false;
        }

        // If course specifies semester, check match
        if (course.semester && studentProfile?.semester) {
            const cSem = String(course.semester).trim();
            const sSem = String(studentProfile.semester).trim();
            if (cSem && sSem && cSem !== sSem && cSem.toUpperCase() !== "ALL") return false;
        }

        return true;
    }

    return false;
}

export const isInternalSecretOrUid = (val) => {
    if (!val || typeof val !== "string") return false;
    const clean = val.trim();
    return clean.length >= 20 && !clean.includes("@");
};

export function getCandidateRolls(user, profile, fetchedStudentData = null) {
    const set = new Set();

    const emailPrefix = (user?.email || "").split("@")[0].trim().toUpperCase();
    const emailRoll = !isInternalSecretOrUid(emailPrefix) ? emailPrefix : "";
    const pRoll = profile?.rollNo && !isInternalSecretOrUid(profile.rollNo) ? String(profile.rollNo).trim().toUpperCase() : "";
    const fRoll = fetchedStudentData?.rollNo && !isInternalSecretOrUid(fetchedStudentData.rollNo) ? String(fetchedStudentData.rollNo).trim().toUpperCase() : "";
    const activeRollNo = pRoll || fRoll || emailRoll;

    const addSafeRoll = (raw) => {
        if (!raw || isInternalSecretOrUid(raw)) return;
        const str = String(raw).trim();
        set.add(str);
        set.add(str.toUpperCase());
        set.add(str.toLowerCase());
        const digits = str.replace(/\D/g, "");
        if (digits && digits.length >= 4) set.add(digits);
    };

    if (activeRollNo) addSafeRoll(activeRollNo);
    if (pRoll) addSafeRoll(pRoll);
    if (fRoll) addSafeRoll(fRoll);
    if (emailRoll) addSafeRoll(emailRoll);

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

    const candidateSet = new Set();
    const addStudentIdentifier = (value) => {
        const identifier = String(value || "").trim().toUpperCase();
        if (!identifier) return;
        candidateSet.add(identifier);
        const emailPrefix = identifier.split("@")[0];
        if (emailPrefix !== identifier) candidateSet.add(emailPrefix);
    };
    (studentProfile.candidateRolls || []).forEach(addStudentIdentifier);
    addStudentIdentifier(studentProfile.rollNo);
    addStudentIdentifier(studentProfile.email);

    // 2. Enrich and sort attendance records (combining attendance_records AND session.attendees array)
    const recordsMap = new Map();

    recordsDocs.forEach((rec) => {
        const session = sessionMap.get(rec.sessionId) || {};
        const rawCourse = rec.courseCode || session.courseCode || rec.classCode || session.classCode || "General";
        const cleanCourse = (rawCourse === "N/A" || !rawCourse) ? "General" : rawCourse.trim();
        const recordRoll = String(rec.rollNo || rec.rollNumber || (rec.studentEmail ? rec.studentEmail.split("@")[0] : "") || "").trim().toUpperCase();
        const key = rec.sessionId ? String(rec.sessionId).trim() : (rec.id || `rec_${recordRoll}`);

        recordsMap.set(key, {
            ...rec,
            courseCode: cleanCourse,
            classCode: normalizeBranchName(rec.classCode || session.classCode || cleanCourse || "CSE"),
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
                    const attendee = att && typeof att === "object" ? att : {};
                    const rollValue = typeof att === "string" || typeof att === "number"
                        ? att
                        : attendee.rollNo || attendee.roll || attendee.studentId;
                    const roll = String(rollValue || "").toUpperCase().trim();
                    const email = String(attendee.studentEmail || attendee.email || "").split("@")[0].toUpperCase().trim();
                    if ((roll && candidateSet.has(roll)) || (email && candidateSet.has(email))) {
                        const attendeeIdentity = roll || email;
                        const key = s.id ? String(s.id).trim() : (attendee.id || `session_${attendeeIdentity}`);
                        if (!recordsMap.has(key)) {
                            const rawCourse = s.courseCode || s.classCode || "General";
                            const cleanCourse = (rawCourse === "N/A" || !rawCourse) ? "General" : rawCourse.trim();
                            recordsMap.set(key, {
                                id: key,
                                sessionId: s.id,
                                rollNo: roll || email,
                                courseCode: cleanCourse,
                                classCode: normalizeBranchName(s.classCode || cleanCourse || "CSE"),
                                roomNo: s.roomNo || "N/A",
                                lecturerName: s.lecturerName || "Faculty",
                                submittedAt: attendee.submittedAt || attendee.timestamp || s.createdAt || Date.now()
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
    const enrolledCourseCodes = new Set();

    coursesDocs.forEach((c) => {
        if (!isStudentEnrolledInCourse(c, candidateSet, studentProfile, enrichedRecords)) return;
        const rawCode = (c.courseCode || c.code || c.id || "").trim().toUpperCase();
        const norm = normalizeCode(rawCode);
        if (norm) {
            enrolledCourseCodes.add(norm);
            courseMap.set(norm, {
                id: c.id || rawCode,
                courseCode: rawCode,
                courseName: c.courseName || c.name || rawCode,
                lecturerName: c.lecturerName || c.faculty || "Assigned Faculty",
                lecturerEmail: c.lecturerEmail || "",
                department: c.department || c.dept || "",
                semester: c.semester || "",
                batch: c.batch || "",
                defaultRoom: c.defaultRoom || c.roomNo || "C003",
                credits: c.credits || 3,
                description: c.description || "",
                ...c
            });
        }
    });

    // Auto-discover any active courses appearing in student's attended records
    enrichedRecords.forEach((r) => {
        const rCourse = (r.courseCode || r.classCode || "").trim().toUpperCase();
        const norm = normalizeCode(rCourse);
        if (norm && !courseMap.has(norm) && norm !== "GENERAL" && norm !== "NA") {
            courseMap.set(norm, {
                id: rCourse,
                courseCode: rCourse,
                courseName: r.courseName || rCourse,
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

    // Auto-discover any conducted sessions matching the student
    sessionsDocs.forEach((s) => {
        const sCourse = (s.courseCode || s.classCode || "").trim().toUpperCase();
        const norm = normalizeCode(sCourse);
        if (norm && !courseMap.has(norm) && norm !== "GENERAL" && norm !== "NA") {
            const hasAttended = Array.isArray(s.attendees) && s.attendees.some((att) => {
                const roll = String(att?.rollNo || att?.roll || att || "").trim().toUpperCase();
                const em = String(att?.email || att?.studentEmail || "").split("@")[0].trim().toUpperCase();
                return candidateSet.has(roll) || candidateSet.has(em);
            });
            const matchesProfile = (!s.batch || String(s.batch).trim() === String(studentProfile.batch || "").trim()) &&
                                   (!s.classCode || !studentProfile.branch || normalizeBranchName(s.classCode) === normalizeBranchName(studentProfile.branch));
            if (hasAttended || matchesProfile) {
                courseMap.set(norm, {
                    id: sCourse,
                    courseCode: sCourse,
                    courseName: s.courseName || s.topic || sCourse,
                    lecturerName: s.lecturerName || "Faculty",
                    lecturerEmail: s.lecturerEmail || s.ownerEmail || "",
                    department: s.department || studentProfile.branch || "General",
                    semester: s.semester || studentProfile.semester || "1",
                    batch: s.batch || studentProfile.batch || "2025",
                    defaultRoom: s.roomNo || "N/A",
                    credits: 3,
                    description: `Lecture sessions conducted for ${sCourse}`
                });
            }
        }
    });

    // 4. Calculate stats for each course
    const allCoursesList = Array.from(courseMap.values());

    const coursesWithStats = allCoursesList.map((course) => {
        const cNorm = normalizeCode(course.courseCode);
        const cNameNorm = normalizeCode(course.courseName);

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

        // Deduplicate attended records by sessionId to ensure true class count
        const attendedSessionIds = new Set();
        const deduplicatedRecords = [];
        matchingRecords.forEach((r) => {
            const sid = String(r.sessionId || r.id || "").trim().toUpperCase();
            if (sid && !attendedSessionIds.has(sid)) {
                attendedSessionIds.add(sid);
                deduplicatedRecords.push(r);
            }
        });
        const attendedCount = deduplicatedRecords.length;

        // Find all sessions conducted for this course that belong to this student's class
        const matchingSessions = sessionsDocs.filter((s) => {
            const sCodeNorm = normalizeCode(s.courseCode || s.classCode || "");
            const sTopicNorm = normalizeCode(s.topic || s.courseName || "");
            const codeMatches = (cNorm && sCodeNorm === cNorm) || (cNameNorm && (sCodeNorm === cNameNorm || sTopicNorm === cNameNorm));
            if (!codeMatches) return false;

            const sid = String(s.id || s.sessionId || "").trim().toUpperCase();
            const hasAttended = (sid && attendedSessionIds.has(sid)) || (Array.isArray(s.attendees) && s.attendees.some((att) => {
                const roll = String(att?.rollNo || att?.roll || att || "").trim().toUpperCase();
                const em = String(att?.email || att?.studentEmail || "").split("@")[0].trim().toUpperCase();
                return candidateSet.has(roll) || candidateSet.has(em);
            }));
            if (hasAttended) return true;

            // If not attended, verify the session was actually conducted for this student's cohort
            if (s.batch && studentProfile?.batch) {
                const sBatch = String(s.batch).trim();
                const pBatch = String(studentProfile.batch).trim();
                if (sBatch && pBatch && sBatch.toUpperCase() !== "ALL" && sBatch !== pBatch) {
                    return false;
                }
            }

            if (s.classCode || s.department || s.branch) {
                const sBranch = normalizeBranchName(s.classCode || s.department || s.branch);
                const pBranch = normalizeBranchName(studentProfile?.branch || studentProfile?.department || "");
                if (sBranch && pBranch && sBranch !== "ALL" && sBranch !== "GENERAL" && sBranch !== pBranch) {
                    return false;
                }
            }

            if (s.section && studentProfile?.section) {
                const sSec = String(s.section).trim().toUpperCase();
                const pSec = String(studentProfile.section).trim().toUpperCase();
                if (sSec && pSec && sSec !== "ALL" && sSec !== pSec) {
                    return false;
                }
            }

            return true;
        });

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
        const detailedSessions = matchingSessions.map((s) => {
            const sid = String(s.id || s.sessionId || "").trim().toUpperCase();
            const myRecord = deduplicatedRecords.find((r) => {
                const rSid = String(r.sessionId || "").trim().toUpperCase();
                const rId = String(r.id || "").trim().toUpperCase();
                return (sid && rSid === sid) || (sid && rId.startsWith(`${sid}_`));
            });
            const isPresent = Boolean(myRecord) || (sid && attendedSessionIds.has(sid));

            return {
                id: s.id,
                courseCode: s.courseCode || course.courseCode,
                topic: s.topic || s.courseName || course.courseName,
                roomNo: s.roomNo || course.defaultRoom || "C003",
                lecturerName: s.lecturerName || course.lecturerName || "Faculty",
                createdAt: s.createdAt || s.timestamp || Date.now(),
                isPresent,
                submittedAt: myRecord ? (myRecord.submittedAt || s.createdAt) : null,
                faceVerified: Boolean(myRecord?.faceVerified)
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
            history: deduplicatedRecords,
            sessions: detailedSessions
        };
    });

    // 5. Aggregate calculations
    const activeSubjects = coursesWithStats.filter((c) => c.totalConducted > 0);
    const sumConducted = activeSubjects.reduce((acc, c) => acc + c.totalConducted, 0);
    const sumAttended = activeSubjects.reduce((acc, c) => acc + c.attendedCount, 0);

    const uniqueAttendedSessionIds = new Set();
    enrichedRecords.forEach((r) => {
        const sid = String(r.sessionId || r.id || "").trim().toUpperCase();
        if (sid) uniqueAttendedSessionIds.add(sid);
    });

    const totalAttended = Math.max(sumAttended, uniqueAttendedSessionIds.size);
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
