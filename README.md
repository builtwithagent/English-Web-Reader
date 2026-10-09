# English Web Reader

**Read English web pages bilingually.** Paste a URL, get a clean two-column reading view — original on the left, translation on the right, aligned block by block in real time.

![Pasting an English article URL, then watching it open as a two-column reading view with the Chinese translation filling in block by block](docs/demo.gif)

---

## Getting started

Requires **Node 22+**.

### 1. Backend

```bash
cd server
npm install
cp .env.example .env        # then set LLM_API_KEY
npm run build
npm start                   # http://localhost:3000
```

### 2. Frontend

```bash
cd web
npm install
npm run dev                 # http://localhost:5173
```

### 3. Production (single port)

```bash
npm run build               # installs and builds both packages
npm start                   # one process serves the page and the API
```

The server hosts `web/dist` itself, so `/api/...` stays same-origin and there is no CORS to configure. Static hosting is only mounted when `web/dist/index.html` exists — otherwise an unknown `/api/...` path would fall back to an HTML page instead of clean JSON.

### Configuration

All backend configuration lives in `server/.env`. The upstream is addressed with **vendor-neutral names** on purpose — switching providers means changing values, not code:

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | Injected by the deploy sandbox in production |
| `LLM_API_KEY` | **yes** | — | Server-side only; never reaches the frontend, logs or error messages |
| `LLM_BASE_URL` | no | `https://open.bigmodel.cn/api/paas/v4` | The trailing `/v4` is required — the client appends `/chat/completions` |
| `LLM_MODEL` | no | `glm-4-flash` | Upstream model names change without changelog entries; check the provider's docs |
| `LLM_TIMEOUT_MS` | no | `30000` | Per-block timeout |
| `STATS_PASSWORD` | no | — | Turns on `GET /api/stats`, the JSON behind the `/stats` dashboard. Leaving it empty keeps that endpoint **off** (503), not unprotected. It doubles as the dashboard's own login |
| `STATS_USER` | no | `admin` | Only used by the `Authorization: Basic` path; the dashboard itself asks for the password alone |

Without a key the translation endpoint refuses at the door; fetching, reading and exporting keep working.

`/stats` is a client-side route served by the same bundle, reading its data from `/api/stats`. It is deliberately not linked from anywhere in the UI. It counts page views, fetches and translation volume per day, and never stores raw IPs or user agents — only a per-day salted hash, so visitor counts cannot be traced back to a person.

Two things it **does** store verbatim, because the dashboard is useless without them: the **full URL** of every page you fetch or translate (query string included, fragment dropped), and for each failed fetch a small entry with the URL, the error code and the timestamp — that's what answers "which four pages failed, and why". Both live only in the local `server/data/stats.json`, behind the password.

The dashboard asks for that password itself and sends it in an `X-Stats-Key` header — deliberately not `Authorization`, which some deploy gateways overwrite with a token of their own. It is kept in the tab's `sessionStorage` (or supplied once as `/stats?key=…`), and it travels in cleartext on every request, so only enable it behind HTTPS.

> Both packages ship an `.npmrc` pointing at a China-based npm mirror. Delete those files if you're building from outside China.

## Testing

Testing is split into three layers on purpose, each answering a different question:

```bash
# 1. Offline logic — fast, no network, no LLM quota
cd server && npm test        # 262 checks
cd web    && npm test        # 138 checks

# 2. Real network, real articles — "does the whole chain actually work"
cd server && npm run smoke             # fetch / extract / language / SSRF, 16 checks
cd server && npm run verify:translate  # end-to-end translation, 47 checks

# 3. Real rendering — "does the page actually look right"
cd web && npm run shot                 # 4 scenarios, screenshots + DOM assertions
```

The integration scripts run against a **local mock upstream** (`server/scripts/mock-llm.mjs`) rather than a live provider, so they are deterministic, offline, and free. The mock turns phrases into triggers (`__429__`, `__500__`, `__SLOW__`, …) so error paths can be asserted too.

`npm run shot` drives a headless Chrome over the DevTools Protocol: it starts both services, waits for translation to actually settle, then asserts alignment, the shared-block layout, the export round-trip and preference persistence. It is the only layer that can catch "the data is right but the page is wrong".

## Known limitations

- **Translation quality has not been evaluated by a human yet.** The pipeline is verified; the output is not.
- **Landing and category pages extract poorly.** The pipeline handles articles and documentation well, but a site's front page tends to come out as a short, plausible-looking fake article. A field probe of 72 real sites put success at 32/72, with the misses dominated by network reachability and anti-bot responses rather than extraction — and the poor results clustered on page *type*, not on site.
- **What the server can fetch depends on where it runs.** The probe was run from a mainland-China host, where most international news sites are unreachable. Re-run it from wherever you deploy.

## License

No license has been chosen yet. Until one is, the code is under default copyright — please open an issue rather than assume permission.
