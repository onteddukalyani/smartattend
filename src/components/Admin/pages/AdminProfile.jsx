import React, { useState } from "react";
import {
  FaUserShield,
  FaEnvelope,
  FaBuilding,
  FaCamera,
  FaTrashAlt,
  FaSpinner,
  FaCheck,
  FaTimes
} from "react-icons/fa";
import { useAuth } from "../../authcontext";
import ProfilePhotoModal from "../../Common/ProfilePhotoModal";
import "./AdminProfile.css";

const AdminProfile = () => {
  const { user, profile, updateProfilePhoto, deleteProfilePhoto } = useAuth();
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoDeleting, setPhotoDeleting] = useState(false);
  const [photoMsg, setPhotoMsg] = useState("");
  const [photoError, setPhotoError] = useState("");
  const [imageFailed, setImageFailed] = useState(false);

  const currentPhoto = profile?.photoURL || profile?.photo || profile?.image || user?.photoURL;
  const hasPhoto = Boolean(currentPhoto && !imageFailed);
  const adminName = profile?.name || user?.displayName || "Administrator";

  const handlePhotoUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setPhotoError("Please select a valid image file (JPEG, PNG, WEBP).");
      setTimeout(() => setPhotoError(""), 3500);
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        setPhotoUploading(true);
        setPhotoError("");
        setPhotoMsg("");

        const img = new Image();
        img.src = event.target.result;
        img.onload = async () => {
          const canvas = document.createElement("canvas");
          const MAX_DIM = 400;
          let width = img.width;
          let height = img.height;
          if (width > height) {
            if (width > MAX_DIM) {
              height = Math.round((height * MAX_DIM) / width);
              width = MAX_DIM;
            }
          } else {
            if (height > MAX_DIM) {
              width = Math.round((width * MAX_DIM) / height);
              height = MAX_DIM;
            }
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          const compressedDataUrl = canvas.toDataURL("image/jpeg", 0.85);

          await updateProfilePhoto(compressedDataUrl);
          setImageFailed(false);
          setPhotoMsg("Profile photo updated successfully!");
          setTimeout(() => setPhotoMsg(""), 3500);
        };
      } catch (err) {
        console.error("Error updating admin photo:", err);
        setPhotoError(err.message || "Failed to update profile photo");
        setTimeout(() => setPhotoError(""), 3500);
      } finally {
        setPhotoUploading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handlePhotoDelete = async () => {
    const confirm = window.confirm("Are you sure you want to remove your profile photo?");
    if (!confirm) return;

    try {
      setPhotoDeleting(true);
      setPhotoError("");
      setPhotoMsg("");
      await deleteProfilePhoto();
      setImageFailed(false);
      setPhotoMsg("Profile photo removed!");
      setTimeout(() => setPhotoMsg(""), 3500);
    } catch (err) {
      console.error("Error deleting admin photo:", err);
      setPhotoError(err.message || "Failed to remove photo");
      setTimeout(() => setPhotoError(""), 3500);
    } finally {
      setPhotoDeleting(false);
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
            style={{ position: "relative", display: "inline-block" }}
          >
            <div
              onClick={() => setShowPhotoModal(true)}
              title="Click to view full-size profile photo"
              style={{ cursor: "pointer", display: "inline-block" }}
            >
              {hasPhoto ? (
                <img
                  src={currentPhoto}
                  alt={adminName}
                  className="admin-profile-image"
                  onError={() => setImageFailed(true)}
                />
              ) : (
                <div className="admin-profile-avatar">
                  {adminName.charAt(0).toUpperCase()}
                </div>
              )}
            </div>

            {/* Direct Avatar Action Overlay */}
            <div
              className="admin-avatar-actions-overlay"
              onClick={(e) => e.stopPropagation()}
            >
              <label
                className="admin-avatar-action-btn upload-btn"
                title="Upload / Change Profile Photo"
              >
                {photoUploading ? <FaSpinner className="fa-spin" /> : <FaCamera />}
                <input
                  type="file"
                  accept="image/*"
                  onChange={handlePhotoUpload}
                  disabled={photoUploading || photoDeleting}
                  style={{ display: "none" }}
                />
              </label>

              {hasPhoto && (
                <button
                  type="button"
                  className="admin-avatar-action-btn delete-btn"
                  title="Remove Profile Photo"
                  onClick={handlePhotoDelete}
                  disabled={photoUploading || photoDeleting}
                >
                  {photoDeleting ? <FaSpinner className="fa-spin" /> : <FaTrashAlt />}
                </button>
              )}
            </div>
          </div>

          <div className="admin-profile-top-info">
            <h2>{adminName}</h2>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <span className="admin-role-badge">
                <FaUserShield /> Administrator
              </span>
              <span className="admin-role-badge inst-badge">
                <FaBuilding /> IIIT Dharwad
              </span>
            </div>

            {photoMsg && (
              <div className="admin-toast-msg success">
                <FaCheck /> {photoMsg}
              </div>
            )}
            {photoError && (
              <div className="admin-toast-msg error">
                <FaTimes /> {photoError}
              </div>
            )}
          </div>
        </div>

        <div className="admin-profile-details">
          <div className="profile-detail">
            <FaEnvelope />
            <div>
              <span>Email Address</span>
              <strong>{profile?.email || user?.email || "-"}</strong>
            </div>
          </div>

          <div className="profile-detail">
            <FaBuilding />
            <div>
              <span>Institution</span>
              <strong>Indian Institute of Information Technology Dharwad</strong>
            </div>
          </div>

          <div className="profile-detail">
            <FaUserShield />
            <div>
              <span>System Role</span>
              <strong>{profile?.role || "admin"}</strong>
            </div>
          </div>

          <div className="profile-detail">
            <FaCamera />
            <div>
              <span>Profile Photo</span>
              <strong>{hasPhoto ? "Custom Photo Uploaded" : "Default Initial Avatar"}</strong>
            </div>
          </div>
        </div>

        <div className="admin-profile-security">
          <h3>Account Status</h3>
          <div className="security-status">
            <span className="status-dot"></span>
            <div>
              <strong>Account Active &amp; Verified</strong>
              <p>Your administrator account has full authority to manage institution courses, students, and faculty.</p>
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
        onUpload={handlePhotoUpload}
        onDelete={handlePhotoDelete}
        uploading={photoUploading}
        deleting={photoDeleting}
      />
    </div>
  );
};

export default AdminProfile;