import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, type ErrorCode } from '../common/errors';

/**
 * DeepSeek 上游客户端（技术方案 5.1）。
 *
 * 直接用 Node 原生 `fetch`，不引 SDK —— OpenAI 兼容接口本来就是几个字段的事，
 * 引一个 SDK 反而多一层版本与类型负担。
 *
 * 这一层只做三件事，业务语义（翻译、提示词、并发）全在上层：
 *   1. 发请求（流式）
 *   2. 把 SSE 分片拼回完整文本
 *   3. 把上游的各种失败**归一成我们的错误码**
 */

/** 用配置项覆盖是为了让本地 Mock 上游能顶替真实上游 —— 这是端到端测试唯一的入口 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/**
 * 默认模型。
 *
 * 注意：`deepseek-chat` / `deepseek-reasoner` 这两个名字**已经废弃**。
 * 当前档位是 `deepseek-flash`（另有 `deepseek-v4-pro`，约 4 倍价）。
 * 翻译是"照着说一遍"的活，flash 档足够。
 *
 * 另注：`deepseek-v4-flash` 现在也进了 legacy 名单 —— 官方文档的原文是
 * "the legacy names ... are still accepted, but the corresponding models have been retired,
 * their requests are served by the DeepSeek-V4.1-Flash model"。
 * 也就是说旧名字**还能用**（请求会被V4.1-Flash接管、按 Flash 计价），
 * 但既然官方给了新名字，就没理由继续用旧的 —— 这种"还能用但已经不建议"的
 * 名字最容易在某天静默变行为。
 */
const DEFAULT_MODEL = 'deepseek-flash';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Mock 密钥前缀。**只用来打一行提示日志**，不改变任何行为 ——
 * 换句话说，用 Mock 密钥跑，链路是完整真实地打到上游然后被拒的，
 * 不是"看到 Mock 就返回假译文"。否则测试就失去意义了。
 */
const MOCK_KEY_PREFIX = 'sk-MOCK';

export interface CompleteOptions {
  /** 外部取消信号（客户端断开时由控制器触发） */
  signal?: AbortSignal;
  /** 覆盖默认超时 */
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

@Injectable()
export class DeepSeekService {
  private readonly logger = new Logger(DeepSeekService.name);
  private readonly config: ResolvedConfig;

  constructor(configService: ConfigService) {
    this.config = {
      apiKey: (configService.get<string>('DEEPSEEK_API_KEY') ?? '').trim(),
      baseUrl: (configService.get<string>('DEEPSEEK_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      model: (configService.get<string>('DEEPSEEK_MODEL') ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
      timeoutMs: Number(configService.get<string>('DEEPSEEK_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS),
    };

    if (!this.config.apiKey) {
      this.logger.warn('未配置 DEEPSEEK_API_KEY，翻译请求会在入口被拒（translate_auth_failed）');
    } else if (this.config.apiKey.startsWith(MOCK_KEY_PREFIX)) {
      // 只打前缀，绝不打完整密钥
      this.logger.warn(
        `当前使用 Mock 密钥（${MOCK_KEY_PREFIX}…）：调用上游会返回 401，这是预期行为。` +
          `接真实密钥请改 server/.env 的 DEEPSEEK_API_KEY。`,
      );
    }

    this.logger.log(`上游就绪 model=${this.config.model} base=${safeHost(this.config.baseUrl)}`);
  }

  get hasApiKey(): boolean {
    return this.config.apiKey.length > 0;
  }

  get model(): string {
    return this.config.model;
  }

  /**
   * 一次完整的补全，返回拼好的文本。
   *
   * 上游走 `stream: true`：虽然我们对前端是按**块**回流的（技术方案 5.2），
   * 用它真实地等到最后一帧是没必要的，但流式能让我们在"收了半截就断掉"时
   * 立刻拿到失败信号，而不用干等到整体超时。
   */
  async complete(system: string, user: string, options: CompleteOptions = {}): Promise<string> {
    if (!this.config.apiKey) throw new AppError('translate_auth_failed');

    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    // 外部信号（客户端断开）转接到我们自己的 controller 上：
    // 用户关掉标签页之后上游还在生成，那部分额度是白烧的。
    const onExternalAbort = (): void => controller.abort();
    if (options.signal?.aborted) {
      clearTimeout(timer);
      throw new AppError('translate_unavailable');
    }
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await this.request(system, user, options, controller.signal);
      return await this.readStream(response);
    } catch (err) {
      throw this.normalize(err, timedOut);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private async request(
    system: string,
    user: string,
    options: CompleteOptions,
    signal: AbortSignal,
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: true,
      temperature: options.temperature,
      messages: [
        // 顺序不能反：`system` 必须在 `messages[0]`，这是上游的硬要求
        { role: 'system', content: system },
        // 用户/网页内容**只**能进 user —— 进 system 就等于把指令权交出去了
        { role: 'user', content: user },
      ],
    };
    if (options.maxTokens) body.max_tokens = options.maxTokens;

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      // 错误体是 `{ error: { message, type, code } }`，我们只把它记进日志，
      // **不往上传** —— 上游的原始错误对前端没有意义，还可能夹带内部信息
      const raw = await response.text().catch(() => '');
      this.logger.warn(`上游返回 ${response.status}：${truncate(raw, 300)}`);
      throw new AppError(mapStatusToCode(response.status));
    }

    return response;
  }

  /**
   * 读 SSE，逐行解析，把 `choices[0].delta.content` 拼起来。
   *
   * 两个容易踩的点：
   * - **分片不保证按行对齐**，一个 JSON 可能被劈成两个 chunk，所以必须留行缓冲，
   *   不能对每个 chunk 单独 `split('\n')` 完就丢。
   * - 流末尾可能没有换行符，循环结束后要把残留缓冲再处理一次。
   */
  private async readStream(response: Response): Promise<string> {
    if (!response.body) throw new AppError('translate_unavailable');

    const decoder = new TextDecoder('utf-8');
    const stream = response.body as unknown as AsyncIterable<Uint8Array>;

    let text = '';
    let buffer = '';

    const consume = (line: string): boolean => {
      const trimmed = line.trim();
      // 注释行（`: keep-alive`）与空行直接跳过
      if (!trimmed.startsWith('data:')) return false;

      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return true;
      if (!payload) return false;

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        // 单个分片坏掉不至于废掉整段：跳过它，后面的分片接着拼
        this.logger.debug(`跳过无法解析的 SSE 分片：${truncate(payload, 120)}`);
        return false;
      }

      const delta = pickDelta(parsed);
      if (delta) text += delta;
      return false;
    };

    // 收到 `[DONE]` 就退出发送循环。
    // 用 `break` 而不是 `return`：for-await 的 break 会调用迭代器的 `return()`，
    // 它会 cancel 掉底层 ReadableStream、释放连接；提前 return 则会留下一个
    // 没读完的 socket。
    let finished = false;
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });

      let newlineAt: number;
      while ((newlineAt = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        if (consume(line)) {
          finished = true;
          break;
        }
      }
      if (finished) break;
    }

    if (!finished) {
      // 流是自己结束的（没等到 `[DONE]`），把最后一段没有换行符的残留处理掉
      buffer += decoder.decode();
      if (buffer) consume(buffer);
    }

    if (!text) {
      this.logger.warn('上游返回 200 但没解析出任何内容');
      throw new AppError('translate_unavailable');
    }
    return text;
  }

  /** 把各种失败收敛到我们的错误码上（技术方案 5.6） */
  private normalize(err: unknown, timedOut: boolean): AppError {
    if (err instanceof AppError) return err;

    if (timedOut || isAbortError(err)) {
      return new AppError(timedOut ? 'translate_timeout' : 'translate_unavailable');
    }

    const code = errnoOf(err);
    this.logger.warn(`上游请求失败 errno=${code ?? 'unknown'}：${truncate(String(err), 200)}`);

    switch (code) {
      case 'ETIMEDOUT':
      case 'ESOCKETTIMEDOUT':
      case 'UND_ERR_CONNECT_TIMEOUT':
      case 'UND_ERR_HEADERS_TIMEOUT':
      case 'UND_ERR_BODY_TIMEOUT':
        return new AppError('translate_timeout');
      default:
        // ENOTFOUND / ECONNREFUSED / ECONNRESET / EPIPE …… 全是"这一会儿打不通"。
        // 它们和 timeout 的区别对用户没有意义，都归到"稍后重试"。
        return new AppError('translate_unavailable');
    }
  }
}

// ============================================================================
// 纯函数
// ============================================================================

/** HTTP 状态码 → 我们的错误码 */
function mapStatusToCode(status: number): ErrorCode {
  if (status === 401) return 'translate_auth_failed';
  if (status === 402) return 'translate_quota';
  if (status === 429) return 'translate_rate_limited';
  // 4xx 里的其余状态（400 参数不对、404 模型名写错）本质上都是我们这边的配置/代码问题，
  // 对用户而言和"服务暂时不可用"没有区别，不单独开码
  return 'translate_unavailable';
}

/** 从一帧 SSE JSON 里取出增量文本 */
function pickDelta(parsed: unknown): string {
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const delta = (choices[0] as { delta?: { content?: unknown } }).delta;
  const content = delta?.content;
  return typeof content === 'string' ? content : '';
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

/**
 * 顺着 `cause` 链找 errno。
 *
 * `fetch` 失败时抛的是 `TypeError: fetch failed`，真正的 errno 藏在两层 cause 里，
 * 只看最外层永远只能拿到一个 'fetch failed'。
 */
function errnoOf(err: unknown): string | undefined {
  let cursor: unknown = err;
  for (let depth = 0; depth < 5 && cursor; depth++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

/** 日志里只留主机名，不把完整 URL（可能带查询串）铺开 */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
