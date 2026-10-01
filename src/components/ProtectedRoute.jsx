import React from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./authcontext";
import {
  FaShieldAlt,
  FaExclamationTriangle,
  FaUserTie,
  FaChalkboardTeacher,
  FaUserGraduate,
  FaArrowLeft,
  FaHome,
  FaSignOutAlt,
  FaLock
} from "react-icons/fa";

const roleIcons = {
  admin: <FaUserTie />,
  lecturer: <FaChalkboardTeacher />,
  student: <FaUserGraduate />
};

const roleLabels = {
  admin: "Administrator",
  lecturer: "Faculty / Lecturer",
  student: "Student"
};

const roleDashboards = {
  admin: "/admin",
  lecturer: "/lecturer",
  student: "/student"
};

const ProtectedRoute = ({ allowedRole, children }) => {
  const { user, profile, loading, logoutUser } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // 1. Loading state
  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-main, #f8fafc)",
          color: "var(--text-main, #0f172a)",
          gap: "14px",
          fontFamily: "system-ui, -apple-system, sans-serif"
        }}
      >
        <div
          style={{
            width: "42px",
            height: "42px",
            border: "3.5px solid #e2e8f0",
            borderTopColor: "#6366f1",
            borderRadius: "50%",
            animation: "spin 0.8s linear infinite"
          }}
        />
        <span style={{ fontSize: "0.95rem", fontWeight: 700, color: "#64748b" }}>
          Verifying security authorization...
        </span>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // 2. Not logged in
  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname }}
      />
    );
  }

  // 3. Logged in but profile doesn't exist
  if (!profile) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--page-bg, #f8fafc)",
          padding: "20px",
          fontFamily: "system-ui, -apple-system, sans-serif"
        }}
      >
        <div
          style={{
            background: "var(--surface, #ffffff)",
            padding: "36px 32px",
            borderRadius: "20px",
            maxWidth: "480px",
            width: "100%",
            textAlign: "center",
            boxShadow: "0 20px 40px var(--shadow, rgba(0,0,0,0.12))",
            border: "1px solid var(--border, #e2e8f0)"
          }}
        >
          <div
            style={{
              width: "56px",
              height: "56px",
              borderRadius: "16px",
              background: "rgba(239, 68, 68, 0.15)",
              color: "#ef4444",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "26px",
              marginBottom: "16px"
            }}
          >
            <FaExclamationTriangle />
          </div>
          <h2 style={{ margin: "0 0 8px", fontSize: "1.35rem", color: "var(--text-main, #0f172a)", fontWeight: 800 }}>
            Profile Record Not Found
          </h2>
          <p style={{ color: "var(--text-muted, #64748b)", fontSize: "0.9rem", lineHeight: 1.5, margin: "0 0 20px" }}>
            Your Google account (<strong>{user.email}</strong>) is logged in, but no authorized user profile was found in the database.
          </p>
          <button
            type="button"
            onClick={() => logoutUser()}
            style={{
              padding: "10px 20px",
              borderRadius: "12px",
              background: "var(--accent, #6366f1)",
              color: "#ffffff",
              border: "none",
              fontWeight: 700,
              cursor: "pointer",
              fontSize: "0.9rem"
            }}
          >
            Sign Out &amp; Return to Login
          </button>
        </div>
      </div>
    );
  }

  // 4. Role mismatch check
  const currentRole = String(profile.role || "").trim().toLowerCase();
  const allowed = Array.isArray(allowedRole)
    ? allowedRole.map((r) => r.toLowerCase())
    : [String(allowedRole || "").trim().toLowerCase()];

  const isRoleAllowed = allowed.includes(currentRole);

  if (!isRoleAllowed) {
    const requiredRoleName = allowed.map((r) => roleLabels[r] || r.toUpperCase()).join(" or ");
    const userRoleName = roleLabels[currentRole] || currentRole.toUpperCase();
    const myDashboardPath = roleDashboards[currentRole] || "/";

    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--page-bg, #f8fafc)",
          padding: "24px",
          fontFamily: "system-ui, -apple-system, sans-serif"
        }}
      >
        <div
          style={{
            background: "var(--surface, #ffffff)",
            padding: "40px 32px",
            borderRadius: "24px",
            maxWidth: "540px",
            width: "100%",
            textAlign: "center",
            boxShadow: "0 20px 45px var(--shadow, rgba(15, 23, 42, 0.15))",
            border: "1.5px solid var(--border, #e2e8f0)",
            animation: "fadeIn 0.25s ease-out"
          }}
        >
          {/* Top Warning Shield */}
          <div
            style={{
              width: "64px",
              height: "64px",
              borderRadius: "18px",
              background: "rgba(239, 68, 68, 0.15)",
              color: "#ef4444",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "28px",
              marginBottom: "16px",
              boxShadow: "0 4px 14px rgba(239, 68, 68, 0.2)"
            }}
          >
            <FaShieldAlt />
          </div>

          <h2 style={{ margin: "0 0 6px", fontSize: "1.45rem", color: "var(--text-main, #0f172a)", fontWeight: 800 }}>
            Access Restricted: Role Mismatch
          </h2>
          <p style={{ margin: "0 0 20px", color: "var(--text-muted, #64748b)", fontSize: "0.88rem" }}>
            You do not have permission to access this section with your current account role.
          </p>

          {/* Role Comparison Visual Card */}
          <div
            style={{
              background: "var(--surface-soft, rgba(100, 116, 139, 0.06))",
              border: "1.5px solid var(--border, #e2e8f0)",
              borderRadius: "16px",
              padding: "16px",
              marginBottom: "24px",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "12px",
              textAlign: "left"
            }}
          >
            <div style={{ background: "var(--surface, #ffffff)", padding: "12px", borderRadius: "12px", border: "1px solid var(--border, #e2e8f0)" }}>
              <span style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--text-muted, #64748b)", textTransform: "uppercase", display: "block", marginBottom: "4px" }}>
                Your Signed-In Role
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-main, #0f172a)", fontWeight: 800, fontSize: "0.95rem" }}>
                <span style={{ color: "var(--accent, #6366f1)", fontSize: "1.1rem" }}>{roleIcons[currentRole] || <FaUserTie />}</span>
                <span>{userRoleName}</span>
              </div>
            </div>

            <div style={{ background: "rgba(239, 68, 68, 0.12)", padding: "12px", borderRadius: "12px", border: "1px solid rgba(239, 68, 68, 0.3)" }}>
              <span style={{ fontSize: "0.74rem", fontWeight: 700, color: "#f87171", textTransform: "uppercase", display: "block", marginBottom: "4px" }}>
                Required Role
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#f87171", fontWeight: 800, fontSize: "0.95rem" }}>
                <span style={{ color: "#ef4444", fontSize: "1.1rem" }}><FaLock /></span>
                <span>{requiredRoleName}</span>
              </div>
            </div>
          </div>

          <div style={{ backgroundColor: "rgba(245, 158, 11, 0.12)", border: "1px solid rgba(245, 158, 11, 0.3)", borderRadius: "12px", padding: "12px 14px", marginBottom: "24px", textAlign: "left" }}>
            <p style={{ margin: 0, fontSize: "0.84rem", color: "var(--text-muted, #64748b)", lineHeight: 1.45 }}>
              Your account <strong style={{ color: "var(--text-main, #0f172a)" }}>{user.email}</strong> is registered as an <strong style={{ color: "var(--text-main, #0f172a)" }}>{userRoleName}</strong>. The page <code style={{ color: "var(--accent, #6366f1)" }}>{location.pathname}</code> is strictly reserved for <strong style={{ color: "var(--text-main, #0f172a)" }}>{requiredRoleName}</strong> accounts.
            </p>
          </div>

          {/* Action Buttons */}
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <button
              type="button"
              onClick={() => navigate(myDashboardPath, { replace: true })}
              style={{
                width: "100%",
                padding: "12px 20px",
                borderRadius: "12px",
                background: "linear-gradient(135deg, #4f46e5, #6366f1)",
                color: "#ffffff",
                border: "none",
                fontWeight: 750,
                cursor: "pointer",
                fontSize: "0.92rem",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                boxShadow: "0 4px 14px rgba(99, 102, 241, 0.3)",
                transition: "all 0.15s ease"
              }}
            >
              <FaHome /> Go to My {userRoleName} Dashboard
            </button>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <button
                type="button"
                onClick={() => navigate(-1)}
                style={{
                  padding: "10px 16px",
                  borderRadius: "12px",
                  background: "var(--surface, #ffffff)",
                  color: "var(--text-muted, #64748b)",
                  border: "1.5px solid var(--border, #cbd5e1)",
                  fontWeight: 700,
                  cursor: "pointer",
                  fontSize: "0.86rem",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "6px"
                }}
              >
                <FaArrowLeft /> Go Back
              </button>

              <button
                type="button"
                onClick={async () => {
                  await logoutUser();
                  navigate("/login", { replace: true });
                }}
                style={{
                  padding: "10px 16px",
                  borderRadius: "12px",
                  background: "var(--surface-soft, #f1f5f9)",
                  color: "var(--text-main, #0f172a)",
                  border: "1.5px solid var(--border, #cbd5e1)",
                  fontWeight: 700,
                  cursor: "pointer",
                  fontSize: "0.86rem",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "6px"
                }}
                title="Sign out and log in with a different role account"
              >
                <FaSignOutAlt /> Switch Account
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 5. Account must be approved
  if (profile.approved === false) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--page-bg, #f8fafc)",
          padding: "20px",
          fontFamily: "system-ui, -apple-system, sans-serif"
        }}
      >
        <div
          style={{
            background: "var(--surface, #ffffff)",
            padding: "40px 32px",
            borderRadius: "20px",
            maxWidth: "500px",
            width: "100%",
            textAlign: "center",
            boxShadow: "0 10px 30px var(--shadow, rgba(0,0,0,0.12))",
            border: "1px solid var(--border, #e2e8f0)"
          }}
        >
          <div
            style={{
              width: "56px",
              height: "56px",
              borderRadius: "16px",
              background: "rgba(245, 158, 11, 0.15)",
              color: "#fbbf24",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "26px",
              marginBottom: "16px"
            }}
          >
            <FaExclamationTriangle />
          </div>
          <h2 style={{ margin: "0 0 8px", fontSize: "1.35rem", color: "var(--text-main, #0f172a)", fontWeight: 800 }}>
            Account Pending Approval
          </h2>

          <p style={{ color: "var(--text-muted, #64748b)", lineHeight: "1.6", fontSize: "0.9rem", margin: "0 0 12px" }}>
            Your account has been registered as a <strong style={{ color: "var(--text-main, #0f172a)" }}>{roleLabels[profile.role] || profile.role}</strong>, but an institution administrator has not approved your account yet.
          </p>

          <p style={{ color: "var(--text-muted, #94a3b8)", fontSize: "0.82rem", margin: "0 0 24px" }}>
            Please contact the SmartAttend institution administrator for verification.
          </p>

          <button
            type="button"
            onClick={() => logoutUser()}
            style={{
              padding: "10px 20px",
              borderRadius: "12px",
              background: "var(--accent, #6366f1)",
              color: "#ffffff",
              border: "none",
              fontWeight: 700,
              cursor: "pointer",
              fontSize: "0.9rem"
            }}
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  // 6. Account disabled
  if (profile.status === "disabled") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--page-bg, #f8fafc)",
          padding: "20px",
          fontFamily: "system-ui, -apple-system, sans-serif"
        }}
      >
        <div
          style={{
            background: "var(--surface, #ffffff)",
            padding: "40px 32px",
            borderRadius: "20px",
            maxWidth: "500px",
            width: "100%",
            textAlign: "center",
            boxShadow: "0 10px 30px var(--shadow, rgba(0,0,0,0.12))",
            border: "1px solid var(--border, #e2e8f0)"
          }}
        >
          <div
            style={{
              width: "56px",
              height: "56px",
              borderRadius: "16px",
              background: "rgba(239, 68, 68, 0.15)",
              color: "#ef4444",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "26px",
              marginBottom: "16px"
            }}
          >
            <FaShieldAlt />
          </div>
          <h2 style={{ margin: "0 0 8px", fontSize: "1.35rem", color: "var(--text-main, #0f172a)", fontWeight: 800 }}>
            Account Deactivated
          </h2>

          <p style={{ color: "var(--text-muted, #64748b)", lineHeight: "1.6", fontSize: "0.9rem", margin: "0 0 24px" }}>
            Your <strong style={{ color: "var(--text-main, #0f172a)" }}>{roleLabels[profile.role] || profile.role}</strong> account has been disabled by the institution administrator.
          </p>

          <button
            type="button"
            onClick={() => logoutUser()}
            style={{
              padding: "10px 20px",
              borderRadius: "12px",
              background: "var(--accent, #6366f1)",
              color: "#ffffff",
              border: "none",
              fontWeight: 700,
              cursor: "pointer",
              fontSize: "0.9rem"
            }}
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  // 7. Everything is valid
  return children;
};

export default ProtectedRoute;