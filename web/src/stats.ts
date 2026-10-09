/**
 * 统计页的纯函数：排序、格式化、进度条宽度。
 *
 * 和后端 `server/src/stats/stats.types.ts` 里那几个（`topEntries` / `sumBy`）规则相同，
 * 但**有意各写一份**。接口只送原始数据（每天若干张 `Record<string, number>`），
 * 排布与取前几项是"怎么显示"的事，属于前端；为省这十来行去让后端把
 * 每种面板的前 N 项都排好、再定一套响应结构，反而把两边绑死了 ——
 * 以后想在页面上加一张图就得动接口。
 *
 * 放在单独文件里（而不是塞进组件）是为了能离线单测：这几条最容易悄悄错
 * （排序不稳定、空数据除以零、千分位），错了页面上看着还挺正常。
 */

/** 按次数倒序取前 n 项。并列时按键名排 —— 保证同一份数据每次渲染顺序一致 */
export function topEntries(map: Record<string, number>, n: number): Array<[string, number]> {
  return Object.entries(map)
    .filter(([, value]) => Number.isFinite(value))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}

/**
 * 千分位。
 *
 * 不用 `toLocaleString`：它依赖运行时的 ICU 数据，换个环境（或旧浏览器）
 * 加不加分隔符、用不用非断行空格都说不准。自己来只有一种输出。
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 进度条宽度（百分比）。
 *
 * **最低给 2%**：一条 0 宽度的条看起来像"这一项没有数据"，
 * 而它其实只是相对最大值很小。给它一个能看见的宽度，语义才对。
 *
 * 空数据（max <= 0）返回 0，不返回 NaN —— 这里的 NaN 会让 style 变成
 * `width:NaN%`，CSS 直接忽略，条不见了，而页面上没有任何报错。
 */
export function barWidth(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)));
}

/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm:ss`。解析不出来就原样返回，不显示 Invalid Date */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * 只要时分秒。明细表里日期已经在标题上了，每行再重复一遍日期是噪音。
 * 解析不出来返回空串（表格里留白比显示 `NaN:NaN` 好）。
 */
export function formatLocalClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// `isHttpUrl` 搬去了 `url.ts`：它不再只是统计页在用 ——
// 阅读器渲染「原文链接」也要用同一个判断。原来它住在本文件是因为
// "明细里存的是用户原始输入，可能是 `javascript:`"，那个理由今天仍然成立，
// 但".不把可执行串塞进 href"这件事跟统计页没有关系，放在这里会让人不敢复用。
