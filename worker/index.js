// ttimes-editor — Cloudflare Worker
// 7개 엔드포인트: /analyze, /correct, /spellcheck, /highlights, /visuals, /save, /load/:id
// OpenAI GPT-5.1 API 프록시 + CORS 완전 제어 + KV 세션 저장
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
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
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

    const loadMatch = path.match(/^\/load\/([a-zA-Z0-9]+)$/);
    if (loadMatch && request.method === "GET") {
      return await handleLoad(loadMatch[1], env, corsHeaders);
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

      if (path === "/dict") return await handleDictPost(body, env, corsHeaders);
      else if (path === "/save") return await handleSave(body, env, corsHeaders);
      else if (path === "/autosave") return await handleAutoSave(body, env, corsHeaders);
      else if (path === "/analyze") return await handleAnalyze(body, env, corsHeaders);
      else if (path === "/correct") return await handleCorrect(body, env, corsHeaders);
      else if (path === "/spellcheck") return await handleSpellcheck(body, env, corsHeaders);
      else if (path === "/subtitle-format") return await handleSubtitleFormat(body, env, corsHeaders);
      else if (path === "/highlights") return await handleHighlights(body, env, corsHeaders);
      else if (path === "/term-explain") return await handleTermExplain(body, env, corsHeaders);
      else if (path === "/visuals") return await handleVisuals(body, env, corsHeaders);
      else return new Response(JSON.stringify({ error: "Unknown endpoint" }), { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  },
};

// ═══════════════════════════════════════
// /save, /load
// ═══════════════════════════════════════

async function handleSave(body, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const id = body.id || Array.from(crypto.getRandomValues(new Uint8Array(5))).map(b => b.toString(36)).join("").slice(0, 8);
  const { id: _discardId, ...dataWithoutId } = body;
  const savedAt = new Date().toISOString();
  await env.SESSIONS.put("save_" + id, JSON.stringify({ ...dataWithoutId, savedAt }), { expirationTtl: 60*60*24*365 });

  // 세션 인덱스 업데이트 (목록 관리)
  try {
    const indexData = await env.SESSIONS.get("session_index");
    const index = indexData ? JSON.parse(indexData) : [];
    const existing = index.findIndex(s => s.id === id);
    const entry = {
      id,
      fn: body.fn || "제목 없음",
      savedAt,
      blockCount: body.blocks?.length || 0,
      hasGuide: (body.hl?.length || 0) > 0,
    };
    if (existing >= 0) {
      index[existing] = entry;
    } else {
      index.unshift(entry);
    }
    const trimmed = index.slice(0, 200);
    await env.SESSIONS.put("session_index", JSON.stringify(trimmed));
  } catch (e) {
    console.error("세션 인덱스 업데이트 실패:", e.message);
  }

  return new Response(JSON.stringify({ success: true, id }), { headers });
}

// 세션 목록 조회
async function handleSessionList(env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const indexData = await env.SESSIONS.get("session_index");
  const index = indexData ? JSON.parse(indexData) : [];
  return new Response(JSON.stringify({ success: true, sessions: index }), { headers });
}

// 세션 삭제
async function handleSessionDelete(body, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const { id } = body;
  if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers });
  // KV에서 세션 데이터 삭제
  await env.SESSIONS.delete(id);
  // 인덱스에서도 제거
  try {
    const indexData = await env.SESSIONS.get("session_index");
    const index = indexData ? JSON.parse(indexData) : [];
    const filtered = index.filter(s => s.id !== id);
    await env.SESSIONS.put("session_index", JSON.stringify(filtered));
  } catch (e) {}
  return new Response(JSON.stringify({ success: true }), { headers });
}

// 자동 저장 (TTL 7일)
async function handleAutoSave(body, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const id = body.id || Array.from(crypto.getRandomValues(new Uint8Array(5))).map(b => b.toString(36)).join("").slice(0, 8);
  const { id: _discardId, ...dataWithoutId } = body;
  const savedAt = new Date().toISOString();
  await env.SESSIONS.put("auto_" + id, JSON.stringify({ ...dataWithoutId, savedAt }), { expirationTtl: 60*60*24*7 });
  return new Response(JSON.stringify({ success: true, id }), { headers });
}

async function handleLoad(id, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  // save_ 우선, 기존 키 폴백, auto_ 최종 폴백
  var data = await env.SESSIONS.get("save_" + id);
  if (!data) data = await env.SESSIONS.get(id);
  if (!data) data = await env.SESSIONS.get("auto_" + id);
  if (!data) return new Response(JSON.stringify({ error: "세션을 찾을 수 없습니다." }), { status: 404, headers });
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
// /correct — 1단계: 청크별 교정 (강화)
// ═══════════════════════════════════════

const BASE_CORRECT_PROMPT = `You are a professional editor specializing in correcting Korean interview transcripts produced by STT (Speech-to-Text).
You follow the Korean National Institute of Korean Language (국립국어원) standard spelling and spacing rules.
You correct word-level errors while preserving the original conversation's content, tone, and nuance as much as possible.
Preserve the original form of technical terms and proper nouns — only fix typos.

## Scope of Work

### 1. Filler Word & Interjection Removal
You MUST find and remove unnecessary interjections and habitual filler words embedded within sentences.

**Interjection removal targets:** "자", "음", "어", "아니", "이제", "인제", "또", "좀", "뭐", "그냥", "약간", "진짜", "되게", "막", "이렇게", "저렇게", "사실", "근데"

**Short-response removal targets:** "네", "그렇죠", "맞아요", "아니요" etc. when used as standalone back-channel responses.
- Exception: Keep "네"/"아니요" when it is a substantive answer to a question.
- NEVER delete standalone reaction utterances (where a speaker's entire turn is just a back-channel response).

**Additional patterns to find:**
- Speaker-specific verbal habits: Any meaningless word/phrase a specific speaker uses repeatedly, even if not in the list above.
  Examples: "그래가지고", "뭐라 그러냐", "어떻게 보면", "이런 거", "그니까"
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

### 2. STT Misrecognition Correction
- Words mapped in the terminology dictionary below → MUST be corrected. This is mandatory, not optional.
- Speaker name misrecognitions must also be corrected.
- Words not in the dictionary → use context judgment. If uncertain, keep the original.

### 3. Number & Quantity Notation Rules (★ Highest Priority)
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

### 4. User-Specified Notation Rules (★ Highest Priority)
These rules override the terminology dictionary:
- "챗gpt", "챗지피티" → "챗GPT"
- "에이전트 AI" → "AI 에이전트"
- "AI 에이전틱" → "에이전틱 AI"
- "NVIDIA" → "엔비디아"
- "아웃소싱" → "외주"

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
    }]
  }]
}

## Absolute Rules
1. NEVER modify document structure (speaker names, timestamps, paragraphs).
2. NEVER delete standalone reaction utterances (a speaker's entire turn being just a back-channel).
3. NEVER misidentify meaningful words as fillers.
4. NEVER make uncertain corrections.
5. NEVER rearrange or summarize sentences.
6. Process ALL blocks without skipping any.
7. Output JSON ONLY — no other text.
8. **Terminology dictionary mappings are MANDATORY. Do not ignore them.**
9. **Number notation rules and user-specified notation rules take HIGHEST priority.**`;

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
    return new Response(JSON.stringify({ success: true, result: result.content, chunk_index, usage: result.usage }), { headers });
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
// /spellcheck — Step 1.5
// ═══════════════════════════════════════

const SPELLCHECK_PROMPT = `You are a Korean spelling, spacing, and style editor.
You follow the Korean National Institute of Korean Language standard rules.
The input text has already been through Step 1 editing (filler removal + term correction).
Your job is to catch remaining spelling, spacing, and colloquial expression issues.

## Scope of Work

### 1. Spacing (highest frequency issue)
Fix spacing errors involving particles, dependent nouns, auxiliary verbs, and compound words.
- "할 수있다" → "할 수 있다"
- "안되" → "안 되" (negation + verb spacing)
- "못하" → "못 하" (negation + auxiliary verb spacing)

### 2. Orthography
Fix misspellings based on standard Korean orthography rules.
Common targets: 됬→됐, 웬지→왠지, 몇일→며칠, 어떻게/어떡해, 안돼/안되, 데/대, 로서/로써, 되/돼

### 3. Particle Correction
Fix incorrect particles based on the preceding syllable's final consonant.
Targets: 을/를, 이/가, 은/는, 과/와, 으로/로

### 4. Punctuation
Fix missing periods, misplaced commas.

### 5. Colloquial Expression Polishing

This transcript is for broadcast subtitles. Polish overly casual spoken language while preserving the speaker's natural tone.

**5-1. Mandatory mappings (always apply):**
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

**5-2. Active detection (★ proactively find and fix these):**
Beyond the mandatory list above, actively search for these patterns:
- Contracted verbs → full forms: "갖다" → "가져다", "갖고" → "가지고"
- Spoken connectives → written forms: "해가지고" → "해서", "그래갖고" → "그래서", "해 갖고" → "해서"
- Informal endings in polite-speech context: "~거든" → "~거든요", "~잖아" → "~잖아요"
- Redundant particles: "~하면을" → "~하면", "~에다가" → "~에"
- Unnecessary repetition: "진짜 진짜 좋은" → "정말 좋은"
- Verb ending cleanup: "하는거에요" → "하는 거예요", "하는거죠" → "하는 거죠"

**5-3. Preserve these (do NOT correct):**
- "~거든요", "~잖아요", "~인 거죠", "~인 거예요" — speaker's conversational style
- "~인 건데", "~한 건데" — natural contractions
- "뭔가" — acceptable in spoken interview context (do NOT change to "무언가")
- "어쨌든" — standard form, no correction needed

### 6. Number Notation Recheck
Catch any number notation errors missed in Step 1.
- "천억" → "1000억", "사천만 명" → "4000만 명"
- Ranges: "이삼십 명" → "20~30명", "삼사만 원" → "3만~4만 원"

## Output Format (changes only, JSON)
{
  "chunks": [{
    "block_index": 3,
    "changes": [{
      "type": "spelling", "subtype": "spacing",
      "original": "할 수있다", "corrected": "할 수 있다",
      "reason": "dependent noun spacing"
    }, {
      "type": "spelling", "subtype": "colloquial",
      "original": "해가지고", "corrected": "해서",
      "reason": "spoken connective → written form"
    }]
  }]
}

## Absolute Rules
1. NEVER shorten, condense, or summarize sentences.
2. NEVER change technical terms or proper nouns.
3. NEVER alter speaker's characteristic speech patterns (~거든요, ~잖아요, ~인 거죠).
4. Output JSON ONLY — no other text.
5. If the input text already has correct spelling and style, return {"chunks":[]}.`;

async function handleSpellcheck(body, env, headers) {
  const { chunk_text, chunk_index, total_chunks, context_blocks } = body;
  if (!chunk_text) return new Response(JSON.stringify({ error: "chunk_text is required" }), { status: 400, headers });

  let userMsg = "";
  if (context_blocks) userMsg += `[Context reference — do NOT modify]\n${context_blocks}\n\n`;
  userMsg += `[Correction target — chunk ${(chunk_index||0)+1}/${total_chunks||1}]\n${chunk_text}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await callOpenAI(SPELLCHECK_PROMPT, userMsg, env, { temperature: 0.1, max_tokens: 32000 });
    if (result.error && result.status === 429) { await new Promise(r => setTimeout(r, (attempt+1)*3000)); continue; }
    if (result.error) return new Response(JSON.stringify({ error: result.error }), { status: result.status||500, headers });
    return new Response(JSON.stringify({ success: true, result: result.content, chunk_index, usage: result.usage }), { headers });
  }
  return new Response(JSON.stringify({ error: "All retries failed" }), { status: 500, headers });
}

// ═══════════════════════════════════════
// /subtitle-format — 자막용 줄바꿈 포맷팅 (V2: Word-Index System)
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
PRIORITY 3 — Aim for roughly 15–25 characters per line, but NEVER sacrifice Priority 1 or 2 for character count. A 10-character line or a 28-character line is acceptable if splitting would break a semantic unit.
</decision_criteria>

<clause_boundaries>
These are natural break points in Korean speech.

Break AFTER words ending with these suffixes:
~하고, ~해서, ~인데, ~지만, ~니까, ~있고, ~거든요, ~잖아요, ~됐고, ~보니까, ~계세요, ~는데, ~때문에

Break BEFORE these conjunctions (they start a new line):
그래서, 그리고, 하지만, 결국, 심지어, 특히, 마찬가지로, 근데, 그러니까, 그런데

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
</example>

<example id="3">
<input>
[1]1년 [2]만에 [3]30년 [4]개발자 [5]기업 [6]분석 [7]시리즈를 [8]저희가 [9]다시 [10]시작해서 [11]지금 [12]이어가고 [13]있는데 [14]일단 [15]토큰을 [16]중심으로 [17]하는 [18]토큰 [19]이코노미가 [20]굉장히 [21]중요하다고 [22]말씀해 [23]주셨고 [24]코딩 [25]에이전트는 [26]이미 [27]다 [28]보급돼서 [29]우리가 [30]잘 [31]쓰고 [32]있고
</input>
<correct_output>{"breaks_after": [7, 13, 19, 23, 28]}</correct_output>
</example>

</examples>

<output_format>
Return ONLY valid JSON. Nothing before or after.
{"breaks_after": [3, 6, 12, 20, 25, 30]}

The numbers are word indices AFTER which a line break is inserted.
Do NOT include the last word's index (no trailing break).
Do NOT output any text, explanation, or markdown — JSON only.
</output_format>`;

// ── 어절 번호 부여 ──
function numberWords(text) {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const numbered = words.map((w, i) => `[${i + 1}]${w}`).join(' ');
  return { words, numbered, count: words.length };
}

// ── breaks_after → 줄바꿈 텍스트 재조립 ──
function applyBreaks(words, breaksAfter) {
  const breakSet = new Set(breaksAfter);
  const lines = [];
  let currentLine = [];
  for (let i = 0; i < words.length; i++) {
    currentLine.push(words[i]);
    if (breakSet.has(i + 1) || i === words.length - 1) {
      lines.push(currentLine.join(' '));
      currentLine = [];
    }
  }
  return lines;
}

// ── 후처리: 줄 끝 마침표/쉼표 제거 ──
function postProcessLines(lines) {
  return lines.map(l => {
    let s = l.trimEnd();
    while (s.endsWith('.') || s.endsWith(',')) {
      s = s.slice(0, -1).trimEnd();
    }
    return s;
  }).filter(l => l.length > 0);
}

async function handleSubtitleFormat(body, env, headers) {
  const { blocks } = body;
  if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
    return new Response(JSON.stringify({ error: "blocks array is required" }), { status: 400, headers });
  }

  const fullText = blocks.map(b => b.text).join('\n');

  // ── 전처리: 어절 번호 부여 ──
  const { words, numbered, count: wordCount } = numberWords(fullText);

  // ── OpenAI API 직접 호출 ──
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      },
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
    return new Response(JSON.stringify({
      error: `Network error: ${netErr.message}`,
      _debug: { inputLength: fullText.length, wordCount, error: netErr.message },
    }), { status: 502, headers });
  }

  if (response.status === 429) {
    return new Response(JSON.stringify({
      error: "Rate limited. Please wait and retry.",
      _debug: { inputLength: fullText.length, wordCount, error: "429 rate limited" },
    }), { status: 429, headers });
  }

  if (!response.ok) {
    const errText = await response.text();
    return new Response(JSON.stringify({
      error: `OpenAI API error ${response.status}: ${errText}`,
      _debug: { inputLength: fullText.length, wordCount, error: errText.substring(0, 500) },
    }), { status: response.status, headers });
  }

  const data = await response.json();
  const finishReason = data.choices?.[0]?.finish_reason;
  const rawContent = data.choices?.[0]?.message?.content || "";

  if (finishReason === "length") {
    return new Response(JSON.stringify({
      error: "출력 토큰 한계 초과 (finish_reason: length).",
      _debug: { inputLength: fullText.length, wordCount, finishReason, rawPreview: rawContent.substring(0, 300) },
    }), { status: 413, headers });
  }

  if (!rawContent) {
    return new Response(JSON.stringify({
      error: `Empty response from OpenAI. finish_reason: ${finishReason}`,
      _debug: { inputLength: fullText.length, wordCount, finishReason },
    }), { status: 500, headers });
  }

  // ── 파싱: breaks_after 추출 ──
  let breaksAfter = null;
  let parseMethod = null;

  // 1단계: JSON 파싱
  try {
    const braceStart = rawContent.indexOf('{');
    const braceEnd = rawContent.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      const parsed = JSON.parse(rawContent.substring(braceStart, braceEnd + 1));
      if (Array.isArray(parsed.breaks_after)) {
        breaksAfter = parsed.breaks_after.filter(n => typeof n === 'number' && n >= 1 && n < wordCount);
        parseMethod = "json";
      }
    }
  } catch (e) { /* fallback */ }

  // 2단계: 정규식으로 배열 추출
  if (!breaksAfter) {
    try {
      const arrMatch = rawContent.match(/\[[\d,\s]+\]/);
      if (arrMatch) {
        breaksAfter = JSON.parse(arrMatch[0]).filter(n => typeof n === 'number' && n >= 1 && n < wordCount);
        parseMethod = "regex";
      }
    } catch (e) { /* fallback */ }
  }

  // 3단계: 파싱 실패 — 단순 글자수 기반 자동 분할
  if (!breaksAfter || breaksAfter.length === 0) {
    parseMethod = "fallback";
    breaksAfter = [];
    let charCount = 0;
    for (let i = 0; i < words.length - 1; i++) {
      charCount += words[i].length + 1;
      if (charCount >= 20) {
        breaksAfter.push(i + 1);
        charCount = 0;
      }
    }
  }

  // ── 후처리: breaks_after → 줄바꿈 텍스트 ──
  const lines = applyBreaks(words, breaksAfter);
  const processed = postProcessLines(lines);
  const finalText = processed.join('\n');

  const _debug = {
    version: "v2-wordindex",
    rawLength: rawContent.length,
    parseMethod,
    finishReason,
    inputLength: fullText.length,
    wordCount,
    breaksCount: breaksAfter.length,
    outputLength: finalText.length,
    rawPreview: rawContent.substring(0, 800),
    breaksAfter,
  };

  return new Response(JSON.stringify({
    success: true,
    blocks: [{ index: 0, text: finalText }],
    usage: data.usage || {},
    _debug,
  }), { headers });
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
// /visuals — 3단계 stub
// ═══════════════════════════════════════

function handleVisuals(body, env, headers) {
  return new Response(JSON.stringify({
    success: false, status: "not_implemented",
    message: "3단계 자료/그래픽 가이드는 룰북 완성 후 구현 예정입니다."
  }), { status: 200, headers });
}
