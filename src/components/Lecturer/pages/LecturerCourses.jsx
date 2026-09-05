import React, { useEffect, useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
    collection,
    doc,
    setDoc,
    onSnapshot,
    getDocs
} from "firebase/firestore";
import {
    FaBookOpen,
    FaPlus,
    FaSearch,
    FaChalkboardTeacher,
    FaLayerGroup,
    FaDoorOpen,
    FaCalendarCheck,
    FaUsers,
    FaSyncAlt,
    FaTimes,
    FaQrcode,
    FaGraduationCap
} from "react-icons/fa";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import "./LecturerCourses.css";

export default function LecturerCourses() {
    const { user, profile } = useAuth();
    const navigate = useNavigate();

    const [courses, setCourses] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [activeTab, setActiveTab] = useState("my"); // "my" or "all"

    // Modal state for quick subject creation
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [formData, setFormData] = useState({
        courseCode: "",
        courseName: "",
        department: profile?.department || profile?.branch || "CSE",
        semester: "1",
        credits: "3",
        defaultRoom: "LH-101",
        batch: "2024",
        description: ""
    });

    const lecturerEmail = (user?.email || profile?.email || "").toLowerCase().trim();
    const lecturerName = profile?.name || user?.displayName || (lecturerEmail ? lecturerEmail.split("@")[0] : "Lecturer");

    // 1. Real-time Courses listener
    useEffect(() => {
        setLoading(true);
        const unsubscribe = onSnapshot(
            collection(db, "courses"),
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({
                    id: d.id,
                    ...d.data()
                }));
                list.sort((a, b) => (a.courseCode || "").localeCompare(b.courseCode || ""));
                setCourses(list);
                setLoading(false);
            },
            (err) => {
                console.error("Error loading courses for lecturer:", err);
                setLoading(false);
            }
        );

        return () => unsubscribe();
    }, []);

    // 2. Real-time Sessions listener
    useEffect(() => {
        const unsubscribe = onSnapshot(
            collection(db, "attendance_sessions"),
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({
                    id: d.id,
                    ...d.data()
                }));
                setSessions(list);
            },
            (err) => console.warn("Sessions read error:", err)
        );

        return () => unsubscribe();
    }, []);

    // Session statistics per course
    const sessionsPerCourse = useMemo(() => {
        const map = {};
        sessions.forEach((s) => {
            const code = (s.courseCode || s.classCode || "").trim().toUpperCase();
            if (code) {
                map[code] = (map[code] || 0) + 1;
            }
        });
        return map;
    }, [sessions]);

    // Filter courses based on tab and search
    const filteredCourses = useMemo(() => {
        return courses.filter((c) => {
            const assignedEmail = (c.lecturerEmail || "").toLowerCase().trim();
            const isAssignedToMe =
                assignedEmail === lecturerEmail ||
                (c.lecturerName && c.lecturerName.toLowerCase() === lecturerName.toLowerCase());

            if (activeTab === "my" && !isAssignedToMe) {
                return false;
            }

            const term = search.toLowerCase().trim();
            if (!term) return true;

            return (
                (c.courseCode || "").toLowerCase().includes(term) ||
                (c.courseName || "").toLowerCase().includes(term) ||
                (c.department || "").toLowerCase().includes(term) ||
                (c.defaultRoom || "").toLowerCase().includes(term)
            );
        });
    }, [courses, activeTab, search, lecturerEmail, lecturerName]);

    // Handle Quick Add Course
    const handleSaveCourse = async (e) => {
        e.preventDefault();
        const code = formData.courseCode.trim().toUpperCase();
        if (!code) {
            alert("Please enter a valid Course Code.");
            return;
        }
        if (!formData.courseName.trim()) {
            alert("Please enter Course Name / Title.");
            return;
        }

        setSaving(true);
        try {
            const courseDocId = code.replace(/[^a-zA-Z0-9_-]/g, "_");
            const docRef = doc(db, "courses", courseDocId);

            const payload = {
                courseCode: code,
                courseName: formData.courseName.trim(),
                department: formData.department,
                semester: formData.semester,
                credits: Number(formData.credits) || 3,
                defaultRoom: formData.defaultRoom.trim() || "LH-101",
                lecturerEmail: lecturerEmail,
                lecturerName: lecturerName,
                batch: formData.batch,
                description: formData.description.trim(),
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            await setDoc(docRef, payload, { merge: true });
            setIsModalOpen(false);
            setFormData({
                courseCode: "",
                courseName: "",
                department: profile?.department || profile?.branch || "CSE",
                semester: "1",
                credits: "3",
                defaultRoom: "LH-101",
                batch: "2024",
                description: ""
            });
        } catch (err) {
            console.error("Error creating course:", err);
            alert("Failed to create course: " + err.message);
        } finally {
            setSaving(false);
        }
    };

    const handleLaunchQR = (course) => {
        navigate(`/lecturer/lecturerpage?courseCode=${encodeURIComponent(course.courseCode)}&roomNo=${encodeURIComponent(course.defaultRoom || "")}&classCode=${encodeURIComponent(course.department || "")}`);
    };

    // KPIs
    const myCoursesCount = courses.filter((c) => (c.lecturerEmail || "").toLowerCase() === lecturerEmail).length;
    const myConductedCount = sessions.filter((s) => (s.ownerEmail || s.lecturerEmail || "").toLowerCase() === lecturerEmail).length;

    return (
        <div className="lecturer-courses-page">
            {/* Header Banner */}
            <header className="lecturer-courses-header">
                <div className="lecturer-courses-title-box">
                    <div className="lecturer-courses-icon">
                        <FaBookOpen />
                    </div>
                    <div>
                        <h1>Teaching Courses & Curriculum</h1>
                        <p>Manage your assigned subjects and launch instant QR attendance sessions.</p>
                    </div>
                </div>

                <div className="lecturer-courses-actions">
                    <button
                        className="lecturer-add-course-btn"
                        onClick={() => setIsModalOpen(true)}
                    >
                        <FaPlus />
                        <span>Add Subject</span>
                    </button>
                </div>
            </header>

            {/* KPI Overview */}
            <section className="lecturer-kpi-grid">
                <div className="lecturer-kpi-card">
                    <div className="lecturer-kpi-icon emerald">
                        <FaBookOpen />
                    </div>
                    <div className="lecturer-kpi-info">
                        <span className="lecturer-kpi-label">My Assigned Subjects</span>
                        <span className="lecturer-kpi-val">{loading ? "..." : myCoursesCount}</span>
                    </div>
                </div>

                <div className="lecturer-kpi-card">
                    <div className="lecturer-kpi-icon indigo">
                        <FaCalendarCheck />
                    </div>
                    <div className="lecturer-kpi-info">
                        <span className="lecturer-kpi-label">Sessions Conducted</span>
                        <span className="lecturer-kpi-val">{loading ? "..." : myConductedCount}</span>
                    </div>
                </div>

                <div className="lecturer-kpi-card">
                    <div className="lecturer-kpi-icon purple">
                        <FaLayerGroup />
                    </div>
                    <div className="lecturer-kpi-info">
                        <span className="lecturer-kpi-label">Total Catalog Subjects</span>
                        <span className="lecturer-kpi-val">{loading ? "..." : courses.length}</span>
                    </div>
                </div>
            </section>

            {/* Controls Bar */}
            <div className="lecturer-controls-bar">
                <div className="lecturer-tab-group">
                    <button
                        className={`lecturer-tab-btn ${activeTab === "my" ? "active" : ""}`}
                        onClick={() => setActiveTab("my")}
                    >
                        My Assigned Courses ({myCoursesCount})
                    </button>
                    <button
                        className={`lecturer-tab-btn ${activeTab === "all" ? "active" : ""}`}
                        onClick={() => setActiveTab("all")}
                    >
                        All Department Courses ({courses.length})
                    </button>
                </div>

                <div className="lecturer-search-wrapper">
                    <FaSearch className="lecturer-search-icon" />
                    <input
                        type="text"
                        placeholder="Search courses, titles, rooms..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="lecturer-search-input"
                    />
                </div>
            </div>

            {/* Courses Grid */}
            {loading ? (
                <div className="courses-lecturer-empty">
                    <div className="courses-lecturer-empty-icon">
                        <FaSyncAlt className="spin" />
                    </div>
                    <h3>Loading Courses...</h3>
                    <p>Fetching curriculum catalog and your teaching assignments.</p>
                </div>
            ) : filteredCourses.length === 0 ? (
                <div className="courses-lecturer-empty">
                    <div className="courses-lecturer-empty-icon">
                        <FaBookOpen />
                    </div>
                    <h3>No Courses Found</h3>
                    <p>
                        {activeTab === "my"
                            ? "You don't have any assigned courses yet. Switch to 'All Department Courses' or click 'Add Subject' to create one."
                            : "No courses match your search."}
                    </p>
                    <button
                        className="lecturer-add-course-btn"
                        onClick={() => setIsModalOpen(true)}
                    >
                        <FaPlus />
                        <span>Add Subject</span>
                    </button>
                </div>
            ) : (
                <div className="lecturer-courses-grid">
                    {filteredCourses.map((course) => {
                        const count = sessionsPerCourse[(course.courseCode || "").toUpperCase()] || 0;

                        return (
                            <div className="lecturer-course-card" key={course.id}>
                                <div className="lecturer-course-top">
                                    <span className="lecturer-course-code">{course.courseCode}</span>
                                    <span className="lecturer-course-dept">
                                        {course.department} • Sem {course.semester}
                                    </span>
                                </div>

                                <div className="lecturer-course-main">
                                    <h3>{course.courseName}</h3>
                                    {course.description && (
                                        <p className="lecturer-course-desc">{course.description}</p>
                                    )}
                                </div>

                                <div className="lecturer-course-details">
                                    <div className="lecturer-course-detail-row">
                                        <FaChalkboardTeacher />
                                        <span>
                                            Faculty: <strong>{course.lecturerName || "Unassigned"}</strong>
                                        </span>
                                    </div>
                                    <div className="lecturer-course-detail-row">
                                        <FaDoorOpen />
                                        <span>
                                            Default Room: <strong>{course.defaultRoom || "LH-101"}</strong>
                                        </span>
                                    </div>
                                    <div className="lecturer-course-detail-row">
                                        <FaGraduationCap />
                                        <span>
                                            Credits: <strong>{course.credits || 3}</strong> • Batch: <strong>{course.batch || "2024"}</strong>
                                        </span>
                                    </div>
                                </div>

                                <div className="lecturer-course-footer">
                                    <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-muted, #64748b)" }}>
                                        <FaCalendarCheck style={{ marginRight: "5px", color: "#10b981" }} />
                                        {count} Class{count !== 1 ? "es" : ""} Held
                                    </span>

                                    <button
                                        type="button"
                                        className="lecturer-start-session-btn"
                                        onClick={() => handleLaunchQR(course)}
                                    >
                                        <FaQrcode />
                                        <span>Start QR Session</span>
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Quick Add Course Modal */}
            {isModalOpen && (
                <div
                    style={{
                        position: "fixed",
                        inset: 0,
                        background: "rgba(15, 23, 42, 0.6)",
                        backdropFilter: "blur(8px)",
                        WebkitBackdropFilter: "blur(8px)",
                        zIndex: 1050,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "20px"
                    }}
                    onClick={() => !saving && setIsModalOpen(false)}
                >
                    <div
                        style={{
                            background: "var(--surface, #ffffff)",
                            border: "1px solid var(--border, #e2e8f0)",
                            borderRadius: "20px",
                            width: "100%",
                            maxWidth: "580px",
                            maxHeight: "90vh",
                            display: "flex",
                            flexDirection: "column",
                            boxShadow: "0 20px 50px rgba(0, 0, 0, 0.2)",
                            overflow: "hidden"
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div
                            style={{
                                padding: "20px 24px",
                                borderBottom: "1px solid var(--border, #e2e8f0)",
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center"
                            }}
                        >
                            <h3 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                                Register New Subject
                            </h3>
                            <button
                                style={{
                                    background: "none",
                                    border: "none",
                                    color: "var(--text-muted, #64748b)",
                                    fontSize: "20px",
                                    cursor: "pointer"
                                }}
                                onClick={() => setIsModalOpen(false)}
                                disabled={saving}
                                aria-label="Close modal"
                            >
                                <FaTimes />
                            </button>
                        </div>

                        <form onSubmit={handleSaveCourse} style={{ padding: "20px 24px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "16px" }}>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                    <label style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main, #0f172a)" }}>Course Code *</label>
                                    <input
                                        type="text"
                                        required
                                        placeholder="e.g. CS301"
                                        value={formData.courseCode}
                                        onChange={(e) => setFormData({ ...formData, courseCode: e.target.value })}
                                        style={{ padding: "10px 14px", background: "var(--surface-soft, #f8fafc)", border: "1px solid var(--border, #e2e8f0)", borderRadius: "10px", fontSize: "0.9rem", color: "var(--text-main, #0f172a)", outline: "none" }}
                                    />
                                </div>

                                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                    <label style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main, #0f172a)" }}>Department</label>
                                    <select
                                        value={formData.department}
                                        onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                                        style={{ padding: "10px 14px", background: "var(--surface-soft, #f8fafc)", border: "1px solid var(--border, #e2e8f0)", borderRadius: "10px", fontSize: "0.9rem", color: "var(--text-main, #0f172a)", outline: "none" }}
                                    >
                                        <option value="CSE">CSE</option>
                                        <option value="DSAI">DSAI</option>
                                        <option value="ECE">ECE</option>
                                        <option value="MECH">MECH</option>
                                        <option value="General">General</option>
                                    </select>
                                </div>
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <label style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main, #0f172a)" }}>Course Title *</label>
                                <input
                                    type="text"
                                    required
                                    placeholder="e.g. Operating Systems"
                                    value={formData.courseName}
                                    onChange={(e) => setFormData({ ...formData, courseName: e.target.value })}
                                    style={{ padding: "10px 14px", background: "var(--surface-soft, #f8fafc)", border: "1px solid var(--border, #e2e8f0)", borderRadius: "10px", fontSize: "0.9rem", color: "var(--text-main, #0f172a)", outline: "none" }}
                                />
                            </div>

                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                    <label style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main, #0f172a)" }}>Default Classroom</label>
                                    <input
                                        type="text"
                                        placeholder="e.g. LH-101"
                                        value={formData.defaultRoom}
                                        onChange={(e) => setFormData({ ...formData, defaultRoom: e.target.value })}
                                        style={{ padding: "10px 14px", background: "var(--surface-soft, #f8fafc)", border: "1px solid var(--border, #e2e8f0)", borderRadius: "10px", fontSize: "0.9rem", color: "var(--text-main, #0f172a)", outline: "none" }}
                                    />
                                </div>

                                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                    <label style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main, #0f172a)" }}>Semester</label>
                                    <select
                                        value={formData.semester}
                                        onChange={(e) => setFormData({ ...formData, semester: e.target.value })}
                                        style={{ padding: "10px 14px", background: "var(--surface-soft, #f8fafc)", border: "1px solid var(--border, #e2e8f0)", borderRadius: "10px", fontSize: "0.9rem", color: "var(--text-main, #0f172a)", outline: "none" }}
                                    >
                                        {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
                                            <option key={s} value={String(s)}>Semester {s}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <label style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main, #0f172a)" }}>Notes / Syllabus Description</label>
                                <textarea
                                    rows="2"
                                    placeholder="Optional notes or prerequisites..."
                                    value={formData.description}
                                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                    style={{ padding: "10px 14px", background: "var(--surface-soft, #f8fafc)", border: "1px solid var(--border, #e2e8f0)", borderRadius: "10px", fontSize: "0.9rem", color: "var(--text-main, #0f172a)", outline: "none", fontFamily: "inherit" }}
                                />
                            </div>

                            <div style={{ padding: "16px 0 0", borderTop: "1px solid var(--border, #e2e8f0)", display: "flex", justifyContent: "flex-end", gap: "12px" }}>
                                <button
                                    type="button"
                                    onClick={() => setIsModalOpen(false)}
                                    disabled={saving}
                                    style={{ padding: "10px 18px", borderRadius: "10px", border: "1px solid var(--border, #e2e8f0)", background: "var(--surface, #ffffff)", color: "var(--text-muted, #64748b)", fontWeight: 600, cursor: "pointer" }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={saving}
                                    style={{ padding: "10px 22px", borderRadius: "10px", border: "none", background: "linear-gradient(135deg, #10b981, #059669)", color: "#ffffff", fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 14px rgba(16, 185, 129, 0.35)" }}
                                >
                                    {saving ? "Saving..." : "Create Subject"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
