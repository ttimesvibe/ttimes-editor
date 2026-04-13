// ═══════════════════════════════════════
// HTML 내보내기 — self-contained, 라이트 배경, 인쇄 가능
// ═══════════════════════════════════════

export function generateExportHTML(data) {
  const {
    filename, exportedAt, blocks, diffs, anal, hl, hlVerdicts, hlEdits,
    hlMarkers, scriptEdits, reviewData, exportCache,
  } = data;

  const date = new Date(exportedAt).toLocaleString("ko-KR", {
    year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  // ── 교정 텍스트 생성 (변경 부분 색상 표시) ──
  function getCorrectedHTML(block) {
    const blockDiffs = (diffs || []).filter(d => d.blockIndex === block.index);
    const se = scriptEdits?.[block.index];
    if (se !== undefined) return esc(se);
    if (blockDiffs.length === 0) return esc(block.text);

    let text = block.text;
    const changes = blockDiffs.flatMap(d => d.changes || []);
    // 변경 사항이 있지만 복잡한 인라인 표시 대신, 원문+교정 병렬 표시
    const parts = [];
    for (const c of changes) {
      if (c.type === "filler_removal") {
        parts.push(`<span style="background:#FEF3C7;text-decoration:line-through;color:#92400E" title="추임새 제거">${esc(c.original)}</span>`);
      } else if (c.type === "term_correction") {
        parts.push(`<span style="text-decoration:line-through;color:#999">${esc(c.original)}</span> → <span style="background:#D1FAE5;color:#065F46;font-weight:600" title="${esc(c.reason || "용어 교정")}">${esc(c.corrected)}</span>`);
      } else if (c.corrected && c.original) {
        parts.push(`<span style="text-decoration:line-through;color:#999">${esc(c.original)}</span> → <span style="background:#DBEAFE;color:#1E40AF">${esc(c.corrected)}</span>`);
      }
    }
    const correctedText = changes.reduce((t, c) => {
      if (c.original && c.corrected !== undefined) return t.replace(c.original, c.corrected);
      if (c.type === "filler_removal" && c.original) return t.replace(c.original, "");
      return t;
    }, text);
    return esc(correctedText);
  }

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

  const MARKER_COLORS = { yellow: "#FEF3C7", blue: "#DBEAFE", sky: "#E0F2FE", red: "#FEE2E2", pink: "#FCE7F3" };
  const VERDICT_LABELS = { use: "✅ 사용", recommend: "💡 추천", discard: "❌ 폐기" };
  const VERDICT_COLORS = { use: "#059669", recommend: "#D97706", discard: "#DC2626" };
  const CAT_LABELS = { subtitle: "💬 자막", cut: "✂️ 구간 삭제", graphic: "🎨 그래픽", audio: "🔊 오디오", etc: "📌 기타" };

  // ═══ SECTIONS ═══

  // 1. 교정 원고
  let correctedSection = "";
  if (blocks?.length > 0) {
    const rows = blocks.map(b => {
      const corrected = getCorrectedHTML(b);
      return `<div class="block">
        <div class="block-header"><span class="speaker">${esc(b.speaker)}</span> <span class="ts">${esc(b.timestamp)}</span></div>
        <div class="block-text">${corrected}</div>
      </div>`;
    }).join("\n");
    correctedSection = section("📝 교정된 원고 전문", `<p class="meta">${blocks.length}블록 · ${blocks.reduce((s, b) => s + b.text.length, 0).toLocaleString()}자</p>${rows}`, true);
  }

  // 2. 0차 원고 검토
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

  // 4. 편집 가이드 (강조자막)
  let guideSection = "";
  if (hl?.length > 0) {
    const rows = hl.map(h => {
      const key = `${h.block_index}-${h.subtitle}`;
      const verdict = hlVerdicts?.[key];
      const edited = hlEdits?.[key];
      const marker = hlMarkers?.[key];
      const markerBg = marker ? (MARKER_COLORS[marker.color] || "#FEF3C7") : "transparent";
      const verdictLabel = VERDICT_LABELS[verdict] || "";
      const verdictColor = VERDICT_COLORS[verdict] || "#666";
      return `<div class="card" style="border-left:3px solid ${verdictColor};${verdict === "discard" ? "opacity:0.5;" : ""}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span><span class="badge">${esc(h.type)}</span> <span style="color:#666;font-size:12px">${esc(h.type_name || "")}</span></span>
          <span style="color:${verdictColor};font-weight:600;font-size:12px">${verdictLabel}</span>
        </div>
        <div style="background:${markerBg};padding:6px 10px;border-radius:6px;font-size:15px;line-height:1.6;${verdict === "discard" ? "text-decoration:line-through;" : ""}">${esc(edited || h.subtitle)}</div>
        <div style="margin-top:6px;font-size:12px;color:#888">블록 #${h.block_index} · ${esc(h.speaker || "")} ${h.reason ? "· " + esc(h.reason) : ""}</div>
      </div>`;
    }).join("\n");

    const useCount = Object.values(hlVerdicts || {}).filter(v => v === "use").length;
    const recCount = Object.values(hlVerdicts || {}).filter(v => v === "recommend").length;
    guideSection = section("🎬 편집 가이드 (강조자막)", `
      <p class="meta">총 ${hl.length}개 · 사용 ${useCount}개 · 추천 ${recCount}개</p>
      ${rows}
    `, true);
  }

  // 5. 자료 & 그래픽 가이드
  let visualSection = "";
  const vc = exportCache?.visual;
  if (vc) {
    let html = "";
    if (vc.visualGuides?.length > 0) {
      html += `<h4>📊 시각화 가이드 (${vc.visualGuides.length}건)</h4>`;
      html += vc.visualGuides.map(v => {
        const vd = vc.verdicts?.[`vis-${v.id}`];
        const vdLabel = vd === "use" ? "✅ 사용" : vd === "discard" ? "❌ 폐기" : "";
        return `<div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span><span class="badge">${esc(v.type)}</span> <strong>${esc(v.title)}</strong></span>
            <span style="font-size:12px;color:${vd === "use" ? "#059669" : vd === "discard" ? "#DC2626" : "#888"}">${vdLabel}</span>
          </div>
          ${v.reason ? `<div style="font-size:13px;color:#666;margin-top:4px">${esc(v.reason)}</div>` : ""}
          <div style="font-size:12px;color:#888;margin-top:4px">블록 #${(v.block_range || [])[0] ?? "?"}~#${(v.block_range || [])[1] ?? (v.block_range || [])[0] ?? "?"} · ${v.priority || ""} · ${v.duration_seconds ? v.duration_seconds + "초" : ""}</div>
        </div>`;
      }).join("\n");
    }
    if (vc.insertCuts?.length > 0) {
      const IC_LABELS = { A: "🎨 회상 일러스트", B: "🏢 공식 이미지", C: "🏆 작품/성과물" };
      html += `<h4>🎬 인서트 컷 (${vc.insertCuts.length}건)</h4>`;
      html += vc.insertCuts.map(ic => {
        const vd = vc.verdicts?.[`ic-${ic.id}`];
        const vdLabel = vd === "use" ? "✅ 사용" : vd === "discard" ? "❌ 폐기" : "";
        return `<div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span>${IC_LABELS[ic.type] || ic.type} <strong>${esc(ic.title)}</strong></span>
            <span style="font-size:12px;color:${vd === "use" ? "#059669" : vd === "discard" ? "#DC2626" : "#888"}">${vdLabel}</span>
          </div>
          ${ic.trigger_quote ? `<div style="font-style:italic;color:#555;margin:4px 0;border-left:2px solid #ddd;padding-left:8px">"${esc(ic.trigger_quote)}"</div>` : ""}
          ${ic.instruction ? `<div style="font-size:13px;color:#666">${esc(ic.instruction)}</div>` : ""}
          ${ic.image_prompt ? `<div style="font-size:12px;color:#7C3AED;margin-top:4px">🖼 ${esc(ic.image_prompt)}</div>` : ""}
          ${ic.search_keywords?.length ? `<div style="margin-top:4px">${ic.search_keywords.map(k => `<span class="tag">${esc(k)}</span>`).join(" ")}</div>` : ""}
          <div style="font-size:12px;color:#888;margin-top:4px">블록 #${(ic.block_range || [])[0] ?? "?"}</div>
        </div>`;
      }).join("\n");
    }
    if (html) visualSection = section("📊 자료 & 그래픽 가이드", html);
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
  ${correctedSection}
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
