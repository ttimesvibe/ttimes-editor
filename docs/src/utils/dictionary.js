// ═══════════════════════════════════════════════
// TERM DICTIONARY — 팀 공유 단어장 (Worker KV + localStorage 캐시)
// ═══════════════════════════════════════════════

export function loadDictionary() {
  try { return JSON.parse(localStorage.getItem("te_dict") || "[]"); }
  catch { return []; }
}

export function saveDictionary(terms) {
  localStorage.setItem("te_dict", JSON.stringify(terms));
}

// Worker에서 팀 공유 단어장 불러오기 → localStorage 캐시 갱신
export async function syncDictionaryFromServer(config) {
  if (config.apiMode === "mock" || !config.workerUrl) return loadDictionary();
  try {
    const token = localStorage.getItem("ttimes_token");
    const r = await fetch(`${config.workerUrl}/dict`, {
      headers: token ? { "Authorization": `Bearer ${token}` } : {},
    });
    const d = await r.json();
    if (d.success && Array.isArray(d.dict)) {
      // 오염된 항목 자동 정리: 문장 조각이 아닌 진짜 용어만 유지
      const JOSA_ENDINGS = /(?:을|를|이|가|은|는|에서|으로|에게|하고|되는|하는|있는|없는|같은|되는|보는|갖다가|뽑아|했을|라는|인데|인가|이런|저런)$/;
      const cleaned = d.dict.filter(word => {
        if (typeof word !== "string") return false;
        const w = word.trim();
        if (!w) return false;
        const spaceCount = (w.match(/\s/g) || []).length;
        // 공백 2개 이상이면 문장 조각 → 제거
        if (spaceCount >= 2) return false;
        // 10자 초과 + 공백 포함이면 문장 조각 가능성 높음 → 제거
        if (w.length > 10 && spaceCount >= 1) return false;
        // 조사/어미로 끝나면 문장 조각 → 제거
        if (JOSA_ENDINGS.test(w)) return false;
        return true;
      });
      if (cleaned.length < d.dict.length) {
        console.log(`📚 단어장 자동 정리: ${d.dict.length}건 → ${cleaned.length}건 (${d.dict.length - cleaned.length}건 제거)`);
        saveDictionary(cleaned);
        // 서버에도 정리된 버전 저장
        await saveDictionaryToServer(cleaned, config);
        return cleaned;
      }
      saveDictionary(d.dict);
      return d.dict;
    }
  } catch (e) { console.warn("단어장 서버 동기화 실패:", e.message); }
  return loadDictionary();
}

// Worker에 팀 공유 단어장 저장 + localStorage 캐시 갱신
export async function saveDictionaryToServer(terms, config) {
  saveDictionary(terms); // 로컬 캐시 즉시 반영
  if (config.apiMode === "mock" || !config.workerUrl) return;
  try {
    const token = localStorage.getItem("ttimes_token");
    await fetch(`${config.workerUrl}/dict`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "Authorization": `Bearer ${token}` } : {}) },
      body: JSON.stringify({ dict: terms }),
    });
  } catch (e) { console.warn("단어장 서버 저장 실패:", e.message); }
}

// Step 0 결과에서 correct 값을 추출하여 기존 단어장과 병합 (중복 제거)
export function mergeDictionary(existingDict, newTerms) {
  const merged = [...existingDict];
  const existingSet = new Set(existingDict.map(t => typeof t === "string" ? t : t.correct || t.wrong));
  for (const t of newTerms) {
    const word = t.correct || t.wrong;
    if (word && !existingSet.has(word)) {
      merged.push(word);
      existingSet.add(word);
    }
  }
  // 기존 {wrong, correct} 형태가 섞여 있으면 정답만 추출하여 문자열 배열로 정리
  return merged.map(t => typeof t === "string" ? t : t.correct || t.wrong).filter(Boolean);
}

// 확정된 용어의 correct 값을 단어장에 저장 + 서버 동기화
// ⚠️ 단어장은 "용어"만 저장 — 긴 문장/구절은 제외 (10자 초과 or 공백 2개 이상)
export async function updateDictionary(approvedTerms, config) {
  const dict = loadDictionary();
  const normalized = dict.map(t => typeof t === "string" ? t : t.correct || t.wrong).filter(Boolean);
  const existingSet = new Set(normalized);
  let added = 0;
  for (const t of approvedTerms) {
    const word = t.correct || (typeof t === "string" ? t : null);
    if (!word) continue;
    // 문장 조각은 단어장에 추가하지 않음
    const spaceCount = (word.match(/\s/g) || []).length;
    const JOSA_RE = /(?:을|를|이|가|은|는|에서|으로|에게|하고|되는|하는|있는|없는|같은|보는|갖다가|라는|인데)$/;
    if (spaceCount >= 2 || (word.length > 10 && spaceCount >= 1) || JOSA_RE.test(word)) {
      console.log(`📚 단어장 제외 (문장 조각): "${word.substring(0, 30)}"`);
      continue;
    }
    if (!existingSet.has(word)) {
      normalized.push(word);
      existingSet.add(word);
      added++;
    }
  }
  if (added > 0) await saveDictionaryToServer(normalized, config);
  return added;
}
