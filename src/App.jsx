import { useState, useEffect, useRef, useCallback } from "react";
import {
  getConfig, setConfig, onConfig,
  addAttendance, updateAttendance, onAttendance,
  addLeave, updateLeave, deleteLeave, onLeaves,
  addReg, updateReg, onRegs,
  updateLiveLocation, onLiveLocations,
  addNotification, updateNotification, onNotifications
} from "./firebase";

const gid=()=>Math.random().toString(36).substr(2,9);
const tod=()=>new Date().toISOString().split("T")[0];
const fT=(d)=>new Date(d).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const fD=(d)=>new Date(d).toLocaleDateString([],{day:"2-digit",month:"short",year:"numeric"});
const dist=(a,b,c,d)=>{const R=6371000,dL=((c-a)*Math.PI)/180,dl=((d-b)*Math.PI)/180,x=Math.sin(dL/2)**2+Math.cos((a*Math.PI)/180)*Math.cos((c*Math.PI)/180)*Math.sin(dl/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));};
const lateBy=(ci,ss)=>{const [h,m]=ss.split(":").map(Number),s=new Date(ci);s.setHours(h,m,0,0);return Math.max(0,Math.round((new Date(ci)-s)/60000));};
const wMin=(a,b)=>b?Math.round((new Date(b)-new Date(a))/60000):0;
const wHr=(a,b)=>{const m=wMin(a,b);return m?`${Math.floor(m/60)}h${m%60}m`:null;};
const wDM=(y,m)=>{let c=0;const d=new Date(y,m-1,1);while(d.getMonth()===m-1){if(d.getDay()&&d.getDay()<6)c++;d.setDate(d.getDate()+1);}return c;};
const isHL=(ds,hs)=>(hs||[]).some(h=>h.date===ds);
const isWE=(ds)=>{const d=new Date(ds);return!d.getDay()||d.getDay()===6;};
const ld=(k,f)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):f;}catch{return f;}};
const sv=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch{}};

const DP_EMP={casual:12,sick:12,compoff:6,halfday:24,early:12};
const DP_AA={casual:0,sick:7,compoff:0,halfday:0,early:0};
const DP={employee:DP_EMP,articled:DP_AA};
const SEED={
  companyName:"Nucleus HRMS",
  offices:[{id:"o1",name:"Gurugram HQ",lat:28.4595,lng:77.0266,radius:50},{id:"o2",name:"Noida Branch",lat:28.5355,lng:77.391,radius:50}],
  teams:[{id:"t1",name:"Investment Banking",shiftStart:"09:30",shiftEnd:"18:30"},{id:"t2",name:"Risk Advisory",shiftStart:"09:00",shiftEnd:"18:00"},{id:"t3",name:"Tax & Regulatory",shiftStart:"09:30",shiftEnd:"18:30"}],
  users:[
    {id:"u1",name:"Ashish Gupta",email:"ag@nucleusadvisors.in",password:"Nucleus123#",role:"admin",teamId:null,officeIds:["o1","o2"],customShift:null,managedTeams:["t1","t2","t3"]},
    {id:"u2",name:"Raj Sharma",email:"raj@nucleusadvisors.in",password:"pass123",role:"manager",employeeType:"employee",teamId:"t1",officeIds:["o1"],customShift:null,managedTeams:["t1","t2"]},
    {id:"u3",name:"Priya Patel",email:"priya@nucleusadvisors.in",password:"pass123",role:"staff",employeeType:"employee",teamId:"t1",officeIds:["o1"],customShift:null},
    {id:"u4",name:"Amit Singh",email:"amit@nucleusadvisors.in",password:"pass123",role:"staff",employeeType:"articled",teamId:"t2",officeIds:["o1","o2"],customShift:{shiftStart:"10:00",shiftEnd:"19:00"}},
  ],
  attendance:[],leaves:[],liveLocations:{},leavePolicy:DP,
  holidays:[{id:"h1",date:"2026-01-26",name:"Republic Day"},{id:"h2",date:"2026-08-15",name:"Independence Day"},{id:"h3",date:"2026-10-02",name:"Gandhi Jayanti"},{id:"h4",date:"2026-11-08",name:"Diwali"},{id:"h5",date:"2026-12-25",name:"Christmas"}],
  notifications:[],regularizations:[],
};

const G={bg:"#0a0f1e",card:"#111827",card2:"#1a2235",bdr:"#1e3a5f",gold:"#c9a84c",goldL:"#e8c97a",goldD:"#a07830",navy:"#0d1f3c",navyL:"#1a3a6b",txt:"#e8dcc8",mut:"#8a9bb5",dim:"#4a5a72",gr:"#10b981",rd:"#ef4444",am:"#f59e0b",bl:"#3b82f6",pu:"#8b5cf6"};
const B=(bg,x={})=>({background:bg,color:"#fff",border:"none",borderRadius:10,padding:"12px 18px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",...x});
const I={width:"100%",padding:"11px 14px",borderRadius:10,border:`1px solid ${G.bdr}`,background:G.navy,color:G.txt,fontSize:14,fontFamily:"inherit",boxSizing:"border-box"};
const L={fontSize:11,color:G.mut,marginBottom:4,display:"block",fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase"};
const K={background:G.card,border:`1px solid ${G.bdr}`,borderRadius:16,padding:18,marginBottom:12};

const Chip=({bg,label,sm})=>(
  <span style={{background:bg,color:"#fff",fontSize:sm?10:11,fontWeight:700,padding:sm?"2px 7px":"3px 10px",borderRadius:20}}>{label}</span>
);
const FRow=({label,children})=>(
  <div style={{marginBottom:12}}><label style={L}>{label}</label>{children}</div>
);

const Logo=({s=32})=>(
  <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
    <circle cx="20" cy="20" r="18" stroke={G.gold} strokeWidth="2.5" fill="none"/>
    <circle cx="20" cy="20" r="6" fill={G.gold}/>
    <ellipse cx="20" cy="20" rx="18" ry="7" stroke={G.goldL} strokeWidth="1.5" fill="none" transform="rotate(45 20 20)"/>
    <ellipse cx="20" cy="20" rx="18" ry="7" stroke={G.goldL} strokeWidth="1.5" fill="none" transform="rotate(-45 20 20)"/>
  </svg>
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
    <div style={{textAlign:"center",padding:20,color:G.rd}}>
      <div style={{fontSize:36}}>📷</div>
      <p style={{fontSize:13}}>{err}</p>
      <button onClick={onCancel} style={B(G.dim)}>Back</button>
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
        <button onClick={snap} disabled={!ok} style={{...B(ok?G.gold:"#555"),flex:2,color:ok?"#000":"#fff"}}>📸 Take Selfie</button>
      </div>
    </div>
  );
}

export default function App() {
  const [D,setD]=useState({...SEED,attendance:[],leaves:[],regularizations:[],liveLocations:{},notifications:[]});
  const [cu,setCu]=useState(()=>ld("nau5",null));
  const [sc,setSc]=useState("login");
  const [toast,setToast]=useState(null);

  useEffect(()=>{
    const unsub=onConfig(cfg=>{
      if(cfg&&cfg.users&&cfg.users.length>0){
        setD(prev=>({...prev,...cfg}));
      } else {
        const init={companyName:SEED.companyName,users:SEED.users,offices:SEED.offices,teams:SEED.teams,leavePolicy:SEED.leavePolicy,holidays:SEED.holidays};
        setConfig(init).catch(()=>{});
      }
    });
    return unsub;
  },[]);

  useEffect(()=>{const unsub=onAttendance(r=>setD(p=>({...p,attendance:r})));return unsub;},[]);
  useEffect(()=>{const unsub=onLeaves(r=>setD(p=>({...p,leaves:r})));return unsub;},[]);
  useEffect(()=>{const unsub=onRegs(r=>setD(p=>({...p,regularizations:r})));return unsub;},[]);
  useEffect(()=>{const unsub=onLiveLocations(r=>setD(p=>({...p,liveLocations:r})));return unsub;},[]);
  useEffect(()=>{
    if(!cu)return;
    const unsub=onNotifications(cu.id,r=>setD(p=>({...p,notifications:r})));
    return unsub;
  },[cu?.id]);
  useEffect(()=>{
    if(!cu||cu.role==="admin")return;
    const w=navigator.geolocation?.watchPosition(p=>{
      updateLiveLocation(cu.id,{lat:p.coords.latitude,lng:p.coords.longitude,ac:Math.round(p.coords.accuracy),ts:new Date().toISOString()});
    },null,{enableHighAccuracy:true,maximumAge:30000});
    return()=>navigator.geolocation?.clearWatch(w);
  },[cu?.id]);

  const ST=(msg,type="success")=>{setToast({msg,type});setTimeout(()=>setToast(null),3000);};
  const P=useCallback(nd=>{
    setD(nd);
    const {users,offices,teams,leavePolicy,holidays,companyName}=nd;
    setConfig({users,offices,teams,leavePolicy,holidays,companyName});
  },[]);
  const AN=useCallback((uid,msg,type="info")=>{
    addNotification({id:gid(),userId:uid,msg,type,ts:new Date().toISOString(),read:false});
  },[]);

  useEffect(()=>{
    if(cu) setSc(cu.role==="admin"?"dash":"home");
    else setSc("login");
  },[cu]);

  const login=(e,p)=>{
    const u=(D.users||[]).find(u=>u.email===e&&u.password===p);
    if(!u)return ST("Invalid credentials","error");
    setCu(u);sv("nau5",u);
  };
  const logout=()=>{setCu(null);sv("nau5",null);setSc("login");};
  const unread=(D.notifications||[]).filter(n=>n.userId===cu?.id&&!n.read).length;
  const props={user:cu,D,P,ST,AN,logout,setSc,unread};
  return (
    <div style={{fontFamily:"'Nunito',sans-serif",background:G.bg,minHeight:"100vh",color:G.txt}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');*{box-sizing:border-box}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:${G.navyL};border-radius:3px}input::placeholder,textarea::placeholder{color:${G.dim}}select option{background:${G.card}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
      {sc==="login"&&<Login login={login} name={D.companyName}/>}
      {sc==="home"&&<Home {...props}/>}
      {sc==="hist"&&<Hist {...props}/>}
      {sc==="lv"&&<Lv {...props}/>}
      {sc==="notif"&&<Notif {...props}/>}
      {sc==="reg"&&<Reg {...props}/>}
      {sc==="teamdash"&&<Dash {...props}/>}
      {sc==="dash"&&<Dash {...props}/>}
      {toast&&<Msg t={toast}/>}
    </div>
  );
}

function Login({login,name}) {
  const [e,setE]=useState(""),[p,setP]=useState("");
  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,background:`linear-gradient(135deg,${G.bg},${G.navy})`}}>
      <div style={{width:"100%",maxWidth:400}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:10}}><Logo s={48}/><div style={{textAlign:"left"}}><div style={{fontSize:22,fontWeight:900,color:G.gold}}>Nucleus Advisors</div><div style={{fontSize:11,color:G.mut,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.1em"}}>HR Management System</div></div></div>
          <div style={{width:80,height:2,background:`linear-gradient(90deg,transparent,${G.gold},transparent)`,margin:"0 auto"}}/>
        </div>
        <div style={{...K,padding:24,marginBottom:12}}>
          <FRow label="Email"><input style={I} type="email" value={e} onChange={x=>setE(x.target.value)} placeholder="you@nucleusadvisors.in"/></FRow>
          <FRow label="Password"><input style={I} type="password" value={p} onChange={x=>setP(x.target.value)} placeholder="••••••••" onKeyDown={x=>x.key==="Enter"&&login(e,p)}/></FRow>
          <button onClick={()=>login(e,p)} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",fontSize:15,padding:14,color:"#000",fontWeight:800}}>Sign In →</button>
        </div>
        <div style={{...K,padding:14}}>
          <p style={{color:G.dim,fontSize:11,margin:"0 0 8px",fontWeight:700,textTransform:"uppercase"}}>Demo — tap to fill</p>
          {[["ag@nucleusadvisors.in","Nucleus123#","👑 Admin"],["raj@nucleusadvisors.in","pass123","👔 Manager"],["priya@nucleusadvisors.in","pass123","👤 Staff"]].map(([em,pw,r])=>(
            <div key={em} onClick={()=>{setE(em);setP(pw);}} style={{fontSize:12,color:G.mut,marginBottom:4,cursor:"pointer",padding:"4px 8px",borderRadius:6,background:G.navy}}>
              <span style={{color:G.gold,fontWeight:700}}>{r}</span>: {em}
            </div>
          ))}
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
  const [step,setStep]=useState("idle"),[selfie,setSelfie]=useState(null),[gps,setGps]=useState(null),[office,setOffice]=useState(null),[locErr,setLocErr]=useState(null),[wfh,setWfh]=useState(false);
  const rec=D.attendance.find(a=>a.userId===user.id&&a.date===tod());
  const tm=D.teams.find(t=>t.id===user.teamId);
  const sh=user.customShift||(tm?{shiftStart:tm.shiftStart,shiftEnd:tm.shiftEnd}:null);
  const pl=(D.leaves||[]).filter(l=>l.userId===user.id&&l.status==="pending").length;
  const hol=isHL(tod(),D.holidays)?(D.holidays||[]).find(h=>h.date===tod())?.name:null;
  const now=new Date();
  const onSelfie=img=>{
    setSelfie(img);
    if(wfh){setStep("confirm");return;}
    setStep("loc");
    navigator.geolocation?.getCurrentPosition(pos=>{
      const{latitude:la,longitude:lo}=pos.coords;setGps({lat:la,lng:lo});
      const near=(user.officeIds||[]).map(id=>D.offices.find(o=>o.id===id)).filter(Boolean).find(o=>dist(la,lo,o.lat,o.lng)<=o.radius);
      if(near){setOffice(near);setStep("confirm");}else{setLocErr("Not within 50m of any assigned office.");setStep("err");}
    },()=>{setLocErr("Could not get location.");setStep("err");},{enableHighAccuracy:true,timeout:15000});
  };
  const doIn=()=>{
    const lb=(!wfh&&sh)?lateBy(new Date().toISOString(),sh.shiftStart):0;
    P({...D,attendance:[...D.attendance,{id:gid(),userId:user.id,userName:user.name,teamId:user.teamId,date:tod(),checkIn:new Date().toISOString(),checkOut:null,selfie,gps:wfh?null:gps,officeName:wfh?"WFH":office?.name,status:wfh?"wfh":lb>30?"late":"present",lateBy:lb,isWFH:wfh}]});
    ST(wfh?"🏠 WFH done!":lb>30?`⚠️ ${lb}m late`:"✅ Checked in!");setStep("done");
  };
  const doOut=()=>{
    const go=cg=>{P({...D,attendance:D.attendance.map(a=>a.id===rec.id?{...a,checkOut:new Date().toISOString(),checkOutGps:cg}:a)});ST("👋 Out!");};
    navigator.geolocation?.getCurrentPosition(p=>go({lat:p.coords.latitude,lng:p.coords.longitude}),()=>go(null));
  };
  return (
    <div style={{maxWidth:440,margin:"0 auto",padding:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}><Logo s={28}/><div><div style={{fontSize:10,color:G.gold,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em"}}>Nucleus Advisors</div><div style={{fontSize:16,fontWeight:800}}>{user.name}</div></div></div>
        <div style={{display:"flex",gap:6}}>
          <button onClick={()=>setSc("notif")} style={{...B(G.card),padding:"8px 11px",border:`1px solid ${G.bdr}`,fontSize:13,position:"relative"}}>{unread>0&&<span style={{position:"absolute",top:-4,right:-4,background:G.rd,color:"#fff",borderRadius:"50%",width:15,height:15,fontSize:9,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900}}>{unread}</span>}🔔</button>
          <button onClick={logout} style={{...B(G.card),fontSize:12,padding:"8px 12px",border:`1px solid ${G.bdr}`}}>Out</button>
        </div>
      </div>
      {(hol||isWE(tod()))&&(
        <div style={{background:`linear-gradient(135deg,${G.navy},${G.navyL})`,border:`1px solid ${G.gold}`,borderRadius:14,padding:"12px 16px",marginBottom:14,display:"flex",gap:10,alignItems:"center"}}>
          <div style={{fontSize:26}}>{hol?"🎉":"🌟"}</div>
          <div><div style={{color:G.gold,fontWeight:800,fontSize:14}}>{hol||"Weekend"}</div><div style={{color:G.mut,fontSize:12}}>No attendance needed</div></div>
        </div>
      )}
      <div style={{background:`linear-gradient(135deg,${G.navy},${G.navyL})`,border:`1px solid ${G.gold}`,borderRadius:20,padding:22,marginBottom:14,textAlign:"center"}}>
        <div style={{fontSize:40,fontWeight:900,color:G.gold}}>{now.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</div>
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
            {step==="err"&&<div style={{textAlign:"center"}}><div style={{fontSize:32,marginBottom:8}}>🚫</div><p style={{color:G.rd,fontSize:13,marginBottom:12}}>{locErr}</p><button onClick={()=>setStep("idle")} style={B(G.dim)}>Try Again</button></div>}
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
        {[["History","hist"],["Leaves"+(pl>0?` (${pl})`:""  ),"lv"],["Regularize","reg"],["Notifications"+(unread>0?` (${unread})`:""  ),"notif"],...(user.role==="manager"?[["My Team","teamdash"]]:[]  )].map(([lb,s])=>(
          <button key={s} onClick={()=>setSc(s)} style={{...B(G.card),border:`1px solid ${G.bdr}`,fontSize:12,padding:10,fontWeight:600}}>{lb}</button>
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
  const workDays=allDays.filter(ds=>!isWE(ds)&&!isHL(ds,D.holidays));
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
  const tL={casual:"🏖 Casual",sick:"🤒 Sick",compoff:"🔄 CompOff",halfday:"🌓 Half Day",early:"🏃 Early"};
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
  const markAll=()=>P({...D,notifications:(D.notifications||[]).map(n=>n.userId===user.id?{...n,read:true}:n)});
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
  const [f,setF]=useState({date:tod(),reason:"",checkIn:"09:30",checkOut:"18:30"});
  const submit=()=>{
    if(!f.reason.trim())return ST("Please add reason","error");
    P({...D,regularizations:[...(D.regularizations||[]),{id:gid(),userId:user.id,userName:user.name,teamId:user.teamId,...f,appliedOn:new Date().toISOString(),status:"pending"}]});
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
  const isA=user.role==="admin";
  const tabs=isA?[["ov","Overview"],["live","Live"],["att","Records"],["lv","Leaves"],["rg","Regularize"],["pay","Payroll"],["pol","Policy"],["hol","Holidays"],["st","Staff"],["tm","Teams"],["of","Offices"],["rst","⚙ Reset"]]:[["ov","Overview"],["live","Live"],["att","Records"],["lv","Leaves"],["rg","Regularize"],["pay","Payroll"]];
  const vu=isA?D.users.filter(u=>u.role!=="admin"):D.users.filter(u=>u.role==="staff"&&(user.managedTeams||[]).includes(u.teamId));
  const pL=(D.leaves||[]).filter(l=>l.status==="pending"&&vu.some(u=>u.id===l.userId)).length;
  const pR=(D.regularizations||[]).filter(r=>r.status==="pending"&&vu.some(u=>u.id===r.userId)).length;
  const tp={D,P,ST,AN,vu,isA};
  return (
    <div style={{maxWidth:500,margin:"0 auto",padding:"14px 14px 80px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{display:"flex",gap:10,alignItems:"center"}}><Logo s={26}/><div><div style={{fontSize:10,color:G.gold,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em"}}>{isA?"Admin":"Manager"}</div><div style={{fontSize:16,fontWeight:900}}>{user.name}</div></div></div>
        <button onClick={logout} style={{...B(G.card),fontSize:12,padding:"8px 12px",border:`1px solid ${G.bdr}`}}>Logout</button>
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
        const nr=D.offices.reduce((b,o)=>{const d=dist(loc.lat,loc.lng,o.lat,o.lng);return(!b||d<b.d)?{...o,d}:b;},null);
        const at=nr&&nr.d<=nr.radius,ago=Math.round((new Date()-new Date(loc.ts))/60000);
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
  const [fd,setFd]=useState(tod()),[fu,setFu]=useState("all"),[sel,setSel]=useState(null);
  const recs=D.attendance.filter(a=>{if(fd&&a.date!==fd)return false;if(fu!=="all"&&a.userId!==fu)return false;return vu.some(u=>u.id===a.userId);}).sort((a,b)=>new Date(b.checkIn)-new Date(a.checkIn));
  const exp=()=>{
    const rows=[["Name","Date","In","Out","Hours","Late","Office","WFH","Status"],...recs.map(r=>[r.userName,r.date,fT(r.checkIn),r.checkOut?fT(r.checkOut):"",r.checkOut?wHr(r.checkIn,r.checkOut):"",r.lateBy||0,r.officeName||"",r.isWFH?"Y":"N",r.status])].map(r=>r.map(c=>`"${c}"`).join(",")).join("\n");
    const a=document.createElement("a");a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(rows);a.download=`att_${fd}.csv`;a.click();ST("📊 Exported!");
  };
  const mk=(uid,status)=>{
    const ex=D.attendance.find(a=>a.userId===uid&&a.date===fd);
    const na=ex?D.attendance.map(a=>a.id===ex.id?{...a,status}:a):[...D.attendance,{id:gid(),userId:uid,userName:vu.find(u=>u.id===uid)?.name,date:fd,checkIn:new Date().toISOString(),checkOut:null,officeName:"Manual",status,lateBy:0}];
    P({...D,attendance:na});ST(`Marked ${status}`);
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
  const [fl,setFl]=useState("pending"),[eid,setEid]=useState(null),[ef,setEf]=useState(null);
  const lvs=(D.leaves||[]).filter(l=>vu.some(u=>u.id===l.userId)&&(fl==="all"||l.status===fl)).sort((a,b)=>new Date(b.appliedOn)-new Date(a.appliedOn));
  const pd=(D.leaves||[]).filter(l=>l.status==="pending"&&vu.some(u=>u.id===l.userId)).length;
  const tL={casual:"🏖",sick:"🤒",compoff:"🔄",halfday:"🌓",early:"🏃"};
  const sc={pending:G.am,approved:G.gr,rejected:G.rd};
  const cs=(id,st)=>{
    const nl=(D.leaves||[]).map(l=>l.id===id?{...l,status:st,reviewedOn:new Date().toISOString()}:l);
    P({...D,leaves:nl});
    const l=(D.leaves||[]).find(x=>x.id===id);
    if(l)AN(l.userId,`Your ${l.type} leave has been ${st}.`,st==="approved"?"success":"error");
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
                  {isA&&<button onClick={()=>{if(!confirm("Delete?"))return;P({...D,leaves:(D.leaves||[]).filter(x=>x.id!==l.id)});ST("Deleted");}} style={{...B(G.dim),fontSize:11,padding:"5px 9px"}}>🗑</button>}
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
    const na=[...D.attendance,{id:gid(),userId:r.userId,userName:r.userName,teamId:r.teamId,date:r.date,checkIn:new Date(`${r.date}T${r.checkIn}`).toISOString(),checkOut:new Date(`${r.date}T${r.checkOut}`).toISOString(),officeName:"Regularized",status:"present",lateBy:0}];
    P({...D,attendance:na,regularizations:(D.regularizations||[]).map(x=>x.id===id?{...x,status:"approved"}:x)});
    AN(r.userId,`Regularization for ${r.date} approved.`,"success");ST("✅ Approved!");
  };
  const rj=(id)=>{
    const r=(D.regularizations||[]).find(x=>x.id===id);
    P({...D,regularizations:(D.regularizations||[]).map(x=>x.id===id?{...x,status:"rejected"}:x)});
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
    const h=["Name","Email","Team","Working Days","Present","Late","WFH","Half Days","Casual","Sick","CompOff","Total Present","Paid Days","Absent","Late Count","Avg Hrs","Total Hrs","Attendance%","Month","Year"];
    const dr=rows.map(r=>[r.name,r.email,r.team,r.wd,r.pr,r.lt,r.wf,r.hd,r.cl,r.sl,r.co,r.tp,r.pd,r.ab,r.lt2,r.aH,r.tH,`${r.pct}%`,ms[mo-1],yr]);
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
  const [sa,setSa]=useState(false),[f,setF]=useState({date:"",name:""});
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
  const [sa,setSa]=useState(false),[f,setF]=useState({name:"",email:"",password:"pass123",role:"staff",employeeType:"employee",teamId:"",officeIds:[]});
  const add=()=>{if(!f.name||!f.email)return ST("Name and email required","error");P({...D,users:[...D.users,{...f,id:gid()}]});ST("Added!");setSa(false);setF({name:"",email:"",password:"pass123",role:"staff",employeeType:"employee",teamId:"",officeIds:[]});};
  return (
    <>
      <button onClick={()=>setSa(!sa)} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:10,color:"#000",fontWeight:800}}>{sa?"✕ Cancel":"+ Add Staff/Manager"}</button>
      {sa&&(<div style={{...K,marginBottom:10}}>
        <FRow label="Name"><input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="Priya Sharma"/></FRow>
        <FRow label="Email"><input style={I} value={f.email} onChange={e=>setF({...f,email:e.target.value})} placeholder="priya@nucleusadvisors.in"/></FRow>
        <FRow label="Password"><input style={I} value={f.password} onChange={e=>setF({...f,password:e.target.value})}/></FRow>
        <FRow label="Role"><select style={I} value={f.role} onChange={e=>setF({...f,role:e.target.value})}><option value="staff">Staff</option><option value="manager">Manager</option></select></FRow>
        <FRow label="Employee Type"><select style={I} value={f.employeeType} onChange={e=>setF({...f,employeeType:e.target.value})}><option value="employee">Employee</option><option value="articled">Articled Assistant</option></select></FRow>
        <FRow label="Team"><select style={I} value={f.teamId} onChange={e=>setF({...f,teamId:e.target.value})}><option value="">No Team</option>{D.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></FRow>
        <FRow label="Offices"><div style={{display:"flex",flexWrap:"wrap",gap:6}}>{D.offices.map(o=>{const s=f.officeIds.includes(o.id);return(<button key={o.id} onClick={()=>setF({...f,officeIds:s?f.officeIds.filter(i=>i!==o.id):[...f.officeIds,o.id]})} style={{...B(s?G.gold:G.card2),fontSize:12,padding:"5px 10px",color:s?"#000":"#fff",border:s?"none":`1px solid ${G.bdr}`}}>{o.name}</button>);})}</div></FRow>
        <button onClick={add} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#000",fontWeight:800}}>Add</button>
      </div>)}
      {D.users.filter(u=>u.role!=="admin").map(u=>(
        <div key={u.id} style={{...K,display:"flex",gap:10,alignItems:"flex-start"}}>
          <div style={{width:38,height:38,borderRadius:"50%",background:u.role==="manager"?G.pu:G.navyL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>{u.role==="manager"?"👔":"👤"}</div>
          <div style={{flex:1,minWidth:0}}><div style={{fontWeight:700,fontSize:13}}>{u.name}</div><div style={{fontSize:11,color:G.dim}}>{u.email}</div><div style={{fontSize:11,color:G.mut,marginTop:1}}>{D.teams.find(t=>t.id===u.teamId)?.name||"No team"} · {(u.officeIds||[]).length} office(s)</div><Chip bg={u.role==="manager"?G.pu:G.navyL} label={u.role.toUpperCase()} sm/></div>
          <button onClick={()=>{if(!confirm("Remove?"))return;P({...D,users:D.users.filter(x=>x.id!==u.id)});}} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:12,padding:"5px 9px"}}>✕</button>
        </div>
      ))}
    </>
  );
}

function TC({D,P,ST}) {
  const [sa,setSa]=useState(false),[f,setF]=useState({name:"",shiftStart:"09:30",shiftEnd:"18:30"});
  return (
    <>
      <button onClick={()=>setSa(!sa)} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:10,color:"#000",fontWeight:800}}>{sa?"✕ Cancel":"+ Add Team"}</button>
      {sa&&(<div style={{...K,marginBottom:10}}><FRow label="Name"><input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="Tax & Regulatory"/></FRow><div style={{display:"flex",gap:8}}><FRow label="Start"><input type="time" style={I} value={f.shiftStart} onChange={e=>setF({...f,shiftStart:e.target.value})}/></FRow><FRow label="End"><input type="time" style={I} value={f.shiftEnd} onChange={e=>setF({...f,shiftEnd:e.target.value})}/></FRow></div><button onClick={()=>{if(!f.name)return ST("Name required","error");P({...D,teams:[...D.teams,{...f,id:gid()}]});ST("Created!");setSa(false);}} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#000",fontWeight:800}}>Create</button></div>)}
      {D.teams.map(t=>(
        <div key={t.id} style={{...K,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{fontWeight:700}}>{t.name}</div><div style={{fontSize:12,color:G.mut}}>🕘 {t.shiftStart}–{t.shiftEnd} · {D.users.filter(u=>u.teamId===t.id).length} members</div></div>
          <button onClick={()=>{if(!confirm("Delete?"))return;P({...D,teams:D.teams.filter(x=>x.id!==t.id)});}} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:12,padding:"5px 9px"}}>✕</button>
        </div>
      ))}
    </>
  );
}

function RST({D,P,ST,logout}) {
  const [pwd,setPwd]=useState("");
  const [confirm,setConfirm]=useState("");
  const [step,setStep]=useState("menu"); // menu | pwd_data | pwd_full | pwd_users | done
  const ADMIN_PWD="Nucleus123#";

  const verify=(next)=>{
    if(pwd!==ADMIN_PWD)return ST("Incorrect admin password","error");
    setStep(next);setPwd("");
  };

  // Level 1: Reset all transactional data only (attendance, leaves, regs, locations)
  const resetData=()=>{
    if(confirm!=="RESET DATA")return ST('Type "RESET DATA" to confirm',"error");
    P({...D,attendance:[],leaves:[],regularizations:[],liveLocations:{},notifications:[]});
    setStep("done");setConfirm("");
    ST("✅ All data cleared. Users and settings kept.");
  };

  // Level 2: Full factory reset — wipe everything back to blank
  const resetFull=()=>{
    if(confirm!=="FACTORY RESET")return ST('Type "FACTORY RESET" to confirm',"error");
    const blank={
      companyName:"Nucleus HRMS",
      offices:[],teams:[],
      users:[{id:"u1",name:"Ashish Gupta",email:"ag@nucleusadvisors.in",password:"Nucleus123#",role:"admin",teamId:null,officeIds:[],customShift:null,managedTeams:[]}],
      attendance:[],leaves:[],regularizations:[],liveLocations:{},notifications:[],
      leavePolicy:DP,
      holidays:[{id:"h1",date:"2026-01-26",name:"Republic Day"},{id:"h2",date:"2026-08-15",name:"Independence Day"},{id:"h3",date:"2026-10-02",name:"Gandhi Jayanti"},{id:"h4",date:"2026-11-08",name:"Diwali"},{id:"h5",date:"2026-12-25",name:"Christmas"}],
    };
    P(blank);setStep("done");setConfirm("");
    ST("✅ Factory reset complete. All data and users wiped.");
  };

  // Level 3: Reset only staff users (keep admin, offices, teams, settings)
  const resetUsers=()=>{
    if(confirm!=="RESET USERS")return ST('Type "RESET USERS" to confirm',"error");
    const adminOnly=D.users.filter(u=>u.role==="admin");
    P({...D,users:adminOnly,attendance:[],leaves:[],regularizations:[],liveLocations:{},notifications:[]});
    setStep("done");setConfirm("");
    ST("✅ All staff removed. Admin account kept.");
  };

  const statusColors={menu:G.navy,done:G.gr};
  if(step==="done") return (
    <div style={{maxWidth:440,margin:"0 auto"}}>
      <div style={{...K,background:"#0d2010",border:`1px solid ${G.gr}`,textAlign:"center",padding:32}}>
        <div style={{fontSize:48,marginBottom:12}}>✅</div>
        <div style={{fontWeight:800,fontSize:18,color:G.gr,marginBottom:8}}>Reset Complete</div>
        <div style={{fontSize:13,color:G.mut,marginBottom:20}}>The selected data has been permanently deleted.</div>
        <button onClick={()=>{setStep("menu");logout();}} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#000",fontWeight:800}}>Logout & Restart Fresh</button>
      </div>
    </div>
  );

  return (
    <div style={{maxWidth:440,margin:"0 auto"}}>
      {/* Warning banner */}
      <div style={{...K,background:"#1a0a00",border:`1px solid ${G.rd}`,marginBottom:16}}>
        <div style={{color:G.rd,fontWeight:800,fontSize:14,marginBottom:4}}>⚠️ Danger Zone</div>
        <div style={{fontSize:12,color:G.mut}}>All reset actions are permanent and cannot be undone. Make sure you have exported any data you need before proceeding.</div>
      </div>

      {step==="menu" && (<>
        {/* Option 1 */}
        <div style={K}>
          <div style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:12}}>
            <div style={{width:40,height:40,borderRadius:10,background:"#1a1000",border:`1px solid ${G.am}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>🗑</div>
            <div>
              <div style={{fontWeight:800,fontSize:14,color:G.am}}>Level 1 — Reset All Data</div>
              <div style={{fontSize:12,color:G.mut,marginTop:3}}>Deletes all attendance records, leaves, regularizations and live locations.</div>
              <div style={{fontSize:11,color:G.dim,marginTop:2}}>✓ Keeps: Users, offices, teams, policies, holidays</div>
            </div>
          </div>
          <button onClick={()=>setStep("pwd_data")} style={{...B(G.am),width:"100%",fontSize:13}}>Proceed to Reset Data →</button>
        </div>

        {/* Option 2 */}
        <div style={K}>
          <div style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:12}}>
            <div style={{width:40,height:40,borderRadius:10,background:"#1a0a00",border:`1px solid ${G.rd}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>🔄</div>
            <div>
              <div style={{fontWeight:800,fontSize:14,color:G.rd}}>Level 2 — Full Factory Reset</div>
              <div style={{fontSize:12,color:G.mut,marginTop:3}}>Wipes everything — all users, data, settings. App goes back to day one.</div>
              <div style={{fontSize:11,color:G.dim,marginTop:2}}>✓ Keeps: Only admin account (ag@nucleusadvisors.in)</div>
            </div>
          </div>
          <button onClick={()=>setStep("pwd_full")} style={{...B(G.rd),width:"100%",fontSize:13}}>Proceed to Factory Reset →</button>
        </div>

        {/* Option 3 */}
        <div style={K}>
          <div style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:12}}>
            <div style={{width:40,height:40,borderRadius:10,background:"#0a001a",border:`1px solid ${G.pu}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>👥</div>
            <div>
              <div style={{fontWeight:800,fontSize:14,color:G.pu}}>Level 3 — Reset Staff & Data</div>
              <div style={{fontSize:12,color:G.mut,marginTop:3}}>Removes all staff/managers and clears all data. Offices, teams and settings stay.</div>
              <div style={{fontSize:11,color:G.dim,marginTop:2}}>✓ Keeps: Offices, teams, policies, holidays, admin</div>
            </div>
          </div>
          <button onClick={()=>setStep("pwd_users")} style={{...B(G.pu),width:"100%",fontSize:13}}>Proceed to Reset Staff →</button>
        </div>
      </>)}

      {/* Password + Confirm step */}
      {(step==="pwd_data"||step==="pwd_full"||step==="pwd_users")&&(
        <div style={K}>
          <button onClick={()=>setStep("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:14}}>← Back</button>
          <div style={{fontWeight:800,color:step==="pwd_full"?G.rd:step==="pwd_users"?G.pu:G.am,fontSize:15,marginBottom:4}}>
            {step==="pwd_data"?"🗑 Reset All Data":step==="pwd_full"?"🔄 Factory Reset":"👥 Reset Staff & Data"}
          </div>
          <div style={{fontSize:12,color:G.mut,marginBottom:16}}>Enter your admin password to continue.</div>
          <FRow label="Admin Password">
            <input type="password" style={I} value={pwd} onChange={e=>setPwd(e.target.value)} placeholder="Enter admin password"/>
          </FRow>
          <button onClick={()=>verify(step==="pwd_data"?"confirm_data":step==="pwd_full"?"confirm_full":"confirm_users")} style={{...B(step==="pwd_full"?G.rd:step==="pwd_users"?G.pu:G.am),width:"100%",fontWeight:700}}>Verify Password →</button>
        </div>
      )}

      {step==="confirm_data"&&(
        <div style={{...K,border:`1px solid ${G.am}`}}>
          <button onClick={()=>setStep("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:14}}>← Back</button>
          <div style={{fontWeight:800,color:G.am,fontSize:15,marginBottom:4}}>🗑 Final Confirmation</div>
          <div style={{fontSize:12,color:G.mut,marginBottom:16}}>This will permanently delete all attendance, leaves and location data. Type <span style={{color:G.am,fontWeight:700}}>RESET DATA</span> to confirm.</div>
          <FRow label="Type RESET DATA to confirm">
            <input style={I} value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="RESET DATA"/>
          </FRow>
          <button onClick={resetData} style={{...B(G.am),width:"100%",fontWeight:800}}>Confirm Reset Data</button>
        </div>
      )}

      {step==="confirm_full"&&(
        <div style={{...K,border:`1px solid ${G.rd}`}}>
          <button onClick={()=>setStep("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:14}}>← Back</button>
          <div style={{fontWeight:800,color:G.rd,fontSize:15,marginBottom:4}}>🔄 Final Confirmation — Factory Reset</div>
          <div style={{fontSize:12,color:G.mut,marginBottom:16}}>This will permanently wipe EVERYTHING. Type <span style={{color:G.rd,fontWeight:700}}>FACTORY RESET</span> to confirm.</div>
          <FRow label="Type FACTORY RESET to confirm">
            <input style={I} value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="FACTORY RESET"/>
          </FRow>
          <button onClick={resetFull} style={{...B(G.rd),width:"100%",fontWeight:800}}>Confirm Factory Reset</button>
        </div>
      )}

      {step==="confirm_users"&&(
        <div style={{...K,border:`1px solid ${G.pu}`}}>
          <button onClick={()=>setStep("menu")} style={{...B(G.card2),border:`1px solid ${G.bdr}`,fontSize:12,padding:"6px 12px",marginBottom:14}}>← Back</button>
          <div style={{fontWeight:800,color:G.pu,fontSize:15,marginBottom:4}}>👥 Final Confirmation</div>
          <div style={{fontSize:12,color:G.mut,marginBottom:16}}>This will remove all staff and their data. Type <span style={{color:G.pu,fontWeight:700}}>RESET USERS</span> to confirm.</div>
          <FRow label="Type RESET USERS to confirm">
            <input style={I} value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="RESET USERS"/>
          </FRow>
          <button onClick={resetUsers} style={{...B(G.pu),width:"100%",fontWeight:800}}>Confirm Reset Staff</button>
        </div>
      )}
    </div>
  );
}

function OC({D,P,ST}) {
  const [sa,setSa]=useState(false),[f,setF]=useState({name:"",lat:"",lng:"",radius:50}),[dt,setDt]=useState(false);
  const det=()=>{setDt(true);navigator.geolocation?.getCurrentPosition(p=>{setF({...f,lat:p.coords.latitude.toFixed(6),lng:p.coords.longitude.toFixed(6)});setDt(false);},()=>{ST("Cannot detect","error");setDt(false);});};
  return (
    <>
      <button onClick={()=>setSa(!sa)} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",marginBottom:10,color:"#000",fontWeight:800}}>{sa?"✕ Cancel":"+ Add Office"}</button>
      {sa&&(<div style={{...K,marginBottom:10}}>
        <FRow label="Name"><input style={I} value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="Delhi Office"/></FRow>
        <button onClick={det} style={{...B(G.pu),width:"100%",marginBottom:10}}>{dt?"Detecting…":"📍 Use My Location"}</button>
        <div style={{display:"flex",gap:8}}><FRow label="Latitude"><input style={I} value={f.lat} onChange={e=>setF({...f,lat:e.target.value})}/></FRow><FRow label="Longitude"><input style={I} value={f.lng} onChange={e=>setF({...f,lng:e.target.value})}/></FRow></div>
        <FRow label="Radius (m)"><input type="number" style={I} value={f.radius} onChange={e=>setF({...f,radius:e.target.value})}/></FRow>
        <button onClick={()=>{if(!f.name||!f.lat||!f.lng)return ST("Name and location required","error");P({...D,offices:[...D.offices,{...f,id:gid(),lat:parseFloat(f.lat),lng:parseFloat(f.lng),radius:parseInt(f.radius)}]});ST("Added!");setSa(false);}} style={{...B(`linear-gradient(135deg,${G.gold},${G.goldD})`),width:"100%",color:"#000",fontWeight:800}}>Add Office</button>
      </div>)}
      {D.offices.map(o=>(
        <div key={o.id} style={{...K,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{fontWeight:700}}>🏢 {o.name}</div><div style={{fontSize:12,color:G.mut}}>📍 {o.lat},{o.lng} · {o.radius}m</div></div>
          <button onClick={()=>{if(!confirm("Delete?"))return;P({...D,offices:D.offices.filter(x=>x.id!==o.id)});}} style={{...B(G.card2),border:`1px solid ${G.rd}`,color:G.rd,fontSize:12,padding:"5px 9px"}}>✕</button>
        </div>
      ))}
    </>
  );
}
