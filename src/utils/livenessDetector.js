/**
 * Fast & Robust Biometric Anti-Spoofing & Liveness Detection Engine
 * 
 * Features:
 * - Passive, real-time live human feature tracking (EAR eye landmarks, natural micro-motion, 3D facial proportions)
 * - Anti-Spoofing defense against printed static photos and freeze-frame screen replays
 * - Instant, non-blocking face alignment detection for ultra-fast, smooth biometric capture
 */

export const BLINK_CLOSED_THRESHOLD = 0.21;
export const BLINK_OPEN_THRESHOLD = 0.25;
export const STATIC_VARIANCE_THRESHOLD = 0.00008;
export const YAW_CENTER_MIN = 0.72;
export const YAW_CENTER_MAX = 1.38;

/**
 * Computes Euclidean distance between two points
 */
export const getDist = (p1, p2) => {
    if (!p1 || !p2) return 0;
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
};

/**
 * Computes Eye Aspect Ratio (EAR) for a 6-landmark eye contour
 */
export const computeEAR = (eye) => {
    if (!eye || eye.length < 6) return 0.30;
    const v1 = getDist(eye[1], eye[5]);
    const v2 = getDist(eye[2], eye[4]);
    const h = getDist(eye[0], eye[3]);
    if (h < 1e-4) return 0.30;
    return (v1 + v2) / (2.0 * h);
};

/**
 * Computes 5 normalized 3D facial geometric ratios to track non-rigid parallax movement
 */
export const computeFacialRatios = (positions) => {
    if (!positions || positions.length < 68) return [0, 0, 0, 0, 0];
    const p36 = positions[36]; // Left eye outer corner
    const p45 = positions[45]; // Right eye outer corner
    const eyeSpan = getDist(p36, p45);
    if (eyeSpan < 1) return [0, 0, 0, 0, 0];

    const p30 = positions[30]; // Nose tip
    const p27 = positions[27]; // Nose bridge top
    const p48 = positions[48]; // Mouth left corner
    const p54 = positions[54]; // Mouth right corner
    const p8 = positions[8];   // Chin tip

    return [
        getDist(p30, p36) / eyeSpan,
        getDist(p30, p45) / eyeSpan,
        getDist(p48, p54) / eyeSpan,
        getDist(p30, p8) / eyeSpan,
        getDist(p27, p30) / eyeSpan
    ];
};

/**
 * Computes head pose from landmarks
 */
export const computeHeadPose = (positions) => {
    if (!positions || positions.length < 68) {
        return { yawRatio: 1.0, pitchRatio: 1.0, pose: "CENTER" };
    }

    const p30 = positions[30]; // Nose tip
    const p36 = positions[36]; // Left eye outer
    const p45 = positions[45]; // Right eye outer
    const p27 = positions[27]; // Nose bridge top
    const p8 = positions[8];   // Chin tip

    const leftDist = getDist(p30, p36) + 1e-5;
    const rightDist = getDist(p30, p45) + 1e-5;
    const yawRatio = leftDist / rightDist;

    const topDist = getDist(p27, p30) + 1e-5;
    const bottomDist = getDist(p30, p8) + 1e-5;
    const pitchRatio = topDist / bottomDist;

    let pose = "CENTER";
    if (yawRatio < 0.70) {
        pose = "LEFT";
    } else if (yawRatio > 1.40) {
        pose = "RIGHT";
    } else if (pitchRatio > 1.40) {
        pose = "UP";
    } else if (pitchRatio < 0.60) {
        pose = "DOWN";
    }

    return { yawRatio, pitchRatio, pose };
};

/**
 * Calculates multi-frame geometric variance
 */
export const computeMotionVariance = (history) => {
    if (!history || history.length < 6) return 0.001;
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

/**
 * Fast, Non-Blocking Real-Time Liveness & Quality Engine
 */
export class LivenessEngine {
    constructor(options = {}) {
        this.onStateChange = options.onStateChange || (() => {});
        this.reset();
    }

    reset() {
        this.eyeState = "open";
        this.blinkCount = 0;
        this.ratioHistory = [];
        this.staticFramesCount = 0;
        this.spoofDetected = false;
        this.livenessConfirmed = true;
        this.isAligned = false;
        this.alignedFrames = 0;
        this.faceScore = 0;
        this.message = "Position your face in the frame";
        this.statusType = "ready"; // "ready", "aligned", "capturing", "success", "warning", "error"
        this.notify();
    }

    notify() {
        this.onStateChange({
            isAligned: this.isAligned,
            alignedFrames: this.alignedFrames,
            blinkCount: this.blinkCount,
            livenessConfirmed: this.livenessConfirmed,
            spoofDetected: this.spoofDetected,
            faceScore: this.faceScore,
            message: this.message,
            statusType: this.statusType
        });
    }

    /**
     * Process live frame detection with landmarks
     */
    processFrame(detection) {
        if (!detection || !detection.landmarks) {
            this.isAligned = false;
            this.alignedFrames = 0;
            this.faceScore = 0;
            this.message = "Looking for face... Look directly into camera";
            this.statusType = "ready";
            this.notify();
            return false;
        }

        const landmarks = detection.landmarks;
        const positions = landmarks.positions;
        const score = detection.detection?.score || 0.9;
        this.faceScore = Math.round(score * 100);

        // 1. EAR Blink Tracking
        const leftEye = positions.slice(36, 42);
        const rightEye = positions.slice(42, 48);
        const leftEAR = computeEAR(leftEye);
        const rightEAR = computeEAR(rightEye);
        const avgEAR = (leftEAR + rightEAR) / 2.0;

        if (avgEAR < BLINK_CLOSED_THRESHOLD) {
            this.eyeState = "closed";
        } else if (avgEAR >= BLINK_OPEN_THRESHOLD) {
            if (this.eyeState === "closed") {
                this.blinkCount += 1;
            }
            this.eyeState = "open";
        }

        // 2. Head Pose & Facial Geometric Ratios
        const { yawRatio, pose } = computeHeadPose(positions);
        const currentRatios = computeFacialRatios(positions);
        this.ratioHistory.push(currentRatios);
        if (this.ratioHistory.length > 15) this.ratioHistory.shift();

        const variance = computeMotionVariance(this.ratioHistory);

        // 3. Static Spoof Detector (Detect completely still printed photo or replay)
        if (this.blinkCount === 0 && variance < STATIC_VARIANCE_THRESHOLD && this.ratioHistory.length >= 12) {
            this.staticFramesCount += 1;
            if (this.staticFramesCount >= 25) {
                this.spoofDetected = true;
                this.isAligned = false;
                this.message = "⚠️ Static photo detected. Please use a live human face.";
                this.statusType = "warning";
                this.notify();
                return false;
            }
        } else {
            this.staticFramesCount = Math.max(0, this.staticFramesCount - 1);
            this.spoofDetected = false;
        }

        // 4. Alignment & Quality Check
        const isFacingFront = yawRatio >= YAW_CENTER_MIN && yawRatio <= YAW_CENTER_MAX;

        if (isFacingFront && score >= 0.5) {
            this.alignedFrames += 1;
            this.isAligned = true;
            this.livenessConfirmed = true;
            this.message = "✨ Face Centered & Clear • Ready to Capture!";
            this.statusType = "aligned";
        } else {
            this.alignedFrames = 0;
            this.isAligned = false;
            if (!isFacingFront) {
                this.message = pose === "LEFT" ? "Turn head slightly right" : pose === "RIGHT" ? "Turn head slightly left" : "Look straight at the camera";
            } else {
                this.message = "Center your face in the camera";
            }
            this.statusType = "ready";
        }

        this.notify();
        return this.isAligned;
    }
}
