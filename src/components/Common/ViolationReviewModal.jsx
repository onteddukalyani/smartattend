import React, { useState } from 'react';
import { db, auth } from '../../firebase';
import { doc, updateDoc, setDoc, getDoc, arrayUnion, increment, serverTimestamp } from 'firebase/firestore';
import { FaShieldAlt, FaCheck, FaTimes, FaExclamationTriangle, FaTrashAlt } from 'react-icons/fa';
import { sendStudentNotification } from '../../services/notificationsService';

export default function ViolationReviewModal({ violation, onClose, onActionComplete }) {
    const [actionLoading, setActionLoading] = useState(false);

    if (!violation) return null;

    const handleDecision = async (status, reviewNotes) => {
        setActionLoading(true);
        try {
            const studentRoll = (violation.rollNo || violation.rollNumber || violation.studentUid || "").toString().trim().toUpperCase();
            const studentUid = violation.studentUid || violation.id || studentRoll;
            const studentName = violation.studentName || violation.name || studentRoll;
            const studentEmail = (violation.studentEmail || violation.email || "").toString().trim().toLowerCase();
            const sessionId = violation.sessionId || (violation.id && violation.id.includes("_") ? violation.id.split("_")[0] : null);

            // Ownership & Permission Verification
            if (sessionId) {
                const sessionRef = doc(db, 'attendance_sessions', sessionId);
                const sessionSnap = await getDoc(sessionRef).catch(() => null);
                if (sessionSnap && sessionSnap.exists()) {
                    const sessData = sessionSnap.data();
                    const currentUser = auth.currentUser;
                    if (currentUser) {
                        const currentUid = currentUser.uid;
                        const currentEmail = (currentUser.email || '').toLowerCase().trim();
                        const currentPrefix = currentEmail.split('@')[0].toLowerCase().trim();

                        const ownerId = sessData.ownerId;
                        const ownerEmail = (sessData.ownerEmail || '').toLowerCase().trim();
                        const lecturerEmail = (sessData.lecturerEmail || '').toLowerCase().trim();

                        const isOwner =
                            (ownerId && ownerId === currentUid) ||
                            (ownerEmail && ownerEmail === currentEmail) ||
                            (lecturerEmail && lecturerEmail === currentEmail) ||
                            (currentPrefix && (ownerEmail.startsWith(currentPrefix) || lecturerEmail.startsWith(currentPrefix)));

                        if (!isOwner) {
                            let isCallerAdmin = false;
                            try {
                                const adminSnap = await getDoc(doc(db, 'admins', currentPrefix)).catch(() => null);
                                if (adminSnap && adminSnap.exists()) isCallerAdmin = true;
                                if (!isCallerAdmin) {
                                    const userSnap = await getDoc(doc(db, 'users', currentUid)).catch(() => null);
                                    if (userSnap && userSnap.exists() && userSnap.data()?.role === 'admin') isCallerAdmin = true;
                                }
                            } catch (_) {}

                            if (!isCallerAdmin) {
                                const assignedLecturer = sessData.lecturerName || sessData.lecturerEmail || 'the assigned lecturer';
                                alert(`❌ Permission Denied: This session belongs to ${assignedLecturer}. You cannot modify attendance or excuse violations for another lecturer's class.`);
                                setActionLoading(false);
                                return;
                            }
                        }
                    }
                }
            }

            // 1. Update attendance record
            const targetIds = new Set();
            if (violation.id) targetIds.add(violation.id);
            if (sessionId && studentRoll) targetIds.add(`${sessionId}_${studentRoll}`);

            const recordUpdatePayload = {
                status: status, // 'APPROVED' | 'REJECTED' | 'DISMISSED'
                verificationStatus: status === 'APPROVED' ? 'VERIFIED' : 'REJECTED',
                flagged: false,
                disqualified: status === 'REJECTED',
                hasViolation: false,
                reviewed: true,
                reviewedByRole: 'LECTURER',
                reviewNotes: reviewNotes || (status === 'APPROVED' ? 'Pardoned by lecturer' : status === 'DISMISSED' ? 'Dismissed by lecturer' : 'Rejected by lecturer'),
                reviewedAt: serverTimestamp(),
                excused: status === 'APPROVED',
                dismissed: status === 'DISMISSED',
                faceVerified: status === 'APPROVED' ? true : (violation.faceVerified ?? false)
            };

            for (const recId of targetIds) {
                const recordRef = doc(db, 'attendance_records', recId);
                await setDoc(recordRef, recordUpdatePayload, { merge: true }).catch(() => {});
            }

            // 2. Update session doc: clean flaggedViolations array & update attendees
            if (sessionId) {
                try {
                    const sessionRef = doc(db, 'attendance_sessions', sessionId);
                    const sessionSnap = await getDoc(sessionRef);
                    if (sessionSnap.exists()) {
                        const sessData = sessionSnap.data();
                        const sessionUpdate = {};

                        // Remove from flaggedViolations array so it never appears in pending review lists
                        if (Array.isArray(sessData?.flaggedViolations)) {
                            sessionUpdate.flaggedViolations = sessData.flaggedViolations.filter((f) => {
                                const fRoll = (f.rollNo || f.studentUid || "").toUpperCase().trim();
                                return fRoll !== studentRoll && fRoll !== studentUid.toUpperCase() && f.id !== violation.id;
                            });
                        }

                        // If approved, ensure student is added to the session's attendees array
                        if (status === 'APPROVED') {
                            const alreadyPresent = Array.isArray(sessData?.attendees) && sessData.attendees.some(
                                (a) => (a.rollNo || a.studentUid || "").toUpperCase().trim() === studentRoll
                            );

                            const attendeePayload = {
                                id: violation.id,
                                rollNo: studentRoll,
                                studentName: studentName,
                                fullName: studentName,
                                email: studentEmail,
                                faceVerified: true,
                                excused: true,
                                status: 'APPROVED',
                                submittedAt: violation.submittedAt || violation.timestamp || Date.now()
                            };

                            sessionUpdate.attendees = arrayUnion(attendeePayload);
                            if (!alreadyPresent) {
                                sessionUpdate.attendanceCount = increment(1);
                            }
                        }

                        if (Object.keys(sessionUpdate).length > 0) {
                            await updateDoc(sessionRef, sessionUpdate).catch(() => {});
                        }

                        // Also update authorization subcollection
                        const authRef = doc(db, 'attendance_sessions', sessionId, 'authorizations', studentUid);
                        await setDoc(authRef, {
                            status: status === 'APPROVED' ? 'ATTENDED' : 'REVIEWED',
                            released: true,
                            releaseStatus: 'RELEASED',
                            flagged: false,
                            disqualified: false,
                            reviewed: true,
                            excused: status === 'APPROVED'
                        }, { merge: true }).catch(() => {});
                    }
                } catch (sessErr) {
                    console.warn("Session update notice in ViolationReviewModal:", sessErr);
                }
            }

            // 3. Notify the student about the decision in real-time
            if (studentRoll && status !== 'DISMISSED') {
                const statusLabel = status === 'APPROVED' ? 'Approved (Present) ✅' : 'Rejected (Absent) ❌';
                await sendStudentNotification(
                    studentRoll,
                    'Attendance Update',
                    `Your attendance for ${violation.classCode || violation.courseCode || 'class'} was reviewed and marked as ${statusLabel} by your teacher.`,
                    'VIOLATION_DECISION',
                    'lecturer'
                ).catch(() => {});
            }

            if (onActionComplete) onActionComplete(violation.id, status);
            onClose();
        } catch (err) {
            alert('Failed to update violation status: ' + err.message);
        } finally {
            setActionLoading(false);
        }
    };

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.65)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
            padding: '16px'
        }}>
            <div style={{
                backgroundColor: '#ffffff', borderRadius: '20px', padding: '28px',
                maxWidth: '520px', width: '100%', boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
                border: '1px solid #e2e8f0', animation: 'dashFadeIn 0.25s ease'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: '#ef4444', marginBottom: '18px' }}>
                    <div style={{
                        width: '44px', height: '44px', borderRadius: '12px', background: 'rgba(239, 68, 68, 0.1)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px'
                    }}>
                        <FaExclamationTriangle />
                    </div>
                    <div>
                        <h3 style={{ margin: 0, fontSize: '1.25rem', color: '#0f172a', fontWeight: '800' }}>Review Flagged Violation</h3>
                        <p style={{ margin: 0, fontSize: '0.82rem', color: '#64748b' }}>Anti-Proxy Detection Audit</p>
                    </div>
                </div>

                <div style={{ backgroundColor: '#f8fafc', padding: '16px', borderRadius: '14px', fontSize: '0.9rem', marginBottom: '20px', border: '1px solid #e2e8f0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ color: '#64748b' }}>Roll Number:</span>
                        <strong style={{ color: '#0f172a' }}>{violation.rollNo || violation.rollNumber || 'N/A'}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ color: '#64748b' }}>Student Name:</span>
                        <strong style={{ color: '#0f172a' }}>{violation.studentName || violation.name || 'N/A'}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ color: '#64748b' }}>Class Code:</span>
                        <strong style={{ color: '#0f172a' }}>{violation.classCode || violation.courseCode || 'N/A'}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ color: '#64748b' }}>Violation Reason:</span>
                        <span style={{ color: '#dc2626', fontWeight: '750' }}>{violation.violationReason || violation.reason || 'App Switched / Minimised'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#64748b' }}>Time Logged:</span>
                        <span style={{ color: '#475569', fontSize: '0.84rem' }}>
                            {violation.timestamp || violation.submittedAt ? new Date(violation.timestamp || violation.submittedAt).toLocaleTimeString() : 'N/A'}
                        </span>
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={actionLoading}
                        style={{
                            padding: '10px 16px', borderRadius: '12px', border: '1px solid #cbd5e1',
                            backgroundColor: '#ffffff', color: '#475569', fontWeight: '700', cursor: 'pointer',
                            fontSize: '0.86rem'
                        }}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => handleDecision('DISMISSED', 'Violation dismissed / false flag removed')}
                        disabled={actionLoading}
                        style={{
                            padding: '10px 14px', borderRadius: '12px', border: '1px solid #cbd5e1',
                            backgroundColor: '#f1f5f9', color: '#475569', fontWeight: '700', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.86rem'
                        }}
                        title="Remove violation from review list without modifying attendance status"
                    >
                        <FaTrashAlt style={{ fontSize: '0.78rem' }} /> Dismiss Flag
                    </button>
                    <button
                        type="button"
                        onClick={() => handleDecision('REJECTED', 'Violation confirmed by lecturer')}
                        disabled={actionLoading}
                        style={{
                            padding: '10px 16px', borderRadius: '12px', border: 'none',
                            backgroundColor: '#ef4444', color: '#ffffff', fontWeight: '700', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: '6px', boxShadow: '0 4px 12px rgba(239,68,68,0.3)',
                            fontSize: '0.86rem'
                        }}>
                        <FaTimes /> Reject (Absent)
                    </button>
                    <button
                        type="button"
                        onClick={() => handleDecision('APPROVED', 'Violation forgiven by lecturer')}
                        disabled={actionLoading}
                        style={{
                            padding: '10px 18px', borderRadius: '12px', border: 'none',
                            backgroundColor: '#10b981', color: '#ffffff', fontWeight: '700', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: '6px', boxShadow: '0 4px 12px rgba(16,185,129,0.3)',
                            fontSize: '0.86rem'
                        }}>
                        <FaCheck /> Approve (Present)
                    </button>
                </div>
            </div>
        </div>
    );
}
