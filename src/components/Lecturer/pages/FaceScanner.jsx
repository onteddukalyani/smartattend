import { useEffect, useRef, useState } from "react";
import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";

function FaceScanner() {
    const videoRef = useRef(null);
    const [faceDetected, setFaceDetected] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        let stream;
        let detector;
        let animationId;

        const startCamera = async () => {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        facingMode: "user",
                    },
                    audio: false,
                });
                videoRef.current.srcObject = stream;

                const vision = await FilesetResolver.forVisionTasks(
                    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
                );
                detector = await FaceDetector.createFromOptions(vision, {
                    baseOptions: {
                        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
                        delegate: "GPU",
                    },
                    runningMode: "VIDEO",
                    minDetectionConfidence: 0.5,
                });
                detectFace();
            } catch (err) {
                console.log(err);
                setError("Unable to access Camera.");
            }
        };
        const detectFace = () => {
            if (!videoRef.current || !detector)
                return;
            if (videoRef.current.readyState >= 2) {
                const result = detector.detectForVideo(
                    videoRef.current, performance.now()
                );
                const detected = result.detections.length > 0;
                setFaceDetected(detected);
            }
            animationId = requestAnimationFrame(detectFace);
        };
        startCamera();
        return () => {
            cancelAnimationFrame(animationId);
            if (stream) {
                stream.getTracks().forEach((track) => track.stop());
            }
            if (detector) {
                detector.close();
            }
        };
    }, []);
    return (
        <div className="face-scanner" style={{ textAlign: "center" }}>
            <h2>Face Verification</h2>
            <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", maxWidth: "400px", borderRadius: "15px", }} />
            {error && <p>{error}</p>}
            <p>{faceDetected ? "Face detected" : "No face detected"}</p>
        </div>
    );
} export default FaceScanner;