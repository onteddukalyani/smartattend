import * as XLSX from 'xlsx';

export function downloadExcel(dataOrTableId, filename = "Export") {
    try {
        let workSheet;
        if (typeof dataOrTableId === "string") {
            const table = document.getElementById(dataOrTableId);
            if (table) {
                workSheet = XLSX.utils.table_to_sheet(table);
            } else {
                console.error(`Table element with id "${dataOrTableId}" not found.`);
                return;
            }
        } else if (Array.isArray(dataOrTableId)) {
            workSheet = XLSX.utils.json_to_sheet(dataOrTableId);
        } else {
            console.error("Invalid data format for Excel download.");
            return;
        }

        const workBook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workBook, workSheet, "Records");
        XLSX.writeFile(workBook, `${filename}.xlsx`);
    } catch (error) {
        console.error("Error downloading Excel file:", error);
    }
}