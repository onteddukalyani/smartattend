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
  FaEyeSlash,
  FaSyncAlt
} from "react-icons/fa";
import { matchStudentFace } from "../../../services/faceEnrollmentService";
import {
  computeEAR,
  computeHeadPose,
  computeFacialRatios,
  computeMotionVariance,
  computeMAR,
  computeSmileMetric,
  MAR_SMILE_THRESHOLD,
  BLINK_CLOSED_THRESHOLD,
  BLINK_OPEN_THRESHOLD,
  STATIC_VARIANCE_THRESHOLD,
  RandomizedChallengeEngine
} from "../../../utils/livenessDetector";
import "./FaceScanner.css";

const MODEL_CDN_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
export const MATCH_THRESHOLD = 0.52; // Industry-calibrated ResNet-34 Euclidean benchmark for mobile front camera
const STATIC_FRAME_LIMIT = 30; // ~4 seconds of dead static face triggers spoof alert

// Helper to release all active media tracks across DOM to avoid hardware camera collisions
export const releaseAllMediaTracks = () => {
  try {
    if (typeof document !== "undefined") {
      document.querySelectorAll("video").forEach((v) => {
        if (v.srcObject && typeof v.srcObject.getTracks === "function") {
          v.srcObject.getTracks().forEach((t) => {
            try { t.stop(); } catch (_) { }
          });
          v.srcObject = null;
        }
      });
    }
  } catch (e) {
    console.warn("Track release notice:", e);
  }
};

// Helper for camera stream capture with progressive fallback and automatic retry
const getCameraStream = async (_requestedFacingMode = "user", maxRetries = 3) => {
  releaseAllMediaTracks();
  // Safe cooldown for hardware camera HAL release between rear and front sensors
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Identify front/user camera device ID if multiple video devices are available
  let frontDeviceId = null;
  try {
    if (navigator?.mediaDevices?.enumerateDevices) {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const videoDevs = devs.filter((d) => d.kind === "videoinput");
      const frontDev = videoDevs.find((d) =>
        /front|user|selfie|face/i.test(d.label)
      );
      if (frontDev?.deviceId) {
        frontDeviceId = frontDev.deviceId;
      }
    }
  } catch (_) { }

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const attempts = [
      ...(frontDeviceId ? [{
        video: {
          deviceId: { exact: frontDeviceId },
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 30, max: 30 }
        },
        audio: false
      }] : []),
      {
        video: {
          facingMode: { ideal: "user" },
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 30, max: 30 }
        },
        audio: false
      },
      { video: { facingMode: { ideal: "user" }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
      { video: { facingMode: { ideal: "user" } }, audio: false },
      { video: { facingMode: "user" }, audio: false },
      { video: true, audio: false }
    ];

    let lastError = null;
    for (let retry = 0; retry <= maxRetries; retry++) {
      if (retry > 0) {
        await new Promise((r) => setTimeout(r, retry * 400));
        releaseAllMediaTracks();
      }

      for (const constraints of attempts) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (stream && stream.getVideoTracks().length > 0) {
            return stream;
          }
        } catch (err) {
          lastError = err;
          console.warn(`Camera attempt (retry ${retry}) failed:`, constraints, err?.name, err?.message);
          if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
            throw err;
          }
        }
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

// Dual-source model loader: local /models with CDN fallback
export const loadFaceApiModels = async () => {
  if (
    faceapi.nets.tinyFaceDetector.isLoaded &&
    faceapi.nets.faceLandmark68Net.isLoaded &&
    faceapi.nets.faceRecognitionNet.isLoaded
  ) {
    return true;
  }

  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri("/models"),
      faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
      faceapi.nets.faceRecognitionNet.loadFromUri("/models")
    ]);
    return true;
  } catch (localErr) {
    console.warn("Local models load notice, falling back to CDN:", localErr);
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_CDN_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_CDN_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_CDN_URL)
    ]);
    return true;
  }
};

function FaceScanner({
  verifiedStudent = null,
  lookingUp = false,
  rollNo = "",
  onVerificationChange = () => { },
  onEnrollRequest = null,
  allowRearCamera = false
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
  const mismatchFramesRef = useRef(0);

  // Status: "idle" | "loading_models" | "loading_camera" | "scanning" | "liveness_check" | "spoof" | "verified" | "mismatch" | "no_face" | "unregistered" | "error"
  const [status, setStatus] = useState("loading_camera");
  const [cameraActive, setCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState("user");
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [feedback, setFeedback] = useState("Starting camera & loading AI recognition models...");
  const [confidence, setConfidence] = useState(0);
  const [distance, setDistance] = useState(1.0);
  const [cameraError, setCameraError] = useState("");
  const [recognizedStudent, setRecognizedStudent] = useState(null);

  // Performance & Concurrency Refs
  const statusRef = useRef(status);
  const feedbackRef = useRef(feedback);
  const isDetectingRef = useRef(false);
  const matchScoreRef = useRef(0);
  const lastStateUpdateRef = useRef(0);
  const liveDescriptorRef = useRef(null);
  const frameCountRef = useRef(0);
  const serverMatchRef = useRef(null);
  const lastServerMatchAtRef = useRef(0);
  const matchInFlightRef = useRef(false);
  const matchRequestTokenRef = useRef(0);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    feedbackRef.current = feedback;
  }, [feedback]);

  // UI Liveness Indicators
  const [blinkCount, setBlinkCount] = useState(0);
  const [livenessPassed, setLivenessPassed] = useState(false);
  const [isSpoof, setIsSpoof] = useState(false);
  const challengeEngineRef = useRef(null);
  const [activeChallenge, setActiveChallenge] = useState(null);

  // Helpers to prevent React re-render thrashing inside high-frequency animation loop
  const updateStatus = useCallback((nextStatus) => {
    if (statusRef.current !== nextStatus) {
      statusRef.current = nextStatus;
      setStatus(nextStatus);
    }
  }, []);

  const updateFeedback = useCallback((nextFeedback) => {
    if (feedbackRef.current !== nextFeedback) {
      feedbackRef.current = nextFeedback;
      setFeedback(nextFeedback);
    }
  }, []);

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
    matchScoreRef.current = 0;
    mismatchFramesRef.current = 0;
    liveDescriptorRef.current = null;
    frameCountRef.current = 0;
    setBlinkCount(0);
    setLivenessPassed(false);
    setIsSpoof(false);
    if (!challengeEngineRef.current) {
      challengeEngineRef.current = new RandomizedChallengeEngine({ mode: "attendance" });
    } else {
      challengeEngineRef.current.reset();
    }
    setActiveChallenge(null);
  }, []);

  // 1. Initialize Camera and AI Models
  const initCameraAndModels = useCallback(async (targetFacingMode) => {
    const activeFacing = (typeof targetFacingMode === "string" && targetFacingMode) ? targetFacingMode : (facingMode || "user");
    setCameraError("");
    setStatus("loading_camera");
    setFeedback("Initializing camera and biometric models...");

    // A. Start Camera Stream
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      const stream = await getCameraStream(activeFacing);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute("autoplay", "true");
        videoRef.current.setAttribute("playsinline", "true");
        videoRef.current.setAttribute("muted", "true");

        try {
          await videoRef.current.play();
          setCameraActive(true);
        } catch (playErr) {
          console.warn("Video play error:", playErr);
          setCameraActive(true);
        }
      }
    } catch (camErr) {
      console.error("Camera access error:", camErr);
      const isDenied = camErr.name === "NotAllowedError" || camErr.name === "PermissionDeniedError";
      const isInUse = camErr.name === "NotReadableError" || camErr.name === "TrackStartError";

      if (isDenied) {
        setCameraError("Camera permission denied. Please allow camera access in your browser / app settings.");
      } else if (isInUse) {
        setCameraError("Camera is in use by another feature. Retrying connection...");
        // Auto retry once after brief delay
        setTimeout(() => {
          initCameraAndModels(activeFacing);
        }, 600);
      } else if (camErr.message?.includes("INSECURE_CONTEXT")) {
        setCameraError("Camera requires HTTPS. Please open via HTTPS or localhost.");
      } else {
        setCameraError("Could not access webcam. Please check camera permissions and tap Retry.");
      }
      setStatus("error");
      setFeedback("Camera connection unavailable.");
      return;
    }

    // B. Load AI Recognition Models
    try {
      setStatus("loading_models");
      setFeedback("Loading facial neural network models...");

      await loadFaceApiModels();

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
      releaseAllMediaTracks();
    };
  }, [initCameraAndModels]);

  // Reset state when roll number or verified student changes
  useEffect(() => {
    resetLivenessState();
    serverMatchRef.current = null;
    lastServerMatchAtRef.current = 0;
    matchRequestTokenRef.current += 1;
    matchInFlightRef.current = false;
  }, [rollNo, verifiedStudent, resetLivenessState]);

  // 3. Real-time Face Detection, Biometric Matching, Liveness & Anti-Spoofing Loop
  useEffect(() => {
    if (lookingUp) {
      resetLivenessState();
      updateStatus("scanning");
      updateFeedback("🔍 Fetching student biometric profile from database...");
      onVerificationChange({ verified: false, reason: "LOOKING_UP" });
      return;
    }

    const hasEnrolledFace = Boolean(
      verifiedStudent?.faceRegistered ||
      verifiedStudent?.faceDescriptor ||
      verifiedStudent?.descriptor
    );
    if (verifiedStudent && !hasEnrolledFace) {
      resetLivenessState();
      updateStatus("unregistered");
      updateFeedback(`⚠️ No registered face biometrics found for ${verifiedStudent.name || "Student"} (Roll No: ${verifiedStudent.rollNo || rollNo}). Please complete in-app Face Registration in the Biometric Registration hub before marking attendance.`);
      onVerificationChange({ verified: false, reason: "NO_REGISTERED_FACE", student: verifiedStudent });
      return;
    }

    if (!modelsLoaded || !cameraActive) return;

    let isScanning = true;
    let lastScanTime = 0;
    const isMobileDevice = typeof window !== "undefined" && (window.innerWidth <= 768 || /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || ""));
    const detectorInputSize = isMobileDevice ? 160 : 224;
    const detectorOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: detectorInputSize, scoreThreshold: 0.35 });
    const scanInterval = isMobileDevice ? 50 : 40;

    const runRecognition = async (time) => {
      if (!isScanning) return;

      // Run recognition loop with non-blocking concurrency guard to maintain 60 FPS camera smoothness
      if (time - lastScanTime > scanInterval && !isDetectingRef.current && videoRef.current && videoRef.current.readyState >= 2) {
        lastScanTime = time;
        isDetectingRef.current = true;

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

          // Decouple landmark tracking from heavy ResNet-34 descriptor computation:
          // TinyFaceDetector + FaceLandmarks is lightweight (~15ms, silky-smooth 60 FPS).
          // ResNet-34 FaceRecognitionNet (.withFaceDescriptor()) takes ~180-250ms per frame.
          // Therefore, only compute descriptor on challenge progress/completion OR every 6th frame (~240ms).
          frameCountRef.current = (frameCountRef.current || 0) + 1;
          const isChallengeNearComplete = challengeEngineRef.current && (challengeEngineRef.current.isComplete || challengeEngineRef.current.progress >= 50);
          const shouldComputeDescriptor = isChallengeNearComplete || (frameCountRef.current % 6 === 0) || !liveDescriptorRef.current;

          let detection = null;
          if (shouldComputeDescriptor) {
            detection = await faceapi
              .detectSingleFace(video, detectorOptions)
              .withFaceLandmarks()
              .withFaceDescriptor();
            if (detection?.descriptor) {
              liveDescriptorRef.current = detection.descriptor;
            }
          } else {
            detection = await faceapi
              .detectSingleFace(video, detectorOptions)
              .withFaceLandmarks();
            if (detection && liveDescriptorRef.current) {
              detection.descriptor = liveDescriptorRef.current;
            }
          }

          const ctx = canvas ? canvas.getContext("2d") : null;
          if (ctx && canvas) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
          }

          if (!detection) {
            noFaceFramesRef.current += 1;
            if (noFaceFramesRef.current >= 6) {
              resetLivenessState();
              updateStatus("no_face");
              updateFeedback("👀 Looking for face... Please look directly into the camera.");
              setConfidence(0);
              onVerificationChange({ verified: false, reason: "NO_FACE" });
            }
          } else {
            noFaceFramesRef.current = 0;
            const landmarks = detection.landmarks;
            const box = detection.detection.box;
            const liveDescriptor = detection.descriptor;

            // -------------------------------------------------------------
            // A. ACTIVE LIVENESS & ANTI-SPOOFING CHALLENGE ENGINE
            // -------------------------------------------------------------
            if (!challengeEngineRef.current) {
              challengeEngineRef.current = new RandomizedChallengeEngine({ mode: "attendance" });
            }

            const challengeEngine = challengeEngineRef.current;
            const isChallengeComplete = challengeEngine.processFrame(detection);

            // STRICT Dynamic Anti-Replay Liveness Verification:
            // The active randomized challenge MUST be verified in real-time without spoofing.
            // Human blink, gesture completion, or verified live motion consensus confirms presence.
            const hasLivePresence = Boolean(
              !challengeEngine.spoofDetected && (
                (isChallengeComplete && challengeEngine.isComplete === true) ||
                (challengeEngine.blinkCount >= 1) ||
                (challengeEngine.isComplete === true) ||
                (consecutiveMatchesRef.current >= 2 && (challengeEngine.ratioHistory?.length || 0) >= 6)
              )
            );

            // Throttle activeChallenge state updates to ~250ms to keep React lightweight
            const now = performance.now();
            if (now - lastStateUpdateRef.current > 250 || hasLivePresence || challengeEngine.spoofDetected) {
              lastStateUpdateRef.current = now;
              setActiveChallenge({
                message: challengeEngine.message,
                progress: challengeEngine.progress,
                currentChallenge: challengeEngine.currentChallenge,
                currentIndex: challengeEngine.currentIndex,
                challenges: challengeEngine.challenges,
                isComplete: hasLivePresence,
                spoofDetected: challengeEngine.spoofDetected,
                blinkCount: challengeEngine.blinkCount || 0
              });
            }

            if (challengeEngine.spoofDetected) {
              spoofDetectedRef.current = true;
              livenessConfirmedRef.current = false;
              setIsSpoof(true);
              setLivenessPassed(false);
            } else if (hasLivePresence) {
              livenessConfirmedRef.current = true;
              spoofDetectedRef.current = false;
              setLivenessPassed(true);
              setIsSpoof(false);
            }

            if (
              liveDescriptor &&
              !challengeEngine.spoofDetected &&
              !matchInFlightRef.current &&
              now - lastServerMatchAtRef.current >= 1800
            ) {
              const requestToken = matchRequestTokenRef.current;
              const targetRollNo = verifiedStudent?.rollNo || rollNo || "";
              lastServerMatchAtRef.current = now;
              matchInFlightRef.current = true;
              matchStudentFace(Array.from(liveDescriptor), targetRollNo)
                .then((result) => {
                  if (requestToken === matchRequestTokenRef.current) {
                    serverMatchRef.current = { ...result, receivedAt: performance.now() };
                  }
                })
                .catch((error) => {
                  if (requestToken === matchRequestTokenRef.current) {
                    serverMatchRef.current = {
                      status: "ERROR",
                      message: error.message || "Secure face matching is unavailable.",
                      receivedAt: performance.now()
                    };
                  }
                })
                .finally(() => {
                  if (requestToken === matchRequestTokenRef.current) {
                    matchInFlightRef.current = false;
                  }
                });
            }

            const serverMatch = serverMatchRef.current;
            const hasFreshServerMatch = Boolean(
              serverMatch && now - serverMatch.receivedAt < 2000
            );

            // -------------------------------------------------------------
            // B. BIOMETRIC MATCHING & VERIFICATION GATING
            // -------------------------------------------------------------
            // SCENARIO 1: Targeted student verification (Form mode / Attendance)
            if (verifiedStudent) {
              const dist = hasFreshServerMatch && Number.isFinite(serverMatch.distance)
                ? serverMatch.distance
                : 1;
              const conf = hasFreshServerMatch ? Number(serverMatch.confidence || 0) : 0;

              // Throttled UI distance & confidence updates
              if (now - lastStateUpdateRef.current > 250) {
                setDistance(dist);
                setConfidence(conf);
              }

              const isMatch = hasFreshServerMatch && serverMatch.matched === true;
              const isLive = livenessConfirmedRef.current;
              const isSpoofed = spoofDetectedRef.current;

              if (isSpoofed) {
                matchScoreRef.current = 0;
                consecutiveMatchesRef.current = 0;
                mismatchFramesRef.current = 0;
                updateStatus("spoof");
                updateFeedback("⚠️ Anti-Spoof Alert: Static Photo or Screen Detected! Live Human Presence Required.");
                onVerificationChange({
                  verified: false,
                  reason: "SPOOF_DETECTED",
                  confidence: 0,
                  distance: dist,
                  antiSpoof: "FAILED"
                });
              } else if (hasFreshServerMatch && serverMatch.status === "REVIEW_REQUIRED") {
                updateStatus("mismatch");
                updateFeedback("⚠️ Face match is uncertain. Ask an authorized lecturer or administrator to review; attendance is not verified.");
                onVerificationChange({ verified: false, reason: "REVIEW_REQUIRED", distance: dist });
              } else if (hasFreshServerMatch && serverMatch.status === "UNREGISTERED") {
                updateStatus("unregistered");
                updateFeedback(`⚠️ No registered face biometrics found for ${verifiedStudent.name || "Student"} (${verifiedStudent.rollNo || rollNo}).`);
                onVerificationChange({ verified: false, reason: "NO_REGISTERED_FACE", student: verifiedStudent });
              } else if (!hasFreshServerMatch || serverMatch.status === "ERROR") {
                updateStatus("scanning");
                updateFeedback(serverMatch?.message || "Secure face comparison in progress...");
                onVerificationChange({ verified: false, reason: "MATCHING_IN_PROGRESS" });
              } else if (isMatch && isLive) {
                mismatchFramesRef.current = 0;
                matchScoreRef.current = Math.min(3, matchScoreRef.current + 1);
                consecutiveMatchesRef.current += 1;
                // Fast verify on strong match (dist < 0.44) or 2-frame consensus (dist <= 0.52)
                const isVerifiedStrict = (dist < 0.44) || (matchScoreRef.current >= 2);
                if (isVerifiedStrict) {
                  setDistance(dist);
                  setConfidence(conf);
                  updateStatus("verified");
                  updateFeedback(`✅ Live Face Verified! Match Confidence: ${conf}% (${verifiedStudent.name}) • Liveness Confirmed 🛡️`);
                  // Halt animation loop and camera immediately to prevent WebView stutter / freezing
                  isScanning = false;
                  if (animationRef.current) {
                    cancelAnimationFrame(animationRef.current);
                    animationRef.current = null;
                  }
                  if (streamRef.current) {
                    streamRef.current.getTracks().forEach((t) => t.stop());
                    streamRef.current = null;
                  }
                  onVerificationChange({
                    verified: true,
                    confidence: conf,
                    distance: dist,
                    liveness: true,
                    antiSpoof: "PASSED",
                    blinkCount: challengeEngine.blinkCount || 1,
                    student: verifiedStudent,
                    liveDescriptor: Array.from(liveDescriptor)
                  });
                } else {
                  updateStatus("scanning");
                  updateFeedback("Authenticating live presence... Hold still.");
                  onVerificationChange({ verified: false, reason: "ALIGNING" });
                }
              } else if (isMatch && !isLive) {
                mismatchFramesRef.current = 0;
                if (dist > MATCH_THRESHOLD + 0.04) {
                  matchScoreRef.current = Math.max(0, matchScoreRef.current - 0.5);
                }
                updateStatus("liveness_check");
                updateFeedback(challengeEngine.message || "👁️ Face aligned! Please blink naturally to confirm live presence...");
                onVerificationChange({
                  verified: false,
                  reason: "LIVENESS_CHECK_REQUIRED",
                  confidence: conf,
                  distance: dist,
                  antiSpoof: "CHECKING"
                });
              } else {
                matchScoreRef.current = Math.max(0, matchScoreRef.current - 1);
                consecutiveMatchesRef.current = 0;
                mismatchFramesRef.current += 1;

                // Require at least 5 consecutive non-matching frames before declaring mismatch to avoid transient angle jitter
                if (mismatchFramesRef.current >= 5) {
                  updateStatus("mismatch");
                  updateFeedback(`❌ Face does NOT match registered student ${verifiedStudent.name} (${verifiedStudent.rollNo})! Proxy attendance is strictly prohibited.`);
                  onVerificationChange({
                    verified: false,
                    confidence: 0,
                    distance: dist,
                    reason: "MISMATCH"
                  });
                } else {
                  updateStatus("scanning");
                  updateFeedback("Aligning face with biometric profile... Please hold steady.");
                  onVerificationChange({ verified: false, reason: "ALIGNING" });
                }
              }
            }
            // SCENARIO 2: Standalone Mode (e.g. /facedetection)
            else {
              const bestMatch = hasFreshServerMatch ? serverMatch.student : null;
              const isMatch = hasFreshServerMatch && serverMatch.matched === true;
              const isLive = livenessConfirmedRef.current;
              const isSpoofed = spoofDetectedRef.current;

              if (isSpoofed) {
                updateStatus("spoof");
                setRecognizedStudent(null);
                updateFeedback("⚠️ Anti-Spoof Alert: Static Photo / Replay Screen Detected!");
              } else if (hasFreshServerMatch && serverMatch.status === "REVIEW_REQUIRED") {
                updateStatus("mismatch");
                setRecognizedStudent(null);
                updateFeedback("⚠️ Face match is uncertain. Ask an authorized lecturer or administrator to review.");
              } else if (!hasFreshServerMatch || serverMatch.status === "ERROR") {
                updateStatus("scanning");
                updateFeedback(serverMatch?.message || "Secure face comparison in progress...");
              } else if (isMatch && isLive) {
                const conf = Number(serverMatch.confidence || 0);
                setConfidence(conf);
                setRecognizedStudent(bestMatch);
                updateStatus("verified");
                updateFeedback(`✅ Live Verified: ${bestMatch.name} (${bestMatch.rollNo}) • ${conf}% Match`);
              } else if (isMatch && !isLive) {
                updateStatus("liveness_check");
                updateFeedback(challengeEngine.message || "👁️ Face found. Blink naturally to confirm liveness...");
              } else {
                updateStatus("mismatch");
                setRecognizedStudent(null);
                updateFeedback("❌ Unknown Face / Unregistered Student");
              }
            }

            // -------------------------------------------------------------
            // C. RENDER BIOMETRIC HUD OVERLAY ON CANVAS
            // -------------------------------------------------------------
            if (ctx && canvas) {
              const { x, y, width, height } = box;
              const cornerLen = Math.min(width, height) * 0.22;

              let strokeColor = "#6366f1"; // default indigo
              const curStatus = statusRef.current;
              if (spoofDetectedRef.current) strokeColor = "#ef4444"; // red spoof
              else if (curStatus === "verified") strokeColor = "#10b981"; // green verified
              else if (curStatus === "liveness_check") strokeColor = "#f59e0b"; // amber liveness check
              else if (curStatus === "mismatch") strokeColor = "#ef4444"; // red mismatch

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
              const leftEye = (landmarks && typeof landmarks.getLeftEye === "function") ? landmarks.getLeftEye() : [];
              const rightEye = (landmarks && typeof landmarks.getRightEye === "function") ? landmarks.getRightEye() : [];
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
        } finally {
          isDetectingRef.current = false;
        }
      }

      if (isScanning) {
        animationRef.current = requestAnimationFrame(runRecognition);
      }
    };

    animationRef.current = requestAnimationFrame(runRecognition);

    return () => {
      isScanning = false;
      isDetectingRef.current = false;
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
    onVerificationChange,
    resetLivenessState,
    updateStatus,
    updateFeedback
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
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "0.72rem", padding: "2px 8px", borderRadius: "999px", background: "rgba(99, 102, 241, 0.12)", color: "#4f46e5", fontWeight: 700, marginTop: "4px" }}>
                <FaUserCheck /> 1:1 Identity Lock Active
              </span>
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

        {/* Actions & Status */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {/* Front Camera Biometrics Badge */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "5px 11px",
              borderRadius: "8px",
              background: "rgba(99, 102, 241, 0.08)",
              border: "1px solid rgba(99, 102, 241, 0.25)",
              color: "#4f46e5",
              fontSize: "0.75rem",
              fontWeight: 700
            }}
          >
            <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#6366f1", boxShadow: "0 0 6px #6366f1" }}></span>
            Front Cam · Biometrics
          </div>

          {/* Status Pill */}
          <div className={`scanner-status-pill ${status === "liveness_check" ? "liveness" : status === "spoof" ? "spoof" : status}`}>
            {status === "verified" && <><FaCheckCircle /> Verified Live</>}
            {status === "liveness_check" && <><FaEye className="fa-spin" /> Live Action Required</>}
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
        {isSpoof ? (
          <span className="liveness-shield-tag spoof-warn">
            <FaShieldAlt /> ⚠️ Anti-Spoof: Static Photo/Screen Blocked
          </span>
        ) : status === "mismatch" ? (
          <span className="liveness-shield-tag spoof-warn">
            <FaUserCheck /> ❌ Biometric Identity Mismatch
          </span>
        ) : livenessPassed ? (
          <span className="liveness-shield-tag live-pass">
            <FaShieldAlt /> ✅ Anti-Spoof Passed · Live Biometric Verified
          </span>
        ) : (
          <span className="liveness-shield-tag">
            <FaShieldAlt /> 🛡️ Anti-Spoof Active · Look at Camera
          </span>
        )}
      </div>

      {/* Active Anti-Spoofing Challenge HUD */}
      {status === "liveness_check" && activeChallenge && (
        <div className="active-challenge-hud">
          <div className="challenge-prompt-text">{activeChallenge.message}</div>
          <div className="challenge-progress-bar-bg">
            <div className="challenge-progress-bar-fill" style={{ width: `${Math.max(10, activeChallenge.progress)}%` }} />
          </div>
        </div>
      )}

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
              <FaCamera /> Register / Enroll Facial Biometrics Now
            </button>
          )}
        </div>
      )}

      {/* Identity Mismatch Alert Banner */}
      {status === "mismatch" && verifiedStudent && (
        <div className="unregistered-face-alert" style={{
          marginTop: "12px",
          marginBottom: "12px",
          borderColor: "#ef4444",
          background: "#fef2f2"
        }}>
          <h4 style={{ color: "#b91c1c" }}>
            <FaUserTimes style={{ color: "#ef4444", fontSize: "1.1rem" }} />
            Biometric Identity Mismatch Detected
          </h4>
          <p style={{ color: "#7f1d1d" }}>
            The face in front of the camera does <strong>NOT match</strong> the registered biometric profile for <strong>{verifiedStudent?.name || "Student"}</strong> (Roll No: <strong>{verifiedStudent?.rollNo || rollNo}</strong>).
          </p>
          <p style={{ marginTop: "6px", fontWeight: 700, color: "#b91c1c" }}>
            ⛔ Anti-Proxy Security: Only the registered student can mark their attendance. Proxy attendance is strictly prohibited and logged.
          </p>
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
            onClick={() => initCameraAndModels(facingMode || "user")}
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