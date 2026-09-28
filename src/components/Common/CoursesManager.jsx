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
  FaUndo
} from "react-icons/fa";
import { db } from "../../firebase";
import { useAuth } from "../authcontext";
import { downloadExcel } from "../../DownloadExcel";
import { mergeAllStudentRecords } from "../../utils/studentDataHelper";
import StudentDetailModal from "./StudentDetailModal";
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
  const [refreshing, setRefreshing] = useState(false);

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

    // Lecturers listener
    const unsubUsers = onSnapshot(collection(db, "users"), (snapshot) => {
      const lecs = [];
      snapshot.forEach((d) => {
        const data = d.data();
        if (data.role === "lecturer" || data.role === "faculty" || data.role === "admin") {
          lecs.push({ id: d.id, ...data });
        }
      });
      setLecturers(lecs);
    }, () => { });
    unsubs.push(unsubUsers);

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

  // Filtered Courses
  const filteredCourses = useMemo(() => {
    return courses.filter((c) => {
      // Tab filter
      if (activeTab === "my") {
        if (!isCourseAssignedToLecturer(c, user, profile)) return false;
      }

      // Dept filter
      if (selectedDept !== "all" && c.department && c.department.toUpperCase() !== selectedDept.toUpperCase()) {
        return false;
      }

      // Semester filter
      if (selectedSemester !== "all" && String(c.semester || "") !== String(selectedSemester)) {
        return false;
      }

      // Search term
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase().trim();
        const code = (c.code || "").toLowerCase();
        const name = (c.name || "").toLowerCase();
        const dept = (c.department || "").toLowerCase();
        const lecturer = (c.lecturer || c.lecturerName || "").toLowerCase();
        return code.includes(q) || name.includes(q) || dept.includes(q) || lecturer.includes(q);
      }

      return true;
    });
  }, [courses, activeTab, selectedDept, selectedSemester, searchTerm, user, profile]);

  // Statistics calculation
  const stats = useMemo(() => {
    const total = courses.length;
    const myCount = courses.filter((c) => isCourseAssignedToLecturer(c, user, profile)).length;
    const totalSessions = sessions.length;
    const activeSessions = sessions.filter((s) => s.status === "ACTIVE" || s.phase === "PHASE_1" || s.phase === "PHASE_2").length;
    return { total, myCount, totalSessions, activeSessions };
  }, [courses, sessions, user, profile]);

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
    if (!window.confirm(`Are you sure you want to delete course "${course.code} - ${course.name}"? This action cannot be undone.`)) {
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
    if (!window.confirm(`Remove student ${rollNo} from ${selectedCourseForRoster.code}?`)) return;

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
          "Course Roster Update ℹ️",
          `You have been un-enrolled from course ${selectedCourseForRoster.code} (${selectedCourseForRoster.name}) by ${actorName}.`,
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
            "Course Enrollment 📚",
            `You have been enrolled in course ${selectedCourseForRoster.code} (${selectedCourseForRoster.name}) by ${actorName}.`,
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

  // Batch Add All Students of Branch / Batch
  const handleBatchAddBranchStudents = async () => {
    if (!selectedCourseForRoster) return;
    if (!isCurrentAdmin && !canManageCourseForUser(selectedCourseForRoster)) {
      alert("You can only batch-enroll students for courses assigned to your lecturer profile.");
      return;
    }
    const dept = selectedCourseForRoster.department || "CSE";
    const normalizeRoll = (value) => String(value || "").split("@")[0].toUpperCase().trim();
    const matchingByRoll = new Map();
    allStudents.forEach((student) => {
      const branch = String(student.branch || student.department || "").toUpperCase().trim();
      const roll = normalizeRoll(student.rollNo || student.rollNumber || student.id);
      if (branch === dept.toUpperCase().trim() && roll && !matchingByRoll.has(roll)) {
        matchingByRoll.set(roll, student);
      }
    });
    const matching = Array.from(matchingByRoll.values());

    if (matching.length === 0) {
      alert(`No registered students found in department ${dept}.`);
      return;
    }

    if (!window.confirm(`Add all ${matching.length} unique students from ${dept} to ${selectedCourseForRoster.code}?`)) return;

    setSavingRoster(true);
    try {
      const currentList = Array.isArray(selectedCourseForRoster.enrolledStudents) ? selectedCourseForRoster.enrolledStudents : [];
      const existingRollSet = new Set();
      const uniqueCurrentList = currentList.filter((student) => {
        const roll = normalizeRoll(typeof student === "string" ? student : student?.rollNo || student?.rollNumber);
        if (!roll) return true;
        if (existingRollSet.has(roll)) return false;
        existingRollSet.add(roll);
        return true;
      });

      const additions = matching
        .map((student) => normalizeRoll(student.rollNo || student.rollNumber || student.id))
        .filter((r) => r && !existingRollSet.has(r));

      const updatedList = [...uniqueCurrentList, ...additions];

      await setDoc(doc(db, "courses", selectedCourseForRoster.id), {
        enrolledStudents: updatedList,
        updatedAt: serverTimestamp()
      }, { merge: true });

      setSelectedCourseForRoster((prev) => ({ ...prev, enrolledStudents: updatedList }));

      // Immediately notify all enrolled students
      const actorName = profile?.name || profile?.email || "Faculty/Admin";
      for (const roll of additions) {
        const cleanRoll = String(roll).split("@")[0].toUpperCase().trim();
        if (cleanRoll) {
          sendStudentNotification(
            cleanRoll,
            "Course Enrollment 📚",
            `You have been enrolled in course ${selectedCourseForRoster.code} (${selectedCourseForRoster.name}) by ${actorName}.`,
            "COURSE_ENROLLMENT",
            actorName
          ).catch(() => {});
        }
      }

      alert(`Successfully enrolled ${additions.length} students into ${selectedCourseForRoster.code}!`);
    } catch (err) {
      alert("Error batch enrolling: " + err.message);
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
        "Course Code": selectedCourseForRoster.code,
        "Course Name": selectedCourseForRoster.name,
        "Roll Number": roll,
        "Student Name": studentMatch?.name || studentMatch?.fullName || "—",
        "Email": studentMatch?.email || "—",
        "Department": studentMatch?.branch || studentMatch?.department || selectedCourseForRoster.department || "—"
      };
    });

    downloadExcel(exportData, `${selectedCourseForRoster.code}_Enrolled_Students.xlsx`);
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
          <h1>Course Management</h1>
          <p>Manage curriculum subjects, faculty assignments, enrolled student rosters, and active attendance sessions.</p>
        </div>
        <div className="cm-header-actions">
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
            <span className="cm-stat-label">Total Sessions</span>
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

      {/* Course Cards Grid */}
      {loading ? (
        <div className="cm-loading-wrap">
          <FaSyncAlt className="fa-spin" />
          <p>Loading course curriculum...</p>
        </div>
      ) : filteredCourses.length === 0 ? (
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
      ) : (
        <div className="cm-courses-grid">
          {filteredCourses.map((course) => {
            const courseCode = course.code || course.courseCode || course.id || "Course";
            const courseName = course.name || course.courseName || course.title || `Untitled course (${courseCode})`;
            const enrolledStudents = Array.isArray(course.enrolledStudents) ? course.enrolledStudents : [];
            const enrolledCount = new Set(enrolledStudents
              .map((student) => String(typeof student === "string" ? student : student?.rollNo || student?.rollNumber || "").trim().toUpperCase())
              .filter(Boolean)).size;
            const isAssigned = isCourseAssignedToLecturer(course, user, profile);

            return (
              <div key={course.id || course.code || courseCode} className="cm-course-card">
                <div>
                  <div className="cm-course-card-top">
                    <span className="cm-course-code-badge">
                      <FaBookOpen /> {courseCode}
                    </span>
                    <span className="cm-course-code-badge" style={{ background: "rgba(99, 102, 241, 0.1)", color: "#6366f1" }}>
                      <FaLayerGroup /> Class: {course.classCode || course.classNumber || "C003"}
                    </span>
                    <span className="cm-course-dept-badge">
                      {normalizeCourseDepartment(course.department)} · Sem {course.semester || 4}
                    </span>
                  </div>

                  <h3 className="cm-course-title">{courseName}</h3>

                  <div className="cm-course-meta-row">
                    <span className="cm-meta-item">
                      <FaGraduationCap /> {course.credits || 4} Credits
                    </span>
                    <span className="cm-meta-item">
                      <FaUsers /> {enrolledCount} Enrolled
                    </span>
                  </div>

                  <div className="cm-course-faculty">
                    <div className="cm-faculty-label">
                      <FaChalkboardTeacher /> Faculty In-Charge
                    </div>
                    <div className="cm-faculty-name">
                      {course.lecturer || course.lecturerName || (course.assignedLecturers && course.assignedLecturers[0]) || "Not Assigned"}
                      {isAssigned && (
                        <span style={{ fontSize: "0.72rem", background: "rgba(16, 185, 129, 0.12)", color: "#10b981", padding: "2px 6px", borderRadius: "4px" }}>
                          You
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="cm-course-actions">
                  {isCurrentLecturer && canManageCourseForUser(course) && (
                    <Link
                      to={`/lecturer/lecturerpage?course=${encodeURIComponent(courseCode)}`}
                      className="cm-btn cm-btn-primary cm-btn-sm"
                      title="Launch 2-Phase Attendance Session"
                    >
                      <FaQrcode /> Start Session
                    </Link>
                  )}

                  {(isCurrentAdmin || canManageCourseForUser(course)) && (
                    <button
                      type="button"
                      className="cm-btn cm-btn-secondary cm-btn-sm"
                      onClick={() => handleOpenRosterModal(course)}
                      title="Manage Enrolled Students"
                    >
                      <FaUsers /> Students ({enrolledCount})
                    </button>
                  )}

                  {(isCurrentAdmin || canManageCourseForUser(course)) && (
                    <button
                      type="button"
                      className="cm-btn cm-btn-secondary cm-btn-sm cm-course-action-edit"
                      onClick={() => handleOpenAddEditModal(course)}
                      title="Edit Course"
                      aria-label={`Edit ${courseName}`}
                    >
                      <FaEdit /> <span>Edit</span>
                    </button>
                  )}

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
                  <div style={{ padding: "10px 14px", borderRadius: "10px", background: "#fee2e2", border: "1px solid #fca5a5", color: "#b91c1c", fontSize: "0.85rem", marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px" }}>
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
                      onChange={(e) => setFormData((p) => ({ ...p, classCode: e.target.value.toUpperCase() }))}
                      required
                    />
                  </div>
                  <div className="cm-form-group">
                    <label>Department *</label>
                    <select
                      className="cm-form-select"
                      value={formData.department}
                      onChange={(e) => setFormData((p) => ({ ...p, department: e.target.value }))}
                      required
                    >
                      <option value="CSE">CSE</option>
                      <option value="DSAI">DSAI</option>
                      <option value="ECE">ECE</option>
                      <option value="AIC">AIC</option>
                    </select>
                  </div>
                </div>

                <div className="cm-form-group">
                  <label>Course Title *</label>
                  <input
                    type="text"
                    className="cm-form-input"
                    placeholder="e.g. Data Structures and Algorithms"
                    value={formData.name}
                    onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                    required
                  />
                </div>

                <div className="cm-form-row">
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
                  <div className="cm-form-group">
                    <label>Credits</label>
                    <select
                      className="cm-form-select"
                      value={formData.credits}
                      onChange={(e) => setFormData((p) => ({ ...p, credits: e.target.value }))}
                    >
                      <option value="1">1 Credit</option>
                      <option value="2">2 Credits</option>
                      <option value="3">3 Credits</option>
                      <option value="4">4 Credits</option>
                      <option value="6">6 Credits</option>
                    </select>
                  </div>
                </div>

                <div className="cm-form-group">
                  <label>Assigned Faculty In-Charge</label>
                  <select
                    className="cm-form-select"
                    value={formData.assignedLecturers[0] || ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      setFormData((p) => ({ ...p, assignedLecturers: val ? [val] : [] }));
                    }}
                  >
                    <option value="">-- Select Faculty Member --</option>
                    {lecturers.map((lec) => (
                      <option key={lec.id || lec.email} value={lec.email}>
                        {lec.name || lec.displayName || lec.email} ({lec.email})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="cm-form-group">
                  <label>Course Description / Syllabus Notes (Optional)</label>
                  <textarea
                    rows={3}
                    className="cm-form-textarea"
                    placeholder="Brief description of the course content..."
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
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cm-btn cm-btn-primary"
                  disabled={savingCourse}
                >
                  {savingCourse ? <><FaSyncAlt className="fa-spin" /> Saving...</> : <><FaCheckCircle /> Save Course</>}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Course Roster / Enrolled Students Modal */}
      {showRosterModal && selectedCourseForRoster && (
        <div className="cm-modal-backdrop" onClick={() => setShowRosterModal(false)}>
          <div className="cm-modal-dialog lg" onClick={(e) => e.stopPropagation()}>
            <div className="cm-modal-header">
              <h2>
                <FaUsers /> Enrolled Students · {selectedCourseForRoster.code} ({selectedCourseForRoster.name})
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
              {/* Roster Controls */}
              <div className="cm-roster-toolbar">
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: "240px" }}>
                  <div className="cm-search-wrap" style={{ maxWidth: "260px" }}>
                    <FaSearch />
                    <input
                      type="text"
                      className="cm-search-input"
                      placeholder="Search enrolled students..."
                      value={rosterSearch}
                      onChange={(e) => setRosterSearch(e.target.value)}
                    />
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <button
                    type="button"
                    className="cm-btn cm-btn-primary cm-btn-sm"
                    onClick={() => {
                      setShowAvailableStudents((visible) => !visible);
                      setSelectedStudentsToAdd([]);
                    }}
                    aria-expanded={showAvailableStudents}
                  >
                    <FaUserPlus /> Add Students
                  </button>
                  <button
                    type="button"
                    className="cm-btn cm-btn-secondary cm-btn-sm"
                    onClick={handleExportRoster}
                  >
                    <FaFileExcel /> Export Excel
                  </button>
                  <button
                    type="button"
                    className="cm-btn cm-btn-primary cm-btn-sm"
                    onClick={handleBatchAddBranchStudents}
                    disabled={savingRoster}
                  >
                    <FaUserPlus /> Batch Enroll All {selectedCourseForRoster.department || "CSE"}
                  </button>
                </div>
              </div>

              {showAvailableStudents && (
                <section className="cm-available-students" aria-label="Add students to this course">
                  <div className="cm-available-header">
                    <div>
                      <h3>Add students to {selectedCourseForRoster.code || selectedCourseForRoster.id}</h3>
                      <p>Select registered students who are not already enrolled.</p>
                    </div>
                    <div className="cm-available-actions">
                      <div className="cm-search-wrap">
                        <FaSearch />
                        <input
                          type="search"
                          className="cm-search-input"
                          placeholder="Search name, roll number, email..."
                          value={availableStudentSearch}
                          onChange={(e) => setAvailableStudentSearch(e.target.value)}
                        />
                      </div>
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
