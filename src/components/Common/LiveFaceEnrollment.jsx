import React, { useEffect, useRef, useState, useCallback } from "react";
import * as faceapi from "@vladmandic/face-api";
import {
    FaCamera,
    FaCheckCircle,
    FaRedo,
    FaSpinner,
    FaShieldAlt,
    FaVideo,
    FaLock,
    FaInfoCircle,
    FaArrowLeft,
    FaArrowRight,
    FaArrowUp,
    FaBullseye,
    FaUserTimes,
    FaBolt,
    FaIdCard,
    FaDownload
} from "react-icons/fa";
import { useAuth } from "../authcontext";
import { checkDuplicateFaceBiometrics } from "../../utils/biometricManager";
import { BiometricLivenessEngine, fuseFaceDescriptors } from "../../utils/livenessDetector";
import { isBrowserCameraAllowed } from "../../utils/deviceDetection";
import { getApkDownloadUrl } from "../../utils/apkUrl";
import "./LiveFaceEnrollment.css";

const MODEL_CDN_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";

export function LiveFaceEnrollment({
    onFaceEnrolled,
    initialPhoto = null,
    hideHeader = false,
    targetRollNo = "",
    targetEmail = "",
    targetName = ""
}) {
    const { user, profile } = useAuth();
    const browserCameraAuth = isBrowserCameraAllowed(profile, user);
    const isCameraAllowed = browserCameraAuth.allowed;

    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const canvasRef = useRef(null);
    const animationRef = useRef(null);
    const livenessEngineRef = useRef(null);
    const blinkCountRef = useRef(0);
    const hasTriggeredCompleteRef = useRef(false);
    const bufferedDescriptorsRef = useRef([]);
    const frameCountRef = useRef(0);
    const isDetectingRef = useRef(false);

    const [cameraActive, setCameraActive] = useState(false);
    const [cameraLoading, setCameraLoading] = useState(false);
    const [permissionStatus, setPermissionStatus] = useState("unknown");
    const [cameraError, setCameraError] = useState("");
    const [modelsLoaded, setModelsLoaded] = useState(false);
    const [capturing, setCapturing] = useState(false);
    const [statusMessage, setStatusMessage] = useState("Align face inside the biometric circle");
    const [statusType, setStatusType] = useState("ready");
    const [enrolledPhoto, setEnrolledPhoto] = useState(initialPhoto);
    const [capturedVector, setCapturedVector] = useState(null);
    const [flashEffect, setFlashEffect] = useState(false);
    const [duplicateError, setDuplicateError] = useState("");
    // 3D Liveness Interactive State
    const DEFAULT_CHECKPOINTS = {
        CENTER: false,
        LEFT: false,
        RIGHT: false,
        UP: false,
        BLINK: false
    };
    const [checkpoints, setCheckpoints] = useState(DEFAULT_CHECKPOINTS);
    const [currentStep, setCurrentStep] = useState("CENTER");
    const [currentPose, setCurrentPose] = useState("CENTER");
    const [progress, setProgress] = useState(0);
    const [isBiometricVerified, setIsBiometricVerified] = useState(false);

    // Initialize Multi-Angle Liveness Engine
    useEffect(() => {
        livenessEngineRef.current = new BiometricLivenessEngine({
            onStateChange: (state) => {
                if (!state) return;
                const nextCheckpoints = state.checkpoints || (state.completedChallenges ? {
                    CENTER: state.completedChallenges.includes("CENTER"),
                    LEFT: state.completedChallenges.includes("TURN_LEFT") || state.completedChallenges.includes("LEFT"),
                    RIGHT: state.completedChallenges.includes("TURN_RIGHT") || state.completedChallenges.includes("RIGHT"),
                    UP: state.completedChallenges.includes("TILT_UP") || state.completedChallenges.includes("UP"),
                    BLINK: state.completedChallenges.includes("BLINK") || state.completedChallenges.includes("SMILE")
                } : DEFAULT_CHECKPOINTS);

                setCheckpoints(nextCheckpoints);
                setCurrentStep(state.currentStep || "CENTER");
                setCurrentPose(state.currentPose || "CENTER");
                setProgress(state.progress || 0);
                setIsBiometricVerified(Boolean(state.isComplete));

                if (!capturing && !enrolledPhoto && state.message) {
                    setStatusMessage(state.message);
                }
                if (state.statusType) {
                    setStatusType(state.statusType);
                }

                // Instant Trigger on 100% Verification
                if (state.isComplete && !hasTriggeredCompleteRef.current && !capturing && !enrolledPhoto) {
                    hasTriggeredCompleteRef.current = true;
                    setTimeout(() => {
                        handleCaptureFace();
                    }, 120);
                }
            }
        });
    }, [capturing, enrolledPhoto]);

    // 1. Check Camera Permission
    useEffect(() => {
        const checkPerms = async () => {
            if (typeof window !== "undefined") {
                const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
                if (!window.isSecureContext && !isLocal) {
                    setPermissionStatus("insecure");
                    return;
                }

                if (navigator.permissions && navigator.permissions.query) {
                    try {
                        const res = await navigator.permissions.query({ name: "camera" });
                        setPermissionStatus(res.state);
                        res.onchange = () => {
                            setPermissionStatus(res.state);
                            if (res.state === "granted" && !cameraActive && !enrolledPhoto) {
                                startCameraStream();
                            }
                        };
                    } catch (e) { }
                }
            }
        };
        checkPerms();
    }, [cameraActive, enrolledPhoto]);

    // 2. Load Neural Face Recognition Models
    const loadAiModels = useCallback(async () => {
        try {
            if (
                faceapi.nets.tinyFaceDetector.isLoaded &&
                faceapi.nets.faceLandmark68Net.isLoaded &&
                faceapi.nets.faceRecognitionNet.isLoaded
            ) {
                setModelsLoaded(true);
                return true;
            }

            try {
                await Promise.all([
                    faceapi.nets.tinyFaceDetector.loadFromUri("/models"),
                    faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
                    faceapi.nets.faceRecognitionNet.loadFromUri("/models")
                ]);
            } catch (localErr) {
                console.warn("Local models load failed, loading from CDN:", localErr);
                await Promise.all([
                    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_CDN_URL),
                    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_CDN_URL),
                    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_CDN_URL)
                ]);
            }
            setModelsLoaded(true);
            return true;
        } catch (modelErr) {
            console.error("AI Models load error:", modelErr);
            return false;
        }
    }, []);

    useEffect(() => {
        loadAiModels();
        if (!initialPhoto && isCameraAllowed) {
            startCameraStream();
        }

        return () => {
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
                animationRef.current = null;
            }
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
            }
        };
    }, [loadAiModels, initialPhoto]);

    // 3. Start Camera Stream
    const startCameraStream = async () => {
        setCameraError("");
        setDuplicateError("");
        setCameraLoading(true);
        setStatusMessage("Connecting camera...");
        setStatusType("ready");
        hasTriggeredCompleteRef.current = false;

        try {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => {
                    try { t.stop(); } catch (_) { }
                });
                streamRef.current = null;
            }

            // Release any active video tracks across DOM to avoid hardware HAL collisions
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

            // Cooldown for hardware camera HAL release
            await new Promise((r) => setTimeout(r, 200));

            if (!isCameraAllowed) {
                setCameraError("Camera in browser is only available for Lecturers, Admins, and iPhone users. Android students must use the official SmartAttend Android App (.apk).");
                setCameraLoading(false);
                return;
            }

            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error("Camera API is not supported in this browser.");
            }

            // Check if device enumeration can find a front/user camera deviceId
            let frontDeviceId = null;
            try {
                if (navigator?.mediaDevices?.enumerateDevices) {
                    const devs = await navigator.mediaDevices.enumerateDevices();
                    const videoDevs = devs.filter((d) => d.kind === 'videoinput');
                    const frontDev = videoDevs.find((d) =>
                        /front|user|selfie|face/i.test(d.label)
                    );
                    if (frontDev?.deviceId) {
                        frontDeviceId = frontDev.deviceId;
                    }
                }
            } catch (_) { }

            const attempts = [
                ...(frontDeviceId ? [{
                    video: {
                        deviceId: { exact: frontDeviceId },
                        width: { ideal: 640, min: 320 },
                        height: { ideal: 480, min: 240 }
                    },
                    audio: false
                }] : []),
                {
                    video: {
                        facingMode: { ideal: "user" },
                        width: { ideal: 640, min: 320 },
                        height: { ideal: 480, min: 240 }
                    },
                    audio: false
                },
                {
                    video: {
                        facingMode: "user",
                        width: { ideal: 640, min: 320 },
                        height: { ideal: 480, min: 240 }
                    },
                    audio: false
                },
                { video: { facingMode: { ideal: "user" } }, audio: false },
                { video: { facingMode: "user" }, audio: false },
                { video: true, audio: false }
            ];

            let stream = null;
            let lastErr = null;
            for (const constraints of attempts) {
                try {
                    stream = await navigator.mediaDevices.getUserMedia(constraints);
                    if (stream && stream.getVideoTracks().length > 0) {
                        break;
                    }
                } catch (err) {
                    lastErr = err;
                    console.warn("Front camera attempt notice:", constraints, err?.name, err?.message);
                    if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
                        throw err;
                    }
                }
            }

            if (!stream) {
                throw lastErr || new Error("Unable to obtain front camera stream.");
            }

            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.setAttribute("autoplay", "true");
                videoRef.current.setAttribute("playsinline", "true");
                videoRef.current.setAttribute("muted", "true");
                videoRef.current.play().catch((e) => console.warn("Video play error:", e));
            }
            setCameraActive(true);
            setPermissionStatus("granted");
            if (livenessEngineRef.current) {
                livenessEngineRef.current.reset();
            }
            setStatusMessage("🎯 Look straight into camera · Capturing 3D biometrics in 2s...");
            setStatusType("ready");
        } catch (camErr) {
            console.error("Camera access error:", camErr);
            setCameraActive(false);
            if (camErr.name === "NotAllowedError" || camErr.name === "PermissionDeniedError") {
                setPermissionStatus("denied");
                setCameraError("Camera permission blocked in browser. Allow camera permission or upload a photo.");
            } else {
                setCameraError(camErr.message || "Failed to start camera.");
            }
            setStatusMessage("⚠️ Camera unavailable. You can upload a photo below.");
            setStatusType("warning");
        } finally {
            setCameraLoading(false);
        }
    };

    // 4. Real-time Multi-Angle Tracking Loop (smooth non-blocking 60fps camera feed)
    useEffect(() => {
        if (!cameraActive || !modelsLoaded || enrolledPhoto) return;

        let isRunning = true;
        let lastScanTime = 0;
        const isMobileDevice = typeof window !== "undefined" && (window.innerWidth <= 768 || /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || ""));
        const detectorInputSize = isMobileDevice ? 160 : 224;
        const detectorOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: detectorInputSize, scoreThreshold: 0.35 });
        const scanInterval = isMobileDevice ? 45 : 35;

        const runLiveTracking = async (time) => {
            if (!isRunning) return;

            if (time - lastScanTime > scanInterval && !isDetectingRef.current && videoRef.current && videoRef.current.readyState >= 2) {
                lastScanTime = time;
                isDetectingRef.current = true;

                try {
                    const video = videoRef.current;
                    const canvas = canvasRef.current;

                    if (canvas && video.videoWidth > 0 && video.videoHeight > 0) {
                        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
                            canvas.width = video.videoWidth;
                            canvas.height = video.videoHeight;
                        }
                    }

                    // Lightweight 60 FPS live tracking: landmark extraction only
                    // ResNet-34 descriptor is strictly computed once upon capture snapshot
                    const detection = await faceapi
                        .detectSingleFace(video, detectorOptions)
                        .withFaceLandmarks();

                    const ctx = canvas ? canvas.getContext("2d") : null;
                    if (ctx && canvas) {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                    }

                    if (detection) {
                        frameCountRef.current = (frameCountRef.current || 0) + 1;

                        if (livenessEngineRef.current) {
                            livenessEngineRef.current.processFrame(detection);
                        }

                        // Render Canvas HUD Reticle
                        if (ctx && canvas) {
                            const { x, y, width, height } = detection.detection.box;
                            const cornerLen = Math.min(width, height) * 0.20;

                            ctx.lineWidth = 3;
                            ctx.strokeStyle = isBiometricVerified ? "#10b981" : "#6366f1";
                            ctx.lineCap = "round";

                            // Corner brackets
                            ctx.beginPath();
                            ctx.moveTo(x, y + cornerLen);
                            ctx.lineTo(x, y);
                            ctx.lineTo(x + cornerLen, y);
                            ctx.stroke();

                            ctx.beginPath();
                            ctx.moveTo(x + width - cornerLen, y);
                            ctx.lineTo(x + width, y);
                            ctx.lineTo(x + width, y + cornerLen);
                            ctx.stroke();

                            ctx.beginPath();
                            ctx.moveTo(x, y + height - cornerLen);
                            ctx.lineTo(x, y + height);
                            ctx.lineTo(x + cornerLen, y + height);
                            ctx.stroke();

                            ctx.beginPath();
                            ctx.moveTo(x + width - cornerLen, y + height);
                            ctx.lineTo(x + width, y + height);
                            ctx.lineTo(x + width, y + height - cornerLen);
                            ctx.stroke();

                            // Eye landmarks highlight
                            const leftEye = detection.landmarks.positions.slice(36, 42);
                            const rightEye = detection.landmarks.positions.slice(42, 48);
                            ctx.fillStyle = isBiometricVerified ? "rgba(16, 185, 129, 0.9)" : "rgba(99, 102, 241, 0.85)";
                            [...leftEye, ...rightEye].forEach((pt) => {
                                ctx.beginPath();
                                ctx.arc(pt.x, pt.y, 2.2, 0, 2 * Math.PI);
                                ctx.fill();
                            });
                        }
                    } else {
                        if (livenessEngineRef.current) {
                            livenessEngineRef.current.processFrame(null);
                        }
                    }
                } catch (e) {
                } finally {
                    isDetectingRef.current = false;
                }
            }

            if (isRunning) {
                animationRef.current = requestAnimationFrame(runLiveTracking);
            }
        };

        animationRef.current = requestAnimationFrame(runLiveTracking);

        return () => {
            isRunning = false;
            if (animationRef.current) cancelAnimationFrame(animationRef.current);
        };
    }, [cameraActive, modelsLoaded, enrolledPhoto, isBiometricVerified]);

    // 5. Fast Biometric Vector Capture & Duplicate Verification
    const handleCaptureFace = async () => {
        if (!videoRef.current || capturing) return;
        setCapturing(true);
        setStatusMessage("⚡ Extracting 128-D biometric vector & verifying...");
        setStatusType("capturing");

        // Flash effect for shutter feedback
        setFlashEffect(true);
        setTimeout(() => setFlashEffect(false), 220);

        try {
            const canvas = document.createElement("canvas");
            canvas.width = videoRef.current.videoWidth || 640;
            canvas.height = videoRef.current.videoHeight || 480;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

            // Fast single-pass 128-D descriptor extraction directly on aligned face
            let detection = null;
            try {
                detection = await faceapi
                    .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.30 }))
                    .withFaceLandmarks()
                    .withFaceDescriptor();
            } catch (_) { }

            // Quick fallback only if first pass did not resolve
            if (!detection || !detection.descriptor) {
                try {
                    detection = await faceapi
                        .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.25 }))
                        .withFaceLandmarks()
                        .withFaceDescriptor();
                } catch (_) { }
            }

            if (!detection || !detection.descriptor) {
                try {
                    detection = await faceapi
                        .detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.25 }))
                        .withFaceLandmarks()
                        .withFaceDescriptor();
                } catch (_) { }
            }

            let descriptorArray = detection && detection.descriptor ? Array.from(detection.descriptor) : null;

            if (!descriptorArray || descriptorArray.length !== 128) {
                setStatusMessage("❌ Face not detected clearly. Look straight into camera and retry.");
                setStatusType("warning");
                setCapturing(false);
                hasTriggeredCompleteRef.current = false;
                return;
            }

            // DUPLICATE BIOMETRICS SECURITY CHECK
            setStatusMessage("🔍 Verifying biometric uniqueness across registry...");
            const duplicateCheck = await checkDuplicateFaceBiometrics(descriptorArray, targetRollNo, targetEmail);

            if (duplicateCheck.isDuplicate && duplicateCheck.conflictStudent) {
                const cs = duplicateCheck.conflictStudent;
                const errText = `⛔ Duplicate Face Detected! This biometric profile matches "${cs.name}" (Roll No: ${cs.rollNo}). Multiple students cannot share identical face templates.`;
                setDuplicateError(errText);
                setStatusMessage(errText);
                setStatusType("warning");
                setCapturing(false);
                hasTriggeredCompleteRef.current = false;
                return;
            }

            const photoDataUrl = canvas.toDataURL("image/jpeg", 0.90);
            setEnrolledPhoto(photoDataUrl);
            setCapturedVector(descriptorArray);
            setStatusMessage("✅ 3D Facial Biometrics Enrolled & Verified Unique!");
            setStatusType("success");

            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
                setCameraActive(false);
            }

            if (onFaceEnrolled) {
                onFaceEnrolled({
                    faceDescriptor: descriptorArray,
                    photoURL: photoDataUrl,
                    biometricEnrolled: true,
                    livenessConfirmed: true,
                    biometricVerified: true,
                    blinkCount: blinkCountRef.current || 1,
                    enrolledAt: Date.now()
                });
            }
        } catch (err) {
            console.error("Capture error:", err);
            setStatusMessage("Failed to process biometric face. Please try again.");
            setStatusType("warning");
            hasTriggeredCompleteRef.current = false;
        } finally {
            setCapturing(false);
        }
    };

    const handleRetake = () => {
        setEnrolledPhoto(null);
        setCapturedVector(null);
        setDuplicateError("");
        setIsBiometricVerified(false);
        setProgress(0);
        bufferedDescriptorsRef.current = [];
        frameCountRef.current = 0;
        hasTriggeredCompleteRef.current = false;
        if (livenessEngineRef.current) {
            livenessEngineRef.current.reset();
        }
        setStatusMessage("🎯 Step 1/4: Look straight into camera");
        setStatusType("ready");
        if (onFaceEnrolled) {
            onFaceEnrolled(null);
        }
        startCameraStream();
    };

    const safeCheckpoints = checkpoints || DEFAULT_CHECKPOINTS;

    return (
        <div className={`live-enrollment-card biohud-auth-card ${hideHeader ? "in-modal" : ""}`}>
            {/* Viewport Container with 3D Biometric Multi-Angle Radar HUD */}
            <div
                className={`lfe-viewport-container biohud-viewport ${enrolledPhoto ? "enrolled" : ""} ${isBiometricVerified ? "verified" : ""} ${capturing ? "capturing" : ""} ${flashEffect ? "flash" : ""}`}
            >
                {/* 3D Circular Biometric Reticle HUD */}
                {!enrolledPhoto && cameraActive && (
                    <div className="biohud-compass-hud">
                        {/* 360 Progress SVG Ring */}
                        <svg className="biohud-ring-svg" viewBox="0 0 260 260">
                            <circle
                                className="biohud-ring-bg"
                                cx="130"
                                cy="130"
                                r="118"
                            />
                            <circle
                                className="biohud-ring-progress"
                                cx="130"
                                cy="130"
                                r="118"
                                style={{
                                    strokeDasharray: 741,
                                    strokeDashoffset: 741 - (741 * progress) / 100
                                }}
                            />
                        </svg>

                        {/* Central Dynamic Status Guide */}
                        <div className="biohud-dynamic-pointer">
                            {progress >= 100 || isBiometricVerified ? (
                                <div className="pointer-icon success-check">✅</div>
                            ) : progress > 0 ? (
                                <div className="pointer-icon pulse-center" style={{ fontSize: "0.88rem", fontWeight: 800, color: "#ffffff", textShadow: "0 2px 8px rgba(0,0,0,0.85)" }}>
                                    ⚡ {progress}%
                                </div>
                            ) : (
                                <div className="pointer-icon pulse-center">🎯</div>
                            )}
                        </div>
                    </div>
                )}

                {/* Camera Shutter Flash */}
                {flashEffect && <div className="lfe-shutter-flash" />}

                {/* Enrolled Photo Display */}
                {enrolledPhoto ? (
                    <div className="lfe-enrolled-preview-wrap">
                        <img src={enrolledPhoto} alt="Enrolled Biometric Face" className="lfe-preview-img" />
                        <div className="lfe-enrolled-floating-badge">
                            <FaCheckCircle className="badge-icon" />
                            <span>Live Facial Biometrics Enrolled</span>
                        </div>
                    </div>
                ) : (
                    /* CAMERA STREAM */
                    <>
                        <video
                            ref={videoRef}
                            autoPlay
                            playsInline
                            muted
                            className="lfe-video"
                            style={{ display: cameraActive ? "block" : "none" }}
                        />
                        <canvas
                            ref={canvasRef}
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                height: "100%",
                                pointerEvents: "none",
                                transform: "scaleX(-1)",
                                display: cameraActive ? "block" : "none"
                            }}
                        />

                        {/* Standby Camera Box */}
                        {!cameraActive && (
                            <div className="lfe-camera-placeholder">
                                {!isCameraAllowed ? (
                                    <>
                                        <div className="lfe-placeholder-icon-wrap" style={{ background: '#fee2e2', color: '#dc2626' }}>
                                            <FaLock className="lfe-camera-placeholder-icon" />
                                        </div>
                                        <h5 style={{ color: '#991b1b' }}>Camera Unavailable in Web Browser</h5>
                                        <p>
                                            Per college attendance policy, camera access in the web browser is only available for <strong>Lecturers</strong>, <strong>Admins</strong>, and <strong>iPhone users</strong>.
                                        </p>
                                        <div style={{
                                            padding: '10px 14px',
                                            borderRadius: '10px',
                                            background: '#fef2f2',
                                            border: '1px solid #fecaca',
                                            color: '#b91c1c',
                                            fontSize: '0.84rem',
                                            fontWeight: 700,
                                            margin: '12px 0 16px',
                                            textAlign: 'left',
                                            lineHeight: 1.45
                                        }}>
                                            🛡️ Android students must use the official <strong>SmartAttend Android App (.apk)</strong> for live facial biometrics registration and attendance.
                                        </div>
                                        <div className="lfe-placeholder-btn-group">
                                            <a
                                                href={getApkDownloadUrl()}
                                                download="SmartAttend-release.apk"
                                                className="lfe-primary-cam-btn"
                                                style={{ width: "100%", justifyContent: "center", textDecoration: "none", background: "#16a34a" }}
                                            >
                                                <FaDownload /> Download SmartAttend Android App (.apk)
                                            </a>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="lfe-placeholder-icon-wrap">
                                            <FaIdCard className="lfe-camera-placeholder-icon" />
                                        </div>
                                        <h5>Fast Facial Biometric Registration</h5>
                                        <p>Position your face inside the frame. The scanner will capture and verify your facial profile in ~2 seconds.</p>
                                        <div className="lfe-placeholder-btn-group">
                                            <button
                                                type="button"
                                                className="lfe-primary-cam-btn"
                                                onClick={startCameraStream}
                                                disabled={cameraLoading}
                                                style={{ width: "100%", justifyContent: "center" }}
                                            >
                                                {cameraLoading ? (
                                                    <><FaSpinner className="fa-spin" /> Starting Camera...</>
                                                ) : (
                                                    <><FaVideo /> Start Live Biometric Scan</>
                                                )}
                                            </button>
                                        </div>

                                        {permissionStatus === "denied" && (
                                            <div className="lfe-perm-denied-guide">
                                                <div style={{ fontWeight: 800, marginBottom: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
                                                    <FaLock /> Camera Blocked in Browser
                                                </div>
                                                <div>
                                                    Click the <strong>Lock / Camera icon 🔒</strong> in your address bar and set <strong>Camera</strong> to <strong>Allow</strong>.
                                                </div>
                                            </div>
                                        )}

                                        {cameraError && permissionStatus !== "denied" && (
                                            <div className="lfe-error-tip">
                                                <FaInfoCircle /> {cameraError}
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Interactive Step Pills & Progress */}
            {cameraActive && !enrolledPhoto && (
                <div className="biohud-steps-tray">
                    <div className="biohud-pills-row">
                        <span className={`biohud-pill ${progress >= 40 ? "done" : "current"}`}>
                            {progress >= 40 ? "✅" : "1️⃣"} Face Aligned
                        </span>
                        <span className={`biohud-pill ${progress >= 100 || isBiometricVerified ? "done" : progress >= 40 ? "current" : ""}`}>
                            {progress >= 100 || isBiometricVerified ? "✅" : "2️⃣"} Blink Reflex
                        </span>
                        <span className={`biohud-pill ${isBiometricVerified ? "done" : ""}`}>
                            {isBiometricVerified ? "✅" : "3️⃣"} Biometrics Ready
                        </span>
                    </div>

                    <div className="biohud-progress-track">
                        <div
                            className="biohud-progress-fill"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Status Capsule */}
            <div className="lfe-status-capsule-wrapper">
                <div className={`lfe-status-capsule ${statusType}`}>
                    {statusType === "success" && <FaCheckCircle style={{ color: "#10b981" }} />}
                    {statusType === "capturing" && <FaSpinner className="fa-spin" style={{ color: "#6366f1" }} />}
                    {statusType === "warning" && <FaInfoCircle style={{ color: "#f59e0b" }} />}
                    {statusType === "aligned" && <FaBolt style={{ color: "#10b981" }} />}
                    {statusType === "ready" && <FaShieldAlt style={{ color: "#6366f1" }} />}
                    <span>{statusMessage}</span>
                </div>

                {cameraActive && !enrolledPhoto && (
                    <span className="biohud-score-badge">
                        Biometric Progress: <strong>{progress}%</strong>
                    </span>
                )}
            </div>

            {/* Duplicate Error Alert */}
            {duplicateError && (
                <div className="lfe-duplicate-alert">
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: 800, fontSize: "0.95rem", marginBottom: "4px" }}>
                        <FaUserTimes style={{ color: "#ef4444" }} /> Duplicate Face Rejected
                    </div>
                    {duplicateError}
                </div>
            )}

            {/* Action Buttons */}
            <div className="lfe-actions">
                {enrolledPhoto ? (
                    <div className="lfe-enrolled-actions">
                        <button
                            type="button"
                            className="lfe-retake-btn"
                            onClick={handleRetake}
                        >
                            <FaRedo /> Retake / Register New Biometrics
                        </button>
                    </div>
                ) : cameraActive ? (
                    <div className="lfe-active-action-row">
                        <button
                            type="button"
                            className={`lfe-capture-btn ${isBiometricVerified ? "ready-pulse" : ""}`}
                            onClick={handleCaptureFace}
                            disabled={capturing || !modelsLoaded}
                        >
                            {capturing ? (
                                <><FaSpinner className="fa-spin" /> Enrolling Biometrics...</>
                            ) : (
                                <><FaCamera /> Capture Face Biometrics</>
                            )}
                        </button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export default LiveFaceEnrollment;
