import React, { useEffect, useState } from "react";
import {
  FaTimes,
  FaUserTie,
  FaEnvelope,
  FaBuilding,
  FaBriefcase,
  FaPhone,
  FaDoorOpen,
  FaCheckCircle,
  FaTimesCircle,
  FaChalkboardTeacher,
  FaUsers,
  FaClock,
  FaFileDownload,
  FaHistory
} from "react-icons/fa";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../../firebase";
import { downloadExcel } from "../../DownloadExcel";
import { useTableSort, SortIcon } from "./useTableSort";
import { buildUserLookupMaps, normalizeSessions, doesSessionBelongToLecturer } from "./sessionMatcher";
import "./StudentDetailModal.css";

const LecturerDetailModal = ({ lecturer, onClose }) => {
  const [sessions, setSessions] = useState([]);
  const [attendancesCountMap, setAttendancesCountMap] = useState(new Map());
  const [totalAttendees, setTotalAttendees] = useState(0);
  const [loading, setLoading] = useState(true);

  const sessionRows = React.useMemo(() => {
    return sessions.map((sess) => ({
      ...sess,
      attendeeCount: attendancesCountMap.get(sess.id) || 0
    }));
  }, [sessions, attendancesCountMap]);

  const { sortedItems: sortedSessions, sortConfig, requestSort } = useTableSort(sessionRows, "createdAt", "desc");

  useEffect(() => {
    if (!lecturer) {
      setLoading(false);
      return;
    }

    const fetchLecturerActivity = async () => {
      try {
        setLoading(true);

        // Fetch all attendance sessions, records, and user maps
        const [sessionsSnap, recordsSnap, usersSnap, authUsersSnap] = await Promise.all([
          getDocs(collection(db, "attendance_sessions")).catch((e) => {
            console.warn("Could not read attendance_sessions:", e);
            return { docs: [] };
          }),
          getDocs(collection(db, "attendance_records")).catch((e) => {
            console.warn("Could not read attendance_records:", e);
            return { docs: [] };
          }),
          getDocs(collection(db, "users")).catch(() => ({ docs: [] })),
          getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] }))
        ]);

        const lookupMaps = buildUserLookupMaps(
          usersSnap.docs,
          authUsersSnap.docs,
          recordsSnap.docs,
          sessionsSnap.docs
        );

        // Count attendees per session
        const countMap = new Map();
        let totalCount = 0;

        recordsSnap.docs.forEach((docSnap) => {
          const data = docSnap.data();
          const sid = data.sessionId;
          if (sid) {
            countMap.set(sid, (countMap.get(sid) || 0) + 1);
          }
        });

        // Comprehensive session list
        const sessionsList = normalizeSessions(sessionsSnap.docs, recordsSnap.docs, lookupMaps);

        // Count total lecturers to handle sole lecturer fallback
        const facultyCount = authUsersSnap.docs.filter((d) => {
          const r = String(d.data().role || "").toLowerCase();
          return r === "lecturer" || r === "faculty";
        }).length || 1;

        // Filter sessions that belong to this lecturer
        const lecturerSessions = sessionsList.filter((sess) =>
          doesSessionBelongToLecturer(sess, lecturer, lookupMaps, facultyCount)
        );

        // Calculate total attendees for this lecturer's sessions
        lecturerSessions.forEach((sess) => {
          totalCount += countMap.get(sess.id) || 0;
        });

        // Sort descending by creation date
        lecturerSessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        setSessions(lecturerSessions);
        setAttendancesCountMap(countMap);
        setTotalAttendees(totalCount);

      } catch (err) {
        console.error("Error fetching lecturer activity details:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchLecturerActivity();
  }, [lecturer]);

  if (!lecturer) return null;

  const totalClasses = sessions.length;
  const activeClasses = sessions.filter((s) => s.active === true && (s.expiresAt || 0) > Date.now()).length;
  const uniqueCourses = new Set(sessions.map((s) => s.courseCode || s.classCode).filter(Boolean)).size;

  const handleExportReport = () => {
    const exportData = sessions.map((sess) => ({
      "Lecturer Name": lecturer.name || "N/A",
      "Email": lecturer.email || "N/A",
      "Course Code": sess.courseCode || "N/A",
      "Class Code": sess.classCode || "N/A",
      "Room": sess.roomNo || "N/A",
      "Date Created": sess.createdAt ? new Date(sess.createdAt).toLocaleString() : "N/A",
      "Attendees Count": attendancesCountMap.get(sess.id) || 0,
      "Status": sess.active && (sess.expiresAt || 0) > Date.now() ? "Active (Live)" : "Closed"
    }));

    downloadExcel(
      exportData,
      `${lecturer.name || "Lecturer"}_Teaching_Report_${new Date().toISOString().slice(0, 10)}`
    );
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="student-modal-container" onClick={(e) => e.stopPropagation()}>
        {/* Close Button */}
        <button className="modal-close-btn" onClick={onClose} aria-label="Close modal">
          <FaTimes />
        </button>

        {/* Header Profile Section */}
        <div className="modal-profile-header">
          <div className="modal-avatar-wrapper lecturer-avatar-theme">
            {lecturer.photoURL ? (
              <img
                src={lecturer.photoURL}
                alt={lecturer.name}
                className="modal-avatar-img"
              />
            ) : (
              <div className="modal-avatar-placeholder lecturer">
                <FaUserTie />
              </div>
            )}
          </div>

          <div className="modal-header-meta">
            <h2>{lecturer.name || "Unnamed Lecturer"}</h2>
            <div className="modal-badges-row">
              <span className="badge-roll">
                <FaBriefcase /> {lecturer.designation || "Lecturer"}
              </span>
              <span className={`badge-status ${lecturer.status === "active" ? "active" : "disabled"}`}>
                {lecturer.status === "active" ? "Active Faculty" : "Disabled"}
              </span>
              <span className="badge-branch">
                {lecturer.department || "Computer Science & Engineering"}
              </span>
              {lecturer.approved === true ? (
                <span className="approved-badge-pill">
                  <FaCheckCircle /> Approved
                </span>
              ) : (
                <span className="pending-badge-pill">
                  <FaTimesCircle /> Pending Approval
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Teaching Activity Stats */}
        <div className="modal-stats-grid">
          <div className="stat-box">
            <div className="stat-icon-wrap indigo">
              <FaChalkboardTeacher />
            </div>
            <div>
              <span className="stat-label">Classes Conducted</span>
              <strong className="stat-value">{totalClasses}</strong>
            </div>
          </div>

          <div className="stat-box">
            <div className="stat-icon-wrap green">
              <FaUsers />
            </div>
            <div>
              <span className="stat-label">Total Attendees Recorded</span>
              <strong className="stat-value">{totalAttendees}</strong>
            </div>
          </div>

          <div className="stat-box">
            <div className="stat-icon-wrap blue">
              <FaClock />
            </div>
            <div>
              <span className="stat-label">Unique Courses</span>
              <strong className="stat-value">{uniqueCourses}</strong>
            </div>
          </div>
        </div>

        {/* Two-Column Info: Faculty Info & Session Records */}
        <div className="modal-content-grid">
          {/* Left Column: Faculty Details */}
          <div className="info-card">
            <h3>
              <FaUserTie /> Faculty Information
            </h3>
            <div className="info-rows">
              <div className="info-row">
                <FaEnvelope className="info-icon" />
                <div>
                  <label>Email (Google Account)</label>
                  <span>{lecturer.email || "Not provided"}</span>
                </div>
              </div>

              <div className="info-row">
                <FaBuilding className="info-icon" />
                <div>
                  <label>Department / Branch</label>
                  <span>{lecturer.department || "General"}</span>
                </div>
              </div>

              <div className="info-row">
                <FaBriefcase className="info-icon" />
                <div>
                  <label>Designation</label>
                  <span>{lecturer.designation || "Assistant Professor"}</span>
                </div>
              </div>

              <div className="info-row">
                <FaDoorOpen className="info-icon" />
                <div>
                  <label>Cabin / Office Room</label>
                  <span>{lecturer.cabin || "Not specified"}</span>
                </div>
              </div>

              <div className="info-row">
                <FaPhone className="info-icon" />
                <div>
                  <label>Phone Number</label>
                  <span>{lecturer.phone || "Not provided"}</span>
                </div>
              </div>

              <div className="info-row">
                {lecturer.approved === true ? (
                  <FaCheckCircle className="info-icon success" />
                ) : (
                  <FaTimesCircle className="info-icon warning" />
                )}
                <div>
                  <label>Authorization Status</label>
                  <span>{lecturer.approved === true ? "Approved by Admin ✅" : "Pending Approval ⏳"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Conducted Classes & Sessions History */}
          <div className="info-card">
            <div className="card-header-flex">
              <h3>
                <FaHistory /> Recorded Classes ({totalClasses})
              </h3>
              {sessions.length > 0 && (
                <button
                  type="button"
                  className="mini-export-btn"
                  onClick={handleExportReport}
                  title="Export Teaching Report"
                >
                  <FaFileDownload /> Export
                </button>
              )}
            </div>

            {loading ? (
              <div className="history-loading">Loading session records...</div>
            ) : sessions.length === 0 ? (
              <div className="history-empty">
                <FaHistory className="empty-icon" />
                <p>No attendance classes recorded by this lecturer yet.</p>
              </div>
            ) : (
              <div className="history-table-container">
                <table className="modal-history-table">
                  <thead>
                    <tr>
                      <th className="sortable-th" onClick={() => requestSort("courseCode")} title="Click to sort by Course / Class">
                        Course / Class <SortIcon sortConfig={sortConfig} columnKey="courseCode" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("roomNo")} title="Click to sort by Room">
                        Room <SortIcon sortConfig={sortConfig} columnKey="roomNo" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("attendeeCount")} title="Click to sort by Attendees">
                        Attendees <SortIcon sortConfig={sortConfig} columnKey="attendeeCount" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("createdAt")} title="Click to sort by Date">
                        Date <SortIcon sortConfig={sortConfig} columnKey="createdAt" />
                      </th>
                      <th className="sortable-th" onClick={() => requestSort("active")} title="Click to sort by Status">
                        Status <SortIcon sortConfig={sortConfig} columnKey="active" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSessions.map((sess) => {
                      const count = attendancesCountMap.get(sess.id) || 0;
                      const isLive = sess.active && (sess.expiresAt || 0) > Date.now();

                      return (
                        <tr key={sess.id}>
                          <td>
                            <strong>{sess.courseCode || sess.classCode || "Class Session"}</strong>
                            {sess.classCode && sess.courseCode && (
                              <small className="sub-text"> ({sess.classCode})</small>
                            )}
                          </td>
                          <td>{sess.roomNo || "N/A"}</td>
                          <td>
                            <span className="attendee-count-pill">
                              <FaUsers /> {count} present
                            </span>
                          </td>
                          <td>
                            {sess.createdAt ? (
                              <span>{new Date(sess.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                            ) : (
                              "N/A"
                            )}
                          </td>
                          <td>
                            {isLive ? (
                              <span className="live-badge">🔴 Live</span>
                            ) : (
                              <span className="closed-badge">Closed</span>
                            )}
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
      </div>
    </div>
  );
};

export default LecturerDetailModal;
