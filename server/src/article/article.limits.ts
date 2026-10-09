import { AppError } from '../common/errors';
import {
  RateLimiter,
  limitErrorCode,
  readLimitNumber,
  type LimitReason,
  type LimitSpec,
} from '../common/rate-limit';

/**
 * `/api/article` 的配额闸门。
 *
 * ## 为什么抓取这条链路也要限流
 *
 * 它不花上游的钱（成本是带宽 + 出网 IP 的声誉），但它是**对外发请求**的那个口子：
 * 一个循环脚本能在几分钟内把我们的 IP 打到目标站点的黑名单上，
 * 而后果是**所有用户**一起收到 `blocked_by_site` —— 那种"突然全都抓不了了"的故障
 * 极难排查，因为表面上每个请求都返回得像目标站点的问题。
 *
 * ## 为什么这里**没有**全站日额度（`globalPerDay: 0`）
 *
 * 全站日额度是"保钱的总闸"，抓取不花钱，它保的是别的东西：
 * 而"抓取量大"在正常使用下**恰恰是好事**（有人一天读几十篇，说明这站有用）。
 * 挂一道全站日闸的后果是"某天下午开始，所有人都抓不了"，代价远大于收益。
 * 真正要防的"单点刷子"由每 IP 那两道挡 —— 频率限制让它慢，日额度让它有尽头。
 */
export const ARTICLE_LIMITS = 'ARTICLE_LIMITS';

/**
 * 默认额度。
 *
 * `perMinute: 20` 比翻译那边宽得多（6）：一次翻译是几十次上游调用，
 * 一次抓取只是一次 HTTP 请求，且**用户正常浏览一篇就要一次**（前端拿到正文才知道要不要翻）。
 * 20/分钟 相当于"一分钟点 20 个链接"，只有脚本才会到。
 *
 * `perIpPerDay: 1000` 是一次也别指望用满的量（约等于一天读 1000 篇），
 * 存在的意义只是给"慢慢刷一整天"的人一个尽头。
 */
export const DEFAULT_ARTICLE_LIMITS: LimitSpec = {
  perMinute: 20,
  perIpPerDay: 1000,
  globalPerDay: 0,
};

export function readArticleLimitSpec(get: (key: string) => string | undefined): LimitSpec {
  return {
    perMinute: readLimitNumber(get, 'ARTICLE_PER_MINUTE', DEFAULT_ARTICLE_LIMITS.perMinute),
    perIpPerDay: readLimitNumber(
      get,
      'ARTICLE_PAGES_PER_IP_PER_DAY',
      DEFAULT_ARTICLE_LIMITS.perIpPerDay,
    ),
    // 全站日额度默认关着，但配置项留着：真被打的时候（比如站被挂到某个爬虫群里）
    // 有个不用改代码就能拉上的闸
    globalPerDay: readLimitNumber(get, 'ARTICLE_PAGES_PER_DAY', DEFAULT_ARTICLE_LIMITS.globalPerDay),
  };
}

export function makeArticleLimiter(get: (key: string) => string | undefined): RateLimiter {
  return new RateLimiter(readArticleLimitSpec(get));
}

/** 与翻译那边同一套思路：带上具体数字，用户才知道是"等会儿"还是"明天" */
export function articleLimitHint(
  reason: LimitReason,
  spec: LimitSpec,
  retryAfterSec: number,
): string {
  switch (reason) {
    case 'per_minute':
      return `同一 IP 每分钟最多抓取 ${spec.perMinute} 个页面，约 ${retryAfterSec} 秒后可再试`;
    case 'per_ip_per_day':
      return `每个 IP 每天最多抓取 ${spec.perIpPerDay} 个页面，明天零点恢复`;
    case 'global_per_day':
      return `今天全站的抓取量已达上限（共 ${spec.globalPerDay} 个页面），明天零点恢复`;
  }
}

export function articleLimitError(
  reason: LimitReason,
  spec: LimitSpec,
  retryAfterSec: number,
): AppError {
  return new AppError(limitErrorCode(reason), articleLimitHint(reason, spec, retryAfterSec));
}
