import test from "node:test";
import assert from "node:assert/strict";
import {
    normalizeCode,
    parseTimestampMillis,
    getCandidateRolls,
    isStudentEnrolledInCourse,
    computeStudentMetrics
} from "../src/components/Student/studentAttendanceHelper.js";

test("studentAttendanceHelper: normalizeCode strips special characters and upper-cases", () => {
    assert.equal(normalizeCode("cs-101"), "CS101");
    assert.equal(normalizeCode(" CS 202 "), "CS202");
    assert.equal(normalizeCode(null), "");
});

test("studentAttendanceHelper: parseTimestampMillis handles Date, string, number, and Firestore timestamps", () => {
    const now = 1700000000000;
    assert.equal(parseTimestampMillis(now), now);
    assert.equal(parseTimestampMillis(new Date(now)), now);
    assert.equal(parseTimestampMillis({ seconds: 1700000000, nanoseconds: 0 }), now);
    assert.equal(parseTimestampMillis({ toMillis: () => now }), now);
});

test("studentAttendanceHelper: getCandidateRolls collects candidate rolls and normalizations", () => {
    const user = { uid: "firebaseUid123456789012345", email: "21b91a0501@college.edu" };
    const profile = { rollNo: "21B91A0501" };
    const rolls = getCandidateRolls(user, profile);
    assert.ok(rolls.includes("21B91A0501"));
    assert.ok(rolls.includes("21b91a0501"));
});

test("studentAttendanceHelper: isStudentEnrolledInCourse matches roster and profile fallbacks", () => {
    const candidateSet = new Set(["21B91A0501"]);
    const profile = { branch: "Computer Science and Engineering", batch: "2025", semester: "5" };

    // 1. Explicit roster match
    const courseWithRoster = {
        courseCode: "CS101",
        enrolledStudents: [{ rollNo: "21B91A0501" }]
    };
    assert.equal(isStudentEnrolledInCourse(courseWithRoster, candidateSet, profile), true);

    // 2. Explicit roster non-match
    const courseWithOtherRoster = {
        courseCode: "CS102",
        enrolledStudents: [{ rollNo: "99B99A9999" }]
    };
    assert.equal(isStudentEnrolledInCourse(courseWithOtherRoster, candidateSet, profile), false);

    // 3. Fallback when roster is empty: matching department and batch
    const courseEmptyRosterMatch = {
        courseCode: "CS103",
        department: "CSE",
        batch: "2025",
        semester: "5",
        enrolledStudents: []
    };
    assert.equal(isStudentEnrolledInCourse(courseEmptyRosterMatch, candidateSet, profile), true);

    // 4. Fallback when roster is empty: different batch
    const courseDifferentBatch = {
        courseCode: "CS104",
        department: "CSE",
        batch: "2023",
        semester: "5",
        enrolledStudents: []
    };
    assert.equal(isStudentEnrolledInCourse(courseDifferentBatch, candidateSet, profile), false);

    // 5. Enrolled via existing attendance records
    const records = [{ courseCode: "CS104", rollNo: "21B91A0501" }];
    assert.equal(isStudentEnrolledInCourse(courseDifferentBatch, candidateSet, profile, records), true);
});

test("studentAttendanceHelper: computeStudentMetrics calculates stats accurately and excludes other batches", () => {
    const courses = [
        {
            id: "CS101",
            courseCode: "CS101",
            courseName: "Algorithms",
            department: "CSE",
            batch: "2025",
            enrolledStudents: ["21B91A0501"]
        }
    ];

    const sessions = [
        // Session 1 for student's batch
        {
            id: "sess_1",
            courseCode: "CS101",
            batch: "2025",
            classCode: "CSE",
            createdAt: 1700000000000
        },
        // Session 2 for student's batch
        {
            id: "sess_2",
            courseCode: "CS101",
            batch: "2025",
            classCode: "CSE",
            createdAt: 1700000100000
        },
        // Session 3 for an entirely different batch (should NOT be counted as absent for this student)
        {
            id: "sess_diff_batch",
            courseCode: "CS101",
            batch: "2022",
            classCode: "CSE",
            createdAt: 1700000200000
        }
    ];

    // Student attended sess_1. Student also has a duplicate record for sess_1.
    const records = [
        {
            id: "sess_1_recordA",
            sessionId: "sess_1",
            courseCode: "CS101",
            rollNo: "21B91A0501"
        },
        {
            id: "sess_1_recordB",
            sessionId: "sess_1",
            courseCode: "CS101",
            rollNo: "21B91A0501"
        }
    ];

    const profile = {
        rollNo: "21B91A0501",
        email: "21b91a0501@college.edu",
        candidateRolls: ["21B91A0501"],
        branch: "CSE",
        batch: "2025"
    };

    const metrics = computeStudentMetrics(courses, sessions, records, profile);

    // 1 course with stats
    assert.equal(metrics.coursesWithStats.length, 1);
    const cs101 = metrics.coursesWithStats[0];

    // Only sess_1 and sess_2 were conducted for 2025 batch (totalConducted = 2, NOT 3)
    assert.equal(cs101.totalConducted, 2);
    // Student attended sess_1 (deduplicated attendedCount = 1, NOT 2)
    assert.equal(cs101.attendedCount, 1);
    // 1 out of 2 = 50%
    assert.equal(cs101.percentage, 50);
    // Status should be danger (<65%)
    assert.equal(cs101.status, "danger");

    // Overall metrics
    assert.equal(metrics.totalConducted, 2);
    assert.equal(metrics.totalAttended, 1);
    assert.equal(metrics.totalMissed, 1);
    assert.equal(metrics.overallPercentage, 50);
});
