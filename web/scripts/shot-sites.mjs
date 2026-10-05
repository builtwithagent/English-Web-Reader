/**
 * 站点抽查：把一批真实英文站点在阅读器里逐个截图，并生成一张总览页。
 *
 * 和 shot.mjs 的分工：shot.mjs 是**固定场景的回归自检**（断言"必须怎样"），
 * 这个是**样本抽查**（观察"实际怎样"），不做断言，只如实记录。
 *
 * 用法：
 *   node scripts/shot-sites.mjs                # 跑内置的代表性样本
 *   node scripts/shot-sites.mjs --only=npr.org,techcrunch.com
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePage, clearPrevious, launchChrome, startDevStack, stamp } from './lib/cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(webRoot, '..');
const outDir = path.join(repoRoot, 'docs', 'design');

const NEST_PORT = 3000;
const VITE_PORT = 5173;
const SITE = `http://localhost:${VITE_PORT}`;
const DEBUG_PORT = 9334;
const VIEWPORT = { width: 1180, height: 1300 };

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

/**
 * 代表性样本：刻意覆盖"提取好 / 提取差 / 直接失败"三种情况，
 * 而不是只挑跑得通的 —— 只看好的一面看不出问题。
 */
const SAMPLES = [
  // —— 预期提取质量好：标准文章页 ——
  { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Introduction', note: '技术文档' },
  { url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html', note: '官方文档' },
  { url: 'https://react.dev/learn', note: '前端文档' },
  { url: 'https://www.anthropic.com/engineering/managed-agents', note: 'AI 长文（含插图）' },
  { url: 'https://www.scientificamerican.com/', note: '科普媒体' },
  // —— 预期有问题：首页 / 栏目页被当成文章 ——
  { url: 'https://techcrunch.com/', note: '科技媒体首页' },
  { url: 'https://www.npr.org/', note: '新闻首页' },
  { url: 'https://arxiv.org/abs/1706.03762', note: '论文摘要页' },
  { url: 'https://learn.microsoft.com/en-us/dotnet/csharp/tour-of-csharp/', note: '降级到启发式' },
  // —— 预期失败：网络层不通 ——
  { url: 'https://www.bbc.com/news', note: '网络不通（问外）' },
];

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

async function inspect(cdp) {
  return cdp.evalJson(`JSON.stringify((() => {
    const err = document.querySelector('.error-banner');
    const cells = [...document.querySelectorAll('.cell')];
    const firstTxt = cells.find(c => c.classList.contains('col-src'))?.innerText?.trim() ?? '';
    return {
      title: document.querySelector('.art-head h1')?.textContent?.slice(0, 90) ?? '',
      siteName: document.querySelector('.art-meta span')?.textContent ?? '',
      cells: cells.length,
      src: document.querySelectorAll('.col-src').length,
      dst: document.querySelectorAll('.col-dst').length,
      shared: document.querySelectorAll('.col-shared').length,
      mode: document.querySelector('.grid')?.dataset.mode ?? '',
      notice: document.querySelector('.notice')?.innerText?.trim().slice(0, 40) ?? '',
      error: err ? (err.querySelector('.title')?.textContent ?? '') + '｜' + (err.querySelector('.hint')?.textContent ?? '') : '',
      firstTxt: firstTxt.slice(0, 120),
      imgCount: document.querySelectorAll('.col-shared img').length,
      brokenImg: [...document.querySelectorAll('.col-shared img')].filter(i => i.complete && i.naturalWidth === 0).length,
    };
  })())`);
}

function buildSheet(rows, ts) {
  const cards = rows
    .map((r) => {
      const bad = !!r.info?.error;
      const thin = !bad && (r.info?.cells ?? 0) < 6;
      const tag = bad ? ['失败', 'bad'] : thin ? ['提取偏少', 'warn'] : ['正常', 'ok'];
      return `
  <figure class="card ${tag[1]}">
    <figcaption>
      <div class="head">
        <span class="tag ${tag[1]}">${tag[0]}</span>
        <b>${esc(r.host)}</b>
        <span class="note">${esc(r.note)}</span>
      </div>
      <div class="stats">${
        bad
          ? esc(r.info.error)
          : `块 ${r.info.cells}（原文 ${r.info.src} / 译文 ${r.info.dst} / 共享 ${r.info.shared}）` +
            (r.info.imgCount ? ` · 图 ${r.info.imgCount}${r.info.brokenImg ? `（${r.info.brokenImg} 张没加载出来）` : ''}` : '') +
            (r.info.notice ? ` · ${esc(r.info.notice)}` : '')
      }</div>
      <div class="title">${esc(r.info?.title || '（没有取到标题）')}</div>
      <div class="first">「${esc(r.info?.firstTxt || '')}」</div>
    </figcaption>
    <img src="design/${path.basename(r.file)}" alt="${esc(r.host)}" loading="lazy">
  </figure>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>英文站点抽查 · 阅读器实际效果</title>
<style>
  :root { --line:#e3e8ee; --ink:#1f2328; --soft:#57606a; --muted:#8c959f; }
  * { box-sizing:border-box; }
  body { margin:0; padding:28px 22px 60px; background:#f4f6f8; color:var(--ink);
         font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  h1 { font-size:20px; margin:0 0 6px; }
  .sub { color:var(--soft); margin:0 0 22px; font-size:13px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(430px,1fr)); gap:18px; }
  .card { margin:0; background:#fff; border:1px solid var(--line); border-radius:12px; overflow:hidden;
          box-shadow:0 1px 3px rgba(27,31,36,.05); }
  .card.bad { border-color:#ffc9c9; }
  .card.warn { border-color:#ffe0a3; }
  figcaption { padding:12px 14px 13px; }
  .head { display:flex; align-items:center; gap:8px; margin-bottom:7px; flex-wrap:wrap; }
  .head b { font-size:13.5px; }
  .note { color:var(--muted); font-size:12px; margin-left:auto; }
  .tag { font-size:11px; padding:1.5px 7px; border-radius:999px; border:1px solid; }
  .tag.ok { color:#1a7f37; border-color:#b7e0c0; background:#f0fbf3; }
  .tag.warn { color:#9a6700; border-color:#f0d999; background:#fff9e8; }
  .tag.bad { color:#c0392b; border-color:#ffc9c9; background:#fff5f5; }
  .stats { font-size:12px; color:var(--soft); margin-bottom:5px; }
  .title { font-size:12.5px; font-weight:600; margin-bottom:3px; }
  .first { font-size:12px; color:var(--muted); line-height:1.5; }
  .card img { display:block; width:100%; max-height:460px; object-fit:cover; object-position:top;
              border-top:1px solid var(--line); background:#fff; }
</style></head><body>
<h1>英文站点抽查 · 阅读器实际效果</h1>
<p class="sub">无头 Chrome 实拍，${ts} · 视口 ${VIEWPORT.width}px · 截图只显示页面上部，完整图见 docs/design/</p>
<div class="grid">${cards}</div>
</body></html>`;
}

async function main() {
  const only = argOf('only', '');
  const list = only ? SAMPLES.filter((s) => only.includes(new URL(s.url).hostname.replace(/^www\./, ''))) : SAMPLES;

  const stack = await startDevStack({ repoRoot, webRoot, nestPort: NEST_PORT, vitePort: VITE_PORT });
  let chrome = null;
  try {
    if (!stack.ok) {
      console.log(`${stack.reason === 'nest' ? 'Nest' : 'Vite'} 没起来。日志：\n${stack.logs.join('')}`);
      process.exitCode = 1;
      return;
    }

    console.log('启动无头 Chrome（CDP）…');
    chrome = await launchChrome({ debugPort: DEBUG_PORT });

    const removed = clearPrevious(outDir, '站点抽查-');
    if (removed) console.log(`清掉上一批抽查图 ${removed} 张`);

    mkdirSync(outDir, { recursive: true });
    const ts = stamp();
    const rows = [];

    for (const s of list) {
      const host = new URL(s.url).hostname.replace(/^www\./, '');
      const file = path.join(outDir, `站点抽查-${host}-${ts}.png`);
      process.stdout.write(`  → ${host} … `);

      const shot = await capturePage(chrome.cdp, {
        url: `${SITE}/?url=${encodeURIComponent(s.url)}`,
        outFile: file,
        viewport: VIEWPORT,
      });

      // 失败也要留下记录：错误页本身就是要观察的对象
      const info = shot.ok ? await inspect(chrome.cdp) : { error: `没等到页面就绪：${String(shot.detail).slice(0, 80)}` };
      rows.push({ host, note: s.note, file, info });
      console.log(info?.error ? `✗ ${info.error.slice(0, 46)}` : `✓ ${info.cells} 块`);
    }

    const sheet = path.join(repoRoot, 'docs', `站点抽查-${ts}.html`);
    writeFileSync(sheet, buildSheet(rows, ts));

    console.log('\n── 汇总 ──────────────────────────────');
    for (const r of rows) {
      const bad = !!r.info?.error;
      console.log(`  ${bad ? '✗' : (r.info.cells < 6 ? '?' : '✓')} ${r.host.padEnd(24)} ${bad ? r.info.error.slice(0, 52) : `${r.info.cells} 块 / 原 ${r.info.src} 译 ${r.info.dst} 共享 ${r.info.shared}`}`);
    }
    console.log(`\n总览页：${path.relative(repoRoot, sheet)}`);
  } finally {
    if (chrome) chrome.child.kill();
    stack.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
