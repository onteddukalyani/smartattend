import React, { useEffect, useRef, useState, useCallback } from "react";
import * as faceapi from "@vladmandic/face-api";
import {
  FaCamera,
  FaCheckCircle,
  FaTimesCircle,
  FaSpinner,
  FaUserCheck,
  FaExclamationTriangle,
  FaUserTimes,
  FaShieldAlt,
  FaUser,
  FaRedo,
  FaEye,
  FaEyeSlash
} from "react-icons/fa";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../../firebase";
import "./FaceScanner.css";

const MODEL_CDN_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
const MATCH_THRESHOLD = 0.50; // Strict euclidean distance threshold (<= 0.50 = authentic match)
const BLINK_CLOSED_THRESHOLD = 0.205; // Eye Aspect Ratio below this = eye closed
const BLINK_OPEN_THRESHOLD = 0.245;   // Eye Aspect Ratio above this = eye open
const STATIC_VARIANCE_THRESHOLD = 0.00010; // Ratio variance below this across frames = 2D static photo
const STATIC_FRAME_LIMIT = 18; // ~3 seconds of dead static face triggers spoof alert

// Helper to compute Euclidean distance between 2 landmark points
const getDist = (p1, p2) => {
  if (!p1 || !p2) return 0;
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
};

// Compute Eye Aspect Ratio (EAR) for 6 landmark points of an eye
const computeEAR = (eye) => {
  if (!eye || eye.length < 6) return 0.3;
  const v1 = getDist(eye[1], eye[5]);
  const v2 = getDist(eye[2], eye[4]);
  const h = getDist(eye[0], eye[3]);
  if (h === 0) return 0.3;
  return (v1 + v2) / (2.0 * h);
};

// Compute 5 normalized 3D facial geometric ratios to track non-rigid parallax movement
const computeFacialRatios = (positions) => {
  if (!positions || positions.length < 68) return [0, 0, 0, 0, 0];
  const p36 = positions[36]; // Left eye outer
  const p45 = positions[45]; // Right eye outer
  const eyeSpan = getDist(p36, p45);
  if (eyeSpan < 1) return [0, 0, 0, 0, 0];

  const p30 = positions[30]; // Nose tip
  const p27 = positions[27]; // Nose bridge top
  const p48 = positions[48]; // Mouth left corner
  const p54 = positions[54]; // Mouth right corner
  const p8 = positions[8];   // Chin bottom

  return [
    getDist(p30, p36) / eyeSpan,
    getDist(p30, p45) / eyeSpan,
    getDist(p48, p54) / eyeSpan,
    getDist(p30, p8) / eyeSpan,
    getDist(p27, p30) / eyeSpan
  ];
};

// Calculate multi-frame geometric variance to distinguish live humans from 2D photos/screens
const computeVariance = (history) => {
  if (!history || history.length < 8) return 0.001;
  const n = history.length;
  let totalVar = 0;
  for (let dim = 0; dim < 5; dim++) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += history[i][dim];
    mean /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += Math.pow(history[i][dim] - mean, 2);
    v /= n;
    totalVar += v;
  }
  return totalVar / 5;
};

// Helper for camera stream capture
const getCameraStream = async () => {
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const attempts = [
      { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false },
      { video: { facingMode: "user" }, audio: false },
      { video: { width: 640, height: 480 }, audio: false },
      { video: true, audio: false }
    ];
    let lastError = null;
    for (const constraints of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (stream) return stream;
      } catch (err) {
        lastError = err;
        console.warn("Camera attempt with constraints failed:", constraints, err);
      }
    }
    throw lastError || new Error("Failed to access camera.");
  }

  const legacyGetUserMedia =
    navigator.getUserMedia ||
    navigator.webkitGetUserMedia ||
    navigator.mozGetUserMedia ||
    navigator.msGetUserMedia;

  if (legacyGetUserMedia) {
    return new Promise((resolve, reject) => {
      legacyGetUserMedia.call(navigator, { video: true, audio: false }, resolve, reject);
    });
  }

  if (typeof window !== "undefined" && !window.isSecureContext) {
    throw new Error(
      "INSECURE_CONTEXT: WebRTC requires HTTPS or localhost. Please open via HTTPS."
    );
  }

  throw new Error("getUserMedia is not supported on this browser.");
};

function FaceScanner({
  verifiedStudent = null,
  lookingUp = false,
  rollNo = "",
  onVerificationChange = () => { },
  onEnrollRequest = null
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const consecutiveMatchesRef = useRef(0);

  // Liveness & Anti-Spoofing tracking refs
  const eyeStateRef = useRef("open"); // "open" | "closed"
  const blinkCountRef = useRef(0);
  const livenessConfirmedRef = useRef(false);
  const ratioHistoryRef = useRef([]);
  const staticFramesCountRef = useRef(0);
  const spoofDetectedRef = useRef(false);
  const noFaceFramesRef = useRef(0);

  // Status: "idle" | "loading_models" | "loading_camera" | "scanning" | "liveness_check" | "spoof" | "verified" | "mismatch" | "no_face" | "unregistered" | "error"
  const [status, setStatus] = useState("loading_camera");
  const [cameraActive, setCameraActive] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [feedback, setFeedback] = useState("Starting camera & loading AI recognition models...");
  const [confidence, setConfidence] = useState(0);
  const [distance, setDistance] = useState(1.0);
  const [cameraError, setCameraError] = useState("");
  const [standaloneStudents, setStandaloneStudents] = useState([]);
  const [recognizedStudent, setRecognizedStudent] = useState(null);

  // UI Liveness Indicators
  const [blinkCount, setBlinkCount] = useState(0);
  const [livenessPassed, setLivenessPassed] = useState(false);
  const [isSpoof, setIsSpoof] = useState(false);

  // Reset liveness trackers cleanly
  const resetLivenessState = useCallback(() => {
    eyeStateRef.current = "open";
    blinkCountRef.current = 0;
    livenessConfirmedRef.current = false;
    ratioHistoryRef.current = [];
    staticFramesCountRef.current = 0;
    spoofDetectedRef.current = false;
    noFaceFramesRef.current = 0;
    consecutiveMatchesRef.current = 0;
    setBlinkCount(0);
    setLivenessPassed(false);
    setIsSpoof(false);
  }, []);

  // 1. Initialize Camera and AI Models
  const initCameraAndModels = useCallback(async () => {
    setCameraError("");
    setStatus("loading_camera");
    setFeedback("Initializing camera and biometric models...");

    // A. Start Camera Stream
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      const stream = await getCameraStream();
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute("autoplay", "true");
        videoRef.current.setAttribute("playsinline", "true");
        videoRef.current.setAttribute("muted", "true");

        videoRef.current.onloadedmetadata = () => {
          videoRef.current
            .play()
            .then(() => {
              setCameraActive(true);
            })
            .catch((e) => {
              console.warn("Video play promise error:", e);
              setCameraActive(true);
            });
        };
      }
    } catch (camErr) {
      console.error("Camera access error:", camErr);
      setCameraError(
        camErr.message.includes("INSECURE_CONTEXT")
          ? "Camera requires HTTPS. Please open via HTTPS or localhost."
          : "Could not access webcam. Please check browser camera permissions."
      );
      setStatus("error");
      setFeedback("Camera permission denied or camera unavailable.");
      return;
    }

    // B. Load AI Recognition Models
    try {
      setStatus("loading_models");
      setFeedback("Loading facial neural network models...");

      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_CDN_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_CDN_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_CDN_URL)
      ]);

      setModelsLoaded(true);
      setStatus("scanning");
      setFeedback("AI models loaded! Looking for face in frame...");
    } catch (modelErr) {
      console.error("Model loading error:", modelErr);
      setStatus("error");
      setFeedback("Failed to load facial recognition models.");
    }
  }, []);

  useEffect(() => {
    initCameraAndModels();

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
  }, [initCameraAndModels]);

  // Reset state when roll number or verified student changes
  useEffect(() => {
    resetLivenessState();
  }, [rollNo, verifiedStudent, resetLivenessState]);

  // 2. Fetch standalone database students if in standalone mode (no verifiedStudent prop provided)
  useEffect(() => {
    if (verifiedStudent !== null || !modelsLoaded) return;
    const fetchAllForStandalone = async () => {
      try {
        const [studentsSnap, usersSnap, authSnap] = await Promise.all([
          getDocs(collection(db, "students")),
          getDocs(collection(db, "users")),
          getDocs(collection(db, "authorizedUsers")).catch(() => ({ docs: [] }))
        ]);
        const map = new Map();
        [...studentsSnap.docs, ...usersSnap.docs, ...authSnap.docs].forEach((docSnap) => {
          const d = docSnap.data();
          if (d.faceDescriptor && Array.isArray(d.faceDescriptor) && d.faceDescriptor.length === 128) {
            let key = (d.rollNo && String(d.rollNo).trim()) ? String(d.rollNo).trim() : docSnap.id;
            if (key.includes("@")) key = key.split("@")[0];
            key = key.toUpperCase().trim();
            const existing = map.get(key) || {};
            map.set(key, { ...existing, ...d, rollNo: key, descriptor: new Float32Array(d.faceDescriptor) });
          }
        });
        setStandaloneStudents(Array.from(map.values()));
      } catch (err) {
        console.warn("Could not fetch students for standalone face scanner:", err);
      }
    };
    fetchAllForStandalone();
  }, [verifiedStudent, modelsLoaded]);

  // 3. Real-time Face Detection, Biometric Matching, Liveness & Anti-Spoofing Loop
  useEffect(() => {
    if (lookingUp) {
      resetLivenessState();
      setStatus("scanning");
      setFeedback("🔍 Fetching student biometric profile from database...");
      onVerificationChange({ verified: false, reason: "LOOKING_UP" });
      return;
    }

    if (verifiedStudent && (!verifiedStudent.faceDescriptor || !Array.isArray(verifiedStudent.faceDescriptor) || verifiedStudent.faceDescriptor.length !== 128)) {
      resetLivenessState();
      setStatus("unregistered");
      setFeedback(`⚠️ No registered face biometrics found for ${verifiedStudent.name || "Student"} (Roll No: ${verifiedStudent.rollNo || rollNo}). Attendance cannot be marked until face is registered by Lecturer or Admin.`);
      onVerificationChange({ verified: false, reason: "NO_REGISTERED_FACE", student: verifiedStudent });
      return;
    }

    if (!modelsLoaded || !cameraActive) return;

    let isScanning = true;
    let lastScanTime = 0;

    const runRecognition = async (time) => {
      if (!isScanning) return;

      // Run recognition loop every 160ms for smooth performance and high responsiveness
      if (time - lastScanTime > 160 && videoRef.current && videoRef.current.readyState >= 2) {
        lastScanTime = time;

        try {
          const video = videoRef.current;
          const canvas = canvasRef.current;

          // Align canvas dimensions to video
          if (canvas && video.videoWidth > 0 && video.videoHeight > 0) {
            if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
            }
          }

          const detection = await faceapi
            .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
            .withFaceLandmarks()
            .withFaceDescriptor();

          const ctx = canvas ? canvas.getContext("2d") : null;
          if (ctx && canvas) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
          }

          if (!detection) {
            noFaceFramesRef.current += 1;
            if (noFaceFramesRef.current >= 6) {
              // Reset if no face has been present for ~1 second
              resetLivenessState();
            }
            setStatus("no_face");
            setFeedback("👀 Looking for face... Please look directly into the camera.");
            setConfidence(0);
            onVerificationChange({ verified: false, reason: "NO_FACE" });
          } else {
            noFaceFramesRef.current = 0;
            const landmarks = detection.landmarks;
            const positions = landmarks.positions;
            const box = detection.detection.box;
            const liveDescriptor = detection.descriptor;

            // -------------------------------------------------------------
            // A. LIVENESS & ANTI-SPOOFING ENGINE
            // -------------------------------------------------------------
            // 1. Eye Aspect Ratio (EAR) Blink Detection
            const leftEye = positions.slice(36, 42);
            const rightEye = positions.slice(42, 48);
            const leftEAR = computeEAR(leftEye);
            const rightEAR = computeEAR(rightEye);
            const avgEAR = (leftEAR + rightEAR) / 2.0;

            // Track eye transition: OPEN -> CLOSED -> OPEN (1 Natural Blink)
            if (avgEAR < BLINK_CLOSED_THRESHOLD) {
              eyeStateRef.current = "closed";
            } else if (avgEAR >= BLINK_OPEN_THRESHOLD) {
              if (eyeStateRef.current === "closed") {
                blinkCountRef.current += 1;
                livenessConfirmedRef.current = true;
                spoofDetectedRef.current = false;
                staticFramesCountRef.current = 0;
                setBlinkCount(blinkCountRef.current);
                setLivenessPassed(true);
                setIsSpoof(false);
              }
              eyeStateRef.current = "open";
            }

            // 2. 3D Facial Micro-Dynamics & Parallax Tracking (Detects Static 2D Photos/Screens)
            const currentRatios = computeFacialRatios(positions);
            ratioHistoryRef.current.push(currentRatios);
            if (ratioHistoryRef.current.length > 20) {
              ratioHistoryRef.current.shift();
            }

            const motionVariance = computeVariance(ratioHistoryRef.current);

            // If authentic 3D micro-movement is detected
            if (motionVariance > 0.00065 && ratioHistoryRef.current.length >= 10) {
              livenessConfirmedRef.current = true;
              spoofDetectedRef.current = false;
              setLivenessPassed(true);
              setIsSpoof(false);
            }

            // If face is completely static for >18 frames without blinks -> Spoof Detected!
            if (
              blinkCountRef.current === 0 &&
              !livenessConfirmedRef.current &&
              motionVariance < STATIC_VARIANCE_THRESHOLD &&
              ratioHistoryRef.current.length >= 12
            ) {
              staticFramesCountRef.current += 1;
              if (staticFramesCountRef.current >= STATIC_FRAME_LIMIT) {
                spoofDetectedRef.current = true;
                livenessConfirmedRef.current = false;
                setIsSpoof(true);
                setLivenessPassed(false);
              }
            } else if (motionVariance >= STATIC_VARIANCE_THRESHOLD) {
              staticFramesCountRef.current = Math.max(0, staticFramesCountRef.current - 1);
            }

            // -------------------------------------------------------------
            // B. BIOMETRIC MATCHING & VERIFICATION GATING
            // -------------------------------------------------------------
            // SCENARIO 1: Targeted student verification (Form mode)
            if (verifiedStudent && verifiedStudent.faceDescriptor) {
              const targetDescriptor = new Float32Array(verifiedStudent.faceDescriptor);
              const dist = faceapi.euclideanDistance(liveDescriptor, targetDescriptor);
              setDistance(dist);

              const conf = Math.max(0, Math.min(100, Math.round((1 - (dist / 0.60)) * 100)));
              setConfidence(conf);

              const isMatch = dist <= MATCH_THRESHOLD;
              const isLive = livenessConfirmedRef.current || blinkCountRef.current >= 1;
              const isSpoofed = spoofDetectedRef.current;

              if (isSpoofed) {
                consecutiveMatchesRef.current = 0;
                setStatus("spoof");
                setFeedback("⚠️ Anti-Spoof Alert: Static Photo or Screen Detected! Live Human Presence Required.");
                onVerificationChange({
                  verified: false,
                  reason: "SPOOF_DETECTED",
                  confidence: 0,
                  distance: dist,
                  antiSpoof: "FAILED"
                });
              } else if (isMatch && isLive) {
                consecutiveMatchesRef.current += 1;
                if (consecutiveMatchesRef.current >= 2) {
                  setStatus("verified");
                  setFeedback(`✅ Live Face Verified! Match Confidence: ${conf}% (${verifiedStudent.name}) • Liveness: PASS 🛡️`);
                  onVerificationChange({
                    verified: true,
                    confidence: conf,
                    distance: dist,
                    liveness: true,
                    antiSpoof: "PASSED",
                    blinkCount: blinkCountRef.current,
                    student: verifiedStudent
                  });
                } else {
                  setStatus("scanning");
                  setFeedback("Authenticating live presence... Hold still.");
                  onVerificationChange({ verified: false, reason: "ALIGNING" });
                }
              } else if (isMatch && !isLive) {
                consecutiveMatchesRef.current = 0;
                setStatus("liveness_check");
                setFeedback("👁️ Face Matched! Please blink naturally to confirm live presence...");
                onVerificationChange({
                  verified: false,
                  reason: "LIVENESS_CHECK_REQUIRED",
                  confidence: conf,
                  distance: dist,
                  antiSpoof: "CHECKING"
                });
              } else {
                consecutiveMatchesRef.current = 0;
                setStatus("mismatch");
                setFeedback(`❌ Face does NOT match registered biometric profile for ${verifiedStudent.name} (${verifiedStudent.rollNo}).`);
                onVerificationChange({
                  verified: false,
                  confidence: 0,
                  distance: dist,
                  reason: "MISMATCH"
                });
              }
            }
            // SCENARIO 2: Standalone Mode (e.g. /facedetection)
            else if (standaloneStudents.length > 0) {
              let bestMatch = null;
              let minDistance = 1.0;

              standaloneStudents.forEach((st) => {
                const dist = faceapi.euclideanDistance(liveDescriptor, st.descriptor);
                if (dist < minDistance) {
                  minDistance = dist;
                  bestMatch = st;
                }
              });

              const isMatch = bestMatch && minDistance <= MATCH_THRESHOLD;
              const isLive = livenessConfirmedRef.current || blinkCountRef.current >= 1;
              const isSpoofed = spoofDetectedRef.current;

              if (isSpoofed) {
                setStatus("spoof");
                setRecognizedStudent(null);
                setFeedback("⚠️ Anti-Spoof Alert: Static Photo / Replay Screen Detected!");
              } else if (isMatch && isLive) {
                const conf = Math.max(0, Math.min(100, Math.round((1 - (minDistance / 0.60)) * 100)));
                setConfidence(conf);
                setRecognizedStudent(bestMatch);
                setStatus("verified");
                setFeedback(`✅ Live Verified: ${bestMatch.name} (${bestMatch.rollNo}) • ${conf}% Match`);
              } else if (isMatch && !isLive) {
                setStatus("liveness_check");
                setFeedback(`👁️ Recognized ${bestMatch.name}. Please blink naturally to confirm liveness...`);
              } else {
                setStatus("mismatch");
                setRecognizedStudent(null);
                setFeedback("❌ Unknown Face / Unregistered Student");
              }
            } else {
              setStatus("scanning");
              setFeedback("Face detected in camera. Enter your Roll Number above to verify.");
              onVerificationChange({ verified: false, reason: "WAITING_ROLL_NUMBER" });
            }

            // -------------------------------------------------------------
            // C. RENDER BIOMETRIC HUD OVERLAY ON CANVAS
            // -------------------------------------------------------------
            if (ctx && canvas) {
              const { x, y, width, height } = box;
              const cornerLen = Math.min(width, height) * 0.22;

              let strokeColor = "#6366f1"; // default indigo
              if (spoofDetectedRef.current) strokeColor = "#ef4444"; // red spoof
              else if (status === "verified") strokeColor = "#10b981"; // green verified
              else if (status === "liveness_check") strokeColor = "#f59e0b"; // amber liveness check
              else if (status === "mismatch") strokeColor = "#ef4444"; // red mismatch

              ctx.lineWidth = 3.5;
              ctx.strokeStyle = strokeColor;
              ctx.lineCap = "round";

              // Top-Left corner
              ctx.beginPath();
              ctx.moveTo(x, y + cornerLen);
              ctx.lineTo(x, y);
              ctx.lineTo(x + cornerLen, y);
              ctx.stroke();

              // Top-Right corner
              ctx.beginPath();
              ctx.moveTo(x + width - cornerLen, y);
              ctx.lineTo(x + width, y);
              ctx.lineTo(x + width, y + cornerLen);
              ctx.stroke();

              // Bottom-Left corner
              ctx.beginPath();
              ctx.moveTo(x, y + height - cornerLen);
              ctx.lineTo(x, y + height);
              ctx.lineTo(x + cornerLen, y + height);
              ctx.stroke();

              // Bottom-Right corner
              ctx.beginPath();
              ctx.moveTo(x + width - cornerLen, y + height);
              ctx.lineTo(x + width, y + height);
              ctx.lineTo(x + width, y + height - cornerLen);
              ctx.stroke();

              // Eye Landmarks Highlighting
              ctx.fillStyle = livenessConfirmedRef.current ? "#10b981" : "#06b6d4";
              [...leftEye, ...rightEye].forEach((pt) => {
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 2, 0, 2 * Math.PI);
                ctx.fill();
              });
            }
          }
        } catch (err) {
          console.warn("Face detection frame error:", err);
        }
      }

      animationRef.current = requestAnimationFrame(runRecognition);
    };

    animationRef.current = requestAnimationFrame(runRecognition);

    return () => {
      isScanning = false;
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [
    verifiedStudent,
    rollNo,
    lookingUp,
    modelsLoaded,
    cameraActive,
    standaloneStudents,
    onVerificationChange,
    resetLivenessState,
    status
  ]);

  return (
    <div className={`biometric-scanner-card ${status}`}>
      {/* Header Info */}
      <div className="scanner-header-info">
        {verifiedStudent ? (
          <div className="scanner-registered-student">
            {verifiedStudent.photoURL ? (
              <img
                src={verifiedStudent.photoURL}
                alt={verifiedStudent.name}
                className="registered-avatar-thumb"
              />
            ) : (
              <div className="registered-avatar-placeholder">
                <FaUser />
              </div>
            )}
            <div className="registered-meta">
              <h4>{verifiedStudent.name}</h4>
              <p>Registered: {verifiedStudent.rollNo} • {(verifiedStudent.branch && String(verifiedStudent.branch).toLowerCase() !== "general") ? verifiedStudent.branch : "CSE"}</p>
            </div>
          </div>
        ) : (
          <div className="scanner-registered-student">
            <div className="registered-avatar-placeholder">
              <FaShieldAlt />
            </div>
            <div className="registered-meta">
              <h4>AI Face Biometric Verification</h4>
              <p>Anti-Spoofing & Live EAR Blink Detection</p>
            </div>
          </div>
        )}

        {/* Status Pill */}
        <div className={`scanner-status-pill ${status === "liveness_check" ? "liveness" : status === "spoof" ? "spoof" : status}`}>
          {status === "verified" && <><FaCheckCircle /> Verified Live</>}
          {status === "liveness_check" && <><FaEye className="fa-spin" /> Blink Required</>}
          {status === "spoof" && <><FaTimesCircle /> Spoof Detected</>}
          {status === "mismatch" && <><FaTimesCircle /> Mismatch</>}
          {status === "no_face" && <><FaCamera /> Looking for Face</>}
          {status === "scanning" && <><FaSpinner className="fa-spin" /> Camera Active</>}
          {status === "loading_models" && <><FaSpinner className="fa-spin" /> Loading AI</>}
          {status === "loading_camera" && <><FaSpinner className="fa-spin" /> Starting Camera</>}
          {status === "unregistered" && <><FaExclamationTriangle /> Unregistered Face</>}
          {status === "error" && <><FaExclamationTriangle /> Camera Error</>}
          {status === "idle" && <><FaShieldAlt /> Standby</>}
        </div>
      </div>

      {/* Video & Scanner Box */}
      <div className="scanner-video-wrapper">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="scanner-video"
          onLoadedMetadata={() => {
            if (videoRef.current) {
              videoRef.current.play().catch((e) => console.warn("play onLoadedMetadata error:", e));
            }
          }}
        />
        <canvas ref={canvasRef} className="scanner-overlay-canvas" />

        {/* Laser scanning line */}
        <div className="scanner-laser-line" />

        {/* Reticle Corners */}
        <div className="scanner-corner top-left" />
        <div className="scanner-corner top-right" />
        <div className="scanner-corner bottom-left" />
        <div className="scanner-corner bottom-right" />
      </div>

      {/* Anti-Spoofing & Liveness Shield Badges */}
      <div className="liveness-badge-row">
        <span className={`liveness-shield-tag ${isSpoof ? "spoof-warn" : livenessPassed ? "live-pass" : ""}`}>
          <FaShieldAlt /> Anti-Spoof: {isSpoof ? "⚠️ ALERT (Static Photo/Screen)" : livenessPassed ? "PASSED (Live Human)" : "Active 🛡️"}
        </span>
        <span className={`liveness-shield-tag ${livenessPassed ? "live-pass" : ""}`}>
          {livenessPassed ? <FaEye /> : <FaEyeSlash />} Blink Check: {blinkCount >= 1 ? `✅ Blink Verified (${blinkCount})` : "👁️ Blink to Verify"}
        </span>
      </div>

      {/* Unregistered Alert Banner */}
      {status === "unregistered" && (
        <div className="unregistered-face-alert" style={{ marginTop: "12px", marginBottom: "12px" }}>
          <h4>
            <FaUserTimes style={{ color: "#ef4444", fontSize: "1.1rem" }} />
            Biometric Face Not Registered
          </h4>
          <p>
            No registered facial biometric vector found for <strong>{verifiedStudent?.name || "Student"}</strong> (Roll No: <strong>{verifiedStudent?.rollNo || rollNo}</strong>).
          </p>
          <p style={{ marginTop: "6px", fontWeight: 700, color: "#b91c1c" }}>
            ⛔ Facial biometric enrollment is required to mark attendance.
          </p>
          {onEnrollRequest && (
            <button
              type="button"
              onClick={onEnrollRequest}
              style={{
                marginTop: "12px",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "9px 18px",
                borderRadius: "10px",
                background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                color: "#ffffff",
                border: "none",
                fontWeight: 700,
                fontSize: "0.88rem",
                cursor: "pointer",
                boxShadow: "0 4px 12px rgba(99, 102, 241, 0.3)"
              }}
            >
              <FaCamera /> 📸 Register / Enroll Facial Biometrics Now
            </button>
          )}
        </div>
      )}

      {/* Error & Retry Button */}
      {cameraError && (
        <div style={{ margin: "10px 0", textAlign: "center" }}>
          <p style={{ color: "#dc2626", fontWeight: 700, fontSize: "0.85rem", margin: "0 0 8px 0" }}>
            {cameraError}
          </p>
          <button
            type="button"
            onClick={initCameraAndModels}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "8px 16px",
              borderRadius: "8px",
              background: "#6366f1",
              color: "#ffffff",
              border: "none",
              fontWeight: 700,
              fontSize: "0.85rem",
              cursor: "pointer"
            }}
          >
            <FaRedo /> Retry Camera Connection
          </button>
        </div>
      )}

      {/* Status Message */}
      <div className={`scanner-feedback-msg ${status === "liveness_check" ? "warning" : status === "spoof" ? "mismatch" : status}`}>
        {status === "verified" && <FaCheckCircle />}
        {status === "liveness_check" && <FaEye />}
        {status === "spoof" && <FaExclamationTriangle />}
        {status === "mismatch" && <FaExclamationTriangle />}
        {(status === "loading_models" || status === "loading_camera") && <FaSpinner className="fa-spin" />}
        <span>{feedback}</span>
      </div>

      {/* Confidence Gauge Bar when scanning / verified / spoof */}
      {(status === "verified" || status === "mismatch" || status === "liveness_check" || status === "spoof") && (
        <div className="confidence-gauge-wrap">
          <div className="confidence-gauge-header">
            <span>Biometric Match Score</span>
            <span style={{ color: status === "verified" ? "#10b981" : status === "liveness_check" ? "#f59e0b" : "#ef4444" }}>
              {confidence}% {status === "verified" ? "(AUTHENTICATED)" : status === "liveness_check" ? "(LIVENESS REQUIRED)" : status === "spoof" ? "(SPOOF BLOCKED)" : "(FAIL)"}
            </span>
          </div>
          <div className="confidence-gauge-bar-bg">
            <div
              className={`confidence-gauge-bar-fill ${status === "verified" ? "high" : status === "liveness_check" ? "medium" : "low"}`}
              style={{ width: `${confidence}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default FaceScanner;