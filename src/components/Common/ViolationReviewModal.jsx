import React, { useState } from 'react';
import { db } from '../../firebase';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { FaShieldAlt, FaCheck, FaTimes, FaExclamationTriangle } from 'react-icons/fa';
import { sendStudentNotification } from '../../services/notificationsService';

export default function ViolationReviewModal({ violation, onClose, onActionComplete }) {
    const [actionLoading, setActionLoading] = useState(false);

    if (!violation) return null;

    const handleDecision = async (status, reviewNotes) => {
        setActionLoading(true);
        try {
            const recordRef = doc(db, 'attendance_records', violation.id);
            await updateDoc(recordRef, {
                status: status, // 'APPROVED' or 'REJECTED'
                reviewedByRole: 'LECTURER',
                reviewNotes: reviewNotes || 'Reviewed by instructor',
                reviewedAt: serverTimestamp()
            });

            // Notify the student about the decision in real-time
            const studentRoll = violation.rollNo || violation.rollNumber || violation.studentUid;
            if (studentRoll) {
                const statusLabel = status === 'APPROVED' ? 'Approved ✅' : 'Rejected (Absent) ❌';
                await sendStudentNotification(
                    studentRoll,
                    'Flagged Attendance Reviewed',
                    `Your flagged attendance attempt for ${violation.classCode || violation.courseCode || 'class'} was ${statusLabel} by Lecturer.`,
                    'VIOLATION_DECISION',
                    'Lecturer'
                );
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
                maxWidth: '500px', width: '100%', boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
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

                <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                    <button 
                        type="button"
                        onClick={onClose}
                        disabled={actionLoading}
                        style={{
                            padding: '11px 18px', borderRadius: '12px', border: '1px solid #cbd5e1',
                            backgroundColor: '#ffffff', color: '#475569', fontWeight: '700', cursor: 'pointer'
                        }}>
                        Cancel
                    </button>
                    <button 
                        type="button"
                        onClick={() => handleDecision('REJECTED', 'Violation confirmed by lecturer')}
                        disabled={actionLoading}
                        style={{
                            padding: '11px 18px', borderRadius: '12px', border: 'none',
                            backgroundColor: '#ef4444', color: '#ffffff', fontWeight: '700', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: '6px', boxShadow: '0 4px 12px rgba(239,68,68,0.3)'
                        }}>
                        <FaTimes /> Reject (Absent)
                    </button>
                    <button 
                        type="button"
                        onClick={() => handleDecision('APPROVED', 'Violation forgiven by lecturer')}
                        disabled={actionLoading}
                        style={{
                            padding: '11px 18px', borderRadius: '12px', border: 'none',
                            backgroundColor: '#10b981', color: '#ffffff', fontWeight: '700', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: '6px', boxShadow: '0 4px 12px rgba(16,185,129,0.3)'
                        }}>
                        <FaCheck /> Approve
                    </button>
                </div>
            </div>
        </div>
    );
}
