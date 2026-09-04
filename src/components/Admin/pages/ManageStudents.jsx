import React, { useEffect, useState } from "react";
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
  FaSyncAlt
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
  serverTimestamp
} from "firebase/firestore";

import { db } from "../../../firebase";
import StudentDetailModal from "../../Common/StudentDetailModal";
import { useTableSort, SortIcon } from "../../Common/useTableSort";

import "./ManageStudents.css";

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
    branch: "General",
    semester: "1",
    phone: "",
    status: "active"
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [cleaningUp, setCleaningUp] = useState(false);
  const [legacyDocsCount, setLegacyDocsCount] = useState(0);

  useEffect(() => {
    loadStudents();
  }, []);

  const loadStudents = async () => {
    try {
      setLoading(true);

      const [usersSnap, authUsersSnap] = await Promise.all([
        getDocs(collection(db, "users")).catch((e) => {
          console.warn("Could not read users collection:", e);
          return { docs: [] };
        }),
        getDocs(collection(db, "authorizedUsers")).catch((e) => {
          console.warn("Could not read authorizedUsers collection:", e);
          return { docs: [] };
        })
      ]);

      const studentsMap = new Map();
      let legacyCount = 0;

      // 1. Ingest students from authorizedUsers
      authUsersSnap.docs.forEach((docSnap) => {
        const data = docSnap.data();
        const role = String(data.role || "").toLowerCase().trim();
        if (role === "student") {
          const roll = (data.rollNo || docSnap.id).trim().toUpperCase();
          studentsMap.set(roll, {
            id: docSnap.id,
            ...data,
            rollNo: roll,
            role: "student",
            status: data.status || "active"
          });
        }
      });

      // 2. Ingest students from users collection
      usersSnap.docs.forEach((studentDoc) => {
        const data = studentDoc.data();
        const currentId = studentDoc.id;
        const role = String(data.role || "").toLowerCase().trim();

        // Exclude faculty and admins
        if (role === "lecturer" || role === "admin" || role === "faculty" || role === "professor") {
          return;
        }

        // Detect student by role, rollNo, branch, semester, or roll-like ID
        const isStudent = role === "student" ||
          Boolean(data.rollNo) ||
          Boolean(data.semester) ||
          Boolean(data.branch) ||
          /^\d{2}[a-zA-Z]{3}\d{2,4}$/i.test(currentId);

        if (!isStudent) return;

        const roll = (data.rollNo || currentId).trim().toUpperCase();

        if (currentId !== roll) {
          legacyCount++;
        }

        const existing = studentsMap.get(roll) || {};
        studentsMap.set(roll, {
          ...existing,
          ...data,
          id: currentId === roll ? currentId : (existing.id || currentId),
          userDocId: currentId,
          rollNo: roll,
          name: data.name || existing.name || "Student",
          email: data.email || existing.email || "",
          branch: data.branch || existing.branch || "General",
          semester: data.semester || existing.semester || "1",
          phone: data.phone || existing.phone || "",
          status: data.status || existing.status || "active",
          faceRegistered: data.faceRegistered || existing.faceRegistered || false,
          role: "student"
        });
      });

      setLegacyDocsCount(legacyCount);
      const studentList = Array.from(studentsMap.values());

      studentList.sort((a, b) => {
        const rollA = a.rollNo || "";
        const rollB = b.rollNo || "";
        return rollA.localeCompare(rollB, undefined, { numeric: true, sensitivity: 'base' });
      });

      setStudents(studentList);
    } catch (error) {
      console.error("Error loading students:", error);
    } finally {
      setLoading(false);
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
          await deleteDoc(doc(db, "users", currentId));
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

      const promises = [
        setDoc(doc(db, "users", roll), { status: newStatus }, { merge: true })
      ];

      if (student.id && student.id !== roll) {
        promises.push(setDoc(doc(db, "users", student.id), { status: newStatus }, { merge: true }));
      }

      if (emailKey) {
        promises.push(setDoc(doc(db, "authorizedUsers", emailKey), { status: newStatus }, { merge: true }).catch(() => {}));
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

      const promises = [
        deleteDoc(doc(db, "users", roll)).catch(() => {})
      ];

      if (student.id && student.id !== roll) {
        promises.push(deleteDoc(doc(db, "users", student.id)).catch(() => {}));
      }

      if (email) {
        promises.push(deleteDoc(doc(db, "authorizedUsers", email)).catch(() => {}));
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
      branch: student.branch || "General",
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
      const oldDocId = editingStudent.id;
      const oldRollNo = (editingStudent.rollNo || "").trim().toUpperCase();

      // Check if new roll number is taken by another student
      if (cleanRollNo !== oldRollNo && cleanRollNo !== oldDocId) {
        const checkDoc = await getDoc(doc(db, "users", cleanRollNo));
        if (checkDoc.exists()) {
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
        branch: editForm.branch.trim() || "General",
        semester: editForm.semester || "1",
        phone: editForm.phone.trim() || "",
        status: editForm.status,
        updatedAt: serverTimestamp()
      };

      // 1. Always save student using Roll Number as Document ID
      const newDocRef = doc(db, "users", cleanRollNo);
      await setDoc(newDocRef, updatedData);

      // 2. Also update authorizedUsers if matching email exists
      if (cleanEmail) {
        try {
          await setDoc(doc(db, "authorizedUsers", cleanEmail), {
            name: editForm.name.trim(),
            rollNo: cleanRollNo,
            branch: editForm.branch.trim() || "General",
            semester: editForm.semester || "1",
            phone: editForm.phone.trim() || "",
            status: editForm.status,
            role: "student"
          }, { merge: true });
        } catch (authErr) {
          console.warn("Could not update authorizedUsers:", authErr);
        }
      }

      // 3. If previous document had a legacy random ID or different rollNo, remove old doc
      if (oldDocId && oldDocId !== cleanRollNo) {
        try {
          await deleteDoc(doc(db, "users", oldDocId));
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
            style={{ background: "#10b981" }}
            type="button"
            onClick={() => navigate("/admin/students/add")}
          >
            <FaFileExcel />
            Bulk Upload
          </button>

          <button
            className="add-student-btn"
            type="button"
            onClick={() => navigate("/admin/students/add")}
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

            <div style={{ display: "flex", gap: "10px", marginTop: "14px", justifyContent: "center" }}>
              <button
                className="add-student-btn"
                style={{ background: "#10b981" }}
                type="button"
                onClick={() => navigate("/admin/students/add")}
              >
                <FaFileExcel />
                Bulk Upload
              </button>

              <button
                className="add-student-btn"
                type="button"
                onClick={() => navigate("/admin/students/add")}
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
                    <option value="General">General</option>
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