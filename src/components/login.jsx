import { useState } from "react";

import {
  FaGoogle,
  FaLock,
  FaUserTie,
  FaChalkboardTeacher,
  FaUserGraduate
} from "react-icons/fa";

import { useAuth } from "./authcontext";

import "./login.css";

const Login = () => {

  const {
    loginWithGoogle
  } = useAuth();

  const [selectedRole, setSelectedRole] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);


  // =====================================================
  // SELECT ROLE
  // =====================================================

  const handleRoleSelect = (role) => {

    setSelectedRole(role);
    setError("");

  };


  // =====================================================
  // GOOGLE LOGIN
  // =====================================================

  const handleGoogleLogin = async () => {
  try {
    setError("");

    if (!selectedRole) {
      setError("Please select a role before signing in.");
      return;
    }

    setLoading(true);

    console.log("LOGIN PAGE ROLE:", selectedRole);

    const authorizedUser =
      await loginWithGoogle(selectedRole);

    console.log(
      "LOGIN SUCCESS:",
      authorizedUser
    );

  } catch (error) {
    console.error(
      "LOGIN ERROR:",
      error
    );

    setError(
      error.message || "Login failed."
    );

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
              SA
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


          {/* ERROR */}

          {error && (

            <p
              className="login-error"
              role="alert"
            >
              {error}
            </p>

          )}


          {/* =================================================
              ROLE BUTTONS
          ================================================= */}

          <div className="role-selection">


            {/* ADMIN */}

            <button
              type="button"
              className={`login-button ${
                selectedRole === "admin"
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
              className={`login-button ${
                selectedRole === "lecturer"
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
              className={`login-button ${
                selectedRole === "student"
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
                onClick={handleGoogleLogin}
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