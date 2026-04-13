import { useState, useCallback, useRef, useEffect } from "react";
import { C, FN } from "../utils/styles.js";
import { apiHlRecommend } from "../utils/api.js";

const CPS = 9.0; // ttimes 학습 데이터 기준 542.7자/분

function findBestMatch(blockText, clipText) {
  let idx = blockText.indexOf(clipText);
  if (idx >= 0) return { start: idx, end: idx + clipText.length, exact: true };
  const minChunk = 3;
  if (clipText.length < minChunk) return null;
  let bestStart = -1, bestEnd = -1, bestLen = 0;
  for (let len = Math.min(clipText.length, 40); len >= minChunk; len -= 5) {
    const headChunk = clipText.substring(0, len);
    const hIdx = blockText.indexOf(headChunk);
    if (hIdx >= 0 && len > bestLen) {
      const tailChunk = clipText.slice(-Math.min(len, 30));
      const tIdx = blockText.indexOf(tailChunk, hIdx);
      if (tIdx >= 0) { bestStart = hIdx; bestEnd = tIdx + tailChunk.length; bestLen = bestEnd - bestStart; break; }
      else { bestStart = hIdx; bestEnd = Math.min(hIdx + clipText.length + 10, blockText.length); bestLen = len; }
    }
  }
  if (bestStart >= 0 && bestLen >= minChunk) return { start: bestStart, end: bestEnd, exact: false };
  for (let len = Math.min(clipText.length, 40); len >= minChunk; len -= 5) {
    const tailChunk = clipText.slice(-len);
    const tIdx = blockText.indexOf(tailChunk);
    if (tIdx >= 0) return { start: Math.max(0, tIdx - clipText.length + len), end: tIdx + tailChunk.length, exact: false };
  }
  return null;
}

export function HighlightTab({ script, blocks, sessionId, config, onSave }) {
  const [clips, setClips] = useState([]);
  const [recs, setRecs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showRecs, setShowRecs] = useState(true);

  // 초기 데이터 로드 (App.jsx에서 전달)
  const initializedRef = useRef(false);

  // 클립 변경 시 자동 저장 debounce
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!onSave || clips.length === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onSave({ clips, recs, savedAt: new Date().toISOString() });
    }, 5000);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [clips, recs]);

  const scriptBlocks = blocks.length > 0 ? blocks : (() => {
    const lines = (script || "").split("\n").filter(l => l.trim());
    const result = [];
    let id = 0;
    const speakerRe = /^([가-힣a-zA-Z]+)\s+(\d{1,2}:\d{2}(?::\d{2})?)/;
    let current = null;
    for (const line of lines) {
      const m = line.match(speakerRe);
      if (m) {
        if (current) result.push(current);
        current = { speaker: m[1], time: m[2], text: line.substring(m[0].length).trim(), id: id++ };
      } else if (current) { current.text += " " + line.trim(); }
    }
    if (current) result.push(current);
    return result;
  })();

  const getRecommendations = useCallback(async () => {
    if (!script) return;
    setLoading(true); setErr(null);
    try {
      const result = await apiHlRecommend(script, config);
      setRecs(result.candidates || []);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [script, config]);

  const handleTextSelect = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const text = sel.toString().trim();
    if (text.length < 3) return;
    if (clips.some(c => c.originalText === text)) return;
    let blockId = null;
    let node = sel.anchorNode;
    while (node && node !== document.body) {
      if (node.dataset && node.dataset.blockid !== undefined) { blockId = parseInt(node.dataset.blockid); break; }
      node = node.parentNode;
    }
    setClips(prev => [...prev, { id: Date.now() + Math.random(), text, originalText: text, blockId, seconds: Math.round(text.length / CPS) }]);
    sel.removeAllRanges();
  }, [clips]);

  const addFromRec = (rec) => {
    if (clips.some(c => c.originalText === rec.text || c.text === rec.text)) return;
    let blockId = null;
    for (const b of scriptBlocks) { if (findBestMatch(b.text || "", rec.text)) { blockId = b.id; break; } }
    setClips(prev => [...prev, { id: Date.now() + Math.random(), text: rec.text, originalText: rec.text, blockId, seconds: Math.round(rec.text.length / CPS), reason: rec.reason }]);
    if (blockId !== null) {
      setTimeout(() => {
        const el = document.querySelector(`[data-blockid="${blockId}"]`);
        if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.style.transition = "box-shadow 0.3s"; el.style.boxShadow = `0 0 0 2px ${C.ac}`; setTimeout(() => { el.style.boxShadow = ""; }, 1500); }
      }, 50);
    }
  };

  const removeClip = (id) => setClips(prev => prev.filter(c => c.id !== id));
  const handleDragStart = (idx) => setDragIdx(idx);
  const handleDragOver = (e, idx) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;
    setClips(prev => { const next = [...prev]; const [m] = next.splice(dragIdx, 1); next.splice(idx, 0, m); return next; });
    setDragIdx(idx);
  };
  const handleDragEnd = () => setDragIdx(null);

  const totalSeconds = clips.reduce((s, c) => s + (c.seconds || Math.round(c.text.length / CPS)), 0);
  const getTimeColor = () => {
    if (totalSeconds >= 30 && totalSeconds <= 40) return C.ok || "#16A34A";
    if (totalSeconds > 40) return "#DC2626";
    return C.txD;
  };

  const copyAll = () => {
    navigator.clipboard.writeText(clips.map(c => c.text).join("\n"));
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  const scrollToClip = (clip) => {
    const matchText = clip.originalText || clip.text;
    let targetId = clip.blockId;
    if (targetId === null || targetId === undefined) {
      for (const b of scriptBlocks) { if (findBestMatch(b.text || "", matchText)) { targetId = b.id; break; } }
    }
    if (targetId !== null && targetId !== undefined) {
      const el = document.querySelector(`[data-blockid="${targetId}"]`);
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.style.transition = "box-shadow 0.3s"; el.style.boxShadow = `0 0 0 2px ${C.ac}`; setTimeout(() => { el.style.boxShadow = ""; }, 1500); }
    }
  };

  const renderBlock = (block) => {
    let html = block.text || "";
    for (const clip of clips) {
      if (clip.blockId !== null && clip.blockId !== undefined && clip.blockId !== block.id) continue;
      const matchText = clip.originalText || clip.text;
      const match = findBestMatch(html, matchText);
      if (match) {
        const before = html.substring(0, match.start);
        if (before.lastIndexOf("<mark") > before.lastIndexOf("</mark>")) continue;
        const snippet = html.substring(match.start, match.end);
        html = before + `<mark style="background:rgba(0,229,255,0.18);border-bottom:2px solid #00E5FF;padding:1px 0">${snippet}</mark>` + html.substring(match.end);
      }
    }
    if (showRecs) {
      for (const rec of recs) {
        if (clips.some(c => (c.originalText || c.text) === rec.text)) continue;
        const idx = html.indexOf(rec.text);
        if (idx >= 0 && !html.substring(Math.max(0, idx - 50), idx).includes("<mark")) {
          html = html.substring(0, idx) + `<span style="background:rgba(217,119,6,0.06);border-bottom:1px dashed #D97706;padding:1px 0;cursor:pointer" title="AI 추천: ${rec.reason}">${rec.text}</span>` + html.substring(idx + rec.text.length);
        }
      }
    }
    return html;
  };

  if (!script) return <div style={{padding:40,textAlign:"center",color:C.txD,fontSize:14}}>원고 데이터가 없습니다. 먼저 원고를 업로드하세요.</div>;

  return <div style={{display:"flex",height:"calc(100vh - 90px)",overflow:"hidden"}}>
    {/* Left: Script */}
    <div style={{flex:1,overflowY:"auto",padding:"16px 20px",borderRight:`1px solid ${C.bd}`}} onMouseUp={handleTextSelect}>
      {/* Controls */}
      <div style={{marginBottom:16,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        {recs.length === 0 && <button onClick={getRecommendations} disabled={loading}
          style={{padding:"8px 18px",borderRadius:8,border:"none",background:`linear-gradient(135deg,${C.ac},#06B6D4)`,color:"#fff",fontSize:13,fontWeight:600,cursor:loading?"wait":"pointer",opacity:loading?0.6:1}}>
          {loading ? "AI 분석 중..." : "AI 하이라이트 추천"}</button>}
        {recs.length > 0 && <button onClick={()=>setShowRecs(!showRecs)}
          style={{padding:"5px 12px",borderRadius:6,border:"1px solid rgba(217,119,6,0.15)",background:"rgba(217,119,6,0.06)",color:"#D97706",fontSize:12,fontWeight:600,cursor:"pointer"}}>
          {showRecs ? "AI 추천 숨기기" : "AI 추천 표시"}</button>}
        <span style={{fontSize:12,color:C.txD}}>원고를 드래그하여 직접 선택할 수도 있습니다</span>
        <div style={{marginLeft:"auto",display:"flex",gap:8}}>
          {clips.length > 0 && <button onClick={copyAll}
            style={{fontSize:12,padding:"5px 14px",borderRadius:6,border:`1px solid ${C.bd}`,background:C.sf,color:C.txM,cursor:"pointer"}}>
            {copied?"복사됨":"텍스트 복사"}</button>}
        </div>
      </div>

      {err && <div style={{marginBottom:12,padding:"10px 14px",borderRadius:8,background:"rgba(220,38,38,0.08)",color:"#DC2626",fontSize:13}}>{err}</div>}

      {scriptBlocks.map(block => {
        const isHost = ["홍재의"].includes(block.speaker);
        return <div key={block.id} data-blockid={block.id} style={{marginBottom:12,padding:"8px 12px",borderRadius:8,
          background:isHost?"rgba(0,0,0,0.02)":C.sf,border:`1px solid ${isHost?"rgba(0,0,0,0.06)":C.bd}`}}>
          <div style={{fontSize:11,color:isHost?C.txD:C.txM,marginBottom:4,fontWeight:600}}>
            {block.speaker} <span style={{fontWeight:400}}>{block.time || block.timestamp || ""}</span>
          </div>
          <div style={{fontSize:14,lineHeight:1.8,color:isHost?C.txM:C.tx}} dangerouslySetInnerHTML={{__html: renderBlock(block)}}/>
        </div>;
      })}
    </div>

    {/* Right: Clip Panel */}
    <div style={{width:360,flexShrink:0,overflowY:"auto",background:C.sf,padding:"16px 16px"}}>
      <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>하이라이트 구성</div>
      <div style={{fontSize:12,color:C.txD,marginBottom:12}}>
        {clips.length}개 클립 · <span style={{fontWeight:700,color:getTimeColor()}}>{totalSeconds}초</span> / 30~40초
      </div>

      {/* Progress bar */}
      <div style={{height:6,background:C.bd,borderRadius:3,marginBottom:16,overflow:"hidden",position:"relative"}}>
        <div style={{height:"100%",borderRadius:3,transition:"width 0.3s",
          width:Math.min(totalSeconds/40*100,100)+"%",
          background:totalSeconds>40?"#DC2626":totalSeconds>=30?(C.ok||"#16A34A"):C.ac}}/>
        <div style={{position:"absolute",left:"75%",top:0,width:1,height:"100%",background:C.txD,opacity:0.4}}/>
      </div>

      {clips.length === 0 && <div style={{textAlign:"center",padding:"40px 16px",color:C.txD,fontSize:13}}>
        왼쪽 원고에서 텍스트를 드래그하여<br/>하이라이트 구간을 추가하세요.
      </div>}

      {clips.map((clip, idx) => <div key={clip.id} draggable
        onDragStart={()=>handleDragStart(idx)} onDragOver={e=>handleDragOver(e,idx)} onDragEnd={handleDragEnd}
        style={{padding:"10px 12px",marginBottom:8,borderRadius:8,border:"1px solid rgba(0,229,255,0.4)",
          background:"rgba(0,229,255,0.18)",cursor:"grab",opacity:dragIdx===idx?0.5:1}}>
        <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
          <span onClick={()=>scrollToClip(clip)} style={{fontSize:11,color:C.ac,fontWeight:800,flexShrink:0,marginTop:8,cursor:"pointer",userSelect:"none"}} title="원고에서 찾기">{idx+1}</span>
          <div style={{flex:1,minWidth:0}}>
            <textarea value={clip.text}
              onMouseDown={e=>e.stopPropagation()} onDragStart={e=>e.stopPropagation()}
              onChange={e=>{const v=e.target.value;setClips(prev=>prev.map(c=>c.id===clip.id?{...c,text:v,seconds:Math.round(v.length/CPS)}:c))}}
              style={{fontSize:13,lineHeight:1.6,color:C.tx,width:"100%",border:"1px solid transparent",
                background:"rgba(255,255,255,0.5)",borderRadius:4,resize:"none",outline:"none",fontFamily:FN,
                padding:"4px 6px",cursor:"text",boxSizing:"border-box"}}
              onFocus={e=>{e.target.style.borderColor=C.ac;e.target.style.background="#fff"}}
              onBlur={e=>{e.target.style.borderColor="transparent";e.target.style.background="rgba(255,255,255,0.5)"}}
              rows={Math.max(2,Math.ceil(clip.text.length/28))}/>
            <div onClick={()=>scrollToClip(clip)} style={{fontSize:11,color:C.txD,marginTop:4,cursor:"pointer"}} title="원고에서 찾기">~{clip.seconds || Math.round(clip.text.length/CPS)}초</div>
          </div>
          <button onClick={()=>removeClip(clip.id)}
            style={{fontSize:14,color:C.txD,background:"none",border:"none",cursor:"pointer",flexShrink:0,padding:"0 4px"}}>x</button>
        </div>
      </div>)}

      {/* AI Recommendations */}
      {recs.length > 0 && <div style={{marginTop:20}}>
        <div style={{fontSize:13,fontWeight:700,color:"#D97706",marginBottom:8}}>
          AI 추천 ({recs.filter(r=>!clips.some(c=>c.text===r.text)).length}개 남음)
        </div>
        {recs.filter(r => !clips.some(c => c.text === r.text)).map((rec, i) => <div key={i}
          onClick={() => addFromRec(rec)}
          style={{padding:"8px 10px",marginBottom:6,borderRadius:8,border:"1px solid rgba(217,119,6,0.15)",
            background:"rgba(217,119,6,0.06)",cursor:"pointer"}}>
          <div style={{fontSize:12,lineHeight:1.6,color:C.tx}}>{rec.text}</div>
          <div style={{fontSize:11,color:"#D97706",marginTop:4}}>
            {rec.impact === "high" ? "*" : "o"} {rec.reason} · ~{rec.estimated_seconds || Math.round(rec.text.length/CPS)}초
          </div>
        </div>)}
      </div>}
    </div>
  </div>;
}
