import React, { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
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
  addDoc,
  setDoc,
  getDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp,
  writeBatch,
  doc,
  updateDoc,
  deleteDoc
} from "firebase/firestore";
import * as XLSX from "xlsx";
import { db } from "../../../firebase";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import "./AddStudent.css";

const AddStudent = () => {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  // Tab State: "single" | "bulk"
  const [activeTab, setActiveTab] = useState("single");

  // --- Single Student Form State ---
  const [form, setForm] = useState({
    name: "",
    rollNo: "",
    email: "",
    phone: "",
    branch: "",
    semester: "",
    gender: "",
    dob: ""
  });
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
    setForm((prev) => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSingleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (!form.rollNo.trim()) {
      setError("Roll number is required.");
      return;
    }
    if (!form.name.trim()) {
      setError("Student name is required.");
      return;
    }
    if (!form.email.trim()) {
      setError("Email is required.");
      return;
    }

    try {
      setSaving(true);
      const cleanRollNo = form.rollNo.trim().toUpperCase();
      const cleanEmail = form.email.trim().toLowerCase();

      // Check duplicate roll number
      const rollQuery = query(
        collection(db, "users"),
        where("rollNo", "==", cleanRollNo)
      );
      const rollSnapshot = await getDocs(rollQuery);
      if (!rollSnapshot.empty) {
        const existingStudent = rollSnapshot.docs[0].data();
        setError(`Roll number ${cleanRollNo} is already registered to "${existingStudent.name || "Student"}".`);
        return;
      }

      // Check duplicate email
      const emailQuery = query(
        collection(db, "users"),
        where("email", "==", cleanEmail)
      );
      const emailSnapshot = await getDocs(emailQuery);
      if (!emailSnapshot.empty) {
        const existingDoc = emailSnapshot.docs[0];
        const existingData = existingDoc.data();
        if (existingData.role === "lecturer") {
          setLecturerConflict({
            docId: existingDoc.id,
            name: existingData.name || "Lecturer",
            email: cleanEmail
          });
          setError(`This email (${cleanEmail}) is currently registered under Lecturers as "${existingData.name || "Faculty"}". You can convert this account to a Student below, or remove it from Manage Lecturers.`);
        } else {
          setError(`This email is already registered to student "${existingData.name || "Existing Student"}" (Roll No: ${existingData.rollNo || "N/A"}).`);
        }
        return;
      }

      // Save student with Roll Number as the Document ID
      await setDoc(doc(db, "users", cleanRollNo), {
        ...form,
        name: form.name.trim(),
        rollNo: cleanRollNo,
        email: cleanEmail,
        branch: form.branch || "General",
        semester: form.semester || "1",
        role: "student",
        status: "active",
        faceRegistered: false,
        createdAt: serverTimestamp()
      });

      // Synchronize to authorizedUsers for instant Google Login access
      await setDoc(doc(db, "authorizedUsers", cleanEmail), {
        name: form.name.trim(),
        rollNo: cleanRollNo,
        email: cleanEmail,
        branch: form.branch || "General",
        semester: form.semester || "1",
        role: "student",
        approved: true,
        status: "active",
        createdAt: Date.now()
      }, { merge: true }).catch((e) => console.warn("authorizedUsers sync error:", e));

      navigate("/admin/students");
    } catch (err) {
      console.error("Error creating student:", err);
      setError("Unable to create student. Please try again.");
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

      // Delete old doc if its ID was not cleanRollNo
      if (lecturerConflict.docId !== cleanRollNo) {
        await deleteDoc(doc(db, "users", lecturerConflict.docId));
      }

      // Save student with Roll Number as the Document ID
      await setDoc(doc(db, "users", cleanRollNo), {
        name: form.name.trim() || lecturerConflict.name,
        rollNo: cleanRollNo,
        email: cleanEmail,
        branch: form.branch || "General",
        semester: form.semester || "1",
        phone: form.phone || "",
        gender: form.gender || "",
        dob: form.dob || "",
        role: "student",
        status: "active",
        faceRegistered: false,
        updatedAt: serverTimestamp()
      });

      try {
        await deleteDoc(doc(db, "authorizedUsers", cleanEmail));
      } catch (authErr) {
        console.warn("Could not delete from authorizedUsers:", authErr);
      }

      alert(`✅ Successfully converted ${cleanEmail} to a registered student (Roll No: ${cleanRollNo})!`);
      navigate("/admin/students");
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
        "Branch": "DSAI",
        "Semester": "4",
        "Phone": "9876543211",
        "Gender": "Female"
      },
      {
        "Roll Number": "23BCS003",
        "Full Name": "Anand Kumar",
        "Email": "anand.23bcs003@iiitdwd.ac.in",
        "Branch": "ECE",
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
          const branch = getVal(["branch", "department", "dept"]) || "General";
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
            branch,
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

      // Fetch existing students from both collections to avoid duplicates
      const [existingUsersSnapshot, authUsersSnap] = await Promise.all([
        getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] }))
      ]);
      const existingRolls = new Set();
      const existingEmails = new Set();

      existingUsersSnapshot.docs.forEach((docSnap) => {
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
        if (existingRolls.has(student.rollNo) || existingEmails.has(student.email)) {
          skippedDuplicatesCount++;
        } else {
          studentsToInsert.push(student);
          existingRolls.add(student.rollNo);
          existingEmails.add(student.email);
        }
      }

      // Write in Firestore batches of up to 200 (2 ops per student = 400 ops <= 500 limit)
      const BATCH_SIZE = 200;
      for (let i = 0; i < studentsToInsert.length; i += BATCH_SIZE) {
        const chunk = studentsToInsert.slice(i, i + BATCH_SIZE);
        const batch = writeBatch(db);

        for (const student of chunk) {
          const newDocRef = doc(db, "users", student.rollNo);
          batch.set(newDocRef, {
            name: student.name,
            rollNo: student.rollNo,
            email: student.email,
            branch: student.branch,
            semester: student.semester,
            phone: student.phone,
            gender: student.gender,
            role: "student",
            status: "active",
            faceRegistered: false,
            createdAt: serverTimestamp()
          });

          const authUserRef = doc(db, "authorizedUsers", student.email);
          batch.set(authUserRef, {
            name: student.name,
            rollNo: student.rollNo,
            email: student.email,
            branch: student.branch,
            semester: student.semester,
            role: "student",
            approved: true,
            status: "active",
            createdAt: Date.now()
          }, { merge: true });
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
          onClick={() => navigate("/admin/students")}
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
                  <option value="">Select branch</option>
                  <option value="CSE">Computer Science & Engineering</option>
                  <option value="DSAI">Data Science & AI</option>
                  <option value="ECE">Electronics & Communication Engineering</option>
                  <option value="AIC">AI and Computing</option>
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

          <div className="form-actions">
            <button
              type="button"
              className="cancel-button"
              onClick={() => navigate("/admin/students")}
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
                  onClick={() => navigate("/admin/students")}
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