import { useState, useEffect, useCallback } from "react";
import { C, FN } from "../utils/styles.js";

// ── Constants ──

const AVATAR_COLORS = ["#4A6CF7","#7C3AED","#EC4899","#F59E0B","#10B981","#EF4444","#06B6D4","#8B5CF6"];

const STEP_KEYS = ["review","correction","script","guide","visual","modify","highlight","setgen"];

const STEP_LABELS = {
  review:"0차 검토", correction:"1차 교정", script:"스크립트",
  guide:"편집 가이드", visual:"자료·그래픽", modify:"수정사항",
  highlight:"하이라이트", setgen:"세트", done:"완료",
};

const STEP_COLORS = {
  review:"#22C55E", correction:"#22C55E", script:"#22C55E",
  guide:"#3B82F6", visual:"#3B82F6", modify:"#F59E0B",
  highlight:"#22C55E", setgen:"#22C55E", done:"#5E6380",
};

const COLUMNS = [
  { key: "pre-production", label: "촬영 예정", color: "#A78BFA" },
  { key: "editing",        label: "원고 편집", color: "#22C55E" },
  { key: "post-production",label: "영상 편집", color: "#F59E0B" },
  { key: "done",           label: "표출 완료", color: "#5E6380" },
];

const ROLE_LABELS = { filming: "촬영", progress: "진행", scriptEdit: "원고", videoEdit: "영상" };
const ROLE_COLORS = { filming: "#F59E0B", progress: "#EC4899", scriptEdit: "#4A6CF7", videoEdit: "#22C55E" };

// ── Stage transition labels ──
const STAGE_NEXT = {
  "pre-production": { label: "촬영 완료 → 원고 편집", next: "editing" },
  "editing": { label: "원고 완료 → 영상 편집", next: "post-production" },
  "post-production": { label: "영상 완료 → 표출 완료", next: "done" },
};

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

function formatShootDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const dayNames = ["일","월","화","수","목","금","토"];
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const dayName = dayNames[d.getDay()];
  const hour = d.getHours();
  const minute = d.getMinutes();
  let timeStr;
  if (hour === 0 && minute === 0) {
    timeStr = "";
  } else if (hour < 12) {
    timeStr = ` 오전 ${hour === 0 ? 12 : hour}시${minute ? minute + "분" : ""}`;
  } else {
    timeStr = ` ${hour === 12 ? 12 : hour - 12}시${minute ? minute + "분" : ""}`;
  }
  return `${month}.${day} (${dayName})${timeStr}`;
}

function shortShootDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getDate()).padStart(2,"0")}`;
}

function getMonthKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

// ═══════════════════════════════════════════════
// KANBAN VIEW
// ═══════════════════════════════════════════════

export function KanbanView({ authUser, cfg, onSelectProject, onNewShoot, onNewProject, onEditShoot, mineOnly, refreshKey }) {
  const [shoots, setShoots] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expandedDone, setExpandedDone] = useState({});
  const [dragOverCol, setDragOverCol] = useState(null);
  const [draggingId, setDraggingId] = useState(null);

  // ── Fetch data ──

  const fetchData = useCallback(async () => {
    if (!cfg?.workerUrl) return;
    setLoading(true);
    try {
      const [shootRes, projRes] = await Promise.all([
        fetch(`${cfg.workerUrl}/shoots`, { headers: authHeaders() }),
        fetch(`${cfg.workerUrl}/projects?filter=all&per_page=999`, { headers: authHeaders() }),
      ]);
      const shootData = await shootRes.json();
      const projData = await projRes.json();
      setShoots(shootData?.shoots || shootData || []);
      setProjects(projData?.projects || []);
    } catch (err) {
      console.error("[Kanban] fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [cfg, refreshKey]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Stage move ──

  const moveShootStage = async (shootId, newStage) => {
    setShoots(prev => prev.map(s => s.id === shootId ? { ...s, stage: newStage } : s));
    try {
      await fetch(`${cfg.workerUrl}/shoots/move-stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ id: shootId, stage: newStage }),
      });
      fetchData();
    } catch (err) {
      console.error("stage 이동 실패:", err);
      fetchData();
    }
  };

  // ── Project stage move ──

  const moveProjectStage = async (projectId, newStage) => {
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, stage: newStage } : p));
    try {
      await fetch(`${cfg.workerUrl}/projects/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ id: projectId, stage: newStage }),
      });
      fetchData();
    } catch (err) {
      console.error("project stage 이동 실패:", err);
      fetchData();
    }
  };

  // ── Drag & Drop handlers ──

  const handleDragStart = (e, type, id) => {
    e.dataTransfer.setData("text/plain", `${type}:${id}`);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(id);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverCol(null);
  };

  const handleDragOver = (e, colKey) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverCol !== colKey) setDragOverCol(colKey);
  };

  const handleDragLeave = (e, colKey) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      if (dragOverCol === colKey) setDragOverCol(null);
    }
  };

  const handleDrop = (e, colKey) => {
    e.preventDefault();
    setDragOverCol(null);
    setDraggingId(null);
    const raw = e.dataTransfer.getData("text/plain");
    if (!raw) return;
    const [type, id] = raw.split(":");
    if (!type || !id) return;

    if (type === "shoot") {
      const shoot = (Array.isArray(shoots) ? shoots : []).find(s => s.id === id);
      if (!shoot || shoot.stage === colKey) return;

      // TransitionCard(자식 프로젝트 연결된 shoot)를 done으로 드래그 금지
      // → 자식 프로젝트가 invisible해지는 버그 방지
      if (colKey === "done" && shoot.childProjectIds?.length > 0) {
        alert("연결된 원고 프로젝트가 있어 직접 '표출 완료'로 이동할 수 없습니다.\n자식 프로젝트를 먼저 완료하거나 연결을 해제해 주세요.");
        return;
      }
      moveShootStage(id, colKey);
    } else if (type === "project") {
      const proj = projects.find(p => p.id === id);
      if (!proj || proj.stage === colKey) return;

      // 프로젝트는 pre-production 컬럼으로 이동 불가 (렌더 안 되므로 실종됨)
      if (colKey === "pre-production") {
        alert("원고 프로젝트는 '촬영 예정' 컬럼으로 이동할 수 없습니다.");
        return;
      }
      moveProjectStage(id, colKey);
    }
  };

  // ── Mine-only filtering helpers ──

  const userEmail = authUser?.email || "";

  function isMyShoot(s) {
    if (!mineOnly) return true;
    const allMembers = [
      ...(s.roles?.filming || []),
      ...(s.roles?.progress || []),
      ...(s.roles?.scriptEdit || []),
      ...(s.roles?.videoEdit || []),
    ];
    return allMembers.some(m => m.email === userEmail) || s.creatorEmail === userEmail;
  }

  function isMyProject(p) {
    if (!mineOnly) return true;
    const editors = p.editors || [];
    return editors.some(e => {
      const email = typeof e === "string" ? e : (e.email || e.id || "");
      return email === userEmail;
    }) || p.creatorEmail === userEmail;
  }

  // ── Group data by columns ──

  const grouped = {};
  COLUMNS.forEach(col => { grouped[col.key] = []; });

  // Sort shoots by shootDate (ascending — nearest first)
  const sortedShoots = [...(Array.isArray(shoots) ? shoots : [])].sort((a, b) => {
    const da = a.shootDate ? new Date(a.shootDate).getTime() : Infinity;
    const db = b.shootDate ? new Date(b.shootDate).getTime() : Infinity;
    return da - db;
  });

  sortedShoots.forEach(s => {
    if (!isMyShoot(s)) return;
    if (grouped[s.stage]) grouped[s.stage].push({ type: "shoot", data: s });
  });

  // childIdSet: 현재 노출되는 shoot의 자식만 포함
  // (mineOnly로 parent shoot이 필터되는 경우, 자식도 독립 프로젝트로 editing 컬럼에 보이도록)
  const childIdSet = new Set();
  sortedShoots.forEach(s => {
    if (s.stage === "editing" && s.childProjectIds?.length && isMyShoot(s)) {
      s.childProjectIds.forEach(id => childIdSet.add(id));
    }
  });

  projects.forEach(p => {
    if (!isMyProject(p)) return;
    const step = p.currentStep || p.step || "review";
    if (step === "done") {
      if (!p.parentShootId) grouped["done"].push({ type: "project", data: p });
    } else {
      const isPostProd = p.stage === "post-production";
      if (isPostProd) {
        grouped["post-production"].push({ type: "project", data: p });
      } else if (!childIdSet.has(p.id)) {
        grouped["editing"].push({ type: "project", data: p });
      }
    }
  });

  // ── Column counts ──
  const colCounts = {};
  COLUMNS.forEach(col => {
    if (col.key === "editing") {
      const shootsInEditing = grouped["editing"].filter(i => i.type === "shoot");
      const childCount = shootsInEditing.reduce((sum, i) => sum + (i.data.childProjectIds?.length || 0), 0);
      const independentProjects = grouped["editing"].filter(i => i.type === "project").length;
      colCounts[col.key] = childCount + independentProjects;
    } else {
      colCounts[col.key] = grouped[col.key].length;
    }
  });

  // ── Done column: group by month ──
  const doneByMonth = {};
  grouped["done"].forEach(item => {
    const date = item.data.updatedAt || item.data.createdAt || new Date().toISOString();
    const mk = getMonthKey(date);
    if (!doneByMonth[mk]) doneByMonth[mk] = [];
    doneByMonth[mk].push(item);
  });
  const doneMonths = Object.keys(doneByMonth).sort().reverse();
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;

  // ═══ Render ═══

  if (loading && shoots.length === 0) {
    return <div style={{ padding: 40, textAlign: "center", color: "#5E6380", fontSize: 13 }}>불러오는 중...</div>;
  }

  return (
    <div style={{ display: "flex", gap: 0, overflowX: "auto", height: "calc(100vh - 180px)" }}>
      {COLUMNS.map(col => {
        const isOver = dragOverCol === col.key;
        return (
          <div
            key={col.key}
            onDragOver={(e) => handleDragOver(e, col.key)}
            onDragLeave={(e) => handleDragLeave(e, col.key)}
            onDrop={(e) => handleDrop(e, col.key)}
            style={{
              flex: 1, minWidth: 240,
              borderRight: `1px solid ${C.bd}`,
              display: "flex", flexDirection: "column",
              background: isOver ? (col.color + "08") : "transparent",
              transition: "background 0.15s",
            }}
          >
            {/* Column Header */}
            <div style={{
              padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: col.color, display: "inline-block" }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: C.tx }}>{col.label}</span>
              </div>
              <span style={{
                fontSize: 11, color: "#5E6380", background: C.glass, padding: "2px 8px", borderRadius: 10,
              }}>{colCounts[col.key]}</span>
            </div>

            {/* Drop indicator bar */}
            {isOver && (
              <div style={{ height: 2, background: col.color, margin: "0 10px", borderRadius: 1, flexShrink: 0 }} />
            )}

            {/* Column Body */}
            <div style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 8, flex: 1, overflowY: "auto" }}>

              {col.key === "pre-production" && (
                <div onClick={onNewShoot} style={{
                  border: `1px dashed ${C.bd}`, padding: 10, textAlign: "center",
                  fontSize: 12, color: "#5E6380", cursor: "pointer",
                }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "#454B66"; e.currentTarget.style.color = "#8B90A5"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = C.bd; e.currentTarget.style.color = "#5E6380"; }}
                >
                  + 촬영 일정 추가
                </div>
              )}

              {col.key !== "done" && grouped[col.key].map((item) => {
                if (item.type === "shoot") {
                  if (col.key === "editing") {
                    const children = projects.filter(p => item.data.childProjectIds?.includes(p.id));
                    return (
                      <TransitionCard
                        key={item.data.id}
                        shoot={item.data}
                        children={children}
                        onSelectProject={onSelectProject}
                        onNewProject={() => onNewProject?.(item.data.id)}
                        onDragStart={(e) => handleDragStart(e, "shoot", item.data.id)}
                        onDragEnd={handleDragEnd}
                        isDragging={draggingId === item.data.id}
                      />
                    );
                  }
                  const shootChildCount = projects.filter(p => p.parentShootId === item.data.id).length;
                  return (
                    <ShootCard
                      key={item.data.id}
                      shoot={item.data}
                      stage={col.key}
                      onClick={() => onEditShoot?.(item.data)}
                      onMoveStage={moveShootStage}
                      onDragStart={(e) => handleDragStart(e, "shoot", item.data.id)}
                      onDragEnd={handleDragEnd}
                      isDragging={draggingId === item.data.id}
                      childCount={shootChildCount}
                    />
                  );
                }
                if (item.type === "project") {
                  return (
                    <ProjectCard
                      key={item.data.id}
                      project={item.data}
                      shoots={shoots}
                      onClick={() => onSelectProject(item.data.id)}
                      onDragStart={(e) => handleDragStart(e, "project", item.data.id)}
                      onDragEnd={handleDragEnd}
                      isDragging={draggingId === item.data.id}
                    />
                  );
                }
                return null;
              })}

              {col.key === "done" && doneMonths.map(mk => {
                const items = doneByMonth[mk];
                const label = mk === thisMonth ? "이번 달" : (() => {
                  const [y, m] = mk.split("-");
                  const diff = (now.getFullYear() * 12 + now.getMonth()) - (parseInt(y) * 12 + (parseInt(m) - 1));
                  if (diff === 1) return "지난 달";
                  return `${y}년 ${parseInt(m)}월`;
                })();
                const isExpanded = expandedDone[mk];
                return (
                  <div key={mk}>
                    <div
                      onClick={() => setExpandedDone(prev => ({ ...prev, [mk]: !prev[mk] }))}
                      style={{
                        padding: "10px 16px", fontSize: 12, color: "#5E6380", cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        borderTop: `1px solid ${C.bd}`, marginTop: 8,
                      }}
                    >
                      <span>{label} {items.length}건</span>
                      <span>{isExpanded ? "▾" : "▸"}</span>
                    </div>
                    {isExpanded && items.map(item => {
                      if (item.type === "shoot") {
                        return (
                          <div key={item.data.id}
                            onClick={() => onEditShoot?.(item.data)}
                            style={{
                              background: C.sf, border: `1px solid ${C.bd}`, padding: 12, marginBottom: 6,
                              opacity: 0.6, cursor: "pointer",
                            }}
                            onMouseEnter={e => e.currentTarget.style.borderColor = "#454B66"}
                            onMouseLeave={e => e.currentTarget.style.borderColor = C.bd}
                          >
                            <div style={{ fontSize: 13, fontWeight: 600, color: C.tx }}>{item.data.guest}</div>
                            <div style={{ fontSize: 11, color: "#5E6380", marginTop: 2 }}>{item.data.topic}</div>
                          </div>
                        );
                      }
                      return (
                        <div key={item.data.id} onClick={() => onSelectProject(item.data.id)} style={{
                          background: C.sf, border: `1px solid ${C.bd}`, padding: 12, marginBottom: 6,
                          cursor: "pointer", opacity: 0.6,
                        }}
                          onMouseEnter={e => e.currentTarget.style.borderColor = "#454B66"}
                          onMouseLeave={e => e.currentTarget.style.borderColor = C.bd}
                        >
                          <div style={{ fontSize: 13, fontWeight: 600, color: C.tx }}>
                            {item.data.fn || item.data.filename || item.data.name || "제목 없음"}
                          </div>
                          <div style={{ fontSize: 11, color: "#5E6380", marginTop: 2 }}>
                            {formatShootDate(item.data.updatedAt || item.data.createdAt)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}

            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════
// SHOOT CARD (촬영 예정 등)
// ═══════════════════════════════════════════════

function ShootCard({ shoot, stage, onClick, onMoveStage, onDragStart, onDragEnd, isDragging, childCount }) {
  const allRoles = [
    ...(shoot.roles?.filming || []),
    ...(shoot.roles?.progress || []),
    ...(shoot.roles?.scriptEdit || []),
    ...(shoot.roles?.videoEdit || []),
  ];
  const stageAction = STAGE_NEXT[stage];

  // Episode badge logic
  const te = shoot.totalEpisodes;
  const linked = childCount || 0;
  let episodeBadge = null;
  if (te) {
    if (linked >= te) {
      episodeBadge = { text: `${te}편 모두 연결`, color: "#22C55E" };
    } else if (linked > 0) {
      episodeBadge = { text: `${te}편 중 ${linked}편 연결`, color: "#F59E0B" };
    } else {
      episodeBadge = { text: `${te}편`, color: "#4A6CF7" };
    }
  } else {
    episodeBadge = { text: "편 미정", color: "#5E6380" };
  }

  // Tags — support both legacy studioBooked and new studioA/B
  const hasStudioA = shoot.tags?.studioA || shoot.tags?.studioBooked;
  const hasStudioB = shoot.tags?.studioB;
  const hasDemo = shoot.tags?.hasDemo;
  const hasTags = hasStudioA || hasStudioB || hasDemo;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      style={{
        background: C.sf, border: `1px solid ${C.bd}`, padding: 14,
        cursor: "pointer", transition: "border-color 0.1s, opacity 0.2s",
        opacity: isDragging ? 0.4 : 1,
      }}
      onMouseEnter={e => { if (!isDragging) e.currentTarget.style.borderColor = "#454B66"; }}
      onMouseLeave={e => e.currentTarget.style.borderColor = C.bd}
    >
      {/* Tags + Episode badge row */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
        {/* Episode badge */}
        <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 2,
          background: episodeBadge.color + "20", color: episodeBadge.color }}>{episodeBadge.text}</span>
        {hasStudioA && (
          <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 2,
            background: "#7C3AED20", color: "#A78BFA" }}>A스튜디오</span>
        )}
        {hasStudioB && (
          <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 2,
            background: "#7C3AED20", color: "#A78BFA" }}>B스튜디오</span>
        )}
        {hasDemo && (
          <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 2,
            background: "#F59E0B20", color: "#FBBF24" }}>시연있음</span>
        )}
      </div>

      {/* Guest */}
      <div style={{ fontSize: 15, fontWeight: 700, color: C.tx, marginBottom: 2 }}>{shoot.guest}</div>

      {/* Topic */}
      {shoot.topic && (
        <div style={{ fontSize: 12, color: "#8B90A5", marginBottom: 8 }}>{shoot.topic}</div>
      )}

      {/* Bottom: date + avatars */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: "#5E6380" }}>{formatShootDate(shoot.shootDate)}</span>
        <div style={{ display: "flex" }}>
          {allRoles.slice(0, 4).map((r, i) => (
            <span key={r.email || i} style={{
              width: 22, height: 22, borderRadius: "50%",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 700, marginLeft: i > 0 ? -6 : 0,
              background: avatarColor(r.name || r.email) + "30",
              color: avatarColor(r.name || r.email),
              border: `2px solid ${C.sf}`,
            }}>
              {(r.name || r.email).charAt(0)}
            </span>
          ))}
        </div>
      </div>

      {/* Roles */}
      {allRoles.length > 0 && (
        <div style={{
          display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8,
          paddingTop: 8, borderTop: `1px solid ${C.bd}`,
          fontSize: 10, color: "#8B90A5",
        }}>
          {["filming","progress","scriptEdit","videoEdit"].map((roleKey, ri) => {
            const members = shoot.roles?.[roleKey] || [];
            if (members.length === 0) return null;
            return (
              <span key={roleKey} style={{ display: "flex", alignItems: "center", gap: 0 }}>
                {ri > 0 && <span style={{ color: C.bd, margin: "0 4px" }}>|</span>}
                <span style={{ width: 4, height: 4, borderRadius: "50%",
                  background: ROLE_COLORS[roleKey], display: "inline-block", marginRight: 3 }} />
                {ROLE_LABELS[roleKey]} {members.map(m => m.name).join(", ")}
              </span>
            );
          })}
        </div>
      )}

      {/* Stage transition button */}
      {stageAction && (
        <div
          onClick={(e) => { e.stopPropagation(); onMoveStage(shoot.id, stageAction.next); }}
          style={{
            marginTop: 10, padding: "7px 0", textAlign: "center",
            border: `1px solid ${C.bd}`, fontSize: 11, fontWeight: 600,
            color: "#8B90A5", cursor: "pointer", background: "#0F1117",
            transition: "all 0.15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = "#4A6CF7"; e.currentTarget.style.color = "#4A6CF7"; e.currentTarget.style.background = "#4A6CF710"; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = C.bd; e.currentTarget.style.color = "#8B90A5"; e.currentTarget.style.background = "#0F1117"; }}
        >
          {stageAction.label} →
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// TRANSITION CARD (원고 편집 — 촬영에서 넘어온 묶음)
// ═══════════════════════════════════════════════

function TransitionCard({ shoot, children, onSelectProject, onNewProject, onDragStart, onDragEnd, isDragging }) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={{
        background: C.sf, border: `1px solid #7C3AED40`,
        borderLeft: "3px solid #A78BFA", padding: 14,
        cursor: "grab", transition: "opacity 0.2s",
        opacity: isDragging ? 0.4 : 1,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#A78BFA" }}>
          {shoot.guest} ({shortShootDate(shoot.shootDate)} 촬영)
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: shoot.totalEpisodes ? "#EF4444" : "#5E6380" }}>
          {shoot.totalEpisodes ? `총 ${shoot.totalEpisodes}편` : "편 미정"}
        </span>
      </div>

      {/* Child projects */}
      {children.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {children.map(p => {
            const step = p.currentStep || p.step || "review";
            const stepColor = STEP_COLORS[step] || "#22C55E";
            const stepIdx = STEP_KEYS.indexOf(step);
            return (
              <div key={p.id}
                onClick={(e) => { e.stopPropagation(); onSelectProject(p.id); }}
                draggable={false}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 10px", background: "#0F1117", border: `1px solid ${C.bd}`,
                  cursor: "pointer", transition: "border-color 0.1s",
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = "#454B66"}
                onMouseLeave={e => e.currentTarget.style.borderColor = C.bd}
              >
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1, color: C.tx }}>
                  {p.fn || p.filename || p.name || "제목 없음"}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 2,
                  background: stepColor + "20", color: stepColor,
                }}>
                  {STEP_LABELS[step] || step}
                </span>
                <div style={{ display: "flex", gap: 2, width: 60 }}>
                  {STEP_KEYS.map((_, i) => (
                    <div key={i} style={{
                      height: 2, flex: 1,
                      background: i <= stepIdx ? stepColor : C.bd,
                    }} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add project button */}
      <div
        onClick={(e) => { e.stopPropagation(); onNewProject?.(); }}
        draggable={false}
        style={{
          marginTop: 8, padding: "6px 0", textAlign: "center",
          border: `1px dashed ${C.bd}`, fontSize: 11, color: "#5E6380",
          cursor: "pointer",
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = "#454B66"; e.currentTarget.style.color = "#8B90A5"; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = C.bd; e.currentTarget.style.color = "#5E6380"; }}
      >
        + 원고 프로젝트 추가
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// PROJECT CARD (독립 편)
// ═══════════════════════════════════════════════

function ProjectCard({ project, shoots, onClick, onDragStart, onDragEnd, isDragging }) {
  const step = project.currentStep || project.step || "review";
  const stepColor = STEP_COLORS[step] || "#22C55E";
  const stepIdx = STEP_KEYS.indexOf(step);
  const editors = project.editors || [];

  const parentShoot = project.parentShootId
    ? (Array.isArray(shoots) ? shoots : []).find(s => s.id === project.parentShootId)
    : null;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      style={{
        background: C.sf, border: `1px solid ${C.bd}`, padding: 14,
        cursor: "pointer", transition: "border-color 0.1s, opacity 0.2s",
        opacity: isDragging ? 0.4 : 1,
      }}
      onMouseEnter={e => { if (!isDragging) e.currentTarget.style.borderColor = "#454B66"; }}
      onMouseLeave={e => e.currentTarget.style.borderColor = C.bd}
    >
      {parentShoot && (
        <div style={{ fontSize: 10, color: "#5E6380", marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.bd, display: "inline-block" }} />
          {parentShoot.guest} ({shortShootDate(parentShoot.shootDate)} 촬영)
        </div>
      )}

      <div style={{ fontSize: 14, fontWeight: 700, color: C.tx, marginBottom: 6 }}>
        {project.fn || project.filename || project.name || "제목 없음"}
      </div>

      <span style={{
        fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 2,
        display: "inline-block", marginBottom: 8,
        background: stepColor + "20", color: stepColor,
      }}>
        {STEP_LABELS[step] || step}
      </span>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: "#5E6380" }}>
          {project.updatedAt ? shortShootDate(project.updatedAt) : shortShootDate(project.createdAt)}
        </span>
        <div style={{ display: "flex" }}>
          {editors.slice(0, 3).map((ed, i) => {
            const name = typeof ed === "string" ? ed : (ed.name || ed.email || "?");
            return (
              <span key={i} style={{
                width: 22, height: 22, borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 700, marginLeft: i > 0 ? -6 : 0,
                background: avatarColor(name) + "30",
                color: avatarColor(name),
                border: `2px solid ${C.sf}`,
              }}>
                {name.charAt(0)}
              </span>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", gap: 2, marginTop: 8 }}>
        {STEP_KEYS.map((_, i) => (
          <div key={i} style={{
            height: 3, flex: 1,
            background: i <= stepIdx ? stepColor : C.bd,
          }} />
        ))}
      </div>
    </div>
  );
}
