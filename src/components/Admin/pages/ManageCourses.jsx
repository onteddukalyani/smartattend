import React, { useEffect, useState, useMemo } from "react";
import {
    collection,
    doc,
    setDoc,
    deleteDoc,
    onSnapshot,
    getDocs,
    serverTimestamp
} from "firebase/firestore";
import {
    FaBookOpen,
    FaPlus,
    FaSearch,
    FaChalkboardTeacher,
    FaLayerGroup,
    FaDoorOpen,
    FaEdit,
    FaTrashAlt,
    FaTimes,
    FaCheckCircle,
    FaGraduationCap,
    FaCalendarCheck,
    FaSyncAlt
} from "react-icons/fa";
import { db } from "../../../firebase";
import "./ManageCourses.css";

export default function ManageCourses() {
    const [courses, setCourses] = useState([]);
    const [lecturers, setLecturers] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [selectedDept, setSelectedDept] = useState("all");
    const [selectedSem, setSelectedSem] = useState("all");

    // Modal state
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingCourse, setEditingCourse] = useState(null);
    const [saving, setSaving] = useState(false);

    // Form fields
    const [formData, setFormData] = useState({
        courseCode: "",
        courseName: "",
        department: "CSE",
        semester: "1",
        credits: "3",
        defaultRoom: "LH-101",
        lecturerEmail: "",
        lecturerName: "",
        batch: "2024",
        description: ""
    });

    // 1. Listen for courses
    useEffect(() => {
        setLoading(true);
        const unsubscribe = onSnapshot(
            collection(db, "courses"),
            (snapshot) => {
                const list = snapshot.docs.map((docSnap) => ({
                    id: docSnap.id,
                    ...docSnap.data()
                }));
                list.sort((a, b) => (a.courseCode || "").localeCompare(b.courseCode || ""));
                setCourses(list);
                setLoading(false);
            },
            (err) => {
                console.error("Error reading courses:", err);
                setLoading(false);
            }
        );

        return () => unsubscribe();
    }, []);

    // 2. Fetch lecturers from authorizedUsers & users
    useEffect(() => {
        const fetchLecturers = async () => {
            try {
                const [authSnap, usersSnap] = await Promise.all([
                    getDocs(collection(db, "authorizedUsers")),
                    getDocs(collection(db, "users"))
                ]);

                const lectMap = new Map();
                authSnap.docs.forEach((d) => {
                    const data = d.data();
                    const email = (d.id || data.email || "").toLowerCase().trim();
                    if (email && email.includes("@")) {
                        lectMap.set(email, {
                            email,
                            name: data.name || email.split("@")[0],
                            department: data.department || "General"
                        });
                    }
                });

                usersSnap.docs.forEach((d) => {
                    const data = d.data();
                    if (data.role === "lecturer") {
                        const email = (data.email || d.id || "").toLowerCase().trim();
                        if (email && email.includes("@")) {
                            lectMap.set(email, {
                                email,
                                name: data.name || lectMap.get(email)?.name || email.split("@")[0],
                                department: data.department || data.branch || lectMap.get(email)?.department || "General"
                            });
                        }
                    }
                });

                setLecturers(Array.from(lectMap.values()));
            } catch (err) {
                console.warn("Error fetching lecturers list:", err);
            }
        };

        fetchLecturers();
    }, []);

    // 3. Fetch sessions to count sessions per course
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

    // Session count map
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

    // Filter courses
    const filteredCourses = useMemo(() => {
        return courses.filter((c) => {
            const term = search.toLowerCase().trim();
            const matchesSearch =
                !term ||
                (c.courseCode || "").toLowerCase().includes(term) ||
                (c.courseName || "").toLowerCase().includes(term) ||
                (c.lecturerName || "").toLowerCase().includes(term) ||
                (c.department || "").toLowerCase().includes(term);

            const matchesDept = selectedDept === "all" || (c.department || "").toUpperCase() === selectedDept.toUpperCase();
            const matchesSem = selectedSem === "all" || String(c.semester || "") === String(selectedSem);

            return matchesSearch && matchesDept && matchesSem;
        });
    }, [courses, search, selectedDept, selectedSem]);

    // Open Modal for Create or Edit
    const handleOpenModal = (course = null) => {
        if (course) {
            setEditingCourse(course);
            setFormData({
                courseCode: course.courseCode || "",
                courseName: course.courseName || "",
                department: course.department || "CSE",
                semester: course.semester || "1",
                credits: course.credits || "3",
                defaultRoom: course.defaultRoom || "LH-101",
                lecturerEmail: course.lecturerEmail || "",
                lecturerName: course.lecturerName || "",
                batch: course.batch || "2024",
                description: course.description || ""
            });
        } else {
            setEditingCourse(null);
            setFormData({
                courseCode: "",
                courseName: "",
                department: "CSE",
                semester: "1",
                credits: "3",
                defaultRoom: "LH-101",
                lecturerEmail: lecturers[0]?.email || "",
                lecturerName: lecturers[0]?.name || "",
                batch: "2024",
                description: ""
            });
        }
        setIsModalOpen(true);
    };

    const handleLecturerSelect = (email) => {
        const found = lecturers.find((l) => l.email === email);
        setFormData((prev) => ({
            ...prev,
            lecturerEmail: email,
            lecturerName: found?.name || email.split("@")[0]
        }));
    };

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
            const courseDocId = editingCourse ? editingCourse.id : code.replace(/[^a-zA-Z0-9_-]/g, "_");
            const docRef = doc(db, "courses", courseDocId);

            const payload = {
                courseCode: code,
                courseName: formData.courseName.trim(),
                department: formData.department,
                semester: formData.semester,
                credits: Number(formData.credits) || 3,
                defaultRoom: formData.defaultRoom.trim() || "LH-101",
                lecturerEmail: formData.lecturerEmail.toLowerCase().trim(),
                lecturerName: formData.lecturerName.trim(),
                batch: formData.batch,
                description: formData.description.trim(),
                updatedAt: Date.now()
            };

            if (!editingCourse) {
                payload.createdAt = Date.now();
            }

            await setDoc(docRef, payload, { merge: true });
            setIsModalOpen(false);
        } catch (err) {
            console.error("Error saving course:", err);
            alert("Failed to save course: " + err.message);
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteCourse = async (course) => {
        if (window.confirm(`Are you sure you want to delete course ${course.courseCode} (${course.courseName})?`)) {
            try {
                await deleteDoc(doc(db, "courses", course.id));
            } catch (err) {
                console.error("Error deleting course:", err);
                alert("Failed to delete course: " + err.message);
            }
        }
    };

    // KPIs
    const totalCourses = courses.length;
    const uniqueDepartments = new Set(courses.map((c) => c.department).filter(Boolean)).size;
    const assignedLecturersCount = new Set(courses.map((c) => c.lecturerEmail).filter(Boolean)).size;
    const totalConducted = Object.values(sessionsPerCourse).reduce((a, b) => a + b, 0);

    return (
        <div className="manage-courses-page">
            {/* Header Banner */}
            <header className="manage-courses-header">
                <div className="manage-courses-title-box">
                    <div className="manage-courses-icon">
                        <FaBookOpen />
                    </div>
                    <div>
                        <h1>Institutional Courses & Curriculum</h1>
                        <p>Create, manage, and assign institutional subjects to faculty members.</p>
                    </div>
                </div>

                <div className="manage-courses-actions">
                    <button
                        className="add-course-btn"
                        onClick={() => handleOpenModal()}
                    >
                        <FaPlus />
                        <span>Add New Course</span>
                    </button>
                </div>
            </header>

            {/* KPI Cards Grid */}
            <section className="courses-kpi-grid">
                <div className="courses-kpi-card">
                    <div className="courses-kpi-icon indigo">
                        <FaBookOpen />
                    </div>
                    <div className="courses-kpi-info">
                        <span className="courses-kpi-label">Active Courses</span>
                        <span className="courses-kpi-val">{loading ? "..." : totalCourses}</span>
                    </div>
                </div>

                <div className="courses-kpi-card">
                    <div className="courses-kpi-icon emerald">
                        <FaChalkboardTeacher />
                    </div>
                    <div className="courses-kpi-info">
                        <span className="courses-kpi-label">Assigned Faculty</span>
                        <span className="courses-kpi-val">{loading ? "..." : assignedLecturersCount}</span>
                    </div>
                </div>

                <div className="courses-kpi-card">
                    <div className="courses-kpi-icon purple">
                        <FaLayerGroup />
                    </div>
                    <div className="courses-kpi-info">
                        <span className="courses-kpi-label">Departments</span>
                        <span className="courses-kpi-val">{loading ? "..." : uniqueDepartments}</span>
                    </div>
                </div>

                <div className="courses-kpi-card">
                    <div className="courses-kpi-icon amber">
                        <FaCalendarCheck />
                    </div>
                    <div className="courses-kpi-info">
                        <span className="courses-kpi-label">Conducted Sessions</span>
                        <span className="courses-kpi-val">{loading ? "..." : totalConducted}</span>
                    </div>
                </div>
            </section>

            {/* Filter and Search Controls */}
            <div className="courses-controls-bar">
                <div className="courses-search-wrapper">
                    <FaSearch className="courses-search-icon" />
                    <input
                        type="text"
                        placeholder="Search by code, subject name, instructor, or department..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="courses-search-input"
                    />
                </div>

                <div className="courses-filter-group">
                    <select
                        value={selectedDept}
                        onChange={(e) => setSelectedDept(e.target.value)}
                        className="courses-filter-select"
                        aria-label="Filter by department"
                    >
                        <option value="all">All Departments</option>
                        <option value="CSE">Computer Science (CSE)</option>
                        <option value="DSAI">Data Science & AI (DSAI)</option>
                        <option value="ECE">Electronics (ECE)</option>
                        <option value="MECH">Mechanical (MECH)</option>
                        <option value="General">General / Basic Science</option>
                    </select>

                    <select
                        value={selectedSem}
                        onChange={(e) => setSelectedSem(e.target.value)}
                        className="courses-filter-select"
                        aria-label="Filter by semester"
                    >
                        <option value="all">All Semesters</option>
                        <option value="1">Semester 1</option>
                        <option value="2">Semester 2</option>
                        <option value="3">Semester 3</option>
                        <option value="4">Semester 4</option>
                        <option value="5">Semester 5</option>
                        <option value="6">Semester 6</option>
                        <option value="7">Semester 7</option>
                        <option value="8">Semester 8</option>
                    </select>
                </div>
            </div>

            {/* Courses Grid */}
            {loading ? (
                <div className="courses-admin-empty">
                    <div className="courses-admin-empty-icon">
                        <FaSyncAlt className="spin" />
                    </div>
                    <h3>Loading Courses...</h3>
                    <p>Fetching institutional subjects and active faculty assignments.</p>
                </div>
            ) : filteredCourses.length === 0 ? (
                <div className="courses-admin-empty">
                    <div className="courses-admin-empty-icon">
                        <FaBookOpen />
                    </div>
                    <h3>No Courses Found</h3>
                    <p>
                        {search || selectedDept !== "all" || selectedSem !== "all"
                            ? "No courses match your active search and filter criteria."
                            : "No courses have been added yet. Click 'Add New Course' to create your first subject."}
                    </p>
                    <button
                        className="add-course-btn"
                        onClick={() => handleOpenModal()}
                    >
                        <FaPlus />
                        <span>Add New Course</span>
                    </button>
                </div>
            ) : (
                <div className="admin-courses-grid">
                    {filteredCourses.map((course) => {
                        const count = sessionsPerCourse[(course.courseCode || "").toUpperCase()] || 0;

                        return (
                            <div className="admin-course-card" key={course.id}>
                                <div className="admin-course-top">
                                    <span className="admin-course-code">{course.courseCode}</span>
                                    <span className="admin-course-dept-badge">
                                        {course.department} • Sem {course.semester}
                                    </span>
                                </div>

                                <div className="admin-course-main">
                                    <h3>{course.courseName}</h3>
                                    {course.description && (
                                        <p className="admin-course-desc">{course.description}</p>
                                    )}
                                </div>

                                <div className="admin-course-details">
                                    <div className="admin-course-detail-row">
                                        <FaChalkboardTeacher />
                                        <span>
                                            Instructor: <strong>{course.lecturerName || "Unassigned"}</strong>
                                        </span>
                                    </div>
                                    <div className="admin-course-detail-row">
                                        <FaDoorOpen />
                                        <span>
                                            Default Hall: <strong>{course.defaultRoom || "LH-101"}</strong>
                                        </span>
                                    </div>
                                    <div className="admin-course-detail-row">
                                        <FaGraduationCap />
                                        <span>
                                            Credits: <strong>{course.credits || 3}</strong> • Batch: <strong>{course.batch || "2024"}</strong>
                                        </span>
                                    </div>
                                </div>

                                <div className="admin-course-footer">
                                    <span className="admin-course-sessions-count">
                                        <FaCalendarCheck /> {count} Session{count !== 1 ? "s" : ""}
                                    </span>

                                    <div className="admin-course-btn-group">
                                        <button
                                            type="button"
                                            className="course-action-icon-btn"
                                            onClick={() => handleOpenModal(course)}
                                            title="Edit Course"
                                            aria-label="Edit Course"
                                        >
                                            <FaEdit />
                                        </button>
                                        <button
                                            type="button"
                                            className="course-action-icon-btn delete"
                                            onClick={() => handleDeleteCourse(course)}
                                            title="Delete Course"
                                            aria-label="Delete Course"
                                        >
                                            <FaTrashAlt />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Add / Edit Course Modal */}
            {isModalOpen && (
                <div
                    className="admin-modal-overlay"
                    onClick={() => !saving && setIsModalOpen(false)}
                >
                    <div
                        className="admin-modal-dialog"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="admin-modal-header">
                            <h3>{editingCourse ? "Edit Course Details" : "Add New Course"}</h3>
                            <button
                                className="admin-modal-close"
                                onClick={() => setIsModalOpen(false)}
                                disabled={saving}
                                aria-label="Close modal"
                            >
                                <FaTimes />
                            </button>
                        </div>

                        <form onSubmit={handleSaveCourse} className="admin-modal-form">
                            <div className="form-row-grid">
                                <div className="form-group">
                                    <label htmlFor="modal-course-code">Course Code *</label>
                                    <input
                                        id="modal-course-code"
                                        type="text"
                                        required
                                        placeholder="e.g. CS301, ECE204"
                                        value={formData.courseCode}
                                        onChange={(e) =>
                                            setFormData({ ...formData, courseCode: e.target.value })
                                        }
                                        disabled={!!editingCourse}
                                    />
                                </div>

                                <div className="form-group">
                                    <label htmlFor="modal-course-dept">Department / Branch</label>
                                    <select
                                        id="modal-course-dept"
                                        value={formData.department}
                                        onChange={(e) =>
                                            setFormData({ ...formData, department: e.target.value })
                                        }
                                    >
                                        <option value="CSE">CSE</option>
                                        <option value="DSAI">DSAI</option>
                                        <option value="ECE">ECE</option>
                                        <option value="MECH">MECH</option>
                                        <option value="General">General</option>
                                    </select>
                                </div>
                            </div>

                            <div className="form-group">
                                <label htmlFor="modal-course-name">Course Title / Name *</label>
                                <input
                                    id="modal-course-name"
                                    type="text"
                                    required
                                    placeholder="e.g. Operating Systems, Computer Networks"
                                    value={formData.courseName}
                                    onChange={(e) =>
                                        setFormData({ ...formData, courseName: e.target.value })
                                    }
                                />
                            </div>

                            <div className="form-row-grid">
                                <div className="form-group">
                                    <label htmlFor="modal-course-sem">Semester</label>
                                    <select
                                        id="modal-course-sem"
                                        value={formData.semester}
                                        onChange={(e) =>
                                            setFormData({ ...formData, semester: e.target.value })
                                        }
                                    >
                                        {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
                                            <option key={s} value={String(s)}>
                                                Semester {s}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div className="form-group">
                                    <label htmlFor="modal-course-credits">Credits</label>
                                    <input
                                        id="modal-course-credits"
                                        type="number"
                                        min="1"
                                        max="10"
                                        value={formData.credits}
                                        onChange={(e) =>
                                            setFormData({ ...formData, credits: e.target.value })
                                        }
                                    />
                                </div>
                            </div>

                            <div className="form-group">
                                <label htmlFor="modal-course-lecturer">Assigned Instructor / Lecturer</label>
                                <select
                                    id="modal-course-lecturer"
                                    value={formData.lecturerEmail}
                                    onChange={(e) => handleLecturerSelect(e.target.value)}
                                >
                                    <option value="">-- Select Instructor --</option>
                                    {lecturers.map((l, i) => (
                                        <option key={i} value={l.email}>
                                            {l.name} ({l.email}) - {l.department}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="form-row-grid">
                                <div className="form-group">
                                    <label htmlFor="modal-course-room">Default Classroom / Lab</label>
                                    <input
                                        id="modal-course-room"
                                        type="text"
                                        placeholder="e.g. LH-101, Lab-2"
                                        value={formData.defaultRoom}
                                        onChange={(e) =>
                                            setFormData({ ...formData, defaultRoom: e.target.value })
                                        }
                                    />
                                </div>

                                <div className="form-group">
                                    <label htmlFor="modal-course-batch">Target Batch Year</label>
                                    <input
                                        id="modal-course-batch"
                                        type="text"
                                        placeholder="e.g. 2024, 2025"
                                        value={formData.batch}
                                        onChange={(e) =>
                                            setFormData({ ...formData, batch: e.target.value })
                                        }
                                    />
                                </div>
                            </div>

                            <div className="form-group">
                                <label htmlFor="modal-course-desc">Course Description / Notes</label>
                                <textarea
                                    id="modal-course-desc"
                                    rows="3"
                                    placeholder="Brief summary of syllabus or prerequisites..."
                                    value={formData.description}
                                    onChange={(e) =>
                                        setFormData({ ...formData, description: e.target.value })
                                    }
                                />
                            </div>

                            <div className="admin-modal-footer">
                                <button
                                    type="button"
                                    className="modal-cancel-btn"
                                    onClick={() => setIsModalOpen(false)}
                                    disabled={saving}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="modal-submit-btn"
                                    disabled={saving}
                                >
                                    {saving
                                        ? "Saving..."
                                        : editingCourse
                                        ? "Update Course"
                                        : "Create Course"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
