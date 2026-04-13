import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { C, FN, MARKER_COLORS } from "../utils/styles.js";
import { apiCall } from "../utils/api.js";
import { MarkedText } from "../components/BlockComponents.jsx";

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════
const VIS_COLORS = ["#3B82F6","#8B5CF6","#EF4444","#22C55E","#F59E0B","#EC4899","#06B6D4","#F97316"];
const VIS_CATEGORIES = [
  {value:"",label:"🎯 AI 자동 선택"},{value:"bar",label:"📊 막대 차트"},{value:"bar_horizontal",label:"📊 수평 막대"},
  {value:"line",label:"📈 라인"},{value:"donut",label:"🍩 도넛"},{value:"kpi",label:"🔢 KPI"},
  {value:"table",label:"📋 표"},{value:"comparison",label:"⚖️ 비교"},{value:"ranking",label:"🏆 랭킹"},
  {value:"process",label:"🔄 프로세스"},{value:"timeline",label:"📅 타임라인"},{value:"structure",label:"🧱 구조도"},
  {value:"cycle",label:"♻️ 순환"},{value:"matrix",label:"📐 매트릭스"},{value:"hierarchy",label:"🌳 계층도"},
  {value:"radar",label:"🕸 레이더"},{value:"venn",label:"⭕ 벤"},{value:"network",label:"🔗 네트워크"},
  {value:"stack",label:"📚 스택"},{value:"progress",label:"📏 진행률"},{value:"checklist",label:"☑️ 체크리스트"},
];
const IC_TYPE = { A:{icon:"🎨",label:"회상 일러스트",color:"#8B5CF6"}, B:{icon:"🏢",label:"공식 이미지/유튜브",color:"#3B82F6"}, C:{icon:"🏆",label:"작품/성과물",color:"#F59E0B"} };

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════
// VISUAL MOCKUP (21종 차트 렌더러)
// ═══════════════════════════════════════
function VisualMockup({ type, chart_data, title }) {
  if (!chart_data) return <div style={{padding:12,fontSize:12,color:C.txD}}>데이터 없음</div>;
  const wrap = (ch) => (
    <div style={{background:"rgba(0,0,0,0.3)",borderRadius:10,padding:14,marginTop:8}}>
      {title && <div style={{fontSize:12,fontWeight:700,color:C.tx,marginBottom:10,textAlign:"center"}}>{title}</div>}
      {ch}
    </div>
  );

  // BAR / BAR_HORIZONTAL / BAR_STACKED
  if (["bar","bar_horizontal","bar_stacked"].includes(type)) {
    const d = chart_data, labels = d.labels||[], datasets = d.datasets||[];
    const maxVal = Math.max(...datasets.flatMap(ds=>ds.data||[]),1);
    const isH = type==="bar_horizontal";
    return wrap(<div style={{display:"flex",flexDirection:"column",gap:6}}>
      {isH ? labels.map((lb,i) => <div key={i} style={{display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontSize:11,color:C.txM,width:80,textAlign:"right",flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{lb}</span>
        <div style={{flex:1,display:"flex",gap:2}}>
          {datasets.map((ds,vi) => <div key={vi} style={{height:20,borderRadius:3,background:(ds.colors||VIS_COLORS)[i%VIS_COLORS.length],
            width:`${((ds.data||[])[i]||0)/maxVal*100}%`,minWidth:2}}/>)}
        </div>
        <span style={{fontSize:10,color:C.txD,width:40}}>{datasets.map(ds=>(ds.data||[])[i]||0).join("/")}{d.unit||""}</span>
      </div>) : <div style={{display:"flex",alignItems:"flex-end",gap:4,height:120,padding:"0 4px"}}>
        {labels.map((lb,i) => <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
          <div style={{width:"100%",display:"flex",flexDirection:"column-reverse",height:100}}>
            {datasets.map((ds,di) => {const v=(ds.data||[])[i]||0; return <div key={di} style={{width:"80%",margin:"0 auto",
              height:`${(v/maxVal)*100}%`,background:(ds.colors||VIS_COLORS)[type==="bar_stacked"?di:i%VIS_COLORS.length],
              borderRadius:type==="bar_stacked"?0:3,minHeight:v>0?2:0}}/>;
            })}
          </div>
          <span style={{fontSize:9,color:C.txD,textAlign:"center",lineHeight:1.2}}>{lb}</span>
        </div>)}
      </div>}
      {datasets.length>1 && <div style={{display:"flex",gap:8,justifyContent:"center",marginTop:4}}>
        {datasets.map((ds,di) => <span key={di} style={{fontSize:10,color:C.txM,display:"flex",alignItems:"center",gap:3}}>
          <span style={{width:8,height:8,borderRadius:2,background:VIS_COLORS[di%VIS_COLORS.length]}}/>{ds.label}
        </span>)}
      </div>}
    </div>);
  }

  // LINE / AREA
  if (["line","area"].includes(type)) {
    const d=chart_data, labels=d.labels||[], datasets=d.datasets||[];
    const all=datasets.flatMap(ds=>ds.data||[]), mn=Math.min(...all), mx=Math.max(...all), range=mx-mn||1;
    return wrap(<div>
      <svg viewBox="0 0 200 100" style={{width:"100%",height:100}}>
        {datasets.map((ds,di) => {
          const pts=(ds.data||[]).map((v,i)=>`${i*(200/Math.max(labels.length-1,1))},${90-((v-mn)/range)*80}`);
          const c=(ds.colors||VIS_COLORS)[di%VIS_COLORS.length];
          return <g key={di}>
            {type==="area"&&<polygon points={`0,90 ${pts.join(" ")} ${(ds.data.length-1)*(200/Math.max(labels.length-1,1))},90`} fill={c} fillOpacity={0.15}/>}
            <polyline points={pts.join(" ")} fill="none" stroke={c} strokeWidth={2}/>
            {(ds.data||[]).map((v,i)=><circle key={i} cx={i*(200/Math.max(labels.length-1,1))} cy={90-((v-mn)/range)*80} r={3} fill={c}/>)}
          </g>;
        })}
      </svg>
      <div style={{display:"flex",justifyContent:"space-between",padding:"0 4px"}}>
        {labels.map((lb,i)=><span key={i} style={{fontSize:9,color:C.txD}}>{lb}</span>)}
      </div>
    </div>);
  }

  // DONUT
  if (type==="donut") {
    const ds=(chart_data.datasets||[])[0]||{}, data=ds.data||[], colors=ds.colors||VIS_COLORS;
    const total=data.reduce((s,v)=>s+v,0)||1; let acc=0;
    return wrap(<div style={{display:"flex",alignItems:"center",gap:16}}>
      <svg viewBox="0 0 100 100" style={{width:90,height:90}}>
        {data.map((v,i) => {const pct=v/total,start=acc; acc+=pct;
          const x1=50+40*Math.cos(2*Math.PI*start-Math.PI/2),y1=50+40*Math.sin(2*Math.PI*start-Math.PI/2);
          const x2=50+40*Math.cos(2*Math.PI*(start+pct)-Math.PI/2),y2=50+40*Math.sin(2*Math.PI*(start+pct)-Math.PI/2);
          return <path key={i} d={`M50,50 L${x1},${y1} A40,40 0 ${pct>0.5?1:0},1 ${x2},${y2} Z`} fill={colors[i%colors.length]} stroke="rgba(0,0,0,0.3)" strokeWidth={0.5}/>;
        })}
        <circle cx={50} cy={50} r={22} fill={C.sf}/>
      </svg>
      <div style={{display:"flex",flexDirection:"column",gap:3}}>
        {(chart_data.labels||[]).map((lb,i)=><span key={i} style={{fontSize:11,color:C.txM,display:"flex",alignItems:"center",gap:4}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:colors[i%colors.length]}}/>{lb} ({data[i]}{chart_data.unit||""})
        </span>)}
      </div>
    </div>);
  }

  // COMPARISON
  if (type==="comparison") {
    const cols=chart_data.columns||[];
    return wrap(<div>
      <div style={{display:"grid",gridTemplateColumns:`repeat(${cols.length},1fr)`,gap:8}}>
        {cols.map((col,ci) => {
          const tone=col.tone, hdrBg=tone==="positive"?"rgba(34,197,94,0.15)":tone==="negative"?"rgba(239,68,68,0.15)":"rgba(59,130,246,0.15)";
          const hdrColor=tone==="positive"?"#22C55E":tone==="negative"?"#EF4444":"#3B82F6";
          return <div key={ci}>
            <div style={{padding:"6px 10px",borderRadius:6,background:hdrBg,marginBottom:6,textAlign:"center",fontSize:12,fontWeight:700,color:hdrColor}}>{col.label}</div>
            {(col.items||[]).map((item,ii)=><div key={ii} style={{padding:"4px 8px",fontSize:11,color:C.txM,borderLeft:`2px solid ${hdrColor}`,marginBottom:4,paddingLeft:8}}>{item}</div>)}
          </div>;
        })}
      </div>
      {chart_data.footer && <div style={{marginTop:8,fontSize:11,color:C.txD,textAlign:"center",fontStyle:"italic"}}>{chart_data.footer}</div>}
    </div>);
  }

  // TABLE
  if (type==="table") {
    const h=chart_data.headers||[], rows=chart_data.rows||[], hlR=new Set(chart_data.highlight_rows||[]);
    return wrap(<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
      <thead><tr>{h.map((hd,i)=><th key={i} style={{padding:"6px 8px",textAlign:"left",borderBottom:`2px solid ${C.ac}`,color:C.ac,fontWeight:700}}>{hd}</th>)}</tr></thead>
      <tbody>{rows.map((row,ri)=><tr key={ri} style={{background:hlR.has(ri)?"rgba(59,130,246,0.1)":"transparent"}}>
        {row.map((cell,ci)=><td key={ci} style={{padding:"5px 8px",borderBottom:`1px solid ${C.bd}`,color:C.txM,fontWeight:hlR.has(ri)?600:400}}>{cell}</td>)}
      </tr>)}</tbody>
    </table></div>);
  }

  // PROCESS
  if (type==="process") {
    const steps=chart_data.steps||[];
    return wrap(<div style={{display:"flex",flexDirection:"column",gap:2}}>
      {steps.map((step,i)=><div key={i}>
        <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
          <div style={{width:28,height:28,borderRadius:"50%",background:C.ac,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{i+1}</div>
          <div style={{flex:1,paddingTop:3}}><div style={{fontSize:12,fontWeight:600,color:C.tx}}>{step.label}</div>
            {step.description&&<div style={{fontSize:10,color:C.txD,marginTop:1}}>{step.description}</div>}</div>
        </div>
        {i<steps.length-1&&<div style={{width:2,height:16,background:C.bd,marginLeft:13}}/>}
      </div>)}
    </div>);
  }

  // STRUCTURE
  if (type==="structure") {
    const items=chart_data.items||[];
    const cm={purple:"#8B5CF6",blue:"#3B82F6",green:"#22C55E",red:"#EF4444",yellow:"#F59E0B",cyan:"#06B6D4",pink:"#EC4899",orange:"#F97316"};
    return wrap(<div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8}}>
      {items.map((it,i) => {const c=cm[it.color]||VIS_COLORS[i%VIS_COLORS.length];
        return <div key={i} style={{padding:"10px 12px",borderRadius:8,border:`1px solid ${c}33`,background:`${c}11`}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
            <span style={{fontSize:14,fontWeight:800,color:c}}>{it.num||i+1}</span>
            <span style={{fontSize:12,fontWeight:600,color:C.tx}}>{it.label}</span></div>
          {it.description&&<div style={{fontSize:10,color:C.txM}}>{it.description}</div>}
        </div>;
      })}
    </div>);
  }

  // TIMELINE
  if (["timeline","timeline_horizontal"].includes(type)) {
    const events=chart_data.events||[];
    if (type==="timeline_horizontal") return wrap(<div style={{overflowX:"auto"}}><div style={{display:"flex",gap:4,minWidth:events.length*120}}>
      {events.map((ev,i)=><div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",minWidth:100}}>
        <div style={{width:12,height:12,borderRadius:"50%",background:VIS_COLORS[i%VIS_COLORS.length],marginBottom:4}}/>
        <div style={{width:2,height:20,background:C.bd}}/>
        <div style={{textAlign:"center",padding:"6px 4px"}}>
          <div style={{fontSize:10,fontWeight:700,color:VIS_COLORS[i%VIS_COLORS.length]}}>{ev.period}</div>
          <div style={{fontSize:11,fontWeight:600,color:C.tx,marginTop:2}}>{ev.label}</div>
          {ev.description&&<div style={{fontSize:9,color:C.txD,marginTop:1}}>{ev.description}</div>}
        </div>
      </div>)}
    </div></div>);
    return wrap(<div style={{display:"flex",flexDirection:"column",gap:2}}>
      {events.map((ev,i)=><div key={i} style={{display:"flex",gap:10}}>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:16}}>
          <div style={{width:10,height:10,borderRadius:"50%",background:VIS_COLORS[i%VIS_COLORS.length],flexShrink:0}}/>
          {i<events.length-1&&<div style={{width:2,flex:1,background:C.bd}}/>}
        </div>
        <div style={{flex:1,paddingBottom:12}}>
          <div style={{fontSize:10,fontWeight:700,color:VIS_COLORS[i%VIS_COLORS.length]}}>{ev.period}</div>
          <div style={{fontSize:12,fontWeight:600,color:C.tx}}>{ev.label}</div>
          {ev.description&&<div style={{fontSize:10,color:C.txD,marginTop:1}}>{ev.description}</div>}
        </div>
      </div>)}
    </div>);
  }

  // KPI
  if (type==="kpi") {
    const metrics=chart_data.metrics||[];
    const ti={up:"↑",down:"↓",neutral:"→"}, tc={up:"#22C55E",down:"#EF4444",neutral:"#94A3B8"};
    return wrap(<div style={{display:"grid",gridTemplateColumns:`repeat(${Math.min(metrics.length,4)},1fr)`,gap:10}}>
      {metrics.map((m,i)=><div key={i} style={{textAlign:"center",padding:"10px 8px",borderRadius:8,background:"rgba(255,255,255,0.04)",border:`1px solid ${C.bd}`}}>
        <div style={{fontSize:22,fontWeight:800,color:C.ac}}>{m.value}</div>
        <div style={{fontSize:10,color:C.txD,marginTop:2}}>{m.label}</div>
        {m.trend&&<span style={{fontSize:12,color:tc[m.trend]||C.txD}}>{ti[m.trend]||""}</span>}
      </div>)}
    </div>);
  }

  // RANKING
  if (type==="ranking") {
    const items=chart_data.items||[];
    return wrap(<div style={{display:"flex",flexDirection:"column",gap:6}}>
      {items.map((it,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 10px",borderRadius:8,
        background:i===0?"rgba(245,158,11,0.1)":"rgba(255,255,255,0.03)"}}>
        <span style={{fontSize:16,fontWeight:800,color:i===0?"#F59E0B":i===1?"#94A3B8":"#CD7F32",width:24}}>{it.rank||i+1}</span>
        <div style={{flex:1}}><div style={{fontSize:12,fontWeight:600,color:C.tx}}>{it.label}</div>
          {it.description&&<div style={{fontSize:10,color:C.txD}}>{it.description}</div>}</div>
        {it.value&&<span style={{fontSize:12,fontWeight:700,color:C.ac}}>{it.value}</span>}
      </div>)}
    </div>);
  }

  // MATRIX
  if (type==="matrix") {
    const quads=chart_data.quadrants||[];
    const pm={"top-left":[0,0],"top-right":[0,1],"bottom-left":[1,0],"bottom-right":[1,1]};
    const grid=[[null,null],[null,null]]; quads.forEach(q=>{const p=pm[q.position];if(p)grid[p[0]][p[1]]=q;});
    return wrap(<div>
      <div style={{textAlign:"center",fontSize:10,color:C.txD,marginBottom:4}}>↑ {chart_data.y_axis||""}</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
        {grid.flat().map((q,i)=><div key={i} style={{padding:"10px 8px",borderRadius:6,background:q?`${VIS_COLORS[i]}15`:"rgba(255,255,255,0.02)",border:`1px solid ${q?VIS_COLORS[i]+"33":C.bd}`,minHeight:60}}>
          {q&&<><div style={{fontSize:11,fontWeight:700,color:VIS_COLORS[i]}}>{q.label}</div>
            {(q.items||[]).map((it,ii)=><div key={ii} style={{fontSize:10,color:C.txM,marginTop:2}}>· {it}</div>)}</>}
        </div>)}
      </div>
      <div style={{textAlign:"center",fontSize:10,color:C.txD,marginTop:4}}>{chart_data.x_axis||""} →</div>
    </div>);
  }

  // STACK
  if (type==="stack") {
    const layers=chart_data.layers||[];
    const cm={purple:"#8B5CF6",blue:"#3B82F6",green:"#22C55E",red:"#EF4444",yellow:"#F59E0B",cyan:"#06B6D4"};
    return wrap(<div style={{display:"flex",flexDirection:"column",gap:2}}>
      {layers.map((l,i) => {const c=cm[l.color]||VIS_COLORS[i%VIS_COLORS.length];
        return <div key={i} style={{padding:"8px 12px",borderRadius:6,background:`${c}15`,borderLeft:`3px solid ${c}`}}>
          <div style={{fontSize:12,fontWeight:600,color:c}}>{l.label}</div>
          {l.description&&<div style={{fontSize:10,color:C.txM}}>{l.description}</div>}
        </div>;
      })}
    </div>);
  }

  // CYCLE
  if (type==="cycle") {
    const steps=chart_data.steps||[];
    return wrap(<div style={{display:"flex",flexDirection:"column",gap:2}}>
      {steps.map((s,i)=><div key={i}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:24,height:24,borderRadius:"50%",background:VIS_COLORS[i%VIS_COLORS.length],color:"#fff",
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0}}>{i+1}</div>
          <div style={{flex:1}}><span style={{fontSize:12,fontWeight:600,color:C.tx}}>{s.label}</span>
            {s.description&&<span style={{fontSize:10,color:C.txD,marginLeft:6}}>{s.description}</span>}</div>
        </div>
        <div style={{marginLeft:11,fontSize:14,color:C.txD}}>{i<steps.length-1?"↓":"↩"}</div>
      </div>)}
    </div>);
  }

  // CHECKLIST
  if (type==="checklist") {
    const h=chart_data.headers||[], rows=chart_data.rows||[];
    return wrap(<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
      <thead><tr>{h.map((hd,i)=><th key={i} style={{padding:"5px 8px",textAlign:i===0?"left":"center",borderBottom:`2px solid ${C.bd}`,color:C.txM,fontWeight:700}}>{hd}</th>)}</tr></thead>
      <tbody>{rows.map((row,ri)=><tr key={ri}>{row.map((cell,ci)=><td key={ci} style={{padding:"4px 8px",borderBottom:`1px solid ${C.bd}`,
        textAlign:ci===0?"left":"center",color:cell==="O"?"#22C55E":cell==="X"?"#EF4444":C.txM,fontWeight:ci===0?400:700}}>{cell}</td>)}</tr>)}</tbody>
    </table></div>);
  }

  // HIERARCHY
  if (type==="hierarchy") {
    const root=chart_data.root; if(!root) return wrap(<div style={{fontSize:11,color:C.txD}}>데이터 없음</div>);
    const renderN=(n,d=0)=>(<div key={n.label} style={{marginLeft:d*16}}>
      <div style={{display:"flex",alignItems:"center",gap:6,padding:"3px 0"}}>
        {d>0&&<span style={{color:C.txD}}>└</span>}
        <span style={{fontSize:11,fontWeight:d===0?700:400,color:d===0?C.ac:C.txM,padding:"2px 8px",borderRadius:4,background:d===0?`${C.ac}15`:"transparent"}}>{n.label}</span>
      </div>
      {(n.children||[]).map(ch=>renderN(ch,d+1))}
    </div>);
    return wrap(renderN(root));
  }

  // RADAR
  if (type==="radar") {
    const labels=chart_data.labels||[], datasets=chart_data.datasets||[], n=labels.length;
    if(n<3) return wrap(<div style={{fontSize:11,color:C.txD}}>축 3개 이상 필요</div>);
    const cx=80,cy=80,r=60;
    return wrap(<svg viewBox="0 0 160 170" style={{width:"100%",maxWidth:200,margin:"0 auto",display:"block"}}>
      {[0.25,0.5,0.75,1].map(s=><polygon key={s} points={labels.map((_,i)=>{const a=(2*Math.PI*i/n)-Math.PI/2;return `${cx+r*s*Math.cos(a)},${cy+r*s*Math.sin(a)}`;}).join(" ")} fill="none" stroke={C.bd} strokeWidth={0.5}/>)}
      {datasets.map((ds,di) => {const mV=Math.max(...ds.data||[],1);
        const pts=(ds.data||[]).map((v,i)=>{const a=(2*Math.PI*i/n)-Math.PI/2;return `${cx+r*(v/mV)*Math.cos(a)},${cy+r*(v/mV)*Math.sin(a)}`;}).join(" ");
        const c=VIS_COLORS[di%VIS_COLORS.length];
        return <polygon key={di} points={pts} fill={c} fillOpacity={0.2} stroke={c} strokeWidth={1.5}/>;
      })}
      {labels.map((lb,i)=>{const a=(2*Math.PI*i/n)-Math.PI/2;return <text key={i} x={cx+(r+14)*Math.cos(a)} y={cy+(r+14)*Math.sin(a)} textAnchor="middle" dominantBaseline="middle" style={{fontSize:8,fill:C.txM}}>{lb}</text>;})}
    </svg>);
  }

  // VENN
  if (type==="venn") {
    const sets=chart_data.sets||[], inter=chart_data.intersection;
    return wrap(<div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
      <svg viewBox="0 0 200 120" style={{width:"100%",maxWidth:240}}>
        <circle cx={75} cy={60} r={45} fill={VIS_COLORS[0]} fillOpacity={0.2} stroke={VIS_COLORS[0]} strokeWidth={1.5}/>
        <circle cx={125} cy={60} r={45} fill={VIS_COLORS[1]} fillOpacity={0.2} stroke={VIS_COLORS[1]} strokeWidth={1.5}/>
        {sets[0]&&<text x={50} y={30} style={{fontSize:9,fill:VIS_COLORS[0],fontWeight:700}}>{sets[0].label}</text>}
        {sets[1]&&<text x={120} y={30} style={{fontSize:9,fill:VIS_COLORS[1],fontWeight:700}}>{sets[1].label}</text>}
        {inter&&<text x={100} y={65} textAnchor="middle" style={{fontSize:8,fill:C.tx,fontWeight:600}}>{inter.label}</text>}
      </svg>
    </div>);
  }

  // NETWORK
  if (type==="network") {
    const nodes=chart_data.nodes||[], edges=chart_data.edges||[];
    const cx=100,cy=80,r=55,n=nodes.length; const pm={};
    nodes.forEach((nd,i)=>{const a=(2*Math.PI*i/n)-Math.PI/2;pm[nd.id]={x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)};});
    return wrap(<svg viewBox="0 0 200 160" style={{width:"100%",maxWidth:240,margin:"0 auto",display:"block"}}>
      {edges.map((e,i)=>{const f=pm[e.from],t=pm[e.to];if(!f||!t)return null;return <g key={i}>
        <line x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke={C.bd} strokeWidth={1}/>
        {e.label&&<text x={(f.x+t.x)/2} y={(f.y+t.y)/2-4} textAnchor="middle" style={{fontSize:7,fill:C.txD}}>{e.label}</text>}
      </g>;})}
      {nodes.map((nd,i)=>{const p=pm[nd.id];return <g key={i}><circle cx={p.x} cy={p.y} r={14} fill={VIS_COLORS[i%VIS_COLORS.length]} fillOpacity={0.3} stroke={VIS_COLORS[i%VIS_COLORS.length]} strokeWidth={1.5}/>
        <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" style={{fontSize:7,fill:C.tx,fontWeight:600}}>{nd.label}</text></g>;})}
    </svg>);
  }

  // PROGRESS
  if (type==="progress") {
    const steps=chart_data.steps||[], cur=chart_data.current??steps.length;
    return wrap(<div style={{display:"flex",alignItems:"center",gap:4}}>
      {steps.map((s,i)=>{const done=(s.status==="done")||i<cur,isCur=i===cur;
        return <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center"}}>
          <div style={{width:24,height:24,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,
            background:done?C.ac:isCur?"#F59E0B":"rgba(255,255,255,0.06)",color:done||isCur?"#fff":C.txD,border:isCur?"2px solid #F59E0B":"none"}}>{done?"✓":i+1}</div>
          <div style={{fontSize:9,color:done?C.ac:C.txD,marginTop:3,textAlign:"center"}}>{s.label}</div>
        </div>;
      })}
    </div>);
  }

  // FALLBACK
  return wrap(<div style={{padding:8,fontSize:11,color:C.txD,textAlign:"center"}}>
    <div style={{fontSize:12,fontWeight:600,color:C.txM,marginBottom:4}}>📊 {type.toUpperCase()}</div>
    <pre style={{fontSize:10,color:C.txD,textAlign:"left",whiteSpace:"pre-wrap",maxHeight:120,overflow:"auto"}}>{JSON.stringify(chart_data,null,2)}</pre>
  </div>);
}

// ═══════════════════════════════════════
// INSERT CUT CARD
// ═══════════════════════════════════════
function InsertCutCard({ item, active, onClick, verdict, onVerdict, onRegenerate, busy, marker, isActiveMatch, matchMode, onMatchClick, onMarkerClear }) {
  const [open,setOpen]=useState(false),[cp,setCp]=useState(false);
  const info=IC_TYPE[item.type]||IC_TYPE.B;
  const blockIdx = (item.block_range||[])[0];
  const mc = marker?.color ? MARKER_COLORS[marker.color] : null;
  const borderC=mc?mc.border:verdict==="use"?"#22C55E":verdict==="discard"?"rgba(239,68,68,0.4)":active?info.color:C.bd;
  const cardBg=verdict==="discard"?"rgba(239,68,68,0.05)":mc?mc.bg.replace("0.3","0.08"):active?`${info.color}11`:C.sf;
  return <div onClick={()=>onClick&&onClick(blockIdx)} style={{border:`1px solid ${borderC}`,borderRadius:10,padding:"10px 12px",marginBottom:8,
    background:cardBg,cursor:"pointer",transition:"all 0.15s",opacity:verdict==="discard"?0.5:1,
    boxShadow:isActiveMatch?`0 0 0 2px ${mc?.border||C.ac}`:active&&!verdict?`0 0 0 2px ${info.color}44`:"none"}}>
    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
      <span style={{fontSize:13}}>{info.icon}</span>
      <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,background:`${info.color}22`,color:info.color}}>Type {item.type}: {item.type_name||info.label}</span>
      {item.speaker&&<span style={{fontSize:10,color:C.txM}}>{item.speaker}</span>}
      <span style={{flex:1}}/>
      <button onClick={e=>{e.stopPropagation();onRegenerate&&onRegenerate()}} disabled={busy}
        title="이 카드 재생성"
        style={{fontSize:9,fontWeight:600,padding:"2px 6px",borderRadius:4,cursor:busy?"not-allowed":"pointer",
          border:`1px solid ${C.bd}`,background:"rgba(255,255,255,0.04)",color:C.txD,flexShrink:0}}>🔄</button>
      <span style={{fontSize:10,color:C.txD,fontFamily:"monospace"}}>#{blockIdx}</span>
    </div>
    <div style={{fontSize:13,fontWeight:600,color:C.tx,marginBottom:4,textDecoration:verdict==="discard"?"line-through":"none"}}>{item.title}</div>
    {item.trigger_quote&&<div style={{fontSize:11,color:C.txM,marginBottom:4,fontStyle:"italic",borderLeft:`2px solid ${info.color}`,paddingLeft:8}}>"{item.trigger_quote}"</div>}
    {item.type==="A"&&item.image_prompt&&<div style={{padding:"6px 10px",borderRadius:6,background:"rgba(139,92,246,0.08)",border:"1px solid rgba(139,92,246,0.2)",marginBottom:4}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:2}}>
        <span style={{fontSize:10,fontWeight:600,color:"#8B5CF6"}}>🖼 이미지 프롬프트</span>
        <button onClick={e=>{e.stopPropagation();navigator.clipboard.writeText(item.image_prompt);setCp(true);setTimeout(()=>setCp(false),1500)}}
          style={{fontSize:9,padding:"1px 6px",borderRadius:3,border:`1px solid ${cp?"#22C55E":"#8B5CF6"}`,background:cp?"rgba(34,197,94,0.15)":"transparent",color:cp?"#22C55E":"#8B5CF6",cursor:"pointer"}}>{cp?"✓ 복사됨":"복사"}</button>
      </div>
      <div style={{fontSize:10,color:C.txD,lineHeight:1.4}}>{item.image_prompt}</div>
    </div>}
    {item.type==="B"&&<div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:4}}>
      {item.search_keywords?.length>0&&<div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
        {item.search_keywords.map((kw,i)=><span key={i} style={{fontSize:9,padding:"2px 6px",borderRadius:3,background:"rgba(59,130,246,0.12)",color:"#3B82F6",border:"1px solid rgba(59,130,246,0.2)"}}>{kw}</span>)}
      </div>}
      {item.youtube_search&&<div style={{padding:"4px 8px",borderRadius:4,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.15)"}}>
        <span style={{fontSize:10,fontWeight:600,color:"#EF4444"}}>▶ YouTube: </span>
        <span style={{fontSize:10,color:C.txM}}>{item.youtube_search.query}</span>
      </div>}
    </div>}
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      <span style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:"rgba(255,255,255,0.06)",color:C.txD}}>
        {item.source_type==="illustration"?"일러스트 제작":item.source_type==="official_image"?"공식 이미지":item.source_type==="official_youtube"?"공식 유튜브":item.source_type==="guest_provided"?"게스트 제공":item.source_type||""}</span>
      {item.asset_note&&<span style={{fontSize:9,color:"#F59E0B"}}>⚠ {item.asset_note}</span>}
    </div>
    <div style={{display:"flex",alignItems:"center",gap:4,marginTop:4}}>
      <button onClick={e=>{e.stopPropagation();setOpen(!open)}} style={{fontSize:11,color:C.ac,background:"none",border:"none",cursor:"pointer",padding:"2px 0"}}>
        {open?"접기 ▲":"상세 ▼"}</button>
      <div style={{marginLeft:"auto",display:"flex",gap:3}}>
        {[{k:"use",l:"사용",c:"#22C55E",bg:"rgba(34,197,94,0.15)"},{k:"discard",l:"폐기",c:"#EF4444",bg:"rgba(239,68,68,0.15)"}].map(o=>
          <button key={o.k} onClick={e=>{e.stopPropagation();onVerdict&&onVerdict(o.k)}}
            style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,cursor:"pointer",transition:"all 0.1s",
              border:`1px solid ${verdict===o.k?o.c:"transparent"}`,background:verdict===o.k?o.bg:"rgba(255,255,255,0.04)",
              color:verdict===o.k?o.c:C.txD}}>{o.l}</button>)}
      </div>
    </div>
    {open&&<div style={{background:"rgba(0,0,0,0.25)",borderRadius:8,padding:10,marginTop:4,border:`1px solid ${C.bd}`}}>
      {item.trigger_reason&&<div style={{fontSize:12,color:C.txM,marginBottom:4}}><b>트리거 사유:</b> {item.trigger_reason}</div>}
      {item.instruction&&<div style={{fontSize:12,color:C.txM}}><b>편집자 지시:</b> {item.instruction}</div>}
    </div>}
    {/* 형광펜 팔레트 */}
    {onMatchClick && <div style={{display:"flex",alignItems:"center",gap:3,marginTop:6,paddingTop:6,borderTop:`1px solid ${C.bd}22`}}>
      <span style={{fontSize:9,color:C.txD,marginRight:2}}>🖍</span>
      {Object.entries(MARKER_COLORS).filter(([,cv])=>!cv._hidden).map(([ck,cv])=>
        <button key={ck} onClick={e=>{e.stopPropagation();onMatchClick(ck)}}
          title={`${cv.label} 형광펜${marker?.color===ck?" (선택됨)":""}`}
          style={{width:16,height:16,borderRadius:3,cursor:"pointer",transition:"all 0.12s",
            border:`2px solid ${isActiveMatch&&matchMode?.color===ck?"#fff":marker?.color===ck?cv.border:"transparent"}`,
            background:cv.bg.replace("0.3","0.6"),
            boxShadow:isActiveMatch&&matchMode?.color===ck?"0 0 4px rgba(255,255,255,0.5)":"none"}}/>)}
      {marker&&<button onClick={e=>{e.stopPropagation();onMarkerClear&&onMarkerClear()}}
        title="형광펜 지우기"
        style={{fontSize:9,lineHeight:1,padding:"2px 4px",border:`1px solid ${C.bd}`,borderRadius:3,
          background:"rgba(255,255,255,0.06)",color:C.txD,cursor:"pointer"}}>✕</button>}
    </div>}
  </div>;
}

// ═══════════════════════════════════════
// VISUAL TAB (main export)
// ═══════════════════════════════════════
export function VisualTab({ script, blocks, sessionId, config, onSave }) {
  const [subTab, setSubTab] = useState("visuals");
  const [visualGuides, setVisualGuides] = useState([]);
  const [insertCuts, setInsertCuts] = useState([]);
  const [verdicts, setVerdicts] = useState({});
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState("");
  const [err, setErr] = useState(null);
  const [aBlock, setABlock] = useState(null);
  const [textSel, setTextSel] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [manualResources, setManualResources] = useState([]);
  const [visualMarkers, setVisualMarkers] = useState({});
  const [vMatchMode, setVMatchMode] = useState(null); // { key, color, blockIdx }
  const [resAddAt, setResAddAt] = useState(null);
  const [resForm, setResForm] = useState({ text: "", type: "image" });
  const [resEditing, setResEditing] = useState(null); // { id, text, type }

  const lRef = useRef(null);
  const rRef = useRef(null);
  const bEls = useRef({});
  const cEls = useRef({});
  const saveTimer = useRef(null);

  // ── 세션 로드 ──
  useEffect(() => {
    if (!sessionId || !config || loaded) return;
    (async () => {
      try {
        const base = config.workerUrl;
        const r = await fetch(`${base}/load/${sessionId}/visual`);
        if (!r.ok) return;
        const data = await r.json();
        if (data && data.data) {
          setVisualGuides(data.data.visualGuides || []);
          setInsertCuts(data.data.insertCuts || []);
          setVerdicts(data.data.verdicts || {});
          setManualResources(data.data.manualResources || []);
          setVisualMarkers(data.data.visualMarkers || {});
        }
        setLoaded(true);
      } catch { setLoaded(true); }
    })();
  }, [sessionId, config, loaded]);

  // ── 디바운스 자동저장 ──
  useEffect(() => {
    if (visualGuides.length === 0 && insertCuts.length === 0 && manualResources.length === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onSave?.({ visualGuides, insertCuts, verdicts, manualResources, visualMarkers, savedAt: new Date().toISOString() });
    }, 5000);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [visualGuides, insertCuts, verdicts, manualResources, visualMarkers, onSave]);

  // ── 텍스트 선택 감지 ──
  const onTextMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const selectedText = sel.toString().trim();
    if (selectedText.length < 10) return;
    const range = sel.getRangeAt(0);
    const container = lRef.current;
    if (!container || !container.contains(range.startContainer)) return;
    const blockIndices = new Set();
    for (const [idx, el] of Object.entries(bEls.current)) {
      if (el && sel.containsNode(el, true)) blockIndices.add(parseInt(idx));
    }
    const indices = [...blockIndices].sort((a, b) => a - b);
    if (indices.length === 0) return;
    const preview = selectedText.length > 80 ? selectedText.substring(0, 80) + "…" : selectedText;
    setTextSel({ text: selectedText, blockIndices: indices, preview });
  }, []);

  const clearTextSel = useCallback(() => { setTextSel(null); window.getSelection()?.removeAllRanges(); }, []);

  // ── 선택 텍스트 기반 생성 ──
  const handleTextSelGenerate = useCallback(async (mode) => {
    if (!textSel || blocks.length === 0) return;
    setBusy(true); setErr(null);
    const endpoint = mode === "visuals" ? "visuals" : "insert-cuts";
    const label = mode === "visuals" ? "📊 시각화" : "🎬 인서트 컷";
    const key = mode === "visuals" ? "visual_guides" : "insert_cuts";
    const rangeBlocks = blocks.filter(b => textSel.blockIndices.includes(b.index));
    try {
      setProg(`${label} 생성 중 (선택 ${textSel.text.length}자)...`);
      const d = await apiCall(endpoint, { blocks: rangeBlocks, analysis: { selected_text: textSel.text } }, config);
      const items = (d.result?.[key] || []).map((v, i) => ({ ...v, id: Date.now() + i }));
      if (mode === "visuals") { setVisualGuides(prev => [...prev, ...items]); setSubTab("visuals"); }
      else { setInsertCuts(prev => [...prev, ...items]); setSubTab("inserts"); }
      setProg(`✅ ${label} 완료 — ${items.length}건 추가`);
      clearTextSel();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }, [textSel, blocks, config, clearTextSel]);

  // ── 전체 생성 ──
  const handleGenerate = useCallback(async (mode) => {
    if (blocks.length === 0) return;
    setBusy(true); setErr(null);
    const endpoint = mode === "visuals" ? "visuals" : "insert-cuts";
    const label = mode === "visuals" ? "📊 시각화" : "🎬 인서트 컷";
    const key = mode === "visuals" ? "visual_guides" : "insert_cuts";
    try {
      const CHUNK = 20000;
      const chunks = []; let cur = [], curLen = 0;
      for (const b of blocks) {
        if (curLen + b.text.length > CHUNK && cur.length > 0) { chunks.push(cur); cur = []; curLen = 0; }
        cur.push(b); curLen += b.text.length;
      }
      if (cur.length > 0) chunks.push(cur);
      let all = [];
      for (let ci = 0; ci < chunks.length; ci++) {
        setProg(`${label} 생성 중 (${ci + 1}/${chunks.length})...`);
        const d = await apiCall(endpoint, { blocks: chunks[ci], chunk_index: ci, total_chunks: chunks.length, existing_count: all.length }, config);
        const items = d.result?.[key] || [];
        all.push(...items);
        if (ci < chunks.length - 1) { setProg("청크 간 대기 중... ☕"); await delay(3000); }
      }
      all = all.map((v, i) => ({ ...v, id: Date.now() + i }));
      if (mode === "visuals") { setVisualGuides(prev => [...prev, ...all]); setSubTab("visuals"); }
      else { setInsertCuts(prev => [...prev, ...all]); setSubTab("inserts"); }
      setProg(`✅ ${label} 완료 — ${all.length}건 추가`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }, [blocks, config]);

  // ── 카드 재생성 ──
  const handleRegenerate = useCallback(async (item, mode, preferredType) => {
    setBusy(true); setErr(null);
    const range = item.block_range || [0, 0];
    const rangeBlocks = blocks.filter(b => b.index >= range[0] && b.index <= (range[1] || range[0]));
    if (rangeBlocks.length === 0) { setBusy(false); return; }
    const endpoint = mode === "visuals" ? "visuals" : "insert-cuts";
    const key = mode === "visuals" ? "visual_guides" : "insert_cuts";
    const label = mode === "visuals" ? "📊 시각화" : "🎬 인서트 컷";
    try {
      const tl = preferredType ? ` (${preferredType})` : "";
      setProg(`🔄 ${label} 재생성 중${tl}...`);
      const payload = { blocks: rangeBlocks };
      if (preferredType) payload.preferred_type = preferredType;
      const d = await apiCall(endpoint, payload, config);
      const newItems = (d.result?.[key] || []).map((v, i) => ({ ...v, id: Date.now() + i }));
      if (newItems.length === 0) { setProg("⚠ 재생성 결과 없음"); setBusy(false); return; }
      const vKey = mode === "visuals" ? `vis-${item.id}` : `ic-${item.id}`;
      if (mode === "visuals") {
        setVisualGuides(prev => { const idx = prev.findIndex(v => v.id === item.id); if (idx === -1) return [...prev, ...newItems]; const next = [...prev]; next.splice(idx, 1, ...newItems); return next; });
      } else {
        setInsertCuts(prev => { const idx = prev.findIndex(v => v.id === item.id); if (idx === -1) return [...prev, ...newItems]; const next = [...prev]; next.splice(idx, 1, ...newItems); return next; });
      }
      setVerdicts(prev => { const n = { ...prev }; delete n[vKey]; return n; });
      setProg(`✅ ${label} 재생성 완료 (${newItems.length}건)`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }, [blocks, config]);

  // ── 스크롤 ──
  const scrollTo = useCallback((blockIdx) => {
    setABlock(blockIdx);
    const HEADER_H = 40;
    const bEl = bEls.current[blockIdx];
    if (bEl && lRef.current) {
      const cr = lRef.current.getBoundingClientRect();
      const er = bEl.getBoundingClientRect();
      const target = er.top - cr.top + lRef.current.scrollTop - HEADER_H - 20;
      lRef.current.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
    if (rRef.current) {
      const cardEl = rRef.current.querySelector(`[data-card-block="${blockIdx}"]`);
      if (cardEl) {
        const cr = rRef.current.getBoundingClientRect();
        const er = cardEl.getBoundingClientRect();
        const target = er.top - cr.top + rRef.current.scrollTop - HEADER_H - 20;
        rRef.current.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
      }
    }
  }, []);

  const blockHasCard = useMemo(() => {
    const set = new Set();
    const items = subTab === "visuals" ? visualGuides : subTab === "inserts" ? insertCuts : manualResources;
    for (const item of items) {
      const range = item.block_range || (item.block_index != null ? [item.block_index, item.block_index] : []);
      for (let i = range[0]; i <= (range[1] || range[0]); i++) set.add(i);
    }
    return set;
  }, [subTab, visualGuides, insertCuts, manualResources]);

  // ── 수동 자료 추가 ──
  const RES_TYPES = [
    { value: "image", label: "🖼 이미지", color: "#3B82F6" },
    { value: "video", label: "🎬 영상", color: "#8B5CF6" },
    { value: "data", label: "📊 데이터", color: "#22C55E" },
    { value: "etc", label: "📌 기타", color: "#F59E0B" },
  ];

  const handleAddResource = useCallback(() => {
    if (resAddAt === null || !resForm.text.trim()) return;
    const block = blocks.find(b => b.index === resAddAt);
    const newRes = {
      id: Date.now(),
      block_index: resAddAt,
      block_range: [resAddAt, resAddAt],
      speaker: block?.speaker || "—",
      text: resForm.text.trim(),
      type: resForm.type,
      _manual: true,
    };
    setManualResources(prev => [...prev, newRes]);
    setVerdicts(prev => ({ ...prev, [`res-${newRes.id}`]: "use" }));
    setResAddAt(null);
    setResForm({ text: "", type: "image" });
  }, [resAddAt, resForm, blocks]);

  const handleDeleteResource = useCallback((id) => {
    setManualResources(prev => prev.filter(r => r.id !== id));
    setVerdicts(prev => { const n = { ...prev }; delete n[`res-${id}`]; return n; });
    handleMarkerClear(`res-${id}`);
  }, []);

  const handleSaveResource = useCallback(() => {
    if (!resEditing || !resEditing.text.trim()) return;
    setManualResources(prev => prev.map(r => r.id === resEditing.id ? { ...r, text: resEditing.text.trim(), type: resEditing.type } : r));
    setResEditing(null);
  }, [resEditing]);

  // ── 형광펜 ──
  const handleMarkerAdd = useCallback((key, color, blockIdx, s, e) => {
    setVisualMarkers(prev => {
      const existing = prev[key] || { color, ranges: [] };
      const prevRanges = existing.color === color ? existing.ranges : [];
      const newRanges = [...prevRanges];
      let merged = false;
      for (let i = 0; i < newRanges.length; i++) {
        const r = newRanges[i];
        if (r.blockIdx === blockIdx && !(e <= r.s || s >= r.e)) {
          newRanges[i] = { blockIdx, s: Math.min(s, r.s), e: Math.max(e, r.e) };
          merged = true;
          break;
        }
      }
      if (!merged) newRanges.push({ blockIdx, s, e });
      return { ...prev, [key]: { color, ranges: newRanges } };
    });
  }, []);

  const handleMarkerClear = useCallback((key) => {
    setVisualMarkers(prev => { const n = { ...prev }; delete n[key]; return n; });
  }, []);

  // ── verdict + 자동 형광펜 ──
  const handleVerdictToggle = useCallback((vKey, currentVd, newVd, item, markerColor) => {
    const finalVd = currentVd === newVd ? null : newVd;
    setVerdicts(prev => ({ ...prev, [vKey]: finalVd }));
    if (finalVd === "use" && item) {
      const sourceText = item.source_text || item.trigger_quote || "";
      if (sourceText && item.block_range) {
        const blockIdx = item.block_range[0];
        const block = blocks.find(b => b.index === blockIdx);
        if (block) {
          const idx = block.text.indexOf(sourceText);
          if (idx >= 0) {
            handleMarkerAdd(vKey, markerColor, blockIdx, idx, idx + sourceText.length);
          }
        }
      }
    } else if (finalVd !== "use") {
      handleMarkerClear(vKey);
    }
  }, [blocks, handleMarkerAdd, handleMarkerClear]);

  // ═══════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════
  return <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
    {/* 서브탭 + 액션 바 */}
    <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 16px",borderBottom:`1px solid ${C.bd}`,background:C.sf,flexShrink:0}}>
      <div style={{display:"flex",gap:2,background:"rgba(255,255,255,0.04)",borderRadius:7,padding:2}}>
        {[["visuals","📊 시각화"],["inserts","🎬 인서트 컷"],["resources","📎 자료"]].map(([id,l])=>
          <button key={id} onClick={()=>setSubTab(id)} style={{padding:"5px 14px",borderRadius:5,border:"none",cursor:"pointer",
            fontSize:12,fontWeight:subTab===id?600:400,background:subTab===id?C.ac:"transparent",color:subTab===id?"#fff":C.txM}}>
            {l}{id==="visuals"&&visualGuides.length>0?` (${visualGuides.length})`:""}{id==="inserts"&&insertCuts.length>0?` (${insertCuts.length})`:""}{id==="resources"&&manualResources.length>0?` (${manualResources.length})`:""}
          </button>)}
      </div>
      <span style={{flex:1}}/>
      {prog&&<span style={{fontSize:11,color:C.ac}}>{prog}</span>}
      {err&&<span style={{fontSize:11,color:C.err}}>⚠ {err}</span>}
    </div>
    {/* 본체: 좌(원고) + 우(카드) */}
    <div style={{flex:1,display:"flex",overflow:"hidden",position:"relative"}}>
      {/* 왼쪽: 블록 뷰 */}
      <div ref={lRef} onMouseUp={onTextMouseUp} style={{flex:1,overflowY:"auto",borderRight:`1px solid ${C.bd}`}}>
        {/* 형광펜 모드 상태 바 */}
        {vMatchMode && (
          <div style={{position:"sticky",top:0,zIndex:5,padding:"6px 16px",
            background:MARKER_COLORS[vMatchMode.color]?.bg||"rgba(251,191,36,0.3)",
            borderBottom:`2px solid ${MARKER_COLORS[vMatchMode.color]?.border||"#FBBF24"}`,
            display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:12,fontWeight:600,color:C.tx}}>🖍 형광펜 모드 — 블록 #{vMatchMode.blockIdx}에서 드래그로 구간 선택</span>
            <span style={{flex:1}}/>
            <button onClick={()=>setVMatchMode(null)}
              style={{fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:5,border:`1px solid ${C.bd}`,
                background:"rgba(255,255,255,0.1)",color:C.tx,cursor:"pointer"}}>완료</button>
          </div>
        )}
        <div style={{padding:"8px 16px",fontSize:11,fontWeight:700,color:C.txD,borderBottom:`1px solid ${C.bd}`,
          position:"sticky",top:vMatchMode?38:0,background:C.bg,zIndex:2}}>
          교정본 ({blocks.length}블록) — 텍스트 드래그로 구간 추천
        </div>
        {blocks.map(b => {
          const isActive = aBlock === b.index;
          const hasCard = blockHasCard.has(b.index);
          const inSel = textSel && textSel.blockIndices.includes(b.index);
          const usedVisuals = visualGuides.filter(v => (v.block_range||[])[0] === b.index && verdicts[`vis-${v.id}`] === "use");
          const usedCuts = insertCuts.filter(ic => (ic.block_range||[])[0] === b.index && verdicts[`ic-${ic.id}`] === "use");
          const usedResources = manualResources.filter(r => r.block_index === b.index && verdicts[`res-${r.id}`] === "use");
          const isMatchBlock = vMatchMode && vMatchMode.blockIdx === b.index;
          return <div key={b.index}>
            <div ref={el=>{if(el)bEls.current[b.index]=el}}
              onClick={()=>{ if(!window.getSelection()?.toString().trim()){ scrollTo(b.index); setResAddAt(null); }}}
              style={{padding:"10px 16px",borderBottom:`1px solid ${C.bd}22`,cursor:isMatchBlock?"crosshair":"text",transition:"all 0.1s",
                borderLeft:`4px solid ${inSel?"#F59E0B":isActive?"#A855F7":hasCard?"#3B82F644":"transparent"}`,
                background:inSel?"rgba(245,158,11,0.06)":isActive?"rgba(168,85,247,0.08)":"transparent"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                <span style={{fontSize:10,fontWeight:700,color:inSel?"#F59E0B":isActive?"#A855F7":C.txD,fontFamily:"monospace",
                  background:inSel?"rgba(245,158,11,0.2)":isActive?"rgba(168,85,247,0.15)":"rgba(255,255,255,0.06)",
                  padding:"1px 5px",borderRadius:3}}>#{b.index}</span>
                <span style={{fontSize:11,fontWeight:600,color:isActive?C.ac:C.txM}}>{b.speaker}</span>
                <span style={{fontSize:11,color:C.txD,fontFamily:"monospace"}}>{b.timestamp}</span>
                {hasCard && <span style={{fontSize:9,padding:"1px 5px",borderRadius:3,
                  background:subTab==="visuals"?"rgba(59,130,246,0.12)":subTab==="resources"?"rgba(249,115,22,0.12)":"rgba(245,158,11,0.12)",
                  color:subTab==="visuals"?"#3B82F6":subTab==="resources"?"#F97316":"#F59E0B"}}>{subTab==="visuals"?"📊":subTab==="resources"?"📎":"🎬"}</span>}
                {isMatchBlock && <span style={{fontSize:9,fontWeight:600,color:MARKER_COLORS[vMatchMode.color]?.border,
                  padding:"1px 5px",borderRadius:3,background:MARKER_COLORS[vMatchMode.color]?.bg}}>🖍 드래그로 구간 선택</span>}
              </div>
              <MarkedText text={b.text} blockIdx={b.index}
                hlMarkers={visualMarkers}
                matchingMode={isMatchBlock ? vMatchMode : null}
                onMarkerAdd={handleMarkerAdd}/>
            </div>
            {/* 인라인: 사용 시각화 */}
            {usedVisuals.map(v => (
              <div key={`inline-vis-${v.id}`} style={{margin:"2px 16px 4px",padding:"8px 12px",borderRadius:8,
                border:"1px solid rgba(59,130,246,0.3)",background:"rgba(59,130,246,0.06)",display:"flex",alignItems:"flex-start",gap:8}}>
                <span style={{fontSize:11,color:"#3B82F6",fontWeight:700,flexShrink:0}}>📊</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:600,color:"#3B82F6",marginBottom:4}}>{v.title}</div>
                  <VisualMockup type={v.type} chart_data={v.chart_data}/>
                </div>
              </div>
            ))}
            {/* 인라인: 사용 인서트 컷 */}
            {usedCuts.map(ic => {
              const info = IC_TYPE[ic.type] || IC_TYPE.B;
              return <div key={`inline-ic-${ic.id}`} style={{margin:"2px 16px 4px",padding:"8px 12px",borderRadius:8,
                border:`1px solid ${info.color}44`,background:`${info.color}0a`,display:"flex",alignItems:"flex-start",gap:8}}>
                <span style={{fontSize:11,color:info.color,fontWeight:700,flexShrink:0}}>{info.icon}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:600,color:info.color}}>{ic.title}</div>
                  <div style={{fontSize:11,color:C.txD,marginTop:2}}>{ic.instruction}</div>
                  {ic.type==="A"&&ic.image_prompt&&<div style={{fontSize:10,color:C.txD,marginTop:2,fontStyle:"italic"}}>🖼 {ic.image_prompt.substring(0,80)}...</div>}
                </div>
              </div>;
            })}
            {/* 인라인: 사용 수동 자료 */}
            {usedResources.map(r => {
              return <div key={`inline-res-${r.id}`} style={{margin:"2px 16px 4px",padding:"10px 14px",borderRadius:8,
                border:"1px solid rgba(249,115,22,0.4)",background:"rgba(249,115,22,0.06)",display:"flex",alignItems:"flex-start",gap:8}}>
                <span style={{fontSize:13,color:"#F97316",fontWeight:700,flexShrink:0}}>📎</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:600,color:"#F97316",lineHeight:1.6}}>{r.text}</div>
                  <span style={{fontSize:9,padding:"1px 4px",borderRadius:3,background:"rgba(249,115,22,0.15)",color:"#F97316",fontWeight:600}}>수동 추가</span>
                </div>
              </div>;
            })}
            {/* 자료 추가 버튼 */}
            {isActive && resAddAt !== b.index && (
              <div style={{padding:"4px 16px 6px",display:"flex",gap:6}}>
                <button onClick={e=>{e.stopPropagation();setResAddAt(b.index);setResForm({text:"",type:"image"});}}
                  style={{fontSize:11,fontWeight:600,padding:"4px 12px",borderRadius:6,
                    border:`1px dashed #F97316`,background:"rgba(249,115,22,0.08)",
                    color:"#F97316",cursor:"pointer"}}>📎 자료 추가</button>
              </div>
            )}
            {/* 자료 추가 폼 */}
            {resAddAt === b.index && (
              <div onClick={e=>e.stopPropagation()} style={{margin:"0 16px 10px",padding:12,borderRadius:10,
                border:"1px solid #F97316",background:"rgba(249,115,22,0.06)"}}>
                <div style={{display:"flex",gap:4,marginBottom:8}}>
                  {RES_TYPES.map(rt=>
                    <button key={rt.value} onClick={()=>setResForm(f=>({...f,type:rt.value}))}
                      style={{fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:5,cursor:"pointer",
                        border:`1px solid ${resForm.type===rt.value?rt.color:"transparent"}`,
                        background:resForm.type===rt.value?`${rt.color}22`:"rgba(255,255,255,0.04)",
                        color:resForm.type===rt.value?rt.color:C.txD}}>{rt.label}</button>)}
                </div>
                <textarea value={resForm.text} onChange={e=>setResForm(f=>({...f,text:e.target.value}))}
                  placeholder="자료 내용/메모 (예: 관련 기사 캡쳐, 매출 데이터 차트 등)"
                  rows={2} autoFocus
                  style={{width:"100%",padding:"6px 8px",borderRadius:6,border:`1px solid ${C.bd}`,
                    background:"rgba(0,0,0,0.3)",color:C.tx,fontSize:13,fontFamily:FN,
                    lineHeight:1.5,resize:"vertical",outline:"none"}}
                  onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();handleAddResource();}if(e.key==="Escape")setResAddAt(null);}}/>
                <div style={{display:"flex",gap:4,marginTop:6,justifyContent:"flex-end"}}>
                  <button onClick={()=>setResAddAt(null)}
                    style={{fontSize:11,padding:"3px 10px",borderRadius:4,border:`1px solid ${C.bd}`,
                      background:"transparent",color:C.txM,cursor:"pointer"}}>취소</button>
                  <button onClick={handleAddResource}
                    style={{fontSize:11,padding:"3px 10px",borderRadius:4,border:"none",
                      background:"#F97316",color:"#fff",fontWeight:600,cursor:"pointer"}}>추가</button>
                </div>
              </div>
            )}
          </div>;
        })}
      </div>
      {/* 플로팅 액션 바 */}
      {textSel && !busy && (
        <div style={{position:"absolute",bottom:20,left:"50%",transform:"translateX(-70%)",zIndex:10,
          display:"flex",alignItems:"center",gap:8,padding:"10px 16px",borderRadius:12,
          background:"rgba(30,30,40,0.95)",border:"1px solid #F59E0B",
          boxShadow:"0 8px 32px rgba(0,0,0,0.5)",backdropFilter:"blur(8px)",maxWidth:600}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:11,fontWeight:700,color:"#F59E0B",marginBottom:2}}>선택 구간 ({textSel.text.length}자)</div>
            <div style={{fontSize:10,color:C.txD,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>"{textSel.preview}"</div>
          </div>
          <button onClick={()=>handleTextSelGenerate("visuals")}
            style={{fontSize:11,fontWeight:600,padding:"6px 14px",borderRadius:6,border:"none",cursor:"pointer",
              background:"rgba(59,130,246,0.9)",color:"#fff",whiteSpace:"nowrap"}}>📊 시각화 추천</button>
          <button onClick={()=>handleTextSelGenerate("inserts")}
            style={{fontSize:11,fontWeight:600,padding:"6px 14px",borderRadius:6,border:"none",cursor:"pointer",
              background:"rgba(245,158,11,0.9)",color:"#fff",whiteSpace:"nowrap"}}>🎬 인서트 컷</button>
          <button onClick={clearTextSel}
            style={{fontSize:11,padding:"6px 10px",borderRadius:6,border:`1px solid ${C.bd}`,background:"transparent",
              color:C.txM,cursor:"pointer"}}>✕</button>
        </div>
      )}
      {/* 오른쪽: 결과 패널 */}
      <div ref={rRef} style={{width:440,minWidth:440,overflowY:"auto",background:"rgba(0,0,0,0.12)"}}>
        <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.bd}`,position:"sticky",top:0,background:C.sf,zIndex:2}}>
          {subTab !== "resources" ? <div style={{display:"flex",gap:4}}>
            <button onClick={()=>handleGenerate("visuals")} disabled={busy}
              style={{flex:1,fontSize:11,fontWeight:600,padding:"8px 10px",borderRadius:6,border:"none",cursor:busy?"not-allowed":"pointer",
                background:busy?"rgba(59,130,246,0.3)":"rgba(59,130,246,0.8)",color:"#fff"}}>
              {busy&&subTab==="visuals"?"생성 중...":"📊 전체 시각화 생성"}</button>
            <button onClick={()=>handleGenerate("inserts")} disabled={busy}
              style={{flex:1,fontSize:11,fontWeight:600,padding:"8px 10px",borderRadius:6,border:"none",cursor:busy?"not-allowed":"pointer",
                background:busy?"rgba(245,158,11,0.3)":"rgba(245,158,11,0.8)",color:"#fff"}}>
              {busy&&subTab==="inserts"?"생성 중...":"🎬 전체 인서트 컷 생성"}</button>
          </div> : <div style={{fontSize:12,color:C.txM,padding:"6px 0"}}>📎 왼쪽 패널에서 블록 선택 후 자료를 추가하세요</div>}
          {(visualGuides.length>0||insertCuts.length>0||manualResources.length>0) && <div style={{display:"flex",gap:4,marginTop:4}}>
            {visualGuides.length>0&&subTab==="visuals"&&<button onClick={()=>setVisualGuides([])}
              style={{fontSize:10,padding:"3px 8px",borderRadius:4,border:`1px solid ${C.bd}`,background:"transparent",color:C.txD,cursor:"pointer"}}>
              🗑 초기화 ({visualGuides.length}건)</button>}
            {insertCuts.length>0&&subTab==="inserts"&&<button onClick={()=>setInsertCuts([])}
              style={{fontSize:10,padding:"3px 8px",borderRadius:4,border:`1px solid ${C.bd}`,background:"transparent",color:C.txD,cursor:"pointer"}}>
              🗑 초기화 ({insertCuts.length}건)</button>}
            {manualResources.length>0&&subTab==="resources"&&<button onClick={()=>setManualResources([])}
              style={{fontSize:10,padding:"3px 8px",borderRadius:4,border:`1px solid ${C.bd}`,background:"transparent",color:C.txD,cursor:"pointer"}}>
              🗑 초기화 ({manualResources.length}건)</button>}
          </div>}
        </div>
        <div style={{padding:"6px 10px"}}>
          {subTab==="visuals" && <>
            {visualGuides.length===0&&<p style={{padding:30,textAlign:"center",fontSize:12,color:C.txD}}>📊 전체 생성 또는 블록 드래그 → 구간 추천</p>}
            {visualGuides.map((v,i)=>{
              const blockIdx=(v.block_range||[])[0]; const isActive=aBlock===blockIdx;
              const vKey=`vis-${v.id}`; const vd=verdicts[vKey]||null;
              const vMarker=visualMarkers[vKey]; const vMarkerColor=vMarker?.color;
              const vMc=vMarkerColor?MARKER_COLORS[vMarkerColor]:null;
              const isActiveMatch=vMatchMode?.key===vKey;
              const borderC=vMc?vMc.border:vd==="use"?"#22C55E":vd==="discard"?"rgba(239,68,68,0.4)":isActive?"#3B82F6":C.bd;
              const cardBg=vd==="discard"?"rgba(239,68,68,0.05)":vMc?vMc.bg.replace("0.3","0.08"):isActive?"rgba(59,130,246,0.08)":C.sf;
              return <div key={`v-${v.id||i}`} ref={el=>{if(el&&!cEls.current[blockIdx])cEls.current[blockIdx]=el}}
                data-card-block={blockIdx}
                onClick={()=>scrollTo(blockIdx)}
                style={{border:`1px solid ${borderC}`,borderRadius:10,padding:"10px 12px",marginBottom:8,
                  background:cardBg,cursor:"pointer",transition:"all 0.15s",opacity:vd==="discard"?0.5:1,
                  boxShadow:isActiveMatch?`0 0 0 2px ${vMc?.border||C.ac}`:isActive&&!vd?"0 0 0 2px rgba(59,130,246,0.3)":"none"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                  <span style={{fontSize:13}}>📊</span>
                  <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,
                    background:`${v.priority==="high"?"#EF4444":v.priority==="medium"?"#F59E0B":"#94A3B8"}22`,
                    color:v.priority==="high"?"#EF4444":v.priority==="medium"?"#F59E0B":"#94A3B8",textTransform:"uppercase"}}>{v.priority||"medium"}</span>
                  <span style={{fontSize:11,fontWeight:600,color:C.tx,flex:1,textDecoration:vd==="discard"?"line-through":"none"}}>{v.title}</span>
                  <span style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:"rgba(59,130,246,0.12)",color:"#3B82F6",fontWeight:600}}>{v.type}</span>
                </div>
                {v.reason&&<div style={{fontSize:11,color:C.txD,marginBottom:4}}>{v.reason}</div>}
                <VisualMockup type={v.type} chart_data={v.chart_data}/>
                <div style={{display:"flex",alignItems:"center",gap:6,marginTop:6}}>
                  <span style={{fontSize:10,color:isActive?"#3B82F6":C.txD,fontWeight:isActive?600:400}}>
                    블록 #{blockIdx}~#{(v.block_range||[])[1]||blockIdx}
                    {v.duration_seconds&&<span style={{marginLeft:8}}>⏱ {v.duration_seconds}초</span>}
                  </span>
                  <div style={{marginLeft:"auto",display:"flex",gap:3}}>
                    {[{k:"use",l:"사용",c:"#22C55E",bg:"rgba(34,197,94,0.15)"},{k:"discard",l:"폐기",c:"#EF4444",bg:"rgba(239,68,68,0.15)"}].map(o=>
                      <button key={o.k} onClick={e=>{e.stopPropagation();handleVerdictToggle(vKey,vd,o.k,v,"blue")}}
                        style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,cursor:"pointer",transition:"all 0.1s",
                          border:`1px solid ${vd===o.k?o.c:"transparent"}`,background:vd===o.k?o.bg:"rgba(255,255,255,0.04)",
                          color:vd===o.k?o.c:C.txD}}>{o.l}</button>)}
                  </div>
                </div>
                {/* 형광펜 팔레트 */}
                <div style={{display:"flex",alignItems:"center",gap:3,marginTop:6,paddingTop:6,borderTop:`1px solid ${C.bd}22`}}>
                  <span style={{fontSize:9,color:C.txD,marginRight:2}}>🖍</span>
                  {Object.entries(MARKER_COLORS).filter(([,cv])=>!cv._hidden).map(([ck,cv])=>
                    <button key={ck} onClick={e=>{e.stopPropagation();
                      if(isActiveMatch&&vMatchMode.color===ck) setVMatchMode(null);
                      else setVMatchMode({key:vKey,color:ck,blockIdx});}}
                      title={`${cv.label} 형광펜${vMarkerColor===ck?" (선택됨)":""}`}
                      style={{width:16,height:16,borderRadius:3,cursor:"pointer",transition:"all 0.12s",
                        border:`2px solid ${isActiveMatch&&vMatchMode.color===ck?"#fff":vMarkerColor===ck?cv.border:"transparent"}`,
                        background:cv.bg.replace("0.3","0.6"),
                        boxShadow:isActiveMatch&&vMatchMode.color===ck?"0 0 4px rgba(255,255,255,0.5)":"none"}}/>)}
                  {vMarker&&<button onClick={e=>{e.stopPropagation();handleMarkerClear(vKey);setVMatchMode(null)}}
                    title="형광펜 지우기"
                    style={{fontSize:9,lineHeight:1,padding:"2px 4px",border:`1px solid ${C.bd}`,borderRadius:3,
                      background:"rgba(255,255,255,0.06)",color:C.txD,cursor:"pointer"}}>✕</button>}
                  <span style={{flex:1}}/>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:4,marginTop:8,paddingTop:6,borderTop:`1px solid ${C.bd}44`}}>
                  <select onClick={e=>e.stopPropagation()} onChange={e=>{e.stopPropagation();handleRegenerate(v,"visuals",e.target.value||undefined);e.target.value=""}}
                    disabled={busy} value=""
                    style={{fontSize:10,padding:"4px 6px",borderRadius:5,border:`1px solid ${C.ac}44`,background:C.acS,color:C.ac,cursor:busy?"not-allowed":"pointer",fontWeight:600,flex:1,outline:"none",fontFamily:FN}}>
                    <option value="" disabled>🔄 다른 형식으로 재생성...</option>
                    {VIS_CATEGORIES.map(cat=><option key={cat.value} value={cat.value}>{cat.label}</option>)}
                  </select>
                  <button onClick={e=>{e.stopPropagation();handleRegenerate(v,"visuals")}} disabled={busy}
                    style={{fontSize:10,fontWeight:600,padding:"4px 10px",borderRadius:5,border:"none",cursor:busy?"not-allowed":"pointer",background:"rgba(59,130,246,0.7)",color:"#fff",whiteSpace:"nowrap"}}>🔄 재생성</button>
                </div>
              </div>;
            })}
          </>}
          {subTab==="inserts" && <>
            {insertCuts.length===0&&<p style={{padding:30,textAlign:"center",fontSize:12,color:C.txD}}>🎬 전체 생성 또는 블록 드래그 → 구간 추천</p>}
            {insertCuts.map((ic,i)=>{
              const blockIdx=(ic.block_range||[])[0];
              const icKey=`ic-${ic.id}`; const icVd=verdicts[icKey]||null;
              const icMarker=visualMarkers[icKey]; const icActiveMatch=vMatchMode?.key===icKey;
              return <div key={`ic-${ic.id||i}`} ref={el=>{if(el&&!cEls.current[blockIdx])cEls.current[blockIdx]=el}}
                data-card-block={blockIdx}>
                <InsertCutCard item={ic} active={aBlock===blockIdx} onClick={scrollTo}
                  verdict={icVd} onVerdict={v=>handleVerdictToggle(icKey,icVd,v,ic,"cyan")}
                  onRegenerate={()=>handleRegenerate(ic,"inserts")} busy={busy}
                  marker={icMarker} isActiveMatch={icActiveMatch} matchMode={vMatchMode}
                  onMatchClick={ck=>{
                    if(icActiveMatch&&vMatchMode.color===ck) setVMatchMode(null);
                    else setVMatchMode({key:icKey,color:ck,blockIdx});
                  }}
                  onMarkerClear={()=>{handleMarkerClear(icKey);setVMatchMode(null)}}/></div>;
            })}
          </>}
          {subTab==="resources" && <>
            {manualResources.length===0&&<p style={{padding:30,textAlign:"center",fontSize:12,color:C.txD}}>📎 왼쪽 패널에서 블록 선택 → "📎 자료 추가" 버튼으로 수동 자료를 추가하세요</p>}
            {manualResources.map((r,i)=>{
              const rt = RES_TYPES.find(t=>t.value===r.type) || RES_TYPES[3];
              const rKey=`res-${r.id}`; const rVd=verdicts[rKey]||null;
              const rMarker=visualMarkers[rKey]; const rMarkerColor=rMarker?.color;
              const rMc=rMarkerColor?MARKER_COLORS[rMarkerColor]:null;
              const rActiveMatch=vMatchMode?.key===rKey;
              const isEditing=resEditing?.id===r.id;
              const borderC=rMc?rMc.border:rVd==="use"?"#22C55E":rVd==="discard"?"rgba(239,68,68,0.4)":aBlock===r.block_index?"#F97316":C.bd;
              const cardBg=rVd==="discard"?"rgba(239,68,68,0.05)":rMc?rMc.bg.replace("0.3","0.08"):aBlock===r.block_index?"rgba(249,115,22,0.08)":C.sf;
              return <div key={`r-${r.id||i}`} data-card-block={r.block_index}
                onClick={()=>scrollTo(r.block_index)}
                style={{border:`1px solid ${borderC}`,borderRadius:10,padding:"10px 12px",marginBottom:8,
                  background:cardBg,cursor:"pointer",transition:"all 0.15s",opacity:rVd==="discard"?0.5:1,
                  boxShadow:rActiveMatch?`0 0 0 2px ${rMc?.border||C.ac}`:"none"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                  <span style={{fontSize:13}}>{rt.label.split(" ")[0]}</span>
                  <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,
                    background:"rgba(249,115,22,0.15)",color:"#F97316"}}>수동 추가</span>
                  {!isEditing && <span style={{fontSize:11,fontWeight:600,color:C.tx,flex:1,textDecoration:rVd==="discard"?"line-through":"none"}}>{r.text}</span>}
                  <span style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:`${rt.color}22`,color:rt.color,fontWeight:600}}>{rt.label}</span>
                </div>
                {/* 인라인 편집 모드 */}
                {isEditing && <div onClick={e=>e.stopPropagation()} style={{marginBottom:6}}>
                  <div style={{display:"flex",gap:4,marginBottom:6}}>
                    {RES_TYPES.map(et=>
                      <button key={et.value} onClick={()=>setResEditing(prev=>({...prev,type:et.value}))}
                        style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,cursor:"pointer",
                          border:`1px solid ${resEditing.type===et.value?et.color:"transparent"}`,
                          background:resEditing.type===et.value?`${et.color}22`:"rgba(255,255,255,0.04)",
                          color:resEditing.type===et.value?et.color:C.txD}}>{et.label}</button>)}
                  </div>
                  <textarea value={resEditing.text} onChange={e=>setResEditing(prev=>({...prev,text:e.target.value}))}
                    rows={2} autoFocus
                    style={{width:"100%",padding:"6px 8px",borderRadius:6,border:`1px solid ${C.bd}`,
                      background:"rgba(0,0,0,0.3)",color:C.tx,fontSize:12,fontFamily:FN,
                      lineHeight:1.5,resize:"vertical",outline:"none"}}
                    onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();handleSaveResource();}if(e.key==="Escape")setResEditing(null);}}/>
                  <div style={{display:"flex",gap:4,marginTop:4,justifyContent:"flex-end"}}>
                    <button onClick={()=>setResEditing(null)}
                      style={{fontSize:10,padding:"2px 8px",borderRadius:4,border:`1px solid ${C.bd}`,
                        background:"transparent",color:C.txM,cursor:"pointer"}}>취소</button>
                    <button onClick={handleSaveResource}
                      style={{fontSize:10,padding:"2px 8px",borderRadius:4,border:"none",
                        background:"#F97316",color:"#fff",fontWeight:600,cursor:"pointer"}}>저장</button>
                  </div>
                </div>}
                <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}>
                  <span style={{fontSize:10,color:C.txD}}>블록 #{r.block_index} · {r.speaker}</span>
                  <div style={{marginLeft:"auto",display:"flex",gap:3}}>
                    {[{k:"use",l:"사용",c:"#22C55E",bg:"rgba(34,197,94,0.15)"},{k:"discard",l:"폐기",c:"#EF4444",bg:"rgba(239,68,68,0.15)"}].map(o=>
                      <button key={o.k} onClick={e=>{e.stopPropagation();setVerdicts(prev=>({...prev,[rKey]:rVd===o.k?null:o.k}))}}
                        style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,cursor:"pointer",transition:"all 0.1s",
                          border:`1px solid ${rVd===o.k?o.c:"transparent"}`,background:rVd===o.k?o.bg:"rgba(255,255,255,0.04)",
                          color:rVd===o.k?o.c:C.txD}}>{o.l}</button>)}
                    <button onClick={e=>{e.stopPropagation();setResEditing({id:r.id,text:r.text,type:r.type})}}
                      title="수정"
                      style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,cursor:"pointer",
                        border:`1px solid ${C.bd}`,background:"transparent",color:C.txD}}>✏️</button>
                    <button onClick={e=>{e.stopPropagation();handleDeleteResource(r.id)}}
                      title="삭제"
                      style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,cursor:"pointer",
                        border:`1px solid ${C.bd}`,background:"transparent",color:C.txD}}>🗑</button>
                  </div>
                </div>
                {/* 형광펜 팔레트 */}
                <div style={{display:"flex",alignItems:"center",gap:3,marginTop:6,paddingTop:6,borderTop:`1px solid ${C.bd}22`}}>
                  <span style={{fontSize:9,color:C.txD,marginRight:2}}>🖍</span>
                  {Object.entries(MARKER_COLORS).filter(([,cv])=>!cv._hidden).map(([ck,cv])=>
                    <button key={ck} onClick={e=>{e.stopPropagation();
                      if(rActiveMatch&&vMatchMode.color===ck) setVMatchMode(null);
                      else setVMatchMode({key:rKey,color:ck,blockIdx:r.block_index});}}
                      title={`${cv.label} 형광펜${rMarkerColor===ck?" (선택됨)":""}`}
                      style={{width:16,height:16,borderRadius:3,cursor:"pointer",transition:"all 0.12s",
                        border:`2px solid ${rActiveMatch&&vMatchMode.color===ck?"#fff":rMarkerColor===ck?cv.border:"transparent"}`,
                        background:cv.bg.replace("0.3","0.6"),
                        boxShadow:rActiveMatch&&vMatchMode.color===ck?"0 0 4px rgba(255,255,255,0.5)":"none"}}/>)}
                  {rMarker&&<button onClick={e=>{e.stopPropagation();handleMarkerClear(rKey);setVMatchMode(null)}}
                    title="형광펜 지우기"
                    style={{fontSize:9,lineHeight:1,padding:"2px 4px",border:`1px solid ${C.bd}`,borderRadius:3,
                      background:"rgba(255,255,255,0.06)",color:C.txD,cursor:"pointer"}}>✕</button>}
                </div>
              </div>;
            })}
          </>}
        </div>
      </div>
    </div>
  </div>;
}
