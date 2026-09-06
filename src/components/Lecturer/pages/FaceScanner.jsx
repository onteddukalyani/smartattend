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
  FaRedo
} from "react-icons/fa";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../../firebase";
import "./FaceScanner.css";

const MODEL_CDN_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
const MATCH_THRESHOLD = 0.55; // Standard euclidean distance threshold (<= 0.55 = match)

// Helper for resilient camera stream capture across all platforms & browsers
const getCameraStream = async () => {
  // 1. Modern WebRTC
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

  // 2. Legacy getUserMedia
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

  // 3. Insecure context check
  if (typeof window !== "undefined" && !window.isSecureContext) {
    throw new Error(
      "INSECURE_CONTEXT: WebRTC requires HTTPS or localhost. Please use 'Snap Photo with Camera' or access via HTTPS."
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

  // Status: "idle" | "loading_models" | "loading_camera" | "scanning" | "verified" | "mismatch" | "no_face" | "unregistered" | "error"
  const [status, setStatus] = useState("loading_camera");
  const [cameraActive, setCameraActive] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [feedback, setFeedback] = useState("Starting camera & loading AI recognition models...");
  const [confidence, setConfidence] = useState(0);
  const [distance, setDistance] = useState(1.0);
  const [cameraError, setCameraError] = useState("");
  const [standaloneStudents, setStandaloneStudents] = useState([]);
  const [recognizedStudent, setRecognizedStudent] = useState(null);

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
        try {
          await videoRef.current.play();
        } catch (playErr) {
          console.warn("Video play error (handled):", playErr);
        }
      }
      setCameraActive(true);
    } catch (camErr) {
      console.error("Camera initial access error:", camErr);
      setCameraError("Camera access failed. Please enable camera permissions in your browser.");
      setStatus("error");
      setFeedback("Camera blocked or unavailable. Click 'Retry Camera' below.");
      return;
    }

    // B. Load Face-API Models (local /models first with CDN fallback)
    try {
      setStatus("loading_models");
      setFeedback("Loading AI biometric recognition models...");

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
      setStatus("scanning");
      setFeedback("Camera active. Looking for face in frame...");
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

  // 2. Fetch standalone database students if in standalone mode (no verifiedStudent prop provided)
  useEffect(() => {
    if (verifiedStudent !== null || !modelsLoaded) return;
    const fetchAllForStandalone = async () => {
      try {
        const [studentsSnap, usersSnap] = await Promise.all([
          getDocs(collection(db, "students")),
          getDocs(collection(db, "users"))
        ]);
        const map = new Map();
        [...studentsSnap.docs, ...usersSnap.docs].forEach((docSnap) => {
          const d = docSnap.data();
          if (d.faceDescriptor && Array.isArray(d.faceDescriptor) && d.faceDescriptor.length === 128) {
            let key = (d.rollNo && String(d.rollNo).trim()) ? String(d.rollNo).trim() : docSnap.id;
            if (key.includes("@")) key = key.split("@")[0];
            key = key.toUpperCase().trim();
            map.set(key, { ...d, rollNo: key, descriptor: new Float32Array(d.faceDescriptor) });
          }
        });
        setStandaloneStudents(Array.from(map.values()));
      } catch (err) {
        console.warn("Could not fetch students for standalone face scanner:", err);
      }
    };
    fetchAllForStandalone();
  }, [verifiedStudent, modelsLoaded]);

  // 3. Real-time Face Detection and Biometric Matching Loop
  useEffect(() => {
    // If student lookup is currently running
    if (lookingUp) {
      setStatus("scanning");
      setFeedback("🔍 Fetching student biometric profile from database...");
      onVerificationChange({ verified: false, reason: "LOOKING_UP" });
      return;
    }

    // If student was found but has NO registered face biometrics
    if (verifiedStudent && (!verifiedStudent.faceDescriptor || !Array.isArray(verifiedStudent.faceDescriptor) || verifiedStudent.faceDescriptor.length !== 128)) {
      setStatus("unregistered");
      setFeedback(`⚠️ No registered face biometrics found for ${verifiedStudent.name || "Student"} (Roll No: ${verifiedStudent.rollNo || rollNo}). Attendance cannot be marked until face is registered.`);
      onVerificationChange({ verified: false, reason: "NO_REGISTERED_FACE", student: verifiedStudent });
      return;
    }

    // If no models or video yet
    if (!modelsLoaded || !cameraActive) return;

    let isScanning = true;
    let lastScanTime = 0;

    const runRecognition = async (time) => {
      if (!isScanning) return;

      // Run recognition every 160ms for optimal balance of speed and CPU performance
      if (time - lastScanTime > 160 && videoRef.current && videoRef.current.readyState >= 2) {
        lastScanTime = time;

        try {
          const detection = await faceapi
            .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
            .withFaceLandmarks()
            .withFaceDescriptor();

          if (!detection) {
            setStatus("no_face");
            setFeedback("👀 Looking for face... Please look directly into the camera.");
            setConfidence(0);
            onVerificationChange({ verified: false, reason: "NO_FACE" });
          } else {
            const liveDescriptor = detection.descriptor;

            // SCENARIO A: Targeted verification for specific student in form
            if (verifiedStudent && verifiedStudent.faceDescriptor) {
              const targetDescriptor = new Float32Array(verifiedStudent.faceDescriptor);
              const dist = faceapi.euclideanDistance(liveDescriptor, targetDescriptor);
              setDistance(dist);

              // Calculate confidence score (0 to 100%)
              const conf = Math.max(0, Math.min(100, Math.round((1 - (dist / 0.70)) * 100)));
              setConfidence(conf);

              if (dist <= MATCH_THRESHOLD) {
                setStatus("verified");
                setFeedback(`✅ Face Verified! Match Confidence: ${conf}% (${verifiedStudent.name})`);
                onVerificationChange({
                  verified: true,
                  confidence: conf,
                  distance: dist,
                  student: verifiedStudent
                });
              } else {
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
            // SCENARIO B: Standalone mode or waiting for Roll Number
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

              if (bestMatch && minDistance <= MATCH_THRESHOLD) {
                const conf = Math.max(0, Math.min(100, Math.round((1 - (minDistance / 0.70)) * 100)));
                setConfidence(conf);
                setRecognizedStudent(bestMatch);
                setStatus("verified");
                setFeedback(`✅ Recognized: ${bestMatch.name} (${bestMatch.rollNo}) • ${conf}% Match`);
              } else {
                setStatus("mismatch");
                setRecognizedStudent(null);
                setFeedback("❌ Unknown Face / Unregistered Student");
              }
            } else {
              // Face detected, waiting for student roll number to be entered
              setStatus("scanning");
              setFeedback("Face detected in camera. Enter your Roll Number above to verify.");
              onVerificationChange({ verified: false, reason: "WAITING_ROLL_NUMBER" });
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
  }, [verifiedStudent, rollNo, lookingUp, modelsLoaded, cameraActive, standaloneStudents, onVerificationChange]);

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
              <p>Real-time 128-D Euclidean Vector Recognition</p>
            </div>
          </div>
        )}

        {/* Status Pill */}
        <div className={`scanner-status-pill ${status}`}>
          {status === "verified" && <><FaCheckCircle /> Verified</>}
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

      {/* Unregistered Alert Banner */}
      {status === "unregistered" && (
        <div className="unregistered-face-alert" style={{ marginBottom: "12px" }}>
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
      <div className={`scanner-feedback-msg ${status}`}>
        {status === "verified" && <FaCheckCircle />}
        {status === "mismatch" && <FaExclamationTriangle />}
        {(status === "loading_models" || status === "loading_camera") && <FaSpinner className="fa-spin" />}
        <span>{feedback}</span>
      </div>

      {/* Confidence Gauge Bar when scanning / verified */}
      {(status === "verified" || status === "mismatch") && (
        <div className="confidence-gauge-wrap">
          <div className="confidence-gauge-header">
            <span>Biometric Match Score</span>
            <span style={{ color: status === "verified" ? "#10b981" : "#ef4444" }}>
              {confidence}% {status === "verified" ? "(PASS)" : "(FAIL)"}
            </span>
          </div>
          <div className="confidence-gauge-bar-bg">
            <div
              className={`confidence-gauge-bar-fill ${confidence >= 70 ? "high" : confidence >= 50 ? "medium" : "low"}`}
              style={{ width: `${confidence}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default FaceScanner;