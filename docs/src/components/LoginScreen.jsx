import { useState } from "react";

const AUTH_URL = "https://auth.ttimes6000.workers.dev";

export function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState("login"); // "login" | "changePassword"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPwConfirm, setNewPwConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tempToken, setTempToken] = useState(null);
  const [tempUser, setTempUser] = useState(null);

  async function handleLogin(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${AUTH_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.mustChangePassword) {
          setTempToken(data.token);
          setTempUser(data.user);
          setMode("changePassword");
        } else {
          onLogin(data.token, data.user);
        }
      } else {
        setError(data.error || "로그인에 실패했습니다.");
      }
    } catch (err) {
      setError("서버에 연결할 수 없습니다.");
    } finally {
      setLoading(false);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setError("");
    if (newPw.length < 8) {
      setError("비밀번호는 8자 이상이어야 합니다.");
      return;
    }
    if (newPw !== newPwConfirm) {
      setError("새 비밀번호가 일치하지 않습니다.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${AUTH_URL}/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${tempToken}`,
        },
        body: JSON.stringify({ currentPassword: password, newPassword: newPw }),
      });
      const data = await res.json();
      if (data.success) {
        // 비밀번호 변경 후 새 토큰으로 로그인
        if (data.token) {
          onLogin(data.token, tempUser);
        } else {
          onLogin(tempToken, tempUser);
        }
      } else {
        setError(data.error || "비밀번호 변경에 실패했습니다.");
      }
    } catch {
      setError("서버에 연결할 수 없습니다.");
    } finally {
      setLoading(false);
    }
  }

  const cardStyle = {
    background: "#1A1A2E",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 16,
    padding: "48px 40px",
    width: "100%",
    maxWidth: 400,
    boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
  };

  const inputStyle = {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.05)",
    color: "#E5E7EB",
    fontSize: 14,
    fontFamily: "'Pretendard Variable', sans-serif",
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color 0.2s",
  };

  const btnStyle = {
    width: "100%",
    padding: "13px 0",
    borderRadius: 8,
    border: "none",
    background: loading ? "rgba(74,108,247,0.4)" : "linear-gradient(135deg, #4A6CF7, #7C3AED)",
    color: "#fff",
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "'Pretendard Variable', sans-serif",
    cursor: loading ? "not-allowed" : "pointer",
    transition: "all 0.2s",
    marginTop: 8,
  };

  return (
    <div style={{
      height: "100vh",
      background: "#0F0F23",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Pretendard Variable', sans-serif",
    }}>
      <div style={cardStyle}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "#E5E7EB", margin: 0, letterSpacing: "-0.03em" }}>
            <span style={{ color: "#4A6CF7" }}>TTimes</span> 편집 CMS
          </h1>
          {mode === "changePassword" && (
            <p style={{ fontSize: 13, color: "#9CA3AF", marginTop: 12 }}>
              첫 로그인입니다. 새 비밀번호를 설정해주세요.
            </p>
          )}
        </div>

        {mode === "login" ? (
          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 6, display: "block" }}>아이디</label>
              <input
                type="text"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="아이디를 입력하세요"
                style={inputStyle}
                autoFocus
                required
              />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 6, display: "block" }}>비밀번호</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="비밀번호를 입력하세요"
                style={inputStyle}
                required
              />
            </div>
            {error && (
              <div style={{
                padding: "10px 14px", borderRadius: 8, marginBottom: 16,
                background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)",
                color: "#EF4444", fontSize: 13,
              }}>
                {error}
              </div>
            )}
            <button type="submit" disabled={loading} style={btnStyle}>
              {loading ? "로그인 중..." : "로그인"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleChangePassword}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 6, display: "block" }}>새 비밀번호</label>
              <input
                type="password"
                value={newPw}
                onChange={e => setNewPw(e.target.value)}
                placeholder="8자 이상 입력"
                style={inputStyle}
                autoFocus
                required
                minLength={8}
              />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 6, display: "block" }}>새 비밀번호 확인</label>
              <input
                type="password"
                value={newPwConfirm}
                onChange={e => setNewPwConfirm(e.target.value)}
                placeholder="비밀번호를 다시 입력"
                style={inputStyle}
                required
              />
            </div>
            {error && (
              <div style={{
                padding: "10px 14px", borderRadius: 8, marginBottom: 16,
                background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)",
                color: "#EF4444", fontSize: 13,
              }}>
                {error}
              </div>
            )}
            <button type="submit" disabled={loading} style={btnStyle}>
              {loading ? "변경 중..." : "비밀번호 변경"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
