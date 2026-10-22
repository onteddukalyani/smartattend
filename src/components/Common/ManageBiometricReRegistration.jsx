import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
    FaArrowLeft,
    FaShieldAlt,
    FaKey,
    FaCamera,
    FaFingerprint,
    FaUserGraduate,
    FaCheckCircle,
    FaTimesCircle,
    FaSpinner,
    FaSearch,
    FaFilter,
    FaSyncAlt,
    FaExclamationTriangle,
    FaBookOpen,
    FaClock,
    FaTrashAlt,
    FaInfoCircle,
    FaBan,
    FaBuilding,
    FaUserCheck,
    FaHistory
} from "react-icons/fa";
import { collection, getDocs, doc, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../authcontext";
import {
    grantBiometricReRegistration,
    revokeBiometricReRegistration,
    listBiometricReRegistrationPermissions
} from "../../services/faceEnrollmentService";
import "./ManageBiometricReRegistration.css";

export default function ManageBiometricReRegistration() {
    const navigate = useNavigate();
    const location = useLocation();
    const { user, profile } = useAuth();

    const userRole = String(profile?.role || "").trim().toLowerCase();
    const isAdmin = userRole === "admin" || userRole === "administrator" || Boolean(profile?.isAdmin) || window.location.pathname.startsWith("/admin");
    const isLecturer = userRole === "lecturer" || Boolean(profile?.isLecturer);
    const basePath = isAdmin ? "/admin" : "/lecturer";

    // Form State
    const [targetType, setTargetType] = useState("single"); // "single" | "multi" | "course" | "institution"
    const [singleRoll, setSingleRoll] = useState("");
    const [multiRollsInput, setMultiRollsInput] = useState("");
    const [selectedCourseId, setSelectedCourseId] = useState("");
    const [regType, setRegType] = useState("both"); // "face" | "biometric" | "both"
    const [permMode, setPermMode] = useState("one_time"); // "one_time" | "repeated"
    const [expiryHours, setExpiryHours] = useState("72"); // "24", "48", "72", "168", "0" (never)
    const [reason, setReason] = useState("");

    useEffect(() => {
        const params = new URLSearchParams(location.search);
        const rollParam = params.get("roll");
        if (rollParam) {
            setSingleRoll(rollParam.trim().toUpperCase());
            setTargetType("single");
        }
    }, [location.search]);

    // Data State
    const [permissions, setPermissions] = useState([]);
    const [courses, setCourses] = useState([]);
    const [students, setStudents] = useState([]);
    const [loadingPerms, setLoadingPerms] = useState(true);
    const [granting, setGranting] = useState(false);
    const [revokingId, setRevokingId] = useState(null);
    const [formMsg, setFormMsg] = useState(null); // { type: "success" | "error", text: string }
    const [searchTerm, setSearchTerm] = useState("");
    const [statusFilter, setStatusFilter] = useState("ALL"); // "ALL" | "active" | "exhausted" | "revoked" | "expired"

    // Load Authorized Courses for Lecturer / Admin
    useEffect(() => {
        let isMounted = true;
        const fetchCoursesAndStudents = async () => {
            try {
                const coursesSnap = await getDocs(collection(db, "courses")).catch(() => ({ docs: [] }));
                const allCourses = coursesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

                let userCourses = allCourses;
                if (!isAdmin && isLecturer) {
                    const myUid = user?.uid;
                    const myEmail = String(user?.email || profile?.email || "").trim().toLowerCase();
                    userCourses = allCourses.filter((c) => {
                        const lectUid = c.lecturerUid || c.facultyUid || c.createdBy;
                        const lectEmail = String(c.lecturerEmail || c.facultyEmail || "").trim().toLowerCase();
                        return lectUid === myUid || lectEmail === myEmail;
                    });
                }

                if (isMounted) {
                    setCourses(userCourses);
                    if (userCourses.length > 0 && !selectedCourseId) {
                        setSelectedCourseId(userCourses[0].id);
                    }
                }

                // Load students for autocomplete/validation preview
                const studentsSnap = await getDocs(collection(db, "students")).catch(() => ({ docs: [] }));
                if (isMounted) {
                    setStudents(studentsSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
                }
            } catch (err) {
                console.warn("Course/student fetch notice:", err);
            }
        };

        fetchCoursesAndStudents();
        return () => { isMounted = false; };
    }, [isAdmin, isLecturer, user?.uid, profile?.email]);

    // Live Snapshot of Permissions
    useEffect(() => {
        let isMounted = true;
        setLoadingPerms(true);

        const permsRef = collection(db, "biometric_reregistration_permissions");
        const unsub = onSnapshot(permsRef, (snapshot) => {
            if (!isMounted) return;
            const items = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
            // Filter by authorized scope if lecturer
            if (!isAdmin && isLecturer) {
                const myUid = user?.uid;
                const myEmail = String(user?.email || profile?.email || "").trim().toLowerCase();
                const filtered = items.filter((p) => {
                    return p.grantedByUid === myUid || String(p.grantedByEmail || "").trim().toLowerCase() === myEmail;
                });
                setPermissions(filtered);
            } else {
                setPermissions(items);
            }
            setLoadingPerms(false);
        }, (err) => {
            console.warn("Permissions snapshot error, falling back to callable:", err);
            listBiometricReRegistrationPermissions()
                .then((list) => {
                    if (isMounted) {
                        setPermissions(list || []);
                        setLoadingPerms(false);
                    }
                })
                .catch(() => {
                    if (isMounted) setLoadingPerms(false);
                });
        });

        return () => {
            isMounted = false;
            unsub();
        };
    }, [isAdmin, isLecturer, user?.uid, profile?.email]);

    // Handle Grant Permission Submission
    const handleGrantPermission = async (e) => {
        e.preventDefault();
        setFormMsg(null);
        setGranting(true);

        try {
            let targetRolls = [];
            if (targetType === "single") {
                const cleaned = singleRoll.trim().toUpperCase();
                if (!cleaned) throw new Error("Please enter a valid student Roll Number.");
                targetRolls = [cleaned];
            } else if (targetType === "multi") {
                const parsed = multiRollsInput
                    .split(/[\n,;\s]+/)
                    .map((r) => r.trim().toUpperCase())
                    .filter(Boolean);
                if (parsed.length === 0) throw new Error("Please enter at least one valid Roll Number.");
                targetRolls = Array.from(new Set(parsed));
            } else if (targetType === "course") {
                if (!selectedCourseId) throw new Error("Please select an authorized course.");
            } else if (targetType === "institution") {
                if (!isAdmin) throw new Error("Only Administrators can issue institution-wide permissions.");
            }

            const expVal = parseInt(expiryHours, 10);
            const payload = {
                targetType,
                targetRolls,
                courseId: targetType === "course" ? selectedCourseId : undefined,
                registrationType: regType,
                mode: permMode,
                expiryHours: expVal > 0 ? expVal : undefined,
                reason: reason.trim() || undefined
            };

            const result = await grantBiometricReRegistration(payload);
            setFormMsg({
                type: "success",
                text: `✅ Success! ${result.message || `Re-registration access granted for ${result.count || targetRolls.length} student(s).`}`
            });

            // Reset target inputs
            if (targetType === "single") setSingleRoll("");
            if (targetType === "multi") setMultiRollsInput("");
            setReason("");
        } catch (err) {
            console.error("Grant error:", err);
            setFormMsg({
                type: "error",
                text: `❌ Error: ${err.message || "Failed to grant re-registration access."}`
            });
        } finally {
            setGranting(false);
        }
    };

    // Handle Revoke Permission
    const handleRevoke = async (permId) => {
        if (!window.confirm("Are you sure you want to revoke this student's re-registration permission?")) {
            return;
        }

        try {
            setRevokingId(permId);
            await revokeBiometricReRegistration(permId, "Revoked by authorized faculty");
            setFormMsg({
                type: "success",
                text: "✅ Permission revoked successfully."
            });
        } catch (err) {
            alert("Failed to revoke permission: " + err.message);
        } finally {
            setRevokingId(null);
        }
    };

    // Filtered permissions list
    const filteredPermissions = useMemo(() => {
        return permissions.filter((p) => {
            const matchesSearch = !searchTerm || (
                (p.rollNo && p.rollNo.toUpperCase().includes(searchTerm.toUpperCase())) ||
                (p.studentName && p.studentName.toUpperCase().includes(searchTerm.toUpperCase())) ||
                (p.grantedByName && p.grantedByName.toUpperCase().includes(searchTerm.toUpperCase()))
            );

            let statusMatch = true;
            if (statusFilter === "active") {
                statusMatch = p.status === "active" && (!p.expiresAt || p.expiresAt > Date.now()) && (p.remainingUses === undefined || p.remainingUses > 0);
            } else if (statusFilter === "exhausted") {
                statusMatch = p.status === "exhausted" || p.remainingUses === 0;
            } else if (statusFilter === "revoked") {
                statusMatch = p.status === "revoked";
            } else if (statusFilter === "expired") {
                statusMatch = p.status === "expired" || (p.expiresAt && p.expiresAt <= Date.now());
            }

            return matchesSearch && statusMatch;
        });
    }, [permissions, searchTerm, statusFilter]);

    return (
        <div className="manage-rereg-page">
            {/* Top Navigation Bar */}
            <div className="manage-rereg-top-bar">
                <button
                    type="button"
                    className="back-btn"
                    onClick={() => navigate(basePath)}
                >
                    <FaArrowLeft /> Dashboard
                </button>
                <div className="top-scope-badge">
                    <FaShieldAlt />
                    <span>
                        {isAdmin ? "Admin Institution-Wide Scope" : "Lecturer Course Scope"}
                    </span>
                </div>
            </div>

            {/* Page Header */}
            <div className="manage-rereg-header">
                <div className="header-icon-wrap">
                    <FaKey />
                </div>
                <div>
                    <h1>Manage Biometric Re-Registration Access</h1>
                    <p>
                        Authorized portal for Lecturers &amp; Admins to grant and revoke secure student re-registration permissions for Face Biometrics and Device Fingerprints.
                    </p>
                </div>
            </div>

            {/* Grant Permission Form Card */}
            <div className="rereg-card grant-card">
                <div className="rereg-card-header">
                    <h2><FaKey className="text-accent" /> Grant Re-Registration Access</h2>
                    <span className="card-subtitle">
                        Configure authorized target, registration operation, mode, and usage constraints
                    </span>
                </div>

                <form onSubmit={handleGrantPermission} className="grant-form">
                    {/* Target Scope Selection */}
                    <div className="form-group">
                        <label className="form-label">
                            <FaUserGraduate /> 1. Select Target Scope:
                        </label>
                        <div className="pill-selector">
                            <button
                                type="button"
                                className={`pill-btn ${targetType === "single" ? "active" : ""}`}
                                onClick={() => setTargetType("single")}
                            >
                                <FaUserGraduate /> Single Student
                            </button>
                            <button
                                type="button"
                                className={`pill-btn ${targetType === "multi" ? "active" : ""}`}
                                onClick={() => setTargetType("multi")}
                            >
                                <FaUserCheck /> Multiple Students
                            </button>
                            <button
                                type="button"
                                className={`pill-btn ${targetType === "course" ? "active" : ""}`}
                                onClick={() => setTargetType("course")}
                            >
                                <FaBookOpen /> Course / Section
                            </button>
                            {isAdmin && (
                                <button
                                    type="button"
                                    className={`pill-btn admin-pill ${targetType === "institution" ? "active" : ""}`}
                                    onClick={() => setTargetType("institution")}
                                >
                                    <FaBuilding /> Institution-Wide
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Scope-Specific Target Inputs */}
                    {targetType === "single" && (
                        <div className="form-group target-input-group">
                            <label className="form-sublabel">Student Roll Number:</label>
                            <input
                                type="text"
                                placeholder="e.g. 23BCS045"
                                value={singleRoll}
                                onChange={(e) => setSingleRoll(e.target.value.toUpperCase())}
                                className="rereg-input"
                                required
                            />
                            <span className="input-hint">Enter the student's institutional roll number</span>
                        </div>
                    )}

                    {targetType === "multi" && (
                        <div className="form-group target-input-group">
                            <label className="form-sublabel">Student Roll Numbers (Comma or Line Separated):</label>
                            <textarea
                                rows={3}
                                placeholder="23BCS001, 23BCS002&#10;23BCS015&#10;23BCS044"
                                value={multiRollsInput}
                                onChange={(e) => setMultiRollsInput(e.target.value.toUpperCase())}
                                className="rereg-textarea"
                                required
                            />
                            <span className="input-hint">Paste multiple roll numbers to issue bulk re-registration passes</span>
                        </div>
                    )}

                    {targetType === "course" && (
                        <div className="form-group target-input-group">
                            <label className="form-sublabel">Select Authorized Course / Section:</label>
                            {courses.length === 0 ? (
                                <div className="no-courses-warning">
                                    <FaExclamationTriangle /> No courses assigned or found under your account.
                                </div>
                            ) : (
                                <select
                                    value={selectedCourseId}
                                    onChange={(e) => setSelectedCourseId(e.target.value)}
                                    className="rereg-select"
                                    required
                                >
                                    {courses.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.code ? `${c.code} — ` : ""}{c.name || c.title || c.id} {c.section ? `(Sec ${c.section})` : ""}
                                        </option>
                                    ))}
                                </select>
                            )}
                            <span className="input-hint">Grants re-registration access to all students enrolled in this course</span>
                        </div>
                    )}

                    {targetType === "institution" && (
                        <div className="institution-scope-notice">
                            <FaBuilding className="inst-icon" />
                            <div>
                                <strong>Institution-Wide Student Access (Admin Privilege)</strong>
                                <p>This will authorize all registered active students across all courses to re-register according to the settings below.</p>
                            </div>
                        </div>
                    )}

                    <div className="form-row-grid">
                        {/* Registration Type Selector */}
                        <div className="form-group">
                            <label className="form-label">
                                <FaShieldAlt /> 2. Permitted Registration Type:
                            </label>
                            <div className="radio-cards-grid">
                                <label className={`radio-card ${regType === "face" ? "selected" : ""}`}>
                                    <input
                                        type="radio"
                                        name="regType"
                                        value="face"
                                        checked={regType === "face"}
                                        onChange={() => setRegType("face")}
                                    />
                                    <div className="radio-card-content">
                                        <FaCamera className="card-type-icon text-indigo" />
                                        <strong>Face Only</strong>
                                        <span>Re-record 3D facial vector</span>
                                    </div>
                                </label>

                                <label className={`radio-card ${regType === "biometric" ? "selected" : ""}`}>
                                    <input
                                        type="radio"
                                        name="regType"
                                        value="biometric"
                                        checked={regType === "biometric"}
                                        onChange={() => setRegType("biometric")}
                                    />
                                    <div className="radio-card-content">
                                        <FaFingerprint className="card-type-icon text-emerald" />
                                        <strong>Fingerprint Only</strong>
                                        <span>Re-bind phone keystore sensor</span>
                                    </div>
                                </label>

                                <label className={`radio-card ${regType === "both" ? "selected" : ""}`}>
                                    <input
                                        type="radio"
                                        name="regType"
                                        value="both"
                                        checked={regType === "both"}
                                        onChange={() => setRegType("both")}
                                    />
                                    <div className="radio-card-content">
                                        <FaShieldAlt className="card-type-icon text-purple" />
                                        <strong>Both (Complete)</strong>
                                        <span>Face + Device Fingerprint</span>
                                    </div>
                                </label>
                            </div>
                        </div>

                        {/* Permission Mode Selector */}
                        <div className="form-group">
                            <label className="form-label">
                                <FaClock /> 3. Permission Mode:
                            </label>
                            <div className="radio-cards-grid mode-grid">
                                <label className={`radio-card ${permMode === "one_time" ? "selected" : ""}`}>
                                    <input
                                        type="radio"
                                        name="permMode"
                                        value="one_time"
                                        checked={permMode === "one_time"}
                                        onChange={() => setPermMode("one_time")}
                                    />
                                    <div className="radio-card-content">
                                        <strong className="text-accent">Mode A: One-Time Pass</strong>
                                        <span>Single successful re-registration. Automatically consumed upon completion.</span>
                                    </div>
                                </label>

                                <label className={`radio-card ${permMode === "repeated" ? "selected" : ""}`}>
                                    <input
                                        type="radio"
                                        name="permMode"
                                        value="repeated"
                                        checked={permMode === "repeated"}
                                        onChange={() => setPermMode("repeated")}
                                    />
                                    <div className="radio-card-content">
                                        <strong className="text-emerald">Mode B: Repeated Access</strong>
                                        <span>Unlimited re-registrations until explicitly revoked or expired.</span>
                                    </div>
                                </label>
                            </div>
                        </div>
                    </div>

                    <div className="form-row-grid">
                        {/* Expiry Hours Selector */}
                        <div className="form-group">
                            <label className="form-label">
                                <FaClock /> 4. Access Expiration:
                            </label>
                            <select
                                value={expiryHours}
                                onChange={(e) => setExpiryHours(e.target.value)}
                                className="rereg-select"
                            >
                                <option value="24">Expires in 24 Hours</option>
                                <option value="48">Expires in 48 Hours</option>
                                <option value="72">Expires in 72 Hours (3 Days)</option>
                                <option value="168">Expires in 7 Days</option>
                                <option value="0">No Expiration (Until Revoked)</option>
                            </select>
                        </div>

                        {/* Audit Reason */}
                        <div className="form-group">
                            <label className="form-label">
                                <FaInfoCircle /> 5. Reason / Audit Note:
                            </label>
                            <input
                                type="text"
                                placeholder="e.g. Student changed phone; facial scan degraded"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                className="rereg-input"
                            />
                        </div>
                    </div>

                    {/* Status Feedback Message */}
                    {formMsg && (
                        <div className={`form-feedback-banner ${formMsg.type}`}>
                            {formMsg.type === "success" ? <FaCheckCircle /> : <FaTimesCircle />}
                            <span>{formMsg.text}</span>
                        </div>
                    )}

                    {/* Submit Button */}
                    <div className="form-submit-row">
                        <button
                            type="submit"
                            disabled={granting}
                            className="grant-submit-btn"
                        >
                            {granting ? (
                                <><FaSpinner className="fa-spin" /> Granting Re-Registration Access...</>
                            ) : (
                                <><FaKey /> Issue Re-Registration Pass</>
                            )}
                        </button>
                    </div>
                </form>
            </div>

            {/* Permissions Registry Card */}
            <div className="rereg-card registry-card">
                <div className="rereg-card-header registry-header">
                    <div>
                        <h2><FaHistory className="text-accent" /> Active &amp; Historical Permissions</h2>
                        <span className="card-subtitle">
                            Authoritative registry of biometric re-registration permissions within your authorized scope
                        </span>
                    </div>

                    <div className="registry-actions">
                        <button
                            type="button"
                            className="reload-btn"
                            onClick={() => window.location.reload()}
                            title="Refresh registry"
                        >
                            <FaSyncAlt /> Refresh
                        </button>
                    </div>
                </div>

                {/* Toolbar Filter & Search */}
                <div className="registry-toolbar">
                    <div className="search-box">
                        <FaSearch className="search-icon" />
                        <input
                            type="text"
                            placeholder="Search by Roll No, Student Name, or Grantor..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="search-input"
                        />
                    </div>

                    <div className="status-filter-pills">
                        <button
                            type="button"
                            className={`filter-pill ${statusFilter === "ALL" ? "active" : ""}`}
                            onClick={() => setStatusFilter("ALL")}
                        >
                            All ({permissions.length})
                        </button>
                        <button
                            type="button"
                            className={`filter-pill active-pill ${statusFilter === "active" ? "active" : ""}`}
                            onClick={() => setStatusFilter("active")}
                        >
                            Active ({permissions.filter((p) => p.status === "active" && (!p.expiresAt || p.expiresAt > Date.now()) && (p.remainingUses === undefined || p.remainingUses > 0)).length})
                        </button>
                        <button
                            type="button"
                            className={`filter-pill ${statusFilter === "exhausted" ? "active" : ""}`}
                            onClick={() => setStatusFilter("exhausted")}
                        >
                            Consumed
                        </button>
                        <button
                            type="button"
                            className={`filter-pill ${statusFilter === "revoked" ? "active" : ""}`}
                            onClick={() => setStatusFilter("revoked")}
                        >
                            Revoked
                        </button>
                    </div>
                </div>

                {/* Permissions List / Table */}
                {loadingPerms ? (
                    <div className="registry-loading">
                        <FaSpinner className="fa-spin" />
                        <span>Loading permission records from database...</span>
                    </div>
                ) : filteredPermissions.length === 0 ? (
                    <div className="registry-empty">
                        <FaKey className="empty-icon" />
                        <h3>No Re-Registration Permissions Found</h3>
                        <p>There are no active or historical permissions matching your current filter.</p>
                    </div>
                ) : (
                    <div className="table-responsive">
                        <table className="permissions-table">
                            <thead>
                                <tr>
                                    <th>Student</th>
                                    <th>Type</th>
                                    <th>Mode</th>
                                    <th>Granted By</th>
                                    <th>Granted At</th>
                                    <th>Remaining Uses</th>
                                    <th>Status</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredPermissions.map((perm) => {
                                    const isExpired = perm.expiresAt && perm.expiresAt <= Date.now();
                                    const isActive = perm.status === "active" && !isExpired && (perm.remainingUses === undefined || perm.remainingUses > 0);

                                    return (
                                        <tr key={perm.id || perm.rollNo} className={isActive ? "row-active" : "row-inactive"}>
                                            <td className="td-student">
                                                <strong>{perm.rollNo}</strong>
                                                {perm.studentName && <span className="student-subname">{perm.studentName}</span>}
                                            </td>
                                            <td>
                                                <span className={`type-badge type-${perm.registrationType || "both"}`}>
                                                    {perm.registrationType === "face" ? (
                                                        <><FaCamera /> Face</>
                                                    ) : perm.registrationType === "biometric" ? (
                                                        <><FaFingerprint /> Fingerprint</>
                                                    ) : (
                                                        <><FaShieldAlt /> Both</>
                                                    )}
                                                </span>
                                            </td>
                                            <td>
                                                <span className={`mode-badge mode-${perm.mode || "one_time"}`}>
                                                    {perm.mode === "one_time" ? "Mode A (1-Time)" : "Mode B (Repeated)"}
                                                </span>
                                            </td>
                                            <td className="td-grantor">
                                                <span>{perm.grantedByName || perm.grantedByEmail || "Staff"}</span>
                                                <span className="grantor-role">{perm.grantedByRole || "faculty"}</span>
                                            </td>
                                            <td className="td-date">
                                                {perm.grantedAt ? new Date(perm.grantedAt).toLocaleDateString() : "—"}
                                            </td>
                                            <td>
                                                <strong className={perm.remainingUses > 0 ? "text-emerald" : "text-muted"}>
                                                    {perm.mode === "repeated" ? "Unlimited" : (perm.remainingUses ?? 1)}
                                                </strong>
                                            </td>
                                            <td>
                                                {isActive ? (
                                                    <span className="status-pill status-active">
                                                        <FaCheckCircle /> Active
                                                    </span>
                                                ) : perm.status === "revoked" ? (
                                                    <span className="status-pill status-revoked">
                                                        <FaBan /> Revoked
                                                    </span>
                                                ) : isExpired ? (
                                                    <span className="status-pill status-expired">
                                                        <FaClock /> Expired
                                                    </span>
                                                ) : (
                                                    <span className="status-pill status-exhausted">
                                                        Consumed
                                                    </span>
                                                )}
                                            </td>
                                            <td>
                                                {isActive && (
                                                    <button
                                                        type="button"
                                                        className="revoke-btn"
                                                        onClick={() => handleRevoke(perm.id || perm.rollNo)}
                                                        disabled={revokingId === (perm.id || perm.rollNo)}
                                                        title="Revoke active permission"
                                                    >
                                                        {revokingId === (perm.id || perm.rollNo) ? (
                                                            <FaSpinner className="fa-spin" />
                                                        ) : (
                                                            <><FaBan /> Revoke</>
                                                        )}
                                                    </button>
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
    );
}
