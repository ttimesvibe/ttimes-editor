import { useState, useRef, useCallback } from "react";
import { C, FN, MARKER_COLORS } from "../utils/styles.js";
import { findPositions, toSegs } from "../utils/diffRenderer.js";

// ═══════════════════════════════════════════════
// SMALL COMPONENTS
// ═══════════════════════════════════════════════

export function Badge({ name }) {
  const h = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const isLight = C.bg[1] > "E";
  return <span style={{ fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:4,
    background:`hsla(${h},55%,50%,${isLight?0.12:0.15})`,color:`hsl(${h},${isLight?"50%,38%":"55%,65%"})`,marginRight:5 }}>{name}</span>;
}

export function Progress({ pct, label }) {
  return <div style={{margin:"16px 0"}}>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
      <span style={{fontSize:13,color:C.txM}}>{label}</span>
      <span style={{fontSize:13,color:C.ac,fontWeight:600}}>{pct}%</span>
    </div>
    <div style={{height:4,background:C.bd,borderRadius:2,overflow:"hidden"}}>
      <div style={{height:"100%",background:`linear-gradient(90deg,${C.ac},#7C3AED)`,
        width:`${pct}%`,borderRadius:2,transition:"width 0.4s"}}/>
    </div>
  </div>;
}

// ── 형광펜 텍스트 렌더링: 마커 범위에 해당하는 부분을 색상으로 표시 ──
export function MarkedText({ text, blockIdx, hlMarkers, matchingMode, onMarkerAdd }) {
  const textRef = useRef(null);

  // 이 블록에 해당하는 마커들 수집
  const markers = [];
  for (const [key, m] of Object.entries(hlMarkers || {})) {
    if (!m.ranges) continue;
    for (const r of m.ranges) {
      if (r.blockIdx === blockIdx) {
        markers.push({ s: r.s, e: r.e, color: m.color, key });
      }
    }
  }
  markers.sort((a, b) => a.s - b.s);

  // 겹치는 마커 병합 (같은 색은 합치고, 다른 색은 나중 것 우선)
  const merged = [];
  for (const m of markers) {
    if (merged.length > 0) {
      const last = merged[merged.length - 1];
      if (m.s < last.e) {
        // 겹침 — 나중 것으로 덮어쓰기 (마지막 마커의 끝을 잘라내고 새 마커 추가)
        if (m.s > last.s) {
          merged.push({ s: last.s, e: m.s, color: last.color, key: last.key }); // 앞부분
          merged.pop(); // 원래 last 제거 (앞부분으로 대체)
          // 이전 merged에서 last를 제거하고 잘라낸 앞부분을 넣기
        }
        merged.push(m);
        continue;
      }
    }
    merged.push(m);
  }

  // 세그먼트 생성 — 마커가 없는 구간은 일반 텍스트
  const segs = [];
  let cursor = 0;
  for (const m of markers) {
    const s = Math.max(m.s, cursor); // 겹침 방지
    const e = Math.min(m.e, text.length);
    if (s >= e) continue; // 완전히 겹쳐서 무효
    if (s > cursor) segs.push({ text: text.substring(cursor, s), color: null });
    segs.push({ text: text.substring(s, e), color: m.color, key: m.key });
    cursor = e;
  }
  if (cursor < text.length) segs.push({ text: text.substring(cursor), color: null });
  if (segs.length === 0) segs.push({ text, color: null });

  const isMatching = matchingMode && matchingMode.blockIdx === blockIdx;

  const handleMouseUp = useCallback(() => {
    if (!matchingMode) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !textRef.current) return;
    const container = textRef.current;
    if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return;

    // 선택된 텍스트를 원본 text에서 찾아 offset 계산
    const selectedText = sel.toString();
    if (!selectedText.trim()) return;

    // DOM TreeWalker로 정확한 텍스트 offset 계산
    const range = sel.getRangeAt(0);
    let startOffset = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    let node;
    let found = false;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) {
        startOffset += range.startOffset;
        found = true;
        break;
      }
      startOffset += node.textContent.length;
    }
    if (!found) return;
    const endOffset = startOffset + selectedText.length;

    // 유효성 검증: offset이 text 범위 내인지
    if (startOffset < 0 || endOffset > text.length || startOffset >= endOffset) return;

    onMarkerAdd(matchingMode.key, matchingMode.color, blockIdx, startOffset, endOffset);
    sel.removeAllRanges();
  }, [matchingMode, blockIdx, onMarkerAdd, text]);

  return <div ref={textRef}
    onMouseUp={handleMouseUp}
    style={{fontSize:14,lineHeight:1.8,color:C.tx,wordBreak:"keep-all",whiteSpace:"pre-wrap",
      cursor:isMatching?"crosshair":"inherit",
      transition:"all 0.15s"}}>
    {segs.map((s, i) => s.color
      ? <span key={i} style={{background:MARKER_COLORS[s.color]?.bg,borderRadius:3,padding:"1px 0",
          borderBottom:`2px solid ${MARKER_COLORS[s.color]?.border}`}}>{s.text}</span>
      : <span key={i}>{s.text}</span>
    )}
  </div>;
}

// ── 유형 코드 배지 ──
export function TypeBadge({ type, onChangeType }) {
  if (!type) return null;
  const [open, setOpen] = useState(false);
  // 카테고리별 라벨 & 색상 — "자료"(C)는 편집자 수동 변경 시에만 적용
  // AI 생성 type: A=핵심논지, B=용어설명, C=질문프레이밍, D=비교평가, E=기능헤드라인
  // → A,C,D,E는 모두 "자막"으로 표시, B만 "용어설명"
  // → 편집자가 TypeBadge 클릭→"자료" 선택 시에만 _userType="C"로 저장
  const labelMap = {
    A: { label: "자막", bg: "rgba(34,197,94,0.15)", tx: "#22C55E" },
    B: { label: "용어설명", bg: "rgba(59,130,246,0.15)", tx: "#3B82F6" },
    C: { label: "자료", bg: "rgba(249,115,22,0.15)", tx: "#F97316" },
    D: { label: "자막", bg: "rgba(34,197,94,0.15)", tx: "#22C55E" },
    E: { label: "자막", bg: "rgba(34,197,94,0.15)", tx: "#22C55E" },
  };
  const cat = type.charAt(0);
  // AI 생성 C(질문 프레이밍)는 "자막"으로 표시, _userType이 "C"인 경우만 "자료"
  const effectiveCat = (cat === "C" && !type.startsWith("C_user")) ? "A" : cat;
  const c = labelMap[effectiveCat] || { label: "자막", bg: "rgba(255,255,255,0.08)", tx: C.txM };
  if (!onChangeType) {
    return <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,
      background:c.bg,color:c.tx,letterSpacing:"0.03em"}}>{c.label}</span>;
  }
  return <span style={{position:"relative",display:"inline-block"}}>
    <span onClick={e=>{e.stopPropagation();setOpen(!open)}} style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,
      background:c.bg,color:c.tx,letterSpacing:"0.03em",cursor:"pointer",
      border:`1px solid ${c.tx}44`,userSelect:"none"}}>{c.label} ▾</span>
    {open && <div style={{position:"absolute",top:"100%",left:0,marginTop:4,zIndex:999,
      background:C.sf,border:`1px solid ${C.bd}`,borderRadius:6,boxShadow:`0 4px 16px ${C.shadow||"rgba(0,0,0,0.3)"}`,
      overflow:"hidden",minWidth:80}}>
      {[["A","자막"],["B","용어설명"],["C_user","자료"]].map(([k,l])=>{
        const displayCat = k === "C_user" ? "C" : k;
        const m = labelMap[displayCat] || labelMap["A"];
        return <div key={k} onClick={e=>{e.stopPropagation();onChangeType(k);setOpen(false)}}
          style={{padding:"6px 12px",fontSize:11,fontWeight:600,color:m.tx,cursor:"pointer",
            background:effectiveCat===displayCat?m.bg:"transparent",whiteSpace:"nowrap"}}
          onMouseEnter={e=>e.currentTarget.style.background=m.bg}
          onMouseLeave={e=>{if(effectiveCat!==displayCat)e.currentTarget.style.background="transparent"}}>{l}</div>;
      })}
    </div>}
  </span>;
}

export function BlockView({ block, pos, side, active, onClick, bRef, showIndex }) {
  const segs = toSegs(block.text, pos, side);
  return <div ref={bRef} onClick={() => onClick?.(block.index)}
    style={{padding:"10px 16px",borderLeft:`4px solid ${active?"#A855F7":"transparent"}`,
      background:active?"rgba(168,85,247,0.18)":"transparent",cursor:"pointer",transition:"all 0.25s ease",
      boxShadow:active?"inset 0 0 0 1px rgba(168,85,247,0.3), 0 0 20px rgba(168,85,247,0.1)":"none",
      borderRadius:active?"0 8px 8px 0":"0"}}>
    <div style={{marginBottom:4,display:"flex",alignItems:"center"}}>
      {showIndex && <span style={{fontSize:10,fontWeight:700,color:C.txD,fontFamily:"monospace",
        background:"rgba(255,255,255,0.06)",padding:"1px 5px",borderRadius:3,marginRight:6}}>#{block.index}</span>}
      <Badge name={block.speaker}/>
      <span style={{fontSize:11,color:C.txD,fontFamily:"monospace"}}>{block.timestamp}</span>
    </div>
    <div style={{fontSize:14,lineHeight:1.8,color:C.tx,wordBreak:"keep-all"}}>
      {segs.map((s,i) => {
        // 좌측: 필러 구간 — 노란 배경 + 취소선
        if (s.tp === "filler_removal") return <span key={i} style={{textDecoration:"line-through",
          textDecorationColor:C.fSk,background:C.fBg,color:C.fTx,padding:"1px 2px",borderRadius:3,fontSize:13}}>{s.text}</span>;
        // 우측: 필러 제거된 교정 텍스트 (일반 텍스트와 동일)
        if (s.tp === "filler_applied") return <span key={i}>{s.text}</span>;
        // 좌측: 용어 오류 표시
        if (s.tp === "term_correction") return <span key={i} style={{background:C.tBg,color:C.tTx,
          padding:"1px 3px",borderRadius:3,textDecoration:"underline wavy",textDecorationColor:C.tTx,fontSize:13}}>{s.text}</span>;
        // 우측: 용어 교정 적용 — 컬러 없이 일반 텍스트
        if (s.tp === "term_correction_applied") return <span key={i}>{s.text}</span>;
        // 좌측: 맞춤법 오류 표시
        if (s.tp === "spelling") return <span key={i} style={{background:C.sBg,color:C.sTx,
          padding:"1px 3px",borderRadius:3,textDecoration:"underline dotted",textDecorationColor:C.sTx,fontSize:13}}
          title={s.subtype}>{s.text}</span>;
        // 우측: 맞춤법 교정 적용 — 컬러 없이 일반 텍스트
        if (s.tp === "spelling_applied") return <span key={i}>{s.text}</span>;
        // 일반 텍스트
        return <span key={i}>{s.text}</span>;
      })}
    </div>
  </div>;
}

// ── 0차: 원고 검토 블록 (삭제선 표시) ──
export function ReviewBlock({ block, paragraphSegments, strikeRanges, isDeleted, onClick, active, bRef }) {
  const idx = block.index;

  // strikeRanges가 있으면 블록 텍스트를 세그먼트로 분리
  const renderText = () => {
    if (paragraphSegments) {
      return paragraphSegments.map((seg, si) =>
        seg.deleted
          ? <span key={si} style={{textDecoration:"line-through",textDecorationColor:"#EF4444",
              background:"rgba(239,68,68,0.12)",color:"#EF4444",padding:"1px 2px",borderRadius:3}}>{seg.text}</span>
          : <span key={si}>{seg.text}</span>
      );
    }
    if (strikeRanges && strikeRanges.length > 0) {
      const segs = [];
      let cursor = 0;
      for (const r of strikeRanges) {
        if (r.s > cursor) segs.push(<span key={`n${cursor}`}>{block.text.substring(cursor, r.s)}</span>);
        segs.push(<span key={`d${r.s}`} style={{textDecoration:"line-through",textDecorationColor:"#EF4444",
          background:"rgba(239,68,68,0.12)",color:"#EF4444",padding:"1px 2px",borderRadius:3}}>
          {block.text.substring(r.s, r.e)}</span>);
        cursor = r.e;
      }
      if (cursor < block.text.length) segs.push(<span key={`n${cursor}`}>{block.text.substring(cursor)}</span>);
      return segs;
    }
    return block.text;
  };

  const hasPartialStrike = strikeRanges && strikeRanges.length > 0 && !isDeleted;

  return <div ref={bRef} onClick={() => onClick?.(idx)}
    style={{padding:"10px 16px",
      borderLeft:`4px solid ${isDeleted?"#EF4444":hasPartialStrike?"#F59E0B":active?"#A855F7":"transparent"}`,
      background:isDeleted?"rgba(239,68,68,0.06)":active?"rgba(168,85,247,0.08)":"transparent",
      opacity:isDeleted?0.65:1,
      cursor:"pointer",transition:"all 0.15s",borderBottom:`1px solid ${C.bd}`}}>
    <div style={{marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
      <span style={{fontSize:10,fontWeight:700,color:C.txD,fontFamily:"monospace",
        background:"rgba(255,255,255,0.06)",padding:"1px 5px",borderRadius:3}}>#{idx}</span>
      <Badge name={block.speaker}/>
      <span style={{fontSize:11,color:C.txD,fontFamily:"monospace"}}>{block.timestamp}</span>
      {isDeleted && <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,
        background:"rgba(239,68,68,0.15)",color:"#EF4444"}}>삭제</span>}
      {hasPartialStrike && <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,
        background:"rgba(245,158,11,0.15)",color:"#F59E0B"}}>부분 삭제</span>}
    </div>
    <div style={{fontSize:14,lineHeight:1.8,color:isDeleted?C.txD:C.tx,wordBreak:"keep-all",
      textDecoration:isDeleted?"line-through":"none",
      textDecorationColor:isDeleted?"#EF4444":"transparent",
      whiteSpace:"pre-wrap"}}>
      {renderText()}
    </div>
  </div>;
}

// ── 1.5단계: 스크립트 편집 블록 (Hooks 사용을 위해 별도 컴포넌트) ──
export function ScriptEditBlock({ block, correctedText, editedVal, isEdited, onSave, onRevert }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const displayText = editedVal !== undefined ? editedVal : correctedText;
  const idx = block.index;

  return <div style={{padding:"10px 16px",borderBottom:`1px solid ${C.bd}`,
    borderLeft:`4px solid ${isEdited?"#22C55E":"transparent"}`,
    background:isEdited?"rgba(34,197,94,0.04)":"transparent",
    transition:"all 0.15s"}}>
    <div style={{marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
      <span style={{fontSize:10,fontWeight:700,color:C.txD,fontFamily:"monospace",
        background:"rgba(255,255,255,0.06)",padding:"1px 5px",borderRadius:3}}>#{idx}</span>
      <Badge name={block.speaker}/>
      <span style={{fontSize:11,color:C.txD,fontFamily:"monospace"}}>{block.timestamp}</span>
      {isEdited && <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,
        background:"rgba(34,197,94,0.15)",color:"#22C55E"}}>수정됨</span>}
      {isEdited && <button onClick={e=>{e.stopPropagation();onRevert()}}
        style={{fontSize:10,color:C.txD,background:"none",border:"none",cursor:"pointer",marginLeft:"auto"}}
        title="원래대로 되돌리기">↩ 되돌리기</button>}
    </div>
    {!editing ? (
      <div onClick={()=>{setDraft(displayText);setEditing(true)}}
        style={{fontSize:14,lineHeight:1.8,color:C.tx,wordBreak:"keep-all",cursor:"text",
          padding:"4px 0",minHeight:28,whiteSpace:"pre-wrap",
          borderRadius:6,transition:"background 0.15s"}}
        onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.03)"}
        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
        {displayText || <span style={{color:C.txD,fontStyle:"italic"}}>빈 블록</span>}
      </div>
    ) : (
      <div>
        <textarea value={draft} onChange={e=>setDraft(e.target.value)}
          autoFocus rows={Math.max(3, draft.split("\n").length + 1)}
          style={{width:"100%",padding:"8px 10px",borderRadius:8,border:`1px solid ${C.ac}`,
            background:"rgba(0,0,0,0.3)",color:C.tx,fontSize:14,fontFamily:FN,
            lineHeight:1.8,resize:"vertical",outline:"none",boxShadow:`0 0 0 2px ${C.ac}33`}}
          onKeyDown={e=>{
            if(e.key==="Escape"){setEditing(false);}
            if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)){
              e.preventDefault();
              const trimmed = draft.trim();
              onSave(trimmed !== correctedText ? trimmed : null);
              setEditing(false);
            }
          }}/>
        <div style={{display:"flex",gap:4,marginTop:6,justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:11,color:C.txD}}>⌘/Ctrl+Enter 저장 · Esc 취소</span>
          <div style={{display:"flex",gap:4}}>
            <button onClick={()=>setEditing(false)}
              style={{fontSize:11,padding:"4px 12px",borderRadius:5,border:`1px solid ${C.bd}`,
                background:"transparent",color:C.txM,cursor:"pointer"}}>취소</button>
            <button onClick={()=>{
              const trimmed = draft.trim();
              onSave(trimmed !== correctedText ? trimmed : null);
              setEditing(false);
            }} style={{fontSize:11,padding:"4px 12px",borderRadius:5,border:"none",
              background:C.ac,color:"#fff",fontWeight:600,cursor:"pointer"}}>저장</button>
          </div>
        </div>
      </div>
    )}
  </div>;
}

// ── 1차 교정 탭 우측: 수정본 블록 + ✏️ 인라인 편집 ──
export function CorrectionRightBlock({ block, pos, active, onClick, bRef, correctedText, editedVal, isEdited, onSave, onRevert }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const segs = toSegs(block.text, pos, "right");
  const idx = block.index;

  if (editing) {
    return <div ref={bRef} style={{padding:"10px 16px",borderLeft:`4px solid ${C.ac}`,
      background:"rgba(74,108,247,0.08)"}}>
      <div style={{marginBottom:4,display:"flex",alignItems:"center",gap:4}}>
        <Badge name={block.speaker}/>
        <span style={{fontSize:11,color:C.txD,fontFamily:"monospace"}}>{block.timestamp}</span>
        <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,
          background:"rgba(74,108,247,0.15)",color:C.ac}}>편집 중</span>
      </div>
      <textarea value={draft} onChange={e=>setDraft(e.target.value)}
        autoFocus rows={Math.max(3, draft.split("\n").length + 1)}
        style={{width:"100%",padding:"8px 10px",borderRadius:8,border:`1px solid ${C.ac}`,
          background:"rgba(0,0,0,0.3)",color:C.tx,fontSize:14,fontFamily:FN,
          lineHeight:1.8,resize:"vertical",outline:"none",boxShadow:`0 0 0 2px ${C.ac}33`}}
        onKeyDown={e=>{
          if(e.key==="Escape") setEditing(false);
          if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)){
            e.preventDefault();
            const trimmed = draft.trim();
            onSave(trimmed !== correctedText ? trimmed : null);
            setEditing(false);
          }
        }}/>
      <div style={{display:"flex",gap:4,marginTop:6,justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:11,color:C.txD}}>⌘/Ctrl+Enter 저장 · Esc 취소</span>
        <div style={{display:"flex",gap:4}}>
          <button onClick={()=>setEditing(false)}
            style={{fontSize:11,padding:"4px 12px",borderRadius:5,border:`1px solid ${C.bd}`,
              background:"transparent",color:C.txM,cursor:"pointer"}}>취소</button>
          <button onClick={()=>{
            const trimmed = draft.trim();
            onSave(trimmed !== correctedText ? trimmed : null);
            setEditing(false);
          }} style={{fontSize:11,padding:"4px 12px",borderRadius:5,border:"none",
            background:C.ac,color:"#fff",fontWeight:600,cursor:"pointer"}}>저장</button>
        </div>
      </div>
    </div>;
  }

  const displayText = editedVal !== undefined ? editedVal : null;

  return <div ref={bRef} onClick={() => onClick?.(block.index)}
    style={{padding:"10px 16px",borderLeft:`4px solid ${isEdited?"#22C55E":active?"#A855F7":"transparent"}`,
      background:isEdited?"rgba(34,197,94,0.06)":active?"rgba(168,85,247,0.18)":"transparent",
      cursor:"pointer",transition:"all 0.25s ease",position:"relative",
      boxShadow:active?"inset 0 0 0 1px rgba(168,85,247,0.3), 0 0 20px rgba(168,85,247,0.1)":"none",
      borderRadius:active?"0 8px 8px 0":"0"}}>
    <div style={{marginBottom:4,display:"flex",alignItems:"center"}}>
      <Badge name={block.speaker}/>
      <span style={{fontSize:11,color:C.txD,fontFamily:"monospace"}}>{block.timestamp}</span>
      {isEdited && <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,marginLeft:6,
        background:"rgba(34,197,94,0.15)",color:"#22C55E"}}>수정됨</span>}
      <div style={{marginLeft:"auto",display:"flex",gap:3,opacity:0.5,transition:"opacity 0.15s"}}
        onMouseEnter={e=>e.currentTarget.style.opacity="1"}
        onMouseLeave={e=>e.currentTarget.style.opacity="0.5"}>
        {isEdited && <button onClick={e=>{e.stopPropagation();onRevert()}}
          style={{fontSize:10,color:C.txD,background:"none",border:`1px solid ${C.bd}`,borderRadius:4,
            cursor:"pointer",padding:"1px 6px"}} title="되돌리기">↩</button>}
        <button onClick={e=>{e.stopPropagation();setDraft(displayText !== null ? displayText : correctedText);setEditing(true)}}
          style={{fontSize:10,color:C.txM,background:"none",border:`1px solid ${C.bd}`,borderRadius:4,
            cursor:"pointer",padding:"1px 6px"}} title="이 블록 편집">✏️</button>
      </div>
    </div>
    <div style={{fontSize:14,lineHeight:1.8,color:C.tx,wordBreak:"keep-all"}}>
      {displayText !== null
        ? <span>{displayText}</span>
        : segs.map((s,i) => {
            if (s.tp === "filler_applied") return <span key={i}>{s.text}</span>;
            if (s.tp === "term_correction_applied") return <span key={i}>{s.text}</span>;
            if (s.tp === "spelling_applied") return <span key={i}>{s.text}</span>;
            return <span key={i}>{s.text}</span>;
          })
      }
    </div>
  </div>;
}
