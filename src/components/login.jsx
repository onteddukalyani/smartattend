import { useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  FaGoogle,
  FaLock,
  FaUserTie,
  FaChalkboardTeacher,
  FaUserGraduate,
  FaGraduationCap,
  FaExclamationTriangle,
  FaExchangeAlt,
  FaShieldAlt
} from "react-icons/fa";

import { useAuth } from "./authcontext";

import "./login.css";

const Login = () => {
  const navigate = useNavigate();

  const {
    loginWithGoogle
  } = useAuth();

  const [selectedRole, setSelectedRole] = useState("");
  const [error, setError] = useState("");
  const [roleMismatch, setRoleMismatch] = useState(null);
  const [loading, setLoading] = useState(false);

  // =====================================================
  // SELECT ROLE
  // =====================================================

  const handleRoleSelect = (role) => {
    setSelectedRole(role);
    setError("");
    setRoleMismatch(null);
  };

  // =====================================================
  // GOOGLE LOGIN
  // =====================================================

  const handleGoogleLogin = async (overrideRole) => {
    const roleToUse = overrideRole || selectedRole;
    try {
      setError("");
      setRoleMismatch(null);

      if (!roleToUse) {
        setError("Please select a role before signing in.");
        return;
      }

      setLoading(true);

      console.log("LOGIN PAGE ROLE:", roleToUse);

      const authorizedUser = await loginWithGoogle(roleToUse);

      console.log(
        "LOGIN SUCCESS:",
        authorizedUser
      );

      const roleTarget = String(authorizedUser?.role || roleToUse || "student").toLowerCase().trim();
      const pendingRedirect = sessionStorage.getItem("smartattend_redirect_after_login");

      if (roleTarget === "admin" || roleTarget === "administrator" || roleTarget === "superadmin") {
        if (pendingRedirect && pendingRedirect.startsWith("/admin")) {
          sessionStorage.removeItem("smartattend_redirect_after_login");
          navigate(pendingRedirect, { replace: true });
        } else {
          navigate("/admin", { replace: true });
        }
      } else if (roleTarget === "lecturer" || roleTarget === "faculty") {
        if (pendingRedirect && pendingRedirect.startsWith("/lecturer")) {
          sessionStorage.removeItem("smartattend_redirect_after_login");
          navigate(pendingRedirect, { replace: true });
        } else {
          navigate("/lecturer", { replace: true });
        }
      } else {
        if (pendingRedirect && (pendingRedirect.includes("mark-attendance") || pendingRedirect.includes("scanqr") || pendingRedirect.includes("session="))) {
          sessionStorage.removeItem("smartattend_redirect_after_login");
          let target = pendingRedirect;
          if (target.startsWith("/scanqr")) {
            target = target.replace("/scanqr", "/student/mark-attendance");
          } else if (!target.startsWith("/student/")) {
            target = `/student/${target.replace(/^\//, "")}`;
          }
          navigate(target, { replace: true });
        } else {
          navigate("/student", { replace: true });
        }
      }

    } catch (err) {
      console.error(
        "LOGIN ERROR:",
        err
      );

      // Detect role mismatch
      if (err.code === "ROLE_MISMATCH" || (err.message && err.message.toLowerCase().includes("role mismatch"))) {
        const regRole = err.registeredRole || (err.message.match(/registered as "([^"]+)"/i)?.[1]) || "";
        const selRole = err.selectedRole || roleToUse;
        setRoleMismatch({
          selectedRole: selRole,
          registeredRole: regRole,
          message: err.message
        });
        setError("");
      } else {
        setRoleMismatch(null);
        setError(err.message || "Login failed.");
      }

    } finally {
      setLoading(false);
    }
  };


  return (

    <main className="login-page">

      <section
        className="login-shell"
        aria-label="SmartAttend sign in"
      >


        {/* =================================================
            LEFT SIDE
        ================================================= */}

        <div className="login-intro">

          <div>

            <div
              className="login-mark"
              aria-hidden="true"
            >
              <FaGraduationCap />
            </div>

            <h1>
              Attendance, with a clear record.
            </h1>

            <p>
              Sign in to access SmartAttend.
            </p>

          </div>


          <div className="login-caption">

            <FaLock />

            <span>
              Your account details stay private.
            </span>

          </div>

        </div>


        {/* =================================================
            RIGHT SIDE
        ================================================= */}

        <div className="login-form">

          <h2>
            Welcome
          </h2>

          <p>
            Select your role to continue.
          </p>


          {/* ROLE MISMATCH ALERT CARD */}
          {roleMismatch && (
            <div className="login-role-mismatch-box" role="alert">
              <div className="mismatch-box-top">
                <div className="mismatch-box-icon">
                  <FaShieldAlt />
                </div>
                <div>
                  <h4 className="mismatch-box-title">Role Mismatch Detected</h4>
                  <p className="mismatch-box-sub">
                    You selected <strong className="mismatch-highlight red">{roleMismatch.selectedRole.toUpperCase()}</strong>, but your email is registered as an <strong className="mismatch-highlight green">{roleMismatch.registeredRole.toUpperCase()}</strong> in the institution directory.
                  </p>
                </div>
              </div>

              <div className="mismatch-box-actions">
                <button
                  type="button"
                  className="mismatch-switch-btn"
                  onClick={() => {
                    const targetRole = roleMismatch.registeredRole;
                    setSelectedRole(targetRole);
                    setRoleMismatch(null);
                    setError("");
                    handleGoogleLogin(targetRole);
                  }}
                  disabled={loading}
                >
                  <FaExchangeAlt />
                  <span>
                    Switch to {roleMismatch.registeredRole.charAt(0).toUpperCase() + roleMismatch.registeredRole.slice(1)} &amp; Sign In
                  </span>
                </button>
              </div>
            </div>
          )}

          {/* STANDARD ERROR CARD */}
          {error && !roleMismatch && (
            <div className="login-error-box" role="alert">
              <FaExclamationTriangle className="login-error-icon" />
              <span>{error}</span>
            </div>
          )}

          {/* =================================================
              ROLE BUTTONS
          ================================================= */}

          <div className="role-selection">

            {/* ADMIN */}

            <button
              type="button"
              className={`login-button ${selectedRole === "admin"
                  ? "selected"
                  : ""
                }`}
              onClick={() =>
                handleRoleSelect("admin")
              }
              disabled={loading}
            >

              <FaUserTie />

              <span>
                Admin
              </span>

            </button>


            {/* LECTURER */}

            <button
              type="button"
              className={`login-button ${selectedRole === "lecturer"
                  ? "selected"
                  : ""
                }`}
              onClick={() =>
                handleRoleSelect("lecturer")
              }
              disabled={loading}
            >

              <FaChalkboardTeacher />

              <span>
                Lecturer
              </span>

            </button>


            {/* STUDENT */}

            <button
              type="button"
              className={`login-button ${selectedRole === "student"
                  ? "selected"
                  : ""
                }`}
              onClick={() =>
                handleRoleSelect("student")
              }
              disabled={loading}
            >

              <FaUserGraduate />

              <span>
                Student
              </span>

            </button>

          </div>


          {/* =================================================
              GOOGLE BUTTON
              ONLY AFTER ROLE IS SELECTED
          ================================================= */}

          {selectedRole && (

            <div className="google-login-section">

              <p>

                Selected role:{" "}

                <strong>

                  {selectedRole
                    .charAt(0)
                    .toUpperCase() +
                    selectedRole.slice(1)}

                </strong>

              </p>


              <button
                type="button"
                className="login-button login-button-google"
                onClick={() => handleGoogleLogin()}
                disabled={loading}
              >

                <FaGoogle />

                <span>

                  {loading
                    ? "Checking account..."
                    : "Sign in with Google"}

                </span>

              </button>

            </div>

          )}


          {/* =================================================
              PRIVACY
          ================================================= */}
          <br></br>
          <p className="login-privacy">

            Your account and selected role will be
            verified against the IIIT Dharwad database.

          </p>

        </div>

      </section>

    </main>

  );

};

export default Login;