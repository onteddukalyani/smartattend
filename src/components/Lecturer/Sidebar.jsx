import {
    FaCog,
    FaSignOutAlt,
    FaGraduationCap,
} from "react-icons/fa";
import { IoQrCodeOutline } from "react-icons/io5";
import { SiGoogleclassroom } from "react-icons/si";
import "./Sidebar.css";
import { RiDashboardFill } from "react-icons/ri";
import { FaTimes } from "react-icons/fa";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../authcontext";

function Sidebar({ hidden, onClose }) {
    const { logoutUser } = useAuth();
    const location = useLocation();

    const menu = [
        { icon: <RiDashboardFill />, text: "Dashboard", path: "/lecturer" },
        { icon: <IoQrCodeOutline />, text: "New Session", path: '/lecturer/lecturerpage' },
        { icon: <SiGoogleclassroom />, text: "Classes", path: "/lecturer/attendance-sessions" },
        { icon: <FaCog />, text: "Settings", path: "/lecturer/settings" }
    ];

    return (
        <aside className={`sidebar ${hidden ? "hidden" : ""}`}>

            <div className="sidebar-top">

                <div className="logo">
                    <FaGraduationCap className="logo-icon" />
                    <h2>SmartAttend</h2>

                    {/* Mobile close button */}
                    <button
                        className="mobile-close-btn"
                        onClick={onClose}
                        aria-label="Close sidebar"
                    >
                        <FaTimes />
                    </button>
                </div>

                <ul className="menu">
                    {menu.map((item, index) => (
                        <li
                            key={index}
                            className={
                                item.path === "/lecturer"
                                    ? (location.pathname === "/lecturer" || location.pathname === "/lecturer/" ? "active" : "")
                                    : (location.pathname.startsWith(item.path) ? "active" : "")
                            }
                        >
                            <Link to={item.path}>
                                <span className="menu-icon">
                                    {item.icon}
                                </span>
                                {item.text}
                            </Link>
                        </li>
                    ))}
                </ul>

            </div>

            <button
                className="logout"
                type="button"
                onClick={logoutUser}
            >
                <FaSignOutAlt />
                Logout
            </button>

        </aside>
    );
}

export default Sidebar;