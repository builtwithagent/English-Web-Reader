/**
 * M2 预览自检。
 *
 * 起 Nest(3000) + Vite(5173)，用无头 Chrome 截三个场景的图：
 *   - 英文页面     → 双栏对照
 *   - 非英文页面   → 单栏降级 + 说明条
 *   - 带插图的页面 → 跨栏块不被中缝竖线劈开
 * 顺带验证 Vite 的 /api 代理在真实链路里是通的（前后端唯一的联调点）。
 *
 * 截图与 CDP 那套在 scripts/lib/cdp.mjs，这里只留"断言什么"。
 *
 * 用法：node scripts/shot.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  capturePage,
  clearPrevious,
  launchChrome,
  startDevStack,
  stamp,
} from './lib/cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(webRoot, '..');
const outDir = path.join(repoRoot, 'docs', 'design');

const NEST_PORT = 3000;
const VITE_PORT = 5173;
// 用 localhost 而不是 127.0.0.1：Vite 默认绑 localhost，
// 在 Windows 上它常解析到 IPv6 的 ::1，写死 127.0.0.1 会连不上。
const SITE = `http://localhost:${VITE_PORT}`;
const DEBUG_PORT = 9333;
const VIEWPORT = { width: 1440, height: 1400 };

const MDN = 'https://developer.mozilla.org';
const CASES = [
  { name: '英文双栏', url: `${MDN}/en-US/docs/Web/JavaScript/Guide/Introduction` },
  { name: '中文降级单栏', url: `${MDN}/zh-CN/docs/Web/JavaScript/Guide/Introduction` },
  // 这篇有 4 张插图（架构图 / 表格图），是"跨栏块会不会被中缝竖线劈开"的现场。
  // 截图定格到第一张图上 —— 否则图在首屏之外，截出来什么都看不到。
  {
    name: '图片跨栏',
    url: 'https://www.anthropic.com/engineering/managed-agents',
    focus: '.col-shared[data-type="img"]',
  },
];

/** 把页面的实测状态取回来（经 JSON 字符串往返 —— CDP 对复杂返回值的序列化有限制） */
async function measure(cdp) {
  const meta = await cdp.evalJson(`JSON.stringify({
    langs: document.querySelectorAll('.lang-pair option').length,
    cells: document.querySelectorAll('.cell').length,
    src: document.querySelectorAll('.col-src').length,
    dst: document.querySelectorAll('.col-dst').length,
    shared: document.querySelectorAll('.col-shared').length,
    modeSwitch: !!document.querySelector('.mode-seg'),
    notice: !!document.querySelector('.notice'),
    gridMode: document.querySelector('.grid')?.dataset.mode,
    title: document.querySelector('.art-head h1')?.textContent?.slice(0, 60),
    // 第 1 行的**类型**是导语有没有丢的判据（见下面 checks 的注释）
    firstType: document.querySelector('.cell[data-row="1"]')?.dataset.type,
    firstText: document.querySelector('.cell[data-row="1"]')?.innerText?.trim().slice(0, 40),
  })`);

  // 对齐验证（技术方案 7.4）：同一行的原文块与译文块必须 top 相同、高度相同。
  // 这是"滚动天然同步"成立的前提 —— 左右根本不存在两个滚动条。
  const align = await cdp.evalJson(`JSON.stringify((() => {
    const rows = new Map();
    for (const el of document.querySelectorAll('.cell')) {
      const side = el.classList.contains('col-src') ? 'src'
                 : el.classList.contains('col-dst') ? 'dst' : null;
      if (!side) continue;
      const r = el.getBoundingClientRect();
      if (!rows.has(el.dataset.row)) rows.set(el.dataset.row, {});
      rows.get(el.dataset.row)[side] = { top: Math.round(r.top), h: Math.round(r.height) };
    }
    let pairs = 0, badTop = 0, badH = 0;
    const examples = [];
    for (const [id, v] of rows) {
      if (!v.src || !v.dst) continue;
      pairs++;
      if (Math.abs(v.src.top - v.dst.top) > 1) {
        badTop++;
        if (examples.length < 3) examples.push(id + ':top ' + v.src.top + ' vs ' + v.dst.top);
      }
      if (Math.abs(v.src.h - v.dst.h) > 1) {
        badH++;
        if (examples.length < 3) examples.push(id + ':h ' + v.src.h + ' vs ' + v.dst.h);
      }
    }
    return { pairs, badTop, badH, examples };
  })())`);

  // 跨栏块（图片 / 代码）必须盖住中缝那条竖线（见 index.css 里 .cell.col-shared 的注释）。
  // 竖线是 .pane-divider::after，绝对定位、left:50%；网格无 padding/border，
  // 所以它的 x 就是网格宽度的一半。三条判据缺一不可：
  // 横向要盖过中缝、底色要不透明、层级要高于竖线 —— 少任何一条线都会重新压到图上。
  const sharedMask = await cdp.evalJson(`JSON.stringify((() => {
    const grid = document.querySelector('.grid');
    if (!grid) return { total: 0, bad: [], kinds: [] };
    const gr = grid.getBoundingClientRect();
    const midX = gr.left + gr.width / 2;
    const cells = [...document.querySelectorAll('.cell.col-shared')];
    const bad = [];
    const kinds = [];
    for (const el of cells) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const kind = el.dataset.type;
      kinds.push(kind);
      if (!(r.left <= midX && midX <= r.right)) { bad.push(kind + ' 未跨过中缝'); continue; }
      if (!/^rgb\\(/.test(cs.backgroundColor)) { bad.push(kind + ' 底色透明(' + cs.backgroundColor + ')'); continue; }
      if (!(parseInt(cs.zIndex, 10) > 0)) { bad.push(kind + ' 层级不高于竖线(z=' + cs.zIndex + ')'); }
    }
    return { total: cells.length, bad, kinds };
  })())`);

  return { meta, align, sharedMask };
}

async function main() {
  const stack = await startDevStack({
    repoRoot,
    webRoot,
    nestPort: NEST_PORT,
    vitePort: VITE_PORT,
  });

  let chrome = null;
  try {
    if (!stack.ok) {
      console.log('服务没起来，日志：');
      console.log(stack.logs.join('').slice(-2500));
      process.exitCode = 1;
      return;
    }

    // ---- 联调点：Vite 的 /api 代理能不能打到 Nest ----
    const probe = await fetch(`${SITE}/api/article?url=${encodeURIComponent('not a url')}`);
    const probeBody = await probe.json().catch(() => null);
    const proxyOk = probeBody?.error?.code === 'invalid_url';
    console.log(`${proxyOk ? '✓' : '✗'} /api 代理  →  ${probe.status} ${probeBody?.error?.code ?? '(无响应体)'}`);
    if (!proxyOk) {
      process.exitCode = 1;
      return;
    }

    console.log('启动无头 Chrome（CDP）…');
    chrome = await launchChrome({ debugPort: DEBUG_PORT });

    const removed = clearPrevious(outDir, '实现预览-');
    if (removed) console.log(`清掉上一批预览图 ${removed} 张`);

    const ts = stamp();
    let failed = 0;

    for (const c of CASES) {
      const out = path.join(outDir, `实现预览-${c.name}-${ts}.png`);
      const pageUrl = `${SITE}/?url=${encodeURIComponent(c.url)}`;
      const shot = await capturePage(chrome.cdp, {
        url: pageUrl,
        outFile: out,
        viewport: VIEWPORT,
        focus: c.focus,
      });

      if (!shot.ok) {
        console.log(`✗ ${c.name}：没等到阅读态。页面当时显示：${shot.detail}`);
        failed++;
        continue;
      }

      const { meta: m, align: a, sharedMask: s } = await measure(chrome.cdp);
      if (!m || !a || !s) {
        console.log(`✗ ${c.name}：页面状态读不回来`);
        failed++;
        continue;
      }

      const degraded = c.name.includes('降级');
      const checks = [
        ['语言选项 10 项', m.langs === 10],
        ['块已渲染', m.cells > 0],
        degraded ? ['未渲染译文列', m.dst === 0] : ['译文列已渲染', m.dst > 0],
        degraded ? ['隐藏模式切换', m.modeSwitch === false] : ['显示模式切换', m.modeSwitch === true],
        degraded ? ['显示降级说明条', m.notice === true] : ['无说明条', m.notice === false],
        degraded ? ['单栏模式', m.gridMode === 'src'] : ['双栏模式', m.gridMode === 'both'],
        // Readability 会把页面**导语**当 excerpt 摘走、并从正文里删掉 ——
        // 补不回来的话文章开头就断了。导语一定是个段落，
        // 所以"第 1 行是 p"能稳定看住这个回归，且不依赖具体文案。
        ['首块是导语段落', m.firstType === 'p'],
        // 降级态没有译文列，对齐无从谈起
        ...(degraded
          ? []
          : [
              [`左右同行顶部对齐（${a.pairs} 对）`, a.badTop === 0],
              [`左右同行高度一致（${a.pairs} 对）`, a.badH === 0],
              // 单栏模式下 ::after 被 display:none 掉了，这条只在双栏时有意义
              [
                `跨栏块盖住中缝竖线（${s.total} 个：${[...new Set(s.kinds)].join('/') || '无'}）`,
                s.bad.length === 0,
              ],
            ]),
      ];

      console.log(`\n${c.name}  →  ${path.basename(out)}`);
      console.log(`  标题：${m.title}`);
      console.log(`  块数 ${m.cells}（原文 ${m.src} / 译文 ${m.dst} / 共享 ${m.shared}）`);
      console.log(`  首块 [${m.firstType ?? '无'}] ${m.firstText ?? ''}`);
      if (!degraded && (a.badTop || a.badH)) console.log(`  对齐异常示例：${a.examples.join(' | ')}`);
      if (!degraded && s.bad.length) console.log(`  中缝异常：${s.bad.slice(0, 4).join(' | ')}`);
      for (const [label, pass] of checks) {
        console.log(`  ${pass ? '✓' : '✗'} ${label}`);
        if (!pass) failed++;
      }
    }

    console.log(`\n结果：${CASES.length} 个场景，${failed === 0 ? '全部通过' : `${failed} 项未通过`}`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    if (chrome) chrome.child.kill();
    stack.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
