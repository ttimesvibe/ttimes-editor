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
