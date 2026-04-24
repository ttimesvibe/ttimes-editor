// ═══════════════════════════════════════════════
// 0차 단계: DOCX 삭제선(w:del) 파싱 + 분량 계산
// ═══════════════════════════════════════════════

import JSZip from "jszip";

// Word "검토 모드" 변경 추적 — 삭제된 텍스트(w:del)를 마커로 표시하여 추출
export async function parseDocxWithTrackChanges(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("word/document.xml을 찾을 수 없습니다");

  // XML에서 본문(w:body) 추출
  const bodyMatch = docXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) throw new Error("문서 본문을 찾을 수 없습니다");
  const bodyXml = bodyMatch[1];

  // 순수 함수로 위임 (테스트 가능)
  const paragraphs = parseBodyXml(bodyXml);

  // 삭제선 존재 여부 체크
  const hasTrackChanges = paragraphs.some(p => p.some(s => s.deleted));

  // 전체 텍스트 (삭제선 포함) — 마커 형식으로 변환
  // 삭제선 없는 순수 텍스트 (기존 mammoth 동작과 동일)
  const fullText = paragraphs.map(p => p.map(s => s.text).join("")).join("\n");
  const cleanText = paragraphs.map(p => p.filter(s => !s.deleted).map(s => s.text).join("")).join("\n");

  return { paragraphs, hasTrackChanges, fullText, cleanText };
}

// ═══════════════════════════════════════════════
// 본문 XML(w:body 내부) → paragraphs 변환 — 순수 함수 (테스트 대상)
// paragraphs: Array<Array<{text, deleted}>>
// ═══════════════════════════════════════════════
export function parseBodyXml(bodyXml) {
  const paragraphs = [];
  const pRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyXml)) !== null) {
    const pXml = pMatch[0];
    const segments = []; // {text, deleted}

    // w:del (삭제된 텍스트) 과 w:ins (삽입된 텍스트) 와 일반 w:r을 순서대로 파싱.
    // ⚠️ self-closing <w:del .../> 과 <w:ins .../> 는 단락 마크 삭제/삽입 표시로
    //    본문 텍스트에 영향 없음. 반드시 먼저 소비(skip)해야 이후의 opening/closing
    //    매칭이 self-closing의 `/`까지 `[^>]*`로 흡수해 다음 </w:del>까지 swallow 하는
    //    버그를 피할 수 있음 (삭제선 오인식/shift 증상 원인). 회귀 방지 테스트:
    //    docxParser.test.js `self-closing w:del 은 후속 텍스트를 삼키지 않는다`.
    const tokenRegex = /<w:del\b[^>]*\/>|<w:ins\b[^>]*\/>|<w:del\b[^>]*>([\s\S]*?)<\/w:del>|<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>|<w:r[ >]([\s\S]*?)<\/w:r>/g;
    let tMatch;
    while ((tMatch = tokenRegex.exec(pXml)) !== null) {
      // self-closing del/ins 는 skip (tMatch[1..3] 전부 undefined)
      if (tMatch[1] === undefined && tMatch[2] === undefined && tMatch[3] === undefined) continue;
      if (tMatch[1] !== undefined) {
        const delText = extractTextFromRuns(tMatch[1]);
        if (delText) segments.push({ text: delText, deleted: true });
      } else if (tMatch[2] !== undefined) {
        const insText = extractTextFromRuns(tMatch[2]);
        if (insText) segments.push({ text: insText, deleted: false });
      } else if (tMatch[3] !== undefined) {
        const runContent = tMatch[3];
        const runText = extractTextFromRun(runContent);
        const isStrike = /<w:strike\/>/.test(runContent);
        if (runText) segments.push({ text: runText, deleted: isStrike });
      }
    }

    if (segments.length > 0) paragraphs.push(segments);
  }
  return paragraphs;
}

// w:r 태그들에서 텍스트 추출
export function extractTextFromRuns(xml) {
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
export function extractTextFromRun(runXml) {
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

// paragraphs(track changes 세그먼트)와 reviewBlocks를 받아 블록별 삭제 구간 계산
// 반환: { blockStrikeRanges, deletedBlockIndices } — 0차 검토 화면 렌더링에 사용
//   blockStrikeRanges: { [blockIndex]: [{s, e}, ...] }  — 블록 텍스트 내 삭제 문자 구간
//   deletedBlockIndices: number[] — 80% 이상 삭제된 블록 인덱스
export function computeBlockStrikes(paragraphs, reviewBlocks, fullText) {
  // paragraphs → charMap: fullText의 각 문자에 대한 deleted 여부
  const charMap = [];
  for (let pi = 0; pi < paragraphs.length; pi++) {
    for (const seg of paragraphs[pi]) {
      for (let ci = 0; ci < seg.text.length; ci++) {
        charMap.push(seg.deleted);
      }
    }
    if (pi < paragraphs.length - 1) charMap.push(false); // 단락 사이 \n
  }

  const blockStrikeRanges = {};
  const deletedBlockIndices = new Set();
  let searchFrom = 0;

  for (const rb of reviewBlocks) {
    const blockStart = fullText.indexOf(rb.text, searchFrom);
    if (blockStart === -1) continue;
    searchFrom = blockStart + rb.text.length;

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
    const textLen = rb.text.replace(/\s/g, "").length;
    if (textLen > 0 && deletedCount >= textLen * 0.8) deletedBlockIndices.add(rb.index);
  }

  return { blockStrikeRanges, deletedBlockIndices: [...deletedBlockIndices] };
}
