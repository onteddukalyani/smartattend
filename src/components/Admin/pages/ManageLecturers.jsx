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
  FaSyncAlt
} from "react-icons/fa";

import {
  collection,
  getDocs,
  query,
  where,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc
} from "firebase/firestore";

import { db } from "../../../firebase";
import LecturerDetailModal from "../../Common/LecturerDetailModal";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import { buildUserLookupMaps, normalizeSessions, doesSessionBelongToLecturer } from "../../Common/sessionMatcher";

import "./ManageLecturers.css";

const ManageLecturers = () => {
  const navigate = useNavigate();
  const [lecturers, setLecturers] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);
  const [selectedLecturer, setSelectedLecturer] = useState(null);

  useEffect(() => {
    loadLecturers();
  }, []);

  const loadLecturers = async () => {
    try {
      setLoading(true);

      const [usersSnap, authUsersSnap, sessionsSnap, recordsSnap] = await Promise.all([
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
        usersSnap.docs,
        authUsersSnap.docs,
        recordsSnap.docs,
        sessionsSnap.docs
      );

      const lecturerMap = new Map();

      // 1. Ingest authorized faculty from authorizedUsers
      authUsersSnap.docs.forEach((docSnap) => {
        const data = docSnap.data();
        const role = String(data.role || "").toLowerCase().trim();
        if (role === "lecturer" || role === "faculty" || role === "professor") {
          const email = (data.email || (docSnap.id.includes("@") ? docSnap.id : "")).toLowerCase().trim();
          const key = email || docSnap.id;
          lecturerMap.set(key, {
            id: docSnap.id,
            emailDocId: docSnap.id,
            userDocId: null,
            ...data,
            email,
            uid: data.uid || lookupMaps.emailToUid.get(email) || null,
            name: data.name || (email ? email.split("@")[0] : "Lecturer"),
            department: data.department || "General",
            designation: data.designation || "Assistant Professor",
            phone: data.phone || "",
            cabin: data.cabin || "",
            role: "lecturer",
            approved: data.approved !== false,
            status: data.status || "active"
          });
        }
      });

      // 2. Ingest lecturer profiles from users collection
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
            department: data.department || existing.department || "General",
            designation: data.designation || existing.designation || "Assistant Professor",
            phone: data.phone || existing.phone || "",
            cabin: data.cabin || existing.cabin || "",
            role: "lecturer",
            approved: data.approved !== false && existing.approved !== false,
            status: data.status || existing.status || "active"
          });
        }
      });

      // 3. Build comprehensive sessions list with resolved owner metadata
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
      const userDocId = lecturer.userDocId || (lecturer.id && !lecturer.id.includes("@") ? lecturer.id : null);

      const promises = [];

      // Update in users collection
      if (userDocId) {
        promises.push(setDoc(doc(db, "users", userDocId), changes, { merge: true }));
      } else if (emailKey) {
        promises.push(setDoc(doc(db, "users", emailKey), { ...lecturer, ...changes, role: "lecturer" }, { merge: true }));
      }

      // Update in authorizedUsers collection
      if (emailKey) {
        promises.push(setDoc(doc(db, "authorizedUsers", emailKey), changes, { merge: true }));
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
      const userDocId = lecturer.userDocId || lecturer.id;

      const promises = [];
      if (userDocId) {
        promises.push(deleteDoc(doc(db, "users", userDocId)).catch(() => {}));
      }
      if (emailKey) {
        promises.push(deleteDoc(doc(db, "authorizedUsers", emailKey)).catch(() => {}));
        if (emailKey !== userDocId) {
          promises.push(deleteDoc(doc(db, "users", emailKey)).catch(() => {}));
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

  const filteredLecturers = lecturers.filter((lecturer) => {
    const value = search.toLowerCase().trim();

    if (!value) return true;

    return (
      lecturer.name?.toLowerCase().includes(value) ||
      lecturer.email?.toLowerCase().includes(value) ||
      lecturer.department?.toLowerCase().includes(value)
    );
  });

  const { sortedItems: sortedLecturers, sortConfig, requestSort } = useTableSort(filteredLecturers, "name", "asc");

  const pendingCount = lecturers.filter(
    (lecturer) => lecturer.approved !== true
  ).length;

  return (
    <div className="manage-lecturers">

      {/* Header */}
      <div className="lecturers-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "15px" }}>
        <div>
          <h1>Lecturers</h1>
          <p>
            Manage lecturers and click any lecturer to view their teaching activity and classes conducted.
          </p>
        </div>

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <button
            type="button"
            className="add-user-button"
            style={{ background: "var(--surface-soft, #f8fafc)", color: "var(--text-main, #333)", border: "1px solid var(--border, #cbd5e1)" }}
            onClick={loadLecturers}
            disabled={loading}
            title="Refresh lecturers list"
          >
            <FaSyncAlt className={loading ? "fa-spin" : ""} />
            {loading ? "Refreshing..." : "Refresh"}
          </button>

          <button
            type="button"
            className="add-user-button"
            style={{ background: "#10b981" }}
            onClick={() => navigate("/admin/lecturers/add")}
          >
            <FaFileExcel />
            Bulk Upload
          </button>

          <button
            type="button"
            className="add-user-button"
            onClick={() => navigate("/admin/lecturers/add")}
          >
            <FaUserPlus />
            Add Lecturer
          </button>
        </div>
      </div>

      {/* Statistics */}
      <div className="lecturer-summary">
        <div className="lecturer-summary-card">
          <span>Total Lecturers</span>
          <strong>{lecturers.length}</strong>
        </div>

        <div className="lecturer-summary-card pending">
          <span>Pending Approval</span>
          <strong>{pendingCount}</strong>
        </div>

        <div className="lecturer-summary-card">
          <span>Active</span>
          <strong>
            {
              lecturers.filter(
                (item) => item.status === "active"
              ).length
            }
          </strong>
        </div>
      </div>

      {/* Search */}
      <div className="lecturers-toolbar">
        <div className="lecturer-search">
          <FaSearch />
          <input
            type="text"
            placeholder="Search lecturer by name, email or department..."
            value={search}
            onChange={(e) =>
              setSearch(e.target.value)
            }
          />
        </div>

        <span>
          {filteredLecturers.length} lecturer
          {filteredLecturers.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      <div className="lecturers-table-container">
        {loading ? (
          <div className="lecturer-empty">
            Loading lecturers...
          </div>
        ) : filteredLecturers.length === 0 ? (
          <div className="lecturer-empty">
            <FaUserPlus />
            <h3>No lecturers found</h3>
            <p>
              Authorize faculty members individually or bulk upload via Excel / CSV.
            </p>
            <div style={{ display: "flex", gap: "10px", marginTop: "14px", justifyContent: "center" }}>
              <button
                type="button"
                className="add-user-button"
                style={{ background: "#10b981" }}
                onClick={() => navigate("/admin/lecturers/add")}
              >
                <FaFileExcel />
                Bulk Upload
              </button>

              <button
                type="button"
                className="add-user-button"
                onClick={() => navigate("/admin/lecturers/add")}
              >
                <FaUserPlus />
                Add Lecturer
              </button>
            </div>
          </div>
        ) : (
          <table className="lecturers-table">
            <thead>
              <tr>
                <th className="sortable-th" onClick={() => requestSort("name")} title="Click to sort by Lecturer Name">
                  Lecturer <SortIcon sortConfig={sortConfig} columnKey="name" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("department")} title="Click to sort by Department">
                  Department <SortIcon sortConfig={sortConfig} columnKey="department" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("classesConducted")} title="Click to sort by Classes Conducted">
                  Classes Conducted <SortIcon sortConfig={sortConfig} columnKey="classesConducted" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("approved")} title="Click to sort by Approval">
                  Approval <SortIcon sortConfig={sortConfig} columnKey="approved" />
                </th>
                <th className="sortable-th" onClick={() => requestSort("status")} title="Click to sort by Status">
                  Status <SortIcon sortConfig={sortConfig} columnKey="status" />
                </th>
                <th>Actions</th>
              </tr>
            </thead>

            <tbody>
              {sortedLecturers.map((lecturer) => (
                <tr
                  key={lecturer.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelectedLecturer(lecturer)}
                  title="Click to view lecturer activity & classes conducted"
                >
                  <td>
                    <div className="lecturer-info">
                      {lecturer.photoURL ? (
                        <img
                          src={lecturer.photoURL}
                          alt=""
                        />
                      ) : (
                        <div className="lecturer-avatar">
                          {lecturer.name
                            ?.charAt(0)
                            .toUpperCase() || "L"}
                        </div>
                      )}

                      <div>
                        <strong>
                          {lecturer.name || "Unnamed Lecturer"}
                        </strong>

                        <span>
                          {lecturer.email || "No email"}
                        </span>
                      </div>
                    </div>
                  </td>

                  <td>
                    {lecturer.department || "-"}
                  </td>

                  <td>
                    <span className="classes-conducted-badge">
                      <strong>{lecturer.classesConducted || 0}</strong> {lecturer.classesConducted === 1 ? "class" : "classes"}
                    </span>
                  </td>

                  <td>
                    {lecturer.approved === true ? (
                      <span className="approved-badge">
                        <FaCheckCircle />
                        Approved
                      </span>
                    ) : (
                      <span className="pending-badge">
                        <FaTimesCircle />
                        Pending
                      </span>
                    )}
                  </td>

                  <td>
                    <span
                      className={
                        lecturer.status === "active"
                          ? "lecturer-active"
                          : "lecturer-disabled"
                      }
                    >
                      {lecturer.status || "active"}
                    </span>
                  </td>

                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="lecturer-actions">
                      <button
                        type="button"
                        title="View lecturer teaching activity & classes"
                        onClick={() => setSelectedLecturer(lecturer)}
                      >
                        <FaEye />
                      </button>

                      {lecturer.approved !== true ? (
                        <button
                          type="button"
                          className="approve-button"
                          disabled={
                            updating === lecturer.id
                          }
                          onClick={() =>
                            approveLecturer(lecturer)
                          }
                          title="Approve lecturer"
                        >
                          <FaCheckCircle />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="reject-button"
                          disabled={
                            updating === lecturer.id
                          }
                          onClick={() =>
                            rejectLecturer(lecturer)
                          }
                          title="Remove approval"
                        >
                          <FaTimesCircle />
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={
                          updating === lecturer.id
                        }
                        onClick={() =>
                          toggleStatus(lecturer)
                        }
                        title={
                          lecturer.status === "active"
                            ? "Disable lecturer"
                            : "Enable lecturer"
                        }
                      >
                        {lecturer.status === "active"
                          ? <FaUserSlash />
                          : <FaUserCheck />}
                      </button>

                      <button
                        type="button"
                        className="delete-button"
                        style={{ color: "#ef4444" }}
                        disabled={
                          updating === lecturer.id
                        }
                        onClick={() =>
                          removeLecturer(lecturer)
                        }
                        title="Delete lecturer"
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