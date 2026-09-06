import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  FaSearch,
  FaUserPlus,
  FaFileExcel,
  FaCheckCircle,
  FaTimesCircle,
  FaUserSlash,
  FaUserCheck,
  FaTrashAlt,
  FaEye,
  FaSyncAlt,
  FaChalkboardTeacher,
  FaClock,
  FaEnvelope,
  FaPhone,
  FaBuilding,
  FaUserTie,
  FaTimes,
  FaCalendarAlt,
  FaGraduationCap
} from "react-icons/fa";

import {
  collection,
  getDocs,
  doc,
  setDoc,
  deleteDoc
} from "firebase/firestore";

import { db } from "../../../firebase";
import LecturerDetailModal from "../../Common/LecturerDetailModal";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import { buildUserLookupMaps, normalizeSessions, doesSessionBelongToLecturer } from "../../Common/sessionMatcher";
import { downloadExcel } from "../../../DownloadExcel";

import "./ManageLecturers.css";

const ManageLecturers = () => {
  const navigate = useNavigate();
  const [lecturers, setLecturers] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all"); // "all" | "active" | "pending" | "disabled"
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);
  const [selectedLecturer, setSelectedLecturer] = useState(null);

  useEffect(() => {
    loadLecturers();
  }, []);

  const loadLecturers = async () => {
    try {
      setLoading(true);

      const [lecturersSnap, usersSnap, authUsersSnap, sessionsSnap, recordsSnap] = await Promise.all([
        getDocs(collection(db, "lecturers")).catch((e) => {
          console.warn("Could not read lecturers collection:", e);
          return { docs: [] };
        }),
        getDocs(collection(db, "users")).catch((e) => {
          console.warn("Could not read users collection:", e);
          return { docs: [] };
        }),
        getDocs(collection(db, "authorizedUsers")).catch((e) => {
          console.warn("Could not read authorizedUsers collection:", e);
          return { docs: [] };
        }),
        getDocs(collection(db, "attendance_sessions")).catch((e) => {
          console.warn("Could not read attendance_sessions collection:", e);
          return { docs: [] };
        }),
        getDocs(collection(db, "attendance_records")).catch((e) => {
          console.warn("Could not read attendance_records collection:", e);
          return { docs: [] };
        })
      ]);

      // Build cross-collection user lookup maps
      const lookupMaps = buildUserLookupMaps(
        [...lecturersSnap.docs, ...usersSnap.docs],
        authUsersSnap.docs,
        recordsSnap.docs,
        sessionsSnap.docs
      );

      const lecturerMap = new Map();

      // 1. Ingest faculty from lecturers collection
      lecturersSnap.docs.forEach((docSnap) => {
        const data = docSnap.data();
        const email = (data.email || (docSnap.id.includes("@") ? docSnap.id : "")).toLowerCase().trim();
        const key = email || docSnap.id;
        lecturerMap.set(key, {
          id: docSnap.id,
          lecturerDocId: docSnap.id,
          emailDocId: docSnap.id.includes("@") ? docSnap.id : null,
          userDocId: null,
          ...data,
          email: email || data.email || "",
          uid: data.uid || lookupMaps.emailToUid.get(email) || null,
          name: data.name || (email ? email.split("@")[0] : "Lecturer"),
          department: (data.department && String(data.department).toLowerCase() !== "general") ? data.department : "Computer Science & Engineering",
          designation: data.designation || "Assistant Professor",
          phone: data.phone || "",
          cabin: data.cabin || "",
          role: "lecturer",
          approved: data.approved !== false,
          status: data.status || "active"
        });
      });

      // 2. Ingest authorized faculty from authorizedUsers
      authUsersSnap.docs.forEach((docSnap) => {
        const data = docSnap.data();
        const role = String(data.role || "").toLowerCase().trim();
        if (role === "lecturer" || role === "faculty" || role === "professor") {
          const email = (data.email || (docSnap.id.includes("@") ? docSnap.id : "")).toLowerCase().trim();
          const key = email || docSnap.id;
          const existing = lecturerMap.get(key) || {};
          lecturerMap.set(key, {
            ...existing,
            id: existing.id || docSnap.id,
            emailDocId: docSnap.id,
            userDocId: existing.userDocId || null,
            ...data,
            email: email || existing.email || "",
            uid: data.uid || existing.uid || lookupMaps.emailToUid.get(email) || null,
            name: data.name || existing.name || (email ? email.split("@")[0] : "Lecturer"),
            department: (data.department && String(data.department).toLowerCase() !== "general") ? data.department : ((existing.department && String(existing.department).toLowerCase() !== "general") ? existing.department : "Computer Science & Engineering"),
            designation: data.designation || existing.designation || "Assistant Professor",
            phone: data.phone || existing.phone || "",
            cabin: data.cabin || existing.cabin || "",
            role: "lecturer",
            approved: data.approved !== false && existing.approved !== false,
            status: data.status || existing.status || "active"
          });
        }
      });

      // 3. Ingest lecturer profiles from users collection
      usersSnap.docs.forEach((docSnap) => {
        const data = docSnap.data();
        const role = String(data.role || "").toLowerCase().trim();
        if (role === "lecturer" || role === "faculty" || role === "professor") {
          const email = (data.email || (docSnap.id.includes("@") ? docSnap.id : "")).toLowerCase().trim();
          const key = email || docSnap.id;
          const existing = lecturerMap.get(key) || {};

          lecturerMap.set(key, {
            ...existing,
            ...data,
            id: existing.id || docSnap.id,
            userDocId: docSnap.id,
            emailDocId: existing.emailDocId || (email ? email : null),
            email: email || existing.email || "",
            uid: data.uid || existing.uid || lookupMaps.emailToUid.get(email) || null,
            name: data.name || existing.name || (email ? email.split("@")[0] : "Lecturer"),
            department: (data.department && String(data.department).toLowerCase() !== "general") ? data.department : ((existing.department && String(existing.department).toLowerCase() !== "general") ? existing.department : "Computer Science & Engineering"),
            designation: data.designation || existing.designation || "Assistant Professor",
            phone: data.phone || existing.phone || "",
            cabin: data.cabin || existing.cabin || "",
            role: "lecturer",
            approved: data.approved !== false && existing.approved !== false,
            status: data.status || existing.status || "active"
          });
        }
      });

      // 4. Build comprehensive sessions list with resolved owner metadata
      const sessionsList = normalizeSessions(sessionsSnap.docs, recordsSnap.docs, lookupMaps);

      const allFacultyList = Array.from(lecturerMap.values());
      const totalFacultyCount = allFacultyList.length;

      const lecturerList = allFacultyList.map((lec) => {
        const mySessions = sessionsList.filter((sess) =>
          doesSessionBelongToLecturer(sess, lec, lookupMaps, totalFacultyCount)
        );

        return {
          ...lec,
          classesConducted: mySessions.length
        };
      });

      lecturerList.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      setLecturers(lecturerList);
    } catch (error) {
      console.error("Error loading lecturers:", error);
    } finally {
      setLoading(false);
    }
  };

  const updateLecturer = async (lecturer, changes) => {
    try {
      setUpdating(lecturer.id);

      const emailKey = lecturer.email ? lecturer.email.toLowerCase().trim() : null;
      const prefix = emailKey ? emailKey.split("@")[0] : null;
      const lecturerDocId = lecturer.lecturerDocId || lecturer.id;
      const userDocId = lecturer.userDocId || (lecturer.id && !lecturer.id.includes("@") ? lecturer.id : null);

      const promises = [];

      // 1. Update in lecturers collection
      if (lecturerDocId) {
        promises.push(setDoc(doc(db, "lecturers", lecturerDocId), changes, { merge: true }));
      }
      if (prefix) {
        promises.push(setDoc(doc(db, "lecturers", prefix), changes, { merge: true }));
      }
      if (emailKey) {
        promises.push(setDoc(doc(db, "lecturers", emailKey), { ...lecturer, ...changes, role: "lecturer" }, { merge: true }));
      }

      // 2. Update in users collection
      if (userDocId) {
        promises.push(setDoc(doc(db, "users", userDocId), changes, { merge: true }));
      } else if (emailKey) {
        promises.push(setDoc(doc(db, "users", emailKey), { ...lecturer, ...changes, role: "lecturer" }, { merge: true }));
      }
      if (prefix) {
        promises.push(setDoc(doc(db, "users", prefix), changes, { merge: true }));
      }

      // 3. Update in authorizedUsers collection
      if (emailKey) {
        promises.push(setDoc(doc(db, "authorizedUsers", emailKey), changes, { merge: true }));
      }
      if (prefix) {
        promises.push(setDoc(doc(db, "authorizedUsers", prefix), changes, { merge: true }));
      }

      await Promise.all(promises);

      setLecturers((previous) =>
        previous.map((item) =>
          item.id === lecturer.id || (emailKey && item.email?.toLowerCase() === emailKey)
            ? { ...item, ...changes }
            : item
        )
      );
    } catch (error) {
      console.error("Error updating lecturer:", error);
      alert("Unable to update lecturer.");
    } finally {
      setUpdating(null);
    }
  };

  const approveLecturer = async (lecturer) => {
    const confirmed = window.confirm(
      `Approve ${lecturer.name || lecturer.email} as a lecturer?`
    );

    if (!confirmed) return;

    await updateLecturer(lecturer, {
      approved: true,
      status: "active"
    });
  };

  const rejectLecturer = async (lecturer) => {
    const confirmed = window.confirm(
      `Remove approval for ${lecturer.name || lecturer.email}?`
    );

    if (!confirmed) return;

    await updateLecturer(lecturer, {
      approved: false,
      status: "disabled"
    });
  };

  const toggleStatus = async (lecturer) => {
    const currentlyActive = lecturer.status === "active";
    const newStatus = currentlyActive ? "disabled" : "active";

    await updateLecturer(lecturer, {
      status: newStatus
    });
  };

  const removeLecturer = async (lecturer) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete ${lecturer.name || lecturer.email}? This will revoke their access to SmartAttend.`
    );

    if (!confirmed) return;

    try {
      setUpdating(lecturer.id);
      const emailKey = lecturer.email ? lecturer.email.toLowerCase().trim() : null;
      const prefix = emailKey ? emailKey.split("@")[0] : null;
      const lecturerDocId = lecturer.lecturerDocId || lecturer.id;
      const userDocId = lecturer.userDocId || lecturer.id;

      const promises = [];
      if (lecturerDocId) {
        promises.push(deleteDoc(doc(db, "lecturers", lecturerDocId)).catch(() => { }));
      }
      if (prefix) {
        promises.push(deleteDoc(doc(db, "lecturers", prefix)).catch(() => { }));
        promises.push(deleteDoc(doc(db, "authorizedUsers", prefix)).catch(() => { }));
        promises.push(deleteDoc(doc(db, "users", prefix)).catch(() => { }));
      }
      if (userDocId) {
        promises.push(deleteDoc(doc(db, "users", userDocId)).catch(() => { }));
      }
      if (emailKey) {
        promises.push(deleteDoc(doc(db, "lecturers", emailKey)).catch(() => { }));
        promises.push(deleteDoc(doc(db, "authorizedUsers", emailKey)).catch(() => { }));
        if (emailKey !== userDocId) {
          promises.push(deleteDoc(doc(db, "users", emailKey)).catch(() => { }));
        }
      }

      await Promise.all(promises);

      setLecturers((previous) =>
        previous.filter((item) => item.id !== lecturer.id && (!emailKey || item.email?.toLowerCase() !== emailKey))
      );
    } catch (error) {
      console.error("Error removing lecturer:", error);
      alert("Unable to remove lecturer. Please try again.");
    } finally {
      setUpdating(null);
    }
  };

  // Metrics
  const totalLecturers = lecturers.length;
  const activeLecturers = lecturers.filter((l) => l.status === "active" && l.approved !== false).length;
  const pendingCount = lecturers.filter((l) => l.approved !== true).length;
  const disabledCount = lecturers.filter((l) => l.status === "disabled").length;
  const totalClassesConducted = lecturers.reduce((sum, l) => sum + (l.classesConducted || 0), 0);

  // Unique departments for quick filter
  const departmentsList = Array.from(
    new Set(lecturers.map((l) => l.department).filter(Boolean))
  ).sort();

  // Filtered dataset
  const filteredLecturers = lecturers.filter((lecturer) => {
    // Status Filter
    if (statusFilter === "active" && (lecturer.status !== "active" || lecturer.approved === false)) return false;
    if (statusFilter === "pending" && lecturer.approved === true) return false;
    if (statusFilter === "disabled" && lecturer.status !== "disabled") return false;

    // Department Filter
    if (departmentFilter !== "all" && lecturer.department !== departmentFilter) return false;

    // Search Query
    const value = search.toLowerCase().trim();
    if (!value) return true;

    return (
      lecturer.name?.toLowerCase().includes(value) ||
      lecturer.email?.toLowerCase().includes(value) ||
      lecturer.department?.toLowerCase().includes(value) ||
      lecturer.designation?.toLowerCase().includes(value) ||
      lecturer.phone?.toLowerCase().includes(value)
    );
  });

  const { sortedItems: sortedLecturers, sortConfig, requestSort } = useTableSort(filteredLecturers, "name", "asc");

  const handleExportExcel = () => {
    const exportData = sortedLecturers.map((l, idx) => ({
      "S.No": idx + 1,
      "Faculty Name": l.name || "N/A",
      "Email Address": l.email || "N/A",
      "Department": l.department || "Computer Science & Engineering",
      "Designation": l.designation || "Assistant Professor",
      "Phone": l.phone || "N/A",
      "Classes Conducted": l.classesConducted || 0,
      "Approval Status": l.approved === true ? "Approved" : "Pending",
      "Account Status": l.status || "active"
    }));

    downloadExcel(exportData, `SmartAttend_Faculty_Directory_${new Date().toISOString().slice(0, 10)}`);
  };

  return (
    <div className="manage-lecturers-page">
      {/* Hero Banner */}
      <div className="lecturers-hero-banner">
        <div className="hero-content">
          <div className="hero-badge">
            <FaChalkboardTeacher className="hero-badge-icon" />
            <span>FACULTY &amp; TEACHING STAFF DIRECTORY</span>
          </div>
          <h1>Manage Lecturers</h1>
          <p>
            Manage lecturers and click any lecturer to view their teaching activity and classes conducted.
          </p>
        </div>

        <div className="hero-actions">
          <button
            type="button"
            className="hero-btn export-btn"
            onClick={handleExportExcel}
            disabled={lecturers.length === 0}
            title="Download faculty directory as Excel"
          >
            <FaFileExcel className="btn-icon" />
            <span>Export Excel</span>
          </button>

          <button
            type="button"
            className="hero-btn bulk-btn"
            onClick={() => navigate("/admin/lecturers/add")}
            title="Bulk upload lecturers via Excel / CSV"
          >
            <FaFileExcel className="btn-icon" />
            <span>Bulk Upload</span>
          </button>

          <button
            type="button"
            className="hero-btn add-lecturer-btn"
            onClick={() => navigate("/admin/lecturers/add")}
            title="Add a new faculty member"
          >
            <FaUserPlus className="btn-icon" />
            <span>Add Lecturer</span>
          </button>
        </div>
      </div>

      {/* KPI Stat Cards Grid */}
      <div className="lecturer-stats-grid">
        <div className="lecturer-stat-card card-total">
          <div className="stat-card-inner">
            <div className="stat-info">
              <span className="stat-label">Total Faculty</span>
              <strong className="stat-number">{loading ? "—" : totalLecturers}</strong>
              <span className="stat-meta">Verified faculty profiles</span>
            </div>
            <div className="stat-icon-wrapper icon-total">
              <FaChalkboardTeacher />
            </div>
          </div>
          <div className="stat-card-glow glow-total"></div>
        </div>

        <div className="lecturer-stat-card card-active">
          <div className="stat-card-inner">
            <div className="stat-info">
              <span className="stat-label">Active Lecturers</span>
              <strong className="stat-number text-emerald">{loading ? "—" : activeLecturers}</strong>
              <span className="stat-meta">
                <span className="live-indicator-dot"></span> Authorized &amp; Active
              </span>
            </div>
            <div className="stat-icon-wrapper icon-active">
              <FaCheckCircle />
            </div>
          </div>
          <div className="stat-card-glow glow-active"></div>
        </div>

        <div className="lecturer-stat-card card-pending">
          <div className="stat-card-inner">
            <div className="stat-info">
              <span className="stat-label">Pending Approval</span>
              <strong className="stat-number text-amber">{loading ? "—" : pendingCount}</strong>
              <span className="stat-meta">{pendingCount === 0 ? "All faculty approved" : "Awaiting admin clearance"}</span>
            </div>
            <div className="stat-icon-wrapper icon-pending">
              <FaClock />
            </div>
          </div>
          <div className="stat-card-glow glow-pending"></div>
        </div>

        <div className="lecturer-stat-card card-classes">
          <div className="stat-card-inner">
            <div className="stat-info">
              <span className="stat-label">Classes Conducted</span>
              <strong className="stat-number text-sky">{loading ? "—" : totalClassesConducted}</strong>
              <span className="stat-meta">Recorded attendance sessions</span>
            </div>
            <div className="stat-icon-wrapper icon-classes">
              <FaCalendarAlt />
            </div>
          </div>
          <div className="stat-card-glow glow-classes"></div>
        </div>
      </div>

      {/* Main Table Card Container */}
      <div className="lecturers-container-card">
        {/* Filter and Search Bar */}
        <div className="table-controls-bar">
          {/* Status Filter Tabs */}
          <div className="status-tabs-group" role="tablist">
            <button
              type="button"
              className={`status-tab ${statusFilter === "all" ? "active" : ""}`}
              onClick={() => setStatusFilter("all")}
            >
              All Faculty
              <span className="tab-badge">{totalLecturers}</span>
            </button>
            <button
              type="button"
              className={`status-tab ${statusFilter === "active" ? "active" : ""}`}
              onClick={() => setStatusFilter("active")}
            >
              Active
              <span className="tab-badge badge-active">{activeLecturers}</span>
            </button>
            <button
              type="button"
              className={`status-tab ${statusFilter === "pending" ? "active" : ""}`}
              onClick={() => setStatusFilter("pending")}
            >
              Pending Approval
              <span className="tab-badge badge-pending">{pendingCount}</span>
            </button>
            <button
              type="button"
              className={`status-tab ${statusFilter === "disabled" ? "active" : ""}`}
              onClick={() => setStatusFilter("disabled")}
            >
              Disabled
              <span className="tab-badge badge-disabled">{disabledCount}</span>
            </button>
          </div>

          {/* Search Input, Department Filter & Refresh */}
          <div className="search-actions-wrapper">
            {departmentsList.length > 1 && (
              <select
                className="department-select-filter"
                value={departmentFilter}
                onChange={(e) => setDepartmentFilter(e.target.value)}
                title="Filter by department"
              >
                <option value="all">All Departments</option>
                {departmentsList.map((dept) => (
                  <option key={dept} value={dept}>
                    {dept}
                  </option>
                ))}
              </select>
            )}

            <div className="modern-search-box">
              <FaSearch className="search-icon" />
              <input
                type="text"
                placeholder="Search by name, email, department, designation..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setSearch("")}
                  title="Clear search"
                >
                  <FaTimes />
                </button>
              )}
            </div>

            <button
              type="button"
              className="refresh-btn"
              onClick={loadLecturers}
              disabled={loading}
              title="Refresh faculty list"
            >
              <FaSyncAlt className={loading ? "spin-icon" : ""} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Table Content / Loading / Empty States */}
        {loading ? (
          <div className="table-loading-state">
            <div className="loading-spinner"></div>
            <p>Loading faculty and teaching records...</p>
          </div>
        ) : sortedLecturers.length === 0 ? (
          <div className="table-empty-state">
            <div className="empty-icon-circle">
              <FaChalkboardTeacher />
            </div>
            <h3>No Faculty Members Found</h3>
            <p>
              {search
                ? `No faculty match the search query "${search}".`
                : departmentFilter !== "all"
                  ? `No faculty found in department "${departmentFilter}".`
                  : statusFilter !== "all"
                    ? `No faculty currently in "${statusFilter}" status.`
                    : "No lecturer profiles registered in the system yet."}
            </p>
            {search || departmentFilter !== "all" ? (
              <button
                type="button"
                className="hero-btn"
                onClick={() => {
                  setSearch("");
                  setDepartmentFilter("all");
                }}
              >
                Reset Filters
              </button>
            ) : (
              <div style={{ display: "flex", gap: "10px", marginTop: "14px", flexWrap: "wrap", justifyContent: "center" }}>
                <button
                  type="button"
                  className="hero-btn bulk-btn"
                  onClick={() => navigate("/admin/lecturers/add")}
                >
                  <FaFileExcel /> Bulk Upload
                </button>
                <button
                  type="button"
                  className="hero-btn add-lecturer-btn"
                  onClick={() => navigate("/admin/lecturers/add")}
                >
                  <FaUserPlus /> Add Lecturer
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="lecturers-table-scroll">
            <table className="lecturers-modern-table">
              <thead>
                <tr>
                  <th className="sortable-th" onClick={() => requestSort("name")} title="Sort by Lecturer Name">
                    Lecturer Profile <SortIcon sortConfig={sortConfig} columnKey="name" />
                  </th>
                  <th className="sortable-th" onClick={() => requestSort("department")} title="Sort by Department">
                    Department &amp; Designation <SortIcon sortConfig={sortConfig} columnKey="department" />
                  </th>
                  <th className="sortable-th" onClick={() => requestSort("classesConducted")} title="Sort by Classes Conducted">
                    Classes Conducted <SortIcon sortConfig={sortConfig} columnKey="classesConducted" />
                  </th>
                  <th className="sortable-th" onClick={() => requestSort("approved")} title="Sort by Approval">
                    Approval <SortIcon sortConfig={sortConfig} columnKey="approved" />
                  </th>
                  <th className="sortable-th" onClick={() => requestSort("status")} title="Sort by Status">
                    Status <SortIcon sortConfig={sortConfig} columnKey="status" />
                  </th>
                  <th style={{ textAlign: "right", paddingRight: "24px" }}>Actions</th>
                </tr>
              </thead>

              <tbody>
                {sortedLecturers.map((lecturer) => {
                  const isBusy = updating === lecturer.id;

                  return (
                    <tr
                      key={lecturer.id}
                      className="lecturer-row-item"
                      onClick={() => setSelectedLecturer(lecturer)}
                    >
                      <td>
                        <div className="lecturer-profile-cell">
                          {lecturer.photoURL ? (
                            <div className="lecturer-avatar-box">
                              <img src={lecturer.photoURL} alt={lecturer.name} />
                              <span className={`avatar-status-dot ${lecturer.status === "active" ? "online" : "offline"}`}></span>
                            </div>
                          ) : (
                            <div className="lecturer-avatar-box avatar-fallback">
                              <span>{lecturer.name?.charAt(0).toUpperCase() || "L"}</span>
                              <span className={`avatar-status-dot ${lecturer.status === "active" ? "online" : "offline"}`}></span>
                            </div>
                          )}

                          <div className="lecturer-text-details">
                            <div className="lecturer-name-heading">
                              <strong className="lecturer-display-name">{lecturer.name || "Unnamed Lecturer"}</strong>
                              <span className="faculty-role-tag">Faculty</span>
                            </div>
                            <div className="lecturer-email-line">
                              <FaEnvelope className="inline-meta-icon" />
                              <span>{lecturer.email || "No email"}</span>
                            </div>
                            {lecturer.phone && (
                              <div className="lecturer-phone-line">
                                <FaPhone className="inline-meta-icon" />
                                <span>{lecturer.phone}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      <td>
                        <div className="department-cell-stack">
                          <span className="department-chip">
                            <FaBuilding className="chip-icon" />
                            {lecturer.department || "Computer Science & Engineering"}
                          </span>
                          <span className="designation-chip">
                            <FaUserTie className="chip-icon" />
                            {lecturer.designation || "Assistant Professor"}
                          </span>
                        </div>
                      </td>

                      <td>
                        <div className="classes-conducted-pill">
                          <FaCalendarAlt className="classes-pill-icon" />
                          <span className="classes-pill-count">{lecturer.classesConducted || 0}</span>
                          <span className="classes-pill-label">{lecturer.classesConducted === 1 ? "class" : "classes"}</span>
                        </div>
                      </td>

                      <td>
                        {lecturer.approved === true ? (
                          <span className="approval-badge-approved">
                            <FaCheckCircle className="badge-icon" />
                            Approved
                          </span>
                        ) : (
                          <span className="approval-badge-pending">
                            <FaClock className="badge-icon" />
                            Pending
                          </span>
                        )}
                      </td>

                      <td>
                        {lecturer.status === "active" ? (
                          <span className="status-badge-active">
                            <span className="pulse-dot"></span>
                            Active
                          </span>
                        ) : (
                          <span className="status-badge-disabled">
                            <FaTimesCircle className="badge-icon" />
                            Disabled
                          </span>
                        )}
                      </td>

                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="lecturer-actions-cell">
                          {/* View details */}
                          <button
                            type="button"
                            className="action-btn btn-view"
                            onClick={() => setSelectedLecturer(lecturer)}
                            title="View faculty teaching activity & details"
                          >
                            <FaEye />
                          </button>

                          {/* Approval toggles */}
                          {lecturer.approved !== true ? (
                            <button
                              type="button"
                              className="action-btn btn-approve"
                              disabled={isBusy}
                              onClick={() => approveLecturer(lecturer)}
                              title="Approve faculty access"
                            >
                              <FaCheckCircle />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="action-btn btn-reject"
                              disabled={isBusy}
                              onClick={() => rejectLecturer(lecturer)}
                              title="Revoke faculty approval"
                            >
                              <FaTimesCircle />
                            </button>
                          )}

                          {/* Status toggle */}
                          <button
                            type="button"
                            className={`action-btn ${lecturer.status === "active" ? "btn-disable" : "btn-enable"}`}
                            disabled={isBusy}
                            onClick={() => toggleStatus(lecturer)}
                            title={
                              lecturer.status === "active"
                                ? "Disable faculty access"
                                : "Enable faculty access"
                            }
                          >
                            {lecturer.status === "active" ? <FaUserSlash /> : <FaUserCheck />}
                          </button>

                          {/* Delete */}
                          <button
                            type="button"
                            className="action-btn btn-delete"
                            disabled={isBusy}
                            onClick={() => removeLecturer(lecturer)}
                            title="Delete faculty record"
                          >
                            <FaTrashAlt />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Lecturer Details Modal */}
      {selectedLecturer && (
        <LecturerDetailModal
          lecturer={selectedLecturer}
          onClose={() => setSelectedLecturer(null)}
        />
      )}
    </div>
  );
};

export default ManageLecturers;