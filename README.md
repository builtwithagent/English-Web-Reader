# English Web Reader

**Read English web pages bilingually.** Paste a URL, get a clean two-column reading view — original on the left, translation on the right, aligned block by block in real time.

Also known as 英文网页阅读器.

---

## The idea

Most "translate this page" tools treat language as a free variable: whatever the page is in, translate it into whatever you want. That design has two problems — it produces a lot of bad translations nobody asked for, and it hides the fact that the translation may not be trustworthy.

This project takes a narrower, more honest position:

- **The source language is locked to English.** That is the entire product. No "translate any language to any language".
- **There are 10 target languages**, with Simplified Chinese as the default. English is deliberately *not* in the list.
- **Non-English pages are not translated at all.** They degrade to a single-column original view with a short notice. This is not an error state — it costs nothing, sends zero upstream requests, and never changes your saved preferences.

Locking one axis is what makes the other axis good.

## Features

- **Block-level streaming translation.** The article is split into blocks before translation starts, so the first paragraphs appear in seconds while the rest are still in flight.
- **Genuinely aligned columns.** Alignment comes from layout, not from runtime synchronisation — no second scrollbar, no drift.
- **Three-level content extraction.** A purpose-built pipeline rather than "throw the HTML at a library".
- **Markdown export** in the current display mode, ready to keep or republish.
- **Display modes**: side-by-side, translation only, original only.
- **No account required.** Reading, translating and exporting need no signup and no database.
- **SSRF-hardened fetcher**, because the server fetches arbitrary URLs on your behalf.

## How it works

```
   URL
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 1. Fetch        redirect-by-redirect validation, protocol and │
│                 port allowlist, body size cap, timeouts, and  │
│                 a custom DNS lookup so the IP that was        │
│                 validated is the IP actually connected to     │
├───────────────────────────────────────────────────────────────┤
│ 2. Extract      Readability → heuristic container (selector + │
│                 text density) → <body> fallback. Output is a  │
│                 flat list of blocks with stable ids and a     │
│                 `translatable` flag                           │
├───────────────────────────────────────────────────────────────┤
│ 3. Detect       Character-script statistics over the body     │
│                 text, code blocks excluded. <html lang> is    │
│                 never trusted                                 │
├───────────────────────────────────────────────────────────────┤
│ 4. Translate    The whole block list is POSTed to the         │
│                 translation endpoint, which streams results   │
│                 back over SSE as they complete                │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
  Two-column reading view, filled in block by block
```

### Two decisions worth knowing about

**Translation happens on the server, not in the browser.** One Node service owns both fetch and translate. The alternative — a browser-side LLM channel — would split the pipeline into two halves with different failure modes and different security properties, and would put your API key in a place you cannot control.

**Blocks come back out of order.** Translation is concurrent, so results arrive as they finish: block 7 may land before block 5. The protocol carries an `id` on every message and the client re-keys on it, so `#7` fills slot 7 and nothing shifts. This is why the wire format is a stream of tagged blocks rather than a translated array.

## Tech stack

| Layer | Choice |
| --- | --- |
| Backend | Node 22 · NestJS 12 · TypeScript 7 |
| Frontend | React 19 · Vite 8 · TypeScript 7 |
| Extraction | `@mozilla/readability` + `jsdom`, with two fallback levels |
| Translation transport | Server-Sent Events, hand-written (see note below) |
| LLM upstream | Any OpenAI-compatible endpoint |
| Tests | Vitest 5 (offline) + three real-network assertion scripts |

`@Sse()` from Nest deliberately isn't used: it only supports `GET`, and the request body carries the whole block list, so the endpoint has to be a `POST`. The SSE framing is written by hand instead.

## Getting started

Requires **Node 22+**. No database, no cloud account.

### 1. Backend

```bash
cd server
npm install
cp .env.example .env        # then set LLM_API_KEY
npm run build
npm start                   # http://localhost:3000
```

### 2. Frontend

In a second terminal:

```bash
cd web
npm install
npm run dev                 # http://localhost:5173
```

Open **http://localhost:5173** — use `localhost`, not `127.0.0.1`: Vite binds to the IPv6 loopback by default. During development Vite proxies `/api/*` to the backend, so the frontend only ever calls same-origin relative paths.

For a quick look without pasting anything, append `?url=https://…` to go straight into the reading view.

### Configuration

All backend configuration lives in `server/.env`. The upstream is addressed with **vendor-neutral names** on purpose — switching providers means changing values, not code:

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | Injected by the deploy sandbox in production |
| `LLM_API_KEY` | **yes** | — | Server-side only; never reaches the frontend, logs or error messages |
| `LLM_BASE_URL` | no | `https://open.bigmodel.cn/api/paas/v4` | The trailing `/v4` is required — the client appends `/chat/completions` |
| `LLM_MODEL` | no | `glm-4-flash` | Upstream model names change without changelog entries; check the provider's docs |
| `LLM_TIMEOUT_MS` | no | `30000` | Per-block timeout |

Without a key the translation endpoint refuses at the door; fetching, reading and exporting keep working.

> Both packages ship an `.npmrc` pointing at a China-based npm mirror. Delete those two files if you're building from outside China.

## Testing

Testing is split into three layers on purpose, each answering a different question:

```bash
# 1. Offline logic — fast, no network, no LLM quota
cd server && npm test        # 197 checks
cd web    && npm test        # 114 checks

# 2. Real network, real articles — "does the whole chain actually work"
cd server && npm run smoke             # fetch / extract / language / SSRF, 16 checks
cd server && npm run verify:translate  # end-to-end translation, 47 checks

# 3. Real rendering — "does the page actually look right"
cd web && npm run shot                 # 4 scenarios, screenshots + DOM assertions
```

The integration scripts run against a **local mock upstream** (`server/scripts/mock-llm.mjs`) rather than a live provider, so they are deterministic, offline, and free. The mock turns phrases into triggers (`__429__`, `__500__`, `__SLOW__`, …) so error paths can be asserted too.

`npm run shot` drives a headless Chrome over the DevTools Protocol: it starts both services, waits for translation to actually settle, then asserts alignment, the shared-block layout, the export round-trip and preference persistence. It is the only layer that can catch "the data is right but the page is wrong".

## Project layout

```
server/                  NestJS service
  src/article/           fetch · extract · language detection
  src/translate/         streaming client · concurrency · SSE endpoint
  src/common/            error contract · SSRF guards · language rules
  scripts/               smoke · verify-translate · mock upstream · site probe
  test/                  Vitest
web/                     React + Vite client
  src/components/        reading view · toolbar · language selector
  src/hooks/             useArticle · useTranslation · usePreferences
  src/styles/            one stylesheet, theme-variable driven
  scripts/               CDP-driven visual checks
docs/                    PRD and technical design (Chinese)
```

## Status

Working end to end: fetch → extract → detect → translate → read → export.

- [x] Fetch with SSRF protection and a three-level extraction fallback
- [x] Language detection that doesn't trust the page's own metadata
- [x] Streaming translation, concurrent, fault-isolated per block
- [x] Two-column / single-column / degraded reading views
- [x] Markdown export and persistent preferences
- [x] 311 offline tests plus three real-network assertion layers
- [ ] Copy translation to clipboard
- [ ] Print / save as PDF
- [ ] Cross-user translation cache
- [ ] Deployment behind a single origin
- [ ] Accounts and a bookshelf

### Known limitations

- **Translation quality has not been evaluated by a human yet.** The pipeline is verified; the output is not.
- **Landing and category pages extract poorly.** The pipeline handles articles and documentation well, but a site's front page tends to come out as a short, plausible-looking fake article. A field probe of 72 real sites put success at 32/72, with the misses dominated by network reachability and anti-bot responses rather than extraction — and the poor results clustered on page *type*, not on site.
- **What the server can fetch depends on where it runs.** The probe was run from a mainland-China host, where most international news sites are unreachable. Re-run it from wherever you deploy.

## Documentation

`docs/` holds the product requirements and the technical design, both in Chinese:

- `docs/英文网页阅读器-PRD.md` — what it does, what it deliberately doesn't, account boundaries, degradation rules
- `docs/英文网页阅读器-技术方案.md` — architecture, protocols, error contract, the reasoning behind the trade-offs, and the limitations above in detail
- `docs/design/前端设计稿-*.html`, `docs/站点抽查/` — interactive design mockups and the 72-site probe snapshot

## License

No license has been chosen yet. Until one is, the code is under default copyright — please open an issue rather than assume permission.
