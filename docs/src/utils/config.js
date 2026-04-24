// ═══════════════════════════════════════════════
// CONFIG & PERSISTENCE
// ═══════════════════════════════════════════════

export const DEFAULT_CONFIG = {
  apiMode: "live",
  workerUrl: "https://editor.ttimes.workers.dev",
  fillers: ["이제","또","좀","뭐","그냥","약간","진짜","되게","막","이렇게","저렇게"],
  customTerms: {},
  chunkSize: 8000,
};

// ★ workerUrl 은 빌드 타임 상수 (DEFAULT_CONFIG.workerUrl) 만 사용.
//   브라우저 localStorage 의 te_cfg 에 workerUrl 이 박혀 있어도 런타임에 무시.
//   동일 origin(ttimesvibe.github.io) 에 editor(PROD) 와 ttimes-editor(TEST) 가
//   공존해 localStorage 를 공유하므로, 한쪽 설정 저장이 다른쪽 워커 호출을
//   유발하는 KV 섞임 사고를 물리적으로 차단.
export function loadConfig() {
  try {
    const cached = JSON.parse(localStorage.getItem("te_cfg") || "{}");
    return { ...DEFAULT_CONFIG, ...cached, workerUrl: DEFAULT_CONFIG.workerUrl };
  } catch { return { ...DEFAULT_CONFIG }; }
}
export function saveConfig(c) {
  // workerUrl 은 저장 대상에서 제외 (빌드 타임 상수만 권위 있는 값)
  const { workerUrl, ...rest } = c || {};
  localStorage.setItem("te_cfg", JSON.stringify(rest));
}
