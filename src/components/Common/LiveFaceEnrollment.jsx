import React, { useEffect, useRef, useState, useCallback } from "react";
import * as faceapi from "@vladmandic/face-api";
import {
    FaCamera,
    FaCheckCircle,
    FaRedo,
    FaSpinner,
    FaUserCheck,
    FaShieldAlt,
    FaMicrochip,
    FaExclamationTriangle,
    FaVideo,
    FaUpload,
    FaLock,
    FaInfoCircle,
    FaEye,
    FaEyeSlash,
    FaUserTimes,
    FaCloudUploadAlt,
    FaImage,
    FaSync
} from "react-icons/fa";
import { checkDuplicateFaceBiometrics } from "../../utils/biometricManager";
import {
    LivenessEngine,
    computeEAR,
    computeHeadPose,
    computeFacialRatios,
    computeMotionVariance,
    BLINK_CLOSED_THRESHOLD,
    BLINK_OPEN_THRESHOLD
} from "../../utils/livenessDetector";
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

    // Dynamic Anti-Spoofing & Liveness Engine Ref
    const livenessEngineRef = useRef(null);
    const blinkCountRef = useRef(0);

    const [cameraActive, setCameraActive] = useState(false);
    const [cameraLoading, setCameraLoading] = useState(false);
    const [permissionStatus, setPermissionStatus] = useState("unknown");
    const [cameraError, setCameraError] = useState("");
    const [modelsLoaded, setModelsLoaded] = useState(false);
    const [capturing, setCapturing] = useState(false);
    const [captureStep, setCaptureStep] = useState(0);
    const [faceQualityStatus, setFaceQualityStatus] = useState("Look into the camera and blink naturally to verify live human presence.");
    const [statusType, setStatusType] = useState("ready"); // "ready", "capturing", "success", "warning", "error"
    const [enrolledPhoto, setEnrolledPhoto] = useState(initialPhoto);
    const [capturedVector, setCapturedVector] = useState(null);
    const [activeMode, setActiveMode] = useState("camera"); // "camera" or "upload"
    const [isDragging, setIsDragging] = useState(false);
    const [selectedFileName, setSelectedFileName] = useState("");

    // Liveness & Anti-Duplicate UI States
    const [blinkCount, setBlinkCount] = useState(0);
    const [livenessPassed, setLivenessPassed] = useState(false);
    const [isSpoof, setIsSpoof] = useState(false);
    const [duplicateError, setDuplicateError] = useState("");
    const [livenessStep, setLivenessStep] = useState("ALIGN");
    const [livenessProgress, setLivenessProgress] = useState(15);
    const [challengeMessage, setChallengeMessage] = useState("");

    // Initialize Liveness Engine
    useEffect(() => {
        livenessEngineRef.current = new LivenessEngine({
            onStateChange: (state) => {
                setLivenessStep(state.step);
                setBlinkCount(state.blinkCount);
                blinkCountRef.current = state.blinkCount;
                const isPassed = state.livenessConfirmed || state.blinkCount >= 1;
                setLivenessPassed(isPassed);
                setIsSpoof(state.spoofDetected);
                setLivenessProgress(state.progress);
                setChallengeMessage(state.message);
                if (state.message) {
                    setFaceQualityStatus(state.message);
                }
                if (state.statusType) {
                    setStatusType(state.statusType);
                }
            }
        });
    }, []);

    // 1. Check Browser Permission and Secure Context State
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

    // 2. Load AI Models
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

    // 3. User Gesture Driven Camera Stream Initializer
    const startCameraStream = async () => {
        setCameraError("");
        setDuplicateError("");
        setCameraLoading(true);
        setFaceQualityStatus("Requesting camera access...");
        setStatusType("ready");

        try {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
            }

            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                const legacyGetUserMedia =
                    navigator.getUserMedia ||
                    navigator.webkitGetUserMedia ||
                    navigator.mozGetUserMedia ||
                    navigator.msGetUserMedia;

                if (legacyGetUserMedia) {
                    const legacyStream = await new Promise((resolve, reject) => {
                        legacyGetUserMedia.call(navigator, { video: true, audio: false }, resolve, reject);
                    });
                    attachStreamToVideo(legacyStream);
                    return;
                }

                if (typeof window !== "undefined" && !window.isSecureContext) {
                    setPermissionStatus("insecure");
                    throw new Error("WebRTC live camera requires HTTPS or localhost. Please use 'Upload Photo' below.");
                }

                throw new Error("Camera API is not supported in this browser.");
            }

            let stream = null;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: "user", width: { ideal: 1280, min: 640 }, height: { ideal: 720, min: 480 } },
                    audio: false
                });
            } catch (err1) {
                console.warn("facingMode: user failed, trying fallback video:", err1);
                if (err1.name === "NotAllowedError" || err1.name === "PermissionDeniedError") {
                    setPermissionStatus("denied");
                    throw new Error("Camera permission was denied in your browser settings.");
                }
                stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            }

            if (!stream) {
                throw new Error("Unable to obtain video stream.");
            }

            attachStreamToVideo(stream);
            setPermissionStatus("granted");
        } catch (camErr) {
            console.error("Camera access error:", camErr);
            setCameraActive(false);
            if (camErr.name === "NotAllowedError" || camErr.name === "PermissionDeniedError") {
                setPermissionStatus("denied");
                setCameraError("Camera permission blocked in browser. Click the lock icon in your URL address bar to allow camera access.");
            } else if (camErr.name === "NotReadableError" || camErr.name === "TrackStartError") {
                setCameraError("Camera is already in use by another application (e.g. Teams, Zoom, or Windows Camera).");
            } else {
                setCameraError(camErr.message || "Failed to start camera.");
            }
            setFaceQualityStatus("⚠️ Camera stream unavailable. You can use 'Upload Face Photo' below.");
            setStatusType("warning");
        } finally {
            setCameraLoading(false);
        }
    };

    const attachStreamToVideo = (stream) => {
        streamRef.current = stream;
        if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.setAttribute("autoplay", "true");
            videoRef.current.setAttribute("playsinline", "true");
            videoRef.current.setAttribute("muted", "true");
            videoRef.current.play().catch((e) => console.warn("Video play error:", e));
        }
        setCameraActive(true);
        setFaceQualityStatus("Look directly into the camera and blink naturally to verify live human presence.");
        setStatusType("ready");
    };

    // 4. Real-time Live Detection & Blink Tracking Loop during Enrollment
    useEffect(() => {
        if (!cameraActive || !modelsLoaded || enrolledPhoto) return;

        let isRunning = true;
        let lastScanTime = 0;

        const runLiveTracking = async (time) => {
            if (!isRunning) return;

            if (time - lastScanTime > 160 && videoRef.current && videoRef.current.readyState >= 2) {
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
                        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
                        .withFaceLandmarks();

                    const ctx = canvas ? canvas.getContext("2d") : null;
                    if (ctx && canvas) {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                    }

                    if (detection) {
                        const landmarks = detection.landmarks;
                        const positions = landmarks.positions;
                        const box = detection.detection.box;

                        // Process through active 3D landmark Liveness & Anti-Spoof Engine
                        if (livenessEngineRef.current) {
                            livenessEngineRef.current.processFrame(detection);
                        }

                        // Render Canvas Reticle HUD
                        if (ctx && canvas) {
                            const { x, y, width, height } = box;
                            const cornerLen = Math.min(width, height) * 0.22;
                            ctx.lineWidth = 3.5;
                            ctx.strokeStyle = isSpoof ? "#ef4444" : livenessPassed ? "#10b981" : "#6366f1";
                            ctx.lineCap = "round";

                            // Corners
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

                            // Eye landmarks
                            const leftEye = positions.slice(36, 42);
                            const rightEye = positions.slice(42, 48);
                            ctx.fillStyle = livenessPassed ? "#10b981" : "#06b6d4";
                            [...leftEye, ...rightEye].forEach((pt) => {
                                ctx.beginPath();
                                ctx.arc(pt.x, pt.y, 2.5, 0, 2 * Math.PI);
                                ctx.fill();
                            });
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
    }, [cameraActive, modelsLoaded, enrolledPhoto, isSpoof, livenessPassed]);

    // 5. Capture Live Video Frames, Check Liveness & Duplicate Biometrics
    const handleCaptureFace = async () => {
        if (!videoRef.current || capturing) return;
        setDuplicateError("");

        // Check if spoof detected
        if (isSpoof || (livenessEngineRef.current && livenessEngineRef.current.spoofDetected)) {
            setFaceQualityStatus("⛔ Cannot enroll static photo or screen replay. Live biological face with natural blink required.");
            setStatusType("warning");
            return;
        }

        setCapturing(true);
        setCaptureStep(0);
        setStatusType("capturing");
        setFaceQualityStatus("Scanning & extracting 128-dimensional biometric vectors across live frames...");

        try {
            const capturedDescriptors = [];
            const canvas = document.createElement("canvas");
            canvas.width = videoRef.current.videoWidth || 640;
            canvas.height = videoRef.current.videoHeight || 480;
            const ctx = canvas.getContext("2d");

            for (let i = 0; i < 5; i++) {
                setCaptureStep(i + 1);
                ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

                const detection = await faceapi
                    .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
                    .withFaceLandmarks()
                    .withFaceDescriptor();

                if (detection) {
                    capturedDescriptors.push(detection.descriptor);
                }
                await new Promise((r) => setTimeout(r, 140));
            }

            if (capturedDescriptors.length < 2) {
                setFaceQualityStatus("❌ Face not clearly detected across frames. Ensure good lighting and look directly into the camera.");
                setStatusType("warning");
                setCapturing(false);
                setCaptureStep(0);
                return;
            }

            // Average the 128-dimensional vectors
            const avgDescriptor = new Array(128).fill(0);
            for (let i = 0; i < 128; i++) {
                let sum = 0;
                for (let j = 0; j < capturedDescriptors.length; j++) {
                    sum += capturedDescriptors[j][i];
                }
                avgDescriptor[i] = sum / capturedDescriptors.length;
            }

            // DUPLICATE FACE BIOMETRICS SECURITY CHECK
            setFaceQualityStatus("🔍 Verifying biometric uniqueness across student registry...");
            const duplicateCheck = await checkDuplicateFaceBiometrics(avgDescriptor, targetRollNo, targetEmail);

            if (duplicateCheck.isDuplicate && duplicateCheck.conflictStudent) {
                const cs = duplicateCheck.conflictStudent;
                const errText = `⛔ Duplicate Face Detected! This face is already registered to "${cs.name}" (Roll No: ${cs.rollNo} • ${cs.confidence}% Match). System security strictly prohibits saving the same facial biometric template to multiple students.`;
                setDuplicateError(errText);
                setFaceQualityStatus(errText);
                setStatusType("warning");
                setCapturing(false);
                setCaptureStep(0);
                return;
            }

            const photoDataUrl = canvas.toDataURL("image/jpeg", 0.88);
            setEnrolledPhoto(photoDataUrl);
            setCapturedVector(avgDescriptor);
            setFaceQualityStatus("✅ Facial biometrics verified unique & registered successfully!");
            setStatusType("success");

            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
                setCameraActive(false);
            }

            if (onFaceEnrolled) {
                onFaceEnrolled({
                    faceDescriptor: avgDescriptor,
                    photoURL: photoDataUrl,
                    biometricEnrolled: true,
                    livenessConfirmed: true,
                    blinkCount: blinkCountRef.current || blinkCount || 1,
                    enrolledAt: Date.now()
                });
            }
        } catch (err) {
            console.error("Enrollment error:", err);
            setFaceQualityStatus("Error processing biometric face. Please try again or use photo upload.");
            setStatusType("warning");
        } finally {
            setCapturing(false);
            setCaptureStep(0);
        }
    };

    // 6. Photo File Upload & Processing Handler with Duplicate Prevention
    const processPhotoFile = async (file) => {
        if (!file) return;
        if (!file.type || !file.type.startsWith("image/")) {
            setFaceQualityStatus("⚠️ Please upload a valid image file (PNG, JPG, JPEG, WEBP).");
            setStatusType("warning");
            return;
        }

        setSelectedFileName(file.name || "Uploaded Photo");
        setDuplicateError("");
        setCapturing(true);
        setFaceQualityStatus("Extracting 128-D biometric vector from photo...");
        setStatusType("capturing");

        try {
            if (!modelsLoaded) {
                setFaceQualityStatus("Loading neural face recognition models...");
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
                            .detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
                            .withFaceLandmarks()
                            .withFaceDescriptor();

                        if (!detection) {
                            setFaceQualityStatus("❌ No clear face detected in photo. Please choose a well-lit photo looking directly at camera.");
                            setStatusType("warning");
                            setCapturing(false);
                            return;
                        }

                        const descriptorArray = Array.from(detection.descriptor);

                        // DUPLICATE BIOMETRICS CHECK
                        setFaceQualityStatus("🔍 Verifying biometric uniqueness across registry...");
                        const duplicateCheck = await checkDuplicateFaceBiometrics(descriptorArray, targetRollNo, targetEmail);

                        if (duplicateCheck.isDuplicate && duplicateCheck.conflictStudent) {
                            const cs = duplicateCheck.conflictStudent;
                            const errText = `⛔ Duplicate Face Detected! This photo matches already registered student "${cs.name}" (Roll No: ${cs.rollNo} • ${cs.confidence}% Match). Multiple students cannot share identical facial biometrics.`;
                            setDuplicateError(errText);
                            setFaceQualityStatus(errText);
                            setStatusType("warning");
                            setCapturing(false);
                            return;
                        }

                        const photoDataUrl = canvas.toDataURL("image/jpeg", 0.88);

                        setEnrolledPhoto(photoDataUrl);
                        setCapturedVector(descriptorArray);
                        setFaceQualityStatus("✅ Facial biometrics verified unique & registered successfully! (128-D Vector Ready)");
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
                        console.error("Native photo detection error:", detectErr);
                        setFaceQualityStatus("Error analyzing face from photo. Please try another photo.");
                        setStatusType("warning");
                    } finally {
                        setCapturing(false);
                    }
                };

                img.onerror = () => {
                    setFaceQualityStatus("Failed to load image file. Please try another photo.");
                    setStatusType("warning");
                    setCapturing(false);
                };

                img.src = readerEvent.target.result;
            };

            reader.readAsDataURL(file);
        } catch (err) {
            console.error("Native photo capture error:", err);
            setFaceQualityStatus("Failed to process photo capture.");
            setStatusType("warning");
            setCapturing(false);
        }
    };

    const handleNativePhotoCapture = (e) => {
        const file = e.target.files?.[0];
        if (file) processPhotoFile(file);
    };

    const handleDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    };

    const handleDragLeave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    };

    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        const file = e.dataTransfer?.files?.[0];
        if (file) {
            setActiveMode("upload");
            processPhotoFile(file);
        }
    };

    const handleRetake = () => {
        setEnrolledPhoto(null);
        setCapturedVector(null);
        setDuplicateError("");
        setSelectedFileName("");
        if (livenessEngineRef.current) {
            livenessEngineRef.current.reset();
        }
        blinkCountRef.current = 0;
        setBlinkCount(0);
        setLivenessPassed(false);
        setIsSpoof(false);
        setFaceQualityStatus("Position your face in camera or upload a clear frontal photo to register biometrics.");
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
                onChange={handleNativePhotoCapture}
            />

            {/* Mode Switcher Tabs (Live Camera vs Upload Photo) */}
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
                            <FaUpload /> Upload Face Photo
                        </button>
                    </div>
                </div>
            )}

            {/* Viewport Container for Camera Video or Upload Dropzone */}
            <div
                className={`lfe-viewport-container ${enrolledPhoto ? "enrolled" : ""} ${capturing ? "capturing" : ""} ${isDragging ? "dragging" : ""} ${activeMode === "upload" && !cameraActive && !enrolledPhoto ? "upload-mode" : ""}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                {/* Clean Corner Brackets */}
                <span className="lfe-corner-bracket lfe-corner-tl" />
                <span className="lfe-corner-bracket lfe-corner-tr" />
                <span className="lfe-corner-bracket lfe-corner-bl" />
                <span className="lfe-corner-bracket lfe-corner-br" />

                {/* Face Oval Target Guide (only in active camera feed) */}
                {!enrolledPhoto && cameraActive && activeMode === "camera" && <div className="lfe-face-guide" />}

                {/* Laser Scanning Bar */}
                {((!enrolledPhoto && cameraActive && activeMode === "camera") || (capturing && !enrolledPhoto)) && (
                    <div className="lfe-scan-laser" />
                )}

                {/* Media Feed / Upload Area */}
                {enrolledPhoto ? (
                    <div className="lfe-enrolled-preview-wrap">
                        <img src={enrolledPhoto} alt="Enrolled Student" className="lfe-preview-img" />
                        <div className="lfe-enrolled-floating-badge">
                            <FaCheckCircle className="badge-icon" />
                            <span>Biometrics Verified &amp; Ready</span>
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
                            {isDragging ? "Drop your face photo here!" : "Upload Student Face Photo"}
                        </h4>
                        <p className="lfe-upload-subtitle">
                            Drag &amp; drop an image file here, or click to browse from device
                        </p>

                        <div className="lfe-upload-guidelines">
                            <span className="lfe-guide-badge"><FaCheckCircle /> Frontal Face</span>
                            <span className="lfe-guide-badge"><FaCheckCircle /> Good Lighting</span>
                            <span className="lfe-guide-badge"><FaCheckCircle /> Single Person</span>
                        </div>

                        <div className="lfe-upload-formats">
                            <span className="lfe-format-tag">PNG</span>
                            <span className="lfe-format-tag">JPG</span>
                            <span className="lfe-format-tag">JPEG</span>
                            <span className="lfe-format-tag">WEBP</span>
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
                    /* CAMERA STREAM OR CAMERA PLACEHOLDER */
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
                                <p>Start your camera for live liveness verification or switch to photo upload.</p>

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

                                {/* Permission Denied Helper */}
                                {permissionStatus === "denied" && (
                                    <div className="lfe-perm-denied-guide">
                                        <div style={{ fontWeight: 800, marginBottom: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
                                            <FaLock /> Camera Blocked in Browser
                                        </div>
                                        <div>
                                            1. Click the <strong>Lock / Camera icon 🔒</strong> in your address bar.<br />
                                            2. Change <strong>Camera</strong> permission to <strong>Allow</strong>.<br />
                                            3. Refresh or click retry.
                                        </div>
                                    </div>
                                )}

                                {/* Error Tip */}
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

            {/* Interactive Liveness Steps & Progress Indicator */}
            {cameraActive && !enrolledPhoto && activeMode === "camera" && (
                <div style={{ margin: "12px 0 6px" }}>
                    <div style={{ display: "flex", justifyContent: "center", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
                        <span style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            padding: "4px 10px",
                            borderRadius: "6px",
                            fontSize: "0.78rem",
                            fontWeight: 700,
                            background: livenessStep !== "ALIGN" ? "#dcfce7" : "#e0e7ff",
                            color: livenessStep !== "ALIGN" ? "#15803d" : "#4338ca",
                            border: livenessStep === "ALIGN" ? "1.5px solid #6366f1" : "1px solid #bbf7d0"
                        }}>
                            {livenessStep !== "ALIGN" ? "✅" : "1️⃣"} Center Face
                        </span>
                        <span style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            padding: "4px 10px",
                            borderRadius: "6px",
                            fontSize: "0.78rem",
                            fontWeight: 700,
                            background: blinkCount >= 1 ? "#dcfce7" : livenessStep === "BLINK" ? "#fef3c7" : "#f1f5f9",
                            color: blinkCount >= 1 ? "#15803d" : livenessStep === "BLINK" ? "#b45309" : "#64748b",
                            border: livenessStep === "BLINK" ? "1.5px solid #f59e0b" : "1px solid #e2e8f0"
                        }}>
                            {blinkCount >= 1 ? "✅" : "2️⃣"} Blink Eyes ({blinkCount})
                        </span>
                        <span style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            padding: "4px 10px",
                            borderRadius: "6px",
                            fontSize: "0.78rem",
                            fontWeight: 700,
                            background: livenessPassed ? "#dcfce7" : livenessStep === "TURN" ? "#fef3c7" : "#f1f5f9",
                            color: livenessPassed ? "#15803d" : livenessStep === "TURN" ? "#b45309" : "#64748b",
                            border: livenessStep === "TURN" ? "1.5px solid #f59e0b" : "1px solid #e2e8f0"
                        }}>
                            {livenessPassed ? "✅" : "3️⃣"} 3D Head Turn
                        </span>
                        <span style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            padding: "4px 10px",
                            borderRadius: "6px",
                            fontSize: "0.78rem",
                            fontWeight: 700,
                            background: isSpoof ? "#fee2e2" : livenessPassed ? "#dcfce7" : "#f1f5f9",
                            color: isSpoof ? "#b91c1c" : livenessPassed ? "#15803d" : "#475569"
                        }}>
                            <FaShieldAlt /> {isSpoof ? "⚠️ Replay Spoof Alert" : livenessPassed ? "🛡️ Live Anti-Spoof: PASSED" : "Anti-Spoof: Active"}
                        </span>
                    </div>

                    {/* Liveness Progress Bar */}
                    <div style={{ width: "100%", height: "6px", background: "#e2e8f0", borderRadius: "999px", overflow: "hidden", margin: "6px 0" }}>
                        <div style={{
                            width: `${livenessProgress}%`,
                            height: "100%",
                            background: isSpoof ? "#ef4444" : livenessPassed ? "#10b981" : "#6366f1",
                            transition: "width 0.3s ease, background-color 0.3s ease"
                        }} />
                    </div>
                </div>
            )}

            {/* Duplicate Face Error Alert */}
            {duplicateError && (
                <div style={{
                    padding: "14px 18px",
                    borderRadius: "12px",
                    background: "#fef2f2",
                    border: "1.5px solid #fecaca",
                    color: "#991b1b",
                    margin: "12px 0",
                    textAlign: "left",
                    fontSize: "0.86rem",
                    fontWeight: 600,
                    lineHeight: 1.45
                }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: 800, fontSize: "0.95rem", marginBottom: "4px" }}>
                        <FaUserTimes style={{ color: "#ef4444" }} /> Duplicate Face Rejected
                    </div>
                    {duplicateError}
                </div>
            )}

            {/* Status Quality Indicator */}
            <div style={{
                margin: "8px 0 12px",
                fontSize: "0.88rem",
                fontWeight: 700,
                color: statusType === "success" ? "#10b981" : statusType === "warning" ? "#d97706" : "var(--text-muted, #64748b)"
            }}>
                {faceQualityStatus}
            </div>

            {/* Multi-Frame Progress Bar during live capture or vector extraction */}
            {capturing && (
                <div className="lfe-progress-bar-wrapper">
                    <div className="lfe-progress-info">
                        <span>{captureStep > 0 ? `Biometric Sampling: Frame ${captureStep}/5` : "Extracting & Verifying Biometric Uniqueness..."}</span>
                        <span>{captureStep > 0 ? `${Math.round((captureStep / 5) * 100)}%` : "AI Processing..."}</span>
                    </div>
                    <div className="lfe-progress-track">
                        <div
                            className="lfe-progress-fill"
                            style={{ width: captureStep > 0 ? `${(captureStep / 5) * 100}%` : "100%" }}
                        />
                    </div>
                </div>
            )}

            {/* Action Bar */}
            {(cameraActive || enrolledPhoto || activeMode === "upload") && (
                <div className="lfe-actions">
                    {enrolledPhoto ? (
                        <>
                            <span className="lfe-success-badge">
                                <FaCheckCircle /> Face Biometrics Enrolled &amp; Unique
                            </span>
                            <button
                                type="button"
                                className="lfe-retake-btn"
                                onClick={handleRetake}
                            >
                                <FaRedo /> Retake / Upload New Photo
                            </button>
                        </>
                    ) : cameraActive ? (
                        <div className="lfe-active-action-row">
                            <button
                                type="button"
                                className="lfe-capture-btn"
                                onClick={handleCaptureFace}
                                disabled={capturing || !modelsLoaded || isSpoof}
                                style={{
                                    opacity: isSpoof ? 0.6 : 1,
                                    cursor: isSpoof ? "not-allowed" : "pointer"
                                }}
                            >
                                {capturing ? (
                                    <><FaSpinner className="fa-spin" /> Verifying &amp; Enrolling...</>
                                ) : (
                                    <><FaCamera /> 📸 Capture &amp; Register Facial Data</>
                                )}
                            </button>

                            <button
                                type="button"
                                className="lfe-secondary-upload-btn"
                                onClick={() => {
                                    setActiveMode("upload");
                                    fileInputRef.current?.click();
                                }}
                                title="Upload or snap photo from device"
                            >
                                <FaUpload /> Upload Photo
                            </button>
                        </div>
                    ) : null}
                </div>
            )}
        </div>
    );
}

export default LiveFaceEnrollment;
