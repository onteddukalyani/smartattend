import React from "react";
import { Link, useLocation } from "react-router-dom";
import { FaHome, FaCog, FaBookOpen } from "react-icons/fa";
import { MdQrCodeScanner } from "react-icons/md";
import { BsBarChart } from "react-icons/bs";
import "./BottomNav.css";

function BottomNav() {
    const location = useLocation();

    const items = [
        { path: "/student", text: "Home", icon: <FaHome />, end: true },
        { path: "/student/courses", text: "Courses", icon: <FaBookOpen /> },
        { path: "/student/mark-attendance", text: "Scan QR", icon: <MdQrCodeScanner />, isElevated: true },
        { path: "/student/statistics", text: "Attendance", icon: <BsBarChart />, end: true },
        { path: "/student/settings", text: "Settings", icon: <FaCog /> }
    ];

    return (
        <nav className="bottom-nav student-bottom-nav">
            <div className="bottom-nav-container">
                {items.map((item, index) => {
                    const isActive = item.end
                        ? location.pathname === item.path
                        : location.pathname.startsWith(item.path);

                    return (
                        <Link
                            to={item.path}
                            className={`bottom-nav-item ${isActive ? "active" : ""} ${item.isElevated ? "elevated" : ""}`}
                            key={index}
                            aria-label={item.text}
                        >
                            <div className="bottom-nav-icon-wrap">
                                {item.icon}
                            </div>
                            <span className="bottom-nav-label">{item.text}</span>
                            {isActive && !item.isElevated && <span className="bottom-nav-active-pill" />}
                        </Link>
                    );
                })}
            </div>
        </nav>
    );
}

export default BottomNav;