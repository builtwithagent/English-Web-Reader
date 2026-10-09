/**
 * 访问统计页（前端路由 `/stats`，数据来自 `GET /api/stats`）。
 *
 * 这一版是**从服务端直出 HTML 改过来的**。改的原因是那版把页面样式和产品其余部分
 * 分了家：后端得抄一份 CSS 变量、自己写转义、自己处理深浅色，于是"看板"和"产品"
 * 会永远长成两种东西。现在它就是一个普通的 React 页面 —— 复用同一套变量、
 * 同一个主题开关、同一个 `ApiError` 约定。
 *
 * 它**不在任何地方被链接**，也带着 `noindex`。但这不是安全措施：
 * 真正的门是 `/api/stats` 上那道密码（见 `web/src/statsKey.ts` 与 `server/src/stats/stats.auth.ts`），
 * 页面本身公开无妨（拿不到数据，看到的只是输入框）。
 *
 * **密码由这个页面自己收，不靠浏览器弹框**：服务端曾靠 `401 + WWW-Authenticate`
 * 让浏览器自己弹登录框，但发布环境的网关会覆盖 `Authorization` 头，弹了也进不去，
 * 只会变成弹了又弹的死循环。现在两条路都走自定义头，见 `api.ts` 的 `fetchStats`。
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, fetchStats, isAbortError } from '../api';
import { usePreferencesApi } from '../hooks/usePreferences';
import {
  barWidth,
  formatLocalClock,
  formatLocalTime,
  formatNumber,
  isHttpUrl,
  topEntries,
} from '../stats';
import { STATS_KEY_STORAGE, parseStatsKey } from '../statsKey';
import type { StatsDay, StatsFailure, StatsResponse } from '../types';

/** 最近多少天进历史表 */
const HISTORY_DAYS = 14;

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; data: StatsResponse }
  /** 401：要密码（或是密码不对）—— 由页面自己收，别指望浏览器弹框 */
  | { kind: 'locked' }
  /** 503：服务端没配 STATS_PASSWORD，接口是关着的 */
  | { kind: 'disabled' }
  | { kind: 'failed'; message: string; hint?: string };

/**
 * 页面打开时的密钥来源：先看 `?key=`（引导用），再看本次会话里存过的。
 *
 * `?key=` 取到之后**立刻把 query 抹掉** —— 否则密码会留在地址栏、进浏览器历史、
 * 被截图，还可能随 Referer 漏给外链。抹掉它用 `replaceState`，不触发路由的
 * `popstate`，所以不会重渲染。
 */
function readInitialKey(): string | null {
  const fromUrl = parseStatsKey(window.location.search);
  if (fromUrl) {
    rememberKey(fromUrl);
    window.history.replaceState(null, '', window.location.pathname);
    return fromUrl;
  }
  try {
    return window.sessionStorage.getItem(STATS_KEY_STORAGE) || null;
  } catch {
    // 隐私模式等场景下 sessionStorage 会抛异常 —— 那就当没存过
    return null;
  }
}

function rememberKey(key: string): void {
  try {
    window.sessionStorage.setItem(STATS_KEY_STORAGE, key);
  } catch {
    /* 存不下就算了，这一次仍然可用 */
  }
}

function forgetKey(): void {
  try {
    window.sessionStorage.removeItem(STATS_KEY_STORAGE);
  } catch {
    /* 同上 */
  }
}

export function StatsPage() {
  const { prefs, toggleTheme } = usePreferencesApi();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [key, setKey] = useState<string | null>(readInitialKey);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  /** 用户输了密码：存下来，改 state 会让下面的 effect 重新拉一次 */
  const submitKey = useCallback((value: string) => {
    rememberKey(value);
    setKey(value);
  }, []);

  useEffect(() => {
    const previous = document.title;
    document.title = '访问统计 · 英文网页阅读器';
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setView({ kind: 'loading' });

    fetchStats(key ?? undefined, controller.signal)
      .then((data) => setView({ kind: 'ready', data }))
      .catch((err: unknown) => {
        // 组件卸载/换页导致的取消不是错误，静默退出
        if (isAbortError(err)) return;

        if (err instanceof ApiError) {
          if (err.status === 401) {
            // 会话里存着的那把不对，先扔掉，否则用户改都没法改
            if (key !== null) {
              forgetKey();
              setKey(null);
              return;
            }
            setView({ kind: 'locked' });
            return;
          }
          if (err.status === 503) {
            setView({ kind: 'disabled' });
            return;
          }
          setView({ kind: 'failed', message: err.message, hint: err.hint });
          return;
        }

        setView({ kind: 'failed', message: '读取统计失败' });
      });

    return () => controller.abort();
  }, [reloadKey, key]);

  return (
    <div className="stats-page">
      <header className="stats-head">
        <div className="brand">
          <span className="mark">📖</span>
          <span>英文网页阅读器</span>
        </div>
        {/* 面包屑放在 `.brand` 外面：顶栏那条窄屏规则 `span:last-child` 会把
            品牌名后面的元素藏掉，放里面就只剩一个孤零零的图标 */}
        <span className="stats-crumb">/ 访问统计</span>

        <div className="spacer" />

        <button type="button" className="btn" onClick={reload} disabled={view.kind === 'loading'}>
          刷新
        </button>
        <button
          type="button"
          className="btn icon"
          title="深浅色"
          aria-label="切换深浅色"
          onClick={toggleTheme}
        >
          {prefs.theme === 'light' ? '☾' : '☀'}
        </button>
      </header>

      <p className="stats-sub">只统计不追踪，原始 IP 与 UA 均不落盘。</p>

      {view.kind === 'loading' ? <p className="empty">正在读取…</p> : null}
      {view.kind === 'locked' ? <Locked onSubmit={submitKey} /> : null}
      {view.kind === 'disabled' ? <Disabled /> : null}
      {view.kind === 'failed' ? (
        <p className="stats-error">
          {view.message}
          {view.hint ? <span className="dim"> · {view.hint}</span> : null}
        </p>
      ) : null}
      {view.kind === 'ready' ? <StatsBody data={view.data} /> : null}
    </div>
  );
}

// ============================================================================
// 三种"没拿到数据"的形态 —— 分开说，别都叫"加载失败"
// ============================================================================

/**
 * 输密码这一步。
 *
 * 为什么不是"浏览器弹框"：见文件头。这里自己收，输入框类型是 `password`，
 * 提交后由父组件存进 `sessionStorage` 并立刻重拉数据。
 *
 * 也支持 `?key=<密码>` 一次性进入（父组件的 `readInitialKey` 处理），
 * 适合在手机上懒得打字的时候用。
 */
function Locked({ onSubmit }: { onSubmit(key: string): void }) {
  const [value, setValue] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const key = value.trim();
    if (key.length > 0) onSubmit(key);
  };

  return (
    <form className="stats-notice" onSubmit={submit}>
      <p>这是作者自用的看板，需要密码。</p>
      <p className="dim">
        密码就是服务端配置的 <code>STATS_PASSWORD</code>；输了之后只记在这个标签页里，
        关掉就没了。也可以直接用 <code>/stats?key=密码</code> 一次进来。
      </p>
      <div className="key-row">
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="管理密码"
          aria-label="管理密码"
          autoFocus
        />
        <button type="submit" className="btn" disabled={value.trim().length === 0}>
          进入
        </button>
      </div>
    </form>
  );
}

function Disabled() {
  return (
    <div className="stats-notice">
      <p>统计接口未启用。</p>
      <p className="dim">
        服务端需要先配置 <code>STATS_PASSWORD</code> 环境变量，然后重启。
        没配就等于这个接口是关着的，而不是"不校验"。
      </p>
    </div>
  );
}

// ============================================================================
// 主体
// ============================================================================

function StatsBody({ data }: { data: StatsResponse }) {
  const { totals } = data;

  // 历史表只要最近这些天，倒序（最新的在最上面）
  const history = [...data.days].reverse().slice(0, HISTORY_DAYS);

  // `days` 里最后一个**有数据**的天不一定是今天（周末没人来就没有今天这一桶）
  const latest = data.days.length > 0 ? data.days[data.days.length - 1] : null;
  const latestIsToday = latest !== null && latest.date === todayKey();

  /**
   * 失败明细看的是"哪一天"，默认选**最近一个有失败的那天**。
   *
   * 这样打开页面就能直接看到问题，不用先点一下；点历史表里的红色数字则切到那天。
   * 用 `??` 逐级兜底而不是只取最后一天：最后一天可能一条都没失败，
   * 那样明细区会是空的，而前一天明明挂着 4 条。
   */
  const [selectedDate, setSelectedDate] = useState<string | null>(
    () => [...data.days].reverse().find((d) => d.articleFailures.length > 0)?.date ?? null,
  );
  const selected = data.days.find((d) => d.date === selectedDate) ?? null;

  const selectDay = useCallback((date: string) => {
    setSelectedDate(date);
    // 点完要能看见 —— 明细区在页面靠下的位置，不滚过去等于没反应
    window.setTimeout(() => {
      document.getElementById('failures')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }, []);

  return (
    <>
      <section className="stats-cards">
        <Card
          label="页面访问"
          value={totals.pageViews}
          hint={`其中 ${formatNumber(totals.directLinks)} 次是带 ?url= 的直达链接`}
        />
        <Card label="独立访客" value={totals.visitors} hint="按天去重后累加，跨天重复计" />
        <Card
          label="抓取次数"
          value={totals.articleTotal}
          hint={
            totals.articleTotal > 0
              ? `成功 ${formatNumber(totals.articleOk)} · 失败 ${formatNumber(
                  totals.articleTotal - totals.articleOk,
                )}`
              : '还没有数据'
          }
        />
        <Card
          label="翻译次数"
          value={totals.translateTotal}
          hint={
            totals.translateTotal > 0
              ? `共 ${formatNumber(totals.translateBlocks)} 个文本块发给上游`
              : '还没有数据'
          }
        />
      </section>

      <h2>{latestIsToday ? `今日 · ${latest.date}` : latest ? `最近一天 · ${latest.date}` : '今日'}</h2>

      {latest ? (
        <div className="stats-grid">
          <Panel title="热门页面">{barList(topEntries(latest.paths, 8), '今天还没有访问')}</Panel>
          <Panel title="来源站点">
            {barList(topEntries(latest.referrers, 8), '全部是直接输入地址')}
          </Panel>
          <Panel title="抓取过的页面">
            {barList(topEntries(latest.articleUrls, 10), '今天还没抓过页面', 'url')}
          </Panel>
          <Panel title="抓取失败原因">
            {barList(
              topEntries(latest.articleErrors, 10).map(([code, count]) => [
                data.errorLabels[code] ?? code,
                count,
              ]),
              '没有失败，挺好',
              'text',
            )}
          </Panel>
          <Panel title="翻译目标语言">
            {barList(topEntries(latest.translateLangs, 10), '今天还没翻译过')}
          </Panel>
          <Panel title="翻译过的页面">
            {barList(topEntries(latest.translateUrls, 10), '今天还没翻译过', 'url')}
          </Panel>
          <Panel title="被语言闸门拦下">
            {barList(
              topEntries(latest.translateRejects, 10).map(([code, count]) => [
                data.errorLabels[code] ?? code,
                count,
              ]),
              '没有被拦的请求',
              'text',
            )}
          </Panel>
          <Panel title="今日小计">{barList(subtotal(latest), '今天还没有数据')}</Panel>
        </div>
      ) : (
        <p className="empty">今天还没有任何访问。</p>
      )}

      <h2>最近 {history.length} 天</h2>
      <table className="stats-table">
        <thead>
          <tr>
            <th>日期</th>
            <th>访问</th>
            <th>访客</th>
            <th>抓取</th>
            <th>失败</th>
            <th>翻译</th>
            <th>块数</th>
          </tr>
        </thead>
        <tbody>
          {history.length > 0 ? (
            history.map((day) => (
              <HistoryRow
                key={day.date}
                day={day}
                selected={day.date === selectedDate}
                onSelect={selectDay}
              />
            ))
          ) : (
            <tr>
              <td colSpan={7} className="dim">
                还没有数据
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {selected && selected.articleFailures.length > 0 ? (
        <FailuresSection
          day={selected}
          maxKept={data.maxFailuresPerDay}
          onClose={() => setSelectedDate(null)}
        />
      ) : null}
      {selected && selected.articleFailures.length === 0 ? (
        <p className="empty" id="failures">
          {selected.date} 没有失败记录。
        </p>
      ) : null}

      <footer className="stats-foot">
        <p>
          页面生成于 {formatLocalTime(data.generatedAt)} · 上面「累计」是最近 {data.retainDays} 天、
          现有 {data.totalDays} 天数据 · 按服务端本地时区切天
        </p>
      </footer>
    </>
  );
}

function HistoryRow({
  day,
  selected,
  onSelect,
}: {
  day: StatsDay;
  selected: boolean;
  onSelect(date: string): void;
}) {
  const failed = day.articleTotal - day.articleOk;
  const clickable = failed > 0 && day.articleFailures.length > 0;

  return (
    <tr className={selected ? 'is-selected' : undefined}>
      <td className="mono">{day.date}</td>
      <td>{formatNumber(day.pageViews)}</td>
      <td>{formatNumber(day.visitors)}</td>
      <td>{formatNumber(day.articleTotal)}</td>
      <td className={failed > 0 ? 'bad' : 'dim'}>
        {clickable ? (
          // 做成按钮而不是 `<a>`：它不是导航到一个新页面，是在本页切换明细。
          // 但看起来要像链接，否则"这个数字能点"完全看不出来。
          <button
            type="button"
            className="stats-link"
            onClick={() => onSelect(day.date)}
            title="点开看是哪几个页面失败了、失败原因是什么"
          >
            {formatNumber(failed)}
          </button>
        ) : (
          formatNumber(failed)
        )}
      </td>
      <td>{formatNumber(day.translateTotal)}</td>
      <td>{formatNumber(day.translateBlocks)}</td>
    </tr>
  );
}

/**
 * 失败明细。
 *
 * 这是这个看板里唯一"能拿来干活"的一块：光有"失败 4 次"没法排查，
 * 得知道**是哪 4 个页面**、**各自什么原因**，然后点开原页面自己看一眼。
 */
function FailuresSection({
  day,
  maxKept,
  onClose,
}: {
  day: StatsDay;
  maxKept: number;
  onClose(): void;
}) {
  const total = day.articleTotal - day.articleOk;
  const shown = day.articleFailures.length;
  // 计数是全量的、明细是有上限的 —— 两个数字口径不同，页面上必须说清楚，
  // 否则"失败 120 次但只列出 100 条"看起来就像数据丢了
  const truncated = shown < total;

  return (
    <section className="stats-failures" id="failures">
      <div className="stats-failures-head">
        <h2>
          失败明细 · {day.date}
          <span className="dim"> · 共 {formatNumber(total)} 次</span>
        </h2>
        <button type="button" className="btn" onClick={onClose}>
          收起
        </button>
      </div>

      {truncated ? (
        <p className="empty">
          只保留最近 {maxKept} 条明细，这里显示 {formatNumber(shown)} 条（计数不受影响，仍是全部）。
        </p>
      ) : null}

      <table className="stats-table stats-failures-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>页面</th>
            <th>原因</th>
          </tr>
        </thead>
        <tbody>
          {day.articleFailures.map((failure, index) => (
            <FailureRow key={`${failure.at}-${index}`} failure={failure} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function FailureRow({ failure }: { failure: StatsFailure }) {
  // 存的可能是 `invalid_url` 那条路径上的**用户原始输入**，
  // 那种串不能进 href（`javascript:` 就是一个 XSS）
  const linkable = isHttpUrl(failure.url);

  return (
    <tr>
      <td className="mono dim">{formatLocalClock(failure.at)}</td>
      <td className="url-cell">
        {linkable ? (
          <a href={failure.url} target="_blank" rel="noreferrer noopener" title={failure.url}>
            {failure.url}
          </a>
        ) : (
          <span title={failure.url}>{failure.url}</span>
        )}
      </td>
      <td className="reason-cell" title={failure.code}>
        <span className="reason">{failure.message}</span>
        {failure.hint ? <span className="hint">{failure.hint}</span> : null}
      </td>
    </tr>
  );
}

// ============================================================================
// 小片段
// ============================================================================

function Card({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="stats-card">
      <div className="label">{label}</div>
      <div className="value">{formatNumber(value)}</div>
      <div className="hint">{hint}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="stats-panel">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/**
 * 条形列表。
 *
 * `variant` 决定标签怎么处理长文本，三档各有理由：
 * - `'url'`：完整 URL 是这一栏的**重点**，所以允许换行 + `break-all`。
 *   用省略号截掉的话，用户看到的还是"这是个 example.com 的页面"，
 *   跟之前只记域名没区别。
 * - `'text'`：中文原因这类短语，允许换行但不许在词中间断开。
 * - 缺省：host / 语言码 / 路径这类短而规整的键，一行一个最好看，超出就省略 + tooltip。
 */
function barList(
  entries: Array<[string, number]>,
  empty: string,
  variant?: 'url' | 'text',
) {
  if (entries.length === 0) return <p className="empty">{empty}</p>;

  const max = entries[0][1];
  return (
    <ul className={variant ? `bars is-${variant}` : 'bars'}>
      {entries.map(([key, value]) => (
        <li key={key}>
          {/* 路径与域名都是外部输入，这里不拼 HTML —— React 默认转义，
              当初服务端直出那版要自己写 escapeHtml 的地方就在这儿 */}
          <span className="bar-label" title={key}>
            {key}
          </span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${barWidth(value, max)}%` }} />
          </span>
          <span className="bar-value">{formatNumber(value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** 「今日小计」面板：把几个总数并成一张同样的条形图，方便一眼看比例 */
function subtotal(day: StatsDay): Array<[string, number]> {
  return [
    ['页面访问', day.pageViews],
    ['独立访客', day.visitors],
    ['抓取', day.articleTotal],
    ['翻译', day.translateTotal],
    ['译文块数', day.translateBlocks],
  ];
}

/** 本地时区的今天（和后端 `dayKey` 同口径，不用 `toISOString` —— 那是 UTC） */
function todayKey(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
