// ═══════════════════════════════════════
// HTML 내보내기 — self-contained, 라이트 배경, 인쇄 가능
// ═══════════════════════════════════════

export function generateExportHTML(data) {
  const {
    filename, exportedAt, blocks, diffs, anal, hl, hlVerdicts, hlEdits,
    hlMarkers, scriptEdits, blockDeletions, reviewData, exportCache,
  } = data;

  const date = new Date(exportedAt).toLocaleString("ko-KR", {
    year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  function esc(s) {
    if (!s) return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtTime(sec) {
    if (sec == null) return "--:--";
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
    return `${m}:${String(ss).padStart(2,"0")}`;
  }

  const MARKER_BG = { yellow: "#FEF3C7", blue: "#DBEAFE", cyan: "#E0F2FE", red: "#FEE2E2", pink: "#FCE7F3" };
  const MARKER_BORDER = { yellow: "#D97706", blue: "#2563EB", cyan: "#0891B2", red: "#DC2626", pink: "#DB2777" };
  const VERDICT_LABELS = { use: "✅ 사용", recommend: "💡 추천", discard: "❌ 폐기" };
  const VERDICT_COLORS = { use: "#059669", recommend: "#D97706", discard: "#DC2626" };
  const CAT_LABELS = { subtitle: "💬 자막", cut: "✂️ 구간 삭제", graphic: "🎨 그래픽", audio: "🔊 오디오", etc: "📌 기타" };

  // ── 교정된 평문 텍스트 (마커 적용용) ──
  function applyBlockDeletions(text, dels) {
    if (!dels || dels.length === 0) return text;
    const sorted = [...dels].sort((a, b) => b.s - a.s);
    let result = text;
    for (const d of sorted) { result = result.slice(0, d.s) + result.slice(d.e); }
    return result;
  }

  function getCorrectedPlain(block) {
    const se = scriptEdits?.[block.index];
    let text;
    if (se !== undefined) { text = se; }
    else {
      const blockDiffs = (diffs || []).filter(d => d.blockIndex === block.index);
      if (blockDiffs.length === 0) { text = block.text; }
      else {
        const changes = blockDiffs.flatMap(d => d.changes || []);
        text = changes.reduce((t, c) => {
          if (c.original && c.corrected !== undefined) return t.replace(c.original, c.corrected);
          if (c.type === "filler_removal" && c.original) return t.replace(c.original, "");
          return t;
        }, block.text);
      }
    }
    return applyBlockDeletions(text, blockDeletions?.[block.index]);
  }

  // ── 마커 하이라이트 적용 HTML ──
  function applyMarkers(text, blockIdx, markers) {
    const ranges = [];
    for (const [, m] of Object.entries(markers || {})) {
      for (const r of (m.ranges || [])) {
        if (r.blockIdx === blockIdx) ranges.push({ s: r.s, e: r.e, color: m.color });
      }
    }
    if (ranges.length === 0) return esc(text);
    ranges.sort((a, b) => a.s - b.s);
    let result = "", cursor = 0;
    for (const r of ranges) {
      const s = Math.max(r.s, cursor), e = Math.min(r.e, text.length);
      if (s >= e) continue;
      if (s > cursor) result += esc(text.substring(cursor, s));
      const bg = MARKER_BG[r.color] || "#FEF3C7";
      const bd = MARKER_BORDER[r.color] || "#D97706";
      result += `<span style="background:${bg};border-bottom:2px solid ${bd};border-radius:2px;padding:1px 2px">${esc(text.substring(s, e))}</span>`;
      cursor = e;
    }
    if (cursor < text.length) result += esc(text.substring(cursor));
    return result;
  }

  // ═══ SECTIONS ═══

  // 1. 0차 원고 검토
  let reviewSection = "";
  if (reviewData) {
    const dur = reviewData.duration;
    const delCount = (reviewData.deletedBlockIndices || []).length;
    reviewSection = section("🔍 0차 원고 검토", `
      ${dur ? `<p>예상 영상 길이: <strong>${dur.display || ""}</strong> (${dur.confidence || ""})</p>` : ""}
      ${delCount > 0 ? `<p>삭제 구간: <strong>${delCount}블록</strong></p>` : "<p>삭제 구간 없음</p>"}
    `);
  }

  // 3. 사전 분석 결과
  let analSection = "";
  if (anal) {
    const es = anal.editorial_summary || {};
    let analHTML = "";
    if (anal.overview) analHTML += `<p><strong>주제:</strong> ${esc(anal.overview.topic || "")}</p>
      <p><strong>키워드:</strong> ${(anal.overview.keywords || []).map(k => `<span class="tag">${esc(k)}</span>`).join(" ")}</p>`;
    if (es.one_liner) analHTML += `<p><strong>요약:</strong> ${esc(es.one_liner)}</p>`;
    if (es.key_points?.length) analHTML += `<ul>${es.key_points.map(p => `<li>${esc(p)}</li>`).join("")}</ul>`;
    if (anal.speakers?.length) analHTML += `<p><strong>화자:</strong> ${anal.speakers.map(s => `${esc(s.name)} (${esc(s.role || "")})`).join(", ")}</p>`;
    if (anal.term_corrections?.length) {
      analHTML += `<h4>용어 교정 목록 (${anal.term_corrections.length}건)</h4>
        <table><tr><th>오인식</th><th>교정</th><th>신뢰도</th></tr>
        ${anal.term_corrections.map(t => `<tr><td>${esc(t.wrong)}</td><td><strong>${esc(t.correct)}</strong></td><td>${esc(t.confidence || "")}</td></tr>`).join("")}</table>`;
    }
    analSection = section("📊 사전 분석 결과", analHTML);
  }

  // 4. 편집 가이드 (강조자막) — 블록 인라인
  let guideSection = "";
  if (hl?.length > 0 && blocks?.length > 0) {
    const useCount = Object.values(hlVerdicts || {}).filter(v => v === "use").length;
    const recCount = Object.values(hlVerdicts || {}).filter(v => v === "recommend").length;
    // 블록별 가이드 그룹핑
    const guidesByBlock = {};
    for (const h of hl) {
      const bi = h.block_index;
      if (!guidesByBlock[bi]) guidesByBlock[bi] = [];
      guidesByBlock[bi].push(h);
    }
    const TYPE_COLORS = { A: "#059669", B: "#2563EB", C: "#F97316", D: "#059669", E: "#059669" };
    const rows = blocks.map(b => {
      const guides = guidesByBlock[b.index] || [];
      const corrected = getCorrectedPlain(b);
      const markedText = applyMarkers(corrected, b.index, hlMarkers);
      const hasGuides = guides.length > 0;
      // 가이드 카드 — "사용" verdict만 표시
      const cards = guides.map(h => {
        const key = `${h.block_index}-${h.subtitle}`;
        const verdict = hlVerdicts?.[key];
        if (verdict !== "use") return ""; // 사용이 아니면 내보내기에서 제외
        const edited = hlEdits?.[key];
        const cat = (h.type || "A").charAt(0);
        const isUserMat = h.type?.startsWith("C_user");
        const effectiveCat = (cat === "C" && !isUserMat) ? "A" : cat;
        const typeColor = TYPE_COLORS[effectiveCat] || "#059669";
        const catLabel = effectiveCat === "B" ? "용어설명" : isUserMat ? "자료" : "자막";
        return `<div class="inline-card" style="border-left:3px solid ${typeColor}">
          <span class="badge" style="background:${typeColor}15;color:${typeColor}">${catLabel}</span>
          <span style="font-size:11px;color:#059669;margin-left:4px">✅</span>
          <div style="font-size:14px;font-weight:500;color:${typeColor};line-height:1.6;margin-top:4px;white-space:pre-line">${esc(edited || h.subtitle)}</div>
        </div>`;
      }).filter(Boolean).join("\n");
      return `<div class="block${hasGuides ? " has-data" : ""}">
        <div class="block-header"><span class="block-idx">#${b.index}</span> <span class="speaker">${esc(b.speaker)}</span> <span class="ts">${esc(b.timestamp)}</span></div>
        <div class="block-text">${markedText}</div>
        ${cards}
      </div>`;
    }).join("\n");
    guideSection = section("🎬 편집 가이드 (강조자막)", `
      <p class="meta">총 ${hl.length}개 · 사용 ${useCount}개 · 추천 ${recCount}개</p>
      ${rows}
    `, true);
  }

  // ── 차트 데이터 → 정적 HTML 렌더링 ──
  function renderChartHTML(type, chart_data, title) {
    if (!chart_data) return "";
    const d = chart_data;
    const labels = d.labels || [];
    const datasets = d.datasets || [];
    const VIS_COLORS = ["#3B82F6","#8B5CF6","#EF4444","#22C55E","#F59E0B","#EC4899","#06B6D4","#F97316"];
    // 타입 정규화 (AI가 다양한 변형 이름을 생성할 수 있음)
    const t = (type || "").toLowerCase().replace(/-/g, "_");

    // 테이블 형식 (table, comparison, ranking, structure)
    if (["table","comparison","ranking","structure","matrix"].includes(t)) {
      if (d.rows) {
        const headers = d.headers || Object.keys(d.rows[0] || {});
        return `<table style="margin:8px 0">
          <tr>${headers.map(h => `<th>${esc(String(h))}</th>`).join("")}</tr>
          ${d.rows.map(r => `<tr>${(Array.isArray(r) ? r : headers.map(h => r[h] ?? "")).map(v => `<td>${esc(String(v ?? ""))}</td>`).join("")}</tr>`).join("")}
        </table>`;
      }
      if (d.items) {
        return `<div style="margin:8px 0">${d.items.map(item => {
          if (typeof item === "string") return `<div style="margin:4px 0;font-size:13px;padding:6px 10px;background:#F9FAFB;border-radius:6px">• ${esc(item)}</div>`;
          return `<div style="margin:4px 0;font-size:13px;padding:6px 10px;background:#F9FAFB;border-radius:6px;border-left:3px solid #3B82F6"><strong>${esc(item.label || item.title || "")}</strong>${item.description || item.value ? ` — ${esc(String(item.description || item.value || ""))}` : ""}</div>`;
        }).join("")}</div>`;
      }
      if (labels.length && datasets.length) {
        return `<table style="margin:8px 0">
          <tr><th></th>${datasets.map(ds => `<th>${esc(ds.label || "")}</th>`).join("")}</tr>
          ${labels.map((lb, i) => `<tr><td><strong>${esc(String(lb))}</strong></td>${datasets.map(ds => `<td>${(ds.data||[])[i] ?? ""}${d.unit||""}</td>`).join("")}</tr>`).join("")}
        </table>`;
      }
    }

    // KPI
    if (t === "kpi" && d.items) {
      return `<div style="display:flex;gap:12px;flex-wrap:wrap;margin:8px 0">${d.items.map(item =>
        `<div style="background:#F0F9FF;border:1px solid #DBEAFE;border-radius:8px;padding:10px 16px;text-align:center;min-width:100px">
          <div style="font-size:20px;font-weight:800;color:#2563EB">${esc(String(item.value ?? ""))}${esc(item.unit||"")}</div>
          <div style="font-size:12px;color:#666;margin-top:2px">${esc(item.label || "")}</div>
        </div>`).join("")}</div>`;
    }

    // 막대 차트 (bar, bar_horizontal)
    if (["bar","bar_horizontal","bar_stacked","bar_grouped"].includes(t) && labels.length && datasets.length) {
      const allVals = datasets.flatMap(ds => ds.data || []);
      const maxVal = Math.max(...allVals, 1);
      return `<div style="margin:8px 0">${labels.map((lb, i) => {
        const vals = datasets.map((ds, di) => ({ val: (ds.data||[])[i]||0, color: (ds.colors||VIS_COLORS)[di % VIS_COLORS.length], label: ds.label }));
        return `<div style="display:flex;align-items:center;gap:8px;margin:3px 0">
          <span style="font-size:12px;color:#666;width:90px;text-align:right;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(lb))}</span>
          <div style="flex:1;display:flex;gap:2px">${vals.map(v =>
            `<div style="height:18px;border-radius:3px;background:${v.color};width:${(v.val/maxVal)*100}%;min-width:${v.val>0?2:0}px"></div>`).join("")}</div>
          <span style="font-size:11px;color:#888;width:50px">${vals.map(v=>v.val).join("/")}${d.unit||""}</span>
        </div>`;
      }).join("")}</div>`;
    }

    // 도넛/파이
    if (["donut","pie","pie_chart"].includes(t) && labels.length && datasets.length) {
      const data0 = datasets[0]?.data || [];
      const total = data0.reduce((s,v)=>s+v, 0) || 1;
      return `<div style="margin:8px 0">${labels.map((lb, i) => {
        const pct = ((data0[i]||0)/total*100).toFixed(1);
        return `<div style="display:flex;align-items:center;gap:8px;margin:2px 0">
          <span style="width:10px;height:10px;border-radius:50%;background:${VIS_COLORS[i%VIS_COLORS.length]};flex-shrink:0"></span>
          <span style="font-size:12px;color:#333;flex:1">${esc(String(lb))}</span>
          <span style="font-size:12px;font-weight:700;color:#333">${pct}%</span>
          <span style="font-size:11px;color:#888">(${data0[i]||0}${d.unit||""})</span>
        </div>`;
      }).join("")}</div>`;
    }

    // 프로세스/타임라인 (모든 변형 포함)
    if (t.includes("timeline") || t.includes("process") || t.includes("flow") || t === "sequence") {
      if (d.steps) {
        return `<div style="margin:8px 0;padding-left:12px;border-left:3px solid #DBEAFE">${d.steps.map((st, i) =>
          `<div style="margin:6px 0"><span style="font-size:11px;font-weight:700;color:#3B82F6;margin-right:6px">${i+1}.</span><span style="font-size:13px">${esc(st.label || st.title || String(st))}</span>${st.description || st.date ? `<div style="font-size:12px;color:#888;margin-left:20px">${esc(st.date || "")}${st.date && st.description ? " — " : ""}${esc(st.description || "")}</div>` : ""}</div>`).join("")}</div>`;
      }
      if (d.events) {
        return `<div style="margin:8px 0;padding-left:12px;border-left:3px solid #DBEAFE">${d.events.map((ev, i) =>
          `<div style="margin:6px 0"><span style="font-size:11px;font-weight:700;color:#3B82F6;margin-right:6px">${esc(ev.date || ev.time || String(i+1))}.</span><span style="font-size:13px">${esc(ev.label || ev.title || ev.event || String(ev))}</span>${ev.description ? `<div style="font-size:12px;color:#888;margin-left:20px">${esc(ev.description)}</div>` : ""}</div>`).join("")}</div>`;
      }
      if (d.items) {
        return `<div style="margin:8px 0;padding-left:12px;border-left:3px solid #DBEAFE">${d.items.map((it, i) => {
          const label = it.label || it.title || it.event || (typeof it === "string" ? it : JSON.stringify(it));
          return `<div style="margin:6px 0"><span style="font-size:11px;font-weight:700;color:#3B82F6;margin-right:6px">${i+1}.</span><span style="font-size:13px">${esc(label)}</span>${it.description || it.date ? `<div style="font-size:12px;color:#888;margin-left:20px">${esc(it.date || "")}${it.date && it.description ? " — " : ""}${esc(it.description || "")}</div>` : ""}</div>`;
        }).join("")}</div>`;
      }
      // labels를 timeline으로 표시
      if (labels.length) {
        return `<div style="margin:8px 0;padding-left:12px;border-left:3px solid #DBEAFE">${labels.map((lb, i) =>
          `<div style="margin:6px 0"><span style="font-size:11px;font-weight:700;color:#3B82F6;margin-right:6px">${i+1}.</span><span style="font-size:13px">${esc(String(lb))}</span>${datasets.length ? `<div style="font-size:12px;color:#888;margin-left:20px">${datasets.map(ds => `${esc(ds.label||"")}: ${(ds.data||[])[i] ?? ""}`).join(" · ")}</div>` : ""}</div>`).join("")}</div>`;
      }
    }

    // 체크리스트
    if (t === "checklist" && d.items) {
      return `<div style="margin:8px 0">${d.items.map(item =>
        `<div style="margin:2px 0;font-size:13px">☐ ${esc(item.label || String(item))}</div>`).join("")}</div>`;
    }

    // 기본 폴백: labels+datasets → 테이블
    if (labels.length && datasets.length) {
      return `<table style="margin:8px 0">
        <tr><th></th>${datasets.map(ds => `<th>${esc(ds.label || "")}</th>`).join("")}</tr>
        ${labels.map((lb, i) => `<tr><td>${esc(String(lb))}</td>${datasets.map(ds => `<td>${(ds.data||[])[i] ?? ""}${d.unit||""}</td>`).join("")}</tr>`).join("")}
      </table>`;
    }

    // rows 폴백
    if (d.rows) {
      const headers = d.headers || Object.keys(d.rows[0] || {});
      return `<table style="margin:8px 0">
        <tr>${headers.map(h => `<th>${esc(String(h))}</th>`).join("")}</tr>
        ${d.rows.map(r => `<tr>${(Array.isArray(r) ? r : headers.map(h => r[h] ?? "")).map(v => `<td>${esc(String(v ?? ""))}</td>`).join("")}</tr>`).join("")}
      </table>`;
    }

    // items 폴백
    if (d.items) {
      return `<div style="margin:8px 0">${d.items.map((item, i) => {
        if (typeof item === "string") return `<div style="margin:3px 0;font-size:13px">${i+1}. ${esc(item)}</div>`;
        return `<div style="margin:3px 0;font-size:13px">${i+1}. <strong>${esc(item.label || item.title || "")}</strong>${item.description || item.value ? ` — ${esc(String(item.description || item.value))}` : ""}</div>`;
      }).join("")}</div>`;
    }

    // steps 폴백
    if (d.steps) {
      return `<div style="margin:8px 0;padding-left:12px;border-left:3px solid #DBEAFE">${d.steps.map((st, i) =>
        `<div style="margin:6px 0"><span style="font-size:11px;font-weight:700;color:#3B82F6;margin-right:6px">${i+1}.</span><span style="font-size:13px">${esc(st.label || st.title || String(st))}</span></div>`).join("")}</div>`;
    }

    return "";
  }

  // 5. 자료 & 그래픽 가이드 — 블록 인라인
  let visualSection = "";
  const vc = exportCache?.visual;
  if (vc && blocks?.length > 0) {
    const IC_LABELS = { A: "🎨 회상 일러스트", B: "🏢 공식 이미지/유튜브", C: "🏆 작품/성과물" };
    const IC_COLORS = { A: "#8B5CF6", B: "#3B82F6", C: "#F59E0B" };
    const RES_LABELS = { image: "🖼 이미지", video: "🎬 영상", data: "📊 그래픽", etc: "📌 기타" };
    const RES_COLORS = { image: "#3B82F6", video: "#8B5CF6", data: "#22C55E", etc: "#F59E0B" };
    // 블록별 아이템 그룹핑
    const visByBlock = {}, icByBlock = {}, resByBlock = {};
    for (const v of (vc.visualGuides || [])) { const bi = (v.block_range || [])[0]; if (bi != null) { if (!visByBlock[bi]) visByBlock[bi] = []; visByBlock[bi].push(v); } }
    for (const ic of (vc.insertCuts || [])) { const bi = (ic.block_range || [])[0]; if (bi != null) { if (!icByBlock[bi]) icByBlock[bi] = []; icByBlock[bi].push(ic); } }
    for (const r of (vc.manualResources || [])) { const bi = r.block_index; if (bi != null) { if (!resByBlock[bi]) resByBlock[bi] = []; resByBlock[bi].push(r); } }
    const allBlockIndices = new Set([...Object.keys(visByBlock), ...Object.keys(icByBlock), ...Object.keys(resByBlock)].map(Number));
    // 통계
    const totalVis = (vc.visualGuides || []).length, totalIc = (vc.insertCuts || []).length, totalRes = (vc.manualResources || []).length;
    const rows = blocks.map(b => {
      const vis = visByBlock[b.index] || [];
      const ics = icByBlock[b.index] || [];
      const res = resByBlock[b.index] || [];
      const hasData = vis.length + ics.length + res.length > 0;
      const corrected = getCorrectedPlain(b);
      const markedText = applyMarkers(corrected, b.index, vc.visualMarkers);
      // 시각화 카드 — "사용"만 표시 + 차트 시각화 포함
      const visCards = vis.map(v => {
        const vd = vc.verdicts?.[`vis-${v.id}`];
        if (vd !== "use") return ""; // 사용이 아니면 제외
        const chartHTML = renderChartHTML(v.type, v.chart_data, v.title);
        return `<div class="inline-card" style="border-left:3px solid #3B82F6">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:13px">📊</span>
            <span class="badge" style="background:rgba(59,130,246,0.1);color:#3B82F6">${esc(v.type)}</span>
            <span style="font-weight:600;color:#3B82F6;flex:1">${esc(v.title)}</span>
            <span style="font-size:11px;color:#059669">✅</span>
          </div>
          ${v.reason ? `<div style="font-size:12px;color:#666;margin-top:4px">${esc(v.reason)}</div>` : ""}
          ${chartHTML}
          <div style="font-size:11px;color:#888;margin-top:2px">${v.priority || ""} ${v.duration_seconds ? "· " + v.duration_seconds + "초" : ""}</div>
        </div>`;
      }).filter(Boolean).join("");
      // 인서트 컷 카드 — "사용"만 표시
      const icCards = ics.map(ic => {
        const vd = vc.verdicts?.[`ic-${ic.id}`];
        if (vd !== "use") return "";
        const icColor = IC_COLORS[ic.type] || "#3B82F6";
        return `<div class="inline-card" style="border-left:3px solid ${icColor}">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:13px">${(IC_LABELS[ic.type] || "🎬").split(" ")[0]}</span>
            <span class="badge" style="background:${icColor}15;color:${icColor}">Type ${esc(ic.type)}</span>
            <span style="font-weight:600;color:${icColor};flex:1">${esc(ic.title)}</span>
            <span style="font-size:11px;color:#059669">✅</span>
          </div>
          ${ic.trigger_quote ? `<div style="font-style:italic;color:#555;margin:4px 0;border-left:2px solid #ddd;padding-left:8px;font-size:13px">"${esc(ic.trigger_quote)}"</div>` : ""}
          ${ic.instruction ? `<div style="font-size:12px;color:#666">${esc(ic.instruction)}</div>` : ""}
          ${ic.image_prompt ? `<div style="font-size:11px;color:#7C3AED;margin-top:4px">🖼 ${esc(ic.image_prompt)}</div>` : ""}
          ${ic.search_keywords?.length ? `<div style="margin-top:3px">${ic.search_keywords.map(k => `<span class="tag">${esc(k)}</span>`).join(" ")}</div>` : ""}
        </div>`;
      }).filter(Boolean).join("");
      // 수동 자료 카드 — "사용"만 표시
      const resCards = res.map(r => {
        const vd = vc.verdicts?.[`res-${r.id}`];
        if (vd !== "use") return "";
        const rc = RES_COLORS[r.type] || "#F59E0B";
        return `<div class="inline-card" style="border-left:3px solid #F97316">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:13px">📎</span>
            <span class="badge" style="background:${rc}15;color:${rc}">${RES_LABELS[r.type] || r.type}</span>
            <span style="font-weight:600;color:#F97316;flex:1">${esc(r.text)}</span>
            <span style="font-size:11px;color:#059669">✅</span>
          </div>
          ${r.source ? `<div style="font-size:12px;color:#888;margin-top:2px">출처: ${esc(r.source)}</div>` : ""}
        </div>`;
      }).filter(Boolean).join("");
      return `<div class="block${hasData ? " has-data" : ""}">
        <div class="block-header"><span class="block-idx">#${b.index}</span> <span class="speaker">${esc(b.speaker)}</span> <span class="ts">${esc(b.timestamp)}</span></div>
        <div class="block-text">${markedText}</div>
        ${visCards}${icCards}${resCards}
      </div>`;
    }).join("\n");
    const summary = [totalVis > 0 ? `시각화 ${totalVis}건` : "", totalIc > 0 ? `인서트 컷 ${totalIc}건` : "", totalRes > 0 ? `수동 자료 ${totalRes}건` : ""].filter(Boolean).join(" · ");
    visualSection = section("📊 자료 & 그래픽 가이드", `<p class="meta">${summary}</p>${rows}`);
  }

  // 6. 하이라이트 클립
  let highlightSection = "";
  const hc = exportCache?.highlight;
  if (hc) {
    let html = "";
    if (hc.clips?.length > 0) {
      html += `<h4>선택된 클립 (${hc.clips.length}개)</h4>`;
      html += `<ol>${hc.clips.map((cl, i) => `<li style="margin-bottom:8px">
        <div style="font-size:14px">${esc(cl.text || cl.subtitle || "")}</div>
        <div style="font-size:12px;color:#888">${esc(cl.speaker || "")} · ${cl.duration ? cl.duration + "초" : ""}</div>
      </li>`).join("")}</ol>`;
    }
    if (hc.recommendations?.length > 0) {
      html += `<h4>AI 추천 목록 (${hc.recommendations.length}개)</h4>`;
      html += `<ol>${hc.recommendations.map(r => `<li style="margin-bottom:6px">
        <div style="font-size:13px">${esc(r.text || "")}</div>
        <div style="font-size:12px;color:#888">${esc(r.speaker || "")} · ${esc(r.reason || "")}</div>
      </li>`).join("")}</ol>`;
    }
    if (hc.timestamps) {
      html += `<h4>타임스탬프 (챕터)</h4><pre style="background:#F9FAFB;padding:12px;border-radius:8px;font-size:13px;white-space:pre-wrap">${esc(typeof hc.timestamps === "string" ? hc.timestamps : JSON.stringify(hc.timestamps, null, 2))}</pre>`;
    }
    if (html) highlightSection = section("⭐ 하이라이트 클립", html);
  }

  // 7. 세트 생성 결과
  let setgenSection = "";
  const sc = exportCache?.setgen;
  if (sc) {
    let html = "";
    if (sc.results?.length > 0) {
      html += sc.results.map((r, i) => `<div class="card">
        <div style="font-weight:700;font-size:15px;margin-bottom:4px">${esc(r.title || `세트 ${i + 1}`)}</div>
        ${r.description ? `<div style="font-size:13px;color:#555;white-space:pre-wrap">${esc(r.description)}</div>` : ""}
        ${r.tags?.length ? `<div style="margin-top:6px">${r.tags.map(t => `<span class="tag">${esc(t)}</span>`).join(" ")}</div>` : ""}
      </div>`).join("\n");
    }
    if (sc.tags?.length) {
      html += `<h4>태그</h4><div>${sc.tags.map(t => `<span class="tag">${esc(t)}</span>`).join(" ")}</div>`;
    }
    if (sc.timestamps) {
      html += `<h4>타임스탬프</h4><pre style="background:#F9FAFB;padding:12px;border-radius:8px;font-size:13px;white-space:pre-wrap">${esc(typeof sc.timestamps === "string" ? sc.timestamps : JSON.stringify(sc.timestamps, null, 2))}</pre>`;
    }
    if (html) setgenSection = section("🎯 세트 생성 결과", html);
  }

  // 8. 영상 수정사항
  let modifySection = "";
  const mc = exportCache?.modify;
  if (mc?.cards?.length > 0) {
    const cards = mc.cards;
    const checked = cards.filter(c => c.checked).length;
    let html = `<p class="meta">${mc.title ? esc(mc.title) + " · " : ""}${cards.length}건 · 완료 ${checked}건${mc.videoUrl ? ` · <a href="${esc(mc.videoUrl)}" target="_blank">YouTube 링크</a>` : ""}</p>`;
    html += cards.map(c => {
      const catLabel = CAT_LABELS[c.category] || c.category;
      return `<div class="card" style="${c.checked ? "opacity:0.6;text-decoration:line-through;" : ""}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-family:monospace;color:#6C9CFC">▶ ${fmtTime(c.timestamp)}${c.timestampEnd != null ? "~" + fmtTime(c.timestampEnd) : ""}</span>
          <span>${catLabel} ${c.checked ? "✅" : "☐"}</span>
        </div>
        <div style="font-size:14px;white-space:pre-wrap">${esc(c.content)}</div>
        ${c.hasImage && mc.images?.[c.id] ? `<img src="data:image/jpeg;base64,${mc.images[c.id]}" style="max-width:100%;max-height:300px;border-radius:8px;margin-top:8px;border:1px solid #E5E7EB" />` : ""}
      </div>`;
    }).join("\n");
    modifySection = section("🎬 영상 수정사항", html, true);
  }

  function section(title, content, open = true) {
    return `<details${open ? " open" : ""}><summary class="section-title">${title}</summary><div class="section-body">${content}</div></details>`;
  }

  // ═══ FINAL HTML ═══
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(filename || "편집 가이드")} — 내보내기</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif; background: #fff; color: #1a1a1a; line-height: 1.7; padding: 40px 20px; max-width: 900px; margin: 0 auto; }
  @media print { body { padding: 20px; } details { break-inside: avoid; } }
  h1 { font-size: 24px; font-weight: 800; margin-bottom: 4px; }
  h4 { font-size: 15px; font-weight: 700; margin: 20px 0 10px; color: #333; }
  .header-meta { font-size: 13px; color: #888; margin-bottom: 32px; }
  .section-title { font-size: 18px; font-weight: 700; cursor: pointer; padding: 14px 0 10px; border-bottom: 2px solid #E5E7EB; margin-top: 24px; color: #111; user-select: none; }
  .section-title:hover { color: #4A6CF7; }
  .section-body { padding: 16px 0; }
  .meta { font-size: 13px; color: #888; margin-bottom: 12px; }
  .block { margin-bottom: 12px; padding: 10px 14px; border-radius: 8px; background: #FAFAFA; border: 1px solid #F0F0F0; }
  .block-header { font-size: 13px; margin-bottom: 4px; }
  .speaker { font-weight: 700; color: #4A6CF7; }
  .ts { font-family: monospace; color: #888; margin-left: 8px; }
  .block-text { font-size: 14px; white-space: pre-wrap; line-height: 1.8; }
  .card { background: #FAFAFA; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px; margin-bottom: 10px; }
  .inline-card { background: #FAFBFC; border: 1px solid #E5E7EB; border-radius: 8px; padding: 10px 14px; margin: 6px 0 4px 20px; }
  .has-data { border-left: 3px solid #A855F7; }
  .block-idx { font-family: monospace; font-size: 11px; font-weight: 700; color: #999; background: #F3F4F6; padding: 1px 5px; border-radius: 3px; margin-right: 4px; }
  .badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; background: #EEF2FF; color: #4338CA; }
  .tag { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 4px; background: #F0F9FF; color: #0369A1; margin: 2px 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 10px 0; }
  th { background: #F9FAFB; padding: 8px; text-align: left; border-bottom: 2px solid #E5E7EB; font-weight: 700; }
  td { padding: 6px 8px; border-bottom: 1px solid #F0F0F0; }
  a { color: #4A6CF7; text-decoration: none; }
  pre { overflow-x: auto; }
  ul, ol { padding-left: 20px; }
  li { margin-bottom: 4px; }
  img { display: block; }
</style>
</head>
<body>
  <h1>${esc(filename || "편집 가이드")}</h1>
  <div class="header-meta">내보내기: ${date} · ttimes 편집 CMS</div>
  ${reviewSection}
  ${analSection}
  ${guideSection}
  ${visualSection}
  ${modifySection}
  ${highlightSection}
  ${setgenSection}
  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #E5E7EB;font-size:12px;color:#aaa;text-align:center">
    ttimes 편집 CMS · ${date}
  </div>
</body>
</html>`;
}
