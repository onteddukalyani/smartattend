import React, { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
    collection,
    doc,
    setDoc,
    deleteDoc,
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
    FaEdit,
    FaTrashAlt,
    FaTimes,
    FaCheckCircle,
    FaGraduationCap,
    FaCalendarCheck,
    FaSyncAlt,
    FaUsers,
    FaClock,
    FaUserCheck,
    FaInfoCircle,
    FaArrowRight,
    FaChevronDown,
    FaChevronUp,
    FaIdCard,
    FaEnvelope,
    FaCalendarAlt,
    FaQrcode
} from "react-icons/fa";
import { db } from "../../../firebase";
import { mergeAllStudentRecords } from "../../../utils/studentDataHelper";
import "./ManageCourses.css";

export function normalizeCode(str) {
    if (!str) return "";
    return String(str).toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
}

export function parseTimestampMillis(ts) {
    if (!ts) return 0;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") {
        const parsed = Date.parse(ts);
        return isNaN(parsed) ? 0 : parsed;
    }
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.toDate === "function") return ts.toDate().getTime();
    if (typeof ts.seconds === "number") return ts.seconds * 1000 + (ts.nanoseconds ? Math.floor(ts.nanoseconds / 1000000) : 0);
    if (ts._seconds) return ts._seconds * 1000;
    return 0;
}

export function formatTimestamp(ts, options = { dateStyle: "medium", timeStyle: "short" }) {
    const millis = parseTimestampMillis(ts);
    if (!millis) return "—";
    return new Date(millis).toLocaleString(undefined, options);
}

export default function ManageCourses() {
    const navigate = useNavigate();
    const [courses, setCourses] = useState([]);
    const [lecturers, setLecturers] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [records, setRecords] = useState([]);
    const [allStudents, setAllStudents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [selectedDept, setSelectedDept] = useState("all");
    const [selectedSem, setSelectedSem] = useState("all");

    // Add / Edit Form Modal state
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingCourse, setEditingCourse] = useState(null);
    const [saving, setSaving] = useState(false);

    // Course Full Details & Recent Sessions Modal state
    const [selectedCourseDetails, setSelectedCourseDetails] = useState(null);
    const [detailTab, setDetailTab] = useState("sessions"); // "sessions" | "students" | "info"
    const [expandedSessionId, setExpandedSessionId] = useState(null);
    const [studentSearchTerm, setStudentSearchTerm] = useState("");

    // Form fields
    const [formData, setFormData] = useState({
        courseCode: "",
        courseName: "",
        department: "CSE",
        semester: "1",
        credits: "3",
        defaultRoom: "L-105",
        lecturerEmail: "",
        lecturerName: "",
        batch: "2025",
        description: ""
    });

    // 1. Listen for courses in real time
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

    // 2. Fetch lecturers from lecturers, authorizedUsers & users
    useEffect(() => {
        const fetchLecturers = async () => {
            try {
                const [lecturersSnap, authSnap, usersSnap] = await Promise.all([
                    getDocs(collection(db, "lecturers")).catch((e) => {
                        console.warn("Could not read lecturers:", e);
                        return { docs: [] };
                    }),
                    getDocs(collection(db, "authorizedUsers")).catch((e) => {
                        console.warn("Could not read authorizedUsers:", e);
                        return { docs: [] };
                    }),
                    getDocs(collection(db, "users")).catch((e) => {
                        console.warn("Could not read users:", e);
                        return { docs: [] };
                    })
                ]);

                const lectMap = new Map();

                // Ingest faculty from lecturers collection
                lecturersSnap.docs.forEach((d) => {
                    const data = d.data();
                    const email = (data.email || (d.id.includes("@") ? d.id : "")).toLowerCase().trim();
                    if (email && email.includes("@")) {
                        lectMap.set(email, {
                            email,
                            name: data.name || (email ? email.split("@")[0] : "Lecturer"),
                            department: (data.department && String(data.department).toLowerCase() !== "general") ? data.department : ((data.branch && String(data.branch).toLowerCase() !== "general") ? data.branch : "CSE")
                        });
                    }
                });

                // Ingest authorized faculty from authorizedUsers collection
                authSnap.docs.forEach((d) => {
                    const data = d.data();
                    const role = String(data.role || "").toLowerCase().trim();
                    const isFaculty = role === "lecturer" || role === "faculty" || role === "professor" || data.isFaculty === true;

                    if (isFaculty) {
                        const email = (data.email || (d.id.includes("@") ? d.id : "")).toLowerCase().trim();
                        if (email && email.includes("@")) {
                            const existing = lectMap.get(email) || {};
                            lectMap.set(email, {
                                email,
                                name: data.name || existing.name || (email ? email.split("@")[0] : "Lecturer"),
                                department: (data.department && String(data.department).toLowerCase() !== "general") ? data.department : ((data.branch && String(data.branch).toLowerCase() !== "general") ? data.branch : ((existing.department && String(existing.department).toLowerCase() !== "general") ? existing.department : "CSE"))
                            });
                        }
                    }
                });

                // Ingest faculty from users collection
                usersSnap.docs.forEach((d) => {
                    const data = d.data();
                    const role = String(data.role || "").toLowerCase().trim();
                    const isFaculty = role === "lecturer" || role === "faculty" || role === "professor" || data.isFaculty === true;
                    const isStudent = role === "student" || Boolean(data.rollNo) || /^\d{2}[a-zA-Z]{3}\d{2,4}$/i.test(d.id);
                    const isAdmin = role === "admin" || role === "superadmin";

                    if (isFaculty && !isStudent && !isAdmin) {
                        const email = (data.email || (d.id.includes("@") ? d.id : "")).toLowerCase().trim();
                        if (email && email.includes("@")) {
                            const existing = lectMap.get(email) || {};
                            lectMap.set(email, {
                                email,
                                name: data.name || existing.name || (email ? email.split("@")[0] : "Lecturer"),
                                department: (data.department && String(data.department).toLowerCase() !== "general") ? data.department : ((data.branch && String(data.branch).toLowerCase() !== "general") ? data.branch : ((existing.department && String(existing.department).toLowerCase() !== "general") ? existing.department : "CSE"))
                            });
                        }
                    }
                });

                const sortedLecturers = Array.from(lectMap.values()).sort((a, b) =>
                    (a.name || "").localeCompare(b.name || "")
                );

                setLecturers(sortedLecturers);
            } catch (err) {
                console.warn("Error fetching lecturers list:", err);
            }
        };

        fetchLecturers();
    }, []);

    // 3. Real-time Sessions listener
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

    // 4. Real-time Attendance Records listener
    useEffect(() => {
        const unsubscribe = onSnapshot(
            collection(db, "attendance_records"),
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({
                    id: d.id,
                    ...d.data()
                }));
                setRecords(list);
            },
            (err) => console.warn("Attendance records read error:", err)
        );

        return () => unsubscribe();
    }, []);

    // 5. Real-time Students Catalog listener
    useEffect(() => {
        let authDocs = [];
        let studentsDocs = [];
        let usersDocs = [];

        const recomputeStudents = () => {
            const canonicalList = mergeAllStudentRecords(authDocs, studentsDocs, usersDocs);
            const mapped = canonicalList.map((s) => ({
                id: s.id || s.rollNo,
                rollNo: s.rollNo,
                name: s.name || s.rollNo,
                email: s.email || "",
                department: s.branch || "CSE",
                branch: s.branch || "CSE",
                semester: s.semester || "1",
                batch: s.batch || "2025",
                hasFace: Boolean(s.faceRegistered || s.biometricEnrolled),
                photoURL: s.photoURL || ""
            }));
            setAllStudents(mapped);
        };

        const unsubAuth = onSnapshot(collection(db, "authorizedUsers"), (snap) => {
            authDocs = snap.docs;
            recomputeStudents();
        }, (err) => console.warn("authorizedUsers snapshot error:", err));

        const unsubStudents = onSnapshot(collection(db, "students"), (snap) => {
            studentsDocs = snap.docs;
            recomputeStudents();
        }, (err) => console.warn("students snapshot error:", err));

        const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
            usersDocs = snap.docs;
            recomputeStudents();
        }, (err) => console.warn("users snapshot error:", err));

        return () => {
            unsubAuth();
            unsubStudents();
            unsubUsers();
        };
    }, []);

    // Session count per course map with robust multi-field matching
    const sessionsPerCourse = useMemo(() => {
        const map = {};
        courses.forEach((c) => {
            const normCode = normalizeCode(c.courseCode || c.id);
            const normName = normalizeCode(c.courseName);
            const cIdNorm = normalizeCode(c.id);

            const count = sessions.filter((s) => {
                const sCodeNorm = normalizeCode(s.courseCode || s.classCode);
                const sCourseIdNorm = normalizeCode(s.courseId);
                const sNameNorm = normalizeCode(s.courseName || s.topic);
                const sIdNorm = normalizeCode(s.id);

                if (normCode && sCodeNorm === normCode) return true;
                if (normCode && sCourseIdNorm === normCode) return true;
                if (cIdNorm && sCourseIdNorm === cIdNorm) return true;
                if (normCode && sIdNorm.startsWith(normCode)) return true;
                if (normName && sNameNorm === normName) return true;

                // Check records in this session
                return records.some((r) => {
                    const rSessId = String(r.sessionId || "").trim().toUpperCase();
                    const rCodeNorm = normalizeCode(r.courseCode || r.classCode);
                    return rSessId === String(s.id).toUpperCase() && normCode && rCodeNorm === normCode;
                });
            }).length;

            const cleanCode = (c.courseCode || "").toUpperCase();
            if (cleanCode) map[cleanCode] = count;
            if (c.id) map[c.id.toUpperCase()] = count;
        });
        return map;
    }, [courses, sessions, records]);

    // Filter courses
    const filteredCourses = useMemo(() => {
        return courses.filter((c) => {
            const term = search.toLowerCase().trim();
            const matchesSearch =
                !term ||
                (c.courseCode || "").toLowerCase().includes(term) ||
                (c.courseName || "").toLowerCase().includes(term) ||
                (c.lecturerName || "").toLowerCase().includes(term) ||
                (c.lecturerEmail || "").toLowerCase().includes(term) ||
                (c.department || "").toLowerCase().includes(term);

            const matchesDept = selectedDept === "all" || (c.department || "").toUpperCase() === selectedDept.toUpperCase();
            const matchesSem = selectedSem === "all" || String(c.semester || "") === String(selectedSem);

            return matchesSearch && matchesDept && matchesSem;
        });
    }, [courses, search, selectedDept, selectedSem]);

    // Open Modal for Create or Edit
    const handleOpenModal = (course = null, e = null) => {
        if (e) e.stopPropagation();
        if (course) {
            setEditingCourse(course);
            setFormData({
                courseCode: course.courseCode || "",
                courseName: course.courseName || "",
                department: course.department || "CSE",
                semester: course.semester || "1",
                credits: course.credits || "3",
                defaultRoom: course.defaultRoom || "L-105",
                lecturerEmail: course.lecturerEmail || "",
                lecturerName: course.lecturerName || "",
                batch: course.batch || "2025",
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
                defaultRoom: "L-105",
                lecturerEmail: "",
                lecturerName: "",
                batch: "2025",
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
            lecturerName: found ? found.name : ""
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
                defaultRoom: formData.defaultRoom.trim() || "L-105",
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

            // If this course is currently open in details modal, update it
            if (selectedCourseDetails && selectedCourseDetails.id === courseDocId) {
                setSelectedCourseDetails((prev) => ({ ...prev, ...payload }));
            }

            setIsModalOpen(false);
        } catch (err) {
            console.error("Error saving course:", err);
            alert("Failed to save course: " + err.message);
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteCourse = async (course, e = null) => {
        if (e) e.stopPropagation();
        if (window.confirm(`Are you sure you want to delete course ${course.courseCode} (${course.courseName})?`)) {
            try {
                await deleteDoc(doc(db, "courses", course.id));
                if (selectedCourseDetails && selectedCourseDetails.id === course.id) {
                    setSelectedCourseDetails(null);
                }
            } catch (err) {
                console.error("Error deleting course:", err);
                alert("Failed to delete course: " + err.message);
            }
        }
    };

    // Deep Analysis for Selected Course in Details Modal (Full Complete Data)
    const courseDetailsData = useMemo(() => {
        if (!selectedCourseDetails) return null;

        const normCode = normalizeCode(selectedCourseDetails.courseCode || selectedCourseDetails.id);
        const normName = normalizeCode(selectedCourseDetails.courseName);
        const normId = normalizeCode(selectedCourseDetails.id);
        const deptUpper = (selectedCourseDetails.department || "").toUpperCase().trim();
        const semStr = String(selectedCourseDetails.semester || "").trim();

        // 1. Relevant Sessions (multi-field matching + safe timestamp sort)
        const courseSessions = sessions.filter((s) => {
            const sCodeNorm = normalizeCode(s.courseCode || s.classCode);
            const sCourseIdNorm = normalizeCode(s.courseId);
            const sNameNorm = normalizeCode(s.courseName || s.topic);
            const sIdNorm = normalizeCode(s.id);

            if (normCode && sCodeNorm === normCode) return true;
            if (normCode && sCourseIdNorm === normCode) return true;
            if (normId && sCourseIdNorm === normId) return true;
            if (normCode && sIdNorm.startsWith(normCode)) return true;
            if (normName && sNameNorm === normName) return true;

            return records.some((r) => {
                const rSessId = String(r.sessionId || "").trim().toUpperCase();
                const rCodeNorm = normalizeCode(r.courseCode || r.classCode);
                return rSessId === String(s.id).toUpperCase() && normCode && rCodeNorm === normCode;
            });
        }).sort((a, b) => parseTimestampMillis(b.createdAt) - parseTimestampMillis(a.createdAt));

        const sessionIdsSet = new Set(courseSessions.map((s) => s.id));

        // 2. Relevant Records
        const courseRecords = records.filter((r) => {
            const rCodeNorm = normalizeCode(r.courseCode || r.classCode);
            return (r.sessionId && sessionIdsSet.has(r.sessionId)) ||
                   (normCode && rCodeNorm === normCode) ||
                   (r.id && Array.from(sessionIdsSet).some((sid) => r.id.startsWith(`${sid}_`)));
        });

        // 3. Map attendees by Session ID (combining attendance_records AND embedded session.attendees)
        const attendeesBySession = new Map();
        courseSessions.forEach((s) => {
            const list = [];
            const seenRolls = new Set();

            // From records collection
            courseRecords.forEach((r) => {
                if (r.sessionId === s.id || (r.id && r.id.startsWith(`${s.id}_`))) {
                    const roll = (r.rollNo || r.studentRoll || "").trim().toUpperCase();
                    if (roll && !seenRolls.has(roll)) {
                        seenRolls.add(roll);
                        list.push({
                            id: r.id || `${s.id}_${roll}`,
                            rollNo: roll,
                            studentName: r.studentName || r.name || roll,
                            studentEmail: r.studentEmail || r.email || "",
                            submittedAt: r.submittedAt || s.createdAt,
                            faceVerified: r.faceVerified ?? true
                        });
                    }
                }
            });

            // From embedded attendees array on session doc
            if (Array.isArray(s.attendees)) {
                s.attendees.forEach((att, idx) => {
                    const roll = (att.rollNo || att.roll || att.studentId || "").trim().toUpperCase();
                    if (roll && !seenRolls.has(roll)) {
                        seenRolls.add(roll);
                        list.push({
                            id: att.id || `${s.id}_${roll || idx}`,
                            rollNo: roll || "—",
                            studentName: att.fullName || att.name || att.studentName || "Student",
                            studentEmail: att.studentEmail || att.email || "",
                            submittedAt: att.submittedAt || att.timestamp || s.createdAt,
                            faceVerified: att.faceVerified ?? true
                        });
                    }
                });
            }

            list.sort((a, b) => a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true }));
            attendeesBySession.set(s.id, list);
        });

        // 4. Map Course Attendees strictly (only students who have attendance in this course or explicit course enrollment)
        const studentRegisterMap = new Map();

        // If the course document itself has an explicit enrolledStudents list:
        if (Array.isArray(selectedCourseDetails.enrolledStudents)) {
            selectedCourseDetails.enrolledStudents.forEach((enrolled) => {
                const roll = (typeof enrolled === "string" ? enrolled : (enrolled?.rollNo || enrolled?.id || "")).toUpperCase().trim();
                if (roll) {
                    const matchedSt = allStudents.find((s) => (s.rollNo || "").toUpperCase() === roll);
                    studentRegisterMap.set(roll, {
                        rollNo: roll,
                        name: matchedSt?.name || enrolled?.name || roll,
                        department: matchedSt?.department || deptUpper || "CSE",
                        semester: matchedSt?.semester || semStr || "1",
                        email: matchedSt?.email || "",
                        attendedCount: 0,
                        lastAttended: null,
                        hasFace: matchedSt ? matchedSt.hasFace : false
                    });
                }
            });
        }

        // Calculate attended count for every student who attended sessions for this course
        courseSessions.forEach((s) => {
            const sessionAtts = attendeesBySession.get(s.id) || [];
            sessionAtts.forEach((att) => {
                const roll = (att.rollNo || "").toUpperCase().trim();
                if (roll && roll !== "—") {
                    if (!studentRegisterMap.has(roll)) {
                        const matchedSt = allStudents.find((s) => (s.rollNo || "").toUpperCase() === roll);
                        studentRegisterMap.set(roll, {
                            rollNo: roll,
                            name: att.studentName || matchedSt?.name || roll,
                            department: matchedSt?.department || deptUpper || "CSE",
                            semester: matchedSt?.semester || semStr || "1",
                            email: att.studentEmail || matchedSt?.email || "",
                            attendedCount: 0,
                            lastAttended: null,
                            hasFace: matchedSt ? matchedSt.hasFace : (att.faceVerified ?? true)
                        });
                    }
                    const entry = studentRegisterMap.get(roll);
                    entry.attendedCount += 1;
                    const subTime = parseTimestampMillis(att.submittedAt);
                    if (subTime && (!entry.lastAttended || subTime > parseTimestampMillis(entry.lastAttended))) {
                        entry.lastAttended = subTime;
                    }
                }
            });
        });

        const studentsList = Array.from(studentRegisterMap.values()).sort((a, b) =>
            b.attendedCount - a.attendedCount || a.rollNo.localeCompare(b.rollNo)
        );

        const totalConductedCount = courseSessions.length;
        const totalAttendancesCount = Array.from(attendeesBySession.values()).reduce((acc, list) => acc + list.length, 0);
        const avgAttendeesPerSession = totalConductedCount > 0 ? (totalAttendancesCount / totalConductedCount).toFixed(1) : "0";
        const uniqueStudentsCount = studentRegisterMap.size;

        return {
            courseSessions,
            courseRecords,
            attendeesBySession,
            studentsList,
            totalConductedCount,
            totalAttendancesCount,
            avgAttendeesPerSession,
            uniqueStudentsCount
        };
    }, [selectedCourseDetails, sessions, records, allStudents]);

    // Filter students inside modal
    const filteredModalStudents = useMemo(() => {
        if (!courseDetailsData) return [];
        const term = studentSearchTerm.toLowerCase().trim();
        if (!term) return courseDetailsData.studentsList;
        return courseDetailsData.studentsList.filter(
            (s) => s.rollNo.toLowerCase().includes(term) || s.name.toLowerCase().includes(term)
        );
    }, [courseDetailsData, studentSearchTerm]);

    // KPIs for top page
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
                        <h1>Institutional Courses &amp; Curriculum</h1>
                        <p>Create, manage, and click any course to inspect real-time sessions and student attendance.</p>
                    </div>
                </div>

                <div className="manage-courses-actions">
                    <button
                        type="button"
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
                    {search && (
                        <button
                            type="button"
                            className="courses-search-clear"
                            onClick={() => setSearch("")}
                            title="Clear search"
                        >
                            <FaTimes />
                        </button>
                    )}
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
                        <option value="DSAI">Data Science &amp; AI (DSAI)</option>
                        <option value="ECE">Electronics (ECE)</option>
                        <option value="AIC">AI and Computing</option>
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
                        type="button"
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
                            <div
                                className="admin-course-card interactive"
                                key={course.id}
                                onClick={() => {
                                    setSelectedCourseDetails(course);
                                    setDetailTab("sessions");
                                    setExpandedSessionId(null);
                                    setStudentSearchTerm("");
                                }}
                                role="button"
                                tabIndex={0}
                                title="Click to view full course details & recent sessions"
                            >
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
                                            Default Hall: <strong>{course.defaultRoom || "L-106"}</strong>
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

                                    <div className="admin-course-btn-group" onClick={(e) => e.stopPropagation()}>
                                        <button
                                            type="button"
                                            className="course-action-icon-btn"
                                            onClick={(e) => handleOpenModal(course, e)}
                                            title="Edit Course"
                                            aria-label="Edit Course"
                                        >
                                            <FaEdit />
                                        </button>
                                        <button
                                            type="button"
                                            className="course-action-icon-btn delete"
                                            onClick={(e) => handleDeleteCourse(course, e)}
                                            title="Delete Course"
                                            aria-label="Delete Course"
                                        >
                                            <FaTrashAlt />
                                        </button>
                                    </div>
                                </div>

                                <div className="admin-course-card-hint">
                                    <span>View Details &amp; Attendance Sessions <FaArrowRight /></span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* =========================================================
                COURSE FULL DETAILS & RECENT SESSIONS MODAL
               ========================================================= */}
            {selectedCourseDetails && courseDetailsData && (
                <div
                    className="course-details-modal-backdrop"
                    onClick={() => setSelectedCourseDetails(null)}
                >
                    <div
                        className="course-details-modal-card"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Modal Hero Header */}
                        <div className="cd-modal-header">
                            <div className="cd-modal-header-left">
                                <div className="cd-modal-tags">
                                    <span className="cd-code-badge">{selectedCourseDetails.courseCode}</span>
                                    <span className="cd-dept-badge">{selectedCourseDetails.department}</span>
                                    <span className="cd-sem-badge">Semester {selectedCourseDetails.semester}</span>
                                    {selectedCourseDetails.batch && (
                                        <span className="cd-batch-badge">Batch {selectedCourseDetails.batch}</span>
                                    )}
                                </div>
                                <h2 className="cd-modal-title">{selectedCourseDetails.courseName}</h2>
                                <div className="cd-modal-meta-row">
                                    <span>
                                        <FaChalkboardTeacher /> {selectedCourseDetails.lecturerName || "Assigned Faculty"}
                                    </span>
                                    <span>
                                        <FaDoorOpen /> Room {selectedCourseDetails.defaultRoom || "Main Hall"}
                                    </span>
                                    <span>
                                        <FaLayerGroup /> {selectedCourseDetails.credits || 3} Credits
                                    </span>
                                </div>
                            </div>

                            <button
                                type="button"
                                className="cd-modal-close"
                                onClick={() => setSelectedCourseDetails(null)}
                                aria-label="Close modal"
                            >
                                <FaTimes />
                            </button>
                        </div>

                        {/* 4 Metric Cards Strip */}
                        <div className="cd-modal-stats-strip">
                            <div className="cd-stat-card card-indigo">
                                <div className="cd-stat-icon">
                                    <FaCalendarCheck />
                                </div>
                                <div className="cd-stat-info">
                                    <span className="cd-stat-label">Conducted Sessions</span>
                                    <strong className="cd-stat-number">{courseDetailsData.totalConductedCount}</strong>
                                    <span className="cd-stat-sub">Class sessions</span>
                                </div>
                            </div>

                            <div className="cd-stat-card card-emerald">
                                <div className="cd-stat-icon">
                                    <FaUserCheck />
                                </div>
                                <div className="cd-stat-info">
                                    <span className="cd-stat-label">Total Attendances</span>
                                    <strong className="cd-stat-number text-emerald">{courseDetailsData.totalAttendancesCount}</strong>
                                    <span className="cd-stat-sub">Logged records</span>
                                </div>
                            </div>

                            <div className="cd-stat-card card-sky">
                                <div className="cd-stat-icon">
                                    <FaUsers />
                                </div>
                                <div className="cd-stat-info">
                                    <span className="cd-stat-label">Avg Attendance / Class</span>
                                    <strong className="cd-stat-number text-sky">{courseDetailsData.avgAttendeesPerSession}</strong>
                                    <span className="cd-stat-sub">Students per session</span>
                                </div>
                            </div>

                            <div className="cd-stat-card card-purple">
                                <div className="cd-stat-icon">
                                    <FaGraduationCap />
                                </div>
                                <div className="cd-stat-info">
                                    <span className="cd-stat-label">Course Attendees</span>
                                    <strong className="cd-stat-number text-purple">{courseDetailsData.uniqueStudentsCount}</strong>
                                    <span className="cd-stat-sub">Active attendees</span>
                                </div>
                            </div>
                        </div>

                        {/* Modal Navigation Tabs */}
                        <div className="cd-modal-tabs-bar">
                            <button
                                type="button"
                                className={`cd-tab-btn ${detailTab === "sessions" ? "active" : ""}`}
                                onClick={() => setDetailTab("sessions")}
                            >
                                <FaCalendarCheck />
                                <span>Recent Sessions ({courseDetailsData.totalConductedCount})</span>
                            </button>

                            <button
                                type="button"
                                className={`cd-tab-btn ${detailTab === "students" ? "active" : ""}`}
                                onClick={() => setDetailTab("students")}
                            >
                                <FaUsers />
                                <span>Course Attendees ({courseDetailsData.uniqueStudentsCount})</span>
                            </button>

                            <button
                                type="button"
                                className={`cd-tab-btn ${detailTab === "info" ? "active" : ""}`}
                                onClick={() => setDetailTab("info")}
                            >
                                <FaInfoCircle />
                                <span>Course &amp; Syllabus Details</span>
                            </button>
                        </div>

                        {/* Modal Body Content */}
                        <div className="cd-modal-body">
                            {/* TAB 1: RECENT SESSIONS & ATTENDANCE LOGS */}
                            {detailTab === "sessions" && (
                                <div className="cd-tab-content">
                                    {courseDetailsData.courseSessions.length === 0 ? (
                                        <div className="cd-empty-state">
                                            <div className="cd-empty-icon">
                                                <FaCalendarAlt />
                                            </div>
                                            <h4>No Sessions Conducted Yet</h4>
                                            <p>
                                                Faculty members have not generated QR attendance sessions for this subject yet.
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="cd-sessions-list">
                                            {courseDetailsData.courseSessions.map((session, idx) => {
                                                const attendees = courseDetailsData.attendeesBySession.get(session.id) || [];
                                                const attendeeCount = attendees.length;
                                                const isExpanded = expandedSessionId === session.id;
                                                const timeFormatted = formatTimestamp(session.createdAt);
                                                const isLive = session.status === "active";

                                                return (
                                                    <div
                                                        key={session.id || idx}
                                                        className={`cd-session-card ${isExpanded ? "expanded" : ""}`}
                                                    >
                                                        <div
                                                            className="cd-session-header-row"
                                                            onClick={() => setExpandedSessionId(isExpanded ? null : session.id)}
                                                        >
                                                            <div className="cd-session-main-info">
                                                                <div className="cd-session-icon-box">
                                                                    <FaQrcode />
                                                                </div>
                                                                <div>
                                                                    <div className="cd-session-title-line">
                                                                        <strong>
                                                                            {session.topic || session.classCode || selectedCourseDetails.courseCode}
                                                                        </strong>
                                                                        {isLive ? (
                                                                            <span className="cd-status-live">
                                                                                <span className="live-dot"></span> Active Session
                                                                            </span>
                                                                        ) : (
                                                                            <span className="cd-status-ended">Completed</span>
                                                                        )}
                                                                    </div>
                                                                    <div className="cd-session-sub-line">
                                                                        <span>
                                                                            <FaClock /> {timeFormatted}
                                                                        </span>
                                                                        <span>
                                                                            <FaDoorOpen /> Room {session.roomNo || selectedCourseDetails.defaultRoom || "N/A"}
                                                                        </span>
                                                                        {session.facultyName && (
                                                                            <span>
                                                                                <FaChalkboardTeacher /> {session.facultyName}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>

                                                            <div className="cd-session-actions-right">
                                                                <div className="cd-attendees-pill">
                                                                    <FaUserCheck />
                                                                    <span>{attendeeCount} Present</span>
                                                                </div>
                                                                <button
                                                                    type="button"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        navigate(`/admin/classes/${session.id}`);
                                                                    }}
                                                                    title="Open full class session attendance record"
                                                                    style={{
                                                                        display: "inline-flex",
                                                                        alignItems: "center",
                                                                        gap: "5px",
                                                                        fontSize: "0.78rem",
                                                                        fontWeight: 700,
                                                                        padding: "5px 10px",
                                                                        borderRadius: "8px",
                                                                        background: "rgba(99, 102, 241, 0.1)",
                                                                        color: "#4f46e5",
                                                                        border: "1px solid rgba(99, 102, 241, 0.2)",
                                                                        cursor: "pointer"
                                                                    }}
                                                                >
                                                                    <FaArrowRight /> Class
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    className="cd-expand-btn"
                                                                    aria-label="Toggle student attendees list"
                                                                >
                                                                    {isExpanded ? <FaChevronUp /> : <FaChevronDown />}
                                                                </button>
                                                            </div>
                                                        </div>

                                                        {/* Expanded Student Attendees List */}
                                                        {isExpanded && (
                                                            <div className="cd-session-attendees-drawer">
                                                                <div className="cd-drawer-header">
                                                                    <h5>Students Attended in this Session ({attendeeCount})</h5>
                                                                </div>
                                                                {attendeeCount === 0 ? (
                                                                    <div className="cd-drawer-empty">
                                                                        <FaInfoCircle /> No student attendance recorded in this specific session.
                                                                    </div>
                                                                ) : (
                                                                    <div className="cd-drawer-students-grid">
                                                                        {attendees.map((rec, rIdx) => (
                                                                            <div key={rec.id || rIdx} className="cd-drawer-student-chip">
                                                                                <div className="cd-chip-avatar">
                                                                                    {(rec.studentName || rec.rollNo || "S").charAt(0).toUpperCase()}
                                                                                </div>
                                                                                <div className="cd-chip-text">
                                                                                    <strong className="cd-chip-roll">{rec.rollNo || "N/A"}</strong>
                                                                                    <span className="cd-chip-name">{rec.studentName || "Student"}</span>
                                                                                </div>
                                                                                <span className="cd-chip-verified">
                                                                                    <FaCheckCircle />
                                                                                </span>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* TAB 2: STUDENT ATTENDANCE REGISTER */}
                            {detailTab === "students" && (
                                <div className="cd-tab-content">
                                    <div className="cd-students-toolbar">
                                        <div className="cd-student-search-box">
                                            <FaSearch />
                                            <input
                                                type="text"
                                                placeholder="Search student by name or roll number..."
                                                value={studentSearchTerm}
                                                onChange={(e) => setStudentSearchTerm(e.target.value)}
                                            />
                                            {studentSearchTerm && (
                                                <button
                                                    type="button"
                                                    className="cd-clear-btn"
                                                    onClick={() => setStudentSearchTerm("")}
                                                >
                                                    <FaTimes />
                                                </button>
                                            )}
                                        </div>
                                        <span className="cd-students-count-badge">
                                            {filteredModalStudents.length} Course Attendees
                                        </span>
                                    </div>

                                    {filteredModalStudents.length === 0 ? (
                                        <div className="cd-empty-state">
                                            <div className="cd-empty-icon">
                                                <FaUsers />
                                            </div>
                                            <h4>No Course Attendees Yet</h4>
                                            <p>
                                                {studentSearchTerm
                                                    ? `No attendees match "${studentSearchTerm}".`
                                                    : "No student attendance records recorded for this course yet."}
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="cd-students-table-wrap">
                                            <table className="cd-students-table">
                                                <thead>
                                                    <tr>
                                                        <th>Student Roll No</th>
                                                        <th>Student Name</th>
                                                        <th>Department &amp; Sem</th>
                                                        <th>Sessions Attended</th>
                                                        <th>Attendance %</th>
                                                        <th>Last Attendance</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {filteredModalStudents.map((st) => {
                                                        const totalSes = courseDetailsData.totalConductedCount || 1;
                                                        const pct = courseDetailsData.totalConductedCount > 0
                                                            ? Math.round((st.attendedCount / courseDetailsData.totalConductedCount) * 100)
                                                            : (st.attendedCount > 0 ? 100 : 0);
                                                        const isSafe = pct >= 75;
                                                        const lastStr = st.lastAttended
                                                            ? formatTimestamp(st.lastAttended, { dateStyle: "medium" })
                                                            : (st.attendedCount > 0 ? "Recorded" : "Never");

                                                        return (
                                                            <tr key={st.rollNo}>
                                                                <td>
                                                                    <div className="cd-student-roll-cell">
                                                                        <FaIdCard className="cd-roll-icon" />
                                                                        <strong>{st.rollNo}</strong>
                                                                    </div>
                                                                </td>
                                                                <td>
                                                                    <span className="cd-student-name">{st.name}</span>
                                                                </td>
                                                                <td>
                                                                    <span className="cd-student-dept-tag">
                                                                        {st.department || selectedCourseDetails.department} • Sem {st.semester || selectedCourseDetails.semester}
                                                                    </span>
                                                                </td>
                                                                <td>
                                                                    <span className="cd-attended-badge">
                                                                        <strong>{st.attendedCount}</strong> / {courseDetailsData.totalConductedCount}
                                                                    </span>
                                                                </td>
                                                                <td>
                                                                    <span className={`cd-pct-pill ${isSafe ? "safe" : pct === 0 ? "zero" : "danger"}`}>
                                                                        {pct}% {isSafe ? "Safe" : "Shortage"}
                                                                    </span>
                                                                </td>
                                                                <td>
                                                                    <span className="cd-last-date">{lastStr}</span>
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* TAB 3: COURSE SYLLABUS & INFO */}
                            {detailTab === "info" && (
                                <div className="cd-tab-content">
                                    <div className="cd-info-grid">
                                        <div className="cd-info-card">
                                            <h4><FaBookOpen /> Course Description &amp; Syllabus</h4>
                                            <p className="cd-info-desc">
                                                {selectedCourseDetails.description || "No description or syllabus overview provided for this course."}
                                            </p>
                                        </div>

                                        <div className="cd-info-card">
                                            <h4><FaChalkboardTeacher /> Faculty Assignment</h4>
                                            <div className="cd-faculty-details">
                                                <div className="cd-faculty-avatar">
                                                    {(selectedCourseDetails.lecturerName || "L").charAt(0).toUpperCase()}
                                                </div>
                                                <div className="cd-faculty-text">
                                                    <strong>{selectedCourseDetails.lecturerName || "Unassigned Faculty"}</strong>
                                                    {selectedCourseDetails.lecturerEmail && (
                                                        <span><FaEnvelope /> {selectedCourseDetails.lecturerEmail}</span>
                                                    )}
                                                    <span>Department: {selectedCourseDetails.department}</span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="cd-info-card">
                                            <h4><FaLayerGroup /> Academic Specifications</h4>
                                            <div className="cd-specs-list">
                                                <div className="cd-spec-row">
                                                    <span>Course Code</span>
                                                    <strong>{selectedCourseDetails.courseCode}</strong>
                                                </div>
                                                <div className="cd-spec-row">
                                                    <span>Department</span>
                                                    <strong>{selectedCourseDetails.department}</strong>
                                                </div>
                                                <div className="cd-spec-row">
                                                    <span>Academic Semester</span>
                                                    <strong>Semester {selectedCourseDetails.semester}</strong>
                                                </div>
                                                <div className="cd-spec-row">
                                                    <span>Credit Units</span>
                                                    <strong>{selectedCourseDetails.credits || 3} Credits</strong>
                                                </div>
                                                <div className="cd-spec-row">
                                                    <span>Default Lecture Hall</span>
                                                    <strong>{selectedCourseDetails.defaultRoom || "L-105"}</strong>
                                                </div>
                                                <div className="cd-spec-row">
                                                    <span>Academic Batch</span>
                                                    <strong>{selectedCourseDetails.batch || "2025"}</strong>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Modal Footer */}
                        <div className="cd-modal-footer">
                            <button
                                type="button"
                                className="cd-btn cd-btn-secondary"
                                onClick={() => setSelectedCourseDetails(null)}
                            >
                                Close
                            </button>
                            <button
                                type="button"
                                className="cd-btn cd-btn-primary"
                                onClick={() => {
                                    const c = selectedCourseDetails;
                                    setSelectedCourseDetails(null);
                                    handleOpenModal(c);
                                }}
                            >
                                <FaEdit /> Edit Course Details
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Add / Edit Course Form Modal */}
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
                                type="button"
                                className="admin-modal-close"
                                onClick={() => setIsModalOpen(false)}
                                disabled={saving}
                                aria-label="Close modal"
                            >
                                <FaTimes />
                            </button>
                        </div>

                        <form onSubmit={handleSaveCourse} className="admin-course-form">
                            <div className="form-row-2">
                                <div className="form-group">
                                    <label>Course Code *</label>
                                    <input
                                        type="text"
                                        placeholder="e.g. 25CS101"
                                        value={formData.courseCode}
                                        onChange={(e) => setFormData({ ...formData, courseCode: e.target.value.toUpperCase() })}
                                        required
                                        disabled={Boolean(editingCourse) || saving}
                                    />
                                    {editingCourse && (
                                        <span className="field-hint">Course code cannot be changed once created.</span>
                                    )}
                                </div>

                                <div className="form-group">
                                    <label>Course Name / Title *</label>
                                    <input
                                        type="text"
                                        placeholder="e.g. Data Structures & Algorithms"
                                        value={formData.courseName}
                                        onChange={(e) => setFormData({ ...formData, courseName: e.target.value })}
                                        required
                                        disabled={saving}
                                    />
                                </div>
                            </div>

                            <div className="form-row-3">
                                <div className="form-group">
                                    <label>Department</label>
                                    <select
                                        value={formData.department}
                                        onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                                        disabled={saving}
                                    >
                                        <option value="CSE">CSE</option>
                                        <option value="DSAI">DSAI</option>
                                        <option value="ECE">ECE</option>
                                        <option value="AIC">AIC</option>
                                        <option value="General">General</option>
                                    </select>
                                </div>

                                <div className="form-group">
                                    <label>Semester</label>
                                    <select
                                        value={formData.semester}
                                        onChange={(e) => setFormData({ ...formData, semester: e.target.value })}
                                        disabled={saving}
                                    >
                                        {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
                                            <option key={s} value={String(s)}>
                                                Sem {s}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div className="form-group">
                                    <label>Credits</label>
                                    <input
                                        type="number"
                                        min="1"
                                        max="6"
                                        value={formData.credits}
                                        onChange={(e) => setFormData({ ...formData, credits: e.target.value })}
                                        disabled={saving}
                                    />
                                </div>
                            </div>

                            <div className="form-row-2">
                                <div className="form-group">
                                    <label>Assigned Faculty (Lecturer)</label>
                                    <select
                                        value={formData.lecturerEmail}
                                        onChange={(e) => handleLecturerSelect(e.target.value)}
                                        disabled={saving}
                                    >
                                        <option value="">-- Select Instructor --</option>
                                        {lecturers.map((lec) => (
                                            <option key={lec.email} value={lec.email}>
                                                {lec.name} ({lec.email}) - {lec.department}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div className="form-group">
                                    <label>Default Room / Lecture Hall</label>
                                    <input
                                        type="text"
                                        placeholder="e.g. L-105"
                                        value={formData.defaultRoom}
                                        onChange={(e) => setFormData({ ...formData, defaultRoom: e.target.value })}
                                        disabled={saving}
                                    />
                                </div>
                            </div>

                            <div className="form-row-2">
                                <div className="form-group">
                                    <label>Academic Batch</label>
                                    <input
                                        type="text"
                                        placeholder="e.g. 2025"
                                        value={formData.batch}
                                        onChange={(e) => setFormData({ ...formData, batch: e.target.value })}
                                        disabled={saving}
                                    />
                                </div>

                                <div className="form-group">
                                    <label>Instructor Display Name</label>
                                    <input
                                        type="text"
                                        placeholder="Auto-filled or custom faculty name"
                                        value={formData.lecturerName}
                                        onChange={(e) => setFormData({ ...formData, lecturerName: e.target.value })}
                                        disabled={saving}
                                    />
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Course Description / Syllabus Overview</label>
                                <textarea
                                    rows="3"
                                    placeholder="Brief outline of syllabus modules, lab requirements, prerequisites..."
                                    value={formData.description}
                                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                    disabled={saving}
                                />
                            </div>

                            <div className="admin-modal-footer">
                                <button
                                    type="button"
                                    className="admin-btn-cancel"
                                    onClick={() => setIsModalOpen(false)}
                                    disabled={saving}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="admin-btn-save"
                                    disabled={saving}
                                >
                                    {saving ? "Saving Course..." : editingCourse ? "Update Course" : "Create Course"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
