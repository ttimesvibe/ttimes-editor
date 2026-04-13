import { useState, useCallback, useRef, useEffect } from "react";
import { C, FN } from "../utils/styles.js";
import { apiSetgen, apiHlTimestamps } from "../utils/api.js";

const SLOPE = 0.001210;
const INTERCEPT = 7.05;
const predictMinutes = (totalChars) => SLOPE * totalChars + INTERCEPT;

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

const TYPE_LABELS = { balanced: "밸런스", trend: "트렌드 공략", focus: "선택과 집중", script: "스크립트 충실" };
const TYPE_COLORS = {
  balanced: { bg: "rgba(91,76,212,0.08)", bd: "rgba(91,76,212,0.2)", tx: "#5B4CD4" },
  trend: { bg: "rgba(59,130,246,0.06)", bd: "rgba(59,130,246,0.15)", tx: "#2563EB" },
  focus: { bg: "rgba(234,88,12,0.06)", bd: "rgba(234,88,12,0.15)", tx: "#EA580C" },
  script: { bg: "rgba(168,85,247,0.06)", bd: "rgba(168,85,247,0.15)", tx: "#9333EA" },
};
const SRC_BADGE = {
  trend: { label: "trend", bg: "rgba(59,130,246,0.06)", bd: "rgba(59,130,246,0.15)", tx: "#2563EB" },
  script: { label: "script", bg: "rgba(168,85,247,0.06)", bd: "rgba(168,85,247,0.15)", tx: "#9333EA" },
  both: { label: "both", bg: "rgba(217,119,6,0.08)", bd: "rgba(217,119,6,0.2)", tx: "#D97706" },
};
const FIELDS = ["thumbnail", "youtube_title", "description"];
const FLABELS = { thumbnail: "썸네일/리스트 제목", youtube_title: "유튜브 제목", description: "유튜브 설명/기사/페북" };

export function SetgenTab({ script, blocks, guestName, guestTitle, sessionId, config, onSave, keywords: suggestedKeywords }) {
  const [gN, setGN] = useState(guestName || "");
  const [gT, setGT] = useState(guestTitle || "");
  const [result, setResult] = useState(null);
  const [trendData, setTrendData] = useState(null);
  const [trendingNow, setTrendingNow] = useState([]);
  const [keywords, setKeywords] = useState([]);
  const [sel, setSel] = useState({});
  const [edits, setEdits] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showTrend, setShowTrend] = useState(false);
  const [focusKw, setFocusKw] = useState("");
  const [timestamps, setTimestamps] = useState(null);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [tsLoading, setTsLoading] = useState(false);
  const [tsCopied, setTsCopied] = useState(false);

  useEffect(() => { if (guestName) setGN(guestName); }, [guestName]);
  useEffect(() => { if (guestTitle) setGT(guestTitle); }, [guestTitle]);

  // 자동 저장
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!onSave || !result) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onSave({ result, trendData, trendingNow, keywords, selections: sel, edits, focusKeyword: focusKw, timestamps, savedAt: new Date().toISOString() });
    }, 5000);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [result, sel, edits, timestamps]);

  const scriptBlocks = blocks?.length > 0 ? blocks : (() => {
    const lines = (script || "").split("\n").filter(l => l.trim());
    const res = [];
    let id = 0;
    const speakerRe = /^([가-힣a-zA-Z]+)\s+(\d{1,2}:\d{2}(?::\d{2})?)/;
    let current = null;
    for (const line of lines) {
      const m = line.match(speakerRe);
      if (m) {
        if (current) res.push(current);
        current = { speaker: m[1], time: m[2], text: line.substring(m[0].length).trim(), id: id++ };
      } else if (current) { current.text += " " + line.trim(); }
    }
    if (current) res.push(current);
    return res;
  })();

  const generateTimestamps = useCallback(async () => {
    if (!script) return;
    setTsLoading(true); setErr(null);
    try {
      const tsResult = await apiHlTimestamps(script, config);
      const chapters = tsResult.chapters || [];
      const totalChars = scriptBlocks.reduce((s, b) => s + (b.text || "").length, 0);
      const totalMin = predictMinutes(totalChars);
      const fullText = scriptBlocks.map(b => b.text || "").join(" ");
      const withTimes = chapters.map((ch, i) => {
        let charPos = 0;
        if (i > 0) {
          const match = findBestMatch(fullText, ch.anchor_text || "");
          charPos = match ? match.start : Math.round((i / chapters.length) * fullText.length);
        }
        const ratio = charPos / fullText.length;
        const timeMin = ratio * totalMin;
        const mm = Math.floor(timeMin);
        const ss = Math.round((timeMin - mm) * 60);
        return { ...ch, time: `${mm}:${ss.toString().padStart(2, "0")}`, ratio, charPos };
      });
      setTimestamps(withTimes);
      setShowTimestamps(true);
    } catch (e) { setErr("타임스탬프 생성 실패: " + e.message); }
    finally { setTsLoading(false); }
  }, [script, scriptBlocks, config]);

  const copyTimestamps = () => {
    if (!timestamps) return;
    navigator.clipboard.writeText(timestamps.map(t => `${t.time} ${t.title}`).join("\n"));
    setTsCopied(true); setTimeout(() => setTsCopied(false), 2000);
  };

  const generate = useCallback(async () => {
    if (!script?.trim()) { setErr("원고를 먼저 업로드하세요."); return; }
    setLoading(true); setErr(null); setResult(null); setTrendData(null); setTrendingNow([]); setKeywords([]); setSel({}); setEdits({});
    const t0 = Date.now();
    const thirdLabel = focusKw.trim() ? "선택과집중" : "스크립트";
    const timer = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      if (s < 5) setLoadMsg("1. 키워드 추출 중...");
      else if (s < 12) setLoadMsg("2. 트렌드 수집 중 (YouTube/Google/Trends/News)...");
      else if (s < 20) setLoadMsg("3. 밸런스형 세트 생성 중...");
      else if (s < 28) setLoadMsg("4. 트렌드형 세트 생성 중...");
      else if (s < 36) setLoadMsg("5. " + thirdLabel + "형 세트 생성 중...");
      else setLoadMsg("결과 취합 중... (" + s + "초)");
    }, 1000);
    try {
      const data = await apiSetgen(script, gN, gT, focusKw, config);
      clearInterval(timer);
      setResult(data.result);
      setTrendData(data.trend_data || null);
      setTrendingNow(data.trending_now || []);
      setKeywords(data.keywords_extracted || []);
      const s = {}; FIELDS.forEach(k => { s[k] = 0; }); setSel(s);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); setLoadMsg(""); clearInterval(timer); }
  }, [script, gN, gT, focusKw, config]);

  const getDisplay = (key, idx) => {
    if (!result || !result[key] || !result[key][idx]) return "";
    const item = result[key][idx];
    return key === "thumbnail" ? (item.lines || []).join("\n") : (item.text || "");
  };
  const getSelected = (key) => { const idx = sel[key] ?? 0; const ek = key + "-" + idx; return edits[ek] !== undefined ? edits[ek] : getDisplay(key, idx); };

  const copyAll = () => {
    const parts = FIELDS.map(k => "<" + FLABELS[k] + ">\n" + getSelected(k));
    if (result?.tags) parts.push("<태그>\n" + result.tags.map(t => t.tag).join(", "));
    navigator.clipboard.writeText(parts.join("\n\n"));
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  if (!script) return <div style={{padding:40,textAlign:"center",color:C.txD,fontSize:14}}>원고 데이터가 없습니다. 먼저 원고를 업로드하세요.</div>;

  // Pre-generate form (before results)
  if (!result && !loading) return <div style={{maxWidth:600,margin:"40px auto",padding:"0 24px"}}>
    <div style={{background:C.sf,borderRadius:14,border:`1px solid ${C.bd}`,padding:24}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:16}}>세트 생성</div>
      <div style={{display:"flex",gap:12,marginBottom:16,alignItems:"flex-end"}}>
        <div style={{width:140,flexShrink:0}}>
          <label style={{fontSize:12,color:C.txD,fontWeight:600,display:"block",marginBottom:4}}>게스트 이름</label>
          <input value={gN} onChange={e=>setGN(e.target.value)} placeholder="박종천"
            style={{width:"100%",padding:"8px 12px",borderRadius:8,border:`1px solid ${C.bd}`,background:"rgba(0,0,0,0.03)",color:C.tx,fontSize:14,fontFamily:FN,outline:"none",boxSizing:"border-box"}}/>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <label style={{fontSize:12,color:C.txD,fontWeight:600,display:"block",marginBottom:4}}>직함/소속</label>
          <input value={gT} onChange={e=>setGT(e.target.value)} placeholder="30년 개발자"
            style={{width:"100%",padding:"8px 12px",borderRadius:8,border:`1px solid ${C.bd}`,background:"rgba(0,0,0,0.03)",color:C.tx,fontSize:14,fontFamily:FN,outline:"none",boxSizing:"border-box"}}/>
        </div>
      </div>
      <div style={{fontSize:12,color:C.txM,marginBottom:16}}>원고 {(script||"").length.toLocaleString()}자</div>
      <div style={{marginBottom:16}}>
        <label style={{fontSize:12,color:"#EA580C",fontWeight:600,display:"block",marginBottom:4}}>집중 키워드 (선택)</label>
        <input value={focusKw} onChange={e=>setFocusKw(e.target.value)} placeholder="예: 애플 중심으로 / 애플과 구글의 전쟁"
          style={{width:"100%",padding:"8px 12px",borderRadius:8,border:"1px solid rgba(234,88,12,0.3)",background:"rgba(234,88,12,0.04)",color:C.tx,fontSize:14,fontFamily:FN,outline:"none",boxSizing:"border-box"}}/>
        <div style={{fontSize:11,color:C.txD,marginTop:4}}>입력하면 3번째 후보가 이 키워드 중심으로 생성됩니다.</div>
        {suggestedKeywords?.length > 0 && <div style={{marginTop:8,display:"flex",flexWrap:"wrap",gap:4}}>
          {suggestedKeywords.map((kw, i) => <button key={i} onClick={()=>setFocusKw(kw)}
            style={{fontSize:11,padding:"2px 8px",borderRadius:6,border:`1px solid rgba(234,88,12,0.2)`,background:"rgba(234,88,12,0.04)",color:"#EA580C",cursor:"pointer"}}>{kw}</button>)}
        </div>}
      </div>
      <button onClick={generate} style={{width:"100%",padding:"12px",borderRadius:10,border:"none",background:`linear-gradient(135deg,#5B4CD4,#7C3AED)`,color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer"}}>
        세트 생성 (키워드 → 트렌드 수집 → 3개 개별 생성)</button>
      {err && <div style={{marginTop:12,padding:"10px 14px",borderRadius:8,background:"rgba(239,68,68,0.06)",color:"#DC2626",fontSize:13}}>{err}</div>}
    </div>
  </div>;

  // Loading state
  if (loading) return <div style={{textAlign:"center",padding:"80px 24px"}}>
    <div style={{fontSize:40,marginBottom:16,animation:"spin 1.5s linear infinite"}}>*</div>
    <div style={{fontSize:15,fontWeight:600,color:C.tx,marginBottom:8}}>{loadMsg}</div>
    <div style={{fontSize:12,color:C.txD}}>총 4회 GPT 호출 (30~50초 소요)</div>
    <div style={{maxWidth:300,margin:"20px auto",height:4,background:C.bd,borderRadius:2,overflow:"hidden"}}>
      <div style={{height:"100%",background:"#5B4CD4",borderRadius:2,animation:"progress 40s linear",width:"0%"}}/>
    </div>
    <style>{"@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}@keyframes progress{from{width:0%}to{width:95%}}"}</style>
  </div>;

  // Results view
  return <div style={{maxWidth:860,margin:"20px auto",padding:"0 20px 60px",overflowY:"auto",maxHeight:"calc(100vh - 90px)"}}>
    {/* Header actions */}
    <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginBottom:14}}>
      <button onClick={timestamps ? ()=>setShowTimestamps(!showTimestamps) : generateTimestamps} disabled={tsLoading}
        style={{fontSize:12,padding:"5px 14px",borderRadius:6,border:"1px solid #8B5CF6",background:tsLoading?"#999":timestamps&&showTimestamps?"#8B5CF6":"rgba(139,92,246,0.08)",color:tsLoading?"#fff":timestamps&&showTimestamps?"#fff":"#8B5CF6",fontWeight:600,cursor:"pointer"}}>
        {tsLoading ? "생성 중..." : timestamps ? (showTimestamps ? "타임스탬프 ▲" : "타임스탬프 ▼") : "타임스탬프"}</button>
      <button onClick={copyAll} style={{fontSize:12,padding:"5px 14px",borderRadius:6,border:"none",background:copied?"#16A34A":"#5B4CD4",color:"#fff",fontWeight:600,cursor:"pointer"}}>
        {copied ? "복사 완료" : "전체 복사"}</button>
      <button onClick={()=>{setResult(null);setTrendData(null);setTrendingNow([]);setKeywords([]);setSel({});setEdits({});setTimestamps(null);}}
        style={{fontSize:12,padding:"5px 14px",borderRadius:6,border:`1px solid ${C.bd}`,background:C.sf,color:C.txM,cursor:"pointer"}}>다시 생성</button>
    </div>

    {/* Timestamp Section */}
    {timestamps && showTimestamps && <div style={{marginBottom:14,borderRadius:14,border:"1px solid rgba(139,92,246,0.3)",background:"rgba(139,92,246,0.04)",overflow:"hidden"}}>
      <div style={{padding:"12px 18px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid rgba(139,92,246,0.15)"}}>
        <div style={{fontSize:14,fontWeight:700,color:"#8B5CF6"}}>타임스탬프 ({timestamps.length}개)</div>
        <div style={{display:"flex",gap:6}}>
          <button onClick={generateTimestamps} disabled={tsLoading} style={{fontSize:11,padding:"3px 10px",borderRadius:5,border:"1px solid rgba(139,92,246,0.3)",background:"transparent",color:"#8B5CF6",cursor:"pointer",fontWeight:600}}>
            {tsLoading ? "생성 중..." : "재생성"}</button>
          <button onClick={copyTimestamps} style={{fontSize:11,padding:"3px 10px",borderRadius:5,border:"1px solid rgba(139,92,246,0.3)",background:tsCopied?"#8B5CF6":"transparent",color:tsCopied?"#fff":"#8B5CF6",cursor:"pointer",fontWeight:600}}>
            {tsCopied ? "복사됨" : "복사"}</button>
        </div>
      </div>
      <div style={{padding:"10px 18px 14px"}}>
        {timestamps.map((t, i) => <div key={i} style={{padding:"6px 0",borderBottom:i<timestamps.length-1?"1px solid rgba(139,92,246,0.08)":"none",display:"flex",gap:10,alignItems:"flex-start"}}>
          <span style={{fontSize:13,fontWeight:700,color:"#8B5CF6",flexShrink:0,fontVariantNumeric:"tabular-nums",minWidth:36}}>{t.time}</span>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:C.tx,lineHeight:1.5}}>{t.title}</div>
            {t.summary && <div style={{fontSize:11,color:C.txD,marginTop:2,lineHeight:1.4}}>{t.summary}</div>}
          </div>
        </div>)}
        <div style={{marginTop:10,padding:"8px 10px",borderRadius:6,background:"rgba(139,92,246,0.06)",fontSize:11,color:C.txD,lineHeight:1.5}}>
          예상 영상 길이: <strong style={{color:"#8B5CF6"}}>{Math.floor(predictMinutes(scriptBlocks.reduce((s,b)=>s+(b.text||"").length,0)))}분 {Math.round((predictMinutes(scriptBlocks.reduce((s,b)=>s+(b.text||"").length,0)) % 1) * 60)}초</strong>
        </div>
      </div>
    </div>}

    {/* Tags */}
    {result.tags?.length > 0 && <div style={{background:C.sf,borderRadius:14,border:`1px solid ${C.bd}`,padding:"18px 22px",marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <span style={{fontSize:14,fontWeight:700}}>추천 태그 ({result.tags.length}개)</span>
        <button onClick={()=>navigator.clipboard.writeText(result.tags.map(t=>t.tag).join(", "))}
          style={{fontSize:11,padding:"3px 10px",borderRadius:5,border:`1px solid ${C.bd}`,background:C.sf,color:C.txM,cursor:"pointer"}}>태그 복사</button>
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
        {result.tags.map((t, i) => { const sb = SRC_BADGE[t.source] || SRC_BADGE.script;
          return <div key={i} style={{display:"inline-flex",alignItems:"center",gap:4,padding:"4px 10px",borderRadius:8,background:sb.bg,border:`1px solid ${sb.bd}`,fontSize:12,cursor:"default"}} title={t.reason}>
            <span style={{fontWeight:600,color:sb.tx}}>{t.tag}</span>
            <span style={{fontSize:9,color:sb.tx,opacity:0.7}}>{sb.label}</span>
          </div>; })}
      </div>
      <details><summary style={{fontSize:11,color:C.txD,cursor:"pointer"}}>태그별 추천 근거</summary>
        <div style={{marginTop:8,fontSize:12,color:C.txM,lineHeight:1.8}}>
          {result.tags.map((t, i) => <div key={i} style={{marginBottom:4}}><span style={{fontWeight:600,color:C.tx}}>{t.tag}</span> — {t.reason}</div>)}
        </div>
      </details>
    </div>}

    {/* Trend Data */}
    {(trendData || trendingNow.length > 0) && <div style={{marginBottom:14}}>
      <button onClick={()=>setShowTrend(!showTrend)} style={{fontSize:12,color:"#2563EB",background:"rgba(59,130,246,0.06)",border:"1px solid rgba(59,130,246,0.15)",padding:"6px 14px",borderRadius:8,cursor:"pointer",fontWeight:600}}>
        {showTrend ? "트렌드 접기" : "수집된 트렌드 데이터 보기"}</button>
      {showTrend && <div style={{background:C.sf,borderRadius:12,border:`1px solid ${C.bd}`,padding:16,marginTop:8,maxHeight:500,overflowY:"auto"}}>
        {trendingNow.length > 0 && <div style={{marginBottom:16}}>
          <div style={{fontSize:13,fontWeight:700,color:"#DC2626",marginBottom:8}}>Google Trends 급상승</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {trendingNow.map((t, i) => <span key={i} style={{fontSize:11,padding:"3px 8px",borderRadius:6,background:"rgba(239,68,68,0.06)",border:"1px solid rgba(239,68,68,0.15)",color:"#DC2626"}}>{t}</span>)}
          </div>
        </div>}
        {trendData && Object.entries(trendData).map(([kw, d]) => <div key={kw} style={{marginBottom:14}}>
          <div style={{fontSize:13,fontWeight:700,color:C.tx,marginBottom:4}}>
            "{kw}" <span style={{fontSize:11,fontWeight:400,color:d.news_24h>5?"#DC2626":C.txD}}>뉴스 {d.news_24h}건/24h</span>
          </div>
          <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
            {d.youtube?.length > 0 && <div style={{flex:1,minWidth:200}}>
              <div style={{fontSize:10,fontWeight:700,color:"#2563EB",marginBottom:4}}>YouTube</div>
              {d.youtube.map((s, i) => <div key={i} style={{fontSize:12,color:C.txM,padding:"1px 0"}}>{i+1}. {s}</div>)}
            </div>}
            {d.google?.length > 0 && <div style={{flex:1,minWidth:200}}>
              <div style={{fontSize:10,fontWeight:700,color:"#16A34A",marginBottom:4}}>Google</div>
              {d.google.map((s, i) => <div key={i} style={{fontSize:12,color:C.txM,padding:"1px 0"}}>{i+1}. {s}</div>)}
            </div>}
          </div>
        </div>)}
      </div>}
    </div>}

    {/* Set Fields */}
    {FIELDS.map(key => {
      const cands = result[key] || []; if (cands.length === 0) return null;
      const si = sel[key] ?? 0;
      const item = cands[si];
      return <div key={key} style={{background:C.sf,borderRadius:14,border:`1px solid ${C.bd}`,padding:"20px 22px",marginBottom:14}}>
        <div style={{fontSize:15,fontWeight:700,marginBottom:14}}>{FLABELS[key]}</div>
        <div style={{display:"flex",gap:8,marginBottom:12}}>
          {cands.map((c, ci) => { const tc = TYPE_COLORS[c.type] || TYPE_COLORS.balanced; const isSel = si === ci;
            return <button key={ci} onClick={() => setSel(p => ({...p, [key]: ci}))}
              style={{fontSize:12,fontWeight:600,padding:"5px 14px",borderRadius:8,cursor:"pointer",
                border:`1px solid ${isSel ? tc.bd : "transparent"}`,background:isSel ? tc.bg : "rgba(0,0,0,0.04)",color:isSel ? tc.tx : C.txD}}>
              {TYPE_LABELS[c.type] || c.type}</button>; })}
        </div>
        <textarea value={edits[key + "-" + si] !== undefined ? edits[key + "-" + si] : getDisplay(key, si)}
          onChange={e => setEdits(p => ({...p, [key + "-" + si]: e.target.value}))}
          rows={key === "description" ? 6 : key === "thumbnail" ? 3 : 2}
          style={{width:"100%",padding:"10px 12px",borderRadius:8,border:`1px solid ${C.bd}`,background:"rgba(0,0,0,0.03)",color:C.tx,fontSize:14,fontFamily:FN,lineHeight:1.7,resize:"vertical",outline:"none",boxSizing:"border-box"}}/>
        {item?.reason && <div style={{marginTop:8,padding:"8px 12px",borderRadius:8,background:"rgba(0,0,0,0.02)",fontSize:12,color:C.txD,lineHeight:1.6}}>
          <span style={{fontWeight:600}}>근거:</span> {item.reason}</div>}
        <div style={{display:"flex",justifyContent:"flex-end",marginTop:6}}>
          <button onClick={() => navigator.clipboard.writeText(getSelected(key))}
            style={{fontSize:11,padding:"3px 10px",borderRadius:5,border:`1px solid ${C.bd}`,background:C.sf,color:C.txM,cursor:"pointer"}}>복사</button>
        </div>
      </div>; })}
  </div>;
}
