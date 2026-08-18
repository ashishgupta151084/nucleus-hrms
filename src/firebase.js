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
// Save timestamped backup to backups collection
export const saveBackup = async (data) => {
  try {
    if (!data || !data.users || data.users.length === 0) return;
    const key = 'backup_' + new Date().toISOString().slice(0,19).replace(/[:.T]/g,'-');
    await setDoc(doc(db, 'backups', key), {
      ...data,
      backedUpAt: new Date().toISOString(),
      userCount: data.users.length
    });
    console.log('✅ Backup saved:', key, 'Users:', data.users.length);
    // Auto-cleanup: keep only last 30 backups
    const all = await getDocs(collection(db, 'backups'));
    const sorted = all.docs
      .map(d => ({ id: d.id, at: d.data().backedUpAt || '' }))
      .sort((a,b) => b.at.localeCompare(a.at));
    if (sorted.length > 30) {
      const toDelete = sorted.slice(30);
      await Promise.all(toDelete.map(b => deleteDoc(doc(db, 'backups', b.id))));
    }
  } catch(e) {
    console.warn('Backup failed:', e.message);
  }
};

// Get list of all backups
export const getBackups = async () => {
  try {
    const snap = await getDocs(collection(db, 'backups'));
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a,b) => b.backedUpAt?.localeCompare(a.backedUpAt));
  } catch(e) {
    console.warn('Get backups failed:', e.message);
    return [];
  }
};

// Restore from a specific backup
export const restoreBackup = async (backupId) => {
  try {
    const snap = await getDoc(doc(db, 'backups', backupId));
    if (!snap.exists()) throw new Error('Backup not found');
    const data = snap.data();
    if (!data.users || data.users.length === 0) throw new Error('Backup has no users');
    // Remove backup metadata before restoring
    const { backedUpAt, userCount, ...configData } = data;
    await setDoc(doc(db, 'app', 'config'), configData);
    console.log('✅ Restored from backup:', backupId);
    return configData;
  } catch(e) {
    console.error('Restore failed:', e.message);
    throw e;
  }
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
  try {
    const all = await getDocs(collection(db, 'backups'));
    const sorted = all.docs
      .map(d => ({ id: d.id, at: d.data().backedUpAt || '' }))
      .sort((a,b) => b.at.localeCompare(a.at));
    if (sorted.length > 30) {
      const toDelete = sorted.slice(30);
      await Promise.all(toDelete.map(b => deleteDoc(doc(db, 'backups', b.id))));
      return toDelete.length;
    }
    return 0;
  } catch(e) {
    console.warn('Cleanup failed:', e.message);
    return 0;
  }
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
