// ═══════════════════════════════════════════════
// docxParser 회귀 방지 테스트
// 실행: node --test docs/src/utils/docxParser.test.js
//
// 배경: 2026-04-24 `260423_4월 국제 싱크(제미나이 초벌).docx` 에서 발생한
// 삭제선 오인식 버그. self-closing <w:del .../> (단락 마크 삭제 표시) 이
// 있을 때 정규식 `<w:del[^>]*>...</w:del>` 이 self-closing 의 `/` 까지
// `[^>]*` 로 흡수해 버려 다음 </w:del> 까지의 본문 전체를 "삭제"로 오인식.
// 수정: self-closing del/ins 를 우선 매칭해서 소비(skip).
// 커밋 4c55b05.
// ═══════════════════════════════════════════════

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBodyXml,
  extractTextFromRun,
  extractTextFromRuns,
  computeBlockStrikes,
} from "./docxParser.js";

// ── 도우미: w:r 래퍼 ─────────────────────────
const run = (text) => `<w:r><w:t>${text}</w:t></w:r>`;
const runDel = (text) => `<w:r><w:delText>${text}</w:delText></w:r>`;
const para = (...children) => `<w:p>${children.join("")}</w:p>`;

// ═══════════════════════════════════════════════
test("extractTextFromRun: w:t + w:br 순서 보존", () => {
  const xml = `<w:r><w:t>첫째</w:t><w:br/><w:t>둘째</w:t></w:r>`;
  assert.equal(extractTextFromRun(xml), "첫째\n둘째");
});

test("extractTextFromRun: w:delText 도 텍스트로 추출", () => {
  const xml = `<w:r><w:delText>삭제된텍스트</w:delText></w:r>`;
  assert.equal(extractTextFromRun(xml), "삭제된텍스트");
});

test("extractTextFromRuns: 여러 w:r 이어붙이기", () => {
  const xml = `${run("A")}${run("B")}${run("C")}`;
  assert.equal(extractTextFromRuns(xml), "ABC");
});

// ═══════════════════════════════════════════════
// 핵심 회귀 방지 — self-closing w:del
// ═══════════════════════════════════════════════
test("self-closing <w:del .../> 은 후속 텍스트를 삼키지 않는다 (회귀 방지)", () => {
  // 단락 마크 삭제 표시(self-closing) 뒤에 일반 텍스트. 버그 시점에는
  // 이 self-closing 이 다음 </w:del> 로 착각되어 그 사이 전체가 삭제로 분류됐음.
  const body = para(
    `<w:del w:id="1" w:author="X" w:date="2026-04-24T00:00:00Z"/>`,
    run("보존되어야 하는 정상 텍스트"),
    run(" 그리고 이어지는 텍스트"),
  );
  const paragraphs = parseBodyXml(body);
  assert.equal(paragraphs.length, 1);
  const segs = paragraphs[0];
  // 모든 세그먼트는 deleted=false 여야 함
  for (const s of segs) assert.equal(s.deleted, false, `"${s.text}" 가 삭제로 오분류됨`);
  const joined = segs.map(s => s.text).join("");
  assert.equal(joined, "보존되어야 하는 정상 텍스트 그리고 이어지는 텍스트");
});

test("self-closing <w:ins .../> 도 동일하게 skip", () => {
  const body = para(
    `<w:ins w:id="2" w:author="X" w:date="2026-04-24T00:00:00Z"/>`,
    run("일반 텍스트"),
  );
  const paragraphs = parseBodyXml(body);
  assert.equal(paragraphs[0][0].text, "일반 텍스트");
  assert.equal(paragraphs[0][0].deleted, false);
});

test("paired <w:del>…</w:del> 는 여전히 삭제로 표시", () => {
  const body = para(
    run("앞부분 "),
    `<w:del w:id="3" w:author="X" w:date="2026-04-24T00:00:00Z">${runDel("삭제된구간")}</w:del>`,
    run(" 뒷부분"),
  );
  const paragraphs = parseBodyXml(body);
  const segs = paragraphs[0];
  assert.equal(segs.length, 3);
  assert.equal(segs[0].text, "앞부분 "); assert.equal(segs[0].deleted, false);
  assert.equal(segs[1].text, "삭제된구간"); assert.equal(segs[1].deleted, true);
  assert.equal(segs[2].text, " 뒷부분"); assert.equal(segs[2].deleted, false);
});

test("paired <w:ins>…</w:ins> 는 삽입으로 표시 (deleted=false)", () => {
  const body = para(
    run("기존 "),
    `<w:ins w:id="4" w:author="X" w:date="2026-04-24T00:00:00Z">${run("추가된텍스트")}</w:ins>`,
  );
  const paragraphs = parseBodyXml(body);
  const segs = paragraphs[0];
  assert.equal(segs[0].text, "기존 "); assert.equal(segs[0].deleted, false);
  assert.equal(segs[1].text, "추가된텍스트"); assert.equal(segs[1].deleted, false);
});

test("일반 <w:r> + <w:strike/> 는 삭제로 표시", () => {
  const body = para(
    `<w:r><w:rPr><w:strike/></w:rPr><w:t>취소선문장</w:t></w:r>`,
    run("일반문장"),
  );
  const paragraphs = parseBodyXml(body);
  assert.equal(paragraphs[0][0].text, "취소선문장");
  assert.equal(paragraphs[0][0].deleted, true);
  assert.equal(paragraphs[0][1].text, "일반문장");
  assert.equal(paragraphs[0][1].deleted, false);
});

test("self-closing 과 paired 가 섞여도 정확한 segment 순서·삭제 flag", () => {
  // 실제 docx 에서 관찰된 패턴: 단락 마크 삭제 표시와 인라인 삭제가 혼재
  const body = para(
    run("머리 "),
    `<w:del w:id="10"/>`,                                   // self-closing → skip
    run("중간1 "),
    `<w:del w:id="11"><w:r><w:delText>삭제A</w:delText></w:r></w:del>`,
    run(" 중간2 "),
    `<w:ins w:id="12"/>`,                                   // self-closing → skip
    `<w:ins w:id="13"><w:r><w:t>삽입B</w:t></w:r></w:ins>`,
    run(" 꼬리"),
  );
  const paragraphs = parseBodyXml(body);
  const segs = paragraphs[0];
  assert.deepEqual(
    segs.map(s => ({ t: s.text, d: s.deleted })),
    [
      { t: "머리 ", d: false },
      { t: "중간1 ", d: false },
      { t: "삭제A", d: true },
      { t: " 중간2 ", d: false },
      { t: "삽입B", d: false },
      { t: " 꼬리", d: false },
    ],
  );
});

test("여러 단락 분리 처리", () => {
  const body = `${para(run("단락1"))}${para(run("단락2"))}`;
  const paragraphs = parseBodyXml(body);
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0][0].text, "단락1");
  assert.equal(paragraphs[1][0].text, "단락2");
});

// ═══════════════════════════════════════════════
// computeBlockStrikes — 블록별 삭제 구간 매핑
// ═══════════════════════════════════════════════
test("computeBlockStrikes: 블록 내 삭제 문자 구간 정확 매핑", () => {
  const paragraphs = [[
    { text: "앞부분 ", deleted: false },
    { text: "삭제구간", deleted: true },
    { text: " 뒷부분", deleted: false },
  ]];
  const fullText = "앞부분 삭제구간 뒷부분";
  const reviewBlocks = [{ index: 0, text: fullText }];
  const { blockStrikeRanges, deletedBlockIndices } = computeBlockStrikes(paragraphs, reviewBlocks, fullText);
  assert.deepEqual(blockStrikeRanges[0], [{ s: 4, e: 8 }]);  // "삭제구간"
  assert.deepEqual(deletedBlockIndices, []);                  // 80% 미만이라 통째 삭제 아님
});

test("computeBlockStrikes: 80% 이상 삭제된 블록은 deletedBlockIndices 에", () => {
  const paragraphs = [[
    { text: "전부삭제문장입니다", deleted: true },
    { text: "끝", deleted: false },
  ]];
  const fullText = "전부삭제문장입니다끝";
  const reviewBlocks = [{ index: 0, text: fullText }];
  const { deletedBlockIndices } = computeBlockStrikes(paragraphs, reviewBlocks, fullText);
  assert.deepEqual(deletedBlockIndices, [0]);
});
