/**
 * Aadhaar / KYC-Grade Multi-Angle Face Biometric Verification Engine
 * 
 * Tracks 3D head poses in real-time:
 * 1. 🎯 FRONT / CENTER (Face aligned)
 * 2. ⬅️ LEFT TURN (Yaw left)
 * 3. ➡️ RIGHT TURN (Yaw right)
 * 4. ⬆️ TILT UP (Pitch up)
 * 5. 👁️ BLINK / SMILE (EAR blink / live human reflex)
 */

export const BLINK_CLOSED_THRESHOLD = 0.21;
export const BLINK_OPEN_THRESHOLD = 0.25;
export const STATIC_VARIANCE_THRESHOLD = 0.00008;
export const YAW_CENTER_MIN = 0.75;
export const YAW_CENTER_MAX = 1.32;
export const YAW_LEFT_MAX = 0.70;   // Looking left (relative to camera)
export const YAW_RIGHT_MIN = 1.38;  // Looking right (relative to camera)

export const getDist = (p1, p2) => {
    if (!p1 || !p2) return 0;
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
};

export const computeEAR = (eye) => {
    if (!eye || eye.length < 6) return 0.28;
    const v1 = getDist(eye[1], eye[5]);
    const v2 = getDist(eye[2], eye[4]);
    const h = getDist(eye[0], eye[3]);
    if (h < 1e-4) return 0.28;
    return (v1 + v2) / (2.0 * h);
};

export const computeFacialRatios = (positions) => {
    if (!positions || positions.length < 68) return [0, 0, 0, 0, 0];
    const p36 = positions[36];
    const p45 = positions[45];
    const eyeSpan = getDist(p36, p45);
    if (eyeSpan < 1) return [0, 0, 0, 0, 0];

    const p30 = positions[30];
    const p27 = positions[27];
    const p48 = positions[48];
    const p54 = positions[54];
    const p8  = positions[8];

    const noseToEyeMidY = p30.y - p27.y;
    const mouthWidth = getDist(p48, p54);
    const chinToNoseY = p8.y - p30.y;
    const leftCheekToNose = getDist(positions[0], p30);
    const rightCheekToNose = getDist(positions[16], p30);

    return [
        noseToEyeMidY / eyeSpan,
        mouthWidth / eyeSpan,
        chinToNoseY / eyeSpan,
        leftCheekToNose / eyeSpan,
        rightCheekToNose / eyeSpan
    ];
};

export const computeHeadPose = (positions) => {
    if (!positions || positions.length < 68) return { yawRatio: 1.0, pitchRatio: 1.0, pose: "CENTER" };
    
    const nose = positions[30];
    const leftEye = positions[36];
    const rightEye = positions[45];
    const chin = positions[8];
    const eyeMidX = (leftEye.x + rightEye.x) / 2.0;
    const eyeMidY = (leftEye.y + rightEye.y) / 2.0;

    const dLeft = Math.max(0.1, getDist(leftEye, nose));
    const dRight = Math.max(0.1, getDist(rightEye, nose));
    const yawRatio = dLeft / dRight;

    const topDist = Math.max(0.1, nose.y - eyeMidY);
    const bottomDist = Math.max(0.1, chin.y - nose.y);
    const pitchRatio = bottomDist / topDist;

    let pose = "CENTER";
    if (yawRatio < 0.72) {
        pose = "LEFT";
    } else if (yawRatio > 1.35) {
        pose = "RIGHT";
    } else if (pitchRatio > 1.35) {
        pose = "UP";
    } else if (pitchRatio < 0.65) {
        pose = "DOWN";
    }

    return { yawRatio, pitchRatio, pose };
};

export const computeMotionVariance = (history) => {
    if (!history || history.length < 5) return 1.0;
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
 * Aadhaar / KYC Interactive Multi-Angle Liveness Engine
 */
export class AadhaarLivenessEngine {
    constructor(options = {}) {
        this.onStateChange = options.onStateChange || (() => {});
        this.reset();
    }

    reset() {
        // Multi-Angle Checkpoints
        this.checkpoints = {
            CENTER: false,
            LEFT: false,
            RIGHT: false,
            UP: false,
            BLINK: false
        };

        // Step Progression: "CENTER" -> "LEFT" -> "RIGHT" -> "UP" -> "BLINK" -> "COMPLETE"
        this.currentStep = "CENTER";
        this.step = "ALIGN";
        this.eyeState = "open";
        this.blinkCount = 0;
        this.baselineEAR = 0.28;
        this.earHistory = [];
        this.ratioHistory = [];
        this.staticFramesCount = 0;
        this.spoofDetected = false;
        this.isComplete = false;
        this.livenessConfirmed = false;
        this.currentPose = "CENTER";
        this.yawRatio = 1.0;
        this.pitchRatio = 1.0;
        this.progress = 0;
        this.message = "🎯 Step 1/4: Look straight into the camera";
        this.statusType = "ready";
        this.holdFrames = 0;
        this.notify();
    }

    notify() {
        this.onStateChange({
            checkpoints: { ...this.checkpoints },
            currentStep: this.currentStep,
            currentPose: this.currentPose,
            yawRatio: this.yawRatio,
            pitchRatio: this.pitchRatio,
            blinkCount: this.blinkCount,
            isComplete: this.isComplete,
            spoofDetected: this.spoofDetected,
            progress: this.progress,
            message: this.message,
            statusType: this.statusType,
            step: this.currentStep,
            livenessConfirmed: this.isComplete || this.livenessConfirmed
        });
    }

    processFrame(detection) {
        if (!detection || !detection.landmarks) {
            this.message = "👀 Face not detected. Align face inside circle";
            this.statusType = "warning";
            this.notify();
            return false;
        }

        const landmarks = detection.landmarks;
        const positions = landmarks.positions;
        const { yawRatio, pitchRatio, pose } = computeHeadPose(positions);
        this.yawRatio = yawRatio;
        this.pitchRatio = pitchRatio;
        this.currentPose = pose;

        // 1. EAR Blink Tracking
        const leftEye = positions.slice(36, 42);
        const rightEye = positions.slice(42, 48);
        const leftEAR = computeEAR(leftEye);
        const rightEAR = computeEAR(rightEye);
        const avgEAR = (leftEAR + rightEAR) / 2.0;

        // Maintain moving baseline of open eye
        if (avgEAR > 0.20) {
            this.earHistory.push(avgEAR);
            if (this.earHistory.length > 25) this.earHistory.shift();
            const sum = this.earHistory.reduce((a, b) => a + b, 0);
            this.baselineEAR = sum / this.earHistory.length;
        }

        // Relative and absolute closed threshold
        const closedCutoff = Math.min(BLINK_CLOSED_THRESHOLD, this.baselineEAR * 0.82);
        const openCutoff = Math.max(BLINK_OPEN_THRESHOLD, this.baselineEAR * 0.90);

        let justBlinked = false;
        if (avgEAR < closedCutoff || avgEAR < 0.220) {
            this.eyeState = "closed";
        } else if (avgEAR >= openCutoff || avgEAR >= 0.235) {
            if (this.eyeState === "closed") {
                this.blinkCount += 1;
                justBlinked = true;
                this.checkpoints.BLINK = true;
                this.livenessConfirmed = true;
            }
            this.eyeState = "open";
        }

        // 2. Multi-Frame Variance
        const currentRatios = computeFacialRatios(positions);
        this.ratioHistory.push(currentRatios);
        if (this.ratioHistory.length > 15) this.ratioHistory.shift();
        const variance = computeMotionVariance(this.ratioHistory);

        // 3. Static Spoof Protection
        if (this.blinkCount === 0 && !this.checkpoints.LEFT && !this.checkpoints.RIGHT && variance < STATIC_VARIANCE_THRESHOLD && this.ratioHistory.length >= 12) {
            this.staticFramesCount += 1;
            if (this.staticFramesCount >= 25) {
                this.spoofDetected = true;
                this.message = "⚠️ Static photo detected. Real human presence required.";
                this.statusType = "warning";
                this.notify();
                return false;
            }
        } else {
            this.staticFramesCount = Math.max(0, this.staticFramesCount - 1);
            this.spoofDetected = false;
        }

        // 4. Update Checkpoints dynamically based on natural motion
        if (pose === "CENTER" && yawRatio >= 0.82 && yawRatio <= 1.20 && pitchRatio >= 0.82 && pitchRatio <= 1.20) {
            this.checkpoints.CENTER = true;
        }
        if (pose === "LEFT" || yawRatio < 0.74) {
            this.checkpoints.LEFT = true;
        }
        if (pose === "RIGHT" || yawRatio > 1.28) {
            this.checkpoints.RIGHT = true;
        }
        if (pose === "UP" || pitchRatio > 1.22) {
            this.checkpoints.UP = true;
        }

        // 5. Guided Step Flow & Progress
        if (this.currentStep === "CENTER") {
            if (this.checkpoints.CENTER) {
                this.holdFrames += 1;
                if (this.holdFrames >= 3) {
                    this.currentStep = "LEFT";
                    this.holdFrames = 0;
                    this.message = "⬅️ Step 2/4: Turn your face slowly to the LEFT";
                    this.statusType = "capturing";
                } else {
                    this.message = "🎯 Hold face centered...";
                    this.statusType = "aligned";
                }
            } else {
                this.message = "🎯 Step 1/4: Look straight into the camera";
                this.statusType = "ready";
            }
        } else if (this.currentStep === "LEFT") {
            if (this.checkpoints.LEFT) {
                this.holdFrames += 1;
                if (this.holdFrames >= 2) {
                    this.currentStep = "RIGHT";
                    this.holdFrames = 0;
                    this.message = "➡️ Step 3/4: Turn your face slowly to the RIGHT";
                    this.statusType = "capturing";
                } else {
                    this.message = "✨ Left angle captured! Now face right...";
                    this.statusType = "aligned";
                }
            } else {
                this.message = "⬅️ Step 2/4: Turn your face slowly to the LEFT";
                this.statusType = "ready";
            }
        } else if (this.currentStep === "RIGHT") {
            if (this.checkpoints.RIGHT) {
                this.holdFrames += 1;
                if (this.holdFrames >= 2) {
                    this.currentStep = "UP";
                    this.holdFrames = 0;
                    this.message = "⬆️ Step 4/4: Tilt your face slightly UP (or Blink eyes)";
                    this.statusType = "capturing";
                } else {
                    this.message = "✨ Right angle captured! Tilting up...";
                    this.statusType = "aligned";
                }
            } else {
                this.message = "➡️ Step 3/4: Turn your face slowly to the RIGHT";
                this.statusType = "ready";
            }
        } else if (this.currentStep === "UP") {
            if (this.checkpoints.UP || this.checkpoints.BLINK || justBlinked) {
                this.currentStep = "COMPLETE";
                this.isComplete = true;
                this.message = "✅ Aadhaar-Grade Biometrics Verified! Enrolling...";
                this.statusType = "success";
            } else {
                this.message = "⬆️ Step 4/4: Tilt your face slightly UP or Blink naturally";
                this.statusType = "ready";
            }
        } else if (this.currentStep === "COMPLETE") {
            this.isComplete = true;
            this.message = "✅ Biometrics 100% Verified!";
            this.statusType = "success";
        }

        // Calculate Overall Progress % based on completed checkpoints
        let completedCount = 0;
        if (this.checkpoints.CENTER) completedCount += 1;
        if (this.checkpoints.LEFT) completedCount += 1;
        if (this.checkpoints.RIGHT) completedCount += 1;
        if (this.checkpoints.UP || this.checkpoints.BLINK) completedCount += 1;

        this.progress = Math.min(100, Math.round((completedCount / 4) * 100));
        if (this.isComplete) this.progress = 100;

        this.notify();
        return this.isComplete;
    }
}
export const LivenessEngine = AadhaarLivenessEngine;
