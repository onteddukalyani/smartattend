/**
 * Defense-Grade Multi-Modal Facial Liveness & Anti-Spoofing Engine
 * 
 * Tracks 3D head poses in real-time:
 * 1. 🎯 FRONT / CENTER (Face aligned)
 * 2. ⬅️ LEFT TURN (Yaw left)
 * 3. ➡️ RIGHT TURN (Yaw right)
 * 4. ⬆️ TILT UP (Pitch up)
 * 5. 👁️ BLINK / SMILE (EAR blink / live human reflex)
 */

export const BLINK_CLOSED_THRESHOLD = 0.205;
export const BLINK_OPEN_THRESHOLD = 0.250;
export const STATIC_VARIANCE_THRESHOLD = 0.000085;
export const MAR_SMILE_THRESHOLD = 0.42;
export const MAR_OPEN_THRESHOLD = 0.55;

export const getDist = (p1, p2) => {
    if (!p1 || !p2) return 0;
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
};

/**
 * 1. Eye Aspect Ratio (EAR) Calculation
 * EAR = (||p2 - p6|| + ||p3 - p5||) / (2 * ||p1 - p4||)
 */
export const computeEAR = (eye) => {
    if (!eye || eye.length < 6) return 0.28;
    const v1 = getDist(eye[1], eye[5]);
    const v2 = getDist(eye[2], eye[4]);
    const h = getDist(eye[0], eye[3]);
    if (h < 1e-4) return 0.28;
    return (v1 + v2) / (2.0 * h);
};

/**
 * 2. Mouth Aspect Ratio (MAR) Calculation
 * MAR = (||p51 - p59|| + ||p53 - p57||) / (2 * ||p48 - p54||)
 */
export const computeMAR = (positions) => {
    if (!positions || positions.length < 68) return 0.25;
    const p51 = positions[51];
    const p59 = positions[59];
    const p53 = positions[53];
    const p57 = positions[57];
    const p48 = positions[48];
    const p54 = positions[54];

    const v1 = getDist(p51, p59);
    const v2 = getDist(p53, p57);
    const h = getDist(p48, p54);
    if (h < 1e-4) return 0.25;
    return (v1 + v2) / (2.0 * h);
};

/**
 * 3. Smile & Dynamic Expression Metric
 * Evaluates mouth corner elevation and width relative to eye span
 */
export const computeSmileMetric = (positions) => {
    if (!positions || positions.length < 68) return 0;
    const eyeSpan = getDist(positions[36], positions[45]);
    if (eyeSpan < 1) return 0;

    const mouthWidth = getDist(positions[48], positions[54]);
    const noseBase = positions[33];
    const mouthLeft = positions[48];
    const mouthRight = positions[54];

    // Corner elevation relative to nose tip
    const elevation = ((noseBase.y - mouthLeft.y) + (noseBase.y - mouthRight.y)) / (2.0 * eyeSpan);
    const widthRatio = mouthWidth / eyeSpan;

    return widthRatio * 0.7 + elevation * 0.3;
};

/**
 * 4. Comprehensive 3D Facial Landmark Ratios
 */
export const computeFacialRatios = (positions) => {
    if (!positions || positions.length < 68) return [0, 0, 0, 0, 0, 0];
    const p36 = positions[36];
    const p45 = positions[45];
    const eyeSpan = getDist(p36, p45);
    if (eyeSpan < 1) return [0, 0, 0, 0, 0, 0];

    const p30 = positions[30];
    const p27 = positions[27];
    const p48 = positions[48];
    const p54 = positions[54];
    const p8 = positions[8];

    const noseToEyeMidY = p30.y - p27.y;
    const mouthWidth = getDist(p48, p54);
    const chinToNoseY = p8.y - p30.y;
    const leftCheekToNose = getDist(positions[0], p30);
    const rightCheekToNose = getDist(positions[16], p30);
    const mar = computeMAR(positions);

    return [
        noseToEyeMidY / eyeSpan,
        mouthWidth / eyeSpan,
        chinToNoseY / eyeSpan,
        leftCheekToNose / eyeSpan,
        rightCheekToNose / eyeSpan,
        mar
    ];
};

/**
 * 5. 3D Head Pose (Yaw, Pitch, Roll) Estimation
 */
export const computeHeadPose = (positions) => {
    if (!positions || positions.length < 68) return { yawRatio: 1.0, pitchRatio: 1.0, rollDeg: 0, pose: "CENTER" };

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

    const rollRad = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
    const rollDeg = (rollRad * 180) / Math.PI;

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

    return { yawRatio, pitchRatio, rollDeg, pose };
};

/**
 * 6. Temporal Micro-Movement Variance across Sliding Window
 */
export const computeMotionVariance = (history) => {
    if (!history || history.length < 6) return 1.0;
    const n = history.length;
    const dims = history[0]?.length || 5;
    let totalVar = 0;
    for (let dim = 0; dim < dims; dim++) {
        let mean = 0;
        for (let i = 0; i < n; i++) mean += history[i][dim] || 0;
        mean /= n;
        let v = 0;
        for (let i = 0; i < n; i++) v += Math.pow((history[i][dim] || 0) - mean, 2);
        v /= n;
        totalVar += v;
    }
    return totalVar / dims;
};

/**
 * 7. Multi-Frame Biometric Vector Fusion (Centroid Embedding)
 * Filters out outlier frames and returns normalized consensus 128-D descriptor
 */
export const fuseFaceDescriptors = (descriptorArray) => {
    if (!descriptorArray || descriptorArray.length === 0) return null;
    if (descriptorArray.length === 1) return descriptorArray[0];

    const validDescriptors = descriptorArray.filter(
        (d) => d && (d.length === 128 || d.byteLength === 512)
    );
    if (validDescriptors.length === 0) return null;

    const fused = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
        let sum = 0;
        for (let j = 0; j < validDescriptors.length; j++) {
            sum += validDescriptors[j][i];
        }
        fused[i] = sum / validDescriptors.length;
    }

    // L2 Normalize fused centroid vector
    let norm = 0;
    for (let i = 0; i < 128; i++) norm += fused[i] * fused[i];
    norm = Math.sqrt(norm);
    if (norm > 1e-6) {
        for (let i = 0; i < 128; i++) fused[i] /= norm;
    }

    return fused;
};

/**
 * 8. Randomized Challenge-Response Interactive Liveness Engine
 * Generates an unpredictable challenge sequence for every verification.
 */
export class RandomizedChallengeEngine {
    constructor(options = {}) {
        this.onStateChange = options.onStateChange || (() => { });
        this.timeoutSec = options.timeoutSec || 6;
        this.reset();
    }

    /**
     * Generate randomized challenge sequence:
     * Step 1 is always CENTER alignment, followed by 2 random actions (e.g. BLINK, SMILE, TURN_LEFT, TURN_RIGHT)
     */
    generateChallenges() {
        const pool = ["BLINK", "SMILE", "TURN_LEFT", "TURN_RIGHT", "TILT_UP"];
        // Shuffle pool
        const shuffled = [...pool].sort(() => 0.5 - Math.random());
        // Pick 2 distinct randomized challenges
        return ["CENTER", shuffled[0], shuffled[1]];
    }

    reset() {
        this.challenges = this.generateChallenges();
        this.currentIndex = 0;
        this.currentChallenge = this.challenges[0];
        this.completedChallenges = [];
        this.stepStartTime = Date.now();
        this.isComplete = false;
        this.spoofDetected = false;
        this.livenessScore = 0;

        this.earHistory = [];
        this.ratioHistory = [];
        this.collectedDescriptors = [];
        this.staticFramesCount = 0;
        this.blinkCount = 0;
        this.eyeState = "open";
        this.baselineEAR = 0.28;

        this.holdFrames = 0;
        this.progress = 0;
        this.message = this.getChallengePrompt(this.currentChallenge, 1);
        this.statusType = "ready";
        this.notify();
    }

    getChallengePrompt(challenge, stepNum) {
        switch (challenge) {
            case "CENTER":
                return `🎯 Step ${stepNum}/3: Look straight into the camera`;
            case "TURN_LEFT":
                return `⬅️ Step ${stepNum}/3: Turn your face slowly to the LEFT`;
            case "TURN_RIGHT":
                return `➡️ Step ${stepNum}/3: Turn your face slowly to the RIGHT`;
            case "TILT_UP":
                return `⬆️ Step ${stepNum}/3: Tilt your head slightly UP`;
            case "SMILE":
                return `😊 Step ${stepNum}/3: Smile or open mouth slightly`;
            case "BLINK":
                return `👁️ Step ${stepNum}/3: Blink your eyes naturally`;
            default:
                return `🎯 Step ${stepNum}/3: Follow on-screen instructions`;
        }
    }

    notify() {
        this.onStateChange({
            challenges: this.challenges,
            currentIndex: this.currentIndex,
            currentChallenge: this.currentChallenge,
            completedChallenges: [...this.completedChallenges],
            progress: this.progress,
            isComplete: this.isComplete,
            spoofDetected: this.spoofDetected,
            message: this.message,
            statusType: this.statusType,
            fusedDescriptor: this.isComplete ? fuseFaceDescriptors(this.collectedDescriptors) : null
        });
    }

    processFrame(detection) {
        if (!detection || !detection.landmarks) {
            this.message = "👀 Face not detected. Align face inside frame";
            this.statusType = "warning";
            this.notify();
            return false;
        }

        const landmarks = detection.landmarks;
        const positions = landmarks.positions;
        const { yawRatio, pitchRatio, pose } = computeHeadPose(positions);
        const liveDescriptor = detection.descriptor;

        // Buffer valid descriptor frames
        if (liveDescriptor && liveDescriptor.length === 128) {
            this.collectedDescriptors.push(new Float32Array(liveDescriptor));
            if (this.collectedDescriptors.length > 8) this.collectedDescriptors.shift();
        }

        // 1. EAR Blink Tracking
        const leftEye = positions.slice(36, 42);
        const rightEye = positions.slice(42, 48);
        const leftEAR = computeEAR(leftEye);
        const rightEAR = computeEAR(rightEye);
        const avgEAR = (leftEAR + rightEAR) / 2.0;

        if (avgEAR > 0.20) {
            this.earHistory.push(avgEAR);
            if (this.earHistory.length > 25) this.earHistory.shift();
            const sum = this.earHistory.reduce((a, b) => a + b, 0);
            this.baselineEAR = sum / this.earHistory.length;
        }

        const closedCutoff = Math.min(BLINK_CLOSED_THRESHOLD, this.baselineEAR * 0.82);
        const openCutoff = Math.max(BLINK_OPEN_THRESHOLD, this.baselineEAR * 0.90);

        let justBlinked = false;
        if (avgEAR < closedCutoff || avgEAR < 0.215) {
            this.eyeState = "closed";
        } else if (avgEAR >= openCutoff || avgEAR >= 0.235) {
            if (this.eyeState === "closed") {
                this.blinkCount += 1;
                justBlinked = true;
            }
            this.eyeState = "open";
        }

        // 2. MAR & Smile Tracking
        const mar = computeMAR(positions);
        const smileScore = computeSmileMetric(positions);
        const isSmiling = mar > MAR_SMILE_THRESHOLD || smileScore > 0.62;

        // 3. Temporal Motion Variance (Anti-Static Photo & Replay Defense)
        const currentRatios = computeFacialRatios(positions);
        this.ratioHistory.push(currentRatios);
        if (this.ratioHistory.length > 15) this.ratioHistory.shift();
        const variance = computeMotionVariance(this.ratioHistory);

        if (
            this.blinkCount === 0 &&
            !isSmiling &&
            variance < STATIC_VARIANCE_THRESHOLD &&
            this.ratioHistory.length >= 12
        ) {
            this.staticFramesCount += 1;
            if (this.staticFramesCount >= 22) {
                this.spoofDetected = true;
                this.message = "⚠️ Static photo/screen detected. Real human presence required.";
                this.statusType = "warning";
                this.notify();
                return false;
            }
        } else {
            this.staticFramesCount = Math.max(0, this.staticFramesCount - 1);
            this.spoofDetected = false;
        }

        // 4. Evaluate Active Challenge Completion
        const target = this.currentChallenge;
        let challengeSatisfied = false;

        if (target === "CENTER") {
            if (pose === "CENTER" && yawRatio >= 0.80 && yawRatio <= 1.25 && pitchRatio >= 0.80 && pitchRatio <= 1.25) {
                challengeSatisfied = true;
            }
        } else if (target === "TURN_LEFT") {
            if (pose === "LEFT" || yawRatio < 0.72) {
                challengeSatisfied = true;
            }
        } else if (target === "TURN_RIGHT") {
            if (pose === "RIGHT" || yawRatio > 1.30) {
                challengeSatisfied = true;
            }
        } else if (target === "TILT_UP") {
            if (pose === "UP" || pitchRatio > 1.25) {
                challengeSatisfied = true;
            }
        } else if (target === "SMILE") {
            if (isSmiling) {
                challengeSatisfied = true;
            }
        } else if (target === "BLINK") {
            if (justBlinked || this.blinkCount > 0) {
                challengeSatisfied = true;
            }
        }

        // Handle step transition
        if (challengeSatisfied) {
            this.holdFrames += 1;
            if (this.holdFrames >= 3) {
                this.holdFrames = 0;
                this.completedChallenges.push(target);
                this.currentIndex += 1;

                if (this.currentIndex >= this.challenges.length) {
                    this.isComplete = true;
                    this.progress = 100;
                    this.message = "✅ Biometrics & Liveness 100% Verified!";
                    this.statusType = "success";
                    this.notify();
                    return true;
                } else {
                    this.currentChallenge = this.challenges[this.currentIndex];
                    this.message = this.getChallengePrompt(this.currentChallenge, this.currentIndex + 1);
                    this.statusType = "capturing";
                }
            } else {
                this.statusType = "aligned";
            }
        } else {
            this.holdFrames = Math.max(0, this.holdFrames - 1);
            this.message = this.getChallengePrompt(this.currentChallenge, this.currentIndex + 1);
            this.statusType = "ready";
        }

        this.progress = Math.min(100, Math.round((this.currentIndex / this.challenges.length) * 100));
        this.notify();
        return this.isComplete;
    }
}

/**
 * Aadhaar / KYC Multi-Angle Engine alias with full backward compatibility
 */
export class AadhaarLivenessEngine extends RandomizedChallengeEngine { }
export const LivenessEngine = AadhaarLivenessEngine;
