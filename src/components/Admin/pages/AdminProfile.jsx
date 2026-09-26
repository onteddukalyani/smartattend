import React, { useState } from "react";
import { FaUserShield, FaEnvelope, FaBuilding, FaCamera } from "react-icons/fa";
import { useAuth } from "../../authcontext";
import ProfilePhotoModal from "../../Common/ProfilePhotoModal";
import "./AdminProfile.css";

const AdminProfile = () => {
  const { user, profile, updateUserProfilePhoto, removeUserProfilePhoto } = useAuth();
  const [showPhotoModal, setShowPhotoModal] = useState(false);

  const currentPhoto = profile?.photoURL || profile?.photo || profile?.image || user?.photoURL;
  const adminName = profile?.name || user?.displayName || "Administrator";

  const handleUpdatePhoto = async (photoDataUrl) => {
    if (updateUserProfilePhoto) {
      await updateUserProfilePhoto(photoDataUrl);
    }
  };

  const handleDeletePhoto = async () => {
    if (removeUserProfilePhoto) {
      await removeUserProfilePhoto();
    }
  };

  return (
    <div className="admin-profile-page">
      <div className="admin-profile-header">
        <h1>Admin Profile</h1>
        <p>View and manage your administrator account information and profile photo.</p>
      </div>

      <div className="admin-profile-card">
        <div className="admin-profile-top">
          <div
            className="admin-avatar-interactive-wrapper"
            onClick={() => setShowPhotoModal(true)}
            title="Click to view or change profile photo (WhatsApp / Instagram style)"
            style={{ position: "relative", cursor: "pointer", display: "inline-block" }}
          >
            {currentPhoto ? (
              <img
                src={currentPhoto}
                alt={adminName}
                className="admin-profile-image"
              />
            ) : (
              <div className="admin-profile-avatar">
                {adminName.charAt(0).toUpperCase()}
              </div>
            )}
            <div
              className="admin-avatar-hover-pill"
              style={{
                position: "absolute",
                bottom: "-6px",
                right: "-6px",
                background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                color: "#ffffff",
                borderRadius: "50%",
                width: "26px",
                height: "26px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "12px",
                boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                border: "2px solid #ffffff"
              }}
              title="Change or view photo"
            >
              <FaCamera />
            </div>
          </div>

          <div>
            <h2>{adminName}</h2>
            <span className="admin-role-badge">
              <FaUserShield /> Administrator
            </span>
          </div>
        </div>

        <div className="admin-profile-details">
          <div className="profile-detail">
            <FaEnvelope />
            <div>
              <span>Email</span>
              <strong>{profile?.email || user?.email || "-"}</strong>
            </div>
          </div>

          <div className="profile-detail">
            <FaBuilding />
            <div>
              <span>Institution</span>
              <strong>IIIT Dharwad</strong>
            </div>
          </div>

          <div className="profile-detail">
            <FaUserShield />
            <div>
              <span>Account Role</span>
              <strong>{profile?.role || "admin"}</strong>
            </div>
          </div>
        </div>

        <div className="admin-profile-security">
          <h3>Account Status</h3>
          <div className="security-status">
            <span className="status-dot"></span>
            <div>
              <strong>Account Active</strong>
              <p>Your administrator account is authorized to manage the institution.</p>
            </div>
          </div>
        </div>
      </div>

      {/* WhatsApp / Instagram Style Full Screen Profile Photo Viewer */}
      <ProfilePhotoModal
        isOpen={showPhotoModal}
        onClose={() => setShowPhotoModal(false)}
        photoSrc={currentPhoto}
        name={adminName}
        role="admin"
        subtext="System Administrator • IIIT Dharwad"
        canEdit={true}
        onUpdatePhoto={handleUpdatePhoto}
        onDeletePhoto={handleDeletePhoto}
      />
    </div>
  );
};

export default AdminProfile;