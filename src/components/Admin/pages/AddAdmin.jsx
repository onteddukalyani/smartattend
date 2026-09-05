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
  FaUserShield
} from "react-icons/fa";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  writeBatch
} from "firebase/firestore";
import * as XLSX from "xlsx";
import { db } from "../../../firebase";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import "./AddStudent.css";

const AddAdmin = () => {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  // Tab State: "single" | "bulk"
  const [activeTab, setActiveTab] = useState("single");

  // --- Single Admin Form State ---
  const [form, setForm] = useState({
    name: "",
    email: "",
    department: "Administration",
    designation: "System Administrator",
    phone: "",
    cabin: ""
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // --- Bulk Upload State ---
  const [bulkFile, setBulkFile] = useState(null);
  const [parsedAdmins, setParsedAdmins] = useState([]);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkSummary, setBulkSummary] = useState(null);
  const [bulkError, setBulkError] = useState("");

  const { sortedItems: sortedParsedAdmins, sortConfig, requestSort } = useTableSort(parsedAdmins, "rowNumber", "asc");

  // Single Admin Form Handlers
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
      setError("Administrator name is required.");
      return;
    }

    if (!form.email.trim()) {
      setError("Email address is required.");
      return;
    }

    const cleanEmail = form.email.trim().toLowerCase();

    try {
      setSaving(true);

      const adminData = {
        name: form.name.trim(),
        email: cleanEmail,
        department: form.department.trim() || "Administration",
        designation: form.designation.trim() || "System Administrator",
        phone: form.phone.trim(),
        cabin: form.cabin.trim(),
        role: "admin",
        approved: true,
        status: "active",
        createdAt: Date.now()
      };

      // 1. Save to authorizedUsers collection
      await setDoc(doc(db, "authorizedUsers", cleanEmail), adminData, { merge: true });

      // 2. Save/merge into users collection
      await setDoc(doc(db, "users", cleanEmail), adminData, { merge: true });

      alert(`✅ Administrator ${form.name} (${cleanEmail}) added successfully!`);
      navigate("/admin/admins");
    } catch (err) {
      console.error("Error saving administrator:", err);
      setError(err.message || "Failed to save administrator.");
    } finally {
      setSaving(false);
    }
  };

  // Bulk Upload Handlers
  const downloadTemplate = () => {
    const templateData = [
      {
        "Full Name": "Dr. Ramesh Kumar",
        "Email": "admin.ramesh@iiitdwd.ac.in",
        "Designation": "Dean of Academic Affairs",
        "Department": "Administration",
        "Phone": "9876543210",
        "Cabin": "Admin Block 204"
      },
      {
        "Full Name": "Prof. Anita Sharma",
        "Email": "admin.anita@iiitdwd.ac.in",
        "Designation": "System Administrator",
        "Department": "IT Services",
        "Phone": "9876543211",
        "Cabin": "Server Room 101"
      }
    ];

    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Admins");
    XLSX.writeFile(wb, "SmartAttend_Admins_Template.xlsx");
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setBulkFile(file);
    setBulkError("");
    setBulkSummary(null);
    setBulkLoading(true);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target.result;
        const wb = XLSX.read(bstr, { type: "binary" });
        const wsName = wb.SheetNames[0];
        const ws = wb.Sheets[wsName];
        const rawData = XLSX.utils.sheet_to_json(ws, { defval: "" });

        if (rawData.length === 0) {
          setBulkError("The selected Excel file is empty.");
          setParsedAdmins([]);
          setBulkLoading(false);
          return;
        }

        const validList = [];
        const emailsSeen = new Set();

        rawData.forEach((row, index) => {
          const name = String(row["Full Name"] || row["Name"] || row["name"] || "").trim();
          const email = String(row["Email"] || row["email"] || row["Email Address"] || "").trim().toLowerCase();
          const designation = String(row["Designation"] || row["designation"] || "System Administrator").trim();
          const department = String(row["Department"] || row["department"] || "Administration").trim();
          const phone = String(row["Phone"] || row["phone"] || row["Contact"] || "").trim();
          const cabin = String(row["Cabin"] || row["cabin"] || row["Office"] || "").trim();

          const issues = [];
          if (!name) issues.push("Missing name");
          if (!email) issues.push("Missing email");
          else if (!email.includes("@")) issues.push("Invalid email format");
          else if (emailsSeen.has(email)) issues.push("Duplicate email in sheet");

          if (email) emailsSeen.add(email);

          validList.push({
            rowNumber: index + 2,
            name,
            email,
            designation,
            department,
            phone,
            cabin,
            isValid: issues.length === 0,
            issues
          });
        });

        setParsedAdmins(validList);
      } catch (err) {
        console.error("Error parsing Excel:", err);
        setBulkError("Failed to parse Excel file. Please ensure it is a valid .xlsx or .xls file.");
      } finally {
        setBulkLoading(false);
      }
    };

    reader.readAsBinaryString(file);
  };

  const handleBulkSubmit = async () => {
    const validRows = parsedAdmins.filter((p) => p.isValid);
    if (validRows.length === 0) {
      alert("No valid administrator records to save.");
      return;
    }

    try {
      setBulkSaving(true);
      const batch = writeBatch(db);

      validRows.forEach((adm) => {
        const adminData = {
          name: adm.name,
          email: adm.email,
          designation: adm.designation || "System Administrator",
          department: adm.department || "Administration",
          phone: adm.phone || "",
          cabin: adm.cabin || "",
          role: "admin",
          approved: true,
          status: "active",
          createdAt: Date.now()
        };

        const authRef = doc(db, "authorizedUsers", adm.email);
        batch.set(authRef, adminData, { merge: true });

        const userRef = doc(db, "users", adm.email);
        batch.set(userRef, adminData, { merge: true });
      });

      await batch.commit();

      setBulkSummary({
        total: parsedAdmins.length,
        saved: validRows.length,
        skipped: parsedAdmins.length - validRows.length
      });

      alert(`✅ Successfully imported ${validRows.length} administrators!`);
      navigate("/admin/admins");
    } catch (err) {
      console.error("Bulk save error:", err);
      setBulkError(err.message || "Failed to save administrators in bulk.");
    } finally {
      setBulkSaving(false);
    }
  };

  return (
    <div className="add-admin">
      {/* Top Navigation */}
      <div className="add-student-header">
        <button
          type="button"
          className="back-button"
          onClick={() => navigate("/admin/admins")}
        >
          <FaArrowLeft /> Back to Administrators
        </button>

        <div>
          <h1>Add Administrators</h1>
          <p>Register new system administrators individually or in bulk.</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="student-tabs">
        <button
          type="button"
          className={`student-tab ${activeTab === "single" ? "active" : ""}`}
          onClick={() => setActiveTab("single")}
        >
          <FaUserShield /> Single Administrator
        </button>

        <button
          type="button"
          className={`student-tab ${activeTab === "bulk" ? "active" : ""}`}
          onClick={() => setActiveTab("bulk")}
        >
          <FaFileExcel /> Bulk Upload (Excel)
        </button>
      </div>

      {/* SINGLE ADMIN FORM */}
      {activeTab === "single" && (
        <form onSubmit={handleSingleSubmit} className="student-form">
          {error && (
            <div className="error-message" style={{ marginBottom: "20px" }}>
              <FaExclamationTriangle /> {error}
            </div>
          )}

          <div className="form-section">
            <h3>Administrative Profile</h3>
            <div className="form-grid">
              <div className="form-group">
                <label>Full Name *</label>
                <input
                  type="text"
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  placeholder="Enter Name"
                  required
                />
              </div>

              <div className="form-group">
                <label>Email (Google Account) *</label>
                <input
                  type="email"
                  name="email"
                  value={form.email}
                  onChange={handleChange}
                  placeholder="e.g. name@iiitdwd.ac.in"
                  required
                />
              </div>

              <div className="form-group">
                <label>Designation / Role Title</label>
                <input
                  type="text"
                  name="designation"
                  value={form.designation}
                  onChange={handleChange}
                  placeholder="e.g. System Administrator"
                />
              </div>

              <div className="form-group">
                <label>Department / Division</label>
                <input
                  type="text"
                  name="department"
                  value={form.department}
                  onChange={handleChange}
                  placeholder="e.g. Administration"
                />
              </div>

              <div className="form-group">
                <label>Phone Number</label>
                <input
                  type="tel"
                  name="phone"
                  value={form.phone}
                  onChange={handleChange}
                  placeholder="e.g. +91 XXXXX XXXXX"
                />
              </div>

              <div className="form-group">
                <label>Office / Cabin Location</label>
                <input
                  type="text"
                  name="cabin"
                  value={form.cabin}
                  onChange={handleChange}
                  placeholder="Enter Room Number"
                />
              </div>
            </div>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="back-button"
              onClick={() => navigate("/admin/admins")}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="add-user-button"
              disabled={saving}
            >
              <FaSave /> {saving ? "Saving..." : "Save Administrator"}
            </button>
          </div>
        </form>
      )}

      {/* BULK UPLOAD TAB */}
      {activeTab === "bulk" && (
        <div className="bulk-upload-container">
          <div className="bulk-instructions-card">
            <h3>Instructions for Bulk Excel Upload</h3>
            <p>Download the pre-formatted Excel template, fill in the administrator details, and upload below.</p>
            <button
              type="button"
              className="download-template-btn"
              onClick={downloadTemplate}
            >
              <FaDownload /> Download Excel Template
            </button>
          </div>

          <div className="file-drop-zone">
            <FaFileUpload className="upload-icon" />
            <h3>Choose an Excel File (.xlsx, .xls)</h3>
            <p>Upload the filled template with columns: Full Name, Email, Designation, Department, Phone, Cabin</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx, .xls"
              onChange={handleFileUpload}
              style={{ display: "none" }}
            />
            <button
              type="button"
              className="browse-file-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              Browse Computer
            </button>
            {bulkFile && <span className="selected-filename">📄 {bulkFile.name}</span>}
          </div>

          {bulkError && (
            <div className="error-message" style={{ marginTop: "20px" }}>
              <FaExclamationTriangle /> {bulkError}
            </div>
          )}

          {bulkLoading && (
            <div style={{ textAlign: "center", padding: "30px", color: "#6366f1" }}>
              <p>Parsing Excel rows...</p>
            </div>
          )}

          {parsedAdmins.length > 0 && (
            <div className="parsed-preview-card">
              <div className="preview-header">
                <h3>Preview Uploaded Administrators ({parsedAdmins.length} rows)</h3>
                <button
                  type="button"
                  className="add-user-button"
                  onClick={handleBulkSubmit}
                  disabled={bulkSaving || parsedAdmins.filter((p) => p.isValid).length === 0}
                >
                  <FaSave /> {bulkSaving ? "Importing..." : `Save ${parsedAdmins.filter((p) => p.isValid).length} Valid Admins`}
                </button>
              </div>

              <div className="preview-table-wrapper">
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Designation</th>
                      <th>Department</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedParsedAdmins.map((adm, idx) => (
                      <tr key={idx} className={adm.isValid ? "row-valid" : "row-invalid"}>
                        <td>{adm.rowNumber}</td>
                        <td><strong>{adm.name || "—"}</strong></td>
                        <td>{adm.email || "—"}</td>
                        <td>{adm.designation || "—"}</td>
                        <td>{adm.department || "—"}</td>
                        <td>
                          {adm.isValid ? (
                            <span className="valid-pill"><FaCheckCircle /> Ready</span>
                          ) : (
                            <span className="invalid-pill" title={adm.issues.join(", ")}>
                              <FaExclamationTriangle /> {adm.issues.join(", ")}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AddAdmin;
