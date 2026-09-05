import {
    FaCog, FaHome,
    FaGraduationCap,
    FaSignOutAlt,
    FaUser,
    FaTimes,
    FaBookOpen
} from "react-icons/fa";
import { MdQrCodeScanner, MdLogout } from "react-icons/md";
import { BsBarChart } from "react-icons/bs";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../authcontext";
import "./Sidebar.css";

function Sidebar({ hidden, onClose }) {
    const { logoutUser } = useAuth();
    const location = useLocation();

    const menu = [
        { icon: <FaHome />, text: "Dashboard", path: "/student" },
        { icon: <FaBookOpen />, text: "My Courses", path: "/student/courses" },
        { icon: <MdQrCodeScanner />, text: "Mark Attendance", path: "/student/mark-attendance" },
        { icon: <BsBarChart />, text: "My Attendance", path: "/student/statistics" },
        { icon: <FaCog />, text: "Settings", path: "/student/settings" },
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
                                item.path === "/student"
                                    ? (location.pathname === "/student" || location.pathname === "/student/" ? "active" : "")
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