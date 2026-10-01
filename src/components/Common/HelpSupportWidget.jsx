import React, { useState } from "react";
import { FaHeadset, FaCommentDots, FaBug } from "react-icons/fa";
import SupportFeedbackModal from "./SupportFeedbackModal";
import "./SupportFeedback.css";

export default function HelpSupportWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [defaultTab, setDefaultTab] = useState("feedback");

  const handleOpen = (tab = "feedback") => {
    setDefaultTab(tab);
    setIsOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className="sf-floating-btn"
        onClick={() => handleOpen("feedback")}
        title="Support, Feedback & Issue Helpdesk"
        aria-label="Open support and feedback dialog"
      >
        <div className="sf-floating-pulse" />
        <FaHeadset style={{ fontSize: "1.1rem" }} />
        <span>Help &amp; Feedback</span>
      </button>

      <SupportFeedbackModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        defaultTab={defaultTab}
      />
    </>
  );
}
