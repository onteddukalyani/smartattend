import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
    FaBell,
    FaTimes,
    FaExclamationTriangle,
    FaMobileAlt,
    FaCamera,
    FaUserEdit,
    FaCheck,
    FaCheckDouble,
    FaInbox,
    FaLock,
    FaShieldAlt,
    FaBullhorn,
    FaPaperPlane,
    FaTrashAlt,
    FaSearch,
    FaVolumeUp,
    FaVolumeMute,
    FaUserGraduate,
    FaChalkboardTeacher,
    FaUserShield,
    FaSpinner,
    FaHistory
} from 'react-icons/fa';
import {
    markNotificationAsRead,
    markFacultyNotificationAsRead,
    deleteFacultyNotification,
    deleteStudentNotification,
    approveDeviceResetAction,
    sendBroadcastNotification,
    sendStudentNotification,
    sendFacultyNotification,
    playNotificationChime
} from '../../services/notificationsService';
import './NotificationHistoryModal.css';

/**
 * NotificationHistoryModal
 * Unified Real-Time Notification Center & Security Dispatch Hub for Students, Lecturers, and Admins.
 */
export function NotificationHistoryModal({
    isOpen,
    onClose,
    notifications = [],
    studentRollNo = '',
    isFaculty = false,
    role = 'student', // 'student' | 'lecturer' | 'admin'
    currentUser = null,
    onOpenDeviceModal = null,
    onOpenFaceModal = null
}) {
    // Determine active role
    const effectiveRole = isFaculty ? (role === 'admin' ? 'admin' : 'lecturer') : 'student';

    // State
    const [activeTab, setActiveTab] = useState('all'); // 'all' | 'security' | 'attendance' | 'accounts' | 'announcements' | 'compose'
    const [searchQuery, setSearchQuery] = useState('');
    const [soundEnabled, setSoundEnabled] = useState(true);
    const [actionLoading, setActionLoading] = useState({});
    const [successMessage, setSuccessMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');

    // Broadcast Form State (For Admin & Lecturer)
    const [composerForm, setComposerForm] = useState({
        targetAudience: effectiveRole === 'admin' ? 'all' : 'student', // 'student' | 'lecturer' | 'admin' | 'all' | 'specific'
        specificRoll: '',
        title: '',
        message: '',
        urgency: 'GENERAL_NOTICE' // 'GENERAL_NOTICE' | 'SECURITY_ALERT' | 'CLASS_UPDATE' | 'SYSTEM_UPDATE'
    });
    const [sendingBroadcast, setSendingBroadcast] = useState(false);

    // Audio chime on new notification arrival
    const prevCountRef = useRef(notifications.length);
    useEffect(() => {
        if (notifications.length > prevCountRef.current && soundEnabled && isOpen) {
            playNotificationChime();
        }
        prevCountRef.current = notifications.length;
    }, [notifications.length, soundEnabled, isOpen]);

    const unreadCount = (notifications || []).filter(n => !n.read).length;

    // Filter by Category Tab & Search Query
    const filteredNotifications = useMemo(() => {
        let list = [...notifications];

        // Tab Filter
        if (activeTab === 'security') {
            list = list.filter(n =>
                ['DEVICE_RESET_REQUEST', 'DEVICE_RESET', 'DEVICE_LOCKED', 'ANTI_PROXY_VIOLATION', 'VIOLATION_DECISION', 'SECURITY_ALERT', 'USER_VERIFICATION_FAILURE'].includes(n.type) ||
                n.metadata?.actionable
            );
        } else if (activeTab === 'attendance') {
            list = list.filter(n =>
                ['ATTENDANCE_SUCCESS', 'ATTENDANCE_UPDATE', 'ATTENDANCE_RECORDED', 'SESSION_STARTED', 'SESSION_CLOSED'].includes(n.type)
            );
        } else if (activeTab === 'accounts') {
            list = list.filter(n =>
                ['PROFILE_UPDATE', 'BIOMETRICS_CLEARED', 'BIOMETRICS_REGISTERED', 'STUDENT_ADDED', 'LECTURER_ADDED', 'ADMIN_ADDED'].includes(n.type)
            );
        } else if (activeTab === 'announcements') {
            list = list.filter(n =>
                ['BROADCAST_ANNOUNCEMENT', 'ANNOUNCEMENT', 'SYSTEM_UPDATE', 'SYSTEM_NOTICE', 'GENERAL_NOTICE', 'CLASS_UPDATE'].includes(n.type)
            );
        }

        // Search Query Filter
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase().trim();
            list = list.filter(n =>
                (n.title && n.title.toLowerCase().includes(q)) ||
                (n.message && n.message.toLowerCase().includes(q)) ||
                (n.studentRollNo && n.studentRollNo.toLowerCase().includes(q)) ||
                (n.senderName && n.senderName.toLowerCase().includes(q))
            );
        }

        return list;
    }, [notifications, activeTab, searchQuery]);

    const getTypeBadge = (type) => {
        switch (type) {
            case 'DEVICE_RESET_REQUEST':
                return <span className="notif-type-tag type-violation" style={{ background: '#ffedd5', color: '#c2410c', border: '1px solid #fed7aa' }}><FaMobileAlt /> Reset Requested</span>;
            case 'DEVICE_LOCKED':
                return <span className="notif-type-tag type-device" style={{ background: '#e0f2fe', color: '#0369a1' }}><FaLock /> Device Locked</span>;
            case 'DEVICE_RESET':
            case 'DEVICE_RESET_APPROVED':
                return <span className="notif-type-tag type-device"><FaMobileAlt /> Device Reset</span>;
            case 'BIOMETRICS_CLEARED':
            case 'BIOMETRICS_REGISTERED':
                return <span className="notif-type-tag type-biometric"><FaCamera /> Biometrics</span>;
            case 'VIOLATION_DECISION':
            case 'ANTI_PROXY_VIOLATION':
                return <span className="notif-type-tag type-violation"><FaExclamationTriangle /> Anti-Proxy</span>;
            case 'SECURITY_ALERT':
            case 'USER_VERIFICATION_FAILURE':
                return <span className="notif-type-tag type-violation" style={{ background: '#fee2e2', color: '#b91c1c', border: '1px solid #fca5a5' }}><FaShieldAlt /> Security Alert</span>;
            case 'SESSION_STARTED':
            case 'SESSION_CLOSED':
            case 'ATTENDANCE_SUCCESS':
                return <span className="notif-type-tag type-attendance" style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #bbf7d0' }}><FaCheck /> Attendance</span>;
            case 'PROFILE_UPDATE':
                return <span className="notif-type-tag type-profile"><FaUserEdit /> Profile Update</span>;
            case 'BROADCAST_ANNOUNCEMENT':
            case 'ANNOUNCEMENT':
                return <span className="notif-type-tag type-announcement" style={{ background: '#fdf4ff', color: '#a21caf', border: '1px solid #f5d0fe' }}><FaBullhorn /> Announcement</span>;
            default:
                return <span className="notif-type-tag type-device"><FaShieldAlt /> System Audit</span>;
        }
    };

    const handleRead = async (notifId) => {
        if (isFaculty || effectiveRole !== 'student') {
            await markFacultyNotificationAsRead(notifId);
        } else {
            await markNotificationAsRead(studentRollNo, notifId);
        }
    };

    const handleDelete = async (notifId) => {
        if (isFaculty || effectiveRole !== 'student') {
            await deleteFacultyNotification(notifId);
        } else {
            await deleteStudentNotification(studentRollNo, notifId);
        }
    };

    const handleMarkAllRead = async () => {
        const unread = notifications.filter(n => !n.read);
        for (const n of unread) {
            await handleRead(n.id);
        }
    };

    // Approve Student Device Reset (1-Click for Faculty / Admin)
    const handleApproveDeviceReset = async (notif) => {
        const roll = notif.studentRollNo || notif.metadata?.studentRollNo;
        if (!roll) return;

        setActionLoading(prev => ({ ...prev, [notif.id]: true }));
        setErrorMessage('');
        setSuccessMessage('');

        const approverName = currentUser?.displayName || currentUser?.email || (effectiveRole === 'admin' ? 'Administrator' : 'Course Lecturer');
        const res = await approveDeviceResetAction(roll, approverName, notif.id);

        setActionLoading(prev => ({ ...prev, [notif.id]: false }));
        if (res.success) {
            setSuccessMessage(`✅ Successfully cleared device lock for student ${roll}. Student notified!`);
            setTimeout(() => setSuccessMessage(''), 6000);
        } else {
            setErrorMessage(`Failed to reset device: ${res.error}`);
            setTimeout(() => setErrorMessage(''), 6000);
        }
    };

    // Handle Broadcast Dispatch by Admin / Lecturer
    const handleSendBroadcast = async (e) => {
        e.preventDefault();
        setErrorMessage('');
        setSuccessMessage('');

        if (!composerForm.title.trim()) {
            setErrorMessage('Please enter a notification title.');
            return;
        }
        if (!composerForm.message.trim()) {
            setErrorMessage('Please enter a notification message.');
            return;
        }

        const senderName = currentUser?.displayName || currentUser?.email?.split('@')[0] || (effectiveRole === 'admin' ? 'Campus Admin' : 'Course Lecturer');

        setSendingBroadcast(true);

        try {
            if (composerForm.targetAudience === 'specific') {
                const targetRoll = composerForm.specificRoll.trim().toUpperCase();
                if (!targetRoll) {
                    setErrorMessage('Please specify the student Roll Number.');
                    setSendingBroadcast(false);
                    return;
                }
                await sendStudentNotification(
                    targetRoll,
                    composerForm.title.trim(),
                    composerForm.message.trim(),
                    composerForm.urgency,
                    senderName
                );
                // Also log to faculty
                await sendFacultyNotification(
                    `📢 Direct Notice Sent to ${targetRoll}: ${composerForm.title.trim()}`,
                    composerForm.message.trim(),
                    composerForm.urgency,
                    targetRoll,
                    senderName
                );
            } else {
                let targetRoles = ['student', 'lecturer', 'admin'];
                if (composerForm.targetAudience === 'student') targetRoles = ['student'];
                else if (composerForm.targetAudience === 'lecturer') targetRoles = ['lecturer'];
                else if (composerForm.targetAudience === 'admin') targetRoles = ['admin'];

                await sendBroadcastNotification({
                    targetRoles,
                    title: composerForm.title.trim(),
                    message: composerForm.message.trim(),
                    type: composerForm.urgency,
                    senderName,
                    senderRole: effectiveRole
                });
            }

            setSuccessMessage('🚀 Notification broadcast transmitted successfully in real-time!');
            setComposerForm({
                targetAudience: effectiveRole === 'admin' ? 'all' : 'student',
                specificRoll: '',
                title: '',
                message: '',
                urgency: 'GENERAL_NOTICE'
            });
            setTimeout(() => {
                setActiveTab('all');
                setSuccessMessage('');
            }, 2000);
        } catch (err) {
            setErrorMessage(`Failed to send notification: ${err.message}`);
        } finally {
            setSendingBroadcast(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="notif-modal-overlay" role="dialog" aria-modal="true">
            <div className="notif-modal-card">
                {/* Header */}
                <div className="notif-modal-header">
                    <button className="notif-modal-close-btn" onClick={onClose} aria-label="Close">
                        <FaTimes />
                    </button>

                    <div className="notif-header-center">
                        <div className="notif-header-top-row">
                            <div className="notif-header-icon">
                                <FaBell />
                            </div>
                            <button
                                type="button"
                                className="notif-sound-btn"
                                onClick={() => setSoundEnabled(prev => !prev)}
                                title={soundEnabled ? "Mute notification chime" : "Enable notification chime"}
                            >
                                {soundEnabled ? <FaVolumeUp /> : <FaVolumeMute />}
                            </button>
                        </div>

                        <h2 className="notif-modal-title">
                            {effectiveRole === 'admin'
                                ? 'Admin Notification & Security Center'
                                : effectiveRole === 'lecturer'
                                ? 'Faculty Audit Logs & Class Updates'
                                : 'Student Notifications & Activity Feed'}
                        </h2>

                        <p className="notif-modal-subtitle">
                            {unreadCount > 0
                                ? `${unreadCount} unread notification(s) • Real-time synchronization active`
                                : 'Real-time alert stream for security, attendance, and system updates'}
                        </p>

                        {/* Top Global Action Bar */}
                        <div className="notif-top-actions-bar">
                            {unreadCount > 0 && (
                                <button
                                    type="button"
                                    className="notif-action-btn btn-action-secondary notif-mark-all-btn"
                                    onClick={handleMarkAllRead}
                                    title="Mark all as read"
                                >
                                    <FaCheckDouble /> <span>Mark All Read</span>
                                </button>
                            )}

                            {/* Composer Button for Admins & Lecturers */}
                            {(effectiveRole === 'admin' || effectiveRole === 'lecturer') && (
                                <button
                                    type="button"
                                    className={`notif-action-btn ${activeTab === 'compose' ? 'btn-action-primary' : 'btn-action-outline'}`}
                                    onClick={() => setActiveTab(prev => prev === 'compose' ? 'all' : 'compose')}
                                >
                                    <FaBullhorn /> <span>{activeTab === 'compose' ? 'View Feed' : 'Send Announcement'}</span>
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Filter Tabs & Search Bar (When not in composer tab) */}
                    {activeTab !== 'compose' && (
                        <div className="notif-filter-wrapper">
                            <div className="notif-search-container">
                                <FaSearch className="notif-search-icon" />
                                <input
                                    type="text"
                                    className="notif-search-input"
                                    placeholder="Search by keyword, student roll, title..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                />
                                {searchQuery && (
                                    <button className="notif-search-clear" onClick={() => setSearchQuery('')}>
                                        <FaTimes />
                                    </button>
                                )}
                            </div>

                            <div className="notif-tabs-scroll">
                                <button
                                    type="button"
                                    className={`notif-tab-btn ${activeTab === 'all' ? 'active' : ''}`}
                                    onClick={() => setActiveTab('all')}
                                >
                                    All ({notifications.length})
                                </button>
                                <button
                                    type="button"
                                    className={`notif-tab-btn ${activeTab === 'security' ? 'active' : ''}`}
                                    onClick={() => setActiveTab('security')}
                                >
                                    🚨 Security & Anti-Proxy
                                </button>
                                <button
                                    type="button"
                                    className={`notif-tab-btn ${activeTab === 'attendance' ? 'active' : ''}`}
                                    onClick={() => setActiveTab('attendance')}
                                >
                                    📋 Attendance & Sessions
                                </button>
                                <button
                                    type="button"
                                    className={`notif-tab-btn ${activeTab === 'accounts' ? 'active' : ''}`}
                                    onClick={() => setActiveTab('accounts')}
                                >
                                    👤 Biometrics & Profile
                                </button>
                                <button
                                    type="button"
                                    className={`notif-tab-btn ${activeTab === 'announcements' ? 'active' : ''}`}
                                    onClick={() => setActiveTab('announcements')}
                                >
                                    📢 Announcements
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Feedback Alerts */}
                {successMessage && (
                    <div className="notif-toast-banner toast-success">
                        <FaCheck /> {successMessage}
                    </div>
                )}
                {errorMessage && (
                    <div className="notif-toast-banner toast-error">
                        <FaExclamationTriangle /> {errorMessage}
                    </div>
                )}

                {/* Modal Body */}
                <div className="notif-modal-body">
                    {/* --- COMPOSE ANNOUNCEMENT TAB (Admins & Lecturers) --- */}
                    {activeTab === 'compose' ? (
                        <form className="notif-compose-card" onSubmit={handleSendBroadcast}>
                            <div className="compose-header">
                                <h3><FaBullhorn /> Broadcast Real-Time Notification</h3>
                                <p>Send instant announcements and security alerts to Students, Lecturers, or Administrators.</p>
                            </div>

                            <div className="compose-field">
                                <label>Target Audience</label>
                                <div className="compose-audience-grid">
                                    <label className={`audience-option ${composerForm.targetAudience === 'all' ? 'selected' : ''}`}>
                                        <input
                                            type="radio"
                                            name="targetAudience"
                                            value="all"
                                            checked={composerForm.targetAudience === 'all'}
                                            onChange={(e) => setComposerForm({ ...composerForm, targetAudience: e.target.value })}
                                        />
                                        <FaBullhorn /> Everyone (All Roles)
                                    </label>

                                    <label className={`audience-option ${composerForm.targetAudience === 'student' ? 'selected' : ''}`}>
                                        <input
                                            type="radio"
                                            name="targetAudience"
                                            value="student"
                                            checked={composerForm.targetAudience === 'student'}
                                            onChange={(e) => setComposerForm({ ...composerForm, targetAudience: e.target.value })}
                                        />
                                        <FaUserGraduate /> All Students
                                    </label>

                                    <label className={`audience-option ${composerForm.targetAudience === 'lecturer' ? 'selected' : ''}`}>
                                        <input
                                            type="radio"
                                            name="targetAudience"
                                            value="lecturer"
                                            checked={composerForm.targetAudience === 'lecturer'}
                                            onChange={(e) => setComposerForm({ ...composerForm, targetAudience: e.target.value })}
                                        />
                                        <FaChalkboardTeacher /> All Lecturers
                                    </label>

                                    {effectiveRole === 'admin' && (
                                        <label className={`audience-option ${composerForm.targetAudience === 'admin' ? 'selected' : ''}`}>
                                            <input
                                                type="radio"
                                                name="targetAudience"
                                                value="admin"
                                                checked={composerForm.targetAudience === 'admin'}
                                                onChange={(e) => setComposerForm({ ...composerForm, targetAudience: e.target.value })}
                                            />
                                            <FaUserShield /> Admins Only
                                        </label>
                                    )}

                                    <label className={`audience-option ${composerForm.targetAudience === 'specific' ? 'selected' : ''}`}>
                                        <input
                                            type="radio"
                                            name="targetAudience"
                                            value="specific"
                                            checked={composerForm.targetAudience === 'specific'}
                                            onChange={(e) => setComposerForm({ ...composerForm, targetAudience: e.target.value })}
                                        />
                                        <FaUserEdit /> Specific Student
                                    </label>
                                </div>
                            </div>

                            {composerForm.targetAudience === 'specific' && (
                                <div className="compose-field">
                                    <label>Student Roll Number</label>
                                    <input
                                        type="text"
                                        placeholder="e.g. 21B01A0501"
                                        value={composerForm.specificRoll}
                                        onChange={(e) => setComposerForm({ ...composerForm, specificRoll: e.target.value })}
                                        required
                                    />
                                </div>
                            )}

                            <div className="compose-field">
                                <label>Notification Category</label>
                                <select
                                    value={composerForm.urgency}
                                    onChange={(e) => setComposerForm({ ...composerForm, urgency: e.target.value })}
                                >
                                    <option value="GENERAL_NOTICE">📢 General Notice</option>
                                    <option value="SECURITY_ALERT">🚨 Urgent Security Alert</option>
                                    <option value="CLASS_UPDATE">📚 Class / Academic Update</option>
                                    <option value="SYSTEM_UPDATE">⚙️ System Maintenance</option>
                                </select>
                            </div>

                            <div className="compose-field">
                                <label>Notification Subject / Title</label>
                                <input
                                    type="text"
                                    placeholder="e.g. Mandatory Attendance Policy Update"
                                    value={composerForm.title}
                                    onChange={(e) => setComposerForm({ ...composerForm, title: e.target.value })}
                                    required
                                />
                            </div>

                            <div className="compose-field">
                                <label>Detailed Message</label>
                                <textarea
                                    rows="4"
                                    placeholder="Enter full announcement details..."
                                    value={composerForm.message}
                                    onChange={(e) => setComposerForm({ ...composerForm, message: e.target.value })}
                                    required
                                />
                            </div>

                            <div className="compose-actions">
                                <button
                                    type="button"
                                    className="notif-action-btn btn-action-secondary"
                                    onClick={() => setActiveTab('all')}
                                    disabled={sendingBroadcast}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="notif-action-btn btn-action-primary"
                                    disabled={sendingBroadcast}
                                >
                                    {sendingBroadcast ? (
                                        <><FaSpinner className="spin" /> Transmitting...</>
                                    ) : (
                                        <><FaPaperPlane /> Send Broadcast</>
                                    )}
                                </button>
                            </div>
                        </form>
                    ) : (
                        /* --- NOTIFICATIONS FEED LIST --- */
                        filteredNotifications.length === 0 ? (
                            <div className="notif-empty-state">
                                <div className="notif-empty-icon">
                                    <FaInbox />
                                </div>
                                <h3>No Notifications in this Category</h3>
                                <p>
                                    {effectiveRole !== 'student'
                                        ? 'Real-time anti-proxy alerts, attendance updates, and student activity logs will appear here.'
                                        : 'Any updates or actions performed by your Lecturers or Administrators will appear here in real-time.'}
                                </p>
                            </div>
                        ) : (
                            filteredNotifications.map((n) => {
                                const isResetRequest = n.type === 'DEVICE_RESET_REQUEST' || n.metadata?.actionType === 'RESET_DEVICE';
                                const isLoading = actionLoading[n.id];

                                return (
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

                                        {/* Metadata banner if present */}
                                        {n.studentRollNo && (
                                            <div className="notif-meta-pill">
                                                <FaUserGraduate /> Student Roll: <strong>{n.studentRollNo}</strong>
                                            </div>
                                        )}

                                        <div className="notif-item-actions">
                                            <span className="notif-sender-pill">
                                                Sent by <strong>{n.senderName || 'System'}</strong>
                                            </span>

                                            <div className="notif-item-btns">
                                                {/* 1-Click Action Button: Approve Student Device Reset (Faculty & Admin) */}
                                                {(effectiveRole === 'admin' || effectiveRole === 'lecturer') && isResetRequest && (
                                                    <button
                                                        type="button"
                                                        className="notif-action-btn btn-action-approve"
                                                        disabled={isLoading}
                                                        onClick={() => handleApproveDeviceReset(n)}
                                                        title="1-Click Approve and Reset Device Lock for this student"
                                                    >
                                                        {isLoading ? (
                                                            <><FaSpinner className="spin" /> Approving...</>
                                                        ) : (
                                                            <><FaMobileAlt /> Approve Device Reset</>
                                                        )}
                                                    </button>
                                                )}

                                                {/* Actionable Button: Device Reset (Student) */}
                                                {effectiveRole === 'student' && n.type === 'DEVICE_RESET' && onOpenDeviceModal && (
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
                                                {effectiveRole === 'student' && n.type === 'BIOMETRICS_CLEARED' && onOpenFaceModal && (
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

                                                {/* Mark Read */}
                                                {!n.read && (
                                                    <button
                                                        type="button"
                                                        className="notif-action-btn btn-action-secondary"
                                                        onClick={() => handleRead(n.id)}
                                                        title="Mark as read"
                                                    >
                                                        <FaCheck /> Dismiss
                                                    </button>
                                                )}

                                                {/* Delete Notification */}
                                                <button
                                                    type="button"
                                                    className="notif-delete-btn"
                                                    onClick={() => handleDelete(n.id)}
                                                    title="Delete notification"
                                                >
                                                    <FaTrashAlt />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })
                        )
                    )}
                </div>
            </div>
        </div>
    );
}

export default NotificationHistoryModal;
