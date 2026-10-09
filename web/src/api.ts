/**
 * 请求封装（技术方案 7.2）。
 *
 * 两条硬规矩：
 * 1. **只写同源相对路径** `/api/...` —— 开发期由 Vite 代理转发，发布期由 Nest 同源托管，
 *    一份代码两处跑，不用改配置（7.1）。这里绝不出现 `http://localhost:3000`。
 * 2. 后端的错误一律是 `{ error: { code, message, hint } }`，在这里统一转成 `ApiError`，
 *    上层只认 `code` 做分支，不解析字符串。
 */

import type {
  Article,
  ErrorCode,
  ErrorPayload,
  StatsResponse,
  TranslateEvent,
  TranslateRequest,
} from './types';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  /** HTTP 状态码；网络层失败时为 0 */
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number, hint?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

/** 用户主动取消（换了一篇、组件卸载）—— 上层不该把它当错误展示 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * 抓取并提取一篇文章。
 *
 * @param url    用户粘贴的网址（原样传，规范化交给后端，保证前后端判定一致）
 * @param signal 用于取消上一次请求
 */
export async function fetchArticle(url: string, signal?: AbortSignal): Promise<Article> {
  let res: Response;
  try {
    res = await fetch(`/api/article?url=${encodeURIComponent(url)}`, { signal });
  } catch (err) {
    // 取消要原样抛出，否则上层会把"用户换了篇文章"显示成报错
    if (isAbortError(err)) throw err;
    throw new ApiError('internal_error', '连不上服务器', 0, '检查一下网络，或稍后再试');
  }

  if (!res.ok) {
    throw await toApiError(res);
  }

  // 后端返回 200 但内容不是预期结构时，也不能让页面白屏
  try {
    return (await res.json()) as Article;
  } catch {
    throw new ApiError('internal_error', '服务器返回的数据看不懂', res.status);
  }
}

/**
 * 拉取访问统计数据（`/api/stats`，仅作者自用）。
 *
 * 鉴权走 HTTP Basic，但**前端完全不碰密码**：服务端回 `401 + WWW-Authenticate`
 * 之后是**浏览器自己**弹登录框，输一次，同一会话内后续请求都会自动带上凭证。
 * 前端要做的事只有一件 —— 把这个 401 翻译成"需要管理员身份"，别再重试。
 *
 * `503` 是"服务端没配 STATS_PASSWORD，这个接口关着"，跟"密码错了"是两回事，
 * 页面上要分开说，否则用户只会看到一个说不清的失败。
 */
export async function fetchStats(signal?: AbortSignal): Promise<StatsResponse> {
  let res: Response;
  try {
    res = await fetch('/api/stats', { signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError('internal_error', '连不上服务器', 0, '检查一下网络，或稍后再试');
  }

  if (!res.ok) throw await toApiError(res);

  try {
    return (await res.json()) as StatsResponse;
  } catch {
    throw new ApiError('internal_error', '服务器返回的数据看不懂', res.status);
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as Partial<ErrorPayload>;
    const err = body?.error;
    if (err?.code) {
      return new ApiError(err.code, err.message || '请求失败', res.status, err.hint);
    }
  } catch {
    // 落到下面的兜底
  }
  return new ApiError('internal_error', '服务器出了点问题', res.status);
}

// ============================================================================
// 翻译（SSE 回流）
// ============================================================================

/**
 * 把一整篇的块丢给后端，边收边回填。
 *
 * 为什么不用 `EventSource`：它只能发 GET，带不了请求体（整篇的块），
 * 而且拿不到 HTTP 状态码 —— 被前置校验拦下时（非英文闸门 / 密钥缺失）我们要的是
 * 那个 422 / 502 和它的 message。所以走 `fetch` + 手动读 `ReadableStream`。
 *
 * **不按到达顺序回填**：服务端并发 3，第 8 块可能先于第 3 块到。
 * 交给 `handlers.onBlock(id, text)`，由上层按 id 落到格子里。
 */
export async function streamTranslate(
  request: TranslateRequest,
  handlers: TranslateHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError('internal_error', '连不上服务器', 0, '检查一下网络，或稍后再试');
  }

  // 前置校验被拦下来时走的是普通 JSON 错误（非英文闸门 / 密钥缺失 / 入参不合法）。
  // 这些**在发流之前**就判死了，所以状态码是有意义的，别当成"流里的错误"处理。
  if (!res.ok) throw await toApiError(res);

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.body || !contentType.includes('text/event-stream')) {
    throw new ApiError('internal_error', '译文服务返回了预期外的格式', res.status);
  }

  const decoder = new TextDecoder();
  const stream = res.body as unknown as AsyncIterable<Uint8Array>;
  let buffer = '';
  let done = false;

  // 分帧靠空行。注意分片不保证按帧对齐 —— 一帧可能被劈成两个 chunk，
  // 所以必须留缓冲，不能对每个 chunk 单独切完就丢。
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    let at: number;
    while (!done && (at = buffer.indexOf('\n\n')) !== -1) {
      done = dispatchFrame(buffer.slice(0, at), handlers);
      buffer = buffer.slice(at + 2);
    }
    // 见到 [DONE] 就停：后面的字节不是我们这个协议的一部分，
    // 继续解析只会在某天把一段垃圾当成译文回填上去。
    // 和后端读上游 SSE 的写法保持一致（那边也是遇到 [DONE] 就 break）。
    if (done) break;
  }

  // 流末尾可能没有空行收尾，残留的也要处理一次
  if (!done && buffer.trim()) dispatchFrame(buffer, handlers);
}

export interface TranslateHandlers {
  /** 某块译好了 */
  onBlock(id: number, text: string): void;
  /** 某块失败（**不影响其它块**） */
  onBlockError(id: number, code: ErrorCode): void;
  /** 整篇失败（上游不可用 / 服务端配置有误），带可直接展示的文案 */
  onFatal(error: ApiError): void;
}

/**
 * 处理一帧。返回 `true` 表示这一帧里见到了收尾标记 `[DONE]`。
 *
 * 强调一下"见过 [DONE] 就停"这件事：不返回状态、继续往下解析也能跑，
 * 但那样就等于假设"服务器在 [DONE] 之后不会再发任何东西"。这个假设今天成立，
 * 某天不会 —— 那时多出来的字节会被当成译文回填到某个格子里，而且在界面上
 * 看起来完全正常。宁可在这里停住。
 */
function dispatchFrame(frame: string, handlers: TranslateHandlers): boolean {
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue; // 空行、`: keep-alive` 之类

    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') return true;

    let event: TranslateEvent;
    try {
      event = JSON.parse(payload) as TranslateEvent;
    } catch {
      continue; // 单个坏帧不至于废掉整篇
    }
    routeEvent(event, handlers);
  }
  return false;
}

function routeEvent(event: TranslateEvent, handlers: TranslateHandlers): void {
  // 靠 `'id' in event` 区分三态，与后端契约一一对应
  if ('id' in event) {
    if ('error' in event) {
      handlers.onBlockError(event.id, event.error.code);
    } else {
      handlers.onBlock(event.id, event.text);
    }
    return;
  }

  const { code, message, hint } = event.error;
  handlers.onFatal(new ApiError(code, message || '翻译失败', 200, hint));
}
