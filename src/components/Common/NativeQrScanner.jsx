import React, { useState, useEffect, useRef, useCallback } from 'react';
import jsQR from 'jsqr';
import { FaSpinner, FaSyncAlt, FaExclamationTriangle, FaBolt } from 'react-icons/fa';

/**
 * Release all active media tracks across the DOM to avoid hardware camera collisions.
 */
function releaseAllTracks() {
    try {
        if (typeof document !== 'undefined') {
            document.querySelectorAll('video').forEach((v) => {
                if (v.srcObject && typeof v.srcObject.getTracks === 'function') {
                    v.srcObject.getTracks().forEach((t) => {
                        try { t.stop(); } catch (_) { }
                    });
                    v.srcObject = null;
                }
            });
        }
    } catch (_) { }
}

/**
 * NativeQrScanner — High-performance, ultra-reliable QR camera scanner
 * 
 * Features:
 * 1. Progressive multi-tier constraints (never throws OverconstrainedError on portrait phones).
 * 2. Multi-engine detection: Native BarcodeDetector if available, instant offline jsQR fallback.
 * 3. 100% offline, zero external WASM or CDN network dependencies.
 * 4. Automatic camera switch (back/front) and torch/flashlight toggle.
 * 5. Full media track lifecycle cleanup.
 */
function NativeQrScanner({
    onScan,
    onError,
    facingMode = 'environment',
    onToggleFacingMode,
    active = true
}) {
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const streamRef = useRef(null);
    const [loading, setLoading] = useState(true);
    const [errorMsg, setErrorMsg] = useState('');
    const [torchAvailable, setTorchAvailable] = useState(false);
    const [torchOn, setTorchOn] = useState(false);
    const isScanningRef = useRef(true);
    const animRef = useRef(null);
    const lastScanTimeRef = useRef(0);

    const onScanRef = useRef(onScan);
    const onErrorRef = useRef(onError);
    const isStartingRef = useRef(false);
    // Invalidates any in-flight getUserMedia request when the scanner is stopped,
    // deactivated, switched cameras, or unmounted.
    const cameraGenerationRef = useRef(0);

    useEffect(() => {
        onScanRef.current = onScan;
    }, [onScan]);

    useEffect(() => {
        onErrorRef.current = onError;
    }, [onError]);

    const stopStream = useCallback(() => {
        // A getUserMedia() promise cannot be cancelled. Invalidate it so a late
        // resolution cannot attach a new stream after the UI has moved on.
        cameraGenerationRef.current += 1;
        isScanningRef.current = false;
        if (animRef.current) {
            cancelAnimationFrame(animRef.current);
            animRef.current = null;
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => {
                try { track.stop(); } catch (_) { }
            });
            streamRef.current = null;
        }
        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
        isStartingRef.current = false;
        setTorchOn(false);
        setTorchAvailable(false);
    }, []);

    const startCamera = useCallback(async () => {
        if (!active) return;

        // If camera stream is already running and live, preserve it smoothly
        if (streamRef.current && streamRef.current.getVideoTracks().some((t) => t.readyState === 'live')) {
            if (videoRef.current && videoRef.current.srcObject !== streamRef.current) {
                videoRef.current.srcObject = streamRef.current;
                videoRef.current.play().catch(() => { });
            }
            setLoading(false);
            return;
        }

        if (isStartingRef.current) return;
        isStartingRef.current = true;
        const cameraGeneration = ++cameraGenerationRef.current;

        setLoading(true);
        setErrorMsg('');

        // Do not call stopStream() here: it resets isStartingRef while this
        // start attempt is still in progress, allowing a second getUserMedia()
        // request to race the first one. Also do not stop every <video> on the
        // page; that can interrupt unrelated camera consumers and cause the QR
        // camera to reopen. Clean up only this scanner's stale stream.
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => {
                try { track.stop(); } catch (_) { }
            });
            streamRef.current = null;
        }
        if (videoRef.current) videoRef.current.srcObject = null;

        // Brief cooldown for hardware camera HAL release
        await new Promise((r) => setTimeout(r, 120));
        if (!active || cameraGeneration !== cameraGenerationRef.current) {
            if (cameraGeneration === cameraGenerationRef.current) isStartingRef.current = false;
            return;
        }

        if (!navigator?.mediaDevices?.getUserMedia) {
            const err = new Error('Camera access (getUserMedia) is not supported on this device/browser.');
            setErrorMsg(err.message);
            if (onErrorRef.current) onErrorRef.current(err);
            setLoading(false);
            isStartingRef.current = false;
            return;
        }

        // Check if device enumeration can find the target camera deviceId directly
        let targetDeviceId = null;
        try {
            if (navigator?.mediaDevices?.enumerateDevices) {
                const devs = await navigator.mediaDevices.enumerateDevices();
                const videoDevs = devs.filter((d) => d.kind === 'videoinput');
                const matchedDev = videoDevs.find((d) =>
                    facingMode === 'user'
                        ? /front|user|selfie|face/i.test(d.label)
                        : /back|rear|environment|world/i.test(d.label)
                );
                if (matchedDev?.deviceId) {
                    targetDeviceId = matchedDev.deviceId;
                }
            }
        } catch (_) { }
        if (!active || cameraGeneration !== cameraGenerationRef.current) {
            if (cameraGeneration === cameraGenerationRef.current) isStartingRef.current = false;
            return;
        }

        const progressiveConstraints = [
            // Tier 0: Direct target hardware deviceId if discovered
            ...(targetDeviceId ? [{
                video: {
                    deviceId: { exact: targetDeviceId },
                    width: { ideal: 1280, min: 480 },
                    height: { ideal: 720, min: 360 }
                },
                audio: false
            }] : []),
            // Tier 1: Exact facingMode
            {
                video: {
                    facingMode: { exact: facingMode || 'environment' },
                    width: { ideal: 1280, min: 480 },
                    height: { ideal: 720, min: 360 }
                },
                audio: false
            },
            // Tier 2: Ideal facingMode
            {
                video: {
                    facingMode: { ideal: facingMode || 'environment' },
                    width: { ideal: 1280, min: 480 },
                    height: { ideal: 720, min: 360 }
                },
                audio: false
            },
            // Tier 3: Direct facingMode fallback
            {
                video: { facingMode: facingMode || 'environment' },
                audio: false
            },
            // Tier 4: Universal fallback for laptops / single webcam devices
            {
                video: true,
                audio: false
            }
        ];

        let stream = null;
        let lastErr = null;

        for (const constraints of progressiveConstraints) {
            try {
                stream = await navigator.mediaDevices.getUserMedia(constraints);
                // On Android/iOS, permission prompts and camera hardware startup can
                // resolve after React has deactivated/unmounted this scanner.
                // Immediately stop that late stream instead of reopening the camera.
                if (!active || cameraGeneration !== cameraGenerationRef.current) {
                    stream?.getTracks?.().forEach((track) => {
                        try { track.stop(); } catch (_) { }
                    });
                    if (cameraGeneration === cameraGenerationRef.current) isStartingRef.current = false;
                    return;
                }
                if (stream && stream.getVideoTracks().length > 0) {
                    break;
                }
            } catch (err) {
                lastErr = err;
                if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
                    break;
                }
            }
        }

        if (!stream) {
            const finalErr = lastErr || new Error('Could not open camera stream.');
            const isDenied = finalErr?.name === 'NotAllowedError' || finalErr?.name === 'PermissionDeniedError';
            setErrorMsg(
                isDenied
                    ? 'Camera permission denied. Please allow camera access in your device settings.'
                    : 'Unable to start camera stream. Please tap Retry or use Snap / Upload QR Photo.'
            );
            if (onErrorRef.current) onErrorRef.current(finalErr);
            setLoading(false);
            isStartingRef.current = false;
            return;
        }

        if (!active || cameraGeneration !== cameraGenerationRef.current) {
            stream.getTracks().forEach((track) => {
                try { track.stop(); } catch (_) { }
            });
            if (cameraGeneration === cameraGenerationRef.current) isStartingRef.current = false;
            return;
        }
        streamRef.current = stream;

        // Check torch support
        try {
            const track = stream.getVideoTracks()[0];
            const caps = track?.getCapabilities?.();
            setTorchAvailable(Boolean(caps?.torch));
        } catch (_) {
            setTorchAvailable(false);
        }

        if (videoRef.current) {
            videoRef.current.srcObject = stream;
            try {
                await videoRef.current.play();
            } catch (playErr) {
                console.warn('[NativeQrScanner] Video play warning:', playErr);
            }
        }

        setLoading(false);
        isStartingRef.current = false;
        isScanningRef.current = true;

        // Initialize Native BarcodeDetector if available in browser
        let barcodeDetector = null;
        if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
            try {
                barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
            } catch (_) {
                barcodeDetector = null;
            }
        }

        let frameCount = 0;
        let isProcessing = false;
        let scanCooldownUntil = 0;
        const scanFrame = async () => {
            if (!isScanningRef.current || !videoRef.current) return;
            if (isProcessing) {
                if (isScanningRef.current) {
                    animRef.current = requestAnimationFrame(scanFrame);
                }
                return;
            }

            const now = Date.now();

            // If in cooldown from recent scan, keep animation frame alive but skip decoding
            if (now < scanCooldownUntil) {
                if (isScanningRef.current) {
                    animRef.current = requestAnimationFrame(scanFrame);
                }
                return;
            }

            const video = videoRef.current;
            const minInterval = barcodeDetector ? 30 : 40;

            // Scan every 30-40ms for instant recognition without stutter
            if (video.readyState >= 2 && now - lastScanTimeRef.current >= minInterval) {
                lastScanTimeRef.current = now;
                frameCount++;
                isProcessing = true;

                try {
                    // 1. Fast Native BarcodeDetector (hardware accelerated GPU pipeline)
                    let detected = false;
                    if (barcodeDetector) {
                        try {
                            const barcodes = await barcodeDetector.detect(video);
                            if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                                detected = true;
                                scanCooldownUntil = Date.now() + 3000;
                                if (onScanRef.current) onScanRef.current(barcodes[0].rawValue);
                                if (isScanningRef.current) {
                                    animRef.current = requestAnimationFrame(scanFrame);
                                }
                                return;
                            }
                        } catch (_) { }
                    }

                    // 2. High-performance multi-tier jsQR decoding engine
                    if (!detected && canvasRef.current) {
                        try {
                            const canvas = canvasRef.current;
                            const vW = video.videoWidth || 640;
                            const vH = video.videoHeight || 480;
                            const ctx = canvas.getContext('2d', { willReadFrequently: true });

                            if (ctx && vW > 0 && vH > 0) {
                                let code = null;

                                // Pass 1: 1:1 Sensor Center-Crop (No downscaling blur; 8-10 pixels per module)
                                // Students aim the camera reticle at the QR code on screen.
                                const cropSize = Math.min(520, Math.min(vW, vH));
                                const sx = Math.floor((vW - cropSize) / 2);
                                const sy = Math.floor((vH - cropSize) / 2);

                                if (canvas.width !== cropSize || canvas.height !== cropSize) {
                                    canvas.width = cropSize;
                                    canvas.height = cropSize;
                                }

                                ctx.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, cropSize, cropSize);
                                const cropImg = ctx.getImageData(0, 0, cropSize, cropSize);

                                code = jsQR(cropImg.data, cropSize, cropSize, {
                                    inversionAttempts: frameCount % 4 === 0 ? 'attemptBoth' : 'dontInvert'
                                });

                                // Pass 2: High-resolution full-frame scan (720px width) if not in center crop
                                if (!code && frameCount % 2 === 0) {
                                    const fullW = Math.min(720, vW);
                                    const fullH = Math.round(fullW * (vH / vW)) || 480;
                                    if (canvas.width !== fullW || canvas.height !== fullH) {
                                        canvas.width = fullW;
                                        canvas.height = fullH;
                                    }
                                    ctx.drawImage(video, 0, 0, fullW, fullH);
                                    const fullImg = ctx.getImageData(0, 0, fullW, fullH);
                                    code = jsQR(fullImg.data, fullW, fullH, {
                                        inversionAttempts: 'dontInvert'
                                    });
                                }

                                if (code && code.data) {
                                    detected = true;
                                    scanCooldownUntil = Date.now() + 3000;
                                    if (onScanRef.current) onScanRef.current(code.data);
                                    if (isScanningRef.current) {
                                        animRef.current = requestAnimationFrame(scanFrame);
                                    }
                                    return;
                                }
                            }
                        } catch (decodeErr) {
                            console.warn('[NativeQrScanner] Frame decode notice:', decodeErr);
                        }
                    }
                } finally {
                    isProcessing = false;
                }
            }

            if (isScanningRef.current) {
                animRef.current = requestAnimationFrame(scanFrame);
            }
        };

        animRef.current = requestAnimationFrame(scanFrame);
    }, [active, facingMode, stopStream]);

    const startCameraRef = useRef(startCamera);
    useEffect(() => { startCameraRef.current = startCamera; }, [startCamera]);

    const activeFacingModeRef = useRef(facingMode);
    useEffect(() => {
        if (activeFacingModeRef.current !== facingMode) {
            activeFacingModeRef.current = facingMode;
            stopStream();
        }
        if (active) {
            startCameraRef.current();
        } else {
            stopStream();
        }
        return () => {
            stopStream();
        };
        // Only re-run on actual active/facingMode changes — not on callback identity changes
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, facingMode]);

    const toggleTorch = async () => {
        if (!streamRef.current || !torchAvailable) return;
        try {
            const track = streamRef.current.getVideoTracks()[0];
            const next = !torchOn;
            await track.applyConstraints({ advanced: [{ torch: next }] });
            setTorchOn(next);
        } catch (e) {
            console.warn('[NativeQrScanner] Torch error:', e);
        }
    };

    return (
        <div style={{
            position: 'relative',
            width: '100%',
            minHeight: '280px',
            height: '320px',
            background: '#020617',
            borderRadius: '16px',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.25)'
        }}>
            {/* Live Video Viewport */}
            <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    transform: facingMode === 'user' ? 'scaleX(-1)' : 'none',
                    display: loading || errorMsg ? 'none' : 'block'
                }}
            />

            {/* Hidden Offscreen Canvas for Frame Extraction */}
            <canvas ref={canvasRef} style={{ display: 'none' }} />

            {/* Loading Spinner */}
            {loading && !errorMsg && (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#94a3b8',
                    gap: '12px'
                }}>
                    <FaSpinner className="fa-spin" style={{ fontSize: '2.2rem', color: '#6366f1' }} />
                    <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#c7d2fe' }}>Starting {facingMode === 'user' ? 'front' : 'rear'} camera...</span>
                </div>
            )}

            {/* Error Message with Immediate Retry */}
            {errorMsg && (
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
                    textAlign: 'center',
                    gap: '12px',
                    zIndex: 10
                }}>
                    <FaExclamationTriangle style={{ fontSize: '2.4rem', color: '#f59e0b' }} />
                    <p style={{ margin: 0, fontSize: '0.88rem', color: '#cbd5e1', maxWidth: '280px', lineHeight: 1.45 }}>
                        {errorMsg}
                    </p>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                        <button
                            type="button"
                            onClick={startCamera}
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '6px',
                                padding: '9px 16px',
                                borderRadius: '10px',
                                background: '#6366f1',
                                color: '#ffffff',
                                border: 'none',
                                fontWeight: 700,
                                fontSize: '0.85rem',
                                cursor: 'pointer',
                                boxShadow: '0 4px 12px rgba(99, 102, 241, 0.35)'
                            }}
                        >
                            <FaSyncAlt /> Retry Camera
                        </button>
                    </div>
                </div>
            )}

            {/* Futuristic Scanning Reticle (Visible when camera is active) */}
            {!loading && !errorMsg && (
                <div style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}>
                    {/* Viewfinder Target Frame */}
                    <div style={{
                        width: '210px',
                        height: '210px',
                        border: '2px solid rgba(99, 102, 241, 0.85)',
                        borderRadius: '20px',
                        position: 'relative',
                        boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45)',
                        overflow: 'hidden'
                    }}>
                        {/* Animated Scanning Laser Line */}
                        <div style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            height: '2px',
                            background: 'linear-gradient(90deg, transparent, #6366f1, #a5b4fc, #6366f1, transparent)',
                            boxShadow: '0 0 10px #6366f1, 0 0 4px #a5b4fc',
                            animation: 'scanLaser 2.2s ease-in-out infinite'
                        }} />
                        <style>{`
                            @keyframes scanLaser {
                                0% { top: 6%; opacity: 0.3; }
                                50% { top: 92%; opacity: 1; }
                                100% { top: 6%; opacity: 0.3; }
                            }
                        `}</style>
                    </div>

                    {/* Camera Badge: Rear/Front Camera Active Indicator */}
                    <div style={{
                        position: 'absolute',
                        top: '12px',
                        left: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '5px 11px',
                        borderRadius: '20px',
                        background: 'rgba(15, 23, 42, 0.8)',
                        color: '#e2e8f0',
                        fontSize: '0.74rem',
                        fontWeight: 700,
                        backdropFilter: 'blur(6px)',
                        border: '1px solid rgba(255, 255, 255, 0.15)',
                        zIndex: 5
                    }}>
                        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 6px #10b981' }}></span>
                        {facingMode === 'user' ? 'Front Camera' : 'Rear Camera'} · Scanning QR
                    </div>

                    {/* Camera Control Action Buttons: Camera Switch (Lecturers) & Torch / Flashlight */}
                    <div style={{
                        position: 'absolute',
                        top: '12px',
                        right: '12px',
                        display: 'flex',
                        gap: '8px',
                        pointerEvents: 'auto',
                        zIndex: 5
                    }}>
                        {onToggleFacingMode && (
                            <button
                                type="button"
                                onClick={onToggleFacingMode}
                                title={`Switch to ${facingMode === 'user' ? 'Rear' : 'Front'} Camera`}
                                style={{
                                    width: '38px',
                                    height: '38px',
                                    borderRadius: '50%',
                                    background: 'rgba(15, 23, 42, 0.75)',
                                    color: '#ffffff',
                                    border: '1px solid rgba(255, 255, 255, 0.25)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    cursor: 'pointer',
                                    backdropFilter: 'blur(6px)'
                                }}
                            >
                                <FaSyncAlt style={{ fontSize: '0.9rem' }} />
                            </button>
                        )}
                        {torchAvailable && (
                            <button
                                type="button"
                                onClick={toggleTorch}
                                title={torchOn ? 'Turn Off Flashlight' : 'Turn On Flashlight'}
                                style={{
                                    width: '38px',
                                    height: '38px',
                                    borderRadius: '50%',
                                    background: torchOn ? '#eab308' : 'rgba(15, 23, 42, 0.75)',
                                    color: torchOn ? '#000000' : '#ffffff',
                                    border: '1px solid rgba(255, 255, 255, 0.25)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    cursor: 'pointer',
                                    backdropFilter: 'blur(6px)'
                                }}
                            >
                                <FaBolt style={{ fontSize: '0.9rem' }} />
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export default NativeQrScanner;
