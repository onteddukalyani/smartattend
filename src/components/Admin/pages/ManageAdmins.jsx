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
  FaUserShield,
  FaSyncAlt,
  FaEnvelope,
  FaBuilding,
  FaPhone,
  FaShieldAlt,
  FaKey,
  FaTimes,
  FaUserTie
} from "react-icons/fa";
import {
  collection,
  getDocs,
  doc,
  setDoc,
  updateDoc,
  deleteDoc
} from "firebase/firestore";
import { db } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import { downloadExcel } from "../../../DownloadExcel";
import "./ManageAdmins.css";

const ManageAdmins = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [admins, setAdmins] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all"); // "all" | "active" | "disabled"
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);

  useEffect(() => {
    loadAdmins();
  }, []);

  const loadAdmins = async () => {
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

      const adminMap = new Map();

      // 1. Ingest authorized admins from authorizedUsers
      authUsersSnap.docs.forEach((docSnap) => {
        const data = docSnap.data();
        const role = String(data.role || "").toLowerCase().trim();
        if (role === "admin" || role === "administrator" || role === "superadmin") {
          const email = (data.email || docSnap.id).toLowerCase().trim();
          adminMap.set(email, {
            id: docSnap.id,
            emailDocId: docSnap.id,
            userDocId: null,
            ...data,
            email,
            name: data.name || email.split("@")[0],
            department: data.department || "Administration",
            designation: data.designation || "System Administrator",
            phone: data.phone || "",
            role: "admin",
            status: data.status || "active"
          });
        }
      });

      // 2. Ingest admin profiles from users collection
      usersSnap.docs.forEach((docSnap) => {
        const data = docSnap.data();
        const role = String(data.role || "").toLowerCase().trim();
        if (role === "admin" || role === "administrator" || role === "superadmin") {
          const email = (data.email || "").toLowerCase().trim();
          const key = email || docSnap.id;
          const existing = adminMap.get(key) || {};

          adminMap.set(key, {
            ...existing,
            ...data,
            id: docSnap.id,
            userDocId: docSnap.id,
            emailDocId: existing.emailDocId || (email ? email : null),
            email: email || existing.email || "",
            name: data.name || existing.name || "Administrator",
            department: data.department || existing.department || "Administration",
            designation: data.designation || existing.designation || "System Administrator",
            phone: data.phone || existing.phone || "",
            role: "admin",
            status: data.status || existing.status || "active"
          });
        }
      });

      // Fallback: If no admin records in DB yet, ensure the current logged-in admin account appears
      if (adminMap.size === 0 && user?.email) {
        const myEmail = user.email.toLowerCase().trim();
        adminMap.set(myEmail, {
          id: myEmail,
          email: myEmail,
          name: user.displayName || myEmail.split("@")[0] || "Administrator",
          department: "Administration",
          designation: "System Administrator",
          role: "admin",
          status: "active"
        });
      }

      const adminList = Array.from(adminMap.values());
      adminList.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      setAdmins(adminList);
    } catch (error) {
      console.error("Error loading admins:", error);
    } finally {
      setLoading(false);
    }
  };

  const updateAdminStatus = async (adminUser, newStatus) => {
    try {
      setUpdating(adminUser.id);
      const emailKey = adminUser.email ? adminUser.email.toLowerCase().trim() : null;
      const userDocId = adminUser.userDocId || (adminUser.id && !adminUser.id.includes("@") ? adminUser.id : null);

      if (emailKey) {
        await setDoc(doc(db, "authorizedUsers", emailKey), { status: newStatus }, { merge: true });
      }
      if (userDocId) {
        await updateDoc(doc(db, "users", userDocId), { status: newStatus }).catch(() => {});
      }

      setAdmins((prev) =>
        prev.map((item) =>
          item.id === adminUser.id || (emailKey && item.email === emailKey)
            ? { ...item, status: newStatus }
            : item
        )
      );
    } catch (err) {
      console.error("Error updating admin status:", err);
      alert("Failed to update status.");
    } finally {
      setUpdating(null);
    }
  };

  const toggleStatus = (adminUser) => {
    const newStatus = adminUser.status === "active" ? "disabled" : "active";
    if (adminUser.email?.toLowerCase() === user?.email?.toLowerCase() && newStatus === "disabled") {
      alert("⚠️ You cannot disable your own active administrator account.");
      return;
    }
    updateAdminStatus(adminUser, newStatus);
  };

  const removeAdmin = async (adminUser) => {
    if (adminUser.email?.toLowerCase() === user?.email?.toLowerCase()) {
      alert("⚠️ You cannot delete your own logged-in administrator account.");
      return;
    }

    if (!window.confirm(`Are you sure you want to remove administrator ${adminUser.name || adminUser.email}?`)) {
      return;
    }

    try {
      setUpdating(adminUser.id);
      const emailKey = adminUser.email ? adminUser.email.toLowerCase().trim() : null;
      const userDocId = adminUser.userDocId || (adminUser.id && !adminUser.id.includes("@") ? adminUser.id : null);

      if (emailKey) {
        await deleteDoc(doc(db, "authorizedUsers", emailKey)).catch(() => {});
      }
      if (userDocId) {
        await deleteDoc(doc(db, "users", userDocId)).catch(() => {});
      }

      setAdmins((prev) => prev.filter((item) => item.id !== adminUser.id && item.email !== adminUser.email));
    } catch (err) {
      console.error("Error removing admin:", err);
      alert("Unable to remove administrator.");
    } finally {
      setUpdating(null);
    }
  };

  // Filter by search and status tab
  const filteredAdmins = admins.filter((a) => {
    // Status filter
    if (statusFilter === "active" && a.status !== "active") return false;
    if (statusFilter === "disabled" && a.status === "active") return false;

    // Search query filter
    const term = search.toLowerCase().trim();
    if (!term) return true;
    return (
      (a.name || "").toLowerCase().includes(term) ||
      (a.email || "").toLowerCase().includes(term) ||
      (a.department || "").toLowerCase().includes(term) ||
      (a.designation || "").toLowerCase().includes(term) ||
      (a.phone || "").toLowerCase().includes(term)
    );
  });

  const { sortedItems: sortedAdmins, sortConfig, requestSort } = useTableSort(filteredAdmins, "name", "asc");

  const totalAdmins = admins.length;
  const activeAdmins = admins.filter((a) => a.status === "active").length;
  const disabledAdmins = totalAdmins - activeAdmins;

  const handleExportExcel = () => {
    const exportData = sortedAdmins.map((a, idx) => ({
      "S.No": idx + 1,
      "Name": a.name || "N/A",
      "Email": a.email || "N/A",
      "Designation": a.designation || "System Administrator",
      "Department": a.department || "Administration",
      "Phone": a.phone || "N/A",
      "Status": a.status || "active"
    }));

    downloadExcel(exportData, `SmartAttend_Administrators_${new Date().toISOString().slice(0, 10)}`);
  };

  return (
    <div className="manage-admins-page">
      {/* Hero Banner Header */}
      <div className="admins-hero-banner">
        <div className="hero-content">
          <div className="hero-badge">
            <FaShieldAlt className="hero-badge-icon" />
            <span>SECURITY &amp; ACCESS GOVERNANCE</span>
          </div>
          <h1>Manage Administrators</h1>
          <p>
            Configure administrative privileges, security roles, system credentials, and Google account authorizations.
          </p>
        </div>

        <div className="hero-actions">
          <button
            type="button"
            className="hero-btn export-btn"
            onClick={handleExportExcel}
            disabled={admins.length === 0}
            title="Download administrators directory as Excel"
          >
            <FaFileExcel className="btn-icon" />
            <span>Export Excel</span>
          </button>

          <button
            type="button"
            className="hero-btn add-admin-btn"
            onClick={() => navigate("/admin/admins/add")}
            title="Add a new administrator"
          >
            <FaUserPlus className="btn-icon" />
            <span>Add Admin</span>
          </button>
        </div>
      </div>

      {/* KPI Stat Cards Grid */}
      <div className="admin-stats-grid">
        <div className="admin-stat-card card-total">
          <div className="stat-card-inner">
            <div className="stat-info">
              <span className="stat-label">Total Administrators</span>
              <strong className="stat-number">{loading ? "—" : totalAdmins}</strong>
              <span className="stat-meta">Configured credentials</span>
            </div>
            <div className="stat-icon-wrapper icon-total">
              <FaUserShield />
            </div>
          </div>
          <div className="stat-card-glow glow-total"></div>
        </div>

        <div className="admin-stat-card card-active">
          <div className="stat-card-inner">
            <div className="stat-info">
              <span className="stat-label">Active Administrators</span>
              <strong className="stat-number text-emerald">{loading ? "—" : activeAdmins}</strong>
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

        <div className="admin-stat-card card-disabled">
          <div className="stat-card-inner">
            <div className="stat-info">
              <span className="stat-label">Disabled / Suspended</span>
              <strong className="stat-number text-amber">{loading ? "—" : disabledAdmins}</strong>
              <span className="stat-meta">{disabledAdmins === 0 ? "Zero accounts suspended" : "Restricted access"}</span>
            </div>
            <div className="stat-icon-wrapper icon-disabled">
              <FaUserSlash />
            </div>
          </div>
          <div className="stat-card-glow glow-disabled"></div>
        </div>

        <div className="admin-stat-card card-security">
          <div className="stat-card-inner">
            <div className="stat-info">
              <span className="stat-label">Security Protocol</span>
              <strong className="stat-number text-indigo" style={{ fontSize: "1.15rem" }}>
                Super Admin Guard
              </strong>
              <span className="stat-meta">Google OAuth &amp; RBAC</span>
            </div>
            <div className="stat-icon-wrapper icon-security">
              <FaKey />
            </div>
          </div>
          <div className="stat-card-glow glow-security"></div>
        </div>
      </div>

      {/* Main Table Container */}
      <div className="admins-container-card">
        {/* Filter and Search Bar */}
        <div className="table-controls-bar">
          {/* Status Filter Tabs */}
          <div className="status-tabs-group" role="tablist">
            <button
              type="button"
              className={`status-tab ${statusFilter === "all" ? "active" : ""}`}
              onClick={() => setStatusFilter("all")}
            >
              All Admins
              <span className="tab-badge">{totalAdmins}</span>
            </button>
            <button
              type="button"
              className={`status-tab ${statusFilter === "active" ? "active" : ""}`}
              onClick={() => setStatusFilter("active")}
            >
              Active
              <span className="tab-badge badge-active">{activeAdmins}</span>
            </button>
            <button
              type="button"
              className={`status-tab ${statusFilter === "disabled" ? "active" : ""}`}
              onClick={() => setStatusFilter("disabled")}
            >
              Disabled
              <span className="tab-badge badge-disabled">{disabledAdmins}</span>
            </button>
          </div>

          {/* Search Input & Refresh Button */}
          <div className="search-actions-wrapper">
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
              onClick={loadAdmins}
              disabled={loading}
              title="Refresh administrator list"
            >
              <FaSyncAlt className={loading ? "spin-icon" : ""} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Table / Empty State */}
        {loading ? (
          <div className="table-loading-state">
            <div className="loading-spinner"></div>
            <p>Loading administrator accounts...</p>
          </div>
        ) : sortedAdmins.length === 0 ? (
          <div className="table-empty-state">
            <div className="empty-icon-circle">
              <FaUserShield />
            </div>
            <h3>No Administrators Found</h3>
            <p>
              {search
                ? `No administrators match the search term "${search}".`
                : statusFilter !== "all"
                ? `No administrators currently in "${statusFilter}" status.`
                : "No administrator profiles registered in the system yet."}
            </p>
            {search ? (
              <button type="button" className="hero-btn" onClick={() => setSearch("")}>
                Clear Search
              </button>
            ) : (
              <button
                type="button"
                className="hero-btn add-admin-btn"
                onClick={() => navigate("/admin/admins/add")}
              >
                <FaUserPlus /> Add Administrator
              </button>
            )}
          </div>
        ) : (
          <div className="admins-table-scroll">
            <table className="admins-modern-table">
              <thead>
                <tr>
                  <th className="sortable-th" onClick={() => requestSort("name")} title="Sort by Name">
                    Administrator Profile <SortIcon sortConfig={sortConfig} columnKey="name" />
                  </th>
                  <th className="sortable-th" onClick={() => requestSort("designation")} title="Sort by Designation">
                    Designation &amp; Role <SortIcon sortConfig={sortConfig} columnKey="designation" />
                  </th>
                  <th className="sortable-th" onClick={() => requestSort("department")} title="Sort by Department">
                    Department <SortIcon sortConfig={sortConfig} columnKey="department" />
                  </th>
                  <th className="sortable-th" onClick={() => requestSort("status")} title="Sort by Status">
                    Status <SortIcon sortConfig={sortConfig} columnKey="status" />
                  </th>
                  <th style={{ textAlign: "right", paddingRight: "24px" }}>Actions</th>
                </tr>
              </thead>

              <tbody>
                {sortedAdmins.map((adminUser) => {
                  const isCurrent = adminUser.email?.toLowerCase() === user?.email?.toLowerCase();
                  const isBusy = updating === adminUser.id;

                  return (
                    <tr key={adminUser.id} className={isCurrent ? "row-current-admin" : ""}>
                      <td>
                        <div className="admin-profile-row">
                          {adminUser.photoURL ? (
                            <div className="admin-avatar-box">
                              <img src={adminUser.photoURL} alt={adminUser.name} />
                              <span className={`avatar-status-dot ${adminUser.status === "active" ? "online" : "offline"}`}></span>
                            </div>
                          ) : (
                            <div className="admin-avatar-box avatar-fallback">
                              <FaUserShield />
                              <span className={`avatar-status-dot ${adminUser.status === "active" ? "online" : "offline"}`}></span>
                            </div>
                          )}

                          <div className="admin-text-details">
                            <div className="admin-name-heading">
                              <strong className="admin-display-name">{adminUser.name || "Administrator"}</strong>
                              {isCurrent && <span className="you-current-tag">You (Active)</span>}
                            </div>
                            <div className="admin-email-line">
                              <FaEnvelope className="inline-meta-icon" />
                              <span>{adminUser.email || "No email"}</span>
                            </div>
                            {adminUser.phone && (
                              <div className="admin-phone-line">
                                <FaPhone className="inline-meta-icon" />
                                <span>{adminUser.phone}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      <td>
                        <div className="designation-cell">
                          <span className="designation-chip">
                            <FaUserTie className="chip-icon" />
                            {adminUser.designation || "System Administrator"}
                          </span>
                        </div>
                      </td>

                      <td>
                        <div className="department-cell">
                          <span className="department-chip">
                            <FaBuilding className="chip-icon" />
                            {adminUser.department || "Administration"}
                          </span>
                        </div>
                      </td>

                      <td>
                        {adminUser.status === "active" ? (
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

                      <td>
                        <div className="admin-actions-cell">
                          <button
                            type="button"
                            className={`action-btn ${adminUser.status === "active" ? "btn-disable" : "btn-enable"}`}
                            disabled={isBusy || isCurrent}
                            onClick={() => toggleStatus(adminUser)}
                            title={
                              isCurrent
                                ? "You cannot disable your own active account"
                                : adminUser.status === "active"
                                ? "Disable administrator access"
                                : "Enable administrator access"
                            }
                          >
                            {adminUser.status === "active" ? <FaUserSlash /> : <FaUserCheck />}
                            <span className="action-btn-text">
                              {adminUser.status === "active" ? "Disable" : "Enable"}
                            </span>
                          </button>

                          <button
                            type="button"
                            className="action-btn btn-delete"
                            disabled={isBusy || isCurrent}
                            onClick={() => removeAdmin(adminUser)}
                            title={
                              isCurrent
                                ? "You cannot delete your own active account"
                                : "Remove administrator permanently"
                            }
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
    </div>
  );
};

export default ManageAdmins;
