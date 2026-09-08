/**
 * Utility functions for robust user metadata resolution and session-to-lecturer matching.
 */

export function buildUserLookupMaps(usersDocs = [], authUsersDocs = [], recordsDocs = [], sessionsDocs = []) {
  const uidToEmail = new Map();
  const uidToName = new Map();
  const emailToUid = new Map();
  const emailToName = new Map();

  const register = (uid, email, name) => {
    const cleanUid = uid ? String(uid).trim() : "";
    const cleanEmail = email ? String(email).toLowerCase().trim() : "";
    const cleanName = name ? String(name).trim() : "";

    if (cleanUid && cleanEmail) {
      uidToEmail.set(cleanUid, cleanEmail);
      uidToEmail.set(cleanUid.toLowerCase(), cleanEmail);
      emailToUid.set(cleanEmail, cleanUid);
    }
    if (cleanUid && cleanName) {
      uidToName.set(cleanUid, cleanName);
      uidToName.set(cleanUid.toLowerCase(), cleanName);
    }
    if (cleanEmail && cleanName) {
      emailToName.set(cleanEmail, cleanName);
    }
  };

  // 1. Process users collection
  (usersDocs || []).forEach((docSnap) => {
    const d = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
    const id = docSnap.id || d.id;
    const email = d.email;
    const uid = d.uid || (!String(id).includes("@") && String(id).length > 15 ? id : "");
    const name = d.name;
    register(uid, email, name);
    if (id && email) register(id, email, name);
  });

  // 2. Process authorizedUsers collection
  (authUsersDocs || []).forEach((docSnap) => {
    const d = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
    const id = docSnap.id || d.id;
    const email = d.email || (String(id).includes("@") ? id : "");
    const uid = d.uid;
    const name = d.name;
    register(uid, email, name);
    if (id && email) register(id, email, name);
  });

  // 3. Process attendance_records
  (recordsDocs || []).forEach((docSnap) => {
    const d = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
    const ownerId = d.ownerId;
    const lecEmail = d.lecturerEmail || d.ownerEmail;
    const lecName = d.lecturerName;
    register(ownerId, lecEmail, lecName);
  });

  // 4. Process attendance_sessions
  (sessionsDocs || []).forEach((docSnap) => {
    const d = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
    const ownerId = d.ownerId;
    const lecEmail = d.ownerEmail || d.lecturerEmail;
    const lecName = d.lecturerName;
    register(ownerId, lecEmail, lecName);
  });

  return { uidToEmail, uidToName, emailToUid, emailToName };
}

export function normalizeSessions(sessionsDocs = [], recordsDocs = [], lookupMaps = {}) {
  const { uidToEmail = new Map(), uidToName = new Map(), emailToName = new Map() } = lookupMaps;
  const sessionMap = new Map();

  // 1. Ingest attendance_sessions
  (sessionsDocs || []).forEach((docSnap) => {
    const data = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
    const id = docSnap.id || data.id;
    if (!id) return;

    const ownerId = String(data.ownerId || "").trim();
    const resolvedEmail = (data.ownerEmail || data.lecturerEmail || (ownerId ? uidToEmail.get(ownerId) || uidToEmail.get(ownerId.toLowerCase()) : "") || "").toLowerCase().trim();
    const resolvedName = (data.lecturerName || (ownerId ? uidToName.get(ownerId) || uidToName.get(ownerId.toLowerCase()) : "") || (resolvedEmail ? emailToName.get(resolvedEmail) : "") || "").trim();

    sessionMap.set(id, {
      id,
      ...data,
      ownerId,
      ownerEmail: resolvedEmail,
      lecturerEmail: resolvedEmail,
      lecturerName: resolvedName
    });
  });

  // 2. Ingest attendance_records to discover and enrich sessions
  (recordsDocs || []).forEach((docSnap) => {
    const data = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
    const sid = data.sessionId;
    if (!sid) return;

    const existing = sessionMap.get(sid);
    const ownerId = String(data.ownerId || existing?.ownerId || "").trim();
    const resolvedEmail = (data.lecturerEmail || data.ownerEmail || existing?.ownerEmail || (ownerId ? uidToEmail.get(ownerId) || uidToEmail.get(ownerId.toLowerCase()) : "") || "").toLowerCase().trim();
    const resolvedName = (data.lecturerName || existing?.lecturerName || (ownerId ? uidToName.get(ownerId) || uidToName.get(ownerId.toLowerCase()) : "") || (resolvedEmail ? emailToName.get(resolvedEmail) : "") || "").trim();

    sessionMap.set(sid, {
      id: sid,
      classCode: existing?.classCode || data.classCode || "Class",
      courseCode: existing?.courseCode || data.courseCode || "Course",
      roomNo: existing?.roomNo || data.roomNo || "Room",
      batch: existing?.batch || data.batch || "",
      createdAt: existing?.createdAt || data.submittedAt || Date.now(),
      active: existing?.active ?? false,
      expiresAt: existing?.expiresAt || 0,
      ...existing,
      ownerId,
      ownerEmail: resolvedEmail,
      lecturerEmail: resolvedEmail,
      lecturerName: resolvedName
    });
  });

  return Array.from(sessionMap.values());
}

export function doesSessionBelongToLecturer(sess, lecturer, lookupMaps = {}) {
  if (!sess || !lecturer) return false;

  const { uidToEmail = new Map(), emailToUid = new Map() } = lookupMaps;

  const lecEmail = (lecturer.email || "").toLowerCase().trim();
  const lecPrefix = lecEmail ? lecEmail.split("@")[0].toLowerCase().trim() : "";
  const lecUid = String(lecturer.uid || (lecEmail ? emailToUid.get(lecEmail) : "") || "").toLowerCase().trim();
  const lecUserDocId = String(lecturer.userDocId || "").toLowerCase().trim();
  const lecEmailDocId = String(lecturer.emailDocId || "").toLowerCase().trim();
  const lecId = String(lecturer.id || "").toLowerCase().trim();
  const lecName = (lecturer.name || "").toLowerCase().trim();

  const ownerId = String(sess.ownerId || "").toLowerCase().trim();
  const ownerEmail = String(sess.ownerEmail || sess.lecturerEmail || sess.email || sess.createdBy || "").toLowerCase().trim();
  const sessLecturerName = String(sess.lecturerName || sess.facultyName || "").toLowerCase().trim();
  const resolvedOwnerEmail = (ownerId ? (uidToEmail.get(ownerId) || uidToEmail.get(sess.ownerId)) : "")?.toLowerCase().trim() || "";

  // 1. Direct UID match
  if (lecUid && ownerId === lecUid) return true;
  if (lecUserDocId && (ownerId === lecUserDocId || ownerEmail === lecUserDocId)) return true;
  if (lecId && !lecId.includes("@") && ownerId === lecId) return true;
  if (resolvedOwnerEmail && (resolvedOwnerEmail === lecEmail || resolvedOwnerEmail === lecEmailDocId)) return true;

  // 2. Direct Email match
  if (lecEmail && (ownerEmail === lecEmail || ownerId === lecEmail)) return true;
  if (lecEmailDocId && (ownerEmail === lecEmailDocId || ownerId === lecEmailDocId)) return true;
  if (lecId && lecId.includes("@") && (ownerEmail === lecId || ownerId === lecId)) return true;

  // 3. Exact Email Prefix Match (e.g. "k22bcs108", "onteddukalyani") - strictly exact match
  if (lecPrefix && lecPrefix.length >= 3) {
    if (ownerId === lecPrefix || ownerEmail === lecPrefix) return true;
    if (ownerEmail === `${lecPrefix}@iiitdwd.ac.in` || ownerEmail === `${lecPrefix}@gmail.com`) return true;
  }

  // 4. Exact Full Name Match (ONLY if non-generic and at least 4 characters)
  const genericNames = new Set(["lecturer", "faculty", "admin", "faculty member", "user", "teacher", "unknown", "n/a", "student", "staff"]);
  if (lecName && sessLecturerName && !genericNames.has(lecName) && !genericNames.has(sessLecturerName) && lecName.length >= 4) {
    if (sessLecturerName === lecName) return true;
  }

  return false;
}
