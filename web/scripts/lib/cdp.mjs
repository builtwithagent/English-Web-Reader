/**
 * 无头 Chrome + CDP 的公共部分。
 *
 * 抽出来是因为 shot.mjs（固定场景自检）和 shot-sites.mjs（任意站点抽查）
 * 用的是同一套东西：起 Nest + Vite、连 CDP、轮询页面状态、截图。
 *
 * **为什么不用 `chrome --screenshot`**：它的 `--virtual-time-budget` 只推进虚拟时钟，
 * **等不了 JS 发起的 fetch** —— 页面还在飞的时候就把骨架截下来了。
 * CDP 可以轮询页面状态，等到条件真的成立再截。
 *
 * Node 22 自带全局 WebSocket，所以这里不需要装任何依赖。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!hit) throw new Error('没找到 Chrome / Edge，检查安装路径');
  return hit;
}

/** 文件名时间戳（到分钟）。带时间戳是为了避免"看着是新的、其实是缓存" */
export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 开跑前清掉上一批图。文件名仍带时间戳，只是不让目录一版一版堆下去。
 * prefix 由调用方给，避免误删别的产物。
 */
export function clearPrevious(outDir, prefix) {
  let stale = [];
  try {
    stale = readdirSync(outDir).filter((f) => f.startsWith(prefix) && f.endsWith('.png'));
  } catch {
    return 0;
  }
  for (const f of stale) rmSync(path.join(outDir, f));
  return stale.length;
}

export async function waitFor(url, timeoutMs = 30000) {
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

export class Cdp {
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

  /** 表达式要返回 JSON 字符串，这里负责 parse —— 避开 CDP 对复杂返回值的序列化限制 */
  async evalJson(expression) {
    const raw = await this.eval(expression);
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

export async function launchChrome({ debugPort = 9333, chromePath } = {}) {
  const profile = mkdtempSync(path.join(tmpdir(), 'ewr-cdp-'));
  const child = spawn(
    chromePath ?? findChrome(),
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  if (!(await waitFor(`http://127.0.0.1:${debugPort}/json/version`))) {
    throw new Error('Chrome 调试端口没起来');
  }

  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
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
export async function waitUntil(cdp, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// ============================================================================
// 起本地服务栈
// ============================================================================

/**
 * 起 Nest(3000) + Vite(5173)。
 * 两个都要等：Vite 起得比 Nest 快，只等 Vite 会撞上代理 ECONNREFUSED。
 */
export async function startDevStack({ repoRoot, webRoot, nestPort = 3000, vitePort = 5173 }) {
  const logs = [];
  const procs = [];

  const start = (args, cwd, tag) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, PORT: String(nestPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => logs.push(`[${tag}] ${c}`));
    child.stderr.on('data', (c) => logs.push(`[${tag}] ${c}`));
    child.on('error', (e) => logs.push(`[${tag}] spawn error ${e.message}`));
    procs.push(child);
    return child;
  };

  console.log(`启动 Nest(${nestPort}) 与 Vite(${vitePort})…`);
  start([path.join(repoRoot, 'server', 'dist', 'main.js')], path.join(repoRoot, 'server'), 'nest');
  start(
    [path.join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort'],
    webRoot,
    'vite',
  );

  const stop = () => {
    for (const p of procs) if (!p.killed) p.kill();
  };

  const fail = (reason) => {
    stop();
    return { ok: false, reason, logs, stop };
  };

  if (!(await waitFor(`http://127.0.0.1:${nestPort}/api/article?url=x`))) return fail('nest');
  if (!(await waitFor(`http://localhost:${vitePort}/`))) return fail('vite');
  console.log('Nest 与 Vite 均已就绪');
  return { ok: true, logs, stop };
}

// ============================================================================
// 截图
// ============================================================================

/**
 * 打开一个页面并截图。
 *
 * @param readyExpression 判断"页面已经是目标状态"的表达式，默认等阅读态出现
 * @param focus           要定格进画面的选择器（文章插图常在首屏之外，不滚过去截不到）
 */
export async function capturePage(
  cdp,
  { url, outFile, viewport = { width: 1440, height: 1400 }, readyExpression, focus, settleMs = 300 },
) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1.5,
    mobile: false,
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });

  const ready = readyExpression ?? `!!document.querySelector('.grid') || !!document.querySelector('.error-banner')`;
  if (!(await waitUntil(cdp, ready, 45000))) {
    const text = await cdp.eval('document.body.innerText.slice(0, 300)');
    return { ok: false, detail: text };
  }

  if (focus) {
    await cdp.eval(`document.querySelector('${focus}')?.scrollIntoView({ block: 'center' })`);
    // 图片是 loading="lazy"，滚进视野才开始加载 —— 等它真的解码完再截
    await waitUntil(
      cdp,
      `(() => { const i = document.querySelector('${focus}')?.querySelector('img'); return !!i && i.complete && i.naturalWidth > 0; })()`,
      15000,
    );
  }

  // 图挂了也不影响判断布局，所以不等它们，只给一点时间
  await cdp.eval('Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; })))');
  await new Promise((r) => setTimeout(r, settleMs));

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outFile, Buffer.from(data, 'base64'));
  return { ok: true };
}
