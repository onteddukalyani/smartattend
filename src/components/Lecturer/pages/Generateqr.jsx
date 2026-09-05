import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../../firebase";
import { createAttendanceSession } from "./CreateSession";
import { useAuth } from "../../authcontext";
import "./Generateqr.css";

function GenerateQR() {
    const { user, profile } = useAuth();
    const [searchParams] = useSearchParams();

    const [sessionId, setSessionId] = useState("");
    const [roomNo, setRoomNo] = useState(searchParams.get("roomNo") || "");
    const [courseCode, setCourseCode] = useState(searchParams.get("courseCode") || "");
    const [classCode, setClassCode] = useState(searchParams.get("classCode") || "");
    const [batch, setBatch] = useState(searchParams.get("batch") || "");
    const [availableCourses, setAvailableCourses] = useState([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");

    // Load available courses from Firestore
    useEffect(() => {
        getDocs(collection(db, "courses"))
            .then((snap) => {
                const list = snap.docs.map((d) => ({
                    id: d.id,
                    ...d.data()
                }));
                setAvailableCourses(list);
            })
            .catch((err) => console.warn("Could not load courses for QR page:", err));
    }, []);

    // When selecting a course from dropdown
    const handleSelectCourse = (code) => {
        setCourseCode(code);
        const matched = availableCourses.find((c) => (c.courseCode || "").toUpperCase() === code.toUpperCase());
        if (matched) {
            if (matched.defaultRoom && !roomNo) setRoomNo(matched.defaultRoom);
            if (matched.department && !classCode) setClassCode(matched.department);
            if (matched.batch && !batch) setBatch(matched.batch);
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
            const lecturerInfo = {
                name: profile?.name || user?.displayName || (user?.email ? user.email.split("@")[0] : "Lecturer"),
                email: user?.email || "",
                department: profile?.department || profile?.branch || "General"
            };
            const id = await createAttendanceSession(classCode, courseCode.trim(), roomNo.trim(), batch, lecturerInfo);
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
    return (
        <div className="qrpage">
            <div className="qrpage-header">
                <p className="qrpage-kicker">LECTURER TOOLS</p>
                <h1>Generate attendance QR</h1>
                <p>Select a class and room to create a two-minute attendance session.</p>
            </div>
            <div className="qrpage-layout">
                <section className="qr-builder">
                    <div className="qr-section-heading">
                        <span className="qr-step">01</span>
                        <div>
                            <h2>Session details</h2>
                            <p>Tell students where to check in.</p>
                        </div>
                    </div>

                    {availableCourses.length > 0 && (
                        <>
                            <label htmlFor="course-select">Quick Pick Registered Course</label>
                            <select
                                id="course-select"
                                value={courseCode}
                                onChange={(e) => handleSelectCourse(e.target.value)}
                            >
                                <option value="">-- Choose from Catalog or Type Below --</option>
                                {availableCourses.map((c) => (
                                    <option key={c.id} value={c.courseCode}>
                                        {c.courseCode} - {c.courseName} ({c.department})
                                    </option>
                                ))}
                            </select>
                        </>
                    )}

                    <label htmlFor="course-code">Course Code *</label>
                    <input
                        id="course-code"
                        type="text"
                        value={courseCode}
                        onChange={(e) => setCourseCode(e.target.value)}
                        placeholder="e.g. CS171, CS301"
                        required
                    />

                    <label htmlFor="class-code">Class / Department *</label>
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
                        <option value="MECH">MECH</option>
                    </select>

                    <label htmlFor="batch-year">Batch</label>
                    <select
                        id="batch-year"
                        value={batch}
                        onChange={(e) => setBatch(e.target.value)}
                    >
                        <option value="">Select Batch</option>
                        <option value="2023">2023</option>
                        <option value="2024">2024</option>
                        <option value="2025">2025</option>
                        <option value="2026">2026</option>
                    </select>

                    <label htmlFor="room-number">Room number *</label>
                    <input
                        id="room-number"
                        type="text"
                        value={roomNo}
                        onChange={(e) => setRoomNo(e.target.value)}
                        placeholder="e.g. LH-101, C003"
                        required
                    />
                    <button onClick={handleGenerateQR} className="genqr-btn" disabled={isGenerating}>
                        <span>{isGenerating ? "Generating..." : "Generate QR code"}</span>
                        {!isGenerating && <span aria-hidden="true">→</span>}
                    </button>
                    {errorMessage && <p className="qr-error" role="alert">{errorMessage}</p>}
                </section>
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
                            <p className="qr-result-note">Students can scan this code to submit attendance.</p>
                            <div className="qr-expiry"><span>Valid for</span><strong>2 minutes</strong></div>
                        </>
                    ) : (
                        <div className="qr-empty-state">
                            <div className="qr-empty-mark">QR</div>
                            <h2>Your QR code will appear here</h2>
                            <p>Complete the session details to get started.</p>
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}

export default GenerateQR;