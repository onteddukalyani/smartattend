import { useState, useEffect, useMemo } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../../firebase";
import { createAttendanceSession } from "./CreateSession";
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
    FaUniversity
} from "react-icons/fa";
import "./Generateqr.css";

function GenerateQR() {
    const { user, profile } = useAuth();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    const [sessionId, setSessionId] = useState("");
    const [roomNo, setRoomNo] = useState(searchParams.get("roomNo") || "");
    const [courseCode, setCourseCode] = useState(searchParams.get("courseCode") || "");
    const [classCode, setClassCode] = useState(searchParams.get("classCode") || "");
    const [batch, setBatch] = useState(searchParams.get("batch") || "2025");
    const [availableCourses, setAvailableCourses] = useState([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const [copied, setCopied] = useState(false);

    // Load available courses from Firestore
    useEffect(() => {
        getDocs(collection(db, "courses"))
            .then((snap) => {
                const list = snap.docs.map((d) => ({
                    id: d.id,
                    ...d.data()
                }));
                list.sort((a, b) => (a.courseCode || "").localeCompare(b.courseCode || ""));
                setAvailableCourses(list);

                // If courseCode was passed in search params, auto-fill matching details if missing
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

    // When selecting a course from dropdown
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

    const handleGenerateQR = async () => {
        if (!classCode || !roomNo.trim()) {
            alert("Please select a class and enter room number.");
            return;
        }
        if (!courseCode.trim()) {
            alert("Please Enter Course Code.");
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
            const id = await createAttendanceSession(classCode, courseCode.trim(), roomNo.trim(), finalBatch, lecturerInfo);
            setSessionId(id);
        } catch (error) {
            console.error("Error creating session:", error);
            setErrorMessage(error.message || "Could not create an attendance session.");
        } finally {
            setIsGenerating(false);
        }
    };

    const attendanceUrl = sessionId
        ? `${window.location.origin}/student-form?session=${sessionId}`
        : "";

    const handleCopyLink = () => {
        if (!attendanceUrl) return;
        navigator.clipboard.writeText(attendanceUrl).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    return (
        <div className="qrpage">
            {/* Header */}
            <div className="qrpage-header">
                <h1>Generate attendance QR</h1>
                <p>Select a class and room to create a two-minute attendance session.</p>
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
                        />
                    </div>

                    <button
                        type="button"
                        onClick={handleGenerateQR}
                        className="genqr-btn"
                        disabled={isGenerating}
                    >
                        <span>{isGenerating ? "Generating QR Session..." : "Generate Live QR Code"}</span>
                        {!isGenerating ? <FaArrowRight /> : <FaSyncAlt className="fa-spin" />}
                    </button>

                    {errorMessage && <p className="qr-error" role="alert">{errorMessage}</p>}
                </section>

                {/* 2. QR Code Display & Live Session Monitor */}
                <section className={`qr-result ${sessionId ? "qr-result-ready" : ""}`}>
                    {sessionId ? (
                        <>
                            <div className="qr-result-heading">
                                <span className="qr-status-dot" />
                                <div className="child-qr-result-heading">
                                    <p className="qrpage-kicker">SESSION READY</p>
                                    <h2>{courseCode} · {classCode}{batch ? ` (${batch})` : ""} · {roomNo}</h2>
                                </div>
                            </div>

                            <div className="qr-code-frame">
                                <QRCodeCanvas value={attendanceUrl} size={300} />
                            </div>

                            <p className="qr-result-note">Students can scan this QR code using their camera or SmartAttend scanner.</p>

                            <div className="qr-live-pill-group">
                                <div className="qr-expiry">
                                    <FaClock /> <span>Valid for</span> <strong>2 minutes</strong>
                                </div>
                                <button
                                    type="button"
                                    onClick={handleCopyLink}
                                    className="qr-copy-btn"
                                    title="Copy attendance submission URL"
                                >
                                    {copied ? <><FaCheck /> Copied!</> : <><FaCopy /> Copy Link</>}
                                </button>
                            </div>

                            <div className="qr-active-shortcuts">
                                <Link
                                    to={`/lecturer/attendance-sessions/${sessionId}`}
                                    className="qr-view-live-btn"
                                >
                                    <FaUsers /> View Live Attendees
                                </Link>
                            </div>
                        </>
                    ) : (
                        <div className="qr-empty-state">
                            <div className="qr-empty-mark">
                                <FaQrcode />
                            </div>
                            <h2>Your QR Code Will Appear Here</h2>
                            <p>Select a course code, department and classroom number, then click generate.</p>
                            <div className="qr-empty-hint">
                                <span>⚡ 2-Minute Dynamic Session</span>
                            </div>
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}

export default GenerateQR;