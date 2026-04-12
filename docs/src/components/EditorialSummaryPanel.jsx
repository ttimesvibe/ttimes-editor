import { C } from "../utils/styles.js";

export function EditorialSummaryPanel({ summary, collapsed, onToggle }) {
  if (!summary) return null;
  return <div style={{background:C.sf,borderRadius:12,border:`1px solid ${C.bd}`,overflow:"hidden",marginBottom:16}}>
    <div onClick={onToggle} style={{padding:"14px 16px",borderBottom:collapsed?"none":`1px solid ${C.bd}`,display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
      <span style={{fontSize:15,fontWeight:700,color:C.tx}}>📋 콘텐츠 요약</span>
      <span style={{fontSize:12,color:C.txD}}>{collapsed?"▸ 펼치기":"▾ 접기"}</span>
    </div>
    {!collapsed && <div style={{padding:16}}>
      {summary.one_liner && <div style={{fontSize:17,fontWeight:700,color:C.tx,marginBottom:14,lineHeight:1.5}}>{summary.one_liner}</div>}
      {summary.key_points?.length > 0 && <div style={{marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:C.txD,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>핵심 논점</div>
        {summary.key_points.map((p,i) => <div key={i} style={{fontSize:15,color:C.txM,lineHeight:1.6,
          marginBottom:8,display:"flex",gap:8,alignItems:"flex-start"}}>
          <span style={{flexShrink:0,fontSize:14,lineHeight:"1.5"}}>✅</span>
          <span>{p}</span>
        </div>)}
      </div>}
      {summary.notable_quotes?.length > 0 && <div style={{marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:C.txD,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>핵심 발언</div>
        {summary.notable_quotes.map((q,i) => <div key={i} style={{fontSize:15,color:C.tx,lineHeight:1.6,marginBottom:10,
          padding:"10px 14px",background:"rgba(255,255,255,0.04)",borderRadius:8,borderLeft:`3px solid ${C.fTx||C.ac}`}}>
          <div style={{fontSize:12,color:C.fTx||C.ac,fontWeight:600,marginBottom:4}}>{q.speaker||""}</div>
          <div style={{fontStyle:"italic"}}>"{q.quote||q}"</div>
        </div>)}
      </div>}
      {summary.editor_notes && <div>
        <div style={{fontSize:13,fontWeight:700,color:C.txD,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>편집 참고</div>
        <div style={{fontSize:14,color:C.txM,lineHeight:1.6,padding:"8px 12px",background:"rgba(255,255,255,0.04)",borderRadius:6}}>{summary.editor_notes}</div>
      </div>}
    </div>}
  </div>;
}
