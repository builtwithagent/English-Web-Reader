/**
 * M2 预览自检。
 *
 * 起 Nest(3000) + Vite(5173)，用无头 Chrome 截两张图：
 *   - 英文页面 → 双栏对照
 *   - 非英文页面 → 单栏降级 + 说明条
 * 顺带验证 Vite 的 /api 代理在真实链路里是通的（M2 唯一的联调点）。
 *
 * **为什么用 CDP 而不是 `chrome --screenshot`**：
 * `--virtual-time-budget` 只推进虚拟时钟，**等不了 JS 发起的 fetch** ——
 * 文章还在飞的时候就把骨架截下来了。CDP 可以轮询页面状态，
 * 等到真的出现 `.grid` 再截，这才是"等渲染好"而不是"等固定时间"。
 *
 * 用法：node scripts/shot.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status > 0) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ============================================================================
// 极简 CDP 客户端
// ============================================================================

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id) return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`));
      }, 30000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.value;
  }
}

async function launchChrome() {
  const profile = mkdtempSync(path.join(tmpdir(), 'ewr-cdp-'));
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  if (!(await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/version`))) {
    throw new Error('Chrome 调试端口没起来');
  }

  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到 page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });

  return { child, cdp: new Cdp(ws) };
}

/** 轮询页面状态，直到条件为真 —— 比固定 sleep 稳，机器快慢都不影响 */
async function waitUntil(cdp, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function capture(cdp, pageUrl, outFile, focus) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1.5,
    mobile: false,
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: pageUrl });

  // 等阅读态真的渲染出来（不是等固定时间）
  const ok = await waitUntil(cdp, `!!document.querySelector('.grid')`, 30000);
  if (!ok) {
    const errText = await cdp.eval(`document.body.innerText.slice(0, 300)`);
    return { ok: false, detail: errText };
  }

  // `focus` = 要定格进画面的元素。文章里的插图往往在首屏之外，
  // 不滚过去的话截图里根本没有图，"跨栏块有没有被竖线劈开"就无从判断。
  // 滚动不影响上面那些断言：它们查的是 DOM 与相对位置，跟视口无关。
  if (focus) {
    await cdp.eval(`document.querySelector('${focus}')?.scrollIntoView({ block: 'center' })`);
    // 图片是 loading="lazy"，滚进视野才开始加载 —— 等它真的解码完再截
    await waitUntil(
      cdp,
      `(() => {
         const img = document.querySelector('${focus}')?.querySelector('img');
         return !!img && img.complete && img.naturalWidth > 0;
       })()`,
      15000,
    );
    await new Promise((r) => setTimeout(r, 300));
  }

  // 再给图片一点时间（不阻塞太久，图挂了也不影响判断布局）
  await cdp.eval('Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; })))');
  await new Promise((r) => setTimeout(r, 300));

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outFile, Buffer.from(data, 'base64'));

  // 顺手把页面的实际状态回报出来，方便判断"截图对不对"
  const meta = await cdp.eval(`JSON.stringify({
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
  const align = await cdp.eval(`JSON.stringify((() => {
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
  const sharedMask = await cdp.eval(`JSON.stringify((() => {
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

  return { ok: true, meta: JSON.parse(meta), align: JSON.parse(align), sharedMask: JSON.parse(sharedMask) };
}

async function main() {
  const logs = [];
  const procs = [];

  const start = (args, cwd, tag) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, PORT: String(NEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => logs.push(`[${tag}] ${c}`));
    child.stderr.on('data', (c) => logs.push(`[${tag}] ${c}`));
    child.on('error', (e) => logs.push(`[${tag} spawn error] ${e.message}`));
    procs.push(child);
    return child;
  };

  console.log('启动 Nest(3000) 与 Vite(5173)…');
  start([path.join(repoRoot, 'server', 'dist', 'main.js')], path.join(repoRoot, 'server'), 'nest');
  start(
    [path.join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(VITE_PORT), '--strictPort'],
    webRoot,
    'vite',
  );

  let chrome = null;
  try {
    // 两个都要等：Vite 起得比 Nest 快，只等 Vite 会撞上代理 ECONNREFUSED
    if (!(await waitFor(`http://127.0.0.1:${NEST_PORT}/api/article?url=x`))) {
      console.log('Nest 没起来，日志：');
      console.log(logs.join('').slice(-2500));
      process.exitCode = 1;
      return;
    }
    if (!(await waitFor(`${SITE}/`))) {
      console.log('Vite 没起来，日志：');
      console.log(logs.join('').slice(-2500));
      process.exitCode = 1;
      return;
    }
    console.log('Nest 与 Vite 均已就绪');

    // ---- 联调点：Vite 的 /api 代理能不能打到 Nest ----
    const probe = await fetch(`${SITE}/api/article?url=${encodeURIComponent('not a url')}`);
    const probeBody = await probe.json().catch(() => null);
    const proxyOk = probeBody?.error?.code === 'invalid_url';
    console.log(`${proxyOk ? '✓' : '✗'} /api 代理  →  ${probe.status} ${probeBody?.error?.code ?? '(无响应体)'}`);
    if (!proxyOk) {
      console.log(logs.join('').slice(-2000));
      process.exitCode = 1;
      return;
    }

    console.log('启动无头 Chrome（CDP）…');
    chrome = await launchChrome();

    const ts = stamp();
    let failed = 0;

    for (const c of CASES) {
      const out = path.join(outDir, `实现预览-${c.name}-${ts}.png`);
      const pageUrl = `${SITE}/?url=${encodeURIComponent(c.url)}`;
      const result = await capture(chrome.cdp, pageUrl, out, c.focus);

      if (!result.ok) {
        console.log(`✗ ${c.name}：没等到阅读态。页面当时显示：${result.detail}`);
        failed++;
        continue;
      }

      const m = result.meta;
      const a = result.align;
      const s = result.sharedMask;
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
        // 后端 smoke.mjs 有同款断言，这里再在真实渲染上把一次。
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
      if (!degraded && (a.badTop || a.badH)) {
        console.log(`  对齐异常示例：${a.examples.join(' | ')}`);
      }
      if (!degraded && s.bad.length) {
        console.log(`  中缝异常：${s.bad.slice(0, 4).join(' | ')}`);
      }
      for (const [label, pass] of checks) {
        console.log(`  ${pass ? '✓' : '✗'} ${label}`);
        if (!pass) failed++;
      }
    }

    console.log(`\n结果：${CASES.length} 个场景，${failed === 0 ? '全部通过' : `${failed} 项未通过`}`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    if (chrome) chrome.child.kill();
    for (const p of procs) {
      if (!p.killed) p.kill();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
