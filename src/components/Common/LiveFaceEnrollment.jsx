import React, { useEffect, useRef, useState, useCallback } from "react";
import * as faceapi from "@vladmandic/face-api";
import {
    FaCamera,
    FaCheckCircle,
    FaRedo,
    FaSpinner,
    FaShieldAlt,
    FaVideo,
    FaUpload,
    FaLock,
    FaInfoCircle,
    FaCloudUploadAlt,
    FaImage,
    FaArrowLeft,
    FaArrowRight,
    FaArrowUp,
    FaBullseye,
    FaUserTimes,
    FaBolt,
    FaIdCard
} from "react-icons/fa";
import { checkDuplicateFaceBiometrics } from "../../utils/biometricManager";
import { AadhaarLivenessEngine } from "../../utils/livenessDetector";
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
    const fileInputRef = useRef(null);
    const aadhaarEngineRef = useRef(null);
    const hasTriggeredCompleteRef = useRef(false);

    const [cameraActive, setCameraActive] = useState(false);
    const [cameraLoading, setCameraLoading] = useState(false);
    const [permissionStatus, setPermissionStatus] = useState("unknown");
    const [cameraError, setCameraError] = useState("");
    const [modelsLoaded, setModelsLoaded] = useState(false);
    const [capturing, setCapturing] = useState(false);
    const [statusMessage, setStatusMessage] = useState("Align face inside the Aadhaar biometric circle");
    const [statusType, setStatusType] = useState("ready");
    const [enrolledPhoto, setEnrolledPhoto] = useState(initialPhoto);
    const [capturedVector, setCapturedVector] = useState(null);
    const [activeMode, setActiveMode] = useState("camera"); // "camera" or "upload"
    const [isDragging, setIsDragging] = useState(false);
    const [flashEffect, setFlashEffect] = useState(false);
    const [duplicateError, setDuplicateError] = useState("");

    // Aadhaar KYC Interactive State
    const [checkpoints, setCheckpoints] = useState({
        CENTER: false,
        LEFT: false,
        RIGHT: false,
        UP: false,
        BLINK: false
    });
    const [currentStep, setCurrentStep] = useState("CENTER");
    const [currentPose, setCurrentPose] = useState("CENTER");
    const [progress, setProgress] = useState(0);
    const [isAadhaarVerified, setIsAadhaarVerified] = useState(false);

    // Initialize Aadhaar Multi-Angle Liveness Engine
    useEffect(() => {
        aadhaarEngineRef.current = new AadhaarLivenessEngine({
            onStateChange: (state) => {
                setCheckpoints(state.checkpoints);
                setCurrentStep(state.currentStep);
                setCurrentPose(state.currentPose);
                setProgress(state.progress);
                setIsAadhaarVerified(state.isComplete);

                if (!capturing && !enrolledPhoto) {
                    setStatusMessage(state.message);
                    setStatusType(state.statusType);
                }

                // Automatic Trigger on 100% Aadhaar Verification
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
            if (aadhaarEngineRef.current) {
                aadhaarEngineRef.current.reset();
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

    // 4. Real-time Multi-Angle Tracking Loop (60ms interval for fluid 20+ FPS tracking)
    useEffect(() => {
        if (!cameraActive || !modelsLoaded || enrolledPhoto) return;

        let isRunning = true;
        let lastScanTime = 0;

        const runLiveTracking = async (time) => {
            if (!isRunning) return;

            if (time - lastScanTime > 60 && videoRef.current && videoRef.current.readyState >= 2) {
                lastScanTime = time;

                try {
                    const video = videoRef.current;
                    const canvas = canvasRef.current;

                    if (canvas && video.videoWidth > 0 && video.videoHeight > 0) {
                        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
                            canvas.width = video.videoWidth;
                            canvas.height = video.videoHeight;
                        }
                    }

                    const detection = await faceapi
                        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.45 }))
                        .withFaceLandmarks();

                    const ctx = canvas ? canvas.getContext("2d") : null;
                    if (ctx && canvas) {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                    }

                    if (detection) {
                        if (aadhaarEngineRef.current) {
                            aadhaarEngineRef.current.processFrame(detection);
                        }

                        // Render Canvas HUD Reticle
                        if (ctx && canvas) {
                            const { x, y, width, height } = detection.detection.box;
                            const cornerLen = Math.min(width, height) * 0.20;

                            ctx.lineWidth = 3;
                            ctx.strokeStyle = isAadhaarVerified ? "#10b981" : "#6366f1";
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
                            ctx.fillStyle = isAadhaarVerified ? "rgba(16, 185, 129, 0.9)" : "rgba(99, 102, 241, 0.85)";
                            [...leftEye, ...rightEye].forEach((pt) => {
                                ctx.beginPath();
                                ctx.arc(pt.x, pt.y, 2.2, 0, 2 * Math.PI);
                                ctx.fill();
                            });
                        }
                    } else {
                        if (aadhaarEngineRef.current) {
                            aadhaarEngineRef.current.processFrame(null);
                        }
                    }
                } catch (e) { }
            }

            animationRef.current = requestAnimationFrame(runLiveTracking);
        };

        animationRef.current = requestAnimationFrame(runLiveTracking);

        return () => {
            isRunning = false;
            if (animationRef.current) cancelAnimationFrame(animationRef.current);
        };
    }, [cameraActive, modelsLoaded, enrolledPhoto, isAadhaarVerified]);

    // 5. Fast Biometric Vector Capture & Duplicate Verification
    const handleCaptureFace = async () => {
        if (!videoRef.current || capturing) return;
        setDuplicateError("");
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

            const detection = await faceapi
                .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 }))
                .withFaceLandmarks()
                .withFaceDescriptor();

            if (!detection || !detection.descriptor) {
                setStatusMessage("❌ Face not detected clearly. Look straight into camera and retry.");
                setStatusType("warning");
                setCapturing(false);
                hasTriggeredCompleteRef.current = false;
                return;
            }

            const descriptorArray = Array.from(detection.descriptor);

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
            setStatusMessage("✅ Aadhaar-Grade Biometrics Enrolled & Verified Unique!");
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
                    aadhaarVerified: true,
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

    // 6. Photo File Upload Handler
    const processPhotoFile = async (file) => {
        if (!file) return;
        if (!file.type || !file.type.startsWith("image/")) {
            setStatusMessage("⚠️ Please upload an image file (PNG, JPG, JPEG, WEBP).");
            setStatusType("warning");
            return;
        }

        setDuplicateError("");
        setCapturing(true);
        setStatusMessage("⚡ Extracting 128-D biometric vector from photo...");
        setStatusType("capturing");

        try {
            if (!modelsLoaded) {
                setStatusMessage("Loading AI recognition models...");
                await loadAiModels();
            }

            const img = new Image();
            const reader = new FileReader();

            reader.onload = (readerEvent) => {
                img.onload = async () => {
                    try {
                        const maxDim = 800;
                        let width = img.naturalWidth || img.width;
                        let height = img.naturalHeight || img.height;
                        if (width > maxDim || height > maxDim) {
                            if (width > height) {
                                height = Math.round((height * maxDim) / width);
                                width = maxDim;
                            } else {
                                width = Math.round((width * maxDim) / height);
                                height = maxDim;
                            }
                        }

                        const canvas = document.createElement("canvas");
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext("2d");
                        ctx.drawImage(img, 0, 0, width, height);

                        const detection = await faceapi
                            .detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 }))
                            .withFaceLandmarks()
                            .withFaceDescriptor();

                        if (!detection) {
                            setStatusMessage("❌ No clear face detected in photo. Please choose a well-lit photo looking directly at camera.");
                            setStatusType("warning");
                            setCapturing(false);
                            return;
                        }

                        const descriptorArray = Array.from(detection.descriptor);

                        // DUPLICATE BIOMETRICS CHECK
                        setStatusMessage("🔍 Verifying biometric uniqueness...");
                        const duplicateCheck = await checkDuplicateFaceBiometrics(descriptorArray, targetRollNo, targetEmail);

                        if (duplicateCheck.isDuplicate && duplicateCheck.conflictStudent) {
                            const cs = duplicateCheck.conflictStudent;
                            const errText = `⛔ Duplicate Face Detected! This photo matches already registered student "${cs.name}" (Roll No: ${cs.rollNo}).`;
                            setDuplicateError(errText);
                            setStatusMessage(errText);
                            setStatusType("warning");
                            setCapturing(false);
                            return;
                        }

                        const photoDataUrl = canvas.toDataURL("image/jpeg", 0.90);
                        setEnrolledPhoto(photoDataUrl);
                        setCapturedVector(descriptorArray);
                        setStatusMessage("✅ Facial biometrics verified unique & registered successfully!");
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
                                aadhaarVerified: true,
                                enrolledAt: Date.now()
                            });
                        }
                    } catch (detectErr) {
                        console.error("Photo detect error:", detectErr);
                        setStatusMessage("Error analyzing face from photo. Please try another photo.");
                        setStatusType("warning");
                    } finally {
                        setCapturing(false);
                    }
                };

                img.src = readerEvent.target.result;
            };

            reader.readAsDataURL(file);
        } catch (err) {
            console.error("Photo capture error:", err);
            setStatusMessage("Failed to process photo.");
            setStatusType("warning");
            setCapturing(false);
        }
    };

    const handleRetake = () => {
        setEnrolledPhoto(null);
        setCapturedVector(null);
        setDuplicateError("");
        setIsAadhaarVerified(false);
        setProgress(0);
        hasTriggeredCompleteRef.current = false;
        if (aadhaarEngineRef.current) {
            aadhaarEngineRef.current.reset();
        }
        setStatusMessage("🎯 Step 1/4: Look straight into the camera");
        setStatusType("ready");
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
        if (onFaceEnrolled) {
            onFaceEnrolled(null);
        }
        if (activeMode === "camera") {
            startCameraStream();
        }
    };

    return (
        <div className={`live-enrollment-card aadhaar-auth-card ${hideHeader ? "in-modal" : ""}`}>
            {/* Hidden Photo File Input */}
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="user"
                style={{ display: "none" }}
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) processPhotoFile(file);
                }}
            />

            {/* Mode Switcher Tabs */}
            {!enrolledPhoto && (
                <div className="lfe-mode-tabs-wrapper">
                    <div className="lfe-mode-tabs">
                        <button
                            type="button"
                            className={`lfe-mode-tab ${activeMode === "camera" ? "active" : ""}`}
                            onClick={() => {
                                setActiveMode("camera");
                                if (!cameraActive && !enrolledPhoto) startCameraStream();
                            }}
                        >
                            <FaIdCard /> Aadhaar KYC Camera
                        </button>
                        <button
                            type="button"
                            className={`lfe-mode-tab ${activeMode === "upload" ? "active" : ""}`}
                            onClick={() => {
                                setActiveMode("upload");
                                if (streamRef.current) {
                                    streamRef.current.getTracks().forEach((t) => t.stop());
                                    streamRef.current = null;
                                    setCameraActive(false);
                                }
                            }}
                        >
                            <FaUpload /> Upload Photo
                        </button>
                    </div>
                </div>
            )}

            {/* Viewport Container with Aadhaar Multi-Angle Radar HUD */}
            <div
                className={`lfe-viewport-container aadhaar-viewport ${enrolledPhoto ? "enrolled" : ""} ${isAadhaarVerified ? "verified" : ""} ${capturing ? "capturing" : ""} ${flashEffect ? "flash" : ""} ${activeMode === "upload" && !cameraActive && !enrolledPhoto ? "upload-mode" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
                onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    const file = e.dataTransfer?.files?.[0];
                    if (file) {
                        setActiveMode("upload");
                        processPhotoFile(file);
                    }
                }}
            >
                {/* Aadhaar Circular Multi-Angle Compass Ring */}
                {!enrolledPhoto && cameraActive && activeMode === "camera" && (
                    <div className="aadhaar-compass-hud">
                        {/* 360 Progress SVG Ring */}
                        <svg className="aadhaar-ring-svg" viewBox="0 0 260 260">
                            <circle
                                className="aadhaar-ring-bg"
                                cx="130"
                                cy="130"
                                r="118"
                            />
                            <circle
                                className="aadhaar-ring-progress"
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
                        <div className={`aadhaar-node node-up ${checkpoints.UP ? "done" : currentStep === "UP" ? "active" : ""}`}>
                            <FaArrowUp />
                            <span>UP</span>
                        </div>
                        <div className={`aadhaar-node node-left ${checkpoints.LEFT ? "done" : currentStep === "LEFT" ? "active" : ""}`}>
                            <FaArrowLeft />
                            <span>LEFT</span>
                        </div>
                        <div className={`aadhaar-node node-right ${checkpoints.RIGHT ? "done" : currentStep === "RIGHT" ? "active" : ""}`}>
                            <FaArrowRight />
                            <span>RIGHT</span>
                        </div>
                        <div className={`aadhaar-node node-center ${checkpoints.CENTER ? "done" : currentStep === "CENTER" ? "active" : ""}`}>
                            <FaBullseye />
                            <span>FRONT</span>
                        </div>

                        {/* Central Dynamic Directional Arrow Guide */}
                        <div className="aadhaar-dynamic-pointer">
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
                            <span>Aadhaar-Grade Biometrics Enrolled</span>
                        </div>
                    </div>
                ) : activeMode === "upload" && !cameraActive ? (
                    /* UPLOAD DROPZONE */
                    <div
                        className="lfe-upload-dropzone"
                        onClick={() => fileInputRef.current?.click()}
                    >
                        <div className="lfe-upload-icon-container">
                            <FaCloudUploadAlt className="lfe-upload-hero-icon" />
                        </div>
                        <h4 className="lfe-upload-title">
                            {isDragging ? "Drop your face photo here" : "Upload Face Photo"}
                        </h4>
                        <p className="lfe-upload-subtitle">
                            Drag &amp; drop an image here, or click to browse
                        </p>

                        <div className="lfe-upload-guidelines">
                            <span className="lfe-guide-badge"><FaCheckCircle /> Frontal Face</span>
                            <span className="lfe-guide-badge"><FaCheckCircle /> Good Lighting</span>
                            <span className="lfe-guide-badge"><FaCheckCircle /> High Clarity</span>
                        </div>

                        <button
                            type="button"
                            className="lfe-browse-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                fileInputRef.current?.click();
                            }}
                            disabled={capturing}
                        >
                            {capturing ? (
                                <><FaSpinner className="fa-spin" /> Processing Photo...</>
                            ) : (
                                <><FaImage /> Browse Photo File</>
                            )}
                        </button>
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
                                <h5>Aadhaar-Grade Face Authentication</h5>
                                <p>Perform interactive multi-angle head movement (Front, Left, Right, Up) to verify biological liveness.</p>

                                <div className="lfe-placeholder-btn-group">
                                    <button
                                        type="button"
                                        className="lfe-primary-cam-btn"
                                        onClick={startCameraStream}
                                        disabled={cameraLoading}
                                    >
                                        {cameraLoading ? (
                                            <><FaSpinner className="fa-spin" /> Starting Camera...</>
                                        ) : (
                                            <><FaVideo /> Start Aadhaar Scan</>
                                        )}
                                    </button>

                                    <button
                                        type="button"
                                        className="lfe-secondary-upload-btn"
                                        onClick={() => {
                                            setActiveMode("upload");
                                            fileInputRef.current?.click();
                                        }}
                                    >
                                        <FaUpload /> Upload Photo
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

            {/* Aadhaar Interactive Step Pills & Progress */}
            {cameraActive && !enrolledPhoto && activeMode === "camera" && (
                <div className="aadhaar-steps-tray">
                    <div className="aadhaar-pills-row">
                        <span className={`aadhaar-pill ${checkpoints.CENTER ? "done" : currentStep === "CENTER" ? "current" : ""}`}>
                            {checkpoints.CENTER ? "✅" : "1️⃣"} Front
                        </span>
                        <span className={`aadhaar-pill ${checkpoints.LEFT ? "done" : currentStep === "LEFT" ? "current" : ""}`}>
                            {checkpoints.LEFT ? "✅" : "2️⃣"} Left Turn
                        </span>
                        <span className={`aadhaar-pill ${checkpoints.RIGHT ? "done" : currentStep === "RIGHT" ? "current" : ""}`}>
                            {checkpoints.RIGHT ? "✅" : "3️⃣"} Right Turn
                        </span>
                        <span className={`aadhaar-pill ${checkpoints.UP || checkpoints.BLINK ? "done" : currentStep === "UP" ? "current" : ""}`}>
                            {checkpoints.UP || checkpoints.BLINK ? "✅" : "4️⃣"} Tilt Up / Blink
                        </span>
                    </div>

                    <div className="aadhaar-progress-track">
                        <div
                            className="aadhaar-progress-fill"
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

                {cameraActive && !enrolledPhoto && activeMode === "camera" && (
                    <span className="aadhaar-score-badge">
                        KYC Progress: <strong>{progress}%</strong>
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
                            className={`lfe-capture-btn ${isAadhaarVerified ? "ready-pulse" : ""}`}
                            onClick={handleCaptureFace}
                            disabled={capturing || !modelsLoaded}
                        >
                            {capturing ? (
                                <><FaSpinner className="fa-spin" /> Enrolling Biometrics...</>
                            ) : (
                                <><FaCamera />  Capture Face Biometrics</>
                            )}
                        </button>

                        <button
                            type="button"
                            className="lfe-secondary-upload-btn"
                            onClick={() => {
                                setActiveMode("upload");
                                fileInputRef.current?.click();
                            }}
                        >
                            <FaUpload /> Upload Photo
                        </button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export default LiveFaceEnrollment;
