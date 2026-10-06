/**
 * 批量探测：把 docs/站点抽查/英文站点样本.txt 里的 URL 逐个送进 /api/article，
 * 记录**真实**的抓取与提取结果。
 *
 * 这个脚本不猜"某某站点大概行不行"——全部实测，可达性、语言判定、
 * 提取层级、块数都从响应里读。
 *
 * 产物统一落在 docs/站点抽查/ 下（清单、报告、原始数据、截图都在那儿）。
 *
 * 用法：
 *   node scripts/probe-sites.mjs                    # 全部
 *   node scripts/probe-sites.mjs --section=A        # 只跑 A 组
 *   node scripts/probe-sites.mjs --concurrency=8    # 调并发（默认 6）
 *   node scripts/probe-sites.mjs --base=http://127.0.0.1:3000
 *
 * 需要后端已在跑（cd server && node dist/main.js）。
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(repoRoot, 'docs', '站点抽查');
const LIST_FILE = path.join(OUT_DIR, '英文站点样本.txt');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const BASE = argOf('base', 'http://127.0.0.1:3000');
const CONCURRENCY = Number(argOf('concurrency', '6'));
const SECTION = argOf('section', '');
// 后端自己的全程超时是 25s，客户端给宽一点，好在超时上分辨"后端超时"和"客户端先放弃"
const CLIENT_TIMEOUT_MS = 35_000;

// ============================================================================
// 解析清单
// ============================================================================

function parseList(text) {
  const items = [];
  let section = { key: '?', title: '未分组' };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const head = line.match(/^##\s*──\s*([A-Z])\.\s*(.+?)\s*─+$/);
    if (head) {
      section = { key: head[1], title: head[2] };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!/^https?:\/\//i.test(line)) continue;

    items.push({ url: line, section: section.key, sectionTitle: section.title });
  }
  return items;
}

// ============================================================================
// 探测单个站点
// ============================================================================

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

async function probe(item) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLIENT_TIMEOUT_MS);

  const out = {
    url: item.url,
    host: hostOf(item.url),
    section: item.section,
    sectionTitle: item.sectionTitle,
    httpStatus: null,
    ms: 0,
    ok: false,
    error: null,
    article: null,
  };

  try {
    const res = await fetch(`${BASE}/api/article?url=${encodeURIComponent(item.url)}`, {
      signal: ctrl.signal,
    });
    out.httpStatus = res.status;
    const body = await res.json();

    if (body?.error) {
      out.error = body.error;
    } else {
      out.ok = true;
      out.article = {
        finalUrl: body.finalUrl,
        title: body.title ?? '',
        siteName: body.siteName ?? '',
        byline: body.byline ?? null,
        lang: body.lang,
        isEnglish: body.isEnglish,
        extractLevel: body.extractLevel,
        truncated: body.truncated,
        blocks: body.blocks?.length ?? 0,
        translatable: (body.blocks ?? []).filter((b) => b.translatable).length,
        types: (body.blocks ?? []).reduce((acc, b) => {
          acc[b.type] = (acc[b.type] ?? 0) + 1;
          return acc;
        }, {}),
        chars: (body.blocks ?? []).reduce(
          (n, b) => n + (b.text?.length ?? 0) + (b.items ?? []).join('').length,
          0,
        ),
        // 正文里的第一个非空文本块，用来肉眼判断"抓到的到底是不是正文"
        firstText: (body.blocks ?? []).find((b) => b.text)?.text?.slice(0, 80) ?? '',
      };
    }
  } catch (err) {
    out.error = {
      code: err.name === 'AbortError' ? 'client_timeout' : 'client_network_error',
      message: err.name === 'AbortError' ? `本机请求超过 ${CLIENT_TIMEOUT_MS / 1000}s` : err.message,
    };
  } finally {
    clearTimeout(timer);
    out.ms = Date.now() - started;
  }

  return out;
}

/** 成功但结果可疑 —— 这些才是真正要看的（跑通了不代表跑对了） */
function suspicion(r) {
  const notes = [];
  if (!r.ok) return notes;
  const a = r.article;
  if (a.blocks === 0) notes.push('零块');
  else if (a.blocks < 5) notes.push(`块数极少(${a.blocks})`);
  if (!a.title) notes.push('无标题');
  if (!a.isEnglish) notes.push(`判为非英文(${a.lang})`);
  if (a.extractLevel !== 'readability') notes.push(`降级到 ${a.extractLevel}`);
  if (a.truncated) notes.push('内容被截断');
  if (a.chars < 800) notes.push(`正文极短(${a.chars}字)`);
  return notes;
}

function fmtMs(ms) {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${String(ms).padStart(4)}ms`;
}

function bar(frac, width = 16) {
  const n = Math.round(frac * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  const all = parseList(readFileSync(LIST_FILE, 'utf8'));
  const items = SECTION ? all.filter((i) => i.section.toUpperCase() === SECTION.toUpperCase()) : all;

  if (!items.length) {
    console.error(`清单里没读到 URL（${LIST_FILE}）`);
    process.exitCode = 1;
    return;
  }

  // 先确认后端在跑，别跑到一半才发现
  try {
    const ping = await fetch(`${BASE}/api/article?url=x`);
    await ping.json();
  } catch {
    console.error(`后端没响应（${BASE}）。先在 server 目录跑：node dist/main.js`);
    process.exitCode = 1;
    return;
  }

  console.log(`探测 ${items.length} 个站点  →  ${BASE}`);
  console.log(`并发 ${CONCURRENCY}，单站客户端超时 ${CLIENT_TIMEOUT_MS / 1000}s\n`);

  const results = [];
  let cursor = 0;
  const done = [];

  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      const r = await probe(item);
      results.push(r);
      const mark = r.ok ? (suspicion(r).length ? '?' : '✓') : '✗';
      done.push(`${mark} ${r.host}`);
      process.stdout.write(
        `\r  ${String(results.length).padStart(2)}/${items.length}  ${mark} ${r.host.padEnd(28).slice(0, 28)}`,
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  process.stdout.write('\r' + ' '.repeat(70) + '\r');

  // ---- 明细 ----
  const bySection = new Map();
  for (const r of results) {
    if (!bySection.has(r.section)) bySection.set(r.section, []);
    bySection.get(r.section).push(r);
  }

  for (const [key, list] of [...bySection.entries()].sort()) {
    console.log(`\n── ${key}. ${list[0].sectionTitle} ${'─'.repeat(Math.max(0, 46 - list[0].sectionTitle.length * 2))}`);
    for (const r of list.sort((a, b) => a.host.localeCompare(b.host))) {
      if (r.ok) {
        const a = r.article;
        const sus = suspicion(r);
        const mark = sus.length ? '?' : '✓';
        const level = a.extractLevel === 'readability' ? 'R' : a.extractLevel === 'heuristic' ? 'H' : 'B';
        console.log(
          `  ${mark} ${r.host.padEnd(26).slice(0, 26)} ${(a.isEnglish ? a.lang : `[${a.lang}]`).padEnd(9)} ` +
            `${level} ${String(a.blocks).padStart(3)}块 ${String(a.chars).padStart(6)}字 ${fmtMs(r.ms).padStart(7)}` +
            (sus.length ? `  ← ${sus.join('，')}` : ''),
        );
        console.log(`      「${a.firstText.slice(0, 62)}」`);
      } else {
        console.log(
          `  ✗ ${r.host.padEnd(26).slice(0, 26)} ${''.padEnd(9)}   ${''.padStart(3)}块 ${''.padStart(6)}字 ${fmtMs(r.ms).padStart(7)}` +
            `  ← ${r.error.code}`,
        );
        console.log(`      ${r.error.message}`);
      }
    }
  }

  // ---- 汇总 ----
  const okList = results.filter((r) => r.ok);
  const failList = results.filter((r) => !r.ok);
  const susList = okList.filter((r) => suspicion(r).length);

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`结果：${okList.length}/${results.length} 抓取成功，其中 ${susList.length} 个结果可疑`);
  console.log(`      ${bar(okList.length / results.length)}  ${Math.round((okList.length / results.length) * 100)}%`);

  if (failList.length) {
    const byCode = new Map();
    for (const r of failList) byCode.set(r.error.code, (byCode.get(r.error.code) ?? 0) + 1);
    console.log(`\n失败分类：`);
    for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(2)} × ${code}`);
    }
  }

  // 平均耗时只看成功的，失败里混着超时会失真
  if (okList.length) {
    const avg = okList.reduce((n, r) => n + r.ms, 0) / okList.length;
    const slowest = [...okList].sort((a, b) => b.ms - a.ms).slice(0, 3);
    console.log(`\n成功请求耗时：平均 ${fmtMs(Math.round(avg))}，最慢 ${slowest.map((r) => `${r.host} ${fmtMs(r.ms)}`).join('、')}`);
  }

  const levels = okList.reduce((acc, r) => {
    acc[r.article.extractLevel] = (acc[r.article.extractLevel] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`提取层级分布：${Object.entries(levels).map(([k, v]) => `${k}=${v}`).join('  ') || '（无）'}`);

  if (susList.length) {
    console.log(`\n可疑清单（跑通了，但结果未必对）：`);
    for (const r of susList) console.log(`  · ${r.host.padEnd(26)} ${suspicion(r).join('，')}`);
  }

  // ---- 落盘 ----
  const ts = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  })();
  mkdirSync(OUT_DIR, { recursive: true });
  // 每跑一次丢一个 JSON，不做清理会一版一版堆下去。
  // 文件名仍带时间戳，只是开跑前把上一批删掉；删除范围严格限定在本脚本自己的产物前缀上。
  //
  // **按范围分档**：只跑某一组（--section=A）时产物叫「探测结果-A组-*.json」，
  // 清理也只清同档的。否则跑一次单组就会把全量基线一起删掉 —— 这个坑刚踩过。
  const scope = SECTION ? `${SECTION.toUpperCase()}组` : '全部';
  for (const f of readdirSync(OUT_DIR)) {
    if (f.startsWith(`探测结果-${scope}-`) && f.endsWith('.json')) rmSync(path.join(OUT_DIR, f));
  }
  const outFile = path.join(OUT_DIR, `探测结果-${scope}-${ts}.json`);
  writeFileSync(outFile, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
  console.log(`\n原始结果：${path.relative(repoRoot, outFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
