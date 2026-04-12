import { useState } from "react";
import { C, FN, MARKER_COLORS } from "../utils/styles.js";
import { Badge, TypeBadge } from "./BlockComponents.jsx";

export function GuideCard({ item, active, onClick, blocks, verdict, onVerdict, editedText, onEdit, onRelocate, onChangeType, onDelete }) {
  const bc = C.hBd, bg = C.hBg;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [relocating, setRelocating] = useState(false);
  const [relocTarget, setRelocTarget] = useState(item.block_index);

  const tsOf = (idx) => blocks?.find(b => b.index === idx)?.timestamp || `#${idx}`;
  const timeLabel = tsOf(item.block_index);

  const verdictOptions = [
    { key: "use", label: "사용", color: "#22C55E", bg: "rgba(34,197,94,0.15)" },
    { key: "discard", label: item._manual ? "삭제" : "폐기", color: "#EF4444", bg: "rgba(239,68,68,0.15)" },
  ];
  const currentVerdict = verdict || null;
  const hasEdit = editedText && editedText !== item.subtitle;
  const isB2 = item.type === "B2";

  const borderColor = currentVerdict === "use" ? "#22C55E"
    : currentVerdict === "discard" ? "rgba(239,68,68,0.4)"
    : active ? bc : C.bd;
  const cardBg = currentVerdict === "discard" ? "rgba(239,68,68,0.05)"
    : active ? bg : C.sf;
  const cardOpacity = currentVerdict === "discard" ? 0.6 : 1;

  const startEdit = (e) => {
    e.stopPropagation();
    setDraft(editedText || item.subtitle);
    setEditing(true);
  };
  const saveEdit = (e) => {
    e.stopPropagation();
    const trimmed = draft.trim();
    if (trimmed && trimmed !== item.subtitle) {
      onEdit(item, trimmed);
    } else if (trimmed === item.subtitle) {
      onEdit(item, null);
    }
    setEditing(false);
  };
  const cancelEdit = (e) => {
    e.stopPropagation();
    setEditing(false);
  };

  const handleVerdictClick = (e, vKey) => {
    e.stopPropagation();
    if (vKey === "discard" && item._manual) {
      // 수동 자막 → 완전 삭제
      if (onDelete) onDelete(item);
      return;
    }
    if (vKey === "use" && currentVerdict !== "use") {
      setRelocTarget(item.block_index);
      setRelocating(true);
      onVerdict(item, "use");
    } else if (vKey === "use" && currentVerdict === "use") {
      setRelocating(false);
      onVerdict(item, null);
    } else {
      setRelocating(false);
      onVerdict(item, currentVerdict === vKey ? null : vKey);
    }
  };

  const confirmRelocate = (e) => {
    e.stopPropagation();
    const targetIdx = parseInt(relocTarget);
    if (!isNaN(targetIdx) && onRelocate && targetIdx !== item.block_index) {
      onRelocate(item, targetIdx);
    }
    setRelocating(false);
  };

  return <div onClick={() => onClick(item)} style={{border:`1px solid ${borderColor}`,borderRadius:10,
    padding:"10px 12px",marginBottom:8,background:cardBg,cursor:"pointer",transition:"all 0.12s",
    boxShadow:active?`0 0 0 2px ${bc}44`:"none",opacity:cardOpacity}}>
    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
      <span style={{fontSize:13}}>{item._manual ? "✏️" : "💬"}</span>
      <Badge name={item.speaker||"—"}/>
      <span style={{fontSize:11,color:active?bc:C.txD,fontFamily:"monospace",fontWeight:active?700:400}}>
        ⏱ {timeLabel}</span>
      <TypeBadge type={item.type} onChangeType={onChangeType}/>
      {item._manual && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,
        background:"rgba(34,197,94,0.15)",color:"#22C55E"}}>수동</span>}
      <span style={{fontSize:10,color:C.txD,fontFamily:"monospace",marginLeft:"auto"}}>#{item.block_index}</span>
    </div>

    {/* 자막 텍스트 + 수정/복사 버튼 */}
    {!editing ? (
      <div>
        <div style={{display:"flex",alignItems:"flex-start",gap:6}}>
          <div style={{flex:1}}>
            {isB2 && <div style={{marginBottom:3}}><span style={{fontSize:11,fontWeight:700,color:"#3B82F6",background:"rgba(59,130,246,0.12)",
              padding:"1px 6px",borderRadius:3}}>용어설명</span></div>}
            <div style={{fontSize:14,fontWeight:500,lineHeight:1.5,whiteSpace:"pre-line",
              color:hasEdit?(currentVerdict==="discard"?C.txD:"#EF4444"):currentVerdict==="discard"?C.txD:C.tx,
              textDecoration:(hasEdit||currentVerdict==="discard")?"line-through":"none"}}>
              {item.subtitle}
            </div>
          </div>
          <button onClick={e=>{e.stopPropagation();const t=hasEdit?editedText:item.subtitle;navigator.clipboard.writeText(t);setCopied(true);setTimeout(()=>setCopied(false),1500)}}
            style={{fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:4,
              border:`1px solid ${copied?"#22C55E":C.bd}`,background:copied?"rgba(34,197,94,0.15)":"rgba(255,255,255,0.04)",
              color:copied?"#22C55E":C.txM,cursor:"pointer",flexShrink:0,marginTop:2,transition:"all 0.15s",minWidth:28}}>
            {copied?"✓":"복사"}</button>
          <button onClick={startEdit} style={{fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:4,
            border:`1px solid ${C.bd}`,background:"rgba(255,255,255,0.04)",color:C.txM,cursor:"pointer",
            flexShrink:0,marginTop:2}}>수정</button>
        </div>
        {hasEdit && (
          <div style={{marginTop:4}}>
            {isB2 && <div style={{marginBottom:3}}><span style={{fontSize:11,fontWeight:700,color:"#22C55E",background:"rgba(34,197,94,0.12)",
              padding:"1px 6px",borderRadius:3}}>용어설명</span></div>}
            <div style={{display:"flex",alignItems:"flex-start",gap:6}}>
              <div style={{flex:1,fontSize:14,fontWeight:600,lineHeight:1.5,color:"#22C55E",whiteSpace:"pre-line"}}>
                {editedText}
              </div>
              <button onClick={e=>{e.stopPropagation();onEdit(item, null)}}
                style={{fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:4,
                  border:`1px solid ${C.bd}`,background:"rgba(255,255,255,0.04)",
                  color:C.txM,cursor:"pointer",flexShrink:0,marginTop:2}}
                title="수정 취소 (원래 자막으로 되돌리기)">↩ undo</button>
            </div>
          </div>
        )}
      </div>
    ) : (
      <div onClick={e=>e.stopPropagation()} style={{marginTop:2}}>
        <textarea value={draft} onChange={e=>setDraft(e.target.value)} rows={2}
          autoFocus
          style={{width:"100%",padding:"6px 8px",borderRadius:6,border:`1px solid ${C.ac}`,
            background:"rgba(0,0,0,0.3)",color:C.tx,fontSize:13,fontFamily:"'Pretendard',sans-serif",
            lineHeight:1.5,resize:"vertical",outline:"none"}}
          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();saveEdit(e);}if(e.key==="Escape")cancelEdit(e);}}
        />
        <div style={{display:"flex",gap:4,marginTop:4,justifyContent:"flex-end"}}>
          <button onClick={cancelEdit} style={{fontSize:11,padding:"3px 10px",borderRadius:4,
            border:`1px solid ${C.bd}`,background:"transparent",color:C.txM,cursor:"pointer"}}>취소</button>
          <button onClick={saveEdit} style={{fontSize:11,padding:"3px 10px",borderRadius:4,
            border:"none",background:C.ac,color:"#fff",fontWeight:600,cursor:"pointer"}}>저장</button>
        </div>
      </div>
    )}

    {item.type_name && <div style={{fontSize:11,color:C.txD,marginTop:2}}>{item.type_name}</div>}
    {open && <div style={{background:"rgba(0,0,0,0.25)",borderRadius:8,padding:10,marginTop:8,border:`1px solid ${C.bd}`}}>
      <div style={{fontSize:12,color:C.txM,marginBottom:4}}><b>사유:</b> {item.reason}</div>
      {item.source_text && <div style={{fontSize:12,color:C.txD}}><b>원문:</b> {item.source_text}</div>}
      {item.placement_hint && <div style={{fontSize:12,color:C.txD,marginTop:4}}><b>배치:</b> {item.placement_hint}</div>}
    </div>}
    <div style={{display:"flex",alignItems:"center",gap:4,marginTop:6}}>
      <button onClick={e=>{e.stopPropagation();setOpen(!open)}} style={{fontSize:11,color:C.ac,background:"none",border:"none",cursor:"pointer",padding:"2px 0"}}>
        {open?"접기 ▲":"상세 ▼"}</button>
      <div style={{marginLeft:"auto",display:"flex",gap:3}}>
        {verdictOptions.map(v => (
          <button key={v.key} onClick={e=>handleVerdictClick(e, v.key)}
            style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,cursor:"pointer",transition:"all 0.1s",
              border:`1px solid ${currentVerdict===v.key?v.color:"transparent"}`,
              background:currentVerdict===v.key?v.bg:"rgba(255,255,255,0.04)",
              color:currentVerdict===v.key?v.color:C.txD}}>
            {v.label}
          </button>
        ))}
      </div>
    </div>
    {/* 사용 시 블록 위치 변경 UI */}
    {relocating && currentVerdict === "use" && (
      <div onClick={e=>e.stopPropagation()} style={{marginTop:8,padding:"8px 10px",borderRadius:8,
        background:"rgba(34,197,94,0.08)",border:"1px solid rgba(34,197,94,0.25)"}}>
        <div style={{fontSize:11,color:"#22C55E",fontWeight:600,marginBottom:6}}>📍 배치 위치 선택</div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:11,color:C.txM}}>블록 #</span>
          <select value={relocTarget} onChange={e=>setRelocTarget(e.target.value)}
            style={{padding:"4px 8px",borderRadius:5,border:`1px solid ${C.bd}`,
              background:"rgba(0,0,0,0.3)",color:C.tx,fontSize:12,outline:"none",flex:1,maxWidth:200}}>
            {blocks.map(b => (
              <option key={b.index} value={b.index}>
                #{b.index} {b.speaker} {b.timestamp}
              </option>
            ))}
          </select>
          <button onClick={confirmRelocate}
            style={{fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:5,border:"none",
              background:"#22C55E",color:"#fff",cursor:"pointer"}}>확인</button>
          <button onClick={e=>{e.stopPropagation();setRelocating(false)}}
            style={{fontSize:11,padding:"4px 8px",borderRadius:5,border:`1px solid ${C.bd}`,
              background:"transparent",color:C.txM,cursor:"pointer"}}>닫기</button>
        </div>
        <div style={{fontSize:10,color:C.txD,marginTop:4}}>
          현재: #{item.block_index} · 이 자막이 선택한 블록 아래에 표시됩니다
        </div>
      </div>
    )}
  </div>;
}
