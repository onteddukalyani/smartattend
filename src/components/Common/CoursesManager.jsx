import React, { useEffect, useState, useMemo } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
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
  FaSyncAlt,
  FaUsers,
  FaClock,
  FaUserCheck,
  FaInfoCircle,
  FaArrowRight,
  FaIdCard,
  FaEnvelope,
  FaCalendarAlt,
  FaQrcode,
  FaFileExcel,
  FaUserPlus,
  FaExclamationTriangle,
  FaUndo,
  FaTable,
  FaThLarge,
  FaChartBar,
  FaEye,
  FaUserTie,
  FaBuilding
} from "react-icons/fa";
import { db } from "../../firebase";
import { useAuth } from "../authcontext";
import { downloadExcel } from "../../DownloadExcel";
import { mergeAllStudentRecords } from "../../utils/studentDataHelper";
import StudentDetailModal from "./StudentDetailModal";
import CourseDetailModal from "./CourseDetailModal";
import { useTableSort, SortIcon } from "./useTableSort";
import { sendStudentNotification } from "../../services/notificationsService";
import "./CoursesManager.css";

export function normalizeCourseDepartment(dept) {
  if (!dept) return "CSE";
  const str = String(dept).trim().toUpperCase();
  if (!str) return "CSE";

  if (str === "CSE" || str === "Computer Science and Engineering" || str === "CSE-A" || str === "CSE-B" || str === "GENERAL") return "CSE";
  if (str === "ECE") return "ECE";
  if (str === "DSAI" || str === "DS & AI" || str === "DS/AI" || str === "DS-AI") return "DSAI";
  if (str === "AIC" || str === "AI & COMPUTING" || str === "AI/COMPUTING" || str === "AI-C") return "AIC";

  const clean = str.replace(/[^A-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

  // 1. Check Data Science & AI (DSAI)
  if (clean.includes("DATA SCIENCE") || clean.includes("DSAI") || (clean.includes("DATA") && clean.includes("AI")) || (clean.includes("DS") && clean.includes("AI"))) return "DSAI";

  // 2. Check Artificial Intelligence & Computing (AIC)
  if (clean.includes("CYBERNETIC") || clean.includes("AIC") || (clean.includes("COMPUTING") && (clean.includes("AI") || clean.includes("ARTIFICIAL"))) || clean.includes("INTELLIGENCE AND COMPUTING") || clean.includes("AI COMPUTING")) return "AIC";

  // 3. Check Electronics & Communication Engineering (ECE)
  if (clean.includes("ELECTRONIC") || clean.includes("COMMUNICATION") || clean.includes("ECE") || clean.includes("EC")) return "ECE";

  // 4. Check Computer Science and Engineering (CSE)
  if (clean.includes("COMPUTER") || clean.includes("CSE") || clean.includes("SOFTWARE") || clean === "CS" || clean === "CE") return "CSE";

  // 5. Fallback for standalone AI / Data
  if (clean.includes("DATA")) return "DSAI";
  if (clean.includes("ARTIFICIAL") || clean.includes("INTELLIGENCE") || clean.includes("AI")) return "AIC";

  return "CSE";
}

export function normalizeCode(str) {
  if (!str) return "";
  return String(str).toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
}

export function isCourseAssignedToLecturer(course, user, profile) {
  if (!course || (!user && !profile)) return false;
  const userEmail = (user?.email || profile?.email || "").toLowerCase().trim();
  const userUid = (user?.uid || profile?.uid || "").trim();
  const userName = (profile?.name || profile?.fullName || user?.displayName || "").toLowerCase().trim();
  const userPrefix = userEmail ? userEmail.split("@")[0] : "";

  // Direct lecturer email/id checks
  if (course.lecturerEmail && course.lecturerEmail.toLowerCase().trim() === userEmail) return true;
  if (course.lecturerId && (course.lecturerId === userUid || course.lecturerId.toLowerCase().trim() === userEmail)) return true;
  if (course.assignedLecturerEmail && course.assignedLecturerEmail.toLowerCase().trim() === userEmail) return true;

  // Array of assigned lecturers
  if (Array.isArray(course.assignedLecturers)) {
    return course.assignedLecturers.some((lec) => {
      if (typeof lec === "string") {
        const l = lec.toLowerCase().trim();
        return l === userEmail || l === userUid || (userPrefix && l === userPrefix);
      }
      if (typeof lec === "object" && lec !== null) {
        const lEmail = (lec.email || "").toLowerCase().trim();
        const lUid = (lec.uid || lec.id || "").trim();
        return lEmail === userEmail || lUid === userUid;
      }
      return false;
    });
  }

  // Check course.lecturer string
  if (course.lecturer && typeof course.lecturer === "string") {
    const l = course.lecturer.toLowerCase().trim();
    if (l === userEmail || (userPrefix && l === userPrefix) || (userName && l === userName)) return true;
  }

  return false;
}

export function canManageCourse(course, user, profile, isAdminOverride = false) {
  if (isAdminOverride || profile?.role === "admin" || profile?.role === "administrator" || profile?.role === "superadmin") return true;
  if (profile?.role === "lecturer" || profile?.role === "faculty" || profile?.role === "professor") return true;
  return isCourseAssignedToLecturer(course, user, profile);
}

export default function CoursesManager() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const isCurrentAdmin = location.pathname.startsWith("/admin") || profile?.role === "admin" || profile?.role === "administrator" || profile?.role === "superadmin";
  const isCurrentLecturer = location.pathname.startsWith("/lecturer") || profile?.role === "lecturer" || profile?.role === "faculty";
  const canManageCourseForUser = (course = null) => canManageCourse(course, user, profile, isCurrentAdmin);

  // Data States
  const [courses, setCourses] = useState([]);
  const [lecturers, setLecturers] = useState([]);
  const [allStudents, setAllStudents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  // View Layout: "table" (dense directory) or "grid" (cards)
  const [viewLayout, setViewLayout] = useState(isCurrentAdmin ? "table" : "grid");

  // Filter & Tab States
  const [activeTab, setActiveTab] = useState(isCurrentAdmin ? "all" : "my"); // "my" | "all"
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedDept, setSelectedDept] = useState("all");
  const [selectedSemester, setSelectedSemester] = useState("all");

  // Modal States
  const [showAddEditModal, setShowAddEditModal] = useState(false);
  const [editingCourse, setEditingCourse] = useState(null);
  const [showRosterModal, setShowRosterModal] = useState(false);
  const [selectedCourseForRoster, setSelectedCourseForRoster] = useState(null);
  const [showStudentDetailModal, setShowStudentDetailModal] = useState(false);
  const [selectedStudentForDetail, setSelectedStudentForDetail] = useState(null);
  const [showCourseDetailModal, setShowCourseDetailModal] = useState(false);
  const [selectedCourseForDetail, setSelectedCourseForDetail] = useState(null);

  // Add/Edit Course Form Data
  const [formData, setFormData] = useState({
    code: "",
    name: "",
    classCode: "C003",
    department: "CSE",
    semester: "4",
    credits: "4",
    description: "",
    assignedLecturers: []
  });
  const [savingCourse, setSavingCourse] = useState(false);
  const [formError, setFormError] = useState("");

  // Roster Management Inside Modal State
  const [rosterSearch, setRosterSearch] = useState("");
  const [availableStudentSearch, setAvailableStudentSearch] = useState("");
  const [showAvailableStudents, setShowAvailableStudents] = useState(false);
  const [rosterBatchFilter, setRosterBatchFilter] = useState("all");
  const [selectedStudentsToAdd, setSelectedStudentsToAdd] = useState([]);
  const [savingRoster, setSavingRoster] = useState(false);

  // 1. Subscribe Real-Time to Courses, Lecturers, Students, and Sessions
  useEffect(() => {
    let unsubs = [];

    // Courses listener
    const unsubCourses = onSnapshot(collection(db, "courses"), (snapshot) => {
      const list = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data()
      }));
      setCourses(list);
      setLoading(false);
    }, (err) => {
      console.warn("Notice loading courses:", err);
      setLoading(false);
    });
    unsubs.push(unsubCourses);

    // Lecturers listener from users and authorizedUsers
    const loadLecturersData = async () => {
      try {
        const [usersSnap, authUsersSnap, lecturersSnap] = await Promise.all([
          getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
          getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] })),
          getDocs(collection(db, "lecturers")).catch(() => ({ docs: [] }))
        ]);

        const lecsMap = new Map();

        const ingest = (docSnap) => {
          const data = docSnap.data();
          const role = String(data.role || "").toLowerCase();
          if (role === "lecturer" || role === "faculty" || role === "admin" || role === "administrator" || docSnap.ref.parent.id === "lecturers") {
            const email = (data.email || (docSnap.id.includes("@") ? docSnap.id : "")).toLowerCase().trim();
            const key = email || docSnap.id;
            if (!lecsMap.has(key)) {
              lecsMap.set(key, {
                id: docSnap.id,
                ...data,
                email,
                name: data.name || data.displayName || data.fullName || (email ? email.split("@")[0] : "Faculty"),
                department: normalizeCourseDepartment(data.department || data.branch || "CSE"),
                designation: data.designation || "Assistant Professor",
                photoURL: data.photoURL || data.photo || data.image || null
              });
            }
          }
        };

        usersSnap.docs.forEach(ingest);
        authUsersSnap.docs.forEach(ingest);
        lecturersSnap.docs.forEach(ingest);

        setLecturers(Array.from(lecsMap.values()));
      } catch (err) {
        console.warn("Notice loading lecturers:", err);
      }
    };
    loadLecturersData();

    // Students listener
    const unsubStudents = onSnapshot(collection(db, "students"), (snapshot) => {
      const studs = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAllStudents(studs);
    }, () => { });
    unsubs.push(unsubStudents);

    // Sessions listener
    const unsubSessions = onSnapshot(collection(db, "attendance_sessions"), (snapshot) => {
      const sess = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      setSessions(sess);
    }, () => { });
    unsubs.push(unsubSessions);

    return () => {
      unsubs.forEach((u) => u && typeof u === "function" && u());
    };
  }, []);

  // Compute map of session counts per course code
  const { sessionCountsMap, activeSessionCountsMap } = useMemo(() => {
    const countMap = new Map();
    const activeMap = new Map();

    sessions.forEach((s) => {
      const code = (s.courseCode || s.classCode || "").toUpperCase().trim();
      if (code) {
        countMap.set(code, (countMap.get(code) || 0) + 1);
        if (s.status === "ACTIVE" || s.phase === "PHASE_1" || s.phase === "PHASE_2") {
          activeMap.set(code, (activeMap.get(code) || 0) + 1);
        }
      }
    });

    return { sessionCountsMap: countMap, activeSessionCountsMap: activeMap };
  }, [sessions]);

  // Helper to resolve faculty profile for a course
  const resolveCourseFaculty = (course) => {
    const directEmail = (course.lecturerEmail || course.assignedLecturerEmail || "").toLowerCase().trim();
    const directName = course.lecturer || course.lecturerName || "";

    let matched = null;
    if (directEmail) {
      matched = lecturers.find((l) => (l.email || "").toLowerCase().trim() === directEmail);
    }
    if (!matched && directName) {
      matched = lecturers.find((l) => (l.name || "").toLowerCase().trim() === directName.toLowerCase().trim());
    }
    if (!matched && Array.isArray(course.assignedLecturers) && course.assignedLecturers.length > 0) {
      const first = course.assignedLecturers[0];
      const email = typeof first === "string" ? first.toLowerCase().trim() : (first.email || "").toLowerCase().trim();
      if (email) {
        matched = lecturers.find((l) => (l.email || "").toLowerCase().trim() === email);
      }
    }

    const fallbackName = directName || (directEmail ? directEmail.split("@")[0] : "Not Assigned");

    return {
      name: matched?.name || matched?.displayName || fallbackName,
      email: matched?.email || directEmail || "",
      department: matched?.department || normalizeCourseDepartment(course.department),
      designation: matched?.designation || "Faculty In-Charge",
      photoURL: matched?.photoURL || matched?.photo || matched?.image || null
    };
  };

  // Enriched and Filtered Courses List
  const enrichedFilteredCourses = useMemo(() => {
    return courses
      .map((c) => {
        const courseCode = c.code || c.courseCode || c.id || "COURSE";
        const cleanCodeUpper = courseCode.toUpperCase().trim();
        const enrolledStudents = Array.isArray(c.enrolledStudents) ? c.enrolledStudents : [];
        const enrolledCount = new Set(enrolledStudents
          .map((s) => String(typeof s === "string" ? s : s?.rollNo || s?.rollNumber || "").trim().toUpperCase())
          .filter(Boolean)).size;
        const classesCount = sessionCountsMap.get(cleanCodeUpper) || sessionCountsMap.get(String(c.classCode || "").toUpperCase().trim()) || 0;
        const activeClassesCount = activeSessionCountsMap.get(cleanCodeUpper) || 0;
        const faculty = resolveCourseFaculty(c);

        return {
          ...c,
          courseCode,
          courseName: c.name || c.courseName || c.title || `Untitled (${courseCode})`,
          department: normalizeCourseDepartment(c.department),
          semester: c.semester || 4,
          credits: c.credits || 4,
          classCode: c.classCode || c.classNumber || "C003",
          enrolledCount,
          classesCount,
          activeClassesCount,
          faculty
        };
      })
      .filter((c) => {
        // Tab filter
        if (activeTab === "my") {
          if (!isCourseAssignedToLecturer(c, user, profile)) return false;
        }

        // Dept filter
        if (selectedDept !== "all" && c.department.toUpperCase() !== selectedDept.toUpperCase()) {
          return false;
        }

        // Semester filter
        if (selectedSemester !== "all" && String(c.semester || "") !== String(selectedSemester)) {
          return false;
        }

        // Search term (Matches code, name, dept, and faculty name/email!)
        if (searchTerm.trim()) {
          const q = searchTerm.toLowerCase().trim();
          const code = c.courseCode.toLowerCase();
          const name = c.courseName.toLowerCase();
          const dept = c.department.toLowerCase();
          const facName = c.faculty.name.toLowerCase();
          const facEmail = c.faculty.email.toLowerCase();
          return code.includes(q) || name.includes(q) || dept.includes(q) || facName.includes(q) || facEmail.includes(q);
        }

        return true;
      });
  }, [courses, activeTab, selectedDept, selectedSemester, searchTerm, user, profile, sessionCountsMap, activeSessionCountsMap, lecturers]);

  // Table Sort Hook for Directory Table
  const { sortedItems: sortedCourses, sortConfig, requestSort } = useTableSort(enrichedFilteredCourses, "courseCode", "asc");

  // Statistics calculation
  const stats = useMemo(() => {
    const total = courses.length;
    const myCount = courses.filter((c) => isCourseAssignedToLecturer(c, user, profile)).length;
    const totalSessions = sessions.length;
    const activeSessions = sessions.filter((s) => s.status === "ACTIVE" || s.phase === "PHASE_1" || s.phase === "PHASE_2").length;
    return { total, myCount, totalSessions, activeSessions };
  }, [courses, sessions, user, profile]);

  // Navigation to course attendances
  const handleOpenCourseAttendances = (courseCode) => {
    const basePath = isCurrentAdmin ? "/admin/classes" : "/lecturer/attendance-sessions";
    navigate(`${basePath}?course=${encodeURIComponent(courseCode)}`);
  };

  // Open Course Detail Modal
  const handleOpenCourseDetail = (course) => {
    setSelectedCourseForDetail(course);
    setShowCourseDetailModal(true);
  };

  // Handle Opening Add/Edit Modal
  const handleOpenAddEditModal = (course = null) => {
    if (course) {
      setEditingCourse(course);
      setFormData({
        code: course.code || course.courseCode || course.id || "",
        name: course.name || course.courseName || course.title || "",
        classCode: course.classCode || course.classNumber || "C003",
        department: course.department || "CSE",
        semester: String(course.semester || "4"),
        credits: String(course.credits || "4"),
        description: course.description || "",
        assignedLecturers: course.assignedLecturers || (course.lecturerEmail ? [course.lecturerEmail] : (course.lecturer ? [course.lecturer] : []))
      });
    } else {
      setEditingCourse(null);
      setFormData({
        code: "",
        name: "",
        classCode: "C003",
        department: profile?.department || "CSE",
        semester: "4",
        credits: "4",
        description: "",
        assignedLecturers: isCurrentLecturer && user?.email ? [user.email] : []
      });
    }
    setFormError("");
    setShowAddEditModal(true);
  };

  // Handle Saving Course
  const handleSaveCourse = async (e) => {
    e.preventDefault();
    if (!formData.code.trim() || !formData.name.trim()) {
      setFormError("Course code and course title are required.");
      return;
    }

    setSavingCourse(true);
    setFormError("");

    try {
      const cleanCode = normalizeCode(formData.code);
      const cleanClassCode = (formData.classCode || "C003").trim().toUpperCase();
      const docId = editingCourse ? editingCourse.id : cleanCode;
      const courseRef = doc(db, "courses", docId);

      // Resolve primary assigned lecturer info
      let primaryLecturerName = "Faculty";
      let primaryLecturerEmail = "";
      if (formData.assignedLecturers && formData.assignedLecturers.length > 0) {
        const first = formData.assignedLecturers[0];
        primaryLecturerEmail = typeof first === "string" ? first : first.email || "";
        const matched = lecturers.find((l) => (l.email || "").toLowerCase() === primaryLecturerEmail.toLowerCase());
        if (matched) {
          primaryLecturerName = matched.name || matched.displayName || primaryLecturerEmail.split("@")[0];
        } else if (user?.email && user.email.toLowerCase() === primaryLecturerEmail.toLowerCase()) {
          primaryLecturerName = profile?.name || user.displayName || user.email.split("@")[0];
        }
      }

      const payload = {
        code: cleanCode,
        name: formData.name.trim(),
        classCode: cleanClassCode,
        classNumber: cleanClassCode,
        defaultRoom: cleanClassCode,
        roomNo: cleanClassCode,
        room: cleanClassCode,
        department: normalizeCourseDepartment(formData.department),
        semester: parseInt(formData.semester, 10) || 4,
        credits: parseInt(formData.credits, 10) || 4,
        description: formData.description.trim(),
        assignedLecturers: formData.assignedLecturers,
        lecturer: primaryLecturerName,
        lecturerEmail: primaryLecturerEmail,
        updatedAt: serverTimestamp()
      };

      if (!editingCourse) {
        payload.createdAt = serverTimestamp();
        payload.enrolledStudents = [];
      }

      await setDoc(courseRef, payload, { merge: true });
      setShowAddEditModal(false);
    } catch (err) {
      console.error("Error saving course:", err);
      setFormError(err.message || "Failed to save course.");
    } finally {
      setSavingCourse(false);
    }
  };

  // Handle Deleting Course
  const handleDeleteCourse = async (course) => {
    if (!isCurrentAdmin) {
      alert("Only admins can delete courses.");
      return;
    }
    if (!window.confirm(`Are you sure you want to delete course "${course.code || course.courseCode} - ${course.name || course.courseName}"? This action cannot be undone.`)) {
      return;
    }
    try {
      await deleteDoc(doc(db, "courses", course.id));
    } catch (err) {
      alert("Error deleting course: " + err.message);
    }
  };

  // Open Roster Management Modal
  const handleOpenRosterModal = (course) => {
    setSelectedCourseForRoster(course);
    setSelectedStudentsToAdd([]);
    setRosterSearch("");
    setAvailableStudentSearch("");
    setShowAvailableStudents(false);
    setShowRosterModal(true);
  };

  // Remove Student from Course Roster
  const handleRemoveStudentFromCourse = async (rollNo) => {
    if (!selectedCourseForRoster) return;
    if (!window.confirm(`Remove student ${rollNo} from ${selectedCourseForRoster.code || selectedCourseForRoster.courseCode}?`)) return;

    try {
      const currentList = Array.isArray(selectedCourseForRoster.enrolledStudents) ? selectedCourseForRoster.enrolledStudents : [];
      const updatedList = currentList.filter((s) => {
        const r = typeof s === "string" ? s : s.rollNo || s.rollNumber;
        return String(r).toUpperCase().trim() !== String(rollNo).toUpperCase().trim();
      });

      await setDoc(doc(db, "courses", selectedCourseForRoster.id), {
        enrolledStudents: updatedList,
        updatedAt: serverTimestamp()
      }, { merge: true });

      setSelectedCourseForRoster((prev) => ({ ...prev, enrolledStudents: updatedList }));

      // Immediately notify student
      const actorName = profile?.name || profile?.email || "Faculty/Admin";
      const cleanRoll = String(rollNo).split("@")[0].toUpperCase().trim();
      if (cleanRoll) {
        sendStudentNotification(
          cleanRoll,
          "Class Update ℹ️",
          `You have been removed from class ${selectedCourseForRoster.code || selectedCourseForRoster.courseCode} by ${actorName}.`,
          "COURSE_UPDATE",
          actorName
        ).catch(() => {});
      }
    } catch (err) {
      alert("Failed to remove student: " + err.message);
    }
  };

  // Add Selected Students to Course
  const handleAddStudentsToCourse = async () => {
    if (!selectedCourseForRoster || selectedStudentsToAdd.length === 0) return;
    setSavingRoster(true);
    try {
      const currentList = Array.isArray(selectedCourseForRoster.enrolledStudents) ? selectedCourseForRoster.enrolledStudents : [];
      const existingRollSet = new Set(currentList.map((s) => String(typeof s === "string" ? s : s.rollNo || s.rollNumber || "").toUpperCase().trim()));

      const additions = selectedStudentsToAdd.filter((r) => !existingRollSet.has(String(r).toUpperCase().trim()));
      const updatedList = [...currentList, ...additions];

      await setDoc(doc(db, "courses", selectedCourseForRoster.id), {
        enrolledStudents: updatedList,
        updatedAt: serverTimestamp()
      }, { merge: true });

      setSelectedCourseForRoster((prev) => ({ ...prev, enrolledStudents: updatedList }));
      setSelectedStudentsToAdd([]);

      // Immediately notify added students
      const actorName = profile?.name || profile?.email || "Faculty/Admin";
      for (const roll of additions) {
        const cleanRoll = String(roll).split("@")[0].toUpperCase().trim();
        if (cleanRoll) {
          sendStudentNotification(
            cleanRoll,
            "Added to Class 📚",
            `You have been enrolled in class ${selectedCourseForRoster.code || selectedCourseForRoster.courseCode} by ${actorName}.`,
            "COURSE_ENROLLMENT",
            actorName
          ).catch(() => {});
        }
      }
    } catch (err) {
      alert("Failed to add students: " + err.message);
    } finally {
      setSavingRoster(false);
    }
  };

  // Export Course Roster to Excel
  const handleExportRoster = () => {
    if (!selectedCourseForRoster) return;
    const list = Array.isArray(selectedCourseForRoster.enrolledStudents) ? selectedCourseForRoster.enrolledStudents : [];
    const exportData = list.map((item, idx) => {
      const roll = typeof item === "string" ? item : item.rollNo || item.rollNumber;
      const studentMatch = allStudents.find((s) => String(s.rollNo || s.id || "").toUpperCase().trim() === String(roll).toUpperCase().trim());
      return {
        "Sl No": idx + 1,
        "Course Code": selectedCourseForRoster.code || selectedCourseForRoster.courseCode,
        "Course Name": selectedCourseForRoster.name || selectedCourseForRoster.courseName,
        "Roll Number": roll,
        "Student Name": studentMatch?.name || studentMatch?.fullName || "—",
        "Email": studentMatch?.email || "—",
        "Department": studentMatch?.branch || studentMatch?.department || selectedCourseForRoster.department || "—"
      };
    });

    downloadExcel(exportData, `${selectedCourseForRoster.code || "Course"}_Enrolled_Students.xlsx`);
  };

  // Export Full Course Directory to Excel
  const handleExportCoursesDirectory = () => {
    const exportData = sortedCourses.map((c, idx) => ({
      "S.No": idx + 1,
      "Course Code": c.courseCode,
      "Course Name": c.courseName,
      "Class / Room": c.classCode,
      "Department": c.department,
      "Semester": c.semester,
      "Credits": c.credits,
      "Assigned Lecturer": c.faculty.name,
      "Lecturer Email": c.faculty.email || "N/A",
      "Lecturer Department": c.faculty.department || c.department,
      "Enrolled Students": c.enrolledCount,
      "Classes Conducted": c.classesCount
    }));

    downloadExcel(exportData, `SmartAttend_Courses_Faculty_Directory_${new Date().toISOString().slice(0, 10)}`);
  };

  const enrolledRollSet = new Set((selectedCourseForRoster?.enrolledStudents || []).map((student) =>
    String(typeof student === "string" ? student : student?.rollNo || student?.rollNumber || "").trim().toUpperCase()
  ));
  const availableStudents = allStudents.filter((student) => {
    const roll = String(student.rollNo || student.rollNumber || student.id || "").trim();
    if (!roll || enrolledRollSet.has(roll.toUpperCase())) return false;
    if (!availableStudentSearch.trim()) return true;
    const query = availableStudentSearch.toLowerCase().trim();
    return [roll, student.name, student.fullName, student.email, student.branch, student.department]
      .some((value) => String(value || "").toLowerCase().includes(query));
  });

  return (
    <div className="courses-manager">
      {/* Header */}
      <div className="cm-header">
        <div className="cm-header-titles">
          <div className="cm-header-badge">
            <FaBookOpen />
            <span>ACADEMIC CURRICULUM &amp; FACULTY DIRECTORY</span>
          </div>
          <h1>Course &amp; Faculty Attendance</h1>
          <p>
            Browse courses with their respective assigned lecturers. Click any course or its classes count to inspect all attendance records conducted for that course.
          </p>
        </div>
        <div className="cm-header-actions">
          <button
            type="button"
            className="cm-btn cm-btn-secondary"
            onClick={handleExportCoursesDirectory}
            disabled={courses.length === 0}
            title="Download Course & Faculty Directory as Excel"
          >
            <FaFileExcel /> Export Directory
          </button>

          {(isCurrentAdmin || profile?.role === "admin" || profile?.role === "lecturer") && (
            <button
              type="button"
              className="cm-btn cm-btn-primary"
              onClick={() => handleOpenAddEditModal()}
            >
              <FaPlus /> Add New Course
            </button>
          )}
        </div>
      </div>

      {/* KPI Stats Grid */}
      <div className="cm-stats-grid">
        <div className="cm-stat-card">
          <div className="cm-stat-icon indigo"><FaBookOpen /></div>
          <div className="cm-stat-data">
            <span className="cm-stat-label">Total Courses</span>
            <span className="cm-stat-value">{stats.total}</span>
          </div>
        </div>
        {isCurrentLecturer && (
          <div className="cm-stat-card">
            <div className="cm-stat-icon emerald"><FaChalkboardTeacher /></div>
            <div className="cm-stat-data">
              <span className="cm-stat-label">My Assigned</span>
              <span className="cm-stat-value">{stats.myCount}</span>
            </div>
          </div>
        )}
        <div className="cm-stat-card">
          <div className="cm-stat-icon amber"><FaCalendarCheck /></div>
          <div className="cm-stat-data">
            <span className="cm-stat-label">Total Classes Held</span>
            <span className="cm-stat-value">{stats.totalSessions}</span>
          </div>
        </div>
        <div className="cm-stat-card">
          <div className="cm-stat-icon cyan"><FaClock /></div>
          <div className="cm-stat-data">
            <span className="cm-stat-label">Active Right Now</span>
            <span className="cm-stat-value">{stats.activeSessions}</span>
          </div>
        </div>
      </div>

      {/* Toolbar & Filters */}
      <div className="cm-toolbar">
        <div className="cm-toolbar-left">
          {isCurrentLecturer && (
            <div className="cm-scope-tabs">
              <button
                type="button"
                className={`cm-scope-btn ${activeTab === "my" ? "active" : ""}`}
                onClick={() => setActiveTab("my")}
              >
                <FaChalkboardTeacher /> My Courses ({stats.myCount})
              </button>
              <button
                type="button"
                className={`cm-scope-btn ${activeTab === "all" ? "active" : ""}`}
                onClick={() => setActiveTab("all")}
              >
                <FaBookOpen /> All Courses ({stats.total})
              </button>
            </div>
          )}

          <div className="cm-tabs">
            <button
              type="button"
              className={`cm-tab-btn ${selectedDept === "all" ? "active" : ""}`}
              onClick={() => setSelectedDept("all")}
            >
              All Departments
            </button>
            <button
              type="button"
              className={`cm-tab-btn ${selectedDept === "CSE" ? "active" : ""}`}
              onClick={() => setSelectedDept("CSE")}
            >
              CSE
            </button>
            <button
              type="button"
              className={`cm-tab-btn ${selectedDept === "DSAI" ? "active" : ""}`}
              onClick={() => setSelectedDept("DSAI")}
            >
              DSAI
            </button>
            <button
              type="button"
              className={`cm-tab-btn ${selectedDept === "ECE" ? "active" : ""}`}
              onClick={() => setSelectedDept("ECE")}
            >
              ECE
            </button>
            <button
              type="button"
              className={`cm-tab-btn ${selectedDept === "AIC" ? "active" : ""}`}
              onClick={() => setSelectedDept("AIC")}
            >
              AIC
            </button>
          </div>
        </div>

        <div className="cm-filter-controls">
          {/* View Mode Toggle Switcher */}
          <div className="cm-view-toggle">
            <button
              type="button"
              className={`cm-view-btn ${viewLayout === "table" ? "active" : ""}`}
              onClick={() => setViewLayout("table")}
              title="Table Directory View"
            >
              <FaTable /> <span>Table</span>
            </button>
            <button
              type="button"
              className={`cm-view-btn ${viewLayout === "grid" ? "active" : ""}`}
              onClick={() => setViewLayout("grid")}
              title="Grid Cards View"
            >
              <FaThLarge /> <span>Cards</span>
            </button>
          </div>

          <div className="cm-search-wrap">
            <FaSearch />
            <input
              type="text"
              className="cm-search-input"
              placeholder="Search code, title, faculty..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <select
            className="cm-select"
            value={selectedSemester}
            onChange={(e) => setSelectedSemester(e.target.value)}
          >
            <option value="all">All Semesters</option>
            <option value="1">Sem 1</option>
            <option value="2">Sem 2</option>
            <option value="3">Sem 3</option>
            <option value="4">Sem 4</option>
            <option value="5">Sem 5</option>
            <option value="6">Sem 6</option>
            <option value="7">Sem 7</option>
            <option value="8">Sem 8</option>
          </select>
        </div>
      </div>

      {/* Main Content Area */}
      {loading ? (
        <div className="cm-loading-wrap">
          <FaSyncAlt className="fa-spin" />
          <p>Loading course curriculum &amp; faculty data...</p>
        </div>
      ) : sortedCourses.length === 0 ? (
        <div className="cm-empty-state">
          <div className="cm-empty-icon">
            <FaBookOpen />
          </div>
          {courses.length === 0 ? (
            <>
              <h3>No Courses Created Yet</h3>
              <p>Your academic workspace has no curriculum courses registered in the database yet.</p>
              {(isCurrentAdmin || isCurrentLecturer) && (
                <div className="cm-empty-actions">
                  <button
                    type="button"
                    className="cm-btn cm-btn-primary"
                    onClick={() => handleOpenAddEditModal()}
                  >
                    <FaPlus /> Create First Course
                  </button>
                </div>
              )}
            </>
          ) : activeTab === "my" && stats.myCount === 0 ? (
            <>
              <h3>No Assigned Courses</h3>
              <p>You do not have any courses assigned to your faculty profile. Switch to view all institutional courses or create a new course.</p>
              <div className="cm-empty-actions">
                <button
                  type="button"
                  className="cm-btn cm-btn-secondary"
                  onClick={() => setActiveTab("all")}
                >
                  <FaBookOpen /> View All Courses ({stats.total})
                </button>
                {(isCurrentAdmin || isCurrentLecturer) && (
                  <button
                    type="button"
                    className="cm-btn cm-btn-primary"
                    onClick={() => handleOpenAddEditModal()}
                  >
                    <FaPlus /> Add New Course
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <h3>No Matching Courses</h3>
              <p>
                No courses match your filter criteria
                {selectedDept !== "all" ? ` (${selectedDept})` : ""}
                {selectedSemester !== "all" ? ` (Semester ${selectedSemester})` : ""}
                {searchTerm ? ` matching "${searchTerm}"` : ""}.
              </p>
              <div className="cm-empty-actions">
                <button
                  type="button"
                  className="cm-btn cm-btn-secondary"
                  onClick={() => {
                    setSearchTerm("");
                    setSelectedDept("all");
                    setSelectedSemester("all");
                  }}
                >
                  <FaUndo /> Reset All Filters
                </button>
                {(isCurrentAdmin || isCurrentLecturer) && (
                  <button
                    type="button"
                    className="cm-btn cm-btn-primary"
                    onClick={() => handleOpenAddEditModal()}
                  >
                    <FaPlus /> Add New Course
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ) : viewLayout === "table" ? (
        /* ==========================================================
           1. DIRECTORY TABLE VIEW (Courses + Respective Lecturers)
           ========================================================== */
        <div className="cm-table-scroll">
          <table className="cm-modern-table">
            <thead>
              <tr>
                <th className="sortable-th" onClick={() => requestSort("courseCode")} title="Sort by Course Code">
                  Course Code &amp; Title <SortIcon sortConfig={sortConfig} columnKey="courseCode" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("department")} title="Sort by Department">
                  Department &amp; Sem <SortIcon sortConfig={sortConfig} columnKey="department" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("faculty.name")} title="Sort by Assigned Faculty">
                  Respective Assigned Lecturer <SortIcon sortConfig={sortConfig} columnKey="faculty.name" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("classesCount")} title="Sort by Classes Conducted">
                  Classes Conducted <SortIcon sortConfig={sortConfig} columnKey="classesCount" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("enrolledCount")} title="Sort by Enrolled Students">
                  Enrolled Students <SortIcon sortConfig={sortConfig} columnKey="enrolledCount" />
                </th>
                <th style={{ textAlign: "right", paddingRight: "20px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedCourses.map((course) => {
                const isAssigned = isCourseAssignedToLecturer(course, user, profile);

                return (
                  <tr
                    key={course.id || course.courseCode}
                    className="cm-table-row"
                    onClick={() => handleOpenCourseDetail(course)}
                    title="Click to view course details and classes list"
                  >
                    {/* Course Code & Title */}
                    <td>
                      <div className="cm-table-course-cell">
                        <div className="cm-course-code-badge">
                          <FaBookOpen /> {course.courseCode}
                        </div>
                        <div className="cm-course-cell-text">
                          <strong className="cm-course-cell-title">{course.courseName}</strong>
                          <div className="cm-course-submeta">
                            <span className="cm-class-tag"><FaLayerGroup /> {course.classCode}</span>
                            <span className="cm-credits-tag"><FaGraduationCap /> {course.credits} Credits</span>
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Department & Semester */}
                    <td>
                      <div className="cm-dept-stack">
                        <span className="cm-dept-chip">
                          <FaBuilding /> {course.department}
                        </span>
                        <span className="cm-sem-chip">
                          Sem {course.semester}
                        </span>
                      </div>
                    </td>

                    {/* Respective Assigned Lecturer */}
                    <td>
                      <div className="cm-faculty-profile-cell">
                        <div className="cm-faculty-avatar">
                          {course.faculty.photoURL ? (
                            <img src={course.faculty.photoURL} alt={course.faculty.name} />
                          ) : (
                            <span>{course.faculty.name.charAt(0).toUpperCase()}</span>
                          )}
                        </div>
                        <div className="cm-faculty-text">
                          <div className="cm-faculty-name-row">
                            <strong className="cm-faculty-primary-name">{course.faculty.name}</strong>
                            {isAssigned && (
                              <span className="cm-you-badge">You</span>
                            )}
                          </div>
                          {course.faculty.email ? (
                            <div className="cm-faculty-email-row">
                              <FaEnvelope /> <span>{course.faculty.email}</span>
                            </div>
                          ) : (
                            <span className="cm-faculty-role-sub">{course.faculty.designation}</span>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Classes Conducted Pill (Click goes to Course Attendances!) */}
                    <td>
                      <div
                        className="cm-classes-conducted-pill"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenCourseAttendances(course.courseCode);
                        }}
                        title={`Click to view all ${course.classesCount} attendance sessions for ${course.courseCode}`}
                      >
                        <FaCalendarAlt className="cm-pill-icon" />
                        <span className="cm-pill-count">{course.classesCount}</span>
                        <span className="cm-pill-label">{course.classesCount === 1 ? "class" : "classes"}</span>
                        {course.activeClassesCount > 0 && (
                          <span className="cm-pill-live-dot" title="Live session active right now"></span>
                        )}
                      </div>
                    </td>

                    {/* Enrolled Students Pill */}
                    <td>
                      <div
                        className="cm-enrolled-pill"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenRosterModal(course);
                        }}
                        title="Click to view & manage student roster"
                      >
                        <FaUsers />
                        <span>{course.enrolledCount} Enrolled</span>
                      </div>
                    </td>

                    {/* Action Buttons */}
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="cm-table-actions-cell">
                        {/* 1-Click Go to Course Attendances */}
                        <button
                          type="button"
                          className="cm-table-btn cm-table-btn-attendance"
                          onClick={() => handleOpenCourseAttendances(course.courseCode)}
                          title={`View all attendance records for ${course.courseCode}`}
                        >
                          <FaChartBar /> <span>View Attendance</span>
                        </button>

                        {/* View Course Details Modal */}
                        <button
                          type="button"
                          className="cm-table-btn cm-table-btn-view"
                          onClick={() => handleOpenCourseDetail(course)}
                          title="View course information and session list"
                        >
                          <FaEye />
                        </button>

                        {/* Manage Roster */}
                        <button
                          type="button"
                          className="cm-table-btn cm-table-btn-roster"
                          onClick={() => handleOpenRosterModal(course)}
                          title="Manage enrolled students"
                        >
                          <FaUsers />
                        </button>

                        {/* Edit Course */}
                        {(isCurrentAdmin || canManageCourseForUser(course)) && (
                          <button
                            type="button"
                            className="cm-table-btn cm-table-btn-edit"
                            onClick={() => handleOpenAddEditModal(course)}
                            title="Edit course details"
                          >
                            <FaEdit />
                          </button>
                        )}

                        {/* Delete Course (Admin Only) */}
                        {isCurrentAdmin && (
                          <button
                            type="button"
                            className="cm-table-btn cm-table-btn-delete"
                            onClick={() => handleDeleteCourse(course)}
                            title="Delete course"
                          >
                            <FaTrashAlt />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        /* ==========================================================
           2. VISUAL CARDS GRID VIEW
           ========================================================== */
        <div className="cm-courses-grid">
          {sortedCourses.map((course) => {
            const isAssigned = isCourseAssignedToLecturer(course, user, profile);

            return (
              <div key={course.id || course.courseCode} className="cm-course-card">
                <div>
                  <div className="cm-course-card-top">
                    <span className="cm-course-code-badge">
                      <FaBookOpen /> {course.courseCode}
                    </span>
                    <span className="cm-course-code-badge" style={{ background: "rgba(99, 102, 241, 0.1)", color: "#6366f1" }}>
                      <FaLayerGroup /> Class: {course.classCode}
                    </span>
                    <span className="cm-course-dept-badge">
                      {course.department} · Sem {course.semester}
                    </span>
                  </div>

                  <h3
                    className="cm-course-title clickable"
                    onClick={() => handleOpenCourseDetail(course)}
                    title="Click to view course details"
                  >
                    {course.courseName}
                  </h3>

                  <div className="cm-course-meta-row">
                    <span className="cm-meta-item">
                      <FaGraduationCap /> {course.credits} Credits
                    </span>
                    <span
                      className="cm-meta-item cm-clickable-meta"
                      onClick={() => handleOpenRosterModal(course)}
                      title="View enrolled students"
                    >
                      <FaUsers /> {course.enrolledCount} Enrolled
                    </span>
                    <span
                      className="cm-meta-item cm-clickable-meta"
                      onClick={() => handleOpenCourseAttendances(course.courseCode)}
                      title="View classes conducted"
                      style={{ color: "#6366f1", fontWeight: 750 }}
                    >
                      <FaCalendarAlt /> {course.classesCount} {course.classesCount === 1 ? "Class" : "Classes"}
                    </span>
                  </div>

                  {/* Respective Faculty In-Charge */}
                  <div className="cm-course-faculty">
                    <div className="cm-faculty-label">
                      <FaChalkboardTeacher /> Respective Assigned Lecturer
                    </div>
                    <div className="cm-faculty-name">
                      <div className="cm-faculty-avatar-mini">
                        {course.faculty.photoURL ? (
                          <img src={course.faculty.photoURL} alt={course.faculty.name} />
                        ) : (
                          <span>{course.faculty.name.charAt(0).toUpperCase()}</span>
                        )}
                      </div>
                      <span className="cm-faculty-display-name">{course.faculty.name}</span>
                      {isAssigned && (
                        <span className="cm-you-badge">You</span>
                      )}
                    </div>
                    {course.faculty.email && (
                      <div className="cm-faculty-email-sub">
                        <FaEnvelope /> {course.faculty.email}
                      </div>
                    )}
                  </div>
                </div>

                <div className="cm-course-actions">
                  {/* Primary Button: View Course Attendance */}
                  <button
                    type="button"
                    className="cm-btn cm-btn-primary cm-btn-sm"
                    onClick={() => handleOpenCourseAttendances(course.courseCode)}
                    title={`Go to all attendances of ${course.courseCode}`}
                  >
                    <FaChartBar /> View Attendances ({course.classesCount})
                  </button>

                  {/* Lecturer Start Session Button */}
                  {isCurrentLecturer && canManageCourseForUser(course) && (
                    <Link
                      to={`/lecturer/lecturerpage?course=${encodeURIComponent(course.courseCode)}`}
                      className="cm-btn cm-btn-secondary cm-btn-sm"
                      title="Launch 2-Phase Attendance Session"
                    >
                      <FaQrcode /> QR
                    </Link>
                  )}

                  {/* Students Roster */}
                  <button
                    type="button"
                    className="cm-btn cm-btn-secondary cm-btn-sm"
                    onClick={() => handleOpenRosterModal(course)}
                    title="Manage Enrolled Students"
                  >
                    <FaUsers />
                  </button>

                  {/* Course Details */}
                  <button
                    type="button"
                    className="cm-btn cm-btn-secondary cm-btn-sm"
                    onClick={() => handleOpenCourseDetail(course)}
                    title="View Course Information"
                  >
                    <FaEye />
                  </button>

                  {/* Edit Course */}
                  {(isCurrentAdmin || canManageCourseForUser(course)) && (
                    <button
                      type="button"
                      className="cm-btn cm-btn-secondary cm-btn-sm cm-course-action-edit"
                      onClick={() => handleOpenAddEditModal(course)}
                      title="Edit Course"
                    >
                      <FaEdit />
                    </button>
                  )}

                  {/* Delete Course (Admin only) */}
                  {isCurrentAdmin && (
                    <button
                      type="button"
                      className="cm-btn cm-btn-danger cm-btn-sm"
                      onClick={() => handleDeleteCourse(course)}
                      title="Delete Course"
                    >
                      <FaTrashAlt />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Course Detail Modal */}
      {showCourseDetailModal && selectedCourseForDetail && (
        <CourseDetailModal
          course={selectedCourseForDetail}
          lecturers={lecturers}
          allStudents={allStudents}
          onClose={() => {
            setShowCourseDetailModal(false);
            setSelectedCourseForDetail(null);
          }}
          onOpenRoster={handleOpenRosterModal}
          onEditCourse={handleOpenAddEditModal}
          isAdmin={isCurrentAdmin}
        />
      )}

      {/* Add / Edit Course Modal */}
      {showAddEditModal && (
        <div className="cm-modal-backdrop" onClick={() => setShowAddEditModal(false)}>
          <div className="cm-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="cm-modal-header">
              <h2>{editingCourse ? <><FaEdit /> Edit Course</> : <><FaPlus /> Add New Course</>}</h2>
              <button
                type="button"
                className="cm-modal-close-btn"
                onClick={() => setShowAddEditModal(false)}
              >
                <FaTimes />
              </button>
            </div>

            <form onSubmit={handleSaveCourse}>
              <div className="cm-modal-body">
                {formError && (
                  <div className="cm-form-error-banner">
                    <FaExclamationTriangle /> {formError}
                  </div>
                )}

                <div className="cm-form-row">
                  <div className="cm-form-group">
                    <label>Course Code *</label>
                    <input
                      type="text"
                      className="cm-form-input"
                      placeholder="e.g. CS201, EC304"
                      value={formData.code}
                      onChange={(e) => setFormData((p) => ({ ...p, code: e.target.value.toUpperCase() }))}
                      disabled={Boolean(editingCourse)}
                      required
                    />
                  </div>
                  <div className="cm-form-group">
                    <label>Class Number / Code *</label>
                    <input
                      type="text"
                      className="cm-form-input"
                      placeholder="e.g. C003"
                      value={formData.classCode}
                      onChange={(e) => setFormData((p) => ({ ...p, classCode: e.target.value }))}
                      required
                    />
                  </div>
                </div>

                <div className="cm-form-group">
                  <label>Course Title / Name *</label>
                  <input
                    type="text"
                    className="cm-form-input"
                    placeholder="e.g. Operating Systems & Algorithms"
                    value={formData.name}
                    onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                    required
                  />
                </div>

                <div className="cm-form-row">
                  <div className="cm-form-group">
                    <label>Department</label>
                    <select
                      className="cm-form-select"
                      value={formData.department}
                      onChange={(e) => setFormData((p) => ({ ...p, department: e.target.value }))}
                    >
                      <option value="CSE">Computer Science &amp; Eng (CSE)</option>
                      <option value="DSAI">Data Science &amp; AI (DSAI)</option>
                      <option value="ECE">Electronics &amp; Comm (ECE)</option>
                      <option value="AIC">Artificial Intelligence &amp; Computing (AIC)</option>
                    </select>
                  </div>

                  <div className="cm-form-group">
                    <label>Semester</label>
                    <select
                      className="cm-form-select"
                      value={formData.semester}
                      onChange={(e) => setFormData((p) => ({ ...p, semester: e.target.value }))}
                    >
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

                <div className="cm-form-group">
                  <label>Assign Faculty / Lecturer In-Charge</label>
                  <select
                    className="cm-form-select"
                    value={formData.assignedLecturers && formData.assignedLecturers[0] ? (typeof formData.assignedLecturers[0] === "string" ? formData.assignedLecturers[0] : formData.assignedLecturers[0].email) : ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      setFormData((p) => ({ ...p, assignedLecturers: val ? [val] : [] }));
                    }}
                  >
                    <option value="">-- Choose Lecturer --</option>
                    {lecturers.map((lec) => (
                      <option key={lec.id || lec.email} value={lec.email}>
                        {lec.name || lec.displayName || lec.email} ({lec.email}) - {lec.department || "Faculty"}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="cm-form-group">
                  <label>Course Description / Syllabus Outline (Optional)</label>
                  <textarea
                    className="cm-form-textarea"
                    rows={3}
                    placeholder="Brief description of the course, prerequisites, syllabus..."
                    value={formData.description}
                    onChange={(e) => setFormData((p) => ({ ...p, description: e.target.value }))}
                  />
                </div>
              </div>

              <div className="cm-modal-footer">
                <button
                  type="button"
                  className="cm-btn cm-btn-secondary"
                  onClick={() => setShowAddEditModal(false)}
                  disabled={savingCourse}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cm-btn cm-btn-primary"
                  disabled={savingCourse}
                >
                  {savingCourse ? "Saving..." : editingCourse ? "Update Course" : "Create Course"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Manage Enrolled Students Roster Modal */}
      {showRosterModal && selectedCourseForRoster && (
        <div className="cm-modal-backdrop" onClick={() => setShowRosterModal(false)}>
          <div className="cm-modal-dialog lg" onClick={(e) => e.stopPropagation()}>
            <div className="cm-modal-header">
              <h2>
                <FaUsers /> Enrolled Students: {selectedCourseForRoster.code || selectedCourseForRoster.courseCode} ({selectedCourseForRoster.name || selectedCourseForRoster.courseName})
              </h2>
              <button
                type="button"
                className="cm-modal-close-btn"
                onClick={() => setShowRosterModal(false)}
              >
                <FaTimes />
              </button>
            </div>

            <div className="cm-modal-body">
              <div className="cm-roster-toolbar">
                <div className="cm-search-wrap">
                  <FaSearch />
                  <input
                    type="text"
                    className="cm-search-input"
                    placeholder="Search enrolled roll number or name..."
                    value={rosterSearch}
                    onChange={(e) => setRosterSearch(e.target.value)}
                  />
                </div>

                <div className="cm-roster-actions">
                  <button
                    type="button"
                    className="cm-btn cm-btn-secondary cm-btn-sm"
                    onClick={handleExportRoster}
                    title="Export enrolled students list to Excel"
                  >
                    <FaFileExcel /> Export Excel
                  </button>

                  {(isCurrentAdmin || canManageCourseForUser(selectedCourseForRoster)) && (
                    <button
                      type="button"
                      className="cm-btn cm-btn-primary cm-btn-sm"
                      onClick={() => setShowAvailableStudents((p) => !p)}
                    >
                      <FaUserPlus /> {showAvailableStudents ? "Hide Add Students" : "Add Students"}
                    </button>
                  )}
                </div>
              </div>

              {/* Available Students Picker Accordion */}
              {showAvailableStudents && (
                <section className="cm-available-students">
                  <div className="cm-available-header">
                    <div>
                      <h3>Add Students to {selectedCourseForRoster.code || selectedCourseForRoster.courseCode}</h3>
                      <p>Select registered students below to enroll them into this course.</p>
                    </div>
                    <div className="cm-available-header-actions">
                      <input
                        type="text"
                        className="cm-search-input cm-sm"
                        placeholder="Filter un-enrolled students..."
                        value={availableStudentSearch}
                        onChange={(e) => setAvailableStudentSearch(e.target.value)}
                      />
                      <button
                        type="button"
                        className="cm-btn cm-btn-primary cm-btn-sm"
                        onClick={handleAddStudentsToCourse}
                        disabled={savingRoster || selectedStudentsToAdd.length === 0}
                      >
                        <FaUserPlus /> Add Selected ({selectedStudentsToAdd.length})
                      </button>
                    </div>
                  </div>
                  <div className="cm-available-list">
                    {availableStudents.length === 0 ? (
                      <p className="cm-available-empty">No un-enrolled registered students match this search.</p>
                    ) : availableStudents.map((student) => {
                      const roll = String(student.rollNo || student.rollNumber || student.id || "").trim();
                      const checked = selectedStudentsToAdd.includes(roll);
                      return (
                        <label className="cm-available-student" key={roll}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setSelectedStudentsToAdd((selected) =>
                              checked ? selected.filter((item) => item !== roll) : [...selected, roll]
                            )}
                          />
                          <span className="cm-available-student-info">
                            <strong>{student.name || student.fullName || "Unnamed student"}</strong>
                            <span>{roll}{student.email ? ` · ${student.email}` : ""}</span>
                          </span>
                          <span className="cm-available-student-dept">{student.branch || student.department || "—"}</span>
                        </label>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Enrolled Students Table */}
              <div className="cm-roster-table-wrap">
                <table className="cm-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Roll Number</th>
                      <th>Student Name</th>
                      <th>Department</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const rawList = Array.isArray(selectedCourseForRoster.enrolledStudents) ? selectedCourseForRoster.enrolledStudents : [];
                      const filteredList = rawList.filter((item) => {
                        const roll = typeof item === "string" ? item : item.rollNo || item.rollNumber;
                        if (!rosterSearch.trim()) return true;
                        return String(roll).toLowerCase().includes(rosterSearch.toLowerCase().trim());
                      });

                      if (filteredList.length === 0) {
                        return (
                          <tr>
                            <td colSpan={5} style={{ textAlign: "center", padding: "30px", color: "var(--text-muted, #64748b)" }}>
                              No students are enrolled in this course yet. Use "Add Students" to choose students or batch enroll the department.
                            </td>
                          </tr>
                        );
                      }

                      return filteredList.map((item, idx) => {
                        const roll = typeof item === "string" ? item : item.rollNo || item.rollNumber;
                        const studentMatch = allStudents.find((s) => String(s.rollNo || s.id || "").toUpperCase().trim() === String(roll).toUpperCase().trim());

                        return (
                          <tr key={roll || idx}>
                            <td>{idx + 1}</td>
                            <td>
                              <strong style={{ color: "var(--accent, #6366f1)" }}>{roll}</strong>
                            </td>
                            <td>{studentMatch?.name || studentMatch?.fullName || "—"}</td>
                            <td>{studentMatch?.branch || studentMatch?.department || selectedCourseForRoster.department || "CSE"}</td>
                            <td>
                              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                {studentMatch && (
                                  <button
                                    type="button"
                                    className="cm-btn cm-btn-secondary cm-btn-sm"
                                    onClick={() => {
                                      setSelectedStudentForDetail(studentMatch);
                                      setShowStudentDetailModal(true);
                                    }}
                                  >
                                    View
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="cm-btn cm-btn-danger cm-btn-sm"
                                  onClick={() => handleRemoveStudentFromCourse(roll)}
                                  title="Remove from course"
                                >
                                  <FaTrashAlt />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="cm-modal-footer">
              <button
                type="button"
                className="cm-btn cm-btn-primary"
                onClick={() => setShowRosterModal(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Student Detail Modal */}
      {showStudentDetailModal && selectedStudentForDetail && (
        <StudentDetailModal
          student={selectedStudentForDetail}
          onClose={() => {
            setShowStudentDetailModal(false);
            setSelectedStudentForDetail(null);
          }}
        />
      )}
    </div>
  );
}
