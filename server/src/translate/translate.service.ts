import { Inject, Injectable, Logger } from '@nestjs/common';
import { MIN_SAMPLE_CHARS, detectPageLang } from '../common/lang';
import { AppError, type ErrorCode } from '../common/errors';
import type { LimitTicket, RateLimiter } from '../common/rate-limit';
import { LlmService } from './llm.service';
import { buildSystemPrompt, normalizeTargetLang } from './langs';
import { TRANSLATE_LIMITS, limitError } from './translate.limits';
import {
  CONCURRENCY,
  MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  TEMPERATURE,
  estimateMaxTokens,
  isRetryable,
  needsTranslation,
} from './translate.constants';
import type { TranslateRequestDto } from './translate.dto';

/**
 * 回流给前端的一条事件。与技术方案 5.2 的 SSE 形状一一对应：
 *
 *   { "id": 2, "text": "……" }                              成功
 *   { "id": 2, "error": { "code": "translate_timeout" } }   单块失败
 *   { "error": { "code", "message", "hint" } }              整体失败（无 id，带完整文案）
 *
 * 单块失败**不中断整条流**（技术方案 5.3「逐段独立」）：一篇文章 200 块，
 * 有一块超时就让用户整篇看不到译文，是明显不划算的。
 * 前端靠 `'id' in event` 就能区分这三者。
 *
 * 单块失败只给 `code`（前端统一显示"这段没译出来"，不需要具体原因）；
 * 整体失败才带完整文案 —— 一次而已，多几十字节换"文案只有一处定义"很值。
 */
export type TranslateEvent =
  | { id: number; text: string }
  | { id: number; error: { code: ErrorCode } }
  | { error: { code: ErrorCode; message: string; hint?: string } };

@Injectable()
export class TranslateService {
  private readonly logger = new Logger(TranslateService.name);

  constructor(
    private readonly llm: LlmService,
    // token 注入而不是按类型注入：`emitDecoratorMetadata` 下写 `RateLimiter`
    // 会被当成"去容器里找一个叫 RateLimiter 的 provider"，而它是带构造参数的工厂产物
    @Inject(TRANSLATE_LIMITS) private readonly limits: RateLimiter,
  ) {}

  /**
   * 发流**之前**能做完的所有检查。
   *
   * 单独拎出来是因为 SSE 有个不可逆的时点：一旦 `flushHeaders()`，
   * 状态码就定死了，此时再失败也没法退回一个干净的 JSON 错误 —— 只能在流里塞错误事件。
   * 所以凡是能在流之前判死的，必须在这里判死。
   *
   * 返回的是**额度预扣凭据**（没扣到就是 null）。调用方留着它，
   * 在"整体失败、一块都没交付"时用来 `refund()`。
   */
  preflight(dto: TranslateRequestDto, ip: string): LimitTicket | null {
    // 1) 凭证。没有密钥就没必要往后走，也不该让用户等到超时才看到失败
    if (!this.llm.hasApiKey) {
      throw new AppError('translate_auth_failed');
    }

    // 2) 语言闸门（技术方案 5.2 / 5.6）—— **零上游调用**
    //
    // 正常路径下前端拿到 /api/article 的 isEnglish 就不会发这个请求，
    // 这道闸门存在的意义是**服务端自保**：挡住绕过前端直接调接口刷额度的人。
    //
    // 注意只在样本足够时才敢拦。样本不足时 detectPageLang 会返回 unknown，
    // 那是"判不出来"，不是"确认不是英文" —— 拿它拒绝请求会误伤短内容。
    const joined = dto.blocks.map((block) => block.text).join('\n');
    const verdict = detectPageLang(joined);
    if (verdict.sampleChars >= MIN_SAMPLE_CHARS && !verdict.isEnglish) {
      this.logger.warn(
        `入口闸门拦截：判定为 ${verdict.lang}（cjk=${verdict.cjkRatio.toFixed(2)}，样本 ${verdict.sampleChars} 字）`,
      );
      throw new AppError('source_not_english');
    }

    // 3) 额度闸门（技术方案 7.8.1）—— 同样零上游调用
    //
    // 放在**语言闸门之后**，顺序是有意的：被语言闸门拦下的请求一块都不该扣。
    // 反过来先扣额度再判语言，等于"判断不了的文章也记账"，而那道闸门挡下的量
    // （有人拿中文页试）在统计里并不小。
    //
    // 计费的量是**可译块数**而不是 `blocks.length`：真正发出去的上游请求数
    // 由 `needsTranslation` 过滤之后才定（见下面的 translate()），
    // 按 blocks.length 收会把图片块、纯符号行这些本来就跳过的也算进去。
    const billable = dto.blocks.filter((block) => needsTranslation(block.text)).length;
    const limitVerdict = this.limits.take(ip, billable);
    if (!limitVerdict.ok) {
      const spec = this.limits.spec;
      // 被拦时把三个数一起打出来：能一眼分辨"闸门设小了"（该 IP 用量远小于上限）
      // 和"真的有人在刷"（某个 IP 顶到上限、或者全站额度见底）
      this.logger.warn(
        `额度闸门拦截：${limitVerdict.reason}（ip=${ip} 本次 ${billable} 块 · ` +
          `全站今日 ${this.limits.usage().globalUnits}/${spec.globalPerDay} · ` +
          `该 IP 今日 ${this.limits.usedToday(ip)}/${spec.perIpPerDay}）`,
      );
      throw limitError(limitVerdict.reason, spec, limitVerdict.retryAfterSec);
    }

    return limitVerdict.ticket;
  }

  /**
   * 回滚一次预扣 —— 只在"整体失败、一块都没交付"时调用。
   *
   * 三种情况**刻意不退**，因为额度已经被真实花掉了：
   * 1. 客户端中途关掉标签页（用户不看了，但并发池已经发出去的块回不来）；
   * 2. 单块失败（那是逐块独立的，其余块照常翻完了）；
   * 3. 流正常跑完。
   * 分钟窗口一律不退（理由见 common/rate-limit.ts 的 refund）。
   */
  refund(ticket: LimitTicket | null): void {
    this.limits.refund(ticket);
  }

  /**
   * 逐块翻译，**谁先译完谁先出去**。
   *
   * 并发 3 意味着回流顺序天然是乱的 —— 第 8 块可能比第 3 块先到。
   * 这是刻意的：前端按 `id` 回填到对应的格子，不依赖到达顺序，
   * 于是慢的那一块不会拖住整屏译文。
   */
  async *translate(
    dto: TranslateRequestDto,
    signal: AbortSignal,
  ): AsyncGenerator<TranslateEvent> {
    const targetLang = normalizeTargetLang(dto.targetLang);
    const system = buildSystemPrompt(targetLang);

    // 跳过不可译的块：纯数字、纯符号、过短文本。发出去也是白花钱（技术方案 5.3）
    const jobs = dto.blocks.filter((block) => needsTranslation(block.text));
    const skipped = dto.blocks.length - jobs.length;

    this.logger.log(
      `翻译 targetLang=${targetLang} 块=${dto.blocks.length} 可译=${jobs.length} ` +
        `跳过=${skipped} 站点=${describeHost(dto.url)} model=${this.llm.model}`,
    );

    if (jobs.length === 0) return;

    // ---- 用一个最简单的"队列 + 唤醒"把并发结果按完成顺序转成异步流 ----
    const queue: TranslateEvent[] = [];
    let wake: (() => void) | null = null;
    let poolSettled = false;
    let cursor = 0;

    const emit = (event: TranslateEvent): void => {
      queue.push(event);
      const resolve = wake;
      wake = null;
      resolve?.();
    };

    const worker = async (): Promise<void> => {
      // `cursor++` 在单线程的 JS 里是安全的：取号和自增之间没有 await，
      // 不存在两个 worker 拿到同一个 job 的可能
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        try {
          const text = await this.translateBlock(job.text, system, signal);
          emit({ id: job.id, text });
        } catch (err) {
          // 单块失败在这里被吃掉，只发一条错误事件。流继续。
          const code: ErrorCode = err instanceof AppError ? err.code : 'translate_unavailable';
          this.logger.warn(`块 #${job.id} 翻译失败：${code}`);
          emit({ id: job.id, error: { code } });
        }
      }
    };

    const pool = Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()),
    ).then(() => {
      poolSettled = true;
      const resolve = wake;
      wake = null;
      resolve?.();
    });

    while (!poolSettled || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }

    await pool;
  }

  /**
   * 单块翻译，失败重试 1 次。
   *
   * 只重试"等一下可能有救"的错误：限流、上游 5xx、超时。
   * 401 / 402 重试一百次也是同样的结果，直接抛出去，别浪费用户的时间。
   */
  private async translateBlock(
    text: string,
    system: string,
    signal: AbortSignal,
  ): Promise<string> {
    let lastError = new AppError('translate_unavailable');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.llm.complete(system, text, {
          signal,
          maxTokens: estimateMaxTokens(text),
          temperature: TEMPERATURE,
        });
      } catch (err) {
        lastError = err instanceof AppError ? err : new AppError('translate_unavailable');
        if (attempt === MAX_ATTEMPTS || !isRetryable(lastError.code)) break;

        // 指数退避：400ms → 800ms
        const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        this.logger.debug(`第 ${attempt} 次失败（${lastError.code}），${delayMs}ms 后重试`);
        await sleep(delayMs, signal);
      }
    }

    throw lastError;
  }
}

// ============================================================================
// 纯函数
// ============================================================================

/** 可被 abort 打断的等待 —— 客户端断开后别让 worker 还在这儿睡够退避时间 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** 日志里只留主机名：完整 URL 又长又可能带查询串，铺在日志里没意义 */
function describeHost(raw?: string): string {
  if (!raw) return '-';
  try {
    return new URL(raw).host;
  } catch {
    return 'invalid';
  }
}
