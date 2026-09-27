import React, { useState, useRef, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  FaArrowLeft,
  FaSave,
  FaFileExcel,
  FaFileUpload,
  FaDownload,
  FaCheckCircle,
  FaExclamationTriangle,
  FaTrashAlt,
  FaUserPlus
} from "react-icons/fa";
import {
  setDoc,
  getDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp,
  writeBatch,
  doc,
  deleteDoc
} from "firebase/firestore";
import * as XLSX from "xlsx";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import { LiveFaceEnrollment } from "../../Common/LiveFaceEnrollment";
import { checkDuplicateFaceBiometrics } from "../../../utils/biometricManager";
import { normalizeBranchName } from "../../../utils/studentDataHelper";
import "./AddStudent.css";

const AddStudent = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile } = useAuth();
  const isLecturer = location.pathname.startsWith("/lecturer") || (!location.pathname.startsWith("/admin") && profile?.role === "lecturer");
  const studentsPath = isLecturer ? "/lecturer/students" : "/admin/students";
  const fileInputRef = useRef(null);

  // Determine initial tab from query string or URL path
  const searchParams = new URLSearchParams(location.search);
  const initialTab = searchParams.get("tab") === "bulk" || location.pathname.includes("/bulk") ? "bulk" : "single";

  // Tab State: "single" | "bulk"
  const [activeTab, setActiveTab] = useState(initialTab);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tabParam = params.get("tab");
    if (tabParam === "bulk" || location.pathname.includes("/bulk")) {
      setActiveTab("bulk");
    } else if (tabParam === "single") {
      setActiveTab("single");
    }
  }, [location.search, location.pathname]);

  // --- Single Student Form State ---
  const [form, setForm] = useState({
    name: "",
    rollNo: "",
    email: "",
    phone: "",
    branch: "CSE",
    semester: "1",
    gender: "",
    dob: ""
  });
  const [enrolledBiometric, setEnrolledBiometric] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [lecturerConflict, setLecturerConflict] = useState(null);

  // --- Bulk Upload State ---
  const [bulkFile, setBulkFile] = useState(null);
  const [parsedStudents, setParsedStudents] = useState([]);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkSummary, setBulkSummary] = useState(null);
  const [bulkError, setBulkError] = useState("");

  const { sortedItems: sortedParsedStudents, sortConfig, requestSort } = useTableSort(parsedStudents, "rowNumber", "asc");

  // =========================================================
  // SINGLE STUDENT HANDLERS
  // =========================================================
  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => {
      const updated = {
        ...prev,
        [name]: value
      };
      // Auto-suggest branch and email when typing roll number if empty or default
      if (name === "rollNo") {
        const cleanRoll = value.trim().toUpperCase();
        if (cleanRoll) {
          if (!prev.email || prev.email.endsWith("@iiitdwd.ac.in")) {
            updated.email = `${cleanRoll.toLowerCase()}@iiitdwd.ac.in`;
          }
          if (/bcs/i.test(cleanRoll)) updated.branch = "CSE";
          else if (/bds/i.test(cleanRoll)) updated.branch = "DSAI";
          else if (/bec/i.test(cleanRoll)) updated.branch = "ECE";
          else if (/aic/i.test(cleanRoll)) updated.branch = "AIC";
        }
      }
      return updated;
    });
  };

  const handleSingleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLecturerConflict(null);

    const cleanRollNo = form.rollNo.trim().toUpperCase();
    const cleanEmail = form.email.trim().toLowerCase();
    const prefix = cleanEmail.split("@")[0].toLowerCase().trim();
    const rollLower = cleanRollNo.toLowerCase();

    if (!cleanRollNo) {
      setError("Roll number is required.");
      return;
    }
    if (!form.name.trim()) {
      setError("Student name is required.");
      return;
    }
    if (!cleanEmail) {
      setError("Email address is required.");
      return;
    }

    try {
      setSaving(true);

      // 1. Check duplicate roll number across collections
      const [rollSnapUsers, rollSnapStudents, rollDocUser, rollDocStudent] = await Promise.all([
        getDocs(query(collection(db, "users"), where("rollNo", "==", cleanRollNo))).catch(() => ({ empty: true, docs: [] })),
        getDocs(query(collection(db, "students"), where("rollNo", "==", cleanRollNo))).catch(() => ({ empty: true, docs: [] })),
        getDoc(doc(db, "users", cleanRollNo)).catch(() => ({ exists: () => false })),
        getDoc(doc(db, "students", cleanRollNo)).catch(() => ({ exists: () => false }))
      ]);

      const existingRollDocs = [
        ...rollSnapUsers.docs,
        ...rollSnapStudents.docs,
        ...(rollDocUser.exists() ? [rollDocUser] : []),
        ...(rollDocStudent.exists() ? [rollDocStudent] : [])
      ];

      for (const d of existingRollDocs) {
        const data = d.data();
        const existingEmail = (data.email || "").toLowerCase().trim();
        const existingRole = (data.role || "").toLowerCase().trim();
        // If it's a different student email already attached to this roll number
        if (existingEmail && existingEmail !== cleanEmail && existingRole === "student") {
          setError(`Roll number ${cleanRollNo} is already assigned to "${data.name || "Student"}" (${existingEmail}).`);
          setSaving(false);
          return;
        }
      }

      // 2. Check duplicate email across collections
      const [emailSnapUsers, emailSnapStudents, emailSnapAuth, emailDocAuth] = await Promise.all([
        getDocs(query(collection(db, "users"), where("email", "==", cleanEmail))).catch(() => ({ empty: true, docs: [] })),
        getDocs(query(collection(db, "students"), where("email", "==", cleanEmail))).catch(() => ({ empty: true, docs: [] })),
        getDocs(query(collection(db, "authorizedUsers"), where("email", "==", cleanEmail))).catch(() => ({ empty: true, docs: [] })),
        getDoc(doc(db, "authorizedUsers", cleanEmail)).catch(() => ({ exists: () => false }))
      ]);

      const existingEmailDocs = [
        ...emailSnapUsers.docs,
        ...emailSnapStudents.docs,
        ...emailSnapAuth.docs,
        ...(emailDocAuth.exists() ? [emailDocAuth] : [])
      ];

      for (const d of existingEmailDocs) {
        const data = d.data();
        const role = (data.role || "").toLowerCase().trim();
        if (role === "lecturer" || role === "faculty" || role === "professor") {
          setLecturerConflict({
            docId: d.id,
            name: data.name || "Lecturer",
            email: cleanEmail
          });
          setError(`This email (${cleanEmail}) is currently registered under Lecturers as "${data.name || "Faculty"}". You can convert this account to a Student below, or manage it in Manage Lecturers.`);
          setSaving(false);
          return;
        } else if (role === "admin" || role === "administrator" || role === "superadmin") {
          setError(`This email (${cleanEmail}) is registered as an Administrator account. Administrator accounts cannot be added as students.`);
          setSaving(false);
          return;
        }
      }

      // 3. Biometric duplicate check if face vector is provided
      if (enrolledBiometric?.faceDescriptor) {
        const duplicateCheck = await checkDuplicateFaceBiometrics(enrolledBiometric.faceDescriptor, cleanRollNo, cleanEmail);
        if (duplicateCheck.isDuplicate && duplicateCheck.conflictStudent) {
          const cs = duplicateCheck.conflictStudent;
          setError(`⛔ Duplicate Face Detected! This face is already registered to "${cs.name}" (Roll No: ${cs.rollNo} • ${cs.confidence}% Match). Multiple students cannot share the same facial biometric template.`);
          setSaving(false);
          return;
        }
      }

      const normalizedBranch = normalizeBranchName(form.branch || "CSE");
      const studentPayload = {
        name: form.name.trim(),
        rollNo: cleanRollNo,
        email: cleanEmail,
        branch: normalizedBranch,
        semester: form.semester || "1",
        phone: form.phone ? form.phone.trim() : "",
        gender: form.gender || "",
        dob: form.dob || "",
        role: "student",
        status: "active",
        approved: true,
        faceRegistered: Boolean(enrolledBiometric?.faceDescriptor),
        biometricEnrolled: Boolean(enrolledBiometric?.faceDescriptor),
        faceDescriptor: enrolledBiometric?.faceDescriptor || null,
        photoURL: enrolledBiometric?.photoURL || "",
        enrolledAt: enrolledBiometric?.enrolledAt || null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };

      // 4. Save across Firestore collections with { merge: true }
      const savePromises = [
        setDoc(doc(db, "students", cleanRollNo), studentPayload, { merge: true }),
        setDoc(doc(db, "users", cleanRollNo), studentPayload, { merge: true })
      ];

      if (rollLower !== cleanRollNo) {
        savePromises.push(setDoc(doc(db, "students", rollLower), studentPayload, { merge: true }).catch(() => { }));
        savePromises.push(setDoc(doc(db, "users", rollLower), studentPayload, { merge: true }).catch(() => { }));
      }

      if (prefix && prefix !== cleanRollNo && prefix !== rollLower) {
        savePromises.push(setDoc(doc(db, "students", prefix), studentPayload, { merge: true }).catch(() => { }));
        savePromises.push(setDoc(doc(db, "users", prefix), studentPayload, { merge: true }).catch(() => { }));
      }

      // Authorize student for instant Google Login in authorizedUsers
      if (cleanEmail) {
        savePromises.push(
          setDoc(doc(db, "authorizedUsers", cleanEmail), {
            ...studentPayload,
            createdAt: Date.now()
          }, { merge: true }).catch((e) => console.warn("authorizedUsers email sync error:", e))
        );
        if (prefix && prefix !== cleanEmail) {
          savePromises.push(
            setDoc(doc(db, "authorizedUsers", prefix), {
              ...studentPayload,
              createdAt: Date.now()
            }, { merge: true }).catch((e) => console.warn("authorizedUsers prefix sync error:", e))
          );
        }
      }

      await Promise.all(savePromises);

      alert(`✅ Student "${form.name.trim()}" (${cleanRollNo}) registered successfully!`);
      navigate(studentsPath);
    } catch (err) {
      console.error("Error creating student:", err);
      setError(err.message ? `Failed to add student: ${err.message}` : "Unable to create student. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleConvertToStudent = async () => {
    if (!lecturerConflict) return;
    try {
      setSaving(true);
      const cleanRollNo = form.rollNo.trim().toUpperCase();
      const cleanEmail = form.email.trim().toLowerCase();
      const prefix = cleanEmail.split("@")[0].toLowerCase().trim();
      const rollLower = cleanRollNo.toLowerCase();

      // Delete old doc from lecturers collection and users if ID differed
      await Promise.all([
        deleteDoc(doc(db, "lecturers", lecturerConflict.docId)).catch(() => { }),
        deleteDoc(doc(db, "lecturers", cleanEmail)).catch(() => { }),
        deleteDoc(doc(db, "lecturers", prefix)).catch(() => { })
      ]);

      if (lecturerConflict.docId !== cleanRollNo && lecturerConflict.docId !== rollLower) {
        await deleteDoc(doc(db, "users", lecturerConflict.docId)).catch(() => { });
      }

      const normalizedBranch = normalizeBranchName(form.branch || "CSE");
      const studentPayload = {
        name: form.name.trim() || lecturerConflict.name,
        rollNo: cleanRollNo,
        email: cleanEmail,
        branch: normalizedBranch,
        semester: form.semester || "1",
        phone: form.phone ? form.phone.trim() : "",
        gender: form.gender || "",
        dob: form.dob || "",
        role: "student",
        status: "active",
        approved: true,
        faceRegistered: Boolean(enrolledBiometric?.faceDescriptor),
        biometricEnrolled: Boolean(enrolledBiometric?.faceDescriptor),
        faceDescriptor: enrolledBiometric?.faceDescriptor || null,
        photoURL: enrolledBiometric?.photoURL || "",
        enrolledAt: enrolledBiometric?.enrolledAt || null,
        updatedAt: serverTimestamp()
      };

      const promises = [
        setDoc(doc(db, "students", cleanRollNo), studentPayload, { merge: true }),
        setDoc(doc(db, "users", cleanRollNo), studentPayload, { merge: true }),
        setDoc(doc(db, "authorizedUsers", cleanEmail), { ...studentPayload, createdAt: Date.now() }, { merge: true })
      ];

      if (rollLower !== cleanRollNo) {
        promises.push(setDoc(doc(db, "students", rollLower), studentPayload, { merge: true }).catch(() => { }));
        promises.push(setDoc(doc(db, "users", rollLower), studentPayload, { merge: true }).catch(() => { }));
      }
      if (prefix && prefix !== cleanEmail) {
        promises.push(setDoc(doc(db, "authorizedUsers", prefix), { ...studentPayload, createdAt: Date.now() }, { merge: true }).catch(() => { }));
      }

      await Promise.all(promises);

      alert(`✅ Successfully converted ${cleanEmail} to a registered student (Roll No: ${cleanRollNo})!`);
      navigate(studentsPath);
    } catch (err) {
      console.error("Error converting lecturer to student:", err);
      setError("Failed to convert account: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  // =========================================================
  // BULK UPLOAD HANDLERS
  // =========================================================

  // Download Sample Excel Template
  const downloadTemplate = () => {
    const templateData = [
      {
        "Roll Number": "23BCS001",
        "Full Name": "Rahul Sharma",
        "Email": "rahul.23bcs001@iiitdwd.ac.in",
        "Branch": "CSE",
        "Semester": "4",
        "Phone": "9876543210",
        "Gender": "Male"
      },
      {
        "Roll Number": "23BCS002",
        "Full Name": "Priya Patel",
        "Email": "priya.23bcs002@iiitdwd.ac.in",
        "Branch": "CSE",
        "Semester": "4",
        "Phone": "9876543211",
        "Gender": "Female"
      },
      {
        "Roll Number": "23BCS003",
        "Full Name": "Anand Kumar",
        "Email": "anand.23bcs003@iiitdwd.ac.in",
        "Branch": "CSE",
        "Semester": "4",
        "Phone": "9876543212",
        "Gender": "Male"
      }
    ];

    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Students");
    XLSX.writeFile(wb, "SmartAttend_Student_Bulk_Template.xlsx");
  };

  // Parse Excel / CSV File
  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setBulkFile(file);
    setBulkError("");
    setBulkSummary(null);
    setBulkLoading(true);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const binaryString = evt.target.result;
        const workbook = XLSX.read(binaryString, { type: "binary" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawJson = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        if (!rawJson || rawJson.length === 0) {
          setBulkError("The selected file is empty. Please check your file content.");
          setParsedStudents([]);
          setBulkLoading(false);
          return;
        }

        // Normalize and validate rows
        const seenRolls = new Set();
        const normalized = rawJson.map((row, index) => {
          // Normalize column keys
          const keys = Object.keys(row);
          const getVal = (possibleHeaders) => {
            const matchedKey = keys.find((k) =>
              possibleHeaders.some((h) =>
                k.toLowerCase().replace(/[^a-z0-9]/g, "") === h.toLowerCase().replace(/[^a-z0-9]/g, "")
              )
            );
            return matchedKey ? String(row[matchedKey]).trim() : "";
          };

          const name = getVal(["fullname", "name", "studentname", "student"]);
          const rollNo = getVal(["rollno", "rollnumber", "roll", "regno", "id"]).toUpperCase();
          const email = getVal(["email", "emailaddress", "mail"]).toLowerCase();
          let rawBranch = getVal(["branch", "department", "dept"]);
          let branch = "";
          if (rawBranch && String(rawBranch).toLowerCase() !== "general") {
            branch = normalizeBranchName(rawBranch);
          }
          if (!branch) {
            if (/bcs/i.test(rollNo)) branch = "CSE";
            else if (/bds/i.test(rollNo)) branch = "DSAI";
            else if (/bec/i.test(rollNo)) branch = "ECE";
            else if (/aic/i.test(rollNo)) branch = "AIC";
            else branch = "CSE";
          }
          const semester = getVal(["semester", "sem", "year"]) || "1";
          const phone = getVal(["phone", "phonenumber", "mobile", "contact"]);
          const gender = getVal(["gender", "sex"]);

          // Validation
          const missingFields = [];
          if (!name) missingFields.push("Name");
          if (!rollNo) missingFields.push("Roll No");
          if (!email) missingFields.push("Email");

          const isDuplicateInFile = rollNo ? seenRolls.has(rollNo) : false;
          if (rollNo) seenRolls.add(rollNo);

          return {
            rowNumber: index + 2, // 1-indexed plus header row
            name,
            rollNo,
            email,
            branch: normalizeBranchName(branch),
            semester,
            phone,
            gender,
            isValid: missingFields.length === 0 && !isDuplicateInFile,
            missingFields,
            isDuplicateInFile
          };
        });

        setParsedStudents(normalized);
      } catch (err) {
        console.error("Error reading file:", err);
        setBulkError("Could not parse file. Please upload a valid .xlsx, .xls, or .csv file.");
      } finally {
        setBulkLoading(false);
      }
    };

    reader.onerror = () => {
      setBulkError("Error reading the file from your computer.");
      setBulkLoading(false);
    };

    reader.readAsBinaryString(file);
  };

  // Upload All Valid Students to Firestore
  const handleBulkUpload = async () => {
    const validStudents = parsedStudents.filter((s) => s.isValid);

    if (validStudents.length === 0) {
      setBulkError("No valid student rows found to upload. Please correct missing fields in your file.");
      return;
    }

    try {
      setBulkSaving(true);
      setBulkError("");

      // Fetch existing students from all collections to avoid duplicates
      const [existingUsersSnapshot, existingStudentsSnap, authUsersSnap] = await Promise.all([
        getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "students")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] }))
      ]);
      const existingRolls = new Set();
      const existingEmails = new Set();

      existingUsersSnapshot.docs.forEach((docSnap) => {
        const d = docSnap.data();
        if (d.rollNo) existingRolls.add(d.rollNo.toUpperCase().trim());
        if (d.email) existingEmails.add(d.email.toLowerCase().trim());
      });

      existingStudentsSnap.docs.forEach((docSnap) => {
        const d = docSnap.data();
        if (d.rollNo) existingRolls.add(d.rollNo.toUpperCase().trim());
        if (d.email) existingEmails.add(d.email.toLowerCase().trim());
      });

      authUsersSnap.docs.forEach((docSnap) => {
        const d = docSnap.data();
        if (d.rollNo) existingRolls.add(d.rollNo.toUpperCase().trim());
        if (d.email) existingEmails.add(d.email.toLowerCase().trim());
      });

      let addedCount = 0;
      let skippedDuplicatesCount = 0;

      // Filter out existing database duplicates
      const studentsToInsert = [];
      for (const student of validStudents) {
        const r = student.rollNo.toUpperCase().trim();
        const e = student.email.toLowerCase().trim();
        if (existingRolls.has(r) || existingEmails.has(e)) {
          skippedDuplicatesCount++;
        } else {
          studentsToInsert.push(student);
          existingRolls.add(r);
          existingEmails.add(e);
        }
      }

      // Write in Firestore batches of up to 40
      const BATCH_SIZE = 40;
      for (let i = 0; i < studentsToInsert.length; i += BATCH_SIZE) {
        const chunk = studentsToInsert.slice(i, i + BATCH_SIZE);
        const batch = writeBatch(db);

        for (const student of chunk) {
          const cleanRoll = student.rollNo.toUpperCase().trim();
          const cleanEmail = student.email.toLowerCase().trim();
          const prefix = cleanEmail ? cleanEmail.split("@")[0].toLowerCase().trim() : "";
          const rollLower = cleanRoll.toLowerCase();

          const studentPayload = {
            name: student.name.trim(),
            rollNo: cleanRoll,
            email: cleanEmail,
            branch: normalizeBranchName(student.branch),
            semester: student.semester || "1",
            phone: student.phone ? String(student.phone).trim() : "",
            gender: student.gender || "",
            role: "student",
            status: "active",
            approved: true,
            faceRegistered: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          };

          // 1. Write to students collection
          batch.set(doc(db, "students", cleanRoll), studentPayload, { merge: true });
          if (rollLower !== cleanRoll) {
            batch.set(doc(db, "students", rollLower), studentPayload, { merge: true });
          }

          // 2. Write to users collection
          batch.set(doc(db, "users", cleanRoll), studentPayload, { merge: true });
          if (prefix && prefix !== cleanRoll) {
            batch.set(doc(db, "users", prefix), studentPayload, { merge: true });
          }

          // 3. Write to authorizedUsers collection
          if (cleanEmail) {
            batch.set(doc(db, "authorizedUsers", cleanEmail), {
              ...studentPayload,
              createdAt: Date.now()
            }, { merge: true });
            if (prefix && prefix !== cleanEmail) {
              batch.set(doc(db, "authorizedUsers", prefix), {
                ...studentPayload,
                createdAt: Date.now()
              }, { merge: true });
            }
          }
        }

        await batch.commit();
        addedCount += chunk.length;
      }

      setBulkSummary({
        totalInFile: parsedStudents.length,
        added: addedCount,
        skippedDuplicates: skippedDuplicatesCount,
        invalid: parsedStudents.filter((s) => !s.isValid).length
      });

      setParsedStudents([]);
      setBulkFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";

    } catch (err) {
      console.error("Bulk upload error:", err);
      setBulkError("An error occurred during bulk upload: " + err.message);
    } finally {
      setBulkSaving(false);
    }
  };

  const validCount = parsedStudents.filter((s) => s.isValid).length;
  const invalidCount = parsedStudents.filter((s) => !s.isValid).length;

  return (
    <div className="add-student-page">
      {/* Header */}
      <div className="add-student-header">
        <button
          type="button"
          className="back-button"
          onClick={() => navigate(studentsPath)}
        >
          <FaArrowLeft />
          Back to Students
        </button>

        <div>
          <h1>Add Students</h1>
          <p>Register single or multiple students into SmartAttend.</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="student-tabs">
        <button
          type="button"
          className={`student-tab ${activeTab === "single" ? "active" : ""}`}
          onClick={() => setActiveTab("single")}
        >
          <FaUserPlus />
          Single Student
        </button>

        <button
          type="button"
          className={`student-tab ${activeTab === "bulk" ? "active" : ""}`}
          onClick={() => setActiveTab("bulk")}
        >
          <FaFileExcel />
          Bulk Upload (Excel / CSV)
        </button>
      </div>

      {/* TAB 1: SINGLE STUDENT FORM */}
      {activeTab === "single" && (
        <form className="student-form" onSubmit={handleSingleSubmit}>
          {error && (
            <div className="form-error">
              <p style={{ margin: 0 }}>{error}</p>
              {lecturerConflict && (
                <div style={{ marginTop: "12px", display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={handleConvertToStudent}
                    disabled={saving}
                    style={{
                      background: "#10b981",
                      color: "#ffffff",
                      border: "none",
                      padding: "8px 16px",
                      borderRadius: "6px",
                      fontWeight: 700,
                      cursor: "pointer",
                      fontSize: "0.85rem"
                    }}
                  >
                    {saving ? "Converting..." : "🔄 Convert This Account to Student"}
                  </button>
                  {!isLecturer && (
                    <button
                      type="button"
                      onClick={() => navigate("/admin/lecturers")}
                      style={{
                        background: "transparent",
                        color: "inherit",
                        border: "1px solid currentColor",
                        padding: "8px 16px",
                        borderRadius: "6px",
                        fontWeight: 600,
                        cursor: "pointer",
                        fontSize: "0.85rem"
                      }}
                    >
                      Go to Manage Lecturers ↗
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="form-section">
            <h2>Student Information</h2>

            <div className="form-grid">
              <div className="form-field">
                <label>Roll Number *</label>
                <input
                  type="text"
                  name="rollNo"
                  value={form.rollNo}
                  onChange={handleChange}
                  placeholder="e.g. 23BCS001"
                  required
                />
              </div>

              <div className="form-field">
                <label>Full Name *</label>
                <input
                  type="text"
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  placeholder="Enter full name"
                  required
                />
              </div>

              <div className="form-field">
                <label>Email *</label>
                <input
                  type="email"
                  name="email"
                  value={form.email}
                  onChange={handleChange}
                  placeholder="student@iiitdwd.ac.in"
                  required
                />
              </div>

              <div className="form-field">
                <label>Phone Number</label>
                <input
                  type="tel"
                  name="phone"
                  value={form.phone}
                  onChange={handleChange}
                  placeholder="Enter phone number"
                />
              </div>

              <div className="form-field">
                <label>Branch</label>
                <select
                  name="branch"
                  value={form.branch}
                  onChange={handleChange}
                >
                  <option value="">Select Branch</option>
                  <option value="CSE">CSE</option>
                  <option value="AIC">AIC</option>
                  <option value="DSAI">DSAI</option>
                  <option value="ECE">ECE</option>
                </select>
              </div>

              <div className="form-field">
                <label>Semester</label>
                <select
                  name="semester"
                  value={form.semester}
                  onChange={handleChange}
                >
                  <option value="">Select semester</option>
                  <option value="1">1st Semester</option>
                  <option value="2">2nd Semester</option>
                  <option value="3">3rd Semester</option>
                  <option value="4">4th Semester</option>
                  <option value="5">5th Semester</option>
                  <option value="6">6th Semester</option>
                  <option value="7">7th Semester</option>
                  <option value="8">8th Semester</option>
                </select>
              </div>

              <div className="form-field">
                <label>Date of Birth</label>
                <input
                  type="date"
                  name="dob"
                  value={form.dob}
                  onChange={handleChange}
                />
              </div>

              <div className="form-field">
                <label>Gender</label>
                <select
                  name="gender"
                  value={form.gender}
                  onChange={handleChange}
                >
                  <option value="">Select gender</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>
          </div>

          {/* Biometric Face Registration Section */}
          <div className="form-section">
            <h2>Biometric Face Registration (Optional / Recommended)</h2>
            <p style={{ margin: "4px 0 14px", fontSize: "13px", color: "var(--text-muted, #64748b)" }}>
              Capture the student's live facial features with camera to enable instant AI biometric attendance recognition.
            </p>
            <LiveFaceEnrollment
              hideHeader={true}
              targetRollNo={form.rollNo}
              targetEmail={form.email}
              targetName={form.name}
              onFaceEnrolled={(data) => setEnrolledBiometric(data)}
            />
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="cancel-button"
              onClick={() => navigate(studentsPath)}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="save-button save-btn"
              disabled={saving}
            >
              <FaSave />
              {saving ? "Creating..." : "Create Student"}
            </button>
          </div>
        </form>
      )}

      {/* TAB 2: BULK UPLOAD EXCEL / CSV */}
      {activeTab === "bulk" && (
        <div className="bulk-upload-container">
          {/* Instructions & Template Download Card */}
          <div className="bulk-info-card">
            <div className="bulk-info-text">
              <h3>Upload Student Roster</h3>
              <p>
                Upload an Excel (<code>.xlsx</code>, <code>.xls</code>) or <code>.csv</code> spreadsheet containing your student list.
                Columns supported: <strong>Full Name, Roll Number, Email, Branch, Semester, Phone, Gender</strong>.
              </p>
            </div>

            <button
              type="button"
              className="download-template-btn"
              onClick={downloadTemplate}
            >
              <FaDownload />
              Download Sample Template (.xlsx)
            </button>
          </div>

          {/* Upload Drop Area */}
          <div
            className="bulk-dropzone"
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept=".xlsx, .xls, .csv"
              style={{ display: "none" }}
            />
            <FaFileUpload className="dropzone-icon" />
            <h3>{bulkFile ? bulkFile.name : "Click to select or drag & drop Excel / CSV file"}</h3>
            <p>{bulkFile ? `${(bulkFile.size / 1024).toFixed(1)} KB` : "Supports .xlsx, .xls, .csv files"}</p>
          </div>

          {bulkLoading && <div className="bulk-loading">Reading and validating spreadsheet...</div>}
          {bulkError && <div className="form-error">{bulkError}</div>}

          {/* Success Summary Alert */}
          {bulkSummary && (
            <div className="bulk-success-alert">
              <FaCheckCircle className="success-icon" />
              <div>
                <h4>Bulk Upload Completed Successfully!</h4>
                <p>
                  ✅ <strong>{bulkSummary.added}</strong> students added to SmartAttend.
                  {bulkSummary.skippedDuplicates > 0 && ` ⚠️ ${bulkSummary.skippedDuplicates} duplicates were skipped.`}
                </p>
                <button
                  type="button"
                  className="view-students-btn"
                  onClick={() => navigate(studentsPath)}
                >
                  View All Students
                </button>
              </div>
            </div>
          )}

          {/* Parsed Preview Table */}
          {parsedStudents.length > 0 && (
            <div className="bulk-preview-section">
              <div className="bulk-preview-header">
                <div>
                  <h3>File Preview ({parsedStudents.length} rows found)</h3>
                  <p>Review the data below before saving to the database.</p>
                </div>

                <div className="bulk-stats-pills">
                  <span className="pill valid">✅ {validCount} Ready</span>
                  {invalidCount > 0 && <span className="pill invalid">⚠️ {invalidCount} Invalid</span>}
                </div>
              </div>

              <div className="bulk-table-wrapper">
                <table className="bulk-preview-table">
                  <thead>
                    <tr>
                      <th className="sortable-th" onClick={() => requestSort("rowNumber")} title="Click to sort by Row">
                        Row <SortIcon sortConfig={sortConfig} columnKey="rowNumber" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("isValid")} title="Click to sort by Status">
                        Status <SortIcon sortConfig={sortConfig} columnKey="isValid" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("name")} title="Click to sort by Full Name">
                        Full Name <SortIcon sortConfig={sortConfig} columnKey="name" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("rollNo")} title="Click to sort by Roll Number">
                        Roll Number <SortIcon sortConfig={sortConfig} columnKey="rollNo" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("email")} title="Click to sort by Email">
                        Email <SortIcon sortConfig={sortConfig} columnKey="email" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("branch")} title="Click to sort by Branch">
                        Branch <SortIcon sortConfig={sortConfig} columnKey="branch" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("semester")} title="Click to sort by Semester">
                        Semester <SortIcon sortConfig={sortConfig} columnKey="semester" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("phone")} title="Click to sort by Phone">
                        Phone <SortIcon sortConfig={sortConfig} columnKey="phone" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedParsedStudents.map((s, idx) => (
                      <tr key={idx} className={s.isValid ? "row-valid" : "row-invalid"}>
                        <td>#{s.rowNumber}</td>
                        <td>
                          {s.isValid ? (
                            <span className="status-badge valid"><FaCheckCircle /> Valid</span>
                          ) : (
                            <span className="status-badge invalid" title={s.isDuplicateInFile ? "Duplicate in file" : s.missingFields.join(", ")}>
                              <FaExclamationTriangle /> {s.isDuplicateInFile ? "Duplicate" : `Missing ${s.missingFields.join(", ")}`}
                            </span>
                          )}
                        </td>
                        <td>{s.name || <em className="missing">Missing</em>}</td>
                        <td><strong>{s.rollNo || <em className="missing">Missing</em>}</strong></td>
                        <td>{s.email || <em className="missing">Missing</em>}</td>
                        <td>{s.branch}</td>
                        <td>{s.semester}</td>
                        <td>{s.phone || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="bulk-action-bar">
                <button
                  type="button"
                  className="cancel-button"
                  onClick={() => {
                    setParsedStudents([]);
                    setBulkFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  <FaTrashAlt /> Clear List
                </button>

                <button
                  type="button"
                  className="save-button save-btn"
                  disabled={bulkSaving || validCount === 0}
                  onClick={handleBulkUpload}
                >
                  <FaSave />
                  {bulkSaving ? "Importing to Database..." : `Import ${validCount} Students to Database`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AddStudent;