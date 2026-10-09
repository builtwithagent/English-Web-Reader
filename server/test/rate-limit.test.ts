import { describe, expect, it } from 'vitest';
import {
  MINUTE_WINDOW_MS,
  RateLimiter,
  describeLimitSpec,
  limitErrorCode,
  readLimitNumber,
  type LimitSpec,
  type LimitTicket,
} from '../src/common/rate-limit';

/**
 * 额度闸门的机制测试（技术方案 7.8.1）。
 *
 * 这一层最容易写错的是**时间**：分钟窗口、跨天清零、退款要不要跨天生效。
 * 所以所有用例都把 `now` 显式传进去，不用 `vi.useFakeTimers()` ——
 * 真时钟会让"窗口滑出后恢复"这类用例变成要么慢 60 秒、要么随机翻绿翻红。
 */

/** 全部关掉，用例再按需打开某一两道 */
const ANY: LimitSpec = { perMinute: 0, perIpPerDay: 0, globalPerDay: 0 };

function limiter(partial: Partial<LimitSpec>): RateLimiter {
  return new RateLimiter({ ...ANY, ...partial });
}

const T0 = new Date(2026, 9, 10, 12, 0, 0);
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const IP = '203.0.113.7';
const OTHER = '198.51.100.9';

describe('RateLimiter：每分钟这道闸门', () => {
  it('限额内放行，超了拦住', () => {
    const l = limiter({ perMinute: 2 });
    expect(l.take(IP, 1, T0).ok).toBe(true);
    expect(l.take(IP, 1, T0).ok).toBe(true);

    const blocked = l.take(IP, 1, T0);
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.reason).toBe('per_minute');
  });

  it('窗口滑出去之后自动恢复（不需要任何定时器）', () => {
    const l = limiter({ perMinute: 1 });
    expect(l.take(IP, 1, T0).ok).toBe(true);
    expect(l.take(IP, 1, T0).ok).toBe(false);
    // 差 1ms 就还占着名额 —— 边界是"满一分钟"（`at > cutoff`），不是"差不多一分钟"
    expect(l.take(IP, 1, at(MINUTE_WINDOW_MS - 1)).ok).toBe(false);
    expect(l.take(IP, 1, at(MINUTE_WINDOW_MS)).ok).toBe(true);
  });

  it('给出"还要等几秒"，让页面能说人话', () => {
    const l = limiter({ perMinute: 1 });
    l.take(IP, 1, T0);
    const blocked = l.take(IP, 1, at(20_000)); // 已过 20 秒，还差 40 秒
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.retryAfterSec).toBe(40);
  });

  it('按 IP 分开算', () => {
    const l = limiter({ perMinute: 1 });
    l.take(IP, 1, T0);
    expect(l.take(OTHER, 1, T0).ok).toBe(true);
  });

  it('一次请求里的多个单位只占**一个**次数名额（单位数是量，不是次数）', () => {
    const l = limiter({ perMinute: 1 });
    expect(l.take(IP, 200, T0).ok).toBe(true);
    expect(l.take(IP, 1, T0).ok).toBe(false);
  });
});

describe('RateLimiter：日额度', () => {
  it('每 IP 的额度按**单位数**累计，不是按请求数', () => {
    const l = limiter({ perIpPerDay: 5 });
    expect(l.take(IP, 3, T0).ok).toBe(true);
    expect(l.usedToday(IP, T0)).toBe(3);

    // 想再要 3 个 → 3+3 > 5，整笔拒绝
    // （**不是**"先放进来再算"，那样额度会被系统性超支，超出的部分正好是并发数）
    expect(l.take(IP, 3, T0).ok).toBe(false);
    expect(l.usedToday(IP, T0)).toBe(3);
    // 恰好用满还是可以的
    expect(l.take(IP, 2, T0).ok).toBe(true);
    expect(l.take(IP, 1, T0).ok).toBe(false);
  });

  it('被拦的那一次**一分都不扣**（判定全部通过才预扣）', () => {
    // 如果边判边扣，被 per_minute 拦下的那次已经把日额度消耗掉了 ——
    // 用户重试几次，真额度就没了，而他一次译文都没拿到。
    const l = limiter({ perMinute: 1, perIpPerDay: 10 });
    expect(l.take(IP, 1, T0).ok).toBe(true); // 花了 1
    expect(l.take(IP, 1, T0).ok).toBe(false); // per_minute 拦，不该花钱
    expect(l.take(IP, 1, at(MINUTE_WINDOW_MS + 1)).ok).toBe(true); // 窗口过了，日额度还剩

    expect(l.usedToday(IP, T0)).toBe(2);
  });

  it('全站额度跨 IP 累计（这才是唯一"保钱"的那道）', () => {
    const l = limiter({ globalPerDay: 5 });
    expect(l.take(IP, 3, T0).ok).toBe(true);
    expect(l.take(OTHER, 2, T0).ok).toBe(true);
    // 两个 IP 各自的额度都没事，但全站见底了
    expect(l.take('192.0.2.1', 1, T0).ok).toBe(false);
  });

  it('换天自动清零（按本地时区切，与统计同一个口径）', () => {
    const l = limiter({ perIpPerDay: 1, globalPerDay: 1 });
    const beforeMidnight = new Date(2026, 9, 10, 23, 59, 0);
    const afterMidnight = new Date(2026, 9, 11, 0, 1, 0);

    expect(l.take(IP, 1, beforeMidnight).ok).toBe(true);
    expect(l.take(IP, 1, beforeMidnight).ok).toBe(false);
    expect(l.take(IP, 1, afterMidnight).ok).toBe(true);
    expect(l.usedToday(IP, afterMidnight)).toBe(1);
  });

  it('usage() 跨天之后报 0（看板上"今天用了多少"不能显示昨天的数）', () => {
    const l = limiter({ globalPerDay: 100 });
    l.take(IP, 5, T0);
    expect(l.usage(T0).globalUnits).toBe(5);
    expect(l.usage(new Date(2026, 9, 11, 8, 0, 0)).globalUnits).toBe(0);
  });
});

describe('RateLimiter：预扣凭据与回滚', () => {
  it('凭据记着"当时扣了哪几笔"，因为关掉的那道不该被减', () => {
    const l = limiter({ perIpPerDay: 5, globalPerDay: 0 });
    const verdict = l.take(IP, 2, T0);
    expect(verdict.ok).toBe(true);
    const ticket = verdict.ok ? verdict.ticket : null;
    expect(ticket).toMatchObject({ ip: IP, units: 2, chargedIpDay: true, chargedGlobal: false });
  });

  it('退款把日额度退回去', () => {
    const l = limiter({ perIpPerDay: 5 });
    const verdict = l.take(IP, 5, T0);
    l.refund(verdict.ok ? verdict.ticket : null, T0);
    expect(l.usedToday(IP, T0)).toBe(0);
    expect(l.take(IP, 5, T0).ok).toBe(true);
  });

  it('退款**不退**分钟窗口（否则"失败了就重试"能把速率限制洗掉）', () => {
    const l = limiter({ perMinute: 1, perIpPerDay: 10 });
    const verdict = l.take(IP, 1, T0);
    l.refund(verdict.ok ? verdict.ticket : null, T0);
    expect(l.take(IP, 1, T0).ok).toBe(false);
  });

  it('跨天不退款：今天不该被昨天那笔的退款抬高', () => {
    const l = limiter({ globalPerDay: 5 });
    const day1 = new Date(2026, 9, 10, 23, 59, 0);
    const day2 = new Date(2026, 9, 11, 0, 1, 0);

    const verdict = l.take(IP, 5, day1);
    l.take(IP, 5, day2); // 新的一天，全站额度重新算
    l.refund(verdict.ok ? verdict.ticket : null, day2);

    expect(l.usage(day2).globalUnits).toBe(5);
  });

  it('重复退款不会把账减成负数', () => {
    const l = limiter({ perIpPerDay: 5 });
    const verdict = l.take(IP, 3, T0);
    const ticket = verdict.ok ? verdict.ticket : null;
    l.refund(ticket, T0);
    l.refund(ticket, T0);
    expect(l.usedToday(IP, T0)).toBe(0);
  });

  it('refund(null / undefined) 是空操作', () => {
    const l = limiter({ perIpPerDay: 5 });
    expect(() => l.refund(null, T0)).not.toThrow();
    expect(() => l.refund(undefined, T0)).not.toThrow();
  });
});

describe('RateLimiter：边界输入', () => {
  it('单位数是 NaN / 负数 / 小数时都能兜住（Math.max 不防 NaN，别用那个写法）', () => {
    const l = limiter({ perIpPerDay: 1 });

    const nan = l.take(IP, Number.NaN, T0);
    expect(nan.ok).toBe(true);
    expect(nan.ok && nan.ticket.units).toBe(0);

    const negative = l.take(IP, -3, T0);
    expect(negative.ok && negative.ticket.units).toBe(0);
    // 前两次都没占额度 → 这一笔 1 单位还放得下
    expect(l.take(IP, 1, T0).ok).toBe(true);

    const frac = l.take(OTHER, 0.9, T0);
    expect(frac.ok && frac.ticket.units).toBe(0);
  });

  it('上限配成 0 / 负数 = 关闭这道闸门', () => {
    const l = limiter({ perMinute: 0, perIpPerDay: -1, globalPerDay: 0 });
    for (let i = 0; i < 50; i++) expect(l.take(IP, 100, T0).ok).toBe(true);
  });

  it('几千个不同 IP 轮着来也不会把内存撑爆（超出阈值就清窗口外的记录）', () => {
    const l = limiter({ perMinute: 3 });
    for (let i = 0; i < 6000; i++) {
      expect(l.take(`10.0.${Math.floor(i / 256)}.${i % 256}`, 1, T0).ok).toBe(true);
    }
    // 清完之后新 IP 照常，而且**额度一点没被清乱**
    expect(l.take(IP, 1, T0).ok).toBe(true);
    expect(l.take(IP, 1, T0).ok).toBe(true);
    expect(l.take(IP, 1, T0).ok).toBe(true);
    expect(l.take(IP, 1, T0).ok).toBe(false);
  });
});

describe('readLimitNumber：三态语义', () => {
  const from = (map: Record<string, string>) => (key: string) => map[key];

  it('没配 / 空串 → 用默认值', () => {
    expect(readLimitNumber(from({}), 'X', 5)).toBe(5);
    expect(readLimitNumber(from({ X: '' }), 'X', 5)).toBe(5);
    expect(readLimitNumber(from({ X: '   ' }), 'X', 5)).toBe(5);
  });

  it('显式 0 或负数 → 关掉这道闸门（这是唯一"关"的写法）', () => {
    expect(readLimitNumber(from({ X: '0' }), 'X', 5)).toBe(0);
    expect(readLimitNumber(from({ X: '-1' }), 'X', 5)).toBe(-1);
  });

  it('写错了（不是数字）→ **回落默认值，而不是关掉**', () => {
    // 这是刻意的：手滑写成 `abc` 时宁可继续保护，
    // 也不要静默地把闸门全打开 —— 那是最不容易被发现的失败方式。
    expect(readLimitNumber(from({ X: 'abc' }), 'X', 5)).toBe(5);
    expect(readLimitNumber(from({ X: '10x' }), 'X', 5)).toBe(5);
    expect(readLimitNumber(from({ X: 'Infinity' }), 'X', 5)).toBe(5);
  });

  it('正常数值向下取整（配了小数不报错，也别留个小数在计数器里）', () => {
    expect(readLimitNumber(from({ X: '42' }), 'X', 5)).toBe(42);
    expect(readLimitNumber(from({ X: '3.9' }), 'X', 5)).toBe(3);
  });
});

describe('limitErrorCode：频率与额度分开', () => {
  it('每分钟超限 → too_many_requests；日额度用尽 → daily_limit_reached', () => {
    expect(limitErrorCode('per_minute')).toBe('too_many_requests');
    expect(limitErrorCode('per_ip_per_day')).toBe('daily_limit_reached');
    expect(limitErrorCode('global_per_day')).toBe('daily_limit_reached');
  });
});

describe('describeLimitSpec：启动日志里的那一行', () => {
  it('把三个数摊开，0 显示成"不限"（免得日志里一个 0 被误读成"零额度"）', () => {
    const text = describeLimitSpec({ perMinute: 6, perIpPerDay: 1500, globalPerDay: 0 });
    expect(text).toContain('6');
    expect(text).toContain('1500');
    expect(text).toContain('不限');
  });
});
