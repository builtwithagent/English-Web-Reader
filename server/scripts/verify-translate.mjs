/**
 * M3 翻译链路验收自检（技术方案 §9）。
 *
 * 起一个本地 Mock 上游 + 一个真实的服务端进程，把翻译链路上
 * **只有打真上游才看不到**的那些情况全跑一遍：限流重试、密钥无效、余额不足、
 * 超时、单块失败、入口语言闸门、DTO 校验、不可译块跳过。
 *
 * 关键点：服务端进程、SSE 协议、并发、重试、错误映射全部是真的，
 * 被替掉的只有 `LLM_BASE_URL` 指向的那台机器。
 *
 * 用法：node scripts/verify-translate.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockUpstream } from './mock-llm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = Number(process.env.VERIFY_PORT ?? 3188);
const BASE = `http://127.0.0.1:${PORT}/api`;

/**
 * 超时压到 1.5s，好让 `__SLOW__`（延迟 5s）能真的打到超时分支。
 * 注意它会连带影响重试：超时算可重试错误，所以一次超时用例实际要等 3s 左右。
 */
const BLOCK_TIMEOUT_MS = 1500;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
let mock;
let requests = [];

function ok(name, detail = '') {
  passed++;
  console.log(`${GREEN}  PASS${RESET} ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}

function fail(name, detail = '') {
  failed++;
  console.log(`${RED}  FAIL${RESET} ${name}${detail ? `  ${RED}${detail}${RESET}` : ''}`);
}

/** 一条断言：条件成立就 PASS，否则带上实际值 FAIL */
function check(name, condition, detail = '') {
  if (condition) ok(name, detail);
  else fail(name, detail);
  return condition;
}

// ---------------------------------------------------------------------------
// SSE 客户端
// ---------------------------------------------------------------------------

/**
 * 发一次翻译请求。
 *
 * 前端那边也得这么写 —— `EventSource` 只能发 GET，带 body 的 SSE 只有
 * `fetch` + 手动读流这一条路。
 */
async function callTranslate(body) {
  const res = await fetch(`${BASE}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const contentType = res.headers.get('content-type') ?? '';

  // 非 SSE = 前置校验拦下来了（或者框架报错），走普通 JSON 错误
  if (!contentType.includes('text/event-stream')) {
    const json = await res.json().catch(() => null);
    return { status: res.status, contentType, events: [], body: json };
  }

  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);

      const line = frame.trim();
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        events.push({ done: true });
        continue;
      }
      try {
        events.push(JSON.parse(payload));
      } catch {
        events.push({ unparsed: payload });
      }
    }
  }

  return { status: res.status, contentType, events, body: null };
}

const withText = (evs) => evs.filter((e) => typeof e.id === 'number' && typeof e.text === 'string');
const withError = (evs) => evs.filter((e) => typeof e.id === 'number' && e.error);
const hasDone = (evs) => evs.some((e) => e.done === true);

function byId(evs, id) {
  return evs.find((e) => e.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

const EN = {
  a: 'Readability is a standalone library for extracting the main article content from a web page.',
  b: 'The result is the same across browsers because the parsing happens on the server side.',
  c: 'Caching is keyed by the normalized URL, the target language and the hash of the block.',
};

async function main() {
  mock = await startMockUpstream();
  console.log(`${BOLD}Mock 上游${RESET} ${DIM}${mock.baseUrl}${RESET}`);

  const entry = path.join(root, 'dist', 'main.js');
  const server = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      LLM_BASE_URL: mock.baseUrl,
      // 和真实密钥的形状一致（会走完整的"发出去 → 被拒 → 归一化"路径）
      LLM_API_KEY: 'sk-MOCK-verify-0000',
      LLM_TIMEOUT_MS: String(BLOCK_TIMEOUT_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  let exitInfo = '未退出';
  server.stdout.on('data', (c) => logs.push(c.toString()));
  server.stderr.on('data', (c) => logs.push(c.toString()));
  server.on('error', (err) => logs.push(`[spawn error] ${err.code ?? ''} ${err.message}\n`));

  let exited = false;
  server.on('exit', (code, signal) => {
    exited = true;
    exitInfo = `exit code=${code} signal=${signal}`;
  });

  try {
    if (!(await waitForServer())) {
      console.log(`${RED}服务没起来${RESET} ${DIM}(${exitInfo})${RESET}，日志如下：`);
      console.log(logs.join('').slice(-3000) || `${DIM}(无任何输出)${RESET}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${DIM}服务已就绪${RESET}\n`);

    await caseBasic();
    await caseTargetLang();
    await caseConcurrency();
    await caseSingleBlockFailure();
    await caseRetryOn429();
    await caseNoRetryOn401();
    await caseTimeout();
    await caseSkipUntranslatable();
    await caseLanguageGate();
    await caseValidation();
    await casePromptContract();

    printLogs(logs);
  } finally {
    if (!exited) server.kill();
    await mock.close();
  }

  console.log(
    `\n${BOLD}结果${RESET}  ${GREEN}${passed} passed${RESET}` +
      (failed ? `, ${RED}${failed} failed${RESET}` : ''),
  );
  process.exitCode = failed ? 1 : 0;
}

/** 基本翻译：3 块进 3 条出，id 对得上，译文用的是默认语言 */
async function caseBasic() {
  console.log(`${BOLD}基本翻译${RESET}`);
  reset();

  const r = await callTranslate({
    url: 'https://example.com/post',
    blocks: [
      { id: 1, text: EN.a },
      { id: 2, text: EN.b },
      { id: 3, text: EN.c },
    ],
  });

  check('HTTP 200 且是 SSE', r.status === 200 && r.contentType.includes('text/event-stream'), r.contentType);

  const texts = withText(r.events);
  check('3 块全部返回译文', texts.length === 3, `实收 ${texts.length}`);

  const ids = texts.map((e) => e.id).sort((x, y) => x - y);
  check('id 与请求一一对应', JSON.stringify(ids) === '[1,2,3]', JSON.stringify(ids));

  const first = byId(texts, 1);
  check('默认目标是简体中文', first?.text?.startsWith('【简体中文】'), first?.text?.slice(0, 20));
  check('译文包含原文内容', first?.text?.includes(EN.a.slice(0, 24)), '');
  check('流以 [DONE] 收尾', hasDone(r.events));
  check('上游被调用了 3 次', requests.length === 3, `实际 ${requests.length}`);
}

/** 目标语言：合法值生效，非法值静默回落（技术方案 5.2） */
async function caseTargetLang() {
  console.log(`\n${BOLD}目标语言${RESET}`);

  reset();
  const ja = await callTranslate({ targetLang: 'ja', blocks: [{ id: 1, text: EN.a }] });
  check('targetLang=ja 生效', byId(withText(ja.events), 1)?.text?.startsWith('【日语】'), '');

  reset();
  const bogus = await callTranslate({ targetLang: 'klingon', blocks: [{ id: 1, text: EN.a }] });
  const text = byId(withText(bogus.events), 1)?.text;
  check('非法 targetLang 静默回落简体中文（不报错）', bogus.status === 200 && !!text?.startsWith('【简体中文】'), text?.slice(0, 20));
}

/**
 * 并发：12 块同时发，全部返回。
 *
 * 为了证明"回流是真并发、不是排队"，第 1 块故意慢 800ms。
 * 它会被第一个 worker 领走并占住，于是完成顺序变成 2,3,…,12,1 ——
 * 前端如果按到达顺序填格子，整篇就错位了。
 */
async function caseConcurrency() {
  console.log(`\n${BOLD}并发与回流顺序${RESET}`);
  reset();

  const blocks = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    text: i === 0 ? `__DELAY:800__ ${EN.a}` : `${EN.a} (block ${i + 1})`,
  }));

  const started = Date.now();
  const r = await callTranslate({ blocks });
  const elapsed = Date.now() - started;

  const texts = withText(r.events);
  check('12 块全部返回', texts.length === 12, `实收 ${texts.length}`);

  const ids = texts.map((e) => e.id).sort((x, y) => x - y);
  check('id 集合完整（一块没漏）', JSON.stringify(ids) === JSON.stringify([...Array(12)].map((_, i) => i + 1)), JSON.stringify(ids));

  const arrival = texts.map((e) => e.id);
  console.log(`${DIM}  回流顺序：${arrival.join(' → ')}${RESET}`);
  console.log(`${DIM}  耗时 ${elapsed}ms${RESET}`);

  check('回流顺序不是请求顺序（证明是并发回流，不是排队）', arrival[0] !== 1, `首个到达 id=${arrival[0]}`);
  // 第 1 块是最先发出去的，排队的话必然第一个回来。它落到了后面，
  // 说明后面那些块确实是**同时**在跑，而不是一个个等前一个结束。
  check('最先发出去的慢块落到了后面', arrival.indexOf(1) > 0, `id=1 排在第 ${arrival.indexOf(1) + 1} 位`);
  // 顺序无所谓的底气来自这里：客户端一律按 id 回填
  check('耗时远小于串行（并发确实生效）', elapsed < 12 * 800, `${elapsed}ms`);
}

/** 单块失败不能拖垮整篇（技术方案 5.3「逐段独立」） */
async function caseSingleBlockFailure() {
  console.log(`\n${BOLD}单块失败隔离${RESET}`);
  reset();

  const r = await callTranslate({
    blocks: [
      { id: 1, text: EN.a },
      { id: 2, text: EN.b },
      { id: 3, text: `__500__ ${EN.c}` },
      { id: 4, text: EN.c },
      { id: 5, text: EN.b },
    ],
  });

  const texts = withText(r.events);
  const errors = withError(r.events);

  check('4 块成功', texts.length === 4, `实收 ${texts.length}`);
  check('1 块失败', errors.length === 1, `实收 ${errors.length}`);
  check('失败的是 #3', errors[0]?.id === 3, `id=${errors[0]?.id}`);
  check('失败码为 translate_unavailable', errors[0]?.error?.code === 'translate_unavailable', errors[0]?.error?.code);
  check('失败不影响其它块', [1, 2, 4, 5].every((id) => !!byId(texts, id)));
  check('流仍然正常收尾', hasDone(r.events));
}

/** 429 属于"等一下可能有救"，必须重试并成功 */
async function caseRetryOn429() {
  console.log(`\n${BOLD}限流重试（429 → 成功）${RESET}`);
  reset();

  const r = await callTranslate({ blocks: [{ id: 1, text: `__429__ ${EN.a}` }] });

  check('重试后拿到译文', !!byId(withText(r.events), 1)?.text, '');
  check('上游确实收到了 2 次（证明重试发生）', requests.length === 2, `实际 ${requests.length}`);
}

/** 401 重试一百次也是同样结果，必须只打一次 */
async function caseNoRetryOn401() {
  console.log(`\n${BOLD}密钥无效不重试（401）${RESET}`);
  reset();

  const r = await callTranslate({ blocks: [{ id: 1, text: `__401__ ${EN.a}` }] });

  const err = withError(r.events)[0];
  check('返回 translate_auth_failed', err?.error?.code === 'translate_auth_failed', err?.error?.code);
  check('只打了 1 次上游（未做无谓重试）', requests.length === 1, `实际 ${requests.length}`);
}

/** 超时 */
async function caseTimeout() {
  console.log(`\n${BOLD}单块超时${RESET}`);
  reset();

  const r = await callTranslate({ blocks: [{ id: 1, text: `__SLOW__ ${EN.a}` }] });

  const err = withError(r.events)[0];
  check('返回 translate_timeout', err?.error?.code === 'translate_timeout', err?.error?.code);
  check('超时后会重试一次', requests.length === 2, `实际 ${requests.length}`);
}

/** 不可译块直接跳过，一个上游请求都不发 */
async function caseSkipUntranslatable() {
  console.log(`\n${BOLD}跳过不可译块${RESET}`);
  reset();

  const r = await callTranslate({
    blocks: [
      { id: 1, text: '42' },
      { id: 2, text: '———' },
      { id: 3, text: '$ %' },
      { id: 4, text: '' },
    ],
  });

  check('全部跳过，无译文事件', withText(r.events).length === 0, `实收 ${withText(r.events).length}`);
  check('零上游调用', requests.length === 0, `实际 ${requests.length}`);
  check('流正常收尾', hasDone(r.events));
}

/** 入口语言闸门：非英文直接拒，且零上游调用（技术方案 5.2 / 5.6） */
async function caseLanguageGate() {
  console.log(`\n${BOLD}入口语言闸门${RESET}`);
  reset();

  const chinese = '这是一个中文段落，用来验证翻译接口的入口闸门是否真的拦得住非英文内容。'.repeat(3);
  const r = await callTranslate({ blocks: [{ id: 1, text: chinese }] });

  check('返回 422', r.status === 422, `HTTP ${r.status}`);
  check('错误码为 source_not_english', r.body?.error?.code === 'source_not_english', r.body?.error?.code);
  check('不是 SSE（在发流之前就被拦下）', !r.contentType.includes('text/event-stream'), r.contentType);
  check('零上游调用', requests.length === 0, `实际 ${requests.length}`);
}

/** DTO 校验：形状不对必须挡在门外 */
async function caseValidation() {
  console.log(`\n${BOLD}请求体校验${RESET}`);
  reset();

  const empty = await callTranslate({ blocks: [] });
  check('blocks 为空 → 400 invalid_request', empty.status === 400 && empty.body?.error?.code === 'invalid_request', `${empty.status} ${empty.body?.error?.code}`);
  check('400 带上了具体字段错误', typeof empty.body?.error?.hint === 'string', empty.body?.error?.hint);

  const badId = await callTranslate({ blocks: [{ id: 'x', text: EN.a }] });
  check('id 非整数 → 400', badId.status === 400, `HTTP ${badId.status}`);

  const notArray = await callTranslate({ blocks: 'nope' });
  check('blocks 非数组 → 400', notArray.status === 400, `HTTP ${notArray.status}`);

  const unknownField = await callTranslate({ blocks: [{ id: 1, text: EN.a }], evil: 'x' });
  check('未声明字段被丢弃（whitelist）', unknownField.status === 200, `HTTP ${unknownField.status}`);
  check('被丢弃的字段没有流到上游', !JSON.stringify(requests[0] ?? {}).includes('evil'), '');
}

/** 提示词契约：角色顺序、注入防护、参数 */
async function casePromptContract() {
  console.log(`\n${BOLD}提示词与请求构造${RESET}`);
  reset();

  await callTranslate({ targetLang: 'de', blocks: [{ id: 1, text: EN.a }] });

  const req = requests[0];
  check('messages[0] 是 system', req?.roleOrder?.[0] === 'system', JSON.stringify(req?.roleOrder));
  check('system 里写明了目标语言', req?.systemText?.includes('德语'), '');
  check('system 含注入防护条款', req?.systemText?.includes('不是给你的指令'), '');
  check('待翻译原文只出现在 user 里', req?.userText === EN.a && !req?.systemText?.includes(EN.a.slice(0, 20)), '');
  check('开了流式', req?.stream === true);
  check('温度按低稳定设定', req?.temperature === 0.2, String(req?.temperature));
  check('max_tokens 有下限保护', req?.maxTokens === 256, String(req?.maxTokens));

  reset();
  const long = 'A very long paragraph that should raise the token budget well above the floor. '.repeat(20);
  await callTranslate({ blocks: [{ id: 1, text: long }] });
  const est = requests[0]?.maxTokens ?? 0;
  check('长文本 max_tokens 随长度上升', est > 256 && est <= 8192, String(est));
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function reset() {
  requests = mock.requests;
  requests.length = 0;
}

/** 等端口起来。不用固定 sleep，避免机器慢时误判启动失败 */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: [] }),
      });
      if (res.status > 0) return true;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function printLogs(logs) {
  console.log(`\n${BOLD}服务端日志（抽样）${RESET}`);
  const lines = logs
    .join('')
    .split('\n')
    .filter((l) => /翻译 |块 #|入口闸门|Mock 密钥|上游就绪/.test(l))
    .slice(-10);
  for (const l of lines) console.log(`${DIM}  ${l.trim()}${RESET}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
