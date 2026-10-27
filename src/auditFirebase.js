// ── Bank concurrent audits: data layer ───────────────────────────────
// Kept out of the HRMS config document on purpose. Nothing here can touch
// staff, offices or teams.
//
// Collections
//   auditSetup/main            units (bank branches/units with fee), members
//   auditInvoices/{unit}_{YYYY-MM}   one invoice per unit per audit month
//   auditDaily/{unit}_{YYYY-MM-DD}   daily observation count per unit
//   auditCycles/{unit}_{YYYY-MM}     SV dates and report milestones per unit per month
//
// Every write stamps who made it and when (server time), and appends the
// change to the record's own `log`, so nothing is silently overwritten.
import { db } from './firebase';
import { doc, setDoc, onSnapshot, collection, runTransaction, serverTimestamp, arrayUnion } from 'firebase/firestore';

const clean = (obj) => JSON.parse(JSON.stringify(obj, (k, v) => v === undefined ? null : v));
const snapData = d => d.data({ serverTimestamps: 'estimate' });

// ── Setup ───────────────────────────────────────────────────────────
const setupRef = () => doc(db, 'auditSetup', 'main');

export const onAuditSetup = (cb) => onSnapshot(
  setupRef(),
  s => cb(s.exists() ? snapData(s) : { units: [], members: [] }),
  err => { console.warn('auditSetup listener:', err.message); cb({ units: [], members: [], error: err.message }); }
);

// Merge one unit by id inside a transaction, so two admins editing different
// units never overwrite each other.
export const saveAuditUnits = async (upserts = [], removeIds = [], by) => {
  await runTransaction(db, async t => {
    const s = await t.get(setupRef());
    const cur = s.exists() ? s.data() : {};
    const map = new Map((cur.units || []).map(u => [u.id, u]));
    removeIds.forEach(id => map.delete(id));
    upserts.forEach(u => map.set(u.id, { ...(map.get(u.id) || {}), ...u }));
    t.set(setupRef(), clean({ units: [...map.values()], updatedBy: by?.id, updatedByName: by?.name }), { merge: true });
  });
};

export const saveAuditMembers = async (members, by) => {
  await setDoc(setupRef(), clean({ members, updatedBy: by?.id, updatedByName: by?.name }), { merge: true });
};

// ── Generic per-record collections ──────────────────────────────────
const listen = (name) => (cb) => onSnapshot(
  collection(db, name),
  snap => cb(snap.docs.map(snapData)),
  err => { console.warn(name + ' listener:', err.message); cb([]); }
);

export const onAuditInvoices = listen('auditInvoices');
export const onAuditDaily = listen('auditDaily');
export const onAuditCycles = listen('auditCycles');

// Upsert with audit trail. `fields` are the values being set; `note` is optional.
const upsert = (name) => async (id, fields, by, note = '') => {
  const at = new Date().toISOString();
  const f = clean(fields);
  // Sentinels (serverTimestamp, arrayUnion) must be added after clean(),
  // because JSON round-tripping would destroy them.
  await setDoc(doc(db, name, id), {
    ...f,
    id,
    updatedBy: by.id,
    updatedByName: by.name,
    updatedAt: serverTimestamp(),
    log: arrayUnion({ at, by: by.id, byName: by.name, note: note || '', fields: f }),
  }, { merge: true });
};

export const saveAuditInvoice = upsert('auditInvoices');
export const saveAuditDaily = upsert('auditDaily');
export const saveAuditCycle = upsert('auditCycles');
