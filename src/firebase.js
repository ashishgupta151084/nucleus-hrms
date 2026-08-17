import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc, onSnapshot, collection, query, where, orderBy, limit, getDocs, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';

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

export const setConfig = async (data) => {
  // SAFETY: Never write if users array is empty
  if (!data.users || data.users.length === 0) {
    console.error('BLOCKED: setConfig called with empty users');
    return;
  }
  // SAFETY: Check existing data before overwriting
  try {
    const existing = await getDoc(doc(db, 'app', 'config'));
    if (existing.exists()) {
      const existingData = existing.data();
      // Never reduce user count by more than 1 (only allow intentional deletions)
      if (existingData.users && existingData.users.length > data.users.length + 1) {
        console.error('BLOCKED: Attempt to reduce users from', existingData.users.length, 'to', data.users.length);
        // Save emergency backup
        const key = 'emergency_' + new Date().toISOString().slice(0,19).replace(/[:.T]/g,'-');
        await setDoc(doc(db, 'backups', key), {...existingData, backedUpAt: new Date().toISOString(), emergency: true});
        return;
      }
    }
  } catch(e) {
    console.warn('Pre-write check failed:', e.message);
  }
  await setDoc(doc(db, 'app', 'config'), data, { merge: true });
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
