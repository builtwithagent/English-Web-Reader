/**
 * M2 / M3 / M4 预览自检。
 *
 * 起 Nest(3000) + Vite(5173)，用无头 Chrome 跑四个场景：
 *   - 英文页面     → 双栏对照 + **译文真的落到右栏**
 *   - 非英文页面   → 单栏降级 + 说明条（**一个翻译请求都不发**）
 *   - 带插图的页面 → 跨栏块不被中缝竖线劈开
 *   - 实用功能     → 导出 Markdown 真的落盘 + 偏好真的跨刷新记得住（不截图，只断言）
 * 顺带验证 Vite 的 /api 代理在真实链路里是通的（前后端唯一的联调点）。
 *
 * **上游接的是本地替身**（`server/scripts/mock-llm.mjs`），不是真 LLM 服务商：
 * 自检要能离线跑、要能断言"右栏的内容确实是它那一块翻出来的"，
 * 而真上游给的译文是什么没人能预先知道，没法写判据。
 * 替身把译文拼成「【目标语言】+ 原文」，于是"右栏是否包含左栏开头"
 * 就成了一个能机械核对的对齐判据。
 *
 * 截图与 CDP 那套在 scripts/lib/cdp.mjs，这里只留"断言什么"。
 *
 * 用法：node scripts/shot.mjs
 *      SHOT_KEEP_EXPORT=<目录> node scripts/shot.mjs   # 顺带留一份导出的 md，供肉眼检查
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockUpstream } from '../../server/scripts/mock-llm.mjs';
import {
  capturePage,
  clearPrevious,
  launchChrome,
  setDownloadDir,
  startDevStack,
  stamp,
  waitUntil,
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

/**
 * 页面就绪的判据。
 *
 * 关键在**后半句**：`.grid` 出现只说明文章抓回来了，此时右栏还全是"待翻译"。
 * 抄下这一刻的图，看到的是半个过程，不是结果。
 * 等 `.pending` 归零才是"这一轮翻译跑完了" —— 失败块变成 `.miss`，同样不再计入。
 */
const READY = `(!!document.querySelector('.grid') && document.querySelectorAll('.col-dst .pending').length === 0) || !!document.querySelector('.error-banner')`;

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
  // M4 的两项实用功能：导出 Markdown、偏好记忆。
  // 都在这一个场景里跑 —— 它们操作的是同一个已加载的页面，分开反而要重抓一次。
  { name: '实用功能', url: `${MDN}/en-US/docs/Web/JavaScript/Guide/Introduction`, utility: true },
];

/** 把页面的实测状态取回来（经 JSON 字符串往返 —— CDP 对复杂返回值的序列化有限制） */
async function measure(cdp) {
  const meta = await cdp.evalJson(`JSON.stringify({
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

  // 译文回填（技术方案 5.2）。
  // 服务端并发 3、谁先译完谁先推，所以**到达顺序毫无意义** ——
  // 能验的不是"顺序对不对"，而是"每一格的译文是不是它自己那一块翻的"。
  // 替身上游把译文拼成「【目标语言】+ 原文」，于是右栏必须包含左栏的开头。
  const translation = await cdp.evalJson(`JSON.stringify((() => {
    const dsts = [...document.querySelectorAll('.col-dst')];
    const pending = dsts.filter(el => el.querySelector('.pending')).length;
    const missing = dsts.filter(el => el.querySelector('.miss')).length;
    const examples = [];

    let mismatched = 0;
    for (const dst of dsts) {
      const src = document.querySelector('.col-src[data-row="' + dst.dataset.row + '"]');
      if (!src) continue;
      const srcText = (src.innerText || '').trim().replace(/\\s+/g, ' ');
      const dstText = (dst.innerText || '').trim().replace(/\\s+/g, ' ');
      if (!srcText || !dstText) continue;
      // 取左栏开头 24 个字符去右栏找。列表块的原文是多行拼的，
      // 归一空白之后开头仍然对得上。
      if (!dstText.includes(srcText.slice(0, 24))) {
        mismatched++;
        if (examples.length < 3) examples.push('#' + dst.dataset.row + ' 右栏内容不是这一块翻的');
      }
    }

    // 列表块要还原成多项。行数对不上时代码会整段当成一项（宁可少个符号也不错位），
    // 所以这里查"项数是否与原文一致"，不一致就说明还原失败了。
    let listMismatch = 0;
    for (const src of document.querySelectorAll('.col-src[data-type="ul"], .col-src[data-type="ol"]')) {
      const dst = document.querySelector('.col-dst[data-row="' + src.dataset.row + '"]');
      if (!dst) continue;
      const want = src.querySelectorAll('li').length;
      const got = dst.querySelectorAll('li').length;
      if (want !== got) {
        listMismatch++;
        if (examples.length < 3) examples.push('#' + src.dataset.row + ' 列表项数 ' + want + '→' + got);
      }
    }

    return {
      total: dsts.length,
      pending,
      missing,
      filled: dsts.length - pending - missing,
      mismatched,
      listMismatch,
      examples,
      status: document.querySelector('.controls .status')?.textContent?.trim(),
    };
  })())`);

  // 语言浮层的开合（技术方案 7.2）。
  // 从原生 `<select>` 换成自绘浮层之后，"展开"从**浏览器行为**变成了**我们的代码**，
  // 所以必须看住它 —— 光是数选项数量，开合逻辑整个坏掉也照样通过。
  // 顺便取当前值：偏好用例要靠它验证"刷新后语言还在"。
  const langMenu = await cdp.evalJson(`JSON.stringify({
    count: document.querySelectorAll('.lang-menu .lang-option').length,
    current: document.querySelector('.lang-trigger')?.dataset.value,
  })`);

  await cdp.eval(`document.querySelector('.lang-trigger')?.click()`);
  await new Promise((r) => setTimeout(r, 150));
  const opened = await cdp.evalJson(`JSON.stringify((() => {
    const pane = document.querySelector('.lang-menu');
    const r = pane?.getBoundingClientRect();
    return {
      visible: !!r && r.width > 0 && r.height > 0,
      expanded: document.querySelector('.lang-trigger')?.getAttribute('aria-expanded'),
    };
  })())`);
  // 再点一下收回去，别影响后面的截图
  await cdp.eval(`document.querySelector('.lang-trigger')?.click()`);
  await new Promise((r) => setTimeout(r, 150));
  const collapsed = await cdp.eval(
    `document.querySelector('.lang-trigger')?.getAttribute('aria-expanded') === 'false'`,
  );

  return {
    meta,
    align,
    sharedMask,
    translation,
    langMenu: { ...langMenu, opened: opened?.visible === true && opened?.expanded === 'true', collapsed },
  };
}

/**
 * 切目标语言，等整篇重翻完。
 *
 * 判据刻意收得很紧：**所有**译文格都变成了新语言的标记，而不只是"出现了新语言"。
 * 后者在第一块刚回来时就会成立 —— 那只能证明"翻了"，证明不了"整篇重翻了"。
 *
 * 这里也顺带看住了「切语言只重翻新增块」这类漏掉旧块清空的 bug：
 * 旧译文是「【简体中文】」，只要有任何一格还留着它，`every` 就不成立。
 */
async function switchLangAndWait(cdp, lang, marker) {
  // 自绘浮层没有 `select.value = … + dispatchEvent('change')` 这条捷径了，
  // 得像真人一样点两下：先展开浮层，再点中那一项。
  const opened = await cdp.eval(`(() => {
    const t = document.querySelector('.lang-trigger');
    if (!t) return false;
    if (t.getAttribute('aria-expanded') !== 'true') t.click();
    return true;
  })()`);
  if (!opened) return { ok: false, detail: '找不到语言选择器' };
  await new Promise((r) => setTimeout(r, 150));

  const applied = await cdp.eval(
    `(() => {
      const o = document.querySelector('.lang-menu .lang-option[data-value="${lang}"]');
      if (!o) return false;
      o.click();
      return true;
    })()`,
  );
  if (!applied) return { ok: false, detail: `浮层里没有 ${lang} 这一项` };

  const ok = await waitUntil(
    cdp,
    `document.querySelectorAll('.col-dst').length > 0
     && document.querySelectorAll('.col-dst .pending').length === 0
     && [...document.querySelectorAll('.col-dst')].every(el => (el.innerText || '').includes(${JSON.stringify(marker)}))`,
    60000,
  );

  const status = await cdp.eval(`document.querySelector('.controls .status')?.textContent?.trim() ?? ''`);
  const sample = await cdp.eval(`document.querySelector('.col-dst')?.innerText?.slice(0, 18) ?? ''`);
  return {
    ok,
    detail: ok
      ? `右栏已全部换成${marker} · 状态栏「${status}」`
      : `样例「${sample}」· 状态栏「${status}」`,
  };
}

/**
 * 导出 Markdown（PRD 3.6）。
 *
 * 无头浏览器**默认拒绝下载**，所以启动时就得把下载目录指到临时目录（setDownloadDir），
 * 否则点了按钮什么也不会发生，脚本只能看到"点了没反应" —— 分不清是按钮坏了还是被拦了。
 */
async function checkExport(cdp, downloadDir) {
  const clicked = await cdp.eval(`(() => {
    const btn = document.querySelector('.btn-export');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()`);
  if (!clicked) return { ok: false, detail: '导出按钮不可点' };

  const file = await waitForDownload(downloadDir, 15000);
  if (!file) return { ok: false, detail: '没等到下载的 .md 文件' };

  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  const checks = [
    ['文件名以 .md 结尾', file.endsWith('.md')],
    ['首行是文章标题（# 开头）', /^# \S/.test(lines[0] ?? '')],
    ['来源信息在位', text.includes('> **来源**：https://')],
    ['写明了格式约定', text.includes('格式约定')],
    ['含原文', text.includes('This chapter introduces JavaScript')],
    ['译文用引用块', /^> 【/m.test(text)],
    ['代码块原样保留', /^```/m.test(text)],
  ];

  // 断言只能证明"该有的构件都在"，证明不了"读起来顺不顺"。
  // 需要肉眼过一遍时，用 SHOT_KEEP_EXPORT=<目录> 把产物留一份出来。
  const keep = process.env.SHOT_KEEP_EXPORT;
  if (keep) {
    try {
      mkdirSync(keep, { recursive: true });
      copyFileSync(file, path.join(keep, path.basename(file)));
    } catch {
      /* 留存只是辅助手段，失败了不影响断言结果 */
    }
  }

  return {
    ok: checks.every(([, pass]) => pass),
    checks,
    detail: `${path.basename(file)} · ${text.length} 字节`,
  };
}

/** 轮询下载目录，等一个非 .crdownload 的 .md 出现 */
async function waitForDownload(dir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const hit = readdirSync(dir).find((f) => f.endsWith('.md') && !f.endsWith('.crdownload'));
      if (hit) return path.join(dir, hit);
    } catch {
      /* 目录还没建出来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/**
 * 偏好记忆（PRD 3.6）。
 *
 * 分两步验，缺一不可：**写进去了没**（localStorage），**读回来了没**（刷新后 DOM 还是那样）。
 * 只验前者会漏掉"读的时候被校验逻辑吃掉"的问题 —— 顺带说，这次审查就抓到一个：
 * `targetLang` 从 localStorage 读回时没做合法性校验，一个旧版本残留的 `en`
 * 会让语言选择器显示成空白。
 */
async function checkPreferences(cdp) {
  const readState = `JSON.stringify({
    fontSize: document.documentElement.style.getPropertyValue('--reading-font-size'),
    theme: document.documentElement.dataset.theme,
    mode: document.querySelector('.grid')?.dataset.mode,
    lang: document.querySelector('.lang-trigger')?.dataset.value,
    stored: localStorage.getItem('ewr_preferences'),
  })`;

  const before = await cdp.evalJson(readState);
  if (!before) return { ok: false, detail: '改之前的状态读不回来' };

  // 三项都动一下：字号 +2、模式 → 仅原文、深浅色反转
  await cdp.eval(`(() => {
    const plus = [...document.querySelectorAll('.zs-group .btn.icon')].pop();
    plus?.click(); plus?.click();
    document.querySelectorAll('.mode-seg button')[2]?.click();
    document.querySelector('[aria-label="切换深浅色"]')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 300));

  const changed = await cdp.evalJson(readState);
  if (!changed) return { ok: false, detail: '改之后的状态读不回来' };

  let stored = null;
  try {
    stored = JSON.parse(changed.stored ?? 'null');
  } catch {
    /* 坏值由下面的断言判 */
  }

  // 刷新，看值是不是真的回来了（URL 上的 ?url= 还在，会自动重新载入这篇文章）
  await cdp.send('Page.reload');
  await waitUntil(cdp, `!!document.querySelector('.grid')`, 45000);
  await new Promise((r) => setTimeout(r, 500));
  const after = await cdp.evalJson(readState);

  const checks = [
    [
      '三项都真的变了（字号 / 模式 / 深浅色）',
      changed.fontSize !== before.fontSize &&
        changed.mode !== before.mode &&
        changed.theme !== before.theme,
    ],
    [
      '落进了 localStorage',
      !!stored &&
        stored.fontSize === Number.parseInt(changed.fontSize, 10) &&
        stored.mode === changed.mode &&
        stored.theme === changed.theme,
    ],
    ['刷新后字号还在', after?.fontSize === changed.fontSize],
    ['刷新后显示模式还在', after?.mode === changed.mode],
    ['刷新后深浅色还在', after?.theme === changed.theme],
    ['刷新后目标语言还在', after?.lang === changed.lang],
  ];

  return {
    ok: checks.every(([, pass]) => pass),
    checks,
    detail: `${before.fontSize}/${before.mode}/${before.theme} → ${changed.fontSize}/${changed.mode}/${changed.theme} → 刷新后 ${after?.fontSize}/${after?.mode}/${after?.theme}`,
  };
}

/**
 * 清掉这个源上的 localStorage。
 *
 * 直接打 `Storage.clearDataForOrigin` 而不是"打开页面再执行 JS 清理"：
 * 后者要求先导航一次，等于每个场景多开一次页面；而这条命令在
 * `about:blank` 上就能生效。
 */
async function clearAppStorage(cdp) {
  try {
    await cdp.send('Storage.clearDataForOrigin', {
      origin: SITE,
      storageTypes: 'local_storage',
    });
  } catch {
    // 清不掉不该把整个自检卡住 —— 场景本身还是能跑，只是可能互相带一点残留
  }
}

/** 只打开页面并等就绪，不截图 —— 给"只做验证"的场景用 */
async function openAndWait(cdp, url) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1.5,
    mobile: false,
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  return waitUntil(cdp, READY, 45000);
}

/**
 * 就地截图（不导航）。
 *
 * 不能复用 `capturePage` —— 它会先 `Page.navigate`，一把把页面刷回初始态。
 * 这里要做的是"把刚验证完的那个状态拍下来"（深色 + 仅原文 + 19px 是 M4 的直接证据），
 * 刷新一下证据就没了。
 */
async function cdpScreenshot(cdp, outFile) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outFile, Buffer.from(data, 'base64'));
}

async function main() {
  // 先起替身上游，拿到地址才能把它注入给 Nest
  const mock = await startMockUpstream();
  console.log(`Mock 上游  →  ${mock.baseUrl}`);

  // 无头浏览器默认拒绝下载，导出验证得先把下载目录指到这儿
  const downloadDir = mkdtempSync(path.join(tmpdir(), 'ewr-dl-'));

  const stack = await startDevStack({
    repoRoot,
    webRoot,
    nestPort: NEST_PORT,
    vitePort: VITE_PORT,
    nestEnv: {
      LLM_BASE_URL: mock.baseUrl,
      LLM_API_KEY: 'sk-MOCK-shot-0000',
    },
  });

  let chrome = null;

  // 被 Ctrl-C 或超时掐断时也要把子进程带走。
  // 少了这段，脚本一断就留下两个孤儿进程占着 3000/5173，
  // 下一次跑就会起不来（表现是"新加的路由 404，别的都好"）。
  const cleanup = () => {
    if (chrome) chrome.child.kill();
    stack.stop();
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

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
    await setDownloadDir(chrome.cdp, downloadDir);

    const removed = clearPrevious(outDir, '实现预览-');
    if (removed) console.log(`清掉上一批预览图 ${removed} 张`);

    const ts = stamp();
    let failed = 0;

    for (const c of CASES) {
      const pageUrl = `${SITE}/?url=${encodeURIComponent(c.url)}`;

      // ---- 每个场景都从干净的偏好开始 ----
      //
      // 四个场景共用同一个浏览器 profile，localStorage 是跨场景存活的。
      // 场景「英文双栏」结尾会把目标语言切到日语并落盘，于是后面几个场景
      // 一进来就是日语 —— 不是什么大问题，但它是**隐性耦合**：
      // 导出的 Markdown 会莫名标着"日本語"，偏好用例的起点也不再是默认值，
      // 将来某一场景失败时，你没法确定它是不是被前一场景带歪的。
      // 清一次，场景之间就没有看不见的因果。
      await clearAppStorage(chrome.cdp);

      // ---- 只验证、不截图的场景（M4 实用功能）----
      if (c.utility) {
        if (!(await openAndWait(chrome.cdp, pageUrl))) {
          console.log(`\n✗ ${c.name}：没等到阅读态`);
          failed++;
          continue;
        }
        console.log(`\n${c.name}`);

        const ex = await checkExport(chrome.cdp, downloadDir);
        console.log(`  ${ex.ok ? '✓' : '✗'} 导出 Markdown  ${ex.detail}`);
        if (!ex.ok) {
          failed++;
          for (const [label, pass] of ex.checks ?? []) if (!pass) console.log(`      · ${label}`);
        }

        // 语言切换要放在偏好之前：它需要双栏可见（偏好会切到"仅原文"，
        // 那时 .col-dst 是 display:none，innerText 读到的是空串）
        const flip = await switchLangAndWait(chrome.cdp, 'ja', '【日语】');
        console.log(`  ${flip.ok ? '✓' : '✗'} 切目标语言后整篇重翻  ${flip.detail}`);
        if (!flip.ok) failed++;

        // 把偏好改掉（字号 17→19、模式→仅原文、浅色→深色），刷新验记忆
        const pf = await checkPreferences(chrome.cdp);
        console.log(`  ${pf.ok ? '✓' : '✗'} 偏好记忆跨刷新保持  ${pf.detail}`);
        if (!pf.ok) {
          failed++;
          for (const [label, pass] of pf.checks ?? []) if (!pass) console.log(`      · ${label}`);
        }

        // 顺手把改完偏好的样子留下来 —— 深色 + 仅原文 + 19px 是 M4 的直接证据。
        // 先等这一轮的翻译收尾：刷新会重新发起整篇翻译，不等的话画面里
        // 挂着「5/48 翻译中」，看起来像卡住了，而不是"这两个偏好生效了"。
        await waitUntil(chrome.cdp, READY, 30000);
        const shot = path.join(outDir, `实现预览-深色仅原文-${ts}.png`);
        await cdpScreenshot(chrome.cdp, shot);
        console.log(`  截图  →  ${path.basename(shot)}`);
        continue;
      }

      const out = path.join(outDir, `实现预览-${c.name}-${ts}.png`);
      const shot = await capturePage(chrome.cdp, {
        url: pageUrl,
        outFile: out,
        viewport: VIEWPORT,
        readyExpression: READY,
        focus: c.focus,
      });

      if (!shot.ok) {
        console.log(`✗ ${c.name}：没等到阅读态。页面当时显示：${shot.detail}`);
        failed++;
        continue;
      }

      const { meta: m, align: a, sharedMask: s, translation: t, langMenu: lm } = await measure(chrome.cdp);
      if (!m || !a || !s || !t || !lm) {
        console.log(`✗ ${c.name}：页面状态读不回来`);
        failed++;
        continue;
      }

      const degraded = c.name.includes('降级');
      const checks = [
        ['语言选项 10 项', lm.count === 10],
        ['语言浮层能开能收', lm.opened === true && lm.collapsed === true],
        ['块已渲染', m.cells > 0],
        degraded ? ['未渲染译文列', m.dst === 0] : ['译文列已渲染', m.dst > 0],
        degraded ? ['隐藏模式切换', m.modeSwitch === false] : ['显示模式切换', m.modeSwitch === true],
        degraded ? ['显示降级说明条', m.notice === true] : ['无说明条', m.notice === false],
        degraded ? ['单栏模式', m.gridMode === 'src'] : ['双栏模式', m.gridMode === 'both'],
        // Readability 会把页面**导语**当 excerpt 摘走、并从正文里删掉 ——
        // 补不回来的话文章开头就断了。导语一定是个段落，
        // 所以"第 1 行是 p"能稳定看住这个回归，且不依赖具体文案。
        ['首块是导语段落', m.firstType === 'p'],
        // 降级态没有译文列，对齐与翻译都无从谈起
        ...(degraded
          ? [
              // 降级态的硬要求：一个翻译请求都不发。所以译文列 DOM 压根不存在，
              // 而不是"发了但没填"（后者说明前端漏了闸门，是真花钱的那种 bug）
              ['未生成任何译文格', t.total === 0],
            ]
          : [
              [`左右同行顶部对齐（${a.pairs} 对）`, a.badTop === 0],
              [`左右同行高度一致（${a.pairs} 对）`, a.badH === 0],
              // 单栏模式下 ::after 被 display:none 掉了，这条只在双栏时有意义
              [
                `跨栏块盖住中缝竖线（${s.total} 个：${[...new Set(s.kinds)].join('/') || '无'}）`,
                s.bad.length === 0,
              ],
              [`译文全部回填（${t.filled}/${t.total}）`, t.pending === 0 && t.filled === t.total],
              ['无翻译失败的块', t.missing === 0],
              // **最关键的一条**：并发回流下，每一格拿到的必须是自己那块的译文
              [`译文与所属块一一对应（${t.total} 格）`, t.mismatched === 0],
              ['列表块按项还原', t.listMismatch === 0],
            ]),
      ];

      console.log(`\n${c.name}  →  ${path.basename(out)}`);
      console.log(`  标题：${m.title}`);
      console.log(`  块数 ${m.cells}（原文 ${m.src} / 译文 ${m.dst} / 共享 ${m.shared}）`);
      console.log(`  首块 [${m.firstType ?? '无'}] ${m.firstText ?? ''}`);
      if (!degraded) {
        console.log(`  译文 ${t.filled}/${t.total} 回填，状态栏「${t.status ?? '无'}」`);
      }
      if (!degraded && a.examples?.length) console.log(`  对齐异常示例：${a.examples.join(' | ')}`);
      if (!degraded && t.examples?.length) console.log(`  回填异常示例：${t.examples.join(' | ')}`);
      if (!degraded && s.bad.length) console.log(`  中缝异常：${s.bad.slice(0, 4).join(' | ')}`);
      for (const [label, pass] of checks) {
        console.log(`  ${pass ? '✓' : '✗'} ${label}`);
        if (!pass) failed++;
      }

      // ---- 附加：切目标语言应当自动整篇重翻（技术方案 7.3） ----
      // 放在截图**之后**跑，免得验证过程把截图里的语言换掉。
      if (c.name === '英文双栏') {
        const flip = await switchLangAndWait(chrome.cdp, 'ja', '【日语】');
        console.log(`  ${flip.ok ? '✓' : '✗'} 切目标语言后整篇重翻  ${flip.detail}`);
        if (!flip.ok) failed++;
      }
    }

    console.log(`\n结果：${CASES.length} 个场景，${failed === 0 ? '全部通过' : `${failed} 项未通过`}`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    if (chrome) chrome.child.kill();
    stack.stop();
    await mock.close();
    // 下载目录是临时目录里的，跑完就清 —— 不清的话每跑一次都在系统 temp 里留一份 md
    try {
      rmSync(downloadDir, { recursive: true, force: true });
    } catch {
      /* 文件可能还被浏览器占着，清不掉就算了 */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
