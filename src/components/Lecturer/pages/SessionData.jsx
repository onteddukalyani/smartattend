import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, query, setDoc, where, writeBatch } from "firebase/firestore";
import { useNavigate, useParams, Link } from "react-router-dom";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import { buildUserLookupMaps, normalizeSessions, doesSessionBelongToLecturer } from "../../Common/sessionMatcher";
import { FiSearch, FiPlusCircle, FiUsers, FiLayers } from "react-icons/fi";
import { FaCheckCircle, FaQrcode, FaClock, FaTrashAlt } from "react-icons/fa";
import StudentDetailModal from "../../Common/StudentDetailModal";
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
    const [allSessionsList, setAllSessionsList] = useState([]);
    const [lookupMaps, setLookupMaps] = useState({});
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState("my"); // "my" | "all"
    const [searchTerm, setSearchTerm] = useState("");
    const navigate = useNavigate();

    const isCurrentAdminPath = window.location.pathname.startsWith("/admin");
    const isCurrentLecturerPath = window.location.pathname.startsWith("/lecturer");

    const isAdmin = isCurrentAdminPath || (!isCurrentLecturerPath && (
        profile?.role === "admin" || 
        profile?.role === "administrator" || 
        profile?.role === "superadmin"
    ));

    const basePath = isCurrentAdminPath ? "/admin/classes" : "/lecturer/attendance-sessions";
    const createSessionPath = isCurrentAdminPath ? "/admin/classes" : "/lecturer/lecturerpage";

    // Setup real-time listener for attendance_sessions and enrich metadata
    useEffect(() => {
        let unsubscribeSessions = () => {};

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
                            setDoc(doc(db, "attendance_sessions", sess.id), { batch: resolvedBatch }, { merge: true }).catch(() => {});
                        }

                        return {
                            ...sess,
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

    const removeSession = async (event, session) => {
        event.stopPropagation();
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

    // Filter sessions based on role, tab, and search query
    const currentLecturerObj = {
        uid: user?.uid || "",
        email: user?.email || profile?.email || "",
        name: profile?.name || user?.displayName || "",
        role: profile?.role || "lecturer"
    };

    const mySessions = allSessionsList.filter((sess) => 
        doesSessionBelongToLecturer(sess, currentLecturerObj, lookupMaps, allSessionsList.length <= 1 ? 1 : 100)
    );

    // If user is admin, they always see all sessions; if lecturer, depends on activeTab
    const tabSessions = (isAdmin || activeTab === "all") ? allSessionsList : (mySessions.length === 0 && allSessionsList.length > 0 ? allSessionsList : mySessions);

    const filteredSessions = tabSessions.filter((sess) => {
        if (!searchTerm.trim()) return true;
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
    });

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
            <div className="classes-header-bar">
                <div>
                    <h2>Attendance Sessions</h2>
                    <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-muted, #64748b)" }}>
                        View live and past lecture attendance sessions recorded via QR check-ins.
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

            {/* Search Filter Bar */}
            {allSessionsList.length > 0 && (
                <div className="classes-search-wrapper">
                    <FiSearch className="classes-search-icon" />
                    <input
                        type="text"
                        className="classes-search-input"
                        placeholder="Search by class, course, batch, room, faculty..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
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
                        {searchTerm ? `No sessions match "${searchTerm}". Try adjusting your search query.` : activeTab === "my" ? "You haven't generated any attendance sessions under this account yet. Click below to view all institution sessions or generate a new QR." : "No sessions found in this view."}
                    </p>
                    {activeTab === "my" && (
                        <button
                            type="button"
                            className="classes-tab active"
                            style={{ margin: "0 auto 12px" }}
                            onClick={() => setActiveTab("all")}
                        >
                            View All Institution Sessions ({allSessionsList.length})
                        </button>
                    )}
                    {!isAdmin && (
                        <div>
                            <Link to="/lecturer/lecturerpage" className="classes-new-session-btn" style={{ display: "inline-flex", margin: "0 auto" }}>
                                <FiPlusCircle /> Generate QR Code Now
                            </Link>
                        </div>
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
                                return (
                                    <tr key={session.id} onClick={() => navigate(`${basePath}/${session.id}`)}>
                                        <td><strong>{session.classCode || "N/A"}</strong></td>
                                        <td>{session.batch || "—"}</td>
                                        <td>{session.courseCode || "N/A"}</td>
                                        {(isAdmin || activeTab === "all") && <td>{session.lecturerName || "Faculty"}</td>}
                                        <td>{session.roomNo || "N/A"}</td>
                                        <td>{session.createdAt ? new Date(session.createdAt).toLocaleDateString() : "N/A"}</td>
                                        <td>{session.createdAt ? new Date(session.createdAt).toLocaleTimeString() : "N/A"}</td>
                                        <td>
                                            <button
                                                type="button"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    navigate(`${basePath}/${session.id}`);
                                                }}
                                            >
                                                View Attendance
                                            </button>
                                            <button
                                                type="button"
                                                className="remove-session-btn"
                                                onClick={(event) => removeSession(event, session)}
                                            >
                                                Remove
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
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

    const removeRecord = async (record) => {
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

    useEffect(() => {
        let isMounted = true;
        let unsubscribeRecords = () => {};

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

                    let rawRecords = recordsSnapshot.docs
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

                    // Fallback to embedded attendees array if collection query returned 0
                    if (rawRecords.length === 0 && Array.isArray(sessData?.attendees)) {
                        rawRecords = sessData.attendees.map((att, idx) => ({
                            id: att.id || `${actualSessionId}_${att.rollNo || idx}`,
                            sessionId: actualSessionId,
                            rollNo: att.rollNo || att.roll || att.studentId || "—",
                            fullName: att.fullName || att.name || att.studentName || "Student",
                            studentEmail: att.studentEmail || att.email || "",
                            submittedAt: att.submittedAt || att.timestamp || att.time || sessData.createdAt,
                            faceVerified: att.faceVerified ?? true
                        }));
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

    return (
        <div className="attendance-data-page">
            <div className="session-actions-bar">
                <button className="back-to-sessions-btn" onClick={() => navigate(basePath)}>⬅️ Back to Sessions</button>
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
                <span className="session-summary-item"><strong>Room:</strong> {session.roomNo || "N/A"}</span>
                <span className="session-summary-item"><strong>Session Date:</strong> {sessionDateTime.dateStr}</span>
                <span className="session-summary-item"><strong>Total Students Present:</strong> <strong style={{ color: "#10b981" }}>{records.length}</strong></span>
            </div>
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
                                <th>Verification</th>
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
                                            {record.faceVerified ? (
                                                <span style={{ color: "#10b981", fontWeight: 700, fontSize: "0.82rem" }}>✅ Face Verified</span>
                                            ) : (
                                                <span style={{ color: "#6366f1", fontWeight: 700, fontSize: "0.82rem" }}>📱 QR Verified</span>
                                            )}
                                        </td>
                                        <td onClick={(e) => e.stopPropagation()}>
                                            <button
                                                type="button"
                                                className="remove-session-btn"
                                                style={{ margin: 0, padding: "6px 12px", fontSize: "0.82rem" }}
                                                onClick={() => removeRecord(record)}
                                            >
                                                Remove
                                            </button>
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
                    onUpdate={() => {}}
                />
            )}
        </div>
    );
}

export default ClassesData;

