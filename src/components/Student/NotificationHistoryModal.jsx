import React from 'react';
import {
    FaBell,
    FaTimes,
    FaExclamationTriangle,
    FaMobileAlt,
    FaCamera,
    FaUserEdit,
    FaCheck,
    FaInbox,
    FaLock,
    FaShieldAlt
} from 'react-icons/fa';
import { markNotificationAsRead, markFacultyNotificationAsRead } from '../../services/notificationsService';
import './NotificationHistoryModal.css';

/**
 * NotificationHistoryModal
 * Complete real-time notification history log for Students, Lecturers, and Admins.
 * Displays past updates (Device Lock, Device Reset, Biometrics Cleared, Violation Decisions, Profile Updates).
 */
export function NotificationHistoryModal({
    isOpen,
    onClose,
    notifications = [],
    studentRollNo = '',
    isFaculty = false,
    onOpenDeviceModal = null,
    onOpenFaceModal = null
}) {
    if (!isOpen) return null;

    const unreadCount = notifications.filter(n => !n.read).length;

    const getTypeBadge = (type) => {
        switch (type) {
            case 'DEVICE_LOCKED':
                return <span className="notif-type-tag type-device" style={{ background: '#e0f2fe', color: '#0369a1' }}><FaLock /> Device Locked</span>;
            case 'DEVICE_RESET':
                return <span className="notif-type-tag type-device"><FaMobileAlt /> Device Reset</span>;
            case 'BIOMETRICS_CLEARED':
                return <span className="notif-type-tag type-biometric"><FaCamera /> Biometrics</span>;
            case 'VIOLATION_DECISION':
            case 'ANTI_PROXY_VIOLATION':
                return <span className="notif-type-tag type-violation"><FaExclamationTriangle /> Anti-Proxy Audit</span>;
            case 'SECURITY_ALERT':
            case 'USER_VERIFICATION_FAILURE':
                return <span className="notif-type-tag type-violation" style={{ background: '#fee2e2', color: '#b91c1c', border: '1px solid #fca5a5' }}><FaExclamationTriangle /> Security Alert</span>;
            case 'PROFILE_UPDATE':
                return <span className="notif-type-tag type-profile"><FaUserEdit /> Profile Update</span>;
            default:
                return <span className="notif-type-tag type-device"><FaShieldAlt /> System Audit</span>;
        }
    };

    const handleRead = async (notifId) => {
        if (isFaculty) {
            await markFacultyNotificationAsRead(notifId);
        } else {
            await markNotificationAsRead(studentRollNo, notifId);
        }
    };

    const handleMarkAllRead = async () => {
        const unread = notifications.filter(n => !n.read);
        for (const n of unread) {
            await handleRead(n.id);
        }
    };

    return (
        <div className="notif-modal-overlay" role="dialog" aria-modal="true">
            <div className="notif-modal-card">
                {/* Header */}
                <div className="notif-modal-header">
                    <button className="notif-modal-close-btn" onClick={onClose} aria-label="Close">
                        <FaTimes />
                    </button>

                    <div className="notif-header-center">
                        <div className="notif-header-icon">
                            <FaBell />
                        </div>
                        <h2 className="notif-modal-title">
                            {isFaculty ? 'Faculty Audit Logs & Security Alerts' : 'Notification History & Logs'}
                        </h2>
                        <p className="notif-modal-subtitle">
                            {isFaculty
                                ? (unreadCount > 0 ? `${unreadCount} unread system security alert(s)` : 'Real-time student & anti-proxy audit log stream')
                                : (unreadCount > 0 ? `${unreadCount} unread update(s) from Faculty & Admin` : 'All Faculty & Admin updates')}
                        </p>
                        {unreadCount > 0 && (
                            <button
                                type="button"
                                className="notif-action-btn btn-action-secondary notif-mark-all-btn"
                                onClick={handleMarkAllRead}
                                title="Mark all as read"
                            >
                                <FaCheck /> <span>Mark All Read</span>
                            </button>
                        )}
                    </div>
                </div>

                {/* Notifications List Body */}
                <div className="notif-modal-body">
                    {notifications.length === 0 ? (
                        <div className="notif-empty-state">
                            <div className="notif-empty-icon">
                                <FaInbox />
                            </div>
                            <h3>No Audit Logs Yet</h3>
                            <p>
                                {isFaculty
                                    ? 'Real-time anti-proxy alerts, device lock events, and biometric registrations will appear here.'
                                    : 'Any updates or actions performed by your Lecturers or Administrators will appear here in real-time.'}
                            </p>
                        </div>
                    ) : (
                        notifications.map((n) => (
                            <div
                                key={n.id}
                                className={`notif-item-card ${!n.read ? 'unread' : ''}`}
                            >
                                <div className="notif-item-header">
                                    <div className="notif-item-title-wrap">
                                        <h4 className="notif-item-title">{n.title}</h4>
                                        {getTypeBadge(n.type)}
                                    </div>
                                    <span className="notif-item-time">
                                        {n.createdAt ? new Date(n.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Just now'}
                                    </span>
                                </div>

                                <p className="notif-item-msg" style={{ whiteSpace: "pre-line" }}>{n.message}</p>

                                <div className="notif-item-actions">
                                    <span className="notif-sender-pill">By {n.senderName || 'System'}</span>

                                    <div className="notif-item-btns">
                                        {/* Actionable Button: Device Reset (Student) */}
                                        {!isFaculty && n.type === 'DEVICE_RESET' && onOpenDeviceModal && (
                                            <button
                                                type="button"
                                                className="notif-action-btn btn-action-primary"
                                                onClick={() => {
                                                    handleRead(n.id);
                                                    onClose();
                                                    onOpenDeviceModal();
                                                }}
                                            >
                                                <FaMobileAlt /> Set Up Device
                                            </button>
                                        )}

                                        {/* Actionable Button: Biometrics Cleared (Student) */}
                                        {!isFaculty && n.type === 'BIOMETRICS_CLEARED' && onOpenFaceModal && (
                                            <button
                                                type="button"
                                                className="notif-action-btn btn-action-primary"
                                                onClick={() => {
                                                    handleRead(n.id);
                                                    onClose();
                                                    onOpenFaceModal();
                                                }}
                                            >
                                                <FaCamera /> Enroll Face
                                            </button>
                                        )}

                                        {!n.read && (
                                            <button
                                                type="button"
                                                className="notif-action-btn btn-action-secondary"
                                                onClick={() => handleRead(n.id)}
                                            >
                                                <FaCheck /> Dismiss
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}

export default NotificationHistoryModal;

