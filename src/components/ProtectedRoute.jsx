import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./authcontext";

const ProtectedRoute = ({ allowedRole, children }) => {
  const { user, profile, loading } = useAuth();
  const location = useLocation();

  // Firebase is still checking authentication
  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "18px"
        }}
      >
        Checking authorization...
      </div>
    );
  }

  // Not logged in
  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname }}
      />
    );
  }

  // Logged in but profile doesn't exist
  if (!profile) {
    return (
      <Navigate
        to="/login"
        replace
      />
    );
  }

  // Role doesn't match
  if (profile.role !== allowedRole) {
    if (profile.role === "admin") {
      return <Navigate to="/admin" replace />;
    }

    if (profile.role === "lecturer") {
      return <Navigate to="/lecturer" replace />;
    }

    if (profile.role === "student") {
      return <Navigate to="/student" replace />;
    }

    return <Navigate to="/login" replace />;
  }

  // Admin and lecturer must be approved
  if (
    (profile.role === "admin" ||
      profile.role === "lecturer") &&
    profile.approved !== true
  ) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f5f7fb",
          padding: "20px"
        }}
      >
        <div
          style={{
            background: "white",
            padding: "40px",
            borderRadius: "16px",
            maxWidth: "500px",
            width: "100%",
            textAlign: "center",
            boxShadow: "0 10px 30px rgba(0,0,0,0.08)"
          }}
        >
          <h2>Account Not Approved</h2>

          <p
            style={{
              color: "#666",
              lineHeight: "1.6"
            }}
          >
            Your account has been registered as a{" "}
            <strong>{profile.role}</strong>, but an
            institution administrator has not approved
            your account yet.
          </p>

          <p
            style={{
              color: "#888",
              fontSize: "14px"
            }}
          >
            Please contact the IIIT Dharwad administrator.
          </p>
        </div>
      </div>
    );
  }

  // Account disabled
  if (profile.status === "disabled") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f5f7fb",
          padding: "20px"
        }}
      >
        <div
          style={{
            background: "white",
            padding: "40px",
            borderRadius: "16px",
            maxWidth: "500px",
            width: "100%",
            textAlign: "center"
          }}
        >
          <h2>Account Disabled</h2>

          <p>
            Your {profile.role} account has been
            disabled by the institution administrator.
          </p>
        </div>
      </div>
    );
  }

  // Everything is valid
  return children;
};

export default ProtectedRoute;