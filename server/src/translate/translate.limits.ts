import { AppError } from '../common/errors';
import {
  RateLimiter,
  limitErrorCode,
  readLimitNumber,
  type LimitReason,
  type LimitSpec,
} from '../common/rate-limit';

/**
 * `/api/translate` 的额度闸门。
 *
 * 机制全在 `common/rate-limit.ts`，这里只管**这一条路径**的三件事：
 * 环境变量名、默认值、以及被拦时给用户看的那句话。
 */

/**
 * 注入 token。
 *
 * 为什么用 token 而不是直接注入 `RateLimiter` 类型：这个工程开了
 * `emitDecoratorMetadata`，构造函数里写 `private limits: RateLimiter`
 * 会被当成"去容器里找一个叫 RateLimiter 的 provider"，而它是 `new RateLimiter(spec)`
 * 造出来的（需要一个参数）—— 直接注入会报 UnknownDependenciesException。见 stats 的 `STATS_FILE`。
 */
export const TRANSLATE_LIMITS = 'TRANSLATE_LIMITS';

/**
 * 默认额度。三个数都是**按"一篇文章大约 50 个可译块"折算过的**：
 *
 * - `perMinute: 6` —— 真人一篇一篇地读，一分钟 6 次已经远超正常节奏；
 *   它挡的是"脚本没加 sleep"这种连发，不该成为正常用户的阻碍。
 * - `perIpPerDay: 1500` —— 约 30 篇文章/天。重度用户也用不完，
 *   而单点刷子一天的损失被压到 30 篇的量级。
 * - `globalPerDay: 15000` —— 约 300 篇文章/天，**这才是真正保钱的那道闸**。
 *   按免费档上游的定价，最坏情况也就一顿饭钱，不至于把额度打爆。
 *
 * 想放开就改 `.env`（这项是给公开站点用的，自己私下用可以直接配 0 关掉）。
 */
export const DEFAULT_TRANSLATE_LIMITS: LimitSpec = {
  perMinute: 6,
  perIpPerDay: 1500,
  globalPerDay: 15000,
};

export function readTranslateLimitSpec(get: (key: string) => string | undefined): LimitSpec {
  return {
    perMinute: readLimitNumber(get, 'TRANSLATE_PER_MINUTE', DEFAULT_TRANSLATE_LIMITS.perMinute),
    perIpPerDay: readLimitNumber(
      get,
      'TRANSLATE_BLOCKS_PER_IP_PER_DAY',
      DEFAULT_TRANSLATE_LIMITS.perIpPerDay,
    ),
    globalPerDay: readLimitNumber(
      get,
      'TRANSLATE_BLOCKS_PER_DAY',
      DEFAULT_TRANSLATE_LIMITS.globalPerDay,
    ),
  };
}

export function makeTranslateLimiter(get: (key: string) => string | undefined): RateLimiter {
  return new RateLimiter(readTranslateLimitSpec(get));
}

/**
 * 把"被哪道闸门拦下"翻成给用户看的一句补充说明。
 *
 * 刻意带上**具体数字和恢复时间**：只说"稍后再试"，用户只会反复刷新，
 * 反而把频率限制撞得更响。说清楚"等多久 / 为什么"，他会自己走开。
 * （主文案仍然只在 `common/errors.ts`，这里只是 `hint` 覆盖。）
 */
export function limitHint(reason: LimitReason, spec: LimitSpec, retryAfterSec: number): string {
  switch (reason) {
    case 'per_minute':
      return `同一 IP 每分钟最多 ${spec.perMinute} 次翻译请求，约 ${retryAfterSec} 秒后可再试`;
    case 'per_ip_per_day':
      return `每个 IP 每天最多翻译 ${spec.perIpPerDay} 个段落，明天零点恢复`;
    case 'global_per_day':
      return `今天全站的翻译额度已用完（共 ${spec.globalPerDay} 个段落），明天零点恢复`;
  }
}

/**
 * 被拦时抛的异常：码由共用的 `limitErrorCode` 决定（频率 / 额度），
 * 这里只负责把**具体数字**塞进 hint。
 */
export function limitError(
  reason: LimitReason,
  spec: LimitSpec,
  retryAfterSec: number,
): AppError {
  return new AppError(limitErrorCode(reason), limitHint(reason, spec, retryAfterSec));
}
