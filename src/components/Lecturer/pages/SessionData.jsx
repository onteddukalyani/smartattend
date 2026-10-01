import { useEffect, useState, useMemo } from "react";
import { collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, query, setDoc, where, writeBatch } from "firebase/firestore";
import { useNavigate, useParams, Link, useSearchParams } from "react-router-dom";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import { buildUserLookupMaps, normalizeSessions, doesSessionBelongToLecturer } from "../../Common/sessionMatcher";
import { normalizeBranchName } from "../../../utils/studentDataHelper";
import { excuseAndReinstateAttendance, dismissOrRemoveViolation } from "../../../services/sessionAuthService";
import { FiSearch, FiPlusCircle, FiUsers, FiLayers, FiFilter, FiX } from "react-icons/fi";
import { FaCheckCircle, FaQrcode, FaClock, FaTrashAlt, FaLayerGroup, FaTable, FaUserPlus, FaExclamationTriangle, FaShieldAlt, FaCheck, FaTimes, FaSpinner, FaChalkboardTeacher, FaBookOpen, FaGraduationCap } from "react-icons/fa";
import StudentDetailModal from "../../Common/StudentDetailModal";
import MasterAttendanceMatrix from "../../Common/MasterAttendanceMatrix";
import './AttendanceData.css';

function formatSessionDateTime(rawDate) {
    if (!rawDate) return { dateStr: "N/A", timeStr: "N/A", fullStr: "N/A" };
    let dateObj = null;
    if (typeof rawDate?.toDate === "function") {
        dateObj = rawDate.toDate();
    } else if (rawDate?.seconds) {
        dateObj = new Date(rawDate.seconds * 1000);
    } else if (typeof rawDate === "number" || typeof rawDate === "string") {
        dateObj = new Date(rawDate);
    }
    if (!dateObj || isNaN(dateObj.getTime())) {
        return { dateStr: "N/A", timeStr: "N/A", fullStr: "N/A" };
    }
    return {
        dateStr: dateObj.toLocaleDateString(),
        timeStr: dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        fullStr: dateObj.toLocaleString()
    };
}

function ClassesData() {
    const { user, profile } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const navigate = useNavigate();

    const [allSessionsList, setAllSessionsList] = useState([]);
    const [lookupMaps, setLookupMaps] = useState({});
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState("all"); // "all" | "my"
    const [searchTerm, setSearchTerm] = useState("");

    const initialLecturerParam = searchParams.get("lecturer") || "all";
    const initialCourseParam = searchParams.get("course") || "all";
    const initialBatchParam = searchParams.get("batch") || "all";
    const initialViewParam = searchParams.get("view") || "list";

    // Default to "list" view so Admin sees all classes first
    const [viewMode, setViewMode] = useState(initialViewParam === "matrix" ? "matrix" : "list");
    const [selectedLecturerFilter, setSelectedLecturerFilter] = useState(initialLecturerParam);
    const [selectedCourseFilter, setSelectedCourseFilter] = useState(initialCourseParam);
    const [selectedBatchFilter, setSelectedBatchFilter] = useState(initialBatchParam);

    const isCurrentAdminPath = window.location.pathname.startsWith("/admin");
    const isCurrentLecturerPath = window.location.pathname.startsWith("/lecturer");

    const isAdmin = isCurrentAdminPath || (!isCurrentLecturerPath && (
        profile?.role === "admin" ||
        profile?.role === "administrator" ||
        profile?.role === "superadmin"
    ));

    const basePath = isCurrentAdminPath ? "/admin/classes" : "/lecturer/attendance-sessions";
    const createSessionPath = isCurrentAdminPath ? "/admin/classes" : "/lecturer/lecturerpage";

    // Sync URL search params
    useEffect(() => {
        const lect = searchParams.get("lecturer");
        if (lect) setSelectedLecturerFilter(lect);
        const course = searchParams.get("course");
        if (course) setSelectedCourseFilter(course);
        const batch = searchParams.get("batch");
        if (batch) setSelectedBatchFilter(batch);
        const v = searchParams.get("view");
        if (v) setViewMode(v);
    }, [searchParams]);

    // Setup real-time listener for attendance_sessions and enrich metadata
    useEffect(() => {
        let unsubscribeSessions = () => { };

        const setupListeners = async () => {
            try {
                // Fetch reference datasets for name & batch auto-resolution
                const [lecturersSnapshot, usersSnapshot, authUsersSnapshot, coursesSnapshot] = await Promise.all([
                    getDocs(collection(db, "lecturers")).catch(() => ({ docs: [] })),
                    getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
                    getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] })),
                    getDocs(collection(db, "courses")).catch(() => ({ docs: [] }))
                ]);

                const courseMap = new Map();
                coursesSnapshot.docs.forEach((d) => {
                    const c = d.data();
                    if (c.courseCode) {
                        courseMap.set(c.courseCode.toUpperCase().trim(), c);
                    }
                    courseMap.set(d.id.toUpperCase().trim(), c);
                });

                // Listen to real-time changes on attendance_sessions
                unsubscribeSessions = onSnapshot(collection(db, "attendance_sessions"), async (sessionsSnapshot) => {
                    const recordsSnapshot = await getDocs(collection(db, "attendance_records")).catch(() => ({ docs: [] }));

                    const maps = buildUserLookupMaps(
                        usersSnapshot.docs,
                        authUsersSnapshot.docs,
                        recordsSnapshot.docs,
                        sessionsSnapshot.docs
                    );
                    setLookupMaps(maps);

                    const normalized = normalizeSessions(sessionsSnapshot.docs, recordsSnapshot.docs, maps);

                    const enrichedSessions = normalized.map((sess) => {
                        const courseKey = (sess.courseCode || sess.classCode || "").toUpperCase().trim();
                        const matchedCourse = courseMap.get(courseKey) || {};
                        const rawBatch = (sess.batch || "").toString().trim();
                        const resolvedBatch = (rawBatch && rawBatch !== "—") ? rawBatch : (matchedCourse.batch || "2025");

                        // Auto-heal missing batch in Firestore if not set
                        if (!rawBatch || rawBatch === "—") {
                            setDoc(doc(db, "attendance_sessions", sess.id), { batch: resolvedBatch }, { merge: true }).catch(() => { });
                        }

                        return {
                            ...sess,
                            classCode: normalizeBranchName(sess.classCode || matchedCourse.department || "CSE"),
                            batch: resolvedBatch,
                            lecturerName: sess.lecturerName || maps.uidToName?.get(sess.ownerId) || maps.emailToName?.get(sess.ownerEmail) || (sess.ownerEmail ? sess.ownerEmail.split("@")[0] : "Faculty")
                        };
                    });

                    setAllSessionsList(enrichedSessions);
                    setLoading(false);
                }, (error) => {
                    console.error("Error in real-time sessions listener:", error);
                    setLoading(false);
                });
            } catch (error) {
                console.error("Error setting up sessions listener:", error);
                setLoading(false);
            }
        };

        setupListeners();

        return () => {
            unsubscribeSessions();
        };
    }, [user, profile]);

    // Filter sessions based on role, tab, lecturer, course, batch and search query
    const currentLecturerObj = {
        uid: user?.uid || "",
        email: user?.email || profile?.email || "",
        name: profile?.name || user?.displayName || "",
        role: profile?.role || "lecturer"
    };

    const isSessionOwnerForSess = (sess) => {
        if (isAdmin) return true;
        return doesSessionBelongToLecturer(sess, currentLecturerObj, lookupMaps, 100);
    };

    const removeSession = async (event, session) => {
        event.stopPropagation();
        if (!isSessionOwnerForSess(session)) {
            alert(`❌ Permission Denied: This session belongs to ${session.lecturerName || "another lecturer"}. Only ${session.lecturerName || "the assigned lecturer"} or an administrator can delete it.`);
            return;
        }

        if (!window.confirm(`Remove the ${session.classCode || "selected"} session and its attendance records?`)) {
            return;
        }

        try {
            const recordsQuery = query(
                collection(db, "attendance_records"),
                where("sessionId", "==", session.id)
            );
            const recordsSnapshot = await getDocs(recordsQuery);
            const batch = writeBatch(db);

            recordsSnapshot.docs.forEach((recordDoc) => {
                batch.delete(recordDoc.ref);
            });
            batch.delete(doc(db, "attendance_sessions", session.id));
            await batch.commit();
            setAllSessionsList((currentSessions) => currentSessions.filter(({ id }) => id !== session.id));
        } catch (error) {
            console.error("Error removing session:", error);
            window.alert("Could not remove this session.");
        }
    };

    const mySessions = allSessionsList.filter((sess) =>
        doesSessionBelongToLecturer(sess, currentLecturerObj, lookupMaps, allSessionsList.length <= 1 ? 1 : 100)
    );

    // If user is admin, they always see all sessions; if lecturer, depends on activeTab
    const tabSessions = (isAdmin || activeTab === "all") ? allSessionsList : (mySessions.length === 0 && allSessionsList.length > 0 ? allSessionsList : mySessions);

    // Compute unique lists for filter dropdowns
    const uniqueLecturers = useMemo(() => {
        const set = new Set();
        allSessionsList.forEach((s) => {
            const name = s.lecturerName || (s.ownerEmail ? s.ownerEmail.split("@")[0] : null);
            if (name) set.add(name);
        });
        return Array.from(set).sort();
    }, [allSessionsList]);

    const lecturerSessionCounts = useMemo(() => {
        const counts = new Map();
        allSessionsList.forEach((s) => {
            const name = s.lecturerName || (s.ownerEmail ? s.ownerEmail.split("@")[0] : "Faculty");
            counts.set(name, (counts.get(name) || 0) + 1);
        });
        return counts;
    }, [allSessionsList]);

    const uniqueCourses = useMemo(() => {
        const set = new Set();
        allSessionsList.forEach((s) => {
            const code = s.courseCode || s.classCode;
            if (code) set.add(code.toUpperCase().trim());
        });
        return Array.from(set).sort();
    }, [allSessionsList]);

    const uniqueBatches = useMemo(() => {
        const set = new Set();
        allSessionsList.forEach((s) => {
            if (s.batch && s.batch !== "—") set.add(s.batch.toString().trim());
        });
        return Array.from(set).sort();
    }, [allSessionsList]);

    const filteredSessions = tabSessions.filter((sess) => {
        // Lecturer filter
        if (selectedLecturerFilter !== "all") {
            const lName = String(sess.lecturerName || "").toLowerCase().trim();
            const lEmail = String(sess.lecturerEmail || sess.ownerEmail || "").toLowerCase().trim();
            const filterTerm = selectedLecturerFilter.toLowerCase().trim();
            if (!lName.includes(filterTerm) && !lEmail.includes(filterTerm) && lName !== filterTerm) {
                return false;
            }
        }

        // Course filter
        if (selectedCourseFilter !== "all") {
            const cCode = String(sess.courseCode || sess.classCode || "").toUpperCase().trim();
            if (cCode !== selectedCourseFilter.toUpperCase().trim()) {
                return false;
            }
        }

        // Batch filter
        if (selectedBatchFilter !== "all") {
            const b = String(sess.batch || "").trim();
            if (b !== selectedBatchFilter.trim()) {
                return false;
            }
        }

        // Search Term
        if (searchTerm.trim()) {
            const term = searchTerm.toLowerCase().trim();
            const classCode = String(sess.classCode || "").toLowerCase();
            const courseCode = String(sess.courseCode || "").toLowerCase();
            const roomNo = String(sess.roomNo || "").toLowerCase();
            const batch = String(sess.batch || "").toLowerCase();
            const lecturerName = String(sess.lecturerName || "").toLowerCase();
            const lecturerEmail = String(sess.lecturerEmail || sess.ownerEmail || "").toLowerCase();

            return (
                classCode.includes(term) ||
                courseCode.includes(term) ||
                roomNo.includes(term) ||
                batch.includes(term) ||
                lecturerName.includes(term) ||
                lecturerEmail.includes(term)
            );
        }

        return true;
    });

    const hasActiveFilters = selectedLecturerFilter !== "all" || selectedCourseFilter !== "all" || selectedBatchFilter !== "all" || searchTerm.trim() !== "";

    const { sortedItems: sortedSessions, sortConfig, requestSort } = useTableSort(filteredSessions, "createdAt", "desc");

    if (loading) {
        return (
            <div className="attendance-data-page">
                <p>Loading attendance sessions from database...</p>
            </div>
        );
    }

    return (
        <div className="attendance-data-page">
            {/* View Mode Switcher: Individual Sessions List (Default) vs Master Attendance Matrix */}
            <div className="classes-tabs" style={{ marginBottom: "1.5rem", background: "var(--surface-soft, #f8fafc)", padding: "6px", borderRadius: "14px", border: "1px solid var(--border, #e2e8f0)", display: "inline-flex" }}>
                <button
                    type="button"
                    className={`classes-tab ${viewMode === "list" ? "active" : ""}`}
                    onClick={() => setViewMode("list")}
                    style={{ fontWeight: 800, fontSize: "0.92rem", display: "inline-flex", alignItems: "center", gap: "8px" }}
                >
                    <FiLayers /> 📑 All Classes &amp; Sessions List ({allSessionsList.length})
                </button>
                <button
                    type="button"
                    className={`classes-tab ${viewMode === "matrix" ? "active" : ""}`}
                    onClick={() => setViewMode("matrix")}
                    style={{ fontWeight: 800, fontSize: "0.92rem", display: "inline-flex", alignItems: "center", gap: "8px" }}
                >
                    <FaLayerGroup /> 📊 Master Attendance Sheet (Matrix)
                </button>
            </div>

            {viewMode === "matrix" ? (
                <MasterAttendanceMatrix role={isAdmin ? "admin" : "lecturer"} />
            ) : (
                <>
                    <div className="classes-header-bar">
                        <div>
                            <h2>All Classes &amp; Lecture Sessions</h2>
                            <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-muted, #64748b)" }}>
                                {isAdmin
                                    ? "View all lecture classes conducted across the institution. Filter by faculty to inspect any lecturer's classes."
                                    : "View live and past lecture attendance sessions recorded via QR check-ins."}
                            </p>
                        </div>
                        <div className="classes-header-actions">
                            {sortedSessions.length > 0 && (
                                <button
                                    className="download-excel-btn"
                                    onClick={() => downloadExcel("classes-sessions-table", `Sessions-List-${new Date().toISOString().slice(0, 10)}`)}
                                >
                                    📥 Download Excel
                                </button>
                            )}
                            {!isAdmin && (
                                <Link to="/lecturer/lecturerpage" className="classes-new-session-btn">
                                    <FiPlusCircle /> Start New Session (QR)
                                </Link>
                            )}
                        </div>
                    </div>

                    {/* Tab switchers for Lecturer */}
                    {!isAdmin && (
                        <div className="classes-tabs">
                            <button
                                type="button"
                                className={`classes-tab ${activeTab === "my" ? "active" : ""}`}
                                onClick={() => setActiveTab("my")}
                            >
                                <FiUsers /> My Sessions ({mySessions.length})
                            </button>
                            <button
                                type="button"
                                className={`classes-tab ${activeTab === "all" ? "active" : ""}`}
                                onClick={() => setActiveTab("all")}
                            >
                                <FiLayers /> All Institution Sessions ({allSessionsList.length})
                            </button>
                        </div>
                    )}

                    {/* Active Lecturer Banner when filtered */}
                    {selectedLecturerFilter !== "all" && (
                        <div className="lecturer-active-filter-banner" role="status">
                            <div className="banner-left">
                                <div className="banner-avatar">
                                    <FaChalkboardTeacher />
                                </div>
                                <div>
                                    <span className="banner-sub">Filtered Faculty View</span>
                                    <h3 className="banner-title">{selectedLecturerFilter}</h3>
                                    <p className="banner-meta">
                                        Showing all <strong>{filteredSessions.length}</strong> classes conducted by this lecturer. Click any class to view its full student attendance.
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                className="banner-clear-btn"
                                onClick={() => {
                                    setSelectedLecturerFilter("all");
                                    const newParams = new URLSearchParams(searchParams);
                                    newParams.delete("lecturer");
                                    setSearchParams(newParams);
                                }}
                            >
                                <FiX /> Clear Filter (Show All Faculty)
                            </button>
                        </div>
                    )}

                    {/* Active Course Banner when filtered */}
                    {selectedCourseFilter !== "all" && (
                        <div className="lecturer-active-filter-banner" role="status" style={{ borderLeftColor: "#6366f1" }}>
                            <div className="banner-left">
                                <div className="banner-avatar" style={{ background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)", color: "#ffffff" }}>
                                    <FaBookOpen />
                                </div>
                                <div>
                                    <span className="banner-sub">Filtered Course View</span>
                                    <h3 className="banner-title">{selectedCourseFilter}</h3>
                                    <p className="banner-meta">
                                        Showing all <strong>{filteredSessions.length}</strong> classes conducted for <strong>{selectedCourseFilter}</strong>. Click any session to inspect records or switch to Master Attendance Sheet.
                                    </p>
                                </div>
                            </div>
                            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                <button
                                    type="button"
                                    className="banner-clear-btn"
                                    onClick={() => setViewMode("matrix")}
                                    style={{ background: "#6366f1", color: "#ffffff", borderColor: "#6366f1" }}
                                >
                                    <FaLayerGroup /> Open Master Matrix
                                </button>
                                <button
                                    type="button"
                                    className="banner-clear-btn"
                                    onClick={() => {
                                        setSelectedCourseFilter("all");
                                        const newParams = new URLSearchParams(searchParams);
                                        newParams.delete("course");
                                        setSearchParams(newParams);
                                    }}
                                >
                                    <FiX /> Clear Filter (Show All Courses)
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Multi-Filter Bar: Search, Faculty Selector, Course & Batch */}
                    {allSessionsList.length > 0 && (
                        <div className="classes-filter-controls-row">
                            {/* Search Input */}
                            <div className="classes-search-wrapper">
                                <FiSearch className="classes-search-icon" />
                                <input
                                    type="text"
                                    className="classes-search-input"
                                    placeholder="Search classes, rooms, faculty..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                />
                                {searchTerm && (
                                    <button
                                        type="button"
                                        className="search-clear-mini-btn"
                                        onClick={() => setSearchTerm("")}
                                    >
                                        <FiX />
                                    </button>
                                )}
                            </div>

                            {/* Faculty / Lecturer Dropdown Filter */}
                            {(isAdmin || activeTab === "all") && uniqueLecturers.length > 0 && (
                                <select
                                    className="classes-filter-select"
                                    value={selectedLecturerFilter}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        setSelectedLecturerFilter(val);
                                        const newParams = new URLSearchParams(searchParams);
                                        if (val !== "all") newParams.set("lecturer", val);
                                        else newParams.delete("lecturer");
                                        setSearchParams(newParams);
                                    }}
                                    title="Filter classes by Lecturer"
                                >
                                    <option value="all">👨‍🏫 All Faculty / Lecturers ({allSessionsList.length} classes)</option>
                                    {uniqueLecturers.map((lec) => (
                                        <option key={lec} value={lec}>
                                            {lec} ({lecturerSessionCounts.get(lec) || 0} classes)
                                        </option>
                                    ))}
                                </select>
                            )}

                            {/* Course Dropdown Filter */}
                            {uniqueCourses.length > 0 && (
                                <select
                                    className="classes-filter-select"
                                    value={selectedCourseFilter}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        setSelectedCourseFilter(val);
                                        const newParams = new URLSearchParams(searchParams);
                                        if (val !== "all") newParams.set("course", val);
                                        else newParams.delete("course");
                                        setSearchParams(newParams);
                                    }}
                                    title="Filter classes by Course"
                                >
                                    <option value="all">📚 All Courses</option>
                                    {uniqueCourses.map((c) => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                            )}

                            {/* Batch Dropdown Filter */}
                            {uniqueBatches.length > 0 && (
                                <select
                                    className="classes-filter-select"
                                    value={selectedBatchFilter}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        setSelectedBatchFilter(val);
                                        const newParams = new URLSearchParams(searchParams);
                                        if (val !== "all") newParams.set("batch", val);
                                        else newParams.delete("batch");
                                        setSearchParams(newParams);
                                    }}
                                    title="Filter classes by Batch"
                                >
                                    <option value="all">🎓 All Batches</option>
                                    {uniqueBatches.map((b) => (
                                        <option key={b} value={b}>Batch {b}</option>
                                    ))}
                                </select>
                            )}

                            {/* Reset Filters */}
                            {hasActiveFilters && (
                                <button
                                    type="button"
                                    className="classes-reset-filters-btn"
                                    onClick={() => {
                                        setSelectedLecturerFilter("all");
                                        setSelectedCourseFilter("all");
                                        setSelectedBatchFilter("all");
                                        setSearchTerm("");
                                        setSearchParams({});
                                    }}
                                >
                                    Reset Filters
                                </button>
                            )}
                        </div>
                    )}

                    {/* Empty State or Table Display */}
                    {allSessionsList.length === 0 ? (
                        <div className="classes-empty-card">
                            <div className="classes-empty-icon">📅</div>
                            <h3>No Attendance Sessions Yet</h3>
                            <p>
                                Attendance sessions are created when a lecturer or administrator starts a class and generates a dynamic QR code for students to scan.
                            </p>
                            <Link to={createSessionPath} className="classes-new-session-btn" style={{ display: "inline-flex", margin: "0 auto" }}>
                                <FiPlusCircle /> Generate QR Code to Take Attendance
                            </Link>
                        </div>
                    ) : sortedSessions.length === 0 ? (
                        <div className="classes-empty-card">
                            <div className="classes-empty-icon">🔍</div>
                            <h3>No Matching Sessions Found</h3>
                            <p>
                                {hasActiveFilters
                                    ? "No sessions match your selected filters. Try resetting the filters to view all classes."
                                    : "No sessions found in this view."}
                            </p>
                            {hasActiveFilters && (
                                <button
                                    type="button"
                                    className="classes-new-session-btn"
                                    style={{ margin: "0 auto 12px", display: "inline-flex" }}
                                    onClick={() => {
                                        setSelectedLecturerFilter("all");
                                        setSelectedCourseFilter("all");
                                        setSelectedBatchFilter("all");
                                        setSearchTerm("");
                                        setSearchParams({});
                                    }}
                                >
                                    View All Classes ({allSessionsList.length})
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className="attendance-table-scroll">
                            <table id="classes-sessions-table">
                                <thead>
                                    <tr>
                                        <th className="sortable-th" onClick={() => requestSort("classCode")} title="Click to sort by Class Code">
                                            Class Code <SortIcon sortConfig={sortConfig} columnKey="classCode" />
                                        </th>
                                        <th className="sortable-th" onClick={() => requestSort("batch")} title="Click to sort by Batch">
                                            Batch <SortIcon sortConfig={sortConfig} columnKey="batch" />
                                        </th>
                                        <th className="sortable-th" onClick={() => requestSort("courseCode")} title="Click to sort by Course Code">
                                            Course Code <SortIcon sortConfig={sortConfig} columnKey="courseCode" />
                                        </th>
                                        {(isAdmin || activeTab === "all") && (
                                            <th className="sortable-th" onClick={() => requestSort("lecturerName")} title="Click to sort by Lecturer">
                                                Lecturer <SortIcon sortConfig={sortConfig} columnKey="lecturerName" />
                                            </th>
                                        )}
                                        <th className="sortable-th" onClick={() => requestSort("roomNo")} title="Click to sort by Room No">
                                            Room No <SortIcon sortConfig={sortConfig} columnKey="roomNo" />
                                        </th>
                                        <th className="sortable-th" onClick={() => requestSort("createdAt")} title="Click to sort by Date">
                                            Date <SortIcon sortConfig={sortConfig} columnKey="createdAt" />
                                        </th>
                                        <th className="sortable-th" onClick={() => requestSort("createdAt")} title="Click to sort by Time">
                                            Time <SortIcon sortConfig={sortConfig} columnKey="createdAt" />
                                        </th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sortedSessions.map((session) => {
                                        const isLive = session.active && (session.expiresAt || 0) > Date.now();
                                        return (
                                            <tr
                                                key={session.id}
                                                onClick={() => navigate(`${basePath}/${session.id}`)}
                                                style={{ cursor: "pointer" }}
                                                title="Click to view detailed session attendance"
                                            >
                                                <td>
                                                    <strong>{session.classCode || "N/A"}</strong>
                                                    {isLive && (
                                                        <span style={{ marginLeft: "8px", fontSize: "0.72rem", background: "#fee2e2", color: "#dc2626", padding: "2px 6px", borderRadius: "4px", fontWeight: 800 }}>
                                                            🔴 LIVE
                                                        </span>
                                                    )}
                                                </td>
                                                <td>{session.batch || "—"}</td>
                                                <td>{session.courseCode || "N/A"}</td>
                                                {(isAdmin || activeTab === "all") && (
                                                    <td onClick={(e) => {
                                                        if (session.lecturerName) {
                                                            e.stopPropagation();
                                                            setSelectedLecturerFilter(session.lecturerName);
                                                            setSearchParams({ lecturer: session.lecturerName });
                                                        }
                                                    }}>
                                                        <span
                                                            className="table-lecturer-chip"
                                                            title={`Filter all classes by ${session.lecturerName || "Faculty"}`}
                                                        >
                                                            <FaChalkboardTeacher style={{ marginRight: "4px", color: "#6366f1" }} />
                                                            {session.lecturerName || "Faculty"}
                                                        </span>
                                                    </td>
                                                )}
                                                <td>{session.roomNo || "N/A"}</td>
                                                <td>{session.createdAt ? new Date(session.createdAt).toLocaleDateString() : "N/A"}</td>
                                                <td>{session.createdAt ? new Date(session.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "N/A"}</td>
                                                <td onClick={(e) => e.stopPropagation()}>
                                                    <button
                                                        type="button"
                                                        onClick={() => navigate(`${basePath}/${session.id}`)}
                                                        title="View full student attendance list"
                                                    >
                                                        View Attendance
                                                    </button>
                                                    {isSessionOwnerForSess(session) && (
                                                        <button
                                                            type="button"
                                                            className="remove-session-btn"
                                                            onClick={(event) => removeSession(event, session)}
                                                            title="Delete session record"
                                                        >
                                                            Remove
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

export function SessionAttendanceData() {
    const params = useParams();
    const sessionId = params.sessionId || params["*"] || "";
    const [session, setSession] = useState(null);
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedStudentForModal, setSelectedStudentForModal] = useState(null);
    const [showExcuseModal, setShowExcuseModal] = useState(false);
    const [manualRoll, setManualRoll] = useState("");
    const [manualReason, setManualReason] = useState("Physically verified & excused by lecturer in classroom");
    const [isExcusing, setIsExcusing] = useState(false);

    const navigate = useNavigate();
    const { user, profile } = useAuth();

    const isCurrentAdminPath = window.location.pathname.startsWith("/admin");
    const isCurrentLecturerPath = window.location.pathname.startsWith("/lecturer");

    const isAdmin = isCurrentAdminPath || (!isCurrentLecturerPath && (
        profile?.role === "admin" ||
        profile?.role === "administrator" ||
        profile?.role === "superadmin"
    ));

    const basePath = isCurrentAdminPath ? "/admin/classes" : "/lecturer/attendance-sessions";

    const { sortedItems: sortedRecords, sortConfig, requestSort } = useTableSort(records, "rollNo", "asc");

    const userEmail = (user?.email || "").toLowerCase().trim();
    const userUid = user?.uid;
    const userPrefix = userEmail.split("@")[0].toLowerCase().trim();
    const userName = (profile?.name || user?.displayName || "").toLowerCase().trim();

    const isSessionOwner = Boolean(
        isAdmin ||
        (session?.ownerId && session.ownerId === userUid) ||
        (session?.ownerEmail && session.ownerEmail.toLowerCase().trim() === userEmail) ||
        (session?.lecturerEmail && session.lecturerEmail.toLowerCase().trim() === userEmail) ||
        (userPrefix && (session?.ownerEmail?.toLowerCase().startsWith(userPrefix) || session?.lecturerEmail?.toLowerCase().startsWith(userPrefix))) ||
        (session?.lecturerName && userName && session.lecturerName.toLowerCase().trim() === userName)
    );

    const removeRecord = async (record) => {
        if (!isSessionOwner) {
            alert(`❌ Permission Denied: This class belongs to ${session?.lecturerName || "another lecturer"}. Only the assigned lecturer or an administrator can modify records.`);
            return;
        }

        if (!window.confirm(`Remove attendance for ${record.fullName || "this student"}?`)) {
            return;
        }

        try {
            await deleteDoc(doc(db, "attendance_records", record.id));
            setRecords((currentRecords) => currentRecords.filter(({ id }) => id !== record.id));
        } catch (error) {
            console.error("Error removing attendance record:", error);
            window.alert("Could not remove attendance record.");
        }
    };

    const handleExcuseStudentFromSession = async (studentOrRoll, reason = "Physically verified & excused by lecturer in classroom") => {
        if (!isSessionOwner) {
            alert(`❌ Permission Denied: This class belongs to ${session?.lecturerName || "another lecturer"}. Only ${session?.lecturerName || "the assigned lecturer"} or an administrator can excuse violations and mark attendance.`);
            return;
        }
        const cleanRoll = (typeof studentOrRoll === "string" ? studentOrRoll : (studentOrRoll.rollNo || studentOrRoll.studentUid || "")).trim().toUpperCase();
        const studentName = typeof studentOrRoll === "string" ? cleanRoll : (studentOrRoll.fullName || studentOrRoll.studentName || cleanRoll);

        if (!cleanRoll) {
            alert("Please enter a valid Roll Number.");
            return;
        }

        if (!window.confirm(`Excuse violation and reinstate attendance for ${studentName} (${cleanRoll}) as Present?`)) {
            return;
        }

        setIsExcusing(true);
        try {
            const lecturerDisplayName = profile?.name || user?.displayName || session?.lecturerName || "Lecturer";
            await excuseAndReinstateAttendance(session?.id || sessionId, {
                rollNo: cleanRoll,
                studentName: studentName,
                studentUid: typeof studentOrRoll === "object" ? (studentOrRoll.studentUid || cleanRoll) : cleanRoll,
                courseCode: session?.courseCode,
                classCode: session?.classCode,
                batch: session?.batch,
                roomNo: session?.roomNo
            }, lecturerDisplayName, reason);

            alert(`✅ Attendance for ${studentName} (${cleanRoll}) has been successfully restored and marked as Present!`);
            setManualRoll("");
            setShowExcuseModal(false);
        } catch (err) {
            console.error("Error excusing student:", err);
            alert("❌ Failed to reinstate attendance: " + (err.message || err));
        } finally {
            setIsExcusing(false);
        }
    };

    const handleDismissViolationFromSession = async (violationItem) => {
        if (!isSessionOwner) {
            alert(`❌ Permission Denied: This class belongs to ${session?.lecturerName || "another lecturer"}. Only ${session?.lecturerName || "the assigned lecturer"} or an administrator can dismiss violations.`);
            return;
        }

        const cleanRoll = (violationItem.rollNo || violationItem.studentUid || "").trim().toUpperCase();
        if (!window.confirm(`Dismiss and remove violation log for ${cleanRoll}? It will not appear in the active audit list again.`)) {
            return;
        }

        try {
            await dismissOrRemoveViolation(session?.id || sessionId, {
                rollNo: cleanRoll,
                studentUid: violationItem.studentUid || cleanRoll,
                id: violationItem.id
            }, profile?.role || "LECTURER", "DISMISSED", "Dismissed by faculty");

            // Optimistically update session state so card disappears immediately
            setSession((prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    flaggedViolations: (prev.flaggedViolations || []).filter((f) => {
                        const r = (f.rollNo || f.studentUid || "").toUpperCase().trim();
                        return r !== cleanRoll && f.id !== violationItem.id;
                    })
                };
            });
        } catch (err) {
            console.error("Error dismissing violation:", err);
            alert("❌ Failed to dismiss violation: " + (err.message || err));
        }
    };

    useEffect(() => {
        let isMounted = true;
        let unsubscribeRecords = () => { };

        const getAttendance = async () => {
            if (!sessionId) {
                if (isMounted) setLoading(false);
                return;
            }

            try {
                // 1. Direct fetch from attendance_sessions
                const sessionSnapshot = await getDoc(doc(db, "attendance_sessions", sessionId)).catch(() => ({ exists: () => false }));
                let sessData = null;
                let actualSessionId = sessionId;

                if (sessionSnapshot.exists()) {
                    sessData = sessionSnapshot.data();
                } else {
                    // 2. Case-insensitive search across attendance_sessions
                    const allSessionsSnap = await getDocs(collection(db, "attendance_sessions")).catch(() => ({ docs: [] }));
                    const targetId = String(sessionId).trim().toLowerCase();
                    const matchedSessionDoc = allSessionsSnap.docs.find((d) =>
                        d.id.toLowerCase() === targetId ||
                        d.id.toLowerCase().startsWith(targetId) ||
                        targetId.startsWith(d.id.toLowerCase())
                    );

                    if (matchedSessionDoc) {
                        sessData = matchedSessionDoc.data();
                        actualSessionId = matchedSessionDoc.id;
                    } else {
                        // 3. Auto-synthesize from attendance_records collection
                        const allRecs = await getDocs(collection(db, "attendance_records")).catch(() => ({ docs: [] }));
                        const matchingRecDocs = allRecs.docs.filter((d) => {
                            const data = d.data();
                            const rSessId = String(data.sessionId || data.session_id || "").trim().toLowerCase();
                            const docId = String(d.id).trim().toLowerCase();
                            return rSessId === targetId || docId.startsWith(`${targetId}_`) || docId === targetId;
                        });

                        if (matchingRecDocs.length > 0) {
                            const first = matchingRecDocs[0].data();
                            sessData = {
                                id: sessionId,
                                classCode: first.classCode || first.courseCode || "Class Session",
                                courseCode: first.courseCode || first.classCode || "Course",
                                roomNo: first.roomNo || "Room",
                                batch: first.batch || "2025",
                                lectureHours: first.lectureHours || first.durationHours || 1.0,
                                durationHours: first.lectureHours || first.durationHours || 1.0,
                                lecturerName: first.lecturerName || (first.ownerEmail ? first.ownerEmail.split("@")[0] : "Faculty"),
                                ownerEmail: first.lecturerEmail || first.ownerEmail || "",
                                createdAt: first.submittedAt || Date.now()
                            };
                        } else {
                            // 4. Check if sessionId was a single direct record document ID
                            const directRec = await getDoc(doc(db, "attendance_records", sessionId)).catch(() => ({ exists: () => false }));
                            if (directRec.exists()) {
                                const first = directRec.data();
                                sessData = {
                                    id: sessionId,
                                    classCode: first.classCode || first.courseCode || "Class Session",
                                    courseCode: first.courseCode || first.classCode || "Course",
                                    roomNo: first.roomNo || "Room",
                                    batch: first.batch || "2025",
                                    lectureHours: first.lectureHours || first.durationHours || 1.0,
                                    durationHours: first.lectureHours || first.durationHours || 1.0,
                                    lecturerName: first.lecturerName || (first.ownerEmail ? first.ownerEmail.split("@")[0] : "Faculty"),
                                    ownerEmail: first.lecturerEmail || first.ownerEmail || "",
                                    createdAt: first.submittedAt || Date.now()
                                };
                            } else {
                                // Synthesize clean fallback rather than failing
                                sessData = {
                                    id: sessionId,
                                    classCode: sessionId.split("_")[0] || "Class Session",
                                    courseCode: sessionId.split("_")[0] || "Course",
                                    roomNo: "N/A",
                                    batch: "2025",
                                    lectureHours: 1.0,
                                    durationHours: 1.0,
                                    lecturerName: profile?.name || user?.displayName || "Faculty",
                                    ownerEmail: user?.email || "",
                                    createdAt: Date.now()
                                };
                            }
                        }
                    }
                }

                if (!isMounted) return;

                // Resolve lecturer name
                let lecturerDisplay = sessData.lecturerName;
                if (!lecturerDisplay) {
                    const ownerEmail = sessData.ownerEmail || sessData.lecturerEmail;
                    if (ownerEmail) {
                        const userSnap = await getDoc(doc(db, "authorizedUsers", ownerEmail.toLowerCase())).catch(() => ({ exists: () => false }));
                        if (userSnap.exists() && userSnap.data().name) {
                            lecturerDisplay = userSnap.data().name;
                        } else {
                            lecturerDisplay = ownerEmail.split("@")[0];
                        }
                    } else {
                        lecturerDisplay = "Faculty";
                    }
                }

                // Resolve batch
                let resolvedBatch = (sessData.batch || "").toString().trim();
                if (!resolvedBatch || resolvedBatch === "—") {
                    const courseKey = (sessData.courseCode || sessData.classCode || "").toUpperCase().trim();
                    if (courseKey) {
                        const courseSnap = await getDoc(doc(db, "courses", courseKey)).catch(() => ({ exists: () => false }));
                        if (courseSnap.exists() && courseSnap.data().batch) {
                            resolvedBatch = courseSnap.data().batch;
                        } else {
                            resolvedBatch = "2025";
                        }
                    } else {
                        resolvedBatch = "2025";
                    }
                }

                setSession({ id: actualSessionId, ...sessData, batch: resolvedBatch, lecturerName: lecturerDisplay });

                // Real-time listener for attendance records of this session
                unsubscribeRecords = onSnapshot(collection(db, "attendance_records"), (recordsSnapshot) => {
                    if (!isMounted) return;

                    const targetSessId = String(actualSessionId).trim().toLowerCase();
                    const urlSessId = String(sessionId).trim().toLowerCase();

                    const rawRecords = recordsSnapshot.docs
                        .filter((d) => {
                            const data = d.data();
                            const rSessId = String(data.sessionId || data.session_id || "").trim().toLowerCase();
                            const docId = String(d.id).trim().toLowerCase();
                            return (
                                rSessId === targetSessId ||
                                rSessId === urlSessId ||
                                docId.startsWith(`${targetSessId}_`) ||
                                docId.startsWith(`${urlSessId}_`) ||
                                docId === targetSessId ||
                                docId === urlSessId
                            );
                        })
                        .map((recordDoc) => ({
                            id: recordDoc.id,
                            ...recordDoc.data()
                        }));

                    // Also include attendees from current session data if not already present
                    if (Array.isArray(sessData?.attendees)) {
                        const existingRolls = new Set(rawRecords.map(r => String(r.rollNo || "").toUpperCase().trim()));
                        sessData.attendees.forEach((att, idx) => {
                            const roll = att.rollNo || att.rollNumber || (typeof att === 'string' ? att : null);
                            const cleanRoll = roll ? String(roll).toUpperCase().trim() : "";
                            if (cleanRoll && !existingRolls.has(cleanRoll)) {
                                existingRolls.add(cleanRoll);
                                rawRecords.push({
                                    id: att.id || `${actualSessionId}_${roll || idx}`,
                                    sessionId: actualSessionId,
                                    rollNo: roll,
                                    fullName: att.fullName || att.name || att.studentName || "Student",
                                    studentEmail: att.studentEmail || att.email || "",
                                    deviceType: att.deviceType || "",
                                    submittedAt: att.submittedAt || att.timestamp || att.time || sessData.createdAt,
                                    faceVerified: att.faceVerified ?? true,
                                    excused: att.excused ?? false,
                                    status: att.status || "APPROVED"
                                });
                            }
                        });
                    }

                    rawRecords.sort((a, b) => {
                        const rollA = a.rollNo || "";
                        const rollB = b.rollNo || "";
                        return rollA.localeCompare(rollB, undefined, { numeric: true, sensitivity: 'base' });
                    });

                    setRecords(rawRecords);
                    setLoading(false);
                }, (err) => {
                    console.error("Error in records listener:", err);
                    if (isMounted) setLoading(false);
                });

            } catch (error) {
                console.error("Error getting attendance:", error);
                if (isMounted) setLoading(false);
            }
        };

        getAttendance();

        return () => {
            isMounted = false;
            unsubscribeRecords();
        };
    }, [sessionId, user]);

    if (loading) {
        return (
            <div className="attendance-data-page">
                <p>Loading attendance data...</p>
            </div>
        );
    }

    if (!session) {
        return (
            <div className="attendance-data-page">
                <button className="back-to-sessions-btn" onClick={() => navigate(basePath)}>⬅️ Back to Sessions</button>
                <div className="classes-empty-card">
                    <div className="classes-empty-icon">⚠️</div>
                    <h3>Session Not Found</h3>
                    <p>The requested attendance session does not exist or may have been deleted.</p>
                </div>
            </div>
        );
    }

    const sessionDateTime = formatSessionDateTime(session.createdAt);
    const unreviewedViolationsList = (session?.flaggedViolations || []).filter((f) => {
        const roll = (f.rollNo || f.studentUid || "").toUpperCase().trim();
        const isAlreadyPresent = records.some(r => (r.rollNo || "").toUpperCase() === roll && (r.excused || r.status === "APPROVED" || r.status === "ATTENDED" || r.faceVerified));
        const isAlreadyReviewed = f.reviewed === true || f.excused === true || f.resolved === true || f.dismissed === true || f.status === "RESOLVED" || f.status === "APPROVED" || f.status === "DISMISSED";
        return !isAlreadyPresent && !isAlreadyReviewed;
    });

    return (
        <div className="attendance-data-page">
            <div className="session-actions-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <button className="back-to-sessions-btn" onClick={() => navigate(basePath)}>⬅️ Back to Sessions</button>
                    {isSessionOwner ? (
                        <button
                            type="button"
                            onClick={() => setShowExcuseModal(true)}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                padding: "8px 16px",
                                borderRadius: "10px",
                                background: "#10b981",
                                color: "#ffffff",
                                border: "none",
                                fontWeight: 700,
                                cursor: "pointer",
                                fontSize: "0.85rem",
                                boxShadow: "0 2px 8px rgba(16, 185, 129, 0.25)"
                            }}
                        >
                            <FaUserPlus /> ➕ Excuse / Reinstate Student
                        </button>
                    ) : (
                        <div style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            padding: "6px 14px",
                            borderRadius: "10px",
                            background: "#f1f5f9",
                            color: "#64748b",
                            border: "1px solid #cbd5e1",
                            fontSize: "0.82rem",
                            fontWeight: 700
                        }}>
                            <span>👁️ Read-Only Session ({session?.lecturerName || "Assigned Faculty"})</span>
                        </div>
                    )}
                </div>

                {records.length > 0 && (
                    <button
                        className="download-excel-btn"
                        onClick={() => downloadExcel("session-attendance-table", `Attendance-${session.classCode || "Class"}-${new Date().toISOString().slice(0, 10)}`)}
                    >
                        📥 Download Excel
                    </button>
                )}
            </div>

            <h2>Attendance - {session.classCode}</h2>
            <div className="session-summary-box">
                <span className="session-summary-item"><strong>Lecturer:</strong> {session.lecturerName || "Faculty"}</span>
                <span className="session-summary-item"><strong>Batch:</strong> {session.batch || "2025"}</span>
                <span className="session-summary-item"><strong>Course Code:</strong> {session.courseCode || "N/A"}</span>
                <span className="session-summary-item"><strong>Duration:</strong> {session.lectureHours || session.durationHours || 1.0} hr(s)</span>
                <span className="session-summary-item"><strong>Room:</strong> {session.roomNo || "N/A"}</span>
                <span className="session-summary-item"><strong>Session Date:</strong> {sessionDateTime.dateStr}</span>
                <span className="session-summary-item"><strong>Total Present:</strong> <strong style={{ color: "#10b981" }}>{records.length}</strong></span>
            </div>

            {/* Flagged Violations Section & Quick Pardon / Dismiss Hub */}
            {unreviewedViolationsList.length > 0 && (
                <div className="session-violations-alert-box">
                    <div className="session-violations-header">
                        <FaExclamationTriangle className="session-violations-icon" />
                        <h3>
                            Pending Flagged Violations ({unreviewedViolationsList.length})
                        </h3>
                    </div>
                    <p className="session-violations-desc">
                        {isSessionOwner
                            ? "These students incurred security violations (app switching or screen lockout). If they provide a valid reason in class, click \"Excuse\" to restore attendance, or \"Dismiss\" to remove the violation log."
                            : `These students incurred security violations for this session. Only the assigned lecturer (${session?.lecturerName || "Faculty"}) or an administrator can excuse or dismiss violations.`}
                    </p>
                    <div className="session-violations-grid">
                        {unreviewedViolationsList.map((f, idx) => {
                            const roll = (f.rollNo || f.studentUid || "STUDENT").toUpperCase();

                            return (
                                <div key={idx} className="session-violation-card">
                                    <div className="session-violation-info">
                                        <strong className="session-violation-roll">{roll}</strong>
                                        <span className="session-violation-reason">
                                            {f.violationReason || f.violationType || "App switch violation"}
                                        </span>
                                    </div>
                                    {isSessionOwner ? (
                                        <div className="session-violation-actions">
                                            <button
                                                type="button"
                                                onClick={() => handleDismissViolationFromSession(f)}
                                                className="session-violation-dismiss-btn"
                                                title="Dismiss flag without restoring attendance"
                                            >
                                                <FaTimes /> Dismiss
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleExcuseStudentFromSession(roll, "Excused physically by lecturer in classroom")}
                                                className="session-violation-excuse-btn"
                                                title="Excuse violation & mark student as Present"
                                            >
                                                <FaCheck /> Excuse
                                            </button>
                                        </div>
                                    ) : (
                                        <span className="session-violation-restricted-badge">
                                            Restricted
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {records.length === 0 ? (
                <div className="classes-empty-card">
                    <div className="classes-empty-icon">👥</div>
                    <h3>No Submissions Yet</h3>
                    <p>No students have submitted attendance for this session yet. As students scan the QR code, their attendance will appear here live in real-time.</p>
                </div>
            ) : (
                <div className="attendance-table-scroll">
                    <table id="session-attendance-table">
                        <thead>
                            <tr>
                                <th className="sortable-th" onClick={() => requestSort("rollNo")} title="Click to sort by Roll Number">
                                    Roll Number <SortIcon sortConfig={sortConfig} columnKey="rollNo" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("fullName")} title="Click to sort by Name">
                                    Name <SortIcon sortConfig={sortConfig} columnKey="fullName" />
                                </th>
                                <th>Class Code</th>
                                <th>Room No</th>
                                <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Date">
                                    Date <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Time">
                                    Time <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                                </th>
                                <th>Verification &amp; Status</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedRecords.map((record) => {
                                const recordDateTime = formatSessionDateTime(record.submittedAt);
                                return (
                                    <tr
                                        key={record.id}
                                        onClick={() => setSelectedStudentForModal({
                                            id: record.studentUid || record.rollNo,
                                            rollNo: record.rollNo,
                                            name: record.fullName || record.name || record.studentName || "Student",
                                            email: record.studentEmail || record.email || "",
                                            department: session?.department || session?.classCode || "CSE",
                                            batch: session?.batch || "2025"
                                        })}
                                        style={{ cursor: "pointer" }}
                                        title="Click to view student profile & attendance history"
                                    >
                                        <td><strong>{record.rollNo}</strong></td>
                                        <td>{record.fullName || record.name || record.studentName || "Student"}</td>
                                        <td>{session.classCode}</td>
                                        <td>{session.roomNo || "N/A"}</td>
                                        <td>{recordDateTime.dateStr}</td>
                                        <td>{recordDateTime.timeStr}</td>
                                        <td>
                                            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                {record.excused ? (
                                                    <span style={{ color: "#10b981", fontWeight: 750, fontSize: "0.82rem" }}>
                                                        ✅ Excused (Present)
                                                    </span>
                                                ) : record.faceVerified ? (
                                                    <span style={{ color: "#10b981", fontWeight: 700, fontSize: "0.82rem" }}>
                                                        ✅ Face Verified
                                                    </span>
                                                ) : (
                                                    <span style={{ color: "#6366f1", fontWeight: 700, fontSize: "0.82rem" }}>
                                                        📱 QR Verified
                                                    </span>
                                                )}
                                                {record.deviceType && (
                                                    <span style={{
                                                        fontSize: "0.72rem",
                                                        fontWeight: 700,
                                                        color: record.deviceType === "android" ? "#059669" : record.deviceType === "ios" ? "#0284c7" : "#64748b"
                                                    }}>
                                                        {record.deviceType === "android" ? "🤖 Android APK" : record.deviceType === "ios" ? "🍎 iPhone iOS" : record.deviceType}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td onClick={(e) => e.stopPropagation()}>
                                            {isSessionOwner ? (
                                                <button
                                                    type="button"
                                                    className="remove-session-btn"
                                                    style={{ margin: 0, padding: "6px 12px", fontSize: "0.82rem" }}
                                                    onClick={() => removeRecord(record)}
                                                >
                                                    Remove
                                                </button>
                                            ) : (
                                                <span style={{ color: "#94a3b8", fontSize: "0.78rem", fontWeight: 600 }}>
                                                    Read-Only
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Student Detail Modal */}
            {selectedStudentForModal && (
                <StudentDetailModal
                    student={selectedStudentForModal}
                    onClose={() => setSelectedStudentForModal(null)}
                    onUpdate={() => { }}
                />
            )}

            {/* Manual Excuse / Reinstate Student Modal */}
            {showExcuseModal && (
                <div style={{
                    position: "fixed",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: "rgba(15, 23, 42, 0.65)",
                    backdropFilter: "blur(4px)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: 9999,
                    padding: "16px"
                }}>
                    <div style={{
                        backgroundColor: "#ffffff",
                        borderRadius: "20px",
                        padding: "26px",
                        maxWidth: "460px",
                        width: "100%",
                        boxShadow: "0 20px 40px rgba(0,0,0,0.25)",
                        border: "1px solid #e2e8f0"
                    }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "#10b981" }}>
                                <FaCheckCircle style={{ fontSize: "1.4rem" }} />
                                <h3 style={{ margin: 0, color: "#0f172a", fontSize: "1.2rem", fontWeight: 800 }}>
                                    Excuse &amp; Reinstate Student
                                </h3>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowExcuseModal(false)}
                                style={{ background: "none", border: "none", fontSize: "1.2rem", color: "#64748b", cursor: "pointer" }}
                            >
                                <FaTimes />
                            </button>
                        </div>

                        <p style={{ margin: "0 0 16px", fontSize: "0.85rem", color: "#64748b", lineHeight: 1.4 }}>
                            Reinstate student attendance for <strong>{session.courseCode || session.classCode}</strong> ({session.roomNo}). The student will be recorded as Present.
                        </p>

                        <form onSubmit={(e) => { e.preventDefault(); handleExcuseStudentFromSession(manualRoll, manualReason); }}>
                            <div style={{ marginBottom: "14px" }}>
                                <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                                    Student Roll Number *
                                </label>
                                <input
                                    type="text"
                                    placeholder="e.g. 25BCS108"
                                    value={manualRoll}
                                    onChange={(e) => setManualRoll(e.target.value.toUpperCase())}
                                    required
                                    style={{
                                        width: "100%",
                                        padding: "10px 14px",
                                        borderRadius: "10px",
                                        border: "1.5px solid #cbd5e1",
                                        fontSize: "0.95rem",
                                        fontWeight: 700,
                                        boxSizing: "border-box"
                                    }}
                                />
                            </div>

                            <div style={{ marginBottom: "20px" }}>
                                <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                                    Excuse Reason
                                </label>
                                <input
                                    type="text"
                                    placeholder="e.g. Physically verified in class"
                                    value={manualReason}
                                    onChange={(e) => setManualReason(e.target.value)}
                                    style={{
                                        width: "100%",
                                        padding: "10px 14px",
                                        borderRadius: "10px",
                                        border: "1.5px solid #cbd5e1",
                                        fontSize: "0.88rem",
                                        boxSizing: "border-box"
                                    }}
                                />
                            </div>

                            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                                <button
                                    type="button"
                                    onClick={() => setShowExcuseModal(false)}
                                    disabled={isExcusing}
                                    style={{
                                        padding: "10px 16px",
                                        borderRadius: "10px",
                                        border: "1px solid #cbd5e1",
                                        background: "#ffffff",
                                        color: "#475569",
                                        fontWeight: 700,
                                        cursor: "pointer"
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={isExcusing}
                                    style={{
                                        padding: "10px 18px",
                                        borderRadius: "10px",
                                        border: "none",
                                        background: "#10b981",
                                        color: "#ffffff",
                                        fontWeight: 700,
                                        cursor: "pointer",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "6px",
                                        boxShadow: "0 4px 12px rgba(16, 185, 129, 0.3)"
                                    }}
                                >
                                    {isExcusing ? <FaSpinner className="fa-spin" /> : <FaCheck />}
                                    <span>Reinstate &amp; Mark Present</span>
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

export default ClassesData;


