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

export function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem("te_cfg") || "{}") }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
export function saveConfig(c) { localStorage.setItem("te_cfg", JSON.stringify(c)); }
