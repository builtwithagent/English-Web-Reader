import { ERROR_SPEC, type ErrorCode } from '../common/errors';
import { MAX_FAILURES_PER_DAY, RETAIN_DAYS, sumBy, type DayStats, type StatsSnapshot } from './stats.types';

/**
 * `/api/stats` 的响应形状。
 *
 * 后端只负责**把数据整理干净**，怎么画由前端决定（`web/src/pages/StatsPage.tsx`）。
 * 这样加一张图、换一种排布都不用动服务端。
 *
 * 相对落盘快照做了三处裁剪，都不是随手的：
 * - **去掉 `filePath`**：服务端文件路径没必要给浏览器，给出去只是白送一点内部信息；
 * - **每天去掉 `salt`**：那是给访客指纹加盐用的，属于服务端内部状态；
 * - **`visitors` 从指纹数组折成数量**：页面要的只是"今天几个人"，
 *   把一份可枚举的指纹列表发到浏览器没有意义（哪怕它已经加过盐）。
 */

export interface StatsDay {
  date: string;
  pageViews: number;
  /** 当日独立访客数（指纹已去重，只给数量） */
  visitors: number;
  paths: Record<string, number>;
  referrers: Record<string, number>;
  directLinks: number;
  articleTotal: number;
  articleOk: number;
  articleErrors: Record<string, number>;
  /** 抓取过的完整 URL → 次数 */
  articleUrls: Record<string, number>;
  /** 失败明细（最近的在前）。自带可读文案 */
  articleFailures: StatsFailure[];
  translateTotal: number;
  translateBlocks: number;
  translateLangs: Record<string, number>;
  /** 翻译过的完整 URL → 次数 */
  translateUrls: Record<string, number>;
  translateRejects: Record<string, number>;
}

/**
 * 一条失败明细。
 *
 * `message` / `hint` 是**服务端现解析**出来的，不是落盘时存下来的 ——
 * 错误文案的唯一来源是 `common/errors.ts`（技术方案 5.6），
 * 存一份进统计文件就等于抄了第二份，以后改文案会新旧混用。
 */
export interface StatsFailure {
  url: string;
  /** 归一化错误码，页面上做 tooltip/调试用 */
  code: string;
  /** 一句话原因（来自码表） */
  message: string;
  hint?: string;
  /** 发生时间（ISO 8601） */
  at: string;
}

/** 跨天累加出来的总数（概览卡片用）。失败数由前端拿 `articleTotal - articleOk` 自己算 */
export interface StatsTotals {
  pageViews: number;
  visitors: number;
  directLinks: number;
  articleTotal: number;
  articleOk: number;
  translateTotal: number;
  translateBlocks: number;
}

export interface StatsApiResponse {
  /** 这份数据是什么时候生成的（ISO 8601） */
  generatedAt: string;
  /** 最多保留多少天 —— 页面底部要说明口径，别写死在两处 */
  retainDays: number;
  /** 每天最多保留多少条失败明细 —— 页面要如实说明"可能被截断" */
  maxFailuresPerDay: number;
  /** 数据里实际有多少天 */
  totalDays: number;
  totals: StatsTotals;
  /**
   * 错误码 → 可读文案。页面上的"抓取失败原因"那一栏用它把 `blocked_by_site`
   * 显示成"目标网站拒绝了抓取"。
   *
   * 只包含**数据里真出现过的**码，不把整张码表发过去。
   */
  errorLabels: Record<string, string>;
  /** 按日期升序 */
  days: StatsDay[];
}

export function buildStatsResponse(snapshot: StatsSnapshot): StatsApiResponse {
  // 求和直接对着原始快照做：`sumBy` 的入参是落盘那套 `DayStats`，
  // 而 `StatsDay` 已经多了一层转换，两者不是同一个类型。
  const source = snapshot.days;
  const days = source.map(toApiDay);

  return {
    generatedAt: snapshot.generatedAt,
    retainDays: RETAIN_DAYS,
    maxFailuresPerDay: MAX_FAILURES_PER_DAY,
    totalDays: days.length,
    totals: {
      pageViews: sumBy(source, (d) => d.pageViews),
      // 按天去重后累加：同一个人连着来三天算三个 —— 这个数字是"人·天"，不是"人"。
      // 盐每天换，本来就拼不出跨天的同一个人（不追踪），所以只能这么算，页面上也如实写
      visitors: sumBy(source, (d) => d.visitors.length),
      directLinks: sumBy(source, (d) => d.directLinks),
      articleTotal: sumBy(source, (d) => d.articleTotal),
      articleOk: sumBy(source, (d) => d.articleOk),
      translateTotal: sumBy(source, (d) => d.translateTotal),
      translateBlocks: sumBy(source, (d) => d.translateBlocks),
    },
    errorLabels: collectErrorLabels(source),
    days,
  };
}

/**
 * 错误码 → 文案。数据里出现过的码才给，避免把整张码表（22 条）发过去。
 *
 * 认不出来的码原样当文案返回：那说明有人往统计里写了码表之外的字符串，
 * 页面上显示原始码比显示"服务器出了点问题"更有助于定位。
 */
function collectErrorLabels(days: readonly DayStats[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const day of days) {
    for (const code of [...Object.keys(day.articleErrors), ...Object.keys(day.translateRejects)]) {
      labels[code] = describeCode(code).message;
    }
  }
  return labels;
}

/** 查码表。查不到就退回原始码，绝不抛 */
function describeCode(code: string): { message: string; hint?: string } {
  const spec = ERROR_SPEC[code as ErrorCode];
  if (!spec) return { message: code };
  return { message: spec.message, ...(spec.hint ? { hint: spec.hint } : {}) };
}

/**
 * 单独拷贝每个 map，而不是直接引用快照里的对象。
 *
 * 快照返回的是统计服务内部那批活对象的引用（`snapshot()` 没有深拷贝）。
 * 序列化是同步发生的，眼下不会出问题；但"响应里握着一份随时会被打点的活数据"
 * 迟早会在某次重构里咬人（比如以后加了缓存）。拷贝的代价可以忽略。
 */
function toApiDay(day: DayStats): StatsDay {
  return {
    date: day.date,
    pageViews: day.pageViews,
    visitors: day.visitors.length,
    paths: { ...day.paths },
    referrers: { ...day.referrers },
    directLinks: day.directLinks,
    articleTotal: day.articleTotal,
    articleOk: day.articleOk,
    articleErrors: { ...day.articleErrors },
    articleUrls: { ...day.articleUrls },
    articleFailures: day.articleFailures.map((failure) => {
      const { message, hint } = describeCode(failure.code);
      return {
        url: failure.url,
        code: failure.code,
        message,
        ...(hint ? { hint } : {}),
        at: failure.at,
      };
    }),
    translateTotal: day.translateTotal,
    translateBlocks: day.translateBlocks,
    translateLangs: { ...day.translateLangs },
    translateUrls: { ...day.translateUrls },
    translateRejects: { ...day.translateRejects },
  };
}
