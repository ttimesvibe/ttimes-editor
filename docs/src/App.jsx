import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import * as mammoth from "mammoth";
import JSZip from "jszip";

// ═══════════════════════════════════════════════
// CONFIG & PERSISTENCE
// ═══════════════════════════════════════════════

const DEFAULT_CONFIG = {
  apiMode: "live",
  workerUrl: "https://ttimes-edit.ttimes.workers.dev",
  fillers: ["이제","또","좀","뭐","그냥","약간","진짜","되게","막","이렇게","저렇게"],
  customTerms: {},
  chunkSize: 8000,
};

function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem("te_cfg") || "{}") }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(c) { localStorage.setItem("te_cfg", JSON.stringify(c)); }

// ═══════════════════════════════════════════════
// TERM DICTIONARY — 팀 공유 단어장 (Worker KV + localStorage 캐시)
// ═══════════════════════════════════════════════

function loadDictionary() {
  try { return JSON.parse(localStorage.getItem("te_dict") || "[]"); }
  catch { return []; }
}

function saveDictionary(terms) {
  localStorage.setItem("te_dict", JSON.stringify(terms));
}

// Worker에서 팀 공유 단어장 불러오기 → localStorage 캐시 갱신
async function syncDictionaryFromServer(config) {
  if (config.apiMode === "mock" || !config.workerUrl) return loadDictionary();
  try {
    const r = await fetch(`${config.workerUrl}/dict`);
    const d = await r.json();
    if (d.success && Array.isArray(d.dict)) {
      // 오염된 항목 자동 정리: 문장 조각이 아닌 진짜 용어만 유지
      const JOSA_ENDINGS = /(?:을|를|이|가|은|는|에서|으로|에게|하고|되는|하는|있는|없는|같은|되는|보는|갖다가|뽑아|했을|라는|인데|인가|이런|저런)$/;
      const cleaned = d.dict.filter(word => {
        if (typeof word !== "string") return false;
        const w = word.trim();
        if (!w) return false;
        const spaceCount = (w.match(/\s/g) || []).length;
        // 공백 2개 이상이면 문장 조각 → 제거
        if (spaceCount >= 2) return false;
        // 10자 초과 + 공백 포함이면 문장 조각 가능성 높음 → 제거
        if (w.length > 10 && spaceCount >= 1) return false;
        // 조사/어미로 끝나면 문장 조각 → 제거
        if (JOSA_ENDINGS.test(w)) return false;
        return true;
      });
      if (cleaned.length < d.dict.length) {
        console.log(`📚 단어장 자동 정리: ${d.dict.length}건 → ${cleaned.length}건 (${d.dict.length - cleaned.length}건 제거)`);
        saveDictionary(cleaned);
        // 서버에도 정리된 버전 저장
        await saveDictionaryToServer(cleaned, config);
        return cleaned;
      }
      saveDictionary(d.dict);
      return d.dict;
    }
  } catch (e) { console.warn("단어장 서버 동기화 실패:", e.message); }
  return loadDictionary();
}

// Worker에 팀 공유 단어장 저장 + localStorage 캐시 갱신
async function saveDictionaryToServer(terms, config) {
  saveDictionary(terms); // 로컬 캐시 즉시 반영
  if (config.apiMode === "mock" || !config.workerUrl) return;
  try {
    await fetch(`${config.workerUrl}/dict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dict: terms }),
    });
  } catch (e) { console.warn("단어장 서버 저장 실패:", e.message); }
}

// Step 0 결과에서 correct 값을 추출하여 기존 단어장과 병합 (중복 제거)
function mergeDictionary(existingDict, newTerms) {
  const merged = [...existingDict];
  const existingSet = new Set(existingDict.map(t => typeof t === "string" ? t : t.correct || t.wrong));
  for (const t of newTerms) {
    const word = t.correct || t.wrong;
    if (word && !existingSet.has(word)) {
      merged.push(word);
      existingSet.add(word);
    }
  }
  // 기존 {wrong, correct} 형태가 섞여 있으면 정답만 추출하여 문자열 배열로 정리
  return merged.map(t => typeof t === "string" ? t : t.correct || t.wrong).filter(Boolean);
}

// 확정된 용어의 correct 값을 단어장에 저장 + 서버 동기화
// ⚠️ 단어장은 "용어"만 저장 — 긴 문장/구절은 제외 (10자 초과 or 공백 2개 이상)
async function updateDictionary(approvedTerms, config) {
  const dict = loadDictionary();
  const normalized = dict.map(t => typeof t === "string" ? t : t.correct || t.wrong).filter(Boolean);
  const existingSet = new Set(normalized);
  let added = 0;
  for (const t of approvedTerms) {
    const word = t.correct || (typeof t === "string" ? t : null);
    if (!word) continue;
    // 문장 조각은 단어장에 추가하지 않음
    const spaceCount = (word.match(/\s/g) || []).length;
    const JOSA_RE = /(?:을|를|이|가|은|는|에서|으로|에게|하고|되는|하는|있는|없는|같은|보는|갖다가|라는|인데)$/;
    if (spaceCount >= 2 || (word.length > 10 && spaceCount >= 1) || JOSA_RE.test(word)) {
      console.log(`📚 단어장 제외 (문장 조각): "${word.substring(0, 30)}"`);
      continue;
    }
    if (!existingSet.has(word)) {
      normalized.push(word);
      existingSet.add(word);
      added++;
    }
  }
  if (added > 0) await saveDictionaryToServer(normalized, config);
  return added;
}

// ═══════════════════════════════════════════════
// API CLIENT — Mock ↔ Live switchable
// ═══════════════════════════════════════════════

async function apiCall(endpoint, body, config, retries = 4) {
  if (config.apiMode === "mock") return null;
  const url = `${config.workerUrl}/${endpoint}`;

  for (let i = 0; i < retries; i++) {
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      // 네트워크 에러 또는 CORS 차단
      if (i < retries - 1) {
        const waitTime = (i + 1) * 15000;
        console.warn(`🌐 네트워크 에러 (${endpoint}): ${netErr.message}. ${waitTime/1000}초 후 재시도 (${i+1}/${retries})`);
        await delay(waitTime);
        continue;
      }
      throw new Error(`네트워크 연결 실패 (${endpoint}). Worker 서버 상태를 확인해주세요.\n원인: ${netErr.message}`);
    }

    let d;
    try {
      d = await r.json();
    } catch (parseErr) {
      // Worker가 HTML 에러 페이지 등 non-JSON을 반환한 경우
      const text = await r.text().catch(() => "");
      if (i < retries - 1) {
        const waitTime = (i + 1) * 15000;
        console.warn(`⚠️ Worker 비정상 응답 (${endpoint}): status=${r.status}. ${waitTime/1000}초 후 재시도 (${i+1}/${retries})`);
        await delay(waitTime);
        continue;
      }
      throw new Error(`Worker 서버 오류 (${endpoint}, HTTP ${r.status}). 입력이 너무 크거나 Worker 타임아웃일 수 있습니다.`);
    }

    if (d.success) return d;

    if (r.status === 429 || d.status === 429 || (d.error && d.error.includes("Rate limited"))) {
      const waitTime = (i + 1) * 15000;
      console.warn(`⏳ API 한도 초과! ${waitTime/1000}초 후 자동으로 재시도합니다... (${i+1}/${retries})`);
      await delay(waitTime);
      continue;
    }

    throw new Error(d.error || `${endpoint} failed`);
  }
  
  throw new Error("API 요청 한도 초과로 여러 번 재시도했지만 실패했습니다. 잠시 후 다시 시도해주세요.");
}

// 세션 저장/불러오기도 같은 Worker를 사용
function getWorkerBase(config) {
  return config.workerUrl || "";
}

async function apiSaveSession(sessionData, config) {
  const base = getWorkerBase(config);
  if (!base) throw new Error("Worker URL이 설정되지 않았습니다.");
  const r = await fetch(`${base}/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionData),
  });
  const d = await r.json();
  if (!d.success) throw new Error(d.error || "저장 실패");
  return d.id;
}

async function apiLoadSession(id, config) {
  const base = getWorkerBase(config);
  if (!base) throw new Error("Worker URL이 설정되지 않았습니다.");
  const r = await fetch(`${base}/load/${id}`);
  if (!r.ok) { const d = await r.json(); throw new Error(d.error || "불러오기 실패"); }
  return r.json();
}

// Step 0
async function apiAnalyze(fullText, cfg, dictionaryWords) {
  if (cfg.apiMode === "mock") {
    await delay(700);
    return {
      overview: { topic: "인터뷰 주제 (Mock 분석)", keywords: ["프롬프트","클로드","앤트로픽"] },
      speakers: [], domain_terms: [],
      term_corrections: [
        {wrong:"엔트로피",correct:"앤트로픽",confidence:"high"},
        {wrong:"엠트로픽",correct:"앤트로픽",confidence:"high"},
        {wrong:"프롬보트",correct:"프롬프트",confidence:"high"},
        {wrong:"프롬포트",correct:"프롬프트",confidence:"high"},
        {wrong:"오프스",correct:"오퍼스",confidence:"high"},
        {wrong:"클로즈 스케일",correct:"클로드 스킬",confidence:"high"},
        {wrong:"프럼 엔지니어",correct:"프롬프트 엔지니어",confidence:"high"},
        {wrong:"컨텍트",correct:"컨텍스트",confidence:"high"},
      ],
      genre: { primary: "설명형", secondary: null, transitions: [] },
      tech_difficulty: "보통",
      audience_level: "관심 있는 비전문가",
    };
  }
  const payload = { full_text: fullText };
  if (dictionaryWords?.length > 0) payload.dictionary_words = dictionaryWords;
  const d = await apiCall("analyze", payload, cfg);
  return d.analysis;
}

// 1차 chunk
async function apiCorrect(chunkText, idx, total, analysis, context, cfg) {
  if (cfg.apiMode === "mock") {
    await delay(300 + Math.random() * 400);
    return mockCorrectChunk(chunkText, analysis, cfg);
  }
  
  const d = await apiCall("correct", {
    chunk_text: chunkText, chunk_index: idx, total_chunks: total,
    context_blocks: context, analysis, custom_fillers: cfg.fillers, custom_terms: cfg.customTerms,
  }, cfg);
  
  return d.result;
}

// 2단계 — Draft Agent (청크 단위 호출 지원)
async function apiHighlightsDraft(blocks, analysis, cfg, chunk_index, total_chunks) {
  if (cfg.apiMode === "mock") {
    await delay(800);
    const hl = [];
    blocks.filter(b => b.text.length > 80).forEach((b, i) => {
      if (i % 3 === 0) hl.push({
        block_index: b.index, speaker: b.speaker,
        source_text: b.text.substring(0, 50) + "...",
        subtitle: b.text.replace(/\s+/g," ").substring(0, 35) + "…",
        type: ["A1","B1","B2","C1","D1","E1"][i % 6],
        type_name: ["핵심 논지 압축","등호 정의형","용어 설명형","질문 프레이밍형","비교 평가형","기능 헤드라인"][i % 6],
        reason: "핵심 구간 (Draft)",
        placement_hint: null, sequence_id: null,
      });
    });
    return { highlights: hl.slice(0, 40) };
  }
  const body = { mode: "draft", blocks, analysis };
  if (chunk_index !== undefined) { body.chunk_index = chunk_index; body.total_chunks = total_chunks; }
  const d = await apiCall("highlights", body, cfg);
  return d.result;
}

// 2단계 — Editor Agent (청크 단위 호출 지원)
async function apiHighlightsEdit(blocks, analysis, draftHighlights, cfg, chunk_index, total_chunks) {
  if (cfg.apiMode === "mock") {
    await delay(600);
    const kept = draftHighlights.filter((_, i) => i % 3 !== 2);
    const removed = draftHighlights.filter((_, i) => i % 3 === 2).map(h => ({
      block_index: h.block_index, reason: "밀도 조정으로 제거 (Mock)"
    }));
    return {
      highlights: kept,
      removed,
      stats: {
        draft_count: draftHighlights.length,
        final_count: kept.length,
        removal_rate: `${Math.round((1 - kept.length / draftHighlights.length) * 100)}%`,
      },
    };
  }
  const body = { mode: "edit", blocks, analysis, draft_highlights: draftHighlights };
  if (chunk_index !== undefined) { body.chunk_index = chunk_index; body.total_chunks = total_chunks; }
  const d = await apiCall("highlights", body, cfg);
  return d.result;
}

function mockCorrectChunk(chunkText, analysis, cfg) {
  const chunks = [];
  const blockRe = /\[블록 (\d+)\]/g;
  const matches = [...chunkText.matchAll(blockRe)];
  const terms = analysis?.term_corrections || [];
  matches.forEach((m, mi) => {
    const bIdx = parseInt(m[1]);
    const start = m.index;
    const end = mi < matches.length - 1 ? matches[mi + 1].index : chunkText.length;
    const bText = chunkText.substring(start, end);
    const changes = [];
    cfg.fillers.forEach(f => {
      const re = new RegExp(`(?<=[가-힣a-zA-Z]\\s)${f}(?=\\s[가-힣a-zA-Z])`, "g");
      let fm; while ((fm = re.exec(bText)) !== null) {
        if (f === "이제" && bText.substring(fm.index, fm.index + 4).includes("이제는")) continue;
        changes.push({ type: "filler_removal", original: f, corrected: "", removed_fillers: [f] });
      }
    });
    terms.forEach(tc => {
      if (tc.confidence === "low") return;
      if (bText.includes(tc.wrong)) changes.push({ type: "term_correction", original: tc.wrong, corrected: tc.correct, reason: "STT 교정" });
    });
    if (changes.length > 0) chunks.push({ block_index: bIdx, changes });
  });
  return { chunks };
}

// ═══════════════════════════════════════════════
// 0차 단계: DOCX 삭제선(w:del) 파싱 + 분량 계산
// ═══════════════════════════════════════════════

// Word "검토 모드" 변경 추적 — 삭제된 텍스트(w:del)를 마커로 표시하여 추출
async function parseDocxWithTrackChanges(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("word/document.xml을 찾을 수 없습니다");

  // XML에서 본문(w:body) 추출
  const bodyMatch = docXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) throw new Error("문서 본문을 찾을 수 없습니다");
  const bodyXml = bodyMatch[1];

  // 단락(w:p) 단위로 처리
  const paragraphs = [];
  const pRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyXml)) !== null) {
    const pXml = pMatch[0];
    const segments = []; // {text, deleted}

    // w:del (삭제된 텍스트) 과 w:ins (삽입된 텍스트) 와 일반 w:r을 순서대로 파싱
    // 정규식으로 순차 토큰 추출
    const tokenRegex = /<w:del\b[^>]*>([\s\S]*?)<\/w:del>|<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>|<w:r[ >]([\s\S]*?)<\/w:r>/g;
    let tMatch;
    while ((tMatch = tokenRegex.exec(pXml)) !== null) {
      if (tMatch[1] !== undefined) {
        // w:del — 삭제된 텍스트
        const delText = extractTextFromRuns(tMatch[1]);
        if (delText) segments.push({ text: delText, deleted: true });
      } else if (tMatch[2] !== undefined) {
        // w:ins — 삽입된 텍스트
        const insText = extractTextFromRuns(tMatch[2]);
        if (insText) segments.push({ text: insText, deleted: false });
      } else if (tMatch[3] !== undefined) {
        // 일반 w:r — w:strike(일반 취소선)도 삭제 처리
        const runContent = tMatch[3];
        const runText = extractTextFromRun(runContent);
        const isStrike = /<w:strike\/>/.test(runContent);
        if (runText) segments.push({ text: runText, deleted: isStrike });
      }
    }

    if (segments.length > 0) {
      paragraphs.push(segments);
    }
  }

  // 삭제선 존재 여부 체크
  const hasTrackChanges = paragraphs.some(p => p.some(s => s.deleted));

  // 전체 텍스트 (삭제선 포함) — 마커 형식으로 변환
  // 삭제선 없는 순수 텍스트 (기존 mammoth 동작과 동일)
  const fullText = paragraphs.map(p => p.map(s => s.text).join("")).join("\n");
  const cleanText = paragraphs.map(p => p.filter(s => !s.deleted).map(s => s.text).join("")).join("\n");

  return { paragraphs, hasTrackChanges, fullText, cleanText };
}

// w:r 태그들에서 텍스트 추출
function extractTextFromRuns(xml) {
  const texts = [];
  const rRegex = /<w:r[ >][\s\S]*?<\/w:r>/g;
  let m;
  while ((m = rRegex.exec(xml)) !== null) {
    const t = extractTextFromRun(m[0]);
    if (t !== "") texts.push(t); // 빈 문자열 제외, "\n"은 포함
  }
  return texts.join("");
}

// 단일 w:r 내부의 w:t 또는 w:delText 텍스트 추출 + w:br 줄바꿈 처리
function extractTextFromRun(runXml) {
  const texts = [];
  const tokenRegex = /<w:(?:t|delText)[^>]*>([\s\S]*?)<\/w:(?:t|delText)>|<w:br\/>/g;
  let m;
  while ((m = tokenRegex.exec(runXml)) !== null) {
    if (m[1] !== undefined) {
      texts.push(m[1]);
    } else {
      texts.push("\n");
    }
  }
  return texts.join("");
}

// 학습 데이터: 과거 완성 영상의 최종 글자수 vs 실제 영상 길이
// 메모리에 저장된 6건 + 추가 데이터
// ═══════════════════════════════════════════
// LINEAR REGRESSION MODEL (v2)
// 영상길이(분) = SLOPE × cleanText글자수 + INTERCEPT
// 7건 학습, LOO MAE 3.9%, R²=0.949
// ═══════════════════════════════════════════

const TRAINING_DATA = [
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

function calcRegression(cleanChars) {
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
function tsToSeconds(ts) {
  if (!ts) return 0;
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

// 초 → "MM:SS" 또는 "HH:MM:SS" 변환
function secondsToDisplay(sec) {
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
function calcDuration(blocks, deletedBlockIndices = new Set()) {
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


function parseBlocks(text) {
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

function splitChunks(blocks, max = 15000) {
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

function chunkToText(chunk) {
  return chunk.filter(b => !b.isContext).map(b => `[블록 ${b.index}] ${b.speaker} ${b.timestamp}\n${b.text}`).join("\n\n");
}
function chunkCtx(chunk) {
  const ctx = chunk.filter(b => b.isContext);
  return ctx.length ? ctx.map(b => `${b.speaker} ${b.timestamp}\n${b.text}`).join("\n\n") : undefined;
}

// ═══════════════════════════════════════════════
// DIFF RENDERING
// ═══════════════════════════════════════════════

function findPositions(text, changes) {
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

function toSegs(text, pos, side) {
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

function getCorrectedText(blockText, changes) {
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

// ═══════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════

const DARK_THEME = {
  bg:"#0F1117",sf:"#181B25",bd:"#2A2E3B",
  tx:"#E4E6ED",txM:"#8B8FA3",txD:"#5C6078",
  ac:"#4A6CF7",acS:"rgba(74,108,247,0.12)",
  fBg:"rgba(251,191,36,0.18)",fTx:"#FBBF24",fSk:"#D4A017",
  tBg:"rgba(239,68,68,0.15)",tTx:"#EF4444",
  cBg:"rgba(34,197,94,0.15)",cTx:"#22C55E",
  sBg:"rgba(56,189,248,0.15)",sTx:"#38BDF8",scBg:"rgba(14,165,233,0.15)",scTx:"#0EA5E9",
  hBd:"#A855F7",hBg:"rgba(168,85,247,0.12)",
  vBd:"#3B82F6",vBg:"rgba(59,130,246,0.1)",
  ok:"#22C55E",wn:"#FBBF24",
  glass:"rgba(255,255,255,0.03)",glassHover:"rgba(255,255,255,0.06)",
  btnTx:"#fff",inputBg:"rgba(255,255,255,0.06)",
  linkTx:"#60A5FA",shadow:"rgba(0,0,0,0.4)",
};
const LIGHT_THEME = {
  bg:"#F8F9FB",sf:"#FFFFFF",bd:"#E2E4E9",
  tx:"#1A1D27",txM:"#5C6078",txD:"#8B8FA3",
  ac:"#4A6CF7",acS:"rgba(74,108,247,0.08)",
  fBg:"rgba(251,191,36,0.12)",fTx:"#B45309",fSk:"#92400E",
  tBg:"rgba(239,68,68,0.10)",tTx:"#DC2626",
  cBg:"rgba(34,197,94,0.10)",cTx:"#16A34A",
  sBg:"rgba(56,189,248,0.10)",sTx:"#0284C7",scBg:"rgba(14,165,233,0.10)",scTx:"#0369A1",
  hBd:"#9333EA",hBg:"rgba(168,85,247,0.08)",
  vBd:"#2563EB",vBg:"rgba(59,130,246,0.06)",
  ok:"#16A34A",wn:"#D97706",
  glass:"rgba(0,0,0,0.02)",glassHover:"rgba(0,0,0,0.04)",
  btnTx:"#fff",inputBg:"rgba(0,0,0,0.04)",
  linkTx:"#2563EB",shadow:"rgba(0,0,0,0.1)",
};

let _savedTheme = "dark";
try { _savedTheme = localStorage.getItem("td_theme") || "dark"; } catch {}
const C = { ...(_savedTheme === "light" ? LIGHT_THEME : DARK_THEME) };
function applyTheme(mode) {
  Object.assign(C, mode === "light" ? LIGHT_THEME : DARK_THEME);
  try { localStorage.setItem("td_theme", mode); } catch {}
}

const FN = "'Pretendard','Noto Sans KR',-apple-system,sans-serif";

// 형광펜 색상 (다크/라이트)
const MARKER_COLORS_DARK = {
  yellow: { bg: "rgba(251,191,36,0.3)", border: "#FBBF24", label: "노랑" },
  blue:   { bg: "rgba(59,130,246,0.3)", border: "#3B82F6", label: "파랑" },
  cyan:   { bg: "rgba(34,211,238,0.3)", border: "#22D3EE", label: "하늘" },
  red:    { bg: "rgba(239,68,68,0.3)",  border: "#EF4444", label: "빨강" },
  pink:   { bg: "rgba(236,72,153,0.3)", border: "#EC4899", label: "분홍" },
  green:  { bg: "rgba(34,197,94,0.3)",  border: "#22C55E", label: "초록", _hidden: true },
};
const MARKER_COLORS_LIGHT = {
  yellow: { bg: "rgba(251,191,36,0.22)", border: "#D97706", label: "노랑" },
  blue:   { bg: "rgba(59,130,246,0.22)", border: "#2563EB", label: "파랑" },
  cyan:   { bg: "rgba(34,211,238,0.22)", border: "#0891B2", label: "하늘" },
  red:    { bg: "rgba(239,68,68,0.22)",  border: "#DC2626", label: "빨강" },
  pink:   { bg: "rgba(236,72,153,0.22)", border: "#DB2777", label: "분홍" },
  green:  { bg: "rgba(34,197,94,0.22)",  border: "#16A34A", label: "초록", _hidden: true },
};
let MARKER_COLORS = _savedTheme === "light" ? MARKER_COLORS_LIGHT : MARKER_COLORS_DARK;

// ═══════════════════════════════════════════════
// SMALL COMPONENTS
// ═══════════════════════════════════════════════

function Badge({ name }) {
  const h = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const isLight = C.bg[1] > "E";
  return <span style={{ fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:4,
    background:`hsla(${h},55%,50%,${isLight?0.12:0.15})`,color:`hsl(${h},${isLight?"50%,38%":"55%,65%"})`,marginRight:5 }}>{name}</span>;
}

function Progress({ pct, label }) {
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
function MarkedText({ text, blockIdx, hlMarkers, matchingMode, onMarkerAdd }) {
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
function TypeBadge({ type, onChangeType }) {
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

function BlockView({ block, pos, side, active, onClick, bRef, showIndex }) {
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
function ReviewBlock({ block, paragraphSegments, strikeRanges, isDeleted, onClick, active, bRef }) {
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
function ScriptEditBlock({ block, correctedText, editedVal, isEdited, onSave, onRevert }) {
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
function CorrectionRightBlock({ block, pos, active, onClick, bRef, correctedText, editedVal, isEdited, onSave, onRevert }) {
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

function GuideCard({ item, active, onClick, blocks, verdict, onVerdict, editedText, onEdit, onRelocate, onChangeType, onDelete }) {
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

function ShareModal({ shareUrl, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",zIndex:200,
    display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.sf,borderRadius:16,padding:28,
      width:480,border:`1px solid ${C.bd}`}}>
      <div style={{fontSize:17,fontWeight:700,color:C.tx,marginBottom:6}}>🔗 공유 링크 생성 완료</div>
      <div style={{fontSize:13,color:C.txM,marginBottom:16}}>
        아래 링크를 편집자에게 전달하세요. 30일간 유효합니다.
      </div>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        <input readOnly value={shareUrl}
          style={{flex:1,padding:"9px 12px",borderRadius:8,border:`1px solid ${C.bd}`,
            background:"rgba(0,0,0,0.3)",color:C.tx,fontSize:12,fontFamily:"monospace",outline:"none"}}
          onFocus={e=>e.target.select()}/>
        <button onClick={copy} style={{padding:"9px 16px",borderRadius:8,border:"none",
          background:copied?C.ok:C.ac,color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer",
          minWidth:72,transition:"background 0.2s"}}>
          {copied?"✓ 복사됨":"복사"}
        </button>
      </div>
      <div style={{fontSize:12,color:C.txD,marginBottom:20}}>
        🔗 링크를 아는 사람은 열람 및 편집이 가능합니다.
      </div>
      <div style={{display:"flex",justifyContent:"flex-end"}}>
        <button onClick={onClose} style={{padding:"8px 20px",borderRadius:6,border:`1px solid ${C.bd}`,
          background:"transparent",color:C.txM,fontSize:13,cursor:"pointer"}}>닫기</button>
      </div>
    </div>
  </div>;
}

function SessionListModal({ config, onLoad, onClose }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    if (!config.workerUrl || config.apiMode === "mock") { setLoading(false); return; }
    fetch(`${config.workerUrl}/sessions`)
      .then(r => r.json())
      .then(d => { if (d.success) setSessions(d.sessions || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [config]);

  const handleDelete = async (id) => {
    if (!confirm("이 세션을 삭제할까요?")) return;
    setDeleting(id);
    try {
      await fetch(`${config.workerUrl}/sessions/delete`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch {}
    setDeleting(null);
  };

  const formatDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const mm = String(d.getMonth()+1).padStart(2,"0");
    const dd = String(d.getDate()).padStart(2,"0");
    const hh = String(d.getHours()).padStart(2,"0");
    const mi = String(d.getMinutes()).padStart(2,"0");
    return `${mm}/${dd} ${hh}:${mi}`;
  };

  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",zIndex:200,
    display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.sf,borderRadius:16,padding:28,
      width:560,maxHeight:"80vh",display:"flex",flexDirection:"column",border:`1px solid ${C.bd}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontSize:17,fontWeight:700,color:C.tx}}>📋 작업 히스토리</div>
        <button onClick={onClose} style={{background:"none",border:"none",color:C.txD,cursor:"pointer",fontSize:18}}>✕</button>
      </div>
      <div style={{fontSize:12,color:C.txD,marginBottom:12}}>
        KV에 저장된 세션 목록입니다. 클릭하면 해당 작업을 불러옵니다.
      </div>
      <div style={{flex:1,overflowY:"auto"}}>
        {loading && <div style={{padding:32,textAlign:"center",color:C.txM}}>불러오는 중...</div>}
        {!loading && sessions.length === 0 && <div style={{padding:32,textAlign:"center",color:C.txD}}>저장된 세션이 없습니다</div>}
        {sessions.map(s => (
          <div key={s.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",
            borderRadius:8,border:`1px solid ${C.bd}`,marginBottom:6,cursor:"pointer",
            background:"rgba(255,255,255,0.02)",transition:"background 0.12s"}}
            onMouseEnter={e=>e.currentTarget.style.background="rgba(74,108,247,0.08)"}
            onMouseLeave={e=>e.currentTarget.style.background="rgba(255,255,255,0.02)"}
            onClick={()=>onLoad(s.id)}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:14,fontWeight:600,color:C.tx,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {s.fn || "제목 없음"}
              </div>
              <div style={{fontSize:11,color:C.txD,marginTop:2,display:"flex",gap:8}}>
                <span>{formatDate(s.savedAt)}</span>
                <span>{s.blockCount || 0}블록</span>
                {s.hasGuide && <span style={{color:C.hBd}}>가이드 ✓</span>}
                <span style={{fontFamily:"monospace",color:C.txD}}>{s.id}</span>
              </div>
            </div>
            <button onClick={e=>{e.stopPropagation();handleDelete(s.id)}}
              disabled={deleting===s.id}
              style={{fontSize:11,padding:"4px 8px",borderRadius:4,border:`1px solid ${C.bd}`,
                background:"transparent",color:C.txD,cursor:"pointer",flexShrink:0}}>
              {deleting===s.id?"...":"삭제"}
            </button>
          </div>
        ))}
      </div>
    </div>
  </div>;
}

function SettingsModal({ config, onSave, onClose }) {
  const [m, setM] = useState(config.apiMode);
  const [u, setU] = useState(config.workerUrl);
  const [gk, setGk] = useState(""); // 더 이상 사용 안 함 — Worker에서 관리
  const [f, setF] = useState(config.fillers.join(", "));
  const [t, setT] = useState(Object.entries(config.customTerms).map(([k,v])=>`${k}=${v.join(",")}`).join("\n"));
  const [cs, setCs] = useState(config.chunkSize);
  // 단어장 state — 삭제/수정 즉시 반영
  const [dictList, setDictList] = useState(() => {
    const d = loadDictionary();
    return d.map(t => typeof t === "string" ? t : t.correct || t.wrong).filter(Boolean);
  });
  const [editIdx, setEditIdx] = useState(-1);
  const [editVal, setEditVal] = useState("");
  const [newDictWord, setNewDictWord] = useState("");
  const save = () => {
    const ct = {};
    t.split("\n").filter(Boolean).forEach(l => { const [c,w] = l.split("="); if(c&&w) ct[c.trim()] = w.split(",").map(s=>s.trim()); });
    onSave({...config, apiMode:m, workerUrl:u.replace(/\/+$/,""),
      fillers:f.split(",").map(s=>s.trim()).filter(Boolean), customTerms:ct, chunkSize:parseInt(cs)||15000});
  };
  const iS = {width:"100%",padding:"8px 10px",borderRadius:6,border:`1px solid ${C.bd}`,
    background:"rgba(0,0,0,0.3)",color:C.tx,fontSize:13,fontFamily:FN,outline:"none"};
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:100,
    display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.sf,borderRadius:16,padding:28,
      width:480,maxHeight:"80vh",overflowY:"auto",border:`1px solid ${C.bd}`}}>
      <div style={{fontSize:18,fontWeight:700,color:C.tx,marginBottom:20}}>⚙️ 설정</div>
      <div style={{marginBottom:16}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:6}}>API 모드</label>
        <div style={{display:"flex",gap:4}}>
          {[["mock","Mock (데모)"],["live","Live (GPT-5.1)"]].map(([v,l])=>
            <button key={v} onClick={()=>setM(v)} style={{flex:1,padding:8,borderRadius:6,
              border:`1px solid ${m===v?C.ac:C.bd}`,background:m===v?C.acS:"transparent",
              color:m===v?C.ac:C.txM,fontSize:13,fontWeight:600,cursor:"pointer"}}>{l}</button>)}
        </div>
      </div>
      {m==="live" && <div style={{marginBottom:16}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:6}}>Cloudflare Worker URL</label>
        <input value={u} onChange={e=>setU(e.target.value)} placeholder="https://ttimes-editor.xxx.workers.dev" style={iS}/>
        <div style={{fontSize:11,color:C.txD,marginTop:4}}>ttimes-editor Worker의 전체 URL</div>
      </div>}
      <div style={{marginBottom:16}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:6}}>필러 단어 (쉼표 구분)</label>
        <input value={f} onChange={e=>setF(e.target.value)} style={iS}/>
      </div>
      <div style={{marginBottom:16}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:6}}>
          용어 사전 (줄바꿈, 형식: 올바른표기=오인식1,오인식2)</label>
        <textarea value={t} onChange={e=>setT(e.target.value)} rows={4}
          placeholder={"앤트로픽=엔트로피,엠트로픽\n프롬프트=프롬보트,프롬포트"} style={{...iS,resize:"vertical"}}/>
      </div>
      <div style={{marginBottom:20}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:6}}>청크 크기 (자)</label>
        <input type="number" value={cs} onChange={e=>setCs(e.target.value)} style={{...iS,width:120}}/>
      </div>
      <div style={{marginBottom:20,padding:14,background:"rgba(0,0,0,0.2)",borderRadius:10,border:`1px solid ${C.bd}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <label style={{fontSize:12,color:C.txM,fontWeight:600}}>📚 팀 단어장 (정답 표기)</label>
          <span style={{fontSize:12,color:C.ac,fontWeight:600}}>{dictList.length}건</span>
        </div>
        <div style={{fontSize:11,color:C.txD,marginBottom:10}}>
          정답 표기만 등록하면, AI가 발음 유사·문맥 유추로 오인식을 자동 매칭합니다.
          <br/>클릭하여 수정, × 버튼으로 삭제할 수 있습니다.
        </div>
        {dictList.length > 0 && (
          <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:10,maxHeight:160,overflowY:"auto",
            padding:6,background:"rgba(0,0,0,0.15)",borderRadius:8}}>
            {dictList.map((word, i) => (
              editIdx === i ? (
                <input key={i} autoFocus value={editVal} onChange={e=>setEditVal(e.target.value)}
                  onBlur={()=>{
                    const v = editVal.trim();
                    if(v && v !== word) {
                      const nd = [...dictList]; nd[i] = v; setDictList(nd);
                      saveDictionaryToServer(nd, config);
                    }
                    setEditIdx(-1);
                  }}
                  onKeyDown={e=>{
                    if(e.key==="Enter") e.target.blur();
                    if(e.key==="Escape") { setEditIdx(-1); }
                  }}
                  style={{padding:"3px 8px",borderRadius:12,border:`1px solid ${C.ac}`,
                    background:"rgba(74,108,247,0.2)",color:C.tx,fontSize:12,fontFamily:FN,
                    outline:"none",minWidth:60,width:Math.max(60, editVal.length*10)}}/>
              ) : (
                <span key={i} style={{display:"inline-flex",alignItems:"center",gap:3,padding:"3px 8px",
                  borderRadius:12,background:"rgba(74,108,247,0.12)",color:C.ac,fontSize:12,fontWeight:500,
                  cursor:"pointer"}}
                  onClick={()=>{ setEditIdx(i); setEditVal(word); }}>
                  {word}
                  <button onClick={async(e)=>{
                    e.stopPropagation();
                    const nd = dictList.filter((_,j)=>j!==i);
                    setDictList(nd);
                    await saveDictionaryToServer(nd, config);
                  }} style={{background:"none",border:"none",color:C.txD,cursor:"pointer",fontSize:11,
                    padding:0,lineHeight:1,marginLeft:1}} title="삭제">×</button>
                </span>
              )
            ))}
          </div>
        )}
        <div style={{display:"flex",gap:6}}>
          <input value={newDictWord} onChange={e=>setNewDictWord(e.target.value)}
            placeholder="새 단어 추가 (Enter)" style={{...iS,flex:1,fontSize:12}}
            onKeyDown={async e=>{
              if(e.key==="Enter" && newDictWord.trim()){
                const w = newDictWord.trim();
                if(!dictList.includes(w)){
                  const nd = [...dictList, w]; setDictList(nd);
                  await saveDictionaryToServer(nd, config);
                }
                setNewDictWord("");
              }
            }}/>
          <button onClick={async()=>{
            if(!newDictWord.trim()) return;
            const w = newDictWord.trim();
            if(!dictList.includes(w)){
              const nd = [...dictList, w]; setDictList(nd);
              await saveDictionaryToServer(nd, config);
            }
            setNewDictWord("");
          }} style={{padding:"6px 14px",borderRadius:6,border:"none",background:C.ac,color:"#fff",
            fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>추가</button>
          <button onClick={async ()=>{
            if(confirm("단어장을 초기화하면 저장된 모든 교정 용어가 삭제됩니다.\n팀 전체 단어장이 초기화됩니다. 계속할까요?")) {
              setDictList([]);
              await saveDictionaryToServer([], config);
            }
          }} style={{padding:"6px 12px",borderRadius:6,border:"1px solid rgba(239,68,68,0.3)",
            background:"transparent",color:"#EF4444",fontSize:12,cursor:"pointer",whiteSpace:"nowrap"}}>초기화</button>
        </div>
      </div>
      <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
        <button onClick={onClose} style={{padding:"8px 20px",borderRadius:6,border:`1px solid ${C.bd}`,
          background:"transparent",color:C.txM,fontSize:13,cursor:"pointer"}}>취소</button>
        <button onClick={save} style={{padding:"8px 20px",borderRadius:6,border:"none",
          background:C.ac,color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer"}}>저장</button>
      </div>
    </div>
  </div>;
}

// ═══════════════════════════════════════════════
// TERM REVIEW SCREEN
// ═══════════════════════════════════════════════

function EditorialSummaryPanel({ summary, collapsed, onToggle }) {
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

function TermReviewScreen({ terms: initialTerms, analysis, onConfirm, onSkip }) {
  const [terms, setTerms] = useState(initialTerms);
  const [newWord, setNewWord] = useState("");
  // 단어장 state — 삭제/수정 즉시 반영
  const [dictWords, setDictWords] = useState(() => {
    const d = loadDictionary();
    return d.map(t => typeof t === "string" ? t : t.correct || t.wrong).filter(Boolean);
  });
  const [dictEditIdx, setDictEditIdx] = useState(-1);
  const [dictEditVal, setDictEditVal] = useState("");
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);

  const update = (i, field, val) =>
    setTerms(prev => prev.map((t, idx) => idx === i ? { ...t, [field]: val } : t));
  const remove = (i) =>
    setTerms(prev => prev.filter((_, idx) => idx !== i));
  const add = () =>
    setTerms(prev => [...prev, { wrong: "", correct: "", confidence: "high" }]);
  const confirm = () =>
    onConfirm(terms.filter(t => t.wrong.trim() && t.correct.trim()));

  const dictDelete = async (i) => {
    const nd = dictWords.filter((_,j)=>j!==i);
    setDictWords(nd);
    saveDictionary(nd);
    await saveDictionaryToServer(nd, {apiMode:"live",workerUrl:analysis?._workerUrl||""});
  };
  const dictEdit = async (i, newVal) => {
    const v = newVal.trim();
    if(v && v !== dictWords[i]) {
      const nd = [...dictWords]; nd[i] = v; setDictWords(nd);
      saveDictionary(nd);
      await saveDictionaryToServer(nd, {apiMode:"live",workerUrl:analysis?._workerUrl||""});
    }
    setDictEditIdx(-1);
  };
  const dictAdd = async (word) => {
    if(!word.trim() || dictWords.includes(word.trim())) return;
    const nd = [...dictWords, word.trim()];
    setDictWords(nd);
    saveDictionary(nd);
    await saveDictionaryToServer(nd, {apiMode:"live",workerUrl:analysis?._workerUrl||""});
  };

  const iS = { padding:"6px 10px", borderRadius:6, border:`1px solid ${C.bd}`,
    background:"rgba(0,0,0,0.3)", color:C.tx, fontSize:13, fontFamily:FN, outline:"none", width:"100%" };

  const confColor = (c) => c === "high" ? C.ok : C.wn;
  const confLabel = (c) => c === "high" ? "high" : "low";

  return <div style={{flex:1, overflowY:"auto", display:"flex", flexDirection:"column", alignItems:"center", padding:"32px 24px"}}>
    <div style={{width:"100%", maxWidth:640}}>
      <div style={{marginBottom:24}}>
        <div style={{display:"inline-flex",alignItems:"center",gap:6,padding:"4px 12px",borderRadius:12,
          background:"rgba(34,197,94,0.1)",border:"1px solid rgba(34,197,94,0.2)",fontSize:12,color:C.ok,marginBottom:12}}>
          ✅ 사전 분석 완료</div>
        <div style={{fontSize:20,fontWeight:700,color:C.tx,marginBottom:4}}>용어 교정 목록 검토</div>
        {analysis?.overview?.topic && <div style={{fontSize:13,color:C.txM}}>주제: {analysis.overview.topic}</div>}
        {analysis?.genre?.primary && <div style={{fontSize:12,color:C.txD,marginTop:2}}>
          장르: {analysis.genre.primary}{analysis.genre.secondary ? ` + ${analysis.genre.secondary}` : ""} · 난이도: {analysis.tech_difficulty || "—"}
        </div>}
        <div style={{fontSize:13,color:C.txD,marginTop:6}}>
          AI가 발견한 STT 오인식 후보입니다. 확인 후 교정을 시작하세요.
        </div>
      </div>

      {/* Step 0에서 발견된 오인식 매핑 테이블 (최상단) */}
      <div style={{background:C.sf,borderRadius:12,border:`1px solid ${C.bd}`,overflow:"hidden",marginBottom:16}}>
        <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.bd}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:12,fontWeight:700,color:C.txM}}>AI 발견 오인식 후보</span>
          <span style={{fontSize:11,color:C.txD}}>{terms.length}건</span>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"60px 1fr 24px 1fr 36px",gap:8,padding:"8px 14px",
          borderBottom:`1px solid ${C.bd}`,fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",letterSpacing:"0.06em"}}>
          <span>신뢰도</span><span>원문 (오인식)</span><span></span><span>교정값</span><span></span>
        </div>
        {terms.length === 0 && <div style={{padding:"24px",textAlign:"center",fontSize:13,color:C.txD}}>
          항목 없음 — AI가 신규 오인식 후보를 찾지 못했습니다.
        </div>}
        {terms.map((t, i) => (
          <div key={i} style={{display:"grid",gridTemplateColumns:"60px 1fr 24px 1fr 36px",gap:8,
            padding:"8px 14px",borderBottom:`1px solid ${C.bd}`,alignItems:"center"}}>
            <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,textAlign:"center",
              background:`${confColor(t.confidence)}22`,color:confColor(t.confidence)}}>
              {confLabel(t.confidence)}
            </span>
            <input value={t.wrong} onChange={e=>update(i,"wrong",e.target.value)} style={iS} placeholder="오인식 단어"/>
            <span style={{textAlign:"center",color:C.txD,fontSize:14}}>→</span>
            <input value={t.correct} onChange={e=>update(i,"correct",e.target.value)} style={iS} placeholder="올바른 표기"/>
            <button onClick={()=>remove(i)} style={{background:"none",border:"none",color:C.txD,cursor:"pointer",
              fontSize:16,padding:0,textAlign:"center"}} title="삭제">✕</button>
          </div>
        ))}
        <div style={{padding:"10px 14px"}}>
          <button onClick={add} style={{background:"none",border:`1px dashed ${C.bd}`,borderRadius:6,
            color:C.txM,fontSize:12,cursor:"pointer",padding:"6px 14px",width:"100%"}}>
            + 항목 추가
          </button>
        </div>
      </div>

      {/* 확인/건너뛰기 버튼 */}
      <div style={{display:"flex",justifyContent:"center",gap:12,marginBottom:20}}>
        <button onClick={onSkip} style={{padding:"9px 20px",borderRadius:8,border:`1px solid ${C.bd}`,
          background:"transparent",color:C.txM,fontSize:13,cursor:"pointer"}}>
          용어 교정 없이 진행
        </button>
        <button onClick={confirm} style={{padding:"9px 24px",borderRadius:8,border:"none",
          background:`linear-gradient(135deg,${C.ac},#7C3AED)`,color:"#fff",fontSize:13,fontWeight:700,
          cursor:"pointer",boxShadow:"0 4px 14px rgba(74,108,247,0.3)"}}>
          교정 확정 → 1차 교정 시작
        </button>
      </div>

      {/* 콘텐츠 요약 */}
      <EditorialSummaryPanel summary={analysis?.editorial_summary} collapsed={summaryCollapsed} onToggle={()=>setSummaryCollapsed(!summaryCollapsed)}/>

      {/* 팀 단어장 (정답 표기 목록) — 삭제/수정 가능 */}
      {dictWords.length > 0 && (
        <div style={{background:C.sf,borderRadius:12,border:`1px solid ${C.bd}`,padding:14,marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <span style={{fontSize:12,fontWeight:700,color:"#3B82F6"}}>📚 팀 단어장 ({dictWords.length}건)</span>
            <span style={{fontSize:11,color:C.txD}}>클릭=수정 · ×=삭제</span>
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {dictWords.map((word, i) => (
              dictEditIdx === i ? (
                <input key={i} autoFocus value={dictEditVal} onChange={e=>setDictEditVal(e.target.value)}
                  onBlur={()=>dictEdit(i, dictEditVal)}
                  onKeyDown={e=>{
                    if(e.key==="Enter") e.target.blur();
                    if(e.key==="Escape") setDictEditIdx(-1);
                  }}
                  style={{padding:"3px 8px",borderRadius:12,border:`1px solid #3B82F6`,
                    background:"rgba(59,130,246,0.2)",color:C.tx,fontSize:12,fontFamily:FN,
                    outline:"none",minWidth:60,width:Math.max(60, dictEditVal.length*10)}}/>
              ) : (
                <span key={i} style={{display:"inline-flex",alignItems:"center",gap:3,padding:"3px 10px",
                  borderRadius:12,background:"rgba(59,130,246,0.12)",color:"#3B82F6",fontSize:12,fontWeight:500,
                  cursor:"pointer"}}
                  onClick={()=>{ setDictEditIdx(i); setDictEditVal(word); }}>
                  {word}
                  <button onClick={(e)=>{e.stopPropagation(); dictDelete(i);}}
                    style={{background:"none",border:"none",color:C.txD,cursor:"pointer",fontSize:11,
                      padding:0,lineHeight:1,marginLeft:1}} title="삭제">×</button>
                </span>
              )
            ))}
          </div>
        </div>
      )}

      {/* 신규 단어 추가 (정답형) */}
      <div style={{background:C.sf,borderRadius:12,border:`1px solid ${C.bd}`,padding:14,marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:700,color:C.txM,marginBottom:8}}>+ 단어장에 정답 추가</div>
        <div style={{display:"flex",gap:6}}>
          <input value={newWord} onChange={e=>setNewWord(e.target.value)} placeholder="정답 표기 입력 (예: 오픈AI)"
            style={{...iS,flex:1}} onKeyDown={async e=>{
              if(e.key==="Enter" && newWord.trim()){
                await dictAdd(newWord);
                setNewWord("");
              }
            }}/>
          <button onClick={async()=>{
            if(!newWord.trim()) return;
            await dictAdd(newWord);
            setNewWord("");
          }} style={{padding:"6px 14px",borderRadius:6,border:"none",background:C.ac,color:"#fff",
            fontSize:12,fontWeight:600,cursor:"pointer"}}>추가</button>
        </div>
      </div>

    </div>
  </div>;
}

// ═══════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════

export default function App() {
  const [cfg, setCfg] = useState(loadConfig);
  const [theme, setTheme] = useState(_savedTheme);
  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      MARKER_COLORS = next === "light" ? MARKER_COLORS_LIGHT : MARKER_COLORS_DARK;
      return next;
    });
  }, []);
  const [blocks, setBlocks] = useState([]);
  const [diffs, setDiffs] = useState([]);
  const [hl, setHl] = useState([]);
  const [hlStats, setHlStats] = useState(null);
  const [hlVerdicts, setHlVerdicts] = useState({}); // { "blockIndex-subtitle": "use"|"recommend"|"discard"|null }
  const [hlEdits, setHlEdits] = useState({}); // { "blockIndex-subtitle": "수정된 텍스트" }
  const [scriptEdits, setScriptEdits] = useState({}); // { blockIndex: "수동 편집된 텍스트" } — 1.5단계
  const [subtitleCache, setSubtitleCache] = useState(null); // AI 자막 포맷팅 결과 캐시
  const [subtitleResult, setSubtitleResult] = useState(null); // 2패널 표시용 자막 결과
  const [reviewData, setReviewData] = useState(null); // 0차: { paragraphs, hasTrackChanges, deletedBlockIndices, duration }
  const [addingAt, setAddingAt] = useState(null); // 자막 추가 중인 block_index
  const [addForm, setAddForm] = useState({ subtitle: "", type: "A1" }); // 추가 폼 상태
  const [anal, setAnal] = useState(null);
  const [fn, setFn] = useState("");
  const [tab, setTab] = useState("correction");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState({p:0,l:""});
  const [gReady, setGReady] = useState(false);
  const [gBusy, setGBusy] = useState(false);
  const [partialBusy, setPartialBusy] = useState(false); // 부분 생성 로딩
  const [selPopup, setSelPopup] = useState(null); // { blockIdx, text, x, y }
  const [aBlock, setABlock] = useState(null);
  const [showSet, setShowSet] = useState(false);
  const [err, setErr] = useState(null);
  const [termReview, setTermReview] = useState(false);
  const [pendingTerms, setPendingTerms] = useState([]);
  const [shareUrl, setShareUrl] = useState(null);
  const [sessionId, setSessionId] = useState(null); // 공유된 세션 ID (업데이트용)
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState("");
  const [autoSaveStatus, setAutoSaveStatus] = useState(""); // "", "pending", "saving", "saved"
  const autoSaveTimer = useRef(null);
  const sessionIdRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [hlMarkers, setHlMarkers] = useState({}); // { "blockIdx-subtitle": { color: "yellow", ranges: [{s,e}] } }
  const [matchingMode, setMatchingMode] = useState(null); // { key: "blockIdx-subtitle", color: "yellow" } or null
  const [showSessions, setShowSessions] = useState(false); // 세션 목록 모달
  const [bookmark, setBookmark] = useState(null); // 책갈피 블록 인덱스

  const lRef = useRef(null), rRef = useRef(null), syncing = useRef(false), bEls = useRef({});

  // ── localStorage 자동저장 ──────────────────────────────
  useEffect(() => {
    if (blocks.length === 0) return;
    try {
      localStorage.setItem("te_session", JSON.stringify({ blocks, anal, diffs, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, scriptEdits, reviewData, fn, tab, gReady, bookmark }));
    } catch {}
  }, [blocks, anal, diffs, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, scriptEdits, reviewData, fn, tab, gReady, bookmark]);

  // ── 앱 마운트 시: URL 공유 파라미터 또는 localStorage 복원 ──
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get("s");
    if (sid) {
      setReadOnly(false);
      setSessionId(sid); // 업데이트용 ID 기억
      setBusy(true); setProg({p:30,l:"공유 세션 불러오는 중..."});
      apiLoadSession(sid, cfg)
        .then(data => {
          setBlocks(data.blocks || []);
          setAnal(data.anal || null);
          setDiffs(data.diffs || []);
          setHl(data.hl || []);
          setHlStats(data.hlStats || null);
          setHlVerdicts(data.hlVerdicts || {}); setHlEdits(data.hlEdits || {}); setHlMarkers(data.hlMarkers || {}); setScriptEdits(data.scriptEdits || {}); setReviewData(data.reviewData || null);
          setFn(data.fn || "");
          setGReady((data.hl?.length > 0));
          setTab(data.hl?.length > 0 ? "guide" : data.reviewData ? "review" : "correction");
          setProg({p:100,l:"✅ 공유 세션 로드 완료"});
        })
        .catch(e => setErr(e.message))
        .finally(() => setBusy(false));
    } else {
      try {
        const saved = localStorage.getItem("te_session");
        if (saved) {
          const s = JSON.parse(saved);
          if (s.blocks?.length > 0) {
            setBlocks(s.blocks); setAnal(s.anal || null);
            setDiffs(s.diffs || []); setHl(s.hl || []);
            setHlStats(s.hlStats || null); setHlVerdicts(s.hlVerdicts || {}); setHlEdits(s.hlEdits || {}); setHlMarkers(s.hlMarkers || {}); setScriptEdits(s.scriptEdits || {}); setReviewData(s.reviewData || null);
            setFn(s.fn || ""); setTab(s.tab || "correction"); setGReady(s.gReady || false);
            if (s.bookmark != null) setBookmark(s.bookmark);
          }
        }
      } catch {}
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // sync scroll — 1차 교정 탭에서만 연동 (편집 가이드는 독립 스크롤)
  const onScroll = useCallback(src => {
    if (tab !== "correction") return; // 편집 가이드 탭에서는 연동 안 함
    if (syncing.current) return; syncing.current = true;
    const a = src==="l"?lRef.current:rRef.current;
    const b = src==="l"?rRef.current:lRef.current;
    if (a&&b) { const r = a.scrollTop/(a.scrollHeight-a.clientHeight||1); b.scrollTop = r*(b.scrollHeight-b.clientHeight||1); }
    requestAnimationFrame(()=>{syncing.current=false});
  },[tab]);

  useEffect(()=>{
    const l=lRef.current, r=rRef.current; if(!l||!r) return;
    const oL=()=>onScroll("l"), oR=()=>onScroll("r");
    l.addEventListener("scroll",oL,{passive:true}); r.addEventListener("scroll",oR,{passive:true});
    return()=>{l.removeEventListener("scroll",oL);r.removeEventListener("scroll",oR)};
  },[onScroll,tab,blocks.length]);

  const scrollTo = useCallback(i => {
    setABlock(i);
    // 편집 가이드 탭에서는 g 키, 1차 교정 탭에서는 l/r 키
    const el = bEls.current[`g${i}`] || bEls.current[`l${i}`] || bEls.current[`r${i}`];
    if (el) {
      const container = el.closest('[data-scroll-container]');
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const offset = elRect.top - containerRect.top + container.scrollTop - containerRect.height / 3;
        container.scrollTo({ top: offset, behavior: 'smooth' });
      } else {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
    // 1차 교정 탭: 반대편 패널도 스크롤 (좌→우, 우→좌)
    const otherKey = bEls.current[`l${i}`] === el ? `r${i}` : `l${i}`;
    const otherEl = bEls.current[otherKey];
    if (otherEl && otherEl !== el) {
      const container = otherEl.closest('[data-scroll-container]');
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const elRect = otherEl.getBoundingClientRect();
        const offset = elRect.top - containerRect.top + container.scrollTop - containerRect.height / 3;
        container.scrollTo({ top: offset, behavior: 'smooth' });
      }
    }
    // 편집 가이드: 오른쪽 강조자막 패널도 해당 블록의 자막으로 스크롤
    if (rRef.current) {
      const hlEl = rRef.current.querySelector(`[data-hl-block="${i}"]`);
      if (hlEl) {
        const containerRect = rRef.current.getBoundingClientRect();
        const elRect = hlEl.getBoundingClientRect();
        const offset = elRect.top - containerRect.top + rRef.current.scrollTop - 60;
        rRef.current.scrollTo({ top: offset, behavior: 'smooth' });
      }
    }
  },[]);

  const saveCfg = useCallback(c=>{setCfg(c);saveConfig(c);setShowSet(false)},[]);

  // 저장 & 공유
  // ── 자동 KV 저장 (큰 작업 완료 시 호출) ──
  const autoSaveToKV = useCallback(async (overrideData = {}) => {
    if (cfg.apiMode === "mock") return;
    try {
      const payload = {
        blocks, anal, diffs, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, scriptEdits, reviewData, fn,
        ...overrideData, // 상태 업데이트 직후 호출 시 최신 데이터 전달용
      };
      if (sessionId) payload.id = sessionId;
      const id = await apiSaveSession(payload, cfg);
      setSessionId(id);
      window.history.replaceState({}, "", `${window.location.pathname}?s=${id}`);
      console.log(`💾 자동 저장 완료 (ID: ${id})`);
    } catch (e) {
      console.warn("자동 저장 실패:", e.message);
    }
  }, [blocks, anal, diffs, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, scriptEdits, reviewData, fn, cfg, sessionId]);

  // ── 3분 디바운스 자동 저장 (변경 감지 → 3분 후 /autosave 호출) ──
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  useEffect(() => {
    if (cfg.apiMode === "mock" || !cfg.workerUrl) return;
    if (!blocks || blocks.length === 0) return;
    const currentSnapshot = JSON.stringify({ blocks, anal, diffs, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, scriptEdits, reviewData, fn });
    if (currentSnapshot === lastSavedSnapshot) return;

    setAutoSaveStatus("pending");
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);

    autoSaveTimer.current = setTimeout(async () => {
      setAutoSaveStatus("saving");
      try {
        const session = { blocks, anal, diffs, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, scriptEdits, reviewData, fn, savedAt: new Date().toISOString() };
        const curId = sessionIdRef.current;
        const id = curId || (Date.now().toString(36) + Math.random().toString(36).substring(2, 8));
        const res = await fetch(`${cfg.workerUrl}/autosave`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, ...session }),
        });
        const data = await res.json();
        if (data.success) {
          if (!curId) {
            setSessionId(data.id);
            sessionIdRef.current = data.id;
            window.history.replaceState({}, "", `${window.location.pathname}?s=${data.id}`);
          }
          setLastSavedSnapshot(currentSnapshot);
          setAutoSaveStatus("saved");
          setTimeout(() => setAutoSaveStatus(""), 3000);
        } else { setAutoSaveStatus(""); }
      } catch (e) {
        console.warn("자동 저장 실패:", e.message);
        setAutoSaveStatus("");
      }
    }, 3 * 60 * 1000); // 3분

    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [blocks, anal, diffs, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, scriptEdits, reviewData, fn, lastSavedSnapshot, cfg]);

  const handleShare = useCallback(async () => {
    setSaving(true); setErr(null);
    try {
      const payload = { blocks, anal, diffs, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, scriptEdits, reviewData, fn };
      // sessionId가 있으면 같은 ID로 덮어쓰기 (업데이트)
      if (sessionId) payload.id = sessionId;
      const id = await apiSaveSession(payload, cfg);
      setSessionId(id); // 다음 업데이트를 위해 기억
      sessionIdRef.current = id;
      const url = `${window.location.origin}${window.location.pathname}?s=${id}`;
      setShareUrl(url);
      // URL에 세션 ID 반영 (브라우저 주소창)
      window.history.replaceState({}, "", `${window.location.pathname}?s=${id}`);
      // 공유 저장 후 자동 저장 불필요하게 트리거되지 않도록 스냅샷 갱신
      setLastSavedSnapshot(JSON.stringify({ blocks, anal, diffs, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, scriptEdits, reviewData, fn }));
      if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); setAutoSaveStatus(""); }
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }, [blocks, anal, diffs, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, scriptEdits, reviewData, fn, cfg, sessionId]);

  // 새 파일 시작
  const handleReset = useCallback(() => {
    localStorage.removeItem("te_session");
    if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null; }
    setAutoSaveStatus(""); setLastSavedSnapshot("");
    setBlocks([]); setAnal(null); setDiffs([]); setHl([]); setHlStats(null); setHlVerdicts({}); setHlEdits({}); setHlMarkers({}); setScriptEdits({}); setReviewData(null);
    setFn(""); setTab("correction"); setGReady(false); setBookmark(null);
    setTermReview(false); setReadOnly(false); setSessionId(null); sessionIdRef.current = null;
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  // Process file — analyze only, then pause for term review
  const handleFile = useCallback(async(text,name)=>{
    setFn(name); setBusy(true); setErr(null); setDiffs([]); setHl([]); setHlStats(null); setGReady(false);
    setTermReview(false); setTab("correction");
    try {
      setProg({p:5,l:"텍스트 파싱 중..."});
      const parsed = parseBlocks(text); setBlocks(parsed);
      setProg({p:20,l:"단어장 동기화 중..."});
      // 서버에서 팀 공유 단어장 불러오기 (정답형 문자열 배열) — analyze 전에 로드
      const dict = await syncDictionaryFromServer(cfg);
      const dictNormalized = dict.map(t => typeof t === "string" ? t : t.correct || t.wrong).filter(Boolean);
      setProg({p:40,l:"Step 0: 사전 분석 중..."});
      const ft = parsed.map(b=>`${b.speaker} ${b.timestamp}\n${b.text}`).join("\n\n");
      // 화자명 라인에서 고유 화자명 추출 (사람이 입력한 ground truth)
      const speakerNames = [...new Set(parsed.map(b => b.speaker).filter(s => s && s !== "—"))];
      const speakerHint = speakerNames.length > 0
        ? `\n\n[화자명 라인에서 추출한 정확한 화자명 목록: ${speakerNames.join(", ")}]\n이 이름들은 사람이 직접 입력한 것이므로 정답 기준입니다. 본문 속에서 이와 다르게 표기된 이름은 STT 오인식으로 판단하세요.\n`
        : "";
      const a = await apiAnalyze(speakerHint + ft, cfg, dictNormalized); setAnal(a);
      const newTerms = a.term_corrections || [];
      // Step 0 term_corrections 중 단어장에 이미 있는 항목 제외
      // 정규화 비교: 대소문자 무시 + wrong/correct 양쪽 모두 체크
      const dictLower = new Set(dictNormalized.map(w => w.toLowerCase()));
      const filteredTerms = newTerms.filter(t => {
        const correctLower = (t.correct || "").toLowerCase();
        const wrongLower = (t.wrong || "").toLowerCase();
        // correct 또는 wrong이 단어장에 있으면 이미 처리된 것 → 제외
        return !dictLower.has(correctLower) && !dictLower.has(wrongLower);
      });
      setPendingTerms(filteredTerms);
      setProg({p:100,l:`✅ 사전 분석 완료 (단어장 ${dictNormalized.length}건 + 신규 후보 ${filteredTerms.length}건)`});
      setTermReview(true);
    } catch(e) { setErr(e.message); setProg({p:0,l:""}); }
    finally { setBusy(false); }
  },[cfg]);

  // Run correction with user-approved terms (v4 통합 교정)
  const handleCorrectStart = useCallback(async(approvedTerms)=>{
    setTermReview(false);
    // 확정된 용어를 단어장에 자동 저장 (correct 값만)
    const added = await updateDictionary(approvedTerms, cfg);
    if (added > 0) console.log(`📚 단어장에 ${added}건 추가됨 (총 ${loadDictionary().length}건)`);
    // 단어장 정답 목록도 analysis에 포함 (Worker 프롬프트에서 사용)
    const dict = loadDictionary();
    const dictWords = dict.map(t => typeof t === "string" ? t : t.correct || t.wrong).filter(Boolean);
    const approvedAnal = { ...anal, term_corrections: approvedTerms, dictionary_words: dictWords };
    setAnal(approvedAnal);
    setBusy(true); setErr(null);
    try {
      // ── 통합 교정: 필러 + 용어 + 맞춤법 + 구어체 (단일 루프) ──
      const chs = splitChunks(blocks, cfg.chunkSize); const ad = [];
      for(let i=0;i<chs.length;i++){
        const pct = 5 + Math.round(i/chs.length * 90);
        setProg({p:pct, l:`1차 교정: 청크 ${i+1}/${chs.length} 교정 중...`});
        const res = await apiCorrect(chunkToText(chs[i]),i,chs.length,approvedAnal,chunkCtx(chs[i]),cfg);
        if(res.chunks) ad.push(...res.chunks);
        if(cfg.apiMode==="live"&&i<chs.length-1) await delay(1000);
      }

      setDiffs(ad); setProg({p:100,l:"✅ 1차 교정 완료"});
      // 자동 KV 저장 (1차 교정 완료)
      autoSaveToKV({ diffs: ad });
    } catch(e) { setErr(e.message); setProg({p:0,l:""}); }
    finally { setBusy(false); }
  },[anal, blocks, cfg, autoSaveToKV]);

  // ── 용어 설명 AI 생성 (Gemini 2.5 Flash — 프론트엔드 직접 호출) ──
  const handleTermGen = useCallback(async () => {
    const term = addForm.termInput?.trim();
    if (!term) return;
    if (cfg.apiMode === "mock") {
      setAddForm(f => ({...f, subtitle: `${term}(Term) : 이것은 Mock 용어 설명입니다.`}));
      return;
    }
    if (!cfg.workerUrl) {
      setErr("설정에서 Worker URL을 입력해주세요.");
      return;
    }
    setAddForm(f => ({...f, generating: true}));
    try {
      const block = blocks.find(b => b.index === addingAt);
      const context = block ? block.text.substring(0, 500) : "";

      const d = await apiCall("term-explain", { term, context }, cfg);
      if (d.result?.explanation) {
        setAddForm(f => ({...f, subtitle: d.result.explanation, generating: false}));
      } else {
        setAddForm(f => ({...f, generating: false}));
      }
    } catch (e) {
      setErr(e.message);
      setAddForm(f => ({...f, generating: false}));
    }
  }, [addForm.termInput, addingAt, blocks, cfg]);

  // ── 수동 자막 추가 ──
  const handleAddSubtitle = useCallback(() => {
    if (addingAt === null || !addForm.subtitle.trim()) return;
    const block = blocks.find(b => b.index === addingAt);
    const newItem = {
      block_index: addingAt,
      speaker: block?.speaker || "—",
      source_text: "",
      subtitle: addForm.subtitle.trim(),
      type: addForm.type,
      type_name: addForm.type === "B2" ? "용어 설명형" : addForm.type === "C1" ? "자료" : "수동 추가",
      reason: "편집자 수동 추가",
      placement_hint: null,
      sequence_id: null,
      _manual: true, // 수동 추가 표시
    };
    setHl(prev => [...prev, newItem]);
    // 자동으로 '사용' 판정
    setHlVerdicts(prev => ({...prev, [`${newItem.block_index}-${newItem.subtitle}`]: "use"}));
    setAddingAt(null);
    setAddForm({ subtitle: "", type: "A1" });
  }, [addingAt, addForm, blocks]);

  // Generate guide — 2-Pass: Draft → Editor (청크 분할 지원)
  const handleGuide = useCallback(async()=>{
    setGBusy(true); setErr(null); setTab("guide");
    try {
      // ── 청크 분할: 40,000자 기준, 오버랩 5블록 ──
      const HIGHLIGHT_CHUNK_SIZE = 40000;
      const OVERLAP_BLOCKS = 5;

      const hlChunks = [];
      let currentChunk = [];
      let currentLen = 0;
      for (const b of blocks) {
        if (currentLen + b.text.length > HIGHLIGHT_CHUNK_SIZE && currentChunk.length > 0) {
          hlChunks.push(currentChunk);
          // 오버랩: 마지막 5블록을 다음 청크에 포함 (맥락 연결)
          const overlap = currentChunk.slice(-OVERLAP_BLOCKS);
          currentChunk = [...overlap];
          currentLen = overlap.reduce((s, x) => s + x.text.length, 0);
        }
        currentChunk.push(b);
        currentLen += b.text.length;
      }
      if (currentChunk.length > 0) hlChunks.push(currentChunk);

      const totalChunks = hlChunks.length;
      const isSingleChunk = totalChunks === 1;

      // ── Pass 1: Draft Agent (청크별 순차 호출) ──
      let allDraftHighlights = [];
      for (let ci = 0; ci < totalChunks; ci++) {
        const chunkLabel = isSingleChunk ? "" : ` (청크 ${ci+1}/${totalChunks})`;
        const pct = 5 + Math.round((ci / totalChunks) * 35);
        setProg({p: pct, l: `Pass 1: 강조자막 후보 생성 중${chunkLabel} (Draft Agent)...`});

        const draftResult = await apiHighlightsDraft(
          hlChunks[ci], anal, cfg,
          isSingleChunk ? undefined : ci,
          isSingleChunk ? undefined : totalChunks
        );
        const chunkHighlights = draftResult.highlights || [];
        allDraftHighlights.push(...chunkHighlights);

        // 청크 간 Rate limit 보호
        if (cfg.apiMode === "live" && ci < totalChunks - 1) {
          setProg({p: pct + 2, l: `청크 간 대기 중... ☕`});
          await delay(5000);
        }
      }

      // 오버랩 구간 중복 제거 (같은 block_index의 자막이 여러 청크에서 생성될 수 있음)
      if (!isSingleChunk) {
        const seen = new Set();
        allDraftHighlights = allDraftHighlights.filter(h => {
          const key = `${h.block_index}-${h.subtitle}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      setProg({p: 42, l: `Draft 완료: ${allDraftHighlights.length}건 후보 생성`});

      // Rate limit 보호 대기
      if (cfg.apiMode === "live") {
        setProg({p: 45, l: "API 한도 보호를 위해 잠시 대기 중 (약 15초)... ☕"});
        await delay(15000);
      }

      // ── Pass 2: Editor Agent (청크별 순차 호출) ──
      let allFinalHighlights = [];
      let allRemoved = [];
      let totalDraftCount = allDraftHighlights.length;

      if (isSingleChunk) {
        // 단일 청크: 한 번에 Editor 호출
        setProg({p: 55, l: "Pass 2: 강조자막 검증·선별 중 (Editor Agent)..."});
        const editResult = await apiHighlightsEdit(blocks, anal, allDraftHighlights, cfg);
        allFinalHighlights = editResult.highlights || [];
        allRemoved = editResult.removed || [];
      } else {
        // 다중 청크: 각 청크의 Draft 결과를 해당 청크 원문과 함께 Editor에 전달
        for (let ci = 0; ci < totalChunks; ci++) {
          const pct = 50 + Math.round((ci / totalChunks) * 40);
          setProg({p: pct, l: `Pass 2: 검증·선별 중 (청크 ${ci+1}/${totalChunks}) (Editor Agent)...`});

          // 이 청크에 해당하는 block_index 범위의 Draft 결과만 추출
          const chunkBlockIndices = new Set(hlChunks[ci].map(b => b.index));
          const chunkDrafts = allDraftHighlights.filter(h => chunkBlockIndices.has(h.block_index));

          if (chunkDrafts.length === 0) continue; // Draft 결과가 없는 청크는 스킵

          const editResult = await apiHighlightsEdit(
            hlChunks[ci], anal, chunkDrafts, cfg, ci, totalChunks
          );
          allFinalHighlights.push(...(editResult.highlights || []));
          allRemoved.push(...(editResult.removed || []));

          if (cfg.apiMode === "live" && ci < totalChunks - 1) {
            setProg({p: pct + 2, l: `청크 간 대기 중... ☕`});
            await delay(5000);
          }
        }

        // Editor 결과도 오버랩 중복 제거
        const seenFinal = new Set();
        allFinalHighlights = allFinalHighlights.filter(h => {
          const key = `${h.block_index}-${h.subtitle}`;
          if (seenFinal.has(key)) return false;
          seenFinal.add(key);
          return true;
        });
      }

      const finalStats = {
        draft_count: totalDraftCount,
        final_count: allFinalHighlights.length,
        removal_rate: `${Math.round((1 - allFinalHighlights.length / Math.max(totalDraftCount, 1)) * 100)}%`,
      };
      setHl(allFinalHighlights);
      setHlStats(finalStats);

      setProg({p:100,l:`✅ 편집 가이드 완료 (2-Pass${isSingleChunk ? "" : `, ${totalChunks}청크`})`}); setGReady(true);
      // 자동 KV 저장 (편집 가이드 완료)
      autoSaveToKV({ hl: allFinalHighlights, hlStats: finalStats });
    } catch(e) { setErr(e.message); }
    finally { setGBusy(false); }
  },[blocks,anal,cfg,autoSaveToKV]);

  // ── 부분 강조자막 생성 (텍스트 드래그 → 해당 블록만 생성) ──
  const handlePartialGenerate = useCallback(async (blockIdx, selectedText) => {
    setPartialBusy(true); setErr(null); setSelPopup(null);
    try {
      // 앞뒤 3블록 컨텍스트 포함
      const ctxRange = 3;
      const startIdx = Math.max(0, blockIdx - ctxRange);
      const endIdx = Math.min(blocks.length - 1, blockIdx + ctxRange);
      const contextBlocks = blocks.slice(startIdx, endIdx + 1);
      const targetIndices = [blockIdx];

      // 최대 3개 자막
      const maxItems = 3;

      const body = {
        mode: "draft",
        blocks: contextBlocks,
        analysis: anal,
        target_block_indices: targetIndices,
        max_items: maxItems,
        selected_text: selectedText,
      };

      const d = await apiCall("highlights", body, cfg);
      const partialHl = d?.result?.highlights || [];

      if (partialHl.length > 0) {
        // 타겟 블록 결과만 필터 + 상한 적용
        const filtered = partialHl
          .filter(h => targetIndices.includes(h.block_index))
          .slice(0, maxItems);
        // 수동 생성 표시 추가
        const marked = filtered.map(h => ({ ...h, _manual: true }));
        setHl(prev => [...prev, ...marked]);
      } else {
        setErr("이 구간에서 강조자막 후보를 찾지 못했습니다.");
      }
    } catch (e) {
      setErr(`부분 생성 오류: ${e.message}`);
    } finally {
      setPartialBusy(false);
    }
  }, [blocks, anal, cfg]);

  const dm = useMemo(()=>{ const m={}; for(const d of diffs) { if(!m[d.block_index]) m[d.block_index]=[]; m[d.block_index].push(...d.changes); } return m; },[diffs]);

  const guides = useMemo(()=>{
    return [...hl].sort((a,b) => (a.block_index||0) - (b.block_index||0));
  },[hl]);

  const fC = diffs.reduce((s,d)=>s+d.changes.filter(c=>c.type==="filler_removal").length,0);
  const tC = diffs.reduce((s,d)=>s+d.changes.filter(c=>c.type==="term_correction").length,0);
  const sC = diffs.reduce((s,d)=>s+d.changes.filter(c=>c.type==="spelling").length,0);
  const hasData = blocks.length>0&&!busy;

  // ── 형광펜 마커 추가 핸들러 ──
  const handleMarkerAdd = useCallback((key, color, blockIdx, s, e) => {
    setHlMarkers(prev => {
      const existing = prev[key] || { color, ranges: [] };
      // 색상이 바뀌면 기존 범위 초기화
      const prevRanges = existing.color === color ? existing.ranges : [];
      // 새 범위가 기존 범위와 겹치면 병합
      const newRanges = [...prevRanges];
      let merged = false;
      for (let i = 0; i < newRanges.length; i++) {
        const r = newRanges[i];
        if (r.blockIdx === blockIdx && !(e <= r.s || s >= r.e)) {
          // 겹침 → 확장
          newRanges[i] = { blockIdx, s: Math.min(s, r.s), e: Math.max(e, r.e) };
          merged = true;
          break;
        }
      }
      if (!merged) newRanges.push({ blockIdx, s, e });
      return { ...prev, [key]: { color, ranges: newRanges } };
    });
  }, []);

  // 형광펜 삭제 (특정 자막의 모든 마커 제거)
  const handleMarkerClear = useCallback((key) => {
    setHlMarkers(prev => { const n = { ...prev }; delete n[key]; return n; });
  }, []);

  // file upload handler for docx
  const onFileUpload = useCallback(async(file)=>{
    if(!file) return;
    if(file.name.endsWith(".docx")){
      const buf = await file.arrayBuffer();
      // 먼저 삭제선(변경 추적) 감지 시도
      try {
        const tcResult = await parseDocxWithTrackChanges(buf.slice(0)); // arrayBuffer 복사
        if (tcResult.hasTrackChanges) {
          // 삭제선이 있으면 0차 탭으로 이동
          setFn(file.name);
          const cleanText = tcResult.cleanText;
          const reviewBlocks = parseBlocks(tcResult.fullText);

          // paragraphs → charMap: fullText의 각 문자에 대한 deleted 여부
          const charMap = [];
          for (let pi = 0; pi < tcResult.paragraphs.length; pi++) {
            for (const seg of tcResult.paragraphs[pi]) {
              for (let ci = 0; ci < seg.text.length; ci++) {
                charMap.push(seg.deleted);
              }
            }
            if (pi < tcResult.paragraphs.length - 1) charMap.push(false); // \n
          }

          // 각 블록의 fullText 내 위치를 찾아 삭제 구간 추출
          const fullText = tcResult.fullText;
          const blockStrikeRanges = {}; // { blockIndex: [{s, e}] }
          const deletedBlockIndices = new Set();
          let searchFrom = 0;

          for (const rb of reviewBlocks) {
            const blockStart = fullText.indexOf(rb.text, searchFrom);
            if (blockStart === -1) continue;
            searchFrom = blockStart + rb.text.length;

            // 블록 텍스트 범위에서 삭제된 문자 구간 추출
            const ranges = [];
            let rangeStart = -1;
            let deletedCount = 0;
            for (let ci = 0; ci < rb.text.length; ci++) {
              const isDel = (blockStart + ci) < charMap.length && charMap[blockStart + ci];
              if (isDel) {
                deletedCount++;
                if (rangeStart === -1) rangeStart = ci;
              } else {
                if (rangeStart !== -1) { ranges.push({ s: rangeStart, e: ci }); rangeStart = -1; }
              }
            }
            if (rangeStart !== -1) ranges.push({ s: rangeStart, e: rb.text.length });

            if (ranges.length > 0) blockStrikeRanges[rb.index] = ranges;
            // 블록 텍스트의 80% 이상이 삭제되면 블록 전체 삭제로 판정
            const textLen = rb.text.replace(/\s/g, "").length;
            if (textLen > 0 && deletedCount >= textLen * 0.8) deletedBlockIndices.add(rb.index);
          }

          const duration = calcDuration(reviewBlocks, deletedBlockIndices);
          const cleanTextChars = cleanText.length;
          setReviewData({ hasTrackChanges: true, deletedBlockIndices: [...deletedBlockIndices], blockStrikeRanges, duration, reviewBlocks, cleanTextChars, paragraphs: tcResult.paragraphs, cleanText });
          setBlocks(reviewBlocks); // 0차에서는 전체 블록(삭제 포함) 표시
          setTab("review");
          setDiffs([]); setHl([]); setHlStats(null); setGReady(false); setTermReview(false);
          return;
        }
      } catch (e) {
        console.warn("삭제선 파싱 실패, mammoth fallback:", e.message);
      }
      // 삭제선 없어도 0차 원고검토로 이동 (mammoth 텍스트 추출 후)
      const res = await mammoth.extractRawText({arrayBuffer:buf});
      const plainText = res.value;
      const reviewBlocks = parseBlocks(plainText);
      const duration = calcDuration(reviewBlocks);
      const paragraphs = plainText.split('\n').map(line => [{ text: line, deleted: false }]);
      setFn(file.name);
      setReviewData({ hasTrackChanges: false, deletedBlockIndices: [], blockStrikeRanges: {}, duration, reviewBlocks, cleanTextChars: plainText.length, paragraphs, cleanText: plainText });
      setBlocks(reviewBlocks);
      setTab("review");
      setDiffs([]); setHl([]); setHlStats(null); setGReady(false); setTermReview(false);
    } else {
      const text = await file.text();
      const reviewBlocks = parseBlocks(text);
      const duration = calcDuration(reviewBlocks);
      const paragraphs = text.split('\n').map(line => [{ text: line, deleted: false }]);
      setFn(file.name);
      setReviewData({ hasTrackChanges: false, deletedBlockIndices: [], blockStrikeRanges: {}, duration, reviewBlocks, cleanTextChars: text.length, paragraphs, cleanText: text });
      setBlocks(reviewBlocks);
      setTab("review");
      setDiffs([]); setHl([]); setHlStats(null); setGReady(false); setTermReview(false);
    }
  },[handleFile]);

  const fileRef = useRef(null);
  const [drag,setDrag] = useState(false);

  return <div style={{height:"100vh",background:C.bg,color:C.tx,fontFamily:FN,display:"flex",flexDirection:"column"}}>
    {/* HEADER */}
    <header style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 20px",height:52,
      borderBottom:`1px solid ${C.bd}`,background:C.sf,flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:18,fontWeight:800,letterSpacing:"-0.03em"}}>
          <span style={{color:C.ac}}>티타임즈</span> 편집 CMS
        </span>
        {fn && <span style={{fontSize:11,color:C.txD,padding:"2px 8px",background:"rgba(255,255,255,0.04)",borderRadius:4}}>{fn}</span>}
        <span style={{fontSize:10,padding:"2px 6px",borderRadius:3,fontWeight:600,
          background:cfg.apiMode==="live"?"rgba(34,197,94,0.15)":"rgba(251,191,36,0.15)",
          color:cfg.apiMode==="live"?C.ok:C.wn}}>{cfg.apiMode==="live"?"LIVE":"MOCK"}</span>
        {autoSaveStatus && <span style={{fontSize:11,color:autoSaveStatus==="saved"?C.ok:"#9CA3AF",padding:"3px 8px",borderRadius:6,
          background:autoSaveStatus==="saved"?"rgba(34,197,94,0.1)":"rgba(255,255,255,0.04)"}}>
          {autoSaveStatus==="pending"?"⏳ 자동 저장 대기":autoSaveStatus==="saving"?"💾 자동 저장 중...":"✓ 자동 저장됨"}
        </span>}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        {readOnly && <span style={{fontSize:11,padding:"3px 10px",borderRadius:12,fontWeight:600,
          background:"rgba(168,85,247,0.15)",color:"#A855F7",border:"1px solid rgba(168,85,247,0.3)"}}>
          읽기 전용
        </span>}
        {hasData&&!termReview && <div style={{display:"flex",gap:2,background:"rgba(255,255,255,0.04)",borderRadius:7,padding:2}}>
          {[["review","0차 원고검토"],["correction","1차 교정"],["script","스크립트 편집"],["guide","편집 가이드"]].map(([id,l])=>
            <button key={id} onClick={()=>setTab(id)} style={{padding:"5px 14px",borderRadius:5,border:"none",cursor:"pointer",
              fontSize:12,fontWeight:tab===id?600:400,background:tab===id?C.ac:"transparent",
              color:tab===id?"#fff":C.txM,transition:"all 0.12s",
              opacity:id==="review"&&!reviewData?0.4:1,
              pointerEvents:id==="review"&&!reviewData?"none":"auto"}}>{l}{id==="guide"&&gReady?" ✓":""}</button>)}
        </div>}
        {hasData && !readOnly && !termReview && (
          <button onClick={handleShare} disabled={saving} style={{padding:"5px 14px",borderRadius:6,border:"none",
            background:saving?"rgba(74,108,247,0.4)":sessionId?`linear-gradient(135deg,#22C55E,#16A34A)`:`linear-gradient(135deg,${C.ac},#7C3AED)`,
            color:"#fff",fontSize:12,fontWeight:600,cursor:saving?"not-allowed":"pointer"}}>
            {saving?"저장 중…":sessionId?"↑ 업데이트":"🔗 공유"}
          </button>
        )}
        {/* 최초 공유가 아닌 경우 새 링크 생성 옵션 */}
        {hasData && !readOnly && !termReview && sessionId && (
          <button onClick={()=>{setSessionId(null);}} title="새 공유 링크 생성"
            style={{padding:"5px 8px",borderRadius:6,border:`1px solid ${C.bd}`,
              background:"transparent",color:C.txM,fontSize:11,cursor:"pointer"}}>+ 새 링크</button>
        )}
        {hasData && (
          <button onClick={handleReset} title="새 파일 시작" style={{padding:"5px 10px",borderRadius:6,
            border:`1px solid ${C.bd}`,background:"transparent",color:C.txM,fontSize:12,cursor:"pointer"}}>
            ✕ 새 파일
          </button>
        )}
        {!readOnly && <button onClick={()=>setShowSessions(true)} title="작업 히스토리"
          style={{padding:"5px 10px",borderRadius:6,border:`1px solid ${C.bd}`,
            background:"transparent",color:C.txM,fontSize:12,cursor:"pointer"}}>📋</button>}
        <button onClick={toggleTheme} title={theme==="dark"?"라이트 모드":"다크 모드"}
          style={{padding:"5px 10px",borderRadius:6,border:`1px solid ${C.bd}`,
            background:"transparent",color:C.txM,fontSize:12,cursor:"pointer"}}>{theme==="dark"?"☀️":"🌙"}</button>
        {!readOnly && <button onClick={()=>setShowSet(true)} style={{padding:"5px 10px",borderRadius:6,border:`1px solid ${C.bd}`,
          background:"transparent",color:C.txM,fontSize:12,cursor:"pointer"}}>⚙️</button>}
      </div>
    </header>

    {err && <div style={{padding:"10px 20px",background:"rgba(239,68,68,0.1)",borderBottom:"1px solid rgba(239,68,68,0.2)",
      fontSize:13,color:"#EF4444",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <span>⚠️ {err}</span>
      <button onClick={()=>setErr(null)} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:16}}>✕</button>
    </div>}

    {(busy||gBusy) && <div style={{padding:"0 20px",flexShrink:0}}><Progress pct={prog.p} label={prog.l}/></div>}
    {(busy||gBusy) && anal?.editorial_summary && <div style={{padding:"0 20px 12px",flexShrink:0,maxWidth:660,margin:"0 auto",width:"100%"}}>
      <EditorialSummaryPanel summary={anal.editorial_summary} collapsed={!anal.editorial_summary} onToggle={()=>{}}/>
    </div>}

    <main style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      {/* TERM REVIEW */}
      {termReview && <TermReviewScreen
        terms={pendingTerms}
        analysis={anal}
        onConfirm={handleCorrectStart}
        onSkip={()=>handleCorrectStart([])}
      />}

      {/* EMPTY */}
      {!termReview&&!hasData&&!busy&&!readOnly && <div style={{padding:"40px 24px",maxWidth:520,margin:"0 auto",width:"100%"}}>
        <div onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)}
          onDrop={e=>{e.preventDefault();setDrag(false);onFileUpload(e.dataTransfer.files[0])}}
          onClick={()=>fileRef.current?.click()}
          style={{border:`2px dashed ${drag?C.ac:C.bd}`,borderRadius:16,padding:"56px 32px",textAlign:"center",
            cursor:"pointer",background:drag?C.acS:"transparent",transition:"all 0.2s"}}>
          <div style={{fontSize:44,marginBottom:14,opacity:0.5}}>📄</div>
          <div style={{fontSize:16,fontWeight:600,color:C.tx,marginBottom:6}}>docx 또는 txt 파일을 드래그하거나 클릭</div>
          <div style={{fontSize:12,color:C.txD}}>클로바노트 STT 출력물 (.docx, .txt)</div>
          <input ref={fileRef} type="file" accept=".docx,.txt" style={{display:"none"}}
            onChange={e=>onFileUpload(e.target.files?.[0])}/>
        </div>
        <p style={{textAlign:"center",fontSize:13,color:C.txD,lineHeight:1.8,marginTop:16}}>
          파일 업로드 → 자동 사전 분석 + 필러 제거 + 용어 교정<br/>
          이후 편집 가이드에서 강조자막 생성 (v2 룰북 2-Pass)
        </p>
      </div>}

      {/* 0차: 원고 검토 (삭제선 표시 + 분량 계산) */}
      {!termReview&&hasData&&tab==="review"&&reviewData && (() => {
        const { deletedBlockIndices, duration, reviewBlocks } = reviewData;
        const delSet = new Set(deletedBlockIndices || []);
        const usedBlocks = reviewBlocks || blocks;

        // "1차 교정으로 진행" — cleanText로 parseBlocks → handleFile
        const handleProceedToCorrection = () => {
          const ct = reviewData.cleanText || "";
          setTab("correction");
          handleFile(ct, fn);
        };

        return <>
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            {/* 분량 요약 카드 */}
            <div style={{padding:"16px 20px",background:C.sf,borderBottom:`1px solid ${C.bd}`,flexShrink:0}}>
              <div style={{display:"flex",gap:16,flexWrap:"wrap",alignItems:"flex-start"}}>
                {/* 원본 분량 */}
                <div style={{flex:1,minWidth:180,padding:14,borderRadius:10,background:"rgba(255,255,255,0.03)",border:`1px solid ${C.bd}`}}>
                  <div style={{fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>📄 원본 분량</div>
                  <div style={{fontSize:24,fontWeight:800,color:C.tx,marginBottom:4}}>{secondsToDisplay(duration.totalSeconds)}</div>
                  <div style={{fontSize:12,color:C.txM}}>{duration.totalChars.toLocaleString()}자 · {usedBlocks.length}블록</div>
                </div>
                {/* 예상 영상 길이 */}
                <div style={{flex:1,minWidth:180,padding:14,borderRadius:10,background:"rgba(34,197,94,0.05)",border:"1px solid rgba(34,197,94,0.2)"}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#22C55E",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>🎬 예상 영상 길이</div>
                  {(() => {
                    const cleanChars = reviewData.cleanTextChars || duration.keptChars;
                    const reg = calcRegression(cleanChars);
                    return <>
                      <div style={{fontSize:24,fontWeight:800,color:"#22C55E"}}>{secondsToDisplay(reg.pointSec)}</div>
                      <div style={{marginTop:6,padding:"5px 10px",borderRadius:6,background:"rgba(34,197,94,0.08)",display:"inline-block"}}>
                        <span style={{fontSize:12,color:C.txM,fontWeight:600}}>
                          {secondsToDisplay(reg.lowSec)} ~ {secondsToDisplay(reg.highSec)}
                        </span>
                        <span style={{fontSize:10,color:C.txD,marginLeft:6}}>(95% 신뢰구간)</span>
                      </div>
                      <div style={{marginTop:6,fontSize:10,color:C.txD}}>
                        {reg.count}건 학습 · 선형회귀 (LOO MAE 3.9%) · 삭제 후 {cleanChars.toLocaleString()}자
                      </div>
                      {duration.keptSeconds > 0 && (
                        <div style={{fontSize:11,color:C.txD,marginTop:4}}>
                          타임스탬프 기준: {secondsToDisplay(duration.keptSeconds)}
                        </div>
                      )}
                    </>;
                  })()}
                  <div style={{fontSize:12,color:C.txM,marginTop:4}}>{usedBlocks.length - delSet.size}블록 잔존</div>
                </div>
              </div>
              {/* 진행 버튼 */}
              <div style={{marginTop:14,display:"flex",gap:10,justifyContent:"flex-end"}}>
                <button onClick={handleProceedToCorrection}
                  style={{padding:"9px 24px",borderRadius:8,border:"none",
                    background:`linear-gradient(135deg,${C.ac},#7C3AED)`,color:"#fff",fontSize:13,fontWeight:700,
                    cursor:"pointer",boxShadow:"0 4px 14px rgba(74,108,247,0.3)"}}>
                  {reviewData.hasTrackChanges ? "삭제선 제거 → 1차 교정 시작" : "1차 교정 시작"}
                </button>
              </div>
            </div>
            {/* 원고 (삭제선 표시 — 블록화 없이 단락 그대로) */}
            <div style={{flex:1,overflowY:"auto"}}>
              <div style={{padding:"8px 16px",fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",
                letterSpacing:"0.08em",borderBottom:`1px solid ${C.bd}`,position:"sticky",top:0,background:C.bg,zIndex:2}}>
                원고 검토{reviewData.hasTrackChanges ? " — 취소선은 빨간색으로 표시됩니다" : ""}
              </div>
              <div style={{padding:"16px 20px"}}>
                {(reviewData.paragraphs || []).map((p, pi) => {
                  const hasDeleted = p.some(s => s.deleted);
                  const allDeleted = p.every(s => s.deleted);
                  const paraText = p.map(s => s.text).join("");
                  if (!paraText.trim()) return <div key={pi} style={{height:12}}/>;
                  return <p key={pi} style={{fontSize:14,lineHeight:1.9,color:C.tx,
                    marginBottom:4,wordBreak:"keep-all",whiteSpace:"pre-wrap"}}>
                    {p.map((seg, si) => seg.deleted
                      ? <span key={si} style={{textDecoration:"line-through",textDecorationColor:"#EF4444",
                          background:"rgba(239,68,68,0.12)",color:"#EF4444",padding:"1px 2px",borderRadius:3}}>{seg.text}</span>
                      : <span key={si}>{seg.text}</span>
                    )}
                  </p>;
                })}
              </div>
            </div>
          </div>
        </>;
      })()}

      {/* 1차 교정 */}
      {!termReview&&hasData&&tab==="correction" && <>
        <div style={{flex:1,display:"flex",overflow:"hidden"}}>
          <div ref={lRef} data-scroll-container style={{flex:1,overflowY:"auto",borderRight:`1px solid ${C.bd}`}}>
            <div style={{padding:"8px 16px",fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",
              letterSpacing:"0.08em",borderBottom:`1px solid ${C.bd}`,position:"sticky",top:0,background:C.bg,zIndex:2}}>원문</div>
            {blocks.map(b=><BlockView key={b.index} block={b} side="left" active={aBlock===b.index}
              pos={findPositions(b.text,dm[b.index])} onClick={scrollTo}
              bRef={el=>{if(el)bEls.current[`l${b.index}`]=el}}/>)}
          </div>
          <div ref={rRef} data-scroll-container style={{flex:1,overflowY:"auto"}}>
            <div style={{padding:"8px 16px",fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",
              letterSpacing:"0.08em",borderBottom:`1px solid ${C.bd}`,position:"sticky",top:0,background:C.bg,zIndex:2}}>수정본</div>
            {blocks.map(b=>{
              const idx = b.index;
              const corrected = getCorrectedText(b.text, dm[idx]);
              const editedVal = scriptEdits[idx];
              const isEdited = editedVal !== undefined && editedVal !== corrected;
              return <CorrectionRightBlock key={idx} block={b} active={aBlock===idx}
                pos={findPositions(b.text,dm[idx])} onClick={scrollTo}
                bRef={el=>{if(el)bEls.current[`r${idx}`]=el}}
                correctedText={corrected} editedVal={editedVal} isEdited={isEdited}
                onSave={val => {
                  if (val !== null) setScriptEdits(prev=>({...prev,[idx]:val}));
                  else setScriptEdits(prev=>{const n={...prev};delete n[idx];return n;});
                  setSubtitleCache(null); setSubtitleResult(null);
                }}
                onRevert={() => { setScriptEdits(prev=>{const n={...prev};delete n[idx];return n;}); setSubtitleCache(null); setSubtitleResult(null); }}
              />;
            })}
          </div>
        </div>
        {(() => {
          // 원문/수정본 분량 계산
          const origChars = blocks.reduce((s, b) => s + b.text.replace(/\s/g, "").length, 0);
          const corrChars = blocks.reduce((s, b) => {
            const idx = b.index;
            const t = scriptEdits[idx] !== undefined ? scriptEdits[idx] : getCorrectedText(b.text, dm[idx]);
            return s + t.replace(/\s/g, "").length;
          }, 0);
          const origMs = Math.ceil(origChars / 200); // 원고지 매수 (200자 기준)
          const corrMs = Math.ceil(corrChars / 200);
          const diffChars = corrChars - origChars;
          const diffSign = diffChars > 0 ? "+" : "";
          return <div style={{display:"flex",gap:20,padding:"10px 20px",background:C.sf,borderTop:`1px solid ${C.bd}`,fontSize:13,color:C.txM,flexShrink:0,flexWrap:"wrap"}}>
            <span>필러: <b style={{color:C.fTx}}>{fC}</b></span>
            <span>용어: <b style={{color:C.cTx}}>{tC}</b></span>
            {sC > 0 && <span>맞춤법: <b style={{color:C.scTx}}>{sC}</b></span>}
            <span>총: <b style={{color:C.tx}}>{fC+tC+sC}</b></span>
            {Object.keys(scriptEdits).length > 0 && <span>수동 수정: <b style={{color:"#22C55E"}}>{Object.keys(scriptEdits).length}</b></span>}
            <span style={{marginLeft:"auto",borderLeft:`1px solid ${C.bd}`,paddingLeft:16,fontSize:12}}>
              원문 <b style={{color:C.tx}}>{origChars.toLocaleString()}</b>자 ({origMs}매)
              <span style={{margin:"0 6px",color:C.bd}}>→</span>
              수정본 <b style={{color:"#22C55E"}}>{corrChars.toLocaleString()}</b>자 ({corrMs}매)
              <span style={{marginLeft:8,color:diffChars<0?"#22C55E":"#F59E0B",fontSize:11}}>({diffSign}{diffChars.toLocaleString()}자)</span>
            </span>
          </div>;
        })()}
      </>}

      {/* 1.5단계: 스크립트 편집 */}
      {!termReview&&hasData&&tab==="script" && (() => {
        const editedCount = Object.keys(scriptEdits).length;

        // 원본 텍스트 복사 (포맷팅 없이)
        const handleCopyRaw = (e) => {
          const lines = blocks.map(b => {
            const idx = b.index;
            if (scriptEdits[idx] !== undefined) return scriptEdits[idx];
            return getCorrectedText(b.text, dm[idx]);
          });
          const text = lines.join("\n\n");
          try { navigator.clipboard.writeText(text); } catch {
            const ta = document.createElement("textarea");
            ta.value = text; ta.style.cssText = "position:fixed;left:-9999px";
            document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
          }
          const btn = e.currentTarget;
          btn.textContent = "✅ 복사됨!";
          setTimeout(() => { btn.textContent = "📋 원본 복사"; }, 1500);
        };

        // AI 자막 포맷팅 복사
        // ── 후처리 보정: AI 출력의 형식 오류를 코드로 강제 교정 ──
        const postProcessSubtitle = (text) => {
          let lines = text.split('\n');

          // 1) 메타 정보 / 구분선 제거
          const isMetaLine = (t, lineIdx) => {
            if (!t) return false;
            // 구분선: 대시/등호 3개 이상 포함
            if (/[-=]{3,}/.test(t)) return true;
            // 파일명 패턴: "260327_박종천 싱크" 등
            if (/^\d{6}[_\s]/.test(t)) return true;
            // 날짜+시간 패턴
            if (/^\d{4}\.\d{2}\.\d{2}\s/.test(t)) return true;
            // 분초 패턴
            if (/\d+분\s*\d+초/.test(t) && t.length < 40) return true;
            // 편/장 구분
            if (/^\d+편(\/\d+편)?$/.test(t)) return true;
            // 싱크/녹취 헤더
            if (/싱크|녹취록|Sync/i.test(t) && t.length < 30) return true;
            // 이름 나열: 텍스트 앞부분(처음 10줄)에서만, 2~5어절 한글/영문, 구두점 없음
            if (lineIdx < 10 && /^[가-힣a-zA-Z]+(\s[가-힣a-zA-Z]+){1,4}$/.test(t) && t.length < 25 && !/[.?!,]/.test(t)) return true;
            return false;
          };
          lines = lines.filter((l, i) => {
            const t = l.trim();
            if (!t) return true; // 빈 줄 유지
            return !isMetaLine(t, i);
          });

          // 2) 줄 끝 구두점 제거 (마침표, 쉼표) — 물음표/느낌표는 유지
          lines = lines.map(l => {
            let s = l.trimEnd();
            while (s.endsWith('.') || s.endsWith(',')) {
              s = s.slice(0, -1).trimEnd();
            }
            return s;
          });

          // 3) [제거됨] 짧은 줄 합치기는 문장 경계를 무시할 수 있어 제거

          // 4) 따옴표 보정 — 줄바꿈된 따옴표 구간에 각 줄마다 따옴표 적용
          const fixQuotes = (lines, q) => {
            const result = [];
            let inQuote = false;
            let quoteChar = q;
            for (let i = 0; i < lines.length; i++) {
              let l = lines[i];
              if (!l.trim()) { result.push(l); inQuote = false; continue; }

              const opens = (l.match(new RegExp('\\' + quoteChar, 'g')) || []).length;
              const hasOpen = l.includes(quoteChar);

              if (!inQuote && hasOpen && opens % 2 === 1) {
                // 따옴표 열림 — 닫히지 않은 상태
                // 열린 따옴표 위치 찾기
                const qIdx = l.indexOf(quoteChar);
                const afterQ = l.substring(qIdx);
                if ((afterQ.match(new RegExp('\\' + quoteChar, 'g')) || []).length === 1) {
                  // 이 줄에서 열리고 닫히지 않음
                  inQuote = true;
                  // 줄 끝에 닫는 따옴표 추가
                  l = l.trimEnd() + quoteChar;
                }
              } else if (inQuote) {
                // 따옴표 안에 있는 줄
                if (hasOpen && opens % 2 === 1) {
                  // 닫는 따옴표가 있음 → 따옴표 구간 종료
                  // 줄 시작에 여는 따옴표가 없으면 추가
                  if (!l.trimStart().startsWith(quoteChar)) {
                    l = quoteChar + l.trimStart();
                  }
                  inQuote = false;
                } else {
                  // 중간 줄 — 양쪽에 따옴표 추가
                  const trimmed = l.trim();
                  if (!trimmed.startsWith(quoteChar)) l = quoteChar + trimmed;
                  if (!l.trimEnd().endsWith(quoteChar)) l = l.trimEnd() + quoteChar;
                }
              }
              result.push(l);
            }
            return result;
          };

          let processed = fixQuotes(lines, "'");
          processed = fixQuotes(processed, '"');

          return processed.join('\n');
        };

        const handleCopySubtitle = async (e) => {
          const btn = e.currentTarget;
          const origBtnText = btn.textContent;

          // 캐시가 있으면 2패널 표시 (이미 결과가 있으면 바로 보여줌)
          if (subtitleCache) {
            setSubtitleResult(subtitleCache);
            return;
          }

          btn.textContent = "⏳ AI 포맷팅 중 (0%)...";
          btn.style.opacity = "0.7";
          btn.disabled = true;
          try {
            const allTexts = blocks.map(b => {
              const idx = b.index;
              if (scriptEdits[idx] !== undefined) return scriptEdits[idx];
              return getCorrectedText(b.text, dm[idx]);
            });

            // PATCH-008: 600~1000자 범위 + 화자 턴 경계에서 끊기
            const CHUNK_MIN = 600;
            const CHUNK_MAX = 1000;
            const SENTENCE_END = /(?<=[.?!요죠다까])\s+/;
            const isMetaBlock = (text) => {
              const t = text.trim();
              if (!t) return true;
              if (/^\d{6}[_\s]/.test(t)) return true;
              if (/^\d{4}\.\d{2}\.\d{2}/.test(t)) return true;
              if (/^\d+분\s*\d+초/.test(t)) return true;
              if (/^[-=─]{3,}$/.test(t)) return true;
              if (/^={5,}/.test(t)) return true;
              return false;
            };
            const chunks = [];
            let currentChunk = "";
            for (const blockText of allTexts) {
              if (!blockText.trim()) continue;
              if (isMetaBlock(blockText)) continue;

              const wouldBe = currentChunk.length + (currentChunk ? 1 : 0) + blockText.length;

              if (currentChunk.length >= CHUNK_MIN && wouldBe > CHUNK_MAX) {
                chunks.push(currentChunk);
                currentChunk = blockText;
              } else if (wouldBe > CHUNK_MAX && currentChunk.length < CHUNK_MIN) {
                if (currentChunk) chunks.push(currentChunk);
                if (blockText.length > CHUNK_MAX) {
                  const sentences = blockText.split(SENTENCE_END);
                  let partial = "";
                  for (const sent of sentences) {
                    if (partial.length + sent.length + 1 > CHUNK_MAX && partial.length > 0) {
                      chunks.push(partial);
                      partial = sent;
                    } else {
                      partial += (partial ? ' ' : '') + sent;
                    }
                  }
                  currentChunk = partial || "";
                } else {
                  currentChunk = blockText;
                }
              } else {
                currentChunk += (currentChunk ? '\n' : '') + blockText;
              }
            }
            if (currentChunk) chunks.push(currentChunk);

            // 검증 함수
            const validateAndUse = (d, originalChunk) => {
              if (!d || !d.formatted) return originalChunk;
              if (d._debug?.truncated) {
                console.warn(`[자막] 축약 감지 (${d._debug.ratio}%) — 원본 사용`);
                return originalChunk;
              }
              return d.formatted;
            };

            const PARALLEL = 3;
            const formattedChunks = new Array(chunks.length);

            // Warmup: 첫 블록 순차 호출 → prompt cache 생성
            console.log(`[자막 V3] ${chunks.length}개 블록 처리 시작`);
            const first = await apiCall("subtitle-format", { text: chunks[0], version: "v3" }, cfg);
            if (first._debug) console.log(`[자막 DEBUG] chunk 0:`, first._debug);
            formattedChunks[0] = validateAndUse(first, chunks[0]);

            // 나머지: PARALLEL개씩 병렬 호출 → cache hit
            for (let i = 1; i < chunks.length; i += PARALLEL) {
              const pct = Math.round((i / chunks.length) * 100);
              btn.textContent = `⏳ AI 포맷팅 중 (${pct}%)...`;

              const batch = chunks.slice(i, i + PARALLEL);
              const promises = batch.map((chunk, j) =>
                apiCall("subtitle-format", { text: chunk, version: "v3" }, cfg)
                  .then(d => ({ idx: i + j, d, chunk }))
                  .catch(err => ({ idx: i + j, d: null, chunk, err }))
              );

              const results = await Promise.all(promises);
              for (const { idx, d, chunk } of results) {
                if (d?._debug) console.log(`[자막 DEBUG] chunk ${idx}:`, d._debug);
                formattedChunks[idx] = validateAndUse(d, chunk);
              }
            }

            // V3: Worker 후처리 완료 — 프론트 후처리 스킵
            const finalText = formattedChunks.join('\n');

            setSubtitleCache(finalText);
            setSubtitleResult(finalText);

            btn.textContent = origBtnText;
            btn.style.opacity = "1";
          } catch (err) {
            btn.textContent = "❌ 실패";
            console.error("자막 포맷팅 실패:", err);
            setTimeout(() => { btn.textContent = origBtnText; btn.style.opacity = "1"; }, 2000);
          } finally {
            btn.disabled = false;
          }
        };
        return <div style={{display:"flex",flex:1,overflow:"hidden"}}>
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{flex:1,overflowY:"auto",padding:0}}>
            <div style={{padding:"8px 16px",fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",
              letterSpacing:"0.08em",borderBottom:`1px solid ${C.bd}`,position:"sticky",top:0,background:C.bg,zIndex:2,
              display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span>최종 스크립트 편집</span>
              <span style={{fontSize:11,color:C.txM,fontWeight:400,textTransform:"none",letterSpacing:0}}>
                블록을 클릭하면 편집할 수 있습니다{editedCount > 0 ? ` · 수동 수정 ${editedCount}건` : ""}
              </span>
            </div>
            {blocks.map(b => {
              const idx = b.index;
              const corrected = getCorrectedText(b.text, dm[idx]);
              const editedVal = scriptEdits[idx];
              const isEdited = editedVal !== undefined && editedVal !== corrected;
              return <ScriptEditBlock key={idx} block={b} correctedText={corrected}
                editedVal={editedVal} isEdited={isEdited}
                onSave={val => {
                  if (val !== null) setScriptEdits(prev=>({...prev,[idx]:val}));
                  else setScriptEdits(prev=>{const n={...prev};delete n[idx];return n;});
                  setSubtitleCache(null); setSubtitleResult(null);
                }}
                onRevert={() => { setScriptEdits(prev=>{const n={...prev};delete n[idx];return n;}); setSubtitleCache(null); setSubtitleResult(null); }}
              />;
            })}
          </div>
          <div style={{display:"flex",gap:12,padding:"10px 20px",background:C.sf,borderTop:`1px solid ${C.bd}`,
            fontSize:13,color:C.txM,flexShrink:0,alignItems:"center"}}>
            <span>블록: <b style={{color:C.tx}}>{blocks.length}</b></span>
            {editedCount > 0 && <span>수동 수정: <b style={{color:"#22C55E"}}>{editedCount}</b></span>}
            <span>AI 교정: <b style={{color:C.cTx}}>{fC+tC+sC}</b></span>
            <button onClick={handleCopyRaw}
              style={{marginLeft:"auto",padding:"7px 16px",borderRadius:8,border:`1px solid ${C.bd}`,
                background:"transparent",color:C.txM,fontSize:12,fontWeight:600,
                cursor:"pointer"}}>
              📋 원본 복사
            </button>
            <button onClick={handleCopySubtitle}
              style={{padding:"7px 20px",borderRadius:8,border:"none",
                background:`linear-gradient(135deg,${C.ac},#7C3AED)`,color:"#fff",fontSize:13,fontWeight:700,
                cursor:"pointer",boxShadow:"0 3px 12px rgba(74,108,247,0.3)",
                display:"flex",alignItems:"center",gap:6}}>
              🎬 자막용 복사
            </button>
          </div>
          </div>
          {/* 자막 2패널 — 우측 */}
          {subtitleResult && <div style={{width:420,minWidth:420,borderLeft:`1px solid ${C.bd}`,
            display:"flex",flexDirection:"column",background:"rgba(0,0,0,0.08)"}}>
            <div style={{padding:"8px 14px",fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",
              letterSpacing:"0.08em",borderBottom:`1px solid ${C.bd}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span>자막 포맷팅 결과</span>
              <div style={{display:"flex",gap:6}}>
                <button onClick={async()=>{
                  try { await navigator.clipboard.writeText(subtitleResult); } catch {
                    const ta = document.createElement("textarea");
                    ta.value = subtitleResult; ta.style.cssText = "position:fixed;left:-9999px";
                    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
                  }
                }} style={{fontSize:10,fontWeight:600,padding:"3px 10px",borderRadius:4,border:`1px solid ${C.bd}`,
                  background:"rgba(255,255,255,0.06)",color:C.txM,cursor:"pointer"}}>📋 복사</button>
                <button onClick={()=>setSubtitleResult(null)}
                  style={{fontSize:10,fontWeight:600,padding:"3px 8px",borderRadius:4,border:`1px solid ${C.bd}`,
                    background:"rgba(255,255,255,0.06)",color:C.txD,cursor:"pointer"}}>✕ 닫기</button>
              </div>
            </div>
            <div style={{flex:1,overflowY:"auto",padding:"12px 16px"}}>
              <pre style={{fontSize:13,color:C.tx,lineHeight:1.7,whiteSpace:"pre-wrap",wordBreak:"break-word",
                fontFamily:FN,margin:0}}>{subtitleResult}</pre>
            </div>
          </div>}
        </div>;
      })()}

      {/* 편집 가이드 */}
      {!termReview&&hasData&&tab==="guide" && <>
        {!gReady&&!gBusy && <div style={{padding:48,textAlign:"center"}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 12px",borderRadius:16,
            background:"rgba(34,197,94,0.1)",border:"1px solid rgba(34,197,94,0.2)",fontSize:12,color:C.ok,marginBottom:20}}>
            ✅ 1차 교정 완료 — 필러 {fC}건, 용어 {tC}건</div>
          <div style={{display:"flex",gap:16,justifyContent:"center",flexWrap:"wrap",maxWidth:560,margin:"0 auto"}}>
            <div onClick={handleGuide} style={{flex:1,minWidth:220,padding:24,borderRadius:14,border:`2px solid ${C.ac}`,
              background:`${C.ac}11`,cursor:"pointer",textAlign:"left",transition:"all .15s"}}>
              <div style={{fontSize:16,fontWeight:700,color:C.tx,marginBottom:8}}>▶ 강조자막 생성하기</div>
              <div style={{fontSize:13,color:C.txM,lineHeight:1.5}}>AI가 일괄 생성하는 강조자막 프로세스</div>
              <div style={{fontSize:11,color:C.txD,marginTop:6}}>Draft Agent → Editor Agent (2-Pass)</div>
            </div>
            <div onClick={()=>{setTab("guide"); setGReady(true);}} style={{flex:1,minWidth:220,padding:24,borderRadius:14,border:`2px solid ${C.bd}`,
              background:C.sf,cursor:"pointer",textAlign:"left",transition:"all .15s"}}>
              <div style={{fontSize:16,fontWeight:700,color:C.tx,marginBottom:8}}>✏️ 내가 직접 편집하기</div>
              <div style={{fontSize:13,color:C.txM,lineHeight:1.5}}>편집자가 직접 읽으면서 강조자막을 부분 생성할 수 있습니다</div>
              <div style={{fontSize:11,color:C.txD,marginTop:6}}>텍스트 드래그 → 부분 생성</div>
            </div>
          </div>
        </div>}
        {gReady && <div style={{flex:1,display:"flex",overflow:"hidden"}}>
          <div ref={lRef} data-scroll-container style={{flex:1,overflowY:"auto",borderRight:`1px solid ${C.bd}`}}>
            <div style={{padding:"8px 16px",fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",
              letterSpacing:"0.08em",borderBottom:`1px solid ${C.bd}`,position:"sticky",top:0,background:C.bg,zIndex:2,
              display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span>교정본</span>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                {bookmark != null && <button onClick={()=>{
                  const el = bEls.current[`g${bookmark}`];
                  if (el) el.scrollIntoView({behavior:"smooth",block:"center"});
                }} style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,border:`1px solid #F59E0B`,
                  background:"rgba(245,158,11,0.12)",color:"#F59E0B",cursor:"pointer",textTransform:"none",letterSpacing:0}}>
                  📌 #{bookmark} 이동
                </button>}
                <button onClick={()=>{
                  if (bookmark === aBlock) { setBookmark(null); }
                  else if (aBlock != null) { setBookmark(aBlock); }
                  else {
                    // 현재 스크롤 위치에서 가장 가까운 블록 찾기
                    const container = lRef.current;
                    if (!container) return;
                    const containerTop = container.scrollTop + container.getBoundingClientRect().top;
                    let closest = 0, minDist = Infinity;
                    for (const [k, el] of Object.entries(bEls.current)) {
                      if (!k.startsWith("g")) continue;
                      const idx = parseInt(k.slice(1));
                      const dist = Math.abs(el.getBoundingClientRect().top - container.getBoundingClientRect().top);
                      if (dist < minDist) { minDist = dist; closest = idx; }
                    }
                    setBookmark(closest);
                  }
                }} style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,
                  border:`1px solid ${bookmark!=null?"#F59E0B":C.bd}`,
                  background:bookmark!=null?"rgba(245,158,11,0.12)":"transparent",
                  color:bookmark!=null?"#F59E0B":C.txM,cursor:"pointer",textTransform:"none",letterSpacing:0}}>
                  {bookmark != null ? `📌 #{bookmark} 해제` : "📌 책갈피"}
                </button>
              </div>
            </div>
            {matchingMode && <div style={{padding:"6px 16px",background:MARKER_COLORS[matchingMode.color]?.bg,
              borderBottom:`1px solid ${MARKER_COLORS[matchingMode.color]?.border}`,
              display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:28,zIndex:2}}>
              <span style={{fontSize:12,fontWeight:600,color:MARKER_COLORS[matchingMode.color]?.border}}>
                🖍 블록 #{matchingMode.blockIdx}에서 텍스트를 드래그하여 형광펜을 칠하세요
              </span>
              <button onClick={()=>setMatchingMode(null)}
                style={{fontSize:11,padding:"2px 10px",borderRadius:4,border:`1px solid ${MARKER_COLORS[matchingMode.color]?.border}`,
                  background:"rgba(0,0,0,0.3)",color:MARKER_COLORS[matchingMode.color]?.border,cursor:"pointer",fontWeight:600}}>완료</button>
            </div>}
            {blocks.map(b=>{
              const idx = b.index;
              const hasScriptEdit = scriptEdits[idx] !== undefined;
              const correctedText = getCorrectedText(b.text, dm[idx]);
              const displayText = hasScriptEdit ? scriptEdits[idx] : null;
              const finalText = hasScriptEdit ? scriptEdits[idx] : correctedText;
              // 매칭 모드에서 이 블록이 대상인지 확인
              const activeMatchBlock = matchingMode ? matchingMode.blockIdx : null;
              return <div key={idx}>
              {bookmark === idx && <div style={{padding:"4px 16px",background:"rgba(245,158,11,0.1)",
                borderBottom:`2px solid #F59E0B`,display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:11,fontWeight:700,color:"#F59E0B"}}>📌 책갈피 — 여기까지 확인함</span>
              </div>}
              <div ref={el=>{if(el)bEls.current[`g${idx}`]=el}} onClick={()=>scrollTo(idx)}
                onMouseUp={(e)=>{
                  const sel = window.getSelection();
                  const txt = sel?.toString()?.trim();
                  if (txt && txt.length >= 5) {
                    setSelPopup({ blockIdx: idx, text: txt, x: e.clientX, y: e.clientY });
                  }
                }}
                style={{padding:"10px 16px",
                  borderLeft:`4px solid ${aBlock===idx?"#A855F7":hasScriptEdit?"#22C55E":"transparent"}`,
                  background:aBlock===idx?"rgba(168,85,247,0.08)":hasScriptEdit?"rgba(34,197,94,0.04)":"transparent",
                  cursor:"pointer",transition:"all 0.25s ease"}}>
                <div style={{marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
                  <span style={{fontSize:10,fontWeight:700,color:C.txD,fontFamily:"monospace",
                    background:"rgba(255,255,255,0.06)",padding:"1px 5px",borderRadius:3}}>#{idx}</span>
                  <Badge name={b.speaker}/>
                  <span style={{fontSize:11,color:C.txD,fontFamily:"monospace"}}>{b.timestamp}</span>
                  {hasScriptEdit && <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,
                    background:"rgba(34,197,94,0.15)",color:"#22C55E"}}>수정됨</span>}
                  {activeMatchBlock===idx && <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,
                    background:MARKER_COLORS[matchingMode?.color]?.bg,color:MARKER_COLORS[matchingMode?.color]?.border,
                    border:`1px solid ${MARKER_COLORS[matchingMode?.color]?.border}`}}>
                    🖍 드래그로 구간 선택</span>}
                </div>
                <MarkedText text={finalText} blockIdx={idx}
                  hlMarkers={hlMarkers}
                  matchingMode={activeMatchBlock===idx ? matchingMode : null}
                  onMarkerAdd={handleMarkerAdd}/>
              </div>
              {/* "사용" 판정된 자막을 해당 블록 아래에 인라인 카드로 표시 */}
              {(() => {
                const usedGuides = guides.filter(g => g.block_index === idx && hlVerdicts[`${g.block_index}-${g.subtitle}`] === "use");
                if (usedGuides.length === 0) return null;

                const swapInHl = (gA, gB) => {
                  // hl 배열에서 두 아이템의 위치를 서로 바꿈
                  setHl(prev => {
                    const next = [...prev];
                    const iA = next.indexOf(gA);
                    const iB = next.indexOf(gB);
                    if (iA === -1 || iB === -1) return prev;
                    [next[iA], next[iB]] = [next[iB], next[iA]];
                    return next;
                  });
                };

                return usedGuides.map((g, gi) => {
                  const gKey = `${g.block_index}-${g.subtitle}`;
                  const gEditedText = hlEdits[gKey];
                  const gHasEdit = gEditedText && gEditedText !== g.subtitle;
                  const displaySubtitle = gHasEdit ? gEditedText : g.subtitle;
                  const canUp = gi > 0;
                  const canDown = gi < usedGuides.length - 1;
                  const marker = hlMarkers[gKey];
                  const markerColor = marker?.color;
                  const mc = markerColor ? MARKER_COLORS[markerColor] : null;
                  const isActiveMatch = matchingMode?.key === gKey;
                  // 타입별 기본 색상 — C_user만 자료(주황), AI 생성 C는 자막(초록)
                  const isUserMaterial = g.type?.startsWith("C_user");
                  const typeColor = isUserMaterial ? "#F97316" : g.type?.charAt(0) === "B" ? "#3B82F6" : "#22C55E";
                  const typeBgLight = isUserMaterial ? "rgba(249,115,22,0.06)" : g.type?.charAt(0) === "B" ? "rgba(59,130,246,0.06)" : "rgba(34,197,94,0.06)";
                  const typeBorder = isUserMaterial ? "rgba(249,115,22,0.3)" : g.type?.charAt(0) === "B" ? "rgba(59,130,246,0.3)" : "rgba(34,197,94,0.3)";

                  return <div key={`inline-${gi}`} style={{margin:"2px 16px 4px",padding:"8px 12px",borderRadius:8,
                    border:`1px solid ${mc ? mc.border : typeBorder}`,
                    background:mc ? mc.bg.replace("0.3","0.08") : typeBgLight,
                    display:"flex",alignItems:"center",gap:8,
                    boxShadow:isActiveMatch?`0 0 0 2px ${mc?.border||C.ac}`:"none",
                    transition:"all 0.15s"}}>
                    {/* 순서 변경 화살표 (2개 이상일 때만 표시) */}
                    {usedGuides.length > 1 && <div style={{display:"flex",flexDirection:"column",gap:1,flexShrink:0}}>
                      <button onClick={e=>{e.stopPropagation();if(canUp)swapInHl(g,usedGuides[gi-1])}}
                        disabled={!canUp}
                        style={{fontSize:9,lineHeight:1,padding:"1px 4px",border:"none",borderRadius:3,
                          background:canUp?"rgba(255,255,255,0.08)":"transparent",
                          color:canUp?C.txM:"transparent",cursor:canUp?"pointer":"default"}}>▲</button>
                      <button onClick={e=>{e.stopPropagation();if(canDown)swapInHl(g,usedGuides[gi+1])}}
                        disabled={!canDown}
                        style={{fontSize:9,lineHeight:1,padding:"1px 4px",border:"none",borderRadius:3,
                          background:canDown?"rgba(255,255,255,0.08)":"transparent",
                          color:canDown?C.txM:"transparent",cursor:canDown?"pointer":"default"}}>▼</button>
                    </div>}
                    <span style={{fontSize:11,color:mc?.border||typeColor,fontWeight:700,flexShrink:0}}>▶</span>
                    <TypeBadge type={g.type} onChangeType={(newCat)=>{
                      setHl(prev => prev.map(h => h === g ? {...h, type: newCat + (g.type?.slice(1)||"1")} : h));
                    }}/>
                    <div style={{flex:1,fontSize:13,fontWeight:500,color:mc?.border||typeColor,lineHeight:1.4,whiteSpace:"pre-line"}}>
                      {displaySubtitle}
                    </div>
                    {/* 형광펜 색상 선택 */}
                    <div style={{display:"flex",gap:2,flexShrink:0}}>
                      {Object.entries(MARKER_COLORS).filter(([,cv]) => !cv._hidden).map(([colorKey, cv]) => (
                        <button key={colorKey} onClick={e=>{e.stopPropagation();
                          if (isActiveMatch && matchingMode.color === colorKey) {
                            // 같은 색 다시 클릭 → 매칭 모드 해제
                            setMatchingMode(null);
                          } else {
                            // 매칭 모드 활성화: 이 자막의 블록에서 드래그 가능
                            setMatchingMode({ key: gKey, color: colorKey, blockIdx: g.block_index });
                          }
                        }}
                        title={`${cv.label} 형광펜${markerColor===colorKey?" (선택됨)":""}`}
                        style={{width:16,height:16,borderRadius:3,border:`2px solid ${
                          isActiveMatch && matchingMode.color===colorKey ? "#fff" :
                          markerColor===colorKey ? cv.border : "transparent"}`,
                          background:cv.bg.replace("0.3","0.6"),cursor:"pointer",
                          boxShadow:isActiveMatch && matchingMode.color===colorKey?"0 0 4px rgba(255,255,255,0.5)":"none",
                          transition:"all 0.12s"}}/>
                      ))}
                      {/* 형광펜 지우기 */}
                      {marker && <button onClick={e=>{e.stopPropagation();handleMarkerClear(gKey);setMatchingMode(null)}}
                        title="형광펜 지우기"
                        style={{fontSize:9,lineHeight:1,padding:"2px 4px",border:`1px solid ${C.bd}`,borderRadius:3,
                          background:"rgba(255,255,255,0.06)",color:C.txD,cursor:"pointer"}}>✕</button>}
                    </div>
                    {/* 복사 버튼 */}
                    <button onClick={e=>{e.stopPropagation();
                      navigator.clipboard.writeText(displaySubtitle);
                      const btn=e.currentTarget;btn.textContent="✓";
                      setTimeout(()=>{btn.textContent="복사"},1200);
                    }} style={{fontSize:10,fontWeight:600,padding:"3px 8px",borderRadius:4,border:`1px solid ${C.bd}`,
                      background:"rgba(255,255,255,0.06)",color:C.txM,cursor:"pointer",flexShrink:0,
                      minWidth:36,transition:"all 0.15s"}}>복사</button>
                  </div>;
                });
              })()}
              {/* 선택된 블록에 자막 추가 버튼 */}
              {aBlock===b.index && addingAt!==b.index && (
                <div style={{padding:"4px 16px 8px",display:"flex",justifyContent:"flex-end"}}>
                  <button onClick={e=>{e.stopPropagation();setAddingAt(b.index);setAddForm({subtitle:"",type:"A1"})}}
                    style={{fontSize:11,fontWeight:600,padding:"4px 12px",borderRadius:6,
                      border:`1px dashed ${C.hBd}`,background:"rgba(168,85,247,0.08)",
                      color:C.hBd,cursor:"pointer"}}>+ 자막 추가</button>
                </div>
              )}
              {/* 자막 추가 입력 폼 */}
              {addingAt===b.index && (
                <div onClick={e=>e.stopPropagation()} style={{margin:"0 16px 10px",padding:12,borderRadius:10,
                  border:`1px solid ${C.hBd}`,background:"rgba(168,85,247,0.06)"}}>
                  <div style={{display:"flex",gap:6,marginBottom:8}}>
                    {[["A1","강조자막"],["B2","용어 설명"],["C_user1","자료"]].map(([t,l])=>
                      <button key={t} onClick={()=>setAddForm(f=>({...f,type:t}))}
                        style={{fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:5,cursor:"pointer",
                          border:`1px solid ${addForm.type===t?C.hBd:"transparent"}`,
                          background:addForm.type===t?"rgba(168,85,247,0.15)":"rgba(255,255,255,0.04)",
                          color:addForm.type===t?C.hBd:C.txD}}>{l}</button>)}
                  </div>
                  {/* B2 용어 설명: 용어 입력 + AI 생성 */}
                  {addForm.type==="B2" && (
                    <div style={{display:"flex",gap:4,marginBottom:6}}>
                      <input value={addForm.termInput||""} onChange={e=>setAddForm(f=>({...f,termInput:e.target.value}))}
                        placeholder="용어를 입력하세요 (예: 에이전트)"
                        style={{flex:1,padding:"5px 8px",borderRadius:6,border:`1px solid ${C.bd}`,
                          background:"rgba(0,0,0,0.3)",color:C.tx,fontSize:12,outline:"none"}}
                        onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();handleTermGen();}}}/>
                      <button onClick={handleTermGen} disabled={addForm.generating}
                        style={{fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:5,border:"none",
                          background:addForm.generating?"rgba(59,130,246,0.3)":"rgba(59,130,246,0.8)",
                          color:"#fff",cursor:addForm.generating?"not-allowed":"pointer",whiteSpace:"nowrap"}}>
                        {addForm.generating?"생성 중...":"AI 설명 생성"}</button>
                    </div>
                  )}
                  <textarea value={addForm.subtitle} onChange={e=>setAddForm(f=>({...f,subtitle:e.target.value}))}
                    placeholder={addForm.type==="B2"?"용어(English) : 설명":addForm.type==="C1"?"자료 내용 (예: 관련 기사 캡쳐 이미지)":"강조자막 내용"}
                    rows={2} autoFocus={addForm.type!=="B2"}
                    style={{width:"100%",padding:"6px 8px",borderRadius:6,border:`1px solid ${C.bd}`,
                      background:"rgba(0,0,0,0.3)",color:C.tx,fontSize:13,fontFamily:"'Pretendard',sans-serif",
                      lineHeight:1.5,resize:"vertical",outline:"none"}}
                    onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();handleAddSubtitle();}if(e.key==="Escape")setAddingAt(null);}}/>
                  <div style={{display:"flex",gap:4,marginTop:6,justifyContent:"flex-end"}}>
                    <button onClick={()=>setAddingAt(null)}
                      style={{fontSize:11,padding:"3px 10px",borderRadius:4,border:`1px solid ${C.bd}`,
                        background:"transparent",color:C.txM,cursor:"pointer"}}>취소</button>
                    <button onClick={handleAddSubtitle}
                      style={{fontSize:11,padding:"3px 10px",borderRadius:4,border:"none",
                        background:C.hBd,color:"#fff",fontWeight:600,cursor:"pointer"}}>추가</button>
                  </div>
                </div>
              )}
            </div>})}
          {/* 텍스트 선택 팝업 */}
          {selPopup && <div style={{position:"fixed",left:selPopup.x-60,top:selPopup.y-50,zIndex:100,
            background:C.sf,border:`2px solid ${C.ac}`,borderRadius:10,padding:"8px 12px",
            boxShadow:"0 6px 20px rgba(0,0,0,0.4)",display:"flex",gap:8,alignItems:"center"}}>
            <button onClick={()=>handlePartialGenerate(selPopup.blockIdx, selPopup.text)}
              disabled={partialBusy}
              style={{padding:"6px 14px",borderRadius:6,border:"none",
                background:`linear-gradient(135deg,${C.ac},#7C3AED)`,color:"#fff",fontSize:12,fontWeight:700,
                cursor:partialBusy?"wait":"pointer",opacity:partialBusy?0.6:1}}>
              {partialBusy ? "⏳ 생성 중..." : "✨ 이 구간으로 자막 생성"}
            </button>
            <button onClick={()=>setSelPopup(null)}
              style={{background:"none",border:"none",color:C.txD,cursor:"pointer",fontSize:14}}>✕</button>
          </div>}
          {partialBusy && <div style={{padding:"8px 16px",background:"rgba(74,108,247,0.1)",
            borderTop:`1px solid ${C.ac}`,fontSize:12,color:C.ac,textAlign:"center"}}>
            ⏳ 부분 강조자막 생성 중...
          </div>}
          </div>
          <div ref={rRef} data-scroll-container style={{width:400,minWidth:400,overflowY:"auto",background:"rgba(0,0,0,0.12)"}}>
            <div style={{padding:"8px 14px",fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",
              letterSpacing:"0.08em",borderBottom:`1px solid ${C.bd}`,position:"sticky",top:0,background:C.sf,zIndex:2,
              display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span>강조자막 가이드</span>
              {!guides.length && !gBusy && <button onClick={handleGuide}
                style={{fontSize:10,fontWeight:600,padding:"3px 10px",borderRadius:5,border:"none",
                  background:`linear-gradient(135deg,${C.ac},#7C3AED)`,color:"#fff",cursor:"pointer"}}>
                일괄 생성하기
              </button>}
            </div>
            <div style={{padding:"6px 10px"}}>
              {!guides.length && <p style={{padding:20,textAlign:"center",fontSize:12,color:C.txD}}>항목 없음</p>}
              {guides.map((g,i)=><div key={`hl-${i}`} data-hl-block={g.block_index}>
                <GuideCard item={g}
                blocks={blocks}
                active={aBlock===g.block_index}
                onClick={g2=>scrollTo(g2.block_index)}
                verdict={hlVerdicts[`${g.block_index}-${g.subtitle}`]}
                onVerdict={(item, v) => {
                  const key = `${item.block_index}-${item.subtitle}`;
                  const prevVerdict = hlVerdicts[key];
                  setHlVerdicts(prev => ({...prev, [key]: v}));
                  // "사용" → 다른 상태로 변경 시 형광펜 제거
                  if (prevVerdict === "use" && v !== "use") {
                    setHlMarkers(prev => { const next = {...prev}; delete next[key]; return next; });
                    if (matchingMode?.key === key) setMatchingMode(null);
                  }
                }}
                editedText={hlEdits[`${g.block_index}-${g.subtitle}`]}
                onEdit={(item, text) => setHlEdits(prev => {
                  const key = `${item.block_index}-${item.subtitle}`;
                  const next = {...prev};
                  if (text === null) delete next[key]; else next[key] = text;
                  return next;
                })}
                onRelocate={(item, newIdx) => {
                  // block_index 변경 → hl 배열에서 해당 아이템의 block_index 업데이트
                  // verdict/edit 키도 함께 이전
                  const oldKey = `${item.block_index}-${item.subtitle}`;
                  const newKey = `${newIdx}-${item.subtitle}`;
                  setHl(prev => prev.map(h =>
                    h === item ? {...h, block_index: newIdx} : h
                  ));
                  setHlVerdicts(prev => {
                    const next = {...prev};
                    if (next[oldKey] !== undefined) { next[newKey] = next[oldKey]; delete next[oldKey]; }
                    return next;
                  });
                  setHlEdits(prev => {
                    const next = {...prev};
                    if (next[oldKey] !== undefined) { next[newKey] = next[oldKey]; delete next[oldKey]; }
                    return next;
                  });
                }}
                onChangeType={(newCat) => {
                  setHl(prev => prev.map(h => h === g ? {...h, type: newCat + (g.type?.slice(1)||"1")} : h));
                }}
                onDelete={(item) => {
                  const key = `${item.block_index}-${item.subtitle}`;
                  setHl(prev => prev.filter(h => h !== item));
                  setHlVerdicts(prev => { const next = {...prev}; delete next[key]; return next; });
                  setHlEdits(prev => { const next = {...prev}; delete next[key]; return next; });
                  setHlMarkers(prev => { const next = {...prev}; delete next[key]; return next; });
                  if (matchingMode?.key === key) setMatchingMode(null);
                }}
              />
              </div>)}
            </div>
          </div>
        </div>}
        {gReady && <div style={{display:"flex",gap:20,padding:"10px 20px",background:C.sf,borderTop:`1px solid ${C.bd}`,
          fontSize:13,color:C.txM,flexShrink:0}}>
          <span>강조자막: <b style={{color:C.hBd}}>{hl.length}</b></span>
          {hlStats && <>
            <span style={{color:C.txD}}>|</span>
            <span style={{fontSize:12}}>Draft {hlStats.draft_count}건 → Final {hlStats.final_count}건 ({hlStats.removal_rate} 필터링)</span>
          </>}
          {(() => {
            const vals = Object.values(hlVerdicts).filter(Boolean);
            const useC = vals.filter(v=>v==="use").length;
            const disC = vals.filter(v=>v==="discard").length;
            const unchk = hl.length - useC - disC;
            if (useC + disC === 0) return null;
            return <>
              <span style={{color:C.txD}}>|</span>
              <span style={{fontSize:12}}>
                <span style={{color:"#22C55E"}}>사용 {useC}</span>
                {" · "}<span style={{color:"#EF4444"}}>폐기 {disC}</span>
                {" · "}<span style={{color:C.txD}}>미선택 {unchk}</span>
              </span>
            </>;
          })()}
        </div>}
      </>}
    </main>

    {showSet && <SettingsModal config={cfg} onSave={saveCfg} onClose={()=>setShowSet(false)}/>}
    {shareUrl && <ShareModal shareUrl={shareUrl} onClose={()=>setShareUrl(null)}/>}
    {showSessions && <SessionListModal config={cfg} onClose={()=>setShowSessions(false)}
      onLoad={async(id)=>{
        setShowSessions(false);
        setBusy(true); setProg({p:30,l:"세션 불러오는 중..."});
        try {
          const data = await apiLoadSession(id, cfg);
          setBlocks(data.blocks || []);
          setAnal(data.anal || null);
          setDiffs(data.diffs || []);
          setHl(data.hl || []);
          setHlStats(data.hlStats || null);
          setHlVerdicts(data.hlVerdicts || {}); setHlEdits(data.hlEdits || {}); setHlMarkers(data.hlMarkers || {}); setScriptEdits(data.scriptEdits || {}); setReviewData(data.reviewData || null);
          setFn(data.fn || "");
          setSessionId(id);
          setGReady((data.hl?.length > 0));
          setTab(data.hl?.length > 0 ? "guide" : data.reviewData ? "review" : "correction");
          window.history.replaceState({}, "", `${window.location.pathname}?s=${id}`);
          setProg({p:100,l:"✅ 세션 로드 완료"});
        } catch(e) { setErr(e.message); }
        finally { setBusy(false); }
      }}
    />}

<style>{`
      @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');
      *{box-sizing:border-box;margin:0;padding:0}
      
      ::-webkit-scrollbar { width: 10px; height: 10px; }
      ::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.03); }
      ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); border-radius: 5px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.4); }
      
      body{overflow:hidden}
    `}</style>
  </div>;
}

function delay(ms){return new Promise(r=>setTimeout(r,ms))}
