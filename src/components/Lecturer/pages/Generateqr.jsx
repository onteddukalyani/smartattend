import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../../firebase";
import { createAttendanceSession } from "./CreateSession";
import { transitionSessionToPhase2, subscribeToSession, subscribeToAuthorizations } from "../../../services/sessionAuthService";
import { useAuth } from "../../authcontext";
import { isCourseAssignedToLecturer } from "./LecturerCourses";
import {
    FaQrcode,
    FaBookOpen,
    FaLayerGroup,
    FaCalendarAlt,
    FaDoorOpen,
    FaClock,
    FaCheckCircle,
    FaUsers,
    FaCopy,
    FaCheck,
    FaArrowRight,
    FaSyncAlt,
    FaShieldAlt,
    FaExclamationTriangle,
    FaLock,
    FaUserCheck,
    FaCheckDouble
} from "react-icons/fa";
import "./Generateqr.css";

function GenerateQR() {
    const { user, profile } = useAuth();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    // Form inputs
    const [roomNo, setRoomNo] = useState(searchParams.get("roomNo") || "");
    const [courseCode, setCourseCode] = useState(searchParams.get("courseCode") || "");
    const [classCode, setClassCode] = useState(searchParams.get("classCode") || "");
    const [batch, setBatch] = useState(searchParams.get("batch") || "2025");
    const [availableCourses, setAvailableCourses] = useState([]);

    // Authoritative 2-Phase Session State (0:00 -> 1:00 -> 2:00)
    const [sessionId, setSessionId] = useState("");
    const [phase, setPhase] = useState("NONE"); // "NONE" | "PHASE_1" | "PHASE_2" | "CLOSED"
    const [qr1Token, setQr1Token] = useState("");
    const [qr2Token, setQr2Token] = useState("");
    const [sessionStartAt, setSessionStartAt] = useState(0);
    const [qr1ExpiresAt, setQr1ExpiresAt] = useState(0);
    const [kioskEndsAt, setKioskEndsAt] = useState(0);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    const [sessionData, setSessionData] = useState(null);
    const [authorizedStudents, setAuthorizedStudents] = useState([]);

    // UI State
    const [isGenerating, setIsGenerating] = useState(false);
    const [isTransitioning, setIsTransitioning] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const [copied, setCopied] = useState(false);

    const timerRef = useRef(null);

    // 1. Load available courses from Firestore
    useEffect(() => {
        getDocs(collection(db, "courses"))
            .then((snap) => {
                const list = snap.docs.map((d) => ({
                    id: d.id,
                    ...d.data()
                }));
                list.sort((a, b) => (a.courseCode || "").localeCompare(b.courseCode || ""));
                setAvailableCourses(list);

                if (courseCode) {
                    const matched = list.find((c) => (c.courseCode || "").toUpperCase() === courseCode.toUpperCase());
                    if (matched) {
                        if (matched.defaultRoom && !roomNo) setRoomNo(matched.defaultRoom);
                        if (matched.department && !classCode) setClassCode(matched.department);
                        if (matched.batch && (!batch || batch === "2025")) setBatch(matched.batch);
                    }
                }
            })
            .catch((err) => console.warn("Could not load courses for QR page:", err));
    }, []);

    const myCourses = useMemo(() => {
        return availableCourses.filter((c) => isCourseAssignedToLecturer(c, user, profile));
    }, [availableCourses, user, profile]);

    const otherCourses = useMemo(() => {
        return availableCourses.filter((c) => !myCourses.some((m) => m.id === c.id));
    }, [availableCourses, myCourses]);

    // 2. Real-time Subscriptions to Session & Authorized Students
    useEffect(() => {
        if (!sessionId) return;

        const unsubSession = subscribeToSession(sessionId, (data) => {
            setSessionData(data);
        });

        const unsubAuths = subscribeToAuthorizations(sessionId, (authList) => {
            setAuthorizedStudents(authList);
        });

        return () => {
            unsubSession();
            unsubAuths();
        };
    }, [sessionId]);

    // 3. Authoritative Session Timeline Engine (0:00 to 2:00)
    useEffect(() => {
        if (!sessionStartAt || !kioskEndsAt) {
            if (timerRef.current) clearInterval(timerRef.current);
            return;
        }

        const updateTimeline = () => {
            const now = Date.now();
            const elapsed = Math.floor((now - sessionStartAt) / 1000);
            setElapsedSeconds(elapsed);

            if (now < qr1ExpiresAt) {
                setPhase("PHASE_1");
            } else if (now >= qr1ExpiresAt && now < kioskEndsAt) {
                setPhase("PHASE_2");
            } else {
                setPhase("CLOSED");
                if (timerRef.current) clearInterval(timerRef.current);
            }
        };

        updateTimeline();
        timerRef.current = setInterval(updateTimeline, 1000);

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [sessionStartAt, qr1ExpiresAt, kioskEndsAt]);

    const handleSelectCourse = (code) => {
        setCourseCode(code);
        const matched = availableCourses.find((c) => (c.courseCode || "").toUpperCase() === code.toUpperCase());
        if (matched) {
            if (matched.defaultRoom && !roomNo) setRoomNo(matched.defaultRoom);
            if (matched.department && !classCode) setClassCode(matched.department);
            if (matched.batch) setBatch(matched.batch);
        }
    };

    const handleCourseCodeChange = (e) => {
        const val = e.target.value;
        setCourseCode(val);
        const matched = availableCourses.find((c) => (c.courseCode || "").toUpperCase() === val.trim().toUpperCase());
        if (matched) {
            if (matched.defaultRoom && !roomNo) setRoomNo(matched.defaultRoom);
            if (matched.department && !classCode) setClassCode(matched.department);
            if (matched.batch) setBatch(matched.batch);
        }
    };

    // 4. Start 2-Minute Authoritative Session
    const handleGenerateSession = async () => {
        if (!classCode || !roomNo.trim()) {
            alert("Please select a class and enter room number.");
            return;
        }
        if (!courseCode.trim()) {
            alert("Please enter Course Code.");
            return;
        }
        setIsGenerating(true);
        setErrorMessage("");

        try {
            const rawDept = profile?.department || profile?.branch;
            const lecturerInfo = {
                name: profile?.name || user?.displayName || (user?.email ? user.email.split("@")[0] : "Lecturer"),
                email: user?.email || "",
                department: (rawDept && String(rawDept).toLowerCase() !== "general") ? rawDept : "CSE"
            };
            const finalBatch = (batch && batch.trim() !== "") ? batch.trim() : "2025";

            const result = await createAttendanceSession(classCode, courseCode.trim(), roomNo.trim(), finalBatch, lecturerInfo);

            setSessionId(result.sessionId);
            setQr1Token(result.qr1Token);
            setQr2Token(result.qr2Token);
            setSessionStartAt(result.sessionStartAt);
            setQr1ExpiresAt(result.qr1ExpiresAt);
            setKioskEndsAt(result.kioskEndsAt);
            setPhase("PHASE_1");
            setElapsedSeconds(0);
        } catch (error) {
            console.error("Error creating attendance session:", error);
            setErrorMessage(error.message || "Could not create attendance session.");
        } finally {
            setIsGenerating(false);
        }
    };

    // 5. Early Transition to Phase 2 (Optional shortcut before 60s)
    const handleForcePhase2 = async () => {
        if (!sessionId) return;
        setIsTransitioning(true);
        try {
            await transitionSessionToPhase2(sessionId);
            setPhase("PHASE_2");
        } catch (error) {
            console.warn("Notice transitioning early:", error);
            setPhase("PHASE_2");
        } finally {
            setIsTransitioning(false);
        }
    };

    // Construct Active QR URL based on current phase
    const activeQrUrl = useMemo(() => {
        if (!sessionId) return "";
        if (phase === "PHASE_1" && qr1Token) {
            return `${window.location.origin}/student/mark-attendance?session=${encodeURIComponent(sessionId)}&qr1Token=${encodeURIComponent(qr1Token)}&phase=1`;
        }
        if (phase === "PHASE_2" && qr2Token) {
            return `${window.location.origin}/student/mark-attendance?session=${encodeURIComponent(sessionId)}&qr2Token=${encodeURIComponent(qr2Token)}&phase=2`;
        }
        return `${window.location.origin}/student/mark-attendance?session=${encodeURIComponent(sessionId)}`;
    }, [sessionId, phase, qr1Token, qr2Token]);

    const handleCopyLink = () => {
        if (!activeQrUrl) return;
        navigator.clipboard.writeText(activeQrUrl).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const handleResetSession = () => {
        if (window.confirm("Start a new attendance session? Current session will be closed.")) {
            setSessionId("");
            setPhase("NONE");
            setQr1Token("");
            setQr2Token("");
            setSessionStartAt(0);
            setQr1ExpiresAt(0);
            setKioskEndsAt(0);
            setSessionData(null);
            setAuthorizedStudents([]);
        }
    };

    // Formatting helper for mm:ss
    const formatMmSs = (sec) => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${String(s).padStart(2, "0")}`;
    };

    const qr1Remaining = Math.max(0, 60 - elapsedSeconds);
    const sessionRemaining = Math.max(0, 180 - elapsedSeconds);

    return (
        <div className="qrpage">
            {/* Header */}
            <div className="qrpage-header">
                <div className="qrpage-header-badge">
                    <FaShieldAlt /> 3-Minute Authoritative Session Timeline
                </div>
                <h1>Generate Attendance QR</h1>
                <p>
                    <strong>0:00–1:00 (QR 1, 1 min):</strong> Student Device Check-in &amp; Kiosk Lock <br></br> &bull; <strong>1:00–3:00 (QR 2, 2 min):</strong> Biometric Attendance <br></br> &bull; <strong>3:00:</strong> Kiosks End
                </p>
            </div>

            <div className="qrpage-layout">
                {/* 1. Session Setup Builder */}
                <section className="qr-builder">
                    <div className="qr-section-heading">
                        <span className="qr-step">01</span>
                        <div>
                            <h2>Class &amp; Session Details</h2>
                            <p>Specify course, department, and classroom room.</p>
                        </div>
                    </div>

                    {availableCourses.length > 0 && (
                        <div className="qr-form-group">
                            <label htmlFor="course-select">
                                <FaBookOpen /> Quick Pick Registered Course
                            </label>
                            <select
                                id="course-select"
                                value={courseCode}
                                onChange={(e) => handleSelectCourse(e.target.value)}
                                className="qr-select-styled"
                                disabled={phase !== "NONE"}
                            >
                                <option value="">-- Choose Course or Type Below --</option>
                                {myCourses.length > 0 && (
                                    <optgroup label="🌟 My Assigned Courses">
                                        {myCourses.map((c) => (
                                            <option key={c.id} value={c.courseCode}>
                                                {c.courseCode} - {c.courseName} ({c.department})
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                                {otherCourses.length > 0 && (
                                    <optgroup label="📚 All Other Courses">
                                        {otherCourses.map((c) => (
                                            <option key={c.id} value={c.courseCode}>
                                                {c.courseCode} - {c.courseName} ({c.department})
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                            </select>
                        </div>
                    )}

                    <div className="qr-form-group">
                        <label htmlFor="course-code">
                            <FaBookOpen /> Course Code *
                        </label>
                        <input
                            id="course-code"
                            type="text"
                            value={courseCode}
                            onChange={handleCourseCodeChange}
                            placeholder="e.g. CS171, CS301"
                            required
                            disabled={phase !== "NONE"}
                        />
                    </div>

                    <div className="qr-form-row">
                        <div className="qr-form-group">
                            <label htmlFor="class-code">
                                <FaLayerGroup /> Department *
                            </label>
                            <select
                                id="class-code"
                                value={classCode}
                                onChange={(e) => setClassCode(e.target.value)}
                                disabled={phase !== "NONE"}
                            >
                                <option value="">Select Class</option>
                                <option value="CSE">CSE</option>
                                <option value="CSE-A">CSE-A</option>
                                <option value="CSE-B">CSE-B</option>
                                <option value="DSAI">DSAI</option>
                                <option value="ECE">ECE</option>
                                <option value="AIC">AIC</option>
                            </select>
                        </div>

                        <div className="qr-form-group">
                            <label htmlFor="batch-year">
                                <FaCalendarAlt /> Batch
                            </label>
                            <select
                                id="batch-year"
                                value={batch}
                                onChange={(e) => setBatch(e.target.value)}
                                disabled={phase !== "NONE"}
                            >
                                <option value="2023">2023</option>
                                <option value="2024">2024</option>
                                <option value="2025">2025</option>
                                <option value="2026">2026</option>
                            </select>
                        </div>
                    </div>

                    <div className="qr-form-group">
                        <label htmlFor="room-number">
                            <FaDoorOpen /> Room Number *
                        </label>
                        <input
                            id="room-number"
                            type="text"
                            value={roomNo}
                            onChange={(e) => setRoomNo(e.target.value)}
                            placeholder="e.g. C002, C003"
                            required
                            disabled={phase !== "NONE"}
                        />
                    </div>

                    {phase === "NONE" ? (
                        <button
                            type="button"
                            onClick={handleGenerateSession}
                            className="genqr-btn"
                            disabled={isGenerating}
                        >
                            <span>{isGenerating ? "Initializing Timeline..." : "Start 3-Minute Attendance Session"}</span>
                            {!isGenerating ? <FaArrowRight /> : <FaSyncAlt className="fa-spin" />}
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={handleResetSession}
                            style={{
                                marginTop: "12px",
                                padding: "12px",
                                background: "var(--surface-soft, #f1f5f9)",
                                border: "1.5px solid var(--border, #cbd5e1)",
                                borderRadius: "12px",
                                color: "var(--text-muted, #64748b)",
                                fontWeight: 700,
                                cursor: "pointer"
                            }}
                        >
                            🔄 Reset / Start New Session
                        </button>
                    )}

                    {errorMessage && <p className="qr-error" role="alert">{errorMessage}</p>}
                </section>

                {/* 2. QR Code Display & Authoritative 3-Minute Session Timeline */}
                <section className={`qr-result ${sessionId ? "qr-result-ready" : ""}`}>
                    {sessionId ? (
                        <>
                            {/* Authoritative Timeline Bar */}
                            <div style={{
                                width: "100%",
                                marginBottom: "16px",
                                padding: "12px 16px",
                                borderRadius: "14px",
                                background: "var(--surface-soft, #f8fafc)",
                                border: "1.5px solid var(--border, #e2e8f0)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between"
                            }}>
                                <div style={{ textAlign: "left" }}>
                                    <div style={{ fontSize: "0.74rem", fontWeight: 800, color: "var(--text-muted, #64748b)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                        Authoritative Session Clock
                                    </div>
                                    <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#6366f1", marginTop: "2px" }}>
                                        {formatMmSs(elapsedSeconds)} / 3:00
                                    </div>
                                </div>

                                <div style={{ textAlign: "right" }}>
                                    <span style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "6px",
                                        padding: "6px 12px",
                                        borderRadius: "999px",
                                        fontSize: "0.8rem",
                                        fontWeight: 800,
                                        background: phase === "PHASE_1" ? "rgba(99, 102, 241, 0.15)" : phase === "PHASE_2" ? "rgba(16, 185, 129, 0.15)" : "#fee2e2",
                                        color: phase === "PHASE_1" ? "#6366f1" : phase === "PHASE_2" ? "#10b981" : "#b91c1c"
                                    }}>
                                        {phase === "PHASE_1" ? "⚡ Phase 1: 0:00-1:00 (QR 1, 1m)" : phase === "PHASE_2" ? "🎯 Phase 2: 1:00-3:00 (QR 2, 2m)" : "🔒 Session Closed (T=180s)"}
                                    </span>
                                </div>
                            </div>

                            {/* Session Header */}
                            <div className="qr-result-heading">
                                <span className="qr-status-dot" style={{ background: phase === "PHASE_1" ? "#6366f1" : phase === "PHASE_2" ? "#10b981" : "#94a3b8" }} />
                                <div className="child-qr-result-heading">
                                    <p className="qrpage-kicker" style={{ color: phase === "PHASE_1" ? "#6366f1" : phase === "PHASE_2" ? "#10b981" : "#64748b" }}>
                                        {phase === "PHASE_1" ? "QR 1: CLASSROOM CHECK-IN & KIOSK START" : phase === "PHASE_2" ? "QR 2: BIOMETRIC ATTENDANCE" : "SESSION COMPLETE"}
                                    </p>
                                    <h2>{courseCode} · {classCode}{batch ? ` (${batch})` : ""} · {roomNo}</h2>
                                </div>
                            </div>

                            {/* QR Canvas Frame */}
                            {phase !== "CLOSED" ? (
                                <div className="qr-code-frame" style={{ borderColor: phase === "PHASE_1" ? "#6366f1" : "#10b981" }}>
                                    <QRCodeCanvas value={activeQrUrl} size={270} />
                                </div>
                            ) : (
                                <div style={{
                                    padding: "30px 20px",
                                    borderRadius: "16px",
                                    background: "#f1f5f9",
                                    border: "2px dashed #cbd5e1",
                                    margin: "12px 0 20px",
                                    color: "#334155"
                                }}>
                                    <FaCheckDouble style={{ fontSize: "2.5rem", color: "#10b981", marginBottom: "10px" }} />
                                    <h3 style={{ margin: "0 0 6px", fontSize: "1.15rem", fontWeight: 800 }}>Attendance Session Completed</h3>
                                    <p style={{ margin: 0, fontSize: "0.86rem", color: "#64748b" }}>
                                        Fixed 2-minute deadline elapsed. All student devices have been unlocked from Kiosk mode.
                                    </p>
                                </div>
                            )}

                            {/* Phase 1 Status (0:00 to 1:00) */}
                            {phase === "PHASE_1" && (
                                <div style={{ width: "100%", margin: "6px 0 16px" }}>
                                    <div style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "8px",
                                        padding: "8px 18px",
                                        borderRadius: "999px",
                                        background: qr1Remaining > 15 ? "rgba(99, 102, 241, 0.12)" : "rgba(239, 68, 68, 0.12)",
                                        border: `1.5px solid ${qr1Remaining > 15 ? "#6366f1" : "#ef4444"}`,
                                        color: qr1Remaining > 15 ? "#6366f1" : "#ef4444",
                                        fontWeight: 800,
                                        fontSize: "0.95rem"
                                    }}>
                                        <FaClock />
                                        <span>QR 1 Auto-Switches in:</span>
                                        <strong>{qr1Remaining}s (at 1:00)</strong>
                                    </div>

                                    <div style={{
                                        marginTop: "12px",
                                        padding: "12px 16px",
                                        borderRadius: "12px",
                                        background: "var(--surface-soft, #f8fafc)",
                                        border: "1px solid var(--border, #e2e8f0)",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between"
                                    }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-main, #1e293b)", fontWeight: 700 }}>
                                            <FaUserCheck style={{ color: "#6366f1", fontSize: "1.2rem" }} />
                                            <span>Students Checked In &amp; Locked in Kiosk:</span>
                                        </div>
                                        <strong style={{ fontSize: "1.25rem", color: "#6366f1" }}>
                                            {authorizedStudents.length}
                                        </strong>
                                    </div>

                                    <button
                                        type="button"
                                        onClick={handleForcePhase2}
                                        disabled={isTransitioning}
                                        style={{
                                            marginTop: "14px",
                                            width: "100%",
                                            padding: "12px 18px",
                                            borderRadius: "12px",
                                            background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                                            color: "#ffffff",
                                            border: "none",
                                            fontWeight: 800,
                                            fontSize: "0.95rem",
                                            cursor: "pointer",
                                            boxShadow: "0 6px 18px rgba(16, 185, 129, 0.3)",
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            gap: "8px"
                                        }}
                                    >
                                        <span>⚡ Switch to QR 2 Early</span>
                                        <FaArrowRight />
                                    </button>
                                </div>
                            )}

                            {/* Phase 2 Status (1:00 to 3:00) */}
                            {phase === "PHASE_2" && (
                                <div style={{ width: "100%", margin: "6px 0 16px" }}>
                                    <div style={{
                                        padding: "10px 14px",
                                        borderRadius: "10px",
                                        background: "rgba(16, 185, 129, 0.1)",
                                        border: "1px solid rgba(16, 185, 129, 0.3)",
                                        color: "#065f46",
                                        fontSize: "0.85rem",
                                        fontWeight: 700,
                                        marginBottom: "12px"
                                    }}>
                                        🔒 Phase 2 Active: Only {authorizedStudents.length} students who checked in during 0:00–1:00 can submit attendance.
                                    </div>

                                    <div style={{
                                        padding: "12px 16px",
                                        borderRadius: "12px",
                                        background: "var(--surface-soft, #f8fafc)",
                                        border: "1px solid var(--border, #e2e8f0)",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                        marginBottom: "14px"
                                    }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-main, #1e293b)", fontWeight: 700 }}>
                                            <FaCheckCircle style={{ color: "#10b981", fontSize: "1.2rem" }} />
                                            <span>Attendance Recorded:</span>
                                        </div>
                                        <strong style={{ fontSize: "1.25rem", color: "#10b981" }}>
                                             {sessionData?.attendanceCount || 0} / {authorizedStudents.length}
                                        </strong>
                                    </div>

                                    <div style={{
                                        fontSize: "0.82rem",
                                        color: "var(--text-muted, #64748b)",
                                        marginBottom: "14px",
                                        fontWeight: 600
                                    }}>
                                        ⏱️ All student devices unlock automatically at <strong>3:00 ({sessionRemaining}s remaining)</strong>.
                                    </div>

                                    <div className="qr-active-shortcuts">
                                        <Link
                                            to={`/lecturer/attendance-sessions/${sessionId}`}
                                            className="qr-view-live-btn"
                                        >
                                            <FaUsers /> View Live Attendance Register
                                        </Link>
                                    </div>
                                </div>
                            )}

                            {/* Session Finished Status (T >= 3:00) */}
                            {phase === "CLOSED" && (
                                <div style={{ width: "100%", margin: "8px 0 16px" }}>
                                    <div style={{
                                        padding: "12px 16px",
                                        borderRadius: "12px",
                                        background: "#dcfce7",
                                        border: "1px solid #86efac",
                                        color: "#166534",
                                        fontWeight: 800,
                                        fontSize: "0.95rem",
                                        marginBottom: "14px"
                                    }}>
                                        ✅ Total Present: {sessionData?.attendanceCount || 0} / {authorizedStudents.length} Students
                                    </div>

                                    <div className="qr-active-shortcuts">
                                        <Link
                                            to={`/lecturer/attendance-sessions/${sessionId}`}
                                            className="qr-view-live-btn"
                                        >
                                            <FaUsers /> Open Final Attendance Register
                                        </Link>
                                    </div>
                                </div>
                            )}

                            {phase !== "CLOSED" && (
                                <div className="qr-live-pill-group">
                                    <button
                                        type="button"
                                        onClick={handleCopyLink}
                                        className="qr-copy-btn"
                                        title="Copy active QR URL"
                                    >
                                        {copied ? <><FaCheck /> Copied!</> : <><FaCopy /> Copy Link</>}
                                    </button>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="qr-empty-state">
                            <div className="qr-empty-mark">
                                <FaQrcode />
                            </div>
                            <h2>Your 2-Phase QR Session Will Appear Here</h2>
                            <p>Select a course code, department and room, then click generate.</p>
                            <div className="qr-empty-hint">
                                <span>⚡ 0:00–1:00 Check-in (1m) &bull; 1:00–3:00 Biometrics (2m)</span>
                            </div>
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}

export default GenerateQR;