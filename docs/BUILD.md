# 프론트엔드 빌드 가이드 (TEST 전용)

> **이 리포는 TEST 환경 (`ttimes-editor`) 용입니다.** PROD 용 설정 (editor 리포) 와 혼동하지 마세요.

## 빌드 위치
**반드시 이 디렉터리(`docs/`)에서만 빌드합니다.**

- GitHub Pages 가 `docs/` 루트를 서빙하므로, 여기서 빌드한 `assets/*.js` 와 `index.html` 이 곧 TEST 배포 산출물입니다.
- 배포처: `https://ttimesvibe.github.io/ttimes-editor/`
- 임시 빌드 디렉터리(예: `%TEMP%/service-build/`)에서 빌드하지 마세요 — 과거 PROD 에서 같은 경로의 drift 사고로 KV 오염 발생 이력 있음.

## 빌드 명령
```bash
cd docs
npm install     # 최초 1회
npm run build   # node build.js
```

## build.js 동작
1. **Prebuild drift guard** — `src/utils/config.js` 의 `workerUrl` 이 canonical (`https://editor.ttimes.workers.dev`) 과 일치하는지 검사.
2. `index.html` 의 `<script src>` 를 dev entry(`/src/main.jsx`)로 교체.
3. `vite build` 실행.
4. `dist/assets/*` → `docs/assets/`, `dist/index.html` → `docs/index.html` 복사.
5. **Stale 번들 자동 purge** — `index.html` 이 참조하지 않는 `assets/*.js` 삭제.
6. **Postbuild drift guard** — 번들 JS 에 `FORBIDDEN_WORKER_URLS` (PROD URL) 잔존 시 실패.

## 환경별 URL

| | TEST (이 리포) | PROD (editor 리포) |
|---|---|---|
| Worker URL | `https://editor.ttimes.workers.dev` | `https://alleditor.ttimes6000.workers.dev` |
| Cloudflare Account | `ttimesvibe` (fb0a1086...) | `ttimes6000` (d556c524...) |
| KV | `9e4f5bb9...` (editor-sessions) | `2892f3a4...` (editor-session) |
| GitHub Pages | `ttimesvibe.github.io/ttimes-editor/` | `ttimesvibe.github.io/editor/` |

**TEST 리포의 config·build.js·wrangler.toml 에는 TEST 값만 박혀야 합니다.** PROD 값 발견 시 빌드 실패.

## 배포
```bash
git add docs/assets docs/index.html docs/src/utils/config.js
git commit -m "..."
git push origin main
```
⚠️ **`origin` (ttimes-editor) 로만 push**. `editor` (PROD) 리모트로는 **절대 push 금지**.

GitHub Pages 가 1~2 분 내 반영.
