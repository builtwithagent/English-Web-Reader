/**
 * DeepSeek 上游的**本地替身**。
 *
 * 存在意义：翻译链路的每一段（请求构造、SSE 解析、错误映射、并发、重试、超时）
 * 都要能被验证，而这些在"拿真密钥打真上游"时**验证不了** ——
 * 真上游不会给你返回 429、也不会让你挑一个用 401 的密钥。
 *
 * 它替换的只是 `DEEPSEEK_BASE_URL` 指向的地址，其余一律照常：
 * 服务端进程、SSE 协议、Authorization 头、流式分片，全是真的。
 *
 * 触发词写在待翻译文本里，用 `__XXX__` 包起来：
 *   __401__   401（密钥无效）
 *   __402__   402（余额不足）
 *   __429__   429 —— **只失败一次**，用来验证重试确实发生了
 *   __500__   500（上游故障，重试后仍失败）
 *   __SLOW__  延迟 5 秒才吐第一个字，用来打超时
 *   __EMPTY__ 200 但一个字符都不给
 *   __DELAY:800__  指定首字节延迟（毫秒），用来构造可预期的乱序完成
 *
 * 用法：
 *   node scripts/mock-deepseek.mjs            # 独立跑，监听 4399
 *   import { startMockUpstream } from './mock-deepseek.mjs'   # 被验收脚本拉起
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 4399;
/** 每个分片之间的间隔。不设 0 —— 我们要的是"真的像流"，不是一次性吐完 */
const CHUNK_DELAY_MS = 4;
const CHUNK_SIZE = 4;
/** __SLOW__ 的延迟，要明显大于验收脚本里设的超时（1500ms） */
const SLOW_MS = 5000;

export async function startMockUpstream({ port = 0 } = {}) {
  /** 记录收到的请求，验收脚本靠它断言"重试确实发生了第二发" */
  const requests = [];
  /** __429__ 只失败一次的记账：同一条文本放行第二次 */
  const seenOnce = new Set();

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad json' } }));
        return;
      }

      const auth = req.headers.authorization ?? '';
      const userText = payload.messages?.find((m) => m.role === 'user')?.content ?? '';
      const systemText = payload.messages?.find((m) => m.role === 'system')?.content ?? '';
      const targetLang = /翻译成([^。\n]+)。/.exec(systemText)?.[1] ?? '未知语言';

      requests.push({
        auth,
        model: payload.model,
        stream: payload.stream,
        systemText,
        userText,
        maxTokens: payload.max_tokens,
        temperature: payload.temperature,
        roleOrder: (payload.messages ?? []).map((m) => m.role),
      });

      // 连鉴权格式都不对，直接拒 —— 顺带看住"哪个 message 先进去"这类低级错误
      if (!auth.startsWith('Bearer ')) {
        sendError(res, 401, 'missing bearer token');
        return;
      }

      if (userText.includes('__401__')) return sendError(res, 401, 'invalid api key');
      if (userText.includes('__402__')) return sendError(res, 402, 'insufficient balance');
      if (userText.includes('__500__')) return sendError(res, 500, 'internal server error');
      if (userText.includes('__429__') && !seenOnce.has(userText)) {
        seenOnce.add(userText);
        return sendError(res, 429, 'rate limit exceeded');
      }

      const explicitDelay = /__DELAY:(\d+)__/.exec(userText);
      const delay = userText.includes('__SLOW__')
        ? SLOW_MS
        : explicitDelay
          ? Number(explicitDelay[1])
          : 0;
      const translated = userText.includes('__EMPTY__') ? '' : `【${targetLang}】${userText}`;
      streamText(res, translated, delay);
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${actualPort}`,
    requests,
    async close() {
      // 必须先掐掉在途连接：超时用例里有个 5 秒的定时器还没到点，
      // 只调 close() 会挂在那儿等它自然结束
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 以 SSE 分片吐一段文本，尾帧 `[DONE]` —— 与真实上游的形状一致 */
function streamText(res, text, initialDelayMs) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // 客户端可能在中途断开（服务端超时会 abort），此时 write 会抛。
  // 这里统一咽掉：Mock 的职责是"提供契约"，不是"处理断线"。
  const write = (frame) => {
    try {
      res.write(frame);
    } catch {
      /* 忽略 */
    }
  };

  const finish = () => {
    write('data: [DONE]\n\n');
    try {
      res.end();
    } catch {
      /* 忽略 */
    }
  };

  // 首字节延迟与分片间隔分开：__SLOW__ 要的是"半天不说话"，
  // 不是"每个字都慢"，后者的总耗时会被分片数放大成不可控
  const start = () => {
    if (!text) return finish();

    let index = 0;
    const timer = setInterval(() => {
      if (index >= text.length) {
        clearInterval(timer);
        return finish();
      }
      const piece = text.slice(index, index + CHUNK_SIZE);
      index += CHUNK_SIZE;
      write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }, CHUNK_DELAY_MS);
  };

  if (initialDelayMs > 0) setTimeout(start, initialDelayMs);
  else start();
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  // 形状与真实上游一致：`{ error: { message, type, code } }`
  res.end(JSON.stringify({ error: { message, type: 'mock_error', code: String(status) } }));
}

// ---- 独立运行 ----
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const { baseUrl } = await startMockUpstream({ port: DEFAULT_PORT });
  console.log(`Mock DeepSeek 上游已启动：${baseUrl}`);
  console.log(`接到服务端：DEEPSEEK_BASE_URL=${baseUrl}`);
}
