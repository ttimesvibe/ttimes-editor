# ttimes-editor

ttimes-doctor의 테스트/업그레이드 버전.  
프론트엔드(GitHub Pages)와 백엔드(Cloudflare Worker)를 독립 배포.

## 구조

```
ttimes-editor/
├── frontend/          ← GitHub Pages 배포
│   ├── index.html
│   ├── src/App.jsx    ← React 소스 (참조용, 빌드는 별도)
│   └── assets/        ← Vite 빌드 결과물
├── worker/            ← Cloudflare Worker 배포
│   ├── index.js       ← Worker 메인 코드
│   └── wrangler.toml  ← Worker 설정
└── README.md
```

## 배포 방법

### 프론트엔드 (GitHub Pages)

`frontend/` 내용이 GitHub Pages로 자동 배포됨.  
레포 Settings → Pages → Source: `main` 브랜치, `/frontend` 폴더 선택.

URL: `https://ttimesvibe.github.io/ttimes-editor/`

### 백엔드 (Cloudflare Worker)

```bash
cd worker

# 1) KV 네임스페이스 생성
wrangler kv:namespace create SESSIONS
# → 출력된 id를 wrangler.toml에 입력

# 2) API 키 설정
wrangler secret put OPENAI_API_KEY
wrangler secret put GEMINI_API_KEY

# 3) 배포
wrangler deploy
```

Worker URL: `https://ttimes-editor.<account>.workers.dev`

### 프론트엔드에서 Worker URL 변경

프론트엔드의 설정(⚙️)에서 Worker URL을 새 Worker 주소로 변경하면 됨.  
또는 `src/App.jsx`의 `DEFAULT_CONFIG.workerUrl`을 수정 후 재빌드.

## 환경 변수 (Secrets)

| 이름 | 용도 |
|------|------|
| OPENAI_API_KEY | GPT API 호출 (교정, 자막 등) |
| GEMINI_API_KEY | Gemini 호출 (편집가이드) |

## KV 바인딩

| 바인딩 | 용도 |
|--------|------|
| SESSIONS | 세션 저장/불러오기, 팀 공유 단어장 |
