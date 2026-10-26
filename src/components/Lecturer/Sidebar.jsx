import {
    FaHome,
    FaCog,
    FaSignOutAlt,
    FaGraduationCap,
    FaBookOpen,
    FaUserGraduate,
    FaUserShield,
    FaChalkboardTeacher,
    FaHeadset,
} from "react-icons/fa";
import { IoQrCodeOutline } from "react-icons/io5";
import { SiGoogleclassroom } from "react-icons/si";
import "./Sidebar.css";
import { FaTimes } from "react-icons/fa";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../authcontext";

function Sidebar({ hidden, onClose }) {
    const { logoutUser } = useAuth();
    const location = useLocation();

    const menu = [
        { icon: <FaHome />, text: "Dashboard", path: "/lecturer" },
        { icon: <IoQrCodeOutline />, text: "Launch Session QR", path: '/lecturer/lecturerpage' },
        { icon: <SiGoogleclassroom />, text: "Classes & Sessions", path: "/lecturer/attendance-sessions" },
        { icon: <FaBookOpen />, text: "My Courses", path: "/lecturer/courses" },
        { icon: <FaUserGraduate />, text: "Students Directory", path: "/lecturer/students" },
        { icon: <FaHeadset />, text: "Help & Support", path: "/lecturer/support" },
        { icon: <FaCog />, text: "Settings", path: "/lecturer/settings" }
    ];

    const handleLinkClick = () => {
        if (window.innerWidth <= 800 && onClose) {
            onClose();
        }
    };

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
                            <Link to={item.path} onClick={handleLinkClick}>
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