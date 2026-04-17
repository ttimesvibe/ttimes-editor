import { useState, useEffect, useCallback, useRef } from "react";
import { C, FN } from "../utils/styles.js";
import { KanbanView } from "./KanbanView.jsx";

// ── Constants ──

const STEP_LABELS = {
  review: "0차 검토", correction: "1차 교정", script: "스크립트",
  guide: "편집 가이드", visual: "자료·그래픽", modify: "수정사항",
  highlight: "하이라이트", setgen: "세트", done: "완료",
};

const STEP_KEYS = ["review", "correction", "script", "guide", "visual", "modify", "highlight", "setgen"];

const STATUS_MAP = {
  review:     { label: "진행중",     color: "#22C55E" },
  correction: { label: "진행중",     color: "#22C55E" },
  script:     { label: "진행중",     color: "#22C55E" },
  guide:      { label: "편집가이드", color: "#3B82F6" },
  visual:     { label: "편집가이드", color: "#3B82F6" },
  modify:     { label: "수정사항",   color: "#F59E0B" },
  highlight:  { label: "하이라이트", color: "#22C55E" },
  setgen:     { label: "세트",       color: "#22C55E" },
  done:       { label: "완료",       color: "#5E6380" },
};

const AVATAR_COLORS = ["#4A6CF7","#7C3AED","#EC4899","#F59E0B","#10B981","#EF4444","#06B6D4","#8B5CF6"];

const FILTER_TABS = [
  { key: "all",  label: "전체" },
  { key: "wip",  label: "진행중" },
  { key: "done", label: "완료" },
  { key: "mine", label: "내 프로젝트" },
];

const PER_PAGE = 20;

// ── Helpers ──

function authHeaders() {
  const token = localStorage.getItem("ttimes_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function relativeDate(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}주`;
  const mo = Math.floor(d / 30);
  return `${mo}개월`;
}

function shortDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${d.getMonth()+1}/${d.getDate()}`;
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

// ═══════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════

export function Dashboard({ authUser, cfg, onSelectProject, onNewProject, onNewShoot, onNewProjectWithShoot, onLogout, toggleTheme, theme, viewMode, setViewMode }) {
  const [projects, setProjects] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ all: 0, wip: 0, done: 0, mine: 0 });
  const [filter, setFilter] = useState("wip");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [kanbanMineOnly, setKanbanMineOnly] = useState(false);

  // Editor edit popup state
  const [editingProject, setEditingProject] = useState(null); // { id, editors }
  const [teamMembers, setTeamMembers] = useState([]);
  const [editorsSaving, setEditorsSaving] = useState(false);
  const [deletingProject, setDeletingProject] = useState(null); // project object for delete confirm
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const popupRef = useRef(null);

  // ── Sync body background with theme ──
  useEffect(() => {
    document.body.style.background = C.bg;
    document.documentElement.style.background = C.bg;
  }, [theme]);

  // ── Data Fetching ──

  const fetchProjects = useCallback(async () => {
    if (!cfg?.workerUrl) return;
    setLoading(true);
    try {
      // "wip" → Worker expects "active"
      const apiFilter = filter === "wip" ? "active" : filter;
      const url = `${cfg.workerUrl}/projects?page=${page}&per_page=${PER_PAGE}&filter=${apiFilter}&search=${encodeURIComponent(search)}`;
      const r = await fetch(url, { headers: { ...authHeaders() } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setProjects(data.projects || []);
      setTotal(data.total || 0);
      const wip = data.activeCount ?? 0;
      const done = data.doneCount ?? 0;
      setCounts({
        all:  wip + done,
        wip,
        done,
        mine: data.mineCount ?? 0,
      });
    } catch (err) {
      console.error("[Dashboard] fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [cfg, page, filter, search]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  // Reset page when filter or search changes
  useEffect(() => { setPage(1); }, [filter, search]);

  // Fetch team members for editor assignment
  useEffect(() => {
    if (!cfg?.workerUrl) return;
    fetch(`${cfg.workerUrl}/team/members`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (d?.members) setTeamMembers(d.members); })
      .catch(() => {});
  }, [cfg]);

  // Close popup on outside click
  useEffect(() => {
    if (!editingProject) return;
    const handler = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) {
        setEditingProject(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editingProject]);

  // Save editors to server
  const saveEditors = async (projectId, newEditors) => {
    setEditorsSaving(true);
    try {
      await fetch(`${cfg.workerUrl}/projects/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ id: projectId, editors: newEditors }),
      });
      fetchProjects();
    } catch (err) {
      console.error("편집자 업데이트 실패:", err);
    } finally {
      setEditorsSaving(false);
    }
  };

  const addEditorToProject = (member) => {
    if (!editingProject) return;
    const current = editingProject.editors || [];
    if (current.some(e => (e.email || e.id) === (member.email || member.id))) return;
    const updated = [...current, { email: member.email || member.id, name: member.name || member.email }];
    setEditingProject({ ...editingProject, editors: updated });
    saveEditors(editingProject.id, updated);
  };

  const removeEditorFromProject = (email) => {
    if (!editingProject) return;
    const updated = (editingProject.editors || []).filter(e => (e.email || e.id) !== email);
    setEditingProject({ ...editingProject, editors: updated });
    saveEditors(editingProject.id, updated);
  };

  // Delete project
  const deleteProject = async (id) => {
    try {
      await fetch(`${cfg.workerUrl}/projects/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ id }),
      });
      setDeletingProject(null);
      fetchProjects();
    } catch (err) {
      console.error("프로젝트 삭제 실패:", err);
    }
  };

  // Mark project as done/undone
  const toggleDone = async (projId, currentStep) => {
    const newStep = currentStep === "done" ? "review" : "done";
    try {
      await fetch(`${cfg.workerUrl}/projects/update-step`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ id: projId, step: newStep }),
      });
      fetchProjects();
    } catch (err) {
      console.error("완료 처리 실패:", err);
    }
  };

  // ── Derived ──

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  // ── Render Helpers ──

  function renderStatusBadge(step) {
    const info = STATUS_MAP[step] || STATUS_MAP.review;
    return (
      <span style={{
        display: "inline-block", padding: "2px 8px", borderRadius: 4,
        fontSize: 11, fontWeight: 600, lineHeight: "18px",
        color: info.color,
        background: info.color + "1A",
      }}>
        {info.label}
      </span>
    );
  }

  function renderEditors(editors, projId) {
    const names = (editors && editors.length > 0)
      ? editors.map(e => typeof e === "string" ? e : (e.name || e.email || "?"))
      : [];
    const display = names.length === 0
      ? "-"
      : names.length > 2
        ? `${names[0]} 외 ${names.length - 1}명`
        : names.join(", ");

    return (
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
        onClick={(e) => {
          e.stopPropagation();
          setEditingProject({ id: projId, editors: editors || [] });
        }}
        title="편집자 수정"
      >
        {names.length > 0 ? (
          <>
            <div style={{ display: "flex" }}>
              {names.slice(0, 3).map((name, i) => (
                <div key={i} style={{
                  width: 20, height: 20, borderRadius: "50%",
                  background: avatarColor(name),
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 700, color: "#fff",
                  marginLeft: i > 0 ? -6 : 0,
                  border: `2px solid ${C.bg}`,
                  zIndex: 3 - i,
                  position: "relative",
                }}>
                  {name.charAt(0)}
                </div>
              ))}
            </div>
            <span style={{ fontSize: 12, color: C.tx, whiteSpace: "nowrap" }}>{display}</span>
          </>
        ) : (
          <span style={{ color: "#5E6380", fontSize: 12 }}>-</span>
        )}
        <span style={{ fontSize: 10, color: "#5E6380", marginLeft: 2 }}>✎</span>
      </div>
    );
  }

  function renderProgress(currentStep) {
    const currentIdx = STEP_KEYS.indexOf(currentStep);
    const stepColor = (STATUS_MAP[currentStep] || STATUS_MAP.review).color;
    return (
      <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
        {STEP_KEYS.map((_, i) => (
          <div key={i} style={{
            width: 14, height: 3, borderRadius: 1,
            background: i <= currentIdx ? stepColor : C.bd,
          }} />
        ))}
      </div>
    );
  }

  function renderPagination() {
    if (totalPages <= 1) return null;
    const pages = [];
    let start = Math.max(1, page - 2);
    let end = Math.min(totalPages, start + 4);
    if (end - start < 4) start = Math.max(1, end - 4);

    for (let i = start; i <= end; i++) pages.push(i);

    const btnBase = {
      width: 32, height: 32, display: "inline-flex", alignItems: "center", justifyContent: "center",
      border: "none", borderRadius: 6, cursor: "pointer",
      fontSize: 13, fontFamily: FN, fontWeight: 500,
      transition: "background 0.15s",
    };

    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 4, padding: "24px 0 16px" }}>
        <button
          style={{ ...btnBase, background: "transparent", color: page === 1 ? C.bd : C.txD }}
          disabled={page === 1}
          onClick={() => setPage(p => Math.max(1, p - 1))}
        >
          ‹
        </button>
        {pages.map(p => (
          <button
            key={p}
            style={{
              ...btnBase,
              background: p === page ? C.ac : "transparent",
              color: p === page ? "#fff" : C.txD,
            }}
            onClick={() => setPage(p)}
          >
            {p}
          </button>
        ))}
        <button
          style={{ ...btnBase, background: "transparent", color: page === totalPages ? C.bd : C.txD }}
          disabled={page === totalPages}
          onClick={() => setPage(p => Math.min(totalPages, p + 1))}
        >
          ›
        </button>
      </div>
    );
  }

  // ── Computed Counts for Header ──

  const wipCount = counts.wip;
  const doneCount = counts.done;
  const allCount = counts.all;

  // ── Main Render ──

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FN, color: C.tx }}>

      {/* ── Top Bar ── */}
      <header style={{
        display: "flex", alignItems: "center", height: 48,
        padding: "0 24px",
        borderBottom: `1px solid ${C.bd}`,
        background: C.sf,
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.tx, letterSpacing: -0.3 }}>
          티타임즈 편집 CMS
        </span>
        <div style={{ flex: 1 }} />
        {authUser && (
          <span style={{ fontSize: 12, color: "#8B8FA3", marginRight: 16 }}>
            {authUser.name || authUser.email}
          </span>
        )}
        <button
          onClick={toggleTheme}
          style={{
            background: "none", border: "none", cursor: "pointer",
            fontSize: 16, color: "#8B8FA3", marginRight: 12, padding: 4,
          }}
          title="테마 전환"
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
        <button
          onClick={onLogout}
          style={{
            background: "none", border: "none", cursor: "pointer",
            fontSize: 12, color: "#5E6380", padding: "4px 8px",
          }}
        >
          로그아웃
        </button>
      </header>

      {/* ── Content Area ── */}
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "32px 24px" }}>

        {/* ── Page Header ── */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          paddingBottom: 20, borderBottom: `1px solid ${C.bd}`,
        }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, lineHeight: 1.3 }}>
              대담 편집
            </h1>
            <p style={{ fontSize: 13, color: "#8B8FA3", margin: "4px 0 0" }}>
              총 {allCount}개 · 진행중 {wipCount} · 완료 {doneCount}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            {/* View Toggle */}
            <div style={{ display: "flex", border: `1px solid ${C.bd}` }}>
              <button
                onClick={() => setViewMode("board")}
                style={{
                  padding: "7px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: "none", fontFamily: FN,
                  background: viewMode === "board" ? "#E8E9ED" : "transparent",
                  color: viewMode === "board" ? "#0F1117" : "#5E6380",
                }}
              >게시판</button>
              <button
                onClick={() => setViewMode("kanban")}
                style={{
                  padding: "7px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: "none", fontFamily: FN,
                  background: viewMode === "kanban" ? "#E8E9ED" : "transparent",
                  color: viewMode === "kanban" ? "#0F1117" : "#5E6380",
                }}
              >칸반</button>
            </div>

            {/* Mine-only toggle (kanban only) */}
            {viewMode === "kanban" && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }}>
                <span
                  onClick={() => setKanbanMineOnly(v => !v)}
                  style={{
                    width: 34, height: 18, borderRadius: 9, position: "relative",
                    background: kanbanMineOnly ? "#4A6CF7" : C.bd,
                    transition: "background 0.2s", display: "inline-block", flexShrink: 0,
                  }}
                >
                  <span style={{
                    position: "absolute", top: 2, left: kanbanMineOnly ? 18 : 2,
                    width: 14, height: 14, borderRadius: "50%", background: "#fff",
                    transition: "left 0.2s", boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                  }} />
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: kanbanMineOnly ? C.tx : "#5E6380", whiteSpace: "nowrap" }}>
                  내 프로젝트만
                </span>
              </label>
            )}

            {/* Action button */}
            <button
              onClick={viewMode === "kanban" ? onNewShoot : onNewProject}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "8px 18px",
                border: "none", cursor: "pointer",
                background: "#E8E9ED", color: "#0F1117",
                fontSize: 13, fontWeight: 600, fontFamily: FN,
                transition: "opacity 0.15s",
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = "0.85"}
              onMouseLeave={e => e.currentTarget.style.opacity = "1"}
            >
              {viewMode === "kanban" ? "+ 촬영 일정" : "+ 새 프로젝트"}
            </button>
          </div>
        </div>

        {/* ── Kanban View ── */}
        {viewMode === "kanban" && (
          <div style={{ marginTop: 20 }}>
            <KanbanView
              authUser={authUser}
              cfg={cfg}
              onSelectProject={onSelectProject}
              onNewShoot={onNewShoot}
              onNewProject={(parentShootId) => onNewProjectWithShoot?.(parentShootId)}
              mineOnly={kanbanMineOnly}
            />
          </div>
        )}

        {/* ── Board View ── */}
        {viewMode !== "kanban" && <>

        {/* ── Filter Tabs + Search ── */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginTop: 20, marginBottom: 16,
        }}>
          <div style={{ display: "flex", gap: 0 }}>
            {FILTER_TABS.map(tab => {
              const isActive = filter === tab.key;
              const count = tab.key === "all" ? allCount
                : tab.key === "wip" ? wipCount
                : tab.key === "done" ? doneCount
                : counts.mine;
              return (
                <button
                  key={tab.key}
                  onClick={() => setFilter(tab.key)}
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    padding: "8px 16px", fontFamily: FN,
                    fontSize: 13, fontWeight: isActive ? 600 : 400,
                    color: isActive ? "#fff" : "#5E6380",
                    borderBottom: isActive ? "2px solid #fff" : "2px solid transparent",
                    transition: "color 0.15s, border-color 0.15s",
                  }}
                >
                  {tab.label}
                  <span style={{
                    marginLeft: 5, fontSize: 11,
                    color: isActive ? "#8B8FA3" : "#3A3F52",
                  }}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <input
            type="text"
            placeholder="검색..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: 200, padding: "6px 0", fontFamily: FN,
              fontSize: 13, color: C.tx,
              background: "transparent",
              border: "none", borderBottom: `1px solid ${C.bd}`,
              outline: "none",
              transition: "border-color 0.15s",
            }}
            onFocus={e => e.target.style.borderBottomColor = C.ac}
            onBlur={e => e.target.style.borderBottomColor = C.bd}
          />
        </div>

        {/* ── Table ── */}
        <div style={{ overflowX: "auto" }}>
          {/* Table Header */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "40px 72px 1fr 160px 100px 100px 72px 96px",
            gap: 0, padding: "10px 12px",
            borderBottom: `1px solid ${C.bd}`,
            fontSize: 11, fontWeight: 600, color: "#5E6380",
            textTransform: "uppercase", letterSpacing: 0.5,
          }}>
            <span>#</span>
            <span>상태</span>
            <span>프로젝트</span>
            <span>편집자</span>
            <span>현재 단계</span>
            <span>진행</span>
            <span>날짜</span>
            <span></span>
          </div>

          {/* Loading State */}
          {loading && (
            <div style={{ padding: "40px 0", textAlign: "center", color: "#5E6380", fontSize: 13 }}>
              불러오는 중...
            </div>
          )}

          {/* Empty State */}
          {!loading && projects.length === 0 && (
            <div style={{ padding: "60px 0", textAlign: "center", color: "#5E6380", fontSize: 13 }}>
              {search ? "검색 결과가 없습니다." : "프로젝트가 없습니다."}
            </div>
          )}

          {/* Project Rows */}
          {!loading && projects.map((proj, idx) => {
            const step = proj.currentStep || proj.step || "review";
            const isDone = step === "done";
            const rowNum = total - ((page - 1) * PER_PAGE + idx);
            const editors = proj.editors || (proj.editor ? [proj.editor] : []);

            return (
              <div
                key={proj.id || idx}
                onClick={() => onSelectProject(proj.id)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "40px 72px 1fr 160px 100px 100px 72px 96px",
                  gap: 0, padding: "12px 12px",
                  borderBottom: `1px solid ${C.bd}`,
                  alignItems: "center",
                  cursor: "pointer",
                  opacity: (isDone && filter !== "done") ? 0.35 : 1,
                  transition: "background 0.12s",
                }}
                onMouseEnter={e => e.currentTarget.style.background = C.glassHover}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >
                {/* Row Number */}
                <span style={{ fontSize: 12, color: "#5E6380", fontVariantNumeric: "tabular-nums" }}>
                  {rowNum}
                </span>

                {/* Status Badge */}
                {renderStatusBadge(step)}

                {/* Project Name */}
                <span style={{
                  fontSize: 13, fontWeight: 500, color: C.tx,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  paddingRight: 12,
                }} title={proj.fn || proj.filename || proj.name}>
                  {truncate(proj.fn || proj.filename || proj.name || "제목 없음", 40)}
                </span>

                {/* Editors */}
                {renderEditors(editors, proj.id)}

                {/* Current Step */}
                <span style={{ fontSize: 12, color: "#8B8FA3" }}>
                  {STEP_LABELS[step] || step}
                </span>

                {/* Progress Bar */}
                {renderProgress(step)}

                {/* Date: 등록일 + 최종수정 */}
                <div style={{ textAlign: "right", lineHeight: 1.4 }}>
                  <div style={{ fontSize: 11, color: "#5E6380" }}>{shortDate(proj.createdAt)}</div>
                  <div style={{ fontSize: 10, color: "#3A3F52" }}>{proj.updatedAt ? relativeDate(proj.updatedAt) : "-"}</div>
                </div>

                {/* Actions: 완료 + 삭제 */}
                <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleDone(proj.id, step); }}
                    title={isDone ? "진행중으로 되돌리기" : "완료 처리"}
                    style={{
                      background: "none", border: `1px solid ${isDone ? "rgba(139,143,163,0.3)" : "rgba(34,197,94,0.3)"}`, cursor: "pointer",
                      color: isDone ? "#8B8FA3" : "#22C55E", fontSize: 11, padding: "2px 8px", lineHeight: 1.4,
                      borderRadius: 4, fontFamily: FN, fontWeight: 500,
                      transition: "background 0.15s, border-color 0.15s",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = isDone ? "rgba(139,143,163,0.15)" : "rgba(34,197,94,0.15)"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "none"; }}
                  >
                    {isDone ? "복원" : "완료"}
                  </button>
                  {(proj.creatorEmail === authUser?.email || authUser?.role === "admin") && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeletingProject(proj); }}
                      title="프로젝트 삭제"
                      style={{
                        background: "none", border: `1px solid rgba(239,68,68,0.3)`, cursor: "pointer",
                        color: "#EF4444", fontSize: 11, padding: "2px 8px", lineHeight: 1.4,
                        borderRadius: 4, fontFamily: FN, fontWeight: 500,
                        transition: "background 0.15s, border-color 0.15s",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = "rgba(239,68,68,0.15)"; e.currentTarget.style.borderColor = "#EF4444"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.3)"; }}
                    >
                      삭제
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Pagination ── */}
        {renderPagination()}

        </>}
      </div>

      {/* Editor Edit Modal */}
      {editingProject && (() => {
        const currentEditors = editingProject.editors || [];
        const availableMembers = teamMembers.filter(
          m => !currentEditors.some(e => (e.email || e.id) === (m.email || m.id))
        );
        return (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={() => setEditingProject(null)}
        >
          <div
            ref={popupRef}
            style={{
              background: C.sf, borderRadius: 12, padding: 24,
              border: `1px solid ${C.bd}`, maxWidth: 360, width: "100%",
              fontFamily: FN,
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.tx }}>편집자 관리</div>
              <button onClick={() => setEditingProject(null)} style={{
                background: "none", border: "none", color: "#5E6380",
                fontSize: 18, cursor: "pointer", padding: 4, lineHeight: 1,
              }}>✕</button>
            </div>

            {/* Current editors */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {currentEditors.map((ed, i) => {
                const edName = typeof ed === "string" ? ed : (ed.name || ed.email || "?");
                const edEmail = typeof ed === "string" ? ed : (ed.email || ed.id);
                return (
                  <span key={edEmail || i} style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    background: "rgba(74,108,247,0.15)", color: "#4A6CF7",
                    borderRadius: 12, padding: "4px 10px", fontSize: 12,
                  }}>
                    {edName}
                    <button
                      onClick={() => removeEditorFromProject(edEmail)}
                      style={{
                        background: "none", border: "none", color: "#4A6CF7",
                        cursor: "pointer", padding: 0, fontSize: 12,
                        fontWeight: 700, lineHeight: 1,
                      }}
                    >✕</button>
                  </span>
                );
              })}
              {currentEditors.length === 0 && (
                <span style={{ fontSize: 12, color: "#5E6380" }}>편집자 없음</span>
              )}
            </div>

            {/* Add member dropdown */}
            {availableMembers.length > 0 && (
              <select
                value=""
                onChange={e => {
                  const member = teamMembers.find(m => (m.email || m.id) === e.target.value);
                  if (member) addEditorToProject(member);
                }}
                style={{
                  width: "100%", padding: 8, borderRadius: 6,
                  border: `1px solid ${C.bd}`, background: C.inputBg,
                  color: C.tx, fontSize: 13, cursor: "pointer",
                  outline: "none", boxSizing: "border-box",
                }}
              >
                <option value="" disabled>+ 팀원 추가</option>
                {availableMembers.map(m => (
                  <option key={m.email || m.id} value={m.email || m.id}>
                    {m.name || m.email}
                  </option>
                ))}
              </select>
            )}

            {editorsSaving && (
              <div style={{ fontSize: 11, color: "#5E6380", marginTop: 6 }}>저장 중...</div>
            )}
          </div>
        </div>
        );
      })()}

      {/* Delete Confirmation Modal */}
      {deletingProject && (() => {
        const projName = deletingProject.fn || deletingProject.filename || deletingProject.name || "";
        const canDelete = deleteConfirmText === "삭제";
        return (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 300,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: C.sf, borderRadius: 12, padding: 24,
            border: `1px solid ${C.bd}`, maxWidth: 400, width: "100%",
            fontFamily: FN,
          }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#EF4444", marginBottom: 12 }}>
              프로젝트 삭제
            </div>
            <div style={{ fontSize: 13, color: C.txM, marginBottom: 8, lineHeight: 1.5 }}>
              <strong style={{ color: C.tx }}>{truncate(projName, 30)}</strong> 프로젝트의 모든 데이터가 영구 삭제됩니다.
            </div>
            <div style={{ fontSize: 13, color: C.txM, marginBottom: 16, lineHeight: 1.5 }}>
              이 작업은 되돌릴 수 없습니다. 삭제하려면 아래에 <strong style={{ color: "#EF4444" }}>삭제</strong>를 입력하세요.
            </div>
            <input
              value={deleteConfirmText}
              onChange={e => setDeleteConfirmText(e.target.value)}
              placeholder="삭제"
              autoFocus
              style={{
                width: "100%", padding: 10, borderRadius: 6,
                border: `1px solid ${canDelete ? "#EF4444" : C.bd}`,
                background: C.inputBg, color: C.tx, fontSize: 14,
                fontFamily: FN, outline: "none", boxSizing: "border-box",
                marginBottom: 16,
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => { setDeletingProject(null); setDeleteConfirmText(""); }}
                style={{
                  padding: "8px 16px", borderRadius: 6, border: `1px solid ${C.bd}`,
                  background: "transparent", color: C.tx, fontSize: 13,
                  cursor: "pointer", fontFamily: FN,
                }}
              >
                취소
              </button>
              <button
                onClick={() => { if (canDelete) { deleteProject(deletingProject.id); setDeleteConfirmText(""); } }}
                disabled={!canDelete}
                style={{
                  padding: "8px 16px", borderRadius: 6, border: "none",
                  background: canDelete ? "#EF4444" : "rgba(239,68,68,0.3)",
                  color: "#fff", fontSize: 13, fontWeight: 600,
                  cursor: canDelete ? "pointer" : "not-allowed", fontFamily: FN,
                }}
              >
                삭제
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}
