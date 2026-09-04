import React, { useState } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import { useNavigate } from 'react-router-dom';
import { FaArrowLeft, FaCheckCircle, FaSpinner } from 'react-icons/fa';
import { MdQrCodeScanner } from 'react-icons/md';
import { useAuth } from '../authcontext';

function QrScannerApp() {
    const navigate = useNavigate();
    const { profile } = useAuth();
    const [scanResult, setScanResult] = useState('');
    const [isNavigating, setIsNavigating] = useState(false);

    const handleScan = (result) => {
        if (!result || isNavigating) return;

        const raw = result[0]?.rawValue || (typeof result === 'string' ? result : '');
        if (!raw) return;

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
        } else if (!raw.startsWith("http") && raw.trim().length > 5) {
            targetSessionId = raw.trim();
        }

        if (targetSessionId) {
            setIsNavigating(true);
            setTimeout(() => {
                navigate(`/student-form?session=${encodeURIComponent(targetSessionId)}`);
            }, 600);
        }
    };

    const returnPath = profile?.role === "student" ? "/student" : "/lecturer";

    return (
        <div style={{
            maxWidth: '520px',
            margin: '30px auto',
            padding: '24px',
            background: 'var(--surface)',
            borderRadius: '18px',
            border: '1px solid color-mix(in srgb, var(--accent) 18%, transparent)',
            boxShadow: '0 18px 42px -24px var(--shadow)',
            color: 'var(--text-main)',
            textAlign: 'center'
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                <button
                    type="button"
                    onClick={() => navigate(returnPath)}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--accent)',
                        fontSize: '0.9rem',
                        fontWeight: 600,
                        cursor: 'pointer'
                    }}
                >
                    <FaArrowLeft /> Back to Dashboard
                </button>
            </div>

            <div style={{
                width: '56px',
                height: '56px',
                borderRadius: '50%',
                background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                color: 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 12px',
                fontSize: '28px'
            }}>
                <MdQrCodeScanner />
            </div>

            <h2 style={{ margin: '0 0 8px 0', fontSize: '1.45rem', fontWeight: 800 }}>
                Scan Class QR Code
            </h2>
            <p style={{ margin: '0 0 24px 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                Point your camera at the attendance QR code displayed by your lecturer.
            </p>

            <div style={{
                borderRadius: '14px',
                overflow: 'hidden',
                border: '2px dashed color-mix(in srgb, var(--accent) 35%, transparent)',
                background: '#000',
                position: 'relative'
            }}>
                <Scanner
                    onScan={handleScan}
                    onError={(error) => console.error("Scanner Error:", error)}
                    constraints={{
                        facingMode: 'environment'
                    }}
                />
            </div>

            {isNavigating && (
                <div style={{
                    marginTop: '20px',
                    padding: '12px 18px',
                    borderRadius: '10px',
                    background: 'rgba(16, 185, 129, 0.12)',
                    color: '#10b981',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    fontWeight: 700,
                    fontSize: '0.95rem'
                }}>
                    <FaCheckCircle />
                    <span>Session detected! Opening attendance form...</span>
                </div>
            )}

            {scanResult && !isNavigating && (
                <div style={{ marginTop: '20px', textAlign: 'left' }}>
                    <p style={{ margin: '0 0 6px 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                        Scanned data:
                    </p>
                    <code style={{
                        display: 'block',
                        wordBreak: 'break-all',
                        padding: '10px 12px',
                        borderRadius: '8px',
                        background: 'var(--surface-soft)',
                        fontSize: '0.85rem'
                    }}>
                        {scanResult}
                    </code>
                </div>
            )}
        </div>
    );
}

export default QrScannerApp;
