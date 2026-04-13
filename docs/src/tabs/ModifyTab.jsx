import { useState, useEffect, useRef, useCallback } from "react";
import { C, FN } from "../utils/styles.js";

// ═══════════════════════════════════════
// CONFIG & CONSTANTS
// ═══════════════════════════════════════
const CATEGORIES = [
  { value: "subtitle", label: "자막", icon: "💬" },
  { value: "cut", label: "구간 삭제", icon: "✂️" },
  { value: "graphic", label: "그래픽", icon: "🎨" },
  { value: "audio", label: "오디오", icon: "🔊" },
  { value: "etc", label: "기타", icon: "📌" },
];
const CAT_COLORS = {
  subtitle: { color: "#F87171", bg: "rgba(248,113,113,0.1)" },
  cut:      { color: "#FBBF24", bg: "rgba(251,191,36,0.1)" },
  graphic:  { color: "#A78BFA", bg: "rgba(167,139,250,0.1)" },
  audio:    { color: "#34D399", bg: "rgba(52,211,153,0.1)" },
  etc:      { color: "#6C9CFC", bg: "rgba(108,156,252,0.1)" },
};

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
function genId() { return Math.random().toString(36).slice(2, 10); }

function fmtTime(sec) {
  if (sec == null) return "--:--";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
  return `${m}:${String(ss).padStart(2,"0")}`;
}

function parseYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|v=|\/embed\/|\/v\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function resizeImage(blob, maxW = 640, quality = 0.7) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(maxW / img.width, 1);
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((b) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.readAsDataURL(b);
      }, "image/jpeg", quality);
    };
    img.src = URL.createObjectURL(blob);
  });
}

// ═══════════════════════════════════════
// YouTubePlayer
// ═══════════════════════════════════════
function YouTubePlayer({ videoId, onPlayerReady }) {
  const containerRef = useRef(null);
  const playerRef = useRef(null);

  useEffect(() => {
    if (!videoId) return;
    const initPlayer = () => {
      if (playerRef.current) { try { playerRef.current.destroy(); } catch {} }
      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId,
        playerVars: { rel: 0, modestbranding: 1 },
        events: { onReady: () => onPlayerReady(playerRef.current) },
      });
    };
    if (window.YT && window.YT.Player) {
      initPlayer();
    } else {
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(tag);
      }
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); initPlayer(); };
    }
    return () => { if (playerRef.current) try { playerRef.current.destroy(); } catch {} };
  }, [videoId]);

  return (
    <div style={{ position: "relative", paddingTop: "56.25%", background: "#000", borderRadius: 12, overflow: "hidden", border: `1px solid ${C.bd}` }}>
      <div ref={containerRef} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }} />
    </div>
  );
}

// ═══════════════════════════════════════
// CardForm
// ═══════════════════════════════════════
function CardForm({ onSubmit, currentTime, onCancel }) {
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("subtitle");
  const [imageData, setImageData] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [tsStart, setTsStart] = useState(currentTime ?? 0);
  const [tsEnd, setTsEnd] = useState("");
  const textRef = useRef(null);

  useEffect(() => { textRef.current?.focus(); }, []);

  // Ctrl+V 이미지 붙여넣기
  useEffect(() => {
    const handler = async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          const b64 = await resizeImage(blob);
          setImageData(b64);
          setImagePreview(`data:image/jpeg;base64,${b64}`);
          break;
        }
      }
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, []);

  const handleSubmit = () => {
    if (!content.trim()) return;
    onSubmit({
      id: genId(),
      timestamp: tsStart,
      timestampEnd: tsEnd !== "" ? parseFloat(tsEnd) : null,
      content: content.trim(),
      category,
      hasImage: !!imageData,
      imageData: imageData || null,
      checked: false,
      reply: "",
      createdAt: new Date().toISOString(),
    });
    setContent(""); setCategory("subtitle"); setImageData(null); setImagePreview(null);
    setTsStart(currentTime ?? 0); setTsEnd("");
  };

  return (
    <div style={{ background: C.sf, border: `1px solid ${C.ac}`, borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: `0 0 20px ${C.acS}` }}>
      {/* 타임스탬프 */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ color: C.txD, fontSize: 12 }}>시작</span>
          <button onClick={() => setTsStart(currentTime)} title="현재 재생 시점으로 설정"
            style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${C.bd}`, borderRadius: 6, color: C.ac, fontFamily: "monospace", fontSize: 14, padding: "4px 10px", cursor: "pointer", minWidth: 72, textAlign: "center" }}>
            {fmtTime(tsStart)}</button>
        </div>
        <span style={{ color: C.txD }}>~</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ color: C.txD, fontSize: 12 }}>끝</span>
          <button onClick={() => setTsEnd(String(currentTime))} title="현재 재생 시점으로 설정"
            style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${tsEnd !== "" ? C.ac : C.bd}`, borderRadius: 6, color: tsEnd !== "" ? C.ac : C.txD, fontFamily: "monospace", fontSize: 14, padding: "4px 10px", cursor: "pointer", minWidth: 72, textAlign: "center" }}>
            {tsEnd !== "" ? fmtTime(parseFloat(tsEnd)) : "클릭"}</button>
          {tsEnd !== "" && <button onClick={() => setTsEnd("")} style={{ background: "transparent", border: "none", color: C.txD, cursor: "pointer", fontSize: 11, padding: "2px 4px" }}>✕</button>}
        </div>
      </div>

      {/* 카테고리 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {CATEGORIES.map(c => (
          <button key={c.value} onClick={() => setCategory(c.value)}
            style={{ background: category === c.value ? C.acS : "rgba(255,255,255,0.04)", border: `1px solid ${category === c.value ? C.ac : C.bd}`, borderRadius: 6, padding: "4px 10px", cursor: "pointer", color: category === c.value ? C.ac : C.txD, fontSize: 13, fontFamily: FN, transition: "all 0.15s" }}>
            {c.icon} {c.label}</button>
        ))}
      </div>

      {/* 이미지 프리뷰 */}
      {imagePreview ? (
        <div style={{ marginBottom: 14, position: "relative", display: "inline-block" }}>
          <img src={imagePreview} alt="캡처" style={{ maxWidth: "100%", maxHeight: 200, borderRadius: 8, border: `1px solid ${C.bd}` }} />
          <button onClick={() => { setImageData(null); setImagePreview(null); }}
            style={{ position: "absolute", top: -8, right: -8, background: C.err, color: "#fff", border: "none", borderRadius: "50%", width: 22, height: 22, cursor: "pointer", fontSize: 12, lineHeight: "22px" }}>✕</button>
        </div>
      ) : (
        <div style={{ border: `1px dashed ${C.bd}`, borderRadius: 8, padding: "12px 16px", marginBottom: 14, color: C.txD, fontSize: 13, textAlign: "center", fontFamily: FN }}>
          📋 Ctrl+V로 캡처 이미지 붙여넣기</div>
      )}

      {/* 수정 내용 */}
      <textarea ref={textRef} value={content} onChange={e => setContent(e.target.value)}
        placeholder="수정 내용을 입력하세요..."
        onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
        style={{ width: "100%", minHeight: 80, background: "rgba(255,255,255,0.04)", border: `1px solid ${C.bd}`, borderRadius: 8, color: C.tx, fontFamily: FN, fontSize: 14, padding: 12, resize: "vertical", outline: "none", boxSizing: "border-box" }} />

      {/* 버튼 */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button onClick={onCancel} style={{ background: "transparent", border: `1px solid ${C.bd}`, borderRadius: 8, color: C.txD, padding: "8px 16px", cursor: "pointer", fontSize: 13, fontFamily: FN }}>취소</button>
        <button onClick={handleSubmit} style={{ background: C.ac, border: "none", borderRadius: 8, color: "#fff", padding: "8px 20px", cursor: "pointer", fontSize: 13, fontFamily: FN, fontWeight: 600 }}>추가 (⌘↵)</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// ReviewCard
// ═══════════════════════════════════════
function ReviewCard({ card, onCheck, onDelete, onSeek, onEdit, images, currentTime }) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(card.content);
  const [editCategory, setEditCategory] = useState(card.category);
  const [editTsStart, setEditTsStart] = useState(card.timestamp);
  const [editTsEnd, setEditTsEnd] = useState(card.timestampEnd);
  const cat = CATEGORIES.find(c => c.value === (editing ? editCategory : card.category)) || CATEGORIES[4];
  const catColor = CAT_COLORS[editing ? editCategory : card.category] || CAT_COLORS.etc;
  const imgSrc = images[card.id];

  const startEdit = () => { setEditText(card.content); setEditCategory(card.category); setEditTsStart(card.timestamp); setEditTsEnd(card.timestampEnd); setEditing(true); };
  const cancelEdit = () => { setEditText(card.content); setEditCategory(card.category); setEditTsStart(card.timestamp); setEditTsEnd(card.timestampEnd); setEditing(false); };
  const saveEdit = () => { onEdit(card.id, { content: editText, category: editCategory, timestamp: editTsStart, timestampEnd: editTsEnd }); setEditing(false); };

  return (
    <div style={{ background: card.checked ? "rgba(0,0,0,0.2)" : C.sf, border: `1px solid ${card.checked ? "rgba(255,255,255,0.05)" : C.bd}`, borderRadius: 12, padding: 16, marginBottom: 10, opacity: card.checked ? 0.65 : 1, transition: "all 0.2s", borderLeft: `3px solid ${catColor.color}` }}>
      {/* 헤더 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {editing ? (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button onClick={() => setEditTsStart(currentTime)} title="현재 재생 시점"
                style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${C.ac}`, borderRadius: 6, color: C.ac, fontFamily: "monospace", fontSize: 13, padding: "3px 8px", cursor: "pointer" }}>
                ▶ {fmtTime(editTsStart)}</button>
              <span style={{ color: C.txD, fontSize: 12 }}>~</span>
              <button onClick={() => setEditTsEnd(currentTime)} title="현재 재생 시점"
                style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${editTsEnd != null ? C.ac : C.bd}`, borderRadius: 6, color: editTsEnd != null ? C.ac : C.txD, fontFamily: "monospace", fontSize: 13, padding: "3px 8px", cursor: "pointer" }}>
                {editTsEnd != null ? fmtTime(editTsEnd) : "끝"}</button>
              {editTsEnd != null && <button onClick={() => setEditTsEnd(null)} style={{ background: "transparent", border: "none", color: C.txD, cursor: "pointer", fontSize: 11, padding: "2px 4px" }}>✕</button>}
            </div>
          ) : (
            <button onClick={() => onSeek(card.timestamp)}
              style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${C.bd}`, borderRadius: 6, color: C.ac, fontFamily: "monospace", fontSize: 13, padding: "3px 8px", cursor: "pointer", transition: "all 0.15s" }}>
              ▶ {fmtTime(card.timestamp)}{card.timestampEnd != null && `~${fmtTime(card.timestampEnd)}`}</button>
          )}
          {!editing && <span style={{ fontSize: 12, color: catColor.color, background: catColor.bg, padding: "2px 8px", borderRadius: 4, fontFamily: FN }}>{cat.icon} {cat.label}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => onDelete(card.id)} title="삭제"
            style={{ background: "transparent", border: "none", color: C.txD, cursor: "pointer", fontSize: 14, padding: 4, opacity: 0.5 }}
            onMouseEnter={e => e.currentTarget.style.opacity = 1} onMouseLeave={e => e.currentTarget.style.opacity = 0.5}>🗑</button>
          <button onClick={() => onCheck(card.id)}
            style={{ borderRadius: 6, padding: "4px 10px", background: card.checked ? C.ok : "transparent", border: `2px solid ${card.checked ? C.ok : C.bd}`, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: card.checked ? "#fff" : C.txD, fontSize: 12, transition: "all 0.15s", fontFamily: FN }}>
            {card.checked ? "✓" : "☐"} 완료</button>
        </div>
      </div>

      {/* 캡처 이미지 */}
      {card.hasImage && imgSrc && <img src={`data:image/jpeg;base64,${imgSrc}`} alt="캡처" style={{ maxWidth: "100%", maxHeight: 240, borderRadius: 8, marginBottom: 10, border: `1px solid ${C.bd}` }} />}
      {card.hasImage && !imgSrc && <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: 20, marginBottom: 10, textAlign: "center", color: C.txD, fontSize: 13 }}>이미지 로딩 중...</div>}

      {/* 내용 */}
      {editing ? (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            {CATEGORIES.map(c => {
              const cc = CAT_COLORS[c.value] || CAT_COLORS.etc;
              return <button key={c.value} onClick={() => setEditCategory(c.value)}
                style={{ background: editCategory === c.value ? cc.bg : "rgba(255,255,255,0.04)", border: `1px solid ${editCategory === c.value ? cc.color : C.bd}`, borderRadius: 5, padding: "2px 8px", cursor: "pointer", color: editCategory === c.value ? cc.color : C.txD, fontSize: 12, fontFamily: FN, transition: "all 0.15s" }}>
                {c.icon} {c.label}</button>;
            })}
          </div>
          <textarea value={editText} onChange={e => setEditText(e.target.value)}
            style={{ width: "100%", minHeight: 60, background: "rgba(255,255,255,0.04)", border: `1px solid ${C.ac}`, borderRadius: 8, color: C.tx, fontFamily: FN, fontSize: 14, padding: 10, resize: "vertical", outline: "none", boxSizing: "border-box" }} />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button onClick={saveEdit} style={{ background: C.ac, border: "none", borderRadius: 6, color: "#fff", padding: "4px 12px", cursor: "pointer", fontSize: 12 }}>저장</button>
            <button onClick={cancelEdit} style={{ background: "transparent", border: `1px solid ${C.bd}`, borderRadius: 6, color: C.txD, padding: "4px 12px", cursor: "pointer", fontSize: 12 }}>취소</button>
          </div>
        </div>
      ) : (
        <>
          <p style={{ color: card.checked ? C.txD : C.tx, fontSize: 14, lineHeight: 1.6, margin: "0 0 8px 0", fontFamily: FN, textDecoration: card.checked ? "line-through" : "none", whiteSpace: "pre-wrap" }}>{card.content}</p>
          <button onClick={startEdit} style={{ background: "transparent", border: "none", color: C.txD, fontSize: 12, cursor: "pointer", padding: 0, fontFamily: FN }}>✏️ 수정하기</button>
        </>
      )}

      {/* 답글 */}
      {card.reply && <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 8, background: "rgba(108,156,252,0.08)", border: `1px solid rgba(108,156,252,0.2)`, fontSize: 13, color: C.txM }}>💬 {card.reply}</div>}
    </div>
  );
}

// ═══════════════════════════════════════
// ModifyTab (main export)
// ═══════════════════════════════════════
export function ModifyTab({ sessionId, config, onSave }) {
  const [view, setView] = useState("home"); // home | review
  const [videoUrl, setVideoUrl] = useState("");
  const [videoId, setVideoId] = useState("");
  const [title, setTitle] = useState("");
  const [cards, setCards] = useState([]);
  const [images, setImages] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [filter, setFilter] = useState("all");
  const [loaded, setLoaded] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState("");

  const playerRef = useRef(null);
  const autoSaveTimer = useRef(null);
  const lastSnapshot = useRef("");
  const timeInterval = useRef(null);

  const base = config?.workerUrl || "";

  // ── 세션 로드 ──
  useEffect(() => {
    if (!sessionId || !base || loaded) return;
    (async () => {
      try {
        const r = await fetch(`${base}/load/${sessionId}/modify`);
        if (!r.ok) { setLoaded(true); return; }
        const d = await r.json();
        if (d && d.data) {
          const data = d.data;
          setVideoUrl(data.videoUrl || "");
          setVideoId(data.videoId || "");
          setTitle(data.title || "");
          setCards(data.cards || []);
          lastSnapshot.current = JSON.stringify(data.cards || []);
          if (data.videoId) setView("review");
          // 이미지 lazy-load
          const imgCards = (data.cards || []).filter(c => c.hasImage);
          for (const c of imgCards) {
            try {
              const ir = await fetch(`${base}/image/${sessionId}/${c.id}`);
              if (ir.ok) {
                const id2 = await ir.json();
                if (id2.imageData) setImages(prev => ({ ...prev, [c.id]: id2.imageData }));
              }
            } catch {}
          }
        }
        setLoaded(true);
      } catch { setLoaded(true); }
    })();
  }, [sessionId, base, loaded]);

  // ── 디바운스 자동저장 ──
  useEffect(() => {
    if (!cards.length && !videoId) return;
    const snap = JSON.stringify(cards);
    if (snap === lastSnapshot.current) return;
    setAutoSaveStatus("⏳ 대기");
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      saveNow(cards);
    }, 3 * 60 * 1000);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [cards, title]);

  const saveNow = useCallback(async (cardsToSave) => {
    if (!sessionId) return;
    try {
      setAutoSaveStatus("💾 저장 중...");
      onSave?.({ videoUrl, videoId, title, cards: cardsToSave, savedAt: new Date().toISOString() });
      lastSnapshot.current = JSON.stringify(cardsToSave);
      if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null; }
      setAutoSaveStatus("✓ 저장됨");
      setTimeout(() => setAutoSaveStatus(""), 3000);
    } catch { setAutoSaveStatus("❌ 실패"); }
  }, [sessionId, videoUrl, videoId, title, onSave]);

  function handlePlayerReady(player) {
    playerRef.current = player;
    if (timeInterval.current) clearInterval(timeInterval.current);
    timeInterval.current = setInterval(() => {
      if (playerRef.current?.getCurrentTime) {
        setCurrentTime(playerRef.current.getCurrentTime());
      }
    }, 500);
  }

  function handleStart() {
    const vid = parseYouTubeId(videoUrl);
    if (!vid) return;
    setVideoId(vid);
    setCards([]);
    setImages({});
    lastSnapshot.current = "";
    setView("review");
    // 즉시 저장
    onSave?.({ videoUrl, videoId: vid, title: title || "새 리뷰", cards: [], savedAt: new Date().toISOString() });
  }

  async function handleAddCard(card) {
    const newCards = [...cards, card].sort((a, b) => a.timestamp - b.timestamp);
    setCards(newCards);
    setShowForm(false);
    // 이미지 업로드
    if (card.imageData && sessionId && base) {
      try {
        await fetch(`${base}/save-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, cardId: card.id, imageData: card.imageData }),
        });
        setImages(prev => ({ ...prev, [card.id]: card.imageData }));
      } catch { console.error("image save failed"); }
    }
    saveNow(newCards);
  }

  function handleCheck(cardId) {
    const newCards = cards.map(c => c.id === cardId ? { ...c, checked: !c.checked } : c);
    setCards(newCards);
    saveNow(newCards);
  }

  function handleEdit(cardId, updates) {
    const newCards = cards.map(c => c.id === cardId ? { ...c, ...updates } : c);
    setCards(newCards);
  }

  async function handleDelete(cardId) {
    const card = cards.find(c => c.id === cardId);
    const newCards = cards.filter(c => c.id !== cardId);
    setCards(newCards);
    if (card?.hasImage && sessionId && base) {
      try { await fetch(`${base}/image/${sessionId}/${cardId}`, { method: "DELETE" }); } catch {}
      setImages(prev => { const n = { ...prev }; delete n[cardId]; return n; });
    }
    saveNow(newCards);
  }

  function handleSeek(sec) {
    if (playerRef.current?.seekTo) {
      playerRef.current.seekTo(sec, true);
      playerRef.current.playVideo();
      setTimeout(() => { try { playerRef.current.pauseVideo(); } catch {} }, 300);
    }
  }

  function handleReset() {
    setView("home"); setVideoUrl(""); setVideoId(""); setTitle(""); setCards([]); setImages({});
    setShowForm(false); lastSnapshot.current = ""; setAutoSaveStatus("");
    if (playerRef.current) try { playerRef.current.destroy(); } catch {}
    playerRef.current = null;
    if (timeInterval.current) clearInterval(timeInterval.current);
  }

  const filteredCards = cards.filter(c => {
    if (filter === "unchecked") return !c.checked;
    if (filter === "checked") return c.checked;
    return true;
  }).sort((a, b) => {
    if (a.checked !== b.checked) return a.checked ? 1 : -1;
    return a.timestamp - b.timestamp;
  });

  const stats = { total: cards.length, checked: cards.filter(c => c.checked).length };

  // ═══════════════════════════════════════
  // HOME VIEW
  // ═══════════════════════════════════════
  if (view === "home") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40 }}>
        <div style={{ maxWidth: 640, width: "100%" }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8, color: C.tx }}>🎬 영상 수정사항</h2>
          <p style={{ fontSize: 13, color: C.txD, marginBottom: 24 }}>영상을 보면서 타임코드 기반으로 수정 사항을 기록합니다</p>

          <div style={{ background: C.sf, border: `1px solid ${C.bd}`, borderRadius: 12, padding: 24 }}>
            <label style={{ fontSize: 13, color: C.txD, display: "block", marginBottom: 8 }}>YouTube URL</label>
            <input value={videoUrl} onChange={e => setVideoUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: `1px solid ${C.bd}`, borderRadius: 8, color: C.tx, fontFamily: "monospace", fontSize: 14, padding: "10px 14px", outline: "none", boxSizing: "border-box", marginBottom: 12 }} />
            <label style={{ fontSize: 13, color: C.txD, display: "block", marginBottom: 8 }}>리뷰 제목 (선택)</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
              placeholder="예: 박종천 2편 최종 리뷰"
              style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: `1px solid ${C.bd}`, borderRadius: 8, color: C.tx, fontFamily: FN, fontSize: 14, padding: "10px 14px", outline: "none", boxSizing: "border-box", marginBottom: 16 }} />
            <button onClick={handleStart} disabled={!parseYouTubeId(videoUrl)}
              style={{ width: "100%", background: parseYouTubeId(videoUrl) ? C.ac : "rgba(255,255,255,0.06)", border: "none", borderRadius: 8, color: parseYouTubeId(videoUrl) ? "#fff" : C.txD, padding: "12px 0", cursor: parseYouTubeId(videoUrl) ? "pointer" : "not-allowed", fontSize: 15, fontWeight: 600, fontFamily: FN }}>
              리뷰 시작</button>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════
  // REVIEW VIEW
  // ═══════════════════════════════════════
  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <div style={{ maxWidth: 800, margin: "0 auto", padding: "16px 16px 80px" }}>
        {/* 헤더 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={handleReset}
              style={{ background: "transparent", border: `1px solid ${C.bd}`, borderRadius: 6, color: C.txD, padding: "4px 10px", cursor: "pointer", fontSize: 13 }}>← 홈</button>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="리뷰 제목"
              style={{ background: "transparent", border: "none", color: C.tx, fontSize: 17, fontWeight: 600, outline: "none", fontFamily: FN, width: 240 }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {autoSaveStatus && <span style={{ fontSize: 12, color: C.txD }}>{autoSaveStatus}</span>}
            <span style={{ fontSize: 13, fontFamily: "monospace", color: stats.checked === stats.total && stats.total > 0 ? C.ok : C.txD }}>
              {stats.checked}/{stats.total}</span>
          </div>
        </div>

        {/* YouTube Player */}
        <div style={{ marginBottom: 16 }}>
          <YouTubePlayer videoId={videoId} onPlayerReady={handlePlayerReady} />
        </div>

        {/* 수정 요청 추가 */}
        {!showForm ? (
          <button onClick={() => setShowForm(true)}
            style={{ width: "100%", background: C.sf, border: `1px dashed ${C.bd}`, borderRadius: 10, padding: "14px 0", cursor: "pointer", color: C.ac, fontSize: 14, fontFamily: FN, marginBottom: 16, transition: "all 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = C.ac} onMouseLeave={e => e.currentTarget.style.borderColor = C.bd}>
            ➕ 수정 요청 추가 &nbsp;<span style={{ color: C.txD, fontFamily: "monospace", fontSize: 13 }}>(현재 ▶ {fmtTime(currentTime)})</span></button>
        ) : (
          <CardForm currentTime={currentTime} onSubmit={handleAddCard} onCancel={() => setShowForm(false)} />
        )}

        {/* 필터 */}
        {cards.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {[
              { v: "all", l: `전체 (${stats.total})` },
              { v: "unchecked", l: `미완료 (${stats.total - stats.checked})` },
              { v: "checked", l: `완료 (${stats.checked})` },
            ].map(f => (
              <button key={f.v} onClick={() => setFilter(f.v)}
                style={{ background: filter === f.v ? C.acS : "transparent", border: `1px solid ${filter === f.v ? C.ac : C.bd}`, borderRadius: 6, padding: "4px 10px", cursor: "pointer", color: filter === f.v ? C.ac : C.txD, fontSize: 12, fontFamily: FN }}>
                {f.l}</button>
            ))}
          </div>
        )}

        {/* 카드 리스트 */}
        {filteredCards.map(card => (
          <ReviewCard key={card.id} card={card} images={images} currentTime={currentTime}
            onCheck={handleCheck} onEdit={handleEdit} onDelete={handleDelete} onSeek={handleSeek} />
        ))}

        {cards.length === 0 && (
          <div style={{ textAlign: "center", padding: 60, color: C.txD, fontSize: 14 }}>
            영상을 보면서 수정할 부분이 있으면<br />위 버튼을 눌러 추가해주세요</div>
        )}
      </div>
    </div>
  );
}
