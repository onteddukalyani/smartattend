import React from "react";
import { FaUserShield, FaEnvelope, FaBuilding } from "react-icons/fa";
import { useAuth } from "../../authcontext";

import "./AdminProfile.css";

const AdminProfile = () => {
  const { user, profile } = useAuth();

  return (
    <div className="admin-profile-page">

      <div className="admin-profile-header">
        <h1>Admin Profile</h1>
        <p>
          View your administrator account information.
        </p>
      </div>

      <div className="admin-profile-card">

        <div className="admin-profile-top">

          {user?.photoURL ? (
            <img
              src={user.photoURL}
              alt="Admin"
              className="admin-profile-image"
            />
          ) : (
            <div className="admin-profile-avatar">
              {(
                profile?.name ||
                user?.displayName ||
                "A"
              )
                .charAt(0)
                .toUpperCase()}
            </div>
          )}

          <div>
            <h2>
              {profile?.name ||
                user?.displayName ||
                "Administrator"}
            </h2>

            <span className="admin-role-badge">
              <FaUserShield />
              Administrator
            </span>
          </div>

        </div>

        <div className="admin-profile-details">

          <div className="profile-detail">
            <FaEnvelope />

            <div>
              <span>Email</span>
              <strong>
                {profile?.email ||
                  user?.email ||
                  "-"}
              </strong>
            </div>
          </div>

          <div className="profile-detail">
            <FaBuilding />

            <div>
              <span>Institution</span>
              <strong>
                IIIT Dharwad
              </strong>
            </div>
          </div>

          <div className="profile-detail">
            <FaUserShield />

            <div>
              <span>Account Role</span>
              <strong>
                {profile?.role || "admin"}
              </strong>
            </div>
          </div>

        </div>

        <div className="admin-profile-security">

          <h3>Account Status</h3>

          <div className="security-status">

            <span className="status-dot"></span>

            <div>
              <strong>
                Account Active
              </strong>

              <p>
                Your administrator account is
                authorized to manage the institution.
              </p>
            </div>

          </div>

        </div>

      </div>

    </div>
  );
};

export default AdminProfile;