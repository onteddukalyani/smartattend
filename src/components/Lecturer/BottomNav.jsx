import "./BottomNav.css";
import {
    FaHome,
    FaUser,
    FaBook,
    FaCog,
} from "react-icons/fa";
import { Link, useLocation } from "react-router-dom";
function BottomNav() {
    const location = useLocation();
    return (
        <div className="bottom-nav">
            <div className={`nav-item ${location.pathname === "/lecturer" || location.pathname === "/lecturer/" ? "active" : ""}`}>
                <Link to="/lecturer" className="menu-link">
                    <div className="bottomicons"><FaHome />
                        <span>Home</span></div>
                </Link>
            </div>

            <div className={`nav-item ${location.pathname.startsWith("/lecturer/attendance-sessions") ? "active" : ""}`}>
                <Link to="/lecturer/attendance-sessions" className="menu-link">
                    <div className="bottomicons">
                        <FaBook />
                        <span>Courses</span>
                    </div>
                </Link>
            </div>

            <div className={`nav-item ${location.pathname === "/lecturer/settings" ? "active" : ""}`}>
                <Link to="/lecturer/settings" className="menu-link">
                    <div className="bottomicons">
                        <FaCog />
                        <span>Settings</span>
                    </div>
                </Link>
            </div>
        </div>
    );
}

export default BottomNav;