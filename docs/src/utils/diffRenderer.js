// ═══════════════════════════════════════════════
// DIFF RENDERING
// ═══════════════════════════════════════════════

export function findPositions(text, changes) {
  const pos = [];
  for (const ch of (changes || [])) {
    if (ch.type === "term_correction" || ch.type === "spelling") {
      let i = text.indexOf(ch.original);
      while (i !== -1) {
        pos.push({ s: i, e: i + ch.original.length, type: ch.type, orig: ch.original, corr: ch.corrected, subtype: ch.subtype });
        i = text.indexOf(ch.original, i + 1);
      }
    }
    if (ch.type === "filler_removal") {
      // 방법 1: original 전체 구간을 원문에서 찾기 (모델이 긴 문장을 반환하는 경우)
      if (ch.original && ch.corrected !== undefined) {
        const idx = text.indexOf(ch.original);
        if (idx !== -1) {
          // original과 corrected가 동일하면 실제로 변경된 게 없음 → 스킵
          if (ch.original.trim() === (ch.corrected || "").trim()) continue;
          pos.push({
            s: idx, e: idx + ch.original.length,
            type: "filler_removal", orig: ch.original, corr: ch.corrected,
            fillers: ch.removed_fillers || [],
          });
          continue; // 이 change는 처리 완료
        }
      }
      // 방법 2: fallback — 개별 필러 단어를 regex로 찾기
      // ⚠️ original이 있고 corrected도 있는데 방법1에서 못 찾은 경우만 fallback
      // original과 corrected가 동일하면 (모델이 변경하지 않은 경우) 스킵
      if (ch.original && ch.corrected !== undefined && ch.original.trim() === (ch.corrected || "").trim()) continue;
      const fillers = ch.removed_fillers || [ch.original];
      for (const f of fillers) {
        if (!f) continue;
        const re = new RegExp(`(?<=[\\s가-힣a-zA-Z])${f.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=[\\s가-힣a-zA-Z])`, "g");
        let m; while ((m = re.exec(text)) !== null) {
          pos.push({ s: m.index, e: m.index + f.length, type: "filler_removal", orig: f, corr: "" });
        }
      }
    }
  }
  pos.sort((a, b) => a.s - b.s);
  // 겹치는 구간 제거 (먼저 등장하는 것 우선)
  const d = []; for (const p of pos) { if (!d.length || p.s >= d[d.length - 1].e) d.push(p); }
  return d;
}

export function toSegs(text, pos, side) {
  if (!pos.length) return [{ text, tp: "n" }];
  const s = []; let c = 0;
  for (const p of pos) {
    if (p.s > c) s.push({ text: text.substring(c, p.s), tp: "n" });

    if (p.type === "filler_removal") {
      if (side === "left") {
        // 좌측: original 구간 안에서 필러 단어만 취소선, 나머지는 일반 텍스트
        const origText = text.substring(p.s, p.e);
        const fillers = p.fillers && p.fillers.length > 0 ? p.fillers : [];
        if (fillers.length > 0) {
          // 필러 단어의 위치를 순차적으로 찾기
          const fpos = [];
          let searchFrom = 0;
          for (const f of fillers) {
            let fi = origText.indexOf(f, searchFrom);
            if (fi === -1) fi = origText.indexOf(f); // fallback: 처음부터 다시
            if (fi !== -1) {
              fpos.push({ s: fi, e: fi + f.length });
              searchFrom = fi + f.length;
            }
          }
          fpos.sort((a, b) => a.s - b.s);
          // 겹침 제거
          const clean = []; for (const fp of fpos) { if (!clean.length || fp.s >= clean[clean.length-1].e) clean.push(fp); }
          // 세그먼트 생성
          let ic = 0;
          for (const fp of clean) {
            if (fp.s > ic) s.push({ text: origText.substring(ic, fp.s), tp: "n" });
            s.push({ text: origText.substring(fp.s, fp.e), tp: "filler_removal" });
            ic = fp.e;
          }
          if (ic < origText.length) s.push({ text: origText.substring(ic), tp: "n" });
        } else {
          // fillers 배열이 없으면 전체를 취소선
          s.push({ text: origText, tp: "filler_removal" });
        }
      } else {
        // 우측: corrected 텍스트로 대체 (필러 제거된 버전)
        if (p.corr) {
          s.push({ text: p.corr, tp: "filler_applied" });
        }
      }
      c = p.e;
    } else {
      if (side === "left") {
        s.push({ text: text.substring(p.s, p.e), tp: p.type, corr: p.corr, subtype: p.subtype });
      } else {
        s.push({ text: p.corr || text.substring(p.s, p.e), tp: p.type + "_applied", corr: p.corr, subtype: p.subtype });
      }
      c = p.e;
    }
  }
  if (c < text.length) s.push({ text: text.substring(c), tp: "n" });
  return s;
}

// ═══════════════════════════════════════════════
// CORRECTED TEXT BUILDER — AI 교정 반영 텍스트 생성
// ═══════════════════════════════════════════════

export function getCorrectedText(blockText, changes) {
  if (!changes || changes.length === 0) return blockText;
  const pos = findPositions(blockText, changes);
  if (pos.length === 0) return blockText;
  let result = "";
  let cursor = 0;
  for (const p of pos) {
    if (p.s > cursor) result += blockText.substring(cursor, p.s);
    if (p.type === "filler_removal") {
      // 필러 제거: corrected가 있으면 대체, 없으면 삭제
      result += (p.corr || "");
    } else {
      // 용어/맞춤법 교정: corrected로 대체
      result += (p.corr || blockText.substring(p.s, p.e));
    }
    cursor = p.e;
  }
  if (cursor < blockText.length) result += blockText.substring(cursor);
  return result;
}
