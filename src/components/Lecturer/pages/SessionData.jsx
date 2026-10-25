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
import ExcuseFaceVerification from "../../Common/ExcuseFaceVerification";
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
    const [authorizations, setAuthorizations] = useState([]);
    const [enrolledStudents, setEnrolledStudents] = useState([]);
    const [allStudentsMap, setAllStudentsMap] = useState(new Map());
    const [rosterTab, setRosterTab] = useState("ALL"); // "ALL" | "PRESENT" | "PENDING" | "DISQUALIFIED" | "ABSENT"
    const [searchTerm, setSearchTerm] = useState("");
    const [loading, setLoading] = useState(true);
    const [selectedStudentForModal, setSelectedStudentForModal] = useState(null);
    const [showExcuseModal, setShowExcuseModal] = useState(false);
    const [manualRoll, setManualRoll] = useState("");
    const [manualReason, setManualReason] = useState("Physically verified & excused by lecturer in classroom");
    const [isExcusing, setIsExcusing] = useState(false);
    const [pendingFaceExcuse, setPendingFaceExcuse] = useState(null);

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

    const removeRecord = async (recordOrMember) => {
        if (!isSessionOwner) {
            alert(`❌ Permission Denied: This class belongs to ${session?.lecturerName || "another lecturer"}. Only the assigned lecturer or an administrator can modify records.`);
            return;
        }

        const recId = recordOrMember.recordId || recordOrMember.id;
        const cleanRoll = (recordOrMember.rollNo || "").toUpperCase().trim();
        const studentDisplayName = recordOrMember.name || recordOrMember.fullName || recordOrMember.rollNo || "this student";

        if (!window.confirm(`Remove attendance for ${studentDisplayName}?`)) {
            return;
        }

        try {
            if (recId) {
                await deleteDoc(doc(db, "attendance_records", recId)).catch(() => {});
            }
            if (cleanRoll && session?.id) {
                await deleteDoc(doc(db, "attendance_records", `${session.id}_${cleanRoll}`)).catch(() => {});
            }
            setRecords((currentRecords) => currentRecords.filter(({ id, rollNo }) => id !== recId && String(rollNo || "").toUpperCase() !== cleanRoll));
        } catch (error) {
            console.error("Error removing attendance record:", error);
            window.alert("Could not remove attendance record.");
        }
    };

    const handleExcuseStudentFromSession = async (
        studentOrRoll,
        reason = "Physically verified & excused by lecturer in classroom",
        faceVerified = false
    ) => {
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

        if (!faceVerified) {
            setPendingFaceExcuse({
                student: typeof studentOrRoll === "string"
                    ? { rollNo: cleanRoll, name: studentName }
                    : { ...studentOrRoll, rollNo: cleanRoll, name: studentName },
                reason
            });
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
                roomNo: session?.roomNo,
                faceVerified: true
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

            // Optimistically update session state: mark as reviewed/dismissed in-place so pending list updates while preserving audit history
            setSession((prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    flaggedViolations: (prev.flaggedViolations || []).map((f) => {
                        const r = (f.rollNo || f.studentUid || "").toUpperCase().trim();
                        if (r === cleanRoll || f.id === violationItem.id) {
                            return {
                                ...f,
                                reviewed: true,
                                dismissed: true,
                                resolutionStatus: "DISMISSED",
                                status: "DISMISSED"
                            };
                        }
                        return f;
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
        let unsubscribeAuths = () => { };

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
                                    faceVerified: Boolean(att.faceVerified),
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

                // Real-time listener for authorizations subcollection (QR 1 check-ins)
                const authColRef = collection(db, "attendance_sessions", actualSessionId, "authorizations");
                unsubscribeAuths = onSnapshot(authColRef, (authSnapshot) => {
                    if (!isMounted) return;
                    const authList = authSnapshot.docs.map((d) => ({
                        id: d.id,
                        ...d.data()
                    }));
                    setAuthorizations(authList);
                }, (err) => {
                    console.warn("Notice loading session authorizations:", err);
                });

                // Load Course Enrolled Students & Student Directory
                try {
                    const courseKey = (sessData.courseCode || sessData.classCode || "").toUpperCase().trim();
                    const [coursesSnap, studentsSnap] = await Promise.all([
                        getDocs(collection(db, "courses")).catch(() => ({ docs: [] })),
                        getDocs(collection(db, "students")).catch(() => ({ docs: [] }))
                    ]);

                    if (isMounted) {
                        const sMap = new Map();
                        studentsSnap.docs.forEach((docSnap) => {
                            const d = docSnap.data();
                            const roll = String(d.rollNo || docSnap.id || "").toUpperCase().trim();
                            if (roll) sMap.set(roll, { id: docSnap.id, ...d });
                        });
                        setAllStudentsMap(sMap);

                        if (courseKey) {
                            const matchedCourse = coursesSnap.docs
                                .map((d) => ({ id: d.id, ...d.data() }))
                                .find((c) => {
                                    const code = String(c.courseCode || c.code || c.id || "").toUpperCase().trim();
                                    return code === courseKey || code.replace(/[^A-Z0-9]/g, "") === courseKey.replace(/[^A-Z0-9]/g, "");
                                });
                            if (matchedCourse && Array.isArray(matchedCourse.enrolledStudents)) {
                                setEnrolledStudents(matchedCourse.enrolledStudents);
                            }
                        }
                    }
                } catch (metaErr) {
                    console.warn("Notice loading course/student metadata:", metaErr);
                }

            } catch (error) {
                console.error("Error getting attendance:", error);
                if (isMounted) setLoading(false);
            }
        };

        getAttendance();

        return () => {
            isMounted = false;
            unsubscribeRecords();
            unsubscribeAuths();
        };
    }, [sessionId, user]);

    // Helpers to detect disqualifications and violations
    const checkIsDisqualified = (item) => {
        if (!item) return false;
        if (item.disqualified === true) return true;
        const s = String(item.status || "").toUpperCase();
        if (s === "DISQUALIFIED" || s === "FLAGGED_DISQUALIFIED" || s === "REJECTED") return true;
        if (Number(item.violationCount || item.confirmedKioskViolations || 0) >= 2) return true;
        if (Array.isArray(item.violations) && item.violations.some(v => v.disqualified === true || Number(v.count || 0) >= 2)) return true;
        return false;
    };

    const checkHasViolation = (item) => {
        if (!item) return false;
        if (checkIsDisqualified(item)) return true;
        if (item.hasViolation === true || item.flagged === true) return true;
        const s = String(item.status || "").toUpperCase();
        if (s.startsWith("FLAGGED") || s.includes("VIOLATION") || s.includes("ESCAPE")) return true;
        if (Array.isArray(item.violations) && item.violations.length > 0) return true;
        if (Number(item.violationCount || item.confirmedKioskViolations || 0) > 0) return true;
        return false;
    };

    // Full Unified Roster Construction: Merges Enrolled, Authorizations, Flagged Violations, and Records
    const allMembersList = useMemo(() => {
        const map = new Map();

        // 1. Enrolled students from course baseline (Marked as ABSENT by default)
        (enrolledStudents || []).forEach((stud, idx) => {
            const roll = (typeof stud === "string" ? stud : stud.rollNo || stud.rollNumber || "").toUpperCase().trim();
            if (!roll) return;
            const sMeta = allStudentsMap.get(roll);
            map.set(roll, {
                id: roll,
                rollNo: roll,
                name: (typeof stud === "object" && stud.name) || sMeta?.name || sMeta?.fullName || "Student",
                email: (typeof stud === "object" && stud.email) || sMeta?.email || "",
                department: sMeta?.branch || sMeta?.department || session?.classCode || "CSE",
                batch: sMeta?.batch || session?.batch || "2025",
                status: "ABSENT",
                statusLabel: "Absent (Not Scanned)",
                scannedAt: null,
                submittedAt: null,
                deviceType: "",
                verificationType: "NONE",
                violationReason: null,
                violationCount: 0,
                excused: false,
                faceVerified: false
            });
        });

        // 2. Authorizations subcollection (Students who scanned QR 1)
        (authorizations || []).forEach((auth) => {
            const roll = (auth.rollNo || auth.studentUid || auth.id || "").toUpperCase().trim();
            if (!roll) return;
            const sMeta = allStudentsMap.get(roll);
            const existing = map.get(roll);

            const isDisq = checkIsDisqualified(auth);
            const hasV = isDisq || checkHasViolation(auth);

            const vReason = auth.violationReason ||
                (Array.isArray(auth.violations) && auth.violations.length > 0 ? (auth.violations[auth.violations.length - 1].reason || auth.violations[0].reason) : null) ||
                (isDisq ? "Attendance forfeited: 2 confirmed kiosk exits" : hasV ? "App switch / supervision warning" : null);

            const status = isDisq ? "DISQUALIFIED" : hasV ? "FLAGGED" : "PENDING_QR2";
            const statusLabel = isDisq ? "Disqualified (App Switch)" : hasV ? "Flagged Warning" : "Pending QR 2 (In Kiosk)";

            map.set(roll, {
                id: auth.studentUid || roll,
                rollNo: roll,
                name: auth.studentName || auth.fullName || existing?.name || sMeta?.name || "Student",
                email: auth.studentEmail || existing?.email || sMeta?.email || "",
                department: existing?.department || sMeta?.branch || session?.classCode || "CSE",
                batch: existing?.batch || sMeta?.batch || session?.batch || "2025",
                status: status,
                statusLabel: statusLabel,
                scannedAt: auth.scannedAt || auth.timestamp || auth.authorizedAt,
                submittedAt: null,
                deviceType: auth.deviceType || auth.platform || existing?.deviceType || "",
                verificationType: isDisq ? "DISQUALIFIED" : "QR1_AUTHORIZED",
                violationReason: vReason,
                violationCount: Number(auth.violationCount || auth.confirmedKioskViolations || (isDisq ? 2 : hasV ? 1 : 0)),
                excused: auth.excused === true,
                faceVerified: false,
                released: auth.released === true
            });
        });

        // 3. Session flagged violations overlay
        (session?.flaggedViolations || []).forEach((f) => {
            const roll = (f.rollNo || f.studentUid || "").toUpperCase().trim();
            if (!roll) return;
            const isReviewed = f.reviewed === true || f.excused === true || f.resolved === true || f.dismissed === true;
            if (isReviewed) return;

            const existing = map.get(roll);
            const isDisq = f.disqualified === true || f.status === "FLAGGED_DISQUALIFIED" || Number(f.count || f.violationCount || 0) >= 1 || existing?.status === "DISQUALIFIED";
            const sMeta = allStudentsMap.get(roll);

            map.set(roll, {
                id: f.studentUid || roll,
                rollNo: roll,
                name: f.studentName || existing?.name || sMeta?.name || "Student",
                email: existing?.email || sMeta?.email || "",
                department: existing?.department || sMeta?.branch || session?.classCode || "CSE",
                batch: existing?.batch || sMeta?.batch || session?.batch || "2025",
                status: isDisq ? "DISQUALIFIED" : "FLAGGED",
                statusLabel: isDisq ? "Disqualified (App Switch)" : "Flagged Warning",
                scannedAt: existing?.scannedAt || f.timestamp,
                submittedAt: existing?.submittedAt || null,
                deviceType: existing?.deviceType || "",
                verificationType: isDisq ? "DISQUALIFIED" : "FLAGGED",
                violationReason: f.violationReason || f.violationType || (isDisq ? "Attendance forfeited: confirmed kiosk exit violation" : "App switch detected"),
                violationCount: Number(f.count || f.violationCount || 1),
                excused: false,
                faceVerified: false
            });
        });

        // 4. Attendance records & Attendees (Students who reached QR 2 and submitted, or excused)
        (records || []).forEach((rec) => {
            const roll = (rec.rollNo || "").toUpperCase().trim();
            if (!roll) return;
            const sMeta = allStudentsMap.get(roll);
            const existing = map.get(roll);

            const isExcused = rec.excused === true;
            const isDisq = !isExcused && (rec.disqualified === true || rec.status === "FLAGGED_DISQUALIFIED");

            let status = "PRESENT";
            let statusLabel = "Reached QR 2 (Present)";
            if (isDisq) {
                status = "DISQUALIFIED";
                statusLabel = "Disqualified (App Switch)";
            } else if (isExcused) {
                status = "PRESENT";
                statusLabel = "Excused (Present)";
            } else if (rec.faceVerified) {
                statusLabel = "Face Verified (Present)";
            } else {
                statusLabel = "QR Verified (Present)";
            }

            map.set(roll, {
                id: rec.id || roll,
                recordId: rec.id,
                rollNo: roll,
                name: rec.fullName || rec.name || rec.studentName || existing?.name || sMeta?.name || "Student",
                email: rec.studentEmail || rec.email || existing?.email || sMeta?.email || "",
                department: existing?.department || sMeta?.branch || session?.classCode || "CSE",
                batch: existing?.batch || sMeta?.batch || session?.batch || "2025",
                status: status,
                statusLabel: statusLabel,
                scannedAt: existing?.scannedAt || rec.submittedAt,
                submittedAt: rec.submittedAt || rec.timestamp || rec.time,
                deviceType: rec.deviceType || existing?.deviceType || "",
                verificationType: isExcused ? "EXCUSED" : rec.faceVerified ? "FACE_VERIFIED" : "QR_VERIFIED",
                violationReason: isDisq ? (rec.violationReason || "Security violation limit reached") : null,
                violationCount: isDisq ? 2 : 0,
                excused: isExcused,
                faceVerified: Boolean(rec.faceVerified),
                rawRecord: rec
            });
        });

        return Array.from(map.values()).sort((a, b) => {
            return a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true, sensitivity: "base" });
        });
    }, [enrolledStudents, authorizations, session?.flaggedViolations, records, allStudentsMap, session?.classCode, session?.batch]);

    // Summary Metric Counts
    const { totalCount, presentCount, pendingCount, disqualifiedCount, absentCount } = useMemo(() => {
        let pres = 0;
        let pend = 0;
        let disq = 0;
        let abs = 0;

        allMembersList.forEach((m) => {
            if (m.status === "PRESENT" || m.status === "EXCUSED" || m.excused) pres++;
            else if (m.status === "PENDING_QR2") pend++;
            else if (m.status === "DISQUALIFIED" || m.status === "FLAGGED") disq++;
            else if (m.status === "ABSENT") abs++;
        });

        return {
            totalCount: allMembersList.length,
            presentCount: pres,
            pendingCount: pend,
            disqualifiedCount: disq,
            absentCount: abs
        };
    }, [allMembersList]);

    // Tab-Filtered and Search-Filtered Roster
    const filteredMembers = useMemo(() => {
        return allMembersList.filter((m) => {
            if (rosterTab === "PRESENT" && m.status !== "PRESENT") return false;
            if (rosterTab === "PENDING" && m.status !== "PENDING_QR2") return false;
            if (rosterTab === "DISQUALIFIED" && m.status !== "DISQUALIFIED" && m.status !== "FLAGGED") return false;
            if (rosterTab === "ABSENT" && m.status !== "ABSENT") return false;

            if (searchTerm.trim()) {
                const q = searchTerm.toLowerCase().trim();
                const roll = (m.rollNo || "").toLowerCase();
                const name = (m.name || "").toLowerCase();
                const email = (m.email || "").toLowerCase();
                return roll.includes(q) || name.includes(q) || email.includes(q);
            }
            return true;
        });
    }, [allMembersList, rosterTab, searchTerm]);

    const { sortedItems: sortedMembers, sortConfig, requestSort } = useTableSort(filteredMembers, "rollNo", "asc");

    const isSessionLive = Boolean(
        session?.active !== false &&
        (session?.phase === "PHASE_1" || session?.phase === "PHASE_2" || session?.status === "ACTIVE" || (session?.expiresAt || 0) > Date.now())
    );

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
                <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
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

                    {isSessionLive && (
                        <button
                            type="button"
                            onClick={() => navigate(`/lecturer/lecturerpage?session=${session.id}`)}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                padding: "8px 16px",
                                borderRadius: "10px",
                                background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                                color: "#ffffff",
                                border: "none",
                                fontWeight: 750,
                                cursor: "pointer",
                                fontSize: "0.85rem",
                                boxShadow: "0 2px 8px rgba(99, 102, 241, 0.3)"
                            }}
                            title="Open live projector screen with rotating QR codes & kiosk monitor"
                        >
                            <FaQrcode /> 📺 Live QR &amp; Kiosk Hub
                        </button>
                    )}
                </div>

                {allMembersList.length > 0 && (
                    <button
                        className="download-excel-btn"
                        onClick={() => downloadExcel("session-attendance-table", `Attendance-${session.classCode || "Class"}-${new Date().toISOString().slice(0, 10)}`)}
                    >
                        📥 Download Excel
                    </button>
                )}
            </div>

            {/* Prominent Live Session Banner */}
            {isSessionLive && (
                <div style={{
                    margin: "16px 0 20px",
                    padding: "16px 20px",
                    borderRadius: "16px",
                    background: "linear-gradient(135deg, rgba(99, 102, 241, 0.08), rgba(79, 70, 229, 0.12))",
                    border: "1.5px solid rgba(99, 102, 241, 0.35)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "14px"
                }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, flex: 1 }}>
                        <div style={{
                            background: "#6366f1",
                            color: "#ffffff",
                            padding: "6px 12px",
                            borderRadius: "10px",
                            fontSize: "0.78rem",
                            fontWeight: 800,
                            letterSpacing: "0.04em",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            whiteSpace: "nowrap"
                        }}>
                            <span>● LIVE SESSION IN PROGRESS</span>
                        </div>
                        <div>
                            <h4 style={{ margin: "0 0 2px", fontSize: "1rem", color: "#0f172a", fontWeight: 800 }}>
                                {session.phase === "PHASE_2" ? "Phase 2: Biometric Verification Active" : "Phase 1: Student Check-in & Kiosk Lock Active"}
                            </h4>
                            <p style={{ margin: 0, fontSize: "0.82rem", color: "#64748b" }}>
                                Students are actively checking in. Open the live projector screen to show rotating QR codes and monitor kiosk modes.
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => navigate(`/lecturer/lecturerpage?session=${session.id}`)}
                        style={{
                            padding: "9px 18px",
                            borderRadius: "10px",
                            background: "#6366f1",
                            color: "#ffffff",
                            border: "none",
                            fontWeight: 750,
                            fontSize: "0.86rem",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "8px",
                            boxShadow: "0 4px 12px rgba(99, 102, 241, 0.3)",
                            whiteSpace: "nowrap"
                        }}
                    >
                        <FaQrcode /> 📺 Open Live QR Code &amp; Kiosk Hub →
                    </button>
                </div>
            )}

            <h2>Attendance - {session.classCode}</h2>
            <div className="session-summary-box">
                <span className="session-summary-item"><strong>Lecturer:</strong> {session.lecturerName || "Faculty"}</span>
                <span className="session-summary-item"><strong>Batch:</strong> {session.batch || "2025"}</span>
                <span className="session-summary-item"><strong>Course Code:</strong> {session.courseCode || "N/A"}</span>
                <span className="session-summary-item"><strong>Duration:</strong> {session.lectureHours || session.durationHours || 1.0} hr(s)</span>
                <span className="session-summary-item"><strong>Room:</strong> {session.roomNo || "N/A"}</span>
                <span className="session-summary-item"><strong>Session Date:</strong> {sessionDateTime.dateStr}</span>
                <span className="session-summary-item"><strong>Present:</strong> <strong style={{ color: "#10b981" }}>{presentCount}</strong> / {totalCount}</span>
            </div>

            {/* Summary KPI Cards Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "12px", margin: "20px 0" }}>
                <div style={{ background: "#ffffff", padding: "14px 16px", borderRadius: "14px", border: "1px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
                    <span style={{ fontSize: "0.72rem", fontWeight: 750, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>Total Roster</span>
                    <div style={{ fontSize: "1.55rem", fontWeight: 800, color: "#0f172a", marginTop: "4px" }}>{totalCount}</div>
                </div>
                <div style={{ background: "#ffffff", padding: "14px 16px", borderRadius: "14px", border: "1px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
                    <span style={{ fontSize: "0.72rem", fontWeight: 750, color: "#059669", textTransform: "uppercase", letterSpacing: "0.04em" }}>Present (Submitted)</span>
                    <div style={{ fontSize: "1.55rem", fontWeight: 800, color: "#059669", marginTop: "4px" }}>{presentCount}</div>
                </div>
                <div style={{ background: "#ffffff", padding: "14px 16px", borderRadius: "14px", border: "1px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
                    <span style={{ fontSize: "0.72rem", fontWeight: 750, color: "#d97706", textTransform: "uppercase", letterSpacing: "0.04em" }}>Pending QR 2 (In Kiosk)</span>
                    <div style={{ fontSize: "1.55rem", fontWeight: 800, color: "#d97706", marginTop: "4px" }}>{pendingCount}</div>
                </div>
                <div style={{ background: "#ffffff", padding: "14px 16px", borderRadius: "14px", border: "1px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
                    <span style={{ fontSize: "0.72rem", fontWeight: 750, color: "#dc2626", textTransform: "uppercase", letterSpacing: "0.04em" }}>Disqualified / Flagged</span>
                    <div style={{ fontSize: "1.55rem", fontWeight: 800, color: "#dc2626", marginTop: "4px" }}>{disqualifiedCount}</div>
                </div>
                <div style={{ background: "#ffffff", padding: "14px 16px", borderRadius: "14px", border: "1px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
                    <span style={{ fontSize: "0.72rem", fontWeight: 750, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>Absent (Not Scanned)</span>
                    <div style={{ fontSize: "1.55rem", fontWeight: 800, color: "#64748b", marginTop: "4px" }}>{absentCount}</div>
                </div>
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

            {/* Roster Filter Tabs & Search Bar */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", margin: "24px 0 16px" }}>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    {[
                        { key: "ALL", label: `All Members (${totalCount})` },
                        { key: "PRESENT", label: `Present (${presentCount})` },
                        { key: "PENDING", label: `Pending QR 2 (${pendingCount})` },
                        { key: "DISQUALIFIED", label: `Disqualified (${disqualifiedCount})` },
                        { key: "ABSENT", label: `Absent (${absentCount})` }
                    ].map((tab) => (
                        <button
                            key={tab.key}
                            type="button"
                            onClick={() => setRosterTab(tab.key)}
                            style={{
                                padding: "7px 14px",
                                borderRadius: "10px",
                                border: rosterTab === tab.key ? "1.5px solid #6366f1" : "1px solid #cbd5e1",
                                background: rosterTab === tab.key ? "#6366f1" : "#ffffff",
                                color: rosterTab === tab.key ? "#ffffff" : "#475569",
                                fontWeight: 750,
                                fontSize: "0.82rem",
                                cursor: "pointer",
                                transition: "all 0.15s ease",
                                boxShadow: rosterTab === tab.key ? "0 2px 8px rgba(99, 102, 241, 0.25)" : "none"
                            }}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                <input
                    type="text"
                    placeholder="Filter by roll number, name, or email..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    style={{
                        padding: "8px 14px",
                        borderRadius: "10px",
                        border: "1.5px solid #cbd5e1",
                        fontSize: "0.85rem",
                        minWidth: "260px",
                        outline: "none"
                    }}
                />
            </div>

            {/* Roster Table */}
            {filteredMembers.length === 0 ? (
                <div className="classes-empty-card">
                    <div className="classes-empty-icon">👥</div>
                    <h3>No Students Found</h3>
                    <p>
                        {allMembersList.length === 0
                            ? "No students have scanned QR or enrolled in this course yet."
                            : "No students matching the selected filter."}
                    </p>
                </div>
            ) : (
                <div className="attendance-table-scroll">
                    <table id="session-attendance-table">
                        <thead>
                            <tr>
                                <th className="sortable-th" onClick={() => requestSort("rollNo")} title="Click to sort by Roll Number">
                                    Roll Number <SortIcon sortConfig={sortConfig} columnKey="rollNo" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("name")} title="Click to sort by Name">
                                    Name <SortIcon sortConfig={sortConfig} columnKey="name" />
                                </th>
                                <th className="sortable-th" onClick={() => requestSort("status")} title="Click to sort by Status">
                                    Verification &amp; Status <SortIcon sortConfig={sortConfig} columnKey="status" />
                                </th>
                                <th>Class Code</th>
                                <th>Room No</th>
                                <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Time">
                                    Date &amp; Time <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                                </th>
                                <th>Device / Platform</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedMembers.map((member) => {
                                const memberTime = member.submittedAt || member.scannedAt;
                                const dt = memberTime ? formatSessionDateTime(memberTime) : sessionDateTime;
                                return (
                                    <tr
                                        key={member.rollNo}
                                        onClick={() => setSelectedStudentForModal({
                                            id: member.id || member.rollNo,
                                            rollNo: member.rollNo,
                                            name: member.name,
                                            email: member.email,
                                            department: member.department,
                                            batch: member.batch
                                        })}
                                        style={{ cursor: "pointer" }}
                                        title="Click to view student profile & attendance history"
                                    >
                                        <td><strong>{member.rollNo}</strong></td>
                                        <td>{member.name}</td>
                                        <td>
                                            {(member.status === "PRESENT" || member.status === "EXCUSED" || member.excused) ? (
                                                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                    {(member.excused || member.status === "EXCUSED") ? (
                                                        <span style={{ color: "#d97706", fontWeight: 750, fontSize: "0.82rem" }}>
                                                            ✅ Excused (Present)
                                                        </span>
                                                    ) : member.faceVerified ? (
                                                        <span style={{ color: "#10b981", fontWeight: 750, fontSize: "0.82rem" }}>
                                                            ✅ Face Verified
                                                        </span>
                                                    ) : (
                                                        <span style={{ color: "#6366f1", fontWeight: 750, fontSize: "0.82rem" }}>
                                                            📱 QR Verified
                                                        </span>
                                                    )}
                                                </div>
                                            ) : member.status === "PENDING_QR2" ? (
                                                <span style={{
                                                    background: "#fef3c7",
                                                    color: "#b45309",
                                                    border: "1px solid #fde68a",
                                                    padding: "3px 8px",
                                                    borderRadius: "6px",
                                                    fontWeight: 750,
                                                    fontSize: "0.78rem",
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: "4px"
                                                }}>
                                                    <FaClock /> Pending QR 2 (In Kiosk)
                                                </span>
                                            ) : member.status === "DISQUALIFIED" ? (
                                                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                    <span style={{
                                                        background: "#fee2e2",
                                                        color: "#b91c1c",
                                                        border: "1px solid #fca5a5",
                                                        padding: "3px 8px",
                                                        borderRadius: "6px",
                                                        fontWeight: 750,
                                                        fontSize: "0.78rem",
                                                        display: "inline-flex",
                                                        alignItems: "center",
                                                        gap: "4px"
                                                    }}>
                                                        <FaExclamationTriangle /> Disqualified (App Switch)
                                                    </span>
                                                    {member.violationReason && (
                                                        <span style={{ fontSize: "0.72rem", color: "#9f1239" }}>
                                                            {member.violationReason}
                                                        </span>
                                                    )}
                                                </div>
                                            ) : member.status === "FLAGGED" ? (
                                                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                    <span style={{
                                                        background: "#ffedd5",
                                                        color: "#c2410c",
                                                        border: "1px solid #fed7aa",
                                                        padding: "3px 8px",
                                                        borderRadius: "6px",
                                                        fontWeight: 750,
                                                        fontSize: "0.78rem",
                                                        display: "inline-flex",
                                                        alignItems: "center",
                                                        gap: "4px"
                                                    }}>
                                                        <FaExclamationTriangle /> Flagged Warning (1/2)
                                                    </span>
                                                    {member.violationReason && (
                                                        <span style={{ fontSize: "0.72rem", color: "#c2410c" }}>
                                                            {member.violationReason}
                                                        </span>
                                                    )}
                                                </div>
                                            ) : (
                                                <span style={{
                                                    background: "#f1f5f9",
                                                    color: "#64748b",
                                                    border: "1px solid #cbd5e1",
                                                    padding: "3px 8px",
                                                    borderRadius: "6px",
                                                    fontWeight: 700,
                                                    fontSize: "0.78rem",
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: "4px"
                                                }}>
                                                    <FaTimes /> Absent (Not Scanned)
                                                </span>
                                            )}
                                        </td>
                                        <td>{session.classCode}</td>
                                        <td>{session.roomNo || "N/A"}</td>
                                        <td>
                                            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                <span>{dt.dateStr}</span>
                                                <span style={{ fontSize: "0.76rem", color: "#64748b" }}>{memberTime ? dt.timeStr : "—"}</span>
                                            </div>
                                        </td>
                                        <td>
                                            {member.deviceType ? (
                                                <span style={{
                                                    fontSize: "0.76rem",
                                                    fontWeight: 700,
                                                    color: member.deviceType === "android" ? "#059669" : member.deviceType === "ios" ? "#0284c7" : "#64748b"
                                                }}>
                                                    {member.deviceType === "android" ? "🤖 Android APK" : member.deviceType === "ios" ? "🍎 iPhone iOS" : member.deviceType}
                                                </span>
                                            ) : (
                                                <span style={{ fontSize: "0.74rem", color: "#94a3b8" }}>—</span>
                                            )}
                                        </td>
                                        <td onClick={(e) => e.stopPropagation()}>
                                            {isSessionOwner ? (
                                                (member.status === "PRESENT" || member.status === "EXCUSED" || member.excused) ? (
                                                    <button
                                                        type="button"
                                                        className="remove-session-btn"
                                                        style={{ margin: 0, padding: "5px 10px", fontSize: "0.78rem" }}
                                                        onClick={() => removeRecord(member)}
                                                        title="Remove student attendance record"
                                                    >
                                                        Remove
                                                    </button>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        style={{
                                                            margin: 0,
                                                            padding: "5px 12px",
                                                            fontSize: "0.78rem",
                                                            borderRadius: "8px",
                                                            border: "none",
                                                            background: "#10b981",
                                                            color: "#ffffff",
                                                            fontWeight: 750,
                                                            cursor: "pointer",
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "4px",
                                                            boxShadow: "0 2px 6px rgba(16, 185, 129, 0.25)"
                                                        }}
                                                        onClick={() => handleExcuseStudentFromSession(member.rollNo, "Manually verified & excused by lecturer in classroom")}
                                                        title="Pardon / Excuse student and mark Present"
                                                    >
                                                        <FaCheck /> ➕ Excuse / Reinstate
                                                    </button>
                                                )
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
            {pendingFaceExcuse && (
                <ExcuseFaceVerification
                    student={pendingFaceExcuse.student}
                    onCancel={() => setPendingFaceExcuse(null)}
                    onVerified={() => {
                        const pending = pendingFaceExcuse;
                        setPendingFaceExcuse(null);
                        void handleExcuseStudentFromSession(pending.student, pending.reason, true);
                    }}
                />
            )}
        </div>
    );
}

export default ClassesData;
