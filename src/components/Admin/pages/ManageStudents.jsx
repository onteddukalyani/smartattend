import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  FaSearch,
  FaUserPlus,
  FaFileExcel,
  FaUserSlash,
  FaCheckCircle,
  FaUserCheck,
  FaTrashAlt,
  FaEye,
  FaEdit,
  FaTimes,
  FaSyncAlt,
  FaUserTimes
} from "react-icons/fa";

import {
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  serverTimestamp,
  onSnapshot
} from "firebase/firestore";

import { db } from "../../../firebase";
import StudentDetailModal from "../../Common/StudentDetailModal";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import { removeStudentFaceAndBiometrics } from "../../../utils/biometricManager";

import { mergeAllStudentRecords, normalizeDescriptor } from "../../../utils/studentDataHelper";

const ManageStudents = () => {
  const navigate = useNavigate();

  const [students, setStudents] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);
  const [selectedStudent, setSelectedStudent] = useState(null);

  // Edit Student State
  const [editingStudent, setEditingStudent] = useState(null);
  const [editForm, setEditForm] = useState({
    rollNo: "",
    name: "",
    email: "",
    branch: "CSE",
    semester: "1",
    phone: "",
    status: "active"
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [cleaningUp, setCleaningUp] = useState(false);
  const [legacyDocsCount, setLegacyDocsCount] = useState(0);

  const loadStudents = useCallback(async () => {
    try {
      setLoading(true);
      const [authSnap, studentsSnap, usersSnap] = await Promise.all([
        getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "students")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "users")).catch(() => ({ docs: [] }))
      ]);

      const merged = mergeAllStudentRecords(authSnap.docs, studentsSnap.docs, usersSnap.docs);
      setStudents(merged);
    } catch (err) {
      console.error("Error loading students:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let authDocs = [];
    let studentsDocs = [];
    let usersDocs = [];

    const recomputeStudents = () => {
      const merged = mergeAllStudentRecords(authDocs, studentsDocs, usersDocs);
      setStudents(merged);
      setLoading(false);
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

  // Comprehensive migration of separated collections (students, lecturers, admins) & General → CSE in Firestore
  const migrateGeneralToCSEInFirestore = async () => {
    try {
      setCleaningUp(true);
      let updatedCount = 0;

      // 1. Process users & separate into students, lecturers, admins
      const usersSnap = await getDocs(collection(db, "users")).catch(() => ({ docs: [] }));
      for (const docSnap of usersSnap.docs) {
        const d = docSnap.data();
        const role = String(d.role || "").toLowerCase().trim();
        const email = (d.email || (docSnap.id.includes("@") ? docSnap.id : "")).toLowerCase().trim();
        const prefix = email ? email.split("@")[0] : docSnap.id.toLowerCase();
        const rollNo = (d.rollNo || (/^\d{2}[a-zA-Z]{3}\d{2,4}$/i.test(docSnap.id) ? docSnap.id : "")).toUpperCase();

        const updates = {};
        if (d.branch && String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
        if (d.department && String(d.department).toLowerCase() === "general") updates.department = "CSE";

        const mergedData = { ...d, ...updates };

        // Ensure proper branch / department defaults
        if (!mergedData.branch && (role === "student" || rollNo)) mergedData.branch = "CSE";

        if (role === "student" || rollNo || mergedData.semester) {
          mergedData.role = "student";
          if (!mergedData.branch || String(mergedData.branch).toLowerCase() === "general") mergedData.branch = "CSE";
          const studentDocId = rollNo || prefix || docSnap.id;
          await setDoc(doc(db, "students", studentDocId), mergedData, { merge: true }).catch(() => {});
          if (prefix && prefix !== studentDocId) {
            await setDoc(doc(db, "students", prefix), mergedData, { merge: true }).catch(() => {});
          }
        } else if (role === "lecturer" || role === "faculty" || role === "professor") {
          mergedData.role = "lecturer";
          if (!mergedData.department || String(mergedData.department).toLowerCase() === "general") mergedData.department = "Computer Science & Engineering";
          const lectDocId = prefix || docSnap.id;
          await setDoc(doc(db, "lecturers", lectDocId), mergedData, { merge: true }).catch(() => {});
          if (email && email !== lectDocId) {
            await setDoc(doc(db, "lecturers", email), mergedData, { merge: true }).catch(() => {});
          }
        } else if (role === "admin" || role === "superadmin" || role === "administrator") {
          mergedData.role = "admin";
          const adminDocId = prefix || docSnap.id;
          await setDoc(doc(db, "admins", adminDocId), mergedData, { merge: true }).catch(() => {});
          if (email && email !== adminDocId) {
            await setDoc(doc(db, "admins", email), mergedData, { merge: true }).catch(() => {});
          }
        }

        if (Object.keys(updates).length > 0) {
          await setDoc(doc(db, "users", docSnap.id), updates, { merge: true }).catch(() => {});
          updatedCount++;
        }
      }

      // 2. students collection
      const studentsSnap = await getDocs(collection(db, "students")).catch(() => ({ docs: [] }));
      for (const docSnap of studentsSnap.docs) {
        const d = docSnap.data();
        const updates = {};
        if (!d.branch || String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
        if (d.department && String(d.department).toLowerCase() === "general") updates.department = "CSE";
        if (Object.keys(updates).length > 0) {
          await setDoc(doc(db, "students", docSnap.id), updates, { merge: true }).catch(() => {});
          updatedCount++;
        }
      }

      // 3. lecturers collection
      const lecturersSnap = await getDocs(collection(db, "lecturers")).catch(() => ({ docs: [] }));
      for (const docSnap of lecturersSnap.docs) {
        const d = docSnap.data();
        const updates = {};
        if (d.branch && String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
        if (d.department && String(d.department).toLowerCase() === "general") updates.department = "Computer Science & Engineering";
        if (Object.keys(updates).length > 0) {
          await setDoc(doc(db, "lecturers", docSnap.id), updates, { merge: true }).catch(() => {});
          updatedCount++;
        }
      }

      // 4. admins collection
      const adminsSnap = await getDocs(collection(db, "admins")).catch(() => ({ docs: [] }));
      for (const docSnap of adminsSnap.docs) {
        const d = docSnap.data();
        const updates = {};
        if (d.branch && String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
        if (d.department && String(d.department).toLowerCase() === "general") updates.department = "Administration";
        if (Object.keys(updates).length > 0) {
          await setDoc(doc(db, "admins", docSnap.id), updates, { merge: true }).catch(() => {});
          updatedCount++;
        }
      }

      // 5. authorizedUsers collection
      const authSnap = await getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] }));
      for (const docSnap of authSnap.docs) {
        const d = docSnap.data();
        const updates = {};
        if (d.branch && String(d.branch).toLowerCase() === "general") updates.branch = "CSE";
        if (d.department && String(d.department).toLowerCase() === "general") updates.department = "CSE";
        if (Object.keys(updates).length > 0) {
          await setDoc(doc(db, "authorizedUsers", docSnap.id), updates, { merge: true }).catch(() => {});
          updatedCount++;
        }
      }

      // 6. courses collection
      const coursesSnap = await getDocs(collection(db, "courses")).catch(() => ({ docs: [] }));
      for (const docSnap of coursesSnap.docs) {
        const d = docSnap.data();
        const updates = {};
        if (!d.department || String(d.department).toLowerCase() === "general") updates.department = "CSE";
        if (d.courseCode && String(d.courseCode).toLowerCase() === "general") updates.courseCode = "CSE";
        if (Object.keys(updates).length > 0) {
          await setDoc(doc(db, "courses", docSnap.id), updates, { merge: true }).catch(() => {});
          updatedCount++;
        }
      }

      // 7. attendance_sessions collection
      const sessionsSnap = await getDocs(collection(db, "attendance_sessions")).catch(() => ({ docs: [] }));
      for (const docSnap of sessionsSnap.docs) {
        const d = docSnap.data();
        const updates = {};
        if (d.lecturerDepartment && String(d.lecturerDepartment).toLowerCase() === "general") updates.lecturerDepartment = "CSE";
        if (d.courseCode && String(d.courseCode).toLowerCase() === "general") updates.courseCode = "CSE";
        if (Object.keys(updates).length > 0) {
          await setDoc(doc(db, "attendance_sessions", docSnap.id), updates, { merge: true }).catch(() => {});
          updatedCount++;
        }
      }

      alert(`✅ Database Organized & Migrated!\n• Collections separated into 'students', 'lecturers', 'admins'.\n• Updated ${updatedCount} records to 'CSE' branch.`);
      await loadStudents();
    } catch (err) {
      console.error("Migration error:", err);
      alert("Migration failed: " + err.message);
    } finally {
      setCleaningUp(false);
    }
  };

  const cleanupLegacyDocs = async () => {
    const confirmed = window.confirm(
      "This will remove the old random-ID documents from Firestore, keeping only clean documents saved with Roll Numbers as Document IDs. Continue?"
    );
    if (!confirmed) return;

    try {
      setCleaningUp(true);
      const snapshot = await getDocs(collection(db, "users"));

      let deleted = 0;
      for (const docSnap of snapshot.docs) {
        const data = docSnap.data();
        const currentId = docSnap.id;
        const roll = (data.rollNo || "").trim().toUpperCase();

        const role = String(data.role || "").toLowerCase().trim();
        const isStudent = role === "student" || Boolean(data.rollNo) || Boolean(data.semester) || Boolean(data.branch) || /^\d{2}[a-zA-Z]{3}\d{2,4}$/i.test(currentId);

        if (!isStudent || role === "lecturer" || role === "faculty" || role === "admin") {
          continue;
        }

        // If ID is random string and not the roll number
        if (roll && currentId !== roll) {
          const rollDoc = await getDoc(doc(db, "users", roll));
          if (!rollDoc.exists()) {
            await setDoc(doc(db, "users", roll), { ...data, rollNo: roll, role: "student" });
          }
          await setDoc(doc(db, "students", roll), { ...data, rollNo: roll, role: "student" }, { merge: true }).catch(() => { });
          await deleteDoc(doc(db, "users", currentId));
          await deleteDoc(doc(db, "students", currentId)).catch(() => { });
          deleted++;
        }
      }

      alert(`✅ Cleanup complete! Removed ${deleted} legacy random-ID documents. All students are now stored with Roll Numbers as Document IDs.`);
      await loadStudents();
    } catch (err) {
      console.error("Cleanup error:", err);
      alert("Cleanup failed: " + err.message);
    } finally {
      setCleaningUp(false);
    }
  };

  const toggleStudentStatus = async (student) => {
    const currentlyActive = student.status === "active";
    const newStatus = currentlyActive ? "disabled" : "active";

    try {
      setUpdating(student.id);
      const roll = (student.rollNo || student.id).trim().toUpperCase();
      const emailKey = student.email ? student.email.toLowerCase().trim() : null;
      const prefix = emailKey ? emailKey.split("@")[0].toLowerCase().trim() : null;

      const promises = [
        setDoc(doc(db, "users", roll), { status: newStatus }, { merge: true }),
        setDoc(doc(db, "students", roll), { status: newStatus }, { merge: true })
      ];

      if (student.id && student.id !== roll) {
        promises.push(setDoc(doc(db, "users", student.id), { status: newStatus }, { merge: true }));
        promises.push(setDoc(doc(db, "students", student.id), { status: newStatus }, { merge: true }).catch(() => { }));
      }

      if (emailKey) {
        promises.push(setDoc(doc(db, "authorizedUsers", emailKey), { status: newStatus }, { merge: true }).catch(() => { }));
        promises.push(setDoc(doc(db, "students", emailKey), { status: newStatus }, { merge: true }).catch(() => { }));
      }

      if (prefix && prefix !== emailKey && prefix !== roll.toLowerCase()) {
        promises.push(setDoc(doc(db, "authorizedUsers", prefix), { status: newStatus }, { merge: true }).catch(() => { }));
        promises.push(setDoc(doc(db, "students", prefix), { status: newStatus }, { merge: true }).catch(() => { }));
      }

      await Promise.all(promises);

      setStudents((previous) =>
        previous.map((item) =>
          item.id === student.id || item.rollNo === roll
            ? { ...item, status: newStatus }
            : item
        )
      );
    } catch (error) {
      console.error("Error updating student status:", error);
      alert("Unable to update student status.");
    } finally {
      setUpdating(null);
    }
  };

  const removeStudent = async (student) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete ${student.name || student.rollNo || "this student"}? This will permanently remove their record from SmartAttend.`
    );

    if (!confirmed) return;

    try {
      setUpdating(student.id);
      const roll = (student.rollNo || student.id).trim().toUpperCase();
      const email = student.email ? student.email.toLowerCase().trim() : null;
      const prefix = email ? email.split("@")[0].toLowerCase().trim() : null;

      const promises = [
        deleteDoc(doc(db, "users", roll)).catch(() => { }),
        deleteDoc(doc(db, "students", roll)).catch(() => { })
      ];

      if (student.id && student.id !== roll) {
        promises.push(deleteDoc(doc(db, "users", student.id)).catch(() => { }));
        promises.push(deleteDoc(doc(db, "students", student.id)).catch(() => { }));
      }

      if (email) {
        promises.push(deleteDoc(doc(db, "authorizedUsers", email)).catch(() => { }));
        promises.push(deleteDoc(doc(db, "students", email)).catch(() => { }));
      }

      if (prefix && prefix !== email && prefix !== roll.toLowerCase()) {
        promises.push(deleteDoc(doc(db, "authorizedUsers", prefix)).catch(() => { }));
        promises.push(deleteDoc(doc(db, "students", prefix)).catch(() => { }));
      }

      await Promise.all(promises);

      setStudents((previous) =>
        previous.filter((item) => item.id !== student.id && item.rollNo !== roll)
      );
    } catch (error) {
      console.error("Error removing student:", error);
      alert("Unable to delete student. Please try again.");
    } finally {
      setUpdating(null);
    }
  };

  const handleOpenEdit = (student, e) => {
    e.stopPropagation();
    setEditingStudent(student);
    setEditForm({
      rollNo: student.rollNo || "",
      name: student.name || "",
      email: student.email || "",
      branch: (student.branch && String(student.branch).toLowerCase() !== "general") ? student.branch : "CSE",
      semester: student.semester || "1",
      phone: student.phone || "",
      status: student.status || "active"
    });
    setEditError("");
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    if (!editForm.rollNo.trim()) {
      setEditError("Roll number is required.");
      return;
    }
    if (!editForm.name.trim()) {
      setEditError("Full name is required.");
      return;
    }
    if (!editForm.email.trim()) {
      setEditError("Email is required.");
      return;
    }

    try {
      setEditSaving(true);
      setEditError("");

      const cleanRollNo = editForm.rollNo.trim().toUpperCase();
      const cleanEmail = editForm.email.trim().toLowerCase();
      const prefix = cleanEmail.split("@")[0].toLowerCase().trim();
      const oldDocId = editingStudent.id;
      const oldRollNo = (editingStudent.rollNo || "").trim().toUpperCase();

      // Check if new roll number is taken by another student
      if (cleanRollNo !== oldRollNo && cleanRollNo !== oldDocId) {
        const [checkUserDoc, checkStudentDoc] = await Promise.all([
          getDoc(doc(db, "users", cleanRollNo)).catch(() => ({ exists: () => false })),
          getDoc(doc(db, "students", cleanRollNo)).catch(() => ({ exists: () => false }))
        ]);
        if (checkUserDoc.exists() || checkStudentDoc.exists()) {
          setEditError(`Roll number ${cleanRollNo} is already in use by another student.`);
          return;
        }
      }

      const updatedData = {
        ...editingStudent,
        role: "student",
        rollNo: cleanRollNo,
        name: editForm.name.trim(),
        email: cleanEmail,
        branch: (editForm.branch && String(editForm.branch).toLowerCase() !== "general") ? editForm.branch.trim() : "CSE",
        semester: editForm.semester || "1",
        phone: editForm.phone.trim() || "",
        status: editForm.status,
        updatedAt: serverTimestamp()
      };

      // 1. Save in students and users collections using Roll Number as Document ID
      await setDoc(doc(db, "students", cleanRollNo), updatedData);
      if (prefix && prefix !== cleanRollNo.toLowerCase()) {
        await setDoc(doc(db, "students", prefix), updatedData, { merge: true }).catch(() => { });
      }
      await setDoc(doc(db, "users", cleanRollNo), updatedData);
      if (prefix && prefix !== cleanRollNo.toLowerCase()) {
        await setDoc(doc(db, "users", prefix), updatedData, { merge: true }).catch(() => { });
      }

      // 2. Also update authorizedUsers if matching email exists
      if (cleanEmail) {
        try {
          await setDoc(doc(db, "authorizedUsers", cleanEmail), {
            name: editForm.name.trim(),
            rollNo: cleanRollNo,
            branch: (editForm.branch && String(editForm.branch).toLowerCase() !== "general") ? editForm.branch.trim() : "CSE",
            semester: editForm.semester || "1",
            phone: editForm.phone.trim() || "",
            status: editForm.status,
            role: "student"
          }, { merge: true });

          if (prefix && prefix !== cleanEmail) {
            await setDoc(doc(db, "authorizedUsers", prefix), {
              name: editForm.name.trim(),
              rollNo: cleanRollNo,
              branch: (editForm.branch && String(editForm.branch).toLowerCase() !== "general") ? editForm.branch.trim() : "CSE",
              semester: editForm.semester || "1",
              phone: editForm.phone.trim() || "",
              status: editForm.status,
              role: "student"
            }, { merge: true }).catch(() => { });
          }
        } catch (authErr) {
          console.warn("Could not update authorizedUsers:", authErr);
        }
      }

      // 3. If previous document had a legacy random ID or different rollNo, remove old docs
      if (oldDocId && oldDocId !== cleanRollNo) {
        try {
          await deleteDoc(doc(db, "users", oldDocId));
          await deleteDoc(doc(db, "students", oldDocId)).catch(() => { });
        } catch (delErr) {
          console.warn("Could not delete legacy student doc:", delErr);
        }
      }

      // Update in state
      setStudents((prev) =>
        prev.map((s) => (s.id === oldDocId || s.rollNo === oldRollNo ? { ...updatedData, id: cleanRollNo } : s))
      );

      setEditingStudent(null);
    } catch (err) {
      console.error("Error updating student:", err);
      setEditError("Failed to update student: " + err.message);
    } finally {
      setEditSaving(false);
    }
  };

  const handleRemoveFaceBiometrics = async (student, event) => {
    if (event) event.stopPropagation();
    const studentName = student.name || "Student";
    const studentRoll = student.rollNo || student.id || "";

    const confirm = window.confirm(
      `⚠️ ADMIN ACTION: Remove Facial Biometrics & Photo?\n\nAre you sure you want to remove the registered facial biometric data and enrolled photo for ${studentName} (${studentRoll})?\n\nThis will permanently clear their 128-D biometric vector and avatar photo across all database collections.`
    );
    if (!confirm) return;

    try {
      setUpdating(student.id);
      const cleanRoll = String(student.rollNo || student.id || "").trim().toUpperCase();

      await removeStudentFaceAndBiometrics(student);

      const updated = {
        faceRegistered: false,
        biometricEnrolled: false,
        hasFaceRegistered: false,
        faceDescriptor: null,
        photoURL: "",
        image: "",
        photo: ""
      };

      setStudents((prev) =>
        prev.map((s) =>
          s.id === student.id || (cleanRoll && s.rollNo === cleanRoll)
            ? { ...s, ...updated }
            : s
        )
      );

      if (selectedStudent && (selectedStudent.id === student.id || selectedStudent.rollNo === cleanRoll)) {
        setSelectedStudent((prev) => prev ? { ...prev, ...updated } : null);
      }

      alert(`✅ Facial biometric data and photo for ${studentName} (${cleanRoll}) have been successfully removed.`);
    } catch (err) {
      console.error("Error removing face biometrics:", err);
      alert("Failed to remove face biometrics: " + err.message);
    } finally {
      setUpdating(null);
    }
  };

  const filteredStudents = students.filter((student) => {
    const value = search.toLowerCase().trim();

    if (!value) return true;

    return (
      student.name?.toLowerCase().includes(value) ||
      student.email?.toLowerCase().includes(value) ||
      student.rollNo?.toLowerCase().includes(value) ||
      student.branch?.toLowerCase().includes(value)
    );
  });

  const { sortedItems: sortedStudents, sortConfig, requestSort } = useTableSort(filteredStudents, "rollNo", "asc");

  return (
    <div className="manage-students">

      {/* Header */}
      <div className="students-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "15px" }}>
        <div>
          <h1>Students</h1>
          <p>
            Manage students and click any student to view their profile and full attendance history.
          </p>
        </div>

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <button
            className="add-student-btn"
            style={{ background: "var(--surface-soft, #f8fafc)", color: "var(--text-main, #333)", border: "1px solid var(--border, #cbd5e1)" }}
            type="button"
            disabled={loading}
            onClick={loadStudents}
            title="Refresh students list from database"
          >
            <FaSyncAlt className={loading ? "fa-spin" : ""} />
            {loading ? "Refreshing..." : "Refresh"}
          </button>

          <button
            className="add-student-btn"
            style={{ background: "#6366f1", color: "#ffffff" }}
            type="button"
            disabled={cleaningUp}
            onClick={migrateGeneralToCSEInFirestore}
            title="Scan database and migrate any 'General' records to 'CSE' in Firestore"
          >
            <FaSyncAlt className={cleaningUp ? "fa-spin" : ""} />
            {cleaningUp ? "Updating DB..." : "Migrate General → CSE"}
          </button>

          {legacyDocsCount > 0 && (
            <button
              className="add-student-btn"
              style={{ background: "#f59e0b", color: "#ffffff" }}
              type="button"
              disabled={cleaningUp}
              onClick={cleanupLegacyDocs}
              title="Clean up legacy random ID documents from Firestore"
            >
              <FaSyncAlt className={cleaningUp ? "fa-spin" : ""} />
              {cleaningUp ? "Cleaning..." : `Clean Legacy IDs (${legacyDocsCount})`}
            </button>
          )}

          <button
            className="add-student-btn"
            style={{ background: "linear-gradient(135deg, #10b981, #059669)", color: "#ffffff", border: "none" }}
            type="button"
            onClick={() => navigate("/admin/students/add?tab=bulk")}
          >
            <FaFileExcel />
            Bulk Upload
          </button>

          <button
            className="add-student-btn"
            type="button"
            onClick={() => navigate("/admin/students/add?tab=single")}
          >
            <FaUserPlus />
            Add Student
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="students-toolbar">

        <div className="student-search">
          <FaSearch />

          <input
            type="text"
            placeholder="Search roll number, name, email or branch..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="student-count">
          {filteredStudents.length} student
          {filteredStudents.length !== 1 ? "s" : ""}
        </div>

      </div>

      {/* Table */}
      <div className="students-table-container">

        {loading ? (
          <div className="students-loading">
            Loading students...
          </div>
        ) : filteredStudents.length === 0 ? (

          <div className="students-empty">
            <FaUserPlus />

            <h3>
              {search
                ? "No matching students"
                : "No students registered"}
            </h3>

            <p>
              {search
                ? "Try a different search."
                : "Add a single student or upload students in bulk via Excel/CSV."}
            </p>

            <div style={{ display: "flex", gap: "10px", marginTop: "14px", justifyContent: "center", flexWrap: "wrap" }}>
              <button
                className="add-student-btn"
                style={{ background: "linear-gradient(135deg, #10b981, #059669)", color: "#ffffff", border: "none" }}
                type="button"
                onClick={() => navigate("/admin/students/add?tab=bulk")}
              >
                <FaFileExcel />
                Bulk Upload
              </button>

              <button
                className="add-student-btn"
                type="button"
                onClick={() => navigate("/admin/students/add?tab=single")}
              >
                <FaUserPlus />
                Add Student
              </button>
            </div>
          </div>

        ) : (

          <table className="students-table">

            <thead>
              <tr>
                <th className="sortable-th" onClick={() => requestSort("rollNo")} title="Click to sort by Roll Number">
                  Roll Number <SortIcon sortConfig={sortConfig} columnKey="rollNo" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("name")} title="Click to sort by Student Name">
                  Student <SortIcon sortConfig={sortConfig} columnKey="name" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("branch")} title="Click to sort by Branch">
                  Branch <SortIcon sortConfig={sortConfig} columnKey="branch" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("semester")} title="Click to sort by Semester">
                  Semester <SortIcon sortConfig={sortConfig} columnKey="semester" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("faceRegistered")} title="Click to sort by Face Registration">
                  Face <SortIcon sortConfig={sortConfig} columnKey="faceRegistered" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("status")} title="Click to sort by Status">
                  Status <SortIcon sortConfig={sortConfig} columnKey="status" />
                </th>
                <th>Actions</th>
              </tr>
            </thead>

            <tbody>

              {sortedStudents.map((student) => (

                <tr
                  key={student.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelectedStudent(student)}
                  title="Click to view student attendance & details"
                >

                  <td>
                    <strong>{student.rollNo || "-"}</strong>
                  </td>

                  <td>
                    <div className="student-info">

                      {student.photoURL ? (
                        <img
                          src={student.photoURL}
                          alt=""
                        />
                      ) : (
                        <div className="student-avatar">
                          {student.name
                            ?.charAt(0)
                            .toUpperCase() || "S"}
                        </div>
                      )}

                      <div>
                        <strong>
                          {student.name || "Unnamed Student"}
                        </strong>

                        <span>
                          {student.email || "No email"}
                        </span>
                      </div>

                    </div>
                  </td>

                  <td>
                    {student.branch || "-"}
                  </td>

                  <td>
                    {student.semester || "-"}
                  </td>

                  <td>

                    {student.faceRegistered ? (
                      <span className="face-registered">
                        <FaCheckCircle />
                        Registered
                      </span>
                    ) : (
                      <span className="face-not-registered">
                        Not Registered
                      </span>
                    )}

                  </td>

                  <td>

                    <span
                      className={
                        student.status === "active"
                          ? "status-active"
                          : "status-disabled"
                      }
                    >
                      {student.status || "active"}
                    </span>

                  </td>

                  <td onClick={(e) => e.stopPropagation()}>

                    <div className="student-actions">

                      <button
                        type="button"
                        title="View student profile & attendance"
                        onClick={() => setSelectedStudent(student)}
                      >
                        <FaEye />
                      </button>

                      <button
                        type="button"
                        className="edit-button"
                        title="Edit student"
                        onClick={(e) => handleOpenEdit(student, e)}
                      >
                        <FaEdit />
                      </button>

                      <button
                        type="button"
                        title={
                          student.status === "active"
                            ? "Disable student"
                            : "Enable student"
                        }
                        disabled={updating === student.id}
                        onClick={() =>
                          toggleStudentStatus(student)
                        }
                      >
                        {student.status === "active"
                          ? <FaUserSlash />
                          : <FaUserCheck />}
                      </button>

                      {student.faceRegistered && (
                        <button
                          type="button"
                          className="remove-face-button"
                          title="Admin only: Remove registered facial biometrics"
                          disabled={updating === student.id}
                          onClick={(e) => handleRemoveFaceBiometrics(student, e)}
                        >
                          <FaUserTimes />
                        </button>
                      )}

                      <button
                        type="button"
                        className="delete-button"
                        style={{ color: "#ef4444" }}
                        title="Delete student"
                        disabled={updating === student.id}
                        onClick={() => removeStudent(student)}
                      >
                        <FaTrashAlt />
                      </button>

                    </div>

                  </td>

                </tr>

              ))}

            </tbody>

          </table>

        )}

      </div>

      {/* Student Details Modal */}
      {selectedStudent && (
        <StudentDetailModal
          student={selectedStudent}
          onClose={() => setSelectedStudent(null)}
          onUpdate={(updatedStudent) => {
            if (!updatedStudent) return;
            setSelectedStudent(updatedStudent);
            setStudents((prev) =>
              prev.map((s) =>
                s.id === updatedStudent.id || s.rollNo === updatedStudent.rollNo
                  ? { ...s, ...updatedStudent }
                  : s
              )
            );
          }}
        />
      )}

      {/* Edit Student Modal */}
      {editingStudent && (
        <div className="edit-modal-overlay" onClick={() => setEditingStudent(null)}>
          <div className="edit-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="edit-modal-header">
              <div>
                <h2>Edit Student Details</h2>
                <p>Update information for {editingStudent.name || editingStudent.rollNo}</p>
              </div>
              <button
                type="button"
                className="close-modal-btn"
                onClick={() => setEditingStudent(null)}
              >
                <FaTimes />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="edit-student-form">
              {editError && <div className="edit-form-error">{editError}</div>}

              <div className="edit-form-grid">
                <div className="edit-form-field">
                  <label>Roll Number *</label>
                  <input
                    type="text"
                    value={editForm.rollNo}
                    onChange={(e) => setEditForm({ ...editForm, rollNo: e.target.value.toUpperCase() })}
                    placeholder="e.g. 25BCS017"
                    required
                  />
                  <small style={{ color: "var(--text-muted, #64748b)", fontSize: "0.76rem" }}>
                    Stored as Document ID in Firestore.
                  </small>
                </div>

                <div className="edit-form-field">
                  <label>Full Name *</label>
                  <input
                    type="text"
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    placeholder="Enter full name"
                    required
                  />
                </div>

                <div className="edit-form-field">
                  <label>Email Address *</label>
                  <input
                    type="email"
                    value={editForm.email}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                    placeholder="student@iiitdwd.ac.in"
                    required
                  />
                </div>

                <div className="edit-form-field">
                  <label>Branch</label>
                  <select
                    value={editForm.branch}
                    onChange={(e) => setEditForm({ ...editForm, branch: e.target.value })}
                  >
                    <option value="CSE">CSE</option>
                    <option value="DSAI">DSAI</option>
                    <option value="ECE">ECE</option>
                    <option value="AIC">AIC</option>
                  </select>
                </div>

                <div className="edit-form-field">
                  <label>Semester</label>
                  <select
                    value={editForm.semester}
                    onChange={(e) => setEditForm({ ...editForm, semester: e.target.value })}
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((sem) => (
                      <option key={sem} value={String(sem)}>Semester {sem}</option>
                    ))}
                  </select>
                </div>

                <div className="edit-form-field">
                  <label>Phone Number</label>
                  <input
                    type="tel"
                    value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                    placeholder="e.g. +91 9876543210"
                  />
                </div>

                <div className="edit-form-field">
                  <label>Account Status</label>
                  <select
                    value={editForm.status}
                    onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                  >
                    <option value="active">Active</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>
              </div>

              <div className="edit-modal-footer">
                <button
                  type="button"
                  className="cancel-btn"
                  onClick={() => setEditingStudent(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="save-btn"
                  disabled={editSaving}
                >
                  {editSaving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};

export default ManageStudents;