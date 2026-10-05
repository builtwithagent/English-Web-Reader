/**
 * M1 验收自检（技术方案 §9）。
 *
 * 目标：命令行请求 /api/article，确认能拿到
 *   - 干净的 blocks
 *   - 判定正确的 lang（英文页出 en，非英文页出对应标签）
 * 附带把 SSRF 与参数校验的负向用例一起跑了，这些是安全底线，回归时必须过。
 *
 * 用法：node scripts/smoke.mjs
 * 它会自己拉起 dist/main.js（用独立端口），跑完自动关掉，不依赖外部服务。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT ?? 3187);
const BASE = `http://127.0.0.1:${PORT}/api`;

// MDN 同一篇文档的三个语言版本，用来验判定分叉最干净：
// 结构几乎一致，变量只有语言，能排除"页面结构不同导致提取差异"的干扰。
const MDN = 'https://developer.mozilla.org';
const CASES = [
  {
    name: '英文页（应走翻译流程）',
    url: `${MDN}/en-US/docs/Web/JavaScript/Guide/Introduction`,
    expect: { isEnglish: true, lang: 'en' },
  },
  {
    name: '日文页（应降级单栏）',
    url: `${MDN}/ja/docs/Web/JavaScript/Guide/Introduction`,
    expect: { isEnglish: false, lang: 'ja' },
  },
  {
    name: '中文页（应降级单栏）',
    url: `${MDN}/zh-CN/docs/Web/JavaScript/Guide/Introduction`,
    expect: { isEnglish: false, lang: 'zh-Hans' },
  },
];

// 负向用例：这些必须被拦，且不能真的发出请求。
// 覆盖了 IP 字面量的几种常见绕过写法 —— 这类写法**不会触发 DNS lookup**，
// 只靠 lookup 钩子是拦不住的，必须走静态校验（fetch.service 的 assertAllowedShape）。
const NEGATIVE = [
  { name: '内网回环 + 非标准端口', url: 'http://127.0.0.1:8080/', expectCode: 'blocked_target' },
  { name: '回环标准端口', url: 'http://127.0.0.1/', expectCode: 'blocked_target' },
  { name: 'IPv6 回环', url: 'http://[::1]/', expectCode: 'blocked_target' },
  { name: '十进制混淆回环', url: 'http://2130706433/', expectCode: 'blocked_target' },
  { name: '云元数据地址', url: 'http://169.254.169.254/latest/meta-data/', expectCode: 'blocked_target' },
  { name: '私网段', url: 'http://10.0.0.1/', expectCode: 'blocked_target' },
  { name: '非 http 协议', url: 'file:///C:/Windows/win.ini', expectCode: 'unsupported_protocol' },
  { name: '垃圾输入', url: 'not a url at all', expectCode: 'invalid_url' },
];

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function ok(name, detail = '') {
  passed++;
  console.log(`${GREEN}  PASS${RESET} ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}

function fail(name, detail = '') {
  failed++;
  console.log(`${RED}  FAIL${RESET} ${name}${detail ? `  ${RED}${detail}${RESET}` : ''}`);
}

async function getArticle(url) {
  const res = await fetch(`${BASE}/article?url=${encodeURIComponent(url)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** 等端口起来。不用固定 sleep，避免机器慢时误判启动失败 */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/article?url=${encodeURIComponent('not a url')}`);
      if (res.status > 0) return true;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  console.log(`${BOLD}启动服务${RESET} ${DIM}(port ${PORT})${RESET}`);
  // 用绝对路径做入口：Windows 上 cwd + 相对路径偶尔会解析到别处
  const entry = path.join(root, 'dist', 'main.js');
  const server = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  let exitInfo = '未退出';
  server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  server.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  // spawn 本身失败（找不到文件 / 权限）不会进 stdio，只会走这个事件 —— 不监听就会一片空白
  server.on('error', (err) => {
    logs.push(`[spawn error] ${err.code ?? ''} ${err.message}\n`);
  });

  let exited = false;
  server.on('exit', (code, signal) => {
    exited = true;
    exitInfo = `exit code=${code} signal=${signal}`;
  });

  try {
    const up = await waitForServer();
    if (!up) {
      console.log(`${RED}服务没起来${RESET} ${DIM}(${exitInfo})${RESET}，日志如下：`);
      console.log(logs.join('').slice(-3000) || `${DIM}(无任何输出)${RESET}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${DIM}服务已就绪${RESET}\n`);

    // ---- 正向：语言判定 ----
    console.log(`${BOLD}语言判定${RESET}`);
    for (const c of CASES) {
      try {
        const { status, body } = await getArticle(c.url);
        if (status !== 200) {
          fail(c.name, `HTTP ${status} ${body?.error?.code ?? ''}`);
          continue;
        }
        const problems = [];
        if (body.lang !== c.expect.lang) problems.push(`lang=${body.lang}（期望 ${c.expect.lang}）`);
        if (body.isEnglish !== c.expect.isEnglish) problems.push(`isEnglish=${body.isEnglish}`);
        if (!Array.isArray(body.blocks) || body.blocks.length === 0) problems.push('blocks 为空');
        if (problems.length) {
          fail(c.name, problems.join('; '));
        } else {
          const detail = `blocks=${body.blocks.length} level=${body.extractLevel} lang=${body.lang}`;
          ok(c.name, detail);
        }
      } catch (err) {
        fail(c.name, err.message);
      }
    }

    // ---- 正向：blocks 结构质量 ----
    console.log(`\n${BOLD}blocks 结构${RESET}`);
    try {
      const { body } = await getArticle(CASES[0].url);
      const blocks = body.blocks ?? [];
      const ids = blocks.map((b) => b.id);
      const sequential = ids.every((id, i) => id === i + 1);
      sequential ? ok('id 从 1 起连续递增') : fail('id 不连续', ids.slice(0, 8).join(','));

      const badTranslatable = blocks.filter((b) => b.translatable && !(b.text || b.items?.length));
      badTranslatable.length === 0
        ? ok('translatable 块都有内容')
        : fail('有空的可翻译块', `${badTranslatable.length} 个`);

      const pre = blocks.filter((b) => b.type === 'pre');
      const preAllNonTranslatable = pre.every((b) => b.translatable === false);
      preAllNonTranslatable
        ? ok('代码块不参与翻译', `pre=${pre.length}`)
        : fail('有代码块被标记为可翻译');

      const imgs = blocks.filter((b) => b.type === 'img');
      const imgsAbsolute = imgs.every((b) => /^https?:\/\//.test(b.src ?? ''));
      imgsAbsolute
        ? ok('图片地址均为绝对路径', `img=${imgs.length}`)
        : fail('存在相对路径图片', imgs.filter((b) => !/^https?:\/\//.test(b.src ?? '')).map((b) => b.src).join(' | '));

      const types = [...new Set(blocks.map((b) => b.type))].join(',');
      console.log(`${DIM}  块类型分布：${types}${RESET}`);
    } catch (err) {
      fail('blocks 结构检查', err.message);
    }

    // ---- 负向：安全与参数校验 ----
    console.log(`\n${BOLD}安全与参数校验${RESET}`);
    for (const c of NEGATIVE) {
      try {
        const { status, body } = await getArticle(c.url);
        const code = body?.error?.code;
        if (code === c.expectCode) {
          ok(c.name, `${status} ${code}`);
        } else {
          fail(c.name, `得到 ${status} ${code ?? JSON.stringify(body).slice(0, 80)}，期望 ${c.expectCode}`);
        }
      } catch (err) {
        fail(c.name, err.message);
      }
    }

    // ---- 服务端日志抽样 ----
    console.log(`\n${BOLD}服务端日志（抽样）${RESET}`);
    const lines = logs
      .join('')
      .split('\n')
      .filter((l) => /lang=|抓取 |blocks=/.test(l))
      .slice(-8);
    for (const l of lines) console.log(`${DIM}  ${l.trim()}${RESET}`);
  } finally {
    if (!exited) server.kill();
  }

  console.log(
    `\n${BOLD}结果${RESET}  ${GREEN}${passed} passed${RESET}` +
      (failed ? `, ${RED}${failed} failed${RESET}` : ''),
  );
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
