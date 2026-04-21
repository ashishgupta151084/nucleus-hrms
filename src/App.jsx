import { useState } from "react";

export default function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div style={{minHeight:"100vh",background:"#0a0f1e",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"sans-serif"}}>
      <div style={{background:"#111827",padding:32,borderRadius:16,width:"100%",maxWidth:380,border:"1px solid #1e3a5f"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{fontSize:24,fontWeight:900,color:"#c9a84c"}}>Nucleus HRMS</div>
          <div style={{fontSize:11,color:"#8a9bb5",marginTop:4}}>HR MANAGEMENT SYSTEM</div>
        </div>
        <div style={{marginBottom:12}}>
          <label style={{fontSize:11,color:"#8a9bb5",display:"block",marginBottom:4}}>EMAIL</label>
          <input
            type="email"
            value={email}
            onChange={e=>setEmail(e.target.value)}
            placeholder="you@nucleusadvisors.in"
            style={{width:"100%",padding:"11px 14px",borderRadius:10,border:"1px solid #1e3a5f",background:"#0d1f3c",color:"#e8dcc8",fontSize:14,boxSizing:"border-box"}}
          />
        </div>
        <div style={{marginBottom:20}}>
          <label style={{fontSize:11,color:"#8a9bb5",display:"block",marginBottom:4}}>PASSWORD</label>
          <input
            type="password"
            value={password}
            onChange={e=>setPassword(e.target.value)}
            placeholder="••••••••"
            style={{width:"100%",padding:"11px 14px",borderRadius:10,border:"1px solid #1e3a5f",background:"#0d1f3c",color:"#e8dcc8",fontSize:14,boxSizing:"border-box"}}
          />
        </div>
        <button
          onClick={()=>alert(`Login: ${email}`)}
          style={{width:"100%",padding:14,background:"linear-gradient(135deg,#c9a84c,#a07830)",color:"#000",border:"none",borderRadius:10,fontSize:15,fontWeight:800,cursor:"pointer"}}
        >
          Sign In →
        </button>
        <div style={{textAlign:"center",marginTop:16,fontSize:11,color:"#4a5a72"}}>
          Developed by Ashish Gupta
        </div>
      </div>
    </div>
  );
}
