import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import * as mammoth from "mammoth";

// ── Utils ──
import { loadConfig, saveConfig } from "./utils/config.js";
import { loadDictionary, syncDictionaryFromServer, updateDictionary } from "./utils/dictionary.js";
import { delay, apiCall, apiSaveSession, apiLoadSession, apiAnalyze, apiCorrect, apiHighlightsDraft, apiHighlightsEdit, apiSaveTab, apiLoadMeta, apiLoadTab } from "./utils/api.js";
import { parseDocxWithTrackChanges } from "./utils/docxParser.js";
import { calcRegression, tsToSeconds, secondsToDisplay, calcDuration, parseBlocks, splitChunks, chunkToText, chunkCtx } from "./utils/lengthModel.js";
import { findPositions, getCorrectedText } from "./utils/diffRenderer.js";
import { _savedTheme, C, FN, applyTheme, MARKER_COLORS_LIGHT, MARKER_COLORS_DARK, setMarkerColors } from "./utils/styles.js";

// ── Components ──
import { Badge, Progress, MarkedText, TypeBadge, BlockView, ReviewBlock, ScriptEditBlock, CorrectionRightBlock } from "./components/BlockComponents.jsx";
import { GuideCard } from "./components/GuideCard.jsx";
import { ShareModal, SessionListModal, SettingsModal } from "./components/Modals.jsx";
import { EditorialSummaryPanel } from "./components/EditorialSummaryPanel.jsx";
import { TermReviewScreen } from "./components/TermReviewScreen.jsx";

// ── Tabs ──
import { HighlightTab } from "./tabs/HighlightTab.jsx";
import { SetgenTab } from "./tabs/SetgenTab.jsx";
import { VisualTab } from "./tabs/VisualTab.jsx";
import { ModifyTab } from "./tabs/ModifyTab.jsx";

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
      setMarkerColors(next === "light" ? MARKER_COLORS_LIGHT : MARKER_COLORS_DARK);
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
      // 메타데이터 저장 (하이라이트/세트 탭에서 활용)
      if (sessionIdRef.current) {
        const metadata = {
          interviewee: a.speakers?.[0] ? `${a.speakers[0].name} ${a.speakers[0].role || ""}`.trim() : "",
          topic: a.overview?.topic || "",
          keywords: a.overview?.keywords || [],
          speakers: a.speakers || [],
          genre: a.genre || null,
        };
        apiSaveTab(sessionIdRef.current, "metadata", metadata, cfg, fn).catch(() => {});
      }
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
        {(hasData||tab==="modify")&&!termReview && <div style={{display:"flex",gap:1,background:"rgba(255,255,255,0.04)",borderRadius:7,padding:2}}>
          {[["review","0차 검토"],["correction","1차 교정"],["script","스크립트"],["guide","편집 가이드"],["visual","자료·그래픽"],["highlight","하이라이트"],["setgen","세트"],["modify","수정사항"]].map(([id,l])=>
            <button key={id} onClick={()=>setTab(id)} style={{padding:"5px 10px",borderRadius:5,border:"none",cursor:"pointer",
              fontSize:11,fontWeight:tab===id?600:400,background:tab===id?C.ac:"transparent",
              color:tab===id?"#fff":C.txM,transition:"all 0.12s",whiteSpace:"nowrap",
              opacity:(id==="review"&&!reviewData)||(id!=="modify"&&!hasData)?0.4:1,
              pointerEvents:(id==="review"&&!reviewData)||(id!=="modify"&&!hasData)?"none":"auto"}}>{l}{id==="guide"&&gReady?" ✓":""}</button>)}
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
        <div style={{textAlign:"center",marginTop:24,paddingTop:16,borderTop:`1px solid ${C.bd}`}}>
          <button onClick={()=>setTab("modify")} style={{background:"transparent",border:`1px solid ${C.bd}`,borderRadius:8,
            padding:"10px 24px",cursor:"pointer",color:C.ac,fontSize:13,fontFamily:FN,fontWeight:500,transition:"all 0.15s"}}
            onMouseEnter={e=>e.currentTarget.style.borderColor=C.ac} onMouseLeave={e=>e.currentTarget.style.borderColor=C.bd}>
            🎬 원고 없이 영상 수정사항 작성하기</button>
        </div>
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
              const text = scriptEdits[idx] !== undefined
                ? scriptEdits[idx]
                : getCorrectedText(b.text, dm[idx]);
              const speaker = b.speaker && b.speaker !== "—" ? `[${b.speaker}]` : "";
              return speaker ? `${speaker}\n${text}` : text;
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

      {/* ── 하이라이트 탭 ── */}
      {!termReview&&hasData&&tab==="highlight" && <HighlightTab
        script={(() => {
          const corrected = blocks.map(b => {
            const se = scriptEdits[b.index];
            if (se !== undefined) return se;
            return getCorrectedText(b.text, diffs.filter(d => d.blockIndex === b.index));
          }).join("\n");
          return corrected || blocks.map(b => b.text).join("\n");
        })()}
        blocks={blocks.map(b => ({ id: b.index, speaker: b.speaker, time: b.timestamp, text: getCorrectedText(b.text, diffs.filter(d => d.blockIndex === b.index)) }))}
        sessionId={sessionId}
        config={cfg}
        onSave={(data) => {
          if (sessionId) apiSaveTab(sessionId, "highlight", data, cfg, fn).catch(()=>{});
        }}
      />}

      {/* ── 세트 생성 탭 ── */}
      {!termReview&&hasData&&tab==="setgen" && <SetgenTab
        script={(() => {
          const corrected = blocks.map(b => {
            const se = scriptEdits[b.index];
            if (se !== undefined) return se;
            return getCorrectedText(b.text, diffs.filter(d => d.blockIndex === b.index));
          }).join("\n");
          return corrected || blocks.map(b => b.text).join("\n");
        })()}
        blocks={blocks}
        guestName={anal?.speakers?.[0]?.name?.split(" ")[0] || ""}
        guestTitle={anal?.speakers?.[0] ? `${anal.speakers[0].name} ${anal.speakers[0].role || ""}`.trim() : ""}
        sessionId={sessionId}
        config={cfg}
        keywords={anal?.overview?.keywords || []}
        onSave={(data) => {
          if (sessionId) apiSaveTab(sessionId, "setgen", data, cfg, fn).catch(()=>{});
        }}
      />}

      {/* ── 자료 & 그래픽 탭 ── */}
      {!termReview&&hasData&&tab==="visual" && <VisualTab
        script={(() => {
          const corrected = blocks.map(b => {
            const se = scriptEdits[b.index];
            if (se !== undefined) return se;
            return getCorrectedText(b.text, diffs.filter(d => d.blockIndex === b.index));
          }).join("\n");
          return corrected || blocks.map(b => b.text).join("\n");
        })()}
        blocks={blocks.map(b => ({ index: b.index, speaker: b.speaker, timestamp: b.timestamp, text: getCorrectedText(b.text, diffs.filter(d => d.blockIndex === b.index)) }))}
        sessionId={sessionId}
        config={cfg}
        onSave={(data) => {
          if (sessionId) apiSaveTab(sessionId, "visual", data, cfg, fn).catch(()=>{});
        }}
      />}

      {/* ── 수정사항 탭 ── */}
      {!termReview&&tab==="modify" && <ModifyTab
        sessionId={sessionId}
        config={cfg}
        onSave={(data) => {
          if (sessionId) apiSaveTab(sessionId, "modify", data, cfg, fn).catch(()=>{});
        }}
      />}
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
