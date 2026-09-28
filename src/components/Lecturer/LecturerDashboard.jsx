import { useState, useEffect } from 'react'
import { Outlet } from "react-router-dom";
import { useAuth } from '../authcontext';
import Navbar from './Navbar';
import BottomNav from './BottomNav'
import Sidebar from './Sidebar'
import Login from '../login';
import { RoleFirstLoginGuide } from '../Common/DeviceSetupPage';
import NotificationHistoryModal from '../Student/NotificationHistoryModal';
import { subscribeToFacultyNotifications } from '../../services/notificationsService';

function LecturerDashboard() {
  const [sidebarHidden, setSidebarHidden] = useState(window.innerWidth <= 800);
  const { user, profile } = useAuth();
  const [facultyNotifs, setFacultyNotifs] = useState([]);
  const [showNotifModal, setShowNotifModal] = useState(false);

  useEffect(() => {
    const unsub = subscribeToFacultyNotifications((newNotifs) => {
      setFacultyNotifs(newNotifs || []);
    }, "lecturer");
    return () => unsub();
  }, []);

  const unreadCount = facultyNotifs.filter(n => !n.read).length;

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
      <RoleFirstLoginGuide role={profile?.role || "lecturer"} basePath="/lecturer" />

      {/* Faculty & Admin Audit Logs Modal */}
      <NotificationHistoryModal
        isOpen={showNotifModal}
        onClose={() => setShowNotifModal(false)}
        notifications={facultyNotifs}
        isFaculty={true}
        role="lecturer"
        currentUser={user}
      />
    </div>
  )
}

export default LecturerDashboard;