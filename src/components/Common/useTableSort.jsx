import React, { useState, useMemo } from "react";
import { FaSort, FaSortUp, FaSortDown } from "react-icons/fa";

/**
 * Universal table sorting hook supporting alphanumeric, dates, and numbers.
 * @param {Array} items - Array of data rows to sort.
 * @param {string|null} defaultKey - Column key to sort by initially.
 * @param {'asc'|'desc'} defaultDirection - Initial sort direction.
 */
export function useTableSort(items = [], defaultKey = null, defaultDirection = "asc") {
    const [sortConfig, setSortConfig] = useState({
        key: defaultKey,
        direction: defaultDirection
    });

    const requestSort = (key) => {
        setSortConfig((prev) => {
            if (prev.key === key) {
                return {
                    key,
                    direction: prev.direction === "asc" ? "desc" : "asc"
                };
            }
            return {
                key,
                direction: "asc"
            };
        });
    };

    const sortedItems = useMemo(() => {
        if (!sortConfig.key || !items || !Array.isArray(items)) {
            return items || [];
        }

        const sorted = [...items].sort((a, b) => {
            let valA = a[sortConfig.key];
            let valB = b[sortConfig.key];

            // Resolve nested session properties if needed (e.g. session.classCode)
            if (valA === undefined && sortConfig.key.includes(".")) {
                const parts = sortConfig.key.split(".");
                valA = parts.reduce((acc, part) => acc?.[part], a);
            }
            if (valB === undefined && sortConfig.key.includes(".")) {
                const parts = sortConfig.key.split(".");
                valB = parts.reduce((acc, part) => acc?.[part], b);
            }

            if (valA === undefined || valA === null) valA = "";
            if (valB === undefined || valB === null) valB = "";

            // Handle numeric / timestamp sorting
            if (typeof valA === "number" && typeof valB === "number") {
                return sortConfig.direction === "asc" ? valA - valB : valB - valA;
            }

            // Parse date strings / timestamps if applicable
            const strA = String(valA).trim();
            const strB = String(valB).trim();

            const comp = strA.localeCompare(strB, undefined, { numeric: true, sensitivity: "base" });
            return sortConfig.direction === "asc" ? comp : -comp;
        });

        return sorted;
    }, [items, sortConfig]);

    return {
        sortedItems,
        sortConfig,
        requestSort
    };
}

/**
 * Reusable visual indicator for sortable table headers.
 */
export function SortIcon({ sortConfig, columnKey }) {
    const isActive = sortConfig?.key === columnKey;

    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                marginLeft: "6px",
                verticalAlign: "middle",
                fontSize: "0.82em",
                color: isActive ? "var(--accent, #6366f1)" : "inherit",
                opacity: isActive ? 1 : 0.4,
                transition: "opacity 0.15s, transform 0.15s"
            }}
            aria-hidden="true"
        >
            {!isActive && <FaSort />}
            {isActive && sortConfig.direction === "asc" && <FaSortUp />}
            {isActive && sortConfig.direction === "desc" && <FaSortDown />}
        </span>
    );
}
