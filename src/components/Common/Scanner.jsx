import React, { useState, useEffect, useRef } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import jsQR from 'jsqr';
import { useNavigate } from 'react-router-dom';
import {
    FaArrowLeft,
    FaCheckCircle,
    FaSpinner,
    FaSyncAlt,
    FaExclamationTriangle,
    FaLock,
    FaCamera,
    FaUpload,
    FaInfoCircle
} from 'react-icons/fa';
import { MdQrCodeScanner } from 'react-icons/md';
import { useAuth } from '../authcontext';

function QrScannerApp() {
    const navigate = useNavigate();
    const { profile } = useAuth();
    const fileInputRef = useRef(null);

    const [scanResult, setScanResult] = useState('');
    const [isNavigating, setIsNavigating] = useState(false);
    const [facingMode, setFacingMode] = useState('environment'); // 'environment' or 'user'
    const [retryKey, setRetryKey] = useState(0);
    const [cameraError, setCameraError] = useState('');
    const [permissionDenied, setPermissionDenied] = useState(false);
    const [scanningFile, setScanningFile] = useState(false);
    const [scannerActive, setScannerActive] = useState(true);

    // Initial check for desktop vs mobile to choose best default camera
    useEffect(() => {
        if (typeof window !== 'undefined') {
            const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
            if (!isMobile) {
                setFacingMode('user');
            }
        }
    }, []);

    const processSessionString = (raw) => {
        if (!raw || isNavigating) return;

        setScanResult(raw);

        // Extract session ID from scanned URL or string
        let targetSessionId = null;
        if (raw.includes("session=")) {
            try {
                const url = new URL(raw, window.location.origin);
                targetSessionId = url.searchParams.get("session");
            } catch {
                const match = raw.match(/[?&]session=([^&#]+)/);
                if (match) targetSessionId = match[1];
            }
        } else if (!raw.startsWith("http") && raw.trim().length > 3) {
            targetSessionId = raw.trim();
        }

        if (targetSessionId) {
            setIsNavigating(true);
            setCameraError('');
            setTimeout(() => {
                navigate(`/student-form?session=${encodeURIComponent(targetSessionId)}`);
            }, 500);
        } else {
            setCameraError("Invalid QR code. Please scan a valid SmartAttend session QR code.");
        }
    };

    const handleScan = (result) => {
        if (!result || isNavigating) return;
        const raw = result[0]?.rawValue || (typeof result === 'string' ? result : '');
        if (raw) {
            processSessionString(raw);
        }
    };

    const handleError = (error) => {
        console.warn("Scanner Error:", error);
        const errName = error?.name || "";
        const errMsg = error?.message || String(error);

        if (errName === "NotAllowedError" || errName === "PermissionDeniedError" || errMsg.toLowerCase().includes("permission")) {
            setPermissionDenied(true);
            setCameraError("Camera permission blocked on HTTP. Use 'Snap / Upload QR Photo' below for instant scan!");
        } else if (errName === "OverconstrainedError" || errMsg.toLowerCase().includes("constraint")) {
            if (facingMode === 'environment') {
                setFacingMode('user');
                setRetryKey((k) => k + 1);
            }
        } else {
            setCameraError("WebRTC camera stream unavailable. Please use the camera snap button below.");
        }
    };

    // Instant Photo / Camera File Scanner (Works 100% across all HTTP LAN devices)
    const handleFileScan = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setScanningFile(true);
        setCameraError('');

        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const canvas = document.createElement("canvas");
                    canvas.width = img.naturalWidth || img.width;
                    canvas.height = img.naturalHeight || img.height;
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const code = jsQR(imageData.data, imageData.width, imageData.height, {
                        inversionAttempts: "attemptBoth"
                    });

                    setScanningFile(false);
                    if (code && code.data) {
                        processSessionString(code.data);
                    } else {
                        setCameraError("❌ Could not detect QR code in photo. Please point camera directly at the QR code and snap again.");
                    }
                } catch (decodeErr) {
                    console.error("QR decode error:", decodeErr);
                    setScanningFile(false);
                    setCameraError("Error reading QR image.");
                }
            };
            img.onerror = () => {
                setScanningFile(false);
                setCameraError("Failed to load photo.");
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    };

    const toggleFacingMode = () => {
        setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
        setRetryKey((k) => k + 1);
        setCameraError('');
        setPermissionDenied(false);
    };

    const restartScanner = () => {
        setRetryKey((k) => k + 1);
        setCameraError('');
        setPermissionDenied(false);
        setScannerActive(true);
    };

    const returnPath = profile?.role === "student" ? "/student" : "/lecturer";

    return (
        <div style={{
            maxWidth: '540px',
            margin: '30px auto',
            padding: '26px 22px',
            background: 'var(--surface, #ffffff)',
            borderRadius: '20px',
            border: '1.5px solid var(--border, #e2e8f0)',
            boxShadow: '0 20px 45px -20px rgba(0, 0, 0, 0.1)',
            color: 'var(--text-main, #0f172a)',
            textAlign: 'center'
        }}>
            {/* Hidden Photo / Camera Input for 100% HTTP compatibility */}
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: "none" }}
                onChange={handleFileScan}
            />

            {/* Header Navigation */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
                <button
                    type="button"
                    onClick={() => navigate(returnPath)}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--accent, #6366f1)',
                        fontSize: '0.9rem',
                        fontWeight: 700,
                        cursor: 'pointer'
                    }}
                >
                    <FaArrowLeft /> Back
                </button>

                <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                        type="button"
                        onClick={toggleFacingMode}
                        title="Switch Front/Back Camera"
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '6px 12px',
                            borderRadius: '8px',
                            background: 'var(--surface-soft, #f1f5f9)',
                            border: '1px solid var(--border, #cbd5e1)',
                            color: 'var(--text-main, #334155)',
                            fontSize: '0.78rem',
                            fontWeight: 700,
                            cursor: 'pointer'
                        }}
                    >
                        <FaSyncAlt /> {facingMode === 'environment' ? 'Rear Cam' : 'Front Cam'}
                    </button>
                </div>
            </div>

            {/* Icon & Title */}
            <div style={{
                width: '58px',
                height: '58px',
                borderRadius: '50%',
                background: 'rgba(99, 102, 241, 0.12)',
                color: '#6366f1',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 12px',
                fontSize: '30px'
            }}>
                <MdQrCodeScanner />
            </div>

            <h2 style={{ margin: '0 0 6px 0', fontSize: '1.45rem', fontWeight: 800 }}>
                Scan Class QR Code
            </h2>
            <p style={{ margin: '0 0 16px 0', color: 'var(--text-muted, #64748b)', fontSize: '0.88rem' }}>
                Point your camera at the attendance QR code displayed by your lecturer.
            </p>

            {/* Direct Snap Photo Button (Always works on all phones over HTTP) */}
            <div style={{ marginBottom: '16px' }}>
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={scanningFile || isNavigating}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        width: '100%',
                        padding: '13px 20px',
                        borderRadius: '14px',
                        background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                        color: '#ffffff',
                        border: 'none',
                        fontWeight: 800,
                        fontSize: '0.98rem',
                        cursor: 'pointer',
                        boxShadow: '0 4px 16px rgba(16, 185, 129, 0.35)',
                        transition: 'all 0.2s ease'
                    }}
                >
                    {scanningFile ? (
                        <><FaSpinner className="fa-spin" /> Decoding QR Code...</>
                    ) : (
                        <><FaCamera /> 📸 Scan QR via Device Camera</>
                    )}
                </button>
            </div>

            {/* Live WebRTC Viewport */}
            <div style={{
                borderRadius: '16px',
                overflow: 'hidden',
                border: '2px dashed rgba(99, 102, 241, 0.4)',
                background: '#020617',
                position: 'relative',
                minHeight: '260px',
                boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.15)'
            }}>
                {scannerActive && (
                    <Scanner
                        key={`${retryKey}-${facingMode}`}
                        onScan={handleScan}
                        onError={handleError}
                        constraints={{
                            facingMode: facingMode
                        }}
                        sound={false}
                        components={{
                            audio: false
                        }}
                    />
                )}

                {/* Permission Denied Overlay */}
                {permissionDenied && (
                    <div style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'rgba(15, 23, 42, 0.95)',
                        padding: '24px 20px',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#f8fafc',
                        zIndex: 10
                    }}>
                        <FaCamera style={{ fontSize: '2.4rem', color: '#10b981', marginBottom: '10px' }} />
                        <h4 style={{ margin: '0 0 6px', fontSize: '1rem', fontWeight: 800 }}>Tap Above to Scan</h4>
                        <p style={{ margin: '0 0 14px', fontSize: '0.82rem', color: '#94a3b8', lineHeight: 1.4, maxWidth: '300px' }}>
                            Live WebRTC video streams require HTTPS on mobile IP. Click the green <strong>"📸 Scan QR via Device Camera"</strong> button above to scan instantly with your camera!
                        </p>
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '6px',
                                padding: '10px 20px',
                                borderRadius: '10px',
                                background: '#10b981',
                                color: '#ffffff',
                                border: 'none',
                                fontWeight: 700,
                                fontSize: '0.88rem',
                                cursor: 'pointer'
                            }}
                        >
                            <FaCamera /> Open Camera Now
                        </button>
                    </div>
                )}
            </div>

            {/* Error Message */}
            {cameraError && !permissionDenied && (
                <div style={{
                    marginTop: '12px',
                    padding: '10px 14px',
                    borderRadius: '10px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.25)',
                    color: '#ef4444',
                    fontSize: '0.84rem',
                    fontWeight: 600,
                    textAlign: 'left'
                }}>
                    {cameraError}
                </div>
            )}

            {/* Success Navigating Alert */}
            {isNavigating && (
                <div style={{
                    marginTop: '18px',
                    padding: '14px 18px',
                    borderRadius: '12px',
                    background: '#dcfce7',
                    color: '#15803d',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    fontWeight: 800,
                    fontSize: '0.98rem',
                    boxShadow: '0 4px 14px rgba(22, 163, 74, 0.15)'
                }}>
                    <FaCheckCircle />
                    <span>Session QR Code Verified! Opening attendance form...</span>
                </div>
            )}
        </div>
    );
}

export default QrScannerApp;
