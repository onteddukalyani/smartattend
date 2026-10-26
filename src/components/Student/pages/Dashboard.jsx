import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import {
    collection,
    doc,
    getDocs,
    setDoc,
    deleteField,
    onSnapshot,
    query,
    where
} from "firebase/firestore";
import {
    FaUserGraduate,
    FaIdCard,
    FaCalendarCheck,
    FaHistory,
    FaSearch,
    FaFileDownload,
    FaCheckCircle,
    FaBookOpen,
    FaClock,
    FaSyncAlt,
    FaTimes,
    FaCamera,
    FaExclamationTriangle,
    FaSpinner,
    FaLock,
    FaTrashAlt,
    FaPercentage,
    FaArrowRight,
    FaEdit,
    FaCheck,
    FaMobileAlt,
    FaFingerprint,
    FaShieldAlt,
    FaKey,
    FaUniversity
} from "react-icons/fa";
import { MdQrCodeScanner } from "react-icons/md";
import { db, functions } from "../../../firebase";
import { useAuth } from "../../authcontext";
import { downloadExcel } from "../../../DownloadExcel";
import { useTableSort, SortIcon } from "../../Common/useTableSort";
import { LiveFaceEnrollment } from "../../Common/LiveFaceEnrollment";
import ProfilePhotoModal from "../../Common/ProfilePhotoModal";
import { removeStudentPhotoOnly } from "../../../utils/biometricManager";
import { registerStudentFace } from "../../../services/faceEnrollmentService";
import { getCandidateRolls, computeStudentMetrics, parseTimestampMillis } from "../studentAttendanceHelper";
import { isGenericName, normalizeBranchName, subscribeToStudentUpdates, PROFILE_UPDATED_EVENT } from "../../../utils/studentDataHelper";
import DeviceOnboardingModal from "../DeviceOnboardingModal";
import StudentReadinessModal from "../StudentReadinessModal";
import RequestReRegistrationModal from "../RequestReRegistrationModal";
import { requestAppNotificationPermissions } from "../../../services/nativeNotificationService";
import { subscribeToStudentNotifications, markNotificationAsRead, sendFacultyNotification, sendStudentNotification, reportUserVerificationComplaint, getTimestampMs } from "../../../services/notificationsService";
import { detectDeviceType, getClientIpAddress, getDeviceDisplayName, isDeviceMatching, isStaffCameraUser } from "../../../utils/deviceDetection";
import { locationFromPosition, isAccurateLocation } from "../../../utils/location";
import { Capacitor } from "@capacitor/core";
import { KioskPlugin } from "../../../plugins/kiosk";
import { checkForAppUpdate, subscribeToAppUpdates, triggerApkDownload } from "../../../services/appUpdateService";
import { dismissAppUpdate, isAppUpdateDismissed } from "../../../utils/appUpdateDismissal";
import { registerStudentDevice } from "../../../services/deviceRegistrationService";
import AppUpdateModal from "../../Common/AppUpdateModal";
import "./Dashboard.css";

export default function StudentDashboard() {
    const { user, profile, updateProfileName, updateProfilePhoto, deleteProfilePhoto } = useAuth();

    const [courses, setCourses] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [search, setSearch] = useState("");

    // Device Onboarding & Setup Modal State
    const [currentDeviceType, setCurrentDeviceType] = useState(() => {
        if (typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.()) {
            return "android";
        }
        try {
            return localStorage.getItem('smartattend_student_device_type') || '';
        } catch (_) {
            return '';
        }
    });
    const [showDeviceModal, setShowDeviceModal] = useState(false);
    const [overlayStatus, setOverlayStatus] = useState({ checked: false, granted: true });
    const [showPermissionsGuide, setShowPermissionsGuide] = useState(false);
    const [showReadinessModal, setShowReadinessModal] = useState(false);

    // Device Mismatch & Reset Request State
    const [requestingReset, setRequestingReset] = useState(false);
    const [resetRequestedMsg, setResetRequestedMsg] = useState("");
    const [clientIpAddress, setClientIpAddress] = useState("");
    const hasDispatchedMismatchAlertRef = useRef(false);

    // Face Biometric Registration Modal State
    const [showFaceModal, setShowFaceModal] = useState(false);
    const [showLockedFaceModal, setShowLockedFaceModal] = useState(false);
    const [showReqModal, setShowReqModal] = useState(false);
    const [reqModalScope, setReqModalScope] = useState("face");
    const [faceSaving, setFaceSaving] = useState(false);
    const [faceSuccessMsg, setFaceSuccessMsg] = useState("");

    // Profile Photo Upload & View State
    const [showPhotoModal, setShowPhotoModal] = useState(false);
    const [photoUploading, setPhotoUploading] = useState(false);
    const [photoSuccessMsg, setPhotoSuccessMsg] = useState("");
    const [photoDeleting, setPhotoDeleting] = useState(false);

    // Edit Name Modal State
    const [showEditNameModal, setShowEditNameModal] = useState(false);
    const [editNameInput, setEditNameInput] = useState("");
    const [savingStudentName, setSavingStudentName] = useState(false);
    const [nameEditError, setNameEditError] = useState("");
    const [nameEditSuccess, setNameEditSuccess] = useState("");

    // Identify primary student roll number
    const emailRoll = (user?.email || "").split("@")[0].trim().toUpperCase();
    const activeRollNo = (profile?.rollNo || emailRoll || "").trim().toUpperCase();
    const cleanEmail = (user?.email || "").toLowerCase().trim();

    const [fetchedStudentData, setFetchedStudentData] = useState(null);
    const [notifications, setNotifications] = useState([]);

    // App Update Reminder State
    const [updateInfo, setUpdateInfo] = useState(null);
    const [showUpdateModal, setShowUpdateModal] = useState(false);
    const [updateDismissed, setUpdateDismissed] = useState(false);

    // Subscribe to App Updates so students are immediately notified of new versions
    useEffect(() => {
        let isMounted = true;
        const applyUpdateInfo = (info) => {
            if (!isMounted) return;
            if (!info?.hasUpdate) {
                setUpdateInfo(null);
                setUpdateDismissed(false);
                return;
            }
            setUpdateInfo(info);
            setUpdateDismissed(!info.isMandatory && isAppUpdateDismissed(info.latestVersion));
        };

        checkForAppUpdate().then((info) => {
            applyUpdateInfo(info);
        }).catch(() => {});

        const unsub = subscribeToAppUpdates((info) => {
            applyUpdateInfo(info);
        });

        return () => {
            isMounted = false;
            if (typeof unsub === "function") unsub();
        };
    }, []);

    // Auto-prompt location & notification access and biometric registration just after logging in
    useEffect(() => {
        const justLoggedIn = sessionStorage.getItem("smartattend_just_logged_in") === "true";
        const sessionPrompted = sessionStorage.getItem("smartattend_readiness_prompted") === "true";

        if (justLoggedIn || !sessionPrompted) {
            if (justLoggedIn) sessionStorage.removeItem("smartattend_just_logged_in");
            sessionStorage.setItem("smartattend_readiness_prompted", "true");

            // Open the readiness setup modal
            setShowReadinessModal(true);

            // Auto-trigger native / browser permission requests
            requestAppNotificationPermissions().catch(() => { });
            if (typeof navigator !== "undefined" && navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        const loc = locationFromPosition(pos);
                        if (loc && isAccurateLocation(loc)) {
                            try {
                                localStorage.setItem('smartattend_student_location', JSON.stringify(loc));
                            } catch (_) { }
                        }
                    },
                    () => {
                        try {
                            navigator.geolocation.getCurrentPosition(
                                (pos) => {
                                    const loc = locationFromPosition(pos);
                                    if (loc) {
                                        try {
                                            localStorage.setItem('smartattend_student_location', JSON.stringify(loc));
                                        } catch (_) { }
                                    }
                                },
                                () => { },
                                { enableHighAccuracy: false, timeout: 6000, maximumAge: 30000 }
                            );
                        } catch (_) { }
                    },
                    { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 }
                );
            }
        }
    }, []);

    // Subscribe to real-time Faculty & Admin notifications
    useEffect(() => {
        if (!activeRollNo && !cleanEmail) return;
        const unsub = subscribeToStudentNotifications(activeRollNo, (newNotifs) => {
            setNotifications(newNotifs || []);
        }, cleanEmail);
        return () => unsub();
    }, [activeRollNo, cleanEmail]);

    // Resolve student profile name & biometrics directly in real-time across all collections
    useEffect(() => {
        if (!activeRollNo) return;

        const unsubs = [];
        const cleanEmail = (user?.email || "").toLowerCase().trim();
        const prevCanonicalStudentDocRef = { current: null };
        const lastChangeNotifiedRef = { current: 0 };

        const handleDocUpdate = (snap, isCanonical = false) => {
            if (snap.exists()) {
                const d = snap.data();

                // Detect genuine database changes made by admin or lecturer only on the canonical students document
                if (isCanonical) {
                    const prev = prevCanonicalStudentDocRef.current;
                    if (prev && Date.now() - lastChangeNotifiedRef.current > 5000) {
                        const changes = [];
                        if (d.name && prev.name && d.name !== prev.name && !isGenericName(d.name, activeRollNo, cleanEmail)) {
                            changes.push(`Name changed to "${d.name}"`);
                        }
                        if (d.branch && prev.branch && d.branch !== prev.branch) {
                            changes.push(`Branch updated to "${d.branch}"`);
                        }
                        if (d.semester !== undefined && prev.semester !== undefined && String(d.semester) !== String(prev.semester)) {
                            changes.push(`Semester changed to ${d.semester}`);
                        }
                        if (d.deviceType !== undefined && prev.deviceType !== undefined && d.deviceType !== prev.deviceType) {
                            changes.push(`Device lock updated to ${d.deviceType ? d.deviceType.toUpperCase() : "Unlocked"}`);
                        }
                        if (d.faceRemovedAt && !prev.faceRemovedAt) {
                            changes.push("Facial biometrics removed");
                        } else if (d.faceRegistered && !prev.faceRegistered) {
                            changes.push("Facial biometrics enrolled");
                        }
                        if ((d.photoRemovedAt && !prev.photoRemovedAt) || (prev.photoURL && !d.photoURL && !d.image)) {
                            changes.push("Profile photo removed");
                        }

                        if (changes.length > 0) {
                            lastChangeNotifiedRef.current = Date.now();
                            sendStudentNotification(
                                activeRollNo,
                                "Account Updated 📝",
                                `Your account information was updated: ${changes.join(" • ")}.`,
                                "PROFILE_UPDATE",
                                "System"
                            ).catch(() => { });
                        }
                    }
                    prevCanonicalStudentDocRef.current = { ...d };
                }

                setFetchedStudentData((prev) => {
                    let resolvedName = prev?.name;
                    if (isGenericName(resolvedName, activeRollNo, cleanEmail) && !isGenericName(d.name, activeRollNo, cleanEmail)) resolvedName = String(d.name).trim();
                    if (isGenericName(resolvedName, activeRollNo, cleanEmail) && !isGenericName(d.fullName, activeRollNo, cleanEmail)) resolvedName = String(d.fullName).trim();
                    if (isGenericName(resolvedName, activeRollNo, cleanEmail) && !isGenericName(d.displayName, activeRollNo, cleanEmail)) resolvedName = String(d.displayName).trim();
                    if (!resolvedName || isGenericName(resolvedName, activeRollNo, cleanEmail)) resolvedName = (!isGenericName(d.name, activeRollNo, cleanEmail) ? d.name : null) || (!isGenericName(d.fullName, activeRollNo, cleanEmail) ? d.fullName : null) || prev?.name || "";

                    const branch = normalizeBranchName(d.branch || prev?.branch || d.department || "CSE");

                    const semester = (d.semester !== undefined && d.semester !== null && String(d.semester).trim() !== "")
                        ? String(d.semester).trim()
                        : (prev?.semester || "1");

                    const isDocDirectlyEnrolled = Boolean(
                        d.faceRegistered === true ||
                        d.biometricEnrolled === true ||
                        d.hasFaceRegistered === true ||
                        d.isRegistered === true ||
                        d.registeredGlobally === true ||
                        d.registrationStatus === "registered" ||
                        (Array.isArray(d.faceDescriptor) && d.faceDescriptor.length === 128) ||
                        (Array.isArray(d.descriptor) && d.descriptor.length === 128)
                    );

                    const isPrevEnrolled = Boolean(
                        prev && (prev.faceRegistered || prev.biometricEnrolled || prev.hasFaceRegistered || prev.isRegistered || prev.registeredGlobally)
                    );

                    const docFaceRemoved = Boolean(
                        !isDocDirectlyEnrolled &&
                        d.faceRemovedAt &&
                        (!d.faceEnrolledAt || d.faceRemovedAt > d.faceEnrolledAt) &&
                        (isCanonical || !isPrevEnrolled)
                    );

                    const hasFace = Boolean(
                        !docFaceRemoved &&
                        (isDocDirectlyEnrolled || isPrevEnrolled)
                    );

                    if (hasFace) {
                        try {
                            if (activeRollNo) {
                                localStorage.setItem(`smartattend_face_enrolled_${activeRollNo}`, "true");
                                localStorage.setItem(`smartattend_registered_${activeRollNo}`, "true");
                            }
                            if (user?.uid) {
                                localStorage.setItem(`smartattend_face_enrolled_${user.uid}`, "true");
                                localStorage.setItem(`smartattend_registered_${user.uid}`, "true");
                            }
                            localStorage.setItem("smartattend_face_enrolled", "true");
                            localStorage.setItem("smartattend_student_face_enrolled", "true");
                            localStorage.setItem("smartattend_registered", "true");
                            localStorage.setItem("smartattend_student_registered", "true");
                        } catch (_) {}
                    } else if (docFaceRemoved) {
                        try {
                            if (activeRollNo) localStorage.removeItem(`smartattend_face_enrolled_${activeRollNo}`);
                            if (user?.uid) localStorage.removeItem(`smartattend_face_enrolled_${user.uid}`);
                            localStorage.removeItem("smartattend_face_enrolled");
                            localStorage.removeItem("smartattend_student_face_enrolled");
                        } catch (_) {}
                    }

                    const isDocHwReset = Boolean(
                        d.deviceResetAt ||
                        d.deviceFingerprintResetAt ||
                        (isCanonical && d.deviceTypeLocked === false && !prev?.deviceTypeLocked) ||
                        (isCanonical && d.isDeviceRegistered === false && !prev?.deviceTypeLocked)
                    );

                    if (isDocHwReset) {
                        try {
                            if (activeRollNo) localStorage.removeItem(`smartattend_hw_enrolled_${activeRollNo}`);
                            if (user?.uid) localStorage.removeItem(`smartattend_hw_enrolled_${user.uid}`);
                            localStorage.removeItem("smartattend_hw_enrolled");
                            localStorage.removeItem("smartattend_student_device_locked");
                            localStorage.removeItem("smartattend_device_locked");
                            localStorage.removeItem("smartattend_student_device_type");
                            localStorage.removeItem("smartattend_device_type");
                            localStorage.removeItem("smartattend_device_registered");
                        } catch (_) {}
                        setCurrentDeviceType("");
                    }

                    const hasHw = !isDocHwReset && Boolean(
                        d.hardwareBiometricEnrolled ||
                        (prev?.hardwareBiometricEnrolled && d.hardwareBiometricEnrolled !== false) ||
                        (activeRollNo && localStorage.getItem(`smartattend_hw_enrolled_${activeRollNo}`) === "true") ||
                        localStorage.getItem("smartattend_hw_enrolled") === "true"
                    );
                    if (hasHw) {
                        try {
                            if (activeRollNo) localStorage.setItem(`smartattend_hw_enrolled_${activeRollNo}`, "true");
                            if (user?.uid) localStorage.setItem(`smartattend_hw_enrolled_${user.uid}`, "true");
                            localStorage.setItem("smartattend_hw_enrolled", "true");
                        } catch (_) {}
                    }

                    return {
                        ...(prev || {}),
                        ...d,
                        name: resolvedName,
                        fullName: resolvedName,
                        branch: branch,
                        semester: semester,
                        photoURL: docFaceRemoved ? "" : (d.photoURL || prev?.photoURL || ""),
                        faceRegistered: hasFace,
                        biometricEnrolled: hasFace,
                        hasFaceRegistered: hasFace,
                        isRegistered: Boolean(hasFace || d.isRegistered || prev?.isRegistered),
                        registeredGlobally: Boolean(hasFace || d.registeredGlobally || prev?.registeredGlobally),
                        registrationStatus: hasFace ? "registered" : (d.registrationStatus || prev?.registrationStatus || "pending"),
                        hardwareBiometricEnrolled: hasHw,
                        deviceTypeLocked: isDocHwReset ? false : (d.deviceTypeLocked ?? prev?.deviceTypeLocked ?? false),
                        deviceType: isDocHwReset ? null : (d.deviceType || prev?.deviceType || null),
                        faceRemovedAt: docFaceRemoved ? (d.faceRemovedAt || Date.now()) : null,
                        faceDescriptor: null,
                        descriptor: null
                    };
                });
            }
        };

        // 1. Listen to students collection (canonical doc)
        unsubs.push(onSnapshot(doc(db, "students", activeRollNo), (snap) => handleDocUpdate(snap, true), (err) => console.warn("student doc snapshot notice:", err)));
        if (activeRollNo.toLowerCase() !== activeRollNo) {
            unsubs.push(onSnapshot(doc(db, "students", activeRollNo.toLowerCase()), (snap) => handleDocUpdate(snap, true), (err) => console.warn("student doc lower snapshot notice:", err)));
        }

        // 2. Listen to users collection (by roll and by user.uid)
        unsubs.push(onSnapshot(doc(db, "users", activeRollNo), (snap) => handleDocUpdate(snap, false), (err) => console.warn("user doc snapshot notice:", err)));
        if (activeRollNo.toLowerCase() !== activeRollNo) {
            unsubs.push(onSnapshot(doc(db, "users", activeRollNo.toLowerCase()), (snap) => handleDocUpdate(snap, false), (err) => console.warn("user doc lower snapshot notice:", err)));
        }
        if (user?.uid && user.uid !== activeRollNo && user.uid !== activeRollNo.toLowerCase()) {
            unsubs.push(onSnapshot(doc(db, "users", user.uid), (snap) => handleDocUpdate(snap, false), (err) => console.warn("user uid snapshot notice:", err)));
        }

        // 3. Listen to authorizedUsers collection
        if (cleanEmail) {
            unsubs.push(onSnapshot(doc(db, "authorizedUsers", cleanEmail), (snap) => handleDocUpdate(snap, false), (err) => console.warn("authUser doc snapshot notice:", err)));
        }

        return () => {
            unsubs.forEach((u) => u && u());
        };
    }, [activeRollNo, user?.email, user?.uid]);

    // Live global listener: reflect biometric or device reset changes across all pages instantly
    useEffect(() => {
        const handleUpdate = (updated) => {
            if (!updated) return;
            const myRoll = (activeRollNo || profile?.rollNo || emailRoll || "").trim().toUpperCase();
            const updatedRoll = String(updated.rollNo || updated.id || "").trim().toUpperCase();
            const updatedEmail = String(updated.email || "").trim().toLowerCase();
            const myEmail = (user?.email || "").trim().toLowerCase();
            const updatedUid = String(updated.uid || updated.studentUid || "");

            const isMatch = (
                (myRoll && updatedRoll && myRoll === updatedRoll) ||
                (myEmail && updatedEmail && myEmail === updatedEmail) ||
                (user?.uid && updatedUid && user.uid === updatedUid)
            );

            if (isMatch) {
                const isFaceReset = Boolean(
                    updated.faceRemovedAt &&
                    (!updated.faceEnrolledAt || updated.faceRemovedAt > updated.faceEnrolledAt)
                );
                setFetchedStudentData((prev) => ({
                    ...(prev || {}),
                    ...updated,
                    faceRegistered: isFaceReset ? false : (updated.faceRegistered ?? prev?.faceRegistered ?? false),
                    biometricEnrolled: isFaceReset ? false : (updated.biometricEnrolled ?? prev?.biometricEnrolled ?? false),
                    hasFaceRegistered: isFaceReset ? false : (updated.hasFaceRegistered ?? prev?.hasFaceRegistered ?? false)
                }));
                if (updated.deviceTypeLocked === false || updated.deviceResetAt) {
                    setCurrentDeviceType("");
                }
            }
        };

        const unsub = subscribeToStudentUpdates(handleUpdate);
        const handleProfileEvent = (e) => {
            if (e && e.detail) handleUpdate(e.detail);
        };
        window.addEventListener(PROFILE_UPDATED_EVENT, handleProfileEvent);

        return () => {
            unsub();
            window.removeEventListener(PROFILE_UPDATED_EVENT, handleProfileEvent);
        };
    }, [activeRollNo, profile?.rollNo, emailRoll, user?.email, user?.uid]);

    const studentName = fetchedStudentData?.name || profile?.name || activeRollNo || "Student";
    const rawBranch = fetchedStudentData?.branch || profile?.branch || fetchedStudentData?.department || profile?.department;
    const studentBranch = normalizeBranchName(rawBranch || "CSE");
    const studentSemester = (fetchedStudentData?.semester !== undefined && fetchedStudentData?.semester !== null && String(fetchedStudentData?.semester).trim() !== "")
        ? String(fetchedStudentData.semester).trim()
        : (profile?.semester ? String(profile.semester).trim() : "1");

    const isEnrolledFlagPresent = Boolean(
        fetchedStudentData?.faceRegistered || fetchedStudentData?.biometricEnrolled || fetchedStudentData?.hasFaceRegistered ||
        fetchedStudentData?.isRegistered || fetchedStudentData?.registeredGlobally || fetchedStudentData?.registrationStatus === "registered" ||
        (Array.isArray(fetchedStudentData?.faceDescriptor) && fetchedStudentData.faceDescriptor.length === 128) ||
        profile?.faceRegistered || profile?.biometricEnrolled || profile?.hasFaceRegistered ||
        profile?.isRegistered || profile?.registeredGlobally || profile?.registrationStatus === "registered" ||
        (activeRollNo && localStorage.getItem(`smartattend_face_enrolled_${activeRollNo}`) === "true") ||
        (user?.uid && localStorage.getItem(`smartattend_face_enrolled_${user.uid}`) === "true") ||
        localStorage.getItem("smartattend_face_enrolled") === "true" ||
        localStorage.getItem("smartattend_student_face_enrolled") === "true" ||
        localStorage.getItem("smartattend_registered") === "true" ||
        localStorage.getItem("smartattend_student_registered") === "true" ||
        (activeRollNo && localStorage.getItem(`smartattend_registered_${activeRollNo}`) === "true")
    );

    const profileFaceRemoved = Boolean(
        !isEnrolledFlagPresent &&
        profile?.faceRemovedAt &&
        (!profile?.faceEnrolledAt || profile.faceRemovedAt > profile.faceEnrolledAt)
    );
    const fetchedFaceRemoved = Boolean(
        !isEnrolledFlagPresent &&
        fetchedStudentData?.faceRemovedAt &&
        (!fetchedStudentData?.faceEnrolledAt || fetchedStudentData.faceRemovedAt > fetchedStudentData.faceEnrolledAt)
    );
    const hasRemoval = profileFaceRemoved || fetchedFaceRemoved;

    if (hasRemoval && typeof window !== "undefined") {
        try {
            localStorage.removeItem("smartattend_face_enrolled");
            if (activeRollNo) localStorage.removeItem(`smartattend_face_enrolled_${activeRollNo}`);
            if (user?.uid) localStorage.removeItem(`smartattend_face_enrolled_${user.uid}`);
        } catch (_) {}
    }

    const hasFaceRegistered = !hasRemoval && isEnrolledFlagPresent;

    const isDeviceReset = Boolean(
        (fetchedStudentData?.deviceResetAt && (!fetchedStudentData?.deviceSelectedAt || fetchedStudentData.deviceResetAt > fetchedStudentData.deviceSelectedAt)) ||
        (profile?.deviceResetAt && (!profile?.deviceSelectedAt || profile.deviceResetAt > profile.deviceSelectedAt)) ||
        (fetchedStudentData?.deviceFingerprintResetAt && (!fetchedStudentData?.platformBoundAt || fetchedStudentData.deviceFingerprintResetAt > fetchedStudentData.platformBoundAt)) ||
        (profile?.deviceFingerprintResetAt && (!profile?.platformBoundAt || profile.deviceFingerprintResetAt > profile.platformBoundAt))
    );

    if (isDeviceReset && typeof window !== "undefined") {
        try {
            localStorage.removeItem("smartattend_student_device_locked");
            localStorage.removeItem("smartattend_device_locked");
            localStorage.removeItem("smartattend_student_device_type");
            localStorage.removeItem("smartattend_device_type");
            localStorage.removeItem("smartattend_device_registered");
            localStorage.removeItem("smartattend_hw_enrolled");
            if (activeRollNo) localStorage.removeItem(`smartattend_hw_enrolled_${activeRollNo}`);
            if (user?.uid) localStorage.removeItem(`smartattend_hw_enrolled_${user.uid}`);
            localStorage.removeItem("smartattend_fingerprint_enrolled");
        } catch (_) {}
    }

    const hasHwRegistered = !isDeviceReset && Boolean(
        fetchedStudentData?.hardwareBiometricEnrolled ||
        profile?.hardwareBiometricEnrolled ||
        (activeRollNo && localStorage.getItem(`smartattend_hw_enrolled_${activeRollNo}`) === "true") ||
        (user?.uid && localStorage.getItem(`smartattend_hw_enrolled_${user.uid}`) === "true") ||
        localStorage.getItem("smartattend_hw_enrolled") === "true" ||
        localStorage.getItem("smartattend_fingerprint_enrolled") === "true"
    );

    const isRegisteredGlobally = Boolean(
        hasFaceRegistered ||
        fetchedStudentData?.isRegistered ||
        fetchedStudentData?.registeredGlobally ||
        fetchedStudentData?.registrationStatus === "registered" ||
        profile?.isRegistered ||
        profile?.registeredGlobally ||
        profile?.registrationStatus === "registered" ||
        (activeRollNo && localStorage.getItem(`smartattend_registered_${activeRollNo}`) === "true") ||
        localStorage.getItem("smartattend_registered") === "true" ||
        localStorage.getItem("smartattend_student_registered") === "true"
    );

    const isDualBioRegistered = (hasFaceRegistered || isRegisteredGlobally) && hasHwRegistered;
    const isStaff = isStaffCameraUser(profile, user);
    const [reRegPermission, setReRegPermission] = useState(null);

    // Live subscription to student re-registration permissions granted by lecturer/admin
    useEffect(() => {
        if (!activeRollNo) return;
        const unsubPerm = onSnapshot(doc(db, "biometric_reregistration_permissions", activeRollNo), (snap) => {
            if (snap.exists()) {
                setReRegPermission(snap.data());
            } else {
                setReRegPermission(null);
            }
        }, () => {});
        return () => unsubPerm();
    }, [activeRollNo]);

    const isPermActive = Boolean(
        reRegPermission &&
        reRegPermission.status === "active" &&
        (reRegPermission.remainingUses === undefined || reRegPermission.remainingUses === null || reRegPermission.remainingUses > 0) &&
        (!reRegPermission.expiresAt || reRegPermission.expiresAt > Date.now())
    );

    const canReEnrollFace = isStaff || !hasFaceRegistered || (
        isPermActive && (reRegPermission.registrationType === "face" || reRegPermission.registrationType === "both")
    );

    // Device Resolution & Mismatch Guard
    const registeredDevice = isDeviceReset ? null : (fetchedStudentData?.deviceType || fetchedStudentData?.registeredDeviceType || profile?.deviceType || profile?.registeredDeviceType || currentDeviceType);
    const detectedPlatform = detectDeviceType();
    const isDeviceMismatch = Boolean(!isDeviceReset && registeredDevice && !isDeviceMatching(registeredDevice, detectedPlatform));

    // Fetch Client IP on Mount
    useEffect(() => {
        getClientIpAddress().then((ip) => {
            if (ip) setClientIpAddress(ip);
        }).catch(() => { });
    }, []);

    // Auto-detect native Android & sync Firestore device preference
    useEffect(() => {
        if (isDeviceReset) {
            try {
                localStorage.removeItem('smartattend_student_device_locked');
                localStorage.removeItem('smartattend_device_locked');
                localStorage.removeItem('smartattend_student_device_type');
                localStorage.removeItem('smartattend_device_type');
                localStorage.removeItem('smartattend_device_registered');
                localStorage.removeItem('smartattend_hw_enrolled');
                if (activeRollNo) localStorage.removeItem(`smartattend_hw_enrolled_${activeRollNo}`);
                if (user?.uid) localStorage.removeItem(`smartattend_hw_enrolled_${user.uid}`);
                localStorage.removeItem('smartattend_fingerprint_enrolled');
            } catch (_) { }
            setCurrentDeviceType(null);
            return;
        }

        if (Capacitor.isNativePlatform()) {
            try {
                localStorage.setItem('smartattend_student_device_type', 'android');
                localStorage.setItem('smartattend_student_device_locked', 'true');
                setCurrentDeviceType('android');
                setShowDeviceModal(false);
            } catch (_) { }

            // Authoritatively persist native Android device binding to database
            if (activeRollNo || user?.uid) {
                registerStudentDevice({
                    rollNo: activeRollNo,
                    user,
                    profile,
                    platform: 'android',
                    ip: clientIpAddress
                }).catch((err) => console.warn("Native device registration sync notice:", err));
            }

            KioskPlugin.canDrawOverlays().then((res) => {
                setOverlayStatus({ checked: true, granted: res?.canDrawOverlays === true });
            }).catch(() => { });
            return;
        }

        const regType = fetchedStudentData?.deviceType || profile?.deviceType || fetchedStudentData?.registeredDeviceType;
        if (regType) {
            try {
                localStorage.setItem('smartattend_student_device_type', regType);
                if (fetchedStudentData?.deviceTypeLocked || profile?.deviceTypeLocked) {
                    localStorage.setItem('smartattend_student_device_locked', 'true');
                }
                setCurrentDeviceType(regType);
                setShowDeviceModal(false);
            } catch (_) { }
        }
    }, [activeRollNo, user, profile, clientIpAddress, fetchedStudentData?.deviceType, profile?.deviceType, fetchedStudentData?.registeredDeviceType, isDeviceReset]);

    // Proactively alert Faculty & Student if device mismatch is detected
    useEffect(() => {
        if (isDeviceMismatch && activeRollNo && !hasDispatchedMismatchAlertRef.current) {
            hasDispatchedMismatchAlertRef.current = true;
            const regLabel = getDeviceDisplayName(registeredDevice);
            const curLabel = getDeviceDisplayName(detectedPlatform || "web");

            // 1. Alert Faculty & Admins in real-time
            sendFacultyNotification(
                `🚨 Anti-Proxy Alert: Device Mismatch for ${studentName} (${activeRollNo})`,
                `Student ${studentName} (${activeRollNo}) is registered as ${regLabel}, but currently accessed Dashboard from ${curLabel} (IP: ${clientIpAddress || 'Detected'}). Attendance QR scan will be blocked until device lock is reset.`,
                "DEVICE_MISMATCH_SECURITY_ALERT",
                activeRollNo,
                "Anti-Proxy Sentinel"
            ).catch(() => { });

            // 2. Alert Student in real-time
            sendStudentNotification(
                activeRollNo,
                "⚠️ Different Phone Detected",
                `Your account is linked to a ${regLabel}, but you are using a ${curLabel}. If this is your new phone, tap 'Request Admin to Reset Device' below to request an update.`,
                "SECURITY_ALERT",
                "Attendance Security"
            ).catch(() => { });
        }
    }, [isDeviceMismatch, activeRollNo, registeredDevice, detectedPlatform, studentName, clientIpAddress]);

    // Student Device Reset Request Handler
    const handleRequestDeviceReset = async () => {
        setRequestingReset(true);
        try {
            let clientIp = clientIpAddress;
            if (!clientIp) {
                try { clientIp = await getClientIpAddress(); } catch (_) { }
            }
            const regLabel = getDeviceDisplayName(registeredDevice);
            const curLabel = getDeviceDisplayName(detectedPlatform || "web");

            await sendFacultyNotification(
                `📱 Device Reset Request from ${studentName} (${activeRollNo})`,
                `Student ${studentName} (${activeRollNo}) has submitted a device registration reset request.\n• Registered Device: ${regLabel}\n• Current Device Detected: ${curLabel}\n• Client IP: ${clientIp || 'Unknown'}\n• User-Agent: ${navigator.userAgent}\n\nClick "Approve Device Reset" below to unlock student's device.`,
                "DEVICE_RESET_REQUEST",
                activeRollNo,
                studentName,
                {
                    actionable: true,
                    actionType: "RESET_DEVICE",
                    studentRollNo: activeRollNo,
                    detectedPlatform,
                    registeredDevice
                },
                "faculty"
            );

            await reportUserVerificationComplaint(
                { email: user?.email, rollNo: activeRollNo, name: studentName },
                `Student submitted Device Reset Request: Registered as ${regLabel}, currently on ${curLabel} (IP: ${clientIp || 'Unknown'})`,
                "STUDENT_DASHBOARD_RESET_REQUEST"
            );

            await sendStudentNotification(
                activeRollNo,
                "Phone Reset Request Sent 📨",
                `Your request to register your new phone has been sent to your teachers and administrators. You will be able to set up your new phone once approved.`,
                "DEVICE_REQUEST",
                "System Support"
            );

            setResetRequestedMsg("✅ Reset Request Sent! Faculty & Admins have been notified to unlock your device.");
            setTimeout(() => setResetRequestedMsg(""), 6000);
        } catch (err) {
            console.error("Error submitting device reset request:", err);
            alert("Failed to submit reset request: " + err.message);
        } finally {
            setRequestingReset(false);
        }
    };

    // Build candidate roll numbers to guarantee matching
    const candidateRolls = useMemo(() => {
        return getCandidateRolls(user, profile, fetchedStudentData);
    }, [user, profile, fetchedStudentData]);

    // 1. Real-time Courses listener
    useEffect(() => {
        const unsubscribeCourses = onSnapshot(
            collection(db, "courses"),
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
                setCourses(list);
            },
            (err) => console.warn("Error listening to courses:", err)
        );
        return () => unsubscribeCourses();
    }, []);

    // 2. Real-time Sessions listener
    useEffect(() => {
        const unsubscribeSessions = onSnapshot(
            collection(db, "attendance_sessions"),
            (snapshot) => {
                const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
                setSessions(list);
            },
            (err) => console.warn("Error listening to sessions:", err)
        );
        return () => unsubscribeSessions();
    }, []);

    // Ensure student device is cleanly unlocked from any leftover kiosk session when viewing dashboard
    useEffect(() => {
        try {
            const kioskState = localStorage.getItem("smartattend_kiosk_session_state");
            if (!kioskState) {
                import("../../../plugins/kiosk").then(({ Kiosk }) => {
                    Kiosk.stopKioskMode().catch(() => {});
                    Kiosk.clearAttendanceRestrictions().catch(() => {});
                }).catch(() => {});
            }
        } catch (_) {}
    }, []);

    // 3. Real-time Attendance Records listener (Dual listen by studentUid AND candidate roll numbers with clean sub-map tracking)
    useEffect(() => {
        if (!user?.uid && (!candidateRolls || candidateRolls.length === 0)) {
            return;
        }

        const unsubs = [];
        const uidMap = new Map();
        const rollMap = new Map();

        const emitMergedRecords = () => {
            const merged = new Map([...uidMap, ...rollMap]);
            const list = Array.from(merged.values());
            setRecords(list);
            setLoading(false);
            setRefreshing(false);
        };

        if (user?.uid) {
            const qUid = query(collection(db, "attendance_records"), where("studentUid", "==", user.uid));
            unsubs.push(onSnapshot(qUid, (snapshot) => {
                uidMap.clear();
                snapshot.docs.forEach((d) => uidMap.set(d.id, { id: d.id, ...d.data() }));
                emitMergedRecords();
            }, (err) => {
                console.warn("UID records listener notice:", err);
                emitMergedRecords();
            }));
        }

        const rollsToQuery = (candidateRolls || []).slice(0, 10).filter(Boolean);
        if (rollsToQuery.length > 0) {
            const qRoll = query(collection(db, "attendance_records"), where("rollNo", "in", rollsToQuery));
            unsubs.push(onSnapshot(qRoll, (snapshot) => {
                rollMap.clear();
                snapshot.docs.forEach((d) => rollMap.set(d.id, { id: d.id, ...d.data() }));
                emitMergedRecords();
            }, (err) => {
                console.warn("Roll records listener notice:", err);
                emitMergedRecords();
            }));
        }

        return () => unsubs.forEach((u) => { try { u(); } catch (_) { } });
    }, [user?.uid, candidateRolls]);

    // Native-feel pull-to-refresh touch listener for Android & mobile WebView
    const touchStartRef = useRef(0);
    const [pullDistance, setPullDistance] = useState(0);

    const handleTouchStart = (e) => {
        if (typeof window !== "undefined" && (window.scrollY === 0 || document.documentElement.scrollTop === 0)) {
            touchStartRef.current = e.touches[0].clientY;
        } else {
            touchStartRef.current = 0;
        }
    };

    const handleTouchMove = (e) => {
        if (touchStartRef.current > 0 && (window.scrollY === 0 || document.documentElement.scrollTop === 0)) {
            const currentY = e.touches[0].clientY;
            const diff = currentY - touchStartRef.current;
            if (diff > 0 && diff < 120) {
                setPullDistance(diff);
            }
        }
    };

    const handleTouchEnd = () => {
        if (pullDistance > 60 && !refreshing) {
            handleManualRefresh();
        }
        touchStartRef.current = 0;
        setPullDistance(0);
    };

    // Manual Refresh Handler: Re-syncs courses, active attendance sessions, and student records
    const handleManualRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            const [coursesSnap, sessionsSnap, uidRecordsSnap, rollRecordsSnap] = await Promise.all([
                getDocs(collection(db, "courses")).catch(() => ({ docs: [] })),
                getDocs(collection(db, "attendance_sessions")).catch(() => ({ docs: [] })),
                user?.uid
                    ? getDocs(query(collection(db, "attendance_records"), where("studentUid", "==", user.uid))).catch(() => ({ docs: [] }))
                    : Promise.resolve({ docs: [] }),
                (candidateRolls && candidateRolls.length > 0)
                    ? getDocs(query(collection(db, "attendance_records"), where("rollNo", "in", candidateRolls.slice(0, 10)))).catch(() => ({ docs: [] }))
                    : Promise.resolve({ docs: [] })
            ]);

            setCourses(coursesSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
            setSessions(sessionsSnap.docs.map((d) => ({ id: d.id, ...d.data() })));

            // Merge and deduplicate records by ID
            const recMap = new Map();
            [...uidRecordsSnap.docs, ...rollRecordsSnap.docs].forEach((d) => {
                recMap.set(d.id, { id: d.id, ...d.data() });
            });
            setRecords(Array.from(recMap.values()));
        } catch (err) {
            console.error("Manual refresh error:", err);
        } finally {
            setRefreshing(false);
        }
    }, [user?.uid, candidateRolls]);

    // Auto-refresh when student returns to app on Android native or refocused in browser
    useEffect(() => {
        let appStateHandle = null;
        if (typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.()) {
            import("@capacitor/app").then(({ App: CapApp }) => {
                CapApp.addListener("appStateChange", ({ isActive }) => {
                    if (isActive) {
                        console.log("[Dashboard] Foreground resume detected on Android — auto-syncing sessions & attendance...");
                        handleManualRefresh();
                    }
                }).then((handle) => {
                    appStateHandle = handle;
                });
            }).catch(() => { });
        }

        const handleVisibilityChange = () => {
            if (!document.hidden && document.visibilityState === "visible") {
                handleManualRefresh();
            }
        };

        const handleWindowFocus = () => {
            handleManualRefresh();
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        window.addEventListener("focus", handleWindowFocus);

        return () => {
            if (appStateHandle?.remove) appStateHandle.remove();
            document.removeEventListener("visibilitychange", handleVisibilityChange);
            window.removeEventListener("focus", handleWindowFocus);
        };
    }, [handleManualRefresh]);

    // Unified metrics computation
    const metrics = useMemo(() => {
        return computeStudentMetrics(courses, sessions, records, {
            branch: studentBranch,
            semester: studentSemester,
            candidateRolls,
            rollNo: activeRollNo,
            email: user?.email
        });
    }, [courses, sessions, records, studentBranch, studentSemester, candidateRolls, activeRollNo, user?.email]);

    // Initial Face Biometric Enrollment Handler (Student Side)
    const handleEnrollStudentFace = async (enrollData) => {
        if (!enrollData || !enrollData.faceDescriptor || !activeRollNo) return;

        if (hasFaceRegistered && !canReEnrollFace) {
            alert("🔒 Biometrics Locked:\n\nYour facial biometrics are already enrolled and permanently protected. Students cannot re-enroll or edit biometrics without an authorized pass.\n\nPlease contact your Course Lecturer or Administrator if a re-registration pass is needed.");
            return;
        }

        try {
            setFaceSaving(true);
            const rawVector = enrollData.faceDescriptor;
            const cleanVector = Array.isArray(rawVector) ? rawVector : Array.from(rawVector);
            await registerStudentFace(activeRollNo, cleanVector);

            setFetchedStudentData((prev) => ({
                ...(prev || {}),
                faceRegistered: true,
                biometricEnrolled: true,
                hasFaceRegistered: true,
                faceRemovedAt: null
            }));

            sendFacultyNotification(
                "Face Biometrics Enrolled 👤",
                `Student ${studentName} (${activeRollNo}) registered facial biometrics via live 3D face verification.`,
                "BIOMETRIC_UPDATE",
                activeRollNo,
                studentName
            ).catch(() => { });

            setFaceSuccessMsg("✅ Face biometrics registered successfully! You can now mark attendance.");
            setTimeout(() => {
                setShowFaceModal(false);
                setFaceSuccessMsg("");
            }, 2000);
        } catch (err) {
            console.error("Error saving student face:", err);
            alert("Failed to save face biometrics: " + err.message);
        } finally {
            setFaceSaving(false);
        }
    };

    // Profile Photo Update
    const handleProfilePhotoUpload = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            alert("Please upload a valid image file (PNG, JPG, JPEG, WEBP).");
            return;
        }

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                setPhotoUploading(true);
                const img = new Image();
                img.src = event.target.result;
                img.onload = async () => {
                    const canvas = document.createElement("canvas");
                    const MAX_DIM = 400;
                    let width = img.width;
                    let height = img.height;
                    if (width > height) {
                        if (width > MAX_DIM) {
                            height = Math.round((height * MAX_DIM) / width);
                            width = MAX_DIM;
                        }
                    } else {
                        if (height > MAX_DIM) {
                            width = Math.round((width * MAX_DIM) / height);
                            height = MAX_DIM;
                        }
                    }
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(img, 0, 0, width, height);
                    const compressedDataUrl = canvas.toDataURL("image/jpeg", 0.85);

                    await updateProfilePhoto(compressedDataUrl);

                    setFetchedStudentData((prev) => ({
                        ...(prev || {}),
                        photoURL: compressedDataUrl,
                        photo: compressedDataUrl,
                        image: compressedDataUrl
                    }));

                    setPhotoSuccessMsg("✅ Profile photo updated successfully!");
                    setTimeout(() => setPhotoSuccessMsg(""), 3000);
                };
            } catch (err) {
                console.error("Error updating profile photo:", err);
                alert("Failed to update profile photo: " + err.message);
            } finally {
                setPhotoUploading(false);
            }
        };
        reader.readAsDataURL(file);
    };

    const handleDeleteProfilePhoto = async () => {
        const confirm = window.confirm("Are you sure you want to remove your profile photo?");
        if (!confirm) return;

        try {
            setPhotoDeleting(true);
            await deleteProfilePhoto();
            await removeStudentPhotoOnly({ rollNo: activeRollNo, email: user?.email });
            setFetchedStudentData((prev) => ({
                ...(prev || {}),
                photoURL: "",
                image: "",
                photo: ""
            }));
            setPhotoSuccessMsg("🗑️ Profile photo removed!");
            setTimeout(() => setPhotoSuccessMsg(""), 3000);
        } catch (err) {
            console.error("Error removing photo:", err);
            alert("Failed to remove photo: " + err.message);
        } finally {
            setPhotoDeleting(false);
        }
    };

    // Filtered records for table
    const filteredRecords = useMemo(() => {
        const term = search.toLowerCase().trim();
        if (!term) return metrics.enrichedRecords;
        return metrics.enrichedRecords.filter((r) => {
            return (
                (r.courseCode || "").toLowerCase().includes(term) ||
                (r.classCode || "").toLowerCase().includes(term) ||
                (r.roomNo || "").toLowerCase().includes(term) ||
                (r.rollNo || "").toLowerCase().includes(term) ||
                (r.lecturerName || "").toLowerCase().includes(term)
            );
        });
    }, [metrics.enrichedRecords, search]);

    // Sorting
    const { sortedItems: sortedRecords, sortConfig, requestSort } = useTableSort(filteredRecords, "submittedAt", "desc");

    const handleExport = () => {
        downloadExcel(
            "student-attended-table",
            `${activeRollNo || "Student"}_My_Attendance_${new Date().toISOString().slice(0, 10)}`
        );
    };

    return (
        <div
            className="student-dashboard"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
        >
            {/* Mobile Pull-to-Refresh Indicator */}
            {(pullDistance > 0 || refreshing) && (
                <div style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                    padding: "10px 16px",
                    background: "rgba(99, 102, 241, 0.08)",
                    color: "#4f46e5",
                    fontWeight: 700,
                    fontSize: "0.85rem",
                    borderRadius: "12px",
                    marginBottom: "14px",
                    transition: "all 0.2s ease",
                    border: "1px solid rgba(99, 102, 241, 0.2)"
                }}>
                    <FaSyncAlt className={refreshing ? "fa-spin" : ""} style={{ transform: refreshing ? "none" : `rotate(${pullDistance * 3}deg)` }} />
                    <span>{refreshing ? "Refreshing sessions & records..." : (pullDistance > 60 ? "Release to refresh..." : "Pull down to refresh")}</span>
                </div>
            )}

            {/* 0. Student App Update Reminder Banner */}
            {updateInfo && updateInfo.hasUpdate && (!updateDismissed || updateInfo.isMandatory) && (
                <div
                    className="student-update-reminder-banner"
                    style={{
                        margin: "0 0 20px 0",
                        padding: "16px 20px",
                        background: "linear-gradient(135deg, rgba(79, 70, 229, 0.12) 0%, rgba(147, 51, 234, 0.12) 100%)",
                        border: "1.5px solid rgba(99, 102, 241, 0.5)",
                        borderRadius: "18px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: "14px",
                        boxShadow: "0 8px 24px rgba(99, 102, 241, 0.12)",
                        position: "relative"
                    }}
                >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: "14px", minWidth: 0, flex: "1 1 300px" }}>
                        <div style={{
                            width: "44px",
                            height: "44px",
                            borderRadius: "12px",
                            background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                            color: "#ffffff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "1.25rem",
                            flexShrink: 0,
                            boxShadow: "0 4px 12px rgba(99, 102, 241, 0.3)"
                        }}>
                            <FaSyncAlt />
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <span style={{ fontWeight: 800, fontSize: "1rem", color: "var(--text-main, #0f172a)" }}>
                                    🚀 SmartAttend Update Available
                                </span>
                                <span style={{
                                    background: "#4f46e5",
                                    color: "#ffffff",
                                    fontSize: "0.72rem",
                                    padding: "2px 8px",
                                    borderRadius: "999px",
                                    fontWeight: 800
                                }}>
                                    v{updateInfo.latestVersion}
                                </span>
                                {updateInfo.isMandatory && (
                                    <span style={{
                                        background: "#ef4444",
                                        color: "#ffffff",
                                        fontSize: "0.72rem",
                                        padding: "2px 8px",
                                        borderRadius: "999px",
                                        fontWeight: 800
                                    }}>
                                        MANDATORY
                                    </span>
                                )}
                            </div>
                            <p style={{ margin: "4px 0 0", fontSize: "0.84rem", color: "var(--text-muted, #64748b)", lineHeight: 1.4 }}>
                                {updateInfo.releaseNotes?.[0] || "A fresh update with camera, biometric face verification & geofence improvements is ready."}
                            </p>
                        </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                        <button
                            type="button"
                            onClick={() => setShowUpdateModal(true)}
                            style={{
                                background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
                                color: "#ffffff",
                                border: "none",
                                borderRadius: "10px",
                                padding: "9px 18px",
                                fontWeight: 800,
                                fontSize: "0.85rem",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                boxShadow: "0 4px 12px rgba(79, 70, 229, 0.35)",
                                transition: "all 0.15s ease"
                            }}
                        >
                            <FaFileDownload /> Update App Now
                        </button>
                        {!updateInfo.isMandatory && (
                            <button
                                type="button"
                                onClick={() => {
                                    dismissAppUpdate(updateInfo.latestVersion);
                                    setUpdateDismissed(true);
                                    setShowUpdateModal(false);
                                }}
                                title="Dismiss reminder for now"
                                style={{
                                    background: "transparent",
                                    border: "1px solid var(--border, #cbd5e1)",
                                    borderRadius: "10px",
                                    padding: "9px 12px",
                                    color: "var(--text-muted, #64748b)",
                                    fontWeight: 700,
                                    fontSize: "0.82rem",
                                    cursor: "pointer"
                                }}
                            >
                                <FaTimes />
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* 1. Student Hero Profile Banner */}
            <div className="student-hero-banner">
                <div className="student-hero-main">
                    <div className="student-hero-avatar-wrap" style={{ position: "relative", flexShrink: 0 }}>
                        {(() => {
                            const hasActivePhoto = Boolean(
                                fetchedStudentData?.photoURL ||
                                (fetchedStudentData === null && (profile?.photoURL || user?.photoURL))
                            );
                            const photoSrc = fetchedStudentData?.photoURL || (fetchedStudentData === null ? (profile?.photoURL || user?.photoURL) : "");

                            return (
                                <>
                                    <div
                                        className="student-hero-avatar"
                                        onClick={() => setShowPhotoModal(true)}
                                        title="Click to view full-size profile photo"
                                        style={{
                                            overflow: "hidden",
                                            background: hasActivePhoto && photoSrc ? "#0f172a" : "linear-gradient(135deg, var(--accent, #6366f1), #4338ca)",
                                            cursor: "pointer"
                                        }}
                                    >
                                        {hasActivePhoto && photoSrc ? (
                                            <img
                                                src={photoSrc}
                                                alt={studentName}
                                                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                                            />
                                        ) : (
                                            studentName.charAt(0).toUpperCase()
                                        )}
                                    </div>

                                    {/* Profile Photo Actions */}
                                    <div style={{ position: "absolute", bottom: "-4px", right: "-6px", display: "flex", gap: "4px", alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                                        {hasActivePhoto && (
                                            <button
                                                type="button"
                                                className="student-avatar-delete-btn"
                                                title="Delete Profile Photo"
                                                onClick={handleDeleteProfilePhoto}
                                                disabled={photoDeleting}
                                                style={{
                                                    background: "#ef4444",
                                                    color: "#ffffff",
                                                    width: "24px",
                                                    height: "24px",
                                                    borderRadius: "50%",
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    cursor: photoDeleting ? "wait" : "pointer",
                                                    boxShadow: "0 2px 8px rgba(239, 68, 68, 0.4)",
                                                    fontSize: "10px",
                                                    border: "2px solid var(--surface, #ffffff)",
                                                    transition: "transform 0.15s ease"
                                                }}
                                            >
                                                {photoDeleting ? <FaSpinner className="fa-spin" /> : <FaTrashAlt />}
                                            </button>
                                        )}

                                        <label
                                            className="student-avatar-upload-btn"
                                            title="Upload / Change Profile Photo"
                                            style={{
                                                background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                                                color: "#ffffff",
                                                width: "26px",
                                                height: "26px",
                                                borderRadius: "50%",
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                cursor: photoUploading ? "wait" : "pointer",
                                                boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
                                                fontSize: "11px",
                                                border: "2px solid var(--surface, #ffffff)",
                                                transition: "transform 0.15s ease"
                                            }}
                                        >
                                            {photoUploading ? <FaSpinner className="fa-spin" /> : <FaCamera />}
                                            <input
                                                type="file"
                                                accept="image/*"
                                                onChange={handleProfilePhotoUpload}
                                                disabled={photoUploading}
                                                style={{ display: "none" }}
                                            />
                                        </label>
                                    </div>
                                </>
                            );
                        })()}
                    </div>

                    <div className="student-hero-info">
                        <div className="student-hero-title-row">
                            <h1 className="student-hero-welcome-title">Welcome, {studentName} 👋</h1>
                        </div>

                        {photoSuccessMsg && (
                            <div className="student-hero-toast success">
                                {photoSuccessMsg}
                            </div>
                        )}
                        {nameEditSuccess && (
                            <div className="student-hero-toast success">
                                {nameEditSuccess}
                            </div>
                        )}

                        <div className="student-hero-badges">
                            <span className="student-role-pill-badge" title="Student Account">
                                <FaUserGraduate /> Student
                            </span>
                            <span
                                className="student-roll-badge non-editable"
                                title={`Verified Roll Number: ${activeRollNo}`}
                            >
                                <FaIdCard /> {activeRollNo || "Student"}
                            </span>
                            <span className="student-sub-badge">
                                {studentBranch} • Semester {studentSemester}
                            </span>
                            <span className="student-sub-badge">
                                {user?.email || "Student Account"}
                            </span>
                            <span
                                className="student-sub-badge"
                                onClick={() => {
                                    if (hasFaceRegistered || isRegisteredGlobally) {
                                        setShowLockedFaceModal(true);
                                    } else {
                                        setShowFaceModal(true);
                                    }
                                }}
                                style={{
                                    cursor: "pointer",
                                    background: (hasFaceRegistered || isRegisteredGlobally) ? "#dcfce7" : "#fef3c7",
                                    color: (hasFaceRegistered || isRegisteredGlobally) ? "#15803d" : "#b45309",
                                    border: (hasFaceRegistered || isRegisteredGlobally) ? "1px solid #bbf7d0" : "1px solid #fde68a",
                                    fontWeight: 700,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "5px"
                                }}
                                title={(hasFaceRegistered || isRegisteredGlobally) ? "Facial biometrics registered & locked. Click to view security status" : "Click to register your face biometrics"}
                            >
                                {(hasFaceRegistered || isRegisteredGlobally) ? (
                                    <><FaLock size={11} /> Face Enrolled (Locked 🔒)</>
                                ) : (
                                    <><FaCamera size={11} /> Face Pending (Click to Enroll)</>
                                )}
                            </span>
                            <span
                                className="student-sub-badge"
                                onClick={() => {
                                    if (registeredDevice) {
                                        if (window.confirm(`🔒 Registered Device: ${getDeviceDisplayName(registeredDevice).toUpperCase()} (Locked)\n\nDetected Device: ${getDeviceDisplayName(detectedPlatform || 'web').toUpperCase()}\nIP Address: ${clientIpAddress || 'Detected'}\n\nWould you like to send a 1-click Reset Request to your Administrator/Faculty to unlock this device?`)) {
                                            handleRequestDeviceReset();
                                        }
                                    } else {
                                        setShowDeviceModal(true);
                                    }
                                }}
                                style={{
                                    cursor: "pointer",
                                    background: isDeviceMismatch ? "#fee2e2" : (registeredDevice ? "#f1f5f9" : "#e0f2fe"),
                                    color: isDeviceMismatch ? "#dc2626" : (registeredDevice ? "#334155" : "#0369a1"),
                                    border: isDeviceMismatch ? "1px solid #fca5a5" : (registeredDevice ? "1px solid #cbd5e1" : "1px solid #bae6fd"),
                                    fontWeight: 700,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "5px"
                                }}
                                title={registeredDevice ? `Locked to ${getDeviceDisplayName(registeredDevice)} (Click to Request Reset)` : "Click to select your device type"}
                            >
                                <FaMobileAlt size={11} /> Device: {registeredDevice ? `${getDeviceDisplayName(registeredDevice).toUpperCase()}${isDeviceMismatch ? ' ⚠️ (Mismatch)' : ' 🔒'}` : 'Select Device'}
                            </span>
                        </div>
                    </div>
                </div>

                <div className="student-hero-action" style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                    <button
                        type="button"
                        onClick={handleManualRefresh}
                        disabled={refreshing}
                        className="student-hero-refresh-btn"
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "10px 16px",
                            borderRadius: "14px",
                            background: "var(--surface, #ffffff)",
                            border: "1.5px solid var(--border, #cbd5e1)",
                            color: "var(--text, #1e293b)",
                            fontWeight: 700,
                            fontSize: "0.88rem",
                            cursor: refreshing ? "wait" : "pointer",
                            boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
                            transition: "all 0.2s ease"
                        }}
                        title="Sync latest classes & attendance records"
                    >
                        <FaSyncAlt className={refreshing ? "fa-spin" : ""} style={{ color: "#6366f1" }} />
                        <span>{refreshing ? "Refreshing..." : "Refresh"}</span>
                    </button>
                    <Link to="/student/mark-attendance" className="scan-qr-cta">
                        <MdQrCodeScanner size={20} />
                        <span>Scan Class QR Code</span>
                    </Link>
                </div>
            </div>

            {/* Native Android Overlay & Restricted Settings Action Banner */}
            {Capacitor.isNativePlatform() && !overlayStatus.granted && (
                <div style={{
                    margin: "16px 0",
                    padding: "16px 20px",
                    borderRadius: "16px",
                    background: "linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)",
                    border: "1.5px solid #f59e0b",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "16px",
                    flexWrap: "wrap",
                    boxShadow: "0 4px 12px rgba(245, 158, 11, 0.12)"
                }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "14px", flex: "1 1 300px" }}>
                        <div style={{
                            width: "42px",
                            height: "42px",
                            borderRadius: "12px",
                            background: "#f59e0b",
                            color: "#ffffff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "1.3rem",
                            flexShrink: 0
                        }}>
                            <FaLock />
                        </div>
                        <div>
                            <strong style={{ color: "#92400e", fontSize: "0.95rem", display: "block" }}>
                                Action Required: Allow Display Over Other Apps
                            </strong>
                            <span style={{ color: "#78350f", fontSize: "0.85rem", lineHeight: 1.4 }}>
                                On Android 13+, first tap <strong>Unblock Settings (3 dots ⋮)</strong> in App Info, then tap <strong>Enable Overlay</strong>.
                            </span>
                        </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <button
                            type="button"
                            onClick={() => KioskPlugin.openAppDetailsSettings()}
                            style={{
                                padding: "8px 14px",
                                borderRadius: "10px",
                                background: "#ffffff",
                                border: "1.5px solid #d97706",
                                color: "#b45309",
                                fontWeight: 700,
                                fontSize: "0.82rem",
                                cursor: "pointer"
                            }}
                        >
                            1. Unblock (3 Dots ⋮)
                        </button>
                        <button
                            type="button"
                            onClick={() => KioskPlugin.requestOverlayPermission()}
                            style={{
                                padding: "8px 14px",
                                borderRadius: "10px",
                                background: "#d97706",
                                border: "none",
                                color: "#ffffff",
                                fontWeight: 700,
                                fontSize: "0.82rem",
                                cursor: "pointer",
                                boxShadow: "0 2px 6px rgba(217, 119, 6, 0.3)"
                            }}
                        >
                            2. Enable Overlay
                        </button>
                        <button
                            type="button"
                            onClick={() => setShowPermissionsGuide(true)}
                            style={{
                                padding: "8px 12px",
                                borderRadius: "10px",
                                background: "transparent",
                                border: "1px solid #d97706",
                                color: "#92400e",
                                fontWeight: 600,
                                fontSize: "0.82rem",
                                cursor: "pointer"
                            }}
                        >
                            Instructions
                        </button>
                    </div>
                </div>
            )}



            {/* Face Biometrics Pending Banner: Only displayed if student has not enrolled their face yet */}
            {!hasFaceRegistered && !isRegisteredGlobally && (
                <div className="face-pending-alert-banner">
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        <FaExclamationTriangle className="face-pending-icon" />
                        <div>
                            <h4>In-App Face Biometrics Required</h4>
                            <p>
                                Complete your live 3D Face scan in-app to verify your identity for attendance.
                            </p>
                        </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <button
                            type="button"
                            onClick={() => setShowReadinessModal(true)}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                padding: "8px 14px",
                                borderRadius: "10px",
                                background: "rgba(99, 102, 241, 0.08)",
                                border: "1.5px solid #6366f1",
                                color: "#4f46e5",
                                fontWeight: 700,
                                fontSize: "0.82rem",
                                cursor: "pointer",
                                whiteSpace: "nowrap"
                            }}
                        >
                            <FaShieldAlt /> Permissions &amp; Setup
                        </button>
                        <Link
                            to="/student/face-enroll"
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "8px",
                                padding: "9px 18px",
                                borderRadius: "10px",
                                background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                                color: "#ffffff",
                                textDecoration: "none",
                                fontWeight: 700,
                                fontSize: "0.88rem",
                                cursor: "pointer",
                                boxShadow: "0 4px 12px rgba(99, 102, 241, 0.25)",
                                whiteSpace: "nowrap"
                            }}
                        >
                            <FaFingerprint /> Complete Face Enrollment
                        </Link>
                    </div>
                </div>
            )}

            {/* 2. Unified Attendance Summary Statistics */}
            <div className="student-stats-grid">
                <Link to="/student/statistics" className="student-stat-card" style={{ textDecoration: "none" }} title="Click to view detailed attendance logs">
                    <div className="student-stat-icon blue">
                        <FaCalendarCheck />
                    </div>
                    <div className="student-stat-content">
                        <span>Classes Attended / Conducted</span>
                        <strong>{loading ? "..." : `${metrics.totalAttended} / ${metrics.totalConducted}`}</strong>
                    </div>
                </Link>

                <Link to="/student/statistics" className="student-stat-card" style={{ textDecoration: "none" }} title="Click to view full attendance analytics">
                    <div className={`student-stat-icon ${metrics.overallPercentage >= 75 ? "green" : "purple"}`}>
                        <FaPercentage />
                    </div>
                    <div className="student-stat-content">
                        <span>Overall Attendance</span>
                        <strong>{loading ? "..." : `${metrics.overallPercentage}%`}</strong>
                    </div>
                </Link>

                <Link to="/student/courses" className="student-stat-card green" style={{ textDecoration: "none" }} title="Click to view enrolled courses & syllabus">
                    <div className="student-stat-icon green">
                        <FaBookOpen />
                    </div>
                    <div className="student-stat-content">
                        <span>Enrolled Courses</span>
                        <strong>{loading ? "..." : metrics.coursesWithStats.length}</strong>
                    </div>
                </Link>

                <Link to="/student/statistics" className="student-stat-card purple" style={{ textDecoration: "none" }} title="Click to view recent class history">
                    <div className="student-stat-icon purple">
                        <FaClock />
                    </div>
                    <div className="student-stat-content">
                        <span>Last Attended Class</span>
                        <strong style={{ fontSize: "1.05rem" }}>{loading ? "..." : metrics.lastAttended}</strong>
                    </div>
                </Link>
            </div>

            {/* 3. Course Quick Attendance Overview */}
            {metrics.coursesWithStats.length > 0 && (
                <div className="student-course-quick-section">
                    <div className="student-course-quick-header">
                        <div>
                            <h2>My Courses & Attendance Progress</h2>
                            <p>Overview of all academic courses and current attendance status</p>
                        </div>
                        <Link to="/student/courses" className="student-course-quick-link">
                            View Detailed Syllabus & Logs <FaArrowRight />
                        </Link>
                    </div>

                    <div className="student-courses-quick-grid">
                        {metrics.coursesWithStats.slice(0, 6).map((course) => {
                            const isSafe = course.percentage !== null && course.percentage >= 75;
                            const isWarning = course.percentage !== null && course.percentage >= 65 && course.percentage < 75;
                            const isDanger = course.percentage !== null && course.percentage < 65;

                            return (
                                <Link
                                    to="/student/courses"
                                    key={course.id || course.courseCode}
                                    className="student-quick-course-card"
                                >
                                    <div className="student-quick-course-top">
                                        <span className="student-quick-course-code">{course.courseCode}</span>
                                        <span className={`student-quick-course-badge ${isSafe ? "safe" : isDanger ? "danger" : isWarning ? "warning" : "none"}`}>
                                            {course.percentage !== null ? `${course.percentage}%` : "No classes"}
                                        </span>
                                    </div>

                                    <h4 className="student-quick-course-title">{course.courseName}</h4>

                                    <div className="student-quick-course-bar-bg">
                                        <div
                                            className={`student-quick-course-bar-fill ${isSafe ? "safe" : isDanger ? "danger" : isWarning ? "warning" : ""}`}
                                            style={{ width: `${course.percentage !== null ? course.percentage : 0}%` }}
                                        />
                                    </div>

                                    <div className="student-quick-course-footer">
                                        <span>Attended: <strong>{course.attendedCount} / {course.totalConducted}</strong></span>
                                        <span>
                                            {course.totalConducted === 0 ? (
                                                "Pending"
                                            ) : isSafe ? (
                                                <span style={{ color: "#059669", fontWeight: 700 }}>+{course.leavesAvailable} Leaves Safe</span>
                                            ) : (
                                                <span style={{ color: "#dc2626", fontWeight: 700 }}>Need +{course.classesNeeded} Classes</span>
                                            )}
                                        </span>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* 4. Attended Classes Log */}
            <div className="student-records-card">
                <div className="records-header-row">
                    <div className="records-header-left">
                        <div className="records-header-icon-pill">
                            <FaCalendarCheck />
                        </div>
                        <div>
                            <h2>Classes You Have Attended ({metrics.enrichedRecords.length})</h2>
                            <p>Real-time attendance register for Roll No: <strong className="header-roll-highlight">{activeRollNo}</strong></p>
                        </div>
                    </div>

                    <div className="records-controls">
                        <button
                            type="button"
                            className="dashboard-refresh-btn"
                            onClick={handleManualRefresh}
                            disabled={refreshing}
                            title="Check for newly registered attendance"
                        >
                            <FaSyncAlt className={refreshing ? "fa-spin" : ""} />
                            <span>{refreshing ? "Updating..." : "Refresh"}</span>
                        </button>

                        {metrics.enrichedRecords.length > 0 && (
                            <div className="records-search">
                                <FaSearch className="records-search-icon" />
                                <input
                                    type="text"
                                    placeholder="Search subject, class, room or lecturer..."
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                />
                                {search && (
                                    <button
                                        type="button"
                                        className="records-search-clear"
                                        onClick={() => setSearch("")}
                                    >
                                        <FaTimes />
                                    </button>
                                )}
                            </div>
                        )}

                        {metrics.enrichedRecords.length > 0 && (
                            <button
                                type="button"
                                className="download-export-btn"
                                onClick={handleExport}
                                title="Download Excel report of your attendance"
                            >
                                <FaFileDownload /> <span>Export Excel</span>
                            </button>
                        )}
                    </div>
                </div>

                {loading && candidateRolls.length > 0 ? (
                    <div className="student-empty-state">
                        <div className="empty-state-icon-wrap">
                            <FaSyncAlt className="fa-spin" />
                        </div>
                        <h3>Loading Attendance Stream</h3>
                        <p>Fetching your real-time verified attendance records from Firestore...</p>
                    </div>
                ) : filteredRecords.length === 0 ? (
                    <div className="student-empty-state">
                        <div className="empty-state-icon-wrap">
                            <FaHistory />
                        </div>
                        <h3>{search ? "No Matching Classes Found" : "No Attendance Recorded Yet"}</h3>
                        <p>
                            {search
                                ? `No classes matched your search filter "${search}". Try searching by course code or lecturer name.`
                                : `No attendance entries found under Roll Number "${activeRollNo}". Classes you attend and submit attendance for via QR Code or Face Verification will automatically appear here in real time.`}
                        </p>

                        {!search ? (
                            <div className="empty-state-actions">
                                <Link to="/student/mark-attendance" className="scan-qr-cta empty-cta-btn">
                                    <MdQrCodeScanner size={18} />
                                    <span>Scan Class QR Code</span>
                                </Link>
                                <Link to="/student/courses" className="empty-secondary-btn">
                                    <FaBookOpen />
                                    <span>Browse My Courses</span>
                                </Link>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className="empty-secondary-btn"
                                onClick={() => setSearch("")}
                            >
                                Clear Search Filter
                            </button>
                        )}

                        <div className="empty-state-footer-pill">
                            <span className="live-pulse-dot" />
                            <span>Live Sync Active • Instant Update on Submission</span>
                        </div>
                    </div>
                ) : (
                    <div className="student-table-wrap">
                        <table className="student-att-table" id="student-attended-table">
                            <thead>
                                <tr>
                                    <th className="sortable-th" onClick={() => requestSort("rollNo")} title="Click to sort by Roll Number">
                                        Roll Number <SortIcon sortConfig={sortConfig} columnKey="rollNo" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("fullName")} title="Click to sort by Student Name">
                                        Student Name <SortIcon sortConfig={sortConfig} columnKey="fullName" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("courseCode")} title="Click to sort by Course">
                                        Course / Subject <SortIcon sortConfig={sortConfig} columnKey="courseCode" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("classCode")} title="Click to sort by Class Code">
                                        Class Code <SortIcon sortConfig={sortConfig} columnKey="classCode" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("roomNo")} title="Click to sort by Room">
                                        Room <SortIcon sortConfig={sortConfig} columnKey="roomNo" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Date">
                                        Date <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                                    </th>
                                    <th className="sortable-th" onClick={() => requestSort("submittedAt")} title="Click to sort by Time">
                                        Time <SortIcon sortConfig={sortConfig} columnKey="submittedAt" />
                                    </th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sortedRecords.map((item) => {
                                    const submittedAtMillis = parseTimestampMillis(item.submittedAt);
                                    const submittedAtDate = submittedAtMillis ? new Date(submittedAtMillis) : null;
                                    return (
                                        <tr key={item.id}>
                                            <td><strong>{item.rollNo || activeRollNo}</strong></td>
                                            <td><strong>{item.fullName || studentName}</strong></td>
                                            <td><strong>{item.courseCode}</strong></td>
                                            <td>{item.classCode}</td>
                                            <td>Room {item.roomNo}</td>
                                            <td>
                                                {submittedAtDate
                                                    ? submittedAtDate.toLocaleDateString(undefined, {
                                                        weekday: "short",
                                                        month: "short",
                                                        day: "numeric",
                                                        year: "numeric"
                                                    })
                                                    : "N/A"}
                                            </td>
                                            <td>
                                                {submittedAtDate
                                                    ? submittedAtDate.toLocaleTimeString([], {
                                                        hour: "2-digit",
                                                        minute: "2-digit"
                                                    })
                                                    : "N/A"}
                                            </td>
                                            <td>
                                                <span className="present-tag">
                                                    <FaCheckCircle /> Present
                                                </span>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* 5. Security Dialog: Locked Face Biometrics Information */}
            {showLockedFaceModal && (
                <div className="modal-backdrop" onClick={() => setShowLockedFaceModal(false)} style={{
                    position: "fixed",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: "rgba(15, 23, 42, 0.75)",
                    backdropFilter: "blur(6px)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: 9999,
                    padding: "20px"
                }}>
                    <div className="student-modal-container" onClick={(e) => e.stopPropagation()} style={{
                        background: "var(--surface, #ffffff)",
                        borderRadius: "20px",
                        maxWidth: "520px",
                        width: "100%",
                        padding: "28px",
                        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                        position: "relative",
                        textAlign: "center"
                    }}>
                        <button
                            type="button"
                            onClick={() => setShowLockedFaceModal(false)}
                            style={{
                                position: "absolute",
                                top: "18px",
                                right: "18px",
                                background: "var(--surface-soft, #f1f5f9)",
                                border: "none",
                                borderRadius: "50%",
                                width: "36px",
                                height: "36px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "1.1rem",
                                cursor: "pointer",
                                color: "var(--text-muted, #64748b)"
                            }}
                        >
                            ✕
                        </button>

                        <div style={{
                            width: "60px",
                            height: "60px",
                            borderRadius: "50%",
                            background: "#dcfce7",
                            color: "#16a34a",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "26px",
                            margin: "0 auto 16px"
                        }}>
                            <FaLock />
                        </div>

                        <h2 style={{ margin: "0 0 8px", fontSize: "1.3rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                            Facial Biometrics Registered &amp; Protected
                        </h2>

                        <div style={{
                            background: "var(--surface-soft, #f8fafc)",
                            border: "1px solid var(--border, #e2e8f0)",
                            borderRadius: "14px",
                            padding: "16px 18px",
                            margin: "16px 0",
                            textAlign: "left",
                            fontSize: "0.88rem",
                            lineHeight: 1.6,
                            color: "var(--text-main, #334155)"
                        }}>
                            <p style={{ margin: "0 0 10px" }}>
                                ✅ Your 128-dimensional facial biometric vectors are officially registered under Roll Number <strong style={{ color: "#6366f1" }}>{activeRollNo}</strong> for attendance authentication.
                            </p>
                            <p style={{ margin: 0, color: "var(--text-muted, #64748b)" }}>
                                🔒 <strong>Institutional Security Policy:</strong> To protect attendance integrity, students cannot alter or re-record registered facial biometric vectors. If your biometrics need updating, your Course Lecturer must grant a Re-Registration Pass or enroll you directly.
                            </p>
                            {canReEnrollFace && (
                                <p style={{ margin: "10px 0 0", color: "#059669", fontWeight: 700 }}>
                                    ✨ <strong>Lecturer Access Granted:</strong> You have an active re-registration pass to update your face biometrics.
                                </p>
                            )}
                        </div>

                        {!canReEnrollFace && (
                            <div style={{
                                display: "flex",
                                alignItems: "flex-start",
                                gap: "12px",
                                padding: "12px 14px",
                                borderRadius: "12px",
                                background: "rgba(99, 102, 241, 0.08)",
                                border: "1px solid rgba(99, 102, 241, 0.22)",
                                margin: "12px 0",
                                textAlign: "left"
                            }}>
                                <FaUniversity style={{ color: "#4f46e5", fontSize: "1.25rem", flexShrink: 0, marginTop: "2px" }} />
                                <div style={{ fontSize: "0.83rem", color: "#312e81", lineHeight: 1.45 }}>
                                    <strong>In-Person Physical Assistance:</strong> You can physically report to your Course Lecturer in class or office hours with your Student ID card. Lecturers have 1-click authority to grant re-registration passes or re-enroll you on the spot.
                                </div>
                            </div>
                        )}

                        <div style={{ display: "flex", gap: "10px", marginTop: "16px", flexWrap: "wrap" }}>
                            {canReEnrollFace ? (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowLockedFaceModal(false);
                                        setShowFaceModal(true);
                                    }}
                                    style={{
                                        flex: 1,
                                        minWidth: "160px",
                                        padding: "11px 16px",
                                        borderRadius: "12px",
                                        background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                                        color: "#ffffff",
                                        border: "none",
                                        fontWeight: 700,
                                        fontSize: "0.9rem",
                                        cursor: "pointer",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "8px",
                                        boxShadow: "0 4px 12px rgba(99, 102, 241, 0.25)"
                                    }}
                                >
                                    <FaCamera /> Re-enroll Face Camera
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowLockedFaceModal(false);
                                        setReqModalScope("face");
                                        setShowReqModal(true);
                                    }}
                                    style={{
                                        flex: 1,
                                        minWidth: "160px",
                                        padding: "11px 16px",
                                        borderRadius: "12px",
                                        background: "linear-gradient(135deg, #4f46e5, #6366f1)",
                                        color: "#ffffff",
                                        border: "none",
                                        fontWeight: 700,
                                        fontSize: "0.88rem",
                                        cursor: "pointer",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "8px",
                                        boxShadow: "0 4px 12px rgba(79, 70, 229, 0.25)"
                                    }}
                                >
                                    <FaKey /> Request Re-Registration Access
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => setShowLockedFaceModal(false)}
                                style={{
                                    flex: canReEnrollFace ? undefined : 1,
                                    padding: "11px 20px",
                                    borderRadius: "12px",
                                    background: "var(--surface-soft, #f1f5f9)",
                                    color: "var(--text-main, #334155)",
                                    border: "1px solid var(--border, #cbd5e1)",
                                    fontWeight: 700,
                                    fontSize: "0.9rem",
                                    cursor: "pointer"
                                }}
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 6. Initial Face Biometrics Registration Modal */}
            {showFaceModal && (
                <div className="modal-backdrop" onClick={() => setShowFaceModal(false)} style={{
                    position: "fixed",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: "rgba(15, 23, 42, 0.75)",
                    backdropFilter: "blur(6px)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: 9999,
                    padding: "20px"
                }}>
                    <div className="student-modal-container student-face-register-modal" onClick={(e) => e.stopPropagation()} style={{
                        background: "var(--surface, #ffffff)",
                        borderRadius: "24px",
                        maxWidth: "620px",
                        width: "100%",
                        maxHeight: "92vh",
                        overflowY: "auto",
                        padding: "24px 20px",
                        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.35)",
                        position: "relative"
                    }}>
                        <button
                            type="button"
                            onClick={() => setShowFaceModal(false)}
                            style={{
                                position: "absolute",
                                top: "18px",
                                right: "18px",
                                background: "var(--surface-soft, #f1f5f9)",
                                border: "none",
                                borderRadius: "50%",
                                width: "36px",
                                height: "36px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "1.1rem",
                                cursor: "pointer",
                                color: "var(--text-muted, #64748b)"
                            }}
                        >
                            ✕
                        </button>

                        <div style={{ marginBottom: "20px" }}>
                            <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "6px 14px", borderRadius: "20px", background: "rgba(99, 102, 241, 0.1)", color: "#6366f1", fontWeight: 700, fontSize: "0.85rem", marginBottom: "8px" }}>
                                <FaCamera /> Biometric AI Recognition
                            </div>
                            <h2 style={{ margin: "0 0 6px", fontSize: "1.35rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                                {hasFaceRegistered ? "Facial Biometrics Registered & Locked" : "Register Facial Biometrics"}
                            </h2>
                            <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--text-muted, #64748b)" }}>
                                Roll Number: <strong style={{ color: "#6366f1" }}>{activeRollNo}</strong> • Student: <strong>{studentName}</strong>
                            </p>
                        </div>

                        {hasFaceRegistered ? (
                            <div style={{ textAlign: "center", padding: "16px 0" }}>
                                <div style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "8px",
                                    padding: "8px 18px",
                                    borderRadius: "999px",
                                    background: "#dcfce7",
                                    color: "#15803d",
                                    fontWeight: 800,
                                    fontSize: "0.9rem",
                                    marginBottom: "16px"
                                }}>
                                    <FaLock /> Biometrics Permanently Locked 🔒
                                </div>
                                <p style={{ fontSize: "0.9rem", color: "var(--text-muted, #64748b)", lineHeight: 1.55, margin: "0 0 20px" }}>
                                    Your 3D facial biometrics are officially registered and locked. Institutional policy strictly prohibits students from re-enrolling or editing biometrics after initial setup.
                                </p>
                                <button
                                    type="button"
                                    onClick={() => setShowFaceModal(false)}
                                    style={{
                                        padding: "10px 24px",
                                        borderRadius: "10px",
                                        background: "var(--surface-soft, #f1f5f9)",
                                        border: "1px solid var(--border, #cbd5e1)",
                                        fontWeight: 700,
                                        cursor: "pointer"
                                    }}
                                >
                                    Close
                                </button>
                            </div>
                        ) : (
                            <>
                                <LiveFaceEnrollment
                                    hideHeader={true}
                                    targetRollNo={activeRollNo}
                                    targetEmail={user?.email}
                                    targetName={studentName}
                                    onFaceEnrolled={handleEnrollStudentFace}
                                />

                                {faceSaving && (
                                    <div style={{ marginTop: "16px", textAlign: "center", color: "#6366f1", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                                        <FaSpinner className="fa-spin" /> Saving biometric facial descriptors to database...
                                    </div>
                                )}

                                {faceSuccessMsg && (
                                    <div style={{
                                        marginTop: "16px",
                                        padding: "12px 16px",
                                        background: "#dcfce7",
                                        color: "#15803d",
                                        borderRadius: "10px",
                                        fontWeight: 700,
                                        textAlign: "center",
                                        fontSize: "0.95rem"
                                    }}>
                                        {faceSuccessMsg}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* 7. Dedicated Edit Student Name Modal */}
            {showEditNameModal && (
                <div className="modal-backdrop" onClick={() => setShowEditNameModal(false)} style={{
                    position: "fixed",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: "rgba(15, 23, 42, 0.75)",
                    backdropFilter: "blur(6px)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: 9999,
                    padding: "20px"
                }}>
                    <div className="student-modal-container student-name-edit-modal-box" onClick={(e) => e.stopPropagation()} style={{
                        background: "var(--surface, #ffffff)",
                        borderRadius: "20px",
                        maxWidth: "500px",
                        width: "100%",
                        padding: "28px 24px",
                        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                        position: "relative",
                        border: "1px solid var(--border, #e2e8f0)"
                    }}>
                        <button
                            type="button"
                            onClick={() => setShowEditNameModal(false)}
                            style={{
                                position: "absolute",
                                top: "18px",
                                right: "18px",
                                background: "var(--surface-soft, #f1f5f9)",
                                border: "none",
                                borderRadius: "50%",
                                width: "36px",
                                height: "36px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "1.1rem",
                                cursor: "pointer",
                                color: "var(--text-muted, #64748b)"
                            }}
                        >
                            ✕
                        </button>

                        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "6px 14px", borderRadius: "20px", background: "rgba(99, 102, 241, 0.1)", color: "#6366f1", fontWeight: 700, fontSize: "0.85rem", marginBottom: "12px" }}>
                            <FaEdit /> Student Profile Management
                        </div>

                        <h2 style={{ margin: "0 0 6px", fontSize: "1.35rem", fontWeight: 800, color: "var(--text-main, #0f172a)" }}>
                            Edit Display Name
                        </h2>
                        <p style={{ margin: "0 0 20px", fontSize: "0.88rem", color: "var(--text-muted, #64748b)", lineHeight: 1.5 }}>
                            This name will be saved permanently in the database across all attendance records, class rosters, and certificates.
                        </p>

                        <div style={{
                            background: "var(--surface-soft, #f8fafc)",
                            border: "1px solid var(--border, #e2e8f0)",
                            borderRadius: "12px",
                            padding: "10px 14px",
                            marginBottom: "18px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            fontSize: "0.86rem"
                        }}>
                            <span style={{ color: "var(--text-muted, #64748b)", fontWeight: 600 }}>Verified Roll Number:</span>
                            <span style={{ fontWeight: 800, color: "#6366f1", fontFamily: "monospace", fontSize: "0.95rem" }}>{activeRollNo}</span>
                        </div>

                        <form onSubmit={async (e) => {
                            e.preventDefault();
                            if (!editNameInput.trim()) return;
                            try {
                                setSavingStudentName(true);
                                setNameEditError("");
                                await updateProfileName(editNameInput.trim());
                                setFetchedStudentData((prev) => ({ ...(prev || {}), name: editNameInput.trim() }));
                                setShowEditNameModal(false);
                                setNameEditSuccess("Name updated and saved successfully!");
                                setTimeout(() => setNameEditSuccess(""), 3500);
                            } catch (err) {
                                setNameEditError(err.message || "Failed to save name");
                            } finally {
                                setSavingStudentName(false);
                            }
                        }}>
                            <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main, #334155)", marginBottom: "6px" }}>
                                Full Name
                            </label>
                            <input
                                type="text"
                                value={editNameInput}
                                onChange={(e) => setEditNameInput(e.target.value)}
                                placeholder="Enter your full name"
                                autoFocus
                                required
                                disabled={savingStudentName}
                                style={{
                                    width: "100%",
                                    padding: "12px 14px",
                                    borderRadius: "12px",
                                    border: "2px solid #6366f1",
                                    fontSize: "1.05rem",
                                    fontWeight: 600,
                                    outline: "none",
                                    boxSizing: "border-box",
                                    background: "var(--surface, #ffffff)",
                                    color: "var(--text-main, #0f172a)",
                                    marginBottom: "14px"
                                }}
                            />

                            {nameEditError && (
                                <div className="form-error-alert-box">
                                    ⚠️ {nameEditError}
                                </div>
                            )}

                            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                                <button
                                    type="button"
                                    onClick={() => { setShowEditNameModal(false); setNameEditError(""); }}
                                    disabled={savingStudentName}
                                    style={{
                                        padding: "10px 18px",
                                        borderRadius: "10px",
                                        background: "var(--surface-soft, #f1f5f9)",
                                        color: "var(--text-muted, #64748b)",
                                        border: "1px solid var(--border, #cbd5e1)",
                                        fontWeight: 700,
                                        fontSize: "0.9rem",
                                        cursor: "pointer"
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={savingStudentName || !editNameInput.trim()}
                                    style={{
                                        padding: "10px 22px",
                                        borderRadius: "10px",
                                        background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                                        color: "#ffffff",
                                        border: "none",
                                        fontWeight: 700,
                                        fontSize: "0.9rem",
                                        cursor: "pointer",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "8px",
                                        boxShadow: "0 4px 14px rgba(99, 102, 241, 0.3)"
                                    }}
                                >
                                    {savingStudentName ? <FaSpinner className="fa-spin" /> : <><FaCheck /> Save Name</>}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* WhatsApp / Instagram Style Full Screen Profile Photo Viewer */}
            <ProfilePhotoModal
                isOpen={showPhotoModal}
                onClose={() => setShowPhotoModal(false)}
                photoSrc={fetchedStudentData?.photoURL || (fetchedStudentData === null ? (profile?.photoURL || user?.photoURL) : "")}
                name={studentName}
                role="student"
                subtext={`${activeRollNo} • ${studentBranch} Sem ${studentSemester}`}
                canEdit={true}
                onUpload={handleProfilePhotoUpload}
                onDelete={handleDeleteProfilePhoto}
                uploading={photoUploading}
                deleting={photoDeleting}
            />

            {/* Device Onboarding & Verification Modal (Android APK vs iPhone Guided Access) */}
            <DeviceOnboardingModal
                isOpen={showDeviceModal}
                onClose={() => {
                    setShowDeviceModal(false);
                    try {
                        setCurrentDeviceType(localStorage.getItem('smartattend_student_device_type') || '');
                    } catch (_) { }
                }}
            />

            {/* Student Post-Login Readiness & Permissions Modal */}
            <StudentReadinessModal
                isOpen={showReadinessModal}
                onClose={() => setShowReadinessModal(false)}
                hasFaceRegistered={hasFaceRegistered}
                hasHwRegistered={hasHwRegistered}
                studentName={studentName}
                activeRollNo={activeRollNo}
            />

            {/* Complete Android Permissions & Setup Instructions Modal */}
            {showPermissionsGuide && (
                <div className="profile-photo-modal-overlay" onClick={() => setShowPermissionsGuide(false)} style={{ zIndex: 10000 }}>
                    <div
                        className="profile-photo-modal-content"
                        onClick={(e) => e.stopPropagation()}
                        style={{ maxWidth: "560px", padding: "26px", maxHeight: "90vh", overflowY: "auto", borderRadius: "20px" }}
                    >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                <div style={{ width: "36px", height: "36px", borderRadius: "10px", background: "#6366f1", color: "#ffffff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.2rem" }}>
                                    <FaMobileAlt />
                                </div>
                                <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 800, color: "var(--text-primary, #0f172a)" }}>
                                    Android Setup &amp; Permission Instructions
                                </h3>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowPermissionsGuide(false)}
                                style={{ background: "none", border: "none", fontSize: "1.3rem", color: "#64748b", cursor: "pointer" }}
                            >
                                <FaTimes />
                            </button>
                        </div>

                        {/* Step 1: Before Installing / Play Protect */}
                        <div style={{ marginBottom: "16px", padding: "14px", borderRadius: "12px", background: "rgba(99, 102, 241, 0.06)", border: "1px solid rgba(99, 102, 241, 0.2)" }}>
                            <strong style={{ color: "#4338ca", fontSize: "0.92rem", display: "block", marginBottom: "4px" }}>
                                🛡️ Step 1: Google Play Protect (Before / During Install)
                            </strong>
                            <p style={{ margin: 0, fontSize: "0.84rem", color: "#334155", lineHeight: 1.5 }}>
                                Because SmartAttend is downloaded directly as an APK, Google Play Protect may show a warning: <em>"Unsafe app blocked"</em> or <em>"Play Protect doesn't recognise this app's developer"</em>.<br />
                                👉 Tap <strong>More details</strong> (small dropdown arrow) <span className="device-path-arrow">→</span> Tap <strong>Install anyway</strong>.
                            </p>
                        </div>

                        {/* Step 2: After Installing / Restricted Settings on Android 13+ */}
                        <div style={{ marginBottom: "16px", padding: "14px", borderRadius: "12px", background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.3)" }}>
                            <strong style={{ color: "#b45309", fontSize: "0.92rem", display: "block", marginBottom: "4px" }}>
                                🔓 Step 2: Allow Restricted Settings (Android 13, 14, 15+)
                            </strong>
                            <p style={{ margin: 0, fontSize: "0.84rem", color: "#334155", lineHeight: 1.5 }}>
                                On Android 13+, permissions for downloaded APKs are disabled by default (<em>"Restricted setting: currently unavailable"</em>):<br />
                                1. Open <strong>App info</strong> (Long-press SmartAttend icon on home screen <span className="device-path-arrow">→</span> tap <strong>App info / ℹ️</strong>).<br />
                                2. In the top-right corner, tap the <strong>3 DOTS (⋮)</strong>.<br />
                                3. Tap <strong>"Allow restricted settings"</strong> and verify your device Fingerprint or PIN.
                            </p>
                            {Capacitor.isNativePlatform() && (
                                <button
                                    type="button"
                                    onClick={() => KioskPlugin.openAppDetailsSettings()}
                                    style={{
                                        marginTop: "10px",
                                        padding: "8px 14px",
                                        borderRadius: "8px",
                                        background: "#d97706",
                                        border: "none",
                                        color: "#ffffff",
                                        fontWeight: 700,
                                        fontSize: "0.82rem",
                                        cursor: "pointer"
                                    }}
                                >
                                    Open App Info to Tap 3 Dots ⋮
                                </button>
                            )}
                        </div>

                        {/* Step 3: Turn on Display Over Other Apps */}
                        <div style={{ marginBottom: "16px", padding: "14px", borderRadius: "12px", background: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.3)" }}>
                            <strong style={{ color: "#065f46", fontSize: "0.92rem", display: "block", marginBottom: "4px" }}>
                                📱 Step 3: Turn ON Display Over Other Apps
                            </strong>
                            <p style={{ margin: 0, fontSize: "0.84rem", color: "#334155", lineHeight: 1.5 }}>
                                After allowing restricted settings, tap <strong>Display over other apps</strong> on that same App Info screen and toggle the switch <strong>ON</strong>. This allows SmartAttend to lock attendance and prevent proxy submissions.
                            </p>
                            {Capacitor.isNativePlatform() && (
                                <button
                                    type="button"
                                    onClick={() => KioskPlugin.requestOverlayPermission()}
                                    style={{
                                        marginTop: "10px",
                                        padding: "8px 14px",
                                        borderRadius: "8px",
                                        background: "#059669",
                                        border: "none",
                                        color: "#ffffff",
                                        fontWeight: 700,
                                        fontSize: "0.82rem",
                                        cursor: "pointer"
                                    }}
                                >
                                    Open Display Over Apps Settings
                                </button>
                            )}
                        </div>

                        {/* Step 4: Biometrics */}
                        <div style={{ padding: "14px", borderRadius: "12px", background: "rgba(99, 102, 241, 0.06)", border: "1px solid rgba(99, 102, 241, 0.2)" }}>
                            <strong style={{ color: "#4338ca", fontSize: "0.92rem", display: "block", marginBottom: "4px" }}>
                                👤 Step 4: Complete In-App Biometric Registration
                            </strong>
                            <p style={{ margin: 0, fontSize: "0.84rem", color: "#334155", lineHeight: 1.5 }}>
                                Register both your <strong>3D Face</strong> and <strong>Device Fingerprint</strong> right in SmartAttend.
                            </p>
                            <Link
                                to="/student/face-enroll"
                                onClick={() => setShowPermissionsGuide(false)}
                                style={{
                                    display: "inline-block",
                                    marginTop: "10px",
                                    padding: "8px 14px",
                                    borderRadius: "8px",
                                    background: "#6366f1",
                                    color: "#ffffff",
                                    fontWeight: 700,
                                    fontSize: "0.82rem",
                                    textDecoration: "none"
                                }}
                            >
                                Go to Biometric Registration →
                            </Link>
                        </div>

                        <button
                            type="button"
                            onClick={() => setShowPermissionsGuide(false)}
                            style={{
                                width: "100%",
                                marginTop: "20px",
                                padding: "12px",
                                borderRadius: "12px",
                                background: "#0f172a",
                                color: "#ffffff",
                                border: "none",
                                fontWeight: 700,
                                cursor: "pointer"
                            }}
                        >
                            Got It, Back to Dashboard
                        </button>
                    </div>
                </div>
            )}

            {/* App Update Modal */}
            <AppUpdateModal
                updateInfo={showUpdateModal ? updateInfo : null}
                onClose={() => {
                    if (!updateInfo?.isMandatory) {
                        dismissAppUpdate(updateInfo?.latestVersion);
                        setUpdateDismissed(true);
                    }
                    setShowUpdateModal(false);
                }}
            />

            {/* Re-Registration Request Modal */}
            <RequestReRegistrationModal
                isOpen={showReqModal}
                onClose={() => setShowReqModal(false)}
                rollNo={activeRollNo}
                studentName={studentName}
                studentEmail={cleanEmail}
                initialScope={reqModalScope}
                onProceedEnroll={() => setShowFaceModal(true)}
            />
        </div>
    );
}