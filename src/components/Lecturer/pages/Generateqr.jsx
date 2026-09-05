import { useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { createAttendanceSession } from "./CreateSession";
import { useAuth } from "../../authcontext";
import "./Generateqr.css"

function GenerateQR() {
    const { user, profile } = useAuth();
    const [sessionId, setSessionId] = useState("");
    const [roomNo, setRoomNo] = useState("");
    const [courseCode, setCourseCode] = useState("");
    const [classCode, setClassCode] = useState("");
    const [batch, setBatch] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");

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
            console.log("Session ID:", id);
            console.log("Class Code:", classCode);
            console.log("Batch:", batch);
            console.log("Course Code:", courseCode);
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
                    <label htmlFor="class-code">Class</label>
                    <select
                        id="class-code"
                        value={classCode}
                        onChange={(e) => setClassCode(e.target.value)}
                    >
                        <option value="">Select Class</option>
                        <option value="CSE-A">CSE-A</option>
                        <option value="CSE-B">CSE-B</option>
                        <option value="DSAI">DSAI</option>
                        <option value="ECE">ECE</option>
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

                    <label htmlFor="course-code">Course Code</label>
                    <input
                        id="course-code"
                        type="text"
                        value={courseCode}
                        onChange={(e) => setCourseCode(e.target.value)}
                        placeholder="e.g. CS171"
                        required
                    />
                    <label htmlFor="room-number">Room number</label>
                    <input
                        id="room-number"
                        type="text"
                        value={roomNo}
                        onChange={(e) => setRoomNo(e.target.value)}
                        placeholder="e.g. C003"
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