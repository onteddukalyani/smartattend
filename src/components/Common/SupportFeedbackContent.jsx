import React, { useState, useEffect, Component } from "react";
import {
  FaCommentDots,
  FaBug,
  FaHeadset,
  FaTicketAlt,
  FaStar,
  FaRegStar,
  FaCheckCircle,
  FaExclamationTriangle,
  FaPaperPlane,
  FaCopy,
  FaCheck,
  FaPhoneAlt,
  FaEnvelope,
  FaMapMarkerAlt,
  FaClock,
  FaCamera,
  FaTrashAlt,
  FaSearch,
  FaSpinner,
  FaTimes,
  FaChevronDown,
  FaReply,
  FaMobileAlt,
  FaShieldAlt,
  FaSync
} from "react-icons/fa";
import { useAuth } from "../authcontext";
import {
  submitSupportTicket,
  subscribeToMyTickets,
  subscribeToAllTickets,
  updateTicketStatus,
  deleteTicket,
  SUPPORT_CONTACTS,
  FREQUENT_QUESTIONS
} from "../../services/feedbackService";
import { detectDeviceType } from "../../utils/deviceDetection";
import "./SupportFeedback.css";

// React Error Boundary for the Support component
class SupportErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.warn("[SupportFeedbackContent] Error boundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="sf-card" style={{ textAlign: "center", padding: "3rem 1.5rem" }}>
          <div className="sf-success-icon" style={{ background: "rgba(239, 68, 68, 0.12)", color: "#ef4444" }}>
            <FaExclamationTriangle />
          </div>
          <h2 className="sf-section-title" style={{ color: "var(--text-main, #0f172a)", marginBottom: "8px" }}>
            Something went wrong loading support
          </h2>
          <p className="sf-section-desc" style={{ marginBottom: "20px" }}>
            We encountered an unexpected error. Please refresh or try again.
          </p>
          <button
            type="button"
            className="sf-btn-primary"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            <FaSync /> Reload Portal
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const FEEDBACK_CATEGORIES = [
  "General Experience",
  "Attendance & QR Scanner",
  "Face Recognition",
  "UI & Visual Design",
  "Courses & Timetable",
  "App Performance",
  "Feature Request",
  "Other"
];

const ISSUE_CATEGORIES = [
  "Camera / QR Scanner Error",
  "Face Verification Failed",
  "Location / GPS Geofence Mismatch",
  "Device Lock / Registration Issue",
  "Attendance Record Mismatch",
  "Course / Timetable Issue",
  "App Crash / Blank Screen",
  "Other Technical Glitch"
];

const QUICK_SENTIMENTS = [
  "Super fast & easy! 🚀",
  "Love the dark mode aesthetic ✨",
  "Face recognition was smooth 😊",
  "QR scanning needs better lighting tips 💡",
  "Please add attendance percentage calculator 📊",
  "Session notifications are helpful 🔔"
];

const RATING_LABELS = {
  1: "Needs Improvement 😕",
  2: "Fair, has room to grow 😐",
  3: "Good & Reliable 🙂",
  4: "Very Good & Smooth! 😄",
  5: "Outstanding Experience! 🌟"
};

function SupportFeedbackMain({ defaultTab = "feedback", isModal = false, onClose }) {
  const { user, profile } = useAuth();
  const rawRole = (profile?.role || "student").toLowerCase();
  const isAdmin = rawRole === "admin" || rawRole === "administrator" || rawRole === "superadmin";

  const [activeTab, setActiveTab] = useState(defaultTab);
  const [copiedId, setCopiedId] = useState("");

  // Quick Stats
  const [myTickets, setMyTickets] = useState([]);
  const [allTickets, setAllTickets] = useState([]);

  // ==========================================
  // TAB 1: FEEDBACK STATE
  // ==========================================
  const [fbRating, setFbRating] = useState(5);
  const [fbHoverRating, setFbHoverRating] = useState(0);
  const [fbCategory, setFbCategory] = useState("General Experience");
  const [fbTitle, setFbTitle] = useState("");
  const [fbDescription, setFbDescription] = useState("");
  const [fbSubmitting, setFbSubmitting] = useState(false);
  const [fbSuccessTicket, setFbSuccessTicket] = useState(null);
  const [fbError, setFbError] = useState("");

  // ==========================================
  // TAB 2: ISSUE REPORT STATE
  // ==========================================
  const [issueCategory, setIssueCategory] = useState("Camera / QR Scanner Error");
  const [issuePriority, setIssuePriority] = useState("medium");
  const [issueTitle, setIssueTitle] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [issueImage, setIssueImage] = useState(null);
  const [issueSubmitting, setIssueSubmitting] = useState(false);
  const [issueSuccessTicket, setIssueSuccessTicket] = useState(null);
  const [issueError, setIssueError] = useState("");
  const [detectedType, setDetectedType] = useState("web");

  // ==========================================
  // TAB 3: CONTACT & FAQ STATE
  // ==========================================
  const [faqSearch, setFaqSearch] = useState("");
  const [openFaqId, setOpenFaqId] = useState("faq-qr");
  const [contactSubject, setContactSubject] = useState("");
  const [contactMessage, setContactMessage] = useState("");
  const [contactSending, setContactSending] = useState(false);
  const [contactSuccess, setContactSuccess] = useState(false);

  // ==========================================
  // TAB 4 & 5: TICKETS & ADMIN DESK STATE
  // ==========================================
  const [ticketSearch, setTicketSearch] = useState("");
  const [ticketStatusFilter, setTicketStatusFilter] = useState("all");
  const [ticketTypeFilter, setTicketTypeFilter] = useState("all");

  // Admin Reply Modal
  const [replyTicket, setReplyTicket] = useState(null);
  const [replyText, setReplyText] = useState("");
  const [replyStatus, setReplyStatus] = useState("resolved");
  const [replySaving, setReplySaving] = useState(false);

  const studentRoll = profile?.rollNo || (user?.email ? user.email.split("@")[0].toUpperCase() : "");

  // Auto-detect device specs on mount
  useEffect(() => {
    try {
      setDetectedType(detectDeviceType() || "web");
    } catch (_) {
      setDetectedType("web");
    }
  }, []);

  // Synchronize incoming defaultTab prop
  useEffect(() => {
    if (defaultTab) {
      setActiveTab(defaultTab);
    }
  }, [defaultTab]);

  // Real-time Subscriptions with graceful error handling
  useEffect(() => {
    const userKey = user?.uid || user?.email || studentRoll || "anonymous";

    const unsubMy = subscribeToMyTickets(userKey, (tickets) => {
      setMyTickets(Array.isArray(tickets) ? tickets : []);
    });

    let unsubAll = () => { };
    if (isAdmin) {
      unsubAll = subscribeToAllTickets((tickets) => {
        setAllTickets(Array.isArray(tickets) ? tickets : []);
      });
    }

    return () => {
      if (typeof unsubMy === "function") unsubMy();
      if (typeof unsubAll === "function") unsubAll();
    };
  }, [user, studentRoll, isAdmin]);

  // Copy Ticket ID helper
  const handleCopy = (text, key) => {
    if (!text) return;
    try {
      navigator.clipboard.writeText(text);
      setCopiedId(key || text);
      setTimeout(() => setCopiedId(""), 2200);
    } catch (_) { }
  };

  // Image file handler for issue screenshot
  const handleImageSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setIssueError("Please select a valid screenshot image file (PNG, JPG, WEBP).");
      setTimeout(() => setIssueError(""), 3500);
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setIssueError("Image size should be under 5 MB.");
      setTimeout(() => setIssueError(""), 3500);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setIssueImage(reader.result);
    };
    reader.readAsDataURL(file);
  };

  // ==========================================
  // SUBMIT FEEDBACK
  // ==========================================
  const handleSubmitFeedback = async (e) => {
    e?.preventDefault();
    if (!fbDescription.trim()) {
      setFbError("Please write a few words about your experience.");
      return;
    }

    setFbSubmitting(true);
    setFbError("");

    try {
      const payload = {
        type: "feedback",
        category: fbCategory,
        rating: fbRating,
        title: fbTitle.trim() || `${fbCategory} Feedback (${fbRating} Stars)`,
        description: fbDescription.trim(),
        priority: "low",
        submittedBy: {
          uid: user?.uid,
          email: user?.email,
          rollNo: studentRoll,
          name: profile?.name || user?.displayName || studentRoll || "User",
          role: rawRole,
          department: profile?.department || profile?.branch || ""
        }
      };

      const res = await submitSupportTicket(payload);
      if (res.success) {
        setFbSuccessTicket(res.ticket);
        setFbTitle("");
        setFbDescription("");
      }
    } catch (err) {
      setFbError(err.message || "Failed to submit feedback. Please try again.");
    } finally {
      setFbSubmitting(false);
    }
  };

  // ==========================================
  // SUBMIT ISSUE REPORT
  // ==========================================
  const handleSubmitIssue = async (e) => {
    e?.preventDefault();
    if (!issueDescription.trim()) {
      setIssueError("Please describe the problem you encountered.");
      return;
    }

    setIssueSubmitting(true);
    setIssueError("");

    try {
      const payload = {
        type: "issue",
        category: issueCategory,
        priority: issuePriority,
        title: issueTitle.trim() || `Bug Report: ${issueCategory}`,
        description: issueDescription.trim(),
        attachmentUrl: issueImage,
        submittedBy: {
          uid: user?.uid,
          email: user?.email,
          rollNo: studentRoll,
          name: profile?.name || user?.displayName || studentRoll || "User",
          role: rawRole,
          department: profile?.department || profile?.branch || ""
        }
      };

      const res = await submitSupportTicket(payload);
      if (res.success) {
        setIssueSuccessTicket(res.ticket);
        setIssueTitle("");
        setIssueDescription("");
        setIssueImage(null);
      }
    } catch (err) {
      setIssueError(err.message || "Failed to submit issue ticket. Please try again.");
    } finally {
      setIssueSubmitting(false);
    }
  };

  // ==========================================
  // SEND DIRECT QUICK CONTACT MESSAGE
  // ==========================================
  const handleSendContactMessage = async (e) => {
    e?.preventDefault();
    if (!contactMessage.trim()) return;

    setContactSending(true);
    try {
      await submitSupportTicket({
        type: "inquiry",
        category: "Campus Helpdesk Inquiry",
        title: contactSubject.trim() || "General Helpdesk Inquiry",
        description: contactMessage.trim(),
        priority: "medium",
        submittedBy: {
          uid: user?.uid,
          email: user?.email,
          rollNo: studentRoll,
          name: profile?.name || user?.displayName || studentRoll || "User",
          role: rawRole,
          department: profile?.department || ""
        }
      });
      setContactSuccess(true);
      setContactSubject("");
      setContactMessage("");
    } catch (_) {
      setContactSuccess(true);
    } finally {
      setContactSending(false);
    }
  };

  // ==========================================
  // ADMIN ACTIONS
  // ==========================================
  const handleSaveAdminReply = async (e) => {
    e?.preventDefault();
    if (!replyTicket) return;

    setReplySaving(true);
    try {
      await updateTicketStatus(replyTicket.id, {
        status: replyStatus,
        adminResponse: replyText,
        resolvedBy: profile?.name || user?.displayName || "Administrator"
      });
      setReplyTicket(null);
      setReplyText("");
    } catch (_) {
    } finally {
      setReplySaving(false);
    }
  };

  const handleQuickStatusChange = async (ticketId, newStatus) => {
    await updateTicketStatus(ticketId, {
      status: newStatus,
      resolvedBy: profile?.name || "Administrator"
    });
  };

  const handleDeleteTicket = async (ticketId) => {
    if (window.confirm("Are you sure you want to delete this ticket?")) {
      await deleteTicket(ticketId);
    }
  };

  // Safe phone/contact fallbacks
  const safeHelpline = SUPPORT_CONTACTS.helpline || "+91 98765 43210";
  const safeUrgentHelpline = SUPPORT_CONTACTS.urgentHelpline || "+91 98765 43211";
  const safeEmail = SUPPORT_CONTACTS.email || "support@smartattend.campus.edu";
  const safeOffice = SUPPORT_CONTACTS.officeLocation || "CS & IT Block, Room 204";

  // Filtered lists for My Tickets and Admin Desk
  const targetList = isAdmin && activeTab === "adminDesk" ? allTickets : myTickets;
  const filteredTickets = (targetList || []).filter((t) => {
    if (!t) return false;
    const matchSearch =
      !ticketSearch ||
      t.title?.toLowerCase().includes(ticketSearch.toLowerCase()) ||
      t.description?.toLowerCase().includes(ticketSearch.toLowerCase()) ||
      t.id?.toLowerCase().includes(ticketSearch.toLowerCase()) ||
      t.submittedBy?.name?.toLowerCase().includes(ticketSearch.toLowerCase()) ||
      t.submittedBy?.rollNo?.toLowerCase().includes(ticketSearch.toLowerCase());

    const matchStatus = ticketStatusFilter === "all" || t.status === ticketStatusFilter;
    const matchType = ticketTypeFilter === "all" || t.type === ticketTypeFilter;

    return matchSearch && matchStatus && matchType;
  });

  const openTicketsCount = (targetList || []).filter((t) => t && t.status === "open").length;
  const resolvedTicketsCount = (targetList || []).filter((t) => t && t.status === "resolved").length;

  // Filtered FAQs
  const filteredFaqs = FREQUENT_QUESTIONS.filter((f) => {
    if (!faqSearch.trim()) return true;
    const q = faqSearch.toLowerCase();
    return (
      f.question.toLowerCase().includes(q) ||
      f.answer.toLowerCase().includes(q) ||
      f.category.toLowerCase().includes(q)
    );
  });

  return (
    <div className="sf-page-container">
      {/* Hero Banner */}
      <div className="sf-hero-banner">
        <div className="sf-hero-left">
          <div className="sf-hero-tag">
            <FaHeadset /> SmartAttend Help &amp; Grievance Desk
          </div>
          <h1 className="sf-hero-title">Support, Feedback &amp; Issue Portal</h1>
          <p className="sf-hero-subtitle">
            Need assistance with attendance scanning, have a suggestion for improving SmartAttend, or encountered a technical issue? Submit your request below for prompt resolution.
          </p>
        </div>

        <div className="sf-hero-quick-stats">
          <div className="sf-stat-pill">
            <span className="sf-stat-num">{myTickets.length}</span>
            <span className="sf-stat-lbl">My Tickets</span>
          </div>
          <div className="sf-stat-pill">
            <span className="sf-stat-num" style={{ color: "#a7f3d0" }}>
              {resolvedTicketsCount}
            </span>
            <span className="sf-stat-lbl">Resolved</span>
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="sf-tabs-nav">
        <button
          type="button"
          className={`sf-tab-btn ${activeTab === "feedback" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("feedback");
            setFbSuccessTicket(null);
          }}
        >
          <FaCommentDots /> <span>Give Feedback</span>
        </button>

        <button
          type="button"
          className={`sf-tab-btn ${activeTab === "issue" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("issue");
            setIssueSuccessTicket(null);
          }}
        >
          <FaBug /> <span>Report an Issue</span>
        </button>

        <button
          type="button"
          className={`sf-tab-btn ${activeTab === "contact" ? "active" : ""}`}
          onClick={() => setActiveTab("contact")}
        >
          <FaPhoneAlt /> <span>Contact &amp; FAQs</span>
        </button>

        <button
          type="button"
          className={`sf-tab-btn ${activeTab === "tickets" ? "active" : ""}`}
          onClick={() => setActiveTab("tickets")}
        >
          <FaTicketAlt /> <span>My Submissions</span>
          {myTickets.length > 0 && <span className="sf-tab-badge">{myTickets.length}</span>}
        </button>

        {isAdmin && (
          <button
            type="button"
            className={`sf-tab-btn ${activeTab === "adminDesk" ? "active" : ""}`}
            onClick={() => setActiveTab("adminDesk")}
            style={{ marginLeft: "auto", background: activeTab === "adminDesk" ? undefined : "rgba(99, 102, 241, 0.08)" }}
          >
            <FaShieldAlt /> <span>Admin Ticket Desk</span>
            {openTicketsCount > 0 && (
              <span className="sf-tab-badge" style={{ background: "#ef4444", color: "#fff" }}>
                {openTicketsCount} Open
              </span>
            )}
          </button>
        )}
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: GIVE FEEDBACK */}
      {/* ========================================================================= */}
      {activeTab === "feedback" && (
        <div className="sf-card">
          {fbSuccessTicket ? (
            <div className="sf-success-state">
              <div className="sf-success-icon">
                <FaCheckCircle />
              </div>
              <h2 className="sf-success-title">Thank You For Your Feedback!</h2>
              <p className="sf-success-desc">
                Your feedback has been received by our product and administrative team. It helps us continually improve the attendance experience.
              </p>
              <div className="sf-ticket-id-chip">
                <span>Ref ID: {fbSuccessTicket.id}</span>
                <button
                  type="button"
                  onClick={() => handleCopy(fbSuccessTicket.id, "fb_copy")}
                  title="Copy Reference ID"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", display: "inline-flex", alignItems: "center" }}
                >
                  {copiedId === "fb_copy" ? <FaCheck /> : <FaCopy />}
                </button>
              </div>
              <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="sf-btn-primary"
                  onClick={() => setFbSuccessTicket(null)}
                >
                  Submit Another Feedback
                </button>
                <button
                  type="button"
                  className="sf-btn-secondary"
                  onClick={() => setActiveTab("tickets")}
                >
                  View All Submissions
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmitFeedback}>
              <div className="sf-section-header">
                <h2 className="sf-section-title">
                  <FaCommentDots style={{ color: "#6366f1" }} /> Share Your Experience &amp; Suggestions
                </h2>
                <p className="sf-section-desc">
                  Rate your satisfaction with SmartAttend and let us know what you love or what we can enhance.
                </p>
              </div>

              {/* Star Rating */}
              <div className="sf-form-group">
                <label className="sf-label">Overall Satisfaction Rating</label>
                <div className="sf-rating-box">
                  <div className="sf-stars-row">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        className={`sf-star-btn ${(fbHoverRating || fbRating) >= star ? "active" : ""}`}
                        onClick={() => setFbRating(star)}
                        onMouseEnter={() => setFbHoverRating(star)}
                        onMouseLeave={() => setFbHoverRating(0)}
                        title={`${star} Star`}
                      >
                        {(fbHoverRating || fbRating) >= star ? <FaStar /> : <FaRegStar />}
                      </button>
                    ))}
                  </div>
                  <span className="sf-rating-sentiment">{RATING_LABELS[fbHoverRating || fbRating]}</span>
                </div>
              </div>

              {/* Quick Sentiment Chips */}
              <div className="sf-form-group">
                <label className="sf-label">Quick Suggestions &amp; Sentiments</label>
                <div className="sf-chips-grid">
                  {QUICK_SENTIMENTS.map((chip, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="sf-chip-btn"
                      onClick={() => {
                        setFbDescription((prev) => (prev ? `${prev} ${chip}` : chip));
                      }}
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>

              {/* Category */}
              <div className="sf-form-group">
                <label className="sf-label">Topic / Category</label>
                <div className="sf-chips-grid">
                  {FEEDBACK_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      className={`sf-chip-btn ${fbCategory === cat ? "selected" : ""}`}
                      onClick={() => setFbCategory(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Subject Title */}
              <div className="sf-form-group">
                <label className="sf-label">
                  Headline / Title <span className="sf-label-desc">(Optional)</span>
                </label>
                <input
                  type="text"
                  className="sf-input"
                  placeholder="e.g. Great face verification speed, love the recent dark mode!"
                  value={fbTitle}
                  onChange={(e) => setFbTitle(e.target.value)}
                />
              </div>

              {/* Detailed Description */}
              <div className="sf-form-group">
                <label className="sf-label">Detailed Feedback &amp; Suggestions *</label>
                <textarea
                  className="sf-textarea"
                  placeholder="Tell us what you like, or describe any ideas you have to make SmartAttend better..."
                  value={fbDescription}
                  onChange={(e) => setFbDescription(e.target.value)}
                  required
                />
              </div>

              {fbError && (
                <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: "10px", fontSize: "0.85rem", fontWeight: 600, marginBottom: "14px" }}>
                  ⚠️ {fbError}
                </div>
              )}

              <div className="sf-form-footer">
                <button
                  type="submit"
                  className="sf-btn-primary"
                  disabled={fbSubmitting || !fbDescription.trim()}
                >
                  {fbSubmitting ? <FaSpinner className="fa-spin" /> : <FaPaperPlane />}
                  <span>{fbSubmitting ? "Submitting..." : "Submit Feedback"}</span>
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: REPORT AN ISSUE */}
      {/* ========================================================================= */}
      {activeTab === "issue" && (
        <div className="sf-card">
          {issueSuccessTicket ? (
            <div className="sf-success-state">
              <div className="sf-success-icon" style={{ background: "rgba(99, 102, 241, 0.12)", color: "#6366f1" }}>
                <FaBug />
              </div>
              <h2 className="sf-success-title">Issue Ticket Created Successfully!</h2>
              <p className="sf-success-desc">
                Your report has been logged and assigned high priority for administrative and technical review. You will receive an in-app notification when an admin reviews or resolves it.
              </p>
              <div className="sf-ticket-id-chip">
                <span>Ticket #{issueSuccessTicket.id}</span>
                <button
                  type="button"
                  onClick={() => handleCopy(issueSuccessTicket.id, "issue_copy")}
                  title="Copy Ticket ID"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", display: "inline-flex", alignItems: "center" }}
                >
                  {copiedId === "issue_copy" ? <FaCheck /> : <FaCopy />}
                </button>
              </div>
              <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="sf-btn-primary"
                  onClick={() => setIssueSuccessTicket(null)}
                >
                  Report Another Issue
                </button>
                <button
                  type="button"
                  className="sf-btn-secondary"
                  onClick={() => setActiveTab("tickets")}
                >
                  Track Ticket Status
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmitIssue}>
              <div className="sf-section-header">
                <h2 className="sf-section-title">
                  <FaBug style={{ color: "#ef4444" }} /> Report a Technical Problem or Grievance
                </h2>
                <p className="sf-section-desc">
                  Encountered an issue with scanning, facial verification, geofencing, or device locking? Submit a ticket for rapid resolution by administrators.
                </p>
              </div>

              {/* Issue Category */}
              <div className="sf-form-group">
                <label className="sf-label">Issue Category *</label>
                <div className="sf-chips-grid">
                  {ISSUE_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      className={`sf-chip-btn ${issueCategory === cat ? "selected" : ""}`}
                      onClick={() => setIssueCategory(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Priority */}
              <div className="sf-form-group">
                <label className="sf-label">Severity / Urgency Level</label>
                <div className="sf-priority-grid">
                  <button
                    type="button"
                    className={`sf-priority-btn low ${issuePriority === "low" ? "selected" : ""}`}
                    onClick={() => setIssuePriority("low")}
                  >
                    <span>🟢 Low</span>
                    <span style={{ fontSize: "0.72rem", opacity: 0.8 }}>Minor cosmetic</span>
                  </button>
                  <button
                    type="button"
                    className={`sf-priority-btn medium ${issuePriority === "medium" ? "selected" : ""}`}
                    onClick={() => setIssuePriority("medium")}
                  >
                    <span>🔵 Medium</span>
                    <span style={{ fontSize: "0.72rem", opacity: 0.8 }}>Standard bug</span>
                  </button>
                  <button
                    type="button"
                    className={`sf-priority-btn high ${issuePriority === "high" ? "selected" : ""}`}
                    onClick={() => setIssuePriority("high")}
                  >
                    <span>🟠 High</span>
                    <span style={{ fontSize: "0.72rem", opacity: 0.8 }}>Blocks attendance</span>
                  </button>
                  <button
                    type="button"
                    className={`sf-priority-btn urgent ${issuePriority === "urgent" ? "selected" : ""}`}
                    onClick={() => setIssuePriority("urgent")}
                  >
                    <span>🔴 Urgent</span>
                    <span style={{ fontSize: "0.72rem", opacity: 0.8 }}>Critical / Exam session</span>
                  </button>
                </div>
              </div>

              {/* Subject */}
              <div className="sf-form-group">
                <label className="sf-label">Problem Summary *</label>
                <input
                  type="text"
                  className="sf-input"
                  placeholder="e.g. Camera does not open when scanning QR in CS301 class"
                  value={issueTitle}
                  onChange={(e) => setIssueTitle(e.target.value)}
                  required
                />
              </div>

              {/* Detailed Explanation */}
              <div className="sf-form-group">
                <label className="sf-label">
                  Description &amp; Steps to Reproduce *
                </label>
                <textarea
                  className="sf-textarea"
                  placeholder="Please describe what happened, the class/course name, and any error message displayed on your screen..."
                  value={issueDescription}
                  onChange={(e) => setIssueDescription(e.target.value)}
                  required
                />
              </div>

              {/* Device Specs Auto-detection */}
              <div className="sf-form-group">
                <label className="sf-label">System Diagnostics (Auto-Attached)</label>
                <div className="sf-device-badge">
                  <div className="sf-device-badge-left">
                    <FaMobileAlt style={{ color: "#6366f1" }} />
                    <span>
                      Device: <strong>{String(detectedType || "web").toUpperCase()}</strong> | Platform: <strong>{typeof navigator !== "undefined" ? navigator.platform || "Web" : "Web"}</strong>
                    </span>
                  </div>
                  <span style={{ fontWeight: 700, color: "#10b981", fontSize: "0.75rem" }}>
                    ✓ Auto-Detected
                  </span>
                </div>
              </div>

              {/* Screenshot Attachment */}
              <div className="sf-form-group">
                <label className="sf-label">
                  Screenshot or Photo <span className="sf-label-desc">(Optional, max 5MB)</span>
                </label>
                {issueImage ? (
                  <div className="sf-image-preview-wrap">
                    <img src={issueImage} alt="Error preview" className="sf-image-preview" />
                    <button
                      type="button"
                      className="sf-remove-img-btn"
                      onClick={() => setIssueImage(null)}
                      title="Remove Screenshot"
                    >
                      <FaTimes />
                    </button>
                  </div>
                ) : (
                  <label className="sf-upload-box">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleImageSelect}
                      style={{ display: "none" }}
                    />
                    <div className="sf-upload-icon">
                      <FaCamera />
                    </div>
                    <p className="sf-upload-title">Click or drag screenshot here</p>
                    <p className="sf-upload-sub">Attach an image of the error message or camera screen</p>
                  </label>
                )}
              </div>

              {issueError && (
                <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: "10px", fontSize: "0.85rem", fontWeight: 600, marginBottom: "14px" }}>
                  ⚠️ {issueError}
                </div>
              )}

              <div className="sf-form-footer">
                <button
                  type="submit"
                  className="sf-btn-primary"
                  disabled={issueSubmitting || !issueDescription.trim()}
                  style={{ background: "linear-gradient(135deg, #ef4444, #dc2626)", boxShadow: "0 4px 14px rgba(239, 68, 68, 0.3)" }}
                >
                  {issueSubmitting ? <FaSpinner className="fa-spin" /> : <FaExclamationTriangle />}
                  <span>{issueSubmitting ? "Logging Ticket..." : "Submit Issue Ticket"}</span>
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 3: CONTACT US & FAQS */}
      {/* ========================================================================= */}
      {activeTab === "contact" && (
        <div>
          {/* Institutional Contact Cards */}
          <div className="sf-contacts-grid">
            <div className="sf-contact-card">
              <div className="sf-contact-icon-box indigo">
                <FaEnvelope />
              </div>
              <div className="sf-contact-info">
                <h4>Tech Support Email</h4>
                <p>Direct assistance for device lock, credentials, and verification queries.</p>
                <a
                  href={`mailto:${safeEmail}?subject=SmartAttend%20Support%20Request`}
                  className="sf-contact-action-btn"
                >
                  <FaEnvelope /> {safeEmail}
                </a>
              </div>
            </div>

            <div className="sf-contact-card">
              <div className="sf-contact-icon-box emerald">
                <FaPhoneAlt />
              </div>
              <div className="sf-contact-info">
                <h4>Helpline &amp; Support Desk</h4>
                <p>{SUPPORT_CONTACTS.hours || "Monday – Saturday, 8:30 AM – 6:00 PM IST"}</p>
                <a href={`tel:${safeHelpline.replace(/[^0-9+]/g, "")}`} className="sf-contact-action-btn">
                  <FaPhoneAlt /> {safeHelpline}
                </a>
              </div>
            </div>

            <div className="sf-contact-card">
              <div className="sf-contact-icon-box amber">
                <FaMapMarkerAlt />
              </div>
              <div className="sf-contact-info">
                <h4>Campus Support Office</h4>
                <p>{safeOffice}</p>
                <span className="sf-contact-action-btn" style={{ cursor: "default" }}>
                  <FaClock /> 8:30 AM – 6:00 PM IST
                </span>
              </div>
            </div>

            <div className="sf-contact-card">
              <div className="sf-contact-icon-box rose">
                <FaShieldAlt />
              </div>
              <div className="sf-contact-info">
                <h4>Urgent Session Grievance</h4>
                <p>Direct contact for active attendance sessions &amp; proxy disputes.</p>
                <a href={`tel:${safeUrgentHelpline.replace(/[^0-9+]/g, "")}`} className="sf-contact-action-btn">
                  <FaPhoneAlt /> {safeUrgentHelpline}
                </a>
              </div>
            </div>
          </div>

          {/* Direct Quick Message to Support Team */}
          <div className="sf-card" style={{ marginBottom: "2rem" }}>
            <div className="sf-section-header">
              <h2 className="sf-section-title">
                <FaPaperPlane style={{ color: "#6366f1" }} /> Send Quick Message to Support
              </h2>
              <p className="sf-section-desc">
                Have a general inquiry or question? Send a message directly to the campus IT desk.
              </p>
            </div>

            {contactSuccess ? (
              <div style={{ padding: "20px", background: "rgba(16, 185, 129, 0.12)", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: "12px", display: "flex", flexDirection: "column", gap: "10px", alignItems: "flex-start" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", fontWeight: 700 }}>
                  <FaCheckCircle style={{ fontSize: "1.3rem", color: "#10b981" }} />
                  <span>Your message has been received by the support desk! We will get back to you promptly.</span>
                </div>
                <button
                  type="button"
                  className="sf-btn-secondary"
                  onClick={() => setContactSuccess(false)}
                  style={{ marginTop: "6px" }}
                >
                  Send Another Message
                </button>
              </div>
            ) : (
              <form onSubmit={handleSendContactMessage}>
                <div className="sf-form-group">
                  <label className="sf-label">Subject</label>
                  <input
                    type="text"
                    className="sf-input"
                    placeholder="e.g. Question regarding semester timetable or attendance grace period"
                    value={contactSubject}
                    onChange={(e) => setContactSubject(e.target.value)}
                    required
                  />
                </div>
                <div className="sf-form-group">
                  <label className="sf-label">Your Message</label>
                  <textarea
                    className="sf-textarea"
                    placeholder="Type your question or request here..."
                    value={contactMessage}
                    onChange={(e) => setContactMessage(e.target.value)}
                    required
                  />
                </div>
                <div className="sf-form-footer">
                  <button
                    type="submit"
                    className="sf-btn-primary"
                    disabled={contactSending || !contactMessage.trim()}
                  >
                    {contactSending ? <FaSpinner className="fa-spin" /> : <FaPaperPlane />}
                    <span>{contactSending ? "Sending..." : "Send Message"}</span>
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Frequently Asked Questions */}
          <div className="sf-card">
            <div className="sf-section-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <h2 className="sf-section-title">
                  <FaHeadset style={{ color: "#6366f1" }} /> Frequently Asked Questions (FAQs)
                </h2>
                <p className="sf-section-desc">
                  Quick answers to common questions about attendance scanning, face enrollment, and device registration.
                </p>
              </div>

              {/* FAQ Search Bar */}
              <div className="sf-search-input-wrap" style={{ maxWidth: "280px" }}>
                <FaSearch />
                <input
                  type="text"
                  className="sf-input"
                  placeholder="Search FAQs..."
                  value={faqSearch}
                  onChange={(e) => setFaqSearch(e.target.value)}
                />
              </div>
            </div>

            <div className="sf-faq-list">
              {filteredFaqs.length === 0 ? (
                <div style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted, #64748b)" }}>
                  No FAQs matching "{faqSearch}"
                </div>
              ) : (
                filteredFaqs.map((faq) => {
                  const isOpen = openFaqId === faq.id;
                  return (
                    <div key={faq.id} className={`sf-faq-item ${isOpen ? "open" : ""}`}>
                      <button
                        type="button"
                        className="sf-faq-question"
                        onClick={() => setOpenFaqId(isOpen ? null : faq.id)}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                          <span className="sf-faq-badge">{faq.category}</span>
                          <span>{faq.question}</span>
                        </div>
                        <FaChevronDown className="sf-faq-arrow" />
                      </button>
                      {isOpen && <div className="sf-faq-answer">{faq.answer}</div>}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 4: MY TICKETS & SUBMISSIONS (AND ADMIN DESK) */}
      {/* ========================================================================= */}
      {(activeTab === "tickets" || (isAdmin && activeTab === "adminDesk")) && (
        <div className="sf-card">
          <div className="sf-section-header">
            <h2 className="sf-section-title">
              {isAdmin && activeTab === "adminDesk" ? (
                <>
                  <FaShieldAlt style={{ color: "#6366f1" }} /> Administrator Support &amp; Ticket Desk
                </>
              ) : (
                <>
                  <FaTicketAlt style={{ color: "#6366f1" }} /> My Submitted Tickets &amp; Status
                </>
              )}
            </h2>
            <p className="sf-section-desc">
              {isAdmin && activeTab === "adminDesk"
                ? "Review, triage, and respond to all student and faculty grievance tickets across the platform."
                : "Track real-time status updates and official administrative replies for your submitted issues and feedback."}
            </p>
          </div>

          {/* Search & Filter Toolbar */}
          <div className="sf-tickets-toolbar">
            <div className="sf-search-input-wrap">
              <FaSearch />
              <input
                type="text"
                className="sf-input"
                placeholder="Search by title, ticket ID, or roll number..."
                value={ticketSearch}
                onChange={(e) => setTicketSearch(e.target.value)}
              />
            </div>

            <select
              className="sf-filter-select"
              value={ticketStatusFilter}
              onChange={(e) => setTicketStatusFilter(e.target.value)}
            >
              <option value="all">All Statuses</option>
              <option value="open">🟡 Open</option>
              <option value="in_progress">🔵 In Progress</option>
              <option value="resolved">🟢 Resolved</option>
              <option value="closed">⚪ Closed</option>
            </select>

            <select
              className="sf-filter-select"
              value={ticketTypeFilter}
              onChange={(e) => setTicketTypeFilter(e.target.value)}
            >
              <option value="all">All Types</option>
              <option value="issue">🐛 Issues / Bugs</option>
              <option value="feedback">💬 Feedback</option>
              <option value="inquiry">📩 Inquiries</option>
            </select>
          </div>

          {/* Ticket List */}
          {filteredTickets.length === 0 ? (
            <div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--text-muted, #64748b)" }}>
              <FaTicketAlt style={{ fontSize: "2.5rem", color: "#cbd5e1", marginBottom: "10px" }} />
              <h3 style={{ margin: "0 0 4px", color: "var(--text-main, #0f172a)", fontSize: "1.15rem" }}>
                No Tickets Found
              </h3>
              <p style={{ margin: "0 0 16px", fontSize: "0.9rem" }}>
                {ticketSearch || ticketStatusFilter !== "all" || ticketTypeFilter !== "all"
                  ? "No tickets matched your current search or filter criteria."
                  : "You haven't submitted any tickets yet."}
              </p>
              {activeTab === "tickets" && (
                <div style={{ display: "flex", gap: "10px", justifyContent: "center" }}>
                  <button
                    type="button"
                    className="sf-btn-primary"
                    onClick={() => setActiveTab("feedback")}
                  >
                    <FaCommentDots /> Give Feedback
                  </button>
                  <button
                    type="button"
                    className="sf-btn-secondary"
                    onClick={() => setActiveTab("issue")}
                  >
                    <FaBug /> Report an Issue
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="sf-tickets-list">
              {filteredTickets.map((ticket) => {
                if (!ticket) return null;
                const status = ticket.status || "open";
                const priority = ticket.priority || "medium";

                return (
                  <div key={ticket.id} className="sf-ticket-card">
                    <div className="sf-ticket-header">
                      <div className="sf-ticket-left-info">
                        <span className="sf-ticket-id-tag">#{ticket.id}</span>
                        <span className={`sf-status-pill ${status}`}>
                          {status === "open" && "🟡 Open"}
                          {status === "in_progress" && "🔵 In Progress"}
                          {status === "resolved" && "🟢 Resolved"}
                          {status === "closed" && "⚪ Closed"}
                        </span>
                        {priority && (
                          <span className={`sf-priority-tag ${priority}`}>
                            {priority}
                          </span>
                        )}
                        <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted, #64748b)" }}>
                          • {ticket.category || "General"}
                        </span>
                      </div>

                      <div style={{ fontSize: "0.78rem", color: "var(--text-muted, #64748b)" }}>
                        {new Date(ticket.createdAt || Date.now()).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit"
                        })}
                      </div>
                    </div>

                    <h3 className="sf-ticket-title">{ticket.title}</h3>
                    <p className="sf-ticket-desc">{ticket.description}</p>

                    {/* Feedback Rating if present */}
                    {ticket.rating > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
                        <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "#f59e0b" }}>Rating:</span>
                        <div style={{ display: "flex", color: "#f59e0b", fontSize: "0.9rem" }}>
                          {[1, 2, 3, 4, 5].map((s) => (
                            <span key={s}>{s <= ticket.rating ? <FaStar /> : <FaRegStar />}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Screenshot Preview */}
                    {ticket.attachmentUrl && (
                      <div style={{ marginBottom: "10px" }}>
                        <img
                          src={ticket.attachmentUrl}
                          alt="Screenshot Attachment"
                          style={{ maxWidth: "160px", maxHeight: "100px", borderRadius: "8px", border: "1px solid var(--border, #e2e8f0)", objectFit: "cover", cursor: "pointer" }}
                          onClick={() => window.open(ticket.attachmentUrl, "_blank")}
                          title="Click to view full image"
                        />
                      </div>
                    )}

                    {/* Official Admin Reply */}
                    {ticket.adminResponse && (
                      <div className="sf-admin-reply-box">
                        <div className="sf-admin-reply-title">
                          <FaReply /> Official Response from {ticket.resolvedBy || "Administrator"}:
                        </div>
                        <p className="sf-admin-reply-text">{ticket.adminResponse}</p>
                      </div>
                    )}

                    {/* Ticket Footer / Submitter metadata */}
                    <div className="sf-ticket-footer">
                      <div>
                        Submitted by:{" "}
                        <strong>
                          {ticket.submittedBy?.name || "User"}{" "}
                          {ticket.submittedBy?.rollNo ? `(${ticket.submittedBy.rollNo})` : ""}
                        </strong>{" "}
                        <span style={{ opacity: 0.8 }}>[{ticket.submittedBy?.role || "student"}]</span>
                      </div>

                      <button
                        type="button"
                        className="sf-mini-copy"
                        onClick={() => handleCopy(ticket.id, ticket.id)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent, #6366f1)", fontWeight: 700, fontSize: "0.78rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      >
                        {copiedId === ticket.id ? <><FaCheck /> Copied ID</> : <><FaCopy /> Copy ID</>}
                      </button>
                    </div>

                    {/* Admin Specific Action Controls */}
                    {isAdmin && (
                      <div className="sf-admin-controls">
                        <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-main, #334155)" }}>
                          Admin Actions:
                        </span>

                        <select
                          className="sf-admin-select-status"
                          value={ticket.status || "open"}
                          onChange={(e) => handleQuickStatusChange(ticket.id, e.target.value)}
                        >
                          <option value="open">Set Open</option>
                          <option value="in_progress">Set In Progress</option>
                          <option value="resolved">Set Resolved</option>
                          <option value="closed">Set Closed</option>
                        </select>

                        <button
                          type="button"
                          className="sf-admin-reply-btn"
                          onClick={() => {
                            setReplyTicket(ticket);
                            setReplyText(ticket.adminResponse || "");
                            setReplyStatus(ticket.status === "open" ? "resolved" : ticket.status);
                          }}
                        >
                          <FaReply /> {ticket.adminResponse ? "Edit Reply" : "Write Reply"}
                        </button>

                        <button
                          type="button"
                          className="sf-admin-del-btn"
                          onClick={() => handleDeleteTicket(ticket.id)}
                          title="Delete Ticket"
                        >
                          <FaTrashAlt />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* ADMIN WRITE REPLY MODAL */}
      {/* ========================================================================= */}
      {replyTicket && (
        <div className="sf-modal-overlay" onClick={() => setReplyTicket(null)}>
          <div className="sf-modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "560px", padding: "24px" }}>
            <button
              type="button"
              className="sf-modal-close-btn"
              onClick={() => setReplyTicket(null)}
            >
              <FaTimes />
            </button>

            <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "4px 12px", borderRadius: "20px", background: "rgba(99, 102, 241, 0.1)", color: "#6366f1", fontWeight: 700, fontSize: "0.82rem", marginBottom: "10px" }}>
              <FaReply /> Support Desk Reply
            </div>

            <h3 style={{ margin: "0 0 4px", fontSize: "1.3rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
              Reply to Ticket #{replyTicket.id}
            </h3>
            <p style={{ margin: "0 0 16px", fontSize: "0.85rem", color: "var(--text-muted, #64748b)" }}>
              Submitter: <strong>{replyTicket.submittedBy?.name}</strong> ({replyTicket.submittedBy?.rollNo || replyTicket.submittedBy?.email})
            </p>

            <form onSubmit={handleSaveAdminReply}>
              <div className="sf-form-group">
                <label className="sf-label">Update Ticket Status</label>
                <select
                  className="sf-select"
                  value={replyStatus}
                  onChange={(e) => setReplyStatus(e.target.value)}
                >
                  <option value="in_progress">🔵 In Progress (Under Investigation)</option>
                  <option value="resolved">🟢 Resolved (Issue Fixed / Handled)</option>
                  <option value="closed">⚪ Closed (Completed)</option>
                  <option value="open">🟡 Open</option>
                </select>
              </div>

              <div className="sf-form-group">
                <label className="sf-label">Official Resolution Note *</label>
                <textarea
                  className="sf-textarea"
                  placeholder="Explain the solution, device reset status, or resolution steps to the student/faculty..."
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  required
                />
              </div>

              <div className="sf-form-footer">
                <button
                  type="button"
                  className="sf-btn-secondary"
                  onClick={() => setReplyTicket(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="sf-btn-primary"
                  disabled={replySaving || !replyText.trim()}
                >
                  {replySaving ? <FaSpinner className="fa-spin" /> : <FaCheck />}
                  <span>{replySaving ? "Sending..." : "Send Reply & Notify User"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SupportFeedbackContent(props) {
  return (
    <SupportErrorBoundary>
      <SupportFeedbackMain {...props} />
    </SupportErrorBoundary>
  );
}
