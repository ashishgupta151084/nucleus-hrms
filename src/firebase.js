import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc, onSnapshot, collection, query, where, getDocs, addDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';

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

// ── Firestore helpers ──────────────────────────────────────────────

// App config (users, offices, teams, policies, holidays)
export const getConfig = async () => {
  const snap = await getDoc(doc(db, 'app', 'config'));
  return snap.exists() ? snap.data() : null;
};
export const setConfig = async (data) => {
  await setDoc(doc(db, 'app', 'config'), data, { merge: true });
};
export const onConfig = (cb) => onSnapshot(doc(db, 'app', 'config'), snap => cb(snap.data()));

// Attendance
export const addAttendance = async (rec) => {
  await setDoc(doc(db, 'attendance', rec.id), { ...rec, updatedAt: serverTimestamp() });
};
export const updateAttendance = async (id, data) => {
  await updateDoc(doc(db, 'attendance', id), { ...data, updatedAt: serverTimestamp() });
};
export const onAttendance = (cb) => onSnapshot(collection(db, 'attendance'), snap => {
  cb(snap.docs.map(d => d.data()));
});

// Leaves
export const addLeave = async (rec) => {
  await setDoc(doc(db, 'leaves', rec.id), { ...rec, updatedAt: serverTimestamp() });
};
export const updateLeave = async (id, data) => {
  await updateDoc(doc(db, 'leaves', id), { ...data, updatedAt: serverTimestamp() });
};
export const deleteLeave = async (id) => {
  await deleteDoc(doc(db, 'leaves', id));
};
export const onLeaves = (cb) => onSnapshot(collection(db, 'leaves'), snap => {
  cb(snap.docs.map(d => d.data()));
});

// Regularizations
export const addReg = async (rec) => {
  await setDoc(doc(db, 'regularizations', rec.id), { ...rec, updatedAt: serverTimestamp() });
};
export const updateReg = async (id, data) => {
  await updateDoc(doc(db, 'regularizations', id), { ...data, updatedAt: serverTimestamp() });
};
export const onRegs = (cb) => onSnapshot(collection(db, 'regularizations'), snap => {
  cb(snap.docs.map(d => d.data()));
});

// Live Locations (real-time)
export const updateLiveLocation = async (userId, loc) => {
  await setDoc(doc(db, 'liveLocations', userId), { ...loc, userId, updatedAt: serverTimestamp() });
};
export const onLiveLocations = (cb) => onSnapshot(collection(db, 'liveLocations'), snap => {
  const locs = {};
  snap.docs.forEach(d => { locs[d.id] = d.data(); });
  cb(locs);
});

// Notifications
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