import { useState, useEffect, useRef } from "react";
import { C, FN } from "../utils/styles.js";

function authHeaders() {
  const token = localStorage.getItem("ttimes_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const AVATAR_COLORS = ["#4A6CF7","#7C3AED","#EC4899","#F59E0B","#10B981","#EF4444","#06B6D4","#8B5CF6"];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// ── Role-specific priority ordering ──
const ROLE_PRIORITY = {
  filming: ["장민주", "강기훈"],
  scriptEdit: ["박성수", "배소진", "홍재의", "이재원", "이사민"],
  videoEdit: ["박의정", "박선희", "장민주", "강채은", "강기훈", "박수형", "허재석", "이소민"],
};

function getSortedMembers(members, roleKey) {
  const priorityNames = ROLE_PRIORITY[roleKey] || [];
  return [...members].sort((a, b) => {
    const aIdx = priorityNames.indexOf(a.name);
    const bIdx = priorityNames.indexOf(b.name);
    if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
    if (aIdx >= 0) return -1;
    if (bIdx >= 0) return 1;
    return 0;
  });
}

// ── Parse shoot date for edit mode ──
function parseShootDateTime(shoot) {
  if (!shoot?.shootDate) {
    const today = new Date();
    return {
      date: today.toISOString().split("T")[0],
      ampm: "오전",
      hour: "10",
      minute: "00",
    };
  }
  const d = new Date(shoot.shootDate);
  const h = d.getHours();
  const m = d.getMinutes();
  let displayHour, displayAmpm;
  if (h < 12) {
    displayAmpm = "오전";
    displayHour = h === 0 ? "12" : String(h);
  } else {
    displayAmpm = "오후";
    displayHour = h === 12 ? "12" : String(h - 12);
  }
  return {
    date: shoot.shootDate.split("T")[0],
    ampm: displayAmpm,
    hour: displayHour,
    minute: String(m).padStart(2, "0"),
  };
}

export function ShootModal({ authUser, cfg, onClose, onCreate, shoot: editShoot }) {
  const isEdit = !!editShoot;
  const initTime = parseShootDateTime(editShoot);
  const defaultDate = editShoot ? initTime.date : new Date().toISOString().split("T")[0];

  const [guest, setGuest] = useState(editShoot?.guest || "");
  const [topic, setTopic] = useState(editShoot?.topic || "");
  const [shootDate, setShootDate] = useState(defaultDate);
  const [ampm, setAmpm] = useState(initTime.ampm);
  const [hour, setHour] = useState(initTime.hour);
  const [minute, setMinute] = useState(initTime.minute);
  const [tags, setTags] = useState(editShoot?.tags || { studioBooked: false, hasDemo: false });
  const [roles, setRoles] = useState(editShoot?.roles || { filming: [], scriptEdit: [], videoEdit: [] });
  const [memo, setMemo] = useState(editShoot?.memo || "");
  const [teamMembers, setTeamMembers] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [openDropdown, setOpenDropdown] = useState(null);

  const dropdownRef = useRef(null);
  const dateInputRef = useRef(null);

  useEffect(() => {
    if (!cfg?.workerUrl) return;
    fetch(`${cfg.workerUrl}/team/members`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (d?.members) setTeamMembers(d.members); })
      .catch(() => {});
  }, [cfg]);

  // ── Outside click to close dropdown ──
  useEffect(() => {
    if (!openDropdown) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        // Check if clicked on a "+ 추가" button (don't close if toggling)
        if (e.target.closest("[data-role-add]")) return;
        setOpenDropdown(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openDropdown]);

  const toggleTag = (key) => setTags(prev => ({ ...prev, [key]: !prev[key] }));

  const addRole = (roleKey, member) => {
    setRoles(prev => {
      const current = prev[roleKey] || [];
      if (current.some(r => r.email === (member.email || member.id))) return prev;
      return { ...prev, [roleKey]: [...current, { email: member.email || member.id, name: member.name || member.email }] };
    });
  };

  const removeRole = (roleKey, email) => {
    setRoles(prev => ({ ...prev, [roleKey]: (prev[roleKey] || []).filter(r => r.email !== email) }));
  };

  // ── Hours: 오전 8~11, 오후 12~9 ──
  const hourOptions = ampm === "오전" ? [8, 9, 10, 11] : [12, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  // If current hour is not in the new options after AM/PM switch, reset to first valid
  useEffect(() => {
    const h = parseInt(hour);
    if (!hourOptions.includes(h)) {
      setHour(String(hourOptions[0]));
    }
  }, [ampm]);

  const handleSubmit = async () => {
    if (!guest || submitting) return;
    setSubmitting(true);
    try {
      let shootDateTime = null;
      if (shootDate) {
        let h = parseInt(hour);
        if (ampm === "오후" && h < 12) h += 12;
        if (ampm === "오전" && h === 12) h = 0;
        shootDateTime = `${shootDate}T${String(h).padStart(2,"0")}:${minute}:00`;
      }

      const endpoint = isEdit ? "/shoots/update" : "/shoots/create";
      const payload = isEdit
        ? { id: editShoot.id, guest, topic, shootDate: shootDateTime, tags, roles, memo }
        : { guest, topic, shootDate: shootDateTime, tags, roles, memo };

      await fetch(`${cfg.workerUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
      });
      onCreate();
    } catch (err) {
      console.error("촬영 일정 저장 실패:", err);
    } finally {
      setSubmitting(false);
    }
  };

  const labelStyle = { fontSize: 12, fontWeight: 600, color: "#8B90A5", marginBottom: 6, display: "block", letterSpacing: 0.3 };
  const inputStyle = {
    width: "100%", padding: "10px 12px", border: "1px solid #2E3348", background: "#0F1117",
    color: "#E8E9ED", fontSize: 14, fontFamily: FN, outline: "none", boxSizing: "border-box",
  };

  const ROLE_LABELS = { filming: "촬영", scriptEdit: "원고 편집", videoEdit: "영상 편집" };
  const ROLE_COLORS = { filming: "#F59E0B", scriptEdit: "#4A6CF7", videoEdit: "#22C55E" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200,
      display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div style={{ background: "#181B25", border: "1px solid #2E3348", padding: 28,
        width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto", fontFamily: FN }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#E8E9ED", letterSpacing: -0.5 }}>
            {isEdit ? "촬영 일정 수정" : "촬영 일정 추가"}
          </div>
          <button onClick={onClose} style={{ width: 28, height: 28, display: "flex", alignItems: "center",
            justifyContent: "center", cursor: "pointer", color: "#5E6380", fontSize: 16,
            border: "1px solid #2E3348", background: "none" }}>✕</button>
        </div>

        {/* 게스트 */}
        <div style={{ marginBottom: 18 }}>
          <label style={labelStyle}>인터뷰 대상 (게스트)</label>
          <input value={guest} onChange={e => setGuest(e.target.value)}
            placeholder="게스트 이름 또는 직함" style={inputStyle} />
        </div>

        {/* 주제 */}
        <div style={{ marginBottom: 18 }}>
          <label style={labelStyle}>주제 / 메모</label>
          <input value={topic} onChange={e => setTopic(e.target.value)}
            placeholder="인터뷰 주제, 특이사항 등" style={inputStyle} />
        </div>

        {/* 날짜 + 시간 */}
        <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>촬영 날짜</label>
            <div
              onClick={() => { try { dateInputRef.current?.showPicker(); } catch {} }}
              style={{ cursor: "pointer" }}
            >
              <input ref={dateInputRef} type="date" value={shootDate}
                onChange={e => setShootDate(e.target.value)}
                style={{ ...inputStyle, cursor: "pointer" }} />
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>촬영 시간</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select value={ampm} onChange={e => setAmpm(e.target.value)}
                style={{ ...inputStyle, width: "auto", padding: "10px 12px" }}>
                <option>오전</option><option>오후</option>
              </select>
              <select value={hour} onChange={e => setHour(e.target.value)}
                style={{ ...inputStyle, width: "auto", padding: "10px 12px" }}>
                {hourOptions.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
              <span style={{ color: "#5E6380", fontWeight: 600 }}>:</span>
              <select value={minute} onChange={e => setMinute(e.target.value)}
                style={{ ...inputStyle, width: "auto", padding: "10px 12px" }}>
                <option value="00">00</option><option value="30">30</option>
              </select>
            </div>
          </div>
        </div>

        {/* 태그 */}
        <div style={{ marginBottom: 18 }}>
          <div style={labelStyle}>상태 태그</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <span onClick={() => toggleTag("studioBooked")} style={{
              fontSize: 12, fontWeight: 600, padding: "6px 14px", cursor: "pointer",
              border: `1px solid ${tags.studioBooked ? "#7C3AED50" : "#2E3348"}`,
              background: tags.studioBooked ? "#7C3AED25" : "#0F1117",
              color: tags.studioBooked ? "#A78BFA" : "#5E6380",
            }}>스튜디오 예약 완료</span>
            <span onClick={() => toggleTag("hasDemo")} style={{
              fontSize: 12, fontWeight: 600, padding: "6px 14px", cursor: "pointer",
              border: `1px solid ${tags.hasDemo ? "#F59E0B50" : "#2E3348"}`,
              background: tags.hasDemo ? "#F59E0B25" : "#0F1117",
              color: tags.hasDemo ? "#FBBF24" : "#5E6380",
            }}>시연있음</span>
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: "#2E3348", margin: "22px 0" }} />

        {/* 역할 배정 */}
        <div style={{ marginBottom: 18 }}>
          <div style={labelStyle}>역할 배정 (CMS 등록자 중 선택)</div>
          {["filming", "scriptEdit", "videoEdit"].map(roleKey => {
            const members = roles[roleKey] || [];
            const color = ROLE_COLORS[roleKey];
            return (
              <div key={roleKey} style={{ display: "flex", alignItems: "center", border: "1px solid #2E3348", marginBottom: 10 }}>
                <div style={{ width: 100, padding: "10px 14px", fontSize: 13, fontWeight: 700,
                  color: "#E8E9ED", background: "#1E2230", flexShrink: 0, borderRight: "1px solid #2E3348" }}>
                  {ROLE_LABELS[roleKey]}
                </div>
                <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 12px", minHeight: 42, alignItems: "center" }}>
                  {members.map(m => (
                    <span key={m.email} style={{ display: "flex", alignItems: "center", gap: 5,
                      fontSize: 12, fontWeight: 600, padding: "3px 10px",
                      background: color + "15", color: color }}>
                      <span style={{ width: 18, height: 18, borderRadius: "50%", display: "flex",
                        alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700,
                        background: color + "30", color }}>{m.name.charAt(0)}</span>
                      {m.name}
                      <span onClick={() => removeRole(roleKey, m.email)}
                        style={{ fontSize: 9, opacity: 0.6, cursor: "pointer", marginLeft: 2 }}>✕</span>
                    </span>
                  ))}
                  <span data-role-add="true"
                    onClick={() => setOpenDropdown(openDropdown === roleKey ? null : roleKey)}
                    style={{ fontSize: 11, color: "#5E6380", cursor: "pointer" }}>+ 추가</span>
                </div>
              </div>
            );
          })}
          {/* Dropdown */}
          {openDropdown && (
            <div ref={dropdownRef} style={{ border: "1px solid #2E3348", background: "#0F1117", marginLeft: 100 }}>
              {/* Close button */}
              <div onClick={() => setOpenDropdown(null)}
                style={{ padding: "6px 14px", fontSize: 11, color: "#8B90A5", cursor: "pointer",
                  borderBottom: "1px solid #2E3348", display: "flex", alignItems: "center", justifyContent: "space-between" }}
                onMouseEnter={e => e.currentTarget.style.background = "#1E2230"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span>닫기</span><span>✕</span>
              </div>
              {getSortedMembers(teamMembers, openDropdown).map(m => {
                const isSelected = (roles[openDropdown] || []).some(r => r.email === (m.email || m.id));
                return (
                  <div key={m.email || m.id}
                    onClick={() => { if (!isSelected) addRole(openDropdown, m); }}
                    style={{ padding: "8px 14px", fontSize: 13, cursor: isSelected ? "default" : "pointer",
                      display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #1E2230" }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#1E2230"; }}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <span style={{ width: 20, height: 20, borderRadius: "50%", display: "flex",
                      alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700,
                      background: avatarColor(m.name || m.email) + "40",
                      color: avatarColor(m.name || m.email) }}>{(m.name || m.email).charAt(0)}</span>
                    <span style={{ fontWeight: 500, flex: 1, color: "#E8E9ED" }}>{m.name || m.email}</span>
                    {isSelected && <span style={{ fontSize: 11, fontWeight: 600, color: "#4ADE80" }}>선택됨</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24, paddingTop: 20, borderTop: "1px solid #2E3348" }}>
          <button onClick={onClose} style={{ background: "none", border: "1px solid #2E3348",
            padding: "10px 22px", fontSize: 13, cursor: "pointer", color: "#8B90A5", fontFamily: FN }}>취소</button>
          <button onClick={handleSubmit} disabled={!guest || submitting}
            style={{ background: (!guest || submitting) ? "#555" : "#E8E9ED",
              color: "#0F1117", border: "none", padding: "10px 26px", fontSize: 13,
              fontWeight: 700, cursor: (!guest || submitting) ? "not-allowed" : "pointer", fontFamily: FN }}>
            {submitting ? "저장 중..." : isEdit ? "수정 완료" : "일정 등록"}
          </button>
        </div>
      </div>
    </div>
  );
}
