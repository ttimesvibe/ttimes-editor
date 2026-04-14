import { useState, useEffect, useRef } from "react";
import { C, FN } from "../utils/styles.js";
import * as mammoth from "mammoth";

function authHeaders() {
  const token = localStorage.getItem("ttimes_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readFile(file) {
  if (file.name.endsWith(".docx")) {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }
  return await file.text();
}

export function NewProjectModal({ authUser, cfg, onClose, onCreate }) {
  const [fn, setFn] = useState("");
  const [file, setFile] = useState(null);
  const [memo, setMemo] = useState("");
  const [editors, setEditors] = useState([]);
  const [teamMembers, setTeamMembers] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  // Auto-add creator as editor on mount
  useEffect(() => {
    if (authUser) {
      setEditors([{ id: authUser.id || authUser.email, name: authUser.name || authUser.email, removable: false }]);
    }
  }, [authUser]);

  // Fetch team members
  useEffect(() => {
    if (!cfg?.workerUrl) return;
    fetch(`${cfg.workerUrl}/team/members`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (d?.members) setTeamMembers(d.members); })
      .catch(() => {});
  }, [cfg]);

  const handleFile = (f) => {
    if (!f) return;
    setFile(f);
    if (!fn) {
      const name = f.name.replace(/\.(docx|txt)$/i, "");
      setFn(name);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && /\.(docx|txt)$/i.test(f.name)) handleFile(f);
  };

  const handleFileInput = (e) => {
    const f = e.target.files[0];
    if (f) handleFile(f);
  };

  const addEditor = (member) => {
    if (editors.some(e => (e.id || e.email) === (member.id || member.email))) return;
    setEditors(prev => [...prev, { id: member.id || member.email, name: member.name || member.email, removable: true }]);
  };

  const removeEditor = (id) => {
    setEditors(prev => prev.filter(e => e.id !== id || !e.removable));
  };

  const handleSubmit = async () => {
    if (!fn || !file || submitting) return;
    setSubmitting(true);
    try {
      const fileContent = await readFile(file);
      const res = await fetch(`${cfg.workerUrl}/projects/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          fn,
          editors: editors.map(e => ({ email: e.id, name: e.name })),
          memo,
        }),
      });
      const data = await res.json();
      if (data?.id) {
        onCreate(data.id, fileContent, file.name);
      }
    } catch (err) {
      console.error("프로젝트 생성 실패:", err);
    } finally {
      setSubmitting(false);
    }
  };

  // Available members = team members not already added
  const availableMembers = teamMembers.filter(
    m => !editors.some(e => (e.id || e.email) === (m.id || m.email))
  );

  const labelStyle = { fontSize: 13, fontWeight: 600, color: "#9CA3AF", marginBottom: 6, display: "block", fontFamily: FN };
  const inputStyle = {
    width: "100%", padding: 10, borderRadius: 6,
    border: "1px solid #2E3348", background: "#0F1117",
    color: "#fff", fontSize: 14, fontFamily: FN, outline: "none",
    boxSizing: "border-box",
    transition: "border-color 0.15s",
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "#1A1D2E", borderRadius: 12, padding: 28,
          width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto",
          border: "1px solid #2E3348", fontFamily: FN,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>새 프로젝트</div>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "none", color: "#5E6380",
              fontSize: 20, cursor: "pointer", padding: 4, lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* 프로젝트명 */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>프로젝트명</label>
          <input
            value={fn}
            onChange={e => setFn(e.target.value)}
            placeholder="프로젝트 이름을 입력하세요"
            style={inputStyle}
            onFocus={e => e.target.style.borderColor = "#4A6CF7"}
            onBlur={e => e.target.style.borderColor = "#2E3348"}
          />
        </div>

        {/* 원고 파일 */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>원고 파일</label>
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? "#4A6CF7" : "#2E3348"}`,
              borderRadius: 8, padding: 24, textAlign: "center",
              color: file ? "#fff" : "#5E6380",
              cursor: "pointer", transition: "border-color 0.15s",
              background: dragOver ? "rgba(74,108,247,0.05)" : "transparent",
            }}
            onMouseEnter={e => { if (!dragOver) e.currentTarget.style.borderColor = "#4A6CF7"; }}
            onMouseLeave={e => { if (!dragOver) e.currentTarget.style.borderColor = "#2E3348"; }}
          >
            {file ? (
              <div style={{ fontSize: 14 }}>
                <span style={{ marginRight: 6 }}>📄</span>{file.name}
              </div>
            ) : (
              <div style={{ fontSize: 13 }}>파일을 끌어다 놓거나 클릭하세요<br />
                <span style={{ fontSize: 11, color: "#444" }}>.docx, .txt</span>
              </div>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".docx,.txt"
            style={{ display: "none" }}
            onChange={handleFileInput}
          />
        </div>

        {/* 생성자 */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>생성자</label>
          <input
            readOnly
            value={authUser?.name || authUser?.email || ""}
            style={{ ...inputStyle, color: "#6B7280", cursor: "default" }}
          />
        </div>

        {/* 편집자 배정 */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>편집자 배정</label>
          {availableMembers.length > 0 && (
            <select
              value=""
              onChange={e => {
                const member = teamMembers.find(m => (m.id || m.email) === e.target.value);
                if (member) addEditor(member);
              }}
              style={{
                ...inputStyle, marginBottom: 8, cursor: "pointer",
                appearance: "auto",
              }}
            >
              <option value="" disabled>팀원 선택</option>
              {availableMembers.map(m => (
                <option key={m.id || m.email} value={m.id || m.email}>
                  {m.name || m.email}
                </option>
              ))}
            </select>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
            {editors.map(e => (
              <span
                key={e.id}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  background: "rgba(74,108,247,0.15)", color: "#4A6CF7",
                  borderRadius: 12, padding: "4px 10px", fontSize: 12,
                  fontFamily: FN,
                }}
              >
                {e.name}
                {e.removable && (
                  <button
                    onClick={() => removeEditor(e.id)}
                    style={{
                      background: "none", border: "none", color: "#4A6CF7",
                      cursor: "pointer", padding: 0, marginLeft: 2,
                      fontSize: 12, lineHeight: 1, fontWeight: 700,
                    }}
                  >
                    ✕
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>

        {/* 메모 */}
        <div style={{ marginBottom: 24 }}>
          <label style={labelStyle}>메모</label>
          <textarea
            value={memo}
            onChange={e => setMemo(e.target.value)}
            rows={3}
            placeholder="게스트 정보, 촬영 특이사항 등"
            style={{ ...inputStyle, resize: "vertical" }}
            onFocus={e => e.target.style.borderColor = "#4A6CF7"}
            onBlur={e => e.target.style.borderColor = "#2E3348"}
          />
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={!fn || !file || submitting}
          style={{
            width: "100%", padding: "12px 0", borderRadius: 8, border: "none",
            background: (!fn || !file || submitting)
              ? "rgba(74,108,247,0.3)"
              : "linear-gradient(135deg, #7C3AED, #4A6CF7)",
            color: "#fff", fontSize: 15, fontWeight: 700, cursor: (!fn || !file || submitting) ? "not-allowed" : "pointer",
            fontFamily: FN, transition: "opacity 0.15s",
          }}
        >
          {submitting ? "생성 중..." : "프로젝트 생성"}
        </button>
      </div>
    </div>
  );
}
