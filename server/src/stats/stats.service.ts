import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  MAX_FAILURES_PER_DAY,
  MAX_VISITORS_PER_DAY,
  RETAIN_DAYS,
  bump,
  dayKey,
  emptyDay,
  visitorHash,
  type DayStats,
  type FailureEntry,
  type StatsSnapshot,
} from './stats.types';

/**
 * 访问统计。
 *
 * 设计取舍（为什么不是 GA / 百度统计 / 数据库）：
 * 1. **不引外部分析服务**：那会把访客的 IP 与 UA 交给第三方，还要在页面上挂
 *    一段别人的脚本；这个项目的定位是"自己看自己"的指标，不值得为此加一个外部依赖。
 * 2. **不用数据库**：发布沙箱只给一个端口、不给数据库。统计是"无所谓的数据"，
 *    丢了不心疼，所以落一个 JSON 文件、**整份原子替换**就够。
 *    真涨到每天几千人，这里就该换 SQLite —— 现在不是。
 *
 * 三条铁律：
 * - **记录方法不抛异常**：统计写坏了不能连累抓取和翻译（见每个 public 方法的 try）。
 * - **不存原始 IP**：只存加盐摘要（见 visitorHash）。
 * - **攒着写盘**：每个请求都 fsync 一次是自找麻烦，攒 3 秒或关停时落一次。
 */

/** 落盘格式。带 version 是为了以后改结构时能认出旧文件 */
interface StatsFile {
  version: number;
  updatedAt: string;
  days: Record<string, DayStats>;
}

/**
 * 落盘格式的版本。
 *
 * v1 → v2：`articleHosts` / `translateHosts` 换成 `articleUrls` / `translateUrls`
 * （记完整 URL 而不是域名），并新增 `articleFailures` 明细。
 *
 * **版本不匹配时整份丢弃，不迁移**。理由是旧的键是域名、新的是 URL，
 * 混在一起会得到一份"前一天按域名、后一天按 URL"的数据 —— 页面上看着都是网址，
 * 数字却是两套口径，这种错最难发现。丢掉的只是历史观测数据，没什么可惜的。
 */
const FILE_VERSION = 2;

/** 攒多久落一次盘 */
const FLUSH_INTERVAL_MS = 3000;

/** 数据目录：`server/data/`（已被 .gitignore 排除） */
export function defaultStatsFile(): string {
  // __dirname 在 CJS 产物里是 server/dist/stats → 上两级回到 server/
  // 测试跑在 esbuild 的 ESM 变换下没有 __dirname，所以做了兜底
  const base =
    typeof __dirname === 'string' ? join(__dirname, '..', '..', 'data') : join(process.cwd(), 'data');
  return join(base, 'stats.json');
}

/**
 * 统计文件的路径注入 token。
 *
 * 为什么不用 `constructor(private readonly filePath: string = ...)` 那种写法：
 * 这个工程开了 `emitDecoratorMetadata`，构造函数里的 `string` 会被当成
 * **一个叫 String 的依赖**去容器里找，启动时直接抛 UnknownDependenciesException。
 * 用显式 token 就没有这个歧义。
 */
export const STATS_FILE = 'STATS_FILE';

@Injectable()
export class StatsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatsService.name);

  private readonly days = new Map<string, DayStats>();
  /** 访客去重用的集合。**不进 JSON**（上面的 visitors 数组才是落盘形态） */
  private readonly visitorSets = new Map<string, Set<string>>();

  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 串行化写盘：两次并发写会互相踩同一个 .tmp 文件 */
  private writing: Promise<void> = Promise.resolve();

  constructor(@Inject(STATS_FILE) private readonly filePath: string = defaultStatsFile()) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }

  // ==========================================================================
  // 记录
  // ==========================================================================

  recordPageView(input: {
    path: string;
    ip: string;
    ua: string;
    referer?: string;
    hasUrlParam: boolean;
  }): void {
    try {
      const day = this.day();
      day.pageViews += 1;
      bump(day.paths, input.path || '/');
      if (input.referer) bump(day.referrers, input.referer);
      if (input.hasUrlParam) day.directLinks += 1;
      this.addVisitor(day, input.ip, input.ua);
      this.scheduleFlush();
    } catch (err) {
      this.warn('记页面访问', err);
    }
  }

  recordArticle(input: { url: string; ok: boolean; errorCode?: string }): void {
    try {
      const day = this.day();
      day.articleTotal += 1;
      if (input.ok) {
        day.articleOk += 1;
      } else {
        // 错误码**汇总**（看分布）与**明细**（看是哪一条）要一起记：
        // 前者答"失败了多少、都是什么原因"，后者答"具体是哪几个页面"。
        // 只留一个都会在排查时卡住。
        const code = input.errorCode ?? 'internal_error';
        bump(day.articleErrors, code);
        pushFailure(day, { url: input.url, code, at: new Date().toISOString() });
      }
      // 成功的也记：这一栏是"抓过哪些页面"，不区分成败
      if (input.url) bump(day.articleUrls, input.url);
      this.scheduleFlush();
    } catch (err) {
      this.warn('记抓取', err);
    }
  }

  recordTranslate(input: { url: string; targetLang: string; blocks: number }): void {
    try {
      const day = this.day();
      day.translateTotal += 1;
      day.translateBlocks += input.blocks;
      bump(day.translateLangs, input.targetLang);
      if (input.url) bump(day.translateUrls, input.url);
      this.scheduleFlush();
    } catch (err) {
      this.warn('记翻译', err);
    }
  }

  /** 被入口语言闸门挡下（source_not_english 等）—— 只记原因，不算一次翻译 */
  recordTranslateReject(code: string): void {
    try {
      bump(this.day().translateRejects, code);
      this.scheduleFlush();
    } catch (err) {
      this.warn('记翻译拦截', err);
    }
  }

  // ==========================================================================
  // 读取
  // ==========================================================================

  snapshot(): StatsSnapshot {
    return {
      generatedAt: new Date().toISOString(),
      filePath: this.filePath,
      days: [...this.days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private warn(action: string, err: unknown): void {
    this.logger.warn(`${action}统计失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
  }

  /** 今天的桶，不存在就现建一个（含当天的新盐） */
  private day(now = new Date()): DayStats {
    const key = dayKey(now);
    let day = this.days.get(key);
    if (!day) {
      day = emptyDay(key, randomBytes(16).toString('hex'));
      this.days.set(key, day);
      this.visitorSets.set(key, new Set());
      this.prune();
    }
    return day;
  }

  private addVisitor(day: DayStats, ip: string, ua: string): void {
    if (day.visitors.length >= MAX_VISITORS_PER_DAY) return;

    let set = this.visitorSets.get(day.date);
    if (!set) {
      set = new Set(day.visitors);
      this.visitorSets.set(day.date, set);
    }

    const hash = visitorHash(day.salt, ip, ua);
    if (set.has(hash)) return;
    set.add(hash);
    day.visitors.push(hash);
  }

  /** 丢掉超期的那几天。**只按日期切，不看访问量** */
  private prune(now = new Date()): void {
    const cutoff = dayKey(new Date(now.getTime() - RETAIN_DAYS * 24 * 3600 * 1000));
    for (const key of [...this.days.keys()]) {
      if (key < cutoff) {
        this.days.delete(key);
        this.visitorSets.delete(key);
      }
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // 别让这个定时器把进程钉住（关停时 onModuleDestroy 会兜底 flush）
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;

    const payload: StatsFile = {
      version: FILE_VERSION,
      updatedAt: new Date().toISOString(),
      days: Object.fromEntries(this.days),
    };

    this.writing = this.writing
      .then(async () => {
        const tmp = `${this.filePath}.tmp`;
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(tmp, JSON.stringify(payload), 'utf8');
        // 原子替换：写到一半崩了，旧文件还在，不会留一个半截的统计文件
        await rename(tmp, this.filePath);
      })
      .catch((err: unknown) => {
        // 写盘失败不改统计行为：内存里的数照记，下一个周期再试
        this.warn('落盘', err);
      });

    await this.writing;
  }

  /** 服务启动时读回上次的数据。文件坏了/不存在都当"从零开始"，不阻断启动 */
  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      this.logger.log(`统计文件不存在，从零开始：${this.filePath}`);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<StatsFile>;
      if (parsed.version !== FILE_VERSION || !parsed.days) {
        this.logger.warn(`统计文件版本不匹配（期望 ${FILE_VERSION}），已忽略：${this.filePath}`);
        return;
      }

      for (const [key, value] of Object.entries(parsed.days)) {
        // 逐项兜底：手改过的文件缺字段时不该让整个服务起不来
        const day = normalizeDay(key, value);
        this.days.set(key, day);
        this.visitorSets.set(key, new Set(day.visitors));
      }

      this.prune();
      this.logger.log(`统计已载入：${this.days.size} 天（${this.filePath}）`);
    } catch (err) {
      this.warn('读取统计文件', err);
    }
  }
}

/** 把文件里的原始对象补成完整的一天。缺字段给 0 / 空对象，多的字段丢掉 */
function normalizeDay(key: string, raw: unknown): DayStats {
  const source = (raw ?? {}) as Partial<DayStats>;
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const rec = (value: unknown): Record<string, number> => {
    if (!value || typeof value !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  };

  return {
    date: typeof source.date === 'string' ? source.date : key,
    pageViews: num(source.pageViews),
    paths: rec(source.paths),
    referrers: rec(source.referrers),
    directLinks: num(source.directLinks),
    articleTotal: num(source.articleTotal),
    articleOk: num(source.articleOk),
    articleErrors: rec(source.articleErrors),
    articleUrls: rec(source.articleUrls),
    articleFailures: normalizeFailures(source.articleFailures),
    translateTotal: num(source.translateTotal),
    translateBlocks: num(source.translateBlocks),
    translateLangs: rec(source.translateLangs),
    translateUrls: rec(source.translateUrls),
    translateRejects: rec(source.translateRejects),
    visitors: Array.isArray(source.visitors)
      ? source.visitors.filter((v): v is string => typeof v === 'string')
      : [],
    salt: typeof source.salt === 'string' && source.salt ? source.salt : randomBytes(16).toString('hex'),
  };
}

/**
 * 失败明细的兜底。
 *
 * 手改过的文件里什么都可能出现，所以逐项校验：url / code / at 必须都是非空字符串，
 * 缺一条就整条丢掉 —— 宁可少几条，也不要在页面上渲染出 `undefined`。
 * 同时按上限截断，避免手改的文件绕过写入路径的上限。
 */
function normalizeFailures(value: unknown): FailureEntry[] {
  if (!Array.isArray(value)) return [];
  const out: FailureEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Partial<FailureEntry>;
    if (typeof entry.url !== 'string' || typeof entry.code !== 'string' || typeof entry.at !== 'string') {
      continue;
    }
    out.push({ url: entry.url, code: entry.code, at: entry.at });
    if (out.length >= MAX_FAILURES_PER_DAY) break;
  }
  return out;
}

/** 记一条失败明细，**最近的在前**。到上限就丢最旧的 */
function pushFailure(day: DayStats, entry: FailureEntry): void {
  day.articleFailures.unshift(entry);
  if (day.articleFailures.length > MAX_FAILURES_PER_DAY) {
    day.articleFailures.length = MAX_FAILURES_PER_DAY;
  }
}
