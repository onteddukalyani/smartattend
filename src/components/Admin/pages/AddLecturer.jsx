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
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch
} from "firebase/firestore";
import * as XLSX from "xlsx";
import { db } from "../../../firebase";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import "./AddStudent.css";

const AddLecturer = () => {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  // Tab State: "single" | "bulk"
  const [activeTab, setActiveTab] = useState("single");

  // --- Single Lecturer Form State ---
  const [form, setForm] = useState({
    name: "",
    email: "",
    department: "",
    designation: "Assistant Professor",
    phone: "",
    cabin: ""
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // --- Bulk Upload State ---
  const [bulkFile, setBulkFile] = useState(null);
  const [parsedLecturers, setParsedLecturers] = useState([]);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkSummary, setBulkSummary] = useState(null);
  const [bulkError, setBulkError] = useState("");

  const { sortedItems: sortedParsedLecturers, sortConfig, requestSort } = useTableSort(parsedLecturers, "rowNumber", "asc");

  // =========================================================
  // SINGLE LECTURER HANDLERS
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

    if (!form.name.trim()) {
      setError("Lecturer name is required.");
      return;
    }

    if (!form.email.trim()) {
      setError("Email address is required.");
      return;
    }

    const cleanEmail = form.email.trim().toLowerCase();

    try {
      setSaving(true);

      // Check if email already exists in authorizedUsers
      const authorizedUserRef = doc(db, "authorizedUsers", cleanEmail);
      const authorizedUserSnap = await getDoc(authorizedUserRef);

      if (authorizedUserSnap.exists()) {
        const existingData = authorizedUserSnap.data();
        if (existingData.role === "lecturer") {
          setError(`A lecturer with email ${cleanEmail} is already registered.`);
          return;
        }
      }

      // Check duplicate email in users collection
      const emailQuery = query(
        collection(db, "users"),
        where("email", "==", cleanEmail)
      );
      const emailSnapshot = await getDocs(emailQuery);

      if (!emailSnapshot.empty) {
        setError(`A user with email ${cleanEmail} already exists in the system.`);
        return;
      }

      // 1. Authorize lecturer for Google Login in authorizedUsers
      await setDoc(authorizedUserRef, {
        name: form.name.trim(),
        email: cleanEmail,
        department: form.department.trim() || "General",
        designation: form.designation,
        phone: form.phone.trim(),
        cabin: form.cabin.trim(),
        role: "lecturer",
        approved: true,
        status: "active",
        createdAt: Date.now()
      });

      // 2. Register profile in users collection
      await addDoc(collection(db, "users"), {
        name: form.name.trim(),
        email: cleanEmail,
        department: form.department.trim() || "General",
        designation: form.designation,
        phone: form.phone.trim(),
        cabin: form.cabin.trim(),
        role: "lecturer",
        approved: true,
        status: "active",
        createdAt: serverTimestamp()
      });

      navigate("/admin/lecturers");

    } catch (err) {
      console.error("Error creating lecturer:", err);
      setError("Unable to add lecturer. Please check permissions and try again.");
    } finally {
      setSaving(false);
    }
  };

  // =========================================================
  // BULK UPLOAD HANDLERS
  // =========================================================

  // Download Sample Excel Template for Lecturers
  const downloadTemplate = () => {
    const templateData = [
      {
        "Full Name": "Dr. Ramesh Sharma",
        "Email": "ramesh.sharma@iiitdwd.ac.in",
        "Department": "Computer Science & Engineering",
        "Designation": "Associate Professor",
        "Phone": "9876543210",
        "Cabin": "Room 304, Academic Block"
      },
      {
        "Full Name": "Dr. Sneha Patil",
        "Email": "sneha.patil@iiitdwd.ac.in",
        "Department": "Data Science & AI",
        "Designation": "Assistant Professor",
        "Phone": "9876543211",
        "Cabin": "Room 205, Academic Block"
      },
      {
        "Full Name": "Dr. Amit Verma",
        "Email": "amit.verma@iiitdwd.ac.in",
        "Department": "Electronics & Communication",
        "Designation": "Professor",
        "Phone": "9876543212",
        "Cabin": "Room 102, Academic Block"
      }
    ];

    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Lecturers");
    XLSX.writeFile(wb, "SmartAttend_Lecturer_Bulk_Template.xlsx");
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
          setParsedLecturers([]);
          setBulkLoading(false);
          return;
        }

        // Normalize and validate rows
        const seenEmails = new Set();
        const normalized = rawJson.map((row, index) => {
          const keys = Object.keys(row);
          const getVal = (possibleHeaders) => {
            const matchedKey = keys.find((k) =>
              possibleHeaders.some((h) =>
                k.toLowerCase().replace(/[^a-z0-9]/g, "") === h.toLowerCase().replace(/[^a-z0-9]/g, "")
              )
            );
            return matchedKey ? String(row[matchedKey]).trim() : "";
          };

          const name = getVal(["fullname", "name", "lecturername", "faculty", "facultyname", "teacher"]);
          const email = getVal(["email", "emailaddress", "mail", "googleemail"]).toLowerCase();
          const department = getVal(["department", "dept", "branch"]) || "Computer Science & Engineering";
          const designation = getVal(["designation", "role", "title", "position"]) || "Assistant Professor";
          const phone = getVal(["phone", "phonenumber", "mobile", "contact"]);
          const cabin = getVal(["cabin", "room", "office", "roomno", "cabinno"]);

          // Validation
          const missingFields = [];
          if (!name) missingFields.push("Name");
          if (!email) missingFields.push("Email");

          const isDuplicateInFile = email ? seenEmails.has(email) : false;
          if (email) seenEmails.add(email);

          return {
            rowNumber: index + 2,
            name,
            email,
            department,
            designation,
            phone,
            cabin,
            isValid: missingFields.length === 0 && !isDuplicateInFile,
            missingFields,
            isDuplicateInFile
          };
        });

        setParsedLecturers(normalized);
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

  // Upload All Valid Lecturers to Firestore
  const handleBulkUpload = async () => {
    const validLecturers = parsedLecturers.filter((l) => l.isValid);

    if (validLecturers.length === 0) {
      setBulkError("No valid lecturer rows found to upload. Please correct missing fields in your file.");
      return;
    }

    try {
      setBulkSaving(true);
      setBulkError("");

      // Fetch existing lecturers from both collections to avoid duplicates
      const [existingUsersSnapshot, authUsersSnap] = await Promise.all([
        getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] }))
      ]);
      const existingEmails = new Set();

      existingUsersSnapshot.docs.forEach((docSnap) => {
        const d = docSnap.data();
        if (d.email) existingEmails.add(d.email.toLowerCase().trim());
      });

      authUsersSnap.docs.forEach((docSnap) => {
        const d = docSnap.data();
        if (d.email) existingEmails.add(d.email.toLowerCase().trim());
      });

      let addedCount = 0;
      let skippedDuplicatesCount = 0;

      const lecturersToInsert = [];
      for (const lecturer of validLecturers) {
        if (existingEmails.has(lecturer.email)) {
          skippedDuplicatesCount++;
        } else {
          lecturersToInsert.push(lecturer);
          existingEmails.add(lecturer.email);
        }
      }

      // Write in Firestore batches of up to 200 (since we write to authorizedUsers and users)
      const BATCH_SIZE = 200;
      for (let i = 0; i < lecturersToInsert.length; i += BATCH_SIZE) {
        const chunk = lecturersToInsert.slice(i, i + BATCH_SIZE);
        const batch = writeBatch(db);

        for (const lecturer of chunk) {
          // 1. Authorize in authorizedUsers
          const authUserRef = doc(db, "authorizedUsers", lecturer.email);
          batch.set(authUserRef, {
            name: lecturer.name,
            email: lecturer.email,
            department: lecturer.department,
            designation: lecturer.designation,
            phone: lecturer.phone,
            cabin: lecturer.cabin,
            role: "lecturer",
            approved: true,
            status: "active",
            createdAt: Date.now()
          });

          // 2. Register profile in users collection
          const userDocRef = doc(collection(db, "users"));
          batch.set(userDocRef, {
            name: lecturer.name,
            email: lecturer.email,
            department: lecturer.department,
            designation: lecturer.designation,
            phone: lecturer.phone,
            cabin: lecturer.cabin,
            role: "lecturer",
            approved: true,
            status: "active",
            createdAt: serverTimestamp()
          });
        }

        await batch.commit();
        addedCount += chunk.length;
      }

      setBulkSummary({
        totalInFile: parsedLecturers.length,
        added: addedCount,
        skippedDuplicates: skippedDuplicatesCount,
        invalid: parsedLecturers.filter((l) => !l.isValid).length
      });

      setParsedLecturers([]);
      setBulkFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";

    } catch (err) {
      console.error("Bulk lecturer upload error:", err);
      setBulkError("An error occurred during bulk upload: " + err.message);
    } finally {
      setBulkSaving(false);
    }
  };

  const validCount = parsedLecturers.filter((l) => l.isValid).length;
  const invalidCount = parsedLecturers.filter((l) => !l.isValid).length;

  return (
    <div className="add-student-page">
      {/* Header */}
      <div className="add-student-header">
        <button
          type="button"
          className="back-button"
          onClick={() => navigate("/admin/lecturers")}
        >
          <FaArrowLeft />
          Back to Lecturers
        </button>

        <div>
          <h1>Add Lecturers</h1>
          <p>Authorize single or multiple faculty members into SmartAttend.</p>
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
          Single Lecturer
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

      {/* TAB 1: SINGLE LECTURER FORM */}
      {activeTab === "single" && (
        <form className="student-form" onSubmit={handleSingleSubmit}>
          {error && <div className="form-error">{error}</div>}

          <div className="form-section">
            <h2>Lecturer Information</h2>

            <div className="form-grid">
              <div className="form-field">
                <label>Full Name *</label>
                <input
                  type="text"
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  placeholder="Dr. John Doe"
                  required
                />
              </div>

              <div className="form-field">
                <label>Email Address (Google Login) *</label>
                <input
                  type="email"
                  name="email"
                  value={form.email}
                  onChange={handleChange}
                  placeholder="lecturer@iiitdwd.ac.in"
                  required
                />
              </div>

              <div className="form-field">
                <label>Department / Branch</label>
                <select
                  name="department"
                  value={form.department}
                  onChange={handleChange}
                >
                  <option value="">Select Department</option>
                  <option value="Computer Science & Engineering">Computer Science & Engineering</option>
                  <option value="Data Science & AI">Data Science & AI</option>
                  <option value="Electronics & Communication">Electronics & Communication</option>
                  <option value="AI and Computing ">AI and Computing</option>
                </select>
              </div>

              <div className="form-field">
                <label>Designation</label>
                <select
                  name="designation"
                  value={form.designation}
                  onChange={handleChange}
                >
                  <option value="Assistant Professor">Assistant Professor</option>
                  <option value="Associate Professor">Associate Professor</option>
                  <option value="Professor">Professor</option>
                  <option value="Head of Department">Head of Department</option>
                  <option value="Visiting Faculty">Visiting Faculty</option>
                  <option value="Teaching Assistant">Teaching Assistant</option>
                </select>
              </div>

              <div className="form-field">
                <label>Phone Number</label>
                <input
                  type="tel"
                  name="phone"
                  value={form.phone}
                  onChange={handleChange}
                  placeholder="+91 9876543210"
                />
              </div>

              <div className="form-field">
                <label>Cabin / Office Room</label>
                <input
                  type="text"
                  name="cabin"
                  value={form.cabin}
                  onChange={handleChange}
                  placeholder="Room 304, Academic Block"
                />
              </div>
            </div>
          </div>

          <div className="registration-info">
            <p>
              <strong>Note:</strong> Once added, this lecturer can immediately sign in using their Google account by selecting the <em>Lecturer</em> role.
            </p>
            <span>They will have full access to generate attendance QR codes and view session analytics.</span>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="cancel-button"
              onClick={() => navigate("/admin/lecturers")}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="save-button save-btn"
              disabled={saving}
            >
              <FaSave />
              {saving ? "Saving..." : "Save Lecturer"}
            </button>
          </div>
        </form>
      )}

      {/* TAB 2: BULK UPLOAD EXCEL / CSV */}
      {activeTab === "bulk" && (
        <div className="bulk-upload-container">
          <div className="bulk-info-card">
            <div className="bulk-info-text">
              <h3>Upload Lecturer Roster</h3>
              <p>
                Upload an Excel (<code>.xlsx</code>, <code>.xls</code>) or <code>.csv</code> spreadsheet containing faculty members.
                Columns supported: <strong>Full Name, Email, Department, Designation, Phone, Cabin</strong>.
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

          {bulkSummary && (
            <div className="bulk-success-alert">
              <FaCheckCircle className="success-icon" />
              <div>
                <h4>Bulk Upload Completed Successfully!</h4>
                <p>
                  ✅ <strong>{bulkSummary.added}</strong> lecturers authorized & registered in SmartAttend.
                  {bulkSummary.skippedDuplicates > 0 && ` ⚠️ ${bulkSummary.skippedDuplicates} duplicates were skipped.`}
                </p>
                <button
                  type="button"
                  className="view-students-btn"
                  onClick={() => navigate("/admin/lecturers")}
                >
                  View All Lecturers
                </button>
              </div>
            </div>
          )}

          {parsedLecturers.length > 0 && (
            <div className="bulk-preview-section">
              <div className="bulk-preview-header">
                <div>
                  <h3>File Preview ({parsedLecturers.length} rows found)</h3>
                  <p>Review the faculty data below before authorizing them.</p>
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
                      <th className="sortable-th" onClick={() => requestSort("email")} title="Click to sort by Email">
                        Email (Google Login) <SortIcon sortConfig={sortConfig} columnKey="email" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("department")} title="Click to sort by Department">
                        Department <SortIcon sortConfig={sortConfig} columnKey="department" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("designation")} title="Click to sort by Designation">
                        Designation <SortIcon sortConfig={sortConfig} columnKey="designation" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("cabin")} title="Click to sort by Cabin">
                        Cabin <SortIcon sortConfig={sortConfig} columnKey="cabin" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("phone")} title="Click to sort by Phone">
                        Phone <SortIcon sortConfig={sortConfig} columnKey="phone" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedParsedLecturers.map((l, idx) => (
                      <tr key={idx} className={l.isValid ? "row-valid" : "row-invalid"}>
                        <td>#{l.rowNumber}</td>
                        <td>
                          {l.isValid ? (
                            <span className="status-badge valid"><FaCheckCircle /> Valid</span>
                          ) : (
                            <span className="status-badge invalid" title={l.isDuplicateInFile ? "Duplicate in file" : l.missingFields.join(", ")}>
                              <FaExclamationTriangle /> {l.isDuplicateInFile ? "Duplicate" : `Missing ${l.missingFields.join(", ")}`}
                            </span>
                          )}
                        </td>
                        <td>{l.name || <em className="missing">Missing</em>}</td>
                        <td><strong>{l.email || <em className="missing">Missing</em>}</strong></td>
                        <td>{l.department}</td>
                        <td>{l.designation}</td>
                        <td>{l.cabin || "-"}</td>
                        <td>{l.phone || "-"}</td>
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
                    setParsedLecturers([]);
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
                  {bulkSaving ? "Authorizing Lecturers..." : `Authorize & Import ${validCount} Lecturers`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AddLecturer;