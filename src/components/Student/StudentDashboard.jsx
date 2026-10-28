import { useState, useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from '../authcontext';
import Navbar from './Navbar';
import Sidebar from './Sidebar';
import BottomNav from './BottomNav';
import Login from '../login';
import NotificationHistoryModal from './NotificationHistoryModal';
import DeviceOnboardingModal from './DeviceOnboardingModal';
import HelpSupportWidget from '../Common/HelpSupportWidget';
import { subscribeToStudentNotifications } from '../../services/notificationsService';
import { setGlobalVariable, getGlobalVariable } from '../../utils/globalState';

function StudentDashboard() {
    const [sidebarHidden, setSidebarHidden] = useState(window.innerWidth <= 800);
    const { user, profile } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();
    const [notifications, setNotifications] = useState([]);
    const [showNotifModal, setShowNotifModal] = useState(false);
    const [showDeviceModal, setShowDeviceModal] = useState(false);

    // Kiosk Supervision State: When student scanned QR 1, they are locked under the lecturer's session
    const [isKioskActive, setIsKioskActive] = useState(() => {
        try {
            const raw = localStorage.getItem('smartattend_kiosk_session_state');
            if (!raw) return false;
            const parsed = JSON.parse(raw);
            return Boolean(parsed?.sessionId && (parsed?.kioskEndsAt > Date.now() || parsed?.autoReleaseAt > Date.now()) && parsed?.scanState !== 'IDLE');
        } catch (_) {
            return false;
        }
    });

    useEffect(() => {
        const checkKiosk = () => {
            try {
                const raw = localStorage.getItem('smartattend_kiosk_session_state');
                if (!raw) {
                    setIsKioskActive(false);
                    return;
                }
                const parsed = JSON.parse(raw);
                const active = Boolean(
                    parsed?.sessionId &&
                    (parsed?.kioskEndsAt > Date.now() || parsed?.autoReleaseAt > Date.now()) &&
                    (
                        parsed?.scanState === 'KIOSK_WAITING_QR2' ||
                        parsed?.scanState === 'VALIDATING_QR2' ||
                        parsed?.scanState === 'BIOMETRIC_SCAN' ||
                        parsed?.scanState === 'SUBMITTING_ATTENDANCE'
                    )
                );
                setIsKioskActive(active);

                if (active) {
                    const currentPath = (location.pathname || '').toLowerCase();
                    if (!currentPath.includes('mark-attendance') && !currentPath.includes('scanqr')) {
                        console.log('[StudentDashboard] Student is locked under lecturer session. Redirecting to mark-attendance.');
                        navigate('/student/mark-attendance', { replace: true });
                    }
                }
            } catch (_) {
                setIsKioskActive(false);
            }
        };

        checkKiosk();
        const interval = setInterval(checkKiosk, 1200);
        window.addEventListener('storage', checkKiosk);
        return () => {
            clearInterval(interval);
            window.removeEventListener('storage', checkKiosk);
        };
    }, [location.pathname, navigate]);

    const emailRoll = (user?.email || "").split("@")[0].trim().toUpperCase();
    const activeRollNo = (profile?.rollNo || emailRoll || "").trim().toUpperCase();
    const cleanEmail = (user?.email || "").toLowerCase().trim();

    // Subscribe to real-time notifications for the active student
    useEffect(() => {
        if (!activeRollNo && !cleanEmail) return;
        const unsub = subscribeToStudentNotifications(activeRollNo, (newNotifs) => {
            setNotifications(newNotifs || []);
        }, cleanEmail);

        const handleOpenModal = () => setShowNotifModal(true);
        window.addEventListener("smartattend:open_notification_modal", handleOpenModal);

        return () => {
            unsub();
            window.removeEventListener("smartattend:open_notification_modal", handleOpenModal);
        };
    }, [activeRollNo, cleanEmail]);

    // Auto-prompt device selection if student hasn't chosen Android or iPhone yet (skip entirely if already locked)
    useEffect(() => {
        if (!user) return;
        const isDeviceLocked = Boolean(
            getGlobalVariable('isDeviceLocked') === true ||
            profile?.deviceTypeLocked === true ||
            profile?.isDeviceRegistered === true ||
            localStorage.getItem('smartattend_student_device_locked') === 'true' ||
            localStorage.getItem('smartattend_device_locked') === 'true' ||
            profile?.deviceType ||
            profile?.registeredDeviceType ||
            localStorage.getItem('smartattend_student_device_type') ||
            localStorage.getItem('smartattend_device_type')
        );

        if (isDeviceLocked) {
            setGlobalVariable('isDeviceLocked', true);
            setShowDeviceModal(false);
            return;
        }

        const alreadyPrompted = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('smartattend_device_prompted') : null;
        if (!alreadyPrompted) {
            try { sessionStorage.setItem('smartattend_device_prompted', 'true'); } catch (_) { }
            setShowDeviceModal(true);
        }
    }, [user, profile?.deviceType, profile?.registeredDeviceType, profile?.deviceTypeLocked, profile?.isDeviceRegistered]);

    const unreadCount = notifications.filter(n => !n.read).length;

    if (!user) {
        return <Login />;
    }

    // When student is in an active session under the lecturer's supervision, render strictly full-screen Kiosk view
    if (isKioskActive) {
        return (
            <div className='app kiosk-supervised-fullscreen' style={{ minHeight: '100vh', width: '100vw', margin: 0, padding: 0 }}>
                <Outlet />
            </div>
        );
    }

    return (
        <div className='app'>
            <Sidebar
                hidden={sidebarHidden}
                onClose={() => setSidebarHidden(true)}
            />
            <div className='app-content'>
                <Navbar
                    sidebarHidden={sidebarHidden}
                    onMenuClick={() => setSidebarHidden((hidden) => !hidden)}
                    unreadCount={unreadCount}
                    onNotifClick={() => setShowNotifModal(true)}
                />
                <Outlet />
            </div>
            <BottomNav />

            {/* Global Real-Time Notification History & Audit Log Modal */}
            <NotificationHistoryModal
                isOpen={showNotifModal}
                onClose={() => setShowNotifModal(false)}
                notifications={notifications}
                studentRollNo={activeRollNo}
                role="student"
                currentUser={user}
                onOpenDeviceModal={() => setShowDeviceModal(true)}
            />

            {/* Global Device Setup Modal */}
            <DeviceOnboardingModal
                isOpen={showDeviceModal}
                onClose={() => setShowDeviceModal(false)}
            />

            {/* Quick Floating Support & Feedback Widget */}
            <HelpSupportWidget />
        </div>
    );
}

export default StudentDashboard;
