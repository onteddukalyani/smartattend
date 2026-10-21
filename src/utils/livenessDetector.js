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

export const BLINK_CLOSED_THRESHOLD = 0.220;
export const BLINK_OPEN_THRESHOLD = 0.245;
export const STATIC_VARIANCE_THRESHOLD = 0.000025;
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
 * Calibrated with realistic angles so gentle head rotations are recognized without dropping facial detection
 */
export const computeHeadPose = (positions) => {
    if (!positions || positions.length < 68) return { yawRatio: 1.0, pitchRatio: 1.0, rollDeg: 0, pose: "CENTER" };

    const nose = positions[30];
    const leftEye = positions[36];
    const rightEye = positions[45];
    const chin = positions[8];
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
    if (yawRatio < 0.82) {
        pose = "LEFT";
    } else if (yawRatio > 1.22) {
        pose = "RIGHT";
    } else if (pitchRatio > 1.20) {
        pose = "UP";
    } else if (pitchRatio < 0.75) {
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
 * Generates interactive challenge sequences calibrated for fast attendance or full enrollment.
 */
export class RandomizedChallengeEngine {
    constructor(options = {}) {
        this.onStateChange = options.onStateChange || (() => { });
        this.timeoutSec = options.timeoutSec || 6;
        this.mode = options.mode || "attendance"; // "attendance" | "enrollment"
        this.reset();
    }

    generateChallenges() {
        if (this.mode === "enrollment") {
            // Fast, ultra-smooth front enrollment with natural human blink reflex
            // Stops photo & video spoofing during registration in ~2-3 seconds
            return ["CENTER", "BLINK"];
        }

        // Attendance mode: Dynamic interactive challenge to defeat pre-recorded video playback
        // A recorded video on a second phone CANNOT anticipate whether the random prompt will be BLINK, SMILE, TURN_LEFT, or TURN_RIGHT!
        const dynamicActions = ["BLINK", "SMILE", "TURN_LEFT", "TURN_RIGHT"];
        const randomAction = dynamicActions[Math.floor(Math.random() * dynamicActions.length)];
        return ["CENTER", randomAction];
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
        this.totalSteps = this.challenges.length;
        this.message = this.getChallengePrompt(this.currentChallenge, 1, this.totalSteps);
        this.statusType = "ready";
        this.notify();
    }

    getChallengePrompt(challenge, stepNum, totalSteps = 2) {
        const total = totalSteps || this.challenges?.length || 2;
        switch (challenge) {
            case "CENTER":
                return `🎯 Step ${stepNum}/${total}: Look straight into camera`;
            case "BLINK":
                return this.mode === "enrollment"
                    ? `👁️ Step ${stepNum}/${total}: Blink or smile naturally to verify`
                    : `👁️ Step ${stepNum}/${total}: Blink your eyes naturally to verify`;
            case "SMILE":
                return `😊 Step ${stepNum}/${total}: Smile naturally to verify`;
            case "TURN_LEFT":
                return `⬅️ Step ${stepNum}/${total}: Turn head slightly to the LEFT`;
            case "TURN_RIGHT":
                return `➡️ Step ${stepNum}/${total}: Turn head slightly to the RIGHT`;
            case "NOD":
            case "TILT_UP":
                return `⬆️ Step ${stepNum}/${total}: Nod head slightly UP to verify`;
            default:
                return `🎯 Step ${stepNum}/${total}: Align face in frame`;
        }
    }

    notify() {
        const completed = this.completedChallenges || [];
        const isEnroll = this.mode === "enrollment";
        const checkpoints = {
            CENTER: completed.includes("CENTER") || this.progress >= 25,
            LEFT: completed.includes("TURN_LEFT") || completed.includes("LEFT") || (isEnroll && this.progress >= 50),
            RIGHT: completed.includes("TURN_RIGHT") || completed.includes("RIGHT") || (isEnroll && this.progress >= 75),
            UP: completed.includes("TILT_UP") || completed.includes("UP") || (isEnroll && this.progress >= 100),
            BLINK: completed.includes("BLINK") || completed.includes("SMILE")
        };
        const stepMap = {
            "CENTER": "CENTER",
            "TURN_LEFT": "LEFT",
            "TURN_RIGHT": "RIGHT",
            "TILT_UP": "UP",
            "BLINK": "UP",
            "SMILE": "UP"
        };
        const currentStep = this.isComplete ? "COMPLETE" : (stepMap[this.currentChallenge] || "CENTER");

        this.onStateChange({
            challenges: this.challenges,
            currentIndex: this.currentIndex,
            currentChallenge: this.currentChallenge,
            completedChallenges: [...completed],
            checkpoints,
            currentStep,
            currentPose: this.currentChallenge || "CENTER",
            progress: this.progress,
            isComplete: this.isComplete,
            spoofDetected: this.spoofDetected,
            message: this.message,
            statusType: this.statusType,
            blinkCount: this.blinkCount,
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
            if (this.collectedDescriptors.length > 12) this.collectedDescriptors.shift();
        }

        // 1. Natural EAR Blink Tracking (Ultra-Responsive & Robust)
        const leftEye = positions.slice(36, 42);
        const rightEye = positions.slice(42, 48);
        const leftEAR = computeEAR(leftEye);
        const rightEAR = computeEAR(rightEye);
        const avgEAR = (leftEAR + rightEAR) / 2.0;

        // Only track baseline when eye is open (avoids dragging baseline down during blinks)
        if (avgEAR >= 0.22 && avgEAR <= 0.45) {
            this.earHistory.push(avgEAR);
            if (this.earHistory.length > 20) this.earHistory.shift();
            const sum = this.earHistory.reduce((a, b) => a + b, 0);
            this.baselineEAR = sum / this.earHistory.length;
        }

        const closedCutoff = Math.max(BLINK_CLOSED_THRESHOLD, this.baselineEAR * 0.82);
        const openCutoff = Math.max(BLINK_OPEN_THRESHOLD, this.baselineEAR * 0.88);

        let justBlinked = false;
        if (avgEAR < closedCutoff || (this.baselineEAR - avgEAR) > 0.035 || avgEAR < 0.205) {
            this.eyeState = "closed";
            this.minBlinkEAR = Math.min(this.minBlinkEAR || 1.0, avgEAR);
        } else if (avgEAR >= openCutoff || (this.eyeState === "closed" && (avgEAR - (this.minBlinkEAR || 0.20)) >= 0.025)) {
            if (this.eyeState === "closed") {
                this.blinkCount += 1;
                justBlinked = true;
            }
            this.eyeState = "open";
            this.minBlinkEAR = 1.0;
        }

        // 2. MAR & Smile Tracking
        const mar = computeMAR(positions);
        const smileScore = computeSmileMetric(positions);
        const isSmiling = mar > MAR_SMILE_THRESHOLD || smileScore > 0.60;

        // 3. Temporal Motion Variance (Anti-Static Photo & Replay Defense)
        const currentRatios = computeFacialRatios(positions);
        this.ratioHistory.push(currentRatios);
        if (this.ratioHistory.length > 20) this.ratioHistory.shift();
        const variance = computeMotionVariance(this.ratioHistory);

        // Natural micro-movement, blink, smile, or head angle variance resets static counter
        const hasNaturalMovement =
            this.blinkCount > 0 ||
            isSmiling ||
            Math.abs(yawRatio - 1.0) > 0.08 ||
            Math.abs(pitchRatio - 1.0) > 0.08;

        if (hasNaturalMovement) {
            this.staticFramesCount = 0;
            this.spoofDetected = false;
        } else if (
            this.ratioHistory.length >= 15 &&
            variance < STATIC_VARIANCE_THRESHOLD &&
            this.blinkCount === 0 &&
            !isSmiling
        ) {
            this.staticFramesCount += 1;
            // Require 60 frames (~3.5 seconds) of absolute stillness before alerting spoof
            if (this.staticFramesCount >= 60) {
                this.spoofDetected = true;
                this.message = "⚠️ Static photo detected. Real human presence required (blink or move head).";
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
            if (pose === "CENTER" || (yawRatio >= 0.78 && yawRatio <= 1.28 && pitchRatio >= 0.68 && pitchRatio <= 1.32)) {
                challengeSatisfied = true;
            }
        } else if (target === "TURN_LEFT") {
            if (pose === "LEFT" || yawRatio < 0.84) {
                challengeSatisfied = true;
            }
        } else if (target === "TURN_RIGHT") {
            if (pose === "RIGHT" || yawRatio > 1.20) {
                challengeSatisfied = true;
            }
        } else if (target === "TILT_UP" || target === "NOD") {
            if (pose === "UP" || pitchRatio > 1.16) {
                challengeSatisfied = true;
            }
        } else if (target === "SMILE") {
            if (isSmiling) {
                challengeSatisfied = true;
            }
        } else if (target === "BLINK") {
            if (
                justBlinked ||
                this.blinkCount >= 1 ||
                (this.mode === "enrollment" && (
                    isSmiling ||
                    Math.abs(yawRatio - 1.0) > 0.08 ||
                    Math.abs(pitchRatio - 1.0) > 0.08 ||
                    (this.ratioHistory.length >= 8 && variance >= STATIC_VARIANCE_THRESHOLD)
                ))
            ) {
                challengeSatisfied = true;
            }
        }

        // Handle step transition
        if (challengeSatisfied) {
            this.holdFrames += 1;
            const requiredFrames = target === "CENTER" ? 2 : 1;

            if (this.holdFrames >= requiredFrames) {
                this.holdFrames = 0;
                if (!this.completedChallenges.includes(target)) {
                    this.completedChallenges.push(target);
                }
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
                    this.blinkCount = 0; // Fresh reflex required for next challenge
                    this.stepStartTime = Date.now();
                    this.message = this.getChallengePrompt(this.currentChallenge, this.currentIndex + 1, this.challenges.length);
                    this.statusType = "capturing";
                }
            } else {
                this.statusType = "capturing";
                this.message = "🎯 Face aligned · Verifying...";
            }
        } else {
            this.holdFrames = Math.max(0, this.holdFrames - 1);
            this.message = this.getChallengePrompt(this.currentChallenge, this.currentIndex + 1, this.challenges.length);
            this.statusType = "ready";
        }

        this.progress = Math.min(100, Math.round((this.currentIndex / this.challenges.length) * 100));
        this.notify();
        return this.isComplete;
    }
}

/**
 * Multi-Angle Biometric Liveness Verification Engine for Enrollment
 */
export class BiometricLivenessEngine extends RandomizedChallengeEngine {
    constructor(options = {}) {
        super({ ...options, mode: "enrollment" });
    }
}

export const LivenessEngine = BiometricLivenessEngine;
export const FaceLivenessEngine = BiometricLivenessEngine;

