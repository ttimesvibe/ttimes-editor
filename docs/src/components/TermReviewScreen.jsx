import { useState } from "react";
import { C, FN } from "../utils/styles.js";
import { loadDictionary, saveDictionary, saveDictionaryToServer } from "../utils/dictionary.js";
import { EditorialSummaryPanel } from "./EditorialSummaryPanel.jsx";

export function TermReviewScreen({ terms: initialTerms, analysis, onConfirm, onSkip }) {
  const [terms, setTerms] = useState(initialTerms);
  const [newWord, setNewWord] = useState("");
  // 단어장 state — 삭제/수정 즉시 반영
  const [dictWords, setDictWords] = useState(() => {
    const d = loadDictionary();
    return d.map(t => typeof t === "string" ? t : t.correct || t.wrong).filter(Boolean);
  });
  const [dictEditIdx, setDictEditIdx] = useState(-1);
  const [dictEditVal, setDictEditVal] = useState("");
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);

  const update = (i, field, val) =>
    setTerms(prev => prev.map((t, idx) => idx === i ? { ...t, [field]: val } : t));
  const remove = (i) =>
    setTerms(prev => prev.filter((_, idx) => idx !== i));
  const add = () =>
    setTerms(prev => [...prev, { wrong: "", correct: "", confidence: "high" }]);
  const confirm = () =>
    onConfirm(terms.filter(t => t.wrong.trim() && t.correct.trim()));

  const dictDelete = async (i) => {
    const nd = dictWords.filter((_,j)=>j!==i);
    setDictWords(nd);
    saveDictionary(nd);
    await saveDictionaryToServer(nd, {apiMode:"live",workerUrl:analysis?._workerUrl||""});
  };
  const dictEdit = async (i, newVal) => {
    const v = newVal.trim();
    if(v && v !== dictWords[i]) {
      const nd = [...dictWords]; nd[i] = v; setDictWords(nd);
      saveDictionary(nd);
      await saveDictionaryToServer(nd, {apiMode:"live",workerUrl:analysis?._workerUrl||""});
    }
    setDictEditIdx(-1);
  };
  const dictAdd = async (word) => {
    if(!word.trim() || dictWords.includes(word.trim())) return;
    const nd = [...dictWords, word.trim()];
    setDictWords(nd);
    saveDictionary(nd);
    await saveDictionaryToServer(nd, {apiMode:"live",workerUrl:analysis?._workerUrl||""});
  };

  const iS = { padding:"6px 10px", borderRadius:6, border:`1px solid ${C.bd}`,
    background:"rgba(0,0,0,0.3)", color:C.tx, fontSize:13, fontFamily:FN, outline:"none", width:"100%" };

  const confColor = (c) => c === "high" ? C.ok : C.wn;
  const confLabel = (c) => c === "high" ? "high" : "low";

  return <div style={{flex:1, overflowY:"auto", display:"flex", flexDirection:"column", alignItems:"center", padding:"32px 24px"}}>
    <div style={{width:"100%", maxWidth:640}}>
      <div style={{marginBottom:24}}>
        <div style={{display:"inline-flex",alignItems:"center",gap:6,padding:"4px 12px",borderRadius:12,
          background:"rgba(34,197,94,0.1)",border:"1px solid rgba(34,197,94,0.2)",fontSize:12,color:C.ok,marginBottom:12}}>
          ✅ 사전 분석 완료</div>
        <div style={{fontSize:20,fontWeight:700,color:C.tx,marginBottom:4}}>용어 교정 목록 검토</div>
        {analysis?.overview?.topic && <div style={{fontSize:13,color:C.txM}}>주제: {analysis.overview.topic}</div>}
        {analysis?.genre?.primary && <div style={{fontSize:12,color:C.txD,marginTop:2}}>
          장르: {analysis.genre.primary}{analysis.genre.secondary ? ` + ${analysis.genre.secondary}` : ""} · 난이도: {analysis.tech_difficulty || "—"}
        </div>}
        <div style={{fontSize:13,color:C.txD,marginTop:6}}>
          AI가 발견한 STT 오인식 후보입니다. 확인 후 교정을 시작하세요.
        </div>
      </div>

      {/* Step 0에서 발견된 오인식 매핑 테이블 (최상단) */}
      <div style={{background:C.sf,borderRadius:12,border:`1px solid ${C.bd}`,overflow:"hidden",marginBottom:16}}>
        <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.bd}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:12,fontWeight:700,color:C.txM}}>AI 발견 오인식 후보</span>
          <span style={{fontSize:11,color:C.txD}}>{terms.length}건</span>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"60px 1fr 24px 1fr 36px",gap:8,padding:"8px 14px",
          borderBottom:`1px solid ${C.bd}`,fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",letterSpacing:"0.06em"}}>
          <span>신뢰도</span><span>원문 (오인식)</span><span></span><span>교정값</span><span></span>
        </div>
        {terms.length === 0 && <div style={{padding:"24px",textAlign:"center",fontSize:13,color:C.txD}}>
          항목 없음 — AI가 신규 오인식 후보를 찾지 못했습니다.
        </div>}
        {terms.map((t, i) => (
          <div key={i} style={{display:"grid",gridTemplateColumns:"60px 1fr 24px 1fr 36px",gap:8,
            padding:"8px 14px",borderBottom:`1px solid ${C.bd}`,alignItems:"center"}}>
            <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,textAlign:"center",
              background:`${confColor(t.confidence)}22`,color:confColor(t.confidence)}}>
              {confLabel(t.confidence)}
            </span>
            <input value={t.wrong} onChange={e=>update(i,"wrong",e.target.value)} style={iS} placeholder="오인식 단어"/>
            <span style={{textAlign:"center",color:C.txD,fontSize:14}}>→</span>
            <input value={t.correct} onChange={e=>update(i,"correct",e.target.value)} style={iS} placeholder="올바른 표기"/>
            <button onClick={()=>remove(i)} style={{background:"none",border:"none",color:C.txD,cursor:"pointer",
              fontSize:16,padding:0,textAlign:"center"}} title="삭제">✕</button>
          </div>
        ))}
        <div style={{padding:"10px 14px"}}>
          <button onClick={add} style={{background:"none",border:`1px dashed ${C.bd}`,borderRadius:6,
            color:C.txM,fontSize:12,cursor:"pointer",padding:"6px 14px",width:"100%"}}>
            + 항목 추가
          </button>
        </div>
      </div>

      {/* 확인/건너뛰기 버튼 */}
      <div style={{display:"flex",justifyContent:"center",gap:12,marginBottom:20}}>
        <button onClick={onSkip} style={{padding:"9px 20px",borderRadius:8,border:`1px solid ${C.bd}`,
          background:"transparent",color:C.txM,fontSize:13,cursor:"pointer"}}>
          용어 교정 없이 진행
        </button>
        <button onClick={confirm} style={{padding:"9px 24px",borderRadius:8,border:"none",
          background:`linear-gradient(135deg,${C.ac},#7C3AED)`,color:"#fff",fontSize:13,fontWeight:700,
          cursor:"pointer",boxShadow:"0 4px 14px rgba(74,108,247,0.3)"}}>
          교정 확정 → 1차 교정 시작
        </button>
      </div>

      {/* 콘텐츠 요약 */}
      <EditorialSummaryPanel summary={analysis?.editorial_summary} collapsed={summaryCollapsed} onToggle={()=>setSummaryCollapsed(!summaryCollapsed)}/>

      {/* 팀 단어장 (정답 표기 목록) — 삭제/수정 가능 */}
      {dictWords.length > 0 && (
        <div style={{background:C.sf,borderRadius:12,border:`1px solid ${C.bd}`,padding:14,marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <span style={{fontSize:12,fontWeight:700,color:"#3B82F6"}}>📚 팀 단어장 ({dictWords.length}건)</span>
            <span style={{fontSize:11,color:C.txD}}>클릭=수정 · ×=삭제</span>
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {dictWords.map((word, i) => (
              dictEditIdx === i ? (
                <input key={i} autoFocus value={dictEditVal} onChange={e=>setDictEditVal(e.target.value)}
                  onBlur={()=>dictEdit(i, dictEditVal)}
                  onKeyDown={e=>{
                    if(e.key==="Enter") e.target.blur();
                    if(e.key==="Escape") setDictEditIdx(-1);
                  }}
                  style={{padding:"3px 8px",borderRadius:12,border:`1px solid #3B82F6`,
                    background:"rgba(59,130,246,0.2)",color:C.tx,fontSize:12,fontFamily:FN,
                    outline:"none",minWidth:60,width:Math.max(60, dictEditVal.length*10)}}/>
              ) : (
                <span key={i} style={{display:"inline-flex",alignItems:"center",gap:3,padding:"3px 10px",
                  borderRadius:12,background:"rgba(59,130,246,0.12)",color:"#3B82F6",fontSize:12,fontWeight:500,
                  cursor:"pointer"}}
                  onClick={()=>{ setDictEditIdx(i); setDictEditVal(word); }}>
                  {word}
                  <button onClick={(e)=>{e.stopPropagation(); dictDelete(i);}}
                    style={{background:"none",border:"none",color:C.txD,cursor:"pointer",fontSize:11,
                      padding:0,lineHeight:1,marginLeft:1}} title="삭제">×</button>
                </span>
              )
            ))}
          </div>
        </div>
      )}

      {/* 신규 단어 추가 (정답형) */}
      <div style={{background:C.sf,borderRadius:12,border:`1px solid ${C.bd}`,padding:14,marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:700,color:C.txM,marginBottom:8}}>+ 단어장에 정답 추가</div>
        <div style={{display:"flex",gap:6}}>
          <input value={newWord} onChange={e=>setNewWord(e.target.value)} placeholder="정답 표기 입력 (예: 오픈AI)"
            style={{...iS,flex:1}} onKeyDown={async e=>{
              if(e.key==="Enter" && newWord.trim()){
                await dictAdd(newWord);
                setNewWord("");
              }
            }}/>
          <button onClick={async()=>{
            if(!newWord.trim()) return;
            await dictAdd(newWord);
            setNewWord("");
          }} style={{padding:"6px 14px",borderRadius:6,border:"none",background:C.ac,color:"#fff",
            fontSize:12,fontWeight:600,cursor:"pointer"}}>추가</button>
        </div>
      </div>

    </div>
  </div>;
}
