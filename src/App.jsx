import { useState, useEffect, useRef, useCallback } from "react";
import {
  db, getConfig, setConfig, onConfig,
  addAttendance, updateAttendance, onAttendance,
  addLeave, updateLeave, deleteLeave, onLeaves,
  addReg, updateReg, onRegs,
  updateLiveLocation, onLiveLocations,
  addNotification, updateNotification, onNotifications
} from "./firebase";

// ── OTP utility ──────────────────────────────────────
const generateOTP=()=>Math.floor(100000+Math.random()*900000).toString();
const otpStore={}; // in-memory OTP store {email: {otp, expires}}
const sendOTP=async(email)=>{
  const otp=generateOTP();
  otpStore[email]={otp,expires:Date.now()+10*60*1000}; // 10 min expiry
  await sendEmail(email,"Nucleus HRMS — Password Reset OTP",
    `Your OTP for password reset is: ${otp}\n\nThis OTP is valid for 10 minutes.\n\nIf you did not request this, please ignore.`
  );
  return otp;
};
const verifyOTP=(email,otp)=>{
  const stored=otpStore[email];
  if(!stored)return false;
  if(Date.now()>stored.expires)return false;
  return stored.otp===otp;
};

// ── Email notification utility (EmailJS - free tier) ──────────────
const sendEmail=async(to,subject,body)=>{
  try{
    // Using EmailJS public API - configure with your EmailJS account
    const payload={
      service_id:"service_nucleus",
      template_id:"template_nucleus",
      user_id:"YOUR_EMAILJS_PUBLIC_KEY", // Replace after EmailJS setup
      template_params:{to_email:to,subject,message:body,from_name:"Nucleus HRMS"}
    };
    await fetch("https://api.emailjs.com/api/v1.0/email/send",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    });
    console.log("Email sent to:",to);
  }catch(e){console.warn("Email not sent:",e.message);}
};

// ── Notification + Email helper ───────────────────────────────────
const notifyUser=async(uid,msg,type,email,subject)=>{
  // In-app notification (always)
  const rec={id:Math.random().toString(36).substr(2,9),userId:uid,msg,type,ts:new Date().toISOString(),read:false};
  await addNotification(rec);
  // Email notification (if email provided)
  if(email&&subject){
    await sendEmail(email,subject,msg);
  }
};

const gid=()=>Math.random().toString(36).substr(2,9);
const tod=()=>new Date().toISOString().split("T")[0];
const fT=(d)=>new Date(d).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const fD=(d)=>new Date(d).toLocaleDateString([],{day:"2-digit",month:"short",year:"numeric"});
const dist=(a,b,c,d)=>{const R=6371000,dL=((c-a)*Math.PI)/180,dl=((d-b)*Math.PI)/180,x=Math.sin(dL/2)**2+Math.cos((a*Math.PI)/180)*Math.cos((c*Math.PI)/180)*Math.sin(dl/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));};
const lateBy=(ci,ss)=>{const [h,m]=ss.split(":").map(Number),s=new Date(ci);s.setHours(h,m,0,0);return Math.max(0,Math.round((new Date(ci)-s)/60000));};
const GRACE_MINS=15; // Grace period in minutes
const countMonthlyGrace=(attendance,userId,month)=>{
  return (attendance||[]).filter(a=>
    a.userId===userId &&
    a.date&&a.date.startsWith(month) &&
    a.graceUsed===true
  ).length;
};
const wMin=(a,b)=>b?Math.round((new Date(b)-new Date(a))/60000):0;
const wHr=(a,b)=>{const m=wMin(a,b);return m?`${Math.floor(m/60)}h${m%60}m`:null;};
const wDM=(y,m)=>{let c=0;const d=new Date(y,m-1,1);while(d.getMonth()===m-1){if(d.getDay()&&d.getDay()<6)c++;d.setDate(d.getDate()+1);}return c;};
const isHL=(ds,hs)=>(hs||[]).some(h=>h.date===ds);
const isDayOff=(ds,hs,weeklyOff)=>isWE(ds,weeklyOff)||isHL(ds,hs);
const getSatWeek=(d)=>{
  // Which occurrence of Saturday in the month (1st,2nd,3rd,4th,5th)
  return Math.ceil(d.getDate()/7);
};
const isWE=(ds,weeklyOff="sun_sat")=>{
  const d=new Date(ds);
  const day=d.getDay();
  if(weeklyOff==="sun_sat") return day===0||day===6;
  if(day===0) return true; // Sunday always off for all options below
  if(day!==6) return false; // Not Saturday, not off
  const wk=getSatWeek(d);
  if(weeklyOff==="sun") return false;               // Only Sunday
  if(weeklyOff==="sun_1stsat") return wk===1;
  if(weeklyOff==="sun_2ndsat") return wk===2;
  if(weeklyOff==="sun_3rdsat") return wk===3;
  if(weeklyOff==="sun_4thsat") return wk===4;
  if(weeklyOff==="sun_5thsat") return wk===5;
  if(weeklyOff==="sun_altsat") return wk%2===1;     // 1st & 3rd Sat
  if(weeklyOff==="sun_1st3rdsat") return wk===1||wk===3;
  if(weeklyOff==="sun_2nd4thsat") return wk===2||wk===4;
  return false;
};
const WEEKLY_OFF_OPTIONS=[
  {value:"sun",label:"Sunday Only"},
  {value:"sun_sat",label:"Saturday & Sunday (Full week off)"},
  {value:"sun_1stsat",label:"Sunday + 1st Saturday"},
  {value:"sun_2ndsat",label:"Sunday + 2nd Saturday"},
  {value:"sun_3rdsat",label:"Sunday + 3rd Saturday"},
  {value:"sun_4thsat",label:"Sunday + 4th Saturday"},
  {value:"sun_5thsat",label:"Sunday + 5th Saturday"},
  {value:"sun_altsat",label:"Sunday + Alternate Saturdays (1st & 3rd)"},
  {value:"sun_1st3rdsat",label:"Sunday + 1st & 3rd Saturday"},
  {value:"sun_2nd4thsat",label:"Sunday + 2nd & 4th Saturday"},
];
const ld=(k,f)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):f;}catch{return f;}};
const sv=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch{}};

const DP_EMP={casual:12,sick:12,compoff:6,halfday:24,early:12};
// ICAI New Scheme 2024: 12 leaves per year, no casual/compoff for articled
const DP_AA={
  sick:12,        // 12 days per year as per ICAI new scheme
  casual:0,       // Not allowed for articled
  compoff:0,      // Not allowed for articled
  halfday:0,      // Not allowed (ICAI requires full day)
  early:0,        // Not allowed
  studyleave:12,  // Allowed for exam prep (with principal consent)
};
const DP={employee:DP_EMP,articled:DP_AA};
// ICAI rules
const ICAI_RULES={
  maxLeavesPerYear:12,
  workingHoursStart:"09:00",
  workingHoursEnd:"19:00",
  weeklyHours:35,
  graceAllowed:false, // Stricter for articled
  excessLeaveAction:"extend_articleship",
};
// Admin-only initial config — written to Firebase on first run
const ADMIN_USER={id:"u1",name:"Ashish Gupta",email:"ag@nucleusadvisors.in",password:"Nucleus123#",role:"admin",teamId:null,officeIds:[],customShift:null,managedTeams:[],weeklyOff:"sun_sat",firstLogin:false};
// Role hierarchy: admin > hr > hod > manager > staff
const ROLES=["admin","hr","hod","manager","staff"];
const ROLE_LABELS={admin:"Admin",hr:"HR Manager",hod:"HOD",manager:"Manager",staff:"Staff"};
const INIT_CONFIG={
  companyName:"Nucleus HRMS",
  offices:[],
  teams:[],
  users:[ADMIN_USER],
  leavePolicy:DP,
  holidays:[
    {id:"h1",date:"2026-01-26",name:"Republic Day"},
    {id:"h2",date:"2026-08-15",name:"Independence Day"},
    {id:"h3",date:"2026-10-02",name:"Gandhi Jayanti"},
    {id:"h4",date:"2026-11-08",name:"Diwali"},
    {id:"h5",date:"2026-12-25",name:"Christmas"},
  ],
};
// Runtime state (never stored in Firebase)
const EMPTY_STATE={attendance:[],leaves:[],liveLocations:{},notifications:[],regularizations:[],loading:false};

// Nucleus Advisors brand theme — navy + red + white
const G={
  bg:"#f0f4f8",        // Light grey background
  card:"#ffffff",      // White cards
  card2:"#f8fafc",     // Slightly off-white
  bdr:"#dce4ef",       // Light border
  navy:"#1a2a5e",      // Primary navy (brand)
  navyL:"#2a3f8f",     // Lighter navy
  navyD:"#0f1a3c",     // Darker navy
  navyBg:"#eef1f9",    // Navy tint background
  red:"#cc2222",       // Brand red (arrow in logo)
  redL:"#e53333",      // Lighter red
  txt:"#1a2a5e",       // Navy text
  mut:"#4a5a80",       // Muted navy
  dim:"#8a9bb5",       // Dimmed
  gr:"#16a34a",        // Green
  rd:"#dc2626",        // Error red
  am:"#d97706",        // Amber
  bl:"#2563eb",        // Blue
  pu:"#7c3aed",        // Purple
  gold:"#1a2a5e",      // Use navy as "gold" (primary accent)
  goldL:"#2a3f8f",
  goldD:"#0f1a3c",
};
const B=(bg,x={})=>({background:bg,color:bg==="#ffffff"||bg==="#f8fafc"||bg==="#fff"?"#1a2a5e":"#fff",border:"none",borderRadius:10,padding:"12px 18px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",...x});
const I={width:"100%",padding:"11px 14px",borderRadius:10,border:`1px solid ${G.bdr}`,background:"#fff",color:G.txt,fontSize:14,fontFamily:"inherit",boxSizing:"border-box"};
const L={fontSize:11,color:G.mut,marginBottom:5,display:"block",fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase"};
const K={background:G.card,border:`1px solid ${G.bdr}`,borderRadius:16,padding:18,marginBottom:12,boxShadow:"0 1px 4px rgba(26,42,94,0.06)"};

const Chip=({bg,label,sm})=>(
  <span style={{background:bg,color:"#fff",fontSize:sm?10:11,fontWeight:700,padding:sm?"2px 7px":"3px 10px",borderRadius:20}}>{label}</span>
);
const FRow=({label,children})=>(
  <div style={{marginBottom:12}}><label style={L}>{label}</label>{children}</div>
);


const Logo=({s=40,h})=>(
  <div style={{display:"flex",alignItems:"center",gap:6}}>
    <svg width={h||s} height={h||s} viewBox="0 0 40 20" fill="none">
      <text x="0" y="16" fontFamily="Arial Black,sans-serif" fontSize="14" fontWeight="900" fill="#1B2F5E">N</text>
      <line x1="11" y1="18" x2="11" y2="2" stroke="#cc2222" strokeWidth="3" strokeLinecap="round"/>
      <polygon points="11,0 7,8 15,8" fill="#cc2222"/>
      <text x="14" y="16" fontFamily="Arial Black,sans-serif" fontSize="14" fontWeight="900" fill="#1B2F5E">ucleus</text>
    </svg>
    <span style={{fontSize:9,fontWeight:800,color:"#1B2F5E",letterSpacing:"0.15em",textTransform:"uppercase",display:"block",marginTop:2}}>ADVISORS</span>
  </div>
);

export default function App() {
  const [D,setD]=useState({...INIT_CONFIG,...EMPTY_STATE});

  const [cu,setCu]=useState(()=>ld("nau5",null));
  const [sc,setSc]=useState("login");
  const [toast,setToast]=useState(null);

  // ── Load config from Firebase on mount ──
  useEffect(()=>{
    const unsub=onConfig(cfg=>{
      if(cfg&&cfg.users&&cfg.users.length>0){
        setD(prev=>({...prev,...cfg,loading:false}));
      } else {
        setConfig(INIT_CONFIG).catch(()=>{});
      }
    });
    return unsub;
  },[]);

  // ── Real-time attendance ──
  useEffect(()=>{
    const unsub=onAttendance(recs=>setD(prev=>({...prev,attendance:recs})));
    return unsub;
  },[]);

  // ── Real-time leaves ──
  useEffect(()=>{
    const unsub=onLeaves(recs=>setD(prev=>({...prev,leaves:recs})));
    return unsub;
  },[]);

  // ── Real-time regularizations ──
  useEffect(()=>{
    const unsub=onRegs(recs=>setD(prev=>({...prev,regularizations:recs})));
    return unsub;
  },[]);

  // ── Real-time live locations ──
  useEffect(()=>{
    const unsub=onLiveLocations(locs=>setD(prev=>({...prev,liveLocations:locs})));
    return unsub;
  },[]);

  // ── Real-time notifications for current user ──
  useEffect(()=>{
    if(!cu)return;
    const unsub=onNotifications(cu.id,notifs=>setD(prev=>({...prev,notifications:notifs})));
    return unsub;
  },[cu?.id]);

  // ── Auto escalation check (runs on load) ──
  useEffect(()=>{
    if(!cu||cu.role!=="admin"&&cu.role!=="hr")return;
    const checkEscalations=()=>{
      const now=new Date();
      const pending=(D.leaves||[]).filter(l=>l.status==="pending");
      pending.forEach(l=>{
        const applied=new Date(l.appliedOn);
        const daysPending=Math.floor((now-applied)/(1000*60*60*24));
        // Escalate every 3 days
        if(daysPending>0&&daysPending%3===0){
          const lastEscalated=l.lastEscalated?new Date(l.lastEscalated):null;
          const shouldEscalate=!lastEscalated||Math.floor((now-lastEscalated)/(1000*60*60*24))>=3;
          if(shouldEscalate){
            const mgr=D.users.find(u=>u.id===l.reportingTo||u.role==="hr");
            if(mgr){
              const msg=`⚠️ ESCALATION: ${l.userName}'s ${l.type} leave request (${l.from}) has been pending for ${daysPending} days. Please review.`;
              addNotification({id:gid(),userId:mgr.id,msg,type:"escalation",ts:now.toISOString(),read:false});
              if(mgr.email)sendEmail(mgr.email,"Pending Leave Escalation — Nucleus HRMS",msg);
              updateLeave(l.id,{lastEscalated:now.toISOString(),escalationCount:(l.escalationCount||0)+1});
            }
          }
        }
      });
      // Also check pending regularizations
      const pendingRegs=(D.regularizations||[]).filter(r=>r.status==="pending");
      pendingRegs.forEach(r=>{
        const applied=new Date(r.appliedOn);
        const daysPending=Math.floor((now-applied)/(1000*60*60*24));
        if(daysPending>0&&daysPending%3===0){
          const mgr=D.users.find(u=>u.id===r.reportingTo||u.role==="hr");
          if(mgr){
            const msg=`⚠️ ESCALATION: ${r.userName}'s ${r.type==="late_approval"?"late arrival approval":"regularization"} for ${r.date} pending for ${daysPending} days.`;
            addNotification({id:gid(),userId:mgr.id,msg,type:"escalation",ts:now.toISOString(),read:false});
          }
        }
      });
    };
    // Run on load and every hour
    checkEscalations();
    const interval=setInterval(checkEscalations,60*60*1000);
    return()=>clearInterval(interval);
  },[cu?.id,D.leaves,D.regularizations]);

  // ── GPS tracking for staff/manager ──
  useEffect(()=>{
    if(!cu||cu.role==="admin")return;
    const w=navigator.geolocation?.watchPosition(p=>{
      const loc={lat:p.coords.latitude,lng:p.coords.longitude,ac:Math.round(p.coords.accuracy),ts:new Date().toISOString()};
      updateLiveLocation(cu.id,loc);
    },null,{enableHighAccuracy:true,maximumAge:30000});
    return()=>navigator.geolocation?.clearWatch(w);
  },[cu?.id]);

  const ST=(msg,type="success")=>{setToast({msg,type});setTimeout(()=>setToast(null),3000);};

  // ── Persist: saves config fields (users, offices, teams, policy, holidays) to Firebase ──
  const P=useCallback(nd=>{
    setD(nd);
    // Only sync config fields, not transactional data (handled separately)
    const {users,offices,teams,leavePolicy,holidays,companyName}=nd;
    setConfig({users,offices,teams,leavePolicy,holidays,companyName});
  },[]);

  // ── Notification + Email helper ──
  const AN=useCallback((uid,msg,type="info",emailSubject=null)=>{
    const rec={id:gid(),userId:uid,msg,type,ts:new Date().toISOString(),read:false};
    addNotification(rec);
    // Send email if user has email
    const targetUser=(D.users||[]).find(u=>u.id===uid);
    if(targetUser?.email&&emailSubject){
      sendEmail(targetUser.email,emailSubject,msg);
    }
  },[D.users]);

  useEffect(()=>{
    if(cu){
      // Check if first login
      const freshUser=(D.users||[]).find(u=>u.id===cu.id);
      if(freshUser?.firstLogin===true){setSc("firstlogin");return;}
      setSc(["admin","hr","hod","manager"].includes(cu.role)?cu.role==="admin"||cu.role==="hr"?"dash":"home":"home");
    } else {
      setSc("login");
    }
  },[cu]);

  const login=(e,p)=>{
    const u=(D.users||[]).find(u=>u.email===e&&u.password===p);
    if(!u)return ST("Invalid credentials","error");
    setCu(u);sv("nau5",u);
  };
  const logout=()=>{
    setCu(null);
    sv("nau5",null);
    setSc("login");
    // Don't reset D — keeps config loaded so login screen works instantly
  };
  const unread=(D.notifications||[]).filter(n=>n.userId===cu?.id&&!n.read).length;


  const props={user:cu,D,P,ST,AN,logout,setSc,unread};
  return (
    <div style={{fontFamily:"'Nunito',sans-serif",background:G.bg,minHeight:"100vh",color:G.txt}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');*{box-sizing:border-box}body{background:#f0f4f8}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:#dce4ef;border-radius:3px}input::placeholder,textarea::placeholder{color:#8a9bb5}select option{background:#fff;color:#1a2a5e}@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
      {sc==="login"&&<Login login={login} name={D.companyName} D={D} P={P} ST={ST} logout={logout}/>}
      {sc==="home"&&<Home {...props}/>}
      {sc==="hist"&&<Hist {...props}/>}
      {sc==="lv"&&<Lv {...props}/>}
      {sc==="notif"&&<Notif {...props}/>}
      {sc==="reg"&&<Reg {...props}/>}
      {sc==="lateapproval"&&<LateApproval {...props}/>}
      {sc==="changepwd"&&<ChangePwd {...props} logout={logout}/>}
      {sc==="firstlogin"&&<FirstLogin {...props} logout={logout}/>}
      {sc==="teamdash"&&<Dash {...props}/>}
      {sc==="dash"&&<Dash {...props}/>}
      {toast&&<Msg t={toast}/>}
    </div>
  );
}

function Login({login,name}) {
  const [e,setE]=useState("");
  const [p,setP]=useState("");
  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,background:"linear-gradient(135deg,#eef1f9,#f8fafc)"}}>
      <div style={{width:"100%",maxWidth:400}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{display:"flex",justifyContent:"center",marginBottom:12}}>
            <Logo s={40} full={true}/>
          </div>
          <div style={{fontSize:12,color:G.mut,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.12em"}}>HR Management System</div>
          <div style={{width:60,height:3,background:"#cc2222",margin:"10px auto 0",borderRadius:2}}/>
        </div>
        <div style={{background:"#fff",borderRadius:20,padding:24,marginBottom:12,boxShadow:"0 4px 24px rgba(26,47,90,0.12)",border:`1px solid ${G.bdr}`}}>
          <FRow label="Email"><input style={I} type="email" value={e} onChange={x=>setE(x.target.value)} placeholder="you@nucleusadvisors.in"/></FRow>
          <FRow label="Password"><input style={I} type="password" value={p} onChange={x=>setP(x.target.value)} placeholder="••••••••" onKeyDown={x=>x.key==="Enter"&&login(e,p)}/></FRow>
          <button onClick={()=>login(e,p)} style={{...B(`linear-gradient(135deg,${G.navy},${G.navyL})`),width:"100%",fontSize:15,padding:14,color:"#fff",fontWeight:800,borderRadius:12}}>Sign In →</button>
          <div style={{textAlign:"center",marginTop:10}}>
            <span onClick={()=>setShowForgot(true)} style={{fontSize:12,color:G.bl,cursor:"pointer",textDecoration:"underline"}}>Forgot Password?</span>
          </div>
        </div>
        {showForgot&&(
          <div style={{...K,marginTop:12,padding:16}}>
            <div style={{fontWeight:700,color:G.gold,marginBottom:8}}>📧 Reset via Email OTP</div>
            <ChangePwd user={{email:e}} D={D} P={P} ST={ST} setSc={()=>setShowForgot(false)} logout={()=>setShowForgot(false)}/>
          </div>
        )}
        <div style={{textAlign:"center",marginTop:8}}>
          <div style={{fontSize:11,color:G.mut}}>Developed by <span style={{color:G.navy,fontWeight:700}}>Ashish Gupta</span></div>
          <div style={{fontSize:10,color:G.dim,marginTop:4}}>© {new Date().getFullYear()} Nucleus Advisors. All rights reserved.</div>
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

function Home({user,D,P,ST,AN,logout,setSc,unread}) {
  const [step,setStep]=useState("idle");
  const [selfie,setSelfie]=useState(null);
  const [gps,setGps]=useState(null);
  const [office,setOffice]=useState(null);
  const [locErr,setLocErr]=useState(null);
  const [wfh,setWfh]=useState(false);
  const rec=D.attendance.find(a=>a.userId===user.id&&a.date===tod());
  const tm=D.teams.find(t=>t.id===user.teamId);
  const sh=user.customShift||(tm?{shiftStart:tm.shiftStart,shiftEnd:tm.shiftEnd}:null);
  const pl=(D.leaves||[]).filter(l=>l.userId===user.id&&l.status==="pending").length;
  const hol=isHL(tod(),D.holidays)?(D.holidays||[]).find(h=>h.date===tod())?.name:null;
  const now=new Date();
  const onSelfie=async(img)=>{
    setSelfie(img);
    if(wfh){setStep("confirm");return;}
    // Check GPS support first
    if(!navigator.geolocation){
      setLocErr("GPS is not supported on this device or browser.");
      setStep("err");return;
    }
    setStep("loc");
    // Check permission status if API available
    if(navigator.permissions){
      try{
        const perm=await navigator.permissions.query({name:"geolocation"});
        if(perm.state==="denied"){
          setLocErr("Location permission is blocked. Please enable it in your browser settings: Settings → Site Settings → Location → Allow.");
          setStep("err");return;
        }
      }catch(e){}
    }
    // Get location with retry
    const tryGetLocation=(attempt=1)=>{
      navigator.geolocation.getCurrentPosition(
        pos=>{
          const{latitude:la,longitude:lo,accuracy}=pos.coords;
          setGps({lat:la,lng:lo,accuracy});
          // Check assigned offices
          const assignedOffices=(user.officeIds||[]).map(id=>D.offices.find(o=>o.id===id)).filter(Boolean);
          if(assignedOffices.length===0){
            // No offices configured — allow WFH-style check-in
            setOffice({name:"Remote / No Office Configured"});
            setStep("confirm");
            return;
          }
          // Find nearest office
          const nearest=assignedOffices.reduce((b,o)=>{
            const d=dist(la,lo,o.lat,o.lng);
            return(!b||d<b.d)?{...o,d}:b;
          },null);
          const near=assignedOffices.find(o=>dist(la,lo,o.lat,o.lng)<=o.radius);
          if(near){
            setOffice(near);
            setStep("confirm");
          } else {
            // Outside geofence — show error with distance
            const distM=Math.round(nearest?.d||0);
            setLocErr(`❌ Location mismatch: You are ${distM}m away from ${nearest?.name||"your office"}.\n\nYou must be within ${nearest?.radius||50}m to check in.\n\nIf you are working from home, please use the WFH option.`);
            setStep("err");
          }
        },
        (err)=>{
          if(attempt<2){
            // Retry once with lower accuracy
            setTimeout(()=>tryGetLocation(attempt+1),1000);
          } else {
            const msgs={
              1:"Location permission denied. Go to browser Settings → Site Settings → Location → Allow for this site.",
              2:"GPS signal unavailable. Please move to an open area or enable WiFi for better accuracy.",
              3:"Location request timed out. Please check your GPS settings and try again.",
            };
            setLocErr(msgs[err.code]||"Could not get your location. Please enable GPS and try again.");
            setStep("err");
          }
        },
        {enableHighAccuracy:true,timeout:attempt===1?15000:30000,maximumAge:0}
      );
    };
    tryGetLocation();
  };
  const doIn=()=>{
    const lb=(!wfh&&sh)?lateBy(new Date().toISOString(),sh.shiftStart):0;
    const rec={id:gid(),userId:user.id,userName:user.name,teamId:user.teamId,date:tod(),checkIn:new Date().toISOString(),checkOut:null,selfie,gps:wfh?null:gps,officeName:wfh?"WFH":office?.name,status:wfh?"wfh":lb>30?"late":"present",lateBy:lb,isWFH:wfh};
    addAttendance(rec);
    ST(wfh?"🏠 WFH done!":lb>30?`⚠️ ${lb}m late`:"✅ Checked in!");setStep("done");
  };
  const doOut=()=>{
    const go=cg=>{updateAttendance(rec.id,{checkOut:new Date().toISOString(),checkOutGps:cg});ST("👋 Out!");};
    navigator.geolocation?.getCurrentPosition(p=>go({lat:p.coords.latitude,lng:p.coords.longitude}),()=>go(null));
  };
  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{background:"#1a2a5e",margin:"-20px -20px 18px",padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <Logo s={28} full={false}/>
          <div>
            <div style={{fontSize:10,color:"#cc2222",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em"}}>Nucleus HRMS</div>
            <div style={{fontSize:15,fontWeight:800,color:"#fff"}}>{user.name}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:6}}>
          <button onClick={()=>setSc("notif")} style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:10,padding:"8px 11px",fontSize:13,cursor:"pointer",position:"relative",color:"#fff"}}>{unread>0&&<span style={{position:"absolute",top:-4,right:-4,background:G.rd,color:"#fff",borderRadius:"50%",width:15,height:15,fontSize:9,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900}}>{unread}</span>}🔔</button>
          <button onClick={logout} style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:10,fontSize:12,padding:"8px 12px",cursor:"pointer",color:"#fff",fontWeight:600}}>Logout</button>
        </div>
      </div>
      {(hol||isWE(tod()))&&(
        <div style={{background:`linear-gradient(135deg,${G.navy},${G.navyL})`,border:`1px solid ${G.gold}`,borderRadius:14,padding:"12px 16px",marginBottom:14,display:"flex",gap:10,alignItems:"center"}}>
          <div style={{fontSize:26}}>{hol?"🎉":"🌟"}</div>
          <div><div style={{color:G.gold,fontWeight:800,fontSize:14}}>{hol||"Weekend"}</div><div style={{color:G.mut,fontSize:12}}>No attendance needed</div></div>
        </div>
      )}
      <div style={{background:"linear-gradient(135deg,#1a2a5e,#2a3f8f)",borderRadius:20,padding:22,marginBottom:14,textAlign:"center"}}>
        <div style={{fontSize:40,fontWeight:900,color:"#fff"}}>{now.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</div>
        <div style={{color:G.mut,fontSize:13,marginTop:2}}>{now.toLocaleDateString([],{weekday:"long",day:"numeric",month:"long"})}</div>
        {sh&&<div style={{marginTop:8,background:"rgba(201,168,76,.15)",border:`1px solid ${G.gold}44`,borderRadius:8,padding:"4px 12px",display:"inline-block",fontSize:12,color:G.gold}}>🕘 {sh.shiftStart}–{sh.shiftEnd}</div>}
      </div>
      <div style={K}>
        {!rec?(
          <>
            {step==="idle"&&(
              <>
                <div style={{display:"flex",gap:8,marginBottom:10}}>
                  <button onClick={()=>setWfh(false)} style={{...B(wfh?G.card2:G.gold),flex:1,fontSize:13,color:wfh?"#fff":"#000",border:wfh?`1px solid ${G.bdr}`:"none"}}>🏢 Office</button>
                  <button onClick={()=>setWfh(true)} style={{...B(!wfh?G.card2:G.bl),flex:1,fontSize:13,border:!wfh?`1px solid ${G.bdr}`:"none"}}>🏠 WFH</button>
                </div>
                <button onClick={()=>setStep("cam")} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",fontSize:15,padding:13,color:"#000",fontWeight:800}}>📸 Check In{wfh?" (WFH)":""}</button>
              </>
            )}
            {step==="cam"&&<Cam onDone={onSelfie} onCancel={()=>setStep("idle")}/>}
            {step==="loc"&&<div style={{textAlign:"center",padding:18}}><div style={{fontSize:34,marginBottom:8}}>📍</div><p style={{color:G.mut}}>Verifying location…</p><div style={{width:32,height:32,border:`4px solid ${G.gold}`,borderTopColor:"transparent",borderRadius:"50%",animation:"spin 1s linear infinite",margin:"0 auto"}}/></div>}
            {step==="confirm"&&(
              <div style={{textAlign:"center"}}>
                {selfie&&<img src={selfie} style={{width:90,height:90,borderRadius:"50%",objectFit:"cover",border:`4px solid ${G.gold}`,marginBottom:10}}/>}
                <div style={{color:G.gold,fontWeight:700,marginBottom:2}}>{wfh?"🏠 Work From Home":`📍 ${office?.name}`}</div>
                <div style={{color:G.mut,fontSize:12,marginBottom:12}}>{wfh?"WFH":"Location verified ✓"}</div>
                <button onClick={doIn} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#000",fontWeight:800}}>Confirm Check-In ✓</button>
              </div>
            )}
            {step==="err"&&(
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:36,marginBottom:8}}>📍</div>
                <p style={{color:G.rd,fontSize:13,marginBottom:8,lineHeight:1.5}}>{locErr}</p>
                <div style={{display:"flex",gap:8,flexDirection:"column"}}>
                  <button onClick={()=>setStep("cam")} style={{...B(G.gold),color:"#000",fontWeight:700}}>📸 Retry Check-In</button>
                  <button onClick={()=>setWfh(true)||setStep("cam")} style={{...B(G.bl),fontSize:12}}>🏠 Switch to WFH Instead</button>
                  <button onClick={()=>setStep("idle")} style={{...B(G.dim),fontSize:12}}>Cancel</button>
                </div>
              </div>
            )}
          </>
        ):(
          <div>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
              {rec.selfie?<img src={rec.selfie} style={{width:60,height:60,borderRadius:"50%",objectFit:"cover",border:`3px solid ${G.gold}`,flexShrink:0}}/>:<div style={{width:60,height:60,borderRadius:"50%",background:G.card2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,flexShrink:0}}>👤</div>}
              <div><div style={{color:G.gr,fontWeight:800,fontSize:15}}>✅ {rec.isWFH?"WFH":"Checked In"}</div><div style={{color:G.mut,fontSize:13}}>at {fT(rec.checkIn)} · {rec.officeName}</div>{rec.lateBy>0&&<div style={{color:G.am,fontSize:12}}>⚠️ {rec.lateBy} mins late</div>}</div>
            </div>
            {rec.checkOut?<div style={{background:G.card2,borderRadius:10,padding:10,textAlign:"center",color:G.mut,fontSize:13,border:`1px solid ${G.bdr}`}}>Out {fT(rec.checkOut)} · <span style={{color:G.gold,fontWeight:700}}>{wHr(rec.checkIn,rec.checkOut)}</span> 👋</div>:<button onClick={doOut} style={{...B(G.am),width:"100%",fontWeight:700}}>🚪 Check Out</button>}
          </div>
        )}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        {[
          ["History","hist"],
          ["Leaves"+(pl>0?` (${pl})`:""),"lv"],
          ["Regularize","reg"],
          ["Notifications"+(unread>0?` (${unread})`:""),"notif"],
          ...(user.role==="manager"||user.role==="hod"?[["My Team","teamdash"]]:[]),
          ...(rec&&rec.lateBy>0&&!rec.checkOut?[["Request Late Approval","lateapproval"]]:[]),
          ["Change Password","changepwd"],
        ].map(([lb,s])=>(
          <button key={s} onClick={()=>setSc(s)} style={{background:s==="lateapproval"?"#d97706":"#fff",color:s==="lateapproval"?"#fff":"#1a2a5e",border:s==="lateapproval"?"none":"1px solid #dce4ef",borderRadius:12,fontSize:12,padding:10,fontWeight:600,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 1px 3px rgba(26,42,94,0.08)"}}>{lb}</button>
        ))}
      </div>
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
  const weeklyOff=user.weeklyOff||"sun_sat";
  const workDays=allDays.filter(ds=>!isDayOff(ds,D.holidays,weeklyOff));
  const present=workDays.filter(ds=>attMap[ds]&&(attMap[ds].status==="present"||attMap[ds].status==="wfh")).length;
  const late=workDays.filter(ds=>attMap[ds]&&attMap[ds].status==="late").length;
  const absent=workDays.filter(ds=>!attMap[ds]&&!leaveMap[ds]).length;
  const onLeave=workDays.filter(ds=>leaveMap[ds]&&!attMap[ds]).length;
  const total=workDays.length;
  const pct=total?Math.round(((present+late)/total)*100):0;
  const getInfo=(ds)=>{
    const rec=attMap[ds],lv=leaveMap[ds],we=isWE(ds),hl=isHL(ds,D.holidays);
    const hlName=(D.holidays||[]).find(h=>h.date===ds)?.name;
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
        <div style={{background:G.navy,borderRadius:8,height:8,overflow:"hidden"}}><div style={{background:pct>=80?`linear-gradient(90deg,${G.gr},${G.goldL})`:pct>=60?`linear-gradient(90deg,${G.am},${G.gold})`:`linear-gradient(90deg,${G.rd},${G.am})`,height:"100%",width:`${pct}%`,borderRadius:8}}/></div>
        <div style={{fontSize:11,color:G.dim,marginTop:5}}>{present+late} of {total} working days attended</div>
      </div>
      {allDays.length===0
        ?<div style={{textAlign:"center",color:G.dim,padding:40}}>No data for this month.</div>
        :allDays.map(ds=>{
          const rec=attMap[ds];
          const [stColor,stIcon,stLabel]=getInfo(ds);
          const we=isWE(ds),hl=isHL(ds,D.holidays);
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
                :<div style={{width:38,height:38,borderRadius:"50%",background:G.navy,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>{stIcon}</div>
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

function Lv({user,D,P,ST,setSc}) {
  const [form,setForm]=useState({type:"casual",from:tod(),to:tod(),reason:"",session:"morning",earlyTime:""});
  const pol=(D.leavePolicy||DP)[(user.employeeType||'employee')]||DP_EMP;
  const used=t=>(D.leaves||[]).filter(l=>l.userId===user.id&&l.type===t&&l.status==="approved").length;
  const tL={casual:"🏖 Casual",sick:"🤒 Sick",compoff:"🔄 CompOff",halfday:"🌓 Half Day",early:"🏃 Early",studyleave:"📚 Study Leave"};
  const sc={pending:G.am,approved:G.gr,rejected:G.rd};
  const apply=()=>{
    if(!form.reason.trim())return ST("Please add a reason","error");
    if(pol[form.type]-used(form.type)<=0)return ST("No leaves remaining","error");
    addLeave({id:gid(),userId:user.id,userName:user.name,teamId:user.teamId,...form,appliedOn:new Date().toISOString(),status:"pending"});
    ST("✅ Leave applied!");setForm({type:"casual",from:tod(),to:tod(),reason:"",session:"morning",earlyTime:""});
  };
  const myL=(D.leaves||[]).filter(l=>l.userId===user.id).sort((a,b)=>new Date(b.appliedOn)-new Date(a.appliedOn));
  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:14}}>
        <button onClick={()=>setSc("home")} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800}}>Leave Management</h2>
      </div>
      <div style={K}>
        <div style={{fontSize:11,color:G.mut,fontWeight:700,textTransform:"uppercase",marginBottom:10}}>Balance</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
          {Object.entries(pol).map(([t,a])=>{const r=a-used(t);return(
            <div key={t} style={{background:G.navy,borderRadius:10,padding:"8px 10px",flex:"1 1 60px",textAlign:"center",border:`1px solid ${r>0?G.bdr:G.rd+"44"}`}}>
              <div style={{fontSize:9,color:G.dim,textTransform:"uppercase",fontWeight:700}}>{t}</div>
              <div style={{fontSize:19,fontWeight:900,color:r>0?G.gold:G.rd}}>{r}</div>
              <div style={{fontSize:9,color:G.dim}}>/{a}</div>
            </div>
          );})}
        </div>
      </div>
      <div style={K}>
        <div style={{fontWeight:800,marginBottom:10,color:G.gold}}>Apply for Leave</div>
        <FRow label="Type"><select style={I} value={form.type} onChange={e=>setForm({...form,type:e.target.value})}>{Object.keys(pol).map(t=><option key={t} value={t}>{tL[t]||t} ({pol[t]-used(t)} left)</option>)}</select></FRow>
        {form.type==="halfday"&&<FRow label="Session"><select style={I} value={form.session} onChange={e=>setForm({...form,session:e.target.value})}><option value="morning">Morning</option><option value="afternoon">Afternoon</option></select></FRow>}
        {form.type==="early"&&<FRow label="Early Time"><input type="time" style={I} value={form.earlyTime} onChange={e=>setForm({...form,earlyTime:e.target.value})}/></FRow>}
        {(form.type==="halfday"||form.type==="early")
          ?<FRow label="Date"><input type="date" style={I} value={form.from} onChange={e=>setForm({...form,from:e.target.value,to:e.target.value})}/></FRow>
          :<div style={{display:"flex",gap:8}}><FRow label="From"><input type="date" style={I} value={form.from} onChange={e=>setForm({...form,from:e.target.value})}/></FRow><FRow label="To"><input type="date" style={I} value={form.to} onChange={e=>setForm({...form,to:e.target.value})}/></FRow></div>
        }
        <FRow label="Reason"><textarea style={{...I,resize:"vertical",minHeight:65}} value={form.reason} onChange={e=>setForm({...form,reason:e.target.value})} placeholder="Reason…"/></FRow>
        <button onClick={apply} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#000",fontWeight:800}}>Apply Leave</button>
      </div>
      {myL.map(l=>(
        <div key={l.id} style={K}>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <div><div style={{fontWeight:700}}>{tL[l.type]||l.type}</div><div style={{fontSize:12,color:G.mut,marginTop:2}}>{l.from}{l.to&&l.to!==l.from?`→${l.to}`:""}</div><div style={{fontSize:12,color:G.dim,fontStyle:"italic"}}>"{l.reason}"</div>{l.reviewNote&&<div style={{fontSize:11,color:G.mut,marginTop:2}}>Note: {l.reviewNote}</div>}</div>
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



function FirstLogin({user,D,P,ST,setSc,logout}) {
  const [np,setNp]=useState("");
  const [cp,setCp]=useState("");
  const save=()=>{
    if(!np||np.length<6)return ST("Password must be at least 6 characters","error");
    if(np!==cp)return ST("Passwords do not match","error");
    P({...D,users:D.users.map(u=>u.id===user.id?{...u,password:np,firstLogin:false}:u)});
    const updated={...user,password:np,firstLogin:false};
    ST("✅ Password set! Please login again.");
    setTimeout(()=>logout(),1500);
  };
  return (
    <div style={{minHeight:"100vh",background:G.bg,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{maxWidth:400,width:"100%"}}>
        <div style={{...K,padding:24}}>
          <div style={{textAlign:"center",marginBottom:20}}>
            <div style={{fontSize:40,marginBottom:8}}>🔐</div>
            <div style={{fontSize:18,fontWeight:800,color:G.gold}}>Set Your Password</div>
            <div style={{fontSize:13,color:G.mut,marginTop:6}}>Welcome {user.name}! Please set a new password before continuing.</div>
          </div>
          <FRow label="New Password">
            <input type="password" style={I} value={np} onChange={e=>setNp(e.target.value)} placeholder="Min 6 characters"/>
          </FRow>
          <FRow label="Confirm Password">
            <input type="password" style={I} value={cp} onChange={e=>setCp(e.target.value)} placeholder="Re-enter password" onKeyDown={e=>e.key==="Enter"&&save()}/>
          </FRow>
          <button onClick={save} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#000",fontWeight:800,fontSize:15}}>Set Password & Continue →</button>
        </div>
      </div>
    </div>
  );
}

function ChangePwd({user,D,P,ST,setSc,logout}) {
  const [mode,setMode]=useState("menu"); // menu | current | otp
  const [cur,setCur]=useState("");
  const [np,setNp]=useState("");
  const [cp,setCp]=useState("");
  const [email,setEmail]=useState(user?.email||"");
  const [otp,setOtp]=useState("");
  const [otpSent,setOtpSent]=useState(false);
  const [sending,setSending]=useState(false);

  const changeWithCurrent=()=>{
    const u=(D.users||[]).find(x=>x.id===user.id);
    if(!u||cur!==u.password)return ST("Current password is incorrect","error");
    if(!np||np.length<6)return ST("New password must be at least 6 characters","error");
    if(np!==cp)return ST("Passwords do not match","error");
    P({...D,users:D.users.map(x=>x.id===user.id?{...x,password:np}:x)});
    ST("✅ Password changed successfully!");
    setTimeout(()=>setSc(user.role==="admin"||user.role==="hr"?"dash":"home"),1500);
  };

  const sendOtp=async()=>{
    const u=(D.users||[]).find(x=>x.email===email);
    if(!u)return ST("Email not found","error");
    setSending(true);
    await sendOTP(email);
    setOtpSent(true);setSending(false);
    ST("✅ OTP sent to "+email);
  };

  const changeWithOtp=()=>{
    if(!verifyOTP(email,otp))return ST("Invalid or expired OTP","error");
    if(!np||np.length<6)return ST("New password must be at least 6 characters","error");
    if(np!==cp)return ST("Passwords do not match","error");
    const u=(D.users||[]).find(x=>x.email===email);
    if(!u)return ST("User not found","error");
    P({...D,users:D.users.map(x=>x.email===email?{...x,password:np}:x)});
    ST("✅ Password reset successfully! Please login again.");
    setTimeout(()=>logout(),1500);
  };

  const back=user?.role?()=>setSc(user.role==="admin"||user.role==="hr"?"dash":"home"):logout;

  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:16}}>
        <button onClick={back} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800}}>🔑 Password Settings</h2>
      </div>

      {mode==="menu"&&(
        <>
          <div style={{...K,background:G.navy,border:`1px solid ${G.gold}44`,marginBottom:12}}>
            <div style={{color:G.gold,fontWeight:700}}>Choose an option</div>
            <div style={{fontSize:12,color:G.dim,marginTop:4}}>You can change your password using your current password or via email OTP.</div>
          </div>
          <div style={{...K,cursor:"pointer"}} onClick={()=>setMode("current")}>
            <div style={{fontWeight:700,fontSize:14}}>🔐 Change using current password</div>
            <div style={{fontSize:12,color:G.dim,marginTop:4}}>You know your current password</div>
          </div>
          <div style={{...K,cursor:"pointer"}} onClick={()=>setMode("otp")}>
            <div style={{fontWeight:700,fontSize:14}}>📧 Reset via Email OTP</div>
            <div style={{fontSize:12,color:G.dim,marginTop:4}}>Forgot password or want to reset securely</div>
          </div>
        </>
      )}

      {mode==="current"&&(
        <div style={K}>
          <button onClick={()=>setMode("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:12}}>← Back</button>
          <FRow label="Current Password">
            <input type="password" style={I} value={cur} onChange={e=>setCur(e.target.value)} placeholder="Enter current password"/>
          </FRow>
          <FRow label="New Password">
            <input type="password" style={I} value={np} onChange={e=>setNp(e.target.value)} placeholder="Min 6 characters"/>
          </FRow>
          <FRow label="Confirm New Password">
            <input type="password" style={I} value={cp} onChange={e=>setCp(e.target.value)} placeholder="Re-enter new password" onKeyDown={e=>e.key==="Enter"&&changeWithCurrent()}/>
          </FRow>
          <button onClick={changeWithCurrent} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#000",fontWeight:800}}>Change Password</button>
        </div>
      )}

      {mode==="otp"&&(
        <div style={K}>
          <button onClick={()=>setMode("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:12}}>← Back</button>
          <FRow label="Your Email">
            <input style={I} value={email} onChange={e=>setEmail(e.target.value)} placeholder="your@email.com"/>
          </FRow>
          {!otpSent?(
            <button onClick={sendOtp} style={{...B(G.bl),width:"100%",fontWeight:700}}>{sending?"Sending OTP…":"📧 Send OTP to Email"}</button>
          ):(
            <>
              <div style={{background:"#001a0f",border:`1px solid ${G.gr}`,borderRadius:10,padding:10,marginBottom:12,fontSize:12,color:G.gr}}>✅ OTP sent to {email}. Valid for 10 minutes.</div>
              <FRow label="Enter OTP">
                <input style={I} value={otp} onChange={e=>setOtp(e.target.value)} placeholder="6-digit OTP" maxLength={6}/>
              </FRow>
              <FRow label="New Password">
                <input type="password" style={I} value={np} onChange={e=>setNp(e.target.value)} placeholder="Min 6 characters"/>
              </FRow>
              <FRow label="Confirm New Password">
                <input type="password" style={I} value={cp} onChange={e=>setCp(e.target.value)} placeholder="Re-enter new password"/>
              </FRow>
              <div style={{display:"flex",gap:8}}>
                <button onClick={changeWithOtp} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),flex:2,color:"#000",fontWeight:800}}>Reset Password</button>
                <button onClick={()=>{setOtpSent(false);setOtp("");}} style={{...B(G.dim),flex:1}}>Resend</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
function LateApproval({user,D,P,ST,AN,setSc}) {
  const [reason,setReason]=useState("");
  const rec=D.attendance.find(a=>a.userId===user.id&&a.date===tod());
  const reportingMgr=D.users.find(u=>u.id===user.reportingTo);

  const submit=()=>{
    if(!reason.trim())return ST("Please provide a reason","error");
    if(!rec)return ST("No attendance record found for today","error");
    // Create regularization request for late approval
    const reg={
      id:gid(),userId:user.id,userName:user.name,teamId:user.teamId,
      date:tod(),checkIn:rec.checkIn.split("T")[1].substr(0,5),
      checkOut:"18:30",reason,
      type:"late_approval",
      lateBy:rec.lateBy,
      appliedOn:new Date().toISOString(),status:"pending"
    };
    addReg(reg);
    // Notify reporting manager
    if(reportingMgr){
      AN(reportingMgr.id,`${user.name} has requested late arrival approval for today (${rec.lateBy} mins late). Reason: ${reason}`,"info","Late Approval Request — Nucleus HRMS");
    }
    ST("✅ Late approval request sent to your manager!");
    setSc("home");
  };

  if(!rec||rec.lateBy<=0) return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:16}}>
        <button onClick={()=>setSc("home")} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800}}>Late Approval</h2>
      </div>
      <div style={{...K,textAlign:"center",padding:32}}>
        <div style={{fontSize:40,marginBottom:12}}>✅</div>
        <div style={{fontWeight:700,fontSize:15}}>No late arrival today</div>
        <div style={{color:G.dim,fontSize:13,marginTop:6}}>You are not marked late today.</div>
      </div>
    </div>
  );

  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:16}}>
        <button onClick={()=>setSc("home")} style={{...B(G.card),border:`1px solid ${G.bdr}`,padding:"8px 14px"}}>← Back</button>
        <h2 style={{margin:0,fontSize:17,fontWeight:800,color:G.am}}>Late Approval Request</h2>
      </div>
      <div style={{...K,background:"#1a0f00",border:`1px solid ${G.am}`,marginBottom:12}}>
        <div style={{color:G.am,fontWeight:700,fontSize:14}}>⚠️ Late by {rec.lateBy} minutes today</div>
        <div style={{color:G.mut,fontSize:12,marginTop:4}}>Check-in time: {fT(rec.checkIn)}</div>
        {reportingMgr&&<div style={{color:G.mut,fontSize:12,marginTop:2}}>Request will be sent to: <span style={{color:G.gold,fontWeight:700}}>{reportingMgr.name}</span></div>}
      </div>
      <div style={K}>
        <div style={{fontWeight:800,marginBottom:12,color:G.gold}}>Reason for Late Arrival</div>
        <FRow label="Reason">
          <textarea style={{...I,resize:"vertical",minHeight:100}} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Please explain why you were late today…"/>
        </FRow>
        <div style={{fontSize:12,color:G.dim,marginBottom:12}}>
          ℹ️ If approved by your manager, your attendance will be automatically regularized and the late mark will be removed.
        </div>
        <button onClick={submit} style={{...B(`linear-gradient(135deg,${G.am},${G.goldD})`),width:"100%",color:"#000",fontWeight:800}}>Send Approval Request</button>
      </div>
    </div>
  );
}
function Reg({user,D,P,ST,setSc}) {
  const [f,setF]=useState({date:tod(),reason:"",checkIn:"09:30",checkOut:"18:30"});
  const submit=()=>{
    if(!f.reason.trim())return ST("Please add reason","error");
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
        <FRow label="Date"><input type="date" style={I} value={f.date} onChange={e=>setF({...f,date:e.target.value})}/></FRow>
        <div style={{display:"flex",gap:8}}><FRow label="Check-in"><input type="time" style={I} value={f.checkIn} onChange={e=>setF({...f,checkIn:e.target.value})}/></FRow><FRow label="Check-out"><input type="time" style={I} value={f.checkOut} onChange={e=>setF({...f,checkOut:e.target.value})}/></FRow></div>
        <FRow label="Reason"><textarea style={{...I,resize:"vertical",minHeight:70}} value={f.reason} onChange={e=>setF({...f,reason:e.target.value})} placeholder="Why was attendance missed?"/></FRow>
        <div style={{display:"flex",gap:8}}><button onClick={submit} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),flex:2,color:"#000",fontWeight:800}}>Submit</button><button onClick={()=>setSc("home")} style={{...B(G.dim),flex:1}}>Cancel</button></div>
      </div>
    </div>
  );
}

function Dash({user,D,P,ST,AN,logout}) {
  const [tab,setTab]=useState("ov");
  const isA=user.role==="admin"||user.role==="hr";
  const tabs=isA?[["ov","Overview"],["live","Live"],["att","Records"],["lv","Leaves"],["rg","Regularize"],["pay","Payroll"],["org","Hierarchy"],["pol","Policy"],["hol","Holidays"],["st","Staff"],["tm","Teams"],["of","Offices"],["rst","⚙ Reset"]]:[["ov","Overview"],["live","Live"],["att","Records"],["lv","Leaves"],["rg","Regularize"],["pay","Payroll"],["org","Hierarchy"]];
  const isHR=user.role==="hr";
  const isHOD=user.role==="hod";
  const vu=isA||isHR
    ?D.users.filter(u=>u.role!=="admin")
    :isHOD
    ?D.users.filter(u=>u.teamId===user.teamId&&u.role!=="admin")
    :D.users.filter(u=>u.reportingTo===user.id||((user.managedTeams||[]).includes(u.teamId)&&u.role==="staff"));
  const pL=(D.leaves||[]).filter(l=>l.status==="pending"&&vu.some(u=>u.id===l.userId)).length;
  const pR=(D.regularizations||[]).filter(r=>r.status==="pending"&&vu.some(u=>u.id===r.userId)).length;
  const tp={D,P,ST,AN,vu,isA};
  return (
    <div style={{maxWidth:500,margin:"0 auto",padding:"0 0 80px"}}>
      <div style={{background:"#1a2a5e",padding:"16px 16px 12px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <Logo s={26} full={false}/>
          <div>
            <div style={{fontSize:10,color:"#cc2222",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em"}}>{isA?"Admin":"Manager"}</div>
            <div style={{fontSize:16,fontWeight:900,color:"#fff"}}>{user.name}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:6}}>
          <button onClick={()=>setSc("changepwd")} style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:10,fontSize:11,padding:"7px 10px",cursor:"pointer",color:"#fff"}}>🔑</button>
          <button onClick={logout} style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:10,fontSize:12,padding:"8px 12px",cursor:"pointer",color:"#fff",fontWeight:600}}>Logout</button>
        </div>
      </div>
      <div style={{display:"flex",gap:5,marginBottom:12,overflowX:"auto",paddingBottom:4}}>
        {tabs.map(([id,lb])=>(
          <button key={id} onClick={()=>setTab(id)} style={{...B(tab===id?G.gold:G.card),whiteSpace:"nowrap",fontSize:12,padding:"7px 9px",border:tab===id?"none":`1px solid ${G.bdr}`,color:tab===id?"#000":"#fff",flexShrink:0,position:"relative",fontWeight:tab===id?800:600}}>
            {lb}
            {id==="lv"&&pL>0&&<span style={{position:"absolute",top:-4,right:-4,background:G.rd,color:"#fff",borderRadius:"50%",width:14,height:14,fontSize:8,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900}}>{pL}</span>}
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
      {tab==="rst"&&isA&&<RST {...tp} logout={logout}/>}
    </div>
  );
}

function OV({D,vu}) {
  const tr=D.attendance.filter(a=>a.date===tod());
  const ci=tr.filter(a=>vu.some(u=>u.id===a.userId)).length;
  const wC=tr.filter(a=>a.isWFH&&vu.some(u=>u.id===a.userId)).length;
  const tot=vu.length,ab=tot-ci,pct=tot?Math.round((ci/tot)*100):0;
  const lt=tr.filter(r=>r.status==="late"&&vu.some(u=>u.id===r.userId)).length;
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
        <div style={{background:G.navy,borderRadius:8,height:9,overflow:"hidden"}}><div style={{background:`linear-gradient(90deg,${G.gold},${G.goldL})`,height:"100%",width:`${pct}%`,borderRadius:8,transition:"width .5s"}}/></div>
        <div style={{display:"flex",justifyContent:"space-between",marginTop:5}}><span style={{fontSize:11,color:G.dim}}>{ci}/{tot} in</span><span style={{fontSize:11,color:G.bl}}>📍{lN} live</span></div>
      </div>
      <div style={K}>
        <div style={{fontWeight:700,marginBottom:8,color:G.gold}}>Today</div>
        {vu.map(u=>{const r=tr.find(a=>a.userId===u.id),lv=D.liveLocations?.[u.id];return(
          <div key={u.id} style={{display:"flex",gap:8,alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${G.bdr}`}}>
            {r?.selfie?<img src={r.selfie} style={{width:34,height:34,borderRadius:"50%",objectFit:"cover",border:`2px solid ${G.gold}`}}/>:<div style={{width:34,height:34,borderRadius:"50%",background:G.navy,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>👤</div>}
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
  const lv=vu.filter(u=>D.liveLocations?.[u.id]),off=vu.filter(u=>!D.liveLocations?.[u.id]);
  return (
    <>
      <div style={{...K,background:G.navy,border:`1px solid ${G.navyL}`}}><div style={{color:G.gold,fontWeight:700,fontSize:13}}>📍 Live Location</div><div style={{color:G.dim,fontSize:12,marginTop:3}}>{lv.length}/{vu.length} sharing location.</div></div>
      {lv.length===0&&<div style={{textAlign:"center",color:G.dim,padding:30,fontSize:13}}>No live locations. Staff must be logged in.</div>}
      {lv.map(u=>{
        const loc=D.liveLocations[u.id],r=D.attendance.find(a=>a.userId===u.id&&a.date===tod());
        // Check user's assigned offices first, then all offices
        const userOffices=(u.officeIds||[]).map(id=>D.offices.find(o=>o.id===id)).filter(Boolean);
        const checkOffices=userOffices.length>0?userOffices:D.offices;
        const nr=checkOffices.reduce((b,o)=>{const d=dist(loc.lat,loc.lng,o.lat,o.lng);return(!b||d<b.d)?{...o,d}:b;},null);
        const at=nr&&nr.d<=nr.radius;
        // Handle Firebase timestamp (can be object or string)
        const locTs=loc.ts?.toDate?loc.ts.toDate():loc.ts?new Date(loc.ts):new Date();
        const ago=Math.round((new Date()-locTs)/60000);
        return (
          <div key={u.id} style={{...K,border:sel===u.id?`1px solid ${G.gold}`:`1px solid ${G.bdr}`,cursor:"pointer"}} onClick={()=>setSel(sel===u.id?null:u.id)}>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              {r?.selfie?<img src={r.selfie} style={{width:44,height:44,borderRadius:"50%",objectFit:"cover",border:`2px solid ${G.gold}`}}/>:<div style={{width:44,height:44,borderRadius:"50%",background:G.navy,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>👤</div>}
              <div style={{flex:1}}><div style={{fontWeight:700,display:"flex",gap:6,alignItems:"center"}}>{u.name}<span style={{width:7,height:7,background:G.gr,borderRadius:"50%",animation:"pulse 2s infinite"}}/></div><div style={{fontSize:12,color:G.mut}}>{at?`🏢 ${nr.name}`:`📍 ${Math.round(nr?.d||0)}m from ${nr?.name||"office"}`}</div><div style={{fontSize:11,color:G.dim}}>{ago<1?"just now":`${ago}m ago`}</div></div>
              <Chip bg={at?G.gr:G.am} label={at?"In":"Out"} sm/>
            </div>
            {sel===u.id&&(
              <div style={{marginTop:10,background:G.navy,borderRadius:10,padding:12}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
                  {[["Lat",loc.lat.toFixed(5)],["Lng",loc.lng.toFixed(5)],["Accuracy",`±${loc.ac}m`],["Distance",`${Math.round(nr?.d||0)}m`]].map(([lb,v])=>(
                    <div key={lb} style={{background:G.card2,borderRadius:8,padding:"6px 10px"}}><div style={{fontSize:9,color:G.dim,fontWeight:700,textTransform:"uppercase"}}>{lb}</div><div style={{fontSize:12,color:G.txt,fontWeight:600,marginTop:1}}>{v}</div></div>
                  ))}
                </div>
                <a href={`https://maps.google.com/?q=${loc.lat},${loc.lng}`} target="_blank" rel="noreferrer" style={{display:"block",background:G.bl,color:"#fff",textAlign:"center",padding:"8px",borderRadius:8,fontSize:12,fontWeight:700,textDecoration:"none"}}>🗺 Google Maps</a>
              </div>
            )}
          </div>
        );
      })}
      {off.length>0&&(<><div style={{color:G.dim,fontSize:10,fontWeight:700,textTransform:"uppercase",marginBottom:6,marginTop:4}}>Offline</div>{off.map(u=><div key={u.id} style={{...K,opacity:.5,display:"flex",gap:10,alignItems:"center"}}><div style={{width:34,height:34,borderRadius:"50%",background:G.navy,display:"flex",alignItems:"center",justifyContent:"center"}}>👤</div><div style={{flex:1}}><div style={{fontSize:13,fontWeight:700}}>{u.name}</div><div style={{fontSize:11,color:G.dim}}>No data</div></div><Chip bg={G.dim} label="—" sm/></div>)}</>)}
    </>
  );
}

function AT({D,vu,P,ST}) {
  const [fd,setFd]=useState(tod());
  const [fu,setFu]=useState("all");
  const [sel,setSel]=useState(null);
  const recs=D.attendance.filter(a=>{if(fd&&a.date!==fd)return false;if(fu!=="all"&&a.userId!==fu)return false;return vu.some(u=>u.id===a.userId);}).sort((a,b)=>new Date(b.checkIn)-new Date(a.checkIn));
  const exp=()=>{
    const rows=[["Name","Date","In","Out","Hours","Late","Office","WFH","Status"],...recs.map(r=>[r.userName,r.date,fT(r.checkIn),r.checkOut?fT(r.checkOut):"",r.checkOut?wHr(r.checkIn,r.checkOut):"",r.lateBy||0,r.officeName||"",r.isWFH?"Y":"N",r.status])].map(r=>r.map(c=>`"${c}"`).join(",")).join("\n");
    const a=document.createElement("a");a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(rows);a.download=`att_${fd}.csv`;a.click();ST("📊 Exported!");
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
        <select value={fu} onChange={e=>setFu(e.target.value)} style={{...I,flex:1}}><option value="all">All</option>{vu.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select>
      </div>
      <button onClick={exp} style={{...B(G.bl),width:"100%",marginBottom:10}}>📥 Export CSV/Excel</button>
      {recs.map(r=>(
        <div key={r.id} style={{...K,border:sel===r.id?`1px solid ${G.gold}`:`1px solid ${G.bdr}`,cursor:"pointer"}} onClick={()=>setSel(sel===r.id?null:r.id)}>
          <div style={{display:"flex",gap:10,alignItems:"center"}}>
            {r.selfie?<img src={r.selfie} style={{width:44,height:44,borderRadius:"50%",objectFit:"cover",border:`2px solid ${G.gold}`}}/>:<div style={{width:44,height:44,borderRadius:"50%",background:G.navy,display:"flex",alignItems:"center",justifyContent:"center"}}>👤</div>}
            <div style={{flex:1,minWidth:0}}><div style={{fontWeight:700,fontSize:13}}>{r.userName}{r.isWFH&&<span style={{marginLeft:5,fontSize:11,color:G.bl}}>🏠</span>}</div><div style={{color:G.mut,fontSize:12}}>In:{fT(r.checkIn)}{r.checkOut?` Out:${fT(r.checkOut)} ${wHr(r.checkIn,r.checkOut)}`:""}</div><div style={{color:G.dim,fontSize:11}}>{r.officeName}{r.lateBy>0?` ⚠️${r.lateBy}m`:""}</div></div>
            <Chip bg={sb[r.status]||G.dim} label={r.status} sm/>
          </div>
          {sel===r.id&&(
            <div style={{marginTop:10,background:G.navy,borderRadius:10,padding:12}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
                {[["Date",fD(r.date)],["In",fT(r.checkIn)],["Out",r.checkOut?fT(r.checkOut):"—"],["Hours",r.checkOut?wHr(r.checkIn,r.checkOut):"—"],["Late",r.lateBy>0?`${r.lateBy}m`:"✓"],["Office",r.officeName||"Manual"]].map(([lb,v])=>(
                  <div key={lb} style={{background:G.card2,borderRadius:8,padding:"6px 10px"}}><div style={{fontSize:9,color:G.dim,fontWeight:700,textTransform:"uppercase"}}>{lb}</div><div style={{fontSize:12,color:G.txt,fontWeight:600,marginTop:1}}>{v}</div></div>
                ))}
              </div>
              {r.gps&&<a href={`https://maps.google.com/?q=${r.gps.lat},${r.gps.lng}`} target="_blank" rel="noreferrer" style={{display:"block",background:G.bl,color:"#fff",textAlign:"center",padding:"7px",borderRadius:8,fontSize:12,fontWeight:700,textDecoration:"none"}}>🗺 Check-in GPS Maps</a>}
              {r.selfie&&<div style={{marginTop:8,textAlign:"center"}}><img src={r.selfie} style={{width:100,height:100,borderRadius:10,objectFit:"cover",border:`2px solid ${G.gold}`}}/></div>}
            </div>
          )}
        </div>
      ))}
      <div style={K}>
        <div style={{fontWeight:700,marginBottom:8,fontSize:12}}>Manual Override — {fd}</div>
        {vu.filter(u=>!recs.some(r=>r.userId===u.id)).map(u=>(
          <div key={u.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:`1px solid ${G.bdr}`}}>
            <span style={{fontSize:13}}>{u.name}</span>
            <div style={{display:"flex",gap:5}}>{[["P","present",G.gr],["L","late",G.am],["W","wfh",G.bl],["A","absent",G.rd]].map(([lb,st,c])=><button key={lb} onClick={()=>mk(u.id,st)} style={{...B(c),fontSize:11,padding:"4px 9px"}}>{lb}</button>)}</div>
          </div>
        ))}
        {vu.every(u=>recs.some(r=>r.userId===u.id))&&<div style={{color:G.dim,fontSize:12}}>All accounted for.</div>}
      </div>
    </>
  );
}

function LT({D,vu,P,ST,AN,isA}) {
  const [fl,setFl]=useState("pending");
  const [eid,setEid]=useState(null);
  const [ef,setEf]=useState(null);
  const lvs=(D.leaves||[]).filter(l=>vu.some(u=>u.id===l.userId)&&(fl==="all"||l.status===fl)).sort((a,b)=>new Date(b.appliedOn)-new Date(a.appliedOn));
  const pd=(D.leaves||[]).filter(l=>l.status==="pending"&&vu.some(u=>u.id===l.userId)).length;
  const tL={casual:"🏖",sick:"🤒",compoff:"🔄",halfday:"🌓",early:"🏃"};
  const sc={pending:G.am,approved:G.gr,rejected:G.rd};
  const cs=(id,st)=>{
    updateLeave(id,{status:st,reviewedOn:new Date().toISOString()});
    const l=(D.leaves||[]).find(x=>x.id===id);
    if(l){
      const emailSubject=`Leave ${st.charAt(0).toUpperCase()+st.slice(1)} — Nucleus HRMS`;
      AN(l.userId,`Your ${l.type} leave from ${l.from}${l.to&&l.to!==l.from?" to "+l.to:""} has been ${st}.`,st==="approved"?"success":"error",emailSubject);
    }
    ST(st==="approved"?"✅ Approved!":st==="rejected"?"❌ Rejected":"↩️ Pending");
  };
  return (
    <>
      <div style={{display:"flex",gap:5,marginBottom:10,overflowX:"auto"}}>
        {[["pending",`Pending${pd>0?`(${pd})`:""}`],["approved","Approved"],["rejected","Rejected"],["all","All"]].map(([v,lb])=>(
          <button key={v} onClick={()=>setFl(v)} style={{...B(fl===v?G.gold:G.card),fontSize:12,padding:"6px 10px",border:fl===v?"none":`1px solid ${G.bdr}`,color:fl===v?"#000":"#fff",flexShrink:0}}>{lb}</button>
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
                <FRow label="Type"><select style={I} value={ef.type} onChange={e=>setEf({...ef,type:e.target.value})}>{Object.keys(D.leavePolicy||DP).map(t=><option key={t} value={t}>{t}</option>)}</select></FRow>
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

function RT({D,vu,P,ST,AN}) {
  const rgs=(D.regularizations||[]).filter(r=>vu.some(u=>u.id===r.userId)).sort((a,b)=>new Date(b.appliedOn)-new Date(a.appliedOn));
  const sc={pending:G.am,approved:G.gr,rejected:G.rd};
  const ap=(id)=>{
    const r=(D.regularizations||[]).find(x=>x.id===id);if(!r)return;
    if(r.type==="late_approval"){
      // Late approval: update existing attendance record, clear late mark
      const existingAtt=D.attendance.find(a=>a.userId===r.userId&&a.date===r.date);
      if(existingAtt){updateAttendance(existingAtt.id,{status:"present",lateBy:0,lateApproved:true,graceUsed:false});}
    } else {
      // Regular regularization: add new attendance record
      const newRec={id:gid(),userId:r.userId,userName:r.userName,teamId:r.teamId,date:r.date,checkIn:new Date(`${r.date}T${r.checkIn}`).toISOString(),checkOut:new Date(`${r.date}T${r.checkOut}`).toISOString(),officeName:"Regularized",status:"present",lateBy:0};
      addAttendance(newRec);
    }
    updateReg(id,{status:"approved",reviewedOn:new Date().toISOString()});
    AN(r.userId,`Your ${r.type==="late_approval"?"late arrival approval":"regularization"} for ${r.date} has been approved. Attendance updated.`,"success");
    ST("✅ Approved & attendance updated!");
  };
  const rj=(id)=>{
    const r=(D.regularizations||[]).find(x=>x.id===id);
    updateReg(id,{status:"rejected",reviewedOn:new Date().toISOString()});
    if(r)AN(r.userId,`Regularization for ${r.date} rejected.`,"error");ST("❌ Rejected");
  };
  return (
    <>
      <div style={{...K,background:G.navy,border:`1px solid ${G.navyL}`}}><div style={{color:G.gold,fontWeight:700,fontSize:13}}>📝 Regularization Requests</div><div style={{color:G.dim,fontSize:12,marginTop:3}}>Staff can fix missed attendance entries.</div></div>
      {rgs.length===0&&<div style={{textAlign:"center",color:G.dim,padding:36}}>No requests.</div>}
      {rgs.map(r=>(
        <div key={r.id} style={K}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
            <div><div style={{fontWeight:800}}>{r.userName}</div><div style={{fontSize:13,color:G.gold,marginTop:1}}>📅 {fD(r.date)}</div><div style={{fontSize:12,color:G.mut,marginTop:1}}>🕐 {r.checkIn}→{r.checkOut}</div><div style={{fontSize:12,color:G.dim,fontStyle:"italic"}}>"{r.reason}"</div></div>
            <Chip bg={sc[r.status]||G.dim} label={r.status} sm/>
          </div>
          {r.status==="pending"&&<div style={{display:"flex",gap:8}}><button onClick={()=>ap(r.id)} style={{...B(G.gr),flex:1,fontSize:13}}>✅</button><button onClick={()=>rj(r.id)} style={{...B(G.rd),flex:1,fontSize:13}}>❌</button></div>}
        </div>
      ))}
    </>
  );
}

function PT({D,vu,ST}) {
  const n=new Date(),[yr,setYr]=useState(n.getFullYear()),[mo,setMo]=useState(n.getMonth()+1);
  const ms=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const pol=D.leavePolicy||DP;
  const rows=vu.map(u=>{
    const s=`${yr}-${String(mo).padStart(2,"0")}-01`,e=`${yr}-${String(mo).padStart(2,"0")}-${String(new Date(yr,mo,0).getDate()).padStart(2,"0")}`,wd=wDM(yr,mo);
    const ar=D.attendance.filter(a=>a.userId===u.id&&a.date>=s&&a.date<=e);
    const ap=(D.leaves||[]).filter(l=>l.userId===u.id&&l.status==="approved"&&l.from>=s&&l.from<=e);
    const pr=ar.filter(r=>r.status==="present").length,lt=ar.filter(r=>r.status==="late").length,wf=ar.filter(r=>r.isWFH).length;
    const hd=ap.filter(l=>l.type==="halfday").length,cl=ap.filter(l=>l.type==="casual").length,sl=ap.filter(l=>l.type==="sick").length,co=ap.filter(l=>l.type==="compoff").length;
    const tm=ar.reduce((s,r)=>s+wMin(r.checkIn,r.checkOut),0),am=ar.length?Math.round(tm/ar.length):0;
    const tp=pr+lt+wf,pd=Math.round((tp+(hd*.5)+cl+sl+co)*10)/10,ab=Math.max(0,wd-Math.round(pd));
    const team=D.teams.find(t=>t.id===u.teamId);
    return{id:u.id,name:u.name,email:u.email,team:team?.name||"-",wd,pr,lt,wf,hd,cl,sl,co,tp,pd,ab,lt2:lt,aH:`${Math.floor(am/60)}h${am%60}m`,tH:`${Math.floor(tm/60)}h${tm%60}m`,pct:wd?Math.round((tp/wd)*100):0};
  });
  const exp=()=>{
    const h=["Name","Email","Team","Designation","Reporting To","Working Days","Present","Late","WFH","Half Days","Casual","Sick","CompOff","Total Present","Paid Days","Absent Days","Late (Unregularized)","LOP Days","Grace Used","Avg Hrs","Total Hrs","Attendance%","Month","Year"];
    const dr=rows.map(r=>[r.name,r.email,r.team,r.designation,r.reportingTo,r.wd,r.pr,r.lt,r.wf,r.hd,r.cl,r.sl,r.co,r.tp,r.pd,r.ab,r.lopLate,r.totalLOP,r.graceUsed,r.aH,r.tH,`${r.pct}%`,ms[mo-1],yr]);
    const csv=[h,...dr].map(r=>r.map(c=>`"${c}"`).join(",")).join("\n");
    const a=document.createElement("a");a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);a.download=`Nucleus_Payroll_${ms[mo-1]}_${yr}.csv`;a.click();ST("💰 Payroll exported!");
  };
  return (
    <>
      <div style={{...K,background:G.navy,border:`1px solid ${G.gold}44`}}><div style={{color:G.gold,fontWeight:700,fontSize:13}}>💰 Payroll Report</div><div style={{color:G.dim,fontSize:12,marginTop:3}}>Monthly payroll-ready export for salary processing.</div></div>
      <div style={{display:"flex",gap:8,marginBottom:10}}>
        <div style={{flex:2}}><label style={L}>Month</label><select style={I} value={mo} onChange={e=>setMo(Number(e.target.value))}>{ms.map((m,i)=><option key={i} value={i+1}>{m}</option>)}</select></div>
        <div style={{flex:1}}><label style={L}>Year</label><input type="number" style={I} value={yr} onChange={e=>setYr(Number(e.target.value))}/></div>
      </div>
      <button onClick={exp} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:12,fontSize:14,color:"#000",fontWeight:800}}>📥 Export to Excel</button>
      <div style={{color:G.mut,fontSize:11,fontWeight:700,textTransform:"uppercase",marginBottom:8}}>{ms[mo-1]} {yr} — {wDM(yr,mo)} Working Days</div>
      {rows.map(r=>(
        <div key={r.id} style={K}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
            <div><div style={{fontWeight:800}}>{r.name}</div><div style={{fontSize:12,color:G.dim}}>{r.team}</div></div>
            <div style={{textAlign:"right"}}><div style={{fontSize:20,fontWeight:900,color:r.ab>3?G.rd:G.gold}}>{r.pd}<span style={{fontSize:11,color:G.dim}}>/{r.wd}</span></div><div style={{fontSize:9,color:G.dim}}>paid</div></div>
          </div>
          <div style={{background:G.navy,borderRadius:8,height:7,overflow:"hidden",marginBottom:8}}><div style={{background:r.pct<70?`linear-gradient(90deg,${G.rd},${G.am})`:`linear-gradient(90deg,${G.gold},${G.goldL})`,height:"100%",width:`${r.pct}%`,borderRadius:8}}/></div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:5}}>
            {[["✅Pres",r.pr,G.gr],["⚠️Late",r.lt,G.am],["🏠WFH",r.wf,G.bl],["🌓Half",r.hd,G.pu],["🏖CL",r.cl,G.bl],["🤒SL",r.sl,G.rd],["🔄CO",r.co,G.mut],["❌Ab",r.ab,r.ab>3?G.rd:G.dim],["⏱Hrs",r.tH,G.gold]].map(([lb,v,c])=>(
              <div key={lb} style={{background:G.navy,borderRadius:8,padding:"5px 6px",textAlign:"center"}}><div style={{fontSize:9,color:G.dim,fontWeight:700}}>{lb}</div><div style={{fontSize:13,fontWeight:900,color:c}}>{v}</div></div>
            ))}
          </div>
          {r.lt>0&&<div style={{marginTop:6,background:"#1a0f00",border:`1px solid ${G.am}44`,borderRadius:7,padding:"5px 8px",fontSize:11,color:G.am}}>⚠️ {r.lt} late — apply deduction per policy</div>}
          {r.ab>3&&<div style={{marginTop:4,background:"#1a0000",border:`1px solid ${G.rd}44`,borderRadius:7,padding:"5px 8px",fontSize:11,color:G.rd}}>🚨 {r.ab} absent — high absenteeism</div>}
        </div>
      ))}
    </>
  );
}

function PC({D,P,ST}) {
  const fullPol=D.leavePolicy||DP;
  const [polEmp,setPolEmp]=useState({...fullPol.employee||DP_EMP});
  const [polAA,setPolAA]=useState({...fullPol.articled||DP_AA});
  const [etab,setEtab]=useState("employee");
  const pol=etab==="employee"?polEmp:polAA;
  const setPol=etab==="employee"?setPolEmp:setPolAA;
  const tl={casual:"Casual Leave",sick:"Sick Leave",compoff:"Comp Off",halfday:"Half Day",early:"Early Leaving"};
  const save=()=>{P({...D,leavePolicy:{employee:polEmp,articled:polAA}});ST("✅ Policy saved!");};
  const reset=()=>{setPolEmp({...DP_EMP});setPolAA({...DP_AA});P({...D,leavePolicy:DP});ST("Reset!");};
  return (
    <>
      <div style={{...K,background:G.navy,border:`1px solid ${G.gold}44`}}><div style={{color:G.gold,fontWeight:700,fontSize:13}}>Leave Policy Settings</div><div style={{color:G.dim,fontSize:12,marginTop:3}}>Set annual leave limits separately for Employees and Articled Assistants.</div></div>
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <button onClick={()=>setEtab("employee")} style={{...B(etab==="employee"?G.gold:G.card),flex:1,fontSize:13,color:etab==="employee"?"#000":"#fff",border:etab==="employee"?"none":`1px solid ${G.bdr}`,fontWeight:700}}>Employee</button>
        <button onClick={()=>setEtab("articled")} style={{...B(etab==="articled"?G.gold:G.card),flex:1,fontSize:13,color:etab==="articled"?"#000":"#fff",border:etab==="articled"?"none":`1px solid ${G.bdr}`,fontWeight:700}}>Articled Assistant</button>
      </div>
      <div style={K}>
        <div style={{fontWeight:800,marginBottom:4,color:G.gold,fontSize:14}}>{etab==="employee"?"Employee":"Articled Assistant"} — Annual Allowances</div>
        <div style={{fontSize:11,color:G.dim,marginBottom:12}}>Leaves per year for {etab==="employee"?"regular employees":"articled assistants (CA trainees)"}</div>
        {Object.entries(tl).map(([t,lb])=>(
          <div key={t} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:`1px solid ${G.bdr}`}}>
            <div><div style={{fontWeight:700,fontSize:13}}>{lb}</div><div style={{fontSize:11,color:G.dim}}>{pol[t]} days per year</div></div>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              <button onClick={()=>setPol({...pol,[t]:Math.max(0,pol[t]-1)})} style={{...B(G.card2),padding:"4px 10px",fontSize:15,border:`1px solid ${G.bdr}`}}>−</button>
              <input type="number" value={pol[t]} onChange={e=>setPol({...pol,[t]:Math.max(0,parseInt(e.target.value)||0)})} style={{...I,width:58,textAlign:"center",padding:"7px 5px"}}/>
              <button onClick={()=>setPol({...pol,[t]:pol[t]+1})} style={{...B(G.card2),padding:"4px 10px",fontSize:15,border:`1px solid ${G.bdr}`}}>+</button>
            </div>
          </div>
        ))}
        <div style={{display:"flex",gap:8,marginTop:12}}>
          <button onClick={save} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),flex:2,color:"#000",fontWeight:800}}>Save Policy</button>
          <button onClick={reset} style={{...B(G.dim),flex:1}}>Reset All</button>
        </div>
      </div>
      <div style={K}>
        <div style={{fontWeight:700,marginBottom:8,color:G.gold}}>Staff Usage Summary</div>
        {D.users.filter(u=>u.role!=="admin").map(u=>{
          const uPol=(D.leavePolicy||DP)[(u.employeeType||"employee")]||DP_EMP;
          const ub=Object.keys(uPol).reduce((a,t)=>{a[t]=(D.leaves||[]).filter(l=>l.userId===u.id&&l.type===t&&l.status==="approved").length;return a;},{});
          return(
            <div key={u.id} style={{padding:"8px 0",borderBottom:`1px solid ${G.bdr}`}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <div style={{fontWeight:700,fontSize:13}}>{u.name}</div>
                <Chip bg={u.employeeType==="articled"?G.pu:G.bl} label={u.employeeType==="articled"?"Articled":"Employee"} sm/>
              </div>
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                {Object.entries(uPol).map(([t,mx])=>{const us=ub[t];return(<div key={t} style={{background:G.navy,borderRadius:6,padding:"2px 7px",fontSize:10,border:`1px solid ${us>=mx&&mx>0?G.rd+"44":G.bdr}`}}><span style={{color:G.dim}}>{t}:</span><span style={{color:us>=mx&&mx>0?G.rd:G.gold,fontWeight:700}}>{us}/{mx}</span></div>);})}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function HC({D,P,ST}) {
  const [sa,setSa]=useState(false);
  const [f,setF]=useState({date:"",name:""});
  const hs=(D.holidays||[]).sort((a,b)=>a.date.localeCompare(b.date));
  const add=()=>{if(!f.date||!f.name)return ST("Date and name required","error");P({...D,holidays:[...(D.holidays||[]),{...f,id:gid()}]});ST("Added!");setSa(false);setF({date:"",name:""});};
  return (
    <>
      <div style={{...K,background:G.navy,border:`1px solid ${G.gold}44`}}><div style={{color:G.gold,fontWeight:700,fontSize:13}}>🎉 Holidays</div><div style={{color:G.dim,fontSize:12,marginTop:3}}>Holidays are excluded from absent counts.</div></div>
      <button onClick={()=>setSa(!sa)} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:10,color:"#000",fontWeight:800}}>{sa?"✕ Cancel":"+ Add Holiday"}</button>
      {sa&&(<div style={{...K,marginBottom:10}}><FRow label="Date"><input type="date" style={I} value={f.date} onChange={e=>setF({...f,date:e.target.value})}/></FRow><FRow label="Name"><input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="e.g. Diwali"/></FRow><button onClick={add} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#000",fontWeight:800}}>Add</button></div>)}
      {hs.map(h=>(
        <div key={h.id} style={{...K,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{fontWeight:700}}>🎉 {h.name}</div><div style={{fontSize:12,color:G.mut,marginTop:2}}>{fD(h.date)}</div></div>
          <button onClick={()=>{if(!confirm("Remove?"))return;P({...D,holidays:(D.holidays||[]).filter(x=>x.id!==h.id)});}} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:12,padding:"5px 9px"}}>✕</button>
        </div>
      ))}
    </>
  );
}

function SC({D,P,ST}) {
  const [sa,setSa]=useState(false);
  const [editU,setEditU]=useState(null);
  const emptyF={name:"",email:"",password:"pass123",role:"staff",employeeType:"employee",teamId:"",officeIds:[],reportingTo:"",designation:"",weeklyOff:"sun_sat",articleshipStart:""};
  const [f,setF]=useState(emptyF);

  const save=()=>{
    if(!f.name||!f.email)return ST("Name and email required","error");
    if(editU){
      P({...D,users:D.users.map(u=>u.id===editU?{...u,...f}:u)});
      ST("✅ Updated!");
    } else {
      P({...D,users:[...D.users,{...f,id:gid()}]});
      ST("✅ Added!");
    }
    setSa(false);setEditU(null);setF(emptyF);
  };

  const startEdit=(u)=>{
    setF({
      name:u.name,email:u.email,password:u.password||"",
      role:u.role,employeeType:u.employeeType||"employee",
      teamId:u.teamId||"",officeIds:u.officeIds||[],
      reportingTo:u.reportingTo||"",designation:u.designation||"",
      weeklyOff:u.weeklyOff||"sun_sat",articleshipStart:u.articleshipStart||""
    });
    setEditU(u.id);setSa(true);
    window.scrollTo(0,0);
  };

  const roleColor={admin:G.rd,hr:G.pu,hod:G.bl,manager:G.navyL,staff:G.card2};

  return (
    <>
      <button onClick={()=>{setSa(!sa);if(sa){setEditU(null);setF(emptyF);}}} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:10,color:"#000",fontWeight:800}}>
        {sa&&!editU?"✕ Cancel":editU?"✕ Cancel Edit":"+ Add Staff"}
      </button>

      {sa&&(
        <div style={{...K,marginBottom:12,border:`1px solid ${editU?G.bl:G.bdr}`}}>
          <div style={{fontWeight:800,color:editU?G.bl:G.gold,marginBottom:10}}>
            {editU?"✏️ Edit Staff":"👤 New Staff Member"}
          </div>
          <FRow label="Full Name">
            <input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="e.g. Priya Sharma"/>
          </FRow>
          <FRow label="Email">
            <input style={I} value={f.email} onChange={e=>setF({...f,email:e.target.value})} placeholder="priya@nucleusadvisors.in"/>
          </FRow>
          <FRow label="Password">
            <input style={I} type="password" value={f.password} onChange={e=>setF({...f,password:e.target.value})}/>
          </FRow>
          <FRow label="Role">
            <select style={I} value={f.role} onChange={e=>setF({...f,role:e.target.value})}>
              <option value="staff">Staff</option>
              <option value="manager">Manager</option>
              <option value="hod">HOD (Head of Department)</option>
              <option value="hr">HR Manager</option>
            </select>
          </FRow>
          <FRow label="Employee Type">
            <select style={I} value={f.employeeType} onChange={e=>setF({...f,employeeType:e.target.value})}>
              <option value="employee">Employee</option>
              <option value="articled">Articled Assistant (CA)</option>
            </select>
          </FRow>
          <FRow label="Designation">
            <input style={I} value={f.designation||""} onChange={e=>setF({...f,designation:e.target.value})} placeholder="e.g. Senior Associate"/>
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
          <FRow label="Offices">
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
              {D.offices.map(o=>{
                const sel=(f.officeIds||[]).includes(o.id);
                return(
                  <button key={o.id} onClick={()=>setF({...f,officeIds:sel?(f.officeIds||[]).filter(i=>i!==o.id):[...(f.officeIds||[]),o.id]})} style={{...B(sel?G.gold:G.card2),fontSize:12,padding:"5px 10px",color:sel?"#000":"#fff",border:sel?"none":`1px solid ${G.bdr}`}}>
                    {o.name}
                  </button>
                );
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
            <button onClick={save} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),flex:2,color:"#000",fontWeight:800}}>
              {editU?"💾 Save Changes":"➕ Add Staff"}
            </button>
            <button onClick={()=>{setSa(false);setEditU(null);setF(emptyF);}} style={{...B(G.dim),flex:1}}>Cancel</button>
          </div>
        </div>
      )}

      {D.users.filter(u=>u.role!=="admin").map(u=>{
        const team=D.teams.find(t=>t.id===u.teamId);
        const mgr=D.users.find(x=>x.id===u.reportingTo);
        return(
          <div key={u.id} style={{...K,display:"flex",gap:10,alignItems:"flex-start"}}>
            <div style={{width:40,height:40,borderRadius:"50%",background:roleColor[u.role]||G.card2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>
              {u.role==="hr"?"🧑‍💼":u.role==="hod"?"🏛":u.role==="manager"?"👔":"👤"}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:13}}>{u.name}{u.designation&&<span style={{fontSize:11,color:G.mut,fontWeight:400}}> — {u.designation}</span>}</div>
              <div style={{fontSize:11,color:G.dim,marginTop:1}}>{u.email}</div>
              <div style={{fontSize:11,color:G.mut,marginTop:1}}>{team?.name||"No team"} · {(u.officeIds||[]).length} office(s)</div>
              {mgr&&<div style={{fontSize:11,color:G.mut}}>Reports to: <span style={{color:G.gold}}>{mgr.name}</span></div>}
              <div style={{display:"flex",gap:4,flexWrap:"wrap",marginTop:4}}>
                <Chip bg={roleColor[u.role]||G.dim} label={ROLE_LABELS[u.role]||u.role} sm/>
                <Chip bg={u.employeeType==="articled"?G.pu:G.bl} label={u.employeeType==="articled"?"Articled":"Employee"} sm/>
                {u.weeklyOff&&<Chip bg={G.card2} label={WEEKLY_OFF_OPTIONS.find(o=>o.value===u.weeklyOff)?.label||u.weeklyOff} sm/>}
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6,flexShrink:0}}>
              <button onClick={()=>startEdit(u)} style={{...B(G.bl),fontSize:11,padding:"6px 10px"}}>✏️ Edit</button>
              <button onClick={()=>{
                const np=prompt(`Reset password for ${u.name}:`);
                if(!np)return;
                if(np.length<6)return ST("Password must be at least 6 characters","error");
                P({...D,users:D.users.map(x=>x.id===u.id?{...x,password:np,firstLogin:true}:x)});
                ST(`✅ Password reset for ${u.name}. They will be asked to change on next login.`);
              }} style={{...B(G.am),fontSize:11,padding:"6px 10px"}}>🔑 Reset</button>
              <button onClick={()=>{if(!confirm(`Remove ${u.name}?`))return;P({...D,users:D.users.filter(x=>x.id!==u.id)});ST("Removed!");}} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:11,padding:"6px 10px"}}>✕</button>
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
  const emptyTF={name:"",shiftStart:"09:30",shiftEnd:"18:30"};
  const [f,setF]=useState(emptyTF);
  const saveTeam=()=>{
    if(!f.name)return ST("Name required","error");
    if(editT){P({...D,teams:D.teams.map(t=>t.id===editT?{...t,...f}:t)});ST("✅ Updated!");}
    else{P({...D,teams:[...D.teams,{...f,id:gid()}]});ST("✅ Created!");}
    setSa(false);setEditT(null);setF(emptyTF);
  };
  const startEditT=(t)=>{setF({name:t.name,shiftStart:t.shiftStart,shiftEnd:t.shiftEnd});setEditT(t.id);setSa(true);}
  return (
    <>
      <button onClick={()=>setSa(!sa)} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:10,color:"#000",fontWeight:800}}>{sa?"✕ Cancel":"+ Add Team"}</button>
      {sa&&(<div style={{...K,marginBottom:10}}><FRow label="Name"><input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="Tax & Regulatory"/></FRow><div style={{display:"flex",gap:8}}><FRow label="Start"><input type="time" style={I} value={f.shiftStart} onChange={e=>setF({...f,shiftStart:e.target.value})}/></FRow><FRow label="End"><input type="time" style={I} value={f.shiftEnd} onChange={e=>setF({...f,shiftEnd:e.target.value})}/></FRow></div><button onClick={()=>{if(!f.name)return ST("Name required","error");P({...D,teams:[...D.teams,{...f,id:gid()}]});ST("Created!");setSa(false);}} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#000",fontWeight:800}}>Create</button></div>)}
      {D.teams.map(t=>(
        <div key={t.id} style={{...K,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{fontWeight:700}}>{t.name}</div><div style={{fontSize:12,color:G.mut}}>🕘 {t.shiftStart}–{t.shiftEnd} · {D.users.filter(u=>u.teamId===t.id).length} members</div></div>
          <div style={{display:"flex",gap:6}}>
          <button onClick={()=>startEditT(t)} style={{...B(G.bl),fontSize:11,padding:"5px 9px"}}>✏️</button>
          <button onClick={()=>{if(!confirm("Delete?"))return;P({...D,teams:D.teams.filter(x=>x.id!==t.id)});}} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:11,padding:"5px 9px"}}>✕</button>
        </div>
        </div>
      ))}
    </>
  );
}


function ORG({D,vu}) {
  const renderUser=(u,depth=0)=>{
    const reports=vu.filter(x=>x.reportingTo===u.id);
    const team=D.teams.find(t=>t.id===u.teamId);
    const roleColors={admin:G.rd,hr:G.pu,hod:G.bl,manager:G.navyL,staff:G.card2};
    return (
      <div key={u.id} style={{marginLeft:depth*20,marginBottom:8}}>
        <div style={{background:G.card,border:`1px solid ${roleColors[u.role]||G.bdr}`,borderRadius:12,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:34,height:34,borderRadius:"50%",background:roleColors[u.role]||G.card2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>
            {u.role==="admin"?"👑":u.role==="hr"?"🧑‍💼":u.role==="hod"?"🏛":u.role==="manager"?"👔":"👤"}
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:700,fontSize:13}}>{u.name}</div>
            <div style={{fontSize:11,color:G.mut}}>{ROLE_LABELS[u.role]||u.role}{u.designation?` — ${u.designation}`:""}</div>
            {team&&<div style={{fontSize:10,color:G.dim}}>{team.name}</div>}
          </div>
          <Chip bg={roleColors[u.role]||G.dim} label={ROLE_LABELS[u.role]||u.role} sm/>
        </div>
        {reports.length>0&&(
          <div style={{marginLeft:10,marginTop:4,paddingLeft:10,borderLeft:`2px solid ${G.bdr}`}}>
            {reports.map(r=>renderUser(r,0))}
          </div>
        )}
      </div>
    );
  };

  // Find top-level users (no reporting manager or reporting to admin)
  const topLevel=vu.filter(u=>!u.reportingTo||u.reportingTo===""||u.role==="admin"||u.role==="hr"||u.role==="hod");
  const admins=D.users.filter(u=>u.role==="admin");

  return (
    <div style={{maxWidth:500}}>
      <div style={{...K,background:G.navy,border:`1px solid ${G.gold}44`}}>
        <div style={{color:G.gold,fontWeight:700,fontSize:13}}>🏛 Organisation Hierarchy</div>
        <div style={{color:G.dim,fontSize:12,marginTop:3}}>Reporting structure of your organisation.</div>
      </div>
      {admins.map(u=>renderUser(u,0))}
      {topLevel.filter(u=>u.role!=="admin").map(u=>renderUser(u,0))}
    </div>
  );
}
function RST({D,P,ST,logout}) {
  const [pwd,setPwd]=useState("");
  const [confirm,setConfirm]=useState("");
  const [step,setStep]=useState("menu");
  const ADMIN_PWD="Nucleus123#";

  const verify=(next)=>{
    if(pwd!==ADMIN_PWD)return ST("Incorrect admin password","error");
    setStep(next);setPwd("");
  };
  const resetData=()=>{
    if(confirm!=="RESET DATA")return ST('Type RESET DATA to confirm',"error");
    P({...D,attendance:[],leaves:[],regularizations:[],liveLocations:{},notifications:[]});
    setStep("done");setConfirm("");ST("✅ Data cleared!");
  };
  const resetFull=()=>{
    if(confirm!=="FACTORY RESET")return ST('Type FACTORY RESET to confirm',"error");
    P({...INIT_CONFIG,...EMPTY_STATE,loading:false});
    setStep("done");setConfirm("");ST("✅ Factory reset complete!");
  };
  const resetUsers=()=>{
    if(confirm!=="RESET USERS")return ST('Type RESET USERS to confirm',"error");
    const adminOnly=D.users.filter(u=>u.role==="admin");
    P({...D,users:adminOnly,attendance:[],leaves:[],regularizations:[],liveLocations:{},notifications:[]});
    setStep("done");setConfirm("");ST("✅ Staff removed!");
  };

  if(step==="done") return (
    <div style={{maxWidth:440,margin:"0 auto"}}>
      <div style={{...K,background:"#0d2010",border:`1px solid ${G.gr}`,textAlign:"center",padding:32}}>
        <div style={{fontSize:48,marginBottom:12}}>✅</div>
        <div style={{fontWeight:800,fontSize:18,color:G.gr,marginBottom:8}}>Reset Complete</div>
        <div style={{fontSize:13,color:G.mut,marginBottom:20}}>Selected data has been permanently deleted.</div>
        <button onClick={()=>{setStep("menu");logout();}} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#000",fontWeight:800}}>Logout & Restart Fresh</button>
      </div>
    </div>
  );

  if(step==="menu") return (
    <div style={{maxWidth:440,margin:"0 auto"}}>
      <div style={{...K,background:"#1a0a00",border:`1px solid ${G.rd}`,marginBottom:16}}>
        <div style={{color:G.rd,fontWeight:800,fontSize:14,marginBottom:4}}>⚠️ Danger Zone</div>
        <div style={{fontSize:12,color:G.mut}}>All reset actions are permanent and cannot be undone.</div>
      </div>
      <div style={K}>
        <div style={{fontWeight:800,fontSize:14,color:G.am,marginBottom:6}}>🗑 Level 1 — Reset All Data</div>
        <div style={{fontSize:12,color:G.mut,marginBottom:4}}>Deletes attendance, leaves, locations. Keeps users and settings.</div>
        <button onClick={()=>setStep("pwd_data")} style={{...B(G.am),width:"100%",fontSize:13}}>Proceed →</button>
      </div>
      <div style={K}>
        <div style={{fontWeight:800,fontSize:14,color:G.rd,marginBottom:6}}>🔄 Level 2 — Factory Reset</div>
        <div style={{fontSize:12,color:G.mut,marginBottom:4}}>Wipes everything. Only admin account kept.</div>
        <button onClick={()=>setStep("pwd_full")} style={{...B(G.rd),width:"100%",fontSize:13}}>Proceed →</button>
      </div>
      <div style={K}>
        <div style={{fontWeight:800,fontSize:14,color:G.pu,marginBottom:6}}>👥 Level 3 — Reset Staff & Data</div>
        <div style={{fontSize:12,color:G.mut,marginBottom:4}}>Removes all staff and data. Offices and teams stay.</div>
        <button onClick={()=>setStep("pwd_users")} style={{...B(G.pu),width:"100%",fontSize:13}}>Proceed →</button>
      </div>
    </div>
  );

  if(step==="pwd_data"||step==="pwd_full"||step==="pwd_users") return (
    <div style={{maxWidth:440,margin:"0 auto"}}>
      <div style={K}>
        <button onClick={()=>setStep("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:14}}>← Back</button>
        <div style={{fontWeight:800,color:step==="pwd_full"?G.rd:step==="pwd_users"?G.pu:G.am,fontSize:15,marginBottom:12}}>Enter Admin Password</div>
        <FRow label="Admin Password"><input type="password" style={I} value={pwd} onChange={e=>setPwd(e.target.value)} placeholder="Enter password"/></FRow>
        <button onClick={()=>verify(step==="pwd_data"?"confirm_data":step==="pwd_full"?"confirm_full":"confirm_users")} style={{...B(step==="pwd_full"?G.rd:step==="pwd_users"?G.pu:G.am),width:"100%",fontWeight:700}}>Verify →</button>
      </div>
    </div>
  );

  if(step==="confirm_data") return (
    <div style={{maxWidth:440,margin:"0 auto"}}>
      <div style={{...K,border:`1px solid ${G.am}`}}>
        <button onClick={()=>setStep("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:14}}>← Back</button>
        <div style={{fontWeight:800,color:G.am,fontSize:15,marginBottom:12}}>Type RESET DATA to confirm</div>
        <FRow label="Confirmation"><input style={I} value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="RESET DATA"/></FRow>
        <button onClick={resetData} style={{...B(G.am),width:"100%",fontWeight:800}}>Confirm Reset</button>
      </div>
    </div>
  );

  if(step==="confirm_full") return (
    <div style={{maxWidth:440,margin:"0 auto"}}>
      <div style={{...K,border:`1px solid ${G.rd}`}}>
        <button onClick={()=>setStep("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:14}}>← Back</button>
        <div style={{fontWeight:800,color:G.rd,fontSize:15,marginBottom:12}}>Type FACTORY RESET to confirm</div>
        <FRow label="Confirmation"><input style={I} value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="FACTORY RESET"/></FRow>
        <button onClick={resetFull} style={{...B(G.rd),width:"100%",fontWeight:800}}>Confirm Factory Reset</button>
      </div>
    </div>
  );

  return (
    <div style={{maxWidth:440,margin:"0 auto"}}>
      <div style={{...K,border:`1px solid ${G.pu}`}}>
        <button onClick={()=>setStep("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:14}}>← Back</button>
        <div style={{fontWeight:800,color:G.pu,fontSize:15,marginBottom:12}}>Type RESET USERS to confirm</div>
        <FRow label="Confirmation"><input style={I} value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="RESET USERS"/></FRow>
        <button onClick={resetUsers} style={{...B(G.pu),width:"100%",fontWeight:800}}>Confirm Reset Staff</button>
      </div>
    </div>
  );
}

function OC({D,P,ST}) {
  const [sa,setSa]=useState(false);
  const [editO,setEditO]=useState(null);
  const emptyOF={name:"",lat:"",lng:"",radius:50};
  const [f,setF]=useState(emptyOF);
  const [dt,setDt]=useState(false);
  const [search,setSearch]=useState("");
  const [searching,setSearching]=useState(false);

  const det=()=>{
    setDt(true);
    navigator.geolocation?.getCurrentPosition(p=>{
      setF(prev=>({...prev,lat:p.coords.latitude.toFixed(6),lng:p.coords.longitude.toFixed(6)}));
      setDt(false);
    },()=>{ST("Cannot detect location","error");setDt(false);},{enableHighAccuracy:true,timeout:10000});
  };

  const searchLocation=async()=>{
    if(!search.trim())return ST("Enter a location to search","error");
    setSearching(true);
    try{
      const res=await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(search)}&limit=1`);
      const data=await res.json();
      if(data&&data[0]){
        setF(prev=>({...prev,lat:parseFloat(data[0].lat).toFixed(6),lng:parseFloat(data[0].lon).toFixed(6)}));
        ST("📍 Location found!");
      } else {
        ST("Location not found. Try a different search.","error");
      }
    } catch(e){ST("Search failed. Try using GPS instead.","error");}
    setSearching(false);
  };

  const saveOffice=()=>{
    if(!f.name||!f.lat||!f.lng)return ST("Name and location required","error");
    const rec={...f,lat:parseFloat(f.lat),lng:parseFloat(f.lng),radius:parseInt(f.radius)};
    if(editO){P({...D,offices:D.offices.map(o=>o.id===editO?{...o,...rec}:o)});ST("✅ Updated!");}
    else{P({...D,offices:[...D.offices,{...rec,id:gid()}]});ST("✅ Added!");}
    setSa(false);setEditO(null);setF(emptyOF);setSearch("");
  };

  const startEditO=(o)=>{setF({name:o.name,lat:String(o.lat),lng:String(o.lng),radius:o.radius});setEditO(o.id);setSa(true);}
  return (
    <>
      <button onClick={()=>setSa(!sa)} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:10,color:"#000",fontWeight:800}}>{sa?"✕ Cancel":"+ Add Office"}</button>
      {sa&&(
        <div style={{...K,marginBottom:10}}>
          <div style={{fontWeight:800,color:G.gold,marginBottom:10}}>{editO?"✏️ Edit Office":"🏢 New Office"}</div>
          <FRow label="Office Name">
            <input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="e.g. Delhi Office"/>
          </FRow>
          <FRow label="Search Location by Name">
            <div style={{display:"flex",gap:8}}>
              <input style={{...I,flex:1}} value={search} onChange={e=>setSearch(e.target.value)} placeholder="e.g. Connaught Place Delhi" onKeyDown={e=>e.key==="Enter"&&searchLocation()}/>
              <button onClick={searchLocation} style={{...B(G.bl),padding:"11px 16px",flexShrink:0,borderRadius:10}}>{searching?"⏳":"🔍"}</button>
            </div>
          </FRow>
          <button onClick={det} style={{...B(G.pu),width:"100%",marginBottom:10,borderRadius:10}}>{dt?"Detecting location…":"📍 Use My Current Location"}</button>
          {(f.lat||f.lng)&&(
            <div style={{background:G.navy,borderRadius:10,padding:"8px 12px",marginBottom:10,fontSize:12,color:G.gold}}>
              📍 {f.lat}, {f.lng}
              {f.lat&&f.lng&&<a href={`https://maps.google.com/?q=${f.lat},${f.lng}`} target="_blank" rel="noreferrer" style={{color:G.bl,marginLeft:8,textDecoration:"none"}}>View on Map ↗</a>}
            </div>
          )}
          <div style={{display:"flex",gap:8}}>
            <FRow label="Latitude"><input style={I} value={f.lat} onChange={e=>setF({...f,lat:e.target.value})} placeholder="28.6139"/></FRow>
            <FRow label="Longitude"><input style={I} value={f.lng} onChange={e=>setF({...f,lng:e.target.value})} placeholder="77.2090"/></FRow>
          </div>
          <FRow label="Geofence Radius (meters)">
            <input type="number" style={I} value={f.radius} onChange={e=>setF({...f,radius:e.target.value})} placeholder="50"/>
          </FRow>
          <div style={{fontSize:11,color:G.dim,marginBottom:10}}>Staff must be within this radius to check in at this office.</div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={saveOffice} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),flex:2,color:"#000",fontWeight:800}}>{editO?"💾 Save Changes":"✅ Add Office"}</button>
            <button onClick={()=>{setSa(false);setEditO(null);setF(emptyOF);setSearch("");}} style={{...B(G.dim),flex:1}}>Cancel</button>
          </div>
        </div>
      )}
      {D.offices.map(o=>(
        <div key={o.id} style={{...K,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{fontWeight:700}}>🏢 {o.name}</div><div style={{fontSize:12,color:G.mut}}>📍 {o.lat},{o.lng} · {o.radius}m</div></div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>startEditO(o)} style={{...B(G.bl),fontSize:11,padding:"5px 9px"}}>✏️</button>
            <button onClick={()=>{if(!confirm("Delete?"))return;P({...D,offices:D.offices.filter(x=>x.id!==o.id)});}} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:11,padding:"5px 9px"}}>✕</button>
          </div>
        </div>
      ))}
    </>
  );
}