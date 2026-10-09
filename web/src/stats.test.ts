import { describe, expect, it } from 'vitest';
import { barWidth, formatLocalClock, formatLocalTime, formatNumber, topEntries } from './stats';
import { normalizePath } from './router';

/**
 * 统计页纯函数单测。
 *
 * 这里几条错了**页面上看不出来**：多一项少一项、条宽少了 1%、数字少了千分位，
 * 肉眼都不会觉得不对。而这张表的作用就是让人相信数字，所以规则要锁死。
 */

describe('topEntries：取前 n 项', () => {
  it('按次数倒序', () => {
    expect(topEntries({ a: 3, b: 9, c: 1 }, 3)).toEqual([
      ['b', 9],
      ['a', 3],
      ['c', 1],
    ]);
  });

  it('并列时按键名排 —— 同一份数据每次渲染顺序必须一致', () => {
    const map = { zeta: 5, alpha: 5, mid: 5 };
    expect(topEntries(map, 3).map(([key]) => key)).toEqual(['alpha', 'mid', 'zeta']);
    // 换个插入顺序，结果不变
    expect(topEntries({ mid: 5, zeta: 5, alpha: 5 }, 3).map(([key]) => key)).toEqual([
      'alpha',
      'mid',
      'zeta',
    ]);
  });

  it('截断到 n 项', () => {
    const map = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(topEntries(map, 8)).toHaveLength(8);
    expect(topEntries(map, 8)[0]).toEqual(['k29', 29]);
  });

  it('空表给空数组；n 超过项数就全给', () => {
    expect(topEntries({}, 8)).toEqual([]);
    expect(topEntries({ a: 1 }, 8)).toEqual([['a', 1]]);
  });

  it('丢掉非有限值，不把 NaN / Infinity 带进排序', () => {
    // NaN 参与比较会让 Array#sort 的结果不可预测；Infinity 则会让所有条都变成 0 宽度。
    // 两者都不该出现在响应里（JSON 表示不出它们），真出现了就当没有这一项
    expect(topEntries({ a: 1, nan: Number.NaN, inf: Number.POSITIVE_INFINITY }, 5)).toEqual([
      ['a', 1],
    ]);
  });
});

describe('formatNumber：千分位', () => {
  it('按三位加分隔符', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(7)).toBe('7');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(12345)).toBe('12,345');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  it('负数也加（虽然统计里不该出现，但别输出成 `-1,2,34`）', () => {
    expect(formatNumber(-1234)).toBe('-1,234');
  });

  it('非有限值兜成 0，不显示 "NaN"', () => {
    expect(formatNumber(Number.NaN)).toBe('0');
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('barWidth：条形宽度', () => {
  it('按相对最大值取百分比', () => {
    expect(barWidth(10, 10)).toBe(100);
    expect(barWidth(5, 10)).toBe(50);
  });

  it('最低 2% —— 0 宽度的条看起来像"这项没数据"，而它只是相对小', () => {
    expect(barWidth(1, 1000)).toBe(2);
    expect(barWidth(0.0001, 1)).toBe(2);
  });

  it('空数据 / 脏数据返回 0，绝不返回 NaN', () => {
    // NaN 会让 style 变成 `width:NaN%`，CSS 直接忽略、条不见了，而且不报错
    expect(barWidth(0, 0)).toBe(0);
    expect(barWidth(5, 0)).toBe(0);
    expect(barWidth(Number.NaN, 10)).toBe(0);
    expect(barWidth(5, Number.NaN)).toBe(0);
    expect(barWidth(5, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('超过最大值也不超过 100%', () => {
    expect(barWidth(20, 10)).toBe(100);
  });
});

describe('formatLocalTime', () => {
  it('输出本地时间 `YYYY-MM-DD HH:mm:ss`', () => {
    // 用本地时区构造，避免测试机时区不同导致断言飘
    const local = new Date(2026, 9, 9, 8, 3, 7);
    expect(formatLocalTime(local.toISOString())).toBe('2026-10-09 08:03:07');
  });

  it('解析不出来就原样返回，不显示 Invalid Date', () => {
    expect(formatLocalTime('not-a-date')).toBe('not-a-date');
  });
});

describe('formatLocalClock：明细表只要时分秒', () => {
  it('输出 `HH:mm:ss`', () => {
    const local = new Date(2026, 9, 9, 8, 3, 7);
    expect(formatLocalClock(local.toISOString())).toBe('08:03:07');
  });

  it('补零', () => {
    const local = new Date(2026, 9, 9, 0, 0, 5);
    expect(formatLocalClock(local.toISOString())).toBe('00:00:05');
  });

  it('解析不出来给空串，不显示 NaN:NaN', () => {
    expect(formatLocalClock('not-a-date')).toBe('');
  });
});

describe('normalizePath：路径归一', () => {
  it('结尾斜杠与重复斜杠视作同一个页面', () => {
    expect(normalizePath('/stats')).toBe('/stats');
    expect(normalizePath('/stats/')).toBe('/stats');
    expect(normalizePath('/stats//')).toBe('/stats');
    expect(normalizePath('//stats')).toBe('/stats');
  });

  it('根路径与空串都归一成 `/`', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
  });

  it('不认识的多级路径原样保留（当前会落到阅读器）', () => {
    expect(normalizePath('/a/b/')).toBe('/a/b');
  });
});
