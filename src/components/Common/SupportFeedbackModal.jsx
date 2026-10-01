import React, { useEffect } from "react";
import { FaTimes } from "react-icons/fa";
import SupportFeedbackContent from "./SupportFeedbackContent";
import "./SupportFeedback.css";

export default function SupportFeedbackModal({ isOpen, onClose, defaultTab = "feedback" }) {
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        onClose?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="sf-modal-overlay" onClick={onClose}>
      <div className="sf-modal-box" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="sf-modal-close-btn"
          onClick={onClose}
          aria-label="Close modal"
        >
          <FaTimes />
        </button>
        <SupportFeedbackContent defaultTab={defaultTab} isModal={true} onClose={onClose} />
      </div>
    </div>
  );
}
