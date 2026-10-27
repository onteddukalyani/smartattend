import { useState } from 'react';
import {
    FaApple,
    FaTimes,
    FaCamera,
    FaMobileAlt,
    FaShieldAlt,
    FaArrowRight,
    FaUnlock,
    FaShareAlt
} from 'react-icons/fa';

export default function IphoneInstructionsModal({ isOpen, onClose }) {
    const [activeTab, setActiveTab] = useState('how_to_exit'); // default to exit / leave app as requested by user

    if (!isOpen) return null;

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.75)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 99999,
            padding: 'max(10px, env(safe-area-inset-top, 0px)) 10px max(12px, env(safe-area-inset-bottom, 0px))'
        }} role="dialog" aria-modal="true">
            <div style={{
                background: 'var(--surface, #ffffff)',
                borderRadius: '24px',
                maxWidth: 'min(96vw, 560px)',
                width: '100%',
                maxHeight: 'min(92vh, 92dvh)',
                overflowY: 'auto',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.35)',
                border: '1.5px solid var(--border, #e2e8f0)',
                color: 'var(--text-main, #0f172a)',
                position: 'relative',
                display: 'flex',
                flexDirection: 'column'
            }}>
                {/* Header */}
                <div style={{
                    padding: '20px 24px',
                    borderBottom: '1px solid var(--border, #e2e8f0)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    position: 'sticky',
                    top: 0,
                    background: 'var(--surface, #ffffff)',
                    zIndex: 10
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{
                            width: '40px',
                            height: '40px',
                            borderRadius: '12px',
                            background: 'linear-gradient(135deg, #1e293b, #0f172a)',
                            color: '#ffffff',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '20px'
                        }}>
                            <FaApple />
                        </div>
                        <div>
                            <h2 style={{ fontSize: '1.15rem', fontWeight: 800, margin: 0, color: 'var(--text-main, #0f172a)' }}>
                                iPhone Instructions Guide
                            </h2>
                            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted, #64748b)', margin: 0 }}>
                                Step-by-step setup, scanning &amp; how to exit
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            fontSize: '18px',
                            color: '#64748b',
                            cursor: 'pointer',
                            padding: '8px',
                            borderRadius: '50%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}
                        aria-label="Close modal"
                    >
                        <FaTimes />
                    </button>
                </div>

                {/* Tabs */}
                <div style={{
                    display: 'flex',
                    borderBottom: '1px solid var(--border, #e2e8f0)',
                    padding: '0 16px',
                    gap: '8px',
                    overflowX: 'auto',
                    background: 'var(--surface-soft, #f8fafc)'
                }}>
                    <button
                        type="button"
                        onClick={() => setActiveTab('how_to_exit')}
                        style={{
                            padding: '12px 14px',
                            background: 'none',
                            border: 'none',
                            borderBottom: activeTab === 'how_to_exit' ? '3px solid #2563eb' : '3px solid transparent',
                            color: activeTab === 'how_to_exit' ? '#2563eb' : '#64748b',
                            fontWeight: activeTab === 'how_to_exit' ? 800 : 600,
                            fontSize: '0.86rem',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                        }}
                    >
                        <FaUnlock /> How to Leave App
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('setup')}
                        style={{
                            padding: '12px 14px',
                            background: 'none',
                            border: 'none',
                            borderBottom: activeTab === 'setup' ? '3px solid #2563eb' : '3px solid transparent',
                            color: activeTab === 'setup' ? '#2563eb' : '#64748b',
                            fontWeight: activeTab === 'setup' ? 800 : 600,
                            fontSize: '0.86rem',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                        }}
                    >
                        <FaMobileAlt /> Setup (Camera &amp; Guided Access)
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('scanning')}
                        style={{
                            padding: '12px 14px',
                            background: 'none',
                            border: 'none',
                            borderBottom: activeTab === 'scanning' ? '3px solid #2563eb' : '3px solid transparent',
                            color: activeTab === 'scanning' ? '#2563eb' : '#64748b',
                            fontWeight: activeTab === 'scanning' ? 800 : 600,
                            fontSize: '0.86rem',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                        }}
                    >
                        <FaCamera /> How to Mark Attendance
                    </button>
                </div>

                {/* Tab Content */}
                <div style={{ padding: '24px', flex: 1 }}>

                    {/* TAB 1: HOW TO LEAVE THE APP / EXIT GUIDED ACCESS */}
                    {activeTab === 'how_to_exit' && (
                        <div>
                            <div style={{
                                background: '#eff6ff',
                                border: '1.5px solid #bfdbfe',
                                borderRadius: '16px',
                                padding: '16px',
                                marginBottom: '20px'
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#1e40af', fontWeight: 800, fontSize: '0.92rem', marginBottom: '4px' }}>
                                    <FaUnlock /> How to Exit Guided Access &amp; Leave the App
                                </div>
                                <div style={{ fontSize: '0.84rem', color: '#334155', lineHeight: 1.5 }}>
                                    When Guided Access is active on an iPhone, iOS locks all swipe gestures and home button presses. Follow these simple steps whenever attendance is done or the lecturer releases devices:
                                </div>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                                <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
                                    <div style={{
                                        width: '32px',
                                        height: '32px',
                                        borderRadius: '50%',
                                        background: '#2563eb',
                                        color: '#ffffff',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontWeight: 800,
                                        fontSize: '0.9rem',
                                        flexShrink: 0
                                    }}>
                                        1
                                    </div>
                                    <div style={{ fontSize: '0.88rem', lineHeight: 1.5 }}>
                                        <strong>Triple-Click Side Button:</strong> Rapidly press the <strong>Side/Power Button</strong> on the right side of your iPhone 3 times (or triple-click Home Button on iPhone SE/8).
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
                                    <div style={{
                                        width: '32px',
                                        height: '32px',
                                        borderRadius: '50%',
                                        background: '#2563eb',
                                        color: '#ffffff',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontWeight: 800,
                                        fontSize: '0.9rem',
                                        flexShrink: 0
                                    }}>
                                        2
                                    </div>
                                    <div style={{ fontSize: '0.88rem', lineHeight: 1.5 }}>
                                        <strong>Enter Your iPhone Passcode:</strong> Enter your 4 or 6-digit Guided Access passcode (or double-click for Face ID if configured).
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
                                    <div style={{
                                        width: '32px',
                                        height: '32px',
                                        borderRadius: '50%',
                                        background: '#10b981',
                                        color: '#ffffff',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontWeight: 800,
                                        fontSize: '0.9rem',
                                        flexShrink: 0
                                    }}>
                                        3
                                    </div>
                                    <div style={{ fontSize: '0.88rem', lineHeight: 1.5 }}>
                                        <strong>Tap "End" in Top-Left:</strong> In the upper-left corner of the iPhone screen, tap <span style={{ color: '#dc2626', fontWeight: 800 }}>End</span>. Guided Access is now completely turned off!
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
                                    <div style={{
                                        width: '32px',
                                        height: '32px',
                                        borderRadius: '50%',
                                        background: '#6366f1',
                                        color: '#ffffff',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontWeight: 800,
                                        fontSize: '0.9rem',
                                        flexShrink: 0
                                    }}>
                                        4
                                    </div>
                                    <div style={{ fontSize: '0.88rem', lineHeight: 1.5 }}>
                                        <strong>Return or Close:</strong> On the SmartAttend screen, tap <strong>"Return to Student Dashboard"</strong> or swipe up from the bottom of your iPhone screen to return to your home screen.
                                    </div>
                                </div>
                            </div>

                            <div style={{
                                marginTop: '20px',
                                padding: '12px 16px',
                                borderRadius: '12px',
                                background: '#f8fafc',
                                border: '1px solid #cbd5e1',
                                fontSize: '0.82rem',
                                color: '#475569'
                            }}>
                                💡 <strong>Tip:</strong> If the lecturer announced a 6-digit Session PIN, you can also enter that PIN directly into the card on your screen to unlock immediately.
                            </div>
                        </div>
                    )}

                    {/* TAB 2: ONE-TIME SETUP */}
                    {activeTab === 'setup' && (
                        <div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                {/* Step 1: Camera */}
                                <div style={{
                                    border: '1.5px solid var(--border, #e2e8f0)',
                                    borderRadius: '16px',
                                    padding: '16px',
                                    background: 'var(--surface-soft, #f8fafc)'
                                }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800, color: '#1e293b', marginBottom: '6px' }}>
                                        <FaCamera style={{ color: '#2563eb' }} /> 1. Allow Safari Camera Permissions
                                    </div>
                                    <p style={{ fontSize: '0.85rem', color: '#475569', margin: '0 0 8px 0', lineHeight: 1.5 }}>
                                        Open iPhone <strong>Settings</strong> <FaArrowRight size={10} /> <strong>Safari</strong> <FaArrowRight size={10} /> under <em>Settings for Websites</em> tap <strong>Camera</strong> <FaArrowRight size={10} /> Select <strong>Allow</strong>.
                                    </p>
                                    <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                                        <em>Quick fix inside Safari:</em> Tap the <strong>"aA"</strong> button in the search bar <FaArrowRight size={10} /> <strong>Website Settings</strong> <FaArrowRight size={10} /> set Camera to <strong>Allow</strong>.
                                    </div>
                                </div>

                                {/* Step 2: Home Screen */}
                                <div style={{
                                    border: '1.5px solid var(--border, #e2e8f0)',
                                    borderRadius: '16px',
                                    padding: '16px',
                                    background: 'var(--surface-soft, #f8fafc)'
                                }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800, color: '#1e293b', marginBottom: '6px' }}>
                                        <FaShareAlt style={{ color: '#10b981' }} /> 2. Add to Home Screen (Recommended)
                                    </div>
                                    <p style={{ fontSize: '0.85rem', color: '#475569', margin: '0 0 6px 0', lineHeight: 1.5 }}>
                                        Open SmartAttend in Safari <FaArrowRight size={10} /> Tap the <strong>Share</strong> button (box with arrow pointing up: ⎋) <FaArrowRight size={10} /> Tap <strong>Add to Home Screen</strong> (+) <FaArrowRight size={10} /> Tap <strong>Add</strong>.
                                    </p>
                                    <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                                        This runs SmartAttend in fullscreen PWA mode with zero browser tab clutter.
                                    </div>
                                </div>

                                {/* Step 3: Guided Access */}
                                <div style={{
                                    border: '1.5px solid var(--border, #e2e8f0)',
                                    borderRadius: '16px',
                                    padding: '16px',
                                    background: 'var(--surface-soft, #f8fafc)'
                                }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800, color: '#1e293b', marginBottom: '6px' }}>
                                        <FaShieldAlt style={{ color: '#6366f1' }} /> 3. Enable Guided Access in iOS
                                    </div>
                                    <p style={{ fontSize: '0.85rem', color: '#475569', margin: '0 0 6px 0', lineHeight: 1.5 }}>
                                        Open iPhone <strong>Settings</strong> <FaArrowRight size={10} /> <strong>Accessibility</strong> <FaArrowRight size={10} /> Scroll to <strong>Guided Access</strong> <FaArrowRight size={10} /> Toggle <strong>ON</strong>.
                                    </p>
                                    <div style={{ fontSize: '0.8rem', color: '#475569', lineHeight: 1.4 }}>
                                        • Tap <strong>Passcode Settings</strong> and set a 4 or 6-digit PIN.<br />
                                        • Toggle <strong>Accessibility Shortcut</strong> to <strong>ON</strong>.
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* TAB 3: HOW TO MARK ATTENDANCE */}
                    {activeTab === 'scanning' && (
                        <div>
                            <div style={{
                                background: '#fef3c7',
                                border: '1.5px solid #fde68a',
                                borderRadius: '16px',
                                padding: '14px',
                                marginBottom: '18px',
                                color: '#92400e',
                                fontSize: '0.84rem',
                                lineHeight: 1.5
                            }}>
                                <strong>⚠️ Anti-Proxy Rule:</strong> Keep SmartAttend in the foreground! Do not switch apps, minimize Safari, or take screenshots during attendance. Two strikes will disqualify your session.
                            </div>

                            <ol style={{ paddingLeft: '20px', margin: 0, display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.88rem', color: '#334155', lineHeight: 1.5 }}>
                                <li>
                                    <strong>Step 1 — Start Guided Access:</strong> Before scanning, <strong>Triple-click the Side Button</strong> on your iPhone and tap <strong>Start</strong> in the top-right corner.
                                </li>
                                <li>
                                    <strong>Step 2 — Scan QR 1:</strong> Point your rear camera at the classroom screen showing <strong>QR 1</strong>. Your check-in begins immediately.
                                </li>
                                <li>
                                    <strong>Step 3 — Scan QR 2:</strong> When the lecturer advances the slide, point your camera to scan <strong>QR 2</strong>.
                                </li>
                                <li>
                                    <strong>Step 4 — 3D Face Scan:</strong> The front camera opens automatically. Align your face inside the oval frame. Verification completes locally in milliseconds.
                                </li>
                                <li>
                                    <strong>Step 5 — Done &amp; Exit:</strong> Once attendance shows <strong>"Attendance Submitted Successfully ✅"</strong>, triple-click the Side Button, enter your passcode, tap <strong>End</strong>, and return to the dashboard!
                                </li>
                            </ol>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div style={{
                    padding: '16px 24px',
                    borderTop: '1px solid var(--border, #e2e8f0)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: 'var(--surface-soft, #f8fafc)'
                }}>
                    <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                        iOS 15 / 16 / 17 / 18 Supported
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            background: '#2563eb',
                            color: '#ffffff',
                            border: 'none',
                            padding: '10px 20px',
                            borderRadius: '12px',
                            fontWeight: 700,
                            fontSize: '0.9rem',
                            cursor: 'pointer'
                        }}
                    >
                        Got it, Close Guide
                    </button>
                </div>
            </div>
        </div>
    );
}
