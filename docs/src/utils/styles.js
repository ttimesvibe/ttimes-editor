// ═══════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════

export const DARK_THEME = {
  bg:"#0F1117",sf:"#181B25",bd:"#2A2E3B",
  tx:"#E4E6ED",txM:"#8B8FA3",txD:"#5C6078",
  ac:"#4A6CF7",acS:"rgba(74,108,247,0.12)",
  fBg:"rgba(251,191,36,0.18)",fTx:"#FBBF24",fSk:"#D4A017",
  tBg:"rgba(239,68,68,0.15)",tTx:"#EF4444",
  cBg:"rgba(34,197,94,0.15)",cTx:"#22C55E",
  sBg:"rgba(56,189,248,0.15)",sTx:"#38BDF8",scBg:"rgba(14,165,233,0.15)",scTx:"#0EA5E9",
  hBd:"#A855F7",hBg:"rgba(168,85,247,0.12)",
  vBd:"#3B82F6",vBg:"rgba(59,130,246,0.1)",
  ok:"#22C55E",wn:"#FBBF24",
  glass:"rgba(255,255,255,0.03)",glassHover:"rgba(255,255,255,0.06)",
  btnTx:"#fff",inputBg:"rgba(255,255,255,0.06)",
  linkTx:"#60A5FA",shadow:"rgba(0,0,0,0.4)",
};
export const LIGHT_THEME = {
  bg:"#F8F9FB",sf:"#FFFFFF",bd:"#E2E4E9",
  tx:"#1A1D27",txM:"#5C6078",txD:"#8B8FA3",
  ac:"#4A6CF7",acS:"rgba(74,108,247,0.08)",
  fBg:"rgba(251,191,36,0.12)",fTx:"#B45309",fSk:"#92400E",
  tBg:"rgba(239,68,68,0.10)",tTx:"#DC2626",
  cBg:"rgba(34,197,94,0.10)",cTx:"#16A34A",
  sBg:"rgba(56,189,248,0.10)",sTx:"#0284C7",scBg:"rgba(14,165,233,0.10)",scTx:"#0369A1",
  hBd:"#9333EA",hBg:"rgba(168,85,247,0.08)",
  vBd:"#2563EB",vBg:"rgba(59,130,246,0.06)",
  ok:"#16A34A",wn:"#D97706",
  glass:"rgba(0,0,0,0.02)",glassHover:"rgba(0,0,0,0.04)",
  btnTx:"#fff",inputBg:"rgba(0,0,0,0.04)",
  linkTx:"#2563EB",shadow:"rgba(0,0,0,0.1)",
};

export let _savedTheme = "dark";
try { _savedTheme = localStorage.getItem("td_theme") || "dark"; } catch {}
export const C = { ...(_savedTheme === "light" ? LIGHT_THEME : DARK_THEME) };
export function applyTheme(mode) {
  Object.assign(C, mode === "light" ? LIGHT_THEME : DARK_THEME);
  try { localStorage.setItem("td_theme", mode); } catch {}
}

export const FN = "'Pretendard','Noto Sans KR',-apple-system,sans-serif";

// 형광펜 색상 (다크/라이트)
export const MARKER_COLORS_DARK = {
  yellow: { bg: "rgba(251,191,36,0.3)", border: "#FBBF24", label: "노랑" },
  blue:   { bg: "rgba(59,130,246,0.3)", border: "#3B82F6", label: "파랑" },
  cyan:   { bg: "rgba(34,211,238,0.3)", border: "#22D3EE", label: "하늘" },
  red:    { bg: "rgba(239,68,68,0.3)",  border: "#EF4444", label: "빨강" },
  pink:   { bg: "rgba(236,72,153,0.3)", border: "#EC4899", label: "분홍" },
  green:  { bg: "rgba(34,197,94,0.3)",  border: "#22C55E", label: "초록", _hidden: true },
};
export const MARKER_COLORS_LIGHT = {
  yellow: { bg: "rgba(251,191,36,0.22)", border: "#D97706", label: "노랑" },
  blue:   { bg: "rgba(59,130,246,0.22)", border: "#2563EB", label: "파랑" },
  cyan:   { bg: "rgba(34,211,238,0.22)", border: "#0891B2", label: "하늘" },
  red:    { bg: "rgba(239,68,68,0.22)",  border: "#DC2626", label: "빨강" },
  pink:   { bg: "rgba(236,72,153,0.22)", border: "#DB2777", label: "분홍" },
  green:  { bg: "rgba(34,197,94,0.22)",  border: "#16A34A", label: "초록", _hidden: true },
};
export let MARKER_COLORS = _savedTheme === "light" ? MARKER_COLORS_LIGHT : MARKER_COLORS_DARK;
export function setMarkerColors(colors) { MARKER_COLORS = colors; }
