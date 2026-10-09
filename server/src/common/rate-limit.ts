import type { ErrorCode } from './errors';
import { dayKey } from '../stats/stats.types';

/**
 * 配额闸门：**每分钟次数** + **每 IP 每天单位数** + **全站每天单位数**。
 *
 * ## 为什么要有这个东西
 *
 * 这个站的所有真实成本都在上游 LLM 调用上（一次翻译 = N 个块 = N 次上游请求）。
 * 只要接口公开，就一定有两条路会把额度烧光：
 *   1. **手滑** —— 有人写个循环、或者自己的脚本忘了加 sleep；
 *   2. **滥用** —— 有人发现 `/api/translate` 不要钱，拿它当免费翻译 API 用。
 *
 * 前者靠频率限制挡住，后者只能靠日额度兜底。三道闸门的分工写在这里，避免以后改动时误伤：
 *
 * | 闸门 | 挡什么 | 为什么不能用别的替代 |
 * | --- | --- | --- |
 * | 每 IP 每分钟 | 连发 / 脚本没加 sleep | 日额度太大，一秒钟就能被刷掉一大截 |
 * | 每 IP 每天 | 单个 IP 长时间占便宜 | 只能用频率限制的话，慢慢刷的人可以刷一整天 |
 * | 全站每天 | **真正的总闸** | 每 IP 的限制对有大量 IP 的人无效（见下面 XFF 那条） |
 *
 * ## ⚠️ 为什么"每 IP"这两道闸门只能当减速带
 *
 * IP 是从 `X-Forwarded-For` 第一跳取的，而**这个头是客户端可以随便写的**
 * （见 common/ip.ts）。也就是说：
 *   - 正常用户：真实 IP，限流准确；
 *   - 恶意用户：每次请求编一个 XFF，每 IP 的额度对他完全不存在。
 *
 * 所以**全站每天那道闸门才是唯一真正保钱的**，每 IP 那两道是"提高滥用成本"。
 * 反过来说：全站日额度设得太小会把正常用户一起锁死，设得太大又失去意义 ——
 * 它得按"一天最多能烧多少钱"来定，而不是按"我觉得够用"。
 *
 * ## 预扣与回滚
 *
 * `take()` 是**预扣**：先记账再放行。反过来（先放行、成功了再记）有个致命问题 ——
 * 并发 3 意味着同一瞬间有好几块在飞，等它们回来时闸门早被穿过去了。
 * 一次请求的额度必须在**发出第一个上游调用之前**就扣掉。
 *
 * 代价是：请求中途失败时额度已经扣了。所以配一个 `refund()`，
 * 由调用方在"整体失败、一块都没交付"时退回来（分钟窗口不退，见 refund 的注释）。
 *
 * ## 边界（写清楚，别指望它做它做不到的事）
 *
 * - 计数器**在内存里**：多实例部署时各算各的；进程重启归零。当前发布形态是单进程
 *   （见 app.module.ts 的同源托管），先按单进程做。真要扩多实例，得换共享存储。
 * - 日期按**服务端本地时区**切（复用 stats 的 `dayKey`）。换个时区看会错开几小时，
 *   但"每天"这个口径必须全站一致 —— 所以不另外实现一份，直接用同一个函数。
 */

/** 分钟窗口的长度 */
export const MINUTE_WINDOW_MS = 60_000;

/** 分钟窗口最多跟踪多少个 IP。外部输入不能把内存撑爆（超出就把过期的清掉） */
const MAX_TRACKED_IPS = 5_000;

export interface LimitSpec {
  /** 每个 IP 每分钟最多几次请求。`<= 0` 表示关闭这道闸门 */
  perMinute: number;
  /** 每个 IP 每天最多几个单位。`<= 0` 表示关闭 */
  perIpPerDay: number;
  /** 全站每天最多几个单位（**总闸**）。`<= 0` 表示关闭 */
  globalPerDay: number;
}

/** 被哪道闸门挡下的 */
export type LimitReason = 'per_minute' | 'per_ip_per_day' | 'global_per_day';

/**
 * 预扣凭据。调用方拿着它才能在失败时回滚。
 *
 * 里面记了"当时实际扣了哪几笔账"：配置里把某道闸门关掉（例如抓取那条路径
 * 就没有全站日额度）时，对应那笔不该在回滚时被减 —— 减了会把它扣成负数。
 */
export interface LimitTicket {
  ip: string;
  /** 预扣的单位数 */
  units: number;
  /** 预扣发生的日期（本地时区）。跨天之后这笔账不再回滚 */
  day: string;
  chargedIpDay: boolean;
  chargedGlobal: boolean;
}

export type LimitVerdict =
  | { ok: true; ticket: LimitTicket }
  | { ok: false; reason: LimitReason; retryAfterSec: number };

export class RateLimiter {
  /** ip → 分钟窗口内最近几次请求的时间戳 */
  private readonly minutes = new Map<string, number[]>();
  /** ip → 当天累计的单位数 */
  private readonly ipDays = new Map<string, { day: string; units: number }>();
  /** 全站当天累计的单位数 */
  private global: { day: string; units: number } = { day: '', units: 0 };
  /** 上次清理分钟窗口的时间。**限流器的清理必须自己限流**（见 sweepMinutes 的调用处） */
  private lastSweepMs = 0;

  constructor(readonly spec: LimitSpec) {}

  /**
   * 判定 + 预扣。**要么全都通过并扣账，要么一个都不扣。**
   *
   * 刻意分两段（先全部判定、再统一扣账）：如果边判边扣，前三道里通过了两道、
   * 第三道拦下，前两道就已经扣出去了 —— 一次被拒的请求也吃掉额度，
   * 用户重试几次真额度就没了。
   */
  take(ip: string, units: number, now: Date = new Date()): LimitVerdict {
    const day = dayKey(now);
    this.roll(day);

    // 单位数来自调用方（可译块数 / 1），兜一下：NaN 当 0，负数取 0，
    // 小数向下取整。`Math.max(0, NaN)` 还是 NaN，别用那个写法。
    const want = Number.isFinite(units) && units > 0 ? Math.floor(units) : 0;
    const nowMs = now.getTime();

    // ---- 判定（只看不写）----
    let reason: LimitReason | null = null;
    let retryAfterSec = 0;

    if (this.spec.perMinute > 0) {
      const window = this.recentMinutes(ip, nowMs);
      if (window.length >= this.spec.perMinute) {
        reason = 'per_minute';
        // 最早那次请求滑出窗口，就空出一个名额 —— 这是最省心的等待时间建议
        retryAfterSec = Math.max(
          1,
          Math.ceil((window[0] + MINUTE_WINDOW_MS - nowMs) / 1000),
        );
      }
    }

    if (!reason && this.spec.perIpPerDay > 0 && this.ipDayUnits(ip, day) + want > this.spec.perIpPerDay) {
      reason = 'per_ip_per_day';
    }

    if (!reason && this.spec.globalPerDay > 0 && this.global.units + want > this.spec.globalPerDay) {
      reason = 'global_per_day';
    }

    if (reason) return { ok: false, reason, retryAfterSec };

    // ---- 预扣（全部通过之后一起扣）----
    const chargedMinute = this.spec.perMinute > 0;
    const chargedIpDay = this.spec.perIpPerDay > 0;
    const chargedGlobal = this.spec.globalPerDay > 0;

    if (chargedMinute) {
      const window = this.recentMinutes(ip, nowMs);
      window.push(nowMs);
      this.minutes.set(ip, window);
      // 顺手清理：被大量不同 IP 轮着打时，这张表不该无限长。
      //
      // ⚠️ 清理**自己也要限流**：被 6000 个不同 IP 打时，这张表会一直大于阈值，
      // 如果每次请求都扫一遍全表，就等于"用限流器自己把自己打垮"（O(n²)）。
      // 所以一分钟里最多扫一次 —— 反正扫掉的是"窗口外的记录"，
      // 而窗口就那么长，多扫没有额外收益。
      if (this.minutes.size > MAX_TRACKED_IPS && nowMs - this.lastSweepMs > MINUTE_WINDOW_MS) {
        this.lastSweepMs = nowMs;
        this.sweepMinutes(nowMs);
      }
    }
    if (chargedIpDay) {
      this.ipDays.set(ip, { day, units: this.ipDayUnits(ip, day) + want });
    }
    if (chargedGlobal) {
      this.global.units += want;
    }

    return { ok: true, ticket: { ip, units: want, day, chargedIpDay, chargedGlobal } };
  }

  /**
   * 回滚一次预扣。用于"整体失败、一块都没交付"的场景。
   *
   * **分钟窗口刻意不退**：它是速率限制，退回去等于允许"失败了就重试"，
   * 而重试恰恰是限流要挡的行为（而且 60 秒后它自己就过期了，没有长期影响）。
   */
  refund(ticket: LimitTicket | null | undefined, now: Date = new Date()): void {
    if (!ticket || ticket.units <= 0) return;
    // 跨天不认：今天的余额不该被昨天那笔的退款抬高
    if (ticket.day !== dayKey(now)) return;

    if (ticket.chargedIpDay) {
      const entry = this.ipDays.get(ticket.ip);
      if (entry && entry.day === ticket.day) {
        entry.units = Math.max(0, entry.units - ticket.units);
      }
    }
    if (ticket.chargedGlobal && this.global.day === ticket.day) {
      this.global.units = Math.max(0, this.global.units - ticket.units);
    }
  }

  /**
   * 当前用量。给日志和排查用 —— 被拦时把"已经用了多少 / 上限多少"打出来，
   * 比只打一句"被限流了"有用得多（前者能立刻分辨"闸门设小了"和"真的有人在刷"）。
   */
  usage(now: Date = new Date()): { day: string; globalUnits: number; trackedIps: number } {
    const day = dayKey(now);
    return {
      day,
      globalUnits: this.global.day === day ? this.global.units : 0,
      trackedIps: this.ipDays.size,
    };
  }

  /** 这个 IP 今天已经用了多少单位（只读，不扣账） */
  usedToday(ip: string, now: Date = new Date()): number {
    return this.ipDayUnits(ip, dayKey(now));
  }

  // ---- 内部 ----

  /**
   * 换天就把全站计数清零，并顺手把昨天的 IP 记录扔掉。
   *
   * 放在 `take()` 里做而不是开一个定时器：定时器要管生命周期（关停时清理），
   * 而这里"用到的时候才发现换天了"就够了 —— 一天最多触发一次，开销可以忽略。
   */
  private roll(day: string): void {
    if (this.global.day === day) return;
    this.global = { day, units: 0 };
    for (const [ip, entry] of this.ipDays) {
      if (entry.day !== day) this.ipDays.delete(ip);
    }
  }

  private recentMinutes(ip: string, nowMs: number): number[] {
    const cutoff = nowMs - MINUTE_WINDOW_MS;
    return (this.minutes.get(ip) ?? []).filter((at) => at > cutoff);
  }

  private ipDayUnits(ip: string, day: string): number {
    const entry = this.ipDays.get(ip);
    // 日期对不上就当 0：roll() 只在自己跑过之后才清，中间进来的旧条目不能算数
    return entry && entry.day === day ? entry.units : 0;
  }

  private sweepMinutes(nowMs: number): void {
    for (const [ip, stamps] of this.minutes) {
      const kept = stamps.filter((at) => at > nowMs - MINUTE_WINDOW_MS);
      if (kept.length === 0) this.minutes.delete(ip);
      else this.minutes.set(ip, kept);
    }
  }
}

/**
 * 从配置里读一个上限值。三态语义写清楚，免得以后自己踩：
 *
 * - **没配 / 空串** → 用默认值
 * - **配了 0 或负数** → **关闭这道闸门**（不限）
 * - **配了非法值**（`abc`）→ 用默认值，而不是"关掉"
 *
 * 第三条是刻意的：手滑写错时宁可继续保护，也不要静默地把闸门全打开 ——
 * "配置写错了所以没有限流"是最不容易发现的失败方式。
 *
 * 收 `get` 函数而不是 `ConfigService`，是为了不把 Nest 依赖带进这个纯逻辑文件。
 */
export function readLimitNumber(
  get: (key: string) => string | undefined,
  key: string,
  fallback: number,
): number {
  const raw = get(key)?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.floor(value);
}

/** 给启动日志用的一句话，把生效值摊开 —— 配置类问题最怕"我以为它生效了" */
export function describeLimitSpec(spec: LimitSpec): string {
  const show = (value: number): string => (value > 0 ? String(value) : '不限');
  return `每分钟 ${show(spec.perMinute)} 次 · 每 IP 每天 ${show(spec.perIpPerDay)} 单位 · 全站每天 ${show(spec.globalPerDay)} 单位`;
}

/**
 * 被拦时抛哪个码 —— 只在这里定一次（两条链路共用）。
 *
 * 频率问题与额度问题是**两种处境**：前者"等半分钟就好"，后者"今天没了"。
 * 合成一个码的话，那句固定文案必然对其中一种说谎。两者都给 429，
 * 因为从 HTTP 语义看都是"现在不行，之后可能行"；具体原因与恢复时间走 hint。
 */
export function limitErrorCode(reason: LimitReason): ErrorCode {
  return reason === 'per_minute' ? 'too_many_requests' : 'daily_limit_reached';
}
