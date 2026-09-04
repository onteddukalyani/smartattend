import { useState } from 'react'
import { Outlet } from "react-router-dom";
import { useAuth } from '../authcontext';
import Navbar from './Navbar';
import BottomNav from './BottomNav'
import Sidebar from './Sidebar'
import Login from '../login';

function LecturerDashboard() {
  const [sidebarHidden, setSidebarHidden] = useState(window.innerWidth <= 800);
  const { user } = useAuth();

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
        />
        <Outlet />
      </div>
      <BottomNav />
    </div>
  )
}

export default LecturerDashboard;