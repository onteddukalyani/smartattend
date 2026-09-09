import React, { useEffect, useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
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
    FaCalendarCheck,
    FaUsers,
    FaSyncAlt,
    FaTimes,
    FaQrcode,
    FaGraduationCap,
    FaUserCheck,
    FaClock,
    FaHistory,
    FaInfoCircle,
    FaArrowRight,
    FaArrowLeft,
    FaExternalLinkAlt,
    FaCheckCircle,
    FaExclamationTriangle,
    FaFilter,
    FaCalendarAlt,
    FaChevronRight,
    FaFileExcel,
    FaTrashAlt
} from "react-icons/fa";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import StudentDetailModal from "../../Common/StudentDetailModal";
import "./LecturerCourses.css";

// Strict ownership check: course belongs to current lecturer
export function isCourseAssignedToLecturer(c, user, profile) {
    if (!c) return false;

    const myEmail = (user?.email || profile?.email || "").toLowerCase().trim();
    const myUid = String(user?.uid || profile?.uid || "").toLowerCase().trim();
    const myPrefix = myEmail ? myEmail.split("@")[0].toLowerCase().trim() : "";
    const rawMyName = (profile?.name || user?.displayName || "").trim().toLowerCase();

    const assignedEmail = (c.lecturerEmail || c.ownerEmail || c.facultyEmail || c.email || "").toLowerCase().trim();
    const assignedUid = String(c.ownerId || c.lecturerUid || c.facultyId || c.uid || "").toLowerCase().trim();
    const assignedName = String(c.lecturerName || c.faculty || c.instructor || "").trim().toLowerCase();
    const assignedPrefix = assignedEmail ? assignedEmail.split("@")[0].toLowerCase().trim() : "";

    // 1. If course has an explicit email assigned:
    if (assignedEmail) {
        if (myEmail && assignedEmail === myEmail) return true;
        if (myPrefix && assignedPrefix === myPrefix) return true;
        // Explicit email belongs to someone else -> Strictly NOT my course!
        return false;
    }

    // 2. If course has an explicit UID assigned:
    if (assignedUid) {
        if (myUid && assignedUid === myUid) return true;
        // Explicit UID belongs to someone else -> Strictly NOT my course!
        return false;
    }

    // 3. Fallback to full name match ONLY if no email/UID exists and name is specific
    const genericNames = new Set(["lecturer", "faculty", "admin", "faculty member", "user", "teacher", "unknown", "n/a", "student", "staff"]);
    if (assignedName && rawMyName && !genericNames.has(assignedName) && assignedName.length >= 4) {
        return assignedName === rawMyName;
    }

    return false;
}

export default function LecturerCourses() {
    const { user, profile } = useAuth();
    const navigate = useNavigate();

    const [courses, setCourses] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [records, setRecords] = useState([]);
    const [students, setStudents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [activeTab, setActiveTab] = useState("my"); // "my" or "all"

    // Course Detail Modal State (Opened on clicking any course card)
    const [selectedCourse, setSelectedCourse] = useState(null);
    const [modalSubTab, setModalSubTab] = useState("sessions"); // "sessions" | "students" | "info"
    const [studentSearch, setStudentSearch] = useState("");

    // Active Class Session for Attendee View inside Modal
    const [selectedSessionForAttendees, setSelectedSessionForAttendees] = useState(null);
    const [sessionAttendeeSearch, setSessionAttendeeSearch] = useState("");
    const [deletingRecordId, setDeletingRecordId] = useState(null);
    const [deletingStudentId, setDeletingStudentId] = useState(null);

    // Selected Student Profile Modal
    const [selectedStudentForModal, setSelectedStudentForModal] = useState(null);

    const isCurrentAdminPath = window.location.pathname.startsWith("/admin");
    const isCurrentLecturerPath = window.location.pathname.startsWith("/lecturer");

    const isAdmin = isCurrentAdminPath || (!isCurrentLecturerPath && (
        profile?.role === "admin" || 
        profile?.role === "administrator" || 
        profile?.role === "superadmin"
    ));

    const basePath = isCurrentAdminPath ? "/admin/classes" : "/lecturer/attendance-sessions";

    // Modal state for quick subject creation
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [formData, setFormData] = useState({
        courseCode: "",
        courseName: "",
        department: (profile?.department && String(profile?.department).toLowerCase() !== "general") ? profile.department : ((profile?.branch && String(profile?.branch).toLowerCase() !== "general") ? profile.branch : "CSE"),
        semester: "1",
        credits: "3",
        defaultRoom: "C003",
        batch: "2025",
        description: ""
    });

    const lecturerEmail = (user?.email || profile?.email || "").toLowerCase().trim();
    const lecturerUid = (user?.uid || profile?.uid || "").toLowerCase().trim();
    const rawLecturerName = (profile?.name || user?.displayName || "").trim();


    // 1. Real-time Courses Listener
    useEffect(() => {
        const q = collection(db, "courses");
        const unsubscribe = onSnapshot(
            q,
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({
                    id: d.id,
                    ...d.data()
                }));
                setCourses(list);
                setLoading(false);
            },
            (err) => {
                console.warn("Courses read error:", err);
                setLoading(false);
            }
        );

        return () => unsubscribe();
    }, []);

    // 2. Real-time Sessions Listener
    useEffect(() => {
        const q = collection(db, "attendance_sessions");
        const unsubscribe = onSnapshot(
            q,
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

    // 3. Real-time Attendance Records Listener
    useEffect(() => {
        const q = collection(db, "attendance_records");
        const unsubscribe = onSnapshot(
            q,
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

    // 4. Real-time Students Catalog Listener
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
                faceDescriptor: s.faceDescriptor,
                photoURL: s.photoURL || ""
            }));
            setStudents(mapped);
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

    // Session statistics per course with robust multi-field matching
    const sessionsPerCourse = useMemo(() => {
        const map = {};
        courses.forEach((c) => {
            const code = (c.courseCode || "").trim().toUpperCase();
            const cleanCode = code.replace(/[^A-Z0-9]/g, "");
            const dept = (c.department || "").trim().toUpperCase();
            const cName = String(c.courseName || "").trim().toUpperCase();
            const cId = String(c.id || "").trim().toUpperCase();

            const count = sessions.filter((s) => {
                const sCode = (s.courseCode || "").trim().toUpperCase();
                const sClass = (s.classCode || "").trim().toUpperCase();
                const sCleanCode = sCode.replace(/[^A-Z0-9]/g, "");
                const sCleanClass = sClass.replace(/[^A-Z0-9]/g, "");
                const sidUpper = String(s.id || "").toUpperCase();

                if (sCode && sCode === code) return true;
                if (sCleanCode && cleanCode && sCleanCode === cleanCode) return true;
                if (sClass && sClass === code) return true;
                if (sCleanClass && cleanCode && sCleanClass === cleanCode) return true;
                if (cleanCode && sidUpper.startsWith(cleanCode)) return true;
                if (s.courseId && (String(s.courseId).toUpperCase() === code || String(s.courseId).toUpperCase() === cId)) return true;
                if (s.courseName && cName && String(s.courseName).toUpperCase() === cName) return true;
                if (!sCode && sClass === dept) return true;

                // Check records
                return records.some((r) => {
                    const rSessId = String(r.sessionId || r.session_id || "").trim().toUpperCase();
                    const rCode = String(r.courseCode || r.classCode || "").trim().toUpperCase();
                    const rClean = rCode.replace(/[^A-Z0-9]/g, "");
                    return rSessId === sidUpper && (rCode === code || rClean === cleanCode || rCode === dept);
                });
            }).length;

            map[code] = count;
            if (c.id) map[c.id.toUpperCase()] = count;
        });
        return map;
    }, [courses, sessions, records]);

    // Attendance records per course
    const recordsPerCourse = useMemo(() => {
        const map = {};
        records.forEach((r) => {
            const code = (r.courseCode || r.classCode || "").trim().toUpperCase();
            if (code) {
                map[code] = (map[code] || 0) + 1;
            }
        });
        return map;
    }, [records]);

    // Split courses strictly by ownership
    const myCourses = useMemo(() => {
        return courses.filter((c) => isCourseAssignedToLecturer(c, user, profile));
    }, [courses, user, profile]);

    // Filter courses based on activeTab and search term
    const filteredCourses = useMemo(() => {
        const base = activeTab === "my" ? myCourses : courses;
        const term = search.toLowerCase().trim();
        if (!term) return base;

        return base.filter((c) => {
            const facultyText = (c.lecturerName || c.faculty || c.lecturerEmail || "").toLowerCase();
            return (
                (c.courseCode || "").toLowerCase().includes(term) ||
                (c.courseName || "").toLowerCase().includes(term) ||
                (c.department || "").toLowerCase().includes(term) ||
                (c.defaultRoom || "").toLowerCase().includes(term) ||
                facultyText.includes(term)
            );
        });
    }, [myCourses, courses, activeTab, search]);

    // Derived data for the active Selected Course Modal
    const selectedCourseData = useMemo(() => {
        if (!selectedCourse) return null;

        const code = (selectedCourse.courseCode || "").trim().toUpperCase();
        const cleanCode = code.replace(/[^A-Z0-9]/g, "");
        const dept = (selectedCourse.department || "").trim().toUpperCase();

        // Matching sessions
        const courseSessions = sessions.filter((s) => {
            const sCode = (s.courseCode || "").trim().toUpperCase();
            const sClass = (s.classCode || "").trim().toUpperCase();
            const sCleanCode = sCode.replace(/[^A-Z0-9]/g, "");
            const sCleanClass = sClass.replace(/[^A-Z0-9]/g, "");
            const sCourseId = String(s.courseId || "").trim().toUpperCase();
            const sName = String(s.courseName || "").trim().toUpperCase();
            const courseNameUpper = String(selectedCourse.courseName || "").trim().toUpperCase();
            const courseIdUpper = String(selectedCourse.id || "").trim().toUpperCase();
            const sidUpper = String(s.id || "").toUpperCase();

            if (sCode && sCode === code) return true;
            if (sCleanCode && cleanCode && sCleanCode === cleanCode) return true;
            if (sClass && sClass === code) return true;
            if (sCleanClass && cleanCode && sCleanClass === cleanCode) return true;
            if (cleanCode && sidUpper.startsWith(cleanCode)) return true;
            if (sCourseId && (sCourseId === code || sCourseId === courseIdUpper)) return true;
            if (sName && courseNameUpper && sName === courseNameUpper) return true;
            if (!sCode && sClass === dept) return true;

            // Check if any record in this session has matching course code
            const hasMatchingRecord = records.some((r) => {
                const rSessId = String(r.sessionId || r.session_id || "").trim().toUpperCase();
                const rCode = String(r.courseCode || r.classCode || "").trim().toUpperCase();
                const rClean = rCode.replace(/[^A-Z0-9]/g, "");
                return (rSessId === sidUpper || (r.id && String(r.id).toUpperCase().startsWith(`${sidUpper}_`))) && 
                       (rCode === code || rClean === cleanCode || rCode === dept);
            });
            if (hasMatchingRecord) return true;

            return false;
        });

        // Matching attendance records
        const sessionIds = new Set(courseSessions.map((s) => String(s.id || "").trim().toUpperCase()));
        const courseRecords = records.filter((r) => {
            const rSessId = String(r.sessionId || r.session_id || "").trim().toUpperCase();
            const rCode = (r.courseCode || "").trim().toUpperCase();
            const rClean = rCode.replace(/[^A-Z0-9]/g, "");
            const rClass = (r.classCode || "").trim().toUpperCase();
            return sessionIds.has(rSessId) || 
                   (r.id && Array.from(sessionIds).some(sid => String(r.id).toUpperCase().startsWith(`${sid}_`))) ||
                   rCode === code || 
                   rClean === cleanCode || 
                   rClass === code;
        });

        // Matching students by department/branch
        const enrolledStudents = students.filter((st) => {
            const stDept = (st.department || st.branch || "").trim().toUpperCase();
            if (!dept || dept === "ALL" || dept === "GENERAL") return true;
            return stDept === dept || stDept.includes(dept) || dept.includes(stDept);
        });

        // Compute unique attendees
        const uniqueAttendeeRolls = new Set(courseRecords.map((r) => (r.rollNo || "").toUpperCase()).filter(Boolean));

        return {
            course: selectedCourse,
            sessions: courseSessions,
            records: courseRecords,
            students: enrolledStudents,
            totalSessions: courseSessions.length,
            totalScans: courseRecords.length,
            uniqueAttendeesCount: uniqueAttendeeRolls.size,
            isMine: isCourseAssignedToLecturer(selectedCourse, user, profile)
        };
    }, [selectedCourse, sessions, records, students, user, profile]);

    // Filter students inside modal
    const filteredModalStudents = useMemo(() => {
        if (!selectedCourseData) return [];
        const term = studentSearch.toLowerCase().trim();
        if (!term) return selectedCourseData.students;

        return selectedCourseData.students.filter((st) => {
            return (
                (st.rollNo || "").toLowerCase().includes(term) ||
                (st.name || "").toLowerCase().includes(term) ||
                (st.email || "").toLowerCase().includes(term)
            );
        });
    }, [selectedCourseData, studentSearch]);

    // Active session attendees
    const sessionAttendees = useMemo(() => {
        if (!selectedSessionForAttendees) return [];
        const sessId = String(selectedSessionForAttendees.id || "").trim().toLowerCase();

        // 1. Check matching records from attendance_records collection
        const matchedFromRecords = records.filter((r) => {
            const rSessId = String(r.sessionId || r.session_id || r.session || "").trim().toLowerCase();
            const docId = String(r.id || "").trim().toLowerCase();
            if (rSessId && sessId && rSessId === sessId) return true;
            if (docId && sessId && docId.startsWith(`${sessId}_`)) return true;
            if (docId && sessId && docId === sessId) return true;
            return false;
        });

        // 2. Check embedded attendees array on session doc if records collection has none
        let attendeesList = [...matchedFromRecords];
        if (attendeesList.length === 0 && Array.isArray(selectedSessionForAttendees.attendees)) {
            attendeesList = selectedSessionForAttendees.attendees.map((att, idx) => ({
                id: att.id || `${selectedSessionForAttendees.id}_${att.rollNo || idx}`,
                sessionId: selectedSessionForAttendees.id,
                rollNo: att.rollNo || att.roll || att.studentId || "—",
                fullName: att.fullName || att.name || att.studentName || "Student",
                studentEmail: att.studentEmail || att.email || "",
                submittedAt: att.submittedAt || att.timestamp || att.time || selectedSessionForAttendees.createdAt,
                faceVerified: att.faceVerified ?? true
            }));
        }

        return attendeesList.sort((a, b) => {
            const rollA = a.rollNo || "";
            const rollB = b.rollNo || "";
            return rollA.localeCompare(rollB, undefined, { numeric: true, sensitivity: 'base' });
        });
    }, [selectedSessionForAttendees, records]);

    // Filter attendees within active session view
    const filteredSessionAttendees = useMemo(() => {
        const term = sessionAttendeeSearch.toLowerCase().trim();
        if (!term) return sessionAttendees;
        return sessionAttendees.filter((st) => {
            return (
                (st.rollNo || "").toLowerCase().includes(term) ||
                (st.fullName || st.name || "").toLowerCase().includes(term) ||
                (st.studentEmail || st.email || "").toLowerCase().includes(term)
            );
        });
    }, [sessionAttendees, sessionAttendeeSearch]);

    // Handle removing an individual check-in
    const handleRemoveAttendanceRecord = async (record) => {
        if (!window.confirm(`Remove attendance for Roll No ${record.rollNo || ""} (${record.fullName || "Student"}) from this session?`)) {
            return;
        }
        setDeletingRecordId(record.id);
        try {
            await deleteDoc(doc(db, "attendance_records", record.id));
        } catch (err) {
            console.error("Error removing attendance record:", err);
            alert("Failed to remove attendance record: " + err.message);
        } finally {
            setDeletingRecordId(null);
        }
    };

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
            const facultyName = rawLecturerName || profile?.name || user?.displayName || (user?.email ? user.email.split("@")[0] : "Faculty");

            const payload = {
                courseCode: code,
                courseName: formData.courseName.trim(),
                department: formData.department,
                semester: formData.semester,
                credits: Number(formData.credits) || 3,
                defaultRoom: formData.defaultRoom.trim() || "C003",
                lecturerEmail: lecturerEmail,
                lecturerName: facultyName,
                faculty: facultyName,
                facultyEmail: lecturerEmail,
                ownerEmail: lecturerEmail,
                ownerId: lecturerUid,
                lecturerUid: lecturerUid,
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
                department: (profile?.department && String(profile?.department).toLowerCase() !== "general") ? profile.department : ((profile?.branch && String(profile?.branch).toLowerCase() !== "general") ? profile.branch : "CSE"),
                semester: "3",
                credits: "3",
                defaultRoom: "C003",
                batch: "2025",
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
        navigate(`/lecturer/lecturerpage?courseCode=${encodeURIComponent(course.courseCode)}&roomNo=${encodeURIComponent(course.defaultRoom || "")}&classCode=${encodeURIComponent(course.department || "")}&batch=${encodeURIComponent(course.batch || "2025")}`);
    };

    const handleDeleteStudent = async (student, e) => {
        if (e) e.stopPropagation();
        const studentName = student.name || student.rollNo || "this student";
        const roll = (student.rollNo || student.id || "").trim().toUpperCase();

        const confirmed = window.confirm(
            `⚠️ Delete Student Record?\n\nAre you sure you want to permanently delete ${studentName} (${roll})?\n\nThis will permanently remove their record from SmartAttend across the database (users, students, authorizedUsers) and unenroll them from your course.`
        );
        if (!confirmed) return;

        try {
            setDeletingStudentId(roll || student.id);
            const email = student.email ? String(student.email).toLowerCase().trim() : null;
            const prefix = email ? email.split("@")[0].toLowerCase().trim() : null;

            const promises = [
                deleteDoc(doc(db, "users", roll)).catch(() => {}),
                deleteDoc(doc(db, "students", roll)).catch(() => {})
            ];

            if (student.id && student.id !== roll) {
                promises.push(deleteDoc(doc(db, "users", student.id)).catch(() => {}));
                promises.push(deleteDoc(doc(db, "students", student.id)).catch(() => {}));
            }

            if (email) {
                promises.push(deleteDoc(doc(db, "authorizedUsers", email)).catch(() => {}));
                promises.push(deleteDoc(doc(db, "students", email)).catch(() => {}));
            }

            if (prefix && prefix !== email && prefix !== roll.toLowerCase()) {
                promises.push(deleteDoc(doc(db, "authorizedUsers", prefix)).catch(() => {}));
                promises.push(deleteDoc(doc(db, "students", prefix)).catch(() => {}));
            }

            await Promise.all(promises);

            setStudents((prev) => prev.filter((s) => s.rollNo !== roll && s.id !== student.id));
            alert(`✅ Student ${studentName} (${roll}) was permanently deleted from the database.`);
        } catch (err) {
            console.error("Error deleting student:", err);
            alert("Failed to delete student: " + err.message);
        } finally {
            setDeletingStudentId(null);
        }
    };

    // KPIs
    const myCoursesCount = myCourses.length;
    const myConductedCount = sessions.filter((s) => {
        const ownerEmail = (s.ownerEmail || s.lecturerEmail || "").toLowerCase().trim();
        const ownerUid = String(s.ownerId || "").toLowerCase().trim();
        return (lecturerEmail && ownerEmail === lecturerEmail) || (lecturerUid && ownerUid === lecturerUid);
    }).length;

    return (
        <div className="lecturer-courses-page">
            {/* Header Banner */}
            <header className="lecturer-courses-header">
                <div className="lecturer-courses-title-box">
                    <div className="lecturer-courses-icon">
                        <FaBookOpen />
                    </div>
                    <div>
                        <h1>Teaching Courses &amp; Curriculum</h1>
                        <p>Manage your assigned subjects and launch instant QR attendance sessions.</p>
                    </div>
                </div>

                <div className="lecturer-courses-actions">
                    <button
                        type="button"
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
                <div
                    className="lecturer-kpi-card interactive"
                    onClick={() => setActiveTab("my")}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveTab("my"); } }}
                    title="Click to view your assigned subjects"
                >
                    <div className="lecturer-kpi-icon emerald">
                        <FaBookOpen />
                    </div>
                    <div className="lecturer-kpi-info">
                        <span className="lecturer-kpi-label">My Assigned Subjects</span>
                        <span className="lecturer-kpi-val">{loading ? "..." : myCoursesCount}</span>
                    </div>
                </div>

                <div
                    className="lecturer-kpi-card interactive"
                    onClick={() => navigate(basePath)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(basePath); } }}
                    title="Click to view all conducted class attendance sessions"
                >
                    <div className="lecturer-kpi-icon indigo">
                        <FaCalendarCheck />
                    </div>
                    <div className="lecturer-kpi-info">
                        <span className="lecturer-kpi-label">Sessions Conducted</span>
                        <span className="lecturer-kpi-val">{loading ? "..." : myConductedCount}</span>
                    </div>
                    <div className="lecturer-kpi-action-hint">
                        <FaArrowRight />
                    </div>
                </div>

                <div
                    className="lecturer-kpi-card interactive"
                    onClick={() => setActiveTab("all")}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveTab("all"); } }}
                    title="Click to view all curriculum catalog subjects"
                >
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
                        type="button"
                        className={`lecturer-tab-btn ${activeTab === "my" ? "active" : ""}`}
                        onClick={() => setActiveTab("my")}
                    >
                        <FaBookOpen />
                        <span>My Assigned Courses ({myCoursesCount})</span>
                    </button>
                    <button
                        type="button"
                        className={`lecturer-tab-btn ${activeTab === "all" ? "active" : ""}`}
                        onClick={() => setActiveTab("all")}
                    >
                        <FaLayerGroup />
                        <span>All Department Courses ({courses.length})</span>
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
                        const isMine = isCourseAssignedToLecturer(course, user, profile);
                        const assignedFaculty = course.lecturerName || course.faculty || (course.lecturerEmail ? course.lecturerEmail.split("@")[0] : null);

                        return (
                            <div
                                className={`lecturer-course-card ${isMine ? "is-my-course" : ""}`}
                                key={course.id}
                                onClick={() => {
                                    setSelectedCourse(course);
                                    setModalSubTab("sessions");
                                    setSelectedSessionForAttendees(null);
                                    setStudentSearch("");
                                }}
                                role="button"
                                tabIndex={0}
                                title="Click to view course sessions, attendance records, and student roster"
                            >
                                <div className="lecturer-course-top">
                                    <span className="lecturer-course-code">{course.courseCode}</span>
                                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                        {isMine ? (
                                            <span className="lecturer-badge-mine" title="This course is assigned to you">
                                                🌟 My Course
                                            </span>
                                        ) : assignedFaculty ? (
                                            <span className="lecturer-badge-other" title={`Assigned to ${assignedFaculty}`}>
                                                👤 {assignedFaculty}
                                            </span>
                                        ) : (
                                            <span className="lecturer-badge-unassigned" title="No faculty assigned yet">
                                                ⚠️ Unassigned
                                            </span>
                                        )}
                                        <span className="lecturer-course-dept">
                                            {course.department} • Sem {course.semester}
                                        </span>
                                    </div>
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
                                            Faculty: <strong>{assignedFaculty || (isMine ? (profile?.name || user?.displayName || "You") : "Unassigned")}</strong>
                                        </span>
                                    </div>
                                    <div className="lecturer-course-detail-row">
                                        <FaDoorOpen />
                                        <span>
                                            Default Room: <strong>{course.defaultRoom || "C003"}</strong>
                                        </span>
                                    </div>
                                    <div className="lecturer-course-detail-row">
                                        <FaGraduationCap />
                                        <span>
                                            Credits: <strong>{course.credits || 3}</strong> • Batch: <strong>{course.batch || "2025"}</strong>
                                        </span>
                                    </div>
                                </div>

                                <div className="lecturer-course-card-hint">
                                    <span>View Sessions &amp; Attendees</span>
                                    <FaChevronRight />
                                </div>

                                <div className="lecturer-course-footer">
                                    <button
                                        type="button"
                                        className="lecturer-classes-count"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedCourse(course);
                                            setModalSubTab("sessions");
                                            setSelectedSessionForAttendees(null);
                                        }}
                                        title={`View ${count} attendance classes conducted for ${course.courseCode}`}
                                    >
                                        <FaCalendarCheck />
                                        <span>{count} Class{count !== 1 ? "es" : ""} Held</span>
                                    </button>

                                    <button
                                        type="button"
                                        className="lecturer-start-session-btn"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleLaunchQR(course);
                                        }}
                                        title={`Launch QR attendance session for ${course.courseCode}`}
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

            {/* Course Details Modal (Triggered on Card Click) */}
            {selectedCourse && selectedCourseData && (
                <div
                    className="cd-modal-backdrop"
                    onClick={() => {
                        setSelectedCourse(null);
                        setSelectedSessionForAttendees(null);
                    }}
                >
                    <div
                        className="cd-modal-container"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Modal Header */}
                        <div className="cd-modal-header">
                            <div className="cd-header-left">
                                <div className="cd-course-code-pill">
                                    {selectedCourseData.course.courseCode}
                                </div>
                                <div className="cd-header-title-box">
                                    <h2>{selectedCourseData.course.courseName}</h2>
                                    <div className="cd-header-tags">
                                        <span className="cd-tag dept">
                                            {selectedCourseData.course.department} • Semester {selectedCourseData.course.semester}
                                        </span>
                                        <span className="cd-tag room">
                                            <FaDoorOpen /> {selectedCourseData.course.defaultRoom || "C003"}
                                        </span>
                                        <span className="cd-tag credits">
                                            <FaGraduationCap /> {selectedCourseData.course.credits || 3} Credits
                                        </span>
                                        {selectedCourseData.isMine ? (
                                            <span className="cd-tag mine">🌟 Assigned to You</span>
                                        ) : selectedCourseData.course.lecturerName ? (
                                            <span className="cd-tag other">👤 {selectedCourseData.course.lecturerName}</span>
                                        ) : null}
                                    </div>
                                </div>
                            </div>

                            <button
                                type="button"
                                className="cd-modal-close-btn"
                                onClick={() => {
                                    setSelectedCourse(null);
                                    setSelectedSessionForAttendees(null);
                                }}
                                aria-label="Close details"
                            >
                                <FaTimes />
                            </button>
                        </div>

                        {/* Modal KPI Metrics Row */}
                        <div className="cd-metrics-grid">
                            <div className="cd-metric-card">
                                <div className="cd-metric-icon emerald">
                                    <FaCalendarCheck />
                                </div>
                                <div className="cd-metric-content">
                                    <span className="cd-metric-num">{selectedCourseData.totalSessions}</span>
                                    <span className="cd-metric-text">Sessions Conducted</span>
                                </div>
                            </div>

                            <div className="cd-metric-card">
                                <div className="cd-metric-icon indigo">
                                    <FaUserCheck />
                                </div>
                                <div className="cd-metric-content">
                                    <span className="cd-metric-num">{selectedCourseData.totalScans}</span>
                                    <span className="cd-metric-text">Total Scans Recorded</span>
                                </div>
                            </div>

                            <div className="cd-metric-card">
                                <div className="cd-metric-icon purple">
                                    <FaUsers />
                                </div>
                                <div className="cd-metric-content">
                                    <span className="cd-metric-num">{selectedCourseData.students.length}</span>
                                    <span className="cd-metric-text">Dept Students</span>
                                </div>
                            </div>

                            <div className="cd-metric-card">
                                <div className="cd-metric-icon amber">
                                    <FaHistory />
                                </div>
                                <div className="cd-metric-content">
                                    <span className="cd-metric-num">{selectedCourseData.uniqueAttendeesCount}</span>
                                    <span className="cd-metric-text">Unique Attendees</span>
                                </div>
                            </div>
                        </div>

                        {/* Modal Sub-Tabs */}
                        <div className="cd-subtabs-bar">
                            <button
                                type="button"
                                className={`cd-subtab-btn ${modalSubTab === "sessions" ? "active" : ""}`}
                                onClick={() => {
                                    setModalSubTab("sessions");
                                    setSelectedSessionForAttendees(null);
                                }}
                            >
                                <FaClock />
                                <span>Conducted Sessions ({selectedCourseData.totalSessions})</span>
                            </button>
                            <button
                                type="button"
                                className={`cd-subtab-btn ${modalSubTab === "students" ? "active" : ""}`}
                                onClick={() => {
                                    setModalSubTab("students");
                                    setSelectedSessionForAttendees(null);
                                }}
                            >
                                <FaUsers />
                                <span>Enrolled Students ({selectedCourseData.students.length})</span>
                            </button>
                            <button
                                type="button"
                                className={`cd-subtab-btn ${modalSubTab === "info" ? "active" : ""}`}
                                onClick={() => {
                                    setModalSubTab("info");
                                    setSelectedSessionForAttendees(null);
                                }}
                            >
                                <FaInfoCircle />
                                <span>Course Syllabus &amp; Info</span>
                            </button>
                        </div>

                        {/* Modal Body Content */}
                        <div className="cd-modal-body">
                            {/* 1. SESSIONS TAB */}
                            {modalSubTab === "sessions" && (
                                <div className="cd-sessions-view">
                                    {selectedSessionForAttendees ? (
                                        /* Detailed Attendees View for the clicked class session */
                                        <div className="cd-session-attendees-view">
                                            <div className="cd-attendees-header-bar">
                                                <button
                                                    type="button"
                                                    className="cd-back-to-sessions-btn"
                                                    onClick={() => setSelectedSessionForAttendees(null)}
                                                    title="Return to all sessions list"
                                                >
                                                    <FaArrowLeft />
                                                    <span>Back to Class Sessions</span>
                                                </button>

                                                <div className="cd-attendees-session-summary">
                                                    <div className="cd-attendees-session-title">
                                                        <strong>{selectedSessionForAttendees.courseCode || selectedSessionForAttendees.classCode || selectedCourseData.course.courseCode}</strong>
                                                        <span> • Room {selectedSessionForAttendees.roomNo || selectedSessionForAttendees.room || "C003"}</span>
                                                        <span> • {selectedSessionForAttendees.createdAt ? (new Date(selectedSessionForAttendees.createdAt?.toDate ? selectedSessionForAttendees.createdAt.toDate() : (selectedSessionForAttendees.createdAt?.seconds ? selectedSessionForAttendees.createdAt.seconds * 1000 : selectedSessionForAttendees.createdAt)).toLocaleDateString()) : (selectedSessionForAttendees.date || "Today")}</span>
                                                    </div>
                                                </div>

                                                <div className="cd-attendees-actions-group">
                                                    {sessionAttendees.length > 0 && (
                                                        <button
                                                            type="button"
                                                            className="cd-excel-btn"
                                                            onClick={() => downloadExcel("cd-session-attendees-table", `Attendance-${selectedSessionForAttendees.courseCode || "Class"}-${new Date().toISOString().slice(0, 10)}`)}
                                                            title="Download session attendance as Excel"
                                                        >
                                                            <FaFileExcel />
                                                            <span>Download Excel</span>
                                                        </button>
                                                    )}
                                                    <button
                                                        type="button"
                                                        className="cd-fullpage-btn"
                                                        onClick={() => {
                                                            setSelectedCourse(null);
                                                            setSelectedSessionForAttendees(null);
                                                            navigate(`${basePath}/${selectedSessionForAttendees.id}`);
                                                        }}
                                                        title="Open full-screen management view"
                                                    >
                                                        <FaExternalLinkAlt />
                                                        <span>Full Page</span>
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="cd-attendees-filter-row">
                                                <div className="cd-students-search-box">
                                                    <FaSearch className="cd-search-icon" />
                                                    <input
                                                        type="text"
                                                        placeholder="Search attendee by roll number, name, email..."
                                                        value={sessionAttendeeSearch}
                                                        onChange={(e) => setSessionAttendeeSearch(e.target.value)}
                                                        className="cd-students-search-input"
                                                    />
                                                </div>
                                                <span className="cd-attendee-count-badge">
                                                    <FaUserCheck /> {filteredSessionAttendees.length} of {sessionAttendees.length} Students Present
                                                </span>
                                            </div>

                                            {filteredSessionAttendees.length === 0 ? (
                                                <div className="cd-empty-placeholder">
                                                    <div className="cd-empty-icon">
                                                        <FaUsers />
                                                    </div>
                                                    <h4>{sessionAttendees.length === 0 ? "No Attendance Records Yet" : "No Matching Attendees Found"}</h4>
                                                    <p>
                                                        {sessionAttendees.length === 0
                                                            ? "No student check-ins have been recorded for this class session yet."
                                                            : `No verified students match your search "${sessionAttendeeSearch}".`}
                                                    </p>
                                                </div>
                                            ) : (
                                                <div className="cd-students-table-wrapper">
                                                    <table className="cd-students-table" id="cd-session-attendees-table">
                                                        <thead>
                                                            <tr>
                                                                <th>#</th>
                                                                <th>Roll Number</th>
                                                                <th>Student Name</th>
                                                                <th>Check-in Time</th>
                                                                <th>Verification Status</th>
                                                                <th>Actions</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {filteredSessionAttendees.map((att, index) => {
                                                                const subTime = att.submittedAt || att.timestamp || att.createdAt;
                                                                const timeStr = subTime ? (new Date(subTime?.toDate ? subTime.toDate() : (subTime?.seconds ? subTime.seconds * 1000 : subTime)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })) : "—";
                                                                const isDeleting = deletingRecordId === att.id;

                                                                return (
                                                                    <tr
                                                                        key={att.id || att.rollNo || index}
                                                                        onClick={() => {
                                                                            const matchedStudent = students.find((st) => (st.rollNo || "").toUpperCase() === (att.rollNo || "").toUpperCase()) || {
                                                                                id: att.studentUid || att.rollNo,
                                                                                rollNo: att.rollNo,
                                                                                name: att.fullName || att.name || att.studentName || "Student",
                                                                                email: att.studentEmail || att.email || "",
                                                                                department: selectedCourseData?.course?.department || "CSE",
                                                                                branch: selectedCourseData?.course?.department || "CSE",
                                                                                semester: selectedCourseData?.course?.semester || "1",
                                                                                batch: selectedCourseData?.course?.batch || "2025",
                                                                                hasFace: att.faceVerified ?? false
                                                                            };
                                                                            setSelectedStudentForModal(matchedStudent);
                                                                        }}
                                                                        className="cd-interactive-row"
                                                                        title="Click to view complete student profile and attendance record"
                                                                    >
                                                                        <td style={{ color: "var(--text-muted, #94a3b8)", fontWeight: 750, width: "36px" }}>
                                                                            #{index + 1}
                                                                        </td>
                                                                        <td>
                                                                            <span className="cd-roll-badge">{att.rollNo || "—"}</span>
                                                                        </td>
                                                                        <td>
                                                                            <div className="cd-student-name-box">
                                                                                <strong>{att.fullName || att.name || att.studentName || "Student"}</strong>
                                                                                <span className="cd-student-sub">{att.studentEmail || att.email || "Verified"}</span>
                                                                            </div>
                                                                        </td>
                                                                        <td>
                                                                            <span className="cd-time-text">
                                                                                <FaClock /> {timeStr}
                                                                            </span>
                                                                        </td>
                                                                        <td>
                                                                            {att.faceVerified ? (
                                                                                <span className="cd-face-badge registered" title="Facial 128-D Biometric Match">
                                                                                    <FaCheckCircle /> Face Verified
                                                                                </span>
                                                                            ) : (
                                                                                <span className="cd-face-badge registered" style={{ background: "rgba(99, 102, 241, 0.1)", color: "#4f46e5" }} title="Dynamic QR Verified">
                                                                                    <FaQrcode /> QR Verified
                                                                                </span>
                                                                            )}
                                                                        </td>
                                                                        <td onClick={(e) => e.stopPropagation()}>
                                                                            <button
                                                                                type="button"
                                                                                className="cd-remove-record-btn"
                                                                                onClick={() => handleRemoveAttendanceRecord(att)}
                                                                                disabled={isDeleting}
                                                                                title="Remove this check-in record"
                                                                            >
                                                                                <FaTrashAlt />
                                                                                <span>{isDeleting ? "..." : "Remove"}</span>
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
                                    ) : selectedCourseData.sessions.length === 0 ? (
                                        <div className="cd-empty-placeholder">
                                            <div className="cd-empty-icon">
                                                <FaCalendarAlt />
                                            </div>
                                            <h4>No Sessions Conducted Yet</h4>
                                            <p>No attendance sessions have been logged for this course code. Click "Start Live QR Session" below to launch your first class attendance.</p>
                                        </div>
                                    ) : (
                                        <div className="cd-sessions-list">
                                            {selectedCourseData.sessions.map((s, idx) => {
                                                const sDate = s.createdAt?.toDate ? s.createdAt.toDate() : (s.createdAt?.seconds ? new Date(s.createdAt.seconds * 1000) : (s.createdAt ? new Date(s.createdAt) : (s.timestamp ? new Date(s.timestamp) : null)));
                                                const dateStr = sDate && !isNaN(sDate.getTime())
                                                    ? sDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
                                                    : (s.date || "Past Session");

                                                // Count attendance records for this session
                                                const count = records.filter((r) => r.sessionId === s.id).length || s.attendeesCount || (Array.isArray(s.attendees) ? s.attendees.length : 0);

                                                return (
                                                    <div
                                                        className="cd-session-card"
                                                        key={s.id || idx}
                                                        onClick={() => {
                                                            setSelectedSessionForAttendees(s);
                                                            setSessionAttendeeSearch("");
                                                        }}
                                                        role="button"
                                                        tabIndex={0}
                                                        title="Click to view full attendee list for this class session"
                                                    >
                                                        <div className="cd-session-card-left">
                                                            <div className="cd-session-num">#{selectedCourseData.sessions.length - idx}</div>
                                                            <div className="cd-session-meta">
                                                                <h4>{dateStr}</h4>
                                                                <div className="cd-session-tags">
                                                                    <span>Room: <strong>{s.roomNo || s.room || "C003"}</strong></span>
                                                                    <span>•</span>
                                                                    <span>Dept: <strong>{s.classCode || s.department || selectedCourseData.course.department}</strong></span>
                                                                    {s.lecturerName && (
                                                                        <>
                                                                            <span>•</span>
                                                                            <span>By: <strong>{s.lecturerName}</strong></span>
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        <div className="cd-session-card-right">
                                                            <div className="cd-session-attendees-badge">
                                                                <FaUserCheck />
                                                                <span><strong>{count}</strong> Students Present</span>
                                                            </div>

                                                            <button
                                                                type="button"
                                                                className="cd-view-session-btn"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setSelectedSessionForAttendees(s);
                                                                    setSessionAttendeeSearch("");
                                                                }}
                                                                title="View attendee list for this session"
                                                            >
                                                                <span>View Attendees</span>
                                                                <FaChevronRight />
                                                            </button>

                                                            <button
                                                                type="button"
                                                                className="cd-view-session-btn"
                                                                style={{ background: "rgba(99, 102, 241, 0.08)", color: "#4f46e5" }}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setSelectedCourse(null);
                                                                    setSelectedSessionForAttendees(null);
                                                                    navigate(`${basePath}/${s.id}`);
                                                                }}
                                                                title="Open full page session register"
                                                            >
                                                                <FaExternalLinkAlt />
                                                                <span>Full Page</span>
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* 2. STUDENTS TAB */}
                            {modalSubTab === "students" && (
                                <div className="cd-students-view">
                                    <div className="cd-students-filter-row">
                                        <div className="cd-students-search-box">
                                            <FaSearch className="cd-search-icon" />
                                            <input
                                                type="text"
                                                placeholder={`Search among ${selectedCourseData.students.length} ${selectedCourseData.course.department} students...`}
                                                value={studentSearch}
                                                onChange={(e) => setStudentSearch(e.target.value)}
                                                className="cd-students-search-input"
                                            />
                                        </div>
                                        <span className="cd-student-count-badge">
                                            {filteredModalStudents.length} of {selectedCourseData.students.length} Students
                                        </span>
                                    </div>

                                    {filteredModalStudents.length === 0 ? (
                                        <div className="cd-empty-placeholder">
                                            <div className="cd-empty-icon">
                                                <FaUsers />
                                            </div>
                                            <h4>No Matching Students Found</h4>
                                            <p>No registered students match the search keyword for department "{selectedCourseData.course.department}".</p>
                                        </div>
                                    ) : (
                                        <div className="cd-students-table-wrapper">
                                            <table className="cd-students-table">
                                                <thead>
                                                    <tr>
                                                        <th>Roll Number</th>
                                                        <th>Student Name</th>
                                                        <th>Email</th>
                                                        <th>Face Biometrics</th>
                                                        <th>Course Check-ins</th>
                                                        <th>Actions</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {filteredModalStudents.map((st) => {
                                                        const checkins = selectedCourseData.records.filter((r) => (r.rollNo || "").toUpperCase() === (st.rollNo || "").toUpperCase()).length;
                                                        const isDeleting = deletingStudentId === (st.rollNo || st.id);

                                                        return (
                                                            <tr
                                                                key={st.id || st.rollNo}
                                                                onClick={() => setSelectedStudentForModal(st)}
                                                                className="cd-interactive-row"
                                                                title="Click to view full student profile and attendance record"
                                                            >
                                                                <td>
                                                                    <span className="cd-roll-badge">{st.rollNo}</span>
                                                                </td>
                                                                <td>
                                                                    <div className="cd-student-name-box">
                                                                        <strong>{st.name}</strong>
                                                                        <span className="cd-student-sub">{st.department} • Sem {st.semester}</span>
                                                                    </div>
                                                                </td>
                                                                <td>
                                                                    <span className="cd-email-text">{st.email || "—"}</span>
                                                                </td>
                                                                <td>
                                                                    {st.hasFace ? (
                                                                        <span className="cd-face-badge registered">
                                                                            <FaCheckCircle /> Registered
                                                                        </span>
                                                                    ) : (
                                                                        <span className="cd-face-badge pending">
                                                                            <FaExclamationTriangle /> Not Registered
                                                                        </span>
                                                                    )}
                                                                </td>
                                                                <td>
                                                                    <span className={`cd-checkins-pill ${checkins > 0 ? "has-attended" : "zero"}`}>
                                                                        {checkins} / {selectedCourseData.totalSessions} classes
                                                                    </span>
                                                                </td>
                                                                <td onClick={(e) => e.stopPropagation()}>
                                                                    <button
                                                                        type="button"
                                                                        className="cd-remove-record-btn"
                                                                        onClick={(e) => handleDeleteStudent(st, e)}
                                                                        disabled={isDeleting}
                                                                        style={{
                                                                            display: "inline-flex",
                                                                            alignItems: "center",
                                                                            gap: "5px",
                                                                            background: "rgba(239, 68, 68, 0.1)",
                                                                            color: "#ef4444",
                                                                            border: "1px solid rgba(239, 68, 68, 0.3)",
                                                                            borderRadius: "8px",
                                                                            padding: "5px 11px",
                                                                            fontSize: "0.8rem",
                                                                            fontWeight: 700,
                                                                            cursor: isDeleting ? "not-allowed" : "pointer"
                                                                        }}
                                                                        title="Delete student from registered course and database"
                                                                    >
                                                                        <FaTrashAlt />
                                                                        <span>{isDeleting ? "Deleting..." : "Delete"}</span>
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
                            )}

                            {/* 3. INFO & SYLLABUS TAB */}
                            {modalSubTab === "info" && (
                                <div className="cd-info-view">
                                    <div className="cd-info-grid">
                                        <div className="cd-info-card full-width">
                                            <h4>Course Description &amp; Objectives</h4>
                                            <p className="cd-info-desc">
                                                {selectedCourseData.course.description || "No specific syllabus notes or description provided for this curriculum subject."}
                                            </p>
                                        </div>

                                        <div className="cd-info-card">
                                            <h4>Curriculum Details</h4>
                                            <div className="cd-info-meta-list">
                                                <div className="cd-info-item">
                                                    <span>Course Code:</span>
                                                    <strong>{selectedCourseData.course.courseCode}</strong>
                                                </div>
                                                <div className="cd-info-item">
                                                    <span>Department:</span>
                                                    <strong>{selectedCourseData.course.department}</strong>
                                                </div>
                                                <div className="cd-info-item">
                                                    <span>Semester:</span>
                                                    <strong>Semester {selectedCourseData.course.semester}</strong>
                                                </div>
                                                <div className="cd-info-item">
                                                    <span>Academic Batch:</span>
                                                    <strong>{selectedCourseData.course.batch || "2025"}</strong>
                                                </div>
                                                <div className="cd-info-item">
                                                    <span>Credits:</span>
                                                    <strong>{selectedCourseData.course.credits || 3} Credits</strong>
                                                </div>
                                                <div className="cd-info-item">
                                                    <span>Default Classroom:</span>
                                                    <strong>{selectedCourseData.course.defaultRoom || "C003"}</strong>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="cd-info-card">
                                            <h4>Faculty In Charge</h4>
                                            <div className="cd-info-meta-list">
                                                <div className="cd-info-item">
                                                    <span>Instructor Name:</span>
                                                    <strong>
                                                        {selectedCourseData.course.lecturerName || selectedCourseData.course.faculty || (selectedCourseData.isMine ? (profile?.name || user?.displayName || "You") : "Unassigned")}
                                                    </strong>
                                                </div>
                                                <div className="cd-info-item">
                                                    <span>Faculty Email:</span>
                                                    <strong>
                                                        {selectedCourseData.course.lecturerEmail || selectedCourseData.course.ownerEmail || (selectedCourseData.isMine ? user?.email : "—")}
                                                    </strong>
                                                </div>
                                                <div className="cd-info-item">
                                                    <span>Ownership Status:</span>
                                                    <span className={selectedCourseData.isMine ? "cd-status-pill mine" : "cd-status-pill other"}>
                                                        {selectedCourseData.isMine ? "🌟 Assigned to your account" : "👤 Other faculty subject"}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Modal Footer Actions */}
                        <div className="cd-modal-footer">
                            <button
                                type="button"
                                className="cd-footer-btn-secondary"
                                onClick={() => setSelectedCourse(null)}
                            >
                                Close
                            </button>

                            <button
                                type="button"
                                className="cd-footer-btn-outline"
                                onClick={() => {
                                    setSelectedCourse(null);
                                    navigate(`/lecturer/attendance-data`);
                                }}
                            >
                                <FaHistory />
                                <span>View Attendance Logs</span>
                            </button>

                            <button
                                type="button"
                                className="cd-footer-btn-primary"
                                onClick={() => {
                                    const c = selectedCourseData.course;
                                    setSelectedCourse(null);
                                    handleLaunchQR(c);
                                }}
                            >
                                <FaQrcode />
                                <span>Start Live QR Session</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Quick Add Course Modal */}
            {isModalOpen && (
                <div
                    className="lc-modal-backdrop"
                    onClick={() => !saving && setIsModalOpen(false)}
                >
                    <div
                        className="lc-modal-dialog"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="lc-modal-header">
                            <h3 className="lc-modal-title">
                                Register New Subject
                            </h3>
                            <button
                                className="lc-modal-close"
                                onClick={() => setIsModalOpen(false)}
                                disabled={saving}
                                aria-label="Close modal"
                            >
                                <FaTimes />
                            </button>
                        </div>

                        <form onSubmit={handleSaveCourse} className="lc-modal-form">
                            <div className="lc-form-grid">
                                <div className="lc-form-group">
                                    <label className="lc-form-label">Course Code *</label>
                                    <input
                                        type="text"
                                        required
                                        placeholder="e.g. CS301"
                                        value={formData.courseCode}
                                        onChange={(e) => setFormData({ ...formData, courseCode: e.target.value })}
                                        className="lc-form-input"
                                    />
                                </div>

                                <div className="lc-form-group">
                                    <label className="lc-form-label">Department</label>
                                    <select
                                        value={formData.department}
                                        onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                                        className="lc-form-select"
                                    >
                                        <option value="CSE">CSE</option>
                                        <option value="DSAI">DSAI</option>
                                        <option value="ECE">ECE</option>
                                        <option value="AIC">AIC</option>
                                    </select>
                                </div>
                            </div>

                            <div className="lc-form-group">
                                <label className="lc-form-label">Course Title *</label>
                                <input
                                    type="text"
                                    required
                                    placeholder="e.g. Operating Systems"
                                    value={formData.courseName}
                                    onChange={(e) => setFormData({ ...formData, courseName: e.target.value })}
                                    className="lc-form-input"
                                />
                            </div>

                            <div className="lc-form-grid">
                                <div className="lc-form-group">
                                    <label className="lc-form-label">Default Classroom</label>
                                    <input
                                        type="text"
                                        placeholder="e.g. C003"
                                        value={formData.defaultRoom}
                                        onChange={(e) => setFormData({ ...formData, defaultRoom: e.target.value })}
                                        className="lc-form-input"
                                    />
                                </div>

                                <div className="lc-form-group">
                                    <label className="lc-form-label">Semester</label>
                                    <select
                                        value={formData.semester}
                                        onChange={(e) => setFormData({ ...formData, semester: e.target.value })}
                                        className="lc-form-select"
                                    >
                                        {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
                                             <option key={s} value={String(s)}>Semester {s}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className="lc-form-group">
                                <label className="lc-form-label">Notes / Syllabus Description</label>
                                <textarea
                                    rows="2"
                                    placeholder="Optional notes or prerequisites..."
                                    value={formData.description}
                                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                    className="lc-form-textarea"
                                />
                            </div>

                            <div className="lc-modal-actions">
                                <button
                                    type="button"
                                    onClick={() => setIsModalOpen(false)}
                                    disabled={saving}
                                    className="lc-btn-cancel"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={saving}
                                    className="lc-btn-save"
                                >
                                    {saving ? "Saving..." : "Create Subject"}
                                </button>
                            </div>
                        </form>
                    </div>
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
