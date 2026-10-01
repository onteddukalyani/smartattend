import * as XLSX from 'xlsx';

/**
 * Clean an HTML table element before Excel extraction by removing:
 * 1. Buttons, icons, SVGs, inputs, selects, dropdowns, and UI control elements.
 * 2. Entire 'Action' / 'Actions' columns.
 * 3. Elements marked with .no-export or data-no-export.
 */
function createCleanTableClone(originalTable) {
    const clone = originalTable.cloneNode(true);

    // 1. Remove all buttons, icons, SVGs, inputs, selects, images, and .no-export elements
    const unwantedElements = clone.querySelectorAll(
        'button, svg, input, select, textarea, img, .no-export, [data-no-export="true"], .remove-session-btn, .action-btn, .nav-btn, .modal-trigger'
    );
    unwantedElements.forEach((el) => el.remove());

    // 2. Identify 'Actions' or 'Operations' columns to remove completely
    const headerRow = clone.querySelector('thead tr') || clone.querySelector('tr');
    const columnsToRemove = [];

    if (headerRow) {
        const headerCells = Array.from(headerRow.children);
        headerCells.forEach((th, index) => {
            const text = (th.textContent || "").trim().toLowerCase();
            if (
                text === "action" ||
                text === "actions" ||
                text === "operation" ||
                text === "operations" ||
                text === "manage" ||
                th.classList.contains("no-export")
            ) {
                columnsToRemove.push(index);
            }
        });
    }

    // 3. Remove identified action columns from all rows (in reverse order to preserve indices)
    if (columnsToRemove.length > 0) {
        const allRows = clone.querySelectorAll('tr');
        allRows.forEach((row) => {
            const cells = Array.from(row.children);
            for (let i = columnsToRemove.length - 1; i >= 0; i--) {
                const targetIdx = columnsToRemove[i];
                if (cells[targetIdx]) {
                    cells[targetIdx].remove();
                }
            }
        });
    }

    // 4. Clean up whitespace in all remaining cells
    clone.querySelectorAll('th, td').forEach((cell) => {
        // Strip multiple consecutive whitespace/newlines
        let text = (cell.textContent || "").replace(/\s+/g, ' ').trim();
        cell.textContent = text;
    });

    return clone;
}

/**
 * Universal Excel Downloader
 * Supports: Table ID (String), DOM Table Element, JSON Array of Objects, or 2D Array of Rows.
 */
export function downloadExcel(dataOrTableId, filename = "Export") {
    try {
        let workSheet;

        if (typeof dataOrTableId === "string") {
            const table = document.getElementById(dataOrTableId);
            if (table) {
                const cleanClone = createCleanTableClone(table);
                workSheet = XLSX.utils.table_to_sheet(cleanClone);
            } else {
                console.error(`Table element with id "${dataOrTableId}" not found.`);
                return;
            }
        } else if (dataOrTableId instanceof HTMLElement) {
            const cleanClone = createCleanTableClone(dataOrTableId);
            workSheet = XLSX.utils.table_to_sheet(cleanClone);
        } else if (Array.isArray(dataOrTableId)) {
            if (dataOrTableId.length > 0 && Array.isArray(dataOrTableId[0])) {
                // 2D Array / Matrix format (e.g. AoA)
                workSheet = XLSX.utils.aoa_to_sheet(dataOrTableId);
            } else {
                // Array of Objects
                workSheet = XLSX.utils.json_to_sheet(dataOrTableId);
            }
        } else {
            console.error("Invalid data format for Excel download.");
            return;
        }

        // Auto-compute column widths for a clean Excel appearance
        if (workSheet) {
            const range = XLSX.utils.decode_range(workSheet['!ref'] || 'A1:A1');
            const colWidths = [];

            for (let C = range.s.c; C <= range.e.c; ++C) {
                let maxWidth = 10;
                for (let R = range.s.r; R <= range.e.r; ++R) {
                    const cellAddress = XLSX.utils.encode_cell({ r: R, c: C });
                    const cell = workSheet[cellAddress];
                    if (cell && cell.v) {
                        const len = String(cell.v).length;
                        if (len > maxWidth) maxWidth = Math.min(len + 3, 50);
                    }
                }
                colWidths.push({ wch: maxWidth });
            }
            workSheet['!cols'] = colWidths;
        }

        const workBook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workBook, workSheet, "Attendance Records");

        const cleanFilename = String(filename).replace(/[/\\?%*:|"<>]/g, '-');
        XLSX.writeFile(workBook, `${cleanFilename}.xlsx`);
    } catch (error) {
        console.error("Error downloading Excel file:", error);
    }
}

/**
 * Dedicated Master Matrix Excel Exporter
 * Generates the multi-session matrix format requested by the user:
 *
 * Row 1 (Headers): S No | Roll No | Name | Total lecture hours and percentage | Aug 3 | Aug 4 | Aug 6 ...
 * Row 2 (Subhead): —    | —       | —    | Total: 25                          | 1.5   | 1.5   | 2.0   ...
 * Row 3+ (Data):   1    | 25BCS108| NAME | 100                                | 1     | 1     | 1     ...
 */
export function exportMasterAttendanceMatrix({
    courseName = "Course Attendance",
    courseCode = "",
    batch = "",
    sessions = [],
    students = [],
    matrixMap = new Map(), // key: `${cleanRoll}_${sessionId}` -> boolean (present/absent)
    filename = null
}) {
    try {
        if (!Array.isArray(students) || students.length === 0) {
            alert("No students to export in attendance sheet.");
            return;
        }

        // Calculate total lecture hours
        const totalLectureHours = sessions.reduce((acc, sess) => acc + (Number(sess.durationHours) || Number(sess.hours) || 1.5), 0);

        // Header Row 1: Dates / Titles
        const headerRow1 = [
            "S No",
            "Roll No",
            "Name",
            `Total Lecture Hours & %`
        ];

        // Header Row 2: Weights / Session Hours
        const headerRow2 = [
            "",
            "",
            "",
            totalLectureHours > 0 ? `${totalLectureHours} hrs` : `${sessions.length} sessions`
        ];

        sessions.forEach((sess) => {
            const dateStr = sess.dateLabel || (sess.createdAt ? new Date(sess.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : `Session ${sess.id}`);
            const duration = Number(sess.durationHours) || Number(sess.hours) || 1.5;

            headerRow1.push(dateStr);
            headerRow2.push(duration);
        });

        // Rows for each student
        const dataRows = [];

        students.forEach((student, index) => {
            const cleanRoll = String(student.rollNo || student.rollNumber || student.id || "").trim().toUpperCase();
            const studentName = (student.name || student.fullName || student.studentName || cleanRoll).toUpperCase().trim();

            // Count attended sessions & hours for this student
            let attendedCount = 0;
            let attendedHours = 0;
            const sessionValues = [];

            sessions.forEach((sess) => {
                const sessId = sess.id;
                const isPresent = Boolean(
                    matrixMap.get(`${cleanRoll}_${sessId}`) ||
                    matrixMap.get(`${cleanRoll.toLowerCase()}_${sessId}`)
                );

                const duration = Number(sess.durationHours) || Number(sess.hours) || 1.5;

                if (isPresent) {
                    attendedCount += 1;
                    attendedHours += duration;
                    sessionValues.push(1);
                } else {
                    sessionValues.push(0);
                }
            });

            // Percentage calculation
            const pct = sessions.length > 0 ? Math.round((attendedCount / sessions.length) * 100) : 0;

            const row = [
                index + 1,
                cleanRoll,
                studentName,
                pct,
                ...sessionValues
            ];

            dataRows.push(row);
        });

        // Combine into 2D Array (AoA)
        const aoa = [
            [`SmartAttend Master Attendance Sheet - ${courseCode || courseName} ${batch ? `(Batch ${batch})` : ""}`],
            [`Generated on: ${new Date().toLocaleString()} | Total Sessions: ${sessions.length} | Total Enrolled: ${students.length}`],
            [], // spacer
            headerRow1,
            headerRow2,
            ...dataRows
        ];

        const workSheet = XLSX.utils.aoa_to_sheet(aoa);

        // Auto-calculate column widths
        const colWidths = [
            { wch: 8 },  // S No
            { wch: 16 }, // Roll No
            { wch: 28 }, // Name
            { wch: 24 }  // Total Lecture Hours & %
        ];

        sessions.forEach(() => {
            colWidths.push({ wch: 10 }); // Session columns (Aug 3, Aug 4, etc.)
        });

        workSheet['!cols'] = colWidths;

        const workBook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workBook, workSheet, "Master Attendance Matrix");

        const targetFilename = filename || `Master-Attendance-${courseCode || "All-Classes"}-${batch || "2025"}-${new Date().toISOString().slice(0, 10)}`;
        const cleanFilename = String(targetFilename).replace(/[/\\?%*:|"<>]/g, '-');
        XLSX.writeFile(workBook, `${cleanFilename}.xlsx`);
    } catch (error) {
        console.error("Error generating Master Attendance Matrix:", error);
        alert("Failed to generate master attendance Excel file: " + error.message);
    }
}