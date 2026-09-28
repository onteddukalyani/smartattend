import { useState, useEffect } from 'react';
import { Outlet } from "react-router-dom";
import { useAuth } from '../authcontext';
import Navbar from './Navbar';
import Sidebar from './Sidebar';
import BottomNav from './BottomNav';
import Login from '../login';
import NotificationHistoryModal from './NotificationHistoryModal';
import DeviceOnboardingModal from './DeviceOnboardingModal';
import { subscribeToStudentNotifications } from '../../services/notificationsService';

function StudentDashboard() {
    const [sidebarHidden, setSidebarHidden] = useState(window.innerWidth <= 800);
    const { user, profile } = useAuth();
    const [notifications, setNotifications] = useState([]);
    const [showNotifModal, setShowNotifModal] = useState(false);
    const [showDeviceModal, setShowDeviceModal] = useState(false);

    const emailRoll = (user?.email || "").split("@")[0].trim().toUpperCase();
    const activeRollNo = (profile?.rollNo || emailRoll || "").trim().toUpperCase();

    // Subscribe to real-time notifications for the active student
    useEffect(() => {
        if (!activeRollNo) return;
        const unsub = subscribeToStudentNotifications(activeRollNo, (newNotifs) => {
            setNotifications(newNotifs || []);
        });
        return () => unsub();
    }, [activeRollNo]);

    const unreadCount = notifications.filter(n => !n.read).length;

    if (!user) {
        return <Login />;
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
        </div>
    );
}

export default StudentDashboard;