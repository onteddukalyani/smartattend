import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";
import { collection, getDocs, onSnapshot, doc, updateDoc, getDoc } from "firebase/firestore";
import { db } from "../../../firebase";
import { createAttendanceSession } from "./CreateSession";
import {
    transitionSessionToPhase2,
    subscribeToSession,
    subscribeToAuthorizations,
    closeAttendanceSession,
    extendAttendanceSession,
    updateSessionGeofenceRadius,
    updateSessionRotationInterval,
    releaseIndividualStudentDevice,
    excuseAndReinstateAttendance
} from "../../../services/sessionAuthService";
import { sendFacultyNotification, sendBroadcastNotification, sendStudentNotification } from "../../../services/notificationsService";
import { useAuth } from "../../authcontext";
import { isCourseAssignedToLecturer } from "../../Common/CoursesManager";
import { normalizeBranchName, isGenericName } from "../../../utils/studentDataHelper";
import { generateRotatingQrPayload, DEFAULT_ROTATION_INTERVAL, ROTATION_INTERVALS } from "../../../utils/qrCrypto";
import { isFreshLocation, locationFromPosition } from "../../../utils/location";
import {
    FaQrcode,
    FaBookOpen,
    FaLayerGroup,
    FaCalendarAlt,
    FaDoorOpen,
    FaClock,
    FaCheckCircle,
    FaUsers,
    FaCopy,
    FaCheck,
    FaArrowRight,
    FaSyncAlt,
    FaShieldAlt,
    FaExclamationTriangle,
    FaLock,
    FaUnlock,
    FaMobileAlt,
    FaSpinner,
    FaUserCheck,
    FaCheckDouble,
    FaEye,
    FaEyeSlash,
    FaUserPlus,
    FaTimes,
    FaMapMarkerAlt,
    FaInfoCircle,
    FaChevronDown,
    FaChevronUp,
    FaTv,
    FaColumns,
    FaListUl,
    FaExpand,
    FaCompress,
    FaRocket,
    FaSlidersH,
    FaFingerprint,
    FaTimesCircle
} from "react-icons/fa";
import "./Generateqr.css";

function GenerateQR() {
    const { user, profile } = useAuth();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    // Form inputs
    const [roomNo, setRoomNo] = useState(searchParams.get("roomNo") || "");
    const [courseCode, setCourseCode] = useState(searchParams.get("courseCode") || searchParams.get("course") || "");
    const [classCode, setClassCode] = useState(normalizeBranchName(searchParams.get("classCode") || ""));
    const [batch, setBatch] = useState(searchParams.get("batch") || "2025");
    const [lectureHours, setLectureHours] = useState("1.0"); // Optional lecture duration in hours
    const [timetablePreset, setTimetablePreset] = useState("fast"); // "fast" | "express" | "standard" | "extended" | "custom"
    const [qr1Seconds, setQr1Seconds] = useState(15);   // Phase 1 (QR1 check-in) window
    const [qr2Seconds, setQr2Seconds] = useState(15);  // Phase 2 (QR2 biometric verification) window
    const [sessionDurationMinutes, setSessionDurationMinutes] = useState("0.5");
    const [customDurationMinutes, setCustomDurationMinutes] = useState("0.5");
    const [availableCourses, setAvailableCourses] = useState([]);

    // Authoritative 2-Phase Session State (0:00 -> 1:00 -> 3:00)
    const [sessionId, setSessionId] = useState(searchParams.get("sessionId") || searchParams.get("session") || "");
    const [sessionPin, setSessionPin] = useState("");
    const [showPin, setShowPin] = useState(false);
    const [phase, setPhase] = useState("NONE"); // "NONE" | "PHASE_1" | "PHASE_2" | "CLOSED"
    const [qr1Token, setQr1Token] = useState("");
    const [qr2Token, setQr2Token] = useState("");
    const [sessionStartAt, setSessionStartAt] = useState(0);
    const [qr1ExpiresAt, setQr1ExpiresAt] = useState(0);
    const [kioskEndsAt, setKioskEndsAt] = useState(0);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    // Dynamic Rotating QR & Geofence State
    const [rotationIntervalSec, setRotationIntervalSec] = useState(DEFAULT_ROTATION_INTERVAL);
    const [rotationSecondsLeft, setRotationSecondsLeft] = useState(DEFAULT_ROTATION_INTERVAL);
    const [dynamicQrUrl, setDynamicQrUrl] = useState("");
    const [geofenceRadius, setGeofenceRadius] = useState(10); // Mandatory default: 10 metres standard, adjustable live by lecturer (0 = disabled)
    const [classroomCoords, setClassroomCoords] = useState(null);
    const [classroomGpsStatus, setClassroomGpsStatus] = useState("IDLE"); // "IDLE" | "ACTIVE" | "UNAVAILABLE" | "DISABLED"

    const [sessionData, setSessionData] = useState(null);
    const [authorizedStudents, setAuthorizedStudents] = useState([]);
    const [attendanceRecords, setAttendanceRecords] = useState([]);
    const [dbStudentsMap, setDbStudentsMap] = useState(new Map());
    const [releasingStudentId, setReleasingStudentId] = useState(null);
    const [excusingStudentId, setExcusingStudentId] = useState(null);

    // Subscribe to students collection to resolve authentic database details (Roll No, Name) for every logged-in email
    useEffect(() => {
        const unsub = onSnapshot(collection(db, "students"), (snap) => {
            const m = new Map();
            snap.docs.forEach((d) => {
                const data = d.data();
                const cleanRoll = String(data.rollNo || (!d.id.includes("@") ? d.id : "")).trim().toUpperCase();
                const cleanEmail = String(data.email || "").trim().toLowerCase();
                const cleanName = String(data.name || data.fullName || "").trim();
                const studentInfo = {
                    id: d.id,
                    rollNo: cleanRoll,
                    name: cleanName || cleanRoll,
                    fullName: cleanName || cleanRoll,
                    email: cleanEmail,
                    branch: data.branch || "",
                    semester: data.semester || "",
                    uid: data.uid || ""
                };
                if (cleanRoll) m.set(cleanRoll, studentInfo);
                if (cleanEmail) m.set(cleanEmail, studentInfo);
                if (d.id) m.set(d.id.toUpperCase(), studentInfo);
                if (data.uid) m.set(data.uid, studentInfo);
            });
            setDbStudentsMap(m);
        }, (err) => {
            console.warn("Notice loading students in Generateqr:", err);
        });
        return () => unsub();
    }, []);

    // Manual Excuse / Reinstatement Modal State
    const [showManualExcuseModal, setShowManualExcuseModal] = useState(false);
    const [manualExcuseRoll, setManualExcuseRoll] = useState("");
    const [manualExcuseReason, setManualExcuseReason] = useState("Physically verified & excused by lecturer in classroom");
    const [isExcusingManual, setIsExcusingManual] = useState(false);
    const [rosterFilterTab, setRosterFilterTab] = useState("ALL"); // "ALL" | "PRESENT" | "PENDING" | "VIOLATIONS"
    const [searchTerm, setSearchTerm] = useState("");

    // UI & Live View Mode State
    const [liveViewMode, setLiveViewMode] = useState("PROJECTOR"); // "PROJECTOR" | "SPLIT" | "ROSTER"
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [isTransitioning, setIsTransitioning] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const [copied, setCopied] = useState(false);
    const [showSessionDetails, setShowSessionDetails] = useState(false);

    const timerRef = useRef(null);

    // Sync fullscreen browser state
    useEffect(() => {
        const handleFsChange = () => {
            const isFs = Boolean(document.fullscreenElement);
            setIsFullscreen(isFs);
            if (isFs) {
                setLiveViewMode("PROJECTOR");
            }
        };
        document.addEventListener("fullscreenchange", handleFsChange);
        return () => document.removeEventListener("fullscreenchange", handleFsChange);
    }, []);

    const toggleFullscreen = () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => { });
        } else {
            document.exitFullscreen().catch(() => { });
        }
    };

    // 1. Load available courses from Firestore
    useEffect(() => {
        getDocs(collection(db, "courses"))
            .then((snap) => {
                const list = snap.docs.map((d) => ({
                    id: d.id,
                    ...d.data()
                }));
                list.sort((a, b) => (a.courseCode || a.code || "").localeCompare(b.courseCode || b.code || ""));
                setAvailableCourses(list);

                const targetCode = courseCode || searchParams.get("course") || searchParams.get("courseCode") || "";
                if (targetCode) {
                    const matched = list.find((c) => (c.courseCode || c.code || "").toUpperCase() === targetCode.toUpperCase());
                    if (matched) {
                        setCourseCode(matched.courseCode || matched.code || targetCode);
                        const courseRoom = matched.defaultRoom || matched.roomNo || matched.room || matched.classroom || matched.classCode || matched.classNumber || "";
                        if (courseRoom && !searchParams.get("roomNo")) setRoomNo(courseRoom);
                        if (matched.department && !classCode) setClassCode(normalizeBranchName(matched.department));
                        if (matched.batch && (!batch || batch === "2025")) setBatch(matched.batch);
                    }
                }
            })
            .catch((err) => console.warn("Could not load courses for QR page:", err));
    }, []);

    // Continuous Pre-Warming of Lecturer Host GPS on Mount
    useEffect(() => {
        if (typeof navigator === "undefined" || !navigator.geolocation) return;
        let watchId = null;
        const applyHostGps = (pos) => {
            const location = locationFromPosition(pos);
            if (location && !sessionId) {
                const coords = {
                    ...location,
                    radius: geofenceRadius || 10
                };
                setClassroomCoords(coords);
                setClassroomGpsStatus("ACTIVE");
            }
        };

        try {
            navigator.geolocation.getCurrentPosition(
                applyHostGps,
                () => {
                    navigator.geolocation.getCurrentPosition(
                        applyHostGps,
                        (err) => console.warn("[Generateqr] Lecturer GPS pre-warm notice:", err?.message || err),
                        { enableHighAccuracy: false, timeout: 6000, maximumAge: 0 }
                    );
                },
                { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 }
            );

            watchId = navigator.geolocation.watchPosition(
                applyHostGps,
                () => {},
                { enableHighAccuracy: true, maximumAge: 0 }
            );
        } catch (_) {}

        return () => {
            if (watchId !== null && typeof navigator !== "undefined" && navigator.geolocation) {
                try { navigator.geolocation.clearWatch(watchId); } catch (_) {}
            }
        };
    }, []);

    const myCourses = useMemo(() => {
        return availableCourses.filter((c) => isCourseAssignedToLecturer(c, user, profile));
    }, [availableCourses, user, profile]);

    const otherCourses = useMemo(() => {
        return availableCourses.filter((c) => !myCourses.some((m) => m.id === c.id));
    }, [availableCourses, myCourses]);

    // 2. Real-time Subscriptions to Session & Authorized Students
    useEffect(() => {
        if (!sessionId) return;

        const unsubSession = subscribeToSession(sessionId, (data) => {
            setSessionData(data);
            if (data.lecturerPin || data.sessionPin) {
                setSessionPin(data.lecturerPin || data.sessionPin);
            } else {
                getDoc(doc(db, "attendance_sessions", sessionId, "security", "tokens"))
                    .then((secSnap) => {
                        if (secSnap.exists()) {
                            const sec = secSnap.data() || {};
                            const pin = sec.sessionPin || sec.lecturerPin;
                            if (pin) setSessionPin(pin);
                        }
                    })
                    .catch(() => { });
            }
            if (data.phase === "PHASE_2" || data.phase === "CLOSED") {
                setPhase(data.phase);
            }
            if (data.sessionStartAt) {
                const start = typeof data.sessionStartAt.toMillis === 'function' ? data.sessionStartAt.toMillis() : Number(data.sessionStartAt);
                if (start > 0) setSessionStartAt(start);
            }
            if (data.qr1ExpiresAt) {
                const exp = typeof data.qr1ExpiresAt.toMillis === 'function' ? data.qr1ExpiresAt.toMillis() : Number(data.qr1ExpiresAt);
                setQr1ExpiresAt(exp);
            }
            if (data.kioskEndsAt) {
                const end = typeof data.kioskEndsAt.toMillis === 'function' ? data.kioskEndsAt.toMillis() : Number(data.kioskEndsAt);
                setKioskEndsAt(end);
            }
            if (data.classroomLocation) {
                setClassroomCoords(data.classroomLocation);
                setClassroomGpsStatus("ACTIVE");
            }
            if (typeof data.geofenceRadius === 'number') {
                setGeofenceRadius(data.geofenceRadius);
            }
            if (typeof data.rotationIntervalSec === 'number' && data.rotationIntervalSec >= 5 && data.rotationIntervalSec <= 60 && data.rotationIntervalSec % 5 === 0) {
                setRotationIntervalSec(data.rotationIntervalSec);
            }
        });

        const unsubAuths = subscribeToAuthorizations(sessionId, (authList) => {
            setAuthorizedStudents(authList);
        });

        const unsubRecords = onSnapshot(collection(db, "attendance_records"), (recordsSnapshot) => {
            const target = String(sessionId).trim().toLowerCase();
            const matching = recordsSnapshot.docs
                .filter((d) => {
                    const data = d.data();
                    const sid = String(data.sessionId || data.session_id || "").trim().toLowerCase();
                    const docId = String(d.id).trim().toLowerCase();
                    return sid === target || docId.startsWith(`${target}_`) || docId === target;
                })
                .map((d) => ({ id: d.id, ...d.data() }));
            setAttendanceRecords(matching);
        }, (err) => {
            console.warn("Notice subscribing to attendance records in QR hub:", err);
        });

        return () => {
            unsubSession();
            unsubAuths();
            unsubRecords();
        };
    }, [sessionId]);

    // 3. Authoritative Session Timeline Engine (Dynamic configurable session duration)
    useEffect(() => {
        if (!sessionStartAt || !kioskEndsAt) {
            if (timerRef.current) clearInterval(timerRef.current);
            return;
        }

        const updateTimeline = () => {
            const totalSeconds = (sessionData?.totalDurationSeconds && Number(sessionData.totalDurationSeconds) > 0)
                ? Number(sessionData.totalDurationSeconds)
                : ((kioskEndsAt && sessionStartAt && kioskEndsAt > sessionStartAt)
                    ? Math.max(30, Math.round((kioskEndsAt - sessionStartAt) / 1000))
                    : (Number(qr1Seconds) + Number(qr2Seconds) || 30));

            if (phase === "CLOSED" || sessionData?.phase === "CLOSED" || sessionData?.status === "CLOSED" || sessionData?.active === false) {
                setPhase("CLOSED");
                setElapsedSeconds(totalSeconds);
                if (timerRef.current) clearInterval(timerRef.current);
                return;
            }

            const now = Date.now();
            const elapsed = Math.min(totalSeconds, Math.max(0, Math.floor((now - sessionStartAt) / 1000)));
            setElapsedSeconds(elapsed);

            if (now >= kioskEndsAt || elapsed >= totalSeconds) {
                setPhase("CLOSED");
                setElapsedSeconds(totalSeconds);
                if (timerRef.current) clearInterval(timerRef.current);
                if (sessionId) {
                    closeAttendanceSession(sessionId).catch(() => { });
                }
            } else if (phase === "PHASE_2" || sessionData?.phase === "PHASE_2" || (qr1ExpiresAt && now >= qr1ExpiresAt)) {
                setPhase("PHASE_2");
            } else {
                setPhase("PHASE_1");
            }
        };

        updateTimeline();
        timerRef.current = setInterval(updateTimeline, 1000);

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [sessionStartAt, qr1ExpiresAt, kioskEndsAt, phase, sessionData?.phase, sessionData?.status, sessionData?.active, sessionData?.totalDurationSeconds, qr1Seconds, qr2Seconds]);

    const handleSelectCourse = (code) => {
        setCourseCode(code);
        if (!code) return;
        const matched = availableCourses.find((c) => (c.courseCode || c.code || "").toUpperCase() === String(code).toUpperCase());
        if (matched) {
            const courseRoom = matched.defaultRoom || matched.roomNo || matched.room || matched.classroom || matched.classCode || matched.classNumber || "C003";
            setRoomNo(courseRoom);
            if (matched.department) setClassCode(normalizeBranchName(matched.department));
            else if (matched.classCode) setClassCode(normalizeBranchName(matched.classCode));
            if (matched.batch) setBatch(matched.batch);
        }
    };

    const handleCourseCodeChange = (e) => {
        const val = e.target.value;
        setCourseCode(val);
        const matched = availableCourses.find((c) => (c.courseCode || c.code || "").toUpperCase() === val.trim().toUpperCase());
        if (matched) {
            const courseRoom = matched.defaultRoom || matched.roomNo || matched.room || matched.classroom || matched.classCode || matched.classNumber || "";
            if (courseRoom) setRoomNo(courseRoom);
            if (matched.department) setClassCode(normalizeBranchName(matched.department));
            if (matched.batch) setBatch(matched.batch);
        }
    };

    // 4. Start 3-Minute Authoritative Session
    const handleGenerateSession = async () => {
        if (!classCode || !roomNo.trim()) {
            alert("Please select a class and enter room number.");
            return;
        }
        if (!courseCode.trim()) {
            alert("Please enter Course Code.");
            return;
        }
        setIsGenerating(true);
        setErrorMessage("");

        try {
            const rawDept = profile?.department || profile?.branch;
            const lecturerInfo = {
                name: profile?.name || user?.displayName || (user?.email ? user.email.split("@")[0] : "Lecturer"),
                email: user?.email || "",
                department: normalizeBranchName(rawDept || "CSE")
            };
            const finalBatch = (batch && batch.trim() !== "") ? batch.trim() : "2025";
            const parsedHours = parseFloat(lectureHours) > 0 ? parseFloat(lectureHours) : 1.0;
            const finalClassCode = normalizeBranchName(classCode || "CSE");
            const effectiveQr1Sec = Math.max(15, Number(qr1Seconds) || 15);
            const effectiveQr2Sec = Math.max(15, Number(qr2Seconds) || 15);
            const effectiveTotalSec = effectiveQr1Sec + effectiveQr2Sec;
            const effectiveDurationMinutes = Math.round((effectiveTotalSec / 60) * 10) / 10;

            // Ensure Lecturer Host GPS is locked before initiating session document
            let hostCoords = isFreshLocation(classroomCoords) ? classroomCoords : null;
            if (!hostCoords && geofenceRadius > 0 && typeof navigator !== "undefined" && navigator.geolocation) {
                try {
                    hostCoords = await new Promise((resolve) => {
                        const timeout = setTimeout(() => resolve(null), 3000);
                        navigator.geolocation.getCurrentPosition(
                            (pos) => {
                                clearTimeout(timeout);
                                const location = locationFromPosition(pos);
                                resolve(location ? { ...location, radius: geofenceRadius } : null);
                            },
                            () => {
                                clearTimeout(timeout);
                                resolve(null);
                            },
                            { enableHighAccuracy: true, timeout: 2800, maximumAge: 0 }
                        );
                    });
                    if (hostCoords) {
                        setClassroomCoords(hostCoords);
                        setClassroomGpsStatus("ACTIVE");
                    }
                } catch (_) {}
            }

            if (geofenceRadius > 0 && (!isFreshLocation(hostCoords) || hostCoords.accuracy > 45)) {
                setClassroomGpsStatus("UNAVAILABLE");
                throw new Error("A fresh, accurate classroom GPS fix (45m accuracy or better) is required before attendance. Enable Location on the lecturer's device, wait for GPS to lock, then try again.");
            }

            const activeClassroomCoords = geofenceRadius > 0 ? { ...hostCoords, radius: geofenceRadius } : null;

            const result = await createAttendanceSession(
                finalClassCode,
                courseCode.trim(),
                roomNo.trim(),
                finalBatch,
                lecturerInfo,
                parsedHours,
                geofenceRadius,
                effectiveDurationMinutes,
                {
                    qr1DurationSeconds: effectiveQr1Sec,
                    qr2DurationSeconds: effectiveQr2Sec,
                    classroomLocation: activeClassroomCoords,
                    rotationIntervalSec: rotationIntervalSec
                }
            );

            setSessionId(result.sessionId);
            if (result.sessionPin || result.lecturerPin || result.lecturerReleaseCode) {
                setSessionPin(result.sessionPin || result.lecturerPin || result.lecturerReleaseCode);
            }
            setQr1Token(result.qr1Token);
            setQr2Token(result.qr2Token);
            setSessionStartAt(result.sessionStartAt);
            setQr1ExpiresAt(result.qr1ExpiresAt);
            setKioskEndsAt(result.kioskEndsAt);
            setPhase("PHASE_1");
            setElapsedSeconds(0);
            setLiveViewMode("PROJECTOR");

            if (geofenceRadius === 0) {
                setClassroomCoords(null);
                setClassroomGpsStatus("DISABLED");
            } else {
                setClassroomCoords(activeClassroomCoords);
                setClassroomGpsStatus("ACTIVE");
            }

            // Real-time Faculty & Admin Alert
            sendFacultyNotification(
                `Attendance Session Started: ${courseCode.trim()} 🟢`,
                `Lecturer ${lecturerInfo.name} initiated attendance session for course ${courseCode.trim()} (${parsedHours} hr) in Room ${roomNo.trim()}.`,
                "SESSION_STARTED",
                "",
                lecturerInfo.name
            ).catch(() => { });

            // Targeted Student Session Notification (ONLY students registered for this course receive it)
            const cleanTargetCode = courseCode.trim().toUpperCase();
            const matchedCourse = (availableCourses || []).find((c) =>
                (c.courseCode || c.code || c.id || "").toUpperCase() === cleanTargetCode
            );
            const rawRoster = matchedCourse
                ? (Array.isArray(matchedCourse.enrolledStudents) ? matchedCourse.enrolledStudents : (Array.isArray(matchedCourse.students) ? matchedCourse.students : []))
                : [];

            const enrolledRolls = Array.from(new Set(
                rawRoster.map((s) => typeof s === "object" ? (s.rollNo || s.rollNumber || s.id || s.studentId || s.email) : s)
                    .filter(Boolean)
                    .map((r) => String(r).trim().toUpperCase())
            ));

            if (enrolledRolls.length > 0) {
                enrolledRolls.forEach((studentRoll) => {
                    sendStudentNotification(
                        studentRoll,
                        `🟢 Live Attendance: ${cleanTargetCode}`,
                        `Attendance session opened for ${cleanTargetCode} in Room ${roomNo.trim()}. Open SmartAttend app and scan the QR code before it expires.`,
                        "SESSION_STARTED",
                        lecturerInfo.name,
                        { courseCode: cleanTargetCode, sessionId: result.sessionId, roomNo: roomNo.trim() }
                    ).catch(() => { });
                });
            } else {
                sendStudentNotification(
                    cleanTargetCode,
                    `🟢 Live Attendance: ${cleanTargetCode}`,
                    `Attendance session opened for ${cleanTargetCode} in Room ${roomNo.trim()}. Open SmartAttend app and scan the QR code before it expires.`,
                    "SESSION_STARTED",
                    lecturerInfo.name,
                    { courseCode: cleanTargetCode, sessionId: result.sessionId, roomNo: roomNo.trim() }
                ).catch(() => { });
            }
        } catch (error) {
            console.error("Error creating attendance session:", error);
            setErrorMessage(error.message || "Could not create attendance session.");
        } finally {
            setIsGenerating(false);
        }
    };

    // Live Geofence Update Handler: Allows lecturer to adjust or disable geofence in real time without restarting session
    const handleUpdateGeofenceRadius = (newRadius) => {
        const r = Math.max(0, Number(newRadius) || 0);
        setGeofenceRadius(r);
        if (r === 0) {
            setClassroomCoords(null);
            setClassroomGpsStatus("DISABLED");
            if (sessionId) {
                updateSessionGeofenceRadius(sessionId, 0, null)
                    .catch((err) => console.warn("Notice updating geofence radius:", err));
            }
        } else if (classroomCoords) {
            const updatedCoords = { ...classroomCoords, radius: r };
            setClassroomCoords(updatedCoords);
            setClassroomGpsStatus("ACTIVE");
            if (sessionId) {
                updateSessionGeofenceRadius(sessionId, r, updatedCoords)
                    .catch((err) => console.warn("Notice updating geofence radius:", err));
            }
        } else if (typeof navigator !== "undefined" && navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const newCoords = {
                        latitude: pos.coords.latitude,
                        longitude: pos.coords.longitude,
                        accuracy: pos.coords.accuracy,
                        radius: r
                    };
                    setClassroomCoords(newCoords);
                    setClassroomGpsStatus("ACTIVE");
                    if (sessionId) {
                        updateSessionGeofenceRadius(sessionId, r, newCoords)
                            .catch((err) => console.warn("Notice updating geofence radius:", err));
                    }
                },
                () => {
                    navigator.geolocation.getCurrentPosition(
                        (pos2) => {
                            const newCoords2 = {
                                latitude: pos2.coords.latitude,
                                longitude: pos2.coords.longitude,
                                accuracy: pos2.coords.accuracy,
                                radius: r
                            };
                            setClassroomCoords(newCoords2);
                            setClassroomGpsStatus("ACTIVE");
                            if (sessionId) {
                                updateSessionGeofenceRadius(sessionId, r, newCoords2)
                                    .catch((err) => console.warn("Notice updating geofence radius:", err));
                            }
                        },
                        (err2) => {
                            console.warn("Classroom GPS unavailable on lecturer device:", err2?.message || err2);
                            setClassroomGpsStatus("UNAVAILABLE");
                        },
                        { enableHighAccuracy: false, timeout: 5000, maximumAge: 0 }
                    );
                },
                { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
            );
        }
    };

    // Prompt lecturer for custom manual metres entry (approved range 5–50m, default 10m)
    const handlePromptCustomGeofence = () => {
        const input = window.prompt(
            "Enter custom classroom geofence distance in metres (between 5 and 50 metres, default 10m):",
            geofenceRadius || 10
        );
        if (input !== null) {
            const val = parseInt(input.trim(), 10);
            if (!isNaN(val) && val >= 5 && val <= 50) {
                handleUpdateGeofenceRadius(val);
            } else {
                alert("Please enter a valid number between 5 and 50 metres (default is 10m).");
            }
        }
    };

    // Step adjustment helper (+5m / -5m bounded between 5m and 50m)
    const handleStepGeofenceRadius = (delta) => {
        const current = Number(geofenceRadius) || 10;
        const next = Math.max(5, Math.min(50, current + delta));
        handleUpdateGeofenceRadius(next);
    };

    // Re-calibrate / fetch fresh GPS fix from device
    const handleRecalibrateGps = () => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            alert("Geolocation is not supported by your browser or device.");
            return;
        }

        const applyRecalibration = (pos) => {
            const targetRadius = geofenceRadius > 0 ? geofenceRadius : 30;
            const updatedCoords = {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: Number(pos.coords.accuracy) || 15,
                radius: targetRadius
            };
            setClassroomCoords(updatedCoords);
            setClassroomGpsStatus("ACTIVE");
            if (geofenceRadius === 0) setGeofenceRadius(30);
            if (sessionId) {
                updateDoc(doc(db, "attendance_sessions", sessionId), {
                    geofenceRadius: targetRadius,
                    classroomLocation: updatedCoords
                }).catch(() => { });
            }
            alert(`✅ Classroom GPS re-calibrated successfully!\nCoordinates: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}\nAccuracy: ±${Math.round(pos.coords.accuracy)}m\nRadius: ${targetRadius}m`);
        };

        navigator.geolocation.getCurrentPosition(
            applyRecalibration,
            () => {
                // Secondary coarse / Wi-Fi fallback if high accuracy GNSS satellite fails indoors on laptop
                navigator.geolocation.getCurrentPosition(
                    applyRecalibration,
                    (err) => {
                        alert("Could not retrieve GPS coordinates. Please ensure Location access is allowed in your browser settings.\nError: " + (err.message || err));
                    },
                    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
                );
            },
            { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 }
        );
    };

    // Live Dynamic Session Time Adjustment (Lecturer / Admin can add or remove running session time live)
    const handleAdjustSessionTime = async (deltaSeconds) => {
        if (!sessionId) return;
        try {
            const isPhase1 = phase === "PHASE_1";
            const target = isPhase1 ? "PHASE_1" : "PHASE_2";
            const now = Date.now();
            const startMs = sessionStartAt || now;

            // 1. Immediate optimistic UI updates to instantly update clock, pills, and countdowns
            if (isPhase1) {
                const currentQr1 = qr1ExpiresAt || (now + 30000);
                const targetQr1 = currentQr1 + deltaSeconds * 1000;

                if (targetQr1 <= now + 2000) {
                    // Time removal ends Phase 1 immediately -> advance directly to Phase 2 right now!
                    const qr2Sec = Number(qr2Seconds) || 15;
                    const newEnds = now + (qr2Sec * 1000);
                    setPhase("PHASE_2");
                    setQr1ExpiresAt(now);
                    setKioskEndsAt(newEnds);
                    const newQr1Sec = Math.max(10, Math.round((now - startMs) / 1000));
                    setElapsedSeconds(newQr1Sec);
                } else {
                    const qr2Sec = Number(qr2Seconds) || 15;
                    const newEnds = targetQr1 + (qr2Sec * 1000);
                    setQr1ExpiresAt(targetQr1);
                    setKioskEndsAt(newEnds);
                }
            } else {
                const currentEnds = kioskEndsAt || (now + 60000);
                const targetEnds = currentEnds + deltaSeconds * 1000;

                if (targetEnds <= now + 2000) {
                    // Time removal ends session immediately -> close session!
                    setPhase("CLOSED");
                    setKioskEndsAt(now);
                    const totalSec = Math.max(30, Math.round((now - startMs) / 1000));
                    setElapsedSeconds(totalSec);
                } else {
                    setKioskEndsAt(targetEnds);
                }
            }

            // 2. Authoritative update via extendAttendanceSession (which atomically syncs Cloud Function or Firestore fallback)
            await extendAttendanceSession(sessionId, {
                deltaSeconds,
                phaseTarget: target
            });
        } catch (err) {
            console.error("Failed to adjust session time:", err);
        }
    };
    const handleExtendSession = (mins) => handleAdjustSessionTime(mins * 60);

    // 5. Early Transition to Phase 2 (Starts Phase 2 immediately while preserving total duration)
    const handleForcePhase2 = async () => {
        if (!sessionId) return;
        setIsTransitioning(true);
        try {
            const now = Date.now();
            setQr1ExpiresAt(now);
            setPhase("PHASE_2");
            await transitionSessionToPhase2(sessionId);
        } catch (error) {
            console.warn("Notice transitioning early:", error);
            setPhase("PHASE_2");
        } finally {
            setIsTransitioning(false);
        }
    };

    // Helper: End session immediately, release all student kiosks, and jump clock to end
    const handleEndSessionAndReleaseAll = async () => {
        if (!window.confirm("End attendance session immediately and release all student devices from Kiosk mode?")) {
            return;
        }
        if (timerRef.current) clearInterval(timerRef.current);
        const totalSec = (sessionData?.totalDurationSeconds && Number(sessionData.totalDurationSeconds) > 0)
            ? Number(sessionData.totalDurationSeconds)
            : ((kioskEndsAt && sessionStartAt && kioskEndsAt > sessionStartAt)
                ? Math.round((kioskEndsAt - sessionStartAt) / 1000)
                : 180);
        setPhase("CLOSED");
        setElapsedSeconds(totalSec);
        try {
            if (sessionId) {
                await closeAttendanceSession(sessionId);
                sendFacultyNotification(
                    `Attendance Session Closed: ${courseCode || "Class"} 🔴`,
                    `Attendance session for course ${courseCode || "Class"} was closed and all student devices unlocked.`,
                    "SESSION_CLOSED",
                    "",
                    profile?.name || "Lecturer"
                ).catch(() => { });
            }
        } catch (err) {
            console.error("Error closing session:", err);
        }
    };

    // 6. Release Individual Student Device Remotely from Kiosk Lock Task Mode
    const handleReleaseIndividualStudent = async (student) => {
        const studentId = student.studentUid || student.id || student.rollNo;
        const rollNo = (student.rollNo || studentId || "").toString().trim().toUpperCase();
        const studentName = student.studentName || student.fullName || rollNo;

        if (!window.confirm(`Release ${studentName} (${rollNo}) from Kiosk Lock Task mode immediately?`)) {
            return;
        }

        setReleasingStudentId(studentId);
        try {
            await releaseIndividualStudentDevice(sessionId, student.studentUid || student.id, rollNo, sessionPin || null);
            // Optimistically update student state so button changes to 'Unlocked' immediately
            student.released = true;
            student.releaseStatus = "RELEASED";
            student.status = "RELEASED";
            setAuthorizedStudents((prev) =>
                (prev || []).map((s) => {
                    const sRoll = (s.rollNo || s.studentUid || s.id || "").toString().trim().toUpperCase();
                    if (sRoll === rollNo || s.studentUid === studentId || s.id === studentId) {
                        return { ...s, released: true, releaseStatus: "RELEASED", status: "RELEASED" };
                    }
                    return s;
                })
            );
            alert(`✅ ${studentName} (${rollNo}) has been released! Device is unlocking from Kiosk mode.`);
        } catch (err) {
            console.error("Error releasing student device:", err);
            alert("❌ Failed to release device: " + (err.message || err));
        } finally {
            setReleasingStudentId(null);
        }
    };

    // 7. Excuse / Reinstate Student Attendance (When student provides a physical valid reason in class)
    const handleExcuseStudent = async (student, reason = "Physically verified and excused by lecturer in classroom") => {
        const rollNo = (student.rollNo || student.studentUid || student.id || "").toString().trim().toUpperCase();
        const studentId = student.studentUid || student.id || rollNo;
        const studentName = student.studentName || student.fullName || rollNo;

        if (!window.confirm(`Excuse violation & mark ${studentName} (${rollNo}) as Present (Approved)?`)) {
            return;
        }

        setExcusingStudentId(studentId);
        try {
            const lecturerDisplayName = profile?.name || user?.displayName || "Lecturer";
            await excuseAndReinstateAttendance(sessionId, {
                ...student,
                rollNo,
                studentName,
                studentUid: studentId
            }, lecturerDisplayName, reason);
            alert(`✅ Attendance for ${studentName} (${rollNo}) has been approved and reinstated as Present!`);
        } catch (err) {
            console.error("Failed to excuse student:", err);
            alert("❌ Failed to excuse student: " + (err.message || err));
        } finally {
            setExcusingStudentId(null);
        }
    };

    // 8. Manual Excuse by Roll Number (For students who lost attendance or had device glitch)
    const handleManualExcuseSubmit = async (e) => {
        e?.preventDefault();
        if (!manualExcuseRoll.trim()) {
            alert("Please enter a valid student Roll Number.");
            return;
        }
        setIsExcusingManual(true);
        try {
            const cleanRoll = manualExcuseRoll.trim().toUpperCase();
            const lecturerDisplayName = profile?.name || user?.displayName || "Lecturer";
            await excuseAndReinstateAttendance(sessionId, {
                rollNo: cleanRoll,
                studentName: cleanRoll,
                studentUid: cleanRoll
            }, lecturerDisplayName, manualExcuseReason || "Physically verified and excused by lecturer in classroom");
            alert(`✅ Attendance for ${cleanRoll} has been restored and marked as Present!`);
            setManualExcuseRoll("");
            setShowManualExcuseModal(false);
        } catch (err) {
            console.error("Failed to excuse student manually:", err);
            alert("❌ Failed to reinstate attendance: " + (err.message || err));
        } finally {
            setIsExcusingManual(false);
        }
    };

    // Dynamic Rotating QR Effect (rotates every rotationIntervalSec, default 10s)
    useEffect(() => {
        if (!sessionId || phase === "NONE" || phase === "CLOSED") return;

        let isMounted = true;
        const updateDynamicToken = async () => {
            const baseToken = phase === "PHASE_1" ? qr1Token : qr2Token;
            const currentPhaseNum = phase === "PHASE_1" ? "1" : "2";
            const url = await generateRotatingQrPayload({
                sessionId,
                phase: currentPhaseNum,
                baseToken,
                intervalSec: rotationIntervalSec,
                classroomLocation: classroomCoords
            });
            if (isMounted) {
                setDynamicQrUrl(url);
            }
        };

        updateDynamicToken();

        setRotationSecondsLeft(rotationIntervalSec);
        const intervalId = setInterval(() => {
            setRotationSecondsLeft((prev) => {
                if (prev <= 1) {
                    updateDynamicToken();
                    return rotationIntervalSec;
                }
                return prev - 1;
            });
        }, 1000);

        return () => {
            isMounted = false;
            clearInterval(intervalId);
        };
    }, [sessionId, phase, qr1Token, qr2Token, rotationIntervalSec, classroomCoords]);

    // Construct Active QR URL based on current phase and dynamic rotation
    const activeQrUrl = useMemo(() => {
        if (!sessionId) return "";
        if (dynamicQrUrl) return dynamicQrUrl;
        if (phase === "PHASE_1" && qr1Token) {
            return `${window.location.origin}/student/mark-attendance?session=${encodeURIComponent(sessionId)}&qr1Token=${encodeURIComponent(qr1Token)}&phase=1`;
        }
        if (phase === "PHASE_2" && qr2Token) {
            return `${window.location.origin}/student/mark-attendance?session=${encodeURIComponent(sessionId)}&qr2Token=${encodeURIComponent(qr2Token)}&phase=2`;
        }
        return `${window.location.origin}/student/mark-attendance?session=${encodeURIComponent(sessionId)}`;
    }, [sessionId, phase, qr1Token, qr2Token, dynamicQrUrl]);

    const handleCopyLink = () => {
        if (!activeQrUrl) return;
        navigator.clipboard.writeText(activeQrUrl).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const handleResetSession = async () => {
        if (window.confirm("Start a new attendance session? Current session will be closed.")) {
            if (sessionId) {
                await closeAttendanceSession(sessionId).catch(() => { });
            }
            setSessionId("");
            setPhase("NONE");
            setQr1Token("");
            setQr2Token("");
            setSessionStartAt(0);
            setQr1ExpiresAt(0);
            setKioskEndsAt(0);
            setSessionData(null);
            setAuthorizedStudents([]);
        }
    };

    // Comprehensive Disqualification & Violation Detection Helpers
    const checkIsDisqualified = (st) => {
        if (!st) return false;
        if (st.disqualified === true) return true;
        const s = String(st.status || "").toUpperCase();
        if (s === "DISQUALIFIED" || s === "FLAGGED_DISQUALIFIED" || s === "REJECTED") return true;
        if (Number(st.violationCount || st.confirmedKioskViolations || 0) >= 2) return true;
        if (Array.isArray(st.violations) && st.violations.some(v => v.disqualified === true || Number(v.count || 0) >= 2)) return true;
        return false;
    };

    const checkHasViolation = (st) => {
        if (!st) return false;
        if (checkIsDisqualified(st)) return true;
        if (st.hasViolation === true || st.flagged === true) return true;
        const s = String(st.status || "").toUpperCase();
        if (s.startsWith("FLAGGED") || s.includes("VIOLATION") || s.includes("ESCAPE")) return true;
        if (Array.isArray(st.violations) && st.violations.length > 0) return true;
        if (Number(st.violationCount || st.confirmedKioskViolations || 0) > 0) return true;
        return false;
    };

    // Deduplicated list of students (guarantees no student/device is shown twice, and resolves authentic database details by email)
    const uniqueStudentsList = useMemo(() => {
        const map = new Map();

        const resolveStudentIdentity = (raw) => {
            const rawEmail = (raw.studentEmail || raw.email || "").toLowerCase().trim();
            const rawRoll = String(raw.rollNo || "").toUpperCase().trim();
            const rawUid = raw.studentUid || raw.uid || "";
            const rawId = String(raw.id || "").toUpperCase().trim();

            const dbMatch = (rawEmail && dbStudentsMap.get(rawEmail)) ||
                (rawRoll && dbStudentsMap.get(rawRoll)) ||
                (rawUid && dbStudentsMap.get(rawUid)) ||
                (rawId && dbStudentsMap.get(rawId)) || null;

            const canonicalRoll = dbMatch?.rollNo || (!rawRoll.includes("@") && rawRoll ? rawRoll : (!rawId.includes("@") ? rawId : ""));
            const rawName = raw.studentName || raw.fullName || raw.name || "";
            const canonicalName = dbMatch?.name || dbMatch?.fullName || (!isGenericName(rawName, canonicalRoll, rawEmail) ? rawName : (canonicalRoll || "Student"));
            const canonicalEmail = dbMatch?.email || rawEmail;
            const canonicalUid = rawUid || dbMatch?.uid || canonicalRoll;
            const dedupeKey = (canonicalEmail || canonicalRoll || canonicalUid || rawId).toLowerCase();

            return {
                canonicalRoll,
                canonicalName,
                canonicalEmail,
                canonicalUid,
                dedupeKey
            };
        };

        // 1. Process authorized students (QR 1 check-ins)
        (authorizedStudents || []).forEach((st) => {
            const { canonicalRoll, canonicalName, canonicalEmail, canonicalUid, dedupeKey } = resolveStudentIdentity(st);
            if (!dedupeKey) return;

            const isDisq = checkIsDisqualified(st);
            const hasV = isDisq || checkHasViolation(st);
            const vCount = Math.max(Number(st.violationCount || st.confirmedKioskViolations || 0), isDisq ? 2 : hasV ? 1 : 0);

            if (!map.has(dedupeKey)) {
                map.set(dedupeKey, {
                    ...st,
                    rollNo: canonicalRoll || st.rollNo || dedupeKey.toUpperCase(),
                    studentName: canonicalName || st.studentName || canonicalRoll || "Student",
                    studentEmail: canonicalEmail,
                    studentUid: canonicalUid || st.studentUid,
                    disqualified: isDisq,
                    hasViolation: hasV,
                    violationCount: vCount,
                    violations: Array.isArray(st.violations) ? st.violations : []
                });
            } else {
                const existing = map.get(dedupeKey);
                const mergedDisq = isDisq || existing.disqualified === true;
                const mergedHasV = hasV || existing.hasViolation === true || mergedDisq;
                const mergedVCount = Math.max(vCount, Number(existing.violationCount || 0));
                const allViolations = [
                    ...(Array.isArray(existing.violations) ? existing.violations : []),
                    ...(Array.isArray(st.violations) ? st.violations : [])
                ];

                map.set(dedupeKey, {
                    ...existing,
                    ...st,
                    rollNo: canonicalRoll || existing.rollNo || st.rollNo,
                    studentName: canonicalName || existing.studentName || st.studentName,
                    studentEmail: canonicalEmail || existing.studentEmail,
                    studentUid: canonicalUid || existing.studentUid,
                    released: st.released === true || existing.released === true,
                    status: (st.status === "FLAGGED_DISQUALIFIED" || st.status === "DISQUALIFIED") ? st.status : (existing.status || st.status),
                    flagged: st.flagged === true || existing.flagged === true,
                    disqualified: mergedDisq,
                    hasViolation: mergedHasV,
                    violationCount: mergedVCount,
                    violations: allViolations
                });
            }
        });

        // 2. Also incorporate any students present in attendance_records (e.g. submitted or excused records)
        (attendanceRecords || []).forEach((rec) => {
            const { canonicalRoll, canonicalName, canonicalEmail, canonicalUid, dedupeKey } = resolveStudentIdentity(rec);
            if (!dedupeKey) return;

            const isDisq = checkIsDisqualified(rec);
            const hasV = isDisq || checkHasViolation(rec);

            if (!map.has(dedupeKey)) {
                map.set(dedupeKey, {
                    id: rec.id || dedupeKey,
                    rollNo: canonicalRoll || rec.rollNo || dedupeKey.toUpperCase(),
                    studentName: canonicalName || rec.fullName || rec.name || rec.studentName || canonicalRoll || "Student",
                    studentEmail: canonicalEmail,
                    studentUid: canonicalUid || rec.studentUid,
                    disqualified: isDisq,
                    hasViolation: hasV,
                    violationCount: isDisq ? 2 : hasV ? 1 : 0,
                    violations: [],
                    status: rec.status || (isDisq ? "FLAGGED_DISQUALIFIED" : "APPROVED"),
                    isAttended: rec.excused || rec.faceVerified || rec.status === "APPROVED" || rec.status === "ATTENDED"
                });
            } else {
                const existing = map.get(dedupeKey);
                if (canonicalRoll) existing.rollNo = canonicalRoll;
                if (canonicalName && !isGenericName(canonicalName, canonicalRoll, canonicalEmail)) existing.studentName = canonicalName;
                if (isDisq) {
                    existing.disqualified = true;
                    existing.hasViolation = true;
                    existing.status = "FLAGGED_DISQUALIFIED";
                    existing.violationCount = Math.max(existing.violationCount || 0, 2);
                    if (rec.violationReason && !existing.violationReason) {
                        existing.violationReason = rec.violationReason;
                    }
                }
                if (rec.excused || rec.faceVerified || rec.status === "APPROVED" || rec.status === "ATTENDED") {
                    existing.isAttended = true;
                    if (rec.status) existing.status = rec.status;
                }
            }
        });

        return Array.from(map.values()).sort((a, b) => (a.rollNo || "").localeCompare(b.rollNo || ""));
    }, [authorizedStudents, attendanceRecords, dbStudentsMap]);

    const attendeesSet = useMemo(() => {
        const set = new Set();
        (sessionData?.attendees || []).forEach((a) => {
            if (a.rollNo) set.add(a.rollNo.toUpperCase().trim());
            if (a.studentUid) set.add(a.studentUid.toUpperCase().trim());
            if (a.email || a.studentEmail) set.add((a.email || a.studentEmail).toLowerCase().trim());
        });
        (attendanceRecords || []).forEach((rec) => {
            const roll = (rec.rollNo || "").toUpperCase().trim();
            const uid = (rec.studentUid || "").toUpperCase().trim();
            const email = (rec.studentEmail || rec.email || "").toLowerCase().trim();
            const isExcused = rec.excused === true;
            const isDisq = !isExcused && checkIsDisqualified(rec);
            if (!isDisq && (isExcused || rec.faceVerified || rec.status === "APPROVED" || rec.status === "ATTENDED")) {
                if (roll) set.add(roll);
                if (uid) set.add(uid);
                if (email) set.add(email);
            }
        });
        return set;
    }, [sessionData?.attendees, attendanceRecords]);

    const flaggedMap = useMemo(() => {
        const map = new Map();
        (sessionData?.flaggedViolations || []).forEach((f) => {
            const isReviewed = f.reviewed === true || f.excused === true || f.resolved === true || f.dismissed === true || f.status === "RESOLVED" || f.status === "APPROVED" || f.status === "DISMISSED";
            if (isReviewed) return;
            const r = (f.rollNo || "").toUpperCase().trim();
            const u = (f.studentUid || "").toUpperCase().trim();
            const e = (f.email || f.studentEmail || "").toLowerCase().trim();
            const isDisq = f.disqualified === true || f.status === "FLAGGED_DISQUALIFIED" || Number(f.count || f.violationCount || 0) >= 1;
            const reason = f.violationReason || f.violationType || (isDisq ? "Attendance forfeited: confirmed kiosk exit violation" : "App switched / screen capture violation");
            const entry = { reason, isDisqualified: isDisq };
            if (r) map.set(r, entry);
            if (u) map.set(u, entry);
            if (e) map.set(e, entry);
        });

        // Also incorporate any disqualified records from attendanceRecords
        (attendanceRecords || []).forEach((rec) => {
            const roll = (rec.rollNo || rec.studentUid || "").toUpperCase().trim();
            const email = (rec.studentEmail || rec.email || "").toLowerCase().trim();
            if (roll && checkIsDisqualified(rec) && !map.has(roll)) {
                const entry = {
                    reason: rec.violationReason || "Attendance forfeited: 2 confirmed kiosk exits",
                    isDisqualified: true
                };
                map.set(roll, entry);
                if (email) map.set(email, entry);
            }
        });

        return map;
    }, [sessionData?.flaggedViolations, attendanceRecords]);

    // Enrich student records with attendance, violation, and excuse state
    const enrichedStudentsList = useMemo(() => {
        return uniqueStudentsList.map((st) => {
            const roll = (st.rollNo || "").toUpperCase().trim();
            const uid = (st.studentUid || "").toUpperCase().trim();
            const email = (st.studentEmail || st.email || "").toLowerCase().trim();
            const flagEntry = flaggedMap.get(roll) || flaggedMap.get(uid) || (email && flaggedMap.get(email));

            const isAttended = st.isAttended === true || attendeesSet.has(roll) || attendeesSet.has(uid) || (email && attendeesSet.has(email)) || st.status === "ATTENDED" || st.status === "APPROVED" || st.attended === true || st.excused === true;
            const isExcused = st.excused === true || (isAttended && (flagEntry || st.flagged || st.hasViolation || st.disqualified));

            const isDisqualified = !isExcused && !isAttended && (
                st.disqualified === true ||
                checkIsDisqualified(st) ||
                (flagEntry && flagEntry.isDisqualified) ||
                (sessionData?.flaggedViolations || []).some(f =>
                    (f.disqualified === true || f.status === "FLAGGED_DISQUALIFIED" || Number(f.count || f.violationCount || 0) >= 1) &&
                    ((f.rollNo && f.rollNo.toUpperCase().trim() === roll) || (f.studentUid && f.studentUid.toUpperCase().trim() === uid))
                )
            );

            const hasViolation = isDisqualified || (!isExcused && !isAttended && (
                Boolean(flagEntry) ||
                checkHasViolation(st) ||
                st.status === "FLAGGED_WARNING" ||
                st.status === "FLAGGED_DISQUALIFIED" ||
                st.flagged === true ||
                st.hasViolation === true ||
                (Array.isArray(st.violations) && st.violations.length > 0)
            ));

            const violationReason = flagEntry?.reason ||
                st.violationReason ||
                (Array.isArray(st.violations) && st.violations.length > 0 ? (st.violations[st.violations.length - 1].reason || st.violations[0].reason) : null) ||
                (isDisqualified ? "Attendance forfeited: 2 confirmed kiosk exits" : "App switch detected");

            return {
                ...st,
                isAttended,
                isDisqualified,
                hasViolation,
                violationReason,
                isExcused
            };
        });
    }, [uniqueStudentsList, attendeesSet, flaggedMap, sessionData?.flaggedViolations]);

    // Live Metrics: Total scanned QR 1, Reached QR 2 (Attended), Pending QR 2, and Violations Count
    const { totalScannedQR1, reachedQR2Count, pendingQR2Count, violationsCount } = useMemo(() => {
        let reachedQR2 = 0;
        let pendingQR2 = 0;
        let violations = 0;

        enrichedStudentsList.forEach((st) => {
            if (st.isAttended) {
                reachedQR2++;
            } else if (st.isDisqualified || st.hasViolation) {
                violations++;
            } else {
                pendingQR2++;
            }
        });

        return {
            totalScannedQR1: enrichedStudentsList.length,
            reachedQR2Count: reachedQR2,
            pendingQR2Count: pendingQR2,
            violationsCount: violations
        };
    }, [enrichedStudentsList]);

    // Filtered students according to active tab & search
    const filteredRoster = useMemo(() => {
        return enrichedStudentsList.filter((st) => {
            if (rosterFilterTab === "PRESENT" && !st.isAttended) return false;
            if (rosterFilterTab === "PENDING" && (st.isAttended || st.isDisqualified || st.hasViolation)) return false;
            if (rosterFilterTab === "VIOLATIONS" && (!st.isDisqualified && !st.hasViolation || st.isAttended)) return false;

            if (searchTerm.trim()) {
                const term = searchTerm.toLowerCase().trim();
                const roll = (st.rollNo || "").toLowerCase();
                const name = (st.studentName || "").toLowerCase();
                return roll.includes(term) || name.includes(term);
            }
            return true;
        });
    }, [enrichedStudentsList, rosterFilterTab, searchTerm]);

    // Formatting helper for mm:ss
    const formatMmSs = (sec) => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${String(s).padStart(2, "0")}`;
    };

    const totalDurationSeconds = useMemo(() => {
        if (sessionData?.totalDurationSeconds && Number(sessionData.totalDurationSeconds) > 0) {
            return Number(sessionData.totalDurationSeconds);
        }
        if (kioskEndsAt && sessionStartAt && kioskEndsAt > sessionStartAt) {
            return Math.max(30, Math.round((kioskEndsAt - sessionStartAt) / 1000));
        }
        return Math.max(30, Number(qr1Seconds) + Number(qr2Seconds));
    }, [sessionData?.totalDurationSeconds, kioskEndsAt, sessionStartAt, qr1Seconds, qr2Seconds]);

    const qr1TotalSeconds = useMemo(() => {
        if (sessionData?.qr1DurationSeconds && Number(sessionData.qr1DurationSeconds) > 0) {
            return Number(sessionData.qr1DurationSeconds);
        }
        if (qr1ExpiresAt && sessionStartAt && qr1ExpiresAt > sessionStartAt) {
            return Math.max(10, Math.round((qr1ExpiresAt - sessionStartAt) / 1000));
        }
        return Math.max(15, Number(qr1Seconds) || 15);
    }, [sessionData?.qr1DurationSeconds, qr1ExpiresAt, sessionStartAt, qr1Seconds]);

    const qr1Remaining = Math.max(0, qr1ExpiresAt ? Math.floor((qr1ExpiresAt - Date.now()) / 1000) : (qr1TotalSeconds - elapsedSeconds));
    const sessionRemaining = Math.max(0, kioskEndsAt ? Math.floor((kioskEndsAt - Date.now()) / 1000) : (totalDurationSeconds - elapsedSeconds));
    const totalDurationMinutesDisplay = (totalDurationSeconds / 60).toFixed(1).replace(/\.0$/, "");

    const isFormReady = Boolean(courseCode.trim() && classCode && roomNo.trim());

    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // Sub-render A: Dual-Card Setup Dashboard (Setup Controls + Live Summary)
    // -------------------------------------------------------------------------
    const renderSetupView = () => (
        <div className="qr-setup-grid">
            {/* Left Column: Form Controls */}
            <div className="qr-setup-col-form">
                <section className="qr-setup-card">
                    {/* Step 1: Classroom & Target Course */}
                    <div className="qr-section-heading">
                        <span className="qr-step">01</span>
                        <div>
                            <h2>Classroom &amp; Target Course</h2>
                            <p>Select or enter course code, department section and room number</p>
                        </div>
                    </div>

                    {availableCourses.length > 0 && (
                        <div className="qr-form-group">
                            <label htmlFor="course-select">
                                <FaBookOpen /> Quick Pick Registered Course
                            </label>
                            <select
                                id="course-select"
                                value={courseCode}
                                onChange={(e) => handleSelectCourse(e.target.value)}
                                className="qr-select-styled"
                            >
                                <option value="">-- Choose Course or Type Below --</option>
                                {myCourses.length > 0 && (
                                    <optgroup label="🌟 My Assigned Courses">
                                        {myCourses.map((c) => {
                                            const code = c.courseCode || c.code || "";
                                            const name = c.courseName || c.name || "Curriculum Course";
                                            const dept = c.department || "CSE";
                                            return (
                                                <option key={c.id} value={code}>
                                                    {code} - {name} ({dept})
                                                </option>
                                            );
                                        })}
                                    </optgroup>
                                )}
                                {otherCourses.length > 0 && (
                                    <optgroup label="📚 All Other Courses">
                                        {otherCourses.map((c) => {
                                            const code = c.courseCode || c.code || "";
                                            const name = c.courseName || c.name || "Curriculum Course";
                                            const dept = c.department || "CSE";
                                            return (
                                                <option key={c.id} value={code}>
                                                    {code} - {name} ({dept})
                                                </option>
                                            );
                                        })}
                                    </optgroup>
                                )}
                            </select>
                        </div>
                    )}

                    <div className="qr-form-row">
                        <div className="qr-form-group">
                            <label htmlFor="course-code">
                                <FaBookOpen /> Course Code *
                            </label>
                            <input
                                id="course-code"
                                type="text"
                                value={courseCode}
                                onChange={handleCourseCodeChange}
                                placeholder="e.g. CS171, CS301"
                                required
                            />
                        </div>

                        <div className="qr-form-group">
                            <label htmlFor="class-code">
                                <FaLayerGroup /> Department Branch *
                            </label>
                            <select
                                id="class-code"
                                value={classCode}
                                onChange={(e) => setClassCode(e.target.value)}
                            >
                                <option value="">Select Department</option>
                                <option value="CSE">CSE</option>
                                <option value="CSE-A">CSE-A</option>
                                <option value="CSE-B">CSE-B</option>
                                <option value="DSAI">DSAI</option>
                                <option value="ECE">ECE</option>
                                <option value="AIC">AIC</option>
                            </select>
                        </div>
                    </div>

                    <div className="qr-form-row-3">
                        <div className="qr-form-group">
                            <label htmlFor="room-number">
                                <FaDoorOpen /> Room Number *
                            </label>
                            <input
                                id="room-number"
                                type="text"
                                value={roomNo}
                                onChange={(e) => setRoomNo(e.target.value)}
                                placeholder="e.g. C002, C003"
                                required
                            />
                        </div>

                        <div className="qr-form-group">
                            <label htmlFor="batch-year">
                                <FaCalendarAlt /> Batch
                            </label>
                            <select
                                id="batch-year"
                                value={batch}
                                onChange={(e) => setBatch(e.target.value)}
                            >
                                <option value="2023">2023</option>
                                <option value="2024">2024</option>
                                <option value="2025">2025</option>
                                <option value="2026">2026</option>
                            </select>
                        </div>

                        <div className="qr-form-group">
                            <label htmlFor="lecture-hours">
                                <FaClock /> Lecture Duration
                            </label>
                            <select
                                id="lecture-hours"
                                value={lectureHours}
                                onChange={(e) => setLectureHours(e.target.value)}
                            >
                                <option value="1.0">1.0 Hr (Standard)</option>
                                <option value="0.5">0.5 Hr (30 min)</option>
                                <option value="1.5">1.5 Hrs (90 min)</option>
                                <option value="2.0">2.0 Hrs (Double/Lab)</option>
                                <option value="2.5">2.5 Hrs (Extended)</option>
                                <option value="3.0">3.0 Hrs (3 Hours)</option>
                                <option value="4.0">4.0 Hrs (Workshop)</option>
                            </select>
                        </div>
                    </div>

                    {/* Step 2: Attendance Window & Security Protocols */}
                    <div className="qr-section-heading" style={{ marginTop: "20px" }}>
                        <span className="qr-step">02</span>
                        <div>
                            <h2>Security Protocols &amp; Timetable Window</h2>
                            <p>Authoritative 2-phase check-in timing, classroom geofencing &amp; token rotation</p>
                        </div>
                    </div>

                    {/* Presets */}
                    <div className="qr-form-group">
                        <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span><FaClock /> Timetable Duration Window</span>
                            <span className="qr-total-window-tag">
                                {formatMmSs(qr1Seconds + qr2Seconds)} Total ({Math.round((qr1Seconds + qr2Seconds) / 60 * 10) / 10}m)
                            </span>
                        </label>
                        <div className="qr-preset-grid">
                            {[
                                { id: "fast", icon: "⚡", title: "30s Quick", badge: "15s + 15s", desc: "Rapid check-in & scan", qr1: 15, qr2: 15 },
                                { id: "express", icon: "⏱️", title: "2m Express", badge: "45s + 75s", desc: "Smooth class flow", qr1: 45, qr2: 75 },
                                { id: "standard", icon: "🛡️", title: "3m Standard", badge: "60s + 120s", desc: "Extended attendance window", qr1: 60, qr2: 120 },
                                { id: "extended", icon: "⏳", title: "5m Extended", badge: "90s + 210s", desc: "Large lecture hall", qr1: 90, qr2: 210 },
                                { id: "custom", icon: "🛠️", title: "Custom", badge: "Manual", desc: "Specify QR1 & QR2", qr1: qr1Seconds, qr2: qr2Seconds }
                            ].map((preset) => (
                                <button
                                    key={preset.id}
                                    type="button"
                                    className={`qr-preset-card ${timetablePreset === preset.id ? "active" : ""}`}
                                    onClick={() => {
                                        setTimetablePreset(preset.id);
                                        if (preset.id !== "custom") {
                                            setQr1Seconds(preset.qr1);
                                            setQr2Seconds(preset.qr2);
                                        }
                                    }}
                                >
                                    <div className="qr-preset-header">
                                        <span className="qr-preset-icon">{preset.icon}</span>
                                        <span className="qr-preset-badge">{preset.badge}</span>
                                    </div>
                                    <div className="qr-preset-title">{preset.title}</div>
                                    <div className="qr-preset-desc">{preset.desc}</div>
                                </button>
                            ))}
                        </div>

                        {/* Granular Breakdown Controls */}
                        <div className="qr-timing-breakdown-box">
                            <div className="qr-breakdown-col">
                                <span className="qr-breakdown-label p1-label">
                                    Phase 1: QR1 Check-in Window
                                </span>
                                {timetablePreset === "custom" ? (
                                    <div className="qr-breakdown-input-row">
                                        <input
                                            type="number"
                                            min="15"
                                            max="600"
                                            step="5"
                                            value={qr1Seconds}
                                            onChange={(e) => setQr1Seconds(Math.max(15, parseInt(e.target.value) || 15))}
                                        />
                                        <span style={{ fontSize: "0.75rem", color: "#64748b" }}>seconds</span>
                                    </div>
                                ) : (
                                    <span className="qr-breakdown-val">{qr1Seconds} seconds ({formatMmSs(qr1Seconds)})</span>
                                )}
                            </div>

                            <div className="qr-breakdown-col">
                                <span className="qr-breakdown-label p2-label">
                                    Phase 2: QR2 Biometric Window
                                </span>
                                {timetablePreset === "custom" ? (
                                    <div className="qr-breakdown-input-row">
                                        <input
                                            type="number"
                                            min="15"
                                            max="1800"
                                            step="5"
                                            value={qr2Seconds}
                                            onChange={(e) => setQr2Seconds(Math.max(15, parseInt(e.target.value) || 15))}
                                        />
                                        <span style={{ fontSize: "0.75rem", color: "#64748b" }}>seconds</span>
                                    </div>
                                ) : (
                                    <span className="qr-breakdown-val">{qr2Seconds} seconds ({formatMmSs(qr2Seconds)})</span>
                                )}
                            </div>

                            <div className="qr-breakdown-col total-col">
                                <span className="qr-breakdown-label">Total Execution Window</span>
                                <div className="qr-breakdown-val total">
                                    {formatMmSs(qr1Seconds + qr2Seconds)}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Geofence & Rotating interval row */}
                    <div className="qr-form-row">
                        <div className="qr-form-group">
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                                <label htmlFor="geofence-radius" style={{ margin: 0, display: "flex", alignItems: "center", gap: "6px" }}>
                                    <FaMapMarkerAlt /> Geofence Distance
                                </label>
                                <span style={{
                                    fontSize: "0.78rem",
                                    fontWeight: 800,
                                    padding: "2px 8px",
                                    borderRadius: "6px",
                                    background: geofenceRadius > 0 ? "rgba(16, 185, 129, 0.12)" : "rgba(100, 116, 139, 0.12)",
                                    color: geofenceRadius > 0 ? "#059669" : "#64748b"
                                }}>
                                    {geofenceRadius > 0 ? `${geofenceRadius}m Active` : "Disabled"}
                                </span>
                            </div>

                            {/* Manual Numeric Input + Test GPS Button */}
                            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px" }}>
                                <input
                                    id="geofence-radius"
                                    type="number"
                                    min="0"
                                    max="500"
                                    step="5"
                                    value={geofenceRadius}
                                    onChange={(e) => handleUpdateGeofenceRadius(Math.max(0, parseInt(e.target.value) || 0))}
                                    placeholder="Enter metres (e.g. 25)"
                                    style={{ flex: 1, fontWeight: 750 }}
                                />
                                <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "#64748b", whiteSpace: "nowrap" }}>
                                    metres
                                </span>
                                <button
                                    type="button"
                                    onClick={handleRecalibrateGps}
                                    title="Capture / Test Classroom GPS Now"
                                    style={{
                                        padding: "8px 12px",
                                        borderRadius: "8px",
                                        border: "1px solid var(--border, #cbd5e1)",
                                        background: "var(--surface, #ffffff)",
                                        color: "#4f46e5",
                                        fontSize: "0.78rem",
                                        fontWeight: 750,
                                        cursor: "pointer",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "4px"
                                    }}
                                >
                                    <FaMapMarkerAlt /> Test GPS
                                </button>
                            </div>

                            {/* Fine-Tuning Slider */}
                            <input
                                type="range"
                                min="0"
                                max="150"
                                step="5"
                                value={geofenceRadius}
                                onChange={(e) => handleUpdateGeofenceRadius(Number(e.target.value))}
                                style={{ width: "100%", accentColor: "#6366f1", marginBottom: "8px", cursor: "pointer" }}
                            />

                            {/* Quick Presets */}
                            <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                                {[
                                    { label: "0m (Off)", val: 0 },
                                    { label: "15m Lab", val: 15 },
                                    { label: "20m Small", val: 20 },
                                    { label: "30m (Default)", val: 30 },
                                    { label: "50m Hall", val: 50 },
                                    { label: "100m Campus", val: 100 }
                                ].map((p) => (
                                    <button
                                        key={p.val}
                                        type="button"
                                        onClick={() => handleUpdateGeofenceRadius(p.val)}
                                        style={{
                                            padding: "3px 8px",
                                            borderRadius: "6px",
                                            border: geofenceRadius === p.val ? "1.5px solid #6366f1" : "1px solid var(--border, #cbd5e1)",
                                            background: geofenceRadius === p.val ? "rgba(99, 102, 241, 0.15)" : "transparent",
                                            color: geofenceRadius === p.val ? "#4f46e5" : "var(--text-muted, #64748b)",
                                            fontWeight: 700,
                                            fontSize: "0.74rem",
                                            cursor: "pointer"
                                        }}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>

                            {/* Live Host GPS Telemetry Card */}
                            {classroomCoords ? (
                                <div style={{
                                    marginTop: "10px",
                                    padding: "8px 12px",
                                    borderRadius: "8px",
                                    background: "rgba(16, 185, 129, 0.08)",
                                    border: "1px solid rgba(16, 185, 129, 0.25)",
                                    fontSize: "0.78rem",
                                    color: "#065f46",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: "6px"
                                }}>
                                    <span>📍 <strong>Host GPS Locked:</strong> {classroomCoords.latitude?.toFixed(5)}, {classroomCoords.longitude?.toFixed(5)} (±{Math.round(classroomCoords.accuracy || 15)}m)</span>
                                    <span style={{ fontWeight: 800, color: "#059669" }}>✓ Ready</span>
                                </div>
                            ) : (
                                <div style={{
                                    marginTop: "10px",
                                    padding: "8px 12px",
                                    borderRadius: "8px",
                                    background: "rgba(245, 158, 11, 0.08)",
                                    border: "1px solid rgba(245, 158, 11, 0.25)",
                                    fontSize: "0.78rem",
                                    color: "#92400e",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: "6px"
                                }}>
                                    <span>📍 <strong>GPS:</strong> Acquiring classroom satellite coordinates...</span>
                                    <button
                                        type="button"
                                        onClick={handleRecalibrateGps}
                                        style={{
                                            background: "transparent",
                                            border: "none",
                                            color: "#b45309",
                                            fontWeight: 800,
                                            textDecoration: "underline",
                                            cursor: "pointer",
                                            padding: 0
                                        }}
                                    >
                                        Re-try Now
                                    </button>
                                </div>
                            )}
                        </div>

                        <div className="qr-form-group">
                            <label htmlFor="rotation-interval">
                                <FaSyncAlt /> Dynamic Token Rotation
                            </label>
                            <select
                                id="rotation-interval"
                                value={rotationIntervalSec}
                                onChange={(e) => setRotationIntervalSec(Number(e.target.value))}
                            >
                                {ROTATION_INTERVALS.map((sec) => (
                                    <option key={sec} value={sec}>
                                        {sec}s {sec === 10 ? "(Authoritative Default)" : (sec === 5 ? "(Anti-Proxy Ultra Security)" : "")}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                </section>
            </div>

            {/* Right Column: Live Session Blueprint & Summary Card */}
            <aside className="qr-blueprint-card">
                <div className="qr-blueprint-header">
                    <h3>
                        <FaSlidersH /> Session Blueprint
                    </h3>
                    <span className="qr-blueprint-ribbon">
                        {isFormReady ? "Ready to Launch" : "Draft Setup"}
                    </span>
                </div>

                {/* Visual Timeline Partition Bar */}
                <div className="qr-blueprint-timeline-wrap">
                    <div className="qr-blueprint-timeline-label">
                        <span>Timeline Partition</span>
                        <span>{formatMmSs(qr1Seconds + qr2Seconds)} Total ({Math.round((qr1Seconds + qr2Seconds) / 60 * 10) / 10}m)</span>
                    </div>
                    <div className="qr-timeline-preview-bar">
                        <div
                            className="qr-timeline-seg-p1"
                            style={{ width: `${Math.round((qr1Seconds / (qr1Seconds + qr2Seconds)) * 100)}%` }}
                            title={`Phase 1: ${qr1Seconds}s`}
                        />
                        <div
                            className="qr-timeline-seg-p2"
                            style={{ width: `${Math.round((qr2Seconds / (qr1Seconds + qr2Seconds)) * 100)}%` }}
                            title={`Phase 2: ${qr2Seconds}s`}
                        />
                    </div>
                    <div className="qr-blueprint-timeline-legend">
                        <span><span className="legend-dot-p1" /> P1 Check-in ({qr1Seconds}s)</span>
                        <span><span className="legend-dot-p2" /> P2 Biometrics ({qr2Seconds}s)</span>
                    </div>
                </div>

                {/* Blueprint Specs Grid (Live selections) */}
                <div className="qr-blueprint-specs">
                    <div className="qr-blueprint-spec-item">
                        <span className="spec-label">Course Code</span>
                        <span className="spec-val">{String(courseCode || "").trim() || "Not Selected"}</span>
                    </div>
                    <div className="qr-blueprint-spec-item">
                        <span className="spec-label">Department</span>
                        <span className="spec-val">{classCode || "Not Selected"}</span>
                    </div>
                    <div className="qr-blueprint-spec-item">
                        <span className="spec-label">Room / Lab</span>
                        <span className="spec-val">{String(roomNo || "").trim() || "Not Set"}</span>
                    </div>
                    <div className="qr-blueprint-spec-item">
                        <span className="spec-label">Batch</span>
                        <span className="spec-val">{batch}</span>
                    </div>
                    <div className="qr-blueprint-spec-item">
                        <span className="spec-label">Lecture Length</span>
                        <span className="spec-val">{lectureHours} Hr</span>
                    </div>
                    <div className="qr-blueprint-spec-item">
                        <span className="spec-label">GPS Geofence</span>
                        <span className="spec-val">{geofenceRadius > 0 ? `${geofenceRadius}m Active` : "Disabled"}</span>
                    </div>
                    <div className="qr-blueprint-spec-item">
                        <span className="spec-label">Token Rotation</span>
                        <span className="spec-val">{rotationIntervalSec}s Dynamic</span>
                    </div>
                    <div className="qr-blueprint-spec-item">
                        <span className="spec-label">Host</span>
                        <span className="spec-val">{profile?.name || user?.displayName || (user?.email ? user.email.split("@")[0] : "Lecturer")}</span>
                    </div>
                </div>

                {/* Security Chips */}
                <div className="qr-security-chips">
                    <span className="qr-sec-chip" style={{ background: "rgba(99, 102, 241, 0.12)", color: "#4f46e5", border: "1px solid rgba(99, 102, 241, 0.35)", fontWeight: 750 }}>
                        <FaShieldAlt /> Anti-Proxy Shield (5s QR + Single-Strike + Liveness)
                    </span>
                    <span className="qr-sec-chip"><FaLock /> Kiosk Mode Locked</span>
                    <span className="qr-sec-chip"><FaMapMarkerAlt /> {geofenceRadius > 0 ? `${geofenceRadius}m GPS Active` : "GPS Disabled"}</span>
                    <span className="qr-sec-chip"><FaSyncAlt /> {rotationIntervalSec}s Token Rotation</span>
                    <span className="qr-sec-chip"><FaFingerprint /> Biometric Verified</span>
                </div>

                {/* Live Readiness Checklist */}
                <div className="qr-readiness-list">
                    <div className={`qr-readiness-item ${String(courseCode || "").trim() ? "ready" : "missing"}`}>
                        {String(courseCode || "").trim() ? <FaCheckCircle /> : <FaTimesCircle />}
                        <span>Course: {String(courseCode || "").trim() || "Enter or pick course code"}</span>
                    </div>
                    <div className={`qr-readiness-item ${classCode ? "ready" : "missing"}`}>
                        {classCode ? <FaCheckCircle /> : <FaTimesCircle />}
                        <span>Department: {classCode || "Select branch / section"}</span>
                    </div>
                    <div className={`qr-readiness-item ${String(roomNo || "").trim() ? "ready" : "missing"}`}>
                        {String(roomNo || "").trim() ? <FaCheckCircle /> : <FaTimesCircle />}
                        <span>Room: {String(roomNo || "").trim() || "Enter room number (e.g. C002)"}</span>
                    </div>
                </div>

                {/* Launch Action Button */}
                <button
                    type="button"
                    onClick={handleGenerateSession}
                    className="qr-launch-session-btn"
                    disabled={isGenerating || !isFormReady}
                >
                    <span>
                        {isGenerating
                            ? "Initializing Authoritative Session..."
                            : `🚀 Start Attendance Session (${Math.round((qr1Seconds + qr2Seconds) / 60 * 10) / 10} Min Total)`}
                    </span>
                    {!isGenerating ? <FaArrowRight /> : <FaSyncAlt className="fa-spin" />}
                </button>

                {errorMessage && <p className="qr-error" role="alert" style={{ marginTop: "8px" }}>{errorMessage}</p>}
            </aside>
        </div>
    );

    // -------------------------------------------------------------------------
    // Sub-render B: Roster Table & Moderation Section (Reused across views)
    // -------------------------------------------------------------------------
    const renderRosterTable = (isCompact = true) => (
        <section className={`qr-live-tracking-section ${isCompact ? "qr-compact-roster" : ""}`}>
            <div className="qr-tracking-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
                <div>
                    <h3 className="qr-tracking-title">
                        <FaUsers /> Live Attendance &amp; Student Roster
                    </h3>
                    <p className="qr-tracking-desc">
                        Real-time breakdown of students in this session. Excuse and reinstate attendance if a student presents a valid reason in class.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => setShowManualExcuseModal(true)}
                    className="qr-manual-excuse-btn"
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "9px 16px",
                        borderRadius: "10px",
                        background: "#10b981",
                        color: "#ffffff",
                        border: "none",
                        fontWeight: 750,
                        fontSize: "0.88rem",
                        cursor: "pointer",
                        boxShadow: "0 4px 12px rgba(16, 185, 129, 0.25)"
                    }}
                >
                    <FaUserPlus /> <span>➕ Excuse / Add Student by Roll No</span>
                </button>
            </div>

            {/* 4-Metric Summary Cards */}
            <div className="qr-metrics-grid" style={{ gridTemplateColumns: isCompact ? undefined : "repeat(auto-fit, minmax(220px, 1fr))" }}>
                {/* Metric 1: Total Scanned QR 1 */}
                <div className="qr-kpi-card qr-kpi-scanned">
                    <div className="qr-kpi-icon indigo">
                        <FaMobileAlt />
                    </div>
                    <div className="qr-kpi-data">
                        <span className="qr-kpi-label">Scanned QR 1 (Checked In)</span>
                        <span className="qr-kpi-val">{totalScannedQR1}</span>
                        <span className="qr-kpi-sub">Devices locked in Kiosk</span>
                    </div>
                </div>

                {/* Metric 2: Reached QR 2 (Attendance Completed) */}
                <div className="qr-kpi-card qr-kpi-attended">
                    <div className="qr-kpi-icon emerald">
                        <FaCheckCircle />
                    </div>
                    <div className="qr-kpi-data">
                        <span className="qr-kpi-label">Present (Verified / Excused)</span>
                        <span className="qr-kpi-val">{reachedQR2Count}</span>
                        <span className="qr-kpi-sub">Attendance approved</span>
                    </div>
                </div>

                {/* Metric 3: Pending QR 2 */}
                <div className="qr-kpi-card qr-kpi-pending">
                    <div className="qr-kpi-icon amber">
                        <FaClock />
                    </div>
                    <div className="qr-kpi-data">
                        <span className="qr-kpi-label">Pending QR 2 (In-Class)</span>
                        <span className="qr-kpi-val">{pendingQR2Count}</span>
                        <span className="qr-kpi-sub">Checked-in, waiting QR 2</span>
                    </div>
                </div>

                {/* Metric 4: Flagged Violations / Disqualified */}
                <div className="qr-kpi-card" style={{ borderLeft: "4px solid #ef4444" }}>
                    <div className="qr-kpi-icon" style={{ background: "rgba(239, 68, 68, 0.12)", color: "#dc2626" }}>
                        <FaExclamationTriangle />
                    </div>
                    <div className="qr-kpi-data">
                        <span className="qr-kpi-label">Flagged / Disqualified</span>
                        <span className="qr-kpi-val" style={{ color: "#dc2626" }}>{violationsCount}</span>
                        <span className="qr-kpi-sub">{violationsCount > 0 ? "App switch / screen exit" : "No violations"}</span>
                    </div>
                </div>
            </div>

            {/* Active Violation Alert & Excuse Guide */}
            {violationsCount > 0 && (
                <div className="qr-violations-alert-box">
                    <div className="qr-violations-alert-info">
                        <FaExclamationTriangle className="qr-violations-alert-icon" />
                        <div>
                            <strong className="qr-violations-alert-title">
                                {violationsCount} student(s) disqualified due to app switching or screen lockout
                            </strong>
                            <span className="qr-violations-alert-desc">
                                If a student gives a valid physical reason in class (e.g. accidental notification tap / phone glitch), click <strong>"Excuse &amp; Mark Present"</strong> to pardon and restore their attendance.
                            </span>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setRosterFilterTab("VIOLATIONS")}
                        className="qr-violations-filter-btn"
                    >
                        View Disqualified Students ({violationsCount})
                    </button>
                </div>
            )}

            {/* Roster Controls & Filter Tabs */}
            <div style={{
                marginTop: "18px",
                marginBottom: "12px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "12px"
            }}>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    <button
                        type="button"
                        onClick={() => setRosterFilterTab("ALL")}
                        style={{
                            padding: "6px 14px",
                            borderRadius: "8px",
                            border: "1.5px solid",
                            borderColor: rosterFilterTab === "ALL" ? "#6366f1" : "var(--border, #cbd5e1)",
                            background: rosterFilterTab === "ALL" ? "rgba(99, 102, 241, 0.1)" : "transparent",
                            color: rosterFilterTab === "ALL" ? "#6366f1" : "var(--text-main, #475569)",
                            fontWeight: 700,
                            fontSize: "0.82rem",
                            cursor: "pointer"
                        }}
                    >
                        All ({enrichedStudentsList.length})
                    </button>
                    <button
                        type="button"
                        onClick={() => setRosterFilterTab("PRESENT")}
                        style={{
                            padding: "6px 14px",
                            borderRadius: "8px",
                            border: "1.5px solid",
                            borderColor: rosterFilterTab === "PRESENT" ? "#10b981" : "var(--border, #cbd5e1)",
                            background: rosterFilterTab === "PRESENT" ? "rgba(16, 185, 129, 0.1)" : "transparent",
                            color: rosterFilterTab === "PRESENT" ? "#10b981" : "var(--text-main, #475569)",
                            fontWeight: 700,
                            fontSize: "0.82rem",
                            cursor: "pointer"
                        }}
                    >
                        Present ({reachedQR2Count})
                    </button>
                    <button
                        type="button"
                        onClick={() => setRosterFilterTab("PENDING")}
                        style={{
                            padding: "6px 14px",
                            borderRadius: "8px",
                            border: "1.5px solid",
                            borderColor: rosterFilterTab === "PENDING" ? "#f59e0b" : "var(--border, #cbd5e1)",
                            background: rosterFilterTab === "PENDING" ? "rgba(245, 158, 11, 0.1)" : "transparent",
                            color: rosterFilterTab === "PENDING" ? "#d97706" : "var(--text-main, #475569)",
                            fontWeight: 700,
                            fontSize: "0.82rem",
                            cursor: "pointer"
                        }}
                    >
                        Pending QR 2 ({pendingQR2Count})
                    </button>
                    <button
                        type="button"
                        onClick={() => setRosterFilterTab("VIOLATIONS")}
                        style={{
                            padding: "6px 14px",
                            borderRadius: "8px",
                            border: "1.5px solid",
                            borderColor: rosterFilterTab === "VIOLATIONS" ? "#ef4444" : "var(--border, #cbd5e1)",
                            background: rosterFilterTab === "VIOLATIONS" ? "rgba(239, 68, 68, 0.1)" : "transparent",
                            color: rosterFilterTab === "VIOLATIONS" ? "#dc2626" : "var(--text-main, #475569)",
                            fontWeight: 700,
                            fontSize: "0.82rem",
                            cursor: "pointer"
                        }}
                    >
                        Disqualified / Violations ({violationsCount})
                    </button>
                </div>

                <input
                    type="text"
                    placeholder="Filter by roll number or name..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    style={{
                        padding: "7px 12px",
                        borderRadius: "8px",
                        border: "1.5px solid var(--border, #cbd5e1)",
                        fontSize: "0.84rem",
                        minWidth: "220px",
                        outline: "none"
                    }}
                />
            </div>

            {/* Deduplicated Student List Table */}
            {filteredRoster.length === 0 ? (
                <div className="qr-waiting-box">
                    <FaClock />
                    <p>
                        {uniqueStudentsList.length === 0
                            ? "Waiting for students to scan QR 1 and check into this session..."
                            : "No students matching the current filter."}
                    </p>
                </div>
            ) : (
                <div className="qr-roster-table-wrap">
                    <table className="qr-roster-table">
                        <thead>
                            <tr>
                                <th>Roll Number</th>
                                <th>Student Name</th>
                                <th>Phase 1 (QR 1)</th>
                                <th>Phase 2 (QR 2) &amp; Status</th>
                                <th>Kiosk Mode</th>
                                <th style={{ textAlign: "right" }}>Lecturer Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredRoster.map((student) => {
                                const studentId = student.studentUid || student.id || student.rollNo;
                                const isReleased = student.released === true || student.status === "RELEASED" || phase === "CLOSED";
                                const isBusyRelease = releasingStudentId === studentId;
                                const isBusyExcuse = excusingStudentId === studentId;

                                return (
                                    <tr key={student.rollNo} className={student.hasViolation && !student.isAttended ? "row-violation" : isReleased ? "row-released" : ""}>
                                        <td className="qr-cell-roll">
                                            <strong>{student.rollNo}</strong>
                                        </td>
                                        <td className="qr-cell-name">
                                            {student.studentName || student.fullName || student.rollNo}
                                        </td>
                                        <td>
                                            <span className="qr-tag-scanned">
                                                <FaCheckCircle /> Scanned
                                            </span>
                                        </td>
                                        <td>
                                            {student.isExcused ? (
                                                <span className="qr-tag-attended" style={{ background: "rgba(16, 185, 129, 0.15)", color: "#059669" }}>
                                                    <FaCheckCircle /> Excused (Present)
                                                </span>
                                            ) : student.isAttended ? (
                                                <span className="qr-tag-attended">
                                                    <FaCheckCircle /> Reached QR 2 (100%)
                                                </span>
                                            ) : student.hasViolation ? (
                                                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                    <span style={{
                                                        background: "#fee2e2",
                                                        color: "#b91c1c",
                                                        border: "1px solid #fca5a5",
                                                        padding: "3px 8px",
                                                        borderRadius: "6px",
                                                        fontWeight: 750,
                                                        fontSize: "0.78rem",
                                                        display: "inline-flex",
                                                        alignItems: "center",
                                                        gap: "4px"
                                                    }}>
                                                        <FaExclamationTriangle /> {student.isDisqualified ? "Disqualified (App Switch)" : "Flagged Warning"}
                                                    </span>
                                                    <span style={{ fontSize: "0.72rem", color: "#9f1239" }}>
                                                        {student.violationReason}
                                                    </span>
                                                </div>
                                            ) : (
                                                <span className="qr-tag-pending">
                                                    <FaClock /> Pending QR 2
                                                </span>
                                            )}
                                        </td>
                                        <td>
                                            {isReleased ? (
                                                <span className="qr-tag-released">
                                                    <FaUnlock /> Released
                                                </span>
                                            ) : (
                                                <span className="qr-tag-locked">
                                                    <FaLock /> Locked
                                                </span>
                                            )}
                                        </td>
                                        <td style={{ textAlign: "right" }}>
                                            <div style={{ display: "inline-flex", gap: "6px", justifyContent: "flex-end" }}>
                                                {/* Excuse & Mark Present Action */}
                                                {!student.isAttended ? (
                                                    <button
                                                        type="button"
                                                        disabled={isBusyExcuse}
                                                        onClick={() => handleExcuseStudent(student)}
                                                        style={{
                                                            padding: "6px 12px",
                                                            borderRadius: "8px",
                                                            border: "none",
                                                            background: "#10b981",
                                                            color: "#ffffff",
                                                            fontWeight: 700,
                                                            fontSize: "0.78rem",
                                                            cursor: "pointer",
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "4px",
                                                            boxShadow: "0 2px 6px rgba(16, 185, 129, 0.25)"
                                                        }}
                                                        title="Pardon violation and mark attendance as Present"
                                                    >
                                                        {isBusyExcuse ? (
                                                            <FaSpinner className="fa-spin" />
                                                        ) : (
                                                            <><FaCheck /> Excuse &amp; Mark Present</>
                                                        )}
                                                    </button>
                                                ) : (
                                                    <span style={{ color: "#10b981", fontWeight: 700, fontSize: "0.82rem", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                                        <FaCheck /> Verified
                                                    </span>
                                                )}

                                                {/* Kiosk Mode Device Unlock Button */}
                                                <button
                                                    type="button"
                                                    disabled={isReleased || isBusyRelease}
                                                    onClick={() => handleReleaseIndividualStudent(student)}
                                                    className={`qr-release-btn ${isReleased ? "released" : ""}`}
                                                    style={{ padding: "6px 10px", fontSize: "0.78rem" }}
                                                >
                                                    {isBusyRelease ? (
                                                        <FaSpinner className="fa-spin" />
                                                    ) : isReleased ? (
                                                        <>Unlocked</>
                                                    ) : (
                                                        <><FaUnlock /> Release</>
                                                    )}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );

    // -------------------------------------------------------------------------
    // Sub-render C: Compact HUD Card (For Split Mode Left Column)
    // -------------------------------------------------------------------------
    const renderHudCard = () => (
        <section className="qr-result qr-result-ready qr-compact-hud">
            {/* Phase Banner */}
            <div className={`qr-compact-hud-banner ${phase === "PHASE_1" ? "p1" : phase === "PHASE_2" ? "p2" : "closed"}`}>
                {phase === "PHASE_1" ? (
                    <>⚡ Phase 1: Classroom Check-in (0:00–{formatMmSs(qr1TotalSeconds)})</>
                ) : phase === "PHASE_2" ? (
                    <>🎯 Phase 2: Biometric Verification ({formatMmSs(qr1TotalSeconds)}–{formatMmSs(totalDurationSeconds)})</>
                ) : (
                    <>🔒 Attendance Session Completed</>
                )}
            </div>

            {/* QR Canvas Frame - Placed at top so it is 100% visible without scrolling */}
            {phase !== "CLOSED" ? (
                <>
                    <div className={`qr-code-frame cyber-frame ${phase === "PHASE_1" ? "phase-1" : "phase-2"}`}>
                        <span className="qr-corner-bracket tl" />
                        <span className="qr-corner-bracket tr" />
                        <span className="qr-corner-bracket bl" />
                        <span className="qr-corner-bracket br" />
                        <QRCodeCanvas
                            value={activeQrUrl || (sessionId ? `${window.location.origin}/student/mark-attendance?session=${encodeURIComponent(sessionId)}` : "https://smart-attendance-ok.web.app")}
                            size={250}
                        />
                    </div>

                    {/* Dynamic Rotating QR Ticker */}
                    <div style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "10px",
                        width: "100%",
                        maxWidth: "320px",
                        padding: "6px 12px",
                        background: "rgba(99, 102, 241, 0.08)",
                        borderRadius: "10px",
                        border: "1px solid rgba(99, 102, 241, 0.2)",
                        margin: "6px 0 8px",
                        fontSize: "0.82rem",
                        fontWeight: 700,
                        color: "#4338ca",
                        boxSizing: "border-box"
                    }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <FaSyncAlt className="fa-spin" style={{ color: "#6366f1", fontSize: "0.8rem" }} />
                            <span>Rotating in <strong style={{ color: "#ef4444" }}>{rotationSecondsLeft}s</strong></span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                            <span style={{ fontSize: "0.72rem", color: "var(--text-muted, #64748b)" }}>Interval:</span>
                            <select
                                value={rotationIntervalSec}
                                onChange={async (e) => {
                                    const val = Number(e.target.value);
                                    setRotationIntervalSec(val);
                                    setRotationSecondsLeft(val);
                                    if (sessionId) {
                                        try {
                                            await updateSessionRotationInterval(sessionId, val);
                                        } catch (err) {
                                            console.error("Failed to update rotation interval on server:", err);
                                            alert("Failed to update rotation interval: " + (err.message || err));
                                        }
                                    }
                                }}
                                style={{
                                    padding: "2px 6px",
                                    borderRadius: "6px",
                                    fontSize: "0.74rem",
                                    fontWeight: 700,
                                    border: "1px solid #cbd5e1",
                                    background: "#ffffff",
                                    cursor: "pointer"
                                }}
                            >
                                {ROTATION_INTERVALS.map((sec) => (
                                    <option key={sec} value={sec}>{sec}s</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Interactive Geofence Live Adjustment Bar */}
                    <div style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "6px",
                        fontSize: "0.76rem",
                        fontWeight: 700,
                        color: geofenceRadius > 0 ? "#059669" : "#64748b",
                        marginBottom: "10px",
                        flexWrap: "wrap",
                        padding: "6px 12px",
                        borderRadius: "10px",
                        background: geofenceRadius > 0 ? "rgba(16, 185, 129, 0.08)" : "rgba(100, 116, 139, 0.08)",
                        border: geofenceRadius > 0 ? "1px solid rgba(16, 185, 129, 0.25)" : "1px solid rgba(100, 116, 139, 0.2)"
                    }}>
                        <span>
                            {geofenceRadius > 0
                                ? `📍 Geofence: ${classroomCoords?.radius || geofenceRadius}m Active${classroomCoords?.latitude ? ` (${classroomCoords.latitude.toFixed(4)}, ${classroomCoords.longitude.toFixed(4)})` : ""}`
                                : "📍 Geofence: Disabled"}
                        </span>
                        <div style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
                            {geofenceRadius > 0 && (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => handleStepGeofenceRadius(-5)}
                                        title="Decrease geofence radius by 5m"
                                        style={{ padding: "2px 6px", borderRadius: "5px", border: "1px solid #cbd5e1", background: "var(--surface, #ffffff)", fontSize: "0.7rem", fontWeight: 800, cursor: "pointer" }}
                                    >
                                        -5m
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleStepGeofenceRadius(5)}
                                        title="Increase geofence radius by 5m"
                                        style={{ padding: "2px 6px", borderRadius: "5px", border: "1px solid #cbd5e1", background: "var(--surface, #ffffff)", fontSize: "0.7rem", fontWeight: 800, cursor: "pointer" }}
                                    >
                                        +5m
                                    </button>
                                </>
                            )}
                            <button
                                type="button"
                                onClick={handlePromptCustomGeofence}
                                title="Manually type custom metres radius"
                                style={{ padding: "2px 7px", borderRadius: "5px", border: "1px solid #6366f1", background: "rgba(99, 102, 241, 0.12)", color: "#4f46e5", fontSize: "0.7rem", fontWeight: 750, cursor: "pointer" }}
                            >
                                ✏️ Custom
                            </button>
                            <button
                                type="button"
                                onClick={handleRecalibrateGps}
                                title="Recalibrate Classroom GPS Live"
                                style={{ padding: "2px 7px", borderRadius: "5px", border: "1px solid #059669", background: "rgba(16, 185, 129, 0.12)", color: "#065f46", fontSize: "0.7rem", fontWeight: 750, cursor: "pointer" }}
                            >
                                🎯 GPS
                            </button>
                            {geofenceRadius > 0 ? (
                                <button
                                    type="button"
                                    onClick={() => handleUpdateGeofenceRadius(0)}
                                    title="Disable GPS Geofence enforcement"
                                    style={{ padding: "2px 7px", borderRadius: "5px", border: "1px solid #f87171", background: "rgba(239, 68, 68, 0.1)", color: "#dc2626", fontSize: "0.7rem", fontWeight: 750, cursor: "pointer" }}
                                >
                                    Disable
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => handleUpdateGeofenceRadius(10)}
                                    title="Enable 10m default geofence"
                                    style={{ padding: "2px 7px", borderRadius: "5px", border: "1px solid #10b981", background: "rgba(16, 185, 129, 0.15)", color: "#059669", fontSize: "0.7rem", fontWeight: 750, cursor: "pointer" }}
                                >
                                    Enable 10m
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={handleRecalibrateGps}
                                title="Re-calibrate GPS from current device position"
                                style={{ padding: "2px 7px", borderRadius: "5px", border: "1px solid #cbd5e1", background: "var(--surface, #ffffff)", color: "#64748b", fontSize: "0.7rem", fontWeight: 700, cursor: "pointer" }}
                            >
                                🎯 Re-fix
                            </button>
                        </div>
                    </div>

                    {/* Progress Track */}
                    <div className="qr-hud-progress-track" style={{ width: "100%", maxWidth: "320px", marginBottom: "8px" }}>
                        <div
                            className={`qr-hud-progress-fill ${phase === "PHASE_1" ? "phase-1" : "phase-2"}`}
                            style={{
                                width: `${Math.min(100, Math.max(0, ((totalDurationSeconds - elapsedSeconds) / Math.max(1, totalDurationSeconds)) * 100))}%`
                            }}
                        />
                    </div>

                    {/* Clean Time Adjustment Controls */}
                    <div className="qr-adjust-pills-bar">
                        <span className="qr-adjust-label">Adjust:</span>
                        <button type="button" onClick={() => handleAdjustSessionTime(30)} className="qr-adjust-pill plus" title="Add 30 seconds">+30s</button>
                        <button type="button" onClick={() => handleAdjustSessionTime(60)} className="qr-adjust-pill plus" title="Add 1 minute">+1m</button>
                        <button type="button" onClick={() => handleAdjustSessionTime(120)} className="qr-adjust-pill plus" title="Add 2 minutes">+2m</button>
                        <button type="button" onClick={() => handleAdjustSessionTime(-30)} className="qr-adjust-pill minus" title="Remove 30 seconds">-30s</button>
                        <button type="button" onClick={() => handleAdjustSessionTime(-60)} className="qr-adjust-pill minus" title="Remove 1 minute">-1m</button>
                    </div>

                    {/* Early Switch Button in Phase 1 */}
                    {phase === "PHASE_1" && (
                        <div style={{ margin: "10px 0 6px", width: "100%", maxWidth: "320px" }}>
                            <button
                                type="button"
                                onClick={handleForcePhase2}
                                disabled={isTransitioning}
                                className="qr-switch-btn"
                                style={{ width: "100%", padding: "10px 16px", fontSize: "0.88rem" }}
                            >
                                <span>⚡ Switch to Phase 2 Early</span>
                                <FaArrowRight />
                            </button>
                        </div>
                    )}
                </>
            ) : (
                <div style={{
                    padding: "26px 16px",
                    borderRadius: "16px",
                    background: "var(--surface-soft, #f1f5f9)",
                    border: "2px dashed var(--border, #cbd5e1)",
                    margin: "10px 0 16px",
                    width: "100%",
                    maxWidth: "340px",
                    boxSizing: "border-box"
                }}>
                    <FaCheckDouble style={{ fontSize: "2.4rem", color: "#10b981", marginBottom: "8px" }} />
                    <h3 style={{ margin: "0 0 4px", fontSize: "1.1rem", fontWeight: 800 }}>Attendance Session Completed</h3>
                    <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--text-muted, #64748b)" }}>
                        Session window elapsed. All devices unlocked. Present: <strong>{reachedQR2Count || sessionData?.attendanceCount || 0} / {uniqueStudentsList.length}</strong>
                    </p>
                    <button
                        type="button"
                        onClick={handleResetSession}
                        className="qr-reset-btn"
                        style={{ marginTop: "12px", width: "100%" }}
                    >
                        <FaSyncAlt /> Start New Session
                    </button>
                </div>
            )}

            {/* Classroom Security Notice */}
            <div className="qr-classroom-security-notice" style={{ width: "100%", maxWidth: "330px", margin: "10px auto 14px" }}>
                <div className="qr-sec-badge" style={{ fontSize: "0.72rem" }}>
                    <FaShieldAlt /> Device Policy Active
                </div>
                <p className="qr-sec-text" style={{ fontSize: "0.74rem" }}>
                    Android locked in Kiosk mode. Students must remain in SmartAttend until Phase 2 biometric verification is complete.
                </p>
            </div>

            {/* Quick Actions */}
            <div className="qr-action-footer" style={{ width: "100%", maxWidth: "330px", gap: "8px" }}>
                <Link
                    to={`/lecturer/attendance-sessions/${sessionId}`}
                    className="qr-view-live-btn"
                    style={{ fontSize: "0.82rem", padding: "8px 12px" }}
                >
                    <FaUsers /> <span>{phase === "CLOSED" ? "Final Register" : "Live Register"}</span>
                </Link>
                {phase !== "CLOSED" && (
                    <button
                        type="button"
                        onClick={handleCopyLink}
                        className="qr-copy-btn"
                        style={{ fontSize: "0.82rem", padding: "8px 12px" }}
                        title="Copy active QR URL"
                    >
                        {copied ? <><FaCheck /> <span>Copied</span></> : <><FaCopy /> <span>Copy Link</span></>}
                    </button>
                )}
            </div>
        </section>
    );

    // -------------------------------------------------------------------------
    // Sub-render D: Projector Hero View (Maximized for Classroom Projectors)
    // -------------------------------------------------------------------------
    const renderProjectorHeroView = () => (
        <div className="qr-projector-view">
            <section className="qr-projector-hero-card">
                {/* Giant Digital Clock & Countdown */}
                <div className="qr-projector-clock-wrap">
                    <span className="qr-timeline-label">
                        {phase === "PHASE_1"
                            ? `Phase 1 Check-in Window (0:00–${formatMmSs(qr1TotalSeconds)})`
                            : phase === "PHASE_2"
                                ? `Phase 2 Biometric Window (${formatMmSs(qr1TotalSeconds)}–${formatMmSs(totalDurationSeconds)})`
                                : "Session Window Finished"}
                    </span>
                    <div className="qr-projector-digital-clock">
                        {formatMmSs(elapsedSeconds)} / {formatMmSs(totalDurationSeconds)}
                    </div>
                    {phase !== "CLOSED" && (
                        <div className={`qr-countdown-badge ${phase === "PHASE_1" ? (qr1Remaining > 15 ? "normal" : "urgent") : (sessionRemaining > 20 ? "normal" : "urgent")}`}>
                            <FaClock />
                            <span>
                                {phase === "PHASE_1"
                                    ? `QR 1 Auto-Switches in ${qr1Remaining}s (at ${formatMmSs(qr1TotalSeconds)})`
                                    : `Session unlocks in ${sessionRemaining}s (at ${formatMmSs(totalDurationSeconds)})`}
                            </span>
                        </div>
                    )}
                </div>

                {/* Progress bar */}
                {phase !== "CLOSED" && (
                    <div className="qr-hud-progress-track" style={{ width: "100%", maxWidth: "560px", margin: "0 auto 14px" }}>
                        <div
                            className={`qr-hud-progress-fill ${phase === "PHASE_1" ? "phase-1" : "phase-2"}`}
                            style={{
                                width: `${Math.min(100, Math.max(0, ((totalDurationSeconds - elapsedSeconds) / Math.max(1, totalDurationSeconds)) * 100))}%`
                            }}
                        />
                    </div>
                )}

                {/* In-line Quick Time Adjustments */}
                {phase !== "CLOSED" && (
                    <div className="qr-adjust-pills-bar" style={{ margin: "0 auto 8px" }}>
                        <span className="qr-adjust-label">Time:</span>
                        <button type="button" onClick={() => handleAdjustSessionTime(30)} className="qr-adjust-pill plus" title="Add 30 seconds">+30s</button>
                        <button type="button" onClick={() => handleAdjustSessionTime(60)} className="qr-adjust-pill plus" title="Add 1 minute">+1m</button>
                        <button type="button" onClick={() => handleAdjustSessionTime(120)} className="qr-adjust-pill plus" title="Add 2 minutes">+2m</button>
                        <button type="button" onClick={() => handleAdjustSessionTime(-30)} className="qr-adjust-pill minus" title="Remove 30 seconds">-30s</button>
                        <button type="button" onClick={() => handleAdjustSessionTime(-60)} className="qr-adjust-pill minus" title="Remove 1 minute">-1m</button>
                    </div>
                )}

                {/* Hero QR Canvas */}
                {phase !== "CLOSED" ? (
                    <>
                        <div className={`qr-code-frame cyber-frame qr-projector-hero-frame ${phase === "PHASE_1" ? "phase-1" : "phase-2"}`}>
                            <span className="qr-corner-bracket tl" />
                            <span className="qr-corner-bracket tr" />
                            <span className="qr-corner-bracket bl" />
                            <span className="qr-corner-bracket br" />
                            <QRCodeCanvas
                                value={activeQrUrl || (sessionId ? `${window.location.origin}/student/mark-attendance?session=${encodeURIComponent(sessionId)}` : "https://smart-attendance-ok.web.app")}
                                size={isFullscreen ? 320 : 215}
                            />
                        </div>

                        {/* Dynamic Rotating Token Ticker */}
                        <div style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            padding: "4px 12px",
                            borderRadius: "999px",
                            background: "rgba(99, 102, 241, 0.08)",
                            border: "1px solid rgba(99, 102, 241, 0.2)",
                            marginBottom: "6px",
                            fontSize: "0.76rem",
                            fontWeight: 700,
                            color: "#4338ca"
                        }}>
                            <FaSyncAlt className="fa-spin" style={{ color: "#6366f1", fontSize: "0.72rem" }} />
                            <span>Dynamic QR Token updates in <strong style={{ color: "#ef4444" }}>{rotationSecondsLeft}s</strong> ({rotationIntervalSec}s)</span>
                        </div>

                        {/* Interactive Geofence Live Adjustment Bar */}
                        <div style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: "6px",
                            fontSize: "0.74rem",
                            fontWeight: 700,
                            color: geofenceRadius > 0 ? "#059669" : "#64748b",
                            marginBottom: "8px",
                            flexWrap: "wrap",
                            padding: "4px 12px",
                            borderRadius: "10px",
                            background: geofenceRadius > 0 ? "rgba(16, 185, 129, 0.08)" : "rgba(100, 116, 139, 0.08)",
                            border: geofenceRadius > 0 ? "1px solid rgba(16, 185, 129, 0.25)" : "1px solid rgba(100, 116, 139, 0.2)"
                        }}>
                            <span>
                                {geofenceRadius > 0
                                    ? `📍 Geofence: ${classroomCoords?.radius || geofenceRadius}m Active`
                                    : "📍 Geofence: Disabled"}
                            </span>
                            <div style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
                                {geofenceRadius > 0 && (
                                    <>
                                        <button
                                            type="button"
                                            onClick={() => handleStepGeofenceRadius(-5)}
                                            title="Decrease geofence radius by 5m"
                                            style={{ padding: "2px 6px", borderRadius: "5px", border: "1px solid #cbd5e1", background: "var(--surface, #ffffff)", fontSize: "0.7rem", fontWeight: 800, cursor: "pointer" }}
                                        >
                                            -5m
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleStepGeofenceRadius(5)}
                                            title="Increase geofence radius by 5m"
                                            style={{ padding: "2px 6px", borderRadius: "5px", border: "1px solid #cbd5e1", background: "var(--surface, #ffffff)", fontSize: "0.7rem", fontWeight: 800, cursor: "pointer" }}
                                        >
                                            +5m
                                        </button>
                                    </>
                                )}
                                <button
                                    type="button"
                                    onClick={handlePromptCustomGeofence}
                                    title="Manually type custom metres radius"
                                    style={{ padding: "2px 8px", borderRadius: "5px", border: "1px solid #6366f1", background: "rgba(99, 102, 241, 0.12)", color: "#4f46e5", fontSize: "0.7rem", fontWeight: 750, cursor: "pointer" }}
                                >
                                    ✏️ Custom
                                </button>
                                {geofenceRadius > 0 ? (
                                    <button
                                        type="button"
                                        onClick={() => handleUpdateGeofenceRadius(0)}
                                        title="Disable GPS Geofence enforcement"
                                        style={{ padding: "2px 8px", borderRadius: "5px", border: "1px solid #f87171", background: "rgba(239, 68, 68, 0.1)", color: "#dc2626", fontSize: "0.7rem", fontWeight: 750, cursor: "pointer" }}
                                    >
                                        Disable GPS
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => handleUpdateGeofenceRadius(10)}
                                        title="Enable 10m default geofence"
                                        style={{ padding: "2px 8px", borderRadius: "5px", border: "1px solid #10b981", background: "rgba(16, 185, 129, 0.15)", color: "#059669", fontSize: "0.7rem", fontWeight: 750, cursor: "pointer" }}
                                    >
                                        Enable 10m GPS
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={handleRecalibrateGps}
                                    title="Re-calibrate GPS from current device position"
                                    style={{ padding: "2px 8px", borderRadius: "5px", border: "1px solid #cbd5e1", background: "var(--surface, #ffffff)", color: "#64748b", fontSize: "0.7rem", fontWeight: 700, cursor: "pointer" }}
                                >
                                    🎯 Re-fix GPS
                                </button>
                            </div>
                        </div>

                        {/* Early Switch Button in Phase 1 */}
                        {phase === "PHASE_1" && (
                            <div style={{ marginBottom: "8px" }}>
                                <button
                                    type="button"
                                    onClick={handleForcePhase2}
                                    disabled={isTransitioning}
                                    className="qr-switch-btn"
                                    style={{ maxWidth: "300px", margin: "0 auto", padding: "7px 18px", fontSize: "0.82rem" }}
                                >
                                    <span>⚡ Switch to Phase 2 (QR 2) Early</span>
                                    <FaArrowRight />
                                </button>
                            </div>
                        )}
                    </>
                ) : (
                    <div style={{
                        padding: "20px 16px",
                        borderRadius: "14px",
                        background: "var(--surface-soft, #f1f5f9)",
                        border: "2px dashed var(--border, #cbd5e1)",
                        margin: "10px 0 16px",
                        width: "100%",
                        maxWidth: "460px"
                    }}>
                        <FaCheckDouble style={{ fontSize: "2.4rem", color: "#10b981", marginBottom: "8px" }} />
                        <h3 style={{ margin: "0 0 4px", fontSize: "1.15rem", fontWeight: 800 }}>Attendance Session Completed</h3>
                        <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--text-muted, #64748b)" }}>
                            All student devices have been unlocked from Kiosk mode. Total Present: <strong>{reachedQR2Count || sessionData?.attendanceCount || 0} / {uniqueStudentsList.length}</strong>
                        </p>
                    </div>
                )}

                {/* Hero Stat Ticker */}
                <div className="qr-projector-hero-stats">
                    <div className="qr-hero-kpi">
                        <span className="qr-hero-kpi-val" style={{ color: "#6366f1" }}>{totalScannedQR1}</span>
                        <span className="qr-hero-kpi-label">Checked In (QR1)</span>
                    </div>
                    <div className="qr-hero-kpi">
                        <span className="qr-hero-kpi-val" style={{ color: "#10b981" }}>{reachedQR2Count}</span>
                        <span className="qr-hero-kpi-label">Verified Present</span>
                    </div>
                    <div className="qr-hero-kpi">
                        <span className="qr-hero-kpi-val" style={{ color: "#f59e0b" }}>{pendingQR2Count}</span>
                        <span className="qr-hero-kpi-label">Waiting QR 2</span>
                    </div>
                    <div className="qr-hero-kpi">
                        <span className="qr-hero-kpi-val" style={{ color: violationsCount > 0 ? "#ef4444" : "#64748b" }}>{violationsCount}</span>
                        <span className="qr-hero-kpi-label">Flagged Violations</span>
                    </div>
                </div>

                {/* Projected Notice */}
                <div className="qr-classroom-security-notice" style={{ width: "100%", maxWidth: "620px", margin: "6px auto", padding: "6px 12px" }}>
                    <div className="qr-sec-badge" style={{ fontSize: "0.68rem", padding: "2px 8px" }}>
                        <FaShieldAlt /> Classroom Supervision
                    </div>
                    <p className="qr-sec-text" style={{ fontSize: "0.74rem", lineHeight: 1.35 }}>
                        <strong>⚠️ Notice:</strong> Keep screen awake &amp; remain in SmartAttend until Phase 2 biometric completes. 2 app exits forfeit attendance.
                    </p>
                </div>

                {/* Footer Actions */}
                <div className="qr-action-footer" style={{ marginTop: "8px", paddingTop: "8px", width: "100%", maxWidth: "460px", gap: "8px" }}>
                    <Link to={`/lecturer/attendance-sessions/${sessionId}`} className="qr-view-live-btn" style={{ padding: "7px 14px", fontSize: "0.8rem" }}>
                        <FaUsers /> <span>{phase === "CLOSED" ? "Open Final Register" : "View Live Register"}</span>
                    </Link>
                    {phase !== "CLOSED" && (
                        <button type="button" onClick={handleCopyLink} className="qr-copy-btn" title="Copy active QR URL" style={{ padding: "7px 14px", fontSize: "0.8rem" }}>
                            {copied ? <><FaCheck /> <span>Copied!</span></> : <><FaCopy /> <span>Copy Link</span></>}
                        </button>
                    )}
                    {phase === "CLOSED" && (
                        <button type="button" onClick={handleResetSession} className="qr-reset-btn" style={{ margin: 0, padding: "7px 14px", fontSize: "0.8rem" }}>
                            <FaSyncAlt /> <span>New Session</span>
                        </button>
                    )}
                </div>
            </section>
        </div>
    );

    // -------------------------------------------------------------------------
    // Sub-render E: Split View (Side-by-side Projector HUD + Live Student Roster)
    // -------------------------------------------------------------------------
    const renderSplitView = () => (
        <div className="qrpage-active-split">
            <aside className="qr-active-left-col">
                {renderHudCard()}
            </aside>
            <main className="qr-active-right-col">
                {renderRosterTable(true)}
            </main>
        </div>
    );

    // -------------------------------------------------------------------------
    // Sub-render F: Master Live Session Container (Top Bar + Active View)
    // -------------------------------------------------------------------------
    const renderLiveSessionView = () => (
        <div className="qr-live-session-wrapper">
            {/* Live Command Topbar */}
            <div className="qr-live-topbar">
                <div className="qr-live-topbar-left">
                    <span
                        className="qr-status-dot pulse"
                        style={{ background: phase === "PHASE_1" ? "#6366f1" : phase === "PHASE_2" ? "#10b981" : "#94a3b8" }}
                    />
                    <div className="qr-live-topbar-info">
                        <h2>
                            <span style={{ color: "#4f46e5" }}>{courseCode}</span> Live Attendance · {classCode}{batch ? ` (${batch})` : ""} · Room {roomNo}{" "}
                            <span className="qr-sub-text">({lectureHours || 1.0} hr)</span>
                        </h2>
                        <div className="qr-live-topbar-tags">
                            <span className={`qr-phase-tag ${phase === "PHASE_1" ? "p1" : phase === "PHASE_2" ? "p2" : "closed"}`}>
                                {phase === "PHASE_1"
                                    ? `⚡ Phase 1 (0:00–${formatMmSs(qr1TotalSeconds)}) Check-in`
                                    : phase === "PHASE_2"
                                        ? `🎯 Phase 2 (${formatMmSs(qr1TotalSeconds)}–${formatMmSs(totalDurationSeconds)}) Biometrics`
                                        : "🔒 Session Closed"}
                            </span>
                            <span className="qr-topbar-clock">
                                <FaClock /> {formatMmSs(elapsedSeconds)} / {formatMmSs(totalDurationSeconds)}
                            </span>
                        </div>
                    </div>
                </div>

                {/* View Mode Switcher */}
                <div className="qr-mode-switcher">
                    <button
                        type="button"
                        className={`qr-mode-btn ${liveViewMode === "PROJECTOR" ? "active" : ""}`}
                        onClick={() => setLiveViewMode("PROJECTOR")}
                        title="Maximize QR code & countdown for projector screen"
                    >
                        <FaTv /> <span>Projector</span>
                    </button>
                    <button
                        type="button"
                        className={`qr-mode-btn ${liveViewMode === "SPLIT" ? "active" : ""}`}
                        onClick={() => setLiveViewMode("SPLIT")}
                        title="Side-by-side QR HUD & live student roster"
                    >
                        <FaColumns /> <span>Split View</span>
                    </button>
                    <button
                        type="button"
                        className={`qr-mode-btn ${liveViewMode === "ROSTER" ? "active" : ""}`}
                        onClick={() => setLiveViewMode("ROSTER")}
                        title="Full-width live student attendance roster"
                    >
                        <FaListUl /> <span>Roster ({enrichedStudentsList.length})</span>
                    </button>
                </div>

                {/* Topbar Actions */}
                <div className="qr-live-topbar-actions">
                    {phase !== "CLOSED" && (
                        <div className="qr-pin-pill">
                            <FaLock />
                            <span>PIN: <strong>{showPin ? (sessionPin || "------") : "••••••"}</strong></span>
                            <button
                                type="button"
                                onClick={() => setShowPin((prev) => !prev)}
                                className="qr-pin-mini-toggle"
                                title={showPin ? "Hide PIN" : "View PIN"}
                            >
                                {showPin ? <FaEyeSlash /> : <FaEye />}
                            </button>
                        </div>
                    )}

                    <button
                        type="button"
                        onClick={toggleFullscreen}
                        className={`qr-top-btn ${isFullscreen ? "active" : ""}`}
                        title="Toggle Classroom Fullscreen Projector"
                    >
                        {isFullscreen ? <><FaCompress /> <span>Exit</span></> : <><FaExpand /> <span>Fullscreen</span></>}
                    </button>

                    {phase !== "CLOSED" && (
                        <button
                            type="button"
                            onClick={handleEndSessionAndReleaseAll}
                            className="qr-top-end-btn"
                            title="End session immediately and unlock all student kiosks"
                        >
                            🛑 End Session
                        </button>
                    )}
                </div>
            </div>

            {/* Active Mode Body */}
            {liveViewMode === "PROJECTOR" && renderProjectorHeroView()}
            {liveViewMode === "SPLIT" && renderSplitView()}
            {liveViewMode === "ROSTER" && (
                <div className="qr-roster-fullview">
                    {renderRosterTable(false)}
                </div>
            )}
        </div>
    );

    return (
        <div className={`qrpage ${phase !== "NONE" ? "qrpage-live" : "qrpage-setup"} ${isFullscreen ? "fullscreen-active" : ""}`}>
            {/* Header: Only displayed in Setup Mode. In active live mode, the live command bar serves as the compact, unified header */}
            {phase === "NONE" && (
                <div className="qrpage-header">
                    <div className="qrpage-header-badge">
                        <FaShieldAlt /> 2-Phase Protocol &bull; {formatMmSs(totalDurationSeconds)} Total Window
                    </div>
                    <h1>Create Attendance Session</h1>
                    <p className="qrpage-subtitle">
                        <strong>Phase 1 (0:00–{formatMmSs(qr1TotalSeconds)}):</strong> Check-in &amp; Device Binding &bull; <strong>Phase 2 ({formatMmSs(qr1TotalSeconds)}–{formatMmSs(totalDurationSeconds)}):</strong> Biometric Verification <span className="qr-header-timing-pill">({totalDurationMinutesDisplay}m total)</span>
                    </p>
                </div>
            )}

            {/* Main Stage: Setup Mode vs Live Session */}
            {phase === "NONE" ? renderSetupView() : renderLiveSessionView()}

            {/* 4. Manual Excuse & Add Student Modal */}
            {showManualExcuseModal && (
                <div style={{
                    position: "fixed",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: "rgba(15, 23, 42, 0.65)",
                    backdropFilter: "blur(4px)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: 9999,
                    padding: "16px"
                }}>
                    <div style={{
                        backgroundColor: "#ffffff",
                        borderRadius: "20px",
                        padding: "26px",
                        maxWidth: "460px",
                        width: "100%",
                        boxShadow: "0 20px 40px rgba(0,0,0,0.25)",
                        border: "1px solid #e2e8f0"
                    }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "#10b981" }}>
                                <FaCheckCircle style={{ fontSize: "1.4rem" }} />
                                <h3 style={{ margin: 0, color: "#0f172a", fontSize: "1.2rem", fontWeight: 800 }}>
                                    Excuse &amp; Reinstate Student
                                </h3>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowManualExcuseModal(false)}
                                style={{ background: "none", border: "none", fontSize: "1.2rem", color: "#64748b", cursor: "pointer" }}
                            >
                                <FaTimes />
                            </button>
                        </div>

                        <p style={{ margin: "0 0 16px", fontSize: "0.85rem", color: "#64748b", lineHeight: 1.4 }}>
                            If a student approached you with a valid reason after getting disqualified or missing QR 2, enter their roll number to immediately mark them Present.
                        </p>

                        <form onSubmit={handleManualExcuseSubmit}>
                            <div style={{ marginBottom: "14px" }}>
                                <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                                    Student Roll Number *
                                </label>
                                <input
                                    type="text"
                                    placeholder="e.g. 25BCS108"
                                    value={manualExcuseRoll}
                                    onChange={(e) => setManualExcuseRoll(e.target.value.toUpperCase())}
                                    required
                                    style={{
                                        width: "100%",
                                        padding: "10px 14px",
                                        borderRadius: "10px",
                                        border: "1.5px solid #cbd5e1",
                                        fontSize: "0.95rem",
                                        fontWeight: 700,
                                        boxSizing: "border-box"
                                    }}
                                />
                            </div>

                            <div style={{ marginBottom: "20px" }}>
                                <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                                    Pardon / Excuse Reason
                                </label>
                                <input
                                    type="text"
                                    placeholder="e.g. Accidental app switch excused in class"
                                    value={manualExcuseReason}
                                    onChange={(e) => setManualExcuseReason(e.target.value)}
                                    style={{
                                        width: "100%",
                                        padding: "10px 14px",
                                        borderRadius: "10px",
                                        border: "1.5px solid #cbd5e1",
                                        fontSize: "0.88rem",
                                        boxSizing: "border-box"
                                    }}
                                />
                            </div>

                            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                                <button
                                    type="button"
                                    onClick={() => setShowManualExcuseModal(false)}
                                    disabled={isExcusingManual}
                                    style={{
                                        padding: "10px 16px",
                                        borderRadius: "10px",
                                        border: "1px solid #cbd5e1",
                                        background: "#ffffff",
                                        color: "#475569",
                                        fontWeight: 700,
                                        cursor: "pointer"
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={isExcusingManual}
                                    style={{
                                        padding: "10px 18px",
                                        borderRadius: "10px",
                                        border: "none",
                                        background: "#10b981",
                                        color: "#ffffff",
                                        fontWeight: 700,
                                        cursor: "pointer",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "6px",
                                        boxShadow: "0 4px 12px rgba(16, 185, 129, 0.3)"
                                    }}
                                >
                                    {isExcusingManual ? <FaSpinner className="fa-spin" /> : <FaCheck />}
                                    <span>Reinstate &amp; Mark Present</span>
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

export default GenerateQR;