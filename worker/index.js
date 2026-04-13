// ttimes-editor — Cloudflare Worker
// 8개 엔드포인트: /analyze, /correct, /highlights, /visuals, /insert-cuts, /save, /load/:id, /save-image
// OpenAI GPT-5.1 API 프록시 + CORS 완전 제어 + KV 세션 저장
// /correct: v4 통합 교정 (필러+용어+맞춤법+구어체 단일 호출 + 코드 검증)
// /highlights: v2 룰북 기반 2-Pass (Draft Agent → Editor Agent) + 청크 분할 지원

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

if (path === "/debug-location") {
      return new Response(JSON.stringify({ colo: request.cf?.colo, country: request.cf?.country, city: request.cf?.city }), { headers: corsHeaders });
    }

    // /image/{sessionId}/{cardId} — 이미지 GET/DELETE
    const imageMatch = path.match(/^\/image\/([a-zA-Z0-9]+)\/([a-zA-Z0-9]+)$/);
    if (imageMatch) {
      if (request.method === "GET") return await handleImageGet(imageMatch[1], imageMatch[2], env, corsHeaders);
      if (request.method === "DELETE") return await handleImageDelete(imageMatch[1], imageMatch[2], env, corsHeaders);
    }

    // /load/{id}/{tab} — 특정 탭 데이터 로드 (tab-based)
    const loadTabMatch = path.match(/^\/load\/([a-zA-Z0-9]+)\/([a-z]+)$/);
    if (loadTabMatch && request.method === "GET") {
      return await handleLoadTab(loadTabMatch[1], loadTabMatch[2], env, corsHeaders);
    }

    // /load/{id} — 메타 반환 (어떤 탭이 존재하는지) + 레거시 폴백
    const loadMatch = path.match(/^\/load\/([a-zA-Z0-9]+)$/);
    if (loadMatch && request.method === "GET") {
      return await handleLoadMeta(loadMatch[1], env, corsHeaders);
    }

    // /dict — 팀 공유 단어장 (GET: 불러오기, POST: 저장)
    if (path === "/dict" && request.method === "GET") {
      return await handleDictGet(env, corsHeaders);
    }

    // /sessions — 세션 목록 조회
    if (path === "/sessions" && request.method === "GET") {
      return await handleSessionList(env, corsHeaders);
    }

    // /sessions/delete — 세션 삭제
    if (path === "/sessions/delete" && request.method === "POST") {
      try {
        const body = await request.json();
        return await handleSessionDelete(body, env, corsHeaders);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    try {
      const body = await request.json();

      if (path === "/save-image") return await handleSaveImage(body, env, corsHeaders);
      if (path === "/dict") return await handleDictPost(body, env, corsHeaders);
      else if (path === "/save") return await handleSave(body, env, corsHeaders);
      else if (path === "/autosave") return await handleAutoSave(body, env, corsHeaders);
      else if (path === "/save-legacy") return await handleSaveLegacy(body, env, corsHeaders);
      else if (path === "/analyze") return await handleAnalyze(body, env, corsHeaders);
      else if (path === "/correct") return await handleCorrect(body, env, corsHeaders);
      else if (path === "/subtitle-format") return await handleSubtitleFormat(body, env, corsHeaders);
      else if (path === "/highlights") return await handleHighlights(body, env, corsHeaders);
      else if (path === "/term-explain") return await handleTermExplain(body, env, corsHeaders);
      else if (path === "/visuals") return await handleVisuals(body, env, corsHeaders);
      else if (path === "/insert-cuts") return await handleInsertCuts(body, env, corsHeaders);
      else if (path === "/hl-recommend") return await handleHlRecommend(body, env, corsHeaders);
      else if (path === "/hl-timestamps") return await handleHlTimestamps(body, env, corsHeaders);
      else if (path === "/setgen") return await handleSetgen(body, env, corsHeaders);
      else return new Response(JSON.stringify({ error: "Unknown endpoint" }), { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  },
};

// ═══════════════════════════════════════
// /save, /load
// ═══════════════════════════════════════

// ── 탭별 저장 (새 스키마) ──
async function handleSave(body, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const id = body.id || Array.from(crypto.getRandomValues(new Uint8Array(5))).map(b => b.toString(36)).join("").slice(0, 8);
  const tab = body.tab; // "correction"|"highlight"|"setgen"|"metadata"|"manuscript"|"subtitle"|"review"
  const data = body.data;
  const savedAt = new Date().toISOString();

  if (tab && data) {
    // ── 탭별 저장 (새 구조) ──
    await env.SESSIONS.put(`s:${id}:${tab}`, JSON.stringify({ ...data, savedAt }), { expirationTtl: 60*60*24*365 });

    // meta 업데이트
    let meta;
    try {
      const raw = await env.SESSIONS.get(`s:${id}:meta`);
      meta = raw ? JSON.parse(raw) : {};
    } catch { meta = {}; }
    if (!meta.sessionId) meta.sessionId = id;
    if (!meta.createdAt) meta.createdAt = savedAt;
    meta.updatedAt = savedAt;
    meta.updatedBy = "editor";
    meta.schemaVersion = "1.0";
    if (body.fn) meta.fn = body.fn;
    if (!meta.stages) meta.stages = {};
    meta.stages[tab] = { status: body.status || "완료", updatedAt: savedAt };
    await env.SESSIONS.put(`s:${id}:meta`, JSON.stringify(meta), { expirationTtl: 60*60*24*365 });

    // 세션 인덱스 업데이트
    try {
      const indexData = await env.SESSIONS.get("session_index");
      const index = indexData ? JSON.parse(indexData) : [];
      const existing = index.findIndex(s => s.id === id);
      const entry = { id, fn: meta.fn || body.fn || "제목 없음", savedAt, tab, schema: "v2" };
      if (existing >= 0) index[existing] = { ...index[existing], ...entry };
      else index.unshift(entry);
      await env.SESSIONS.put("session_index", JSON.stringify(index.slice(0, 200)));
    } catch (e) { console.error("세션 인덱스 업데이트 실패:", e.message); }

    return new Response(JSON.stringify({ success: true, id }), { headers });
  }

  // ── 레거시 폴백: tab 없이 전체 데이터 저장 ──
  return await handleSaveLegacy(body, env, headers);
}

// 레거시 단일 key 저장 (하위 호환)
async function handleSaveLegacy(body, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const id = body.id || Array.from(crypto.getRandomValues(new Uint8Array(5))).map(b => b.toString(36)).join("").slice(0, 8);
  const { id: _discardId, ...dataWithoutId } = body;
  const savedAt = new Date().toISOString();
  await env.SESSIONS.put("save_" + id, JSON.stringify({ ...dataWithoutId, savedAt }), { expirationTtl: 60*60*24*365 });

  try {
    const indexData = await env.SESSIONS.get("session_index");
    const index = indexData ? JSON.parse(indexData) : [];
    const existing = index.findIndex(s => s.id === id);
    const entry = { id, fn: body.fn || "제목 없음", savedAt, blockCount: body.blocks?.length || 0, hasGuide: (body.hl?.length || 0) > 0 };
    if (existing >= 0) index[existing] = entry;
    else index.unshift(entry);
    await env.SESSIONS.put("session_index", JSON.stringify(index.slice(0, 200)));
  } catch (e) { console.error("세션 인덱스 업데이트 실패:", e.message); }

  return new Response(JSON.stringify({ success: true, id }), { headers });
}

// 세션 목록 조회
async function handleSessionList(env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const indexData = await env.SESSIONS.get("session_index");
  const index = indexData ? JSON.parse(indexData) : [];
  return new Response(JSON.stringify({ success: true, sessions: index }), { headers });
}

// 세션 삭제 (레거시 + 탭별 key 모두 정리)
async function handleSessionDelete(body, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const { id } = body;
  if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers });
  // 레거시 key 삭제
  await env.SESSIONS.delete(id);
  await env.SESSIONS.delete("save_" + id);
  await env.SESSIONS.delete("auto_" + id);
  // 탭별 key 삭제 (새 스키마)
  const tabs = ["meta","manuscript","correction","subtitle","review","highlight","setgen","metadata"];
  await Promise.all(tabs.map(t => env.SESSIONS.delete(`s:${id}:${t}`)));
  // 인덱스에서 제거
  try {
    const indexData = await env.SESSIONS.get("session_index");
    const index = indexData ? JSON.parse(indexData) : [];
    const filtered = index.filter(s => s.id !== id);
    await env.SESSIONS.put("session_index", JSON.stringify(filtered));
  } catch (e) {}
  return new Response(JSON.stringify({ success: true }), { headers });
}

// 자동 저장 (TTL 7일) — 탭별 또는 레거시
async function handleAutoSave(body, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const id = body.id || Array.from(crypto.getRandomValues(new Uint8Array(5))).map(b => b.toString(36)).join("").slice(0, 8);
  const tab = body.tab;
  const data = body.data;
  const savedAt = new Date().toISOString();

  if (tab && data) {
    // 탭별 자동 저장
    await env.SESSIONS.put(`s:${id}:${tab}`, JSON.stringify({ ...data, savedAt }), { expirationTtl: 60*60*24*7 });
    // meta도 자동 저장
    let meta;
    try {
      const raw = await env.SESSIONS.get(`s:${id}:meta`);
      meta = raw ? JSON.parse(raw) : {};
    } catch { meta = {}; }
    if (!meta.sessionId) meta.sessionId = id;
    if (!meta.createdAt) meta.createdAt = savedAt;
    meta.updatedAt = savedAt;
    if (body.fn) meta.fn = body.fn;
    if (!meta.stages) meta.stages = {};
    meta.stages[tab] = { status: "진행중", updatedAt: savedAt };
    await env.SESSIONS.put(`s:${id}:meta`, JSON.stringify(meta), { expirationTtl: 60*60*24*7 });
    return new Response(JSON.stringify({ success: true, id }), { headers });
  }

  // 레거시 자동 저장
  const { id: _discardId, ...dataWithoutId } = body;
  await env.SESSIONS.put("auto_" + id, JSON.stringify({ ...dataWithoutId, savedAt }), { expirationTtl: 60*60*24*7 });
  return new Response(JSON.stringify({ success: true, id }), { headers });
}

// /load/{id} — 메타 반환 (새 스키마), 레거시 폴백
async function handleLoadMeta(id, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });

  // 새 스키마: s:{id}:meta 확인
  const metaRaw = await env.SESSIONS.get(`s:${id}:meta`);
  if (metaRaw) {
    const meta = JSON.parse(metaRaw);
    return new Response(JSON.stringify({ schema: "v2", ...meta }), { headers });
  }

  // 레거시 폴백: save_ → 기존 → auto_
  let data = await env.SESSIONS.get("save_" + id);
  if (!data) data = await env.SESSIONS.get(id);
  if (!data) data = await env.SESSIONS.get("auto_" + id);
  if (!data) return new Response(JSON.stringify({ error: "세션을 찾을 수 없습니다." }), { status: 404, headers });
  return new Response(data, { headers });
}

// /load/{id}/{tab} — 특정 탭 데이터 반환
async function handleLoadTab(id, tab, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const data = await env.SESSIONS.get(`s:${id}:${tab}`);
  if (!data) return new Response(JSON.stringify({ error: `탭 데이터 없음: ${tab}` }), { status: 404, headers });
  return new Response(data, { headers });
}

// ═══════════════════════════════════════
// /dict — 팀 공유 단어장
// ═══════════════════════════════════════

const DICT_KEY = "shared_dict";

async function handleDictGet(env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const data = await env.SESSIONS.get(DICT_KEY);
  const dict = data ? JSON.parse(data) : [];
  return new Response(JSON.stringify({ success: true, dict }), { headers });
}

async function handleDictPost(body, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const { dict } = body;
  if (!Array.isArray(dict)) return new Response(JSON.stringify({ error: "dict must be an array" }), { status: 400, headers });
  await env.SESSIONS.put(DICT_KEY, JSON.stringify(dict));
  return new Response(JSON.stringify({ success: true, count: dict.length }), { headers });
}

// ═══════════════════════════════════════
// OpenAI API 호출 공통 함수
// ═══════════════════════════════════════

async function callOpenAI(systemPrompt, userMessage, env, options = {}) {
  const { temperature = 0.1, max_tokens = 16000, model = "gpt-5.1", useJsonFormat = true } = options;

  const reqBody = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature,
    max_completion_tokens: max_tokens,
  };
  if (useJsonFormat) {
    reqBody.response_format = { type: "json_object" };
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(reqBody),
  });

  if (response.status === 429) {
    return { error: "Rate limited. Please wait and retry.", status: 429 };
  }

  if (!response.ok) {
    const errText = await response.text();
    return { error: `OpenAI API error ${response.status}: ${errText}`, status: response.status };
  }

  const data = await response.json();
  const finish_reason = data.choices?.[0]?.finish_reason;
  const content = data.choices?.[0]?.message?.content;

  // finish_reason: length → 출력 잘림 감지
  if (finish_reason === "length") {
    return {
      error: `출력 토큰 한계 초과 (finish_reason: length). max_tokens=${max_tokens}. 입력을 더 작게 분할해주세요.`,
      status: 413,
    };
  }

  if (!content) {
    return { error: `Empty response from OpenAI. finish_reason: ${finish_reason}. Model: ${data.model}` };
  }

  let jsonStr = content.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const braceStart = jsonStr.indexOf('{');
  const braceEnd = jsonStr.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd !== -1) {
    jsonStr = jsonStr.substring(braceStart, braceEnd + 1);
  }

  try {
    return { content: JSON.parse(jsonStr), usage: data.usage, finish_reason };
  } catch (e) {
    return { error: `JSON parse error: ${e.message}. Raw (first 300): ${content.substring(0, 300)}` };
  }
}

// ═══════════════════════════════════════
// /analyze — Step 0: 사전 분석
// ═══════════════════════════════════════

const ANALYZE_PROMPT = `You are a pre-analysis specialist for Korean interview transcripts produced by STT (Speech-to-Text).
Read the entire interview transcript below and extract the preliminary information needed for subsequent chunk-by-chunk correction.

## Information to Extract

### 1. Interview Overview
- Topic (1 line, in Korean)
- Core keywords (5–15, in Korean)

### 1-1. Editorial Summary
Provide a quick-reference summary so the editor can grasp the interview content during correction wait time.
- **One-liner**: What this interview is about, 1–2 sentences (~30 Korean chars)
- **Key points** (3–5): Major topics/arguments covered, in short sentences, listed in chronological order of the interview flow. Write in Korean.
- **Notable quotes** (2–3): Memorable verbatim quotes that could become subtitle highlights. Include the speaker name. Write in Korean.
- **Editor notes**: Technical-term-dense segments, controversial/sensitive remarks, unusual structure (demos, screen switches, etc.). 1–3 lines. Write in Korean.

### 2. Speaker Information (★ Highest Priority)
- Speaker-name lines (e.g., "홍재의 00:00", "강정수 박사님 00:25") are **manually typed by humans** and serve as the ground truth for correct names.
- Extract the name and title/affiliation separately from each speaker-name line.
  Example: "강정수 박사님 00:25" → name: "강정수", role: "박사님"
  Example: "홍재의 00:00" → name: "홍재의", role: "기자" (infer role from body text)
- Confirm the spelling from speaker-name lines as canonical. Any different spelling found in the body text is an STT misrecognition — add it to term_corrections.
  Example: Speaker line says "홍재의" but body contains "홍재희", "홍재이" → { "wrong": "홍재희", "correct": "홍재의", "confidence": "high" }

### 3. STT Misrecognition Dictionary
- Find repeatedly occurring suspected misrecognized words and build a correction mapping table.
- Include all variant forms of the same word.
- Use confidence: "low" when uncertain.
- Focus on proper nouns, IT/AI technical terms, and brand names.
- **Speaker-name misrecognitions must be included.** Use the canonical names from Section 2 and map all body-text variants.

### 4. Domain Terminology List
- Confirm correct Korean spelling with English in parentheses.

### 5. Content Genre Classification
Choose 1–2 from 7 types: 서사형, 설명형, 데모/도구활용형, 비교형, 산업/전략분석형, 역사+인물형, 기술트렌드형
Include per-segment genre transition detection.

### 6. Technical Difficulty
One of: 낮음 / 보통 / 높음 / 매우높음

## Output Format (JSON only — no other text)

{
  "overview": { "topic": "...", "keywords": ["..."] },
  "editorial_summary": {
    "one_liner": "이 인터뷰의 한 줄 요약",
    "key_points": ["핵심 논점 1", "핵심 논점 2", "핵심 논점 3"],
    "notable_quotes": [
      { "speaker": "화자명", "quote": "인상적인 발언 원문" }
    ],
    "editor_notes": "편집 시 참고사항"
  },
  "speakers": [{ "name": "화자명", "role": "역할" }],
  "term_corrections": [{ "wrong": "오인식", "correct": "올바른 표기", "confidence": "high" }],
  "domain_terms": [{ "term": "전문용어", "english": "English" }],
  "genre": {
    "primary": "설명형", "secondary": null,
    "transitions": [{ "block_range": [0, 25], "genre": "설명형" }]
  },
  "tech_difficulty": "높음",
  "audience_level": "관심 있는 비전문가"
}`;

async function handleAnalyze(body, env, headers) {
  const { full_text, dictionary_words } = body;
  if (!full_text || full_text.length < 100) {
    return new Response(JSON.stringify({ error: "full_text가 너무 짧습니다 (최소 100자)" }), { status: 400, headers });
  }

  // 단어장이 있으면 프롬프트에 추가 — AI가 중복 후보를 생성하지 않도록
  let systemPrompt = ANALYZE_PROMPT;
  if (dictionary_words?.length > 0) {
    systemPrompt += `\n\n### ★ Team Dictionary (Confirmed Correct Spellings) — MUST EXCLUDE from term_corrections ★\n`;
    systemPrompt += `The words below have already been confirmed as correct by the team.\n`;
    systemPrompt += `Do NOT include these words or their case/transliteration variants in term_corrections.\n`;
    systemPrompt += `Example: If "챗GPT" is in the dictionary, exclude "ChatGPT", "챗gpt", "챗지피티" from misrecognition candidates.\n`;
    systemPrompt += `However, phonetically unrelated STT errors (e.g., "채우지" → "챗GPT") MAY still be included.\n\n`;
    systemPrompt += `Confirmed words:\n`;
    for (const word of dictionary_words) {
      systemPrompt += `- "${word}"\n`;
    }
  }

  const userMsg = `Below is the full interview transcript. Perform the pre-analysis.\n\n---\n\n${full_text}`;
  const result = await callOpenAI(systemPrompt, userMsg, env, { temperature: 0.1, max_tokens: 8000 });

  if (result.error) return new Response(JSON.stringify({ error: result.error }), { status: result.status || 500, headers });
  return new Response(JSON.stringify({ success: true, analysis: result.content, usage: result.usage }), { headers });
}

// ═══════════════════════════════════════
// /correct — v4 통합 교정 (필러+용어+맞춤법+구어체 단일 호출)
// ═══════════════════════════════════════

const BASE_CORRECT_PROMPT = `You are a professional editor specializing in correcting Korean interview transcripts produced by STT (Speech-to-Text).
You follow the Korean National Institute of Korean Language (국립국어원) standard spelling and spacing rules.
You correct word-level errors while preserving the original conversation's content, tone, and nuance as much as possible.
Preserve the original form of technical terms and proper nouns — only fix typos.

## ★ Processing Order (follow this exact sequence)
For each block, evaluate corrections in this order:
1. STT misrecognition (§2) — fix wrong words first
2. Number notation (§3) — fix numbers
3. Spelling & spacing (§5) — fix orthography
4. Colloquial polishing (§6) — polish spoken language
5. Filler removal (§1) — remove fillers LAST, on the corrected sentence

Why this order matters: by the time you evaluate fillers, the sentence is already properly corrected.
Example: "근데 이걸 해가지고" → first §6 converts "해가지고"→"해서" and "근데"→"그런데",
then §1 checks if "그런데" is filler or meaningful connector. Since "그런데" is not in the filler list → keep it.
Result: "그런데 이걸 해서" ✅

## Scope of Work

### §1. Filler Word & Interjection Removal (processed LAST)
You MUST find and remove unnecessary interjections and habitual filler words embedded within sentences.

**Interjection removal targets:** "자", "음", "어", "아니", "이제", "인제", "또", "좀", "뭐", "그냥", "약간", "진짜", "되게", "막", "이렇게", "저렇게", "사실"

**Short-response removal targets:** "네", "그렇죠", "맞아요", "아니요" etc. when used as standalone back-channel responses.
- Exception: Keep "네"/"아니요" when it is a substantive answer to a question.
- NEVER delete standalone reaction utterances (where a speaker's entire turn is just a back-channel response).

**Additional patterns to find:**
- Speaker-specific verbal habits: Any meaningless word/phrase a specific speaker uses repeatedly, even if not in the list above.
  Examples: "뭐라 그러냐", "어떻게 보면", "이런 거", "그니까"
- Compound fillers: Multiple filler words in sequence — remove the entire compound.
  Example: "그러니까 이제 뭐" → remove all. "사실 좀 그냥" → remove all.
- Repetition: Same word or similar expression repeated unnecessarily.
  Example: "그래서 그래서", "이게 이게"

**Core criterion for filler detection:**
- If removing the word/phrase leaves the sentence meaning unchanged → filler → remove.
- If the word carries temporal, logical, or contrastive meaning → keep.
- Example: "이제는 많이 바뀌었죠" → keep "이제" (temporal transition)
- Example: "이제 그러니까 이제 이걸 보면" → remove both "이제" + "그러니까"

**If you found zero fillers, double-check.** In spoken-style interview transcripts, finding zero fillers is highly likely a miss.

**Cross-talk "네" removal (★ Important):**
When STT captures overlapping audio from two speakers, it often inserts Speaker B's back-channel "네" into the middle of Speaker A's sentence. These must be detected and removed.

Detection pattern: "네" appearing right after a clause boundary (~한데, ~니까, ~고, ~서, ~지만, ~거든요, ~잖아요, etc.) where the sentence clearly continues as the same speaker's thought.

Examples:
- "회자가 되고 있긴 한데 네 실제 그렇게" → remove "네" → "회자가 되고 있긴 한데 실제 그렇게"
- "많이 생기는 거니까 네 그래서" → remove "네" → "많이 생기는 거니까 그래서"
- "하고 있었는데 네 그래서 저희가" → remove "네" → "하고 있었는데 그래서 저희가"

How to distinguish from a real answer:
- Cross-talk "네": Appears mid-sentence, the sentence flows naturally without it, same speaker continues.
- Real answer "네": Speaker B's turn starts with "네" as a standalone response or "네, [new sentence]".

### §2. STT Misrecognition Correction
- Words mapped in the terminology dictionary below → MUST be corrected. This is mandatory, not optional.
- Speaker name misrecognitions must also be corrected.
- Words not in the dictionary → use context judgment. If uncertain, keep the original.

### §3. Number & Quantity Notation Rules (★ Highest Priority)
Accurately interpret numbers spoken in Korean and convert to Arabic numerals.

**Korean number words → Arabic numerals:**
- "천억" → "1000억", "사천만 명" → "4000만 명"
- Keep large units (억, 만) but convert the preceding number: "삼백억" → "300억"

**Range expressions — determine digit scale from context:**
- "이삼십 명" / "2~30명" → contextually "20~30명" (same-digit-scale range)
- "한 명에서 이십 명" → "1~20명" (different-digit-scale range)
- "일이십 년" → "10~20년"
- "삼사만 원" / "3~4만원" → "3만~4만 원" (repeat the unit)

**Note:** STT may convert "이삼십" to "2~30" but the actual meaning is often "20~30". Use context to judge.

### §4. User-Specified Notation Rules (★ Highest Priority)
These rules override the terminology dictionary:
- "챗gpt", "챗지피티" → "챗GPT"
- "에이전트 AI" → "AI 에이전트"
- "AI 에이전틱" → "에이전틱 AI"
- "NVIDIA" → "엔비디아"
- "아웃소싱" → "외주"

### §5. Spelling & Spacing
Fix remaining spelling, spacing, and punctuation errors.

**5-1. Spacing (highest frequency):**
- Dependent nouns: "할 수있다" → "할 수 있다"
- Negation spacing: "안되" → "안 되", "못하" → "못 하"

**5-2. Orthography:**
- Common targets: 됬→됐, 웬지→왠지, 몇일→며칠, 어떻게/어떡해, 안돼/안되, 데/대, 로서/로써, 되/돼

**5-3. Particle correction:**
- Fix incorrect particles based on preceding syllable's final consonant: 을/를, 이/가, 은/는, 과/와, 으로/로

**5-4. Punctuation:**
- Fix missing periods, misplaced commas.

### §6. Colloquial Expression Polishing
This transcript is for broadcast subtitles. Polish overly casual spoken language while preserving the speaker's natural tone.

**§6-1. Mandatory mappings (always apply):**
- "근데" → "그런데"
- "이거를" / "이거" → "이것을" / "이것"
- "그거를" / "그거" → "그것을" / "그것"
- "~하는 거는" → "~하는 것은"
- "~하는 거고" → "~하는 것이고"
- "~하는 거를" → "~하는 것을"
- "~하는 거가" → "~하는 것이"
- "~하면은" → "~하면"
- "~인데요은" → "~인데요"
- "~잖아" → "~잖아요" (casual → polite, interview context)
- "그래가지고" → "그래서"
- "되가지고" → "돼서"
- "해가지고" → "해서"

**§6-2. Active detection (★ proactively find and fix):**
- Spoken connectives → written forms: "해 갖고" → "해서", "그래갖고" → "그래서"
- Informal endings in polite-speech context: "~거든" → "~거든요", "~잖아" → "~잖아요"
- Redundant particles: "~하면을" → "~하면", "~에다가" → "~에"
- Unnecessary repetition: "진짜 진짜 좋은" → "정말 좋은"
- Verb ending cleanup: "하는거에요" → "하는 거예요", "하는거죠" → "하는 거죠"

**§6-3. Preserve these (do NOT correct):**
- "~거든요", "~잖아요", "~인 거죠", "~인 거예요" — speaker's conversational style
- "~인 건데", "~한 건데" — natural contractions
- "뭔가" — acceptable in spoken interview context (do NOT change to "무언가")
- "어쨌든" — standard form, no correction needed
- "갖다", "갖고" — standard Korean (do NOT change to "가져다", "가지고")

**§6-4. Single-action rule:**
Each word gets ONE action only. If a word could be both removed (§1 filler) and converted (§6 colloquial), apply §6 conversion only (since §6 runs before §1). NEVER report both a filler_removal and a spelling change for the same word.

## Output Rules
Report only changes as JSON. Omit blocks with no changes.
The "original" field must be an **exact copy** from the source text.

{
  "chunks": [{
    "block_index": 3,
    "changes": [{
      "type": "filler_removal",
      "original": "요새 이제 오늘 이제 주제로 삼을",
      "corrected": "요새 오늘 주제로 삼을",
      "removed_fillers": ["이제", "이제"]
    }, {
      "type": "term_correction",
      "original": "엔트로피 클로드",
      "corrected": "앤트로픽 클로드",
      "reason": "Anthropic의 한국어 표기"
    }, {
      "type": "spelling",
      "subtype": "colloquial",
      "original": "해가지고",
      "corrected": "해서",
      "reason": "spoken connective → written form"
    }]
  }]
}

## Absolute Rules
1. NEVER modify document structure (speaker names, timestamps, paragraphs).
2. NEVER delete standalone reaction utterances (a speaker's entire turn being just a back-channel).
3. NEVER misidentify meaningful words as fillers.
4. NEVER make uncertain corrections.
5. NEVER rearrange or summarize sentences.
6. NEVER insert words that do not exist in the original.
7. Process ALL blocks without skipping any.
8. Output JSON ONLY — no other text.
9. **Terminology dictionary mappings are MANDATORY. Do not ignore them.**
10. **Number notation rules and user-specified notation rules take HIGHEST priority.**
11. **Each word gets ONE action only: either remove OR convert, never both.**`;

function buildCorrectPrompt(analysis, customFillers, customTerms) {
  let prompt = BASE_CORRECT_PROMPT;

  if (analysis) {
    prompt += `\n\n## Pre-Analysis Results\n`;
    if (analysis.overview?.topic) prompt += `\n### Interview Topic\n${analysis.overview.topic}\n`;

    if (analysis.speakers?.length > 0) {
      prompt += `\n### Speaker Name Ground Truth (confirmed from speaker-name lines)\n`;
      prompt += `The names below are the confirmed correct speaker names for this interview. Any different spelling found in the body text is an STT misrecognition — correct it.\n`;
      for (const sp of analysis.speakers) {
        prompt += `- "${sp.name}"${sp.role ? ` (${sp.role})` : ""}\n`;
      }
    }

    if (analysis.term_corrections?.length > 0) {
      prompt += `\n### ★★★ STT Misrecognition Dictionary — MANDATORY mappings below ★★★\n`;
      prompt += `If any "wrong" word below appears in the text, you MUST replace it with the "correct" form.\n\n`;
      for (const tc of analysis.term_corrections) {
        if (tc.confidence !== "low") prompt += `- "${tc.wrong}" → "${tc.correct}" [MANDATORY]\n`;
      }
      const lowConf = analysis.term_corrections.filter(tc => tc.confidence === "low");
      if (lowConf.length > 0) {
        prompt += `\n### Reference (low confidence — use context judgment)\n`;
        for (const tc of lowConf) prompt += `- "${tc.wrong}" → "${tc.correct}"\n`;
      }
    }
    if (analysis.domain_terms?.length > 0) {
      prompt += `\n### Domain Terminology\n`;
      for (const dt of analysis.domain_terms) prompt += `- ${dt.term} (${dt.english})\n`;
    }

    if (analysis.dictionary_words?.length > 0) {
      prompt += `\n### ★★★ Team Dictionary (Correct Spelling List) — Phonetic & Contextual Auto-Correction ★★★\n`;
      prompt += `Below is the list of confirmed correct spellings. Find misrecognized words in the text via two paths:\n`;
      prompt += `1. **Phonetic misrecognition** — STT converted to similar-sounding but wrong characters (e.g., "오픈에이" → "오픈AI")\n`;
      prompt += `2. **Contextual misrecognition** — STT substituted a known word that doesn't fit (e.g., "엔트로피" → "앤트로픽")\n\n`;
      prompt += `Correct spelling list:\n`;
      for (const word of analysis.dictionary_words) {
        prompt += `- "${word}"\n`;
      }
      prompt += `\nFind and correct any word that is phonetically similar to or contextually a misrecognition of the above terms.\n`;
    }
  }

  if (customFillers?.length > 0) {
    prompt += `\n### Additional Filler Words (user-specified)\n` + customFillers.map(f => `- "${f}"`).join("\n") + "\n";
  }
  if (customTerms && Object.keys(customTerms).length > 0) {
    prompt += `\n### Additional Term Mappings (user-specified)\n`;
    for (const [correct, wrongs] of Object.entries(customTerms)) {
      prompt += `- ${wrongs.map(w => `"${w}"`).join(", ")} → "${correct}"\n`;
    }
  }

  return prompt;
}

// ═══════════════════════════════════════
// 코드 검증 (Step 1-V) — AI 응답의 비정상 diff 제거
// ═══════════════════════════════════════

function validateCorrections(chunkText, result) {
  if (!result?.chunks) return result;

  for (const chunk of result.chunks) {
    if (!chunk.changes) continue;

    chunk.changes = chunk.changes.filter(change => {
      const { original, corrected, type } = change;

      // 규칙 1: original이 원본 텍스트에 존재하는가
      if (!original || chunkText.indexOf(original) === -1) {
        console.warn(`[V] 제거: original not found — "${original?.substring(0, 30)}"`);
        return false;
      }

      // 규칙 2: original과 corrected가 동일하면 무의미
      if (original.trim() === (corrected || "").trim()) {
        return false;
      }

      // 규칙 3: 축약 감지 — corrected가 original의 30% 미만이면 과도한 삭제
      // filler_removal, spelling 제외 (구어체 교정은 대폭 축약이 자연스러울 수 있음)
      if (type !== "filler_removal" && type !== "spelling" && corrected !== undefined) {
        const ratio = corrected.length / original.length;
        if (ratio < 0.3 && original.length > 10) {
          console.warn(`[V] 제거: 과도한 축약 (${Math.round(ratio*100)}%) — "${original.substring(0, 30)}"`);
          return false;
        }
      }

      // 규칙 4: filler_removal에서 corrected가 original보다 길면 환각 삽입
      if (type === "filler_removal" && corrected && corrected.length > original.length) {
        console.warn(`[V] 제거: filler 환각 — "${corrected.substring(0, 30)}"`);
        return false;
      }

      // 규칙 5: 새 단어 3개 이상이면 문장 재작성 (term_correction 제외)
      if (corrected && type !== "term_correction") {
        const origWords = new Set(original.split(/\s+/));
        const newWords = corrected.split(/\s+/).filter(w => !origWords.has(w) && w.length > 1);
        if (newWords.length >= 3) {
          console.warn(`[V] 제거: 새 단어 ${newWords.length}개 — [${newWords.join(', ')}]`);
          return false;
        }
      }

      // 규칙 6: removed_fillers가 original 안에 있는지
      if (type === "filler_removal" && change.removed_fillers) {
        change.removed_fillers = change.removed_fillers.filter(f => original.includes(f));
        if (change.removed_fillers.length === 0) {
          console.warn(`[V] 제거: removed_fillers가 original에 없음`);
          return false;
        }
      }

      return true;
    });

    // 규칙 7: 같은 original에 중복 change → 마지막 것만 유지
    const seen = new Map();
    chunk.changes.forEach((ch, idx) => { if (ch.original) seen.set(ch.original, idx); });
    chunk.changes = chunk.changes.filter((ch, idx) => !ch.original || seen.get(ch.original) === idx);
  }

  result.chunks = result.chunks.filter(c => c.changes?.length > 0);
  return result;
}

async function handleCorrect(body, env, headers) {
  const { chunk_text, chunk_index, total_chunks, context_blocks, analysis, custom_fillers, custom_terms } = body;
  if (!chunk_text) return new Response(JSON.stringify({ error: "chunk_text is required" }), { status: 400, headers });

  const systemPrompt = buildCorrectPrompt(analysis, custom_fillers, custom_terms);
  let userMsg = "";
  if (context_blocks) userMsg += `[Context reference — do NOT modify]\n${context_blocks}\n\n`;
  userMsg += `[Correction target — chunk ${(chunk_index||0)+1}/${total_chunks||1}]\n${chunk_text}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await callOpenAI(systemPrompt, userMsg, env, { max_tokens: 32000 });
    if (result.error && result.status === 429) { await new Promise(r => setTimeout(r, (attempt+1)*3000)); continue; }
    if (result.error) return new Response(JSON.stringify({ error: result.error }), { status: result.status||500, headers });
    // v4: 코드 검증 적용
    const validated = validateCorrections(chunk_text, result.content);
    return new Response(JSON.stringify({ success: true, result: validated, chunk_index, usage: result.usage }), { headers });
  }
  return new Response(JSON.stringify({ error: "All retries failed" }), { status: 500, headers });
}

// ═══════════════════════════════════════
// /highlights — 2단계: 강조자막 (v2 룰북 2-Pass + 청크)
// ═══════════════════════════════════════

const DRAFT_AGENT_PROMPT = `당신은 인터뷰 영상의 강조자막 Draft Agent입니다.
강조자막 후보를 넉넉하게 생성하는 것이 목표입니다. 놓치지 않는 것이 최우선입니다.

## §1 핵심 원칙
자막은 녹취가 아니라 번역이다. 긴 구어체를 시청자가 바로 이해할 수 있는 단위로 번역하는 장치다.
단, 화자의 발언 자체가 핵심 콘텐츠인 경우 인용형으로 보존한다.
낯선 개념은 자막이 먼저 책임진다.
한 대목에는 한 가지 시청자 과제만 준다.
화면이 이미 충분하면 자막을 줄인다.
자막 밀도는 시간이 아니라 내용이 결정한다.

## §4 자막 유형 체계 (16유형)
### A. 핵심 전달 (~40%)
- A1. 핵심 논지 압축 (10~30자)
- A2. 핵심 메시지 인용 (따옴표, 15~80자)
- A3. 비유형 압축 (15~30자)
### B. 정의·설명 (~15%)
- B1. 등호 정의형 A = B (10~30자)
- B2. 용어 설명형 A : 설명 (40~150자, 40자 규칙 예외)
  트리거: 전문 용어 첫 등장, 모르면 이해 불가, 영문 약어
- B3. 인물 소개형 (30~100자)
### C. 구조화 (~15%)
- C1. 질문 프레이밍형
- C2. 목차/프레임워크형
- C3. 서사 프레이밍
- C4. 단계 분해형 ①②③
- C5. 프로세스 연쇄형 (인과 사슬)
### D. 평가·반응 (~10%)
- D1. 비교 평가형
- D2. 리액션형
- D3. 말풍선형
### E. 기능·실무 (~10%)
- E1. 기능 헤드라인
- E2. 실무 팁/행동 지침

## §5 문체 규칙
짧게, 단정적으로, 구어체 제거, 결론만. 명사·동사 중심.
대부분 40자 이내. B2(40~150자), B3(30~100자), A2(~80자) 예외.
시각 기호: →, ↑, ↓, ×, · / 두 줄 시 / 로 구분.

## §6 결정 트리
1. 시청자 메시지 있는가? → 없으면 스킵
2. 화면이 이미 전달? → 스킵
3. 어떤 유형? → 메시지 성격으로 선택
4. 직전 자막과 유형 중복? → 3연속 시 재조정

## 출력 지시
- 필요량의 1.5~2배 넉넉히 생성
- 놓칠 바에는 포함. Editor Agent가 걸러냄
- 낯선 용어 첫 등장 → 반드시 B2 후보 생성

반드시 JSON만 출력:
{
  "highlights": [{
    "block_index": 16, "speaker": "화자명",
    "source_text": "원문 일부 (50자 이내)",
    "subtitle": "코드 = 정형 언어 vs 프롬프트 = 비정형 언어",
    "type": "B1", "type_name": "등호 정의형",
    "reason": "설명", "placement_hint": null, "sequence_id": null
  }]
}

## 절대 규칙
1. 교정된 용어 사용  2. 구어체 금지  3. block_index 정확히  4. JSON만 출력`;


const EDITOR_AGENT_PROMPT = `당신은 인터뷰 영상의 강조자막 Editor Agent입니다.
Draft Agent가 생성한 후보를 검증·선별·다듬는 것이 목표입니다.

## §1 핵심 원칙
자막은 녹취가 아니라 번역이다. 한 대목에는 한 가지 과제만.
화면이 충분하면 줄인다. 밀도는 내용이 결정한다.

## §5 문체 규칙
짧게, 단정적, 구어체 제거. 40자 이내 (B2/B3/A2 예외).

## §7 스킵 조건
배경 설명/인사/도입, 농담, 단독 리액션, 반복, 전환 멘트, 잡담, 시연 화면 충분 구간

## §8 배치 지시
크기:(<<작게), 위치:(○○ 옆에), 톤:(부드러운), 이어붙이기:(위에꺼 이어서)

## §9 검증 체크리스트
번역인가? 구어체 남았는가? 1~2초 내 이해? 유일한 과제? 장르 적합? 유형 중복? 용어 설명 누락? 억지?

## 편집 작업
1. 스킵 조건 해당 → 제거
2. 유형 3연속 중복 → 재조정
3. 문체 다듬기
4. 장르별 밀도 조절
5. 놓친 B2 추가

## 출력 (JSON만)
{
  "highlights": [...],
  "removed": [{ "block_index": 5, "reason": "도입부 인사" }],
  "stats": { "draft_count": 45, "final_count": 28, "removal_rate": "38%" }
}

## 절대 규칙
1. 교정된 용어  2. 구어체 금지  3. block_index 정확  4. JSON만  5. removed에 사유 기록`;


const GENRE_DENSITY_STRATEGIES = {
  "서사형": `## 장르: 서사형\n밀도: 낮음. 인용형, 태도 강조 위주.`,
  "설명형": `## 장르: 설명형\n밀도: 높음. 개념마다 검토. 낯선 용어 반드시 B2.`,
  "데모/도구활용형": `## 장르: 데모형\n밀도: 가변. 시연 중 축소, 토킹헤드 복귀 시 복구.`,
  "비교형": `## 장르: 비교형\n밀도: 보통. 비교 근거 명확한 자막 위주.`,
  "산업/전략분석형": `## 장르: 산업/전략\n밀도: 매우 높음. 논점 전환마다 자막.`,
  "역사+인물형": `## 장르: 역사+인물\n밀도: 보통~높음.`,
  "기술트렌드형": `## 장르: 기술트렌드\n밀도: 높음.`,
};

function buildEditorPrompt(analysis) {
  let prompt = EDITOR_AGENT_PROMPT;
  if (analysis?.genre?.primary) {
    const s = GENRE_DENSITY_STRATEGIES[analysis.genre.primary];
    if (s) prompt += `\n\n${s}`;
  }
  if (analysis?.genre?.secondary) {
    const s2 = GENRE_DENSITY_STRATEGIES[analysis.genre.secondary];
    if (s2) prompt += `\n\n### 보조 장르\n${s2}`;
  }
  if (analysis?.tech_difficulty) {
    prompt += `\n\n## 기술 난이도: ${analysis.tech_difficulty}`;
    if (["높음","매우높음"].includes(analysis.tech_difficulty)) prompt += `\nB2 비중을 높이세요.`;
  }
  return prompt;
}

async function handleHighlights(body, env, headers) {
  const { mode, blocks, corrected_text, analysis, draft_highlights, chunk_index, total_chunks, target_block_indices, max_items } = body;
  if (mode === "draft") return await handleDraft(blocks, corrected_text, analysis, env, headers, chunk_index, total_chunks, target_block_indices, max_items);
  else if (mode === "edit") return await handleEdit(blocks, corrected_text, analysis, draft_highlights, env, headers, chunk_index, total_chunks);
  else return await handleDraft(blocks, corrected_text, analysis, env, headers, chunk_index, total_chunks, target_block_indices, max_items);
}

async function handleDraft(blocks, corrected_text, analysis, env, headers, chunk_index, total_chunks, target_block_indices, max_items) {
  let systemPrompt = DRAFT_AGENT_PROMPT;

  if (analysis?.genre) {
    systemPrompt += `\n\n## Step 0 분석 결과\n장르: ${analysis.genre.primary}${analysis.genre.secondary ? ` + ${analysis.genre.secondary}` : ""}`;
    if (analysis.genre.transitions?.length > 0) {
      systemPrompt += `\n장르 전환:`;
      for (const t of analysis.genre.transitions) systemPrompt += `\n- 블록 ${t.block_range[0]}~${t.block_range[1]}: ${t.genre}`;
    }
  }
  if (analysis?.tech_difficulty) systemPrompt += `\n기술 난이도: ${analysis.tech_difficulty}`;
  if (analysis?.domain_terms?.length > 0) {
    systemPrompt += `\n\n## 도메인 전문용어`;
    for (const dt of analysis.domain_terms) systemPrompt += `\n- ${dt.term} (${dt.english})`;
  }
  if (chunk_index !== undefined && total_chunks !== undefined) {
    systemPrompt += `\n\n## 청크 정보\n청크 ${chunk_index+1}/${total_chunks}.`;
    if (chunk_index > 0) systemPrompt += ` 앞 청크에서 이미 자막 생성됨. 이 청크 내용에 집중.`;
  }

  // 부분 생성 모드: 특정 블록에 집중 + 개수 제한
  if (target_block_indices && Array.isArray(target_block_indices) && target_block_indices.length > 0) {
    const rangeLabel = target_block_indices.length === 1
      ? `블록 #${target_block_indices[0]}`
      : `블록 #${target_block_indices[0]}~#${target_block_indices[target_block_indices.length-1]}`;
    systemPrompt += `\n\n## 부분 생성 모드\n사용자가 ${rangeLabel}을 선택했습니다. 이 블록들의 내용을 종합적으로 분석하여 강조자막을 생성하세요.\n- 선택된 블록들의 전체 맥락을 하나로 이해한 뒤 자막을 만드세요.\n- 주변 블록은 맥락 참조용으로만 사용하고, 자막은 반드시 선택 블록(${target_block_indices.join(', ')})에만 배치하세요.`;
    if (max_items) {
      systemPrompt += `\n- 최대 ${max_items}개만 생성하세요. 가장 임팩트 있는 것만 엄선하세요.`;
    }
  }

  let userMsg = target_block_indices ? "아래는 선택 구간과 주변 맥락입니다. 선택 블록에 대해서만 강조자막을 생성하세요.\n\n" : "아래는 1차 교정이 완료된 인터뷰 원고입니다. 강조자막 후보를 넉넉히 생성하세요.\n\n";
  if (blocks && Array.isArray(blocks)) {
    const targetSet = target_block_indices ? new Set(target_block_indices) : null;
    for (const b of blocks) {
      const marker = targetSet && targetSet.has(b.index) ? "★" : "";
      userMsg += `[블록 ${b.index}]${marker} ${b.speaker} ${b.timestamp}\n${b.text}\n\n`;
    }
  } else { userMsg += corrected_text || ""; }

  const result = await callOpenAI(systemPrompt, userMsg, env, { temperature: 0.3, max_tokens: 16000 });
  if (result.error) return new Response(JSON.stringify({ error: result.error }), { status: result.status||500, headers });
  return new Response(JSON.stringify({ success: true, result: result.content, usage: result.usage }), { headers });
}

async function handleEdit(blocks, corrected_text, analysis, draftHighlights, env, headers, chunk_index, total_chunks) {
  const systemPrompt = buildEditorPrompt(analysis);

  let userMsg = `Draft Agent가 생성한 강조자막 후보입니다. 검증·선별·다듬기를 수행하세요.\n\n`;
  userMsg += `## Draft 후보 (${draftHighlights.length}건)\n\n${JSON.stringify(draftHighlights, null, 2)}`;
  userMsg += `\n\n## 원문 참조\n\n`;
  if (blocks && Array.isArray(blocks)) {
    for (const b of blocks) userMsg += `[블록 ${b.index}] ${b.speaker} ${b.timestamp}\n${b.text}\n\n`;
  } else { userMsg += corrected_text || ""; }
  if (chunk_index !== undefined && total_chunks !== undefined) userMsg += `\n(청크 ${chunk_index+1}/${total_chunks})`;

  const result = await callOpenAI(systemPrompt, userMsg, env, { temperature: 0.2, max_tokens: 16000 });
  if (result.error) return new Response(JSON.stringify({ error: result.error }), { status: result.status||500, headers });
  return new Response(JSON.stringify({ success: true, result: result.content, usage: result.usage }), { headers });
}

// ═══════════════════════════════════════
// /subtitle-format — 자막용 줄바꿈 포맷팅 (V2.1: Word-Index + Post-Processing)
// ═══════════════════════════════════════

const SUBTITLE_FORMAT_PROMPT = `<role>
You are a Korean subtitle line-break position expert. You receive Korean interview transcript text with numbered words (eojeols). Your ONLY job is to decide WHERE to place line breaks by returning the word numbers. You do NOT rewrite, modify, or reproduce any of the original text.
</role>

<task>
Given numbered words like: [1]거기서 [2]광고 [3]매출 [4]잘 [5]나오고 [6]있으니까
Return ONLY the word numbers AFTER which a line break should be placed.
Output: {"breaks_after": [6]}
This means: break after word 6 → line 1 = words 1–6, line 2 starts at word 7.
</task>

<decision_criteria>
Your decisions must follow this priority order:

PRIORITY 1 — Never split semantic chunks (see <never_split>)
PRIORITY 2 — Break at clause boundaries (see <clause_boundaries>)
PRIORITY 3 — Every line SHOULD be between 12 and 28 characters.
HARD LIMIT: No line may exceed 35 characters under any circumstance.
If keeping a semantic chunk intact would produce a line over 35 characters, you MUST find a break point inside that chunk — even semantic chunks can be split when they exceed 35 characters.

MINIMUM BREAK DENSITY: For every 5 words in the input, there must be at least 1 break.
A 50-word input must have at least 10 breaks.
A 60-word input must have at least 12 breaks.
If your output has fewer breaks than this minimum, you are making lines too long.

When PRIORITY 2 and 3 conflict:
- If a clause boundary produces a line over 28 characters → you MUST find an additional break point inside that clause. Look for internal phrase boundaries (object+verb, adverb+predicate, list items).
- If a clause boundary produces a line under 12 characters → acceptable ONLY if the line is a semantically complete unit (direct speech, exclamation, or a standalone clause ending). Otherwise merge with adjacent line.

CRITICAL RULE: A line over 35 characters is ALWAYS wrong, no matter what. When you see 5+ words accumulating without a break, you are probably making a line too long. Break it.
</decision_criteria>

<line_length_guide>
Korean eojeols average about 3–4 characters each (including the trailing space).
Use this rough mapping to stay within 12–28 characters per line:

| Words in line | Approximate chars | Verdict      |
|---------------|-------------------|--------------|
| 2–3 words     | 8–15 chars        | Short — OK only if semantically complete |
| 4–5 words     | 14–22 chars       | Ideal range  |
| 6–7 words     | 20–28 chars       | Upper limit — check carefully |
| 8+ words      | 28+ chars         | TOO LONG — must break somewhere inside |

When you have 7+ words between breaks, STOP and look for an internal break point.
</line_length_guide>

<clause_boundaries>
These are natural break points in Korean speech.

Break AFTER words ending with these suffixes:
~하고, ~해서, ~인데, ~지만, ~니까, ~있고, ~거든요, ~잖아요, ~됐고, ~보니까, ~계세요, ~는데, ~때문에, ~합니다, ~돼요, ~거고, ~이고, ~하는, ~됩니다, ~있어요, ~거예요, ~하죠, ~되고

Break BEFORE these conjunctions (they start a new line):
그래서, 그리고, 하지만, 결국, 심지어, 특히, 마찬가지로, 근데, 그러니까, 그런데, 그러면, 그러다, 그런

Break BEFORE direct speech (quoted utterances start a new line).
</clause_boundaries>

<semantic_chunks>
A semantic chunk is a group of words forming ONE meaning unit. Never place a break inside a chunk.

| Chunk Type                    | Example (keep together)       |
|-------------------------------|-------------------------------|
| Subject/Topic + Particle      | 사용자의 역량이                |
| Modifier clause + Head noun   | 돌아가고 있는 곳들이            |
| Adverb(ial phrase) + Predicate| 많이 쓸수록                    |
| Object + Predicate            | 토큰을 생산할                  |
| Main verb + Aux verb + Ending | 나오고 있으니까                |
| Noun + Particle               | 사용자의 (사용자 / 의 = ERROR) |
</semantic_chunks>

<never_split>
Breaking inside ANY of these patterns is a critical error.

| Pattern Type                  | Keep Together            | WRONG Split              |
|-------------------------------|--------------------------|--------------------------|
| Modifier clause + Head noun   | 돌아가고 있는 곳들이       | 돌아가고 있는 / 곳들이     |
| Object + Predicate            | 토큰을 많이 쓸수록        | 토큰을 많이 / 쓸수록      |
| Main verb + Auxiliary verb    | 나오고 있으니까           | 나오고 / 있으니까         |
| Adverb + Verb                 | 꽤 돌아가고              | 꽤 / 돌아가고            |
| Noun + Particle               | 사용자의                 | 사용자 / 의              |
| Orphaned single word on a line | (never allowed)         |                          |
</never_split>

<examples>

<example id="1">
<input>
[1]마찬가지로 [2]워크 [3]에이전트도 [4]사용자의 [5]역량이 [6]중요합니다 [7]회사 [8]데이터를 [9]다 [10]주고 [11]예를 [12]들면 [13]인사 [14]규정 [15]다 [16]주고 [17]제가 [18]한 [19]줄로 [20]물어봐요 [21]나 [22]내일 [23]집에 [24]가도 [25]돼? [26]이러면 [27]답을 [28]할 [29]수가 [30]없죠 [31]이게 [32]도대체 [33]무슨 [34]뜻인데요
</input>
<correct_output>{"breaks_after": [3, 6, 12, 20, 25, 30]}</correct_output>
</example>

<example id="2">
<input>
[1]거기서 [2]광고 [3]매출 [4]잘 [5]나오고 [6]있으니까 [7]그런 [8]거에 [9]장점은 [10]있지만 [11]결국 [12]아마존 [13]마이크로소프트 [14]구글 [15]애플은 [16]토큰을 [17]많이 [18]쓸수록 [19]회사가 [20]좋아지는 [21]회사가 [22]되려고 [23]하고 [24]있고
</input>
<correct_output>{"breaks_after": [6, 10, 13, 18, 21]}</correct_output>
<wrong_output reason="Line too long — no break between [11] and [24] produces 44ch line">
breaks_after: [6, 10] → 44ch = CRITICAL ERROR
</wrong_output>
</example>

<example id="3">
<input>
[1]1년 [2]만에 [3]30년 [4]개발자 [5]기업 [6]분석 [7]시리즈를 [8]저희가 [9]다시 [10]시작해서 [11]지금 [12]이어가고 [13]있는데 [14]일단 [15]토큰을 [16]중심으로 [17]하는 [18]토큰 [19]이코노미가 [20]굉장히 [21]중요하다고 [22]말씀해 [23]주셨고 [24]코딩 [25]에이전트는 [26]이미 [27]다 [28]보급돼서 [29]우리가 [30]잘 [31]쓰고 [32]있고
</input>
<correct_output>{"breaks_after": [7, 13, 19, 23, 28]}</correct_output>
</example>

<example id="4">
<input>
[1]이 [2]사람들이 [3]하는 [4]일을 [5]어떻게 [6]AI로 [7]잘할 [8]것인가라고 [9]해서 [10]일반 [11]직군 [12]AX를 [13]하고 [14]있는데 [15]일반 [16]직군 [17]AX의 [18]제일 [19]중요한 [20]게 [21]이 [22]워크 [23]에이전트라고 [24]보고 [25]있습니다
</input>
<correct_output>{"breaks_after": [9, 14, 20]}</correct_output>
<wrong_output reason="No internal breaks — single 46ch line">
breaks_after: [] → 46ch = CRITICAL ERROR
</wrong_output>
</example>

</examples>

<output_format>
Return ONLY valid JSON. Nothing before or after.
{"breaks_after": [3, 6, 12, 20, 25, 30]}

The numbers are word indices AFTER which a line break is inserted.
Do NOT include the last word's index (no trailing break).
Do NOT output any text, explanation, or markdown — JSON only.

Before outputting the JSON, silently verify:
1. Count your breaks. For N input words, you need at least N/5 breaks.
2. Check: is there any gap of 8+ word indices between consecutive breaks? If yes, add a break in that gap.
3. Only then output the final JSON.
</output_format>`;

// ═══════════════════════════════════════
// V2.1 전처리 함수들
// ═══════════════════════════════════════

function preprocessForV2(rawText) {
  let text = rawText
    .replace(/^[-=─]{3,}$/gm, '')
    .replace(/^\d{6}_[^\n]+$/gm, '')
    .replace(/^\d{1,2}:\d{2}(:\d{2})?$/gm, '')
    .replace(/^\d+분\s*\d+초?$/gm, '')
    .replace(/^(싱크|녹취|편|장)\s*[:：].*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const numbered = words.map((w, i) => `[${i + 1}]${w}`).join(' ');
  return { words, numbered, totalWords: words.length };
}

function chunkWords(words, targetSize = 80) {
  const SENTENCE_ENDINGS = /[.?!]$/;
  const CLAUSE_ENDINGS = /(니다|어요|거든요|잖아요|는데요|네요|세요|죠|고요)$/;
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    let end = Math.min(start + targetSize, words.length);
    if (end < words.length) {
      let bestBreak = -1;
      const searchStart = Math.max(start, start + Math.floor(targetSize * 0.8));
      const searchEnd = Math.min(words.length, start + Math.floor(targetSize * 1.2));
      for (let i = searchEnd - 1; i >= searchStart; i--) {
        if (SENTENCE_ENDINGS.test(words[i]) || CLAUSE_ENDINGS.test(words[i])) {
          bestBreak = i + 1;
          break;
        }
      }
      if (bestBreak > 0) end = bestBreak;
    }
    const chunkW = words.slice(start, end);
    const numbered = chunkW.map((w, i) => `[${start + i + 1}]${w}`).join(' ');
    chunks.push({ words: chunkW, numbered, globalOffset: start });
    start = end;
  }
  return chunks;
}

// ═══════════════════════════════════════
// V2.1 후처리 엔진
// ═══════════════════════════════════════

const V2_MIN_CHARS = 12;
const V2_MAX_CHARS = 28;
const V2_HARD_MAX = 30;

const PARTICLES = /^(은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만|까지|부터|에게|한테|께|라고|이라고|처럼|보다|밖에|마저|조차|이나|나|요|죠)$/;
const AUX_VERBS = /^(있(고|는데|으니까|잖아요|어요|습니다|었고|지만|거든요|으면)|없(고|는데|잖아요|어요|습니다|지만|거든요)|않(고|는데|잖아요|아요|습니다|지만|거든요)|하고|되고|되는|되면|봤는데|보니까|줘야|줘서|줬고|주고|드리고)$/;

async function postProcessSubtitleV2(words, breaksAfter, env) {
  let lines = buildLinesV2(words, breaksAfter);
  const resplitResult = await validateAndResplit(lines, env);
  lines = resplitResult.lines;
  lines = mergeShortLines(lines);
  lines = removeTrailingPunctuation(lines);
  lines = fixQuotesV2(lines);
  return {
    text: lines.map(l => l.text).join('\n'),
    resplitCount: resplitResult.resplitCount,
    resplitLines: resplitResult.resplitLines,
    finalLineCount: lines.length,
  };
}

function buildLinesV2(words, breaksAfter) {
  const breakSet = new Set(breaksAfter);
  const lines = [];
  let currentWords = [];
  for (let i = 0; i < words.length; i++) {
    currentWords.push(words[i]);
    if (breakSet.has(i + 1) || i === words.length - 1) {
      const text = currentWords.join(' ');
      lines.push({ text, words: [...currentWords] });
      currentWords = [];
    }
  }
  return lines;
}

// 변경 D: 35ch 기준 + 최대 2회 재질의 + 강제 분할 fallback
const V2_HARD_LIMIT = 35;

async function validateAndResplit(lines, env) {
  const MAX_RETRIES = 2;
  let resplitCount = 0;
  const resplitLines = [];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].text.length > V2_HARD_LIMIT) {
        violations.push(i);
      }
    }

    if (violations.length === 0) break;

    // 뒤에서부터 처리 (splice 인덱스 안 밀리게)
    for (let vi = violations.length - 1; vi >= 0; vi--) {
      const idx = violations[vi];
      const start = Math.max(0, idx - 1);
      const end = Math.min(lines.length - 1, idx + 1);
      const contextLines = lines.slice(start, end + 1);
      const contextWords = contextLines.flatMap(l => l.words);
      const numbered = contextWords.map((w, i) => `[${i + 1}]${w}`).join(' ');

      resplitCount++;
      resplitLines.push(idx);

      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: "gpt-5.4-mini",
            messages: [
              { role: "system", content: SUBTITLE_FORMAT_PROMPT },
              { role: "user", content: numbered },
            ],
            temperature: 0.1,
            max_completion_tokens: 500,
            response_format: { type: "json_object" },
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const rawContent = data.choices?.[0]?.message?.content || "";
          try {
            const parsed = JSON.parse(rawContent.substring(rawContent.indexOf('{'), rawContent.lastIndexOf('}') + 1));
            if (Array.isArray(parsed.breaks_after)) {
              const newBreaks = parsed.breaks_after.filter(n => typeof n === 'number' && n >= 1 && n < contextWords.length);
              const newLines = buildLinesV2(contextWords, newBreaks);
              lines.splice(start, end - start + 1, ...newLines);
            }
          } catch (e) { /* 파싱 실패 시 원본 유지 */ }
        }
      } catch (e) { /* 네트워크 에러 시 원본 유지 */ }
    }
  }

  // 최후 수단: 재질의 2회 후에도 35ch 초과 줄이 남으면 중간 지점에서 강제 분할
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].text.length > V2_HARD_LIMIT) {
      const ws = lines[i].words;
      const mid = Math.floor(ws.length / 2);
      const line1 = { text: ws.slice(0, mid).join(' '), words: ws.slice(0, mid) };
      const line2 = { text: ws.slice(mid).join(' '), words: ws.slice(mid) };
      lines.splice(i, 1, line1, line2);
    }
  }

  return { lines, resplitCount, resplitLines };
}

// 변경 6: 양방향 병합 강화 — 앞줄 우선 + 1어절/MIN_CHARS 통합 조건
function mergeShortLines(lines) {
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1어절 고아 줄 또는 MIN_CHARS 미만 줄
    if (line.words.length <= 1 || line.text.length < V2_MIN_CHARS) {

      // 먼저 앞줄과 합치기 시도
      if (result.length > 0) {
        const prev = result[result.length - 1];
        const mergedWithPrev = prev.text + ' ' + line.text;
        if (mergedWithPrev.length <= V2_MAX_CHARS) {
          result[result.length - 1] = {
            text: mergedWithPrev,
            words: [...prev.words, ...line.words]
          };
          continue;
        }
      }

      // 앞줄과 안 되면 다음 줄과 합치기 시도
      if (i + 1 < lines.length) {
        const next = lines[i + 1];
        const mergedWithNext = line.text + ' ' + next.text;
        if (mergedWithNext.length <= V2_MAX_CHARS) {
          result.push({
            text: mergedWithNext,
            words: [...line.words, ...next.words]
          });
          i++; // 다음 줄 스킵
          continue;
        }
      }
    }

    result.push(line);
  }
  return result;
}

function removeTrailingPunctuation(lines) {
  return lines.map(line => ({ ...line, text: line.text.replace(/[.,]+$/, '') }));
}

function fixQuotesV2(lines) {
  let inSingle = false, inDouble = false;
  return lines.map(line => {
    let text = line.text;
    const sc = (text.match(/'/g) || []).length;
    const dc = (text.match(/"/g) || []).length;
    if (inSingle && !text.startsWith("'")) text = "'" + text;
    if (inDouble && !text.startsWith('"')) text = '"' + text;
    if (sc % 2 === 1) inSingle = !inSingle;
    if (dc % 2 === 1) inDouble = !inDouble;
    if (inSingle && !text.endsWith("'")) text = text + "'";
    if (inDouble && !text.endsWith('"')) text = text + '"';
    return { ...line, text };
  });
}

// ═══════════════════════════════════════
// V3: 화자 턴 단위 자막 포맷팅
// ═══════════════════════════════════════

const SUBTITLE_FORMAT_PROMPT_V3 = `<role>
You are a Korean subtitle line-break formatter. Your job is to split Korean interview transcripts into subtitle lines that viewers can read at a glance. You must maintain consistent quality from the first line to the last, regardless of input length.
</role>

<hard_rules>
These rules apply to EVERY line with NO exceptions:
1. Every output line must be 15–25 characters (including spaces).
2. Lines under 10 characters → FAILURE. Lines over 25 characters → FAILURE.
3. Remove trailing periods (.) and commas (,). Preserve ? and !
4. Remove metadata lines (filenames, dates, durations, speaker labels, dividers).
5. Output the formatted text only — one subtitle line per line, no numbering, no explanations.
6. After the formatted lines, output NOTHING else.
</hard_rules>

<speaker_markers>
Input text contains [화자명] markers at the start of each speaker turn.
- ALWAYS start a new line after each [화자명] marker.
- NEVER merge text from different speakers into one line.
- Remove the [화자명] markers from your output — they are only for your reference.
</speaker_markers>

<process>
Follow this exact sequence for every input:

STEP 1 — FOR THE INPUT:

  1a. Mark clause boundaries
  Clause-ending suffixes (break AFTER these):
  ~하고, ~해서, ~인데, ~지만, ~니까, ~있고, ~거든요, ~잖아요, ~됐고, ~보니까, ~계세요

  Conjunctions (break BEFORE these — they start a new line):
  그래서, 그리고, 하지만, 결국, 심지어, 특히, 마찬가지로

  1b. Identify semantic chunks within each clause
  A semantic chunk is a group of words forming ONE idea:
  - [Subject/Topic + Particle]: 사용자의 역량이
  - [Modifier clause + Head noun]: 돌아가고 있는 곳들이
  - [Adverb(ial phrase) + Predicate]: 많이 쓸수록
  - [Object + Predicate]: 토큰을 생산할
  - [Main verb + Auxiliary verb + Ending]: 나오고 있으니까

  1c. Place line breaks BETWEEN semantic chunks, never inside them.
  Choose the break point closest to the 15–25 character target.

  1d. VALIDATE every line.
  Count characters. If any line is < 15 or > 25, fix it NOW before outputting.

STEP 2 — FINAL VALIDATION
Do a final character-count check on the entire output.
</process>

<never_split>
The following patterns must ALWAYS stay on a single line. Breaking inside them is a critical error.

| Pattern Type                  | Keep Together            | WRONG Split              |
|-------------------------------|--------------------------|--------------------------|
| Modifier clause + Head noun   | 돌아가고 있는 곳들이       | 돌아가고 있는 / 곳들이     |
| Object + Predicate            | 토큰을 많이 쓸수록        | 토큰을 많이 / 쓸수록      |
| Main verb + Auxiliary verb    | 나오고 있으니까           | 나오고 / 있으니까         |
| Adverb + Verb                 | 꽤 돌아가고              | 꽤 / 돌아가고            |
| Noun + Particle               | 사용자의                 | 사용자 / 의              |
| Orphaned single word on a line | (never allowed)         |                          |
</never_split>

<examples>

<example id="1">
<description>Mixed sentence types: statement, direct speech with ?, and short clauses. Shows conjunction-start rule, quote handling, and semantic unit preservation.</description>

<input>마찬가지로 워크 에이전트도 사용자의 역량이 중요합니다 회사 데이터를 다 주고 예를 들면 인사 규정 다 주고 제가 한 줄로 물어봐요 나 내일 집에 가도 돼? 이러면 답을 할 수가 없죠 이게 도대체 무슨 뜻인데요</input>

<correct_output>
마찬가지로 워크 에이전트도
사용자의 역량이 중요합니다
회사 데이터를 다 주고 예를 들면
인사 규정 다 주고 제가 한 줄로 물어봐요
나 내일 집에 가도 돼?
이러면 답을 할 수가 없죠
이게 도대체 무슨 뜻인데요
</correct_output>

<line_by_line_analysis>
Line 1: "마찬가지로 워크 에이전트도" (15ch) — Conjunction starts the line
Line 2: "사용자의 역량이 중요합니다" (15ch) — [Subject+Particle] + [Predicate] complete clause
Line 3: "회사 데이터를 다 주고 예를 들면" (18ch) — Clause ending ~주고 + transitional
Line 4: "인사 규정 다 주고 제가 한 줄로 물어봐요" (22ch) — Clause ending ~주고 + new subject
Line 5: "나 내일 집에 가도 돼?" (15ch) — Direct speech with ? preserved
Line 6: "이러면 답을 할 수가 없죠" (15ch) — [Object+Predicate] kept intact
Line 7: "이게 도대체 무슨 뜻인데요" (15ch) — [Adverb+Predicate] kept intact
</line_by_line_analysis>
</example>

<example id="2">
<description>Long compound sentence with proper nouns and nested modifier clause. Demonstrates never_split rules.</description>

<input>거기서 광고 매출 잘 나오고 있으니까 그런 거에 장점은 있지만 결국 아마존 마이크로소프트 구글 애플은 결국 토큰을 많이 쓸수록 회사가 좋아지는 회사가 되려고 하고 있고</input>

<correct_output>
거기서 광고 매출 잘 나오고 있으니까
그런 거에 장점은 있지만
결국 아마존 마이크로소프트
구글 애플은 토큰을 많이 쓸수록
회사가 좋아지는 회사가
되려고 하고 있고
</correct_output>

<line_by_line_analysis>
Line 1: "거기서 광고 매출 잘 나오고 있으니까" (20ch) — [Main verb + Auxiliary verb] kept intact
Line 2: "그런 거에 장점은 있지만" (14ch) — Clause ending ~지만
Line 3: "결국 아마존 마이크로소프트" (15ch) — Conjunction starts new line
Line 4: "구글 애플은 토큰을 많이 쓸수록" (17ch) — [Object + Predicate] kept intact
Line 5: "회사가 좋아지는 회사가" (13ch) — [Modifier clause + Head noun] kept intact
Line 6: "되려고 하고 있고" (10ch) — [Main verb + Auxiliary verb + Ending] kept intact
</line_by_line_analysis>

<wrong_output reason="Splits [Main verb + Auxiliary verb]">
거기서 광고 매출 잘 나오고
있으니까 그런 거에 장점은 있지만
</wrong_output>

<wrong_output reason="Splits [Object + Predicate]">
구글 애플은 토큰을 많이
쓸수록 회사가 좋아지는 회사가
</wrong_output>

<wrong_output reason="Splits [Modifier clause + Head noun]">
회사가 좋아지는
회사가 되려고 하고 있고
</wrong_output>
</example>

</examples>

<quote_rules>
- When quoted speech ('...' or "...") spans multiple lines, repeat the quote marks on each line.
- Direct speech always starts a new line.
</quote_rules>

<quality_reminder>
Read this before processing EACH chunk:
- Line 300 must be the same quality as line 1.
- Every line: 15–25 characters. Count them.
- Never split semantic chunks. Break only BETWEEN meaning units.
- If you feel yourself rushing, SLOW DOWN and re-validate.
</quality_reminder>`;

// V3 후처리: 35자 초과 줄 한 줄 단위 모델 재질의
async function resplitLongLines(lines, env) {
  let resplitCount = 0;
  const result = [];
  for (const line of lines) {
    if (line.length <= 35) {
      result.push(line);
      continue;
    }
    resplitCount++;
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          messages: [
            { role: "system", content: SUBTITLE_FORMAT_PROMPT_V3 },
            { role: "user", content: line },
          ],
          temperature: 0.1,
          max_completion_tokens: 1000,
        }),
      });
      if (resp.ok) {
        const d = await resp.json();
        const text = (d.choices?.[0]?.message?.content || "").trim();
        const newLines = text.split('\n').filter(l => l.trim());
        if (newLines.length > 1) { result.push(...newLines); continue; }
      }
    } catch (e) { /* 실패 시 원본 유지 */ }
    result.push(line);
  }
  return { lines: result, resplitCount };
}

// V3 후처리: 짧은 줄 병합 (문자열 배열용)
function mergeShortLinesSimple(lines) {
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 1어절 또는 10자 미만
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount <= 1 || trimmed.length < 10) {
      if (result.length > 0 && (result[result.length - 1] + ' ' + trimmed).length <= 28) {
        result[result.length - 1] += ' ' + trimmed;
        continue;
      }
      if (i + 1 < lines.length && (trimmed + ' ' + lines[i + 1].trim()).length <= 28) {
        result.push(trimmed + ' ' + lines[i + 1].trim());
        i++;
        continue;
      }
    }
    result.push(trimmed);
  }
  return result;
}

// V3 후처리: 구두점 제거 (문자열 배열용)
function removeTrailingPuncSimple(lines) {
  return lines.map(l => {
    let s = l.trimEnd();
    while (s.endsWith('.') || s.endsWith(',')) s = s.slice(0, -1).trimEnd();
    return s;
  }).filter(l => l.length > 0);
}

// V3 후처리: 따옴표 보정 (문자열 배열용)
function fixQuotesSimple(lines) {
  let inSingle = false, inDouble = false;
  return lines.map(line => {
    let text = line;
    const sc = (text.match(/'/g) || []).length;
    const dc = (text.match(/"/g) || []).length;
    if (inSingle && !text.startsWith("'")) text = "'" + text;
    if (inDouble && !text.startsWith('"')) text = '"' + text;
    if (sc % 2 === 1) inSingle = !inSingle;
    if (dc % 2 === 1) inDouble = !inDouble;
    if (inSingle && !text.endsWith("'")) text = text + "'";
    if (inDouble && !text.endsWith('"')) text = text + '"';
    return text;
  });
}

// ═══════════════════════════════════════
// handleSubtitleFormat — V3 + V2 + V1 하위 호환
// ═══════════════════════════════════════

async function handleSubtitleFormat(body, env, headers) {
  // ── V3: { text, version: "v3" } — 화자 턴 단위, 모델이 줄바꿈 텍스트 직접 반환 ──
  if (body.version === "v3" && body.text) {
    const inputText = body.text;

    // 직접 API 호출 (callOpenAI 미사용 — plain text 응답이므로 JSON 파싱 불필요)
    let response;
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          messages: [
            { role: "system", content: SUBTITLE_FORMAT_PROMPT_V3 },
            { role: "user", content: inputText },
          ],
          temperature: 0.1,
          max_completion_tokens: 4000,
        }),
      });
    } catch (netErr) {
      return new Response(JSON.stringify({ error: `Network error: ${netErr.message}`, _debug: { version: "v3", inputLength: inputText.length } }), { status: 502, headers });
    }

    if (response.status === 429) {
      return new Response(JSON.stringify({ error: "Rate limited", _debug: { version: "v3" } }), { status: 429, headers });
    }
    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: `OpenAI error ${response.status}`, _debug: { version: "v3", error: errText.substring(0, 300) } }), { status: response.status, headers });
    }

    const data = await response.json();
    const rawText = (data.choices?.[0]?.message?.content || "").trim();
    const finishReason = data.choices?.[0]?.finish_reason;

    if (!rawText) {
      return new Response(JSON.stringify({ error: "Empty response", _debug: { version: "v3", finishReason } }), { status: 500, headers });
    }

    // 후처리
    let lines = rawText.split('\n').filter(l => l.trim());
    lines = removeTrailingPuncSimple(lines);
    lines = mergeShortLinesSimple(lines);
    lines = fixQuotesSimple(lines);

    // 35자 초과 줄 재질의
    const resplitResult = await resplitLongLines(lines, env);
    lines = resplitResult.lines;

    const formatted = lines.join('\n');

    // 축약 검증
    const inputClean = inputText.replace(/\s+/g, '');
    const outputClean = formatted.replace(/[\n\s]+/g, '');
    const ratio = inputClean.length > 0 ? Math.round((outputClean.length / inputClean.length) * 100) : 100;

    return new Response(JSON.stringify({
      success: true,
      formatted,
      _debug: {
        version: "v3",
        inputLength: inputText.length,
        outputLength: formatted.length,
        lineCount: lines.length,
        ratio,
        truncated: ratio < 80,
        resplitCount: resplitResult.resplitCount,
        finishReason,
      },
    }), { headers });
  }

  // ── V2: { text (numbered), words, version: "v2" } ──
  if (body.version === "v2" && body.text && body.words) {
    const numbered = body.text;
    const words = body.words;
    const wordCount = words.length;

    // ── 모델 호출 (단일 청크) ──
    let response;
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          messages: [
            { role: "system", content: SUBTITLE_FORMAT_PROMPT },
            { role: "user", content: numbered },
          ],
          temperature: 0.1,
          max_completion_tokens: 2000,
          response_format: { type: "json_object" },
        }),
      });
    } catch (netErr) {
      return new Response(JSON.stringify({ error: `Network error: ${netErr.message}`, _debug: { wordCount, error: netErr.message } }), { status: 502, headers });
    }

    if (response.status === 429) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: "gpt-5.4-mini",
            messages: [
              { role: "system", content: SUBTITLE_FORMAT_PROMPT },
              { role: "user", content: numbered },
            ],
            temperature: 0.1,
            max_completion_tokens: 2000,
            response_format: { type: "json_object" },
          }),
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Rate limit retry failed", _debug: { wordCount } }), { status: 429, headers });
      }
    }

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: `OpenAI API error ${response.status}`, _debug: { wordCount, error: errText.substring(0, 300) } }), { status: response.status, headers });
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content || "";
    const finishReason = data.choices?.[0]?.finish_reason;

    // ── 파싱: breaks_after 추출 ──
    let breaksAfter = null;

    try {
      const braceStart = rawContent.indexOf('{');
      const braceEnd = rawContent.lastIndexOf('}');
      if (braceStart !== -1 && braceEnd > braceStart) {
        const parsed = JSON.parse(rawContent.substring(braceStart, braceEnd + 1));
        if (Array.isArray(parsed.breaks_after)) {
          breaksAfter = parsed.breaks_after.filter(n => typeof n === 'number' && n >= 1 && n < wordCount);
        }
      }
    } catch (e) { /* fallback */ }

    if (!breaksAfter) {
      try {
        const arrMatch = rawContent.match(/\[[\d,\s]+\]/);
        if (arrMatch) breaksAfter = JSON.parse(arrMatch[0]).filter(n => typeof n === 'number' && n >= 1 && n < wordCount);
      } catch (e) { /* fallback */ }
    }

    // fallback: 글자수 기반 자동 분할
    if (!breaksAfter || breaksAfter.length === 0) {
      breaksAfter = [];
      let charCount = 0;
      for (let i = 0; i < words.length - 1; i++) {
        charCount += words[i].length + 1;
        if (charCount >= 20) { breaksAfter.push(i + 1); charCount = 0; }
      }
    }

    // ── 후처리 ──
    const ppResult = await postProcessSubtitleV2(words, breaksAfter, env);

    return new Response(JSON.stringify({
      success: true,
      formatted: ppResult.text,
      _debug: {
        version: "v2.2-p005",
        wordCount,
        breaksCount: breaksAfter.length,
        breaksAfter,
        resplitCount: ppResult.resplitCount,
        resplitLines: ppResult.resplitLines,
        finalLineCount: ppResult.finalLineCount,
        outputLength: ppResult.text.length,
        finishReason,
        rawPreview: rawContent.substring(0, 300),
      },
    }), { headers });
  }

  // ── V1 하위 호환: { blocks: [...] } ──
  const { blocks } = body;
  if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
    return new Response(JSON.stringify({ error: "text/version or blocks required" }), { status: 400, headers });
  }
  const fullText = blocks.map(b => b.text).join('\n');
  const { words } = preprocessForV2(fullText);
  const wordChunks = chunkWords(words);

  let allBreaksAfter = [];
  for (const chunk of wordChunks) {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          messages: [{ role: "system", content: SUBTITLE_FORMAT_PROMPT }, { role: "user", content: chunk.numbered }],
          temperature: 0.1, max_completion_tokens: 2000, response_format: { type: "json_object" },
        }),
      });
      if (resp.ok) {
        const d = await resp.json();
        const raw = d.choices?.[0]?.message?.content || "";
        try {
          const p = JSON.parse(raw.substring(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
          if (Array.isArray(p.breaks_after)) allBreaksAfter.push(...p.breaks_after.filter(n => typeof n === 'number' && n >= 1 && n <= words.length));
        } catch (e) {}
      }
    } catch (e) {}
  }
  allBreaksAfter = [...new Set(allBreaksAfter)].sort((a, b) => a - b);
  if (allBreaksAfter.length === 0) {
    let cc = 0;
    for (let i = 0; i < words.length - 1; i++) { cc += words[i].length + 1; if (cc >= 20) { allBreaksAfter.push(i + 1); cc = 0; } }
  }
  const ppResult = await postProcessSubtitleV2(words, allBreaksAfter, env);
  return new Response(JSON.stringify({ success: true, formatted: ppResult.text, blocks: [{ index: 0, text: ppResult.text }] }), { headers });
}

// ═══════════════════════════════════════
// /term-explain — 용어 설명 자동 생성
// ═══════════════════════════════════════

async function handleTermExplain(body, env, headers) {
  const { term, context } = body;
  if (!term) return new Response(JSON.stringify({ error: "term is required" }), { status: 400, headers });

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured. wrangler secret put GEMINI_API_KEY 로 설정하세요." }), { status: 500, headers });

  const prompt = `당신은 영상 강조자막용 용어 설명 작성 전문가입니다.
주어진 용어에 대해 시청자가 바로 이해할 수 있는 1~2줄 짜리 설명을 생성하세요.

## 형식
용어(영문 원어) : 일상 언어로 풀어쓴 정의

## 규칙
- 40~150자 사이
- 전문 용어를 일상 언어로 번역
- 일상 비유를 포함하면 이해도가 올라감
- 구어체 금지, 간결체로 작성
- 반드시 JSON만 출력: { "explanation": "생성된 설명" }

용어: ${term}${context ? `\n\n참고 맥락:\n${context}` : ""}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: `Gemini API error ${response.status}: ${errText}` }), { status: 502, headers });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!text) {
      return new Response(JSON.stringify({ error: "Gemini returned empty response" }), { status: 502, headers });
    }

    let jsonStr = text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const braceStart = jsonStr.indexOf('{');
    const braceEnd = jsonStr.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd !== -1) jsonStr = jsonStr.substring(braceStart, braceEnd + 1);

    try {
      const result = JSON.parse(jsonStr);
      return new Response(JSON.stringify({ success: true, result }), { headers });
    } catch {
      // JSON 파싱 실패 시 원문 텍스트를 그대로 explanation으로 반환
      return new Response(JSON.stringify({ success: true, result: { explanation: text.trim() } }), { headers });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}

// ═══════════════════════════════════════
// /visuals — 시각화 가이드 생성
// ═══════════════════════════════════════

const VISUAL_TYPES_SPEC = `## 지원하는 21가지 시각화 타입 & chart_data 구조

1. bar — 세로 막대: { labels:["A","B"], datasets:[{label:"시리즈1",data:[10,20]}], unit:"%" }
2. bar_horizontal — 가로 막대: 동일 구조
3. bar_stacked — 누적 막대: 동일 구조, datasets 2개 이상
4. line — 라인 차트: { labels:["1월","2월"], datasets:[{label:"매출",data:[100,200]}], unit:"억원" }
5. area — 영역 차트: line과 동일 구조
6. donut — 도넛: { labels:["A","B"], datasets:[{data:[60,40],colors:["#3B82F6","#EF4444"]}], unit:"%" }
7. comparison — 비교: { columns:[{label:"찬성",tone:"positive",items:["항목1"]},{label:"반대",tone:"negative",items:["항목1"]}], footer:"요약" }
8. table — 표: { headers:["항목","값"], rows:[["A","100"],["B","200"]], highlight_rows:[0] }
9. process — 프로세스: { steps:[{label:"1단계",description:"설명"}] }
10. structure — 구조도: { items:[{label:"항목",description:"설명",color:"blue",num:1}] }
11. timeline — 세로 타임라인: { events:[{period:"2020",label:"출시",description:"설명"}] }
12. timeline_horizontal — 가로 타임라인: 동일 구조
13. kpi — KPI 카드: { metrics:[{label:"매출",value:"100억",trend:"up"}] } (trend: up/down/neutral)
14. ranking — 랭킹: { items:[{rank:1,label:"1위 항목",value:"100점",description:"설명"}] }
15. matrix — 2x2 매트릭스: { quadrants:[{position:"top-left",label:"높은X·높은Y",items:["항목"]}], x_axis:"X축명", y_axis:"Y축명" }
16. stack — 스택/레이어: { layers:[{label:"레이어1",description:"설명",color:"blue"}] }
17. cycle — 순환: { steps:[{label:"단계1",description:"설명"}] }
18. checklist — 체크리스트: { headers:["항목","조건1","조건2"], rows:[["A","O","X"]] }
19. hierarchy — 계층도: { root:{label:"루트",children:[{label:"자식1",children:[]}]} }
20. radar — 레이더: { labels:["축1","축2","축3"], datasets:[{label:"항목",data:[80,60,90]}] }
21. venn — 벤 다이어그램: { sets:[{label:"A"},{label:"B"}], intersection:{label:"공통"} }
22. network — 네트워크: { nodes:[{id:"a",label:"노드A"}], edges:[{from:"a",to:"b",label:"관계"}] }
23. progress — 진행률: { steps:[{label:"완료",status:"done"},{label:"진행중"},{label:"미완"}], current:1 }`;

const VISUALS_SYSTEM_PROMPT = `당신은 유튜브 인터뷰 채널 'ttimes'의 시각 자료 편집 전문가입니다.
인터뷰 대본을 읽고, 영상에 삽입할 시각 자료(차트/도표/그래픽)를 추천합니다.

## 목표
시청자가 인터뷰 내용을 더 잘 이해할 수 있도록, 발언 내용 중 수치·비교·과정·구조 등을 시각화할 구간을 선별하고 차트 데이터를 생성합니다.

${VISUAL_TYPES_SPEC}

## 규칙
1. 인터뷰 원문에서 언급된 수치나 정보를 기반으로 chart_data를 구성하세요. 없는 수치를 만들지 마세요.
2. 각 시각 자료에 block_range를 지정하세요 — 시각 자료가 화면에 표시될 구간(블록 인덱스 범위)입니다.
3. type은 내용에 가장 적합한 것을 선택하세요.
4. 청크당 2~5개 생성. 모든 블록에 만들 필요 없음 — 시각화가 효과적인 구간만 선별.
5. priority: "high"(반드시 필요), "medium"(있으면 좋음), "low"(선택)
6. duration_seconds: 해당 시각 자료가 화면에 표시될 예상 시간(초) — 보통 5~15초

## 출력 (JSON만, 코드블록 없이)
{
  "visual_guides": [
    {
      "type": "bar|line|donut|...",
      "title": "차트 제목",
      "chart_data": { ... },
      "block_range": [시작블록, 끝블록],
      "reason": "이 구간에 시각 자료가 필요한 이유",
      "source_text": "관련 원문 발췌 (50자 이내)",
      "priority": "high|medium|low",
      "duration_seconds": 10
    }
  ]
}`;

async function handleVisuals(body, env, headers) {
  const blocks = body.blocks || [];
  if (blocks.length === 0) {
    return new Response(JSON.stringify({ error: "blocks가 비어있습니다." }), { status: 400, headers });
  }

  const chunkIndex = body.chunk_index ?? 0;
  const totalChunks = body.total_chunks ?? 1;
  const existingCount = body.existing_count ?? 0;
  const preferredType = body.preferred_type || null;
  const selectedText = body.analysis?.selected_text || null;

  let userMsg = `## 인터뷰 대본 (청크 ${chunkIndex + 1}/${totalChunks})\n\n`;
  for (const b of blocks) {
    userMsg += `[블록 ${b.index}] ${b.speaker} ${b.timestamp}\n${b.text}\n\n`;
  }

  if (selectedText) {
    userMsg += `\n## 편집자 선택 텍스트 (이 부분을 중점적으로 시각화)\n"${selectedText}"\n`;
  }
  if (preferredType) {
    userMsg += `\n## 재생성 지시: 반드시 "${preferredType}" 타입으로 생성하세요.\n`;
  }
  if (existingCount > 0) {
    userMsg += `\n참고: 이미 ${existingCount}개의 시각 자료가 생성되어 있습니다. 중복되지 않는 새로운 구간을 찾아주세요.\n`;
  }

  const result = await callOpenAI(VISUALS_SYSTEM_PROMPT, userMsg, env, {
    model: "gpt-4.1",
    temperature: 0.3,
    max_tokens: 8000,
  });

  if (result.error) {
    return new Response(JSON.stringify({ error: result.error }), { status: result.status || 500, headers });
  }

  const guides = result.content?.visual_guides || [];
  return new Response(JSON.stringify({
    success: true,
    result: { visual_guides: guides },
  }), { headers });
}

// ═══════════════════════════════════════
// /insert-cuts — 인서트 컷 추천
// ═══════════════════════════════════════

const INSERT_CUTS_SYSTEM_PROMPT = `당신은 유튜브 인터뷰 채널 'ttimes'의 인서트 컷 편집 전문가입니다.
인터뷰 대본을 읽고, 영상에 삽입할 인서트 컷(보조 영상/이미지)을 추천합니다.

## 인서트 컷이란?
인터뷰 진행 중 화자의 얼굴 대신 보여줄 보조 이미지/영상입니다. 시청자의 이해를 돕고 시각적 단조로움을 깨는 역할을 합니다.

## 3가지 유형
- **Type A (회상 일러스트)**: AI 이미지 생성(미드저니 등)으로 제작할 일러스트. 추상적 개념, 역사적 장면, 상상 속 시나리오 등. image_prompt 필수.
- **Type B (공식 이미지/유튜브)**: 구글 검색이나 유튜브에서 찾을 수 있는 공식 자료. 기업 로고, 제품 사진, 뉴스 기사, 공식 유튜브 영상 등. search_keywords 필수.
- **Type C (작품/성과물)**: 게스트나 관련 인물의 실제 작품, 성과, 결과물. 책 표지, 앱 스크린샷, 연구 결과 등.

## 규칙
1. 청크당 3~6개 추천
2. 각 인서트 컷에 block_range 지정 (표시될 블록 구간)
3. trigger_quote: 이 인서트 컷을 트리거하는 원문 발언 (정확한 인용)
4. trigger_reason: 왜 이 지점에 인서트 컷이 필요한지
5. instruction: 편집자에게 전달할 구체적 지시사항
6. source_type: "illustration"(A), "official_image"(B), "official_youtube"(B), "guest_provided"(C)

## 출력 (JSON만, 코드블록 없이)
{
  "insert_cuts": [
    {
      "type": "A|B|C",
      "type_name": "회상 일러스트|공식 이미지|작품/성과물",
      "title": "인서트컷 제목",
      "trigger_quote": "이 인서트컷을 유발하는 원문 발언",
      "trigger_reason": "이 지점에 인서트 컷이 필요한 이유",
      "instruction": "편집자에게 전달할 구체적 지시",
      "block_range": [시작블록, 끝블록],
      "source_type": "illustration|official_image|official_youtube|guest_provided",
      "image_prompt": "(Type A만) 미드저니 스타일 영문 프롬프트",
      "search_keywords": ["(Type B만) 검색 키워드1", "키워드2"],
      "youtube_search": { "query": "(Type B만) 유튜브 검색어" },
      "asset_note": "소재 확보 시 주의사항 (선택)"
    }
  ]
}`;

async function handleInsertCuts(body, env, headers) {
  const blocks = body.blocks || [];
  if (blocks.length === 0) {
    return new Response(JSON.stringify({ error: "blocks가 비어있습니다." }), { status: 400, headers });
  }

  const chunkIndex = body.chunk_index ?? 0;
  const totalChunks = body.total_chunks ?? 1;
  const existingCount = body.existing_count ?? 0;
  const selectedText = body.analysis?.selected_text || null;

  let userMsg = `## 인터뷰 대본 (청크 ${chunkIndex + 1}/${totalChunks})\n\n`;
  for (const b of blocks) {
    userMsg += `[블록 ${b.index}] ${b.speaker} ${b.timestamp}\n${b.text}\n\n`;
  }

  if (selectedText) {
    userMsg += `\n## 편집자 선택 텍스트 (이 부분에 대한 인서트 컷 추천)\n"${selectedText}"\n`;
  }
  if (existingCount > 0) {
    userMsg += `\n참고: 이미 ${existingCount}개의 인서트 컷이 생성되어 있습니다. 중복되지 않는 새로운 구간을 찾아주세요.\n`;
  }

  const result = await callOpenAI(INSERT_CUTS_SYSTEM_PROMPT, userMsg, env, {
    model: "gpt-4.1",
    temperature: 0.3,
    max_tokens: 8000,
  });

  if (result.error) {
    return new Response(JSON.stringify({ error: result.error }), { status: result.status || 500, headers });
  }

  const cuts = result.content?.insert_cuts || [];
  return new Response(JSON.stringify({
    success: true,
    result: { insert_cuts: cuts },
  }), { headers });
}

// ═══════════════════════════════════════
// /hl-recommend — 하이라이트 AI 추천
// ═══════════════════════════════════════

const HL_RECOMMEND_PROMPT = `당신은 유튜브 인터뷰 채널 'ttimes'의 하이라이트 편집자입니다.
인터뷰 원고를 읽고, 30~40초 분량의 하이라이트 영상에 쓸 수 있는 인상적인 발언 구간을 추천합니다.

## 하이라이트란?
- 인터뷰에서 가장 임팩트 있는 발언 5~8개를 뽑아 이어 붙인 30~40초짜리 쇼츠/프리뷰 영상
- 시청자가 "이 인터뷰 본편을 봐야겠다"고 느끼게 만드는 것이 목적
- 각 발언은 2~8초 분량 (10~50자 정도)

## 좋은 하이라이트 구간의 조건
1. 그 자체로 임팩트가 있는 문장 (맥락 없이 들어도 "오?" 하는 발언)
2. 구체적 숫자나 사실이 포함된 발언 ("토큰을 월 4000달러 씁니다")
3. 감정이 실린 단언 ("적게 써서 잘할 가능성은 없어요")
4. 대비/반전이 있는 발언 ("주니어는 400불, 시니어는 4000불")
5. 게스트만의 독특한 표현이나 비유
6. 호스트(홍재의)의 날카로운 질문이나 반응도 포함 가능

## 피해야 할 구간
- 너무 긴 설명이나 나열
- 맥락 없이는 이해 불가능한 발언
- "네", "그렇죠" 같은 맞장구만 있는 부분

## 출력 형식 (JSON만 출력)
{
  "candidates": [
    {
      "text": "원고에서 발췌한 정확한 텍스트",
      "speaker": "화자명",
      "reason": "왜 하이라이트에 적합한지",
      "impact": "high|medium",
      "estimated_seconds": 3
    }
  ],
  "suggested_flow": "추천 순서대로 이어붙였을 때의 흐름 설명 (1문장)"
}

## 규칙
- 후보를 8~12개 추천 (편집자가 그중 5~8개를 선택)
- impact가 high인 것을 5개 이상 포함
- 원고의 텍스트를 정확히 발췌 (수정하지 말 것)
- estimated_seconds는 ttimes 인터뷰 말하기 속도 기준 (초당 약 9자, 분당 540자)
- 총 후보의 합산이 60~90초 분량이 되도록`;

function compressScriptForHl(text, maxChars) {
  if (text.length <= maxChars) return text;
  var h = Math.floor(maxChars * 0.4), t = Math.floor(maxChars * 0.4);
  var mid = maxChars - h - t - 50, ms = Math.floor(text.length * 0.4);
  return text.substring(0, h) + "\n[...중략...]\n" + text.substring(ms, ms + mid) + "\n[...중략...]\n" + text.substring(text.length - t);
}

async function handleHlRecommend(body, env, headers) {
  if (!body.script) return new Response(JSON.stringify({ error: "script required" }), { status: 400, headers });
  if (!env.OPENAI_API_KEY) return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured" }), { status: 500, headers });

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1",
        messages: [{ role: "system", content: HL_RECOMMEND_PROMPT }, { role: "user", content: compressScriptForHl(body.script, 14000) }],
        temperature: 0.5, max_tokens: 2000,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const content = data.choices?.[0]?.message?.content || "";
    const jm = content.match(/\{[\s\S]*\}/);
    if (!jm) throw new Error("JSON parse failed");
    return new Response(JSON.stringify({ success: true, result: JSON.parse(jm[0]) }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
  }
}

// ═══════════════════════════════════════
// /hl-timestamps — 유튜브 타임스탬프 생성
// ═══════════════════════════════════════

async function handleHlTimestamps(body, env, headers) {
  if (!body.script) return new Response(JSON.stringify({ error: "script required" }), { status: 400, headers });
  if (!env.OPENAI_API_KEY) return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured" }), { status: 500, headers });

  const tsPrompt = `당신은 유튜브 인터뷰 영상의 챕터(타임스탬프)를 생성하는 전문가입니다.

## 작업
인터뷰 원고를 읽고, 유튜브 영상 설명란에 넣을 타임스탬프(챕터)를 생성합니다.

## 핵심 규칙
1. 토픽이 전환되는 지점을 찾아서 5~10개의 챕터로 나누기
2. 각 챕터의 제목은 시청자가 검색할 만한 구체적이고 흥미로운 문구 (SEO 최적화)
3. "인트로", "아웃트로", "마무리" 같은 일반적인 제목 대신 내용을 반영한 제목 사용
4. 각 챕터 전환점이 원고 어디에 있는지 "해당 구간의 첫 문장"을 anchor_text로 제공

## 중요
- 원고의 화자 타임스탬프는 편집 전 원본 시간이므로 무시하세요
- 최종 영상 시간은 별도로 계산됩니다
- 당신은 오직 "토픽 전환점"과 "소제목"만 잡아주면 됩니다

## 출력 형식 (JSON만 출력)
{
  "chapters": [
    {
      "title": "챕터 제목 (검색 최적화된 구체적 문구)",
      "anchor_text": "이 챕터가 시작되는 원고의 첫 문장 또는 핵심 구절 (정확히 발췌)",
      "summary": "이 구간에서 다루는 내용 한 줄 요약"
    }
  ],
  "video_title_suggestion": "영상 전체를 아우르는 제목 제안 (선택)"
}

## 규칙
- 첫 번째 챕터는 영상 시작 부분 (인트로 대신 내용 반영 제목)
- 5~10개 챕터 생성
- anchor_text는 원고에서 정확히 발췌 (수정하지 말 것)
- 챕터 제목은 15자 이내로 간결하게`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1",
        messages: [{ role: "system", content: tsPrompt }, { role: "user", content: compressScriptForHl(body.script, 14000) }],
        temperature: 0.4, max_tokens: 2000,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const content = data.choices?.[0]?.message?.content || "";
    const jm = content.match(/\{[\s\S]*\}/);
    if (!jm) throw new Error("JSON parse failed");
    return new Response(JSON.stringify({ success: true, result: JSON.parse(jm[0]) }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
  }
}

// ═══════════════════════════════════════
// /setgen — 세트 생성 (키워드+트렌드+3종 GPT)
// ═══════════════════════════════════════

const SETGEN_KEYWORD_SYSTEM = `인터뷰 원고에서 유튜브 검색에 활용할 핵심 키워드를 추출합니다.
JSON만 출력. 다른 텍스트 없이.
{"keywords":["키워드1","키워드2",...],"guest_summary":"게스트 한줄 소개","notable_quotes":["인상적 발언1","인상적 발언2"]}
규칙:
- keywords: 6~10개. 고유명사(인물, 기업, 서비스명) 우선. "AI 커머스"처럼 구체화
- notable_quotes: 원고에서 게스트가 한 인상적 발언 3~5개 (원문 그대로). 직관적이고 파급력 있는 표현 우선`;

function makeSetgenPrompt(type) {
  var typeGuide = {
    balanced: "## 이번 후보: ⚖️ 밸런스형\n원고의 핵심 발언 + 시의성 있는 트렌드의 교집합을 찾아 앵글을 잡습니다.\n- 썸네일/제목: 원고 내용에 충실하되, 트렌드 데이터에서 시의성이 확인된 표현을 자연스럽게 활용\n- 설명문: 원고 내용 요약 + \"지금 왜 이 주제가 중요한지\" 시의성 연결",
    script: "## 이번 후보: 📝 스크립트 충실형\n게스트만의 독보적 시각과 인상적 발언을 최대한 살립니다.\n- 썸네일/제목: 게스트의 실제 발언이나 비유를 직접 활용. 트렌드 키워드를 억지로 넣지 않음\n- 설명문: 게스트의 분석과 주장을 충실하게 전달\n- \"이 게스트가 아니면 들을 수 없는 이야기\"가 드러나야 함",
    focus: "## 이번 후보: 🎯 선택과 집중\n편집자가 지정한 키워드를 중심 앵글로 세트를 만듭니다.\n\n★ 가장 중요한 규칙: 키워드가 언급된 특정 문장 하나만 보지 마세요.\n원고 전체에서 해당 키워드와 관련된 모든 맥락을 파악한 뒤 세트를 만드세요.\n- 게스트가 왜 이 주제를 꺼냈는가 (배경)\n- 어떤 흐름과 논리로 설명하고 있는가 (전개)\n- 어떤 결론이나 전망을 제시하는가 (핵심 메시지)\n이 세 가지를 종합해서 \"이 영상에서 [키워드]에 대해 알 수 있는 것\"의 전체 그림을 세트에 담으세요.\n\n- 썸네일/제목: 키워드 관련 전체 맥락에서 가장 임팩트 있는 앵글을 잡을 것\n- 설명문: 키워드와 관련된 게스트의 분석 흐름을 충실하게 요약",
    trend: "## 이번 후보: 🔍 시의성 극대화형\n지금 사람들이 관심 있는 주제와 원고 내용의 교집합을 극대화합니다.\n- 썸네일/제목: 뉴스건수가 많거나 급상승 중인 키워드를 앞에 배치. \"지금 뜨는 주제\"임을 즉시 느끼게\n- 설명문: 현재 이슈 → 원고의 분석 → 왜 지금 봐야 하는지 순서로 구성\n- 트렌드 데이터에서 뉴스 건수가 가장 많은 키워드, 급상승 매칭된 키워드를 최우선 활용",
  };

  return `당신은 유튜브 인터뷰 채널 'ttimes'의 편집자입니다.

## ttimes 채널 특성
- 구독자 수만~수십만 규모의 테크/비즈니스 심층 인터뷰 채널
- 시청자 유입의 69%가 홈 피드 추천(41%)과 추천 동영상(28%)
- 검색 유입은 11.7%에 불과 → 태그/검색 최적화보다 CTR이 핵심
- 현재 노출 클릭률 3.5% → 4~5%로 올리는 것이 최우선 목표

## 세트 생성의 핵심 원칙
### 1. 썸네일/제목: 홈 피드에서 스크롤을 멈추게 하는 것
- "정보 격차(information gap)" — 모르면 손해일 것 같은 느낌
- 구체적 숫자, 고유명사, 대비 구조가 효과적

### 2. 시의성이 CTR을 올린다
- 트렌드 데이터에서 뉴스 건수가 많은 키워드 = 지금 사람들이 관심 있는 주제

### 3. Quality CTR
- 썸네일/제목이 약속한 것을 영상이 반드시 전달해야 함
- 원고에 분명히 있는 내용만 활용

### 4. 썸네일+제목 "1+1=3" 원칙 (가장 중요)
- 썸네일과 제목은 서로 다른 정보를 전달해야 함
- 보완 패턴: (A) 감정/훅+맥락, (B) 결과/수치+원인/질문, (C) 발언+프레이밍

${typeGuide[type]}

## 출력 형식 (JSON만 출력)
{
  "tags": [{"tag":"키워드","source":"trend|script|both","reason":"근거"}],
  "thumbnail": {"lines":["줄1","줄2","줄3(선택)"],"reason":"앵글 선택 이유"},
  "youtube_title": {"text":"제목","reason":"CTR 전략"},
  "description": {"text":"설명문","reason":"구성 전략"}
}

## 태그 규칙: 12~15개 (1단어 5~6개, 2단어 6~8개, 3단어 1~2개)
## 썸네일: 2~3줄, 핵심 훅 + 구체적 정보
## 유튜브 제목: 40~60자, 핵심 주제어 앞 20자, (게스트명 직함) 형식 끝
## 설명문: 4~6문장, 시의성→인사이트→게스트 소개

## 트렌드 데이터 해석법
- 🔥급상승 = Google Trends 급상승 → 시의성 최고
- 📰뉴스 N건 = 최근 24시간 뉴스 기사 수
- 급상승 + 뉴스 많음 + 원고 내용 = 최적의 앵글`;
}

async function getYTSuggestions(keyword) {
  try {
    var res = await fetch("https://clients1.google.com/complete/search?client=youtube&hl=ko&gl=kr&ds=yt&q=" + encodeURIComponent(keyword), { headers: { "User-Agent": "Mozilla/5.0" } });
    var text = await res.text();
    var s = text.indexOf("["), e = text.lastIndexOf("]") + 1;
    if (s === -1) return [];
    return (JSON.parse(text.substring(s, e))[1] || []).map(function(i) { return i[0]; });
  } catch (e) { return []; }
}

async function getGoogleSuggestions(keyword) {
  try {
    var res = await fetch("https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&gl=kr&q=" + encodeURIComponent(keyword), { headers: { "User-Agent": "Mozilla/5.0" } });
    return (await res.json())[1] || [];
  } catch (e) { return []; }
}

async function getGoogleTrendsRSS() {
  try {
    var res = await fetch("https://trends.google.com/trending/rss?geo=KR", { headers: { "User-Agent": "Mozilla/5.0" } });
    var xml = await res.text();
    var titles = [];
    var re = /<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g;
    var m;
    while ((m = re.exec(xml)) !== null) { titles.push(m[1]); }
    if (titles.length <= 1) {
      re = /<item>[\s\S]*?<title>([^<]+)<\/title>/g;
      while ((m = re.exec(xml)) !== null) { titles.push(m[1]); }
    }
    return titles.slice(0, 20);
  } catch (e) { return []; }
}

async function getNewsCount(keyword) {
  try {
    var url = "https://news.google.com/rss/search?q=" + encodeURIComponent(keyword) + "+when:1d&hl=ko&gl=KR&ceid=KR:ko";
    var res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    var xml = await res.text();
    return (xml.match(/<item>/g) || []).length;
  } catch (e) { return 0; }
}

async function callGPTForSetgen(system, user, apiKey, maxTokens, temp) {
  var res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4.1", messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: temp, max_tokens: maxTokens }),
  });
  var data = await res.json();
  if (data.error) throw new Error(data.error.message);
  var content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  var jm = content.match(/\{[\s\S]*\}/);
  if (!jm) throw new Error("JSON parse failed: " + content.substring(0, 300));
  return JSON.parse(jm[0]);
}

async function handleSetgen(body, env, headers) {
  var script = body.script, guest_name = body.guest_name, guest_title = body.guest_title;
  var focus_keyword = body.focus_keyword || "";
  if (!script) return new Response(JSON.stringify({ success: false, error: "script required" }), { status: 400, headers });
  if (!env.OPENAI_API_KEY) return new Response(JSON.stringify({ success: false, error: "OPENAI_API_KEY not configured" }), { status: 500, headers });

  try {
    // Step 1: 키워드 + 인상적 발언 추출
    var kwResult = await callGPTForSetgen(SETGEN_KEYWORD_SYSTEM, compressScriptForHl(script, 10000), env.OPENAI_API_KEY, 800, 0.3);
    var keywords = kwResult.keywords || [];
    var guestSummary = kwResult.guest_summary || "";
    var notableQuotes = kwResult.notable_quotes || [];

    // Step 2: 트렌드 데이터 병렬 수집
    var trendData = {};
    var kwSlice = keywords.slice(0, 8);
    var acPromises = kwSlice.map(function(kw) {
      return Promise.all([getYTSuggestions(kw), getGoogleSuggestions(kw), getNewsCount(kw)]).then(function(r) {
        trendData[kw] = { youtube: r[0].slice(0, 8), google: r[1].slice(0, 8), news_24h: r[2] };
      });
    });
    var trendsPromise = getGoogleTrendsRSS();
    var results = await Promise.all([Promise.all(acPromises), trendsPromise]);
    var trendingNow = results[1] || [];

    // Step 3: 트렌드 블록 포맷
    var tb = "## 실시간 트렌드 데이터\n\n";
    tb += "### 🔥 Google Trends 한국 급상승 검색어 (상위 20)\n";
    if (trendingNow.length > 0) { trendingNow.forEach(function(t, i) { tb += (i + 1) + ". " + t + "\n"; }); }
    else { tb += "(수집 실패)\n"; }

    tb += "\n### 키워드별 시의성 지표\n\n";
    for (var kw in trendData) {
      var d = trendData[kw];
      tb += '#### "' + kw + '" 📰뉴스 ' + d.news_24h + '건/24h';
      var matched = trendingNow.filter(function(t) { return t.indexOf(kw) >= 0 || kw.indexOf(t) >= 0; });
      if (matched.length > 0) tb += " 🔥급상승";
      tb += "\n";
      if (d.youtube.length > 0) tb += "YT자동완성: " + d.youtube.slice(0, 5).map(function(s, i) { return (i+1) + "." + s; }).join(" | ") + "\n";
      if (d.google.length > 0) tb += "Google자동완성: " + d.google.slice(0, 5).map(function(s, i) { return (i+1) + "." + s; }).join(" | ") + "\n";
      tb += "\n";
    }

    var quotesBlock = "";
    if (notableQuotes.length > 0) {
      quotesBlock = "\n## 게스트 인상적 발언 (원문)\n";
      notableQuotes.forEach(function(q, i) { quotesBlock += (i+1) + '. "' + q + '"\n'; });
    }

    // Step 4: 3개 후보 개별 호출
    var guestInfo = "## 게스트\n- 이름: " + (guest_name || "(추출)") + "\n- 직함: " + (guest_title || guestSummary || "(추출)") + "\n\n";
    var scriptBlock = "\n## 인터뷰 원고\n" + compressScriptForHl(script, 7000);
    var userBase = guestInfo + tb + quotesBlock + scriptBlock;

    var thirdType, thirdPrompt, thirdUser, thirdTemp;
    if (focus_keyword.trim()) {
      thirdType = "focus";
      thirdPrompt = makeSetgenPrompt("focus");
      thirdUser = guestInfo + tb + quotesBlock + "\n## 🎯 편집자 지정 앵글\n키워드: " + focus_keyword + "\n" + scriptBlock;
      thirdTemp = 0.75;
    } else {
      thirdType = "script";
      thirdPrompt = makeSetgenPrompt("script");
      thirdUser = userBase;
      thirdTemp = 0.7;
    }

    var setResults = await Promise.all([
      callGPTForSetgen(makeSetgenPrompt("balanced"), userBase, env.OPENAI_API_KEY, 2000, 0.8),
      callGPTForSetgen(makeSetgenPrompt("trend"), userBase, env.OPENAI_API_KEY, 2000, 0.85),
      callGPTForSetgen(thirdPrompt, thirdUser, env.OPENAI_API_KEY, 2000, thirdTemp),
    ]);

    // 결과 병합
    var merged = {
      tags: [],
      thumbnail: [
        Object.assign({ type: "balanced" }, setResults[0].thumbnail),
        Object.assign({ type: "trend" }, setResults[1].thumbnail),
        Object.assign({ type: thirdType }, setResults[2].thumbnail),
      ],
      youtube_title: [
        Object.assign({ type: "balanced" }, setResults[0].youtube_title),
        Object.assign({ type: "trend" }, setResults[1].youtube_title),
        Object.assign({ type: thirdType }, setResults[2].youtube_title),
      ],
      description: [
        Object.assign({ type: "balanced" }, setResults[0].description),
        Object.assign({ type: "trend" }, setResults[1].description),
        Object.assign({ type: thirdType }, setResults[2].description),
      ],
    };

    // 태그 병합
    var tagMap = {};
    setResults.forEach(function(sr) {
      (sr.tags || []).forEach(function(t) {
        if (!tagMap[t.tag]) tagMap[t.tag] = t;
        else if (t.source === "both") tagMap[t.tag] = t;
      });
    });
    merged.tags = Object.values(tagMap).slice(0, 15);

    return new Response(JSON.stringify({
      success: true, result: merged, trend_data: trendData, trending_now: trendingNow,
      keywords_extracted: keywords, notable_quotes: notableQuotes, focus_keyword: focus_keyword,
    }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
  }
}

// ═══════════════════════════════════════
// /save-image, /image — 스크린샷 이미지 저장/로드/삭제
// ═══════════════════════════════════════

async function handleSaveImage(body, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const { sessionId, cardId, imageData } = body;
  if (!sessionId || !cardId || !imageData) {
    return new Response(JSON.stringify({ error: "sessionId, cardId, imageData 필수" }), { status: 400, headers });
  }
  // base64 이미지 저장 (TTL 365일)
  await env.SESSIONS.put(`s:${sessionId}:img:${cardId}`, imageData, { expirationTtl: 365 * 86400 });
  return new Response(JSON.stringify({ success: true }), { headers });
}

async function handleImageGet(sessionId, cardId, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const imageData = await env.SESSIONS.get(`s:${sessionId}:img:${cardId}`);
  if (!imageData) {
    return new Response(JSON.stringify({ error: "이미지 없음" }), { status: 404, headers });
  }
  return new Response(JSON.stringify({ success: true, imageData }), { headers });
}

async function handleImageDelete(sessionId, cardId, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  await env.SESSIONS.delete(`s:${sessionId}:img:${cardId}`);
  return new Response(JSON.stringify({ success: true }), { headers });
}
