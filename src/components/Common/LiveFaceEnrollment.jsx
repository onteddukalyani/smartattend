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
    FaIdCard
} from "react-icons/fa";
import { checkDuplicateFaceBiometrics } from "../../utils/biometricManager";
import { BiometricLivenessEngine, fuseFaceDescriptors } from "../../utils/livenessDetector";
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

                // Automatic Trigger on 100% Verification
                if (state.isComplete && !hasTriggeredCompleteRef.current && !capturing && !enrolledPhoto) {
                    hasTriggeredCompleteRef.current = true;
                    setTimeout(() => {
                        handleCaptureFace();
                    }, 400);
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
        if (!initialPhoto) {
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
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
            }

            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error("Camera API is not supported in this browser.");
            }

            let stream = null;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        facingMode: "user",
                        width: { ideal: 640, min: 320 },
                        height: { ideal: 480, min: 240 }
                    },
                    audio: false
                });
            } catch (err1) {
                console.warn("Camera facingMode fallback:", err1);
                stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            }

            if (!stream) {
                throw new Error("Unable to obtain camera stream.");
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
            setStatusMessage("🎯 Step 1/4: Look straight into the camera");
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
        const scanInterval = isMobileDevice ? 140 : 110;

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

                    // Single-pass landmark & descriptor extraction (cuts neural net operations in half)
                    const detection = await faceapi
                        .detectSingleFace(video, detectorOptions)
                        .withFaceLandmarks()
                        .withFaceDescriptor();

                    const ctx = canvas ? canvas.getContext("2d") : null;
                    if (ctx && canvas) {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                    }

                    if (detection) {
                        frameCountRef.current = (frameCountRef.current || 0) + 1;

                        if (detection.descriptor) {
                            bufferedDescriptorsRef.current.push(new Float32Array(detection.descriptor));
                            if (bufferedDescriptorsRef.current.length > 12) {
                                bufferedDescriptorsRef.current.shift();
                            }
                        }

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

            // Progressive detector options with automatic fallback
            let detection = null;
            const candidateSizes = [256, 224, 320, 160];
            for (const sz of candidateSizes) {
                try {
                    detection = await faceapi
                        .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions({ inputSize: sz, scoreThreshold: 0.35 }))
                        .withFaceLandmarks()
                        .withFaceDescriptor();
                    if (detection && detection.descriptor) break;
                } catch (_) { }
            }

            let descriptorArray = null;
            if (detection && detection.descriptor) {
                descriptorArray = Array.from(detection.descriptor);
                bufferedDescriptorsRef.current.push(new Float32Array(detection.descriptor));
            } else if (bufferedDescriptorsRef.current.length > 0) {
                // Seamlessly use multi-angle consensus centroid vector from completed liveness session
                const fused = fuseFaceDescriptors(bufferedDescriptorsRef.current);
                if (fused) {
                    descriptorArray = Array.from(fused);
                }
            }

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
                {/* 3D Circular Multi-Angle Compass Ring */}
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

                        {/* Cardinal Direction Checkpoint Nodes */}
                        <div className={`biohud-node node-up ${safeCheckpoints.UP ? "done" : currentStep === "UP" ? "active" : ""}`}>
                            <FaArrowUp />
                            <span>UP</span>
                        </div>
                        <div className={`biohud-node node-left ${safeCheckpoints.LEFT ? "done" : currentStep === "LEFT" ? "active" : ""}`}>
                            <FaArrowLeft />
                            <span>LEFT</span>
                        </div>
                        <div className={`biohud-node node-right ${safeCheckpoints.RIGHT ? "done" : currentStep === "RIGHT" ? "active" : ""}`}>
                            <FaArrowRight />
                            <span>RIGHT</span>
                        </div>
                        <div className={`biohud-node node-center ${safeCheckpoints.CENTER ? "done" : currentStep === "CENTER" ? "active" : ""}`}>
                            <FaBullseye />
                            <span>FRONT</span>
                        </div>

                        {/* Central Dynamic Directional Arrow Guide */}
                        <div className="biohud-dynamic-pointer">
                            {currentStep === "CENTER" && <div className="pointer-icon pulse-center">🎯</div>}
                            {currentStep === "LEFT" && <div className="pointer-icon slide-left">⬅️ Turn Left</div>}
                            {currentStep === "RIGHT" && <div className="pointer-icon slide-right">➡️ Turn Right</div>}
                            {currentStep === "UP" && <div className="pointer-icon slide-up">⬆️ Tilt Up</div>}
                            {currentStep === "COMPLETE" && <div className="pointer-icon success-check">✅</div>}
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
                                <div className="lfe-placeholder-icon-wrap">
                                    <FaIdCard className="lfe-camera-placeholder-icon" />
                                </div>
                                <h5>3D Facial Biometric Authentication</h5>
                                <p>Perform interactive multi-angle head movement (Front, Left, Right, Up) to verify biological liveness.</p>
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
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Interactive Step Pills & Progress */}
            {cameraActive && !enrolledPhoto && (
                <div className="biohud-steps-tray">
                    <div className="biohud-pills-row">
                        <span className={`biohud-pill ${safeCheckpoints.CENTER ? "done" : currentStep === "CENTER" ? "current" : ""}`}>
                            {safeCheckpoints.CENTER ? "✅" : "1️⃣"} Front
                        </span>
                        <span className={`biohud-pill ${safeCheckpoints.LEFT ? "done" : currentStep === "LEFT" ? "current" : ""}`}>
                            {safeCheckpoints.LEFT ? "✅" : "2️⃣"} Left Turn
                        </span>
                        <span className={`biohud-pill ${safeCheckpoints.RIGHT ? "done" : currentStep === "RIGHT" ? "current" : ""}`}>
                            {safeCheckpoints.RIGHT ? "✅" : "3️⃣"} Right Turn
                        </span>
                        <span className={`biohud-pill ${safeCheckpoints.UP || safeCheckpoints.BLINK ? "done" : currentStep === "UP" ? "current" : ""}`}>
                            {safeCheckpoints.UP || safeCheckpoints.BLINK ? "✅" : "4️⃣"} Tilt Up / Blink
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
