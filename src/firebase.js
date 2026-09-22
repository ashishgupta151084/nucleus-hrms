import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc, onSnapshot, collection, query, where, orderBy, limit, getDocs, updateDoc, deleteDoc, runTransaction, serverTimestamp } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyBMiDU_w76c7aAIJY37tIGncCrEOqZYXCQ",
  authDomain: "nucleus-hrms.firebaseapp.com",
  projectId: "nucleus-hrms",
  storageBucket: "nucleus-hrms.firebasestorage.app",
  messagingSenderId: "618783995405",
  appId: "1:618783995405:web:88e6a8c07155e9e9204744"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// ── App config ────────────────────────────────────────────────────
export const getConfig = async () => {
  const snap = await getDoc(doc(db, 'app', 'config'));
  return snap.exists() ? snap.data() : null;
};

const mergeRecords = (currentRecords, changes) => {
  const records = new Map(
    (Array.isArray(currentRecords) ? currentRecords : [])
      .filter(record => record?.id)
      .map(record => [record.id, record])
  );

  (changes.removeIds || []).forEach(id => records.delete(id));
  (changes.upserts || []).forEach(record => {
    if (record?.id) records.set(record.id, record);
  });

  return [...records.values()];
};

// Apply only the changes made by the current client.  Saving the entire config
// document meant an older tab could overwrite offices, teams, or staff added
// from another device.  The transaction reads the latest document first and
// merges record-level changes into it.
export const setConfig = async ({ changes = {}, arrayChanges = {}, initialConfig = null } = {}) => {
  const configRef = doc(db, 'app', 'config');

  await runTransaction(db, async transaction => {
    const snap = await transaction.get(configRef);
    const current = snap.exists() ? snap.data() : {};
    const update = snap.exists() ? { ...changes } : { ...(initialConfig || {}), ...changes };

    Object.entries(arrayChanges).forEach(([field, fieldChanges]) => {
      const baseline = snap.exists()
        ? current[field]
        : (initialConfig?.[field] || []);
      update[field] = mergeRecords(baseline, fieldChanges);
    });

    if (Object.keys(update).length > 0) {
      transaction.set(configRef, update, { merge: true });
    }
  });
};

export const onConfig = (cb) => onSnapshot(
  doc(db, 'app', 'config'),
  snap => cb(snap.exists() ? snap.data() : null)
);

// ── Attendance ────────────────────────────────────────────────────
export const addAttendance = async (rec) => {
  await setDoc(doc(db, 'attendance', rec.id), { ...rec, updatedAt: serverTimestamp() });
};
export const updateAttendance = async (id, data) => {
  await updateDoc(doc(db, 'attendance', id), { ...data, updatedAt: serverTimestamp() });
};
export const onAttendance = (cb) => onSnapshot(
  collection(db, 'attendance'),
  snap => cb(snap.docs.map(d => d.data()))
);

// ── Leaves ────────────────────────────────────────────────────────
export const addLeave = async (rec) => {
  await setDoc(doc(db, 'leaves', rec.id), { ...rec, updatedAt: serverTimestamp() });
};
export const updateLeave = async (id, data) => {
  await updateDoc(doc(db, 'leaves', id), { ...data, updatedAt: serverTimestamp() });
};
export const deleteLeave = async (id) => {
  await deleteDoc(doc(db, 'leaves', id));
};
export const onLeaves = (cb) => onSnapshot(
  collection(db, 'leaves'),
  snap => cb(snap.docs.map(d => d.data()))
);

// ── Regularizations ───────────────────────────────────────────────
export const addReg = async (rec) => {
  await setDoc(doc(db, 'regularizations', rec.id), { ...rec, updatedAt: serverTimestamp() });
};
export const updateReg = async (id, data) => {
  await updateDoc(doc(db, 'regularizations', id), { ...data, updatedAt: serverTimestamp() });
};
export const onRegs = (cb) => onSnapshot(
  collection(db, 'regularizations'),
  snap => cb(snap.docs.map(d => d.data()))
);

// ── Live Locations ────────────────────────────────────────────────
export const updateLiveLocation = async (userId, loc) => {
  await setDoc(doc(db, 'liveLocations', userId), { ...loc, userId, updatedAt: serverTimestamp() });
};
export const onLiveLocations = (cb) => onSnapshot(
  collection(db, 'liveLocations'),
  snap => {
    const locs = {};
    snap.docs.forEach(d => { locs[d.id] = d.data(); });
    cb(locs);
  }
);

// ── Notifications ─────────────────────────────────────────────────
export const addNotification = async (rec) => {
  await setDoc(doc(db, 'notifications', rec.id), { ...rec, updatedAt: serverTimestamp() });
};
export const updateNotification = async (id, data) => {
  await updateDoc(doc(db, 'notifications', id), data);
};
export const onNotifications = (userId, cb) => onSnapshot(
  query(collection(db, 'notifications'), where('userId', '==', userId)),
  snap => cb(snap.docs.map(d => d.data()))
);

// ── Backups ───────────────────────────────────────────────────────
// A backup holds SETTINGS ONLY (staff, offices, teams, policies, holidays,
// rules, balances) — never attendance, selfies or notifications, which live in
// their own collections and are not touched by a restore.
// The list of backups is kept in one small document (backups/_index) so the
// Backups screen loads instantly instead of downloading every backup.
const BACKUP_FIELDS = ['users','offices','teams','branches','leavePolicy','holidays','holidayCalendars',
  'leRules','leaveOpenings','companyName','firmId','firmPlan','firmTrial'];
const KEEP_BACKUPS = 30;
const pickConfig = (data) => {
  const out = {};
  BACKUP_FIELDS.forEach(k => { if (data && data[k] !== undefined) out[k] = data[k]; });
  return JSON.parse(JSON.stringify(out, (k, v) => v === undefined ? null : v));
};
const indexRef = () => doc(db, 'backups', '_index');
const readIndex = async () => {
  const s = await getDoc(indexRef());
  return s.exists() && Array.isArray(s.data().items) ? s.data().items : [];
};

// Returns the backup's list entry. Throws if it could not be saved, so the
// screen never claims success when the save failed.
export const saveBackup = async (data, reason = 'auto') => {
  const cfg = pickConfig(data);
  if (!cfg.users || cfg.users.length === 0) throw new Error('Nothing to back up (no staff loaded yet)');
  const at = new Date().toISOString();
  const id = 'backup_' + at.slice(0, 23).replace(/[:.T]/g, '-');   // includes milliseconds
  const sizeKB = Math.round(JSON.stringify(cfg).length / 1024);
  const entry = { id, backedUpAt: at, userCount: cfg.users.length, offices: (cfg.offices || []).length,
    teams: (cfg.teams || []).length, sizeKB, reason };
  await setDoc(doc(db, 'backups', id), { ...cfg, backedUpAt: at, userCount: entry.userCount, reason });
  // Update the list, keep the newest 30, delete the rest by id (no downloads)
  const items = [entry, ...(await readIndex()).filter(x => x.id !== id)]
    .sort((a, b) => b.backedUpAt.localeCompare(a.backedUpAt));
  const keep = items.slice(0, KEEP_BACKUPS), drop = items.slice(KEEP_BACKUPS);
  await setDoc(indexRef(), { items: keep, updatedAt: at });
  await Promise.all(drop.map(x => deleteDoc(doc(db, 'backups', x.id)).catch(() => {})));
  return entry;
};

// The list comes from the small index document — fast on any phone
export const getBackups = async () => readIndex();

// Backups made by older versions of the app are not in the list. This fetches
// the newest few of them, on request only.
export const getOlderBackups = async (n = 5) => {
  const known = new Set((await readIndex()).map(x => x.id));
  const snap = await getDocs(query(collection(db, 'backups'), orderBy('backedUpAt', 'desc'), limit(n + known.size)));
  return snap.docs
    .filter(d => d.id !== '_index' && !known.has(d.id))
    .slice(0, n)
    .map(d => { const x = d.data(); return { id: d.id, backedUpAt: x.backedUpAt, userCount: (x.users || []).length,
      offices: (x.offices || []).length, teams: (x.teams || []).length, legacy: true }; });
};

// Restores SETTINGS only. Attendance, leave applications etc. are untouched.
export const restoreBackup = async (backupId) => {
  const snap = await getDoc(doc(db, 'backups', backupId));
  if (!snap.exists()) throw new Error('Backup not found');
  const cfg = pickConfig(snap.data());
  if (!cfg.users || cfg.users.length === 0) throw new Error('Backup has no staff — not restoring');
  await setDoc(doc(db, 'app', 'config'), cfg);
  return cfg;
};

// ── Work Approvals ────────────────────────────────────────────────
export const addWorkApproval = async (rec) => {
  await setDoc(doc(db, 'workApprovals', rec.id), { ...rec, updatedAt: serverTimestamp() });
};
export const updateWorkApproval = async (id, data) => {
  await updateDoc(doc(db, 'workApprovals', id), { ...data, updatedAt: serverTimestamp() });
};
export const onWorkApprovals = (cb) => onSnapshot(
  collection(db, 'workApprovals'),
  snap => cb(snap.docs.map(d => d.data()))
);

// ── Comp Offs ─────────────────────────────────────────────────────
export const addCompOff = async (rec) => {
  await setDoc(doc(db, 'compoffs', rec.id), { ...rec, updatedAt: serverTimestamp() });
};
export const updateCompOff = async (id, data) => {
  await updateDoc(doc(db, 'compoffs', id), { ...data, updatedAt: serverTimestamp() });
};
export const onCompOffs = (cb) => onSnapshot(
  collection(db, 'compoffs'),
  snap => cb(snap.docs.map(d => d.data()))
);

// ── Backup cleanup ────────────────────────────────────────────────
export const cleanupBackups = async () => {
  const items = await readIndex();
  const drop = items.slice(KEEP_BACKUPS);
  await Promise.all(drop.map(x => deleteDoc(doc(db, 'backups', x.id)).catch(() => {})));
  if (drop.length) await setDoc(indexRef(), { items: items.slice(0, KEEP_BACKUPS), updatedAt: new Date().toISOString() });
  return drop.length;
};

// ── User Passwords (separate from config so restores don't affect them) ──
export const saveUserPassword = async (userId, password) => {
  await setDoc(doc(db, 'userPasswords', userId), {
    userId, password, updatedAt: serverTimestamp()
  });
};
export const getUserPasswords = async () => {
  try {
    const snap = await getDocs(collection(db, 'userPasswords'));
    const map = {};
    snap.docs.forEach(d => { map[d.id] = d.data().password; });
    return map;
  } catch(e) { return {}; }
};
