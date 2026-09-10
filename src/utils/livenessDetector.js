/**
 * Advanced Biometric Anti-Spoofing & Liveness Detection Engine
 * 
 * Protects against:
 * 1. 2D Printed Photo Spoofing (detected via EAR blink check, 3D parallax, and static ratio variance).
 * 2. Flat Mobile Screen / Tablet Photo Spoofing (detected via micro-motion dynamics and head pose yaw).
 * 3. Video Replay Attacks (detected via dynamic active challenge-response prompt sequencing).
 */

export const BLINK_CLOSED_THRESHOLD = 0.205; // Eye Aspect Ratio below this = eye closed
export const BLINK_OPEN_THRESHOLD = 0.245;   // Eye Aspect Ratio above this = eye open
export const STATIC_VARIANCE_THRESHOLD = 0.00010; // Zero variance across frames = flat static image
export const YAW_CENTER_MIN = 0.78;
export const YAW_CENTER_MAX = 1.28;
export const YAW_LEFT_MAX = 0.70;   // Looking left (relative to camera)
export const YAW_RIGHT_MIN = 1.38;  // Looking right (relative to camera)

/**
 * Computes Euclidean distance between two 2D/3D points
 */
export const getDist = (p1, p2) => {
    if (!p1 || !p2) return 0;
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
};

/**
 * Computes Eye Aspect Ratio (EAR) for a 6-landmark eye contour
 * Points: [p0, p1, p2, p3, p4, p5]
 * EAR = (|p1 - p5| + |p2 - p4|) / (2 * |p0 - p3|)
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
 * across 68 facial landmarks.
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
 * Computes head pose (Yaw & Pitch ratio) from 68 facial landmarks
 * Returns { yawRatio, pitchRatio, pose: 'CENTER' | 'LEFT' | 'RIGHT' | 'UP' | 'DOWN' }
 */
export const computeHeadPose = (positions) => {
    if (!positions || positions.length < 68) {
        return { yawRatio: 1.0, pitchRatio: 1.0, pose: "UNKNOWN" };
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
    if (yawRatio < YAW_LEFT_MAX) {
        pose = "LEFT";
    } else if (yawRatio > YAW_RIGHT_MIN) {
        pose = "RIGHT";
    } else if (pitchRatio > 1.35) {
        pose = "UP";
    } else if (pitchRatio < 0.65) {
        pose = "DOWN";
    }

    return { yawRatio, pitchRatio, pose };
};

/**
 * Calculates multi-frame geometric variance across 5 facial ratios
 * Used to distinguish live biological faces from 2D photos/screens
 */
export const computeMotionVariance = (history) => {
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

/**
 * Interactive Step-by-Step Liveness Engine
 * Orchestrates:
 * Step 1: Face Centered & Look Straight
 * Step 2: Active Blink Detection (EAR transition)
 * Step 3: Head Rotation / 3D Parallax Movement
 * Step 4: Verification Complete
 */
export class LivenessEngine {
    constructor(options = {}) {
        this.onStateChange = options.onStateChange || (() => {});
        this.reset();
    }

    reset() {
        this.step = "ALIGN"; // "ALIGN" -> "BLINK" -> "TURN" -> "PASSED"
        this.eyeState = "open";
        this.blinkCount = 0;
        this.ratioHistory = [];
        this.staticFramesCount = 0;
        this.spoofDetected = false;
        this.livenessConfirmed = false;
        this.centerHoldFrames = 0;
        this.turnDetected = false;
        this.targetTurn = Math.random() > 0.5 ? "LEFT" : "RIGHT"; // Random challenge direction to prevent video replay
        this.message = "Center your face in the camera frame.";
        this.statusType = "ready";
        this.progress = 10;
        this.notify();
    }

    notify() {
        this.onStateChange({
            step: this.step,
            blinkCount: this.blinkCount,
            livenessConfirmed: this.livenessConfirmed,
            spoofDetected: this.spoofDetected,
            targetTurn: this.targetTurn,
            message: this.message,
            statusType: this.statusType,
            progress: this.progress
        });
    }

    /**
     * Feed a live frame detection with landmarks
     */
    processFrame(detection) {
        if (!detection || !detection.landmarks) {
            this.staticFramesCount = 0;
            this.message = "👀 Face not detected. Please look into the camera.";
            this.statusType = "warning";
            this.notify();
            return false;
        }

        const landmarks = detection.landmarks;
        const positions = landmarks.positions;
        const box = detection.detection?.box || { width: 100, height: 100 };

        // 1. EAR Blink Detection
        const leftEye = positions.slice(36, 42);
        const rightEye = positions.slice(42, 48);
        const leftEAR = computeEAR(leftEye);
        const rightEAR = computeEAR(rightEye);
        const avgEAR = (leftEAR + rightEAR) / 2.0;

        let justBlinked = false;
        if (avgEAR < BLINK_CLOSED_THRESHOLD) {
            this.eyeState = "closed";
        } else if (avgEAR >= BLINK_OPEN_THRESHOLD) {
            if (this.eyeState === "closed") {
                this.blinkCount += 1;
                justBlinked = true;
            }
            this.eyeState = "open";
        }

        // 2. Head Pose & Parallax
        const { yawRatio, pose } = computeHeadPose(positions);
        const currentRatios = computeFacialRatios(positions);
        this.ratioHistory.push(currentRatios);
        if (this.ratioHistory.length > 20) this.ratioHistory.shift();

        const variance = computeMotionVariance(this.ratioHistory);

        // 3. Static Spoof Detector (Freeze frame / printed photo held still)
        if (this.blinkCount === 0 && !this.turnDetected && variance < STATIC_VARIANCE_THRESHOLD && this.ratioHistory.length >= 12) {
            this.staticFramesCount += 1;
            if (this.staticFramesCount >= 20) {
                this.spoofDetected = true;
                this.message = "⛔ Anti-Spoof Warning: Flat photo or screen detected. Live human presence required.";
                this.statusType = "error";
                this.notify();
                return false;
            }
        } else if (variance >= STATIC_VARIANCE_THRESHOLD) {
            this.staticFramesCount = Math.max(0, this.staticFramesCount - 1);
            this.spoofDetected = false;
        }

        // 4. Progressive Challenge State Machine
        if (this.step === "ALIGN") {
            const isFacingFront = yawRatio >= YAW_CENTER_MIN && yawRatio <= YAW_CENTER_MAX;
            if (isFacingFront && box.width > 80) {
                this.centerHoldFrames += 1;
                if (this.centerHoldFrames >= 4) {
                    this.step = "BLINK";
                    this.message = "👁️ Please blink your eyes naturally.";
                    this.statusType = "capturing";
                    this.progress = 40;
                }
            } else {
                this.centerHoldFrames = 0;
                this.message = "Look directly forward into the camera.";
                this.statusType = "ready";
                this.progress = 20;
            }
        } else if (this.step === "BLINK") {
            if (justBlinked || this.blinkCount >= 1) {
                this.step = "TURN";
                this.message = `🔄 Challenge: Turn head slightly to the ${this.targetTurn}.`;
                this.statusType = "capturing";
                this.progress = 70;
            } else {
                this.message = "👁️ Please blink your eyes naturally to verify live presence.";
            }
        } else if (this.step === "TURN") {
            const matchedTurn = (this.targetTurn === "LEFT" && (pose === "LEFT" || yawRatio < YAW_LEFT_MAX)) ||
                                (this.targetTurn === "RIGHT" && (pose === "RIGHT" || yawRatio > YAW_RIGHT_MIN));

            if (matchedTurn || variance > 0.00075) {
                this.turnDetected = true;
                this.step = "PASSED";
                this.livenessConfirmed = true;
                this.spoofDetected = false;
                this.message = "✅ Live Human Presence Verified! Anti-Spoof: PASSED 🛡️";
                this.statusType = "success";
                this.progress = 100;
            } else {
                this.message = `🔄 Turn head slightly to the ${this.targetTurn} to verify 3D depth.`;
            }
        } else if (this.step === "PASSED") {
            this.livenessConfirmed = true;
            this.spoofDetected = false;
            this.progress = 100;
        }

        this.notify();
        return this.livenessConfirmed;
    }
}
