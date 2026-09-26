import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../../firebase";
import { createAttendanceSession } from "./CreateSession";
import {
    transitionSessionToPhase2,
    subscribeToSession,
    subscribeToAuthorizations,
    closeAttendanceSession,
    releaseIndividualStudentDevice
} from "../../../services/sessionAuthService";
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
    FaUnlock,
    FaMobileAlt,
    FaSpinner,
    FaUserCheck,
    FaCheckDouble,
    FaEye,
    FaEyeSlash
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

    // Authoritative 2-Phase Session State (0:00 -> 1:00 -> 3:00)
    const [sessionId, setSessionId] = useState("");
    const [sessionPin, setSessionPin] = useState("");
    const [showPin, setShowPin] = useState(false);
    const [phase, setPhase] = useState("NONE"); // "NONE" | "PHASE_1" | "PHASE_2" | "CLOSED"
    const [qr1Token, setQr1Token] = useState("");
    const [qr2Token, setQr2Token] = useState("");
    const [sessionStartAt, setSessionStartAt] = useState(0);
    const [qr1ExpiresAt, setQr1ExpiresAt] = useState(0);
    const [kioskEndsAt, setKioskEndsAt] = useState(0);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    const [sessionData, setSessionData] = useState(null);
    const [authorizedStudents, setAuthorizedStudents] = useState([]);
    const [releasingStudentId, setReleasingStudentId] = useState(null);

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
            if (data.lecturerPin) {
                setSessionPin(data.lecturerPin);
            }
            if (data.phase === "PHASE_2" || data.phase === "CLOSED") {
                setPhase(data.phase);
            }
            if (data.qr1ExpiresAt) {
                const exp = typeof data.qr1ExpiresAt.toMillis === 'function' ? data.qr1ExpiresAt.toMillis() : data.qr1ExpiresAt;
                setQr1ExpiresAt(exp);
            }
            if (data.kioskEndsAt) {
                const end = typeof data.kioskEndsAt.toMillis === 'function' ? data.kioskEndsAt.toMillis() : data.kioskEndsAt;
                setKioskEndsAt(end);
            }
        });

        const unsubAuths = subscribeToAuthorizations(sessionId, (authList) => {
            setAuthorizedStudents(authList);
        });

        return () => {
            unsubSession();
            unsubAuths();
        };
    }, [sessionId]);

    // 3. Authoritative Session Timeline Engine (0:00 to 3:00)
    useEffect(() => {
        if (!sessionStartAt || !kioskEndsAt) {
            if (timerRef.current) clearInterval(timerRef.current);
            return;
        }

        const updateTimeline = () => {
            const now = Date.now();
            const elapsed = Math.floor((now - sessionStartAt) / 1000);
            setElapsedSeconds(elapsed);

            if (now >= kioskEndsAt) {
                setPhase("CLOSED");
                if (timerRef.current) clearInterval(timerRef.current);
                if (sessionId) {
                    closeAttendanceSession(sessionId).catch(() => {});
                }
            } else if (phase === "PHASE_2" || sessionData?.phase === "PHASE_2" || now >= qr1ExpiresAt) {
                setPhase("PHASE_2");
            } else {
                setPhase("PHASE_1");
            }
        };

        updateTimeline();
        timerRef.current = setInterval(updateTimeline, 1000);

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [sessionStartAt, qr1ExpiresAt, kioskEndsAt, phase, sessionData?.phase]);

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

    // 4. Start 3-Minute Authoritative Session
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
            if (result.sessionPin || result.lecturerPin || result.lecturerReleaseCode) {
                setSessionPin(result.sessionPin || result.lecturerPin || result.lecturerReleaseCode);
            }
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
            const now = Date.now();
            setQr1ExpiresAt(now);
            setPhase("PHASE_2");
            await transitionSessionToPhase2(sessionId);
        } catch (error) {
            console.warn("Notice transitioning early:", error);
            setPhase("PHASE_2");
        } finally {
            setIsTransitioning(false);
        }
    };

    // 6. Release Individual Student Device Remotely from Kiosk Lock Task Mode
    const handleReleaseIndividualStudent = async (student) => {
        const studentId = student.studentUid || student.id || student.rollNo;
        const rollNo = student.rollNo || studentId;
        const studentName = student.studentName || rollNo;

        if (!window.confirm(`Release ${studentName} (${rollNo}) from Kiosk Lock Task mode immediately using Session PIN?`)) {
            return;
        }

        setReleasingStudentId(studentId);
        try {
            await releaseIndividualStudentDevice(sessionId, student.studentUid || student.id, rollNo, sessionPin);
        } catch (err) {
            console.error("Error releasing student device:", err);
            alert("❌ Failed to release device: " + (err.message || err));
        } finally {
            setReleasingStudentId(null);
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

    const handleResetSession = async () => {
        if (window.confirm("Start a new attendance session? Current session will be closed.")) {
            if (sessionId) {
                await closeAttendanceSession(sessionId).catch(() => {});
            }
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
    // Deduplicated list of students (guarantees no student/device is shown twice or more)
    const uniqueStudentsList = useMemo(() => {
        if (!authorizedStudents || !Array.isArray(authorizedStudents)) return [];
        const map = new Map();

        authorizedStudents.forEach((st) => {
            const roll = (st.rollNo || st.studentUid || st.id || "").toUpperCase().trim();
            if (!roll) return;

            if (!map.has(roll)) {
                map.set(roll, {
                    ...st,
                    rollNo: roll,
                    studentName: st.studentName || st.fullName || roll,
                    studentUid: st.studentUid || st.id || roll
                });
            } else {
                const existing = map.get(roll);
                map.set(roll, {
                    ...existing,
                    ...st,
                    rollNo: roll,
                    studentName: st.studentName || existing.studentName || roll,
                    released: st.released === true || existing.released === true,
                    status: st.status || existing.status
                });
            }
        });

        return Array.from(map.values()).sort((a, b) => (a.rollNo || "").localeCompare(b.rollNo || ""));
    }, [authorizedStudents]);

    // Live Metrics: Total scanned QR 1, Reached QR 2 (Attended), and Pending QR 2
    const { totalScannedQR1, reachedQR2Count, pendingQR2Count } = useMemo(() => {
        const attendeesSet = new Set(
            (sessionData?.attendees || []).map((a) => (a.rollNo || a.studentUid || "").toUpperCase().trim())
        );

        let reachedQR2 = 0;
        let pendingQR2 = 0;

        uniqueStudentsList.forEach((st) => {
            const roll = (st.rollNo || "").toUpperCase().trim();
            const hasAttended = attendeesSet.has(roll) || st.status === "ATTENDED" || st.attended === true;
            if (hasAttended) {
                reachedQR2++;
            } else {
                pendingQR2++;
            }
        });

        return {
            totalScannedQR1: uniqueStudentsList.length,
            reachedQR2Count: reachedQR2,
            pendingQR2Count: pendingQR2
        };
    }, [uniqueStudentsList, sessionData?.attendees]);

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

                            {/* Lecturer Security PIN & Kiosk Remote Controller Bar */}
                            {phase !== "CLOSED" && (
                                <div className="qr-pin-bar">
                                    <div className="qr-pin-info">
                                        <FaLock style={{ color: "#6366f1" }} />
                                        <span>Session PIN:{" "}
                                            <strong className="qr-pin-value" style={{ 
                                                letterSpacing: showPin ? "2px" : "3px", 
                                                fontFamily: showPin ? "inherit" : "monospace"
                                            }}>
                                                {showPin ? (sessionPin || "------") : (sessionPin ? "••••••" : "------")}
                                            </strong>
                                        </span>
                                        {sessionPin && (
                                            <button
                                                type="button"
                                                onClick={() => setShowPin((prev) => !prev)}
                                                title={showPin ? "Hide PIN" : "View PIN"}
                                                className={`qr-pin-toggle-btn ${showPin ? "active" : ""}`}
                                            >
                                                {showPin ? <><FaEyeSlash /> Hide PIN</> : <><FaEye /> View PIN</>}
                                            </button>
                                        )}
                                        <span style={{ fontSize: "0.74rem", color: "var(--text-muted, #64748b)" }}>(Unlocks student devices)</span>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={async () => {
                                            if (window.confirm("End attendance session immediately and release all student devices from Kiosk mode?")) {
                                                await closeAttendanceSession(sessionId);
                                                setPhase("CLOSED");
                                            }
                                        }}
                                        className="qr-pin-end-btn"
                                    >
                                        🛑 End Session &amp; Release All
                                    </button>
                                </div>
                            )}

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
                                    background: "var(--surface-soft, #f1f5f9)",
                                    border: "2px dashed var(--border, #cbd5e1)",
                                    margin: "12px 0 20px",
                                    color: "var(--text-main, #334155)"
                                }}>
                                    <FaCheckDouble style={{ fontSize: "2.5rem", color: "#10b981", marginBottom: "10px" }} />
                                    <h3 style={{ margin: "0 0 6px", fontSize: "1.15rem", fontWeight: 800 }}>Attendance Session Completed</h3>
                                    <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--text-muted, #64748b)" }}>
                                        Fixed 2-minute deadline elapsed. All student devices have been unlocked from Kiosk mode.
                                    </p>
                                </div>
                            )}

                            {/* Phase 1 Status (0:00 to 1:00) */}
                            {phase === "PHASE_1" && (
                                <div className="qr-phase-panel">
                                    <div className={`qr-countdown-badge ${qr1Remaining > 15 ? "normal" : "urgent"}`}>
                                        <FaClock />
                                        <span>QR 1 Auto-Switches in:</span>
                                        <strong>{qr1Remaining}s (at 1:00)</strong>
                                    </div>

                                    <div className="qr-metric-row">
                                        <div className="qr-metric-label">
                                            <FaUserCheck style={{ color: "#6366f1", fontSize: "1.2rem" }} />
                                            <span>Students Checked In &amp; Locked:</span>
                                        </div>
                                        <strong className="qr-metric-val" style={{ color: "#6366f1" }}>
                                            {totalScannedQR1}
                                        </strong>
                                    </div>

                                    <button
                                        type="button"
                                        onClick={handleForcePhase2}
                                        disabled={isTransitioning}
                                        className="qr-switch-btn"
                                    >
                                        <span>⚡ Switch to QR 2 Early</span>
                                        <FaArrowRight />
                                    </button>
                                </div>
                            )}

                            {/* Phase 2 Status (1:00 to 3:00) */}
                            {phase === "PHASE_2" && (
                                <div className="qr-phase-panel">
                                    <div style={{
                                        padding: "10px 14px",
                                        borderRadius: "10px",
                                        background: "rgba(16, 185, 129, 0.1)",
                                        border: "1px solid rgba(16, 185, 129, 0.3)",
                                        color: "#065f46",
                                        fontSize: "0.85rem",
                                        fontWeight: 700,
                                        marginBottom: "4px"
                                    }}>
                                        🔒 Phase 2 Active: Only {totalScannedQR1} students who checked in during 0:00–1:00 can submit attendance.
                                    </div>

                                    <div className="qr-metric-row">
                                        <div className="qr-metric-label">
                                            <FaCheckCircle style={{ color: "#10b981", fontSize: "1.2rem" }} />
                                            <span>Attendance Recorded:</span>
                                        </div>
                                        <strong className="qr-metric-val" style={{ color: "#10b981" }}>
                                             {reachedQR2Count} / {totalScannedQR1}
                                        </strong>
                                    </div>

                                    <div style={{
                                        fontSize: "0.82rem",
                                        color: "var(--text-muted, #64748b)",
                                        marginBottom: "8px",
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
                                <div className="qr-phase-panel">
                                    <div className="qr-closed-box">
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

            {/* 3. Live Attendance & QR 1 / QR 2 Status Dashboard */}
            {sessionId && (
                <section style={{
                    marginTop: "30px",
                    padding: "24px",
                    background: "var(--surface, #ffffff)",
                    borderRadius: "20px",
                    border: "1.5px solid var(--border, #e2e8f0)",
                    boxShadow: "0 10px 30px -10px rgba(0,0,0,0.08)"
                }}>
                    <div style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: "12px",
                        marginBottom: "20px",
                        paddingBottom: "16px",
                        borderBottom: "1px solid var(--border, #e2e8f0)"
                    }}>
                        <div>
                            <h3 style={{ margin: "0 0 4px", fontSize: "1.25rem", fontWeight: 800, color: "var(--text-main, #0f172a)", display: "flex", alignItems: "center", gap: "8px" }}>
                                <FaUsers style={{ color: "#6366f1" }} /> Live Attendance &amp; QR Tracking
                            </h3>
                            <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--text-muted, #64748b)" }}>
                                Real-time breakdown of students who scanned QR 1, reached QR 2, or are pending QR 2.
                            </p>
                        </div>
                    </div>

                    {/* 3-Metric Summary Cards */}
                    <div style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                        gap: "16px",
                        marginBottom: "24px"
                    }}>
                        {/* Metric 1: Total Scanned QR 1 */}
                        <div style={{
                            padding: "16px 20px",
                            borderRadius: "16px",
                            background: "linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(99, 102, 241, 0.02) 100%)",
                            border: "1.5px solid rgba(99, 102, 241, 0.25)",
                            display: "flex",
                            alignItems: "center",
                            gap: "14px"
                        }}>
                            <div style={{
                                width: "48px",
                                height: "48px",
                                borderRadius: "12px",
                                background: "rgba(99, 102, 241, 0.15)",
                                color: "#4f46e5",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "1.4rem",
                                flexShrink: 0
                            }}>
                                <FaMobileAlt />
                            </div>
                            <div>
                                <div style={{ fontSize: "0.78rem", fontWeight: 800, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                    Scanned QR 1 (Checked In)
                                </div>
                                <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "#1e1b4b", lineHeight: 1.15 }}>
                                    {totalScannedQR1}
                                </div>
                                <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "2px" }}>
                                    Unique devices locked in Kiosk
                                </div>
                            </div>
                        </div>

                        {/* Metric 2: Reached QR 2 (Attendance Completed) */}
                        <div style={{
                            padding: "16px 20px",
                            borderRadius: "16px",
                            background: "linear-gradient(135deg, rgba(16, 185, 129, 0.08) 0%, rgba(16, 185, 129, 0.02) 100%)",
                            border: "1.5px solid rgba(16, 185, 129, 0.25)",
                            display: "flex",
                            alignItems: "center",
                            gap: "14px"
                        }}>
                            <div style={{
                                width: "48px",
                                height: "48px",
                                borderRadius: "12px",
                                background: "rgba(16, 185, 129, 0.15)",
                                color: "#059669",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "1.4rem",
                                flexShrink: 0
                            }}>
                                <FaCheckCircle />
                            </div>
                            <div>
                                <div style={{ fontSize: "0.78rem", fontWeight: 800, color: "#059669", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                    Reached QR 2 (Attended)
                                </div>
                                <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "#064e3b", lineHeight: 1.15 }}>
                                    {reachedQR2Count}
                                </div>
                                <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "2px" }}>
                                    Biometrics verified (100%)
                                </div>
                            </div>
                        </div>

                        {/* Metric 3: Pending QR 2 (Haven't Scanned QR 2 Yet) */}
                        <div style={{
                            padding: "16px 20px",
                            borderRadius: "16px",
                            background: "linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, rgba(245, 158, 11, 0.02) 100%)",
                            border: "1.5px solid rgba(245, 158, 11, 0.25)",
                            display: "flex",
                            alignItems: "center",
                            gap: "14px"
                        }}>
                            <div style={{
                                width: "48px",
                                height: "48px",
                                borderRadius: "12px",
                                background: "rgba(245, 158, 11, 0.15)",
                                color: "#d97706",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "1.4rem",
                                flexShrink: 0
                            }}>
                                <FaClock />
                            </div>
                            <div>
                                <div style={{ fontSize: "0.78rem", fontWeight: 800, color: "#d97706", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                    Pending QR 2 (Waiting)
                                </div>
                                <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "#78350f", lineHeight: 1.15 }}>
                                    {pendingQR2Count}
                                </div>
                                <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "2px" }}>
                                    Checked-in but didn't scan QR 2
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Deduplicated Student List Table */}
                    {uniqueStudentsList.length === 0 ? (
                        <div style={{
                            padding: "32px 20px",
                            textAlign: "center",
                            background: "var(--surface-soft, #f8fafc)",
                            borderRadius: "16px",
                            color: "var(--text-muted, #64748b)",
                            fontSize: "0.9rem"
                        }}>
                            <FaClock style={{ fontSize: "2rem", color: "#94a3b8", marginBottom: "8px", display: "block", margin: "0 auto 8px" }} />
                            Waiting for students to scan QR 1 and check into this session...
                        </div>
                    ) : (
                        <div style={{ overflowX: "auto" }}>
                            <table style={{
                                width: "100%",
                                borderCollapse: "collapse",
                                textAlign: "left",
                                fontSize: "0.88rem"
                            }}>
                                <thead>
                                    <tr style={{
                                        background: "var(--surface-soft, #f1f5f9)",
                                        color: "var(--text-main, #334155)",
                                        borderBottom: "2px solid var(--border, #cbd5e1)"
                                    }}>
                                        <th style={{ padding: "12px 14px", fontWeight: 800 }}>Roll Number</th>
                                        <th style={{ padding: "12px 14px", fontWeight: 800 }}>Student Name</th>
                                        <th style={{ padding: "12px 14px", fontWeight: 800 }}>Phase 1 (QR 1)</th>
                                        <th style={{ padding: "12px 14px", fontWeight: 800 }}>Phase 2 (QR 2)</th>
                                        <th style={{ padding: "12px 14px", fontWeight: 800 }}>Kiosk Mode</th>
                                        <th style={{ padding: "12px 14px", fontWeight: 800, textAlign: "right" }}>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {uniqueStudentsList.map((student) => {
                                        const studentId = student.studentUid || student.id || student.rollNo;
                                        const isReleased = student.released === true || student.status === "RELEASED" || phase === "CLOSED";
                                        const isAttended = sessionData?.attendees?.some((a) => (a.rollNo || "").toUpperCase() === (student.rollNo || "").toUpperCase()) || student.status === "ATTENDED" || student.attended === true;
                                        const isBusy = releasingStudentId === studentId;

                                        return (
                                            <tr key={student.rollNo} style={{
                                                borderBottom: "1px solid var(--border, #e2e8f0)",
                                                background: isReleased ? "rgba(241, 245, 249, 0.5)" : "transparent"
                                            }}>
                                                {/* Roll Number */}
                                                <td style={{ padding: "12px 14px", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                                                    {student.rollNo}
                                                </td>

                                                {/* Student Name */}
                                                <td style={{ padding: "12px 14px", color: "var(--text-main, #334155)" }}>
                                                    {student.studentName || student.fullName || student.rollNo}
                                                </td>

                                                {/* Phase 1 QR 1 Status */}
                                                <td style={{ padding: "12px 14px" }}>
                                                    <span style={{
                                                        display: "inline-flex",
                                                        alignItems: "center",
                                                        gap: "4px",
                                                        padding: "4px 10px",
                                                        borderRadius: "999px",
                                                        background: "rgba(99, 102, 241, 0.1)",
                                                        color: "#4338ca",
                                                        fontWeight: 700,
                                                        fontSize: "0.78rem"
                                                    }}>
                                                        <FaCheckCircle style={{ color: "#6366f1" }} /> Scanned
                                                    </span>
                                                </td>

                                                {/* Phase 2 QR 2 Status */}
                                                <td style={{ padding: "12px 14px" }}>
                                                    {isAttended ? (
                                                        <span style={{
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "4px",
                                                            padding: "4px 10px",
                                                            borderRadius: "999px",
                                                            background: "#dcfce7",
                                                            color: "#15803d",
                                                            fontWeight: 800,
                                                            fontSize: "0.78rem"
                                                        }}>
                                                            <FaCheckCircle /> Reached QR 2 (100%)
                                                        </span>
                                                    ) : (
                                                        <span style={{
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "4px",
                                                            padding: "4px 10px",
                                                            borderRadius: "999px",
                                                            background: "#fef3c7",
                                                            color: "#b45309",
                                                            fontWeight: 700,
                                                            fontSize: "0.78rem"
                                                        }}>
                                                            <FaClock /> Pending QR 2
                                                        </span>
                                                    )}
                                                </td>

                                                {/* Kiosk Mode Status */}
                                                <td style={{ padding: "12px 14px" }}>
                                                    {isReleased ? (
                                                        <span style={{
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "4px",
                                                            padding: "4px 10px",
                                                            borderRadius: "999px",
                                                            background: "#f1f5f9",
                                                            color: "#64748b",
                                                            fontWeight: 700,
                                                            fontSize: "0.78rem"
                                                        }}>
                                                            <FaUnlock style={{ color: "#10b981" }} /> Released
                                                        </span>
                                                    ) : (
                                                        <span style={{
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "4px",
                                                            padding: "4px 10px",
                                                            borderRadius: "999px",
                                                            background: "rgba(99, 102, 241, 0.12)",
                                                            color: "#4338ca",
                                                            fontWeight: 700,
                                                            fontSize: "0.78rem"
                                                        }}>
                                                            <FaLock style={{ color: "#6366f1" }} /> Locked
                                                        </span>
                                                    )}
                                                </td>

                                                {/* Action */}
                                                <td style={{ padding: "12px 14px", textAlign: "right" }}>
                                                    <button
                                                        type="button"
                                                        disabled={isReleased || isBusy}
                                                        onClick={() => handleReleaseIndividualStudent(student)}
                                                        style={{
                                                            padding: "6px 12px",
                                                            borderRadius: "8px",
                                                            background: isReleased ? "#f1f5f9" : "linear-gradient(135deg, #6366f1 0%, #4338ca 100%)",
                                                            border: isReleased ? "1px solid #cbd5e1" : "none",
                                                            color: isReleased ? "#94a3b8" : "#ffffff",
                                                            fontWeight: 800,
                                                            fontSize: "0.78rem",
                                                            cursor: isReleased ? "not-allowed" : "pointer",
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "5px",
                                                            boxShadow: isReleased ? "none" : "0 2px 8px rgba(99, 102, 241, 0.3)"
                                                        }}
                                                    >
                                                        {isBusy ? (
                                                            <FaSpinner className="fa-spin" />
                                                        ) : isReleased ? (
                                                            <>Unlocked</>
                                                        ) : (
                                                            <><FaUnlock /> Release</>
                                                        )}
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}

export default GenerateQR;