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
import { isCourseAssignedToLecturer } from "../../Common/CoursesManager";
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
    const [courseCode, setCourseCode] = useState(searchParams.get("courseCode") || searchParams.get("course") || "");
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
                list.sort((a, b) => (a.courseCode || a.code || "").localeCompare(b.courseCode || b.code || ""));
                setAvailableCourses(list);

                const targetCode = courseCode || searchParams.get("course") || searchParams.get("courseCode") || "";
                if (targetCode) {
                    const matched = list.find((c) => (c.courseCode || c.code || "").toUpperCase() === targetCode.toUpperCase());
                    if (matched) {
                        setCourseCode(matched.courseCode || matched.code || targetCode);
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
            if (phase === "CLOSED" || sessionData?.phase === "CLOSED" || sessionData?.status === "CLOSED" || sessionData?.active === false) {
                setPhase("CLOSED");
                setElapsedSeconds(180);
                if (timerRef.current) clearInterval(timerRef.current);
                return;
            }

            const now = Date.now();
            const elapsed = Math.min(180, Math.floor((now - sessionStartAt) / 1000));
            setElapsedSeconds(elapsed);

            if (now >= kioskEndsAt || elapsed >= 180) {
                setPhase("CLOSED");
                setElapsedSeconds(180);
                if (timerRef.current) clearInterval(timerRef.current);
                if (sessionId) {
                    closeAttendanceSession(sessionId).catch(() => {});
                }
            } else if (phase === "PHASE_2" || sessionData?.phase === "PHASE_2" || now >= qr1ExpiresAt || elapsed >= 60) {
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
    }, [sessionStartAt, qr1ExpiresAt, kioskEndsAt, phase, sessionData?.phase, sessionData?.status, sessionData?.active]);

    const handleSelectCourse = (code) => {
        setCourseCode(code);
        const matched = availableCourses.find((c) => (c.courseCode || c.code || "").toUpperCase() === String(code).toUpperCase());
        if (matched) {
            if (matched.defaultRoom && !roomNo) setRoomNo(matched.defaultRoom);
            if (matched.department && !classCode) setClassCode(matched.department);
            if (matched.batch) setBatch(matched.batch);
        }
    };

    const handleCourseCodeChange = (e) => {
        const val = e.target.value;
        setCourseCode(val);
        const matched = availableCourses.find((c) => (c.courseCode || c.code || "").toUpperCase() === val.trim().toUpperCase());
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

    // 5. Early Transition to Phase 2 (Sets clock to 1:00 and starts Phase 2 immediately)
    const handleForcePhase2 = async () => {
        if (!sessionId) return;
        setIsTransitioning(true);
        try {
            const now = Date.now();
            const newStartAt = now - 60000; // Aligns elapsed time to 1:00 (60s)
            const newEndsAt = newStartAt + 180000; // Gives full 2 mins (120s) until 3:00
            setSessionStartAt(newStartAt);
            setQr1ExpiresAt(now);
            setKioskEndsAt(newEndsAt);
            setElapsedSeconds(60); // Jumps clock to 1:00
            setPhase("PHASE_2");
            await transitionSessionToPhase2(sessionId);
        } catch (error) {
            console.warn("Notice transitioning early:", error);
            setPhase("PHASE_2");
            setElapsedSeconds(60);
        } finally {
            setIsTransitioning(false);
        }
    };

    // Helper: End session immediately, release all student kiosks, and jump clock to 3:00
    const handleEndSessionAndReleaseAll = async () => {
        if (!window.confirm("End attendance session immediately and release all student devices from Kiosk mode?")) {
            return;
        }
        if (timerRef.current) clearInterval(timerRef.current);
        setPhase("CLOSED");
        setElapsedSeconds(180); // Sets clock to 3:00 / 3:00
        try {
            if (sessionId) {
                await closeAttendanceSession(sessionId);
            }
        } catch (err) {
            console.error("Error closing session:", err);
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
                    <FaShieldAlt /> 2-Phase Attendance Protocol
                </div>
                <h1>Generate Attendance QR</h1>
                <p>
                    <strong>Phase 1 (0:00–1:00):</strong> Student Check-in &amp; Kiosk Lock &bull; <strong>Phase 2 (1:00–3:00):</strong> Biometric Verification
                </p>
            </div>

            <div className="qrpage-layout">
                {/* 1. Session Setup Builder */}
                <section className="qr-builder">
                    <div className="qr-section-heading">
                        <span className="qr-step">01</span>
                        <div>
                            <h2>Session Setup</h2>
                            <p>Select or enter course and classroom info</p>
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
                                        {myCourses.map((c) => {
                                            const code = c.courseCode || c.code || "";
                                            const name = c.courseName || c.name || "Curriculum Course";
                                            const dept = c.department || "CSE";
                                            return (
                                                <option key={c.id} value={code}>
                                                    {code} - {name} ({dept})
                                                </option>
                                            );
                                        })}
                                    </optgroup>
                                )}
                                {otherCourses.length > 0 && (
                                    <optgroup label="📚 All Other Courses">
                                        {otherCourses.map((c) => {
                                            const code = c.courseCode || c.code || "";
                                            const name = c.courseName || c.name || "Curriculum Course";
                                            const dept = c.department || "CSE";
                                            return (
                                                <option key={c.id} value={code}>
                                                    {code} - {name} ({dept})
                                                </option>
                                            );
                                        })}
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
                            className="qr-reset-btn"
                        >
                            <FaSyncAlt /> Reset / Start New Session
                        </button>
                    )}

                    {errorMessage && <p className="qr-error" role="alert">{errorMessage}</p>}
                </section>

                {/* 2. QR Code Display & Authoritative 3-Minute Session Timeline */}
                <section className={`qr-result ${sessionId ? "qr-result-ready" : ""}`}>
                    {sessionId ? (
                        <>
                            {/* Authoritative Timeline Bar */}
                            <div className="qr-timeline-bar">
                                <div className="qr-timeline-clock-wrap">
                                    <span className="qr-timeline-label">Session Clock</span>
                                    <span className="qr-timeline-clock">{formatMmSs(elapsedSeconds)} / 3:00</span>
                                </div>

                                <div className="qr-timeline-phase-wrap">
                                    <span className={`qr-phase-tag ${phase === "PHASE_1" ? "p1" : phase === "PHASE_2" ? "p2" : "closed"}`}>
                                        {phase === "PHASE_1" ? "⚡ Phase 1 (0:00–1:00)" : phase === "PHASE_2" ? "🎯 Phase 2 (1:00–3:00)" : "🔒 Session Closed"}
                                    </span>
                                </div>
                            </div>

                            {/* Lecturer Security PIN & Kiosk Remote Controller Bar */}
                            {phase !== "CLOSED" && (
                                <div className="qr-pin-bar">
                                    <div className="qr-pin-info">
                                        <FaLock />
                                        <span>PIN: <strong className="qr-pin-value">{showPin ? (sessionPin || "------") : (sessionPin ? "••••••" : "------")}</strong></span>
                                        {sessionPin && (
                                            <button
                                                type="button"
                                                onClick={() => setShowPin((prev) => !prev)}
                                                className={`qr-pin-toggle-btn ${showPin ? "active" : ""}`}
                                            >
                                                {showPin ? <><FaEyeSlash /> Hide</> : <><FaEye /> View</>}
                                            </button>
                                        )}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={handleEndSessionAndReleaseAll}
                                        className="qr-pin-end-btn"
                                        title="End session immediately, release all student kiosks, and mark session complete (3:00)"
                                    >
                                        🛑 End Session &amp; Release Devices
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
                <section className="qr-live-tracking-section">
                    <div className="qr-tracking-header">
                        <div>
                            <h3 className="qr-tracking-title">
                                <FaUsers /> Live Attendance &amp; QR Tracking
                            </h3>
                            <p className="qr-tracking-desc">
                                Real-time breakdown of students who scanned QR 1, reached QR 2, or are pending QR 2.
                            </p>
                        </div>
                    </div>

                    {/* 3-Metric Summary Cards */}
                    <div className="qr-metrics-grid">
                        {/* Metric 1: Total Scanned QR 1 */}
                        <div className="qr-kpi-card qr-kpi-scanned">
                            <div className="qr-kpi-icon indigo">
                                <FaMobileAlt />
                            </div>
                            <div className="qr-kpi-data">
                                <span className="qr-kpi-label">Scanned QR 1 (Checked In)</span>
                                <span className="qr-kpi-val">{totalScannedQR1}</span>
                                <span className="qr-kpi-sub">Devices locked in Kiosk</span>
                            </div>
                        </div>

                        {/* Metric 2: Reached QR 2 (Attendance Completed) */}
                        <div className="qr-kpi-card qr-kpi-attended">
                            <div className="qr-kpi-icon emerald">
                                <FaCheckCircle />
                            </div>
                            <div className="qr-kpi-data">
                                <span className="qr-kpi-label">Reached QR 2 (Attended)</span>
                                <span className="qr-kpi-val">{reachedQR2Count}</span>
                                <span className="qr-kpi-sub">Biometrics verified (100%)</span>
                            </div>
                        </div>

                        {/* Metric 3: Pending QR 2 (Haven't Scanned QR 2 Yet) */}
                        <div className="qr-kpi-card qr-kpi-pending">
                            <div className="qr-kpi-icon amber">
                                <FaClock />
                            </div>
                            <div className="qr-kpi-data">
                                <span className="qr-kpi-label">Pending QR 2 (Waiting)</span>
                                <span className="qr-kpi-val">{pendingQR2Count}</span>
                                <span className="qr-kpi-sub">Checked-in, pending QR 2</span>
                            </div>
                        </div>
                    </div>

                    {/* Deduplicated Student List Table */}
                    {uniqueStudentsList.length === 0 ? (
                        <div className="qr-waiting-box">
                            <FaClock />
                            <p>Waiting for students to scan QR 1 and check into this session...</p>
                        </div>
                    ) : (
                        <div className="qr-roster-table-wrap">
                            <table className="qr-roster-table">
                                <thead>
                                    <tr>
                                        <th>Roll Number</th>
                                        <th>Student Name</th>
                                        <th>Phase 1 (QR 1)</th>
                                        <th>Phase 2 (QR 2)</th>
                                        <th>Kiosk Mode</th>
                                        <th style={{ textAlign: "right" }}>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {uniqueStudentsList.map((student) => {
                                        const studentId = student.studentUid || student.id || student.rollNo;
                                        const isReleased = student.released === true || student.status === "RELEASED" || phase === "CLOSED";
                                        const isAttended = sessionData?.attendees?.some((a) => (a.rollNo || "").toUpperCase() === (student.rollNo || "").toUpperCase()) || student.status === "ATTENDED" || student.attended === true;
                                        const isBusy = releasingStudentId === studentId;

                                        return (
                                            <tr key={student.rollNo} className={isReleased ? "row-released" : ""}>
                                                <td className="qr-cell-roll">{student.rollNo}</td>
                                                <td className="qr-cell-name">{student.studentName || student.fullName || student.rollNo}</td>
                                                <td>
                                                    <span className="qr-tag-scanned">
                                                        <FaCheckCircle /> Scanned
                                                    </span>
                                                </td>
                                                <td>
                                                    {isAttended ? (
                                                        <span className="qr-tag-attended">
                                                            <FaCheckCircle /> Reached QR 2 (100%)
                                                        </span>
                                                    ) : (
                                                        <span className="qr-tag-pending">
                                                            <FaClock /> Pending QR 2
                                                        </span>
                                                    )}
                                                </td>
                                                <td>
                                                    {isReleased ? (
                                                        <span className="qr-tag-released">
                                                            <FaUnlock /> Released
                                                        </span>
                                                    ) : (
                                                        <span className="qr-tag-locked">
                                                            <FaLock /> Locked
                                                        </span>
                                                    )}
                                                </td>
                                                <td style={{ textAlign: "right" }}>
                                                    <button
                                                        type="button"
                                                        disabled={isReleased || isBusy}
                                                        onClick={() => handleReleaseIndividualStudent(student)}
                                                        className={`qr-release-btn ${isReleased ? "released" : ""}`}
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