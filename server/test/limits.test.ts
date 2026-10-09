import { describe, expect, it } from 'vitest';
import { ERROR_SPEC } from '../src/common/errors';
import {
  DEFAULT_ARTICLE_LIMITS,
  articleLimitError,
  articleLimitHint,
  makeArticleLimiter,
  readArticleLimitSpec,
} from '../src/article/article.limits';
import {
  DEFAULT_TRANSLATE_LIMITS,
  limitError,
  limitHint,
  makeTranslateLimiter,
  readTranslateLimitSpec,
} from '../src/translate/translate.limits';

/**
 * 两条链路的额度配置与文案（技术方案 7.8.1）。
 *
 * 机制在 `test/rate-limit.test.ts`，这里只管**这条路径特有**的三件事：
 * 环境变量名对不对、默认值合不合理、被拦时那句话说不说得清。
 */

const from = (map: Record<string, string>) => (key: string) => map[key];

describe('翻译侧：默认值与环境变量', () => {
  it('什么都没配 → 用默认值（公开站点不该"因为没配所以没有限流"）', () => {
    expect(readTranslateLimitSpec(from({}))).toEqual(DEFAULT_TRANSLATE_LIMITS);
    expect(DEFAULT_TRANSLATE_LIMITS.perMinute).toBeGreaterThan(0);
    expect(DEFAULT_TRANSLATE_LIMITS.perIpPerDay).toBeGreaterThan(0);
    expect(DEFAULT_TRANSLATE_LIMITS.globalPerDay).toBeGreaterThan(0);
  });

  it('三个键各自独立生效（写错一个不会连带影响另外两个）', () => {
    const spec = readTranslateLimitSpec(
      from({
        TRANSLATE_PER_MINUTE: '10',
        TRANSLATE_BLOCKS_PER_IP_PER_DAY: '200',
        TRANSLATE_BLOCKS_PER_DAY: '3000',
      }),
    );
    expect(spec).toEqual({ perMinute: 10, perIpPerDay: 200, globalPerDay: 3000 });
  });

  it('每 IP 的日额度**小于**全站日额度（写反了就等于每 IP 那道永远先拦，全站那道形同虚设）', () => {
    expect(DEFAULT_TRANSLATE_LIMITS.perIpPerDay).toBeLessThan(DEFAULT_TRANSLATE_LIMITS.globalPerDay);
  });

  it('填 0 = 关掉那道闸门（私下自己用可以全关）', () => {
    const spec = readTranslateLimitSpec(
      from({ TRANSLATE_PER_MINUTE: '0', TRANSLATE_BLOCKS_PER_IP_PER_DAY: '0', TRANSLATE_BLOCKS_PER_DAY: '0' }),
    );
    expect(spec).toEqual({ perMinute: 0, perIpPerDay: 0, globalPerDay: 0 });
  });

  it('makeTranslateLimiter 拿到的就是同一份 spec', () => {
    const limiter = makeTranslateLimiter(from({ TRANSLATE_PER_MINUTE: '3' }));
    expect(limiter.spec.perMinute).toBe(3);
    expect(limiter.spec.globalPerDay).toBe(DEFAULT_TRANSLATE_LIMITS.globalPerDay);
  });
});

describe('抓取侧：默认值与环境变量', () => {
  it('默认**没有**全站日额度 —— 抓取不花上游的钱，而"用得多"本身是好事', () => {
    expect(DEFAULT_ARTICLE_LIMITS.globalPerDay).toBe(0);
    // 但每 IP 那两道要在，否则一个脚本就能把我们的出网 IP 打进别人黑名单
    expect(DEFAULT_ARTICLE_LIMITS.perMinute).toBeGreaterThan(0);
    expect(DEFAULT_ARTICLE_LIMITS.perIpPerDay).toBeGreaterThan(0);
  });

  it('每分钟额度比翻译侧宽（一次抓取 = 一次 HTTP 请求，一次翻译 = 几十次）', () => {
    expect(DEFAULT_ARTICLE_LIMITS.perMinute).toBeGreaterThan(DEFAULT_TRANSLATE_LIMITS.perMinute);
  });

  it('环境变量能覆盖，包括把全站那道闸临时拉上', () => {
    const spec = readArticleLimitSpec(
      from({ ARTICLE_PER_MINUTE: '5', ARTICLE_PAGES_PER_IP_PER_DAY: '50', ARTICLE_PAGES_PER_DAY: '500' }),
    );
    expect(spec).toEqual({ perMinute: 5, perIpPerDay: 50, globalPerDay: 500 });
  });

  it('makeArticleLimiter 拿到的就是同一份 spec', () => {
    expect(makeArticleLimiter(from({ ARTICLE_PER_MINUTE: '7' })).spec.perMinute).toBe(7);
  });
});

describe('被拦时给用户看的那句话', () => {
  it('频率：说清"多少 / 还要等多久"（只说"稍后再试"会让人反复刷新，把限额撞得更响）', () => {
    const hint = limitHint('per_minute', DEFAULT_TRANSLATE_LIMITS, 42);
    expect(hint).toContain('42');
    expect(hint).toContain(String(DEFAULT_TRANSLATE_LIMITS.perMinute));
  });

  it('日额度：说清上限与"什么时候恢复"（不然用户会一直试到今天结束）', () => {
    expect(limitHint('per_ip_per_day', DEFAULT_TRANSLATE_LIMITS, 0)).toContain('明天零点恢复');
    expect(limitHint('global_per_day', DEFAULT_TRANSLATE_LIMITS, 0)).toContain('明天零点恢复');
    expect(limitHint('global_per_day', DEFAULT_TRANSLATE_LIMITS, 0)).toContain(
      String(DEFAULT_TRANSLATE_LIMITS.globalPerDay),
    );
  });

  it('抓取侧同理，且不会把"翻译"两个字串进去', () => {
    expect(articleLimitHint('per_ip_per_day', DEFAULT_ARTICLE_LIMITS, 0)).toContain('抓取');
    expect(articleLimitHint('per_ip_per_day', DEFAULT_ARTICLE_LIMITS, 0)).not.toContain('翻译');
  });
});

describe('被拦时抛的异常', () => {
  it('频率 → too_many_requests（429），额度 → daily_limit_reached（429）', () => {
    const fast = limitError('per_minute', DEFAULT_TRANSLATE_LIMITS, 5);
    expect(fast.code).toBe('too_many_requests');
    expect(fast.status).toBe(429);
    expect(fast.message).toBe(ERROR_SPEC.too_many_requests.message);

    const quota = limitError('global_per_day', DEFAULT_TRANSLATE_LIMITS, 0);
    expect(quota.code).toBe('daily_limit_reached');
    expect(quota.status).toBe(429);
  });

  it('hint 是**覆盖**上去的：主文案仍然只在 errors.ts 一处定义', () => {
    const payload = limitError('per_minute', DEFAULT_TRANSLATE_LIMITS, 9).toPayload();
    expect(payload.error.message).toBe(ERROR_SPEC.too_many_requests.message);
    expect(payload.error.hint).toContain('9');
  });

  it('抓取侧走同一套码（页面上一眼能看出是哪条链路被拦的）', () => {
    expect(articleLimitError('per_minute', DEFAULT_ARTICLE_LIMITS, 3).code).toBe('too_many_requests');
    expect(articleLimitError('per_ip_per_day', DEFAULT_ARTICLE_LIMITS, 0).code).toBe(
      'daily_limit_reached',
    );
    expect(articleLimitError('per_minute', DEFAULT_ARTICLE_LIMITS, 3).status).toBe(429);
  });
});
