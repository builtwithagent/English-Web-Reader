import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { ERROR_SPEC } from '../src/common/errors';
import { StatsAuth, checkBasicAuth, checkStatsKey } from '../src/stats/stats.auth';
import { buildStatsResponse } from '../src/stats/stats.api';
import { createPageViewMiddleware, pathnameOf, shouldCount } from '../src/stats/stats.middleware';
import { StatsService } from '../src/stats/stats.service';
import {
  MAX_FAILURES_PER_DAY,
  MAX_KEYS,
  MAX_URL_LENGTH,
  RETAIN_DAYS,
  bump,
  dayKey,
  emptyDay,
  hostOf,
  mergeMaps,
  sumBy,
  topEntries,
  urlKey,
  visitorHash,
} from '../src/stats/stats.types';

/**
 * 统计模块单测。
 *
 * 这里测的都是"记错了也看不出来"的东西：计数上限、访客去重、落盘后能不能读回来、
 * 发出去的 JSON 有没有多带东西、失败明细会不会把该有的丢掉。它们不会让服务崩，
 * 但会让看板上的数字悄悄骗人 —— 统计的全部价值就在数字可信，所以这部分必须有测试。
 */

/** 测试里造明细用的固定时间，别用 Date.now()（会让断言飘） */
const ISO = '2026-10-08T10:00:00.000Z';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** 造一个临时文件路径（目录随后由 afterEach 清掉） */
async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ewr-stats-'));
  tempDirs.push(dir);
  return join(dir, 'stats.json');
}

// ============================================================================
// 纯函数
// ============================================================================

describe('bump：带上限的计数', () => {
  it('同键累加、新键从 1 开始', () => {
    const map: Record<string, number> = {};
    bump(map, 'a');
    bump(map, 'a');
    bump(map, 'b');
    expect(map).toEqual({ a: 2, b: 1 });
  });

  it('到上限后挤掉计数最小的键，键数不会超过上限', () => {
    const map: Record<string, number> = {};
    bump(map, 'a', 2);
    bump(map, 'a', 2); // a = 2
    bump(map, 'b', 2); // b = 1
    bump(map, 'c', 2); // 满了 → 挤掉 b

    expect(Object.keys(map).length).toBe(2);
    expect(map.a).toBe(2);
    expect(map.c).toBe(1);
    expect(map.b).toBeUndefined();
  });

  it('默认上限是 MAX_KEYS（防止外部输入把统计表撑爆）', () => {
    const map: Record<string, number> = {};
    for (let i = 0; i < MAX_KEYS + 50; i++) bump(map, `host-${i}.example.com`);
    expect(Object.keys(map).length).toBe(MAX_KEYS);
  });
});

describe('dayKey：本地时区切天', () => {
  it('个位数的月与日补零', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(dayKey(new Date(2026, 9, 8))).toBe('2026-10-08');
  });

  it('用的是本地日期而不是 UTC（否则东八区的"今天"会提前 8 小时）', () => {
    // 本地 2026-10-08 00:30 —— 此刻 UTC 还是 10-07
    const localMidnight = new Date(2026, 9, 8, 0, 30);
    expect(dayKey(localMidnight)).toBe('2026-10-08');
  });
});

describe('visitorHash：加盐指纹', () => {
  it('同盐同输入 → 同结果，长度 16', () => {
    const a = visitorHash('salt', '1.2.3.4', 'UA');
    expect(a).toBe(visitorHash('salt', '1.2.3.4', 'UA'));
    expect(a).toHaveLength(16);
  });

  it('换盐 / 换 IP / 换 UA 都会变（跨天无法把同一个人对上）', () => {
    const base = visitorHash('salt1', '1.2.3.4', 'UA');
    expect(visitorHash('salt2', '1.2.3.4', 'UA')).not.toBe(base);
    expect(visitorHash('salt1', '1.2.3.5', 'UA')).not.toBe(base);
    expect(visitorHash('salt1', '1.2.3.4', 'UA2')).not.toBe(base);
  });
});

describe('hostOf：只取 host', () => {
  it('合法 URL 取 host（丢掉路径与查询串）', () => {
    expect(hostOf('https://example.com/post?x=1')).toBe('example.com');
    expect(hostOf('http://sub.example.com:8080/a')).toBe('sub.example.com:8080');
  });

  it('空值 / 脏串 → null，不把垃圾记进去', () => {
    expect(hostOf(undefined)).toBeNull();
    expect(hostOf('')).toBeNull();
    expect(hostOf('not a url')).toBeNull();
    expect(hostOf('javascript:alert(1)')).toBeNull();
  });
});

describe('topEntries / sumBy / mergeMaps', () => {
  it('按次数倒序，并列按键名排（保证同一份数据每次渲染顺序一致）', () => {
    expect(topEntries({ b: 1, a: 1, c: 3 }, 2)).toEqual([
      ['c', 3],
      ['a', 1],
    ]);
  });

  it('sumBy 跨天累加', () => {
    const days = [emptyDay('2026-10-07', 's'), emptyDay('2026-10-08', 's')];
    days[0].pageViews = 3;
    days[1].pageViews = 4;
    expect(sumBy(days, (d) => d.pageViews)).toBe(7);
  });

  it('mergeMaps 合并同名分布', () => {
    const a = emptyDay('2026-10-07', 's');
    const b = emptyDay('2026-10-08', 's');
    bump(a.articleErrors, 'timeout');
    bump(b.articleErrors, 'timeout');
    bump(b.articleErrors, 'dns_failed');
    expect(mergeMaps([a, b], (d) => d.articleErrors)).toEqual({ timeout: 2, dns_failed: 1 });
  });
});

// ============================================================================
// 服务
// ============================================================================

describe('StatsService：记录与快照', () => {
  it('页面访问会累加，并可按 IP+UA 去重', async () => {
    const service = new StatsService(await tempFile());

    service.recordPageView({ path: '/', ip: '1.1.1.1', ua: 'UA', hasUrlParam: false });
    service.recordPageView({ path: '/', ip: '1.1.1.1', ua: 'UA', hasUrlParam: false });
    service.recordPageView({ path: '/', ip: '2.2.2.2', ua: 'UA', hasUrlParam: true });
    // 同一个 IP 但换了 UA → 算另一个人（NAT 出口下要能把设备分开）
    service.recordPageView({ path: '/', ip: '1.1.1.1', ua: 'UA2', hasUrlParam: false });

    const today = service.snapshot().days.at(-1)!;
    expect(today.pageViews).toBe(4);
    expect(today.visitors).toHaveLength(3);
    expect(today.paths).toEqual({ '/': 4 });
    expect(today.directLinks).toBe(1);
  });

  it('抓取成功与失败分开记，失败带错误码与**完整 URL**', async () => {
    const service = new StatsService(await tempFile());

    service.recordArticle({ url: 'https://example.com/a', ok: true });
    service.recordArticle({ url: 'https://example.com/a', ok: false, errorCode: 'timeout' });
    service.recordArticle({ url: '', ok: false, errorCode: 'invalid_url' });

    const today = service.snapshot().days.at(-1)!;
    expect(today.articleTotal).toBe(3);
    expect(today.articleOk).toBe(1);
    expect(today.articleErrors).toEqual({ timeout: 1, invalid_url: 1 });
    // 空 url 不该在分布里占一个格子
    expect(today.articleUrls).toEqual({ 'https://example.com/a': 2 });
  });

  it('失败明细记下 URL、错误码与时间，最近的在前', async () => {
    const service = new StatsService(await tempFile());

    service.recordArticle({ url: 'https://a.com/1', ok: false, errorCode: 'blocked_by_site' });
    service.recordArticle({ url: 'https://b.com/2', ok: false, errorCode: 'connection_reset' });
    // 成功的**不进**明细 —— 这一栏只为排查失败而存在
    service.recordArticle({ url: 'https://c.com/3', ok: true });

    const failures = service.snapshot().days.at(-1)!.articleFailures;
    expect(failures).toHaveLength(2);
    expect(failures[0].url).toBe('https://b.com/2');
    expect(failures[0].code).toBe('connection_reset');
    expect(failures[1].url).toBe('https://a.com/1');
    // 时间必须是能解析的 ISO —— 页面上要按本地时区显示
    expect(Number.isNaN(new Date(failures[0].at).getTime())).toBe(false);
  });

  it('失败明细有上限，超出后丢最旧的', async () => {
    const service = new StatsService(await tempFile());

    for (let i = 0; i < MAX_FAILURES_PER_DAY + 5; i += 1) {
      service.recordArticle({ url: `https://x.com/${i}`, ok: false, errorCode: 'timeout' });
    }

    const day = service.snapshot().days.at(-1)!;
    expect(day.articleFailures).toHaveLength(MAX_FAILURES_PER_DAY);
    // 计数**不受**明细节流影响，仍然是全量 —— 两个数字口径不同，页面上要分别说明
    expect(day.articleTotal).toBe(MAX_FAILURES_PER_DAY + 5);
    // 最新的在最前，最旧的（第 0 条）已经被挤掉
    expect(day.articleFailures[0].url).toBe(`https://x.com/${MAX_FAILURES_PER_DAY + 4}`);
    expect(day.articleFailures.some((f) => f.url === 'https://x.com/0')).toBe(false);
  });

  it('翻译记请求数、块数与归一化后的语言', async () => {
    const service = new StatsService(await tempFile());

    service.recordTranslate({ url: 'https://example.com/a', targetLang: 'zh-Hans', blocks: 12 });
    service.recordTranslate({ url: 'https://example.com/a', targetLang: 'ja', blocks: 8 });
    service.recordTranslateReject('source_not_english');

    const today = service.snapshot().days.at(-1)!;
    expect(today.translateTotal).toBe(2);
    expect(today.translateBlocks).toBe(20);
    expect(today.translateLangs).toEqual({ 'zh-Hans': 1, ja: 1 });
    expect(today.translateUrls).toEqual({ 'https://example.com/a': 2 });
    expect(today.translateRejects).toEqual({ source_not_english: 1 });
  });

  it('落盘后重启能读回来（含访客指纹的去重状态与失败明细）', async () => {
    const file = await tempFile();

    const first = new StatsService(file);
    first.recordPageView({ path: '/', ip: '1.1.1.1', ua: 'UA', hasUrlParam: false });
    first.recordArticle({ url: 'https://example.com/a', ok: true });
    first.recordArticle({ url: 'https://bad.example.com/x', ok: false, errorCode: 'dns_failed' });
    await first.flush();

    const second = new StatsService(file);
    await second.onModuleInit();

    const today = second.snapshot().days.at(-1)!;
    expect(today.pageViews).toBe(1);
    expect(today.articleTotal).toBe(2);
    expect(today.articleUrls).toEqual({
      'https://example.com/a': 1,
      'https://bad.example.com/x': 1,
    });
    expect(today.articleFailures).toHaveLength(1);
    expect(today.articleFailures[0].code).toBe('dns_failed');
    expect(today.articleFailures[0].url).toBe('https://bad.example.com/x');

    // 关键：读回来以后**还认得**这个访客，同一天再访问不会重复计一次独立访客
    second.recordPageView({ path: '/', ip: '1.1.1.1', ua: 'UA', hasUrlParam: false });
    expect(second.snapshot().days.at(-1)!.visitors).toHaveLength(1);
  });

  it('统计文件坏了也不影响启动，只是从头开始', async () => {
    const file = await tempFile();
    await writeFile(file, '{ 这不是 json', 'utf8');

    const service = new StatsService(file);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.snapshot().days).toEqual([]);
  });

  it('写盘失败不抛异常（统计写坏了不能连累抓取与翻译）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewr-stats-'));
    tempDirs.push(dir);

    // 先用一个普通文件把中间那层目录占住 → 无论 mkdir 还是 writeFile 都必然失败
    await writeFile(join(dir, 'blocker'), 'x', 'utf8');
    const service = new StatsService(join(dir, 'blocker', 'stats.json'));

    expect(() =>
      service.recordPageView({ path: '/', ip: '1.1.1.1', ua: 'UA', hasUrlParam: false }),
    ).not.toThrow();
    await expect(service.flush()).resolves.toBeUndefined();
    // 内存里的数照记不误
    expect(service.snapshot().days.at(-1)!.pageViews).toBe(1);
  });

  it('没有数据时 snapshot 返回空数组而不是报错', async () => {
    const service = new StatsService(await tempFile());
    expect(service.snapshot().days).toEqual([]);
  });
});

// ============================================================================
// 鉴权
// ============================================================================

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

function fakeConfig(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('checkBasicAuth', () => {
  it('正确凭证通过', () => {
    expect(checkBasicAuth(basic('admin', 's3cret'), 'admin', 's3cret')).toBe(true);
  });

  it('用户名或密码错都不通过', () => {
    expect(checkBasicAuth(basic('admin', 'wrong'), 'admin', 's3cret')).toBe(false);
    expect(checkBasicAuth(basic('root', 's3cret'), 'admin', 's3cret')).toBe(false);
  });

  it('密码里允许有冒号（按第一个冒号切分）', () => {
    expect(checkBasicAuth(basic('admin', 'a:b:c'), 'admin', 'a:b:c')).toBe(true);
  });

  it('中文密码按 UTF-8 比对', () => {
    expect(checkBasicAuth(basic('admin', '密码'), 'admin', '密码')).toBe(true);
  });

  it('缺头 / 不是 Basic / 没有冒号 / 空值 全都不通过', () => {
    expect(checkBasicAuth(undefined, 'admin', 's3cret')).toBe(false);
    expect(checkBasicAuth('', 'admin', 's3cret')).toBe(false);
    expect(checkBasicAuth('Bearer abc', 'admin', 's3cret')).toBe(false);
    expect(checkBasicAuth('Basic !!!not-base64!!!', 'admin', 's3cret')).toBe(false);
    expect(checkBasicAuth(`Basic ${Buffer.from('admin', 'utf8').toString('base64')}`, 'admin', 's3cret')).toBe(
      false,
    );
  });

  it('密码配成空串时，空密码也进不去（fail closed）', () => {
    expect(checkBasicAuth(basic('admin', ''), 'admin', '')).toBe(false);
  });
});

describe('checkStatsKey（自定义头那条通路）', () => {
  it('密码对就通过 —— 不需要用户名', () => {
    expect(checkStatsKey('s3cret', 's3cret')).toBe(true);
  });

  it('密码错、大小写不同、多一个字符都不通过', () => {
    expect(checkStatsKey('wrong', 's3cret')).toBe(false);
    expect(checkStatsKey('S3CRET', 's3cret')).toBe(false);
    expect(checkStatsKey('s3cret ', 's3cre')).toBe(false);
  });

  it('缺头 / 空串 / 没配密码 全都不通过（fail closed）', () => {
    expect(checkStatsKey(undefined, 's3cret')).toBe(false);
    expect(checkStatsKey('', 's3cret')).toBe(false);
    expect(checkStatsKey('s3cret', '')).toBe(false);
    expect(checkStatsKey('', '')).toBe(false);
  });

  it('两端空白容忍（从输入框或 ?key= 粘过来最容易多带一个空格）', () => {
    expect(checkStatsKey(' s3cret ', 's3cret')).toBe(true);
  });

  it('中文与含冒号的密码按原样比对', () => {
    expect(checkStatsKey('密码', '密码')).toBe(true);
    expect(checkStatsKey('a:b:c', 'a:b:c')).toBe(true);
  });

  it('网关覆盖 Authorization 之后，Basic 那条路失败但这条路仍然通过', () => {
    // 线上真实形态：应用收到的是网关自己的 Bearer，客户端发的 Basic 根本到不了
    const stats = new StatsAuth(fakeConfig({ STATS_PASSWORD: 's3cret' }));
    expect(stats.verify('Bearer eyJhbGciOi...')).toBe(false);
    expect(stats.verifyKey('s3cret')).toBe(true);
  });
});

describe('StatsAuth：失败节流', () => {
  it('没配密码时 configured = false', () => {
    expect(new StatsAuth(fakeConfig({})).configured).toBe(false);
    expect(new StatsAuth(fakeConfig({ STATS_PASSWORD: '' })).configured).toBe(false);
    expect(new StatsAuth(fakeConfig({ STATS_PASSWORD: 'x' })).configured).toBe(true);
  });

  it('用户名默认 admin，可用 STATS_USER 覆盖', () => {
    expect(new StatsAuth(fakeConfig({ STATS_PASSWORD: 'x' })).username).toBe('admin');
    expect(new StatsAuth(fakeConfig({ STATS_PASSWORD: 'x', STATS_USER: '  meat  ' })).username).toBe(
      'meat',
    );
  });

  it('错 10 次后锁定，成功一次即清零', () => {
    const auth = new StatsAuth(fakeConfig({ STATS_PASSWORD: 'x' }));

    for (let i = 0; i < 9; i++) auth.registerFailure('9.9.9.9');
    expect(auth.isLocked('9.9.9.9')).toBe(false);

    auth.registerFailure('9.9.9.9');
    expect(auth.isLocked('9.9.9.9')).toBe(true);

    // 锁的是这个 IP，不是所有人
    expect(auth.isLocked('8.8.8.8')).toBe(false);

    auth.clearFailures('9.9.9.9');
    expect(auth.isLocked('9.9.9.9')).toBe(false);
  });
});

// ============================================================================
// 中间件的计数口径
// ============================================================================

describe('shouldCount：哪些请求算一次页面访问', () => {
  it('首页与 SPA 兜底路径算', () => {
    expect(shouldCount('/')).toBe(true);
    expect(shouldCount('/some/deep/path')).toBe(true);
  });

  it('静态资源不算（否则访问量会被 .js/.css 灌到十倍）', () => {
    expect(shouldCount('/assets/index-abc123.js')).toBe(false);
    expect(shouldCount('/assets/index-abc123.css')).toBe(false);
    expect(shouldCount('/docs/demo.gif')).toBe(false);
    expect(shouldCount('/index.html')).toBe(false);
    expect(shouldCount('/favicon.ico')).toBe(false);
    expect(shouldCount('/robots.txt')).toBe(false);
  });

  it('接口与统计页不算（各自单独记）', () => {
    expect(shouldCount('/api/article')).toBe(false);
    expect(shouldCount('/api/translate')).toBe(false);
    expect(shouldCount('/stats')).toBe(false);
    expect(shouldCount('/stats/anything')).toBe(false);
  });
});

describe('pathnameOf：从 originalUrl 取路径', () => {
  it('丢掉查询串', () => {
    expect(pathnameOf('/')).toBe('/');
    expect(pathnameOf('/?url=https%3A%2F%2Fx.com')).toBe('/');
    expect(pathnameOf('/pages/about?a=1&b=2')).toBe('/pages/about');
  });

  it('空串兜底成 /', () => {
    expect(pathnameOf('')).toBe('/');
  });
});

describe('createPageViewMiddleware：实际记账行为', () => {
  /** 造一个够用的假 req；用 `never` 绕开 express 那堆字段 */
  function run(
    stats: StatsService,
    originalUrl: string,
    method = 'GET',
  ): { nextCalled: boolean } {
    const middleware = createPageViewMiddleware(stats);
    const req = {
      method,
      originalUrl,
      headers: { 'user-agent': 'UA' },
      socket: { remoteAddress: '1.2.3.4' },
      query: {} as Record<string, unknown>,
      get: (key: string) => (key.toLowerCase() === 'user-agent' ? 'UA' : undefined),
    };
    let nextCalled = false;
    middleware(req as never, {} as never, () => {
      nextCalled = true;
    });
    return { nextCalled };
  }

  async function pathsOf(stats: StatsService): Promise<Record<string, number>> {
    return stats.snapshot().days.at(-1)?.paths ?? {};
  }

  it('首页与普通页面路径都会记', async () => {
    const stats = new StatsService(await tempFile());
    run(stats, '/');
    run(stats, '/pages/about?x=1');
    expect(await pathsOf(stats)).toEqual({ '/': 1, '/pages/about': 1 });
  });

  it('**回归**：判定只看 originalUrl —— /stats 挂载点不能把自己的访问算成首页', async () => {
    // 这里刻意把 originalUrl 和 Express 会剥出来的 req.path 分开：
    // 之前用模块中间件挂到 `/stats` 上时，Express 把前缀剥掉后 path 变成 `/`，
    // 于是每看一次统计就记一次首页访问，访问量虚高且全是自己人。
    const stats = new StatsService(await tempFile());
    run(stats, '/stats');
    run(stats, '/stats/whatever');
    run(stats, '/api/article?url=x');
    run(stats, '/assets/index-abc.js');
    expect(await pathsOf(stats)).toEqual({});
  });

  it('非 GET 不记，且无论如何都会放行', async () => {
    const stats = new StatsService(await tempFile());
    expect(run(stats, '/', 'POST').nextCalled).toBe(true);
    expect(await pathsOf(stats)).toEqual({});
    expect(run(stats, '/').nextCalled).toBe(true);
  });
});

describe('urlKey：统计用的 URL 键', () => {
  it('丢掉 fragment（它本来也不发给服务器，留着会把一个页面拆成两个键）', () => {
    expect(urlKey('https://example.com/a#section-2')).toBe('https://example.com/a');
    expect(urlKey('https://example.com/a#')).toBe('https://example.com/a');
  });

  it('**保留** query —— 没有它很多站点定位不到具体页面', () => {
    expect(urlKey('https://example.com/post?id=123&t=2')).toBe('https://example.com/post?id=123&t=2');
  });

  it('超长 URL 截断并带省略号（外部输入不能无上限地写进统计文件）', () => {
    const long = `https://example.com/${'x'.repeat(MAX_URL_LENGTH * 2)}`;
    const key = urlKey(long);
    expect(key.length).toBe(MAX_URL_LENGTH + 1); // MAX_URL_LENGTH 个字符 + 省略号
    expect(key.endsWith('…')).toBe(true);
  });

  it('解析不了的输入原样留一份 —— 失败明细里要能看到"用户到底输了什么"', () => {
    expect(urlKey('not a url')).toBe('not a url');
  });

  it('空输入给占位符，不留空串（空串在 Record 里当键很难看）', () => {
    expect(urlKey('')).toBe('(空)');
    expect(urlKey('   ')).toBe('(空)');
  });

  it('两头空白会被去掉', () => {
    expect(urlKey('  https://example.com/a  ')).toBe('https://example.com/a');
  });
});

// ============================================================================
// /api/stats 的响应
// ============================================================================

describe('buildStatsResponse', () => {
  it('没有数据时给一份结构完整的空响应', () => {
    const res = buildStatsResponse({
      generatedAt: '2026-10-09T01:02:03.000Z',
      filePath: '/tmp/stats.json',
      days: [],
    });

    expect(res.days).toEqual([]);
    expect(res.totalDays).toBe(0);
    expect(res.retainDays).toBe(RETAIN_DAYS);
    expect(res.maxFailuresPerDay).toBe(MAX_FAILURES_PER_DAY);
    expect(res.totals).toEqual({
      pageViews: 0,
      visitors: 0,
      directLinks: 0,
      articleTotal: 0,
      articleOk: 0,
      translateTotal: 0,
      translateBlocks: 0,
    });
  });

  it('totals 是跨天累加，不是只取最后一天', () => {
    const d1 = emptyDay('2026-10-07', 's1');
    d1.pageViews = 10;
    d1.visitors = ['a', 'b'];
    d1.articleTotal = 3;
    d1.articleOk = 2;
    d1.translateTotal = 2;
    d1.translateBlocks = 40;
    d1.directLinks = 1;

    const d2 = emptyDay('2026-10-08', 's2');
    d2.pageViews = 5;
    d2.visitors = ['c'];
    d2.articleTotal = 1;
    d2.articleOk = 1;
    d2.translateTotal = 4;
    d2.translateBlocks = 60;

    const res = buildStatsResponse({
      generatedAt: '2026-10-09T00:00:00.000Z',
      filePath: '/tmp/stats.json',
      days: [d1, d2],
    });

    expect(res.totals).toEqual({
      pageViews: 15,
      visitors: 3, // 2 + 1，按天去重后累加
      directLinks: 1,
      articleTotal: 4,
      articleOk: 3,
      translateTotal: 6,
      translateBlocks: 100,
    });
    expect(res.totalDays).toBe(2);
  });

  it('每天的 visitors 是指纹数量，不是指纹数组', () => {
    const day = emptyDay('2026-10-08', 'salt');
    day.visitors = ['deadbeefdeadbeef', 'cafebabecafebabe'];

    const res = buildStatsResponse({
      generatedAt: '2026-10-09T00:00:00.000Z',
      filePath: '/tmp/stats.json',
      days: [day],
    });

    expect(res.days[0].visitors).toBe(2);
    // 指纹本身不能出现在响应里 —— 页面要的只是"几个人"
    expect(JSON.stringify(res)).not.toContain('deadbeefdeadbeef');
  });

  it('不把服务端内部字段发出去（filePath / salt）', () => {
    const day = emptyDay('2026-10-08', 'super-secret-salt');
    day.pageViews = 1;

    const res = buildStatsResponse({
      generatedAt: '2026-10-09T00:00:00.000Z',
      filePath: '/var/app/server/data/stats.json',
      days: [day],
    });

    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('super-secret-salt');
    expect(serialized).not.toContain('/var/app/server/data');
    expect(res).not.toHaveProperty('filePath');
  });

  it('返回值不与快照共享引用 —— 之后继续打点不会污染已发出的那份', () => {
    const day = emptyDay('2026-10-08', 'salt');
    day.pageViews = 2;
    bump(day.articleUrls, 'https://example.com/a');
    day.articleFailures.push({ url: 'https://bad.example.com/x', code: 'timeout', at: ISO });

    const res = buildStatsResponse({
      generatedAt: '2026-10-09T00:00:00.000Z',
      filePath: '/tmp/stats.json',
      days: [day],
    });

    // 模拟"响应已经生成，统计还在继续记"
    day.pageViews = 99;
    day.articleUrls['https://example.com/a'] = 99;
    day.articleFailures.unshift({ url: 'https://later.example.com/y', code: 'timeout', at: ISO });

    expect(res.days[0].pageViews).toBe(2);
    expect(res.days[0].articleUrls['https://example.com/a']).toBe(1);
    expect(res.days[0].articleFailures).toHaveLength(1);
  });

  it('URL 里的怪异字符原样保留（这是数据，转义是前端的事）', () => {
    const day = emptyDay('2026-10-08', 'salt');
    bump(day.articleUrls, 'https://example.com/?q=<script>alert(1)</script>');

    const res = buildStatsResponse({
      generatedAt: '2026-10-09T00:00:00.000Z',
      filePath: '/tmp/stats.json',
      days: [day],
    });

    expect(res.days[0].articleUrls['https://example.com/?q=<script>alert(1)</script>']).toBe(1);
  });

  it('失败明细带上**从码表现解析**的可读原因', () => {
    const day = emptyDay('2026-10-08', 'salt');
    day.articleFailures.push({ url: 'https://a.com/1', code: 'blocked_by_site', at: ISO });
    day.articleFailures.push({ url: 'https://b.com/2', code: 'connection_reset', at: ISO });

    const res = buildStatsResponse({
      generatedAt: '2026-10-09T00:00:00.000Z',
      filePath: '/tmp/stats.json',
      days: [day],
    });

    const [first, second] = res.days[0].articleFailures;
    expect(first.message).toBe(ERROR_SPEC.blocked_by_site.message);
    expect(first.hint).toBe(ERROR_SPEC.blocked_by_site.hint);
    expect(second.message).toBe(ERROR_SPEC.connection_reset.message);
    // 文案必须来自码表，**不能**是落盘时存下来的第二份
    expect(first.code).toBe('blocked_by_site');
  });

  it('明细里的未知错误码不吞掉，原样当文案返回', () => {
    const day = emptyDay('2026-10-08', 'salt');
    day.articleFailures.push({ url: 'https://a.com/1', code: 'who_knows', at: ISO });

    const res = buildStatsResponse({
      generatedAt: '2026-10-09T00:00:00.000Z',
      filePath: '/tmp/stats.json',
      days: [day],
    });

    expect(res.days[0].articleFailures[0].message).toBe('who_knows');
  });

  it('errorLabels 只覆盖数据里真出现过的码，并给出可读文案', () => {
    const day = emptyDay('2026-10-08', 'salt');
    bump(day.articleErrors, 'blocked_by_site');
    bump(day.translateRejects, 'source_not_english');

    const res = buildStatsResponse({
      generatedAt: '2026-10-09T00:00:00.000Z',
      filePath: '/tmp/stats.json',
      days: [day],
    });

    expect(res.errorLabels).toEqual({
      blocked_by_site: ERROR_SPEC.blocked_by_site.message,
      source_not_english: ERROR_SPEC.source_not_english.message,
    });
    // 没出现过的码不发，免得把整张码表搬到前端
    expect(res.errorLabels.timeout).toBeUndefined();
  });

  it('空数据的 errorLabels 是空对象，不是 undefined', () => {
    const res = buildStatsResponse({
      generatedAt: '2026-10-09T00:00:00.000Z',
      filePath: '/tmp/stats.json',
      days: [],
    });
    expect(res.errorLabels).toEqual({});
  });
});
