import { useState, useEffect, useRef, useCallback } from "react";
import {
  getConfig, setConfig, onConfig,
  addAttendance, updateAttendance, onAttendance,
  addLeave, updateLeave, deleteLeave, onLeaves,
  addReg, updateReg, onRegs,
  updateLiveLocation, onLiveLocations,
  addNotification, updateNotification, onNotifications,
  saveBackup, getBackups, restoreBackup,
  addWorkApproval, updateWorkApproval, onWorkApprovals,
  addCompOff, updateCompOff, onCompOffs
} from "./firebase";

// Strip undefined values before saving to Firestore
const clean = (obj) => JSON.parse(JSON.stringify(obj, (k, v) => v === undefined ? null : v));

const CONFIG_FIELDS = [
  "users", "offices", "teams", "branches", "leavePolicy", "holidays", "holidayCalendars", "leRules",
  "companyName", "firmId", "firmPlan", "firmTrial"
];
const CONFIG_RECORD_FIELDS = new Set(["users", "offices", "teams", "branches", "holidays", "holidayCalendars", "leRules"]);

const configFrom = data => clean({
  users: data.users || [],
  offices: data.offices || [],
  teams: data.teams || [],
  branches: data.branches || [],
  leavePolicy: data.leavePolicy || null,
  holidays: data.holidays || [],
  holidayCalendars: data.holidayCalendars || [],
  leRules: data.leRules || [],
  companyName: data.companyName || "Nucleus HRMS",
  firmId: data.firmId || null,
  firmPlan: data.firmPlan || null,
  firmTrial: data.firmTrial || null,
});

const isEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const getRecordChanges = (previous = [], next = []) => {
  const previousById = new Map(previous.filter(item => item?.id).map(item => [item.id, item]));
  const nextById = new Map(next.filter(item => item?.id).map(item => [item.id, item]));

  return {
    upserts: next.filter(item => item?.id && !isEqual(previousById.get(item.id), item)),
    removeIds: previous.filter(item => item?.id && !nextById.has(item.id)).map(item => item.id),
  };
};

const getConfigChanges = (previous, next) => {
  const changes = {};
  const arrayChanges = {};

  CONFIG_FIELDS.forEach(field => {
    if (isEqual(previous[field], next[field])) return;
    if (CONFIG_RECORD_FIELDS.has(field)) {
      arrayChanges[field] = getRecordChanges(previous[field], next[field]);
    } else {
      changes[field] = next[field];
    }
  });

  return { changes, arrayChanges };
};


// ── MSG91 WhatsApp Notifications ─────────────────────────────────
// Sign up at msg91.com, get your AUTH_KEY and create templates
const MSG91_AUTH = "YOUR_MSG91_AUTH_KEY"; // Replace with your MSG91 auth key
const WA_SENDER = "YOUR_WHATSAPP_NUMBER"; // Your WhatsApp business number

const sendWA = async (mobile, template, vars = []) => {
  if (!mobile || !MSG91_AUTH || MSG91_AUTH === "YOUR_MSG91_AUTH_KEY") return;
  try {
    await fetch("https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authkey": MSG91_AUTH },
      body: JSON.stringify({
        integrated_number: WA_SENDER,
        content_type: "template",
        payload: {
          messaging_product: "whatsapp",
          type: "template",
          template: {
            name: template,
            language: { code: "en" },
            components: vars.length ? [{ type: "body", parameters: vars.map(v => ({ type: "text", text: v })) }] : []
          },
          to: `91${mobile.replace(/[^0-9]/g, "").slice(-10)}`
        }
      })
    });
  } catch (e) { console.warn("WA notification failed:", e.message); }
};

// WA Templates (create these in MSG91 dashboard):
// nucleus_checkin: "{{1}} has checked in at {{2}} at {{3}}"
// nucleus_checkout: "{{1}} has checked out at {{2}}. Hours: {{3}}"
// nucleus_leave_req: "{{1}} has applied for {{2}} leave from {{3}}"
// nucleus_leave_approved: "Your {{1}} leave has been approved"
// nucleus_leave_rejected: "Your {{1}} leave has been rejected"
// nucleus_late: "{{1}} is {{2}} minutes late today"
// nucleus_escalation: "PENDING: {{1}}'s leave request is pending for {{2}} days"

const notifyCheckin = (user, officeName, time) =>
  sendWA(user.mobile, "nucleus_checkin", [user.name, officeName, time]);
const notifyCheckout = (user, time, hours) =>
  sendWA(user.mobile, "nucleus_checkout", [user.name, time, hours]);
const notifyLeaveReq = (manager, staffName, leaveType, fromDate) =>
  sendWA(manager?.mobile, "nucleus_leave_req", [staffName, leaveType, fromDate]);
const notifyLeaveApproved = (user, leaveType) =>
  sendWA(user.mobile, "nucleus_leave_approved", [leaveType]);
const notifyLeaveRejected = (user, leaveType) =>
  sendWA(user.mobile, "nucleus_leave_rejected", [leaveType]);
const notifyLate = (admin, staffName, mins) =>
  sendWA(admin?.mobile, "nucleus_late", [staffName, String(mins)]);
const notifyEscalation = (manager, staffName, days) =>
  sendWA(manager?.mobile, "nucleus_escalation", [staffName, String(days)]);

const gid=()=>Math.random().toString(36).substr(2,9);
const tod=()=>{
  const d=new Date();
  const off=d.getTimezoneOffset();
  const local=new Date(d.getTime()-off*60000);
  return local.toISOString().split("T")[0];
};
const fT=(d)=>new Date(d).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const fD=(d)=>new Date(d).toLocaleDateString([],{day:"2-digit",month:"short",year:"numeric"});
const dist=(a,b,c,d)=>{const R=6371000,dL=((c-a)*Math.PI)/180,dl=((d-b)*Math.PI)/180,x=Math.sin(dL/2)**2+Math.cos((a*Math.PI)/180)*Math.cos((c*Math.PI)/180)*Math.sin(dl/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));};
const lateBy=(ci,ss)=>{const [h,m]=ss.split(":").map(Number),s=new Date(ci);s.setHours(h,m,0,0);return Math.max(0,Math.round((new Date(ci)-s)/60000));};
const wMin=(a,b)=>b?Math.round((new Date(b)-new Date(a))/60000):0;
const wHr=(a,b)=>{const m=wMin(a,b);return m?`${Math.floor(m/60)}h${m%60}m`:null;};
const wDM=(y,m)=>{let c=0;const d=new Date(y,m-1,1);while(d.getMonth()===m-1){if(d.getDay()&&d.getDay()<6)c++;d.setDate(d.getDate()+1);}return c;};
const isHL=(ds,hs)=>(hs||[]).some(h=>h.date===ds);
const isWE=(ds,weeklyOff="sun_sat")=>{
  const d=new Date(ds),day=d.getDay();
  if(weeklyOff==="sun_sat")return day===0||day===6;
  if(day===0)return true;
  if(day!==6)return false;
  const wk=getSatWeek(d);
  if(weeklyOff==="sun")return false;
  if(weeklyOff==="sun_1stsat")return wk===1;
  if(weeklyOff==="sun_2ndsat")return wk===2;
  if(weeklyOff==="sun_3rdsat")return wk===3;
  if(weeklyOff==="sun_4thsat")return wk===4;
  if(weeklyOff==="sun_5thsat")return wk===5;
  if(weeklyOff==="sun_altsat")return wk%2===1;
  if(weeklyOff==="sun_1st3rdsat")return wk===1||wk===3;
  if(weeklyOff==="sun_2nd4thsat")return wk===2||wk===4;
  return false;
};
const isDayOff=(ds,hs,weeklyOff)=>isWE(ds,weeklyOff)||isHL(ds,hs);

// ── Holiday calendars ──────────────────────────────────────────────
// A firm keeps several calendars (head office, each client location).
// Holidays and staff both carry a calendarId; anything without one
// falls back to the default calendar so older records keep working.
const DEFAULT_CAL="cal_default";
const calsOf=D=>{
  const list=D.holidayCalendars||[];
  return list.length?list:[{id:DEFAULT_CAL,name:D.companyName||"Nucleus"}];
};
const calIdOf=user=>user?.calendarId||DEFAULT_CAL;
// Holidays that apply to one person
const holsFor=(D,user)=>{
  const cid=calIdOf(user);
  return (D.holidays||[]).filter(h=>(h.calendarId||DEFAULT_CAL)===cid);
};
// Every date string in a month
const daysOfMonth=(y,m)=>{
  const out=[],last=new Date(y,m,0).getDate();
  for(let d=1;d<=last;d++) out.push(`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`);
  return out;
};

// ── Leave balances (counted in DAYS, not applications) ──────────────
// Leave year runs April–March. Weekly offs and holidays inside a leave are not charged.
// Half day is a duration (0.5), available on every leave type.
const LEAVE_TYPES=[["casual","Casual"],["sick","Sick"],["studyleave","Study"],["compoff","Comp Off"]];
const LEAVE_LABEL={casual:"Casual",sick:"Sick",studyleave:"Study",compoff:"Comp Off",halfday:"Half Day (old)",early:"Early (old)"};
const LEAVE_YEAR_START=4;
const leaveYear=ds=>{
  const [y,m]=ds.split("-").map(Number), sy=m>=LEAVE_YEAR_START?y:y-1, mm=String(LEAVE_YEAR_START).padStart(2,"0");
  return [`${sy}-${mm}-01`,`${sy+1}-${mm}-01`];
};
const leaveDays=(l,D,user,lo,hi)=>{
  if(l.type==="early")return 0;
  const hols=holsFor(D,user), wo=user?.weeklyOff||"sun_sat";
  const half=l.duration==="half"||l.type==="halfday";
  const end=half?l.from:(l.to||l.from);
  let n=0,d=l.from;
  while(d<=end){ if((!lo||d>=lo)&&(!hi||d<hi)&&!isDayOff(d,hols,wo))n+=half?0.5:1; d=addDays(d,1); }
  return n;
};
// Whole months served since a date (the month is earned once it is completed)
const monthsServed=(start,today)=>{
  if(!start)return 0;
  const [sy,sm,sd]=start.split("-").map(Number),[ty,tm,td]=today.split("-").map(Number);
  return Math.max(0,(ty-sy)*12+(tm-sm)-(td<sd?1:0));
};
const leaveBalances=(D,user)=>{
  const isAA=user?.employeeType==="articled";
  const pol=(D.leavePolicy||DP)[isAA?"articled":"employee"]||(isAA?DP_AA:DP_EMP);
  const [ys,ye]=leaveYear(tod());
  const out=[];
  LEAVE_TYPES.forEach(([t,label])=>{
    if(t==="compoff"){ out.push({type:t,label,total:null,left:compOffLedger(D,user).available}); return; }
    if(isAA){
      // Articled: earned per completed month of articleship, never resets
      if(!["sick","studyleave"].includes(t))return;
      const rate=Number(pol[t+"PerMonth"]??(isAA?DP_AA:DP_EMP)[t+"PerMonth"])||0; if(rate<=0)return;
      const start=user.articleshipStart||null;
      const months=monthsServed(start,tod());
      const total=Math.round(months*rate*10)/10;
      const used=(D.leaves||[])
        .filter(l=>l.userId===user.id&&(l.status==="approved"||l.status==="pending")&&l.type===t&&(!start||(l.to||l.from)>=start))
        .reduce((s,l)=>s+leaveDays(l,D,user,start||undefined),0);
      out.push({type:t,label,total,used,left:Math.max(0,Math.round((total-used)*10)/10),
        accrual:{rate,months,start}});
      return;
    }
    const total=Number(pol[t])||0; if(total<=0)return;
    const used=(D.leaves||[])
      .filter(l=>l.userId===user.id&&(l.status==="approved"||l.status==="pending")&&(l.type===t||(t==="casual"&&l.type==="halfday")))
      .reduce((s,l)=>s+leaveDays(l,D,user,ys,ye),0);
    out.push({type:t,label,total,used,left:Math.max(0,total-used)});
  });
  return out;
};
// Payable working days: excludes this person's weekly offs and their calendar's holidays
const workingDaysFor=(y,m,hols,weeklyOff)=>
  daysOfMonth(y,m).filter(ds=>!isDayOff(ds,hols,weeklyOff)).length;

// ── Late coming / early leaving ────────────────────────────────────
// Rules live in D.leRules as {id, scope, targetId, limit, lateMins, earlyMins}.
// scope: "default" | "office" | "team" | "staff". Most specific wins, field by
// field: staff > team > office > firm default. A blank field falls through.
const LE_DEFAULT={limit:4,lateMins:10,earlyMins:10};
const leRuleFor=(D,user)=>{
  const rs=D.leRules||[];
  const find=(scope,tid)=>rs.find(r=>r.scope===scope&&r.targetId===tid);
  const staff=user?find("staff",user.id):null;
  const team=user?.teamId?find("team",user.teamId):null;
  const office=(user?.officeIds||[]).map(o=>find("office",o)).find(Boolean)||null;
  const firm=rs.find(r=>r.scope==="default")||null;
  const chain=[staff,team,office,firm];
  const pick=k=>{
    for(const r of chain){ if(r&&r[k]!==undefined&&r[k]!==null&&r[k]!=="") return Number(r[k]); }
    return LE_DEFAULT[k];
  };
  const src=k=>{ const i=chain.findIndex(r=>r&&r[k]!==undefined&&r[k]!==null&&r[k]!==""); return ["staff","team","office","firm"][i]||"default"; };
  return {limit:pick("limit"),lateMins:pick("lateMins"),earlyMins:pick("earlyMins"),limitFrom:src("limit")};
};
const shiftFor=(D,user)=>{
  if(user?.customShift?.shiftStart)return user.customShift;
  const t=(D.teams||[]).find(x=>x.id===user?.teamId);
  return t?{shiftStart:t.shiftStart,shiftEnd:t.shiftEnd}:null;
};
const minsBeforeEnd=(co,se)=>{const [h,m]=se.split(":").map(Number),e=new Date(co);e.setHours(h,m,0,0);return Math.max(0,Math.round((e-new Date(co))/60000));};

// Every late / early incident for one person in a month, oldest first.
// Worked out from the attendance records each time, so a rule change applies
// to the whole month straight away. The first `limit` incidents are allowed;
// every one after that needs manager regularization.
const leIncidents=(D,user,month)=>{
  const rule=leRuleFor(D,user), sh=shiftFor(D,user);
  if(!sh)return {rule,list:[],used:0,needReg:0,regd:0,open:0,exception:false};
  const recs=(D.attendance||[])
    .filter(a=>a.userId===user.id&&a.date?.startsWith(month)&&!a.isWFH&&!a.isOD&&a.checkIn)
    .sort((a,b)=>a.checkIn.localeCompare(b.checkIn));
  const pend=(D.regularizations||[]).filter(r=>r.userId===user.id&&r.type==="le_reg"&&r.status==="pending");
  const list=[];
  recs.forEach(a=>{
    const lm=lateBy(a.checkIn,sh.shiftStart);
    if(lm>rule.lateMins) list.push({recId:a.id,date:a.date,kind:"late",mins:lm,at:a.checkIn,
      regd:!!(a.lateReg||a.lateApproved)});
    if(a.checkOut){
      const em=minsBeforeEnd(a.checkOut,sh.shiftEnd);
      if(em>rule.earlyMins) list.push({recId:a.id,date:a.date,kind:"early",mins:em,at:a.checkOut,
        regd:!!a.earlyReg});
    }
  });
  list.sort((a,b)=>a.at.localeCompare(b.at));
  list.forEach((x,i)=>{
    x.n=i+1;
    x.allowed=i<rule.limit;
    x.pending=pend.some(r=>r.recId===x.recId&&r.kind===x.kind);
  });
  const over=list.filter(x=>!x.allowed);
  const regd=over.filter(x=>x.regd).length;
  return {rule,list,used:Math.min(list.length,rule.limit),needReg:over.length,regd,
    open:over.filter(x=>!x.regd).length,exception:regd>rule.limit};
};

// ── Comp off ───────────────────────────────────────────────────────
// A credit is earned only for an APPROVED request to work on a weekly off or
// holiday, and only from real check-in/check-out time that day:
//   worked >= 75% of shift -> 1 day,  >= 40% -> 0.5 day,  less -> nothing.
// Opening balances entered by HR/HOD are credits too. Every credit expires
// 90 days after it was earned (or entered). Comp off leave uses the credit
// closest to expiry first. Pending leave already reserves balance.
const CO_FULL=0.75, CO_HALF=0.40, CO_DAYS=90;
const addDays=(ds,n)=>{const d=new Date(ds+"T12:00:00");d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;};
const shiftMinsOf=sh=>{if(!sh)return 540;const [a,b]=sh.shiftStart.split(":").map(Number),[x,y]=sh.shiftEnd.split(":").map(Number);return Math.max(60,(x*60+y)-(a*60+b));};
const coNeed=(l,hols,wo)=>{
  if(l.duration==="half")return 0.5;
  let n=0,d=l.from;const end=l.to||l.from;
  while(d<=end){ if(!isDayOff(d,hols,wo))n++; d=addDays(d,1); }
  return n;
};
const compOffLedger=(D,user)=>{
  const today=tod(), sh=shiftFor(D,user), full=shiftMinsOf(sh);
  const hols=holsFor(D,user), wo=user?.weeklyOff||"sun_sat";
  const credits=[];
  (D.workApprovals||[]).filter(w=>w.userId===user.id&&w.status==="approved"&&!w.creditCancelled&&w.date<=today).forEach(w=>{
    const recs=(D.attendance||[]).filter(a=>a.userId===user.id&&a.date===w.date&&a.checkIn);
    const mins=recs.filter(a=>a.checkOut).reduce((s,a)=>s+wMin(a.checkIn,a.checkOut),0);
    const open=recs.some(a=>!a.checkOut);
    const r=mins/full, value=r>=CO_FULL?1:r>=CO_HALF?0.5:0;
    credits.push({id:w.id,kind:"work",date:w.date,value,mins,open,expires:addDays(w.date,CO_DAYS)});
  });
  (D.compoffs||[]).filter(x=>x.userId===user.id&&x.type==="opening"&&!x.cancelled).forEach(x=>{
    credits.push({id:x.id,kind:"opening",date:x.date,value:Number(x.value)||0,mins:0,open:false,expires:addDays(x.date,CO_DAYS),note:x.note});
  });
  credits.sort((a,b)=>a.expires.localeCompare(b.expires)||a.date.localeCompare(b.date));
  credits.forEach(x=>x.left=x.value);
  const uses=(D.leaves||[]).filter(l=>l.userId===user.id&&l.type==="compoff"&&(l.status==="approved"||l.status==="pending"))
    .sort((a,b)=>a.from.localeCompare(b.from));
  const usage=uses.map(l=>{
    let need=coNeed(l,hols,wo); const want=need;
    for(const x of credits){
      if(need<=0)break;
      if(x.left<=0||x.date>l.from||x.expires<=l.from)continue;
      const t=Math.min(x.left,need); x.left-=t; need-=t;
    }
    return {leave:l,days:want,uncovered:need};
  });
  const live=credits.filter(x=>x.left>0&&x.expires>today);
  const soon=addDays(today,15);
  return {
    credits,usage,
    available:live.reduce((s,x)=>s+x.left,0),
    expiringSoon:live.filter(x=>x.expires<=soon).reduce((s,x)=>s+x.left,0),
    expired:credits.filter(x=>x.left>0&&x.expires<=today).reduce((s,x)=>s+x.left,0),
    earned:credits.reduce((s,x)=>s+x.value,0),
    used:usage.reduce((s,u)=>s+(u.days-u.uncovered),0),
    availableOn:(date)=>credits.filter(x=>x.left>0&&x.date<=date&&x.expires>date).reduce((s,x)=>s+x.left,0),
  };
};
// Upcoming weekly offs and holidays for one person
const upcomingOffs=(D,user,days=60)=>{
  const hols=holsFor(D,user), wo=user?.weeklyOff||"sun_sat", out=[];
  for(let i=0;i<days;i++){
    const ds=addDays(tod(),i);
    if(isDayOff(ds,hols,wo)){const h=hols.find(x=>x.date===ds);out.push({date:ds,name:h?h.name:"Weekly off"});}
  }
  return out;
};
const ld=(k,f)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):f;}catch{return f;}};
const sv=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch{}};

const DP_EMP={casual:12,sick:12};
const DP_AA={sickPerMonth:1,studyleavePerMonth:1};
const DP={employee:DP_EMP,articled:DP_AA};
const GRACE_MINS=15;
// SaaS features (trial countdown, plan limits, upgrade prompts).
// OFF for in-house use at Nucleus. Turn ON only when selling to other firms.
const SAAS_MODE=false;
const PLANS={
  trial:{name:"Free Trial",maxUsers:10,days:30,price:0},
  starter:{name:"Starter",maxUsers:10,price:999},
  growth:{name:"Growth",maxUsers:25,price:1999},
  professional:{name:"Professional",maxUsers:50,price:3499},
  enterprise:{name:"Enterprise",maxUsers:999,price:5999},
};
const ROLE_LABELS={admin:"Admin",hr:"HR Manager",hod:"HOD",branch_head:"Branch Head",manager:"Manager",staff:"Staff"};
const WEEKLY_OFF_OPTIONS=[
  {value:"sun",label:"Sunday Only"},
  {value:"sun_sat",label:"Saturday & Sunday"},
  {value:"sun_1stsat",label:"Sunday + 1st Saturday"},
  {value:"sun_2ndsat",label:"Sunday + 2nd Saturday"},
  {value:"sun_3rdsat",label:"Sunday + 3rd Saturday"},
  {value:"sun_4thsat",label:"Sunday + 4th Saturday"},
  {value:"sun_altsat",label:"Sunday + Alternate Saturdays"},
  {value:"sun_1st3rdsat",label:"Sunday + 1st & 3rd Saturday"},
  {value:"sun_2nd4thsat",label:"Sunday + 2nd & 4th Saturday"},
];
const getSatWeek=d=>Math.ceil(d.getDate()/7);
const countMonthlyGrace=(att,uid,mon)=>(att||[]).filter(a=>a.userId===uid&&a.date&&a.date.startsWith(mon)&&a.graceUsed===true).length;
const SEED={
  companyName:"Nucleus HRMS",
  offices:[{id:"o1",name:"Gurugram HQ",lat:28.4595,lng:77.0266,radius:200,branchId:"b1"},{id:"o2",name:"Noida Branch",lat:28.5355,lng:77.391,radius:200,branchId:"b2"}],
  branches:[{id:"b1",name:"Gurugram HQ",headId:null},{id:"b2",name:"Noida Branch",headId:null}],
  teams:[{id:"t1",name:"Investment Banking",shiftStart:"09:30",shiftEnd:"18:30"},{id:"t2",name:"Risk Advisory",shiftStart:"09:00",shiftEnd:"18:00"},{id:"t3",name:"Tax & Regulatory",shiftStart:"09:30",shiftEnd:"18:30"}],
  users:[
    {id:"u1",name:"Ashish Gupta",email:"ag@nucleusadvisors.in",password:"Nucleus123#",role:"admin",employeeType:"employee",weeklyOff:"sun_sat",teamId:null,officeIds:["o1","o2"],customShift:null,managedTeams:["t1","t2","t3"]},
    {id:"u2",name:"Raj Sharma",email:"raj@nucleusadvisors.in",password:"pass123",role:"manager",employeeType:"employee",teamId:"t1",officeIds:["o1"],customShift:null,managedTeams:["t1","t2"]},
    {id:"u3",name:"Priya Patel",email:"priya@nucleusadvisors.in",password:"pass123",role:"staff",employeeType:"employee",teamId:"t1",officeIds:["o1"],customShift:null},
    {id:"u4",name:"Amit Singh",email:"amit@nucleusadvisors.in",password:"pass123",role:"staff",employeeType:"articled",teamId:"t2",officeIds:["o1","o2"],customShift:{shiftStart:"10:00",shiftEnd:"19:00"}},
  ],
  attendance:[],leaves:[],liveLocations:{},leavePolicy:{employee:DP_EMP,articled:DP_AA},
  holidayCalendars:[{id:"cal_default",name:"Nucleus"}],
  holidays:[{id:"h1",date:"2026-01-26",name:"Republic Day",calendarId:"cal_default"},{id:"h2",date:"2026-08-15",name:"Independence Day",calendarId:"cal_default"},{id:"h3",date:"2026-10-02",name:"Gandhi Jayanti",calendarId:"cal_default"},{id:"h4",date:"2026-11-08",name:"Diwali",calendarId:"cal_default"},{id:"h5",date:"2026-12-25",name:"Christmas",calendarId:"cal_default"}],
  notifications:[],regularizations:[],
};

const G={bg:"#f5f7fb",card:"#ffffff",card2:"#eef1f7",bdr:"#dfe4ee",gold:"#E31E24",goldL:"#ff5a5f",goldD:"#b01419",navy:"#1B2A5E",navyL:"#2f4585",txt:"#1B2A5E",mut:"#5a6b91",dim:"#5d6b8f",gr:"#0b7a44",rd:"#c5221f",am:"#a35200",bl:"#1662c4",pu:"#7b3ff2"};
// Readable text for any background: dark ink on light fills, white on dark/gradients.
const isLightBg=bg=>{
  if(typeof bg!=="string"||!/^#[0-9a-fA-F]{6}$/.test(bg))return false;
  const r=parseInt(bg.slice(1,3),16),g=parseInt(bg.slice(3,5),16),b=parseInt(bg.slice(5,7),16);
  return (0.299*r+0.587*g+0.114*b)>170;
};
const inkOn=bg=>isLightBg(bg)?G.txt:"#fff";
const B=(bg,x={})=>({background:bg,color:inkOn(bg),border:"none",borderRadius:10,padding:"12px 18px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",...x});
const I={width:"100%",padding:"11px 14px",borderRadius:10,border:`1px solid ${G.bdr}`,background:"#fff",color:G.txt,fontSize:14,fontFamily:"inherit",boxSizing:"border-box"};
const L={fontSize:11,color:G.mut,marginBottom:4,display:"block",fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase"};
const K={background:G.card,border:`1px solid ${G.bdr}`,borderRadius:16,padding:18,marginBottom:12,boxShadow:"0 1px 3px rgba(27,42,94,0.06)"};

const Chip=({bg,label,sm})=>(
  <span style={{alignSelf:"flex-start",flexShrink:0,whiteSpace:"nowrap",background:bg,color:inkOn(bg),border:isLightBg(bg)?`1px solid ${G.bdr}`:"none",fontSize:sm?10:11,fontWeight:700,padding:sm?"2px 7px":"3px 10px",borderRadius:20}}>{label}</span>
);
const FRow=({label,children})=>(
  <div style={{marginBottom:12}}><label style={L}>{label}</label>{children}</div>
);

const Logo=({s=32})=>(
  <img src="/logo.png" alt="Nucleus" style={{height:s,width:"auto",display:"block"}}/>
);
const Msg=({t})=>(
  <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:t.type==="error"?G.rd:G.gr,color:"#fff",padding:"12px 24px",borderRadius:12,fontWeight:700,fontSize:14,zIndex:9999,boxShadow:"0 8px 32px rgba(0,0,0,0.6)",whiteSpace:"nowrap",border:`1px solid ${G.gold}`}}>
    {t.msg}
  </div>
);

function Cam({onDone,onCancel}) {
  const vr=useRef(),cr=useRef(),sr=useRef();
  const [ok,setOk]=useState(false),[err,setErr]=useState(null);
  useEffect(()=>{
    navigator.mediaDevices?.getUserMedia({video:{facingMode:"user"}})
      .then(s=>{sr.current=s;if(vr.current){vr.current.srcObject=s;setOk(true);}})
      .catch(()=>setErr("Camera denied. Please allow access."));
    return()=>sr.current?.getTracks().forEach(t=>t.stop());
  },[]);
  const snap=()=>{
    const v=vr.current,c=cr.current;if(!v||!c)return;
    c.width=v.videoWidth;c.height=v.videoHeight;c.getContext("2d").drawImage(v,0,0);
    sr.current?.getTracks().forEach(t=>t.stop());
    onDone(c.toDataURL("image/jpeg",0.7));
  };
  if(err) return (
    <div style={{textAlign:"center",padding:20}}>
      <div style={{fontSize:36}}>📷</div>
      <p style={{color:G.rd,fontSize:13,marginBottom:12}}>{err}</p>
      <div style={{display:"flex",gap:8,flexDirection:"column"}}>
        <button onClick={()=>{setErr(null);navigator.mediaDevices?.getUserMedia({video:{facingMode:"user"}}).then(s=>{sr.current=s;if(vr.current){vr.current.srcObject=s;setOk(true);}}).catch(()=>setErr("Camera still unavailable."));}} style={{...B(G.gold),color:"#fff",fontWeight:700}}>🔄 Retry Camera</button>
        <button onClick={()=>onDone(null)} style={{...B(G.bl)}}>Continue Without Selfie</button>
        <button onClick={onCancel} style={B(G.dim)}>Back</button>
      </div>
    </div>
  );
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12}}>
      <div style={{borderRadius:14,overflow:"hidden",width:"100%",maxWidth:300,background:"#000",border:`2px solid ${G.gold}`,position:"relative"}}>
        <video ref={vr} autoPlay playsInline muted style={{width:"100%",display:"block"}}/>
        {!ok&&<div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",color:G.gold}}>Loading…</div>}
      </div>
      <canvas ref={cr} style={{display:"none"}}/>
      <div style={{display:"flex",gap:10,width:"100%"}}>
        <button onClick={onCancel} style={{...B(G.dim),flex:1}}>Cancel</button>
        <button onClick={snap} disabled={!ok} style={{...B(ok?G.gold:"#555"),flex:2,color:"#fff"}}>📸 Take Selfie</button>
      </div>
    </div>
  );
}

export default function App() {
  const [D,setD]=useState({...SEED,attendance:[],leaves:[],regularizations:[],workApprovals:[],compoffs:[],liveLocations:{},notifications:[],loaded:false});
  const [cu,setCu]=useState(()=>ld("nau5",null));
  const [sc,setSc]=useState("login");
  const [toast,setToast]=useState(null);

  // Firebase realtime listeners
  useEffect(()=>{
    const unsub=onConfig(cfg=>{
      if(cfg&&cfg.users&&cfg.users.length>0){
        // ONLY READ - never write back to Firebase automatically
        setD(prev=>({...prev,...cfg,loaded:true}));
        // Twice-daily backup - use sessionStorage to prevent per-device triggers
        const now=new Date();
        const istNow=new Date(now.getTime()+330*60000);
        const hour=istNow.getUTCHours();
        const inWindow=(hour>=0&&hour<6)||(hour>=12&&hour<18);
        const slot=hour<12?'midnight':'noon';
        const bKey='bk_'+istNow.toISOString().slice(0,10)+'_'+slot;
        if(inWindow&&!sessionStorage.getItem(bKey)){
          sessionStorage.setItem(bKey,'1');
          saveBackup(cfg).catch(()=>{});
        }
      } else {
        // No data - just mark as loaded, NEVER write to Firebase
        setD(prev=>({...prev,loaded:true}));
      }
    });
    return unsub;
  },[]);
  useEffect(()=>{const u=onAttendance(r=>setD(p=>({...p,attendance:r})));return u;},[]);
  useEffect(()=>{const u=onLeaves(r=>setD(p=>({...p,leaves:r})));return u;},[]);
  useEffect(()=>{const u=onRegs(r=>setD(p=>({...p,regularizations:r})));return u;},[]);
  useEffect(()=>{const u=onWorkApprovals(r=>setD(p=>({...p,workApprovals:r})));return u;},[]);
  useEffect(()=>{const u=onCompOffs(r=>setD(p=>({...p,compoffs:r})));return u;},[]);
  useEffect(()=>{const u=onLiveLocations(r=>setD(p=>({...p,liveLocations:r})));return u;},[]);
  useEffect(()=>{
    if(!cu)return;
    const u=onNotifications(cu.id,r=>setD(p=>({...p,notifications:r})));
    return u;
  },[cu?.id]);
  useEffect(()=>{
    if(!cu||["admin","hr"].includes(cu.role))return;
    const w=navigator.geolocation?.watchPosition(p=>{
      updateLiveLocation(cu.id,{lat:p.coords.latitude,lng:p.coords.longitude,ac:Math.round(p.coords.accuracy),ts:new Date().toISOString()});
    },(e)=>{
      // GPS error - retry with low accuracy
      navigator.geolocation?.getCurrentPosition(p=>{
        updateLiveLocation(cu.id,{lat:p.coords.latitude,lng:p.coords.longitude,ac:Math.round(p.coords.accuracy),ts:new Date().toISOString()});
      },null,{enableHighAccuracy:false,maximumAge:60000});
    },{enableHighAccuracy:true,maximumAge:30000,timeout:30000});
    return()=>navigator.geolocation?.clearWatch(w);
  },[cu?.id]);

  const ST=(msg,type="success")=>{setToast({msg,type});setTimeout(()=>setToast(null),3000);};
  const P=useCallback(nd=>{
    setD(nd);

    // CRITICAL SAFETY GUARDS - never write to Firebase if:
    // 1. Firebase hasn't loaded real data yet (would write empty/SEED data)
    if(!D.loaded){
      console.warn("P() blocked: Firebase not loaded yet");
      return;
    }
    // 2. Users array is empty (would wipe all staff)
    if(!nd.users||nd.users.length===0){
      console.warn("P() blocked: empty users array");
      return;
    }

    const previousConfig=configFrom(D);
    const configData=configFrom(nd);
    const {changes,arrayChanges}=getConfigChanges(previousConfig,configData);

    // Only write if something actually changed
    if(Object.keys(changes).length===0&&Object.keys(arrayChanges).length===0)return;

    saveBackup(configData).catch(()=>{});
    setConfig({changes,arrayChanges,initialConfig:configData}).catch(error=>{
      console.error("Config save failed:",error);
    });
  },[D]);
  const AN=useCallback((uid,msg,type="info")=>{
    addNotification({id:gid(),userId:uid,msg,type,ts:new Date().toISOString(),read:false});
  },[]);
  useEffect(()=>{if(cu)setSc(["admin","hr"].includes(cu.role)?"dash":"home");else setSc("login");},[cu]);
  const login=(e,p)=>{
    if(!D.loaded)return ST("App is still loading. Please wait a moment and try again.","error");
    // Check Firebase users first
    // Trim spaces and normalize email to lowercase
    const cleanEmail=e.trim().toLowerCase();
    const cleanPwd=p.trim();
    let u=(D.users||[]).find(u=>u.email?.trim().toLowerCase()===cleanEmail&&u.password?.trim()===cleanPwd);

    // Master admin override - always works regardless of Firebase data
    if(!u&&cleanEmail==="ag@nucleusadvisors.in"&&cleanPwd==="Nucleus123#"){
      u={id:"u1",name:"Ashish Gupta",email:"ag@nucleusadvisors.in",password:"Nucleus123#",role:"admin",employeeType:"employee",weeklyOff:"sun_sat",teamId:null,officeIds:[],managedTeams:[]};
    }
    if(!u){
      // Check if this might be a staff member whose data was lost
      const isKnownDomain=e.includes("@nucleusadvisors.in");
      if(isKnownDomain){
        return ST("Staff data needs to be re-entered by admin. Contact Ashish Gupta.","error");
      }
      return ST("Invalid credentials. Please check your email and password.","error");
    }
    setCu(u);sv("nau5",u);
  };
  const logout=()=>{setCu(null);sv("nau5",null);setSc("login");};
  const unread=(D.notifications||[]).filter(n=>n.userId===cu?.id&&!n.read).length;
  const props={user:cu,D,P,ST,AN,logout,setSc,unread};
  // Show loading overlay after login until Firebase data arrives
  if(cu && !D.loaded) return (
    <div style={{minHeight:"100vh",background:G.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,fontFamily:"'Nunito',sans-serif"}}>
      <div style={{width:48,height:48,border:`4px solid ${G.gold}`,borderTopColor:"transparent",borderRadius:"50%",animation:"spin 1s linear infinite"}}/>
      <div style={{color:G.gold,fontWeight:700,fontSize:15}}>Loading your data…</div>
      <div style={{color:G.dim,fontSize:12}}>Connecting to server</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  return (
    <div style={{fontFamily:"'Nunito',sans-serif",background:G.bg,minHeight:"100vh",color:G.txt}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');:root{color-scheme:only light}*{box-sizing:border-box}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:${G.dim};border-radius:3px}input::placeholder,textarea::placeholder{color:${G.dim}}select option{background:${G.card}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
      {sc==="login"&&<Login login={login} name={D.companyName} setSc={setSc} D={D}/>}
      {sc==="home"&&<Home {...props}/>}
      {sc==="hist"&&<Hist {...props}/>}
      {sc==="lv"&&<Lv {...props}/>}
      {sc==="notif"&&<Notif {...props}/>}
      {sc==="reg"&&<Reg {...props}/>}
      {sc==="profile"&&<Profile {...props} logout={logout}/>}
      {sc==="workreq"&&<WorkReq {...props}/>}
      {sc==="lateapproval"&&<LateApproval {...props}/>}
      {sc==="changepwd"&&<ChangePwd {...props}/>}
      {sc==="teamdash"&&<Dash {...props}/>}
      {sc==="dash"&&<Dash {...props}/>}
      {sc==="register"&&<Register {...props}/>}
      {sc==="superadmin"&&<SuperAdmin {...props}/>}
      {toast&&<Msg t={toast}/>}
    </div>
  );
}

function Login({login,name,setSc,D}) {
  const [e,setE]=useState(""),[p,setP]=useState("");
  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,background:`linear-gradient(160deg,#ffffff,${G.bg})`}}>
      <div style={{width:"100%",maxWidth:400}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:10}}><Logo s={56}/><div style={{textAlign:"left"}}><div style={{fontSize:11,color:G.mut,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.1em"}}>HR Management System</div></div></div>
          <div style={{width:80,height:2,background:`linear-gradient(90deg,transparent,${G.gold},transparent)`,margin:"0 auto"}}/>
        </div>
        <div style={{...K,padding:24,marginBottom:12}}>
          <FRow label="Email"><input style={I} type="email" value={e} onChange={x=>setE(x.target.value)} placeholder="you@nucleusadvisors.in"/></FRow>
          <FRow label="Password"><input style={I} type="password" value={p} onChange={x=>setP(x.target.value)} placeholder="••••••••" onKeyDown={x=>x.key==="Enter"&&login(e,p)}/></FRow>
          {!D?.loaded&&<div style={{textAlign:"center",marginBottom:8,fontSize:12,color:G.am}}>⏳ Connecting to server… please wait</div>}
          <button onClick={()=>login(e,p)} style={{...B(!D?.loaded?"#555":`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",fontSize:15,padding:14,color:D?.loaded?"#fff":"#eee",fontWeight:800}}>{D?.loaded?"Sign In →":"⏳ Loading…"}</button>
        </div>

        <div style={{textAlign:"center",marginTop:8}}>
          <div style={{fontSize:11,color:G.dim}}>Developed by <span style={{color:G.mut,fontWeight:700}}>Ashish Gupta</span></div>
          <div style={{fontSize:10,color:G.dim,marginTop:3}}>© {new Date().getFullYear()} Nucleus Advisors</div>
        </div>
        <div style={{textAlign:"center",marginTop:24,padding:"12px 0"}}>
          <div style={{fontSize:11,color:G.dim}}>Developed by</div>
          <div style={{fontSize:13,fontWeight:700,color:G.mut,marginTop:2}}>Ashish Gupta</div>
          <div style={{width:40,height:1,background:`linear-gradient(90deg,transparent,${G.dim},transparent)`,margin:"8px auto 0"}}/>
          <div style={{fontSize:10,color:G.dim,marginTop:6}}>© {new Date().getFullYear()} Nucleus Advisors. All rights reserved.</div>
        </div>
      </div>
    </div>
  );
}

function LiveTimer({checkIn, checkOut}) {
  const [now,setNow]=useState(new Date());
  useEffect(()=>{
    if(checkOut)return;
    const t=setInterval(()=>setNow(new Date()),60000);
    return()=>clearInterval(t);
  },[checkOut]);
  const start=new Date(checkIn);
  const end=checkOut?new Date(checkOut):now;
  const mins=Math.max(0,Math.round((end-start)/60000));
  const hrs=Math.floor(mins/60);
  const m=mins%60;
  const display=hrs>0?`${hrs}h ${m}m`:`${m}m`;
  return (
    <div style={{marginTop:4,fontSize:12,color:checkOut?G.gold:G.gr,fontWeight:700}}>
      ⏱ {checkOut?"Total: ":"Working: "}{display}
    </div>
  );
}


function Home({user,D,P,ST,AN,logout,setSc,unread}) {
  const [step,setStep]=useState("idle"),[selfie,setSelfie]=useState(null),[gps,setGps]=useState(null),[office,setOffice]=useState(null),[locErr,setLocErr]=useState(null),[wfh,setWfh]=useState(false);
  const rec=D.attendance.find(a=>a.userId===user.id&&a.date===tod());
  const tm=D.teams.find(t=>t.id===user.teamId);
  const sh=user.customShift||(tm?{shiftStart:tm.shiftStart,shiftEnd:tm.shiftEnd}:null);
  const pl=(D.leaves||[]).filter(l=>l.userId===user.id&&l.status==="pending").length;
  const myHols=holsFor(D,user);
  const hol=isHL(tod(),myHols)?myHols.find(h=>h.date===tod())?.name:null;
  const now=new Date();
  const onSelfie=img=>{
    setSelfie(img);
    if(wfh){setStep("confirm");return;}
    setStep("loc");
    if(!navigator.geolocation){
      setLocErr("GPS not supported on this device/browser.");
      setStep("err");
      return;
    }

    const startGpsFlow=()=>{
      runGpsTiers();
    };

    if(navigator.permissions&&navigator.permissions.query){
      navigator.permissions.query({name:"geolocation"}).then(result=>{
        if(result.state==="denied"){
          setLocErr("Location is blocked for this app. Please go to your phone Settings, then Apps, then Chrome (or your Browser), then Permissions, then Location, then Allow. Then try again.");
          setStep("err");
          return;
        }
        startGpsFlow();
      }).catch(()=>startGpsFlow());
    } else {
      startGpsFlow();
    }

    const evaluate=(la,lo,ac)=>{
      setGps({lat:la,lng:lo,ac:Math.round(ac)});
      const assignedOffices=(user.officeIds||[]).map(id=>D.offices.find(o=>o.id===id)).filter(Boolean);
      if(assignedOffices.length===0){setOffice({name:"Remote"});setStep("confirm");return;}
      const near=assignedOffices.find(o=>dist(la,lo,o.lat,o.lng)<=(o.radius||200)+ac);
      if(near){
        setOffice(near);setStep("confirm");
      } else {
        const closest=assignedOffices.reduce((b,o)=>{const d=dist(la,lo,o.lat,o.lng);return(!b||d<b.d)?{...o,d}:b;},null);
        setLocErr(`You are ${Math.round(closest?.d||0)}m from ${closest?.name||"office"} (allowed: ${closest?.radius||200}m). GPS accuracy: ±${Math.round(ac)}m. Try moving near a window/outside, or use WFH.`);
        setStep("err");
      }
    };

    const onFinalErr=(e)=>{
      const msgs={1:"Location permission denied. Please allow location access for this site in your phone or browser settings.",2:"Location/GPS appears to be turned OFF on your phone. Please turn on Location in your phone quick settings (swipe down from top) and try again.",3:"Location request timed out. Indoor GPS can be slow. Please try again or move near a window."};
      setLocErr(msgs[e.code]||"Could not get location. Please try again.");
      setStep("err");
    };

    const runGpsTiers=()=>{
      navigator.geolocation.getCurrentPosition(
        pos=>evaluate(pos.coords.latitude,pos.coords.longitude,pos.coords.accuracy),
        (e1)=>{
          if(e1.code===1){onFinalErr(e1);return;}
          navigator.geolocation.getCurrentPosition(
            pos=>evaluate(pos.coords.latitude,pos.coords.longitude,pos.coords.accuracy),
            (e2)=>{
              if(e2.code===1){onFinalErr(e2);return;}
              navigator.geolocation.getCurrentPosition(
                pos=>evaluate(pos.coords.latitude,pos.coords.longitude,pos.coords.accuracy),
                onFinalErr,
                {enableHighAccuracy:false,timeout:15000,maximumAge:60000}
              );
            },
            {enableHighAccuracy:true,timeout:25000,maximumAge:0}
          );
        },
        {enableHighAccuracy:true,timeout:5000,maximumAge:60000}
      );
    };

    startGpsFlow();
  };
  const doIn=async()=>{
    const lb=(!wfh&&sh)?lateBy(new Date().toISOString(),sh.shiftStart):0;
    const lr=leRuleFor(D,user);
    const isLate=lb>lr.lateMins;
    const rec2={id:gid(),userId:user.id,userName:user.name,teamId:user.teamId,
      date:tod(),checkIn:new Date().toISOString(),checkOut:null,
      selfie,gps:wfh?null:gps,officeName:wfh?"WFH":office?.name,officeId:wfh?null:(office?.id||null),
      status:wfh?"wfh":isLate?"late":"present",lateBy:lb,isWFH:wfh};
    try{
      // Update live location with check-in GPS so admin sees current location
      if(gps){
        updateLiveLocation(user.id,{lat:gps.lat,lng:gps.lng,ac:gps.ac||0,ts:new Date().toISOString()});
      }
      await addAttendance(rec2);
      let msg="✅ Checked in!";
      if(wfh)msg="🏠 WFH check-in done!";
      else if(isLate)msg=`⚠️ ${lb}m late — check-in saved`;
      ST(msg);setStep("done");
    }catch(e){
      // Retry once on failure
      try{
        await addAttendance({...rec2,id:gid()});
        ST("✅ Checked in!");setStep("done");
      }catch(e2){
        ST("❌ Check-in failed! Please try again. Error: "+e2.message,"error");
        setStep("idle");
      }
    }
  };
  const doOut=async()=>{
    const checkOutTime=new Date().toISOString();
    const go=async(cg)=>{
      try{
        // Update live location on checkout too
        if(cg){
          updateLiveLocation(user.id,{lat:cg.lat,lng:cg.lng,ac:0,ts:checkOutTime});
        }
        const ebm=(!rec.isWFH&&sh)?minsBeforeEnd(checkOutTime,sh.shiftEnd):0;
        await updateAttendance(rec.id,{checkOut:checkOutTime,checkOutGps:cg,earlyBy:ebm});
        notifyCheckout(user, fT(checkOutTime), wHr(rec.checkIn,checkOutTime)||"");
        ST("👋 Checked out successfully!");
      }catch(e){
        ST("❌ Check-out failed! Please try again.","error");
      }
    };
    navigator.geolocation?.getCurrentPosition(
      p=>go({lat:p.coords.latitude,lng:p.coords.longitude}),
      ()=>go(null)
    );
  };
  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}><Logo s={28}/><div><div style={{fontSize:16,fontWeight:800}}>{user.name}</div></div></div>
        {SAAS_MODE&&D.firmTrial&&(()=>{const daysLeft=Math.max(0,Math.ceil((new Date(D.firmTrial)-new Date())/(1000*60*60*24)));return daysLeft<=7&&(<div style={{background:daysLeft===0?G.rd:G.am,color:"#fff",fontSize:11,fontWeight:700,padding:"4px 10px",borderRadius:8,marginBottom:8,width:"100%",textAlign:"center"}}>⏰ {daysLeft===0?"Trial expired! ":"Trial: "}{daysLeft} days left</div>);})()}
        <div style={{display:"flex",gap:6}}>
          <button onClick={()=>setSc("notif")} style={{...B(G.card),padding:"8px 11px",border:`1px solid ${G.bdr}`,fontSize:13,position:"relative"}}>{unread>0&&<span style={{position:"absolute",top:-4,right:-4,background:G.rd,color:"#fff",borderRadius:"50%",width:15,height:15,fontSize:9,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900}}>{unread}</span>}🔔</button>
          <button onClick={logout} style={{...B(G.card),fontSize:12,padding:"8px 12px",border:`1px solid ${G.bdr}`}}>Out</button>
        </div>
      </div>
      {(hol||isWE(tod(),user.weeklyOff||"sun_sat"))&&(()=>{
        const wa=(D.workApprovals||[]).find(w=>w.userId===user.id&&w.date===tod()&&w.status!=="cancelled");
        const ok=wa?.status==="approved";
        return(
        <div style={{background:`linear-gradient(135deg,${G.navy},${G.navyL})`,border:`1px solid ${ok?G.gr:G.gold}`,borderRadius:14,padding:"12px 16px",marginBottom:14,display:"flex",gap:10,alignItems:"center"}}>
          <div style={{fontSize:26}}>{ok?"🛠":hol?"🎉":"🌟"}</div>
          <div>
            <div style={{color:"#fff",fontWeight:800,fontSize:14}}>{hol||"Weekly off"}</div>
            <div style={{color:"#c9d3ea",fontSize:12}}>
              {ok?"Approved to work today — check in and check out (WFH allowed) to earn comp off."
                 :wa?.status==="pending"?"Your request to work today is awaiting approval."
                 :"No attendance needed. To earn comp off, get approval first via Work on Holiday."}
            </div>
          </div>
        </div>);})()}
      <div style={{background:`linear-gradient(135deg,${G.navy},${G.navyL})`,border:`1px solid ${G.gold}`,borderRadius:20,padding:22,marginBottom:14,textAlign:"center"}}>
        <div style={{fontSize:40,fontWeight:900,color:"#fff"}}>{now.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</div>
        <div style={{color:"#c9d3ea",fontSize:13,marginTop:2}}>{now.toLocaleDateString([],{weekday:"long",day:"numeric",month:"long"})}</div>
        {sh&&<div style={{marginTop:8,background:"rgba(255,255,255,.14)",border:"1px solid rgba(255,255,255,.3)",borderRadius:8,padding:"4px 12px",display:"inline-block",fontSize:12,color:"#fff"}}>🕘 {sh.shiftStart}–{sh.shiftEnd}</div>}
      </div>
      <div style={K}>
        {(!rec||(rec&&rec.checkOut))?(
          <>
            {step==="idle"&&(
              <>
                <div style={{display:"flex",gap:8,marginBottom:10}}>
                  <button onClick={()=>setWfh(false)} style={{...B(wfh?G.card2:G.gold),flex:1,fontSize:13,color:"#fff",border:wfh?`1px solid ${G.bdr}`:"none"}}>🏢 Office</button>
                  <button onClick={()=>setWfh(true)} style={{...B(!wfh?G.card2:G.bl),flex:1,fontSize:13,border:!wfh?`1px solid ${G.bdr}`:"none"}}>🏠 WFH</button>
                </div>
                <button onClick={()=>setStep("cam")} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",fontSize:15,padding:13,color:"#fff",fontWeight:800}}>📸 Check In{wfh?" (WFH)":""}</button>
              </>
            )}
            {step==="cam"&&<Cam onDone={onSelfie} onCancel={()=>setStep("idle")}/>}
            {step==="loc"&&<div style={{textAlign:"center",padding:18}}><div style={{fontSize:34,marginBottom:8}}>📍</div><p style={{color:G.gold,fontWeight:700,marginBottom:4}}>Getting your location…</p><p style={{color:G.mut,fontSize:12,marginBottom:12}}>Please wait up to 20 seconds.</p><div style={{width:32,height:32,border:`4px solid ${G.gold}`,borderTopColor:"transparent",borderRadius:"50%",animation:"spin 1s linear infinite",margin:"0 auto"}}/><p style={{color:G.dim,fontSize:11,marginTop:10}}>Enable location in phone settings if stuck</p></div>}
            {step==="confirm"&&(
              <div style={{textAlign:"center"}}>
                {selfie&&<img src={selfie} style={{width:90,height:90,borderRadius:"50%",objectFit:"cover",border:`4px solid ${G.gold}`,marginBottom:10}}/>}
                <div style={{color:G.gold,fontWeight:700,marginBottom:2}}>{wfh?"🏠 Work From Home":`📍 ${office?.name}`}</div>
                <div style={{color:G.mut,fontSize:12,marginBottom:12}}>{wfh?"WFH":"Location verified ✓"}</div>
                <button onClick={doIn} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#fff",fontWeight:800}}>Confirm Check-In ✓</button>
              </div>
            )}
            {step==="err"&&<div style={{textAlign:"center",padding:8}}>
              <div style={{fontSize:32,marginBottom:8}}>🚫</div>
              <p style={{color:G.rd,fontSize:13,marginBottom:12}}>{locErr}</p>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <button onClick={()=>setStep("idle")} style={{...B(G.gold),color:"#fff",fontWeight:700}}>🔄 Try Again</button>
                <button onClick={()=>{setWfh(true);setStep("idle");}} style={B(G.bl)}>🏠 Switch to WFH</button>
              </div>
            </div>}
          </>
        ):(
          <div>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
              {rec.selfie?<img src={rec.selfie} style={{width:60,height:60,borderRadius:"50%",objectFit:"cover",border:`3px solid ${G.gold}`,flexShrink:0}}/>:<div style={{width:60,height:60,borderRadius:"50%",background:G.card2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,flexShrink:0}}>👤</div>}
              <div style={{flex:1}}>
                <div style={{color:G.gr,fontWeight:800,fontSize:15}}>✅ {rec.isWFH?"WFH":"Checked In"}</div>
                <div style={{color:G.mut,fontSize:13}}>at {fT(rec.checkIn)} · {rec.officeName}</div>
                {rec.lateBy>0&&<div style={{color:G.am,fontSize:12}}>⚠️ {rec.lateBy} mins late</div>}
                {/* Live working hours timer */}
                <LiveTimer checkIn={rec.checkIn} checkOut={rec.checkOut}/>
              </div>
            </div>
            {rec.checkOut?(
              <>
                <div style={{background:G.card2,borderRadius:10,padding:10,textAlign:"center",border:`1px solid ${G.bdr}`,marginBottom:8}}>
                  <div style={{color:G.mut,fontSize:12}}>Checked Out at {fT(rec.checkOut)}</div>
                  <div style={{color:G.gold,fontWeight:800,fontSize:18,marginTop:2}}>{wHr(rec.checkIn,rec.checkOut)} worked 👋</div>
                </div>
                {/* Allow re-checkin after checkout */}
                <button onClick={()=>{setStep("idle");}} style={{...B(G.bl),width:"100%",fontWeight:700,fontSize:13}}>🔄 Check In Again</button>
              </>
            ):(
              <button onClick={doOut} style={{...B(G.am),width:"100%",fontWeight:700}}>🚪 Check Out</button>
            )}
          </div>
        )}
      </div>
      <LECard D={D} user={user} ST={ST} AN={AN}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        {[["History","hist"],["Leaves"+(pl>0?` (${pl})`:""  ),"lv"],["Regularize","reg"],["Notifications"+(unread>0?` (${unread})`:""  ),"notif"],["My Profile","profile"],["Work on Holiday","workreq"],...(user.role==="manager"?[["My Team","teamdash"]]:[]  )].map(([lb,s])=>(
          <button key={s} onClick={()=>setSc(s)} style={{...B(G.card),border:`1px solid ${G.bdr}`,fontSize:12,padding:10,fontWeight:600}}>{lb}</button>
        ))}
      </div>
    </div>
  );
}

// ── Staff view: this month's late / early count and regularization ─
function LECard({D,user,ST,AN}) {
  const [open,setOpen]=useState(null);   // "recId|kind" being regularized
  const [why,setWhy]=useState("");
  const [show,setShow]=useState(false);
  const mon=tod().slice(0,7);
  const s=leIncidents(D,user,mon);
  if(!s.list.length)return null;
  const mgr=(D.users||[]).find(u=>u.id===user.reportingTo);
  const request=async(x)=>{
    if(!why.trim())return ST("Please give a reason","error");
    await addReg({id:gid(),userId:user.id,userName:user.name,teamId:user.teamId,
      type:"le_reg",kind:x.kind,recId:x.recId,date:x.date,mins:x.mins,reason:why.trim(),
      appliedOn:new Date().toISOString(),status:"pending"});
    if(mgr)AN(mgr.id,`${user.name} requested regularization: ${x.kind==="late"?"late by":"left early by"} ${x.mins} min on ${fD(x.date)}. Reason: ${why.trim()}`,"info");
    ST("Sent to your manager");setOpen(null);setWhy("");
  };
  const over=s.list.filter(x=>!x.allowed);
  const tone=s.open>0?G.am:G.gr;
  return (
    <div style={{...K,border:`1px solid ${s.open>0?G.am:G.bdr}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}} onClick={()=>setShow(!show)}>
        <div>
          <div style={{fontWeight:700,fontSize:13}}>Late / early this month</div>
          <div style={{fontSize:12,color:G.mut,marginTop:2}}>
            {s.used} of {s.rule.limit} allowed used
            {s.needReg>0&&<span style={{color:tone}}> · {s.open} need regularization</span>}
          </div>
        </div>
        <div style={{fontSize:20,fontWeight:900,color:tone}}>{s.list.length}</div>
      </div>
      {show&&(
        <div style={{marginTop:10}}>
          <div style={{fontSize:11,color:G.dim,marginBottom:6}}>
            Late = check-in more than {s.rule.lateMins} min after shift start. Early = check-out more than {s.rule.earlyMins} min before shift end.
          </div>
          {s.list.map(x=>{
            const k=x.recId+"|"+x.kind;
            const state=x.allowed?"Within limit":x.regd?"Regularized":x.pending?"Pending":"Needs regularization";
            const col=x.allowed?G.dim:x.regd?G.gr:x.pending?G.bl:G.am;
            return (
              <div key={k} style={{borderTop:`1px solid ${G.bdr}`,padding:"8px 0"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:12,fontWeight:700}}>#{x.n} · {fD(x.date)}</div>
                    <div style={{fontSize:11,color:G.mut}}>{x.kind==="late"?`Late by ${x.mins} min`:`Left ${x.mins} min early`}</div>
                  </div>
                  {!x.allowed&&!x.regd&&!x.pending
                    ?<button onClick={()=>{setOpen(open===k?null:k);setWhy("");}} style={{...B(G.am),fontSize:11,padding:"5px 10px"}}>Regularize</button>
                    :<span style={{fontSize:11,fontWeight:700,color:col}}>{state}</span>}
                </div>
                {open===k&&(
                  <div style={{marginTop:8}}>
                    <textarea style={{...I,minHeight:60,resize:"vertical"}} value={why} onChange={e=>setWhy(e.target.value)} placeholder="Reason"/>
                    <div style={{display:"flex",gap:8,marginTop:6}}>
                      <button onClick={()=>request(x)} style={{...B(G.gold),flex:2,fontSize:12}}>Send to manager</button>
                      <button onClick={()=>setOpen(null)} style={{...B(G.dim),flex:1,fontSize:12}}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {over.length===0&&<div style={{fontSize:11,color:G.gr,marginTop:4}}>All within your monthly allowance.</div>}
        </div>
      )}
    </div>
  );
}

function WorkReq({user,D,ST,AN,setSc}) {
  const [picked,setPicked]=useState([]);        // dates selected for a request
  const [why,setWhy]=useState("");
  const [busy,setBusy]=useState(false);
  const mine=(D.workApprovals||[]).filter(w=>w.userId===user.id);
  const reqFor=ds=>mine.find(w=>w.date===ds&&w.status!=="cancelled"&&w.status!=="rejected");
  const offs=upcomingOffs(D,user,30);
  const free=offs.filter(o=>!reqFor(o.date));             // days that can still be requested
  const mgr=(D.users||[]).find(u=>u.id===user.reportingTo);
  const L=compOffLedger(D,user);
  const toggle=ds=>setPicked(p=>p.includes(ds)?p.filter(x=>x!==ds):[...p,ds]);
  const allOn=free.length>0&&free.every(o=>picked.includes(o.date));
  const submit=async()=>{
    if(!picked.length)return ST("Select at least one day","error");
    if(!why.trim())return ST("Please give a reason","error");
    if(!mgr)return ST("No reporting manager set — ask admin to set one","error");
    setBusy(true);
    const days=offs.filter(o=>picked.includes(o.date)&&!reqFor(o.date));
    const now=new Date().toISOString();
    for(const o of days){
      await addWorkApproval({id:gid(),userId:user.id,userName:user.name,teamId:user.teamId,managerId:mgr.id,
        date:o.date,dayName:o.name,reason:why.trim(),appliedOn:now,status:"pending"});
    }
    AN(mgr.id,`${user.name} wants to work on ${days.length} day${days.length>1?"s":""} off: ${days.map(o=>fD(o.date)).join(", ")}. Reason: ${why.trim()}`,"info");
    ST(`${days.length} request${days.length>1?"s":""} sent to ${mgr.name}`);
    setPicked([]);setWhy("");setBusy(false);
  };
  const withdraw=async w=>{if(!confirm(`Withdraw request for ${fD(w.date)}?`))return;await updateWorkApproval(w.id,{status:"cancelled",cancelledBy:user.id,cancelledOn:new Date().toISOString()});ST("Withdrawn");};
  const stCol={pending:G.am,approved:G.gr,rejected:G.rd,cancelled:G.dim};
  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:"20px 20px 110px"}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:14}}>
        <button onClick={()=>setSc("home")} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800}}>Work on holiday / weekly off</h2>
      </div>
      <div style={{...K,background:G.card2}}>
        <div style={{fontSize:12,color:G.mut}}>
          Select the days you need to work and send them for approval together. On an approved day, check in and check out (WFH is fine). ≥75% of your shift earns 1 comp off, ≥40% earns half. Comp off expires 90 days after it is earned.
        </div>
        <div style={{display:"flex",gap:8,marginTop:10}}>
          <div style={{flex:1,textAlign:"center"}}><div style={{fontSize:20,fontWeight:900,color:G.gr}}>{L.available}</div><div style={{fontSize:10,color:G.dim,fontWeight:700}}>AVAILABLE</div></div>
          <div style={{flex:1,textAlign:"center"}}><div style={{fontSize:20,fontWeight:900,color:G.am}}>{L.expiringSoon}</div><div style={{fontSize:10,color:G.dim,fontWeight:700}}>EXPIRING ≤15 DAYS</div></div>
        </div>
      </div>

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin:"4px 0 8px"}}>
        <div style={{color:G.mut,fontSize:11,fontWeight:700,textTransform:"uppercase"}}>Weekly offs & holidays · next 30 days</div>
        {free.length>0&&(
          <button onClick={()=>setPicked(allOn?[]:free.map(o=>o.date))}
            style={{...B(G.card),border:`1px solid ${G.bdr}`,fontSize:11,padding:"5px 10px"}}>{allOn?"Clear all":"Select all"}</button>
        )}
      </div>
      {offs.length===0&&<div style={{textAlign:"center",color:G.dim,padding:20}}>No days off in the next 30 days.</div>}
      {offs.map(o=>{
        const req=reqFor(o.date), on=picked.includes(o.date), isHol=o.name!=="Weekly off";
        return (
          <div key={o.date} onClick={()=>!req&&toggle(o.date)}
            style={{...K,padding:12,marginBottom:8,cursor:req?"default":"pointer",border:`1px solid ${on?G.gold:G.bdr}`,background:on?"#fdf1f1":G.card}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              {!req&&(
                <div style={{width:22,height:22,borderRadius:6,flexShrink:0,border:`2px solid ${on?G.gold:G.bdr}`,background:on?G.gold:"#fff",color:"#fff",fontSize:14,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center"}}>{on?"✓":""}</div>
              )}
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:13}}>{fD(o.date)} · {new Date(o.date+"T12:00:00").toLocaleDateString([],{weekday:"short"})}</div>
                <div style={{fontSize:12,color:isHol?G.gold:G.mut,fontWeight:isHol?700:400}}>{isHol?`🎉 ${o.name}`:"Weekly off"}</div>
              </div>
              {req&&(
                <div style={{display:"flex",gap:6,alignItems:"center"}} onClick={e=>e.stopPropagation()}>
                  <Chip bg={stCol[req.status]||G.dim} label={req.status} sm/>
                  {req.status==="pending"&&<button onClick={()=>withdraw(req)} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:11,padding:"4px 8px"}}>Withdraw</button>}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {L.credits.length>0&&(
        <>
          <div style={{color:G.mut,fontSize:11,fontWeight:700,textTransform:"uppercase",margin:"14px 0 8px"}}>Your comp off credits</div>
          {L.credits.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(x=>(
            <div key={x.id} style={{...K,padding:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontWeight:700,fontSize:13}}>{x.kind==="opening"?"Opening balance":`Worked ${fD(x.date)}`}</div>
                <div style={{fontSize:12,color:G.mut}}>
                  {x.kind==="work"&&(x.open?"Still checked in — counted after check-out · ":`${Math.floor(x.mins/60)}h ${x.mins%60}m worked · `)}
                  expires {fD(x.expires)}
                </div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontWeight:900,color:x.expires<=tod()?G.dim:G.gr}}>{x.left}/{x.value}</div>
                <div style={{fontSize:10,color:G.dim}}>{x.expires<=tod()?"expired":"left"}</div>
              </div>
            </div>
          ))}
        </>
      )}

      {picked.length>0&&(
        <div style={{position:"fixed",left:0,right:0,bottom:0,background:G.card,borderTop:`1px solid ${G.bdr}`,boxShadow:"0 -4px 16px rgba(27,42,94,.12)",padding:"12px 16px",zIndex:50}}>
          <div style={{maxWidth:440,margin:"0 auto"}}>
            <div style={{fontSize:12,fontWeight:700,marginBottom:6}}>{picked.length} day{picked.length>1?"s":""} selected</div>
            <textarea style={{...I,minHeight:48,resize:"vertical",marginBottom:8}} value={why} onChange={e=>setWhy(e.target.value)} placeholder="Reason (applies to all selected days)"/>
            <button disabled={busy} onClick={submit} style={{...B(G.gold),width:"100%",fontWeight:800}}>{busy?"Sending…":`Send ${picked.length} request${picked.length>1?"s":""} to ${mgr?.name||"manager"}`}</button>
          </div>
        </div>
      )}
    </div>
  );
}
function Hist({user,D,setSc}) {
  const now=new Date();
  const [yr,setYr]=useState(now.getFullYear());
  const [mo,setMo]=useState(now.getMonth()+1);
  const MS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const pad=n=>String(n).padStart(2,"0");
  const mStart=`${yr}-${pad(mo)}-01`;
  const mEnd=`${yr}-${pad(mo)}-${pad(new Date(yr,mo,0).getDate())}`;
  const todayStr=tod();
  const allDays=[];
  const cur=new Date(mStart);
  while(true){
    const ds=cur.toISOString().split("T")[0];
    if(ds>mEnd||ds>todayStr) break;
    allDays.push(ds);
    cur.setDate(cur.getDate()+1);
  }
  allDays.reverse();
  const attMap={};
  D.attendance.filter(a=>a.userId===user.id).forEach(a=>{attMap[a.date]=a;});
  const leaveMap={};
  (D.leaves||[]).filter(l=>l.userId===user.id&&l.status==="approved").forEach(l=>{
    const s=new Date(l.from),e=new Date(l.to||l.from);
    for(let d=new Date(s);d<=e;d.setDate(d.getDate()+1)){leaveMap[d.toISOString().split("T")[0]]=l;}
  });
  const uWeeklyOff=user.weeklyOff||"sun_sat";
  const uHols=holsFor(D,user);
  const workDays=allDays.filter(ds=>!isDayOff(ds,uHols,uWeeklyOff));
  const present=workDays.filter(ds=>attMap[ds]&&(attMap[ds].status==="present"||attMap[ds].status==="wfh")).length;
  const late=workDays.filter(ds=>attMap[ds]&&attMap[ds].status==="late").length;
  const absent=workDays.filter(ds=>!attMap[ds]&&!leaveMap[ds]).length;
  const onLeave=workDays.filter(ds=>leaveMap[ds]&&!attMap[ds]).length;
  const total=workDays.length;
  const pct=total?Math.round(((present+late)/total)*100):0;
  const getInfo=(ds)=>{
    const rec=attMap[ds],lv=leaveMap[ds],we=isWE(ds,uWeeklyOff),hl=isHL(ds,uHols);
    const hlName=uHols.find(h=>h.date===ds)?.name;
    if(rec){const sb={present:[G.gr,"✅","Present"],late:[G.am,"⚠️","Late"],wfh:[G.bl,"🏠","WFH"]};return sb[rec.status]||[G.gr,"✅","Present"];}
    if(lv) return [G.pu,"🏖","On Leave"];
    if(hl) return [G.gold,"🎉",hlName||"Holiday"];
    if(we) return [G.dim,"📅","Weekend"];
    return [G.rd,"❌","Absent"];
  };
  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:14}}>
        <button onClick={()=>setSc("home")} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800}}>My Attendance</h2>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <select style={{...I,flex:2}} value={mo} onChange={e=>setMo(Number(e.target.value))}>{MS.map((m,i)=><option key={i} value={i+1}>{m}</option>)}</select>
        <input type="number" style={{...I,flex:1}} value={yr} onChange={e=>setYr(Number(e.target.value))}/>
      </div>
      <div style={{display:"flex",gap:6,marginBottom:12}}>
        {[["✅",present,G.gr,"Present"],["⚠️",late,G.am,"Late"],["❌",absent,G.rd,"Absent"],["🏖",onLeave,G.pu,"Leave"]].map(([ic,v,c,lb])=>(
          <div key={lb} style={{...K,flex:1,textAlign:"center",padding:"8px 4px",marginBottom:0}}>
            <div style={{fontSize:13}}>{ic}</div>
            <div style={{fontSize:17,fontWeight:900,color:c}}>{v}</div>
            <div style={{fontSize:8,color:G.dim,textTransform:"uppercase",fontWeight:700}}>{lb}</div>
          </div>
        ))}
      </div>
      <div style={{...K,marginBottom:12,padding:14}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontWeight:700,fontSize:13}}>{MS[mo-1]} {yr}</span><span style={{color:pct>=80?G.gr:pct>=60?G.am:G.rd,fontWeight:900}}>{pct}%</span></div>
        <div style={{background:G.card2,borderRadius:8,height:8,overflow:"hidden"}}><div style={{background:pct>=80?`linear-gradient(90deg,${G.gr},${G.goldL})`:pct>=60?`linear-gradient(90deg,${G.am},${G.gold})`:`linear-gradient(90deg,${G.rd},${G.am})`,height:"100%",width:`${pct}%`,borderRadius:8}}/></div>
        <div style={{fontSize:11,color:G.dim,marginTop:5}}>{present+late} of {total} working days attended</div>
      </div>
      {allDays.length===0
        ?<div style={{textAlign:"center",color:G.dim,padding:40}}>No data for this month.</div>
        :allDays.map(ds=>{
          const rec=attMap[ds];
          const [stColor,stIcon,stLabel]=getInfo(ds);
          const we=isWE(ds,uWeeklyOff),hl=isHL(ds,uHols);
          const dayNum=new Date(ds).getDate();
          const dayName=new Date(ds).toLocaleDateString([],{weekday:"short"});
          return (
            <div key={ds} style={{background:we||hl?G.card2:G.card,border:`1px solid ${G.bdr}`,borderRadius:14,padding:"11px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:12,opacity:we||hl?0.6:1}}>
              <div style={{textAlign:"center",minWidth:38,flexShrink:0}}>
                <div style={{fontSize:19,fontWeight:900,color:we||hl?G.dim:G.gold,lineHeight:1}}>{dayNum}</div>
                <div style={{fontSize:9,color:G.dim,fontWeight:700,textTransform:"uppercase"}}>{dayName}</div>
              </div>
              {rec?.selfie
                ?<img src={rec.selfie} style={{width:38,height:38,borderRadius:"50%",objectFit:"cover",border:`2px solid ${stColor}`,flexShrink:0}}/>
                :<div style={{width:38,height:38,borderRadius:"50%",background:G.card2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>{stIcon}</div>
              }
              <div style={{flex:1,minWidth:0}}>
                {rec
                  ?<>
                    <div style={{fontWeight:700,fontSize:13}}>In: {fT(rec.checkIn)}{rec.checkOut?` · Out: ${fT(rec.checkOut)}`:""}</div>
                    {rec.checkOut&&<div style={{fontSize:11,color:G.gold,fontWeight:700}}>{wHr(rec.checkIn,rec.checkOut)} worked</div>}
                    <div style={{fontSize:11,color:G.dim}}>{rec.officeName}{rec.lateBy>0?` · ⚠️${rec.lateBy}m late`:""}</div>
                  </>
                  :<div style={{fontSize:13,color:G.dim}}>{stLabel}</div>
                }
              </div>
              <Chip bg={stColor} label={stLabel} sm/>
            </div>
          );
        })
      }
    </div>
  );
}

function Lv({user,D,ST,setSc}) {
  const bal=leaveBalances(D,user);
  const avail=bal.filter(b=>b.left>0);                 // only leave types with balance can be applied
  const blank=()=>({type:avail[0]?.type||"",duration:"full",from:tod(),to:tod(),reason:""});
  const [form,setForm]=useState(blank);
  const cur=bal.find(b=>b.type===form.type);
  const CO=compOffLedger(D,user);
  const draft={...form,to:form.duration==="half"?form.from:form.to};
  const need=form.type?leaveDays(draft,D,user):0;
  const sc={pending:G.am,approved:G.gr,rejected:G.rd,cancelled:G.dim};

  const apply=async()=>{
    if(!form.type)return ST("No leave balance available","error");
    if(form.duration!=="half"&&form.to<form.from)return ST("'To' date is before 'From' date","error");
    if(need<=0)return ST("Those dates are all weekly offs or holidays — nothing to apply","error");
    if(form.type==="compoff"){
      const ok=CO.availableOn(form.from);
      if(need>ok)return ST(`Need ${need} comp off, only ${ok} valid on ${fD(form.from)}`,"error");
    } else if(need>(cur?.left||0)) return ST(`Need ${need} day(s), only ${cur?.left||0} ${cur?.label} left`,"error");
    if(!form.reason.trim())return ST("Please add a reason","error");
    await addLeave({id:gid(),userId:user.id,userName:user.name,teamId:user.teamId,
      ...draft,days:need,appliedOn:new Date().toISOString(),status:"pending"});
    const mgr=(D.users||[]).find(u=>u.id===user.reportingTo);
    if(mgr)notifyLeaveReq(mgr,user.name,LEAVE_LABEL[form.type]||form.type,form.from);
    ST("✅ Leave applied — manager notified");setForm(blank());
  };

  const myL=(D.leaves||[]).filter(l=>l.userId===user.id).sort((a,b)=>new Date(b.appliedOn)-new Date(a.appliedOn));
  const tog=(on)=>({...B(on?G.gold:G.card2),flex:1,fontSize:13,border:on?"none":`1px solid ${G.bdr}`});

  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:14}}>
        <button onClick={()=>setSc("home")} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800}}>Leaves</h2>
      </div>

      <div style={K}>
        <div style={{fontSize:11,color:G.mut,fontWeight:700,textTransform:"uppercase",marginBottom:10}}>
          {user.employeeType==="articled"?"Balance · earned monthly over articleship":"Balance · leave year April – March"}
        </div>
        {user.employeeType==="articled"&&!user.articleshipStart&&(
          <div style={{fontSize:12,color:G.am,marginBottom:8}}>Articleship start date is not set, so no leave has been earned yet. Ask HR to add it.</div>
        )}
        <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
          {bal.map(b=>(
            <div key={b.type} style={{background:G.card2,borderRadius:10,padding:"8px 10px",flex:"1 1 70px",textAlign:"center",border:`1px solid ${b.left>0?G.bdr:G.rd+"55"}`,opacity:b.left>0?1:.6}}>
              <div style={{fontSize:10,color:G.mut,textTransform:"uppercase",fontWeight:700}}>{b.label}</div>
              <div style={{fontSize:20,fontWeight:900,color:b.left>0?G.txt:G.rd}}>{b.left}</div>
              <div style={{fontSize:10,color:G.dim}}>{b.total===null?"earned":`of ${b.total}`}</div>
              {b.accrual&&<div style={{fontSize:9,color:G.dim,marginTop:2}}>{b.accrual.rate}/month × {b.accrual.months} mo</div>}
            </div>
          ))}
        </div>
      </div>

      <div style={K}>
        <div style={{fontWeight:800,marginBottom:10}}>Apply for leave</div>
        {avail.length===0?(
          <div style={{fontSize:13,color:G.mut,padding:"8px 0"}}>You have no leave balance left. Speak to HR if you need time off.</div>
        ):(<>
          <FRow label="Leave type">
            <select style={I} value={form.type} onChange={e=>setForm({...form,type:e.target.value})}>
              {avail.map(b=><option key={b.type} value={b.type}>{b.label} — {b.left} left</option>)}
            </select>
          </FRow>
          <FRow label="Duration">
            <div style={{display:"flex",gap:8}}>
              <button type="button" onClick={()=>setForm({...form,duration:"full"})} style={tog(form.duration==="full")}>Full day(s)</button>
              <button type="button" onClick={()=>setForm({...form,duration:"half",to:form.from})} style={tog(form.duration==="half")}>Half day</button>
            </div>
          </FRow>
          {form.duration==="half"?(
            <>
              <FRow label="Date"><input type="date" style={I} value={form.from} onChange={e=>setForm({...form,from:e.target.value,to:e.target.value})}/></FRow>
              <FRow label="Session">
                <div style={{display:"flex",gap:8}}>
                  <button type="button" onClick={()=>setForm({...form,session:"morning"})} style={tog((form.session||"morning")==="morning")}>Morning</button>
                  <button type="button" onClick={()=>setForm({...form,session:"afternoon"})} style={tog(form.session==="afternoon")}>Afternoon</button>
                </div>
              </FRow>
            </>
          ):(
            <div style={{display:"flex",gap:8}}>
              <FRow label="From"><input type="date" style={I} value={form.from} onChange={e=>setForm({...form,from:e.target.value,to:e.target.value<form.to?form.to:e.target.value})}/></FRow>
              <FRow label="To"><input type="date" style={I} value={form.to} onChange={e=>setForm({...form,to:e.target.value})}/></FRow>
            </div>
          )}
          <div style={{fontSize:12,color:need>0?G.mut:G.am,marginBottom:10}}>
            {need>0?`This uses ${need} day${need===1?"":"s"} of ${cur?.label}. Weekly offs and holidays are not counted.`:"Selected dates are weekly offs or holidays."}
          </div>
          <FRow label="Reason"><textarea style={{...I,resize:"vertical",minHeight:65}} value={form.reason} onChange={e=>setForm({...form,reason:e.target.value})} placeholder="Reason…"/></FRow>
          <button onClick={apply} style={{...B(G.gold),width:"100%",fontWeight:800}}>Apply leave</button>
        </>)}
      </div>

      {myL.length>0&&<div style={{color:G.mut,fontSize:11,fontWeight:700,textTransform:"uppercase",margin:"4px 0 8px"}}>Your applications</div>}
      {myL.map(l=>(
        <div key={l.id} style={K}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
            <div>
              <div style={{fontWeight:700}}>{LEAVE_LABEL[l.type]||l.type}{(l.duration==="half"||l.type==="halfday")&&" · half day"}</div>
              <div style={{fontSize:12,color:G.mut,marginTop:2}}>{fD(l.from)}{l.to&&l.to!==l.from?` → ${fD(l.to)}`:""} · {leaveDays(l,D,user)} day{leaveDays(l,D,user)===1?"":"s"}</div>
              {l.reason&&<div style={{fontSize:12,color:G.dim,fontStyle:"italic"}}>"{l.reason}"</div>}
              {l.reviewNote&&<div style={{fontSize:11,color:G.mut,marginTop:2}}>Note: {l.reviewNote}</div>}
            </div>
            <Chip bg={sc[l.status]||G.dim} label={l.status} sm/>
          </div>
        </div>
      ))}
    </div>
  );
}
function Notif({user,D,P,setSc}) {
  const ns=(D.notifications||[]).filter(n=>n.userId===user.id).sort((a,b)=>new Date(b.ts)-new Date(a.ts));
  const markAll=()=>(D.notifications||[]).filter(n=>n.userId===user.id&&!n.read).forEach(n=>updateNotification(n.id,{read:true}));
  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <button onClick={()=>setSc("home")} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
          <h2 style={{margin:0,fontSize:17,fontWeight:800}}>Notifications</h2>
        </div>
        {ns.some(n=>!n.read)&&<button onClick={markAll} style={{...B(G.navyL),fontSize:11,padding:"6px 10px"}}>Mark read</button>}
      </div>
      {ns.length===0?<div style={{textAlign:"center",color:G.dim,padding:40}}>No notifications.</div>:ns.map(n=>(
        <div key={n.id} style={{background:n.read?G.card:G.navyL,border:`1px solid ${n.read?G.bdr:G.gold}`,borderRadius:14,padding:14,marginBottom:10,display:"flex",gap:10}}>
          <div style={{fontSize:20,flexShrink:0}}>{n.type==="success"?"✅":n.type==="error"?"❌":"ℹ️"}</div>
          <div style={{flex:1}}><div style={{fontSize:13,fontWeight:n.read?400:700}}>{n.msg}</div><div style={{fontSize:11,color:G.dim,marginTop:3}}>{fD(n.ts)}</div></div>
          {!n.read&&<span style={{width:8,height:8,background:G.gold,borderRadius:"50%",flexShrink:0,marginTop:4}}/>}
        </div>
      ))}
    </div>
  );
}

function Reg({user,D,P,ST,setSc}) {
  const [f,setF]=useState({date:tod(),reason:"",checkIn:"09:30",checkOut:"18:30",session:"full"});
  const MAX_REG=3; // max regularizations per month
  const mon=tod().substr(0,7);
  const usedReg=(D.regularizations||[]).filter(r=>r.userId===user.id&&r.date&&r.date.startsWith(mon)).length;
  const remReg=Math.max(0,MAX_REG-usedReg);
  const submit=()=>{
    if(!f.reason.trim())return ST("Please add reason","error");
    if(usedReg>=MAX_REG)return ST(`You have used all ${MAX_REG} regularizations for this month`,"error");
    addReg({id:gid(),userId:user.id,userName:user.name,teamId:user.teamId,...f,appliedOn:new Date().toISOString(),status:"pending"});
    ST("📝 Submitted!");setSc("home");
  };
  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:14}}>
        <button onClick={()=>setSc("home")} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800,color:G.gold}}>Regularization</h2>
      </div>
      <div style={K}>
        <div style={{background:remReg===0?"#fdecea":"#e9f7ef",border:`1px solid ${remReg===0?G.rd:G.gr}`,borderRadius:10,padding:"8px 12px",marginBottom:12}}>
          <div style={{fontSize:12,fontWeight:700,color:remReg===0?G.rd:G.gr}}>
            {remReg===0?`⚠️ No regularizations left this month`:`✅ ${remReg} of ${MAX_REG} regularizations remaining this month`}
          </div>
        </div>
        <FRow label="Date"><input type="date" style={I} value={f.date} onChange={e=>setF({...f,date:e.target.value})}/></FRow>
        <FRow label="Session">
          <select style={I} value={f.session||"full"} onChange={e=>setF({...f,session:e.target.value})}>
            <option value="full">Full Day</option>
            <option value="morning">Morning Only (checkout later)</option>
            <option value="evening">Evening Only (checkin done)</option>
          </select>
        </FRow>
        <div style={{display:"flex",gap:8}}><FRow label="Check-in"><input type="time" style={I} value={f.checkIn} onChange={e=>setF({...f,checkIn:e.target.value})}/></FRow><FRow label="Check-out"><input type="time" style={I} value={f.checkOut} onChange={e=>setF({...f,checkOut:e.target.value})}/></FRow></div>
        <FRow label="Reason"><textarea style={{...I,resize:"vertical",minHeight:70}} value={f.reason} onChange={e=>setF({...f,reason:e.target.value})} placeholder="Why was attendance missed?"/></FRow>
        <div style={{display:"flex",gap:8}}><button onClick={submit} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),flex:2,color:"#fff",fontWeight:800}}>Submit</button><button onClick={()=>setSc("home")} style={{...B(G.dim),flex:1}}>Cancel</button></div>
      </div>
    </div>
  );
}

function Dash({user,D,P,ST,AN,logout,setSc}) {
  const [tab,setTab]=useState("ov");
  const isA=user.role==="admin"||user.role==="hr";
  const tabs=isA?[["ov","Overview"],["live","Live"],["att","Records"],["lv","Leaves"],["rg","Regularize"],["co","Comp Off"],["ex","⚠ Exceptions"],["le","Late/Early rules"],["pay","Payroll"],["pol","Policy"],["hol","Holidays"],["st","Staff"],["tm","Teams"],["of","Offices"],["bk","💾 Backups"],["rst","⚙ Reset"]]:[["ov","Overview"],["live","Live"],["att","Records"],["lv","Leaves"],["rg","Regularize"],["co","Comp Off"],...(user.role==="hod"?[["ex","⚠ Exceptions"],["le","Late/Early rules"]]:[]),["pay","Payroll"]];
  const isHR=user.role==="hr";
  const isHOD=user.role==="hod";
  const vu=isA||isHR
    ?D.users.filter(u=>u.role!=="admin")
    :isHOD
    ?D.users.filter(u=>u.role!=="admin"&&(u.teamId===user.teamId||(D.teams||[]).some(t=>t.id===u.teamId&&t.hodId===user.id)))
    :D.users.filter(u=>u.reportingTo===user.id||(user.managedTeams||[]).includes(u.teamId)||u.id===user.id);
  const pL=(D.leaves||[]).filter(l=>l.status==="pending"&&vu.some(u=>u.id===l.userId)).length;
  const pR=(D.regularizations||[]).filter(r=>r.status==="pending"&&vu.some(u=>u.id===r.userId)).length;
  const mon=tod().slice(0,7);
  const pX=vu.filter(u=>{const s=leIncidents(D,u,mon);return s.exception||s.open>0;}).length;
  const pC=(D.workApprovals||[]).filter(w=>w.status==="pending"&&vu.some(u=>u.id===w.userId)).length;
  const tp={D,P,ST,AN,vu,isA,user};
  return (
    <div style={{maxWidth:500,margin:"0 auto",padding:"14px 14px 80px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{display:"flex",gap:10,alignItems:"center"}}><Logo s={26}/><div><div style={{fontSize:10,color:G.gold,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em"}}>{isA?"Admin":isHOD?"HOD / Partner":"Manager"}</div><div style={{fontSize:16,fontWeight:900}}>{user.name}</div></div></div>
        {SAAS_MODE&&D.firmTrial&&(()=>{const daysLeft=Math.max(0,Math.ceil((new Date(D.firmTrial)-new Date())/(1000*60*60*24)));return daysLeft<=7&&(<div style={{background:daysLeft===0?G.rd:G.am,color:"#fff",fontSize:11,fontWeight:700,padding:"4px 10px",borderRadius:8,marginBottom:8,width:"100%",textAlign:"center"}}>⏰ {daysLeft===0?"Trial expired! ":"Trial: "}{daysLeft} days left</div>);})()}
        <div style={{display:"flex",gap:6}}>
          <button onClick={()=>setSc("profile")} style={{...B(G.navyL),fontSize:11,padding:"7px 10px",border:`1px solid ${G.bdr}`}}>👤</button>
          {isA&&<button onClick={()=>setSc("superadmin")} style={{...B(G.navyL),fontSize:11,padding:"7px 10px",border:`1px solid ${G.bdr}`}}>⚙️</button>}
          <button onClick={logout} style={{...B(G.card),fontSize:12,padding:"8px 12px",border:`1px solid ${G.bdr}`}}>Logout</button>
        </div>
      </div>
      <div style={{display:"flex",gap:5,marginBottom:12,overflowX:"auto",paddingBottom:4}}>
        {tabs.map(([id,lb])=>(
          <button key={id} onClick={()=>setTab(id)} style={{...B(tab===id?G.gold:G.card),whiteSpace:"nowrap",fontSize:12,padding:"7px 9px",border:tab===id?"none":`1px solid ${G.bdr}`,color:tab===id?"#fff":G.mut,flexShrink:0,position:"relative",fontWeight:tab===id?800:600}}>
            {lb}
            {id==="lv"&&pL>0&&<span style={{position:"absolute",top:-4,right:-4,background:G.rd,color:"#fff",borderRadius:"50%",width:14,height:14,fontSize:8,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900}}>{pL}</span>}
            {id==="co"&&pC>0&&<span style={{position:"absolute",top:-4,right:-4,background:G.am,color:"#fff",borderRadius:"50%",width:14,height:14,fontSize:8,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900}}>{pC}</span>}
            {id==="ex"&&pX>0&&<span style={{position:"absolute",top:-4,right:-4,background:G.rd,color:"#fff",borderRadius:"50%",width:14,height:14,fontSize:8,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900}}>{pX}</span>}
            {id==="rg"&&pR>0&&<span style={{position:"absolute",top:-4,right:-4,background:G.am,color:"#fff",borderRadius:"50%",width:14,height:14,fontSize:8,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900}}>{pR}</span>}
          </button>
        ))}
      </div>
      {tab==="ov"&&<OV {...tp}/>}
      {tab==="live"&&<LV {...tp}/>}
      {tab==="att"&&<AT {...tp}/>}
      {tab==="lv"&&<LT {...tp}/>}
      {tab==="rg"&&<RT {...tp}/>}
      {tab==="pay"&&<PT {...tp}/>}
      {tab==="pol"&&isA&&<PC {...tp}/>}
      {tab==="hol"&&isA&&<HC {...tp}/>}
      {tab==="st"&&isA&&<SC {...tp}/>}
      {tab==="tm"&&isA&&<TC {...tp}/>}
      {tab==="of"&&isA&&<OC {...tp}/>}
      {tab==="org"&&<ORG {...tp}/>}
      {tab==="br"&&isA&&<BR {...tp}/>}
      {tab==="bk"&&isA&&<BK {...tp}/>}
      {tab==="co"&&<COM {...tp}/>}
      {tab==="ex"&&(isA||isHOD)&&<EX {...tp}/>}
      {tab==="le"&&(isA||isHOD)&&<LER {...tp}/>}
      {tab==="rst"&&isA&&<RST {...tp} logout={logout}/>}
    </div>
  );
}

function OV({D,vu}) {
  const todayStr=tod();
  const tr=D.attendance.filter(a=>a.date===todayStr);
  // Get LATEST record per user (in case of duplicates)
  const userLatest={};
  tr.forEach(a=>{
    if(vu.some(u=>u.id===a.userId)){
      if(!userLatest[a.userId]||new Date(a.checkIn)>new Date(userLatest[a.userId].checkIn)){
        userLatest[a.userId]=a;
      }
    }
  });
  const uniqueRecs=Object.values(userLatest);
  const ci=uniqueRecs.length;
  const wC=uniqueRecs.filter(a=>a.isWFH).length;
  const tot=vu.length;
  const ab=Math.max(0,tot-ci);
  const pct=tot?Math.round((ci/tot)*100):0;
  const lt=uniqueRecs.filter(r=>r.status==="late").length;
  const lN=vu.filter(u=>D.liveLocations?.[u.id]).length;
  const sb={present:G.gr,late:G.am,wfh:G.bl};
  return (
    <>
      <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
        {[["✅","Present",ci,G.gr],["❌","Absent",ab,G.rd],["🏠","WFH",wC,G.bl],["⚠️","Late",lt,G.am]].map(([ic,lb,v,c])=>(
          <div key={lb} style={{...K,flex:"1 1 60px",textAlign:"center",padding:"10px 6px",marginBottom:0}}><div style={{fontSize:16}}>{ic}</div><div style={{fontSize:20,fontWeight:900,color:c}}>{v}</div><div style={{fontSize:9,color:G.dim,textTransform:"uppercase",fontWeight:700,marginTop:2}}>{lb}</div></div>
        ))}
      </div>
      <div style={{...K,marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontWeight:700}}>Attendance</span><span style={{color:G.gold,fontWeight:900}}>{pct}%</span></div>
        <div style={{background:G.card2,borderRadius:8,height:9,overflow:"hidden"}}><div style={{background:`linear-gradient(90deg,${G.gold},${G.goldL})`,height:"100%",width:`${pct}%`,borderRadius:8,transition:"width .5s"}}/></div>
        <div style={{display:"flex",justifyContent:"space-between",marginTop:5}}><span style={{fontSize:11,color:G.dim}}>{ci}/{tot} in</span><span style={{fontSize:11,color:G.bl}}>📍{lN} live</span></div>
      </div>
      <div style={K}>
        <div style={{fontWeight:700,marginBottom:8,color:G.gold}}>Today</div>
        {vu.map(u=>{const r=userLatest[u.id],lv=D.liveLocations?.[u.id];return(
          <div key={u.id} style={{display:"flex",gap:8,alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${G.bdr}`}}>
            {r?.selfie?<img src={r.selfie} style={{width:34,height:34,borderRadius:"50%",objectFit:"cover",border:`2px solid ${G.gold}`}}/>:<div style={{width:34,height:34,borderRadius:"50%",background:G.card2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>👤</div>}
            <div style={{flex:1,minWidth:0}}><div style={{fontSize:13,fontWeight:700}}>{u.name}{lv&&<span style={{marginLeft:5,width:6,height:6,background:G.gr,borderRadius:"50%",display:"inline-block",animation:"pulse 2s infinite"}}/>}</div><div style={{fontSize:11,color:G.dim}}>{r?`In:${fT(r.checkIn)}${r.checkOut?` Out:${fT(r.checkOut)}`:""}${r.lateBy>0?` ⚠️${r.lateBy}m`:""}${r.isWFH?" 🏠":""}` : "Absent"}</div></div>
            <Chip bg={r?(sb[r.status]||G.gr):G.rd} label={r?r.status:"—"} sm/>
          </div>
        );})}
      </div>
    </>
  );
}

function LV({D,vu}) {
  const [sel,setSel]=useState(null);
  const [placeNames,setPlaceNames]=useState({});

  const getAge=(loc)=>{
    if(!loc?.ts)return 9999;
    const ts=loc.ts?.toDate?loc.ts.toDate():new Date(loc.ts);
    return Math.round((new Date()-ts)/60000); // age in minutes
  };

  const isRecent=(loc)=>getAge(loc)<720; // within 12 hours

  const lv=vu.filter(u=>D.liveLocations?.[u.id]&&isRecent(D.liveLocations[u.id]));
  const off=vu.filter(u=>!D.liveLocations?.[u.id]||!isRecent(D.liveLocations[u.id]));

  const getPlaceName=async(userId,lat,lng)=>{
    if(placeNames[userId])return;
    try{
      const res=await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`);
      const data=await res.json();
      const name=data.address?.city||data.address?.town||data.address?.village||data.address?.state_district||data.address?.state||"Unknown";
      setPlaceNames(p=>({...p,[userId]:name}));
    }catch(e){}
  };

  return (
    <>
      <div style={{...K,background:G.card2,border:`1px solid ${G.navyL}`}}>
        <div style={{color:G.gold,fontWeight:700,fontSize:13}}>📍 Live Location</div>
        <div style={{color:G.dim,fontSize:12,marginTop:3}}>{lv.length}/{vu.length} sharing location.</div>
      </div>
      {lv.length===0&&<div style={{textAlign:"center",color:G.dim,padding:30,fontSize:13}}>No live locations. Staff must be logged in with app open.</div>}
      {lv.map(u=>{
        const loc=D.liveLocations[u.id];
        const r=D.attendance.find(a=>a.userId===u.id&&a.date===tod());
        const checkedIn=r&&!r.checkOut;
        const checkedOut=r&&r.checkOut;
        const ageMin=getAge(loc);
        const isStale=ageMin>30;
        const nr=D.offices.reduce((b,o)=>{const d=dist(loc.lat,loc.lng,o.lat,o.lng);return(!b||d<b.d)?{...o,d}:b;},null);
        const atOffice=nr&&nr.d<=(nr.radius||200);
        if(!placeNames[u.id])getPlaceName(u.id,loc.lat,loc.lng);
        const cityName=placeNames[u.id];

        return (
          <div key={u.id} style={{...K,border:sel===u.id?`1px solid ${G.gold}`:`1px solid ${G.bdr}`,cursor:"pointer"}} onClick={()=>setSel(sel===u.id?null:u.id)}>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              {r?.selfie?<img src={r.selfie} style={{width:44,height:44,borderRadius:"50%",objectFit:"cover",border:`2px solid ${G.gold}`}}/>:<div style={{width:44,height:44,borderRadius:"50%",background:G.card2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>👤</div>}
              <div style={{flex:1}}>
                <div style={{fontWeight:700,display:"flex",gap:6,alignItems:"center"}}>
                  {u.name}
                  <span style={{width:7,height:7,background:isStale?G.am:G.gr,borderRadius:"50%",animation:isStale?"none":"pulse 2s infinite"}}/>
                </div>
                <div style={{fontSize:12,color:isStale?G.am:G.mut}}>
                  {atOffice?`🏢 ${nr.name}`:cityName?`📍 ${cityName}`:`📍 ${Math.round(nr?.d||0)}m from ${nr?.name||"office"}`}
                  {isStale&&<span style={{fontSize:10,marginLeft:4}}>⚠️ {ageMin<60?`${ageMin}m`:`${Math.floor(ageMin/60)}h`} ago — may be stale</span>}
                </div>
                {r&&<div style={{fontSize:11,color:G.dim}}>{checkedIn?`In: ${fT(r.checkIn)} · ${r.officeName}`:checkedOut?`In: ${fT(r.checkIn)} · Out: ${fT(r.checkOut)}`:""}</div>}
              </div>
              <Chip bg={checkedIn?G.gr:checkedOut?G.bl:G.am} label={checkedIn?"In":checkedOut?"Done":"No Record"} sm/>
            </div>
            {sel===u.id&&(
              <div style={{marginTop:10,background:G.card2,borderRadius:10,padding:12}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
                  {[["Lat",loc.lat?.toFixed(5)],["Lng",loc.lng?.toFixed(5)],["Accuracy",`±${loc.ac||"?"}m`],["City",cityName||"Loading..."],["Last updated",ageMin<1?"just now":ageMin<60?`${ageMin}m ago`:`${Math.floor(ageMin/60)}h ago`],["Office dist",`${Math.round(nr?.d||0)}m from ${nr?.name||"office"}`]].map(([lb,v])=>(
                    <div key={lb} style={{background:G.card2,borderRadius:8,padding:"6px 10px"}}>
                      <div style={{fontSize:9,color:G.dim,fontWeight:700,textTransform:"uppercase"}}>{lb}</div>
                      <div style={{fontSize:12,color:G.txt,fontWeight:600,marginTop:1}}>{v}</div>
                    </div>
                  ))}
                </div>
                <a href={`https://maps.google.com/?q=${loc.lat},${loc.lng}`} target="_blank" rel="noreferrer" style={{display:"block",background:G.bl,color:"#fff",textAlign:"center",padding:"8px",borderRadius:8,fontSize:12,fontWeight:700,textDecoration:"none"}}>🗺 Open in Google Maps</a>
              </div>
            )}
          </div>
        );
      })}
      {off.length>0&&(
        <>
          <div style={{color:G.dim,fontSize:10,fontWeight:700,textTransform:"uppercase",marginBottom:6,marginTop:4}}>Offline / No recent location</div>
          {off.map(u=>(
            <div key={u.id} style={{...K,opacity:.5,display:"flex",gap:10,alignItems:"center"}}>
              <div style={{width:34,height:34,borderRadius:"50%",background:G.card2,display:"flex",alignItems:"center",justifyContent:"center"}}>👤</div>
              <div style={{flex:1}}><div style={{fontSize:13,fontWeight:700}}>{u.name}</div><div style={{fontSize:11,color:G.dim}}>No location data</div></div>
              <Chip bg={G.dim} label="—" sm/>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function AT({D,vu,P,ST,isA}) {
  const [fd,setFd]=useState(tod());
  const [fu,setFu]=useState("all");
  const [sel,setSel]=useState(null);
  const [editId,setEditId]=useState(null);
  const [ef,setEf]=useState({});

  const recs=D.attendance.filter(a=>{
    if(fd&&a.date!==fd)return false;
    if(fu!=="all"&&a.userId!==fu)return false;
    return vu.some(u=>u.id===a.userId);
  }).sort((a,b)=>new Date(b.checkIn)-new Date(a.checkIn));

  const exp=()=>{
    const rows=[["Name","Date","In","Out","Hours","Late","Office","WFH","Status"],
      ...recs.map(r=>[r.userName,r.date,fT(r.checkIn),r.checkOut?fT(r.checkOut):"",
        r.checkOut?wHr(r.checkIn,r.checkOut):"",r.lateBy||0,r.officeName||"",r.isWFH?"Y":"N",r.status])
    ].map(r=>r.map(c=>`"${c}"`).join(",")).join("\n");
    const a=document.createElement("a");
    a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(rows);
    a.download=`att_${fd}.csv`;a.click();ST("📊 Exported!");
  };

  const saveEdit=()=>{
    updateAttendance(editId,{
      status:ef.status,
      lateBy:parseInt(ef.lateBy)||0,
      checkIn:ef.checkIn?new Date(`${ef.date}T${ef.checkIn}`).toISOString():undefined,
      checkOut:ef.checkOut?new Date(`${ef.date}T${ef.checkOut}`).toISOString():null,
      officeName:ef.officeName,
    });
    ST("✅ Attendance updated!");
    setEditId(null);setSel(null);
  };

  const mk=(uid,status)=>{
    const ex=D.attendance.find(a=>a.userId===uid&&a.date===fd);
    if(ex){updateAttendance(ex.id,{status});}
    else{addAttendance({id:gid(),userId:uid,userName:vu.find(u=>u.id===uid)?.name,date:fd,checkIn:new Date().toISOString(),checkOut:null,officeName:"Manual",status,lateBy:0});}
    ST(`Marked ${status}`);
  };

  const sb={present:G.gr,late:G.am,wfh:G.bl,absent:G.rd};

  return (
    <>
      <div style={{display:"flex",gap:8,marginBottom:10}}>
        <input type="date" value={fd} onChange={e=>setFd(e.target.value)} style={{...I,flex:1}}/>
        <select value={fu} onChange={e=>setFu(e.target.value)} style={{...I,flex:1}}>
          <option value="all">All Staff</option>
          {vu.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <button onClick={exp} style={{...B(G.bl),width:"100%",marginBottom:10}}>📥 Export CSV</button>

      {recs.map(r=>(
        <div key={r.id} style={{...K,border:sel===r.id?`1px solid ${G.gold}`:`1px solid ${G.bdr}`,cursor:"pointer"}} onClick={()=>{if(editId!==r.id){setSel(sel===r.id?null:r.id);}}}>
          <div style={{display:"flex",gap:10,alignItems:"center"}}>
            {r.selfie?<img src={r.selfie} style={{width:44,height:44,borderRadius:"50%",objectFit:"cover",border:`2px solid ${G.gold}`}}/>:<div style={{width:44,height:44,borderRadius:"50%",background:G.card2,display:"flex",alignItems:"center",justifyContent:"center"}}>👤</div>}
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:13}}>{r.userName}{r.isWFH&&<span style={{marginLeft:5,fontSize:11,color:G.bl}}>🏠</span>}</div>
              <div style={{color:G.mut,fontSize:12}}>In:{fT(r.checkIn)}{r.checkOut?` Out:${fT(r.checkOut)} ${wHr(r.checkIn,r.checkOut)}`:""}</div>
              <div style={{color:G.dim,fontSize:11}}>{r.officeName}{r.lateBy>0?` ⚠️${r.lateBy}m`:""}</div>
            </div>
            <Chip bg={sb[r.status]||G.dim} label={r.status} sm/>
          </div>

          {sel===r.id&&editId!==r.id&&(
            <div style={{marginTop:10,background:G.card2,borderRadius:10,padding:12}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
                {[["Date",fD(r.date)],["In",fT(r.checkIn)],["Out",r.checkOut?fT(r.checkOut):"—"],["Hours",r.checkOut?wHr(r.checkIn,r.checkOut):"—"],["Late",r.lateBy>0?`${r.lateBy}m`:"✓"],["Office",r.officeName||"Manual"]].map(([lb,v])=>(
                  <div key={lb} style={{background:G.card2,borderRadius:8,padding:"6px 10px"}}>
                    <div style={{fontSize:9,color:G.dim,fontWeight:700,textTransform:"uppercase"}}>{lb}</div>
                    <div style={{fontSize:12,color:G.txt,fontWeight:600,marginTop:1}}>{v}</div>
                  </div>
                ))}
              </div>
              {r.gps&&<a href={`https://maps.google.com/?q=${r.gps.lat},${r.gps.lng}`} target="_blank" rel="noreferrer" style={{display:"block",background:G.bl,color:"#fff",textAlign:"center",padding:"7px",borderRadius:8,fontSize:12,fontWeight:700,textDecoration:"none",marginBottom:8}}>🗺 View GPS Location</a>}
              {r.selfie&&<div style={{textAlign:"center",marginBottom:8}}><img src={r.selfie} style={{width:80,height:80,borderRadius:10,objectFit:"cover",border:`2px solid ${G.gold}`}}/></div>}
              {isA&&<button onClick={(e)=>{e.stopPropagation();setEditId(r.id);setEf({status:r.status,lateBy:r.lateBy||0,checkIn:r.checkIn?fT(r.checkIn):"",checkOut:r.checkOut?fT(r.checkOut):"",officeName:r.officeName||"",date:r.date});}} style={{...B(G.bl),width:"100%",fontSize:12,fontWeight:700}}>✏️ Edit This Record</button>}
            </div>
          )}

          {editId===r.id&&(
            <div style={{marginTop:10,background:G.card2,borderRadius:10,padding:12}} onClick={e=>e.stopPropagation()}>
              <div style={{color:G.gold,fontWeight:700,marginBottom:10}}>✏️ Edit Attendance — {r.userName}</div>
              <FRow label="Status">
                <select style={I} value={ef.status} onChange={e=>setEf({...ef,status:e.target.value})}>
                  <option value="present">Present</option>
                  <option value="late">Late</option>
                  <option value="wfh">WFH</option>
                  <option value="absent">Absent</option>
                </select>
              </FRow>
              <div style={{display:"flex",gap:8}}>
                <FRow label="Check In Time"><input type="time" style={I} value={ef.checkIn} onChange={e=>setEf({...ef,checkIn:e.target.value})}/></FRow>
                <FRow label="Check Out Time"><input type="time" style={I} value={ef.checkOut} onChange={e=>setEf({...ef,checkOut:e.target.value})}/></FRow>
              </div>
              <FRow label="Late By (mins)"><input type="number" style={I} value={ef.lateBy} onChange={e=>setEf({...ef,lateBy:e.target.value})}/></FRow>
              <FRow label="Office"><input style={I} value={ef.officeName} onChange={e=>setEf({...ef,officeName:e.target.value})}/></FRow>
              <div style={{display:"flex",gap:8,marginTop:4}}>
                <button onClick={saveEdit} style={{...B(G.gr),flex:2,fontWeight:800}}>💾 Save</button>
                <button onClick={(e)=>{e.stopPropagation();setEditId(null);}} style={{...B(G.dim),flex:1}}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {isA&&(
        <div style={K}>
          <div style={{fontWeight:700,marginBottom:8,fontSize:12,color:G.gold}}>Manual Override — {fd}</div>
          {vu.filter(u=>!recs.some(r=>r.userId===u.id)).map(u=>(
            <div key={u.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:`1px solid ${G.bdr}`}}>
              <span style={{fontSize:13}}>{u.name}</span>
              <div style={{display:"flex",gap:5}}>
                {[["P","present",G.gr],["L","late",G.am],["W","wfh",G.bl],["A","absent",G.rd]].map(([lb,st,c])=>(
                  <button key={lb} onClick={()=>mk(u.id,st)} style={{...B(c),fontSize:11,padding:"4px 9px"}}>{lb}</button>
                ))}
              </div>
            </div>
          ))}
          {vu.every(u=>recs.some(r=>r.userId===u.id))&&<div style={{color:G.dim,fontSize:12}}>All staff accounted for.</div>}
        </div>
      )}
    </>
  );
}

function LT({D,vu,P,ST,AN,isA}) {
  const [fl,setFl]=useState("pending"),[eid,setEid]=useState(null),[ef,setEf]=useState(null);
  const lvs=(D.leaves||[]).filter(l=>vu.some(u=>u.id===l.userId)&&(fl==="all"||l.status===fl)).sort((a,b)=>new Date(b.appliedOn)-new Date(a.appliedOn));
  const pd=(D.leaves||[]).filter(l=>l.status==="pending"&&vu.some(u=>u.id===l.userId)).length;
  const tL={casual:"🏖",sick:"🤒",compoff:"🔄",halfday:"🌓",early:"🏃"};
  const sc={pending:G.am,approved:G.gr,rejected:G.rd};
  const cs=(id,st)=>{
    updateLeave(id,{status:st,reviewedOn:new Date().toISOString()});
    const l=(D.leaves||[]).find(x=>x.id===id);
    if(l){
      AN(l.userId,`Your ${l.type} leave has been ${st}.`,st==="approved"?"success":"error");
      const lu=(D.users||[]).find(u=>u.id===l.userId);
      if(lu){st==="approved"?notifyLeaveApproved(lu,l.type):notifyLeaveRejected(lu,l.type);}
    }
    ST(st==="approved"?"✅ Approved!":st==="rejected"?"❌ Rejected":"↩️ Pending");
  };
  return (
    <>
      <div style={{display:"flex",gap:5,marginBottom:10,overflowX:"auto"}}>
        {[["pending",`Pending${pd>0?`(${pd})`:""}`],["approved","Approved"],["rejected","Rejected"],["all","All"]].map(([v,lb])=>(
          <button key={v} onClick={()=>setFl(v)} style={{...B(fl===v?G.gold:G.card),fontSize:12,padding:"6px 10px",border:fl===v?"none":`1px solid ${G.bdr}`,color:fl===v?"#fff":G.mut,flexShrink:0}}>{lb}</button>
        ))}
      </div>
      {lvs.length===0&&<div style={{textAlign:"center",color:G.dim,padding:36}}>No {fl} leaves.</div>}
      {lvs.map(l=>{
        const ed=eid===l.id;
        return (
          <div key={l.id} style={{...K,border:ed?`1px solid ${G.gold}`:`1px solid ${G.bdr}`}}>
            {ed?(
              <div>
                <div style={{color:G.gold,fontWeight:800,marginBottom:10}}>✏️ Edit: {l.userName}</div>
                <FRow label="Type"><select style={I} value={ef.type} onChange={e=>setEf({...ef,type:e.target.value})}>{LEAVE_TYPES.map(([t,lb])=><option key={t} value={t}>{lb}</option>)}</select></FRow>
                <FRow label="Status"><select style={I} value={ef.status} onChange={e=>setEf({...ef,status:e.target.value})}><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></FRow>
                <div style={{display:"flex",gap:8}}><FRow label="From"><input type="date" style={I} value={ef.from} onChange={e=>setEf({...ef,from:e.target.value})}/></FRow><FRow label="To"><input type="date" style={I} value={ef.to} onChange={e=>setEf({...ef,to:e.target.value})}/></FRow></div>
                <FRow label="Note"><input style={I} value={ef.note||""} onChange={e=>setEf({...ef,note:e.target.value})} placeholder="Note to staff…"/></FRow>
                <div style={{display:"flex",gap:8}}><button onClick={()=>{const nl=(D.leaves||[]).map(x=>x.id===l.id?{...x,...ef,reviewNote:ef.note,editedOn:new Date().toISOString()}:x);P({...D,leaves:nl});ST("✅ Updated!");setEid(null);}} style={{...B(G.gr),flex:2}}>💾 Save</button><button onClick={()=>setEid(null)} style={{...B(G.dim),flex:1}}>Cancel</button></div>
              </div>
            ):(
              <>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                  <div><div style={{fontWeight:800}}>{l.userName}</div><div style={{fontSize:13,color:G.gold,marginTop:1}}>{tL[l.type]||"📋"} {l.type}</div><div style={{fontSize:12,color:G.mut,marginTop:1}}>{l.from}{l.to&&l.to!==l.from?`→${l.to}`:""}</div><div style={{fontSize:12,color:G.dim,fontStyle:"italic"}}>"{l.reason}"</div>{l.reviewNote&&<div style={{fontSize:11,color:G.mut,marginTop:2}}>Note:{l.reviewNote}</div>}</div>
                  <Chip bg={sc[l.status]||G.dim} label={l.status} sm/>
                </div>
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  {l.status==="pending"&&<><button onClick={()=>cs(l.id,"approved")} style={{...B(G.gr),fontSize:11,padding:"5px 9px"}}>✅ Approve</button><button onClick={()=>cs(l.id,"rejected")} style={{...B(G.rd),fontSize:11,padding:"5px 9px"}}>❌ Reject</button></>}
                  {l.status==="approved"&&<button onClick={()=>cs(l.id,"pending")} style={{...B(G.am),fontSize:11,padding:"5px 9px"}}>↩️ Unapprove</button>}
                  {l.status==="rejected"&&<button onClick={()=>cs(l.id,"approved")} style={{...B(G.gr),fontSize:11,padding:"5px 9px"}}>✅ Approve</button>}
                  {isA&&<button onClick={()=>{setEid(l.id);setEf({type:l.type,from:l.from,to:l.to||l.from,status:l.status,note:l.reviewNote||"",reason:l.reason});}} style={{...B(G.bl),fontSize:11,padding:"5px 9px"}}>✏️</button>}
                  {isA&&<button onClick={()=>{if(!confirm("Delete?"))return;deleteLeave(l.id);ST("Deleted");}} style={{...B(G.dim),fontSize:11,padding:"5px 9px"}}>🗑</button>}
                </div>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

// ── Exception Dashboard (HR, Admin, HOD/Partner) ───────────────────
function EX({D,vu}) {
  const now=new Date();
  const [mon,setMon]=useState(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`);
  const [sel,setSel]=useState(null);
  const rows=vu.map(u=>({u,s:leIncidents(D,u,mon)}))
    .filter(r=>r.s.needReg>0)
    .sort((a,b)=>(b.s.exception-a.s.exception)||(b.s.open-a.s.open)||(b.s.regd-a.s.regd));
  const nEx=rows.filter(r=>r.s.exception).length;
  const nOpen=rows.filter(r=>r.s.open>0).length;
  return (
    <>
      <div style={{...K,background:G.card2}}>
        <div style={{color:G.gold,fontWeight:700,fontSize:13}}>Exception dashboard</div>
        <div style={{color:G.dim,fontSize:12,marginTop:3}}>
          Staff who crossed their monthly late/early limit. <b>Exception</b> = regularizations beyond the limit.
          <b> Open</b> = not yet regularized; becomes LOP at month end.
        </div>
      </div>
      <FRow label="Month"><input type="month" style={I} value={mon} onChange={e=>setMon(e.target.value)}/></FRow>
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <div style={{...K,flex:1,textAlign:"center",marginBottom:0,padding:12}}>
          <div style={{fontSize:22,fontWeight:900,color:G.rd}}>{nEx}</div><div style={{fontSize:10,color:G.dim,fontWeight:700}}>EXCEPTIONS</div></div>
        <div style={{...K,flex:1,textAlign:"center",marginBottom:0,padding:12}}>
          <div style={{fontSize:22,fontWeight:900,color:G.am}}>{nOpen}</div><div style={{fontSize:10,color:G.dim,fontWeight:700}}>WITH OPEN ITEMS</div></div>
        <div style={{...K,flex:1,textAlign:"center",marginBottom:0,padding:12}}>
          <div style={{fontSize:22,fontWeight:900,color:G.navy}}>{rows.length}</div><div style={{fontSize:10,color:G.dim,fontWeight:700}}>OVER LIMIT</div></div>
      </div>
      {rows.length===0&&<div style={{textAlign:"center",color:G.dim,padding:30}}>Nobody crossed their limit this month.</div>}
      {rows.map(({u,s})=>{
        const team=(D.teams||[]).find(t=>t.id===u.teamId);
        const mgr=(D.users||[]).find(x=>x.id===u.reportingTo);
        return (
          <div key={u.id} style={{...K,border:`1px solid ${s.exception?G.rd:s.open?G.am:G.bdr}`,cursor:"pointer"}} onClick={()=>setSel(sel===u.id?null:u.id)}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <div style={{fontWeight:800}}>{u.name}</div>
                <div style={{fontSize:11,color:G.mut}}>{team?.name||"No team"}{mgr&&` · Manager: ${mgr.name}`}</div>
                <div style={{fontSize:12,marginTop:4}}>
                  {s.list.length} incidents · limit {s.rule.limit} · {s.needReg} over · {s.regd} regularized · <span style={{color:s.open?G.am:G.dim}}>{s.open} open</span>
                </div>
              </div>
              {s.exception
                ?<Chip bg={G.rd} label="EXCEPTION" sm/>
                :s.open>0?<Chip bg={G.am} label="OPEN" sm/>:<Chip bg={G.gr} label="CLEARED" sm/>}
            </div>
            {sel===u.id&&(
              <div style={{marginTop:10}}>
                {s.list.filter(x=>!x.allowed).map(x=>(
                  <div key={x.recId+x.kind} style={{display:"flex",justifyContent:"space-between",borderTop:`1px solid ${G.bdr}`,padding:"6px 0",fontSize:12}}>
                    <span>#{x.n} {fD(x.date)} · {x.kind==="late"?`late ${x.mins}m`:`early ${x.mins}m`}</span>
                    <span style={{fontWeight:700,color:x.regd?G.gr:x.pending?G.bl:G.am}}>{x.regd?"Regularized":x.pending?"Pending":"Open"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ── Late/early rules editor (HR & Admin: all; HOD: own teams + their staff) ──
function LER({D,P,ST,user,vu,isA}) {
  const rules=D.leRules||[];
  const myTeams=isA?(D.teams||[]):(D.teams||[]).filter(t=>t.hodId===user.id||t.id===user.teamId);
  const myStaff=isA?(D.users||[]).filter(u=>u.role!=="admin"):vu;
  const scopes=isA?[["office","Office"],["team","Team"],["staff","Staff"]]:[["team","Team"],["staff","Staff"]];
  const firm=rules.find(r=>r.scope==="default")||{};
  const [fd,setFd]=useState({limit:firm.limit??LE_DEFAULT.limit,lateMins:firm.lateMins??LE_DEFAULT.lateMins,earlyMins:firm.earlyMins??LE_DEFAULT.earlyMins});
  const [f,setF]=useState({scope:scopes[0][0],targetId:"",limit:"",lateMins:"",earlyMins:""});
  const [chk,setChk]=useState("");

  const targets=f.scope==="office"?(D.offices||[]):f.scope==="team"?myTeams:myStaff;
  const nameOf=r=>r.scope==="office"?(D.offices||[]).find(x=>x.id===r.targetId)?.name
    :r.scope==="team"?(D.teams||[]).find(x=>x.id===r.targetId)?.name
    :(D.users||[]).find(x=>x.id===r.targetId)?.name;
  const canEdit=r=>isA||(r.scope==="team"&&myTeams.some(t=>t.id===r.targetId))||(r.scope==="staff"&&myStaff.some(u=>u.id===r.targetId));
  const num=v=>v===""||v===null||v===undefined?"":Math.max(0,parseInt(v)||0);

  const saveFirm=()=>{
    const rec={id:"le_default",scope:"default",targetId:null,limit:num(fd.limit)||0,lateMins:num(fd.lateMins)||0,earlyMins:num(fd.earlyMins)||0};
    P({...D,leRules:[...rules.filter(r=>r.id!=="le_default"),rec]});ST("Firm default saved");
  };
  const saveOv=()=>{
    if(!f.targetId)return ST("Choose who this applies to","error");
    if(f.limit===""&&f.lateMins===""&&f.earlyMins==="")return ST("Enter at least one value","error");
    const id=`le_${f.scope}_${f.targetId}`;
    const rec={id,scope:f.scope,targetId:f.targetId,limit:num(f.limit),lateMins:num(f.lateMins),earlyMins:num(f.earlyMins),
      setBy:user.id,setOn:new Date().toISOString()};
    P({...D,leRules:[...rules.filter(r=>r.id!==id),rec]});
    ST("Override saved");setF({...f,targetId:"",limit:"",lateMins:"",earlyMins:""});
  };
  const del=r=>{if(!confirm(`Remove override for ${nameOf(r)}?`))return;P({...D,leRules:rules.filter(x=>x.id!==r.id)});};

  const ovs=rules.filter(r=>r.scope!=="default").sort((a,b)=>a.scope.localeCompare(b.scope));
  const chkU=(D.users||[]).find(u=>u.id===chk);
  const eff=chkU?leRuleFor(D,chkU):null;
  const show=v=>v===""||v===null||v===undefined?"inherit":v;

  return (
    <>
      <div style={{...K,background:G.card2}}>
        <div style={{color:G.gold,fontWeight:700,fontSize:13}}>Late coming / early leaving rules</div>
        <div style={{color:G.dim,fontSize:12,marginTop:3}}>
          Late and early count together against one monthly limit. Priority: <b>staff › team › office › firm default</b>.
          Leave a field blank in an override to inherit it.
        </div>
      </div>

      {isA&&(
        <div style={K}>
          <div style={{fontWeight:800,marginBottom:8}}>Firm default</div>
          <div style={{display:"flex",gap:8}}>
            <FRow label="Allowed / month"><input type="number" style={I} value={fd.limit} onChange={e=>setFd({...fd,limit:e.target.value})}/></FRow>
            <FRow label="Late after (min)"><input type="number" style={I} value={fd.lateMins} onChange={e=>setFd({...fd,lateMins:e.target.value})}/></FRow>
            <FRow label="Early before (min)"><input type="number" style={I} value={fd.earlyMins} onChange={e=>setFd({...fd,earlyMins:e.target.value})}/></FRow>
          </div>
          <button onClick={saveFirm} style={{...B(G.gold),width:"100%",fontWeight:800}}>Save firm default</button>
        </div>
      )}

      <div style={K}>
        <div style={{fontWeight:800,marginBottom:8}}>Add / update override</div>
        <div style={{display:"flex",gap:8}}>
          <FRow label="Applies to">
            <select style={I} value={f.scope} onChange={e=>setF({...f,scope:e.target.value,targetId:""})}>
              {scopes.map(([v,l])=><option key={v} value={v}>{l}</option>)}
            </select>
          </FRow>
          <FRow label={f.scope==="office"?"Office":f.scope==="team"?"Team":"Staff member"}>
            <select style={I} value={f.targetId} onChange={e=>{
              const id=e.target.value;const ex=rules.find(r=>r.id===`le_${f.scope}_${id}`);
              setF({...f,targetId:id,limit:ex?.limit??"",lateMins:ex?.lateMins??"",earlyMins:ex?.earlyMins??""});
            }}>
              <option value="">Select…</option>
              {targets.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </FRow>
        </div>
        <div style={{display:"flex",gap:8}}>
          <FRow label="Allowed / month"><input type="number" style={I} value={f.limit} placeholder="inherit" onChange={e=>setF({...f,limit:e.target.value})}/></FRow>
          <FRow label="Late after (min)"><input type="number" style={I} value={f.lateMins} placeholder="inherit" onChange={e=>setF({...f,lateMins:e.target.value})}/></FRow>
          <FRow label="Early before (min)"><input type="number" style={I} value={f.earlyMins} placeholder="inherit" onChange={e=>setF({...f,earlyMins:e.target.value})}/></FRow>
        </div>
        <button onClick={saveOv} style={{...B(G.gold),width:"100%",fontWeight:800}}>Save override</button>
      </div>

      <div style={K}>
        <div style={{fontWeight:800,marginBottom:8}}>Check what applies to someone</div>
        <select style={I} value={chk} onChange={e=>setChk(e.target.value)}>
          <option value="">Select staff…</option>
          {myStaff.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        {eff&&(
          <div style={{marginTop:8,fontSize:13}}>
            <b>{eff.limit}</b> per month (from {eff.limitFrom}) · late after <b>{eff.lateMins}</b> min · early before <b>{eff.earlyMins}</b> min
          </div>
        )}
      </div>

      <div style={{color:G.mut,fontSize:11,fontWeight:700,textTransform:"uppercase",margin:"4px 0 8px"}}>Overrides ({ovs.length})</div>
      {ovs.length===0&&<div style={{textAlign:"center",color:G.dim,padding:20,fontSize:13}}>No overrides — everyone uses the firm default.</div>}
      {ovs.map(r=>(
        <div key={r.id} style={{...K,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontWeight:700,fontSize:13}}>{nameOf(r)||"(deleted)"} <span style={{fontSize:11,color:G.dim,fontWeight:600}}>· {r.scope}</span></div>
            <div style={{fontSize:12,color:G.mut}}>limit {show(r.limit)} · late {show(r.lateMins)} · early {show(r.earlyMins)}</div>
          </div>
          {canEdit(r)&&<button onClick={()=>del(r)} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:11,padding:"5px 9px"}}>Remove</button>}
        </div>
      ))}
    </>
  );
}

// ── Comp off management (manager approves; HR / Admin / HOD also set opening balance) ──
function COM({D,ST,AN,user,vu,isA}) {
  const [tab,setTab]=useState("req");
  const [ob,setOb]=useState({userId:"",value:"",note:""});
  const canOpening=isA||user.role==="hod";
  const inScope=w=>vu.some(u=>u.id===w.userId);
  const all=(D.workApprovals||[]).filter(inScope);
  const pend=all.filter(w=>w.status==="pending").sort((a,b)=>a.date.localeCompare(b.date));
  const appr=all.filter(w=>w.status==="approved").sort((a,b)=>b.date.localeCompare(a.date));
  const today=tod();
  const decide=async(w,status)=>{
    await updateWorkApproval(w.id,{status,reviewedBy:user.id,reviewedOn:new Date().toISOString()});
    AN(w.userId,status==="approved"
      ?`Approved to work on ${fD(w.date)}. Check in and check out that day to earn comp off.`
      :`Your request to work on ${fD(w.date)} was rejected.`,status==="approved"?"success":"error");
    ST(status==="approved"?"Approved":"Rejected");
  };
  const cancel=async w=>{
    const past=w.date<=today;
    if(!confirm(past?`Cancel the comp off earned on ${fD(w.date)} by ${w.userName}?`:`Cancel approval to work on ${fD(w.date)}?`))return;
    await updateWorkApproval(w.id,past
      ?{creditCancelled:true,cancelledBy:user.id,cancelledOn:new Date().toISOString()}
      :{status:"cancelled",cancelledBy:user.id,cancelledOn:new Date().toISOString()});
    AN(w.userId,past?`Comp off for ${fD(w.date)} was cancelled by ${user.name}.`:`Approval to work on ${fD(w.date)} was cancelled by ${user.name}.`,"error");
    ST("Cancelled");
  };
  const addOpening=async()=>{
    const v=parseFloat(ob.value);
    if(!ob.userId)return ST("Choose a staff member","error");
    if(!(v>0)||Math.round(v*2)!==v*2)return ST("Enter days in steps of 0.5","error");
    await addCompOff({id:gid(),userId:ob.userId,type:"opening",value:v,date:today,note:ob.note.trim(),by:user.id,byName:user.name,on:new Date().toISOString()});
    AN(ob.userId,`${v} comp off added to your balance by ${user.name}. Valid for 90 days.`,"success");
    ST("Opening balance added");setOb({userId:"",value:"",note:""});
  };
  const credit=w=>{const u=(D.users||[]).find(x=>x.id===w.userId);if(!u)return null;return compOffLedger(D,u).credits.find(x=>x.id===w.id);};
  return (
    <>
      <div style={{display:"flex",gap:6,marginBottom:10}}>
        {[["req",`Requests${pend.length?` (${pend.length})`:""}`],["appr","Approved"],["bal","Balances"]].map(([v,lb])=>(
          <button key={v} onClick={()=>setTab(v)} style={{...B(tab===v?G.gold:G.card),flex:1,fontSize:12,padding:"8px 6px",border:tab===v?"none":`1px solid ${G.bdr}`}}>{lb}</button>
        ))}
      </div>

      {tab==="req"&&(<>
        {pend.length===0&&<div style={{textAlign:"center",color:G.dim,padding:30}}>No pending requests.</div>}
        {pend.map(w=>(
          <div key={w.id} style={K}>
            <div style={{fontWeight:800}}>{w.userName}</div>
            <div style={{fontSize:13,color:G.gold,marginTop:2}}>{fD(w.date)} · {w.dayName||"Day off"}</div>
            <div style={{fontSize:12,color:G.mut,fontStyle:"italic",marginTop:2}}>"{w.reason}"</div>
            <div style={{display:"flex",gap:8,marginTop:10}}>
              <button onClick={()=>decide(w,"approved")} style={{...B(G.gr),flex:2,fontSize:13}}>Approve</button>
              <button onClick={()=>decide(w,"rejected")} style={{...B(G.rd),flex:1,fontSize:13}}>Reject</button>
            </div>
          </div>
        ))}
      </>)}

      {tab==="appr"&&(<>
        {appr.length===0&&<div style={{textAlign:"center",color:G.dim,padding:30}}>Nothing approved yet.</div>}
        {appr.map(w=>{
          const cr=w.date<=today?credit(w):null;
          return (
            <div key={w.id} style={{...K,opacity:w.creditCancelled?.55:1}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div>
                  <div style={{fontWeight:800}}>{w.userName}</div>
                  <div style={{fontSize:12,color:G.mut}}>{fD(w.date)} · {w.dayName||"Day off"}</div>
                  <div style={{fontSize:12,marginTop:3}}>
                    {w.date>today?"Upcoming"
                      :w.creditCancelled?"Credit cancelled"
                      :cr?.open?"Still checked in"
                      :cr?`${Math.floor(cr.mins/60)}h ${cr.mins%60}m worked → ${cr.value===1?"1 day":cr.value===0.5?"½ day":"no credit"}`:"—"}
                  </div>
                </div>
                {!w.creditCancelled&&<button onClick={()=>cancel(w)} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:11,padding:"5px 9px"}}>Cancel</button>}
              </div>
            </div>
          );
        })}
      </>)}

      {tab==="bal"&&(<>
        {canOpening&&(
          <div style={K}>
            <div style={{fontWeight:800,marginBottom:8}}>Add opening balance</div>
            <FRow label="Staff member">
              <select style={I} value={ob.userId} onChange={e=>setOb({...ob,userId:e.target.value})}>
                <option value="">Select…</option>
                {vu.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </FRow>
            <div style={{display:"flex",gap:8}}>
              <FRow label="Days"><input type="number" step="0.5" min="0.5" style={I} value={ob.value} onChange={e=>setOb({...ob,value:e.target.value})}/></FRow>
              <FRow label="Note"><input style={I} value={ob.note} onChange={e=>setOb({...ob,note:e.target.value})} placeholder="e.g. carried forward"/></FRow>
            </div>
            <div style={{fontSize:11,color:G.dim,marginBottom:8}}>Expires 90 days from today.</div>
            <button onClick={addOpening} style={{...B(G.gold),width:"100%",fontWeight:800}}>Add</button>
          </div>
        )}
        {vu.map(u=>{const L=compOffLedger(D,u);if(!L.credits.length&&!L.usage.length)return null;return(
          <div key={u.id} style={{...K,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontWeight:700,fontSize:13}}>{u.name}</div>
              <div style={{fontSize:11,color:G.mut}}>earned {L.earned} · used {L.used} · expired {L.expired}{L.expiringSoon?` · ${L.expiringSoon} expiring soon`:""}</div>
            </div>
            <div style={{textAlign:"right"}}><div style={{fontSize:20,fontWeight:900,color:G.gr}}>{L.available}</div><div style={{fontSize:10,color:G.dim}}>available</div></div>
          </div>);})}
        {vu.every(u=>{const L=compOffLedger(D,u);return !L.credits.length&&!L.usage.length;})&&<div style={{textAlign:"center",color:G.dim,padding:24}}>No comp off balances yet.</div>}
      </>)}
    </>
  );
}

function RT({D,vu,P,ST,AN}) {
  const rgs=(D.regularizations||[]).filter(r=>vu.some(u=>u.id===r.userId)).sort((a,b)=>new Date(b.appliedOn)-new Date(a.appliedOn));
  const sc={pending:G.am,approved:G.gr,rejected:G.rd};
  const ap=(id)=>{
    const r=(D.regularizations||[]).find(x=>x.id===id);if(!r)return;
    if(r.type==="le_reg"){
      if(r.recId)updateAttendance(r.recId,r.kind==="early"?{earlyReg:true}:{lateReg:true});
      updateReg(id,{status:"approved",reviewedOn:new Date().toISOString()});
      AN(r.userId,`Your ${r.kind==="early"?"early leaving":"late coming"} on ${fD(r.date)} was regularized.`,"success");
      ST("✅ Regularized");return;
    }
    if(r.type==="late_approval"){
      const ea=(D.attendance||[]).find(a=>a.userId===r.userId&&a.date===r.date);
      if(ea)updateAttendance(ea.id,{status:"present",lateBy:0,lateApproved:true});
    } else {
      // Only add checkOut if session is full day, not morning (allow real checkout)
      const isMorning=r.session==="morning";
      addAttendance({
        id:gid(),userId:r.userId,userName:r.userName,teamId:r.teamId,
        date:r.date,
        checkIn:new Date(`${r.date}T${r.checkIn}`).toISOString(),
        checkOut:isMorning?null:new Date(`${r.date}T${r.checkOut}`).toISOString(),
        officeName:"Regularized",status:"present",lateBy:0,
        regularized:true,session:r.session||"full"
      });
    }
    updateReg(id,{status:"approved",reviewedOn:new Date().toISOString()});
    AN(r.userId,`Your ${r.type==="late_approval"?"late approval":"regularization"} for ${r.date} has been approved.`,"success");ST("✅ Approved!");
  };
  const rj=(id)=>{
    const r=(D.regularizations||[]).find(x=>x.id===id);
    updateReg(id,{status:"rejected",reviewedOn:new Date().toISOString()});
    if(r)AN(r.userId,`Regularization for ${r.date} rejected.`,"error");ST("❌ Rejected");
  };
  return (
    <>
      <div style={{...K,background:G.card2,border:`1px solid ${G.navyL}`}}><div style={{color:G.gold,fontWeight:700,fontSize:13}}>📝 Regularization Requests</div><div style={{color:G.dim,fontSize:12,marginTop:3}}>Staff can fix missed attendance entries.</div></div>
      {rgs.length===0&&<div style={{textAlign:"center",color:G.dim,padding:36}}>No requests.</div>}
      {rgs.map(r=>(
        <div key={r.id} style={K}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
            <div><div style={{fontWeight:800}}>{r.userName}</div><div style={{fontSize:13,color:G.gold,marginTop:1}}>📅 {fD(r.date)}</div><div style={{fontSize:12,color:G.mut,marginTop:1}}>{r.type==="le_reg"?(r.kind==="early"?`Left ${r.mins} min early`:`Late by ${r.mins} min`):`🕐 ${r.checkIn}→${r.checkOut}`}</div><div style={{fontSize:12,color:G.dim,fontStyle:"italic"}}>"{r.reason}"</div></div>
            <Chip bg={sc[r.status]||G.dim} label={r.status} sm/>
          </div>
          {r.status==="pending"&&<div style={{display:"flex",gap:8}}><button onClick={()=>ap(r.id)} style={{...B(G.gr),flex:1,fontSize:13}}>✅</button><button onClick={()=>rj(r.id)} style={{...B(G.rd),flex:1,fontSize:13}}>❌</button></div>}
        </div>
      ))}
    </>
  );
}

function PT({D,vu,ST,user}) {
  const n=new Date(),[yr,setYr]=useState(n.getFullYear()),[mo,setMo]=useState(n.getMonth()+1);
  const ms=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const polAll=D.leavePolicy||{employee:DP_EMP,articled:DP_AA};
  const rows=vu.map(u=>{
    const s=`${yr}-${String(mo).padStart(2,"0")}-01`,e=`${yr}-${String(mo).padStart(2,"0")}-${String(new Date(yr,mo,0).getDate()).padStart(2,"0")}`;
    // Working days = calendar days minus this person's weekly offs and their holiday calendar
    const uHols=holsFor(D,u);
    const uWO=u.weeklyOff||"sun_sat";
    const wd=workingDaysFor(yr,mo,uHols,uWO);
    const offDays=daysOfMonth(yr,mo).length-wd;
    const pol=(polAll[u.employeeType||"employee"]||DP_EMP);
    const ar=D.attendance.filter(a=>a.userId===u.id&&a.date>=s&&a.date<=e);
    // One attended day per date (re-check-ins don't double count); days off are not paid twice
    const byDate={};
    ar.forEach(r=>{ if(isDayOff(r.date,uHols,uWO))return; const p=byDate[r.date]; if(!p||r.status==="present"||(r.status==="late"&&p.status==="wfh"))byDate[r.date]=r; });
    const days=Object.values(byDate);
    const pr=days.filter(r=>r.status==="present").length,lt=days.filter(r=>r.status==="late").length,wf=days.filter(r=>r.isWFH||r.status==="wfh").length;
    // Approved leave counted in days that fall inside this month
    const eNext=addDays(e,1);
    const ap=(D.leaves||[]).filter(l=>l.userId===u.id&&l.status==="approved"&&l.from<eNext&&(l.to||l.from)>=s);
    const dIn=l=>leaveDays(l,D,u,s,eNext);
    const leaveOn=new Set(); // dates already paid as leave, so attendance on them isn't added again
    ap.forEach(l=>{let d=l.from;const end=(l.duration==="half"||l.type==="halfday")?l.from:(l.to||l.from);while(d<=end){leaveOn.add(d);d=addDays(d,1);}});
    const hd=ap.filter(l=>l.duration==="half"||l.type==="halfday").length;
    const cl=ap.filter(l=>l.type==="casual"||l.type==="halfday").reduce((x,l)=>x+dIn(l),0);
    const sl=ap.filter(l=>l.type==="sick").reduce((x,l)=>x+dIn(l),0);
    const st=ap.filter(l=>l.type==="studyleave").reduce((x,l)=>x+dIn(l),0);
    const co=ap.filter(l=>l.type==="compoff").reduce((x,l)=>x+dIn(l),0);
    const tm=ar.reduce((x,r)=>x+wMin(r.checkIn,r.checkOut),0),am=days.length?Math.round(tm/days.length):0;
    const tp=days.filter(r=>!leaveOn.has(r.date)).length;
    const pd=Math.min(wd,Math.round((tp+cl+sl+st+co)*10)/10),ab=Math.max(0,Math.round((wd-pd)*10)/10);
    const team=D.teams.find(t=>t.id===u.teamId);
    const cal=calsOf(D).find(x=>x.id===calIdOf(u));
    return{id:u.id,name:u.name,email:u.email,team:team?.name||"-",cal:cal?.name||"Default",offDays,wd,pr,lt,wf,hd,cl,sl,st,co,tp,pd,ab,lt2:lt,aH:`${Math.floor(am/60)}h${am%60}m`,tH:`${Math.floor(tm/60)}h${tm%60}m`,pct:wd?Math.round((tp/wd)*100):0};
  });
  const exp=()=>{
    const h=["Name","Email","Team","Holiday Calendar","Off Days (WO+Holidays)","Working Days","Present","Late","WFH","Half Days","Casual","Sick","CompOff","Total Present","Paid Days","Absent","Late Count","Avg Hrs","Total Hrs","Attendance%","Month","Year"];
    const dr=rows.map(r=>[r.name,r.email,r.team,r.cal,r.offDays,r.wd,r.pr,r.lt,r.wf,r.hd,r.cl,r.sl,r.co,r.tp,r.pd,r.ab,r.lt2,r.aH,r.tH,`${r.pct}%`,ms[mo-1],yr]);
    const csv=[h,...dr].map(r=>r.map(c=>`"${c}"`).join(",")).join("\n");
    const a=document.createElement("a");a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);a.download=`Nucleus_Payroll_${ms[mo-1]}_${yr}.csv`;a.click();ST("💰 Payroll exported!");
  };
  return (
    <>
      <div style={{...K,background:G.card2,border:`1px solid ${G.gold}44`}}><div style={{color:G.gold,fontWeight:700,fontSize:13}}>💰 Payroll Report</div><div style={{color:G.dim,fontSize:12,marginTop:3}}>Monthly payroll-ready export for salary processing.</div></div>
      <div style={{display:"flex",gap:8,marginBottom:10}}>
        <div style={{flex:2}}><label style={L}>Month</label><select style={I} value={mo} onChange={e=>setMo(Number(e.target.value))}>{ms.map((m,i)=><option key={i} value={i+1}>{m}</option>)}</select></div>
        <div style={{flex:1}}><label style={L}>Year</label><input type="number" style={I} value={yr} onChange={e=>setYr(Number(e.target.value))}/></div>
      </div>
      <button onClick={exp} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:12,fontSize:14,color:"#fff",fontWeight:800}}>📥 Export to Excel</button>
      <div style={{color:G.mut,fontSize:11,fontWeight:700,textTransform:"uppercase",marginBottom:8}}>{ms[mo-1]} {yr} — working days vary by weekly off & holiday calendar</div>
      {rows.map(r=>(
        <div key={r.id} style={K}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
            <div><div style={{fontWeight:800}}>{r.name}</div><div style={{fontSize:12,color:G.dim}}>{r.team} · 📅 {r.cal}</div><div style={{fontSize:11,color:G.dim}}>{r.wd} working days · {r.offDays} off</div></div>
            <div style={{textAlign:"right"}}><div style={{fontSize:20,fontWeight:900,color:r.ab>3?G.rd:G.gold}}>{r.pd}<span style={{fontSize:11,color:G.dim}}>/{r.wd}</span></div><div style={{fontSize:9,color:G.dim}}>paid</div></div>
          </div>
          <div style={{background:G.card2,borderRadius:8,height:7,overflow:"hidden",marginBottom:8}}><div style={{background:r.pct<70?`linear-gradient(90deg,${G.rd},${G.am})`:`linear-gradient(90deg,${G.gold},${G.goldL})`,height:"100%",width:`${r.pct}%`,borderRadius:8}}/></div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:5}}>
            {[["✅Pres",r.pr,G.gr],["⚠️Late",r.lt,G.am],["🏠WFH",r.wf,G.bl],["🌓Half",r.hd,G.pu],["🏖CL",r.cl,G.bl],["🤒SL",r.sl,G.rd],["🔄CO",r.co,G.mut],["❌Ab",r.ab,r.ab>3?G.rd:G.dim],["⏱Hrs",r.tH,G.gold]].map(([lb,v,c])=>(
              <div key={lb} style={{background:G.card2,borderRadius:8,padding:"5px 6px",textAlign:"center"}}><div style={{fontSize:9,color:G.dim,fontWeight:700}}>{lb}</div><div style={{fontSize:13,fontWeight:900,color:c}}>{v}</div></div>
            ))}
          </div>
          {r.lt>0&&<div style={{marginTop:6,background:"#fff6e8",border:`1px solid ${G.am}44`,borderRadius:7,padding:"5px 8px",fontSize:11,color:G.am}}>⚠️ {r.lt} late — apply deduction per policy</div>}
          {r.ab>3&&<div style={{marginTop:4,background:"#fdecea",border:`1px solid ${G.rd}44`,borderRadius:7,padding:"5px 8px",fontSize:11,color:G.rd}}>🚨 {r.ab} absent — high absenteeism</div>}
        </div>
      ))}
    </>
  );
}

function PC({D,P,ST}) {
  const fullPol=D.leavePolicy||DP;
  const [polEmp,setPolEmp]=useState({...DP_EMP,...(fullPol.employee||{})});
  const [polAA,setPolAA]=useState({...DP_AA,...(fullPol.articled||{})});
  const [etab,setEtab]=useState("employee");
  const pol=etab==="employee"?polEmp:polAA;
  const setPol=etab==="employee"?setPolEmp:setPolAA;
  const tl=etab==="articled"?{sickPerMonth:"Sick Leave",studyleavePerMonth:"Study Leave"}:{casual:"Casual Leave",sick:"Sick Leave"};
  const unit=etab==="articled"?"per month served":"per year (April – March)";
  const stp=etab==="articled"?0.5:1;
  const save=()=>{P({...D,leavePolicy:{employee:polEmp,articled:polAA}});ST("✅ Policy saved!");};
  const reset=()=>{setPolEmp({...DP_EMP});setPolAA({...DP_AA});P({...D,leavePolicy:DP});ST("Reset!");};
  return (
    <>
      <div style={{...K,background:G.card2,border:`1px solid ${G.gold}44`}}><div style={{color:G.gold,fontWeight:700,fontSize:13}}>Leave Policy Settings</div><div style={{color:G.dim,fontSize:12,marginTop:3}}>Set annual leave limits separately for Employees and Articled Assistants.</div></div>
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <button onClick={()=>setEtab("employee")} style={{...B(etab==="employee"?G.gold:G.card),flex:1,fontSize:13,color:etab==="employee"?"#fff":G.mut,border:etab==="employee"?"none":`1px solid ${G.bdr}`,fontWeight:700}}>Employee</button>
        <button onClick={()=>setEtab("articled")} style={{...B(etab==="articled"?G.gold:G.card),flex:1,fontSize:13,color:etab==="articled"?"#fff":G.mut,border:etab==="articled"?"none":`1px solid ${G.bdr}`,fontWeight:700}}>Articled Assistant</button>
      </div>
      <div style={K}>
        <div style={{fontWeight:800,marginBottom:4,color:G.gold,fontSize:14}}>{etab==="employee"?"Employee":"Articled Assistant"} — {etab==="articled"?"Monthly Accrual":"Annual Allowances"}</div>
        <div style={{fontSize:11,color:G.dim,marginBottom:12}}>{etab==="employee"?"Days per leave year (April – March). Resets every 1 April.":"Days earned for each completed month of articleship. Builds up over the whole tenure and never resets."}</div>
        {Object.entries(tl).map(([t,lb])=>(
          <div key={t} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:`1px solid ${G.bdr}`}}>
            <div><div style={{fontWeight:700,fontSize:13}}>{lb}</div><div style={{fontSize:11,color:G.dim}}>{pol[t]||0} days {unit}</div></div>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              <button onClick={()=>setPol({...pol,[t]:Math.max(0,(pol[t]||0)-stp)})} style={{...B(G.card2),padding:"4px 10px",fontSize:15,border:`1px solid ${G.bdr}`}}>−</button>
              <input type="number" value={pol[t]||0} step={stp} onChange={e=>setPol({...pol,[t]:Math.max(0,parseFloat(e.target.value)||0)})} style={{...I,width:58,textAlign:"center",padding:"7px 5px"}}/>
              <button onClick={()=>setPol({...pol,[t]:(pol[t]||0)+stp})} style={{...B(G.card2),padding:"4px 10px",fontSize:15,border:`1px solid ${G.bdr}`}}>+</button>
            </div>
          </div>
        ))}
        <div style={{display:"flex",gap:8,marginTop:12}}>
          <button onClick={save} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),flex:2,color:"#fff",fontWeight:800}}>Save Policy</button>
          <button onClick={reset} style={{...B(G.dim),flex:1}}>Reset All</button>
        </div>
      </div>
      <div style={K}>
        <div style={{fontWeight:700,marginBottom:8,color:G.gold}}>Staff Usage Summary</div>
        {D.users.filter(u=>u.role!=="admin").map(u=>{
          const bs=leaveBalances(D,u).filter(b=>b.type!=="compoff");
          return(
            <div key={u.id} style={{padding:"8px 0",borderBottom:`1px solid ${G.bdr}`}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <div style={{fontWeight:700,fontSize:13}}>{u.name}</div>
                <Chip bg={u.employeeType==="articled"?G.pu:G.bl} label={u.employeeType==="articled"?"Articled":"Employee"} sm/>
              </div>
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                {bs.map(b=>(<div key={b.type} style={{background:G.card2,borderRadius:6,padding:"2px 7px",fontSize:11,border:`1px solid ${b.left<=0?G.rd+"55":G.bdr}`}}><span style={{color:G.mut}}>{b.label}: </span><span style={{color:b.left<=0?G.rd:G.txt,fontWeight:700}}>{b.used}/{b.total} used</span></div>))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function HC({D,P,ST}) {
  const cals=calsOf(D);
  const [calId,setCalId]=useState(cals[0]?.id||DEFAULT_CAL);
  const [sa,setSa]=useState(false);
  const [f,setF]=useState({date:"",name:""});
  const [mgCal,setMgCal]=useState(false);
  const [calName,setCalName]=useState("");
  const [editCal,setEditCal]=useState(null);

  const active=cals.find(x=>x.id===calId)||cals[0];
  const hs=(D.holidays||[]).filter(h=>(h.calendarId||DEFAULT_CAL)===calId)
    .sort((a,b)=>a.date.localeCompare(b.date));
  const staffOn=(D.users||[]).filter(u=>calIdOf(u)===calId).length;

  const addHol=()=>{
    if(!f.date||!f.name)return ST("Date and name required","error");
    if(hs.some(h=>h.date===f.date))return ST("That date already exists in this calendar","error");
    P({...D,holidays:[...(D.holidays||[]),{...f,id:gid(),calendarId:calId}]});
    ST("Holiday added");setSa(false);setF({date:"",name:""});
  };

  const saveCal=()=>{
    if(!calName.trim())return ST("Calendar name required","error");
    const list=calsOf(D);
    if(editCal){
      P({...D,holidayCalendars:list.map(x=>x.id===editCal?{...x,name:calName.trim()}:x)});
      ST("Calendar renamed");
    } else {
      const nid="cal_"+gid();
      P({...D,holidayCalendars:[...list,{id:nid,name:calName.trim()}]});
      setCalId(nid);ST("Calendar created");
    }
    setCalName("");setEditCal(null);setMgCal(false);
  };

  const delCal=(id)=>{
    const list=calsOf(D);
    if(list.length<=1)return ST("At least one calendar is required","error");
    const users=(D.users||[]).filter(u=>calIdOf(u)===id).length;
    const hols=(D.holidays||[]).filter(h=>(h.calendarId||DEFAULT_CAL)===id).length;
    if(!confirm(`Delete "${list.find(x=>x.id===id)?.name}"?\n\n${hols} holidays will be deleted.\n${users} staff will move to ${list.find(x=>x.id!==id)?.name}.`))return;
    const fallback=list.find(x=>x.id!==id).id;
    P({...D,
      holidayCalendars:list.filter(x=>x.id!==id),
      holidays:(D.holidays||[]).filter(h=>(h.calendarId||DEFAULT_CAL)!==id),
      users:(D.users||[]).map(u=>calIdOf(u)===id?{...u,calendarId:fallback}:u)});
    setCalId(fallback);ST("Calendar deleted");
  };

  return (
    <>
      <div style={{...K,background:G.card2}}>
        <div style={{color:G.gold,fontWeight:700,fontSize:13}}>Holiday calendars</div>
        <div style={{color:G.dim,fontSize:12,marginTop:3}}>
          Keep a separate list per office or client location. Each staff member follows one calendar,
          and their payroll working days are calculated from it.
        </div>
      </div>

      {/* Calendar picker */}
      <div style={{display:"flex",gap:6,overflowX:"auto",marginBottom:10,paddingBottom:4}}>
        {cals.map(cl=>(
          <button key={cl.id} onClick={()=>setCalId(cl.id)}
            style={{...B(calId===cl.id?G.gold:G.card),color:calId===cl.id?"#fff":G.mut,
              border:calId===cl.id?"none":`1px solid ${G.bdr}`,fontSize:12,padding:"7px 12px",
              whiteSpace:"nowrap",flexShrink:0,fontWeight:700}}>
            {cl.name}
          </button>
        ))}
        <button onClick={()=>{setMgCal(!mgCal);setEditCal(null);setCalName("");}}
          style={{...B(G.card),color:G.mut,border:`1px dashed ${G.bdr}`,fontSize:12,
            padding:"7px 12px",whiteSpace:"nowrap",flexShrink:0}}>+ Calendar</button>
      </div>

      {/* Create / rename calendar */}
      {mgCal&&(
        <div style={{...K,border:`1px solid ${G.gold}`}}>
          <div style={{fontWeight:800,color:G.gold,marginBottom:10}}>
            {editCal?"Rename calendar":"New calendar"}
          </div>
          <FRow label="Calendar name">
            <input style={I} value={calName} onChange={e=>setCalName(e.target.value)}
              placeholder="e.g. BFSI — Amritsar" onKeyDown={e=>e.key==="Enter"&&saveCal()}/>
          </FRow>
          <div style={{display:"flex",gap:8}}>
            <button onClick={saveCal} style={{...B(G.gold),flex:2,color:"#fff",fontWeight:800}}>
              {editCal?"Save":"Create"}
            </button>
            <button onClick={()=>{setMgCal(false);setEditCal(null);setCalName("");}}
              style={{...B(G.dim),flex:1}}>Cancel</button>
          </div>
        </div>
      )}

      {/* Active calendar summary */}
      <div style={{...K,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontWeight:800,fontSize:14}}>{active?.name}</div>
          <div style={{fontSize:12,color:G.mut,marginTop:2}}>
            {hs.length} holidays · {staffOn} staff assigned
          </div>
        </div>
        <div style={{display:"flex",gap:6}}>
          <button onClick={()=>{setEditCal(calId);setCalName(active?.name||"");setMgCal(true);}}
            style={{...B(G.bl),fontSize:11,padding:"5px 9px"}}>Rename</button>
          {cals.length>1&&(
            <button onClick={()=>delCal(calId)}
              style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:11,padding:"5px 9px"}}>Delete</button>
          )}
        </div>
      </div>

      <button onClick={()=>setSa(!sa)}
        style={{...B(G.gold),width:"100%",marginBottom:10,color:"#fff",fontWeight:800}}>
        {sa?"Cancel":`+ Add holiday to ${active?.name}`}
      </button>

      {sa&&(
        <div style={{...K}}>
          <FRow label="Date"><input type="date" style={I} value={f.date} onChange={e=>setF({...f,date:e.target.value})}/></FRow>
          <FRow label="Occasion"><input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="e.g. Diwali"/></FRow>
          <button onClick={addHol} style={{...B(G.gold),width:"100%",color:"#fff",fontWeight:800}}>Add</button>
        </div>
      )}

      {hs.length===0&&!sa&&(
        <div style={{textAlign:"center",color:G.dim,padding:28,fontSize:13}}>
          No holidays in this calendar yet.
        </div>
      )}

      {hs.map(h=>(
        <div key={h.id} style={{...K,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontWeight:700}}>{h.name}</div>
            <div style={{fontSize:12,color:G.mut,marginTop:2}}>
              {fD(h.date)} · {new Date(h.date).toLocaleDateString([],{weekday:"long"})}
            </div>
          </div>
          <button onClick={()=>{if(!confirm(`Remove ${h.name}?`))return;P({...D,holidays:(D.holidays||[]).filter(x=>x.id!==h.id)});}}
            style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:12,padding:"5px 9px"}}>Remove</button>
        </div>
      ))}
    </>
  );
}

function SC({D,P,ST}) {
  const [sa,setSa]=useState(false);
  const [editU,setEditU]=useState(null);
  const emptyF={name:"",email:"",password:"pass123",role:"staff",employeeType:"employee",teamId:"",officeIds:[],reportingTo:"",designation:"",weeklyOff:"sun_sat",calendarId:DEFAULT_CAL,articleshipStart:"",mobile:""};
  const [f,setF]=useState(emptyF);
  const save=()=>{
    if(!f.name||!f.email)return ST("Name and email required","error");
    if(editU){P({...D,users:D.users.map(u=>u.id===editU?{...u,...f}:u)});ST("✅ Updated!");}
    else{P({...D,users:[...D.users,{...f,id:gid()}]});ST("✅ Added!");}
    setSa(false);setEditU(null);setF(emptyF);
  };
  const startEdit=(u)=>{
    setF({name:u.name,email:u.email,password:u.password||"",role:u.role,employeeType:u.employeeType||"employee",teamId:u.teamId||"",officeIds:u.officeIds||[],reportingTo:u.reportingTo||"",designation:u.designation||"",weeklyOff:u.weeklyOff||"sun_sat",calendarId:calIdOf(u),articleshipStart:u.articleshipStart||"",mobile:u.mobile||""});
    setEditU(u.id);setSa(true);window.scrollTo(0,0);
  };
  const roleColor={admin:G.rd,hr:G.pu,hod:G.bl,manager:G.navyL,staff:G.card2};
  return (
    <>
      <button onClick={()=>{setSa(!sa);if(sa){setEditU(null);setF(emptyF);}}} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:10,color:"#fff",fontWeight:800}}>
        {sa&&!editU?"✕ Cancel":editU?"✕ Cancel Edit":"+ Add Staff"}
      </button>
      {sa&&(
        <div style={{...K,border:`1px solid ${editU?G.bl:G.bdr}`}}>
          <div style={{fontWeight:800,color:editU?G.bl:G.gold,marginBottom:10}}>{editU?"✏️ Edit Staff":"👤 New Staff"}</div>
          <FRow label="Name"><input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="Full Name"/></FRow>
          <FRow label="Email"><input style={I} value={f.email} onChange={e=>setF({...f,email:e.target.value})} placeholder="email@nucleusadvisors.in"/></FRow>
          <FRow label="Password"><input style={I} type="password" value={f.password} onChange={e=>setF({...f,password:e.target.value})}/></FRow>
          <FRow label="Role">
            <select style={I} value={f.role} onChange={e=>setF({...f,role:e.target.value})}>
              <option value="staff">Staff</option>
              <option value="manager">Manager</option>
              <option value="hod">HOD / Partner</option>
              <option value="hr">HR Manager</option>
            </select>
          </FRow>
          <FRow label="Employee Type">
            <select style={I} value={f.employeeType} onChange={e=>setF({...f,employeeType:e.target.value})}>
              <option value="employee">Employee</option>
              <option value="articled">Articled Assistant (CA)</option>
            </select>
          </FRow>
          <FRow label="Designation"><input style={I} value={f.designation||""} onChange={e=>setF({...f,designation:e.target.value})} placeholder="e.g. Senior Associate"/></FRow>
          <FRow label="Mobile (for WhatsApp alerts)">
            <input style={I} value={f.mobile||""} onChange={e=>setF({...f,mobile:e.target.value})} placeholder="10-digit mobile number" maxLength={10} type="tel"/>
          </FRow>
          <FRow label="Team">
            <select style={I} value={f.teamId||""} onChange={e=>setF({...f,teamId:e.target.value})}>
              <option value="">No Team</option>
              {D.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </FRow>
          <FRow label="Reporting Manager">
            <select style={I} value={f.reportingTo||""} onChange={e=>setF({...f,reportingTo:e.target.value})}>
              <option value="">None</option>
              {D.users.filter(u=>["manager","hod","hr","admin"].includes(u.role)&&u.id!==editU).map(u=>(
                <option key={u.id} value={u.id}>{u.name} ({ROLE_LABELS[u.role]||u.role})</option>
              ))}
            </select>
          </FRow>
          <FRow label="Weekly Off">
            <select style={I} value={f.weeklyOff||"sun_sat"} onChange={e=>setF({...f,weeklyOff:e.target.value})}>
              {WEEKLY_OFF_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </FRow>
          <FRow label="Holiday Calendar">
            <select style={I} value={f.calendarId||DEFAULT_CAL} onChange={e=>setF({...f,calendarId:e.target.value})}>
              {calsOf(D).map(cl=><option key={cl.id} value={cl.id}>{cl.name}</option>)}
            </select>
            <div style={{fontSize:11,color:G.dim,marginTop:4}}>
              Decides which holidays apply and the payable working days in payroll.
            </div>
          </FRow>
          <FRow label="Offices">
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
              {D.offices.map(o=>{
                const sel=(f.officeIds||[]).includes(o.id);
                return <button key={o.id} onClick={()=>setF({...f,officeIds:sel?(f.officeIds||[]).filter(i=>i!==o.id):[...(f.officeIds||[]),o.id]})} style={{...B(sel?G.gold:G.card2),fontSize:12,padding:"5px 10px",color:sel?"#fff":G.mut,border:sel?"none":`1px solid ${G.bdr}`}}>{o.name}</button>;
              })}
              {D.offices.length===0&&<div style={{fontSize:12,color:G.dim}}>Add offices first</div>}
            </div>
          </FRow>
          {f.employeeType==="articled"&&(
            <FRow label="Articleship Start Date">
              <input type="date" style={I} value={f.articleshipStart||""} onChange={e=>setF({...f,articleshipStart:e.target.value})}/>
            </FRow>
          )}
          <div style={{display:"flex",gap:8}}>
            <button onClick={save} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),flex:2,color:"#fff",fontWeight:800}}>{editU?"💾 Save":"➕ Add"}</button>
            <button onClick={()=>{setSa(false);setEditU(null);setF(emptyF);}} style={{...B(G.dim),flex:1}}>Cancel</button>
          </div>
        </div>
      )}
      {D.users.filter(u=>u.role!=="admin").map(u=>{
        const team=D.teams.find(t=>t.id===u.teamId);
        const mgr=D.users.find(x=>x.id===u.reportingTo);
        return(
          <div key={u.id} style={{...K,display:"flex",gap:10,alignItems:"flex-start"}}>
            <div style={{width:38,height:38,borderRadius:"50%",background:roleColor[u.role]||G.card2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>
              {u.role==="hr"?"🧑‍💼":u.role==="hod"?"🏛":u.role==="manager"?"👔":"👤"}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:13}}>{u.name}{u.designation&&<span style={{fontSize:11,color:G.mut}}> — {u.designation}</span>}</div>
              <div style={{fontSize:11,color:G.dim}}>{u.email}</div>
              <div style={{fontSize:11,color:G.mut,marginTop:1}}>{team?.name||"No team"} · {(u.officeIds||[]).length} office(s) · 📅 {calsOf(D).find(x=>x.id===calIdOf(u))?.name||"Default"}</div>
              {mgr&&<div style={{fontSize:11,color:G.mut}}>Reports to: <span style={{color:G.gold}}>{mgr.name}</span></div>}
              <div style={{display:"flex",gap:4,flexWrap:"wrap",marginTop:3}}>
                <Chip bg={roleColor[u.role]||G.dim} label={ROLE_LABELS[u.role]||u.role} sm/>
                <Chip bg={u.employeeType==="articled"?G.pu:G.bl} label={u.employeeType==="articled"?"Articled":"Employee"} sm/>
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:5,flexShrink:0}}>
              <button onClick={()=>startEdit(u)} style={{...B(G.bl),fontSize:11,padding:"5px 9px"}}>✏️</button>
              <button onClick={()=>{if(!confirm(`Remove ${u.name}?`))return;P({...D,users:D.users.filter(x=>x.id!==u.id)});}} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:11,padding:"5px 9px"}}>✕</button>
            </div>
          </div>
        );
      })}
    </>
  );
}

function TC({D,P,ST}) {
  const [sa,setSa]=useState(false);
  const [editT,setEditT]=useState(null);
  const emptyTF={name:"",shiftStart:"09:30",shiftEnd:"18:30",hodId:""};
  const [f,setF]=useState(emptyTF);
  const save=()=>{
    if(!f.name)return ST("Name required","error");
    if(editT){P({...D,teams:D.teams.map(t=>t.id===editT?{...t,...f}:t)});ST("✅ Updated!");}
    else{P({...D,teams:[...D.teams,{...f,id:gid()}]});ST("✅ Created!");}
    setSa(false);setEditT(null);setF(emptyTF);
  };
  return (
    <>
      <button onClick={()=>{setSa(!sa);if(sa){setEditT(null);setF(emptyTF);}}} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:10,color:"#fff",fontWeight:800}}>{sa?"✕ Cancel":"+ Add Team"}</button>
      {sa&&(<div style={{...K,marginBottom:10}}>
        <div style={{fontWeight:800,color:editT?G.bl:G.gold,marginBottom:10}}>{editT?"✏️ Edit Team":"New Team"}</div>
        <FRow label="Team Name"><input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="e.g. Tax & Regulatory"/></FRow>
        <div style={{display:"flex",gap:8}}>
          <FRow label="Shift Start"><input type="time" style={I} value={f.shiftStart} onChange={e=>setF({...f,shiftStart:e.target.value})}/></FRow>
          <FRow label="Shift End"><input type="time" style={I} value={f.shiftEnd} onChange={e=>setF({...f,shiftEnd:e.target.value})}/></FRow>
        </div>
        <FRow label="HOD / Partner">
          <select style={I} value={f.hodId||""} onChange={e=>setF({...f,hodId:e.target.value})}>
            <option value="">— None —</option>
            {(D.users||[]).filter(u=>u.role==="hod"||u.role==="admin").map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <div style={{fontSize:11,color:G.dim,marginTop:4}}>Sees this team's exceptions and can set its late/early limits.</div>
        </FRow>
        <div style={{display:"flex",gap:8}}>
          <button onClick={save} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),flex:2,color:"#fff",fontWeight:800}}>{editT?"💾 Save":"Create"}</button>
          <button onClick={()=>{setSa(false);setEditT(null);setF(emptyTF);}} style={{...B(G.dim),flex:1}}>Cancel</button>
        </div>
      </div>)}
      {D.teams.map(t=>(
        <div key={t.id} style={{...K,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{fontWeight:700}}>{t.name}</div><div style={{fontSize:12,color:G.mut}}>🕘 {t.shiftStart}–{t.shiftEnd} · {D.users.filter(u=>u.teamId===t.id).length} members{t.hodId&&` · HOD: ${(D.users||[]).find(u=>u.id===t.hodId)?.name||"—"}`}</div></div>
          {SAAS_MODE&&D.firmTrial&&(()=>{const daysLeft=Math.max(0,Math.ceil((new Date(D.firmTrial)-new Date())/(1000*60*60*24)));return daysLeft<=7&&(<div style={{background:daysLeft===0?G.rd:G.am,color:"#fff",fontSize:11,fontWeight:700,padding:"4px 10px",borderRadius:8,marginBottom:8,width:"100%",textAlign:"center"}}>⏰ {daysLeft===0?"Trial expired! ":"Trial: "}{daysLeft} days left</div>);})()}
        <div style={{display:"flex",gap:6}}>
            <button onClick={()=>{setF({name:t.name,shiftStart:t.shiftStart,shiftEnd:t.shiftEnd,hodId:t.hodId||""});setEditT(t.id);setSa(true);}} style={{...B(G.bl),fontSize:11,padding:"5px 9px"}}>✏️</button>
            <button onClick={()=>{if(!confirm("Delete?"))return;P({...D,teams:D.teams.filter(x=>x.id!==t.id)});}} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:11,padding:"5px 9px"}}>✕</button>
          </div>
        </div>
      ))}
    </>
  );
}
function OC({D,P,ST}) {
  const [sa,setSa]=useState(false);
  const [editO,setEditO]=useState(null);
  const emptyOF={name:"",lat:"",lng:"",radius:200,branchId:""};
  const [f,setF]=useState(emptyOF);
  const [dt,setDt]=useState(false);
  const [search,setSearch]=useState("");
  const [searching,setSearching]=useState(false);

  const det=()=>{
    setDt(true);
    navigator.geolocation?.getCurrentPosition(p=>{
      setF(prev=>({...prev,lat:p.coords.latitude.toFixed(6),lng:p.coords.longitude.toFixed(6)}));
      setDt(false);
    },()=>{ST("Cannot detect location","error");setDt(false);},{enableHighAccuracy:true,timeout:15000,maximumAge:30000});
  };

  const searchLocation=async()=>{
    if(!search.trim())return ST("Enter a location name","error");
    setSearching(true);
    try{
      const res=await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(search)}&limit=1`);
      const data=await res.json();
      if(data&&data[0]){
        setF(prev=>({...prev,lat:parseFloat(data[0].lat).toFixed(6),lng:parseFloat(data[0].lon).toFixed(6)}));
        ST("📍 Location found!");
      } else {ST("Location not found. Try different search.","error");}
    }catch(e){ST("Search failed. Try GPS instead.","error");}
    setSearching(false);
  };

  const save=()=>{
    if(!f.name||!f.lat||!f.lng)return ST("Name and location required","error");
    const rec={...f,lat:parseFloat(f.lat),lng:parseFloat(f.lng),radius:parseInt(f.radius)};
    if(editO){P({...D,offices:D.offices.map(o=>o.id===editO?{...o,...rec}:o)});ST("✅ Updated!");}
    else{P({...D,offices:[...D.offices,{...rec,id:gid()}]});ST("✅ Added!");}
    setSa(false);setEditO(null);setF(emptyOF);setSearch("");
  };

  return (
    <>
      <button onClick={()=>{setSa(!sa);if(sa){setEditO(null);setF(emptyOF);setSearch("");}}} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:10,color:"#fff",fontWeight:800}}>{sa?"✕ Cancel":"+ Add Office"}</button>
      {sa&&(
        <div style={{...K,marginBottom:10}}>
          <div style={{fontWeight:800,color:editO?G.bl:G.gold,marginBottom:10}}>{editO?"✏️ Edit Office":"🏢 New Office"}</div>
          <FRow label="Office Name"><input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="e.g. Delhi Office"/></FRow>
          <FRow label="Branch">
            <select style={I} value={f.branchId||""} onChange={e=>setF({...f,branchId:e.target.value})}>
              <option value="">No Branch</option>
              {(D.branches||[]).map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </FRow>
          <LocationPicker
            value={{lat:f.lat,lng:f.lng,address:f.address||""}}
            onChange={loc=>setF({...f,lat:loc.lat,lng:loc.lng})}
            ST={ST}
          />
          <FRow label="Geofence Radius (meters)"><input type="number" style={I} value={f.radius} onChange={e=>setF({...f,radius:e.target.value})}/></FRow>
          <div style={{display:"flex",gap:8}}>
            <button onClick={save} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),flex:2,color:"#fff",fontWeight:800}}>{editO?"💾 Save":"✅ Add Office"}</button>
            <button onClick={()=>{setSa(false);setEditO(null);setF(emptyOF);setSearch("");}} style={{...B(G.dim),flex:1}}>Cancel</button>
          </div>
        </div>
      )}
      {D.offices.map(o=>(
        <div key={o.id} style={{...K,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{fontWeight:700}}>🏢 {o.name}</div><div style={{fontSize:12,color:G.mut}}>📍 {o.lat},{o.lng} · {o.radius}m</div></div>
          {SAAS_MODE&&D.firmTrial&&(()=>{const daysLeft=Math.max(0,Math.ceil((new Date(D.firmTrial)-new Date())/(1000*60*60*24)));return daysLeft<=7&&(<div style={{background:daysLeft===0?G.rd:G.am,color:"#fff",fontSize:11,fontWeight:700,padding:"4px 10px",borderRadius:8,marginBottom:8,width:"100%",textAlign:"center"}}>⏰ {daysLeft===0?"Trial expired! ":"Trial: "}{daysLeft} days left</div>);})()}
        <div style={{display:"flex",gap:6}}>
            <button onClick={()=>{setF({name:o.name,lat:String(o.lat),lng:String(o.lng),radius:o.radius});setEditO(o.id);setSa(true);}} style={{...B(G.bl),fontSize:11,padding:"5px 9px"}}>✏️</button>
            <button onClick={()=>{if(!confirm("Delete?"))return;P({...D,offices:D.offices.filter(x=>x.id!==o.id)});}} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:11,padding:"5px 9px"}}>✕</button>
          </div>
        </div>
      ))}
    </>
  );
}

function LocationPicker({value, onChange, ST}) {
  const [showMap,setShowMap]=useState(false);
  const [detecting,setDetecting]=useState(false);
  const [mapCenter,setMapCenter]=useState(
    value?.lat&&value?.lng
      ?{lat:parseFloat(value.lat),lng:parseFloat(value.lng)}
      :{lat:26.9124,lng:75.7873} // Default: Jaipur
  );

  const detectGPS=()=>{
    if(!navigator.geolocation)return ST("GPS not supported","error");
    setDetecting(true);
    navigator.geolocation.getCurrentPosition(pos=>{
      const lat=pos.coords.latitude.toFixed(6);
      const lng=pos.coords.longitude.toFixed(6);
      setMapCenter({lat:parseFloat(lat),lng:parseFloat(lng)});
      fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`)
        .then(r=>r.json())
        .then(d=>{
          onChange({lat,lng,address:d.display_name||`${lat}, ${lng}`});
          ST("📍 Location detected!");
        })
        .catch(()=>{onChange({lat,lng,address:`${lat}, ${lng}`});ST("📍 Location detected!");});
      setDetecting(false);
    },(e)=>{
      ST("Could not get GPS. Please allow location access.","error");
      setDetecting(false);
    },{enableHighAccuracy:true,timeout:15000});
  };

  // Google Maps iframe URL for picking location
  const mapSrc=`https://maps.google.com/maps?q=${mapCenter.lat},${mapCenter.lng}&z=15&output=embed`;

  return (
    <div>
      {/* GPS Button */}
      <button onClick={detectGPS} style={{...B(G.pu),width:"100%",marginBottom:8,fontWeight:700}}>
        {detecting?"📍 Detecting…":"📍 Use My Current GPS Location"}
      </button>

      {/* Open Map Button */}
      <button onClick={()=>setShowMap(!showMap)} style={{...B(showMap?G.rd:G.bl),width:"100%",marginBottom:8,fontWeight:700}}>
        {showMap?"✕ Close Map":"🗺️ Pick Location on Google Maps"}
      </button>

      {/* Google Maps iframe */}
      {showMap&&(
        <div style={{marginBottom:8,borderRadius:12,overflow:"hidden",border:`2px solid ${G.gold}`}}>
          <div style={{background:G.card2,padding:"8px 12px",fontSize:12,color:G.am}}>
            ⚠️ After finding your location on the map, copy the coordinates below manually or use GPS button above.
          </div>
          <iframe
            title="Google Maps"
            src={mapSrc}
            width="100%"
            height="300"
            style={{display:"block",border:"none"}}
            allowFullScreen
          />
          <a
            href={`https://maps.google.com/?q=${mapCenter.lat},${mapCenter.lng}`}
            target="_blank"
            rel="noreferrer"
            style={{display:"block",background:G.bl,color:"#fff",textAlign:"center",padding:"10px",fontSize:13,fontWeight:700,textDecoration:"none"}}
          >
            🔗 Open Full Google Maps to Copy Coordinates
          </a>
        </div>
      )}

      {/* Selected location display */}
      {value?.lat&&value?.lng&&(
        <div style={{background:G.card2,borderRadius:10,padding:"10px 12px",fontSize:12,marginBottom:8,border:`1px solid ${G.gold}44`}}>
          <div style={{color:G.gold,fontWeight:700,marginBottom:4}}>✅ Selected Location</div>
          {value.address&&<div style={{color:G.txt,marginBottom:4,fontSize:11,lineHeight:1.4}}>{value.address}</div>}
          <div style={{color:G.dim,fontSize:11}}>📌 {value.lat}, {value.lng}</div>
          <a href={`https://maps.google.com/?q=${value.lat},${value.lng}`} target="_blank" rel="noreferrer"
            style={{display:"inline-block",marginTop:6,color:G.bl,fontSize:11,textDecoration:"underline"}}>
            Verify on Google Maps ↗
          </a>
        </div>
      )}

      {/* Manual lat/lng input */}
      <div style={{fontSize:11,color:G.dim,marginBottom:6}}>Or enter coordinates manually:</div>
      <div style={{display:"flex",gap:8}}>
        <div style={{flex:1}}>
          <label style={L}>Latitude</label>
          <input style={I} value={value?.lat||""} onChange={e=>onChange({...value||{},lat:e.target.value})} placeholder="e.g. 26.9124"/>
        </div>
        <div style={{flex:1}}>
          <label style={L}>Longitude</label>
          <input style={I} value={value?.lng||""} onChange={e=>onChange({...value||{},lng:e.target.value})} placeholder="e.g. 75.7873"/>
        </div>
      </div>
      {value?.lat&&value?.lng&&(
        <button onClick={()=>setMapCenter({lat:parseFloat(value.lat),lng:parseFloat(value.lng)})} style={{...B(G.navyL),width:"100%",marginTop:8,fontSize:12,border:`1px solid ${G.bdr}`}}>
          🗺️ Preview This Location on Map
        </button>
      )}
    </div>
  );
}


function Profile({user,D,P,ST,setSc,logout}) {
  const back=()=>setSc(["admin","hr"].includes(user?.role)?"dash":"home");
  const [tab,setTab]=useState("profile"); // profile | password

  // Profile fields staff can edit
  const [f,setF]=useState({
    name:user.name||"",
    mobile:user.mobile||"",
    emergencyContact:user.emergencyContact||"",
    emergencyName:user.emergencyName||"",
    address:user.address||"",
    bloodGroup:user.bloodGroup||"",
    homeLat:user.homeLat||"",
    homeLng:user.homeLng||"",
    homeAddress:user.homeAddress||"",
  });

  // Password fields
  const [cur,setCur]=useState("");
  const [np,setNp]=useState("");
  const [cp,setCp]=useState("");

  const saveProfile=()=>{
    if(!f.name.trim())return ST("Name cannot be empty","error");
    P({...D,users:D.users.map(u=>u.id===user.id?{...u,...f}:u)});
    ST("✅ Profile updated!");
  };

  const savePwd=()=>{
    const u=(D.users||[]).find(x=>x.id===user.id);
    if(!u||cur.trim()!==u.password?.trim())return ST("Current password incorrect","error");
    if(np.length<4)return ST("New password must be at least 4 characters","error");
    if(np!==cp)return ST("Passwords do not match","error");
    P({...D,users:D.users.map(x=>x.id===user.id?{...x,password:np}:x)});
    ST("✅ Password changed! Please login again.");
    setTimeout(()=>logout(),2000);
  };

  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:16}}>
        <button onClick={back} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800}}>My Profile</h2>
      </div>

      {/* Profile summary card */}
      <div style={{...K,background:`linear-gradient(135deg,${G.navy},${G.navyL})`,marginBottom:12,display:"flex",gap:14,alignItems:"center"}}>
        <div style={{width:56,height:56,borderRadius:"50%",background:G.gold,color:"#fff",fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>
          {user.name?.charAt(0)?.toUpperCase()||"?"}
        </div>
        <div>
          <div style={{fontWeight:800,fontSize:15,color:"#fff"}}>{user.name}</div>
          <div style={{fontSize:12,color:"#c9d3ea",marginTop:2}}>{user.email}</div>
          <div style={{display:"flex",gap:6,marginTop:4}}>
            <Chip bg={G.gold} label={ROLE_LABELS[user.role]||user.role} sm/>
            <Chip bg={user.employeeType==="articled"?G.pu:G.bl} label={user.employeeType==="articled"?"Articled":"Employee"} sm/>
          </div>
        </div>
      </div>

      {/* Read-only info */}
      <div style={{...K,marginBottom:12}}>
        <div style={{fontWeight:700,color:G.gold,marginBottom:10,fontSize:13}}>📋 Work Details (Admin managed)</div>
        {[
          ["Team", D.teams?.find(t=>t.id===user.teamId)?.name||"Not assigned"],
          ["Weekly Off", WEEKLY_OFF_OPTIONS?.find(o=>o.value===user.weeklyOff)?.label||user.weeklyOff||"—"],
          ["Reporting To", D.users?.find(u=>u.id===user.reportingTo)?.name||"—"],
          ["Designation", user.designation||"—"],
          ["Employee Type", user.employeeType==="articled"?"Articled Assistant (CA)":"Employee"],
        ].map(([lb,v])=>(
          <div key={lb} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${G.bdr}`}}>
            <span style={{fontSize:12,color:G.mut,fontWeight:600}}>{lb}</span>
            <span style={{fontSize:12,color:G.txt,fontWeight:700,textAlign:"right",maxWidth:"60%"}}>{v}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <button onClick={()=>setTab("profile")} style={{...B(tab==="profile"?G.gold:G.card),flex:1,fontSize:13,color:tab==="profile"?"#fff":G.mut,border:tab==="profile"?"none":`1px solid ${G.bdr}`,fontWeight:700}}>✏️ Edit Profile</button>
        <button onClick={()=>setTab("password")} style={{...B(tab==="password"?G.gold:G.card),flex:1,fontSize:13,color:tab==="password"?"#fff":G.mut,border:tab==="password"?"none":`1px solid ${G.bdr}`,fontWeight:700}}>🔑 Password</button>
      </div>

      {tab==="profile"&&(
        <div style={K}>
          <div style={{fontWeight:700,color:G.gold,marginBottom:12}}>Personal Details</div>
          <FRow label="Full Name">
            <input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="Your full name"/>
          </FRow>
          <FRow label="Mobile (WhatsApp)">
            <input style={I} type="tel" value={f.mobile} onChange={e=>setF({...f,mobile:e.target.value})} placeholder="10-digit mobile" maxLength={10}/>
          </FRow>
          <FRow label="Blood Group">
            <select style={I} value={f.bloodGroup} onChange={e=>setF({...f,bloodGroup:e.target.value})}>
              <option value="">Select</option>
              {["A+","A-","B+","B-","AB+","AB-","O+","O-"].map(bg=><option key={bg} value={bg}>{bg}</option>)}
            </select>
          </FRow>
          <FRow label="Emergency Contact Name">
            <input style={I} value={f.emergencyName} onChange={e=>setF({...f,emergencyName:e.target.value})} placeholder="Parent/Spouse name"/>
          </FRow>
          <FRow label="Emergency Contact Number">
            <input style={I} type="tel" value={f.emergencyContact} onChange={e=>setF({...f,emergencyContact:e.target.value})} placeholder="10-digit number" maxLength={10}/>
          </FRow>
          <FRow label="Home Address">
            <textarea style={{...I,resize:"vertical",minHeight:70}} value={f.address} onChange={e=>setF({...f,address:e.target.value})} placeholder="Your home address"/>
          </FRow>
          <div style={{marginBottom:12}}>
            <label style={L}>Home Location (GPS Coordinates)</label>
            <LocationPicker
              value={{lat:f.homeLat,lng:f.homeLng,address:f.homeAddress}}
              onChange={loc=>setF({...f,homeLat:loc.lat,homeLng:loc.lng,homeAddress:loc.address||f.homeAddress})}
              ST={ST}
            />
          </div>
          <button onClick={saveProfile} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#fff",fontWeight:800}}>💾 Save Profile</button>
        </div>
      )}

      {tab==="password"&&(
        <div style={K}>
          <div style={{fontWeight:700,color:G.gold,marginBottom:12}}>Change Password</div>
          <FRow label="Current Password">
            <input type="password" style={I} value={cur} onChange={e=>setCur(e.target.value)} placeholder="Enter current password"/>
          </FRow>
          <FRow label="New Password">
            <input type="password" style={I} value={np} onChange={e=>setNp(e.target.value)} placeholder="Min 4 characters"/>
          </FRow>
          <FRow label="Confirm New Password">
            <input type="password" style={I} value={cp} onChange={e=>setCp(e.target.value)} placeholder="Re-enter new password" onKeyDown={e=>e.key==="Enter"&&savePwd()}/>
          </FRow>
          <div style={{background:"#fff6e8",border:`1px solid ${G.am}`,borderRadius:8,padding:"8px 12px",marginBottom:12,fontSize:12,color:G.am}}>
            ⚠️ After changing password you will be logged out automatically.
          </div>
          <button onClick={savePwd} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#fff",fontWeight:800}}>🔑 Change Password</button>
        </div>
      )}
    </div>
  );
}

function LateApproval({user,D,P,ST,AN,setSc}) {
  const [reason,setReason]=useState("");
  const rec=(D.attendance||[]).find(a=>a.userId===user.id&&a.date===tod());
  const mgr=(D.users||[]).find(u=>u.id===user.reportingTo);
  const submit=()=>{
    if(!reason.trim())return ST("Please provide a reason","error");
    if(!rec)return ST("No attendance record found today","error");
    addReg({id:gid(),userId:user.id,userName:user.name,teamId:user.teamId,date:tod(),checkIn:rec.checkIn.split("T")[1].substr(0,5),checkOut:"18:30",reason,type:"late_approval",lateBy:rec.lateBy,appliedOn:new Date().toISOString(),status:"pending"});
    if(mgr)AN(mgr.id,`${user.name} has requested late arrival approval for today (${rec.lateBy} mins late). Reason: ${reason}`,"info");
    ST("✅ Request sent to your manager!");setSc("home");
  };
  if(!rec||rec.lateBy<=0) return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:16}}>
        <button onClick={()=>setSc("home")} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800}}>Late Approval</h2>
      </div>
      <div style={{...K,textAlign:"center",padding:32}}><div style={{fontSize:40,marginBottom:12}}>✅</div><div style={{fontWeight:700}}>Not marked late today</div></div>
    </div>
  );
  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:16}}>
        <button onClick={()=>setSc("home")} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800,color:G.am}}>Late Approval Request</h2>
      </div>
      <div style={{...K,background:"#fff6e8",border:`1px solid ${G.am}`,marginBottom:12}}>
        <div style={{color:G.am,fontWeight:700}}>⚠️ Late by {rec.lateBy} minutes today</div>
        {mgr&&<div style={{fontSize:12,color:G.mut,marginTop:4}}>Request will go to: {mgr.name}</div>}
      </div>
      <div style={K}>
        <FRow label="Reason"><textarea style={{...I,resize:"vertical",minHeight:100}} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Why were you late?"/></FRow>
        <button onClick={submit} style={{...B(`linear-gradient(135deg,${G.am},${G.goldD})`),width:"100%",color:"#fff",fontWeight:800}}>Send Approval Request</button>
      </div>
    </div>
  );
}

function ChangePwd({user,D,P,ST,setSc}) {
  const [cur,setCur]=useState("");
  const [np,setNp]=useState("");
  const [cp,setCp]=useState("");
  const back=()=>setSc(["admin","hr"].includes(user?.role)?"dash":"home");
  const save=()=>{
    const u=(D.users||[]).find(x=>x.id===user.id);
    if(!u||cur!==u.password)return ST("Current password incorrect","error");
    if(np.length<6)return ST("Min 6 characters required","error");
    if(np!==cp)return ST("Passwords do not match","error");
    P({...D,users:D.users.map(x=>x.id===user.id?{...x,password:np}:x)});
    ST("✅ Password changed!");setTimeout(back,1500);
  };
  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:16}}>
        <button onClick={back} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800}}>🔑 Change Password</h2>
      </div>
      <div style={K}>
        <FRow label="Current Password"><input type="password" style={I} value={cur} onChange={e=>setCur(e.target.value)}/></FRow>
        <FRow label="New Password"><input type="password" style={I} value={np} onChange={e=>setNp(e.target.value)} placeholder="Min 6 characters"/></FRow>
        <FRow label="Confirm Password"><input type="password" style={I} value={cp} onChange={e=>setCp(e.target.value)} onKeyDown={e=>e.key==="Enter"&&save()}/></FRow>
        <button onClick={save} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#fff",fontWeight:800}}>Change Password</button>
      </div>
    </div>
  );
}

function ORG({D,vu}) {
  const roleColors={admin:G.rd,hr:G.pu,hod:G.bl,manager:G.navyL,staff:G.card2};
  const renderUser=(u,depth=0)=>{
    const reports=vu.filter(x=>x.reportingTo===u.id);
    const team=D.teams.find(t=>t.id===u.teamId);
    return (
      <div key={u.id} style={{marginLeft:depth*20,marginBottom:8}}>
        <div style={{background:G.card,border:`1px solid ${roleColors[u.role]||G.bdr}`,borderRadius:12,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:34,height:34,borderRadius:"50%",background:roleColors[u.role]||G.card2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>
            {u.role==="hr"?"🧑‍💼":u.role==="hod"?"🏛":u.role==="manager"?"👔":"👤"}
          </div>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:13}}>{u.name}</div>
            <div style={{fontSize:11,color:G.mut}}>{ROLE_LABELS[u.role]||u.role}{u.designation?` — ${u.designation}`:""}{team?` · ${team.name}`:""}</div>
          </div>
          <Chip bg={roleColors[u.role]||G.dim} label={ROLE_LABELS[u.role]||u.role} sm/>
        </div>
        {reports.length>0&&<div style={{marginLeft:10,paddingLeft:10,borderLeft:`2px solid ${G.bdr}`,marginTop:4}}>{reports.map(r=>renderUser(r,0))}</div>}
      </div>
    );
  };
  const topLevel=vu.filter(u=>!u.reportingTo||u.reportingTo==="");
  const admins=D.users.filter(u=>u.role==="admin");
  return (
    <>
      <div style={{...K,background:G.card2,border:`1px solid ${G.navyL}`}}><div style={{color:G.gold,fontWeight:700}}>🏛 Organisation Hierarchy</div></div>
      {admins.map(u=>renderUser(u,0))}
      {topLevel.filter(u=>u.role!=="admin").map(u=>renderUser(u,0))}
    </>
  );
}

function Register({setSc}) {
  // PERMANENTLY DISABLED - prevents Firebase data overwrite
  useEffect(()=>{setSc("login");},[]);
  return null;
}

function SuperAdmin({D,P,ST,setSc,logout}) {
  // Only accessible if logged in as super admin (ashishgupta151084@gmail.com)
  const isSuperAdmin=D.users?.find(u=>u.role==="admin")?.email==="ag@nucleusadvisors.in";
  if(!isSuperAdmin) return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{...K,textAlign:"center",padding:32}}>
        <div style={{fontSize:40}}>🚫</div>
        <div style={{fontWeight:700,marginTop:12}}>Access Denied</div>
        <button onClick={()=>setSc("dash")} style={{...B(G.gold),color:"#fff",marginTop:16}}>← Back</button>
      </div>
    </div>
  );
  const plan=D.firmPlan||"trial";
  const trial=D.firmTrial?new Date(D.firmTrial):null;
  const daysLeft=trial?Math.max(0,Math.ceil((trial-new Date())/(1000*60*60*24))):0;
  return (
    <div style={{maxWidth:500,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:16}}>
        <button onClick={()=>setSc("dash")} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800,color:G.gold}}>Firm Settings</h2>
      </div>
      {SAAS_MODE&&<div style={K}>
        <div style={{fontWeight:700,color:G.gold,marginBottom:12}}>📋 Subscription</div>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
          <span style={{color:G.mut}}>Current Plan</span>
          <Chip bg={plan==="trial"?G.am:G.gr} label={PLANS[plan]?.name||plan} sm/>
        </div>
        {plan==="trial"&&(
          <div style={{background:"#fff6e8",border:`1px solid ${G.am}`,borderRadius:10,padding:12,marginBottom:12}}>
            <div style={{color:G.am,fontWeight:700}}>⏰ Trial: {daysLeft} days remaining</div>
            <div style={{fontSize:12,color:G.mut,marginTop:4}}>Upgrade to continue after trial ends</div>
          </div>
        )}
        <div style={{fontWeight:700,color:G.gold,marginBottom:8,marginTop:4}}>Available Plans</div>
        {Object.entries(PLANS).filter(([k])=>k!=="trial").map(([key,pl])=>(
          <div key={key} style={{...K,padding:12,border:`1px solid ${plan===key?G.gold:G.bdr}`,marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontWeight:700}}>{pl.name}</div>
                <div style={{fontSize:12,color:G.mut}}>Up to {pl.maxUsers} staff · ₹{pl.price}/month</div>
              </div>
              {plan===key
                ?<Chip bg={G.gr} label="Current" sm/>
                :<button onClick={()=>{ST(`Contact ag@nucleusadvisors.in to upgrade to ${pl.name}`,"info");}} style={{...B(G.gold),fontSize:11,padding:"5px 10px",color:"#fff"}}>Upgrade</button>
              }
            </div>
          </div>
        ))}
      </div>}
      <div style={K}>
        <div style={{fontWeight:700,color:G.gold,marginBottom:12}}>🏢 Firm Details</div>
        <div style={{fontSize:13,color:G.mut}}>Firm: <span style={{color:G.txt,fontWeight:700}}>{D.companyName}</span></div>
        <div style={{fontSize:13,color:G.mut,marginTop:4}}>Staff: <span style={{color:G.txt,fontWeight:700}}>{(D.users||[]).filter(u=>u.role!=="admin").length}{SAAS_MODE?` / ${PLANS[plan]?.maxUsers||10}`:""}</span></div>
        <div style={{fontSize:13,color:G.mut,marginTop:4}}>City: <span style={{color:G.txt}}>{D.city||"—"}</span></div>
      </div>
    </div>
  );
}


function BR({D,P,ST}) {
  const [sa,setSa]=useState(false);
  const [editB,setEditB]=useState(null);
  const emptyBF={name:"",headId:"",city:""};
  const [f,setF]=useState(emptyBF);
  const save=()=>{
    if(!f.name)return ST("Branch name required","error");
    const branches=D.branches||[];
    if(editB){P({...D,branches:branches.map(b=>b.id===editB?{...b,...f}:b)});ST("✅ Updated!");}
    else{P({...D,branches:[...branches,{...f,id:gid()}]});ST("✅ Branch added!");}
    setSa(false);setEditB(null);setF(emptyBF);
  };
  return (
    <>
      <div style={{...K,background:G.card2,border:`1px solid ${G.navyL}`}}>
        <div style={{color:G.gold,fontWeight:700}}>🏢 Branch Management</div>
        <div style={{fontSize:12,color:G.dim,marginTop:3}}>Manage your firm's branches. Assign offices and branch heads.</div>
      </div>
      <button onClick={()=>{setSa(!sa);if(sa){setEditB(null);setF(emptyBF);}}} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:10,color:"#fff",fontWeight:800}}>{sa?"✕ Cancel":"+ Add Branch"}</button>
      {sa&&(
        <div style={{...K,marginBottom:10}}>
          <div style={{fontWeight:800,color:editB?G.bl:G.gold,marginBottom:10}}>{editB?"✏️ Edit Branch":"New Branch"}</div>
          <FRow label="Branch Name"><input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="e.g. Jaipur Branch"/></FRow>
          <FRow label="City"><input style={I} value={f.city||""} onChange={e=>setF({...f,city:e.target.value})} placeholder="e.g. Jaipur"/></FRow>
          <FRow label="Branch Head">
            <select style={I} value={f.headId||""} onChange={e=>setF({...f,headId:e.target.value})}>
              <option value="">Select Branch Head</option>
              {(D.users||[]).filter(u=>["manager","hod","hr","branch_head"].includes(u.role)).map(u=>(
                <option key={u.id} value={u.id}>{u.name} ({ROLE_LABELS[u.role]||u.role})</option>
              ))}
            </select>
          </FRow>
          <div style={{display:"flex",gap:8}}>
            <button onClick={save} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),flex:2,color:"#fff",fontWeight:800}}>{editB?"💾 Save":"Add Branch"}</button>
            <button onClick={()=>{setSa(false);setEditB(null);setF(emptyBF);}} style={{...B(G.dim),flex:1}}>Cancel</button>
          </div>
        </div>
      )}
      {(D.branches||[]).length===0&&!sa&&<div style={{textAlign:"center",color:G.dim,padding:30}}>No branches yet. Add your first branch!</div>}
      {(D.branches||[]).map(b=>{
        const head=(D.users||[]).find(u=>u.id===b.headId);
        const offices=(D.offices||[]).filter(o=>o.branchId===b.id);
        const staff=(D.users||[]).filter(u=>(u.officeIds||[]).some(oid=>offices.map(o=>o.id).includes(oid)));
        return(
          <div key={b.id} style={K}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <div style={{fontWeight:800,fontSize:14}}>🏢 {b.name}</div>
                {b.city&&<div style={{fontSize:12,color:G.mut,marginTop:2}}>📍 {b.city}</div>}
                {head&&<div style={{fontSize:12,color:G.mut,marginTop:2}}>👤 Head: <span style={{color:G.gold}}>{head.name}</span></div>}
                <div style={{fontSize:12,color:G.dim,marginTop:2}}>{offices.length} office(s) · {staff.length} staff</div>
              </div>
              <div style={{display:"flex",gap:6}}>
                <button onClick={()=>{setF({name:b.name,headId:b.headId||"",city:b.city||""});setEditB(b.id);setSa(true);}} style={{...B(G.bl),fontSize:11,padding:"5px 9px"}}>✏️</button>
                <button onClick={()=>{if(!confirm("Delete branch?"))return;P({...D,branches:(D.branches||[]).filter(x=>x.id!==b.id)});}} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:11,padding:"5px 9px"}}>✕</button>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}


function BK({D,P,ST}) {
  const [backups,setBackups]=useState([]);
  const [loading,setLoading]=useState(true);
  const [restoring,setRestoring]=useState(null);

  const loadBackups=()=>{
    setLoading(true);
    getBackups()
      .then(b=>{
        console.log("Backups loaded:", b.length, b);
        setBackups(b);
        setLoading(false);
      })
      .catch(e=>{
        console.error("Failed to load backups:", e);
        ST("Could not load backups: "+e.message,"error");
        setLoading(false);
      });
  };

  useEffect(()=>{loadBackups();},[]);

  const doBackup=async()=>{
    ST("💾 Creating backup...");
    try{
      await saveBackup(D);
      await loadBackups();
      ST("✅ Backup created! "+D.users?.length+" users saved.");
    }catch(e){
      ST("Backup failed: "+e.message,"error");
    }
  };

  const doRestore=async(b)=>{
    if(!confirm(`Restore backup from ${new Date(b.backedUpAt).toLocaleString("en-IN")}?\n\n${b.userCount||b.users?.length||0} users will be restored.\n\nClick OK to confirm.`))return;
    setRestoring(b.id);
    try{
      const cfg=await restoreBackup(b.id);
      P({...D,...cfg});
      ST("✅ Restored successfully! Reloading...");
      setTimeout(()=>window.location.reload(),2000);
    }catch(e){
      ST("Restore failed: "+e.message,"error");
    }
    setRestoring(null);
  };

  return (
    <>
      <div style={{...K,background:"#e9f7ef",border:`1px solid ${G.gr}`}}>
        <div style={{color:G.gr,fontWeight:800,fontSize:14}}>💾 Backup & Restore</div>
        <div style={{color:G.dim,fontSize:12,marginTop:4}}>Auto-backup runs daily. You can also create manual backups anytime and restore to any previous backup.</div>
      </div>

      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <button onClick={doBackup} style={{...B(`linear-gradient(135deg,${G.gr},#059669)`),flex:2,fontWeight:800}}>💾 Backup Now</button>
        <button onClick={loadBackups} style={{...B(G.navyL),flex:1,border:`1px solid ${G.bdr}`,fontSize:12}}>🔄 Refresh</button>
      </div>

      <div style={{color:G.mut,fontSize:11,fontWeight:700,textTransform:"uppercase",marginBottom:8}}>
        {loading?"Loading...":backups.length===0?"No backups found":`${backups.length} backups available`}
      </div>

      {backups.map(b=>(
        <div key={b.id} style={{...K,border:`1px solid ${G.bdr}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:12,color:G.gold}}>
                📅 {new Date(b.backedUpAt).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})} {new Date(b.backedUpAt).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})}
              </div>
              <div style={{fontSize:11,color:G.mut,marginTop:2}}>
                👥 {b.userCount||b.users?.length||0} users · 🏢 {b.offices?.length||0} offices · 🏷 {b.teams?.length||0} teams
              </div>
            </div>
            <button
              onClick={()=>doRestore(b)}
              disabled={!!restoring}
              style={{...B(restoring===b.id?G.dim:G.am),color:"#fff",fontSize:11,fontWeight:800,padding:"7px 12px",flexShrink:0}}
            >
              {restoring===b.id?"⏳ Restoring...":"↩️ Restore"}
            </button>
          </div>
        </div>
      ))}

      {!loading&&backups.length===0&&(
        <div style={{textAlign:"center",padding:32,color:G.dim}}>
          <div style={{fontSize:48,marginBottom:8}}>💾</div>
          <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>No backups yet</div>
          <div style={{fontSize:12}}>Click "Backup Now" to create your first backup</div>
        </div>
      )}
    </>
  );
}

function RST({D,P,ST,logout}) {
  const [pwd,setPwd]=useState("");
  const [confirm,setConfirm]=useState("");
  const [step,setStep]=useState("menu");
  const ADMIN_PWD="Nucleus123#";
  const verify=(next)=>{if(pwd!==ADMIN_PWD)return ST("Incorrect admin password","error");setStep(next);setPwd("");};
  const resetData=()=>{
    if(confirm!=="RESET DATA")return ST('Type RESET DATA to confirm',"error");
    P({...D,attendance:[],leaves:[],regularizations:[],liveLocations:{},notifications:[]});
    ST("✅ Data cleared!");setStep("done");setConfirm("");
  };
  const resetFull=()=>{
    if(confirm!=="FACTORY RESET")return ST('Type FACTORY RESET to confirm',"error");
    P({...D,users:[D.users.find(u=>u.role==="admin")].filter(Boolean),offices:[],teams:[],attendance:[],leaves:[],regularizations:[],liveLocations:{},notifications:[]});
    ST("✅ Factory reset done!");setStep("done");setConfirm("");
  };
  const resetUsers=()=>{
    if(confirm!=="RESET USERS")return ST('Type RESET USERS to confirm',"error");
    P({...D,users:D.users.filter(u=>u.role==="admin"),attendance:[],leaves:[],regularizations:[],liveLocations:{},notifications:[]});
    ST("✅ Staff removed!");setStep("done");setConfirm("");
  };
  if(step==="done") return (
    <div style={{maxWidth:440,margin:"0 auto"}}>
      <div style={{...K,textAlign:"center",padding:32,background:"#e9f7ef",border:`1px solid ${G.gr}`}}>
        <div style={{fontSize:48,marginBottom:12}}>✅</div>
        <div style={{fontWeight:800,fontSize:18,color:G.gr,marginBottom:16}}>Reset Complete</div>
        <button onClick={()=>{setStep("menu");logout();}} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#fff",fontWeight:800}}>Logout & Restart</button>
      </div>
    </div>
  );
  return (
    <div style={{maxWidth:440,margin:"0 auto"}}>
      <div style={{...K,background:"#fff6e8",border:`1px solid ${G.rd}`,marginBottom:16}}><div style={{color:G.rd,fontWeight:800}}>⚠️ Danger Zone — All resets are permanent</div></div>
      {step==="menu"&&(<>
        <div style={K}><div style={{fontWeight:800,color:G.am,marginBottom:6}}>🗑 Level 1 — Reset All Data</div><div style={{fontSize:12,color:G.mut,marginBottom:8}}>Deletes attendance, leaves, locations. Keeps users.</div><button onClick={()=>setStep("pwd_data")} style={{...B(G.am),width:"100%"}}>Proceed →</button></div>
        <div style={K}><div style={{fontWeight:800,color:G.rd,marginBottom:6}}>🔄 Level 2 — Factory Reset</div><div style={{fontSize:12,color:G.mut,marginBottom:8}}>Wipes everything except admin.</div><button onClick={()=>setStep("pwd_full")} style={{...B(G.rd),width:"100%"}}>Proceed →</button></div>
        <div style={K}><div style={{fontWeight:800,color:G.pu,marginBottom:6}}>👥 Level 3 — Reset Staff</div><div style={{fontSize:12,color:G.mut,marginBottom:8}}>Removes all staff. Keeps offices & teams.</div><button onClick={()=>setStep("pwd_users")} style={{...B(G.pu),width:"100%"}}>Proceed →</button></div>
      </>)}
      {(step==="pwd_data"||step==="pwd_full"||step==="pwd_users")&&(<div style={K}><button onClick={()=>setStep("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:12}}>← Back</button><FRow label="Admin Password"><input type="password" style={I} value={pwd} onChange={e=>setPwd(e.target.value)}/></FRow><button onClick={()=>verify(step==="pwd_data"?"confirm_data":step==="pwd_full"?"confirm_full":"confirm_users")} style={{...B(step==="pwd_full"?G.rd:step==="pwd_users"?G.pu:G.am),width:"100%",fontWeight:700}}>Verify →</button></div>)}
      {step==="confirm_data"&&(<div style={{...K,border:`1px solid ${G.am}`}}><button onClick={()=>setStep("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:12}}>← Back</button><FRow label="Type: RESET DATA"><input style={I} value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="RESET DATA"/></FRow><button onClick={resetData} style={{...B(G.am),width:"100%",fontWeight:800}}>Confirm</button></div>)}
      {step==="confirm_full"&&(<div style={{...K,border:`1px solid ${G.rd}`}}><button onClick={()=>setStep("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:12}}>← Back</button><FRow label="Type: FACTORY RESET"><input style={I} value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="FACTORY RESET"/></FRow><button onClick={resetFull} style={{...B(G.rd),width:"100%",fontWeight:800}}>Confirm</button></div>)}
      {step==="confirm_users"&&(<div style={{...K,border:`1px solid ${G.pu}`}}><button onClick={()=>setStep("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:12}}>← Back</button><FRow label="Type: RESET USERS"><input style={I} value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="RESET USERS"/></FRow><button onClick={resetUsers} style={{...B(G.pu),width:"100%",fontWeight:800}}>Confirm</button></div>)}
    </div>
  );
}
