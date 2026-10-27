// ══════════════════════════════════════════════════════════════════
// BANK CONCURRENT AUDITS
// 1. Invoice tracker  — one invoice per unit per audit month, bank-specific stages
// 2. Observation tracker — daily counts, SV dates, report milestones, MIS
// Loaded on demand from App.jsx (separate bundle).
// ══════════════════════════════════════════════════════════════════
import { useState, useEffect, useMemo, createContext, useContext } from "react";
import {
  saveAuditUnits, saveAuditMembers,
  onAuditInvoices, onAuditDaily, onAuditCycles,
  saveAuditInvoice, saveAuditDaily, saveAuditCycle,
} from "./auditFirebase";

// ── Banks and their invoice workflows ───────────────────────────────
const BANKS = {
  indusind: {
    name: "IndusInd Bank", short: "IndusInd", svPerMonth: 2,
    stages: [
      { k: "raised", label: "Raised in MyAudit" },
      { k: "with_team", label: "Shared with team member" },
      { k: "submitted", label: "Submitted to bank" },
      { k: "req_no", label: "Bank request no. received" },
      { k: "paid", label: "Payment received" },
    ],
  },
  icici: {
    name: "ICICI Bank", short: "ICICI", svPerMonth: 1,
    stages: [
      { k: "raised", label: "Raised in MyAudit" },
      { k: "with_team", label: "Shared with team member" },
      { k: "dsc", label: "DSC attached" },
      { k: "mailed", label: "Mailed to bank" },
      { k: "paid", label: "Payment received" },
    ],
  },
};
const RETURNED = { k: "returned", label: "Returned by bank" };
const DEFAULT_UNITS = [
  ["indusind", "Sangam Tower"], ["indusind", "Bapu Nagar"], ["indusind", "Rajapark"], ["indusind", "Udaipur"],
  ["icici", "ICMC Jaipur"], ["icici", "Suncity Gurgaon Branch"], ["icici", "VKIA Jaipur Branch"],
];
const Ctx = createContext(null);
const useCtx = () => useContext(Ctx);
// Field label style (same as the HRMS form labels)
const ui_L = { fontSize: 11, color: "#5a6b91", marginBottom: 4, display: "block", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" };
const REPORT_DUE_DAY = 10; // final report due on the 10th of the following month

// ── Date helpers (all local dates as YYYY-MM-DD strings) ────────────
const pad = n => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const thisMonth = () => today().slice(0, 7);
const addMonth = (m, n) => { const [y, mo] = m.split("-").map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const monthsFrom = (a, b) => { const out = []; for (let m = a; m <= b; m = addMonth(m, 1)) out.push(m); return out; };
const lastDay = m => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo, 0).getDate(); };
const daysOf = m => Array.from({ length: lastDay(m) }, (_, i) => `${m}-${pad(i + 1)}`);
const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mLabel = m => m ? `${MN[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : "";
const dLabel = d => d ? `${Number(d.slice(8, 10))} ${MN[Number(d.slice(5, 7)) - 1]}` : "—";
const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 86400000);
const fyStart = m => Number(m.slice(5, 7)) >= 4 ? `${m.slice(0, 4)}-04` : `${Number(m.slice(0, 4)) - 1}-04`;
// Banks close on Sundays and the 2nd and 4th Saturdays, plus the holidays in the
// unit's HRMS holiday calendar (e.g. BFSI Rajasthan, BFSI Haryana).
// An entry made on such a day still counts; the day is just never flagged as missing.
const weekendOff = ds => { const d = new Date(ds + "T12:00:00"), w = d.getDay(); if (w === 0) return "Sunday"; if (w !== 6) return null; const k = Math.ceil(d.getDate() / 7); return k === 2 ? "2nd Saturday" : k === 4 ? "4th Saturday" : null; };
const offReason = (ds, hols) => weekendOff(ds) || hols?.get(ds) || null;
const isOff = (ds, hols) => !!offReason(ds, hols);
const DEFAULT_CAL = "cal_default"; // same fallback HRMS uses for holidays saved without a calendar
const holidaysFor = (D, calId) => new Map(calId ? (D.holidays || []).filter(h => (h.calendarId || DEFAULT_CAL) === calId).map(h => [h.date, h.name]) : []);
const addDay = (ds, n) => { const d = new Date(ds + "T12:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// Final report: 10th of the next month. If that is a holiday, the last working day BEFORE it.
const dueDate = (m, hols) => { let d = `${addMonth(m, 1)}-${pad(REPORT_DUE_DAY)}`; for (let i = 0; i < 15 && isOff(d, hols); i++) d = addDay(d, -1); return d; };;
const tsText = ts => {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d)) return "";
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};
const inr = n => (n || n === 0) && !isNaN(n) ? "₹" + Math.round(Number(n)).toLocaleString("en-IN") : "—";
const num = v => v === "" || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v);
const gid = () => Math.random().toString(36).slice(2, 11);

// SV slots for a unit in a month
const svSlots = (bank, m) => bank === "indusind"
  ? [{ k: "sv1", label: "SV 1 (1–15)", from: `${m}-01`, to: `${m}-15` }, { k: "sv2", label: `SV 2 (16–${lastDay(m)})`, from: `${m}-16`, to: `${m}-${pad(lastDay(m))}` }]
  : [{ k: "sv1", label: "SV (monthly)", from: `${m}-01`, to: `${m}-${pad(lastDay(m))}` }];

const csvDownload = (name, rows) => {
  const csv = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = "data:text/csv;charset=utf-8," + encodeURIComponent("﻿" + csv);
  a.download = name; a.click();
};

// ── Derived status helpers ──────────────────────────────────────────
const stageInfo = (bank, k) => {
  if (!k || k === "not_raised") return { label: "Not raised", idx: -1 };
  if (k === "returned") return { label: RETURNED.label, idx: 0 };
  const st = BANKS[bank]?.stages || [];
  const i = st.findIndex(s => s.k === k);
  return { label: st[i]?.label || k, idx: i };
};

const cycleStatus = (c, m, td, unit) => {
  const due = dueDate(m, unit?.hols);
  if (c?.finalDate) return { label: `Final ${dLabel(c.finalDate)}`, tone: c.finalDate > due ? "late" : "ok", due };
  const left = daysBetween(td, due);
  if (td < `${addMonth(m, 1)}-01`) return { label: "Month in progress", tone: "neutral", due };
  if (left < 0) return { label: `Final overdue ${-left}d`, tone: "bad", due };
  return { label: `Final due in ${left}d`, tone: left <= 3 ? "warn" : "neutral", due };
};

// ══════════════════════════════════════════════════════════════════
export default function BankAudit({ user, D, ST, AN, setSc, setup, ui }) {
  const { G, B, I, K } = ui;
  const isAdmin = ["admin", "hr"].includes(user.role);
  const [tab, setTab] = useState("mis");
  const [month, setMonth] = useState(thisMonth());
  const [invoices, setInvoices] = useState([]);
  const [daily, setDaily] = useState([]);
  const [cycles, setCycles] = useState([]);
  useEffect(() => onAuditInvoices(setInvoices), []);
  useEffect(() => onAuditDaily(setDaily), []);
  useEffect(() => onAuditCycles(setCycles), []);

  const units = useMemo(() => (setup?.units || []).slice().sort((a, b) =>
    ((a.order ?? 99) - (b.order ?? 99)) || a.name.localeCompare(b.name))
    .map(u => ({ ...u, hols: holidaysFor(D, u.calendarId) })), [setup, D.holidays]);
  const active = units.filter(u => u.active !== false);
  const by = { id: user.id, name: user.name };
  const back = () => setSc(["admin", "hr"].includes(user.role) ? "dash" : "home");
  const ctx = { G, B, I, K, ui, user, by, D, ST, AN, units, active, invoices, daily, cycles, month, setMonth, isAdmin };

  const tabs = [["mis", "📊 MIS"], ["daily", "📝 Daily update"], ["cycle", "📅 SV & reports"], ["inv", "🧾 Invoices"], ...(isAdmin ? [["setup", "⚙ Setup"]] : [])];
  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "14px 14px 80px" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <button onClick={back} style={{ ...B(G.card), border: `1px solid ${G.bdr}`, padding: "8px 14px" }}>← Back</button>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 900, flex: 1 }}>Bank Concurrent Audits</h2>
        {tab !== "inv" && tab !== "setup" && (
          <input type="month" value={month} max={thisMonth()} onChange={e => e.target.value && setMonth(e.target.value)} style={{ ...I, width: 160 }} />
        )}
      </div>
      <div style={{ display: "flex", gap: 5, marginBottom: 12, overflowX: "auto", paddingBottom: 4 }}>
        {tabs.map(([id, lb]) => (
          <button key={id} onClick={() => setTab(id)} style={{ ...B(tab === id ? G.gold : G.card), whiteSpace: "nowrap", fontSize: 12, padding: "7px 11px", border: tab === id ? "none" : `1px solid ${G.bdr}`, color: tab === id ? "#fff" : G.mut, flexShrink: 0, fontWeight: tab === id ? 800 : 600 }}>{lb}</button>
        ))}
      </div>
      <Ctx.Provider value={ctx}>
      {setup?.error && <div style={{ ...K, borderColor: G.rd, color: G.rd, fontSize: 13 }}>Could not load audit setup: {setup.error}. If this says "permission", the Firestore rules need the audit collections allowed.</div>}
      {units.length === 0 && tab !== "setup" ? (
        <div style={{ ...K, textAlign: "center", padding: 30 }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>No bank units set up yet</div>
          <div style={{ fontSize: 13, color: G.mut }}>{isAdmin ? "Open Setup to add the branches and their monthly fees." : "Ask Admin or HR to set up the bank units."}</div>
          {isAdmin && <button onClick={() => setTab("setup")} style={{ ...B(G.gold), marginTop: 12 }}>Open Setup</button>}
        </div>
      ) : (
        <>
          {tab === "mis" && <MIS {...ctx} />}
          {tab === "daily" && <Daily {...ctx} />}
          {tab === "cycle" && <Cycle {...ctx} />}
          {tab === "inv" && <Invoices {...ctx} />}
        </>
      )}
      {tab === "setup" && isAdmin && <Setup {...ctx} setup={setup} />}
      </Ctx.Provider>
    </div>
  );
}

// Small shared bits
const BankChip = ({ bank, G }) => (
  <span style={{ fontSize: 10, fontWeight: 800, padding: "2px 7px", borderRadius: 20, background: bank === "icici" ? "#fde8d7" : "#e3e8f7", color: bank === "icici" ? "#8a3b00" : G.navy, whiteSpace: "nowrap" }}>{BANKS[bank]?.short || bank}</span>
);
const toneColor = (G, t) => ({ ok: G.gr, late: G.am, bad: G.rd, warn: G.am, neutral: G.mut }[t] || G.mut);
const Stamp = ({ rec, G }) => rec?.updatedByName
  ? <div style={{ fontSize: 11, color: G.dim, marginTop: 6 }}>Last updated by <b>{rec.updatedByName}</b> · {tsText(rec.updatedAt)}</div>
  : null;
const Tile = ({ G, K, label, value, sub, color }) => (
  <div style={{ ...K, flex: "1 1 150px", marginBottom: 0, padding: 14 }}>
    <div style={{ fontSize: 10, color: G.mut, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
    <div style={{ fontSize: 24, fontWeight: 900, color: color || G.txt, marginTop: 2 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: G.dim, marginTop: 2 }}>{sub}</div>}
  </div>
);

// ── Derived observation numbers for a unit/month ────────────────────
const unitMonthObs = (daily, unit, m, td) => {
  const recs = daily.filter(d => d.unitId === unit.id && d.date?.startsWith(m));
  const byDate = Object.fromEntries(recs.map(r => [r.date, r]));
  const total = recs.reduce((s, r) => s + (r.status === "off" ? 0 : (Number(r.obs) || 0)), 0);
  const started = !unit.startMonth || m >= unit.startMonth;
  // Days are expected only from the unit's "daily entries from" date, so going live mid-month doesn't flag the past
  const from = unit.dailyFrom || (unit.startMonth ? `${unit.startMonth}-01` : "");
  const missing = !started || unit.active === false ? [] : daysOf(m).filter(ds => ds < td && ds >= from && !isOff(ds, unit.hols) && !byDate[ds]);
  const last = recs.slice().sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0))[0];
  const lastDate = recs.map(r => r.date).sort().pop();
  return { recs, byDate, total, missing, last, lastDate };
};
const fyObs = (daily, unit, m) => {
  const s = fyStart(m), e = `${m}-31`;
  return daily.filter(d => d.unitId === unit.id && d.date >= s && d.date <= e && d.status !== "off").reduce((a, r) => a + (Number(r.obs) || 0), 0);
};

// ══════════════════════════════════════════════════════════════════
// MIS
// ══════════════════════════════════════════════════════════════════
function MIS({ G, B, K, active, daily, cycles, invoices, month, units }) {
  const td = today();
  const rows = active.map(u => {
    const o = unitMonthObs(daily, u, month, td);
    const c = cycles.find(x => x.id === `${u.id}_${month}`);
    const svs = svSlots(u.bank, month).map(s => ({ ...s, date: c?.sv?.[s.k] || "", overdue: !c?.sv?.[s.k] && td > s.to }));
    return { u, o, c, svs, fy: fyObs(daily, u, month), cs: cycleStatus(c, month, td, u) };
  });
  const isCur = month === thisMonth();
  const updatedToday = active.filter(u => daily.some(d => d.unitId === u.id && d.date === td)).length;
  const missingTotal = rows.reduce((s, r) => s + r.o.missing.length, 0);
  const obsTotal = rows.reduce((s, r) => s + r.o.total, 0);
  const finals = rows.filter(r => r.c?.finalDate).length;
  const overdueReports = rows.filter(r => r.cs.tone === "bad").length;
  const svOverdue = rows.reduce((s, r) => s + r.svs.filter(x => x.overdue).length, 0);
  // Invoice position across all months
  const inv = invoiceRows(units, invoices, td);
  const open = inv.filter(r => r.stage !== "paid" && r.stage !== "not_raised");
  const outstanding = open.reduce((s, r) => s + (r.rec?.total || 0), 0);
  const notRaised = inv.filter(r => r.stage === "not_raised" && r.month < thisMonth()).length;
  const days = daysOf(month);
  // Day being reviewed in the observations panel: today in the current month, else the
  // latest day of the month that has entries. Tapping a cell in the grid changes it.
  const lastWithData = daily.filter(d => d.date?.startsWith(month)).map(d => d.date).sort().pop();
  const [rv, setRv] = useState(null);
  const reviewDate = rv && rv.startsWith(month) ? rv : (isCur ? td : lastWithData || `${month}-01`);

  const exportMis = () => {
    const head = ["Bank", "Unit", "Month", "Observations (month)", "Observations (FY)", "Days missing", "Missing dates", ...["SV 1", "SV 2"], "Report shared", "Response received", "Final published", "Final due", "Status", "Last updated by", "Last updated at"];
    const body = rows.map(r => [BANKS[r.u.bank].short, r.u.name, mLabel(month), r.o.total, r.fy, r.o.missing.length, r.o.missing.map(dLabel).join(" "),
      r.svs[0]?.date || "", r.svs[1]?.date || (r.u.bank === "icici" ? "n/a" : ""),
      r.c?.reportSharedDate || "", r.c?.responseDate || "", r.c?.finalDate || "", r.cs.due, r.cs.label,
      r.o.last?.updatedByName || r.c?.updatedByName || "", tsText(r.o.last?.updatedAt || r.c?.updatedAt)]);
    const head2 = ["Bank", "Unit", ...days.map(d => d.slice(8))];
    const body2 = rows.map(r => [BANKS[r.u.bank].short, r.u.name, ...days.map(d => { const x = r.o.byDate[d]; return x ? (x.status === "off" ? "off" : x.obs) : (d < td && !isOff(d, r.u.hols) ? "MISSING" : offReason(d, r.u.hols) && !weekendOff(d) ? offReason(d, r.u.hols) : ""); })]);
    const head3 = ["Date", "Bank", "Unit", "Status", "Count", "Shared with branch", "Observations", "Entered by", "Entered at"];
    const body3 = daily.filter(x => x.date?.startsWith(month) && active.some(u => u.id === x.unitId))
      .sort((a, b) => a.date.localeCompare(b.date) || a.unitId.localeCompare(b.unitId))
      .map(x => { const u = active.find(v => v.id === x.unitId); return [x.date, BANKS[u.bank].short, u.name, x.status === "off" ? "No audit" : "Audit done", x.status === "off" ? "" : x.obs, x.sharedDate || "", x.observations ?? x.remarks ?? "", x.updatedByName, tsText(x.updatedAt)]; });
    csvDownload(`Audit_MIS_${month}.csv`, [head, ...body, [], ["Daily observation grid"], head2, ...body2, [], ["Observations log"], head3, ...body3]);
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {isCur && <Tile G={G} K={K} label="Updated today" value={`${updatedToday}/${active.length}`} color={updatedToday < active.length ? G.am : G.gr} sub={active.length && active.every(u => isOff(td, u.hols)) ? "Bank holiday today" : "units with today's entry"} />}
        <Tile G={G} K={K} label={`Observations · ${mLabel(month)}`} value={obsTotal} sub={`${active.length} units`} />
        <Tile G={G} K={K} label="Missing daily entries" value={missingTotal} color={missingTotal ? G.rd : G.gr} sub="working days with no update" />
        <Tile G={G} K={K} label="SV overdue" value={svOverdue} color={svOverdue ? G.rd : G.gr} />
        <Tile G={G} K={K} label="Final reports" value={`${finals}/${active.length}`} color={overdueReports ? G.rd : G.txt} sub={(() => { const ds = [...new Set(rows.map(r => r.cs.due))].sort(); const when = ds.length === 1 ? dLabel(ds[0]) : `${dLabel(ds[0])}–${dLabel(ds[ds.length - 1])}`; return overdueReports ? `${overdueReports} overdue (due ${when})` : `due ${when}`; })()} />
        <Tile G={G} K={K} label="Invoices outstanding" value={inr(outstanding)} sub={`${open.length} unpaid · ${notRaised} not raised`} color={notRaised ? G.am : G.txt} />
      </div>

      <div style={{ ...K, padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", borderBottom: `1px solid ${G.bdr}` }}>
          <div style={{ fontWeight: 800 }}>Unit status · {mLabel(month)}</div>
          <button onClick={exportMis} style={{ ...B(G.bl), fontSize: 12, padding: "7px 12px" }}>📥 Export</button>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 820 }}>
            <thead>
              <tr style={{ background: G.card2, textAlign: "left" }}>
                {["Unit", "Obs (month)", "Obs (FY)", "Missing days", "SV", "Report shared", "Response", "Final", "Last update"].map(h => <th key={h} style={{ padding: "8px 10px", fontSize: 10, textTransform: "uppercase", color: G.mut, fontWeight: 800 }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.u.id} style={{ borderTop: `1px solid ${G.bdr}`, verticalAlign: "top" }}>
                  <td style={{ padding: "9px 10px" }}><div style={{ fontWeight: 800 }}>{r.u.name}</div><BankChip bank={r.u.bank} G={G} /></td>
                  <td style={{ padding: "9px 10px", fontWeight: 900, fontSize: 15 }}>{r.o.total}</td>
                  <td style={{ padding: "9px 10px", color: G.mut }}>{r.fy}</td>
                  <td style={{ padding: "9px 10px", color: r.o.missing.length ? G.rd : G.gr, fontWeight: 700 }}>
                    {r.o.missing.length || "✓"}
                    {r.o.missing.length > 0 && <div style={{ fontSize: 10, fontWeight: 600 }}>{r.o.missing.slice(-4).map(dLabel).join(", ")}{r.o.missing.length > 4 ? "…" : ""}</div>}
                  </td>
                  <td style={{ padding: "9px 10px" }}>{r.svs.map(s => <div key={s.k} style={{ color: s.date ? G.gr : s.overdue ? G.rd : G.dim, fontWeight: 600 }}>{s.date ? `✓ ${dLabel(s.date)}` : s.overdue ? `${s.label.split(" (")[0]} overdue` : `${s.label.split(" (")[0]} due`}</div>)}</td>
                  <td style={{ padding: "9px 10px" }}>{dLabel(r.c?.reportSharedDate)}</td>
                  <td style={{ padding: "9px 10px" }}>{dLabel(r.c?.responseDate)}</td>
                  <td style={{ padding: "9px 10px", color: toneColor(G, r.cs.tone), fontWeight: 700 }}>{r.cs.label}</td>
                  <td style={{ padding: "9px 10px", fontSize: 11, color: G.mut }}>
                    {r.o.last ? <>Entry for {dLabel(r.o.lastDate)}<br /><b>{r.o.last.updatedByName}</b> · {tsText(r.o.last.updatedAt)}</> : <span style={{ color: G.rd }}>No entries</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ ...K, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "12px 14px", borderBottom: `1px solid ${G.bdr}`, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
          <div style={{ fontWeight: 800 }}>Daily observations · {mLabel(month)}</div>
          <div style={{ fontSize: 11, color: G.mut, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span><b style={{ color: G.rd }}>!</b> missing</span><span style={{ color: G.dim }}>· Sun / 2nd–4th Sat</span><span style={{ color: G.dim }}>H holiday (hover for name)</span><span>off = no audit</span>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, background: G.card, padding: "6px 10px", textAlign: "left", minWidth: 150, zIndex: 1 }}>Unit</th>
                {days.map(d => <th key={d} style={{ padding: "6px 0", width: 26, minWidth: 26, color: weekendOff(d) ? G.dim : G.mut, fontWeight: 700, background: d === td ? "#fff3cd" : "transparent" }}>{Number(d.slice(8))}</th>)}
                <th style={{ padding: "6px 10px" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.u.id} style={{ borderTop: `1px solid ${G.bdr}` }}>
                  <td style={{ position: "sticky", left: 0, background: G.card, padding: "6px 10px", fontWeight: 700, whiteSpace: "nowrap", zIndex: 1 }}>{r.u.name}</td>
                  {days.map(d => {
                    const x = r.o.byDate[d];
                    const miss = r.o.missing.includes(d);
                    const why = offReason(d, r.u.hols);
                    const off = !!why;
                    const n = x && x.status !== "off" ? Number(x.obs) || 0 : null;
                    const bg = miss ? "#fde2e1" : x?.status === "off" ? G.card2 : n ? `rgba(22,98,196,${Math.min(0.12 + n * 0.08, 0.6)})` : off ? "#f3f4f8" : "transparent";
                    return <td key={d} onClick={() => setRv(d)} title={(x ? `${dLabel(d)}: ${x.status === "off" ? "no audit" : n + " obs"} · by ${x.updatedByName}` : dLabel(d)) + (why ? ` · ${why}` : "")}
                      style={{ textAlign: "center", padding: "6px 0", background: bg, color: miss ? G.rd : n > 4 ? "#fff" : G.txt, fontWeight: miss || n ? 800 : 400, borderLeft: `1px solid ${G.bdr}`, cursor: "pointer", outline: d === reviewDate ? `2px solid ${G.navy}` : "none", outlineOffset: -2 }}>
                      {miss ? "!" : x?.status === "off" ? "off" : n !== null ? n : off ? (weekendOff(d) ? "·" : "H") : ""}
                    </td>;
                  })}
                  <td style={{ padding: "6px 10px", fontWeight: 900 }}>{r.o.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ ...K }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <div>
            <div style={{ fontWeight: 800 }}>Observations for review · {dLabel(reviewDate)}</div>
            <div style={{ fontSize: 11, color: G.mut }}>Tap any day in the grid above to see its observations.</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setRv(addDay(reviewDate, -1))} disabled={reviewDate <= `${month}-01`} style={{ ...B(G.card), border: `1px solid ${G.bdr}`, padding: "6px 12px", fontSize: 12 }}>← Prev day</button>
            <button onClick={() => setRv(addDay(reviewDate, 1))} disabled={reviewDate >= `${month}-${pad(lastDay(month))}` || reviewDate >= td} style={{ ...B(G.card), border: `1px solid ${G.bdr}`, padding: "6px 12px", fontSize: 12 }}>Next day →</button>
          </div>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {rows.map(r => {
            const x = r.o.byDate[reviewDate];
            const why = offReason(reviewDate, r.u.hols);
            const text = x ? (x.observations ?? x.remarks ?? "") : "";
            return (
              <div key={r.u.id} style={{ borderTop: `1px solid ${G.bdr}`, paddingTop: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}><b>{r.u.name}</b><BankChip bank={r.u.bank} G={G} />
                    {x && x.status !== "off" && <span style={{ fontSize: 12, fontWeight: 800 }}>{x.obs} obs</span>}</div>
                  <div style={{ fontSize: 11, color: G.dim }}>{x ? <>by <b>{x.updatedByName}</b> · {tsText(x.updatedAt)}{x.status !== "off" && (x.sharedDate ? ` · shared ${dLabel(x.sharedDate)}` : " · not shared yet")}</> : ""}</div>
                </div>
                <div style={{ fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: x ? G.txt : r.o.missing.includes(reviewDate) ? G.rd : G.dim }}>
                  {x ? (x.status === "off" ? "No audit this day." : text || (x.obs ? "Count entered, observations not written." : "No observations.")) : r.o.missing.includes(reviewDate) ? "Not updated." : why ? `Holiday: ${why}` : "No entry."}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════
// DAILY UPDATE — one row per unit for the chosen date
// ══════════════════════════════════════════════════════════════════
function Daily({ G, K, I, active, daily, month }) {
  const td = today();
  const [date, setDate] = useState(month === thisMonth() ? td : `${month}-${pad(lastDay(month))}`);
  useEffect(() => { if (!date.startsWith(month)) setDate(month === thisMonth() ? td : `${month}-01`); }, [month]);
  return (
    <>
      <div style={{ ...K, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 800 }}>Daily observations for</div>
          <div style={{ fontSize: 12, color: G.mut }}>Enter the count found that day, even if it is 0. Mark "No audit" for a holiday or a day the branch was not covered.</div>
        </div>
        <input type="date" value={date} max={td} onChange={e => e.target.value && setDate(e.target.value)} style={{ ...I, width: 170 }} />
      </div>
      {weekendOff(date) && <div style={{ ...K, background: "#fff8e6", borderColor: "#f0d48a", fontSize: 12, color: G.am }}>{dLabel(date)} is a {weekendOff(date)}. Enter only if the audit actually ran.</div>}
      {active.map(u => <DailyRow key={u.id + date} u={u} date={date} rec={daily.find(d => d.id === `${u.id}_${date}`)} daily={daily} />)}
    </>
  );
}

function DailyRow({ u, date, rec, daily }) {
  const { G, B, I, K, ST, by } = useCtx();
  const init = () => ({ status: rec?.status || "worked", obs: rec?.obs ?? "", sharedDate: rec?.sharedDate || "", observations: rec?.observations ?? rec?.remarks ?? "" });
  const [f, setF] = useState(init);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  // Pick up a save made elsewhere, unless this row is being edited
  useEffect(() => { if (!dirty) setF(init()); }, [rec?.updatedAt?.seconds]);
  const set = p => { setF(x => ({ ...x, ...p })); setDirty(true); };
  const m = date.slice(0, 7);
  const cum = daily.filter(d => d.unitId === u.id && d.date?.startsWith(m) && d.date < date && d.status !== "off").reduce((s, r) => s + (Number(r.obs) || 0), 0)
    + (f.status === "off" ? 0 : (num(f.obs) || 0));
  const save = async () => {
    if (f.status === "worked") {
      const n = num(f.obs);
      if (n === null || n < 0 || !Number.isInteger(n)) return ST(`${u.name}: enter the number of observations (0 if none)`, "error");
      if (f.sharedDate && f.sharedDate < date) return ST(`${u.name}: shared date can't be before the observation date`, "error");
      if (f.sharedDate && f.sharedDate > today()) return ST(`${u.name}: shared date is in the future`, "error");
    }
    setBusy(true);
    try {
      await saveAuditDaily(`${u.id}_${date}`, {
        unitId: u.id, bank: u.bank, date, month: m, status: f.status,
        obs: f.status === "off" ? 0 : num(f.obs), sharedDate: f.status === "off" ? "" : f.sharedDate, observations: f.status === "off" ? "" : f.observations.trim(),
      }, by, rec ? "edited" : "entered");
      setDirty(false); ST(`✅ ${u.name} saved`);
    } catch (e) { ST("Save failed: " + e.message, "error"); }
    setBusy(false);
  };
  const off = f.status === "off";
  return (
    <div style={{ ...K, borderLeft: `4px solid ${rec ? G.gr : date < today() && !isOff(date, u.hols) ? G.rd : G.bdr}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontWeight: 800 }}>{u.name}</span><BankChip bank={u.bank} G={G} /></div>
        <div style={{ fontSize: 12, color: G.mut }}>Month to date: <b style={{ color: G.txt, fontSize: 14 }}>{cum}</b></div>
      </div>
      {u.hols.get(date) && !rec && <div style={{ fontSize: 12, color: G.am, fontWeight: 700, marginBottom: 8 }}>Holiday: {u.hols.get(date)}. No entry needed unless the audit ran.</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 130px" }}>
          <label style={ui_L}>Status</label>
          <select style={I} value={f.status} onChange={e => set({ status: e.target.value })}>
            <option value="worked">Audit done</option>
            <option value="off">No audit (holiday/leave)</option>
          </select>
        </div>
        <div style={{ flex: "1 1 100px" }}>
          <label style={ui_L}>Observations today</label>
          <input type="number" min="0" step="1" inputMode="numeric" style={{ ...I, opacity: off ? 0.4 : 1 }} disabled={off} value={off ? "" : f.obs} onChange={e => set({ obs: e.target.value })} placeholder="0" />
        </div>
        <div style={{ flex: "1 1 150px" }}>
          <label style={ui_L}>Shared with branch on</label>
          <input type="date" min={date} max={today()} style={{ ...I, opacity: off ? 0.4 : 1 }} disabled={off} value={off ? "" : f.sharedDate} onChange={e => set({ sharedDate: e.target.value })} />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <label style={ui_L}>Observations</label>
        <textarea style={{ ...I, minHeight: 110, resize: "vertical", lineHeight: 1.5, opacity: off ? 0.4 : 1 }} disabled={off} value={off ? "" : f.observations}
          onChange={e => set({ observations: e.target.value })}
          placeholder={"One observation per line, e.g.\n1. KYC not updated for 3 SB accounts opened this week\n2. Cash retention limit exceeded on 26 Oct"} />
        {!off && f.observations.trim() && <div style={{ fontSize: 11, color: G.dim, marginTop: 3 }}>{f.observations.trim().split(/\n+/).filter(Boolean).length} line(s) written</div>}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, gap: 8, flexWrap: "wrap" }}>
        <div>{rec ? <Stamp rec={rec} G={G} /> : <div style={{ fontSize: 11, color: G.dim }}>Not entered yet</div>}
          {!off && rec && !rec.sharedDate && <div style={{ fontSize: 11, color: G.am, fontWeight: 700 }}>Not yet shared with branch</div>}</div>
        <button onClick={save} disabled={busy || (!dirty && !!rec)} style={{ ...B(dirty || !rec ? G.gold : G.card2), color: dirty || !rec ? "#fff" : G.dim, padding: "9px 18px", fontWeight: 800 }}>{busy ? "Saving…" : rec && !dirty ? "Saved ✓" : "Save"}</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SV DATES AND REPORT MILESTONES
// ══════════════════════════════════════════════════════════════════
function Cycle({ G, K, active, cycles, month }) {
  return (
    <>
      <div style={{ ...K, fontSize: 12, color: G.mut }}>
        <b style={{ color: G.txt }}>{mLabel(month)}</b> · IndusInd needs two surprise verifications (one each fortnight), ICICI one. Final report is due on the 10th of {mLabel(addMonth(month, 1))}; if that is a holiday for the unit, on the last working day before it.
      </div>
      {active.filter(u => !u.startMonth || month >= u.startMonth).map(u => <CycleCard key={u.id + month} u={u} m={month} rec={cycles.find(c => c.id === `${u.id}_${month}`)} />)}
    </>
  );
}

function CycleCard({ u, m, rec }) {
  const { G, B, I, K, ST, by } = useCtx();
  const slots = svSlots(u.bank, m);
  const init = () => ({ sv: { ...(rec?.sv || {}) }, reportSharedDate: rec?.reportSharedDate || "", responseDate: rec?.responseDate || "", finalDate: rec?.finalDate || "", note: "" });
  const [f, setF] = useState(init);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!dirty) setF(init()); }, [rec?.updatedAt?.seconds]);
  const set = p => { setF(x => ({ ...x, ...p })); setDirty(true); };
  const td = today();
  const cs = cycleStatus({ finalDate: f.finalDate }, m, td, u);
  const save = async () => {
    for (const s of slots) {
      const v = f.sv[s.k];
      if (v && (v < s.from || v > s.to)) return ST(`${u.name}: ${s.label} must fall between ${dLabel(s.from)} and ${dLabel(s.to)}`, "error");
      if (v && v > td) return ST(`${u.name}: SV date is in the future`, "error");
    }
    const { reportSharedDate: rs, responseDate: rr, finalDate: fd } = f;
    if ([rs, rr, fd].some(x => x && x > td)) return ST(`${u.name}: dates can't be in the future`, "error");
    if (rs && rs < `${m}-01`) return ST(`${u.name}: report can't be shared before the audit month starts`, "error");
    if (rr && !rs) return ST(`${u.name}: enter the report shared date first`, "error");
    if (rr && rr < rs) return ST(`${u.name}: response date is before the report was shared`, "error");
    if (fd && !rs) return ST(`${u.name}: enter the report shared date first`, "error");
    if (fd && fd < (rr || rs)) return ST(`${u.name}: final report date is before ${rr ? "the response" : "the report was shared"}`, "error");
    setBusy(true);
    try {
      await saveAuditCycle(`${u.id}_${m}`, { unitId: u.id, bank: u.bank, month: m, sv: f.sv, reportSharedDate: rs, responseDate: rr, finalDate: fd }, by, f.note.trim());
      setDirty(false); setF(x => ({ ...x, note: "" })); ST(`✅ ${u.name} saved`);
    } catch (e) { ST("Save failed: " + e.message, "error"); }
    setBusy(false);
  };
  const d8 = (label, k, min) => (
    <div style={{ flex: "1 1 140px" }}>
      <label style={ui_L}>{label}</label>
      <input type="date" style={I} min={min} max={td} value={f[k]} onChange={e => set({ [k]: e.target.value })} />
    </div>
  );
  return (
    <div style={{ ...K }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontWeight: 800 }}>{u.name}</span><BankChip bank={u.bank} G={G} /></div>
        <span style={{ fontSize: 12, fontWeight: 800, color: toneColor(G, cs.tone) }}>{cs.label}</span>
      </div>
      <div style={{ fontSize: 10, fontWeight: 800, color: G.mut, textTransform: "uppercase", marginBottom: 4 }}>Surprise verification</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
        {slots.map(s => {
          const overdue = !f.sv[s.k] && td > s.to;
          return (
            <div key={s.k} style={{ flex: "1 1 140px" }}>
              <label style={{ ...ui_L, color: overdue ? G.rd : ui_L.color }}>{s.label}{overdue ? " · overdue" : ""}</label>
              <input type="date" style={I} min={s.from} max={s.to < td ? s.to : td} value={f.sv[s.k] || ""} onChange={e => set({ sv: { ...f.sv, [s.k]: e.target.value } })} />
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, fontWeight: 800, color: G.mut, textTransform: "uppercase", margin: "6px 0 4px" }}>Report</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {d8("Shared with branch", "reportSharedDate", `${m}-01`)}
        {d8("Response received", "responseDate", f.reportSharedDate || `${m}-01`)}
        {d8(`Final published (due ${dLabel(cs.due)})`, "finalDate", f.responseDate || f.reportSharedDate || `${m}-01`)}
      </div>
      <div style={{ marginTop: 8 }}>
        <label style={ui_L}>Note for this update (optional)</label>
        <input style={I} value={f.note} maxLength={200} onChange={e => set({ note: e.target.value })} placeholder="e.g. response pending from branch manager" />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, gap: 8, flexWrap: "wrap" }}>
        <div><Stamp rec={rec} G={G} /><History rec={rec} G={G} render={l => [
          ...Object.entries(l.fields?.sv || {}).filter(([, v]) => v).map(([k, v]) => `${k.toUpperCase()} ${dLabel(v)}`),
          l.fields?.reportSharedDate && `shared ${dLabel(l.fields.reportSharedDate)}`,
          l.fields?.responseDate && `response ${dLabel(l.fields.responseDate)}`,
          l.fields?.finalDate && `final ${dLabel(l.fields.finalDate)}`,
        ].filter(Boolean).join(" · ")} /></div>
        <button onClick={save} disabled={busy || !dirty} style={{ ...B(dirty ? G.gold : G.card2), color: dirty ? "#fff" : G.dim, padding: "9px 18px", fontWeight: 800 }}>{busy ? "Saving…" : dirty ? "Save" : rec ? "Saved ✓" : "Save"}</button>
      </div>
    </div>
  );
}

// Collapsible change log for a record
function History({ rec, G, render }) {
  const [open, setOpen] = useState(false);
  const log = (rec?.log || []).slice().sort((a, b) => b.at.localeCompare(a.at));
  if (log.length === 0) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <span onClick={() => setOpen(!open)} style={{ fontSize: 11, color: G.bl, cursor: "pointer", textDecoration: "underline" }}>{open ? "Hide" : "Show"} history ({log.length})</span>
      {open && (
        <div style={{ marginTop: 6, borderLeft: `2px solid ${G.bdr}`, paddingLeft: 10 }}>
          {log.map((l, i) => (
            <div key={i} style={{ fontSize: 11, marginBottom: 5 }}>
              <b>{l.byName}</b> <span style={{ color: G.dim }}>{tsText(l.at)}</span>
              <div style={{ color: G.mut }}>{render(l)}{l.note ? ` — “${l.note}”` : ""}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// INVOICES
// ══════════════════════════════════════════════════════════════════
// Every active unit is expected to have one invoice per audit month from its
// start month up to the current month. Months with no record show as "Not raised".
const invoiceRows = (units, invoices, td) => {
  const cur = td.slice(0, 7);
  const out = [];
  units.forEach(u => {
    const start = u.startMonth || cur;
    const known = invoices.filter(i => i.unitId === u.id).map(i => i.month);
    const ms = new Set([...(u.active === false ? [] : monthsFrom(start, cur)), ...known]);
    [...ms].forEach(m => {
      const rec = invoices.find(i => i.id === `${u.id}_${m}`);
      const stage = rec?.stage || "not_raised";
      const age = rec?.invoiceDate && stage !== "paid" ? daysBetween(rec.invoiceDate, td) : null;
      out.push({ u, month: m, rec, stage, age });
    });
  });
  return out;
};

function Invoices({ G, B, I, K, units, invoices }) {
  const td = today();
  const [flt, setFlt] = useState("open");
  const [bank, setBank] = useState("");
  const [sel, setSel] = useState(null);
  const all = invoiceRows(units, invoices, td);
  const cur = thisMonth();
  const groups = {
    open: r => r.stage !== "paid" && !(r.stage === "not_raised" && r.month === cur),
    not_raised: r => r.stage === "not_raised",
    process: r => !["paid", "not_raised", "returned"].includes(r.stage),
    returned: r => r.stage === "returned",
    paid: r => r.stage === "paid",
    all: () => true,
  };
  const rows = all.filter(groups[flt]).filter(r => !bank || r.u.bank === bank)
    .sort((a, b) => flt === "paid" ? b.month.localeCompare(a.month) : a.month.localeCompare(b.month) || a.u.name.localeCompare(b.u.name));
  const unpaid = all.filter(r => !["paid", "not_raised"].includes(r.stage));
  const outstanding = unpaid.reduce((s, r) => s + (r.rec?.total || 0), 0);
  const over60 = unpaid.filter(r => r.age >= 60).length;
  const fy = fyStart(cur);
  const paidFY = all.filter(r => r.stage === "paid" && r.rec?.paidDate >= `${fy}-01`).reduce((s, r) => s + (r.rec?.amountReceived || 0), 0);
  const nr = all.filter(r => r.stage === "not_raised" && r.month < cur).length;

  const exportInv = () => {
    const head = ["Bank", "Unit", "Audit month", "Invoice no", "Invoice date", "Fee (taxable)", "GST", "Invoice total", "Status", "Bank request no", "Submitted/mailed on", "Paid on", "Amount received", "TDS deducted", "UTR", "Age (days)", "Last updated by", "Last updated at"];
    const body = all.sort((a, b) => a.month.localeCompare(b.month)).map(r => {
      const x = r.rec || {};
      return [BANKS[r.u.bank].short, r.u.name, mLabel(r.month), x.invoiceNo, x.invoiceDate, x.fee, x.gst, x.total, stageInfo(r.u.bank, r.stage).label,
        x.requestNo, x.stageDates?.submitted || x.stageDates?.mailed || "", x.paidDate, x.amountReceived, x.tdsDeducted, x.utr, r.age ?? "", x.updatedByName, tsText(x.updatedAt)];
    });
    csvDownload(`Audit_Invoices_${td}.csv`, [head, ...body]);
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <Tile G={G} K={K} label="Outstanding" value={inr(outstanding)} sub={`${unpaid.length} invoices awaiting payment`} />
        <Tile G={G} K={K} label="Over 60 days" value={over60} color={over60 ? G.rd : G.gr} />
        <Tile G={G} K={K} label="Not raised" value={nr} color={nr ? G.am : G.gr} sub="past months" />
        <Tile G={G} K={K} label={`Received FY ${fy.slice(0, 4)}-${String(Number(fy.slice(0, 4)) + 1).slice(2)}`} value={inr(paidFY)} />
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        {[["open", "Open"], ["not_raised", "Not raised"], ["process", "In process"], ["returned", "Returned"], ["paid", "Paid"], ["all", "All"]].map(([v, lb]) => (
          <button key={v} onClick={() => setFlt(v)} style={{ ...B(flt === v ? G.navy : G.card), fontSize: 12, padding: "6px 11px", border: flt === v ? "none" : `1px solid ${G.bdr}`, color: flt === v ? "#fff" : G.mut }}>
            {lb} <span style={{ opacity: 0.7 }}>{all.filter(groups[v]).filter(r => !bank || r.u.bank === bank).length}</span>
          </button>
        ))}
        <select value={bank} onChange={e => setBank(e.target.value)} style={{ ...I, width: 140, padding: "7px 10px", fontSize: 12 }}>
          <option value="">Both banks</option>
          {Object.entries(BANKS).map(([k, b]) => <option key={k} value={k}>{b.short}</option>)}
        </select>
        <button onClick={exportInv} style={{ ...B(G.bl), fontSize: 12, padding: "7px 12px", marginLeft: "auto" }}>📥 Export</button>
      </div>
      {rows.length === 0 && <div style={{ textAlign: "center", color: G.dim, padding: 30 }}>Nothing here.</div>}
      {rows.map(r => {
        const key = `${r.u.id}_${r.month}`;
        return <InvoiceCard key={key} r={r} open={sel === key} toggle={() => setSel(sel === key ? null : key)} />;
      })}
    </>
  );
}

function InvoiceCard({ r, open, toggle }) {
  const { G, B, K } = useCtx();
  const { u, month, rec, stage, age } = r;
  const si = stageInfo(u.bank, stage);
  const stages = BANKS[u.bank].stages;
  const ageColor = age >= 60 ? G.rd : age >= 30 ? G.am : G.mut;
  const color = stage === "paid" ? G.gr : stage === "returned" ? G.rd : stage === "not_raised" ? (month < thisMonth() ? G.am : G.dim) : G.bl;
  return (
    <div style={{ ...K, padding: 0, border: `1px solid ${open ? G.navy : G.bdr}` }}>
      <div onClick={toggle} style={{ padding: 14, cursor: "pointer" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}><span style={{ fontWeight: 800 }}>{u.name}</span><BankChip bank={u.bank} G={G} /><span style={{ fontSize: 12, color: G.mut, fontWeight: 700 }}>{mLabel(month)}</span></div>
            <div style={{ fontSize: 12, color: G.mut, marginTop: 3 }}>
              {rec?.invoiceNo ? `Inv ${rec.invoiceNo} · ${dLabel(rec.invoiceDate)}` : "No invoice yet"}{rec?.total ? ` · ${inr(rec.total)}` : u.fee ? ` · fee ${inr(u.fee)} + GST` : ""}
              {rec?.requestNo ? ` · Req ${rec.requestNo}` : ""}
            </div>
            {rec?.updatedByName && <div style={{ fontSize: 11, color: G.mut }}>Last update: <b>{rec.updatedByName}</b> · {tsText(rec.updatedAt)}</div>}
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: "#fff", background: color, padding: "3px 9px", borderRadius: 20, whiteSpace: "nowrap" }}>{si.label}</span>
            {age !== null && <div style={{ fontSize: 11, color: ageColor, fontWeight: 700, marginTop: 4 }}>{age} days</div>}
            {stage === "paid" && rec?.paidDate && <div style={{ fontSize: 11, color: G.gr, marginTop: 4 }}>{dLabel(rec.paidDate)}</div>}
          </div>
        </div>
        {stage !== "not_raised" && stage !== "returned" && (
          <div style={{ display: "flex", gap: 3, marginTop: 10 }}>
            {stages.map((s, i) => <div key={s.k} title={s.label} style={{ flex: 1, height: 5, borderRadius: 3, background: i <= si.idx ? (stage === "paid" ? G.gr : G.bl) : G.card2 }} />)}
          </div>
        )}
      </div>
      {open && <InvoiceEditor r={r} />}
    </div>
  );
}

function InvoiceEditor({ r }) {
  const { G, B, I, ST, by, invoices } = useCtx();
  const { u, month, rec, stage } = r;
  const td = today();
  const stages = BANKS[u.bank].stages;
  const init = () => ({
    invoiceNo: rec?.invoiceNo || "", invoiceDate: rec?.invoiceDate || "",
    fee: rec?.fee ?? u.fee ?? "", gstRate: rec?.gstRate ?? u.gstRate ?? 18, tdsRate: rec?.tdsRate ?? u.tdsRate ?? 10,
    stage: stage === "not_raised" ? "raised" : stage, stageDate: td, note: "",
    requestNo: rec?.requestNo || "", paidDate: rec?.paidDate || "", amountReceived: rec?.amountReceived ?? "", tdsDeducted: rec?.tdsDeducted ?? "", utr: rec?.utr || "",
    returnReason: "",
  });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const set = p => setF(x => ({ ...x, ...p }));
  const fee = num(f.fee) || 0, gst = Math.round(fee * (num(f.gstRate) || 0)) / 100, total = Math.round((fee + gst) * 100) / 100;
  const expTds = Math.round(fee * (num(f.tdsRate) || 0)) / 100, expNet = Math.round((total - expTds) * 100) / 100;
  useEffect(() => {
    if (f.stage === "paid" && f.amountReceived === "" && f.tdsDeducted === "") set({ amountReceived: String(expNet), tdsDeducted: String(expTds) });
  }, [f.stage]);
  const short = f.stage === "paid" && num(f.amountReceived) !== null ? Math.round((total - (num(f.amountReceived) || 0) - (num(f.tdsDeducted) || 0)) * 100) / 100 : 0;

  const save = async () => {
    if (!f.invoiceNo.trim()) return ST("Enter the invoice number from MyAudit", "error");
    if (!f.invoiceDate) return ST("Enter the invoice date", "error");
    if (f.invoiceDate > td) return ST("Invoice date is in the future", "error");
    if (!fee || fee <= 0) return ST("Enter the fee (taxable value)", "error");
    // "Raised" happens on the invoice date and "Paid" on the payment date; other stages carry their own date
    const sd = f.stage === "raised" ? f.invoiceDate : f.stage === "paid" ? f.paidDate : f.stageDate;
    if (f.stage !== "paid") {
      if (!sd || sd > td) return ST("Enter the date of this status (not in the future)", "error");
      if (sd < f.invoiceDate) return ST("Status date can't be before the invoice date", "error");
    }
    if (f.stage === "req_no" && !f.requestNo.trim()) return ST("Enter the bank's request number", "error");
    if (f.stage === "returned" && f.returnReason.trim().length < 5) return ST("Enter the reason the bank returned the invoice (required)", "error");
    if (f.stage === "paid") {
      if (!f.paidDate || f.paidDate > td) return ST("Enter the payment date", "error");
      if (f.paidDate < f.invoiceDate) return ST("Payment date can't be before the invoice date", "error");
      if (num(f.amountReceived) === null || num(f.amountReceived) <= 0) return ST("Enter the amount received in the bank", "error");
      const utr = f.utr.replace(/\s+/g, "").toUpperCase();
      if (!utr) return ST("Enter the UTR number of the payment (required)", "error");
      if (!/^[A-Z0-9]{6,22}$/.test(utr)) return ST("UTR should be 6–22 letters or digits, as shown in the bank statement", "error");
    }
    const fields = {
      unitId: u.id, bank: u.bank, unitName: u.name, month,
      invoiceNo: f.invoiceNo.trim(), invoiceDate: f.invoiceDate, fee, gstRate: num(f.gstRate), gst, total, tdsRate: num(f.tdsRate),
      stage: f.stage, stageDates: { [f.stage]: sd },
      requestNo: f.requestNo.trim(),
      ...(f.stage === "paid" ? { paidDate: f.paidDate, amountReceived: num(f.amountReceived), tdsDeducted: num(f.tdsDeducted) || 0, utr: f.utr.replace(/\s+/g, "").toUpperCase() } : {}),
      ...(f.stage === "returned" ? { returnReason: f.returnReason.trim() } : {}),
    };
    const note = [f.stage === "returned" ? `Returned: ${f.returnReason.trim()}` : "", f.note.trim()].filter(Boolean).join(" · ");
    setBusy(true);
    try {
      await saveAuditInvoice(`${u.id}_${month}`, fields, by, note);
      ST("✅ Invoice updated");
      set({ note: "", returnReason: "" });
    } catch (e) { ST("Save failed: " + e.message, "error"); }
    setBusy(false);
  };

  const row = { display: "flex", gap: 8, flexWrap: "wrap" };
  const cell = { flex: "1 1 140px" };
  return (
    <div style={{ borderTop: `1px solid ${G.bdr}`, padding: 14, background: "#fafbfd", borderRadius: "0 0 16px 16px" }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: G.mut, textTransform: "uppercase", marginBottom: 6 }}>Invoice</div>
      <div style={row}>
        <div style={cell}><label style={ui_L}>Invoice no (MyAudit)</label><input style={I} value={f.invoiceNo} onChange={e => set({ invoiceNo: e.target.value })} /></div>
        <div style={cell}><label style={ui_L}>Invoice date</label><input type="date" max={td} style={I} value={f.invoiceDate} onChange={e => set({ invoiceDate: e.target.value })} /></div>
      </div>
      <div style={{ ...row, marginTop: 8 }}>
        <div style={cell}><label style={ui_L}>Fee (taxable) ₹</label><input type="number" min="0" style={I} value={f.fee} onChange={e => set({ fee: e.target.value })} /></div>
        <div style={{ flex: "0 1 80px" }}><label style={ui_L}>GST %</label><input type="number" min="0" style={I} value={f.gstRate} onChange={e => set({ gstRate: e.target.value })} /></div>
        <div style={{ flex: "0 1 80px" }}><label style={ui_L}>TDS %</label><input type="number" min="0" style={I} value={f.tdsRate} onChange={e => set({ tdsRate: e.target.value })} /></div>
        <div style={{ ...cell, fontSize: 12, color: G.mut, alignSelf: "center" }}>Total <b style={{ color: G.txt }}>{inr(total)}</b><br />Expected in bank {inr(expNet)} after TDS {inr(expTds)}</div>
      </div>

      <div style={{ fontSize: 10, fontWeight: 800, color: G.mut, textTransform: "uppercase", margin: "14px 0 6px" }}>Update status</div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
        {[...stages, RETURNED].map(s => (
          <button key={s.k} onClick={() => set({ stage: s.k })} style={{ ...B(f.stage === s.k ? (s.k === "returned" ? G.rd : G.navy) : G.card), fontSize: 11, padding: "6px 10px", border: f.stage === s.k ? "none" : `1px solid ${G.bdr}`, color: f.stage === s.k ? "#fff" : G.mut }}>
            {s.label}
          </button>
        ))}
      </div>
      <div style={row}>
        {f.stage === "raised" || f.stage === "paid"
          ? <div style={{ ...cell, fontSize: 12, color: G.mut, alignSelf: "center" }}>{f.stage === "raised" ? "Dated on the invoice date" : "Dated on the payment date below"}</div>
          : <div style={cell}><label style={ui_L}>Date of this status</label><input type="date" max={td} min={f.invoiceDate || undefined} style={I} value={f.stageDate} onChange={e => set({ stageDate: e.target.value })} /></div>}
        <div style={{ ...cell, fontSize: 12, color: G.mut, alignSelf: "center" }}>Saved as updated by <b style={{ color: G.txt }}>{by.name}</b></div>
      </div>
      {(f.stage === "req_no" || (u.bank === "indusind" && rec?.requestNo)) && (
        <div style={{ marginTop: 8 }}><label style={ui_L}>Bank request no</label><input style={I} value={f.requestNo} onChange={e => set({ requestNo: e.target.value })} /></div>
      )}
      {f.stage === "returned" && (
        <div style={{ marginTop: 8 }}><label style={ui_L}>Reason for return <span style={{ color: G.rd }}>*</span></label><input style={I} value={f.returnReason} onChange={e => set({ returnReason: e.target.value })} placeholder="e.g. wrong GSTIN, PO number missing" /></div>
      )}
      {f.stage === "paid" && (
        <>
          <div style={{ ...row, marginTop: 8 }}>
            <div style={cell}><label style={ui_L}>Paid on</label><input type="date" max={td} style={I} value={f.paidDate} onChange={e => set({ paidDate: e.target.value })} /></div>
            <div style={cell}><label style={ui_L}>Amount received ₹</label><input type="number" min="0" style={I} value={f.amountReceived} onChange={e => set({ amountReceived: e.target.value })} /></div>
            <div style={cell}><label style={ui_L}>TDS deducted ₹</label><input type="number" min="0" style={I} value={f.tdsDeducted} onChange={e => set({ tdsDeducted: e.target.value })} /></div>
            <div style={cell}><label style={ui_L}>UTR number <span style={{ color: G.rd }}>*</span></label><input style={{ ...I, textTransform: "uppercase" }} value={f.utr} onChange={e => set({ utr: e.target.value })} placeholder="e.g. N298261234567890" /></div>
          </div>
          {(() => {
            // Same UTR on another invoice: allowed (a bank may pay several units in one transfer), but shown
            const utr = f.utr.replace(/\s+/g, "").toUpperCase();
            const other = utr && invoices.filter(i => i.utr === utr && i.id !== `${u.id}_${month}`);
            return other && other.length > 0 && <div style={{ fontSize: 12, color: G.am, fontWeight: 700, marginTop: 6 }}>This UTR is also recorded on {other.map(i => `${i.unitName} ${mLabel(i.month)}`).join(", ")}. Fine if the bank paid them together; otherwise check it.</div>;
          })()}
          {Math.abs(short) >= 1 && <div style={{ fontSize: 12, color: short > 0 ? G.rd : G.am, fontWeight: 700, marginTop: 6 }}>{short > 0 ? `Short received by ${inr(short)}` : `Received ${inr(-short)} more than invoice`} after TDS. Note the reason below.</div>}
        </>
      )}
      <div style={{ marginTop: 8 }}><label style={ui_L}>Note (optional)</label><input style={I} value={f.note} maxLength={250} onChange={e => set({ note: e.target.value })} placeholder="e.g. mailed to Ms X at the branch, followed up on phone" /></div>
      <button onClick={save} disabled={busy} style={{ ...B(G.gold), width: "100%", marginTop: 12, color: "#fff", fontWeight: 800 }}>{busy ? "Saving…" : "Save update"}</button>
      {rec?.returnReason && stage === "returned" && <div style={{ fontSize: 12, color: G.rd, marginTop: 8 }}>Last returned: {rec.returnReason}</div>}
      <Stamp rec={rec} G={G} />
      <History rec={rec} G={G} render={l => {
        const fl = l.fields || {};
        const st = stageInfo(u.bank, fl.stage).label;
        const d = fl.stageDates ? Object.values(fl.stageDates)[0] : "";
        return [st && `${st}${d ? ` on ${dLabel(d)}` : ""}`, fl.requestNo && fl.stage === "req_no" && `req ${fl.requestNo}`, fl.stage === "paid" && `${inr(fl.amountReceived)} recd`].filter(Boolean).join(" · ");
      }} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SETUP (admin / HR)
// ══════════════════════════════════════════════════════════════════
function Setup({ G, B, I, K, ST, by, D, units, setup }) {
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState({ bank: "indusind", name: "" });
  const cals = D.holidayCalendars || [];
  const calLike = word => cals.find(c => c.name.toLowerCase().includes(word))?.id || "";
  // Gurgaon/Gurugram units follow the Haryana calendar; the rest are in Rajasthan
  const guessCal = name => /gurgaon|gurugram/i.test(name) ? calLike("haryana") : calLike("rajasthan");
  const loadDefaults = async () => {
    setBusy(true);
    try {
      await saveAuditUnits(DEFAULT_UNITS.map(([bank, name], i) => ({ id: gid(), bank, name, fee: null, gstRate: 18, tdsRate: 10, startMonth: thisMonth(), dailyFrom: today(), calendarId: guessCal(name), active: true, order: i })), [], by);
      ST("✅ 7 units added. Now enter each unit's fee.");
    } catch (e) { ST("Failed: " + e.message, "error"); }
    setBusy(false);
  };
  const addUnit = async () => {
    if (!add.name.trim()) return ST("Enter the branch / unit name", "error");
    await saveAuditUnits([{ id: gid(), bank: add.bank, name: add.name.trim(), fee: null, gstRate: 18, tdsRate: 10, startMonth: thisMonth(), dailyFrom: today(), calendarId: guessCal(add.name), active: true, order: units.length }], [], by)
      .then(() => { ST("✅ Unit added"); setAdd({ ...add, name: "" }); }).catch(e => ST("Failed: " + e.message, "error"));
  };
  const members = setup?.members || [];
  const toggleMember = id => saveAuditMembers(members.includes(id) ? members.filter(x => x !== id) : [...members, id], by).catch(e => ST("Failed: " + e.message, "error"));
  const staff = (D.users || []).filter(u => !["admin", "hr"].includes(u.role)).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <div style={K}>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>Bank units</div>
        <div style={{ fontSize: 12, color: G.mut, marginBottom: 10 }}>Fee is the monthly taxable fee for that unit; it pre-fills each invoice and can be changed on the invoice. "Invoices from" is the first audit month that should have an invoice. "Daily entries from" is the first day the team must update; days before it are never shown as missing. "Holiday calendar" is the HRMS calendar for the unit's state; its holidays are never shown as missing and move the final report due date earlier.</div>
        {units.length === 0 && <button onClick={loadDefaults} disabled={busy} style={{ ...B(G.gold), width: "100%", marginBottom: 10, color: "#fff", fontWeight: 800 }}>{busy ? "Adding…" : "Add the 7 units (IndusInd ×4, ICICI ×3)"}</button>}
        {units.map(u => <UnitRow key={u.id} u={u} />)}
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <select style={{ ...I, width: 130 }} value={add.bank} onChange={e => setAdd({ ...add, bank: e.target.value })}>{Object.entries(BANKS).map(([k, b]) => <option key={k} value={k}>{b.short}</option>)}</select>
          <input style={{ ...I, flex: 1, minWidth: 160 }} value={add.name} onChange={e => setAdd({ ...add, name: e.target.value })} placeholder="New branch / unit name" />
          <button onClick={addUnit} style={{ ...B(G.navy) }}>+ Add</button>
        </div>
      </div>
      <div style={K}>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>Who can open Bank Audits</div>
        <div style={{ fontSize: 12, color: G.mut, marginBottom: 10 }}>Admin and HR always can. Tick the auditors and team leads; anyone ticked can update any unit, and every update shows their name.</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 6 }}>
          {staff.map(u => (
            <label key={u.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, padding: "7px 10px", border: `1px solid ${members.includes(u.id) ? G.navy : G.bdr}`, borderRadius: 10, cursor: "pointer", background: members.includes(u.id) ? "#eef1fa" : "#fff" }}>
              <input type="checkbox" checked={members.includes(u.id)} onChange={() => toggleMember(u.id)} />
              <span>{u.name}<span style={{ color: G.dim, fontSize: 11 }}> · {u.designation || u.role}</span></span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

function UnitRow({ u }) {
  const { G, B, I, ST, by, D } = useCtx();
  const cals = D.holidayCalendars || [];
  const [f, setF] = useState({ name: u.name, fee: u.fee ?? "", startMonth: u.startMonth || thisMonth(), dailyFrom: u.dailyFrom || "", calendarId: u.calendarId || "", active: u.active !== false });
  const dirty = f.name !== u.name || String(f.fee) !== String(u.fee ?? "") || f.startMonth !== (u.startMonth || thisMonth()) || f.dailyFrom !== (u.dailyFrom || "") || f.calendarId !== (u.calendarId || "") || f.active !== (u.active !== false);
  const save = () => {
    if (!f.name.trim()) return ST("Name can't be blank", "error");
    saveAuditUnits([{ id: u.id, name: f.name.trim(), fee: num(f.fee), startMonth: f.startMonth, dailyFrom: f.dailyFrom, calendarId: f.calendarId, active: f.active }], [], by)
      .then(() => ST(`✅ ${f.name} saved`)).catch(e => ST("Failed: " + e.message, "error"));
  };
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap", padding: "8px 0", borderTop: `1px solid ${G.bdr}`, opacity: f.active ? 1 : 0.55 }}>
      <div style={{ flex: "2 1 160px" }}><label style={ui_L}><BankChip bank={u.bank} G={G} /></label><input style={I} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></div>
      <div style={{ flex: "1 1 100px" }}><label style={ui_L}>Fee / month ₹</label><input type="number" min="0" style={{ ...I, borderColor: f.fee === "" ? G.am : G.bdr }} value={f.fee} onChange={e => setF({ ...f, fee: e.target.value })} placeholder="not set" /></div>
      <div style={{ flex: "1 1 130px" }}><label style={ui_L}>Invoices from</label><input type="month" style={I} value={f.startMonth} onChange={e => e.target.value && setF({ ...f, startMonth: e.target.value })} /></div>
      <div style={{ flex: "1 1 140px" }}><label style={ui_L}>Daily entries from</label><input type="date" style={I} value={f.dailyFrom} onChange={e => setF({ ...f, dailyFrom: e.target.value })} /></div>
      <div style={{ flex: "1 1 170px" }}><label style={{ ...ui_L, color: f.calendarId ? ui_L.color : G.am }}>Holiday calendar{f.calendarId ? "" : " · not set"}</label>
        <select style={{ ...I, borderColor: f.calendarId ? G.bdr : G.am }} value={f.calendarId} onChange={e => setF({ ...f, calendarId: e.target.value })}>
          <option value="">None (Sun + 2nd/4th Sat only)</option>
          {cals.map(c => <option key={c.id} value={c.id}>{c.name} · {(D.holidays || []).filter(h => (h.calendarId || DEFAULT_CAL) === c.id).length} holidays</option>)}
        </select>
      </div>
      <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center", paddingBottom: 12 }}><input type="checkbox" checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} />Active</label>
      <button onClick={save} disabled={!dirty} style={{ ...B(dirty ? G.gold : G.card2), color: dirty ? "#fff" : G.dim, padding: "10px 14px", marginBottom: 1 }}>Save</button>
    </div>
  );
}
