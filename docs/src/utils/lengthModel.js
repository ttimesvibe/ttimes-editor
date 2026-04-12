// ═══════════════════════════════════════════════
// LINEAR REGRESSION MODEL (v2)
// 영상길이(분) = SLOPE × cleanText글자수 + INTERCEPT
// 7건 학습, LOO MAE 3.9%, R²=0.949
// ═══════════════════════════════════════════════

export const TRAINING_DATA = [
  { name: "김창현1편", chars: 12255, minutes: 21 + 20/60 },
  { name: "김창현2편", chars: 15684, minutes: 27 + 30/60 },
  { name: "박종천1편", chars: 16500, minutes: 25 + 50/60 },
  { name: "강정수1편", chars: 15274, minutes: 25 + 45/60 },
  { name: "박종천3편", chars: 19288, minutes: 30 + 46/60 },
  { name: "허진호1편", chars: 21509, minutes: 32 + 11/60 },
  { name: "이세돌2편", chars: 20765, minutes: 32 + 48/60 },
];

const SLOPE = 0.001210;
const INTERCEPT = 7.05;
const LOO_RESIDUAL_STD = 1.19;

export function calcRegression(cleanChars) {
  const pointMin = SLOPE * cleanChars + INTERCEPT;
  const ci95 = 1.96 * LOO_RESIDUAL_STD;
  return {
    pointSec: pointMin * 60,
    lowSec: (pointMin - ci95) * 60,
    highSec: (pointMin + ci95) * 60,
    pointMin,
    ci95,
    count: TRAINING_DATA.length,
  };
}

// 타임스탬프 문자열 → 초 변환
export function tsToSeconds(ts) {
  if (!ts) return 0;
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

// 초 → "MM:SS" 또는 "HH:MM:SS" 변환
export function secondsToDisplay(sec) {
  sec = Math.round(sec);
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// 블록 분량 계산 (타임스탬프 기반)
export function calcDuration(blocks, deletedBlockIndices = new Set()) {
  let totalSeconds = 0;
  let deletedSeconds = 0;
  let keptSeconds = 0;
  let keptChars = 0;
  let totalChars = 0;
  let deletedChars = 0;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const nextB = blocks[i + 1];
    const startSec = tsToSeconds(b.timestamp);
    const endSec = nextB ? tsToSeconds(nextB.timestamp) : (startSec + 10);
    const duration = Math.max(0, endSec - startSec);
    const isDeleted = deletedBlockIndices.has(i);

    totalSeconds += duration;
    totalChars += b.text.length;
    if (isDeleted) {
      deletedSeconds += duration;
      deletedChars += b.text.length;
    } else {
      keptSeconds += duration;
      keptChars += b.text.length;
    }
  }

  return {
    totalSeconds, deletedSeconds, keptSeconds,
    totalChars, deletedChars, keptChars,
  };
}


export function parseBlocks(text) {
  const lines = text.split("\n"), blocks = [];
  let cur = null;
  // 패턴 1: "화자 MM:SS" (줄 전체가 화자+타임스탬프만 — 다음 줄이 본문)
  const hdr = /^(.+?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
  // 패턴 2: "화자 MM:SS 본문내용" (인라인, 한글/영문 화자명)
  const hdrInline = /^([가-힣a-zA-Z\s]{2,15}?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(.+)$/;
  // 패턴 3: "참석자 N MM:SS본문" — "참석자/화자/Speaker + 숫자" 전용
  const hdrNumbered = /^((?:참석자|화자|Speaker)\s*\d+)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/;
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (cur) { blocks.push(cur); cur = null; } continue; }
    // 패턴 3 먼저 시도 (참석자 N 전용 — 가장 구체적)
    const m3 = t.match(hdrNumbered);
    if (m3) {
      if (cur) blocks.push(cur);
      const bodyText = (m3[3] || "").trim();
      cur = { index: blocks.length, speaker: m3[1].trim(), timestamp: m3[2], text: bodyText, lines: bodyText ? [bodyText] : [] };
      continue;
    }
    const m = t.match(hdr);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { index: blocks.length, speaker: m[1], timestamp: m[2], text: "", lines: [] };
    } else {
      const m2 = t.match(hdrInline);
      if (m2) {
        if (cur) blocks.push(cur);
        const bodyText = m2[3].trim();
        cur = { index: blocks.length, speaker: m2[1].trim(), timestamp: m2[2], text: bodyText, lines: [bodyText] };
      } else if (cur) {
        cur.text += (cur.text ? "\n" : "") + t; cur.lines.push(t);
      } else {
        cur = { index: blocks.length, speaker: "—", timestamp: "", text: t, lines: [t] };
      }
    }
  }
  if (cur) blocks.push(cur);
  return blocks.map((b, i) => ({ ...b, index: i }));
}

export function splitChunks(blocks, max = 15000) {
  const ch = []; let c = [], l = 0;
  for (const b of blocks) {
    if (l + b.text.length > max && c.length > 0) {
      ch.push(c);
      const ov = c.slice(-2).map(x => ({ ...x, isContext: true }));
      c = [...ov]; l = ov.reduce((s, x) => s + x.text.length, 0);
    }
    c.push(b); l += b.text.length;
  }
  if (c.length > 0) ch.push(c);
  return ch;
}

export function chunkToText(chunk) {
  return chunk.filter(b => !b.isContext).map(b => `[블록 ${b.index}] ${b.speaker} ${b.timestamp}\n${b.text}`).join("\n\n");
}
export function chunkCtx(chunk) {
  const ctx = chunk.filter(b => b.isContext);
  return ctx.length ? ctx.map(b => `${b.speaker} ${b.timestamp}\n${b.text}`).join("\n\n") : undefined;
}
