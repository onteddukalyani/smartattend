import React, { useEffect } from "react";
import {
    FaTimes,
    FaDownload,
    FaCamera,
    FaTrashAlt,
    FaUser,
    FaUserGraduate,
    FaChalkboardTeacher,
    FaUserShield,
    FaIdCard
} from "react-icons/fa";
import "./ProfilePhotoModal.css";

/**
 * WhatsApp & Instagram style full-screen profile photo viewer
 */
export default function ProfilePhotoModal({
    isOpen,
    onClose,
    photoSrc,
    name = "User",
    role = "student",
    subtext = "",
    canEdit = false,
    onUpload = null,
    onDelete = null,
    uploading = false,
    deleting = false
}) {
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e) => {
            if (e.key === "Escape") {
                onClose();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        document.body.style.overflow = "hidden";

        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            document.body.style.overflow = "";
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const handleDownload = (e) => {
        e.stopPropagation();
        if (!photoSrc) return;
        const link = document.createElement("a");
        link.href = photoSrc;
        link.download = `${name.replace(/\s+/g, "_")}_profile_photo.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const getRoleIcon = () => {
        const r = String(role || "").toLowerCase();
        if (r.includes("admin")) return <FaUserShield />;
        if (r.includes("lecturer") || r.includes("faculty")) return <FaChalkboardTeacher />;
        return <FaUserGraduate />;
    };

    const initial = name ? name.charAt(0).toUpperCase() : "U";

    return (
        <div className="wa-dp-backdrop" onClick={onClose} role="dialog" aria-modal="true">
            {/* Top Bar Header */}
            <div className="wa-dp-top-bar" onClick={(e) => e.stopPropagation()}>
                <div className="wa-dp-user-meta">
                    <div className="wa-dp-mini-avatar">
                        {photoSrc ? (
                            <img src={photoSrc} alt={name} />
                        ) : (
                            <span>{initial}</span>
                        )}
                    </div>
                    <div className="wa-dp-title-stack">
                        <h3 className="wa-dp-name">{name}</h3>
                        <div className="wa-dp-sub-row">
                            <span className={`wa-dp-role-badge role-${String(role).toLowerCase()}`}>
                                {getRoleIcon()} {role.toUpperCase()}
                            </span>
                            {subtext && (
                                <span className="wa-dp-subtext">
                                    <FaIdCard /> {subtext}
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                <div className="wa-dp-header-actions">
                    {photoSrc && (
                        <button
                            type="button"
                            className="wa-dp-action-icon-btn"
                            title="Download Profile Photo"
                            onClick={handleDownload}
                        >
                            <FaDownload />
                        </button>
                    )}
                    <button
                        type="button"
                        className="wa-dp-action-icon-btn close-btn"
                        title="Close (Esc)"
                        onClick={onClose}
                    >
                        <FaTimes />
                    </button>
                </div>
            </div>

            {/* Central Photo Viewer Spotlight */}
            <div className="wa-dp-content-wrapper" onClick={(e) => e.stopPropagation()}>
                <div className="wa-dp-image-container">
                    {photoSrc ? (
                        <img
                            src={photoSrc}
                            alt={`${name}'s profile`}
                            className="wa-dp-full-img"
                        />
                    ) : (
                        <div className="wa-dp-placeholder-big">
                            <div className="wa-dp-initial-big">{initial}</div>
                            <p className="wa-dp-no-photo-txt">No profile photo set</p>
                        </div>
                    )}
                </div>

                {/* Bottom Action Footer (for profile owner) */}
                {canEdit && (
                    <div className="wa-dp-bottom-controls">
                        {onUpload && (
                            <label className="wa-dp-bottom-btn upload-btn" title="Change Profile Photo">
                                <FaCamera /> <span>{uploading ? "Updating..." : "Change Photo"}</span>
                                <input
                                    type="file"
                                    accept="image/*"
                                    onChange={onUpload}
                                    disabled={uploading || deleting}
                                    style={{ display: "none" }}
                                />
                            </label>
                        )}
                        {photoSrc && onDelete && (
                            <button
                                type="button"
                                className="wa-dp-bottom-btn delete-btn"
                                onClick={onDelete}
                                disabled={uploading || deleting}
                                title="Remove Profile Photo"
                            >
                                <FaTrashAlt /> <span>{deleting ? "Removing..." : "Remove Photo"}</span>
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
