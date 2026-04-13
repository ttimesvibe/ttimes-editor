import { useState, useEffect } from "react";
import { C, FN } from "../utils/styles.js";
import { loadDictionary, saveDictionaryToServer } from "../utils/dictionary.js";

export function ShareModal({ shareUrl, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",zIndex:200,
    display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.sf,borderRadius:16,padding:28,
      width:480,border:`1px solid ${C.bd}`}}>
      <div style={{fontSize:17,fontWeight:700,color:C.tx,marginBottom:6}}>🔗 공유 링크 생성 완료</div>
      <div style={{fontSize:13,color:C.txM,marginBottom:16}}>
        아래 링크를 편집자에게 전달하세요. 30일간 유효합니다.
      </div>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        <input readOnly value={shareUrl}
          style={{flex:1,padding:"9px 12px",borderRadius:8,border:`1px solid ${C.bd}`,
            background:"rgba(0,0,0,0.3)",color:C.tx,fontSize:12,fontFamily:"monospace",outline:"none"}}
          onFocus={e=>e.target.select()}/>
        <button onClick={copy} style={{padding:"9px 16px",borderRadius:8,border:"none",
          background:copied?C.ok:C.ac,color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer",
          minWidth:72,transition:"background 0.2s"}}>
          {copied?"✓ 복사됨":"복사"}
        </button>
      </div>
      <div style={{fontSize:12,color:C.txD,marginBottom:20}}>
        🔗 링크를 아는 사람은 열람 및 편집이 가능합니다.
      </div>
      <div style={{display:"flex",justifyContent:"flex-end"}}>
        <button onClick={onClose} style={{padding:"8px 20px",borderRadius:6,border:`1px solid ${C.bd}`,
          background:"transparent",color:C.txM,fontSize:13,cursor:"pointer"}}>닫기</button>
      </div>
    </div>
  </div>;
}

export function SessionListModal({ config, onLoad, onClose }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    if (!config.workerUrl || config.apiMode === "mock") { setLoading(false); return; }
    const _tk = localStorage.getItem("ttimes_token");
    fetch(`${config.workerUrl}/sessions`, { headers: _tk ? { "Authorization": `Bearer ${_tk}` } : {} })
      .then(r => r.json())
      .then(d => { if (d.success) setSessions(d.sessions || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [config]);

  const handleDelete = async (id) => {
    if (!confirm("이 세션을 삭제할까요?")) return;
    setDeleting(id);
    try {
      const _tk = localStorage.getItem("ttimes_token");
      await fetch(`${config.workerUrl}/sessions/delete`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(_tk ? { "Authorization": `Bearer ${_tk}` } : {}) },
        body: JSON.stringify({ id }),
      });
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch {}
    setDeleting(null);
  };

  const formatDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const mm = String(d.getMonth()+1).padStart(2,"0");
    const dd = String(d.getDate()).padStart(2,"0");
    const hh = String(d.getHours()).padStart(2,"0");
    const mi = String(d.getMinutes()).padStart(2,"0");
    return `${mm}/${dd} ${hh}:${mi}`;
  };

  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",zIndex:200,
    display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.sf,borderRadius:16,padding:28,
      width:560,maxHeight:"80vh",display:"flex",flexDirection:"column",border:`1px solid ${C.bd}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontSize:17,fontWeight:700,color:C.tx}}>📋 작업 히스토리</div>
        <button onClick={onClose} style={{background:"none",border:"none",color:C.txD,cursor:"pointer",fontSize:18}}>✕</button>
      </div>
      <div style={{fontSize:12,color:C.txD,marginBottom:12}}>
        KV에 저장된 세션 목록입니다. 클릭하면 해당 작업을 불러옵니다.
      </div>
      <div style={{flex:1,overflowY:"auto"}}>
        {loading && <div style={{padding:32,textAlign:"center",color:C.txM}}>불러오는 중...</div>}
        {!loading && sessions.length === 0 && <div style={{padding:32,textAlign:"center",color:C.txD}}>저장된 세션이 없습니다</div>}
        {sessions.map(s => (
          <div key={s.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",
            borderRadius:8,border:`1px solid ${C.bd}`,marginBottom:6,cursor:"pointer",
            background:"rgba(255,255,255,0.02)",transition:"background 0.12s"}}
            onMouseEnter={e=>e.currentTarget.style.background="rgba(74,108,247,0.08)"}
            onMouseLeave={e=>e.currentTarget.style.background="rgba(255,255,255,0.02)"}
            onClick={()=>onLoad(s.id)}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:14,fontWeight:600,color:C.tx,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {s.fn || "제목 없음"}
              </div>
              <div style={{fontSize:11,color:C.txD,marginTop:2,display:"flex",gap:8}}>
                <span>{formatDate(s.savedAt)}</span>
                <span>{s.blockCount || 0}블록</span>
                {s.hasGuide && <span style={{color:C.hBd}}>가이드 ✓</span>}
                <span style={{fontFamily:"monospace",color:C.txD}}>{s.id}</span>
              </div>
            </div>
            <button onClick={e=>{e.stopPropagation();handleDelete(s.id)}}
              disabled={deleting===s.id}
              style={{fontSize:11,padding:"4px 8px",borderRadius:4,border:`1px solid ${C.bd}`,
                background:"transparent",color:C.txD,cursor:"pointer",flexShrink:0}}>
              {deleting===s.id?"...":"삭제"}
            </button>
          </div>
        ))}
      </div>
    </div>
  </div>;
}

export function SettingsModal({ config, onSave, onClose }) {
  const [m, setM] = useState(config.apiMode);
  const [u, setU] = useState(config.workerUrl);
  const [gk, setGk] = useState(""); // 더 이상 사용 안 함 — Worker에서 관리
  const [f, setF] = useState(config.fillers.join(", "));
  const [t, setT] = useState(Object.entries(config.customTerms).map(([k,v])=>`${k}=${v.join(",")}`).join("\n"));
  const [cs, setCs] = useState(config.chunkSize);
  // 비밀번호 변경
  const [pwCur, setPwCur] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwLoading, setPwLoading] = useState(false);
  const [pwMsg, setPwMsg] = useState(null); // { type: "success"|"error", text }
  const handleChangePw = async () => {
    setPwMsg(null);
    if (pwNew.length < 8) { setPwMsg({ type: "error", text: "새 비밀번호는 8자 이상이어야 합니다." }); return; }
    if (pwNew !== pwConfirm) { setPwMsg({ type: "error", text: "새 비밀번호가 일치하지 않습니다." }); return; }
    setPwLoading(true);
    try {
      const token = localStorage.getItem("ttimes_token");
      const res = await fetch("https://auth.ttimes6000.workers.dev/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: pwCur, newPassword: pwNew }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.token) localStorage.setItem("ttimes_token", data.token);
        setPwMsg({ type: "success", text: "비밀번호가 변경되었습니다." });
        setPwCur(""); setPwNew(""); setPwConfirm("");
      } else {
        setPwMsg({ type: "error", text: data.error || "비밀번호 변경 실패" });
      }
    } catch {
      setPwMsg({ type: "error", text: "서버에 연결할 수 없습니다." });
    } finally { setPwLoading(false); }
  };
  // 단어장 state — 삭제/수정 즉시 반영
  const [dictList, setDictList] = useState(() => {
    const d = loadDictionary();
    return d.map(t => typeof t === "string" ? t : t.correct || t.wrong).filter(Boolean);
  });
  const [editIdx, setEditIdx] = useState(-1);
  const [editVal, setEditVal] = useState("");
  const [newDictWord, setNewDictWord] = useState("");
  const save = () => {
    const ct = {};
    t.split("\n").filter(Boolean).forEach(l => { const [c,w] = l.split("="); if(c&&w) ct[c.trim()] = w.split(",").map(s=>s.trim()); });
    onSave({...config, apiMode:m, workerUrl:u.replace(/\/+$/,""),
      fillers:f.split(",").map(s=>s.trim()).filter(Boolean), customTerms:ct, chunkSize:parseInt(cs)||15000});
  };
  const iS = {width:"100%",padding:"8px 10px",borderRadius:6,border:`1px solid ${C.bd}`,
    background:"rgba(0,0,0,0.3)",color:C.tx,fontSize:13,fontFamily:FN,outline:"none"};
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:100,
    display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.sf,borderRadius:16,padding:28,
      width:480,maxHeight:"80vh",overflowY:"auto",border:`1px solid ${C.bd}`}}>
      <div style={{fontSize:18,fontWeight:700,color:C.tx,marginBottom:20}}>⚙️ 설정</div>
      <div style={{marginBottom:16}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:6}}>API 모드</label>
        <div style={{display:"flex",gap:4}}>
          {[["mock","Mock (데모)"],["live","Live (GPT-5.1)"]].map(([v,l])=>
            <button key={v} onClick={()=>setM(v)} style={{flex:1,padding:8,borderRadius:6,
              border:`1px solid ${m===v?C.ac:C.bd}`,background:m===v?C.acS:"transparent",
              color:m===v?C.ac:C.txM,fontSize:13,fontWeight:600,cursor:"pointer"}}>{l}</button>)}
        </div>
      </div>
      {m==="live" && <div style={{marginBottom:16}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:6}}>Cloudflare Worker URL</label>
        <input value={u} onChange={e=>setU(e.target.value)} placeholder="https://ttimes-editor.xxx.workers.dev" style={iS}/>
        <div style={{fontSize:11,color:C.txD,marginTop:4}}>ttimes-editor Worker의 전체 URL</div>
      </div>}
      <div style={{marginBottom:16}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:6}}>필러 단어 (쉼표 구분)</label>
        <input value={f} onChange={e=>setF(e.target.value)} style={iS}/>
      </div>
      <div style={{marginBottom:16}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:6}}>
          용어 사전 (줄바꿈, 형식: 올바른표기=오인식1,오인식2)</label>
        <textarea value={t} onChange={e=>setT(e.target.value)} rows={4}
          placeholder={"앤트로픽=엔트로피,엠트로픽\n프롬프트=프롬보트,프롬포트"} style={{...iS,resize:"vertical"}}/>
      </div>
      <div style={{marginBottom:20}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:6}}>청크 크기 (자)</label>
        <input type="number" value={cs} onChange={e=>setCs(e.target.value)} style={{...iS,width:120}}/>
      </div>
      <div style={{marginBottom:20,padding:14,background:"rgba(0,0,0,0.2)",borderRadius:10,border:`1px solid ${C.bd}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <label style={{fontSize:12,color:C.txM,fontWeight:600}}>📚 팀 단어장 (정답 표기)</label>
          <span style={{fontSize:12,color:C.ac,fontWeight:600}}>{dictList.length}건</span>
        </div>
        <div style={{fontSize:11,color:C.txD,marginBottom:10}}>
          정답 표기만 등록하면, AI가 발음 유사·문맥 유추로 오인식을 자동 매칭합니다.
          <br/>클릭하여 수정, × 버튼으로 삭제할 수 있습니다.
        </div>
        {dictList.length > 0 && (
          <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:10,maxHeight:160,overflowY:"auto",
            padding:6,background:"rgba(0,0,0,0.15)",borderRadius:8}}>
            {dictList.map((word, i) => (
              editIdx === i ? (
                <input key={i} autoFocus value={editVal} onChange={e=>setEditVal(e.target.value)}
                  onBlur={()=>{
                    const v = editVal.trim();
                    if(v && v !== word) {
                      const nd = [...dictList]; nd[i] = v; setDictList(nd);
                      saveDictionaryToServer(nd, config);
                    }
                    setEditIdx(-1);
                  }}
                  onKeyDown={e=>{
                    if(e.key==="Enter") e.target.blur();
                    if(e.key==="Escape") { setEditIdx(-1); }
                  }}
                  style={{padding:"3px 8px",borderRadius:12,border:`1px solid ${C.ac}`,
                    background:"rgba(74,108,247,0.2)",color:C.tx,fontSize:12,fontFamily:FN,
                    outline:"none",minWidth:60,width:Math.max(60, editVal.length*10)}}/>
              ) : (
                <span key={i} style={{display:"inline-flex",alignItems:"center",gap:3,padding:"3px 8px",
                  borderRadius:12,background:"rgba(74,108,247,0.12)",color:C.ac,fontSize:12,fontWeight:500,
                  cursor:"pointer"}}
                  onClick={()=>{ setEditIdx(i); setEditVal(word); }}>
                  {word}
                  <button onClick={async(e)=>{
                    e.stopPropagation();
                    const nd = dictList.filter((_,j)=>j!==i);
                    setDictList(nd);
                    await saveDictionaryToServer(nd, config);
                  }} style={{background:"none",border:"none",color:C.txD,cursor:"pointer",fontSize:11,
                    padding:0,lineHeight:1,marginLeft:1}} title="삭제">×</button>
                </span>
              )
            ))}
          </div>
        )}
        <div style={{display:"flex",gap:6}}>
          <input value={newDictWord} onChange={e=>setNewDictWord(e.target.value)}
            placeholder="새 단어 추가 (Enter)" style={{...iS,flex:1,fontSize:12}}
            onKeyDown={async e=>{
              if(e.key==="Enter" && newDictWord.trim()){
                const w = newDictWord.trim();
                if(!dictList.includes(w)){
                  const nd = [...dictList, w]; setDictList(nd);
                  await saveDictionaryToServer(nd, config);
                }
                setNewDictWord("");
              }
            }}/>
          <button onClick={async()=>{
            if(!newDictWord.trim()) return;
            const w = newDictWord.trim();
            if(!dictList.includes(w)){
              const nd = [...dictList, w]; setDictList(nd);
              await saveDictionaryToServer(nd, config);
            }
            setNewDictWord("");
          }} style={{padding:"6px 14px",borderRadius:6,border:"none",background:C.ac,color:"#fff",
            fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>추가</button>
          <button onClick={async ()=>{
            if(confirm("단어장을 초기화하면 저장된 모든 교정 용어가 삭제됩니다.\n팀 전체 단어장이 초기화됩니다. 계속할까요?")) {
              setDictList([]);
              await saveDictionaryToServer([], config);
            }
          }} style={{padding:"6px 12px",borderRadius:6,border:"1px solid rgba(239,68,68,0.3)",
            background:"transparent",color:"#EF4444",fontSize:12,cursor:"pointer",whiteSpace:"nowrap"}}>초기화</button>
        </div>
      </div>
      <div style={{marginBottom:20,padding:14,background:"rgba(0,0,0,0.2)",borderRadius:10,border:`1px solid ${C.bd}`}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:10}}>🔒 비밀번호 변경</label>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <input type="password" value={pwCur} onChange={e=>setPwCur(e.target.value)} placeholder="현재 비밀번호" style={iS}/>
          <input type="password" value={pwNew} onChange={e=>setPwNew(e.target.value)} placeholder="새 비밀번호 (8자 이상)" style={iS}/>
          <input type="password" value={pwConfirm} onChange={e=>setPwConfirm(e.target.value)} placeholder="새 비밀번호 확인" style={iS}/>
        </div>
        {pwMsg && <div style={{marginTop:8,padding:"8px 12px",borderRadius:6,fontSize:12,
          background:pwMsg.type==="success"?"rgba(34,197,94,0.1)":"rgba(239,68,68,0.1)",
          border:`1px solid ${pwMsg.type==="success"?"rgba(34,197,94,0.2)":"rgba(239,68,68,0.2)"}`,
          color:pwMsg.type==="success"?C.ok:"#EF4444"}}>{pwMsg.text}</div>}
        <button onClick={handleChangePw} disabled={pwLoading||!pwCur||!pwNew||!pwConfirm}
          style={{marginTop:8,padding:"7px 16px",borderRadius:6,border:"none",
            background:pwLoading?"rgba(74,108,247,0.4)":"rgba(74,108,247,0.8)",
            color:"#fff",fontSize:12,fontWeight:600,cursor:pwLoading?"not-allowed":"pointer",fontFamily:FN}}>
          {pwLoading?"변경 중...":"비밀번호 변경"}</button>
      </div>
      <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
        <button onClick={onClose} style={{padding:"8px 20px",borderRadius:6,border:`1px solid ${C.bd}`,
          background:"transparent",color:C.txM,fontSize:13,cursor:"pointer"}}>취소</button>
        <button onClick={save} style={{padding:"8px 20px",borderRadius:6,border:"none",
          background:C.ac,color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer"}}>저장</button>
      </div>
    </div>
  </div>;
}
