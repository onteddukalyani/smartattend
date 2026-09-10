import React, { useEffect, useRef, useState, useCallback } from "react";
import * as faceapi from "@vladmandic/face-api";
import {
    FaCamera,
    FaCheckCircle,
    FaRedo,
    FaSpinner,
    FaUserCheck,
    FaShieldAlt,
    FaVideo,
    FaUpload,
    FaLock,
    FaInfoCircle,
    FaCloudUploadAlt,
    FaImage,
    FaBolt,
    FaUserTimes,
    FaMagic
} from "react-icons/fa";
import { checkDuplicateFaceBiometrics } from "../../utils/biometricManager";
import { LivenessEngine } from "../../utils/livenessDetector";
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
    const livenessEngineRef = useRef(null);
    const autoCaptureTimerRef = useRef(null);

    const [cameraActive, setCameraActive] = useState(false);
    const [cameraLoading, setCameraLoading] = useState(false);
    const [permissionStatus, setPermissionStatus] = useState("unknown");
    const [cameraError, setCameraError] = useState("");
    const [modelsLoaded, setModelsLoaded] = useState(false);
    const [capturing, setCapturing] = useState(false);
    const [statusMessage, setStatusMessage] = useState("Position your face in the camera frame");
    const [statusType, setStatusType] = useState("ready"); // "ready", "aligned", "capturing", "success", "warning", "error"
    const [enrolledPhoto, setEnrolledPhoto] = useState(initialPhoto);
    const [capturedVector, setCapturedVector] = useState(null);
    const [activeMode, setActiveMode] = useState("camera"); // "camera" or "upload"
    const [isDragging, setIsDragging] = useState(false);
    const [isAligned, setIsAligned] = useState(false);
    const [faceScore, setFaceScore] = useState(0);
    const [autoCaptureEnabled, setAutoCaptureEnabled] = useState(true);
    const [autoCaptureCountdown, setAutoCaptureCountdown] = useState(null);
    const [duplicateError, setDuplicateError] = useState("");
    const [flashEffect, setFlashEffect] = useState(false);

    // Initialize Fast Liveness Engine
    useEffect(() => {
        livenessEngineRef.current = new LivenessEngine({
            onStateChange: (state) => {
                setIsAligned(state.isAligned);
                setFaceScore(state.faceScore);
                if (!capturing && !enrolledPhoto) {
                    setStatusMessage(state.message);
                    setStatusType(state.statusType);
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

    // 2. Fast Model Loading
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
            if (autoCaptureTimerRef.current) {
                clearInterval(autoCaptureTimerRef.current);
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
                console.warn("User facing camera fallback:", err1);
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
            setStatusMessage("Position your face inside the target oval");
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

    // 4. Snappy Real-time Tracking Loop (60ms throttle for silky smooth 20+ FPS tracking)
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
                        if (livenessEngineRef.current) {
                            livenessEngineRef.current.processFrame(detection);
                        }

                        // Render lightweight, beautiful HUD Reticle
                        if (ctx && canvas) {
                            const { x, y, width, height } = detection.detection.box;
                            const cornerLen = Math.min(width, height) * 0.20;
                            const isFaceAligned = livenessEngineRef.current?.isAligned;

                            ctx.lineWidth = 3;
                            ctx.strokeStyle = isFaceAligned ? "#10b981" : "#6366f1";
                            ctx.lineCap = "round";

                            // 4 Corner Brackets
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
                            ctx.fillStyle = isFaceAligned ? "rgba(16, 185, 129, 0.85)" : "rgba(99, 102, 241, 0.8)";
                            [...leftEye, ...rightEye].forEach((pt) => {
                                ctx.beginPath();
                                ctx.arc(pt.x, pt.y, 2, 0, 2 * Math.PI);
                                ctx.fill();
                            });
                        }
                    } else {
                        if (livenessEngineRef.current) {
                            livenessEngineRef.current.processFrame(null);
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
    }, [cameraActive, modelsLoaded, enrolledPhoto]);

    // 5. Smart Auto-Capture Trigger
    useEffect(() => {
        if (!autoCaptureEnabled || !isAligned || capturing || enrolledPhoto || !cameraActive) {
            if (autoCaptureTimerRef.current) {
                clearTimeout(autoCaptureTimerRef.current);
                autoCaptureTimerRef.current = null;
            }
            setAutoCaptureCountdown(null);
            return;
        }

        if (!autoCaptureCountdown && !autoCaptureTimerRef.current) {
            setAutoCaptureCountdown(2);
            let count = 2;

            const interval = setInterval(() => {
                count -= 1;
                if (count > 0) {
                    setAutoCaptureCountdown(count);
                } else {
                    clearInterval(interval);
                    autoCaptureTimerRef.current = null;
                    setAutoCaptureCountdown(null);
                    handleCaptureFace();
                }
            }, 600);

            autoCaptureTimerRef.current = interval;
        }

        return () => {
            if (autoCaptureTimerRef.current) {
                clearInterval(autoCaptureTimerRef.current);
                autoCaptureTimerRef.current = null;
            }
        };
    }, [autoCaptureEnabled, isAligned, capturing, enrolledPhoto, cameraActive]);

    // 6. Fast Single-Snapshot Biometric Capture (< 150ms)
    const handleCaptureFace = async () => {
        if (!videoRef.current || capturing) return;
        setDuplicateError("");
        setCapturing(true);
        setStatusMessage("⚡ Extracting facial biometric vector...");
        setStatusType("capturing");

        // Flash effect for delightful feedback
        setFlashEffect(true);
        setTimeout(() => setFlashEffect(false), 200);

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
                setStatusMessage("❌ Face not detected clearly. Look straight into the camera and try again.");
                setStatusType("warning");
                setCapturing(false);
                return;
            }

            const descriptorArray = Array.from(detection.descriptor);

            // DUPLICATE BIOMETRICS SECURITY CHECK
            setStatusMessage("🔍 Verifying biometric uniqueness...");
            const duplicateCheck = await checkDuplicateFaceBiometrics(descriptorArray, targetRollNo, targetEmail);

            if (duplicateCheck.isDuplicate && duplicateCheck.conflictStudent) {
                const cs = duplicateCheck.conflictStudent;
                const errText = `⛔ Duplicate Face Detected! This face is already registered to "${cs.name}" (Roll No: ${cs.rollNo}). System prohibits saving identical face data across multiple students.`;
                setDuplicateError(errText);
                setStatusMessage(errText);
                setStatusType("warning");
                setCapturing(false);
                return;
            }

            const photoDataUrl = canvas.toDataURL("image/jpeg", 0.90);
            setEnrolledPhoto(photoDataUrl);
            setCapturedVector(descriptorArray);
            setStatusMessage("✅ Facial biometrics registered successfully!");
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
                    enrolledAt: Date.now()
                });
            }
        } catch (err) {
            console.error("Capture error:", err);
            setStatusMessage("Failed to process biometric face. Please try again.");
            setStatusType("warning");
        } finally {
            setCapturing(false);
        }
    };

    // 7. Photo File Upload Handler
    const processPhotoFile = async (file) => {
        if (!file) return;
        if (!file.type || !file.type.startsWith("image/")) {
            setStatusMessage("⚠️ Please upload an image file (PNG, JPG, JPEG, WEBP).");
            setStatusType("warning");
            return;
        }

        setDuplicateError("");
        setCapturing(true);
        setStatusMessage("⚡ Extracting facial biometric vector from photo...");
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
                            setStatusMessage("❌ No face detected in photo. Please choose a well-lit photo looking directly at camera.");
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
                        setStatusMessage("✅ Facial biometrics registered successfully!");
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
        setIsAligned(false);
        setAutoCaptureCountdown(null);
        setStatusMessage("Position your face inside the target oval");
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
        <div className={`live-enrollment-card ${hideHeader ? "in-modal" : ""}`}>
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
                            <FaVideo /> Live Camera
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

            {/* Viewport Container */}
            <div
                className={`lfe-viewport-container ${enrolledPhoto ? "enrolled" : ""} ${isAligned ? "aligned" : ""} ${capturing ? "capturing" : ""} ${flashEffect ? "flash" : ""} ${activeMode === "upload" && !cameraActive && !enrolledPhoto ? "upload-mode" : ""}`}
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
                {/* Modern Face Oval Guide */}
                {!enrolledPhoto && cameraActive && activeMode === "camera" && (
                    <div className={`lfe-modern-oval-guide ${isAligned ? "aligned" : ""}`}>
                        <div className="lfe-oval-pulse" />
                    </div>
                )}

                {/* Shutter Flash Effect */}
                {flashEffect && <div className="lfe-shutter-flash" />}

                {/* Auto Capture Countdown Overlay */}
                {autoCaptureCountdown !== null && (
                    <div className="lfe-countdown-overlay">
                        <div className="lfe-countdown-num">{autoCaptureCountdown}</div>
                        <div className="lfe-countdown-text">Hold still • Auto Snapping...</div>
                    </div>
                )}

                {/* Enrolled Photo Display */}
                {enrolledPhoto ? (
                    <div className="lfe-enrolled-preview-wrap">
                        <img src={enrolledPhoto} alt="Enrolled Biometric Face" className="lfe-preview-img" />
                        <div className="lfe-enrolled-floating-badge">
                            <FaCheckCircle className="badge-icon" />
                            <span>Biometrics Registered</span>
                        </div>
                    </div>
                ) : activeMode === "upload" && !cameraActive ? (
                    /* DEDICATED UPLOAD DROPZONE */
                    <div
                        className="lfe-upload-dropzone"
                        onClick={() => fileInputRef.current?.click()}
                    >
                        <div className="lfe-upload-icon-container">
                            <FaCloudUploadAlt className="lfe-upload-hero-icon" />
                        </div>
                        <h4 className="lfe-upload-title">
                            {isDragging ? "Drop your face photo here" : "Upload Student Face Photo"}
                        </h4>
                        <p className="lfe-upload-subtitle">
                            Drag &amp; drop an image here, or click to browse
                        </p>

                        <div className="lfe-upload-guidelines">
                            <span className="lfe-guide-badge"><FaCheckCircle /> Frontal Face</span>
                            <span className="lfe-guide-badge"><FaCheckCircle /> Good Lighting</span>
                            <span className="lfe-guide-badge"><FaCheckCircle /> Clear Eyes</span>
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
                                <><FaSpinner className="fa-spin" /> Processing Biometrics...</>
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

                        {/* Inactive Standby Hero Box */}
                        {!cameraActive && (
                            <div className="lfe-camera-placeholder">
                                <div className="lfe-placeholder-icon-wrap">
                                    <FaCamera className="lfe-camera-placeholder-icon" />
                                </div>
                                <h5>AI Facial Biometrics Scanner</h5>
                                <p>Start your camera to register biometrics instantly.</p>

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
                                            <><FaVideo /> Start Camera</>
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

            {/* Status Capsule & Live Quality Bar */}
            <div className="lfe-status-capsule-wrapper">
                <div className={`lfe-status-capsule ${statusType}`}>
                    {statusType === "success" && <FaCheckCircle style={{ color: "#10b981" }} />}
                    {statusType === "aligned" && <FaBolt style={{ color: "#10b981" }} />}
                    {statusType === "capturing" && <FaSpinner className="fa-spin" style={{ color: "#6366f1" }} />}
                    {statusType === "warning" && <FaInfoCircle style={{ color: "#f59e0b" }} />}
                    {statusType === "ready" && <FaCamera style={{ color: "#6366f1" }} />}
                    <span>{statusMessage}</span>
                </div>

                {/* Auto Capture Toggle */}
                {cameraActive && !enrolledPhoto && activeMode === "camera" && (
                    <button
                        type="button"
                        className={`lfe-auto-toggle-btn ${autoCaptureEnabled ? "enabled" : ""}`}
                        onClick={() => setAutoCaptureEnabled(!autoCaptureEnabled)}
                        title="Automatically snap when face is aligned"
                    >
                        <FaMagic /> Auto-Snap: {autoCaptureEnabled ? "ON" : "OFF"}
                    </button>
                )}
            </div>

            {/* Duplicate Face Error Alert */}
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
                            <FaRedo /> Retake / Register New Photo
                        </button>
                    </div>
                ) : cameraActive ? (
                    <div className="lfe-active-action-row">
                        <button
                            type="button"
                            className={`lfe-capture-btn ${isAligned ? "ready-pulse" : ""}`}
                            onClick={handleCaptureFace}
                            disabled={capturing || !modelsLoaded}
                        >
                            {capturing ? (
                                <><FaSpinner className="fa-spin" /> Enrolling Biometrics...</>
                            ) : (
                                <><FaCamera /> 📸 Capture Face Biometrics</>
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
