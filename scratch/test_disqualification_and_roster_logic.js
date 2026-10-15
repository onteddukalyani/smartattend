/**
 * Test: Disqualification and Unified Roster Logic Verification
 *
 * Validates:
 * 1. Disqualification detection logic correctly classifies disqualified students and separates them from "Pending QR 2".
 * 2. Generateqr metric counters (totalScannedQR1, reachedQR2Count, pendingQR2Count, violationsCount).
 * 3. SessionData unified roster merges enrolled course students (Absent), authorizations (Pending QR 2),
 *    flagged violations (Disqualified), and submitted records (Present).
 * 4. Filtering and search capabilities on unified roster.
 */

import assert from "assert";

console.log("================================================================================");
console.log("RUNNING: Disqualification & Unified Roster Verification Test Suite");
console.log("================================================================================\n");

// --- 1. Disqualification & Violation Helper Logic Test ---
function checkIsDisqualified(item) {
    if (!item) return false;
    if (item.disqualified === true) return true;
    const s = String(item.status || "").toUpperCase();
    if (s === "DISQUALIFIED" || s === "FLAGGED_DISQUALIFIED" || s === "REJECTED") return true;
    if (Number(item.violationCount || item.confirmedKioskViolations || 0) >= 2) return true;
    if (Array.isArray(item.violations) && item.violations.some(v => v.disqualified === true || Number(v.count || 0) >= 2)) return true;
    return false;
}

function checkHasViolation(item) {
    if (!item) return false;
    if (checkIsDisqualified(item)) return true;
    if (item.hasViolation === true || item.flagged === true) return true;
    const s = String(item.status || "").toUpperCase();
    if (s.startsWith("FLAGGED") || s.includes("VIOLATION") || s.includes("ESCAPE")) return true;
    if (Array.isArray(item.violations) && item.violations.length > 0) return true;
    if (Number(item.violationCount || item.confirmedKioskViolations || 0) > 0) return true;
    return false;
}

console.log("Test 1: Disqualification & Violation Detection Cases");

const testCases = [
    { name: "Clean student", data: { rollNo: "23BCS001", status: "AUTHORIZED" }, expectedDisq: false, expectedHasV: false },
    { name: "Single warning student", data: { rollNo: "23BCS002", status: "FLAGGED_WARNING", violationCount: 1 }, expectedDisq: false, expectedHasV: true },
    { name: "Disqualified via flag boolean", data: { rollNo: "23BCS003", disqualified: true }, expectedDisq: true, expectedHasV: true },
    { name: "Disqualified via status FLAGGED_DISQUALIFIED", data: { rollNo: "23BCS004", status: "FLAGGED_DISQUALIFIED" }, expectedDisq: true, expectedHasV: true },
    { name: "Disqualified via violationCount = 2", data: { rollNo: "23BCS005", violationCount: 2 }, expectedDisq: true, expectedHasV: true },
    { name: "Disqualified via confirmedKioskViolations = 2", data: { rollNo: "23BCS006", confirmedKioskViolations: 2 }, expectedDisq: true, expectedHasV: true },
    { name: "Disqualified via violations array count", data: { rollNo: "23BCS007", violations: [{ reason: "App switch", count: 2 }] }, expectedDisq: true, expectedHasV: true }
];

testCases.forEach((tc) => {
    const isDisq = checkIsDisqualified(tc.data);
    const hasV = checkHasViolation(tc.data);
    assert.strictEqual(isDisq, tc.expectedDisq, `${tc.name}: isDisqualified expected ${tc.expectedDisq}, got ${isDisq}`);
    assert.strictEqual(hasV, tc.expectedHasV, `${tc.name}: hasViolation expected ${tc.expectedHasV}, got ${hasV}`);
    console.log(`  ✓ ${tc.name}: isDisq=${isDisq}, hasViolation=${hasV}`);
});

console.log("\nTest 2: Generateqr Live Metric Breakdown Logic");

function computeGenerateqrMetrics(authorizedStudents, sessionData, attendanceRecords) {
    const map = new Map();

    (authorizedStudents || []).forEach((st) => {
        const roll = (st.rollNo || st.studentUid || st.id || "").toUpperCase().trim();
        if (!roll) return;
        const isDisq = checkIsDisqualified(st);
        const hasV = isDisq || checkHasViolation(st);
        const vCount = Math.max(Number(st.violationCount || st.confirmedKioskViolations || 0), isDisq ? 2 : hasV ? 1 : 0);
        map.set(roll, {
            ...st,
            rollNo: roll,
            disqualified: isDisq,
            hasViolation: hasV,
            violationCount: vCount,
            violations: Array.isArray(st.violations) ? st.violations : []
        });
    });

    (attendanceRecords || []).forEach((rec) => {
        const roll = (rec.rollNo || rec.studentUid || "").toUpperCase().trim();
        if (!roll) return;
        const isDisq = checkIsDisqualified(rec);
        const hasV = isDisq || checkHasViolation(rec);
        if (!map.has(roll)) {
            map.set(roll, {
                id: rec.id || roll,
                rollNo: roll,
                disqualified: isDisq,
                hasViolation: hasV,
                violationCount: isDisq ? 2 : hasV ? 1 : 0,
                status: rec.status,
                isAttended: rec.excused || rec.faceVerified || rec.status === "APPROVED" || rec.status === "ATTENDED"
            });
        } else {
            const existing = map.get(roll);
            if (isDisq) {
                existing.disqualified = true;
                existing.hasViolation = true;
                existing.status = "FLAGGED_DISQUALIFIED";
                existing.violationCount = Math.max(existing.violationCount || 0, 2);
            }
        }
    });

    const attendeesSet = new Set((sessionData?.attendees || []).map(a => (a.rollNo || a.studentUid || "").toUpperCase().trim()));
    (attendanceRecords || []).forEach((rec) => {
        const roll = (rec.rollNo || rec.studentUid || "").toUpperCase().trim();
        const isExcused = rec.excused === true;
        const isDisq = !isExcused && checkIsDisqualified(rec);
        if (roll && !isDisq && (isExcused || rec.faceVerified || rec.status === "APPROVED" || rec.status === "ATTENDED")) {
            attendeesSet.add(roll);
        }
    });

    const flaggedMap = new Map();
    (sessionData?.flaggedViolations || []).forEach((f) => {
        const isReviewed = f.reviewed === true || f.excused === true || f.resolved === true || f.dismissed === true;
        if (isReviewed) return;
        const r = (f.rollNo || "").toUpperCase().trim();
        const isDisq = f.disqualified === true || f.status === "FLAGGED_DISQUALIFIED" || Number(f.count || f.violationCount || 0) >= 2;
        if (r) flaggedMap.set(r, { reason: f.violationReason, isDisqualified: isDisq });
    });

    const uniqueStudents = Array.from(map.values());
    const enrichedList = uniqueStudents.map((st) => {
        const roll = (st.rollNo || "").toUpperCase().trim();
        const flagEntry = flaggedMap.get(roll);
        const isAttended = attendeesSet.has(roll) || st.status === "ATTENDED" || st.status === "APPROVED" || st.isAttended === true;
        const isExcused = st.excused === true;

        const isDisqualified = !isExcused && !isAttended && (
            st.disqualified === true ||
            checkIsDisqualified(st) ||
            (flagEntry && flagEntry.isDisqualified)
        );

        const hasViolation = isDisqualified || (!isExcused && !isAttended && (
            Boolean(flagEntry) ||
            checkHasViolation(st)
        ));

        return {
            ...st,
            isAttended,
            isDisqualified,
            hasViolation,
            isExcused
        };
    });

    let reachedQR2 = 0;
    let pendingQR2 = 0;
    let violations = 0;

    enrichedList.forEach((st) => {
        if (st.isAttended) reachedQR2++;
        else if (st.isDisqualified || st.hasViolation) violations++;
        else pendingQR2++;
    });

    return {
        totalScannedQR1: uniqueStudents.length,
        reachedQR2Count: reachedQR2,
        pendingQR2Count: pendingQR2,
        violationsCount: violations,
        enrichedList
    };
}

// Scenario: 4 students scanned QR 1:
// - Student A: Waiting in kiosk (clean) -> should be Pending QR 2
// - Student B: Completed QR 2 & face verified -> should be Reached QR 2 (Present)
// - Student C: Left kiosk 2 times -> disqualified -> MUST BE IN violationsCount, NOT pendingQR2Count!
// - Student D: Left kiosk once -> warning -> MUST BE IN violationsCount, NOT pendingQR2Count!
const mockAuths = [
    { rollNo: "23BCS001", studentName: "Alice Waiting", status: "AUTHORIZED" },
    { rollNo: "23BCS002", studentName: "Bob Attended", status: "AUTHORIZED" },
    { rollNo: "23BCS003", studentName: "Charlie Disqualified", status: "FLAGGED_DISQUALIFIED", disqualified: true, violationCount: 2 },
    { rollNo: "23BCS004", studentName: "Diana Warning", status: "FLAGGED_WARNING", hasViolation: true, violationCount: 1 }
];

const mockSession = {
    id: "sess_123",
    attendees: [{ rollNo: "23BCS002", studentName: "Bob Attended" }],
    flaggedViolations: [
        { rollNo: "23BCS003", violationReason: "Left app 2 times", disqualified: true, count: 2 },
        { rollNo: "23BCS004", violationReason: "Window blur 1 time", disqualified: false, count: 1 }
    ]
};

const mockRecords = [
    { sessionId: "sess_123", rollNo: "23BCS002", fullName: "Bob Attended", faceVerified: true, status: "APPROVED" }
];

const metrics = computeGenerateqrMetrics(mockAuths, mockSession, mockRecords);
console.log("  Total Scanned QR 1:", metrics.totalScannedQR1);
console.log("  Reached QR 2 (Present):", metrics.reachedQR2Count);
console.log("  Pending QR 2:", metrics.pendingQR2Count);
console.log("  Violations / Disqualified:", metrics.violationsCount);

assert.strictEqual(metrics.totalScannedQR1, 4, "Total scanned QR 1 must be 4");
assert.strictEqual(metrics.reachedQR2Count, 1, "Reached QR 2 must be 1 (Bob)");
assert.strictEqual(metrics.pendingQR2Count, 1, "Pending QR 2 must be EXACTLY 1 (Alice only, Charlie & Diana excluded!)");
assert.strictEqual(metrics.violationsCount, 2, "Violations must be 2 (Charlie disqualified + Diana warning)");

const charlie = metrics.enrichedList.find(s => s.rollNo === "23BCS003");
assert.strictEqual(charlie.isDisqualified, true, "Charlie must be marked isDisqualified");
assert.strictEqual(charlie.isAttended, false, "Charlie must not be attended");

console.log("  ✓ Disqualified students cleanly separated from Pending QR 2!");

console.log("\nTest 3: SessionData Full Unified Roster Construction");

function buildUnifiedRoster(enrolledStudents, authorizations, session, records, allStudentsMap) {
    const map = new Map();

    // 1. Enrolled baseline
    (enrolledStudents || []).forEach((stud) => {
        const roll = (typeof stud === "string" ? stud : stud.rollNo).toUpperCase().trim();
        const sMeta = allStudentsMap.get(roll);
        map.set(roll, {
            rollNo: roll,
            name: (typeof stud === "object" && stud.name) || sMeta?.name || "Student",
            email: sMeta?.email || "",
            status: "ABSENT",
            statusLabel: "Absent (Not Scanned)",
            scannedAt: null,
            submittedAt: null
        });
    });

    // 2. Authorizations
    (authorizations || []).forEach((auth) => {
        const roll = (auth.rollNo || auth.studentUid).toUpperCase().trim();
        const existing = map.get(roll);
        const sMeta = allStudentsMap.get(roll);
        const isDisq = checkIsDisqualified(auth);
        const hasV = isDisq || checkHasViolation(auth);
        const status = isDisq ? "DISQUALIFIED" : hasV ? "FLAGGED" : "PENDING_QR2";
        const statusLabel = isDisq ? "Disqualified (App Switch)" : hasV ? "Flagged Warning" : "Pending QR 2 (In Kiosk)";

        map.set(roll, {
            rollNo: roll,
            name: auth.studentName || existing?.name || sMeta?.name || "Student",
            email: auth.studentEmail || existing?.email || "",
            status,
            statusLabel,
            scannedAt: auth.scannedAt || 1000,
            submittedAt: null
        });
    });

    // 3. Flagged violations
    (session?.flaggedViolations || []).forEach((f) => {
        const roll = (f.rollNo || "").toUpperCase().trim();
        if (f.reviewed || f.excused) return;
        const existing = map.get(roll);
        const isDisq = f.disqualified === true || f.status === "FLAGGED_DISQUALIFIED" || Number(f.count || 0) >= 2 || existing?.status === "DISQUALIFIED";
        map.set(roll, {
            rollNo: roll,
            name: f.studentName || existing?.name || "Student",
            email: existing?.email || "",
            status: isDisq ? "DISQUALIFIED" : "FLAGGED",
            statusLabel: isDisq ? "Disqualified (App Switch)" : "Flagged Warning",
            scannedAt: existing?.scannedAt || f.timestamp,
            submittedAt: null
        });
    });

    // 4. Submitted records
    (records || []).forEach((rec) => {
        const roll = (rec.rollNo || "").toUpperCase().trim();
        const existing = map.get(roll);
        const isExcused = rec.excused === true;
        const isDisq = !isExcused && (rec.disqualified === true || rec.status === "FLAGGED_DISQUALIFIED");

        let status = "PRESENT";
        let statusLabel = isDisq ? "Disqualified (App Switch)" : isExcused ? "Excused (Present)" : "QR Verified (Present)";
        if (isDisq) status = "DISQUALIFIED";

        map.set(roll, {
            rollNo: roll,
            name: rec.fullName || existing?.name || "Student",
            email: rec.studentEmail || existing?.email || "",
            status,
            statusLabel,
            scannedAt: existing?.scannedAt || rec.submittedAt,
            submittedAt: rec.submittedAt
        });
    });

    const allMembers = Array.from(map.values()).sort((a, b) => a.rollNo.localeCompare(b.rollNo));

    let pres = 0, pend = 0, disq = 0, abs = 0;
    allMembers.forEach((m) => {
        if (m.status === "PRESENT") pres++;
        else if (m.status === "PENDING_QR2") pend++;
        else if (m.status === "DISQUALIFIED" || m.status === "FLAGGED") disq++;
        else if (m.status === "ABSENT") abs++;
    });

    return {
        allMembers,
        totalCount: allMembers.length,
        presentCount: pres,
        pendingCount: pend,
        disqualifiedCount: disq,
        absentCount: abs
    };
}

const mockEnrolled = [
    { rollNo: "23BCS001", name: "Alice Waiting" },
    { rollNo: "23BCS002", name: "Bob Attended" },
    { rollNo: "23BCS003", name: "Charlie Disqualified" },
    { rollNo: "23BCS004", name: "Diana Warning" },
    { rollNo: "23BCS005", name: "Evan Absent" },
    { rollNo: "23BCS006", name: "Fiona Absent" }
];

const mockDirectory = new Map([
    ["23BCS001", { name: "Alice Waiting", email: "alice@iiitdwd.ac.in" }],
    ["23BCS002", { name: "Bob Attended", email: "bob@iiitdwd.ac.in" }],
    ["23BCS003", { name: "Charlie Disqualified", email: "charlie@iiitdwd.ac.in" }],
    ["23BCS004", { name: "Diana Warning", email: "diana@iiitdwd.ac.in" }],
    ["23BCS005", { name: "Evan Absent", email: "evan@iiitdwd.ac.in" }],
    ["23BCS006", { name: "Fiona Absent", email: "fiona@iiitdwd.ac.in" }]
]);

const rosterResult = buildUnifiedRoster(mockEnrolled, mockAuths, mockSession, mockRecords, mockDirectory);

console.log("  Roster Members count:", rosterResult.totalCount);
console.log("  Present Count:", rosterResult.presentCount);
console.log("  Pending QR 2 Count:", rosterResult.pendingCount);
console.log("  Disqualified Count:", rosterResult.disqualifiedCount);
console.log("  Absent Count:", rosterResult.absentCount);

assert.strictEqual(rosterResult.totalCount, 6, "Total roster should include all 6 enrolled students");
assert.strictEqual(rosterResult.presentCount, 1, "Present count should be 1 (Bob)");
assert.strictEqual(rosterResult.pendingCount, 1, "Pending QR 2 count should be 1 (Alice)");
assert.strictEqual(rosterResult.disqualifiedCount, 2, "Disqualified/Flagged should be 2 (Charlie & Diana)");
assert.strictEqual(rosterResult.absentCount, 2, "Absent should be 2 (Evan & Fiona who never scanned)");

// Verify members and labels
const evan = rosterResult.allMembers.find(m => m.rollNo === "23BCS005");
assert.strictEqual(evan.status, "ABSENT");
assert.strictEqual(evan.statusLabel, "Absent (Not Scanned)");

const charlieRoster = rosterResult.allMembers.find(m => m.rollNo === "23BCS003");
assert.strictEqual(charlieRoster.status, "DISQUALIFIED");
assert.strictEqual(charlieRoster.statusLabel, "Disqualified (App Switch)");

console.log("  ✓ Unified Roster successfully contains Present, Pending, Disqualified, and Absent students!");

console.log("\n================================================================================");
console.log("ALL TESTS PASSED: Disqualification and Roster Logic Verified Successfully!");
console.log("================================================================================\n");
