import { createHash } from 'node:crypto';

/**
 * 访问统计的数据形状与纯函数。
 *
 * 这一层**不碰 Nest、不碰文件系统** —— 统计里最容易写错的几件事
 * （计数上限、跨天切换、访客去重）全都落在这里，可以离线单测。
 *
 * 关于"独立性"：这个模块是**观测**，不参与业务。它挂掉或写盘失败**不能**
 * 影响抓取与翻译 —— 所以所有记录方法都不抛异常、不返回值（见 stats.service.ts）。
 */

/** 一天的全部聚合数据 */
export interface DayStats {
  /** YYYY-MM-DD。按**服务端本地时区**切分，所以换时区看会错开几小时 */
  date: string;

  // ---- 页面 ----
  pageViews: number;
  /** 页面路径 → 次数。当前 SPA 只有 `/`，留着是为了以后加页面时不用改结构 */
  paths: Record<string, number>;
  /** 来源站点（Referer 的 host）→ 次数。用来分辨"从哪儿点进来的" */
  referrers: Record<string, number>;
  /** 带 `?url=` 直达阅读态的访问次数 —— 衡量"分享链接"这条路径有没有人用 */
  directLinks: number;

  // ---- 抓取 ----
  articleTotal: number;
  /** 其中成功的有多少（失败的原因看 articleErrors） */
  articleOk: number;
  /** 归一化错误码 → 次数（就是 common/errors.ts 那套，前端认的同一套码） */
  articleErrors: Record<string, number>;
  /**
   * 抓取过的**完整 URL** → 次数。
   *
   * 曾经这里存的是 host（只到域名）。改成完整 URL 是因为看板上"抓了哪些页面"
   * 比"抓了哪些站"有用得多 —— 尤其排查失败时，域名根本定位不到具体那一篇。
   * 代价是基数大得多（每篇文章一个键），所以照旧吃 `MAX_KEYS` 的上限，
   * 长尾的一次性 URL 会被挤掉 —— 对"看趋势"没影响，对"看刚才那条"有影响，
   * 后者由下面的 articleFailures 兜住。
   */
  articleUrls: Record<string, number>;

  /**
   * 失败的抓取明细（**完整 URL + 错误码 + 时间**），最近的在前。
   *
   * 为什么要单独存一份而不是只留上面那个按错误码的计数：
   * 计数能告诉你"失败了 4 次，都是 blocked_by_site"，但答不了
   * "**到底是哪 4 个页面**" —— 而后者才是排查时真正要的东西。
   *
   * 有上限（`MAX_FAILURES_PER_DAY`），存不下就丢最旧的。
   */
  articleFailures: FailureEntry[];

  // ---- 翻译 ----
  translateTotal: number;
  /** 累计发出的待译块数。**这才是真正花额度的量**，光看请求数会低估成本 */
  translateBlocks: number;
  /** 目标语言 → 次数 */
  translateLangs: Record<string, number>;
  /** 翻译过的**完整 URL** → 次数（理由同 articleUrls） */
  translateUrls: Record<string, number>;
  /** 被入口语言闸门挡下的次数 → 有多少人在拿非英文页试 */
  translateRejects: Record<string, number>;

  /**
   * 当日访客指纹（**已加盐哈希，存不下原始 IP**）。
   * 只用来算"独立访客"，不对外展示。
   */
  visitors: string[];
  /** 当日哈希盐。每天换一次，于是同一个人跨天的指纹对不上（不追踪） */
  salt: string;
}

/**
 * 一次失败的抓取。
 *
 * **只存错误码，不存文案** —— 文案的唯一来源是 `common/errors.ts`，
 * 在出接口的时候现解析（见 stats.api.ts）。存进来就等于抄了第二份，
 * 以后改文案会出现"当天之前的是旧的、之后的是新的"。
 */
export interface FailureEntry {
  /** 规范化后的完整 URL */
  url: string;
  /** `common/errors.ts` 里的错误码 */
  code: string;
  /** 发生时间（ISO 8601），页面上按本地时区显示 */
  at: string;
}

/** 单个维度最多记多少个取值 —— 路径和域名都是外部输入，统计表不能无上限长 */
export const MAX_KEYS = 200;

/** 每天最多保留多少条失败明细。到顶就丢最旧的 —— 要看的是"刚才那条为什么挂了" */
export const MAX_FAILURES_PER_DAY = 100;

/** URL 作为键最多留多长。真实 URL 很少过 300，给足余量但不给垃圾输入留空子 */
export const MAX_URL_LENGTH = 500;

/** 每天最多记多少个访客指纹。到顶就只计数、不再去重，避免被刷爆内存与磁盘 */
export const MAX_VISITORS_PER_DAY = 2000;

/** 保留多少天。再老的直接丢 —— 这个 json 是整份重写的，不能无限长 */
export const RETAIN_DAYS = 60;

/** 概要：给 /api/stats 用的只读快照 */
export interface StatsSnapshot {
  generatedAt: string;
  /** 数据文件路径。**只给服务端自己看**，出接口时会摘掉 */
  filePath: string;
  /** 按日期升序，最多 RETAIN_DAYS 天 */
  days: DayStats[];
}

/**
 * 计数器 +1。
 *
 * 满了以后挤掉**当前计数最小**的那个，而不是最早的 ——
 * 只出现一次的路径/域名里，扫描器打的占大多数，为它们占位不值。
 * （代价是偶尔会把一个正常的长尾项挤掉，对"看趋势"这件事没有影响。）
 */
export function bump(map: Record<string, number>, key: string, cap = MAX_KEYS): void {
  const current = map[key];
  if (current !== undefined) {
    map[key] = current + 1;
    return;
  }

  const keys = Object.keys(map);
  if (keys.length >= cap) {
    let minKey = keys[0];
    let minValue = map[minKey];
    for (const k of keys) {
      if (map[k] < minValue) {
        minValue = map[k];
        minKey = k;
      }
    }
    delete map[minKey];
  }

  map[key] = 1;
}

/** 本地时区的 YYYY-MM-DD（不用 toISOString —— 那是 UTC，会让"今天"提前/推后 8 小时） */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function emptyDay(date: string, salt: string): DayStats {
  return {
    date,
    pageViews: 0,
    paths: {},
    referrers: {},
    directLinks: 0,
    articleTotal: 0,
    articleOk: 0,
    articleErrors: {},
    articleUrls: {},
    articleFailures: [],
    translateTotal: 0,
    translateBlocks: 0,
    translateLangs: {},
    translateUrls: {},
    translateRejects: {},
    visitors: [],
    salt,
  };
}

/**
 * 把用户给的地址归一成"用来统计的键"。
 *
 * 两件事：
 * - **丢掉 `#fragment`**：它本来就不发给服务器，留着只会把同一个页面拆成两个键
 * - **截断到 `MAX_URL_LENGTH`**：这是外部输入，一个几 KB 的畸形串不该把统计文件撑大
 *
 * 解析不了的（用户输入了 `not a url` 之类，`invalid_url` 那条路径）就原样截断存下来 ——
 * 失败明细里看到"用户到底输了什么"比看到空白有用。
 *
 * 注意 query **保留**：像 `?id=123` 这种没有 query 就定位不到具体页面。
 * 代价是带跟踪参数的链接会各算一份，这个取舍写在 README 里。
 */
export function urlKey(raw: string): string {
  const input = (raw ?? '').trim();
  if (!input) return '(空)';

  let cleaned = input;
  try {
    const url = new URL(input);
    url.hash = '';
    cleaned = url.toString();
  } catch {
    // 解析不了就原样用，下面统一截断
  }

  return cleaned.length > MAX_URL_LENGTH ? `${cleaned.slice(0, MAX_URL_LENGTH)}…` : cleaned;
}

/**
 * 访客指纹。**原始 IP 与 UA 都不落盘**，只落这个 16 位摘要；
 * 盐每天换一次，所以连"这个人昨天来过"都推不出来。
 *
 * 不用 IP 直接当标识：运营商 NAT 下整栋楼共用一个出口 IP，那样算出来的
 * "独立访客"会严重偏低。加 UA 能把同一出口的不同设备大致分开。
 */
export function visitorHash(salt: string, ip: string, ua: string): string {
  return createHash('sha256').update(`${salt}|${ip}|${ua}`).digest('hex').slice(0, 16);
}

/**
 * 取一个 URL 的 host。取不到就返回 null（而不是把脏串直接记下来）。
 *
 * 用在两处：Referer 头（"从哪儿点进来的"）与 `/api/translate` 的 `url` 字段
 * （"哪个页面在烧额度"）。两处都只需要 host —— 完整 URL 可能带查询串，
 * 铺开记既没意义又容易把统计文件撑大。
 */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** 按次数倒序取前 n 项（并列时按键名排，保证同一份数据每次渲染顺序一致） */
export function topEntries(map: Record<string, number>, n: number): Array<[string, number]> {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}

/** 求和：概览卡片要跨天累加 */
export function sumBy(days: readonly DayStats[], pick: (day: DayStats) => number): number {
  return days.reduce((acc, day) => acc + pick(day), 0);
}

/** 把若干天的同名 map 合并成一个（用于错误码 / 语言 / 域名这类分布） */
export function mergeMaps(
  days: readonly DayStats[],
  pick: (day: DayStats) => Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const day of days) {
    for (const [key, value] of Object.entries(pick(day))) {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return merged;
}
