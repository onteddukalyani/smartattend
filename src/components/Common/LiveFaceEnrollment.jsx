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
    FaMobileAlt,
    FaInfoCircle,
    FaUpload,
    FaLock
} from "react-icons/fa";
import "./LiveFaceEnrollment.css";

const MODEL_CDN_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";

export function LiveFaceEnrollment({ onFaceEnrolled, isSaved, initialPhoto = null }) {
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const fileInputRef = useRef(null);

    const [cameraActive, setCameraActive] = useState(false);
    const [cameraLoading, setCameraLoading] = useState(false);
    const [permissionStatus, setPermissionStatus] = useState("unknown"); // "unknown", "granted", "denied", "prompt", "insecure"
    const [cameraError, setCameraError] = useState("");
    const [modelsLoaded, setModelsLoaded] = useState(false);
    const [capturing, setCapturing] = useState(false);
    const [captureStep, setCaptureStep] = useState(0); // 0 to 5 frames
    const [faceQualityStatus, setFaceQualityStatus] = useState("Ready to enroll biometric face data.");
    const [statusType, setStatusType] = useState("ready"); // "ready", "capturing", "success", "warning"
    const [enrolledPhoto, setEnrolledPhoto] = useState(initialPhoto);
    const [capturedVector, setCapturedVector] = useState(null);

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
                        setPermissionStatus(res.state); // "granted", "prompt", "denied"
                        res.onchange = () => {
                            setPermissionStatus(res.state);
                            if (res.state === "granted" && !cameraActive && !enrolledPhoto) {
                                startCameraStream();
                            }
                        };
                    } catch (e) {
                        // Some browsers don't support camera query
                    }
                }
            }
        };
        checkPerms();
    }, [cameraActive, enrolledPhoto]);

    // 2. Parallel AI Models Loader
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

    // Load AI models on initial mount
    useEffect(() => {
        loadAiModels();

        return () => {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
            }
        };
    }, [loadAiModels]);

    // 3. User Gesture Driven Camera Stream Initializer
    const startCameraStream = async () => {
        setCameraError("");
        setCameraLoading(true);
        setFaceQualityStatus("Requesting camera access from browser...");
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
                    throw new Error("WebRTC live camera requires HTTPS or localhost. Please use 'Snap Photo / Upload Photo' below.");
                }

                throw new Error("Camera API is not supported in this browser.");
            }

            // Attempt with user facingMode first, then generic fallback
            let stream = null;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
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
                setCameraError("Camera permission blocked in browser. Click the lock icon in your URL bar to allow camera.");
            } else if (camErr.name === "NotReadableError" || camErr.name === "TrackStartError") {
                setCameraError("Camera is already in use by another app (e.g. Teams, Zoom, or Windows Camera).");
            } else {
                setCameraError(camErr.message || "Failed to start camera.");
            }
            setFaceQualityStatus("⚠️ Camera stream unavailable. You can use 'Snap Photo' or 'Upload Face Photo' below.");
            setStatusType("warning");
        } finally {
            setCameraLoading(false);
        }
    };

    // Helper to attach stream to video DOM element
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
        setFaceQualityStatus("Position face centered & look directly into camera");
        setStatusType("ready");
    };

    // 4. Capture and Average 5 Live Video Frames
    const handleCaptureFace = async () => {
        if (!videoRef.current || capturing) return;
        setCapturing(true);
        setCaptureStep(0);
        setStatusType("capturing");
        setFaceQualityStatus("Sampling multi-frame biometric vectors (Hold still)...");

        try {
            const capturedDescriptors = [];
            const canvas = document.createElement("canvas");
            canvas.width = videoRef.current.videoWidth || 640;
            canvas.height = videoRef.current.videoHeight || 480;
            const ctx = canvas.getContext("2d");

            // Capture 5 frames over ~800ms for high accuracy averaging
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
                await new Promise((r) => setTimeout(r, 160)); // 160ms interval between frames
            }

            if (capturedDescriptors.length < 3) {
                setFaceQualityStatus("❌ Face not clearly detected. Ensure good lighting and look directly into camera.");
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

            // Generate image thumbnail for avatar
            const photoDataUrl = canvas.toDataURL("image/jpeg", 0.88);
            setEnrolledPhoto(photoDataUrl);
            setCapturedVector(avgDescriptor);
            setFaceQualityStatus("✅ Biometric Face Data Enrolled Successfully (128-D Vector Ready)");
            setStatusType("success");

            // Stop camera stream once captured
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
                setCameraActive(false);
            }

            // Send to parent component
            if (onFaceEnrolled) {
                onFaceEnrolled({
                    faceDescriptor: avgDescriptor,
                    photoURL: photoDataUrl,
                    biometricEnrolled: true,
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

    // 5. Photo File Upload / Native Camera Capture Handler
    const handleNativePhotoCapture = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setCapturing(true);
        setFaceQualityStatus("Extracting biometric 128-D vector from photo...");
        setStatusType("capturing");

        try {
            // Ensure AI models are loaded
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
                            setFaceQualityStatus("❌ No face detected in photo. Please choose a clear, well-lit photo looking directly at camera.");
                            setStatusType("warning");
                            setCapturing(false);
                            return;
                        }

                        const descriptorArray = Array.from(detection.descriptor);
                        const photoDataUrl = canvas.toDataURL("image/jpeg", 0.88);

                        setEnrolledPhoto(photoDataUrl);
                        setCapturedVector(descriptorArray);
                        setFaceQualityStatus("✅ Biometric Face Data Enrolled Successfully (128-D Vector Ready)");
                        setStatusType("success");

                        // Stop video stream if running
                        if (streamRef.current) {
                            streamRef.current.getTracks().forEach((t) => t.stop());
                            streamRef.current = null;
                            setCameraActive(false);
                        }

                        // Send to parent component
                        if (onFaceEnrolled) {
                            onFaceEnrolled({
                                faceDescriptor: descriptorArray,
                                photoURL: photoDataUrl,
                                biometricEnrolled: true,
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

    const handleRetake = () => {
        setEnrolledPhoto(null);
        setCapturedVector(null);
        setFaceQualityStatus("Ready to enroll biometric face data.");
        setStatusType("ready");
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
        if (onFaceEnrolled) {
            onFaceEnrolled(null);
        }
    };

    return (
        <div className="live-enrollment-card">
            {/* Hidden Native Camera / Photo File Input */}
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="user"
                style={{ display: "none" }}
                onChange={handleNativePhotoCapture}
            />

            {/* Header */}
            <div className="lfe-header">
                <div className="lfe-badge-pill">
                    <FaMicrochip />
                    <span>NEURAL BIOMETRIC ENGINE</span>
                </div>
                <h4 className="lfe-title">
                    <FaUserCheck style={{ color: "#6366f1" }} />
                    Live Facial Data Enrollment
                </h4>
                <p className={`lfe-subtitle status-${statusType}`}>
                    {faceQualityStatus}
                </p>
            </div>

            {/* Viewport Container with Cyber Overlays */}
            <div className={`lfe-viewport-container ${enrolledPhoto ? "enrolled" : ""} ${capturing ? "capturing" : ""}`}>
                {/* Cybernetic Corner Brackets */}
                <span className="lfe-corner-bracket lfe-corner-tl" />
                <span className="lfe-corner-bracket lfe-corner-tr" />
                <span className="lfe-corner-bracket lfe-corner-bl" />
                <span className="lfe-corner-bracket lfe-corner-br" />

                {/* HUD Top Live Bar */}
                <div className="lfe-hud-top">
                    <div className="lfe-hud-live-tag">
                        <span className="lfe-live-dot" />
                        <span>{enrolledPhoto ? "CAPTURED" : cameraActive ? "AI LIVE" : "STANDBY"}</span>
                    </div>
                    <div className="lfe-hud-info-tag">
                        128-D VECTOR
                    </div>
                </div>

                {/* Face Oval Target Guide */}
                {!enrolledPhoto && cameraActive && <div className="lfe-face-guide" />}

                {/* Laser Scanning Bar */}
                {!enrolledPhoto && cameraActive && <div className="lfe-scan-laser" />}

                {/* Media (Live Video or Enrolled Photo or Permission Request Box) */}
                {enrolledPhoto ? (
                    <img src={enrolledPhoto} alt="Enrolled Student" className="lfe-preview-img" />
                ) : (
                    <>
                        <video
                            ref={videoRef}
                            autoPlay
                            playsInline
                            muted
                            className="lfe-video"
                            style={{ display: cameraActive ? "block" : "none" }}
                        />

                        {!cameraActive && (
                            <div className="lfe-camera-placeholder">
                                <FaCamera className="lfe-camera-placeholder-icon" />
                                <h5>Choose Camera or Upload Photo</h5>
                                <p>
                                    Click below to start your webcam or snap / upload a clear face photo.
                                </p>

                                <div className="lfe-placeholder-btn-group">
                                    <button
                                        type="button"
                                        className="lfe-grant-perm-cta"
                                        onClick={startCameraStream}
                                        disabled={cameraLoading}
                                    >
                                        {cameraLoading ? (
                                            <><FaSpinner className="fa-spin" /> Requesting Camera...</>
                                        ) : (
                                            <><FaVideo /> 🎥 Open Webcam &amp; Allow Camera</>
                                        )}
                                    </button>

                                    <button
                                        type="button"
                                        className="lfe-native-cam-btn"
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        <FaUpload /> 📁 Snap Photo / Upload Image
                                    </button>
                                </div>

                                {/* Permission Denied Helper */}
                                {permissionStatus === "denied" && (
                                    <div className="lfe-perm-denied-guide">
                                        <div style={{ fontWeight: 800, marginBottom: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
                                            <FaLock /> Camera Blocked in Browser
                                        </div>
                                        <div>
                                            1. Click the <strong>Lock / Camera icon 🔒</strong> in your address bar (top-left).<br />
                                            2. Change <strong>Camera</strong> permission to <strong>Allow</strong>.<br />
                                            3. Refresh the page or click retry.
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

                {/* Enrolled Overlay Badge */}
                {enrolledPhoto && (
                    <div className="lfe-enrolled-overlay">
                        <FaShieldAlt /> 128-D Biometric Face Template Locked &amp; Ready
                    </div>
                )}
            </div>

            {/* Multi-Frame Progress Bar (During Live Capture) */}
            {capturing && (
                <div className="lfe-progress-bar-wrapper">
                    <div className="lfe-progress-info">
                        <span>{captureStep > 0 ? `Biometric Sampling: Frame ${captureStep}/5` : "Extracting Biometric Vector..."}</span>
                        <span>{captureStep > 0 ? `${Math.round((captureStep / 5) * 100)}%` : "Processing..."}</span>
                    </div>
                    <div className="lfe-progress-track">
                        <div
                            className="lfe-progress-fill"
                            style={{ width: captureStep > 0 ? `${(captureStep / 5) * 100}%` : "100%" }}
                        />
                    </div>
                </div>
            )}

            {/* Actions */}
            <div className="lfe-actions">
                {enrolledPhoto ? (
                    <>
                        <span className="lfe-success-badge">
                            <FaCheckCircle /> Face Biometrics Enrolled
                        </span>
                        <button
                            type="button"
                            className="lfe-retake-btn"
                            onClick={handleRetake}
                        >
                            <FaRedo /> Retake Capture
                        </button>
                    </>
                ) : cameraActive ? (
                    <div className="lfe-active-action-row">
                        <button
                            type="button"
                            className="lfe-capture-btn"
                            onClick={handleCaptureFace}
                            disabled={capturing || !modelsLoaded}
                        >
                            {capturing ? (
                                <><FaSpinner className="fa-spin" /> Enrolling Multi-Frame Biometrics...</>
                            ) : (
                                <><FaCamera /> Capture &amp; Register Facial Data</>
                            )}
                        </button>

                        <button
                            type="button"
                            className="lfe-native-cam-btn-secondary"
                            onClick={() => fileInputRef.current?.click()}
                            title="Upload or snap photo from device"
                        >
                            <FaUpload /> Upload Photo
                        </button>
                    </div>
                ) : (
                    <div className="lfe-inactive-action-row">
                        <button
                            type="button"
                            className="lfe-grant-perm-cta"
                            onClick={startCameraStream}
                            disabled={cameraLoading}
                        >
                            {cameraLoading ? (
                                <><FaSpinner className="fa-spin" /> Requesting...</>
                            ) : (
                                <><FaVideo /> 🎥 Open Webcam &amp; Allow Camera</>
                            )}
                        </button>

                        <button
                            type="button"
                            className="lfe-native-cam-btn-primary"
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <FaUpload /> 📁 Snap / Upload Photo
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

export default LiveFaceEnrollment;
