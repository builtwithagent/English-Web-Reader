import { describe, expect, it } from 'vitest';
import { STATS_KEY_STORAGE, parseStatsKey } from './statsKey';

describe('parseStatsKey', () => {
  it('从 ?key= 里取出密钥', () => {
    expect(parseStatsKey('?key=s3cret')).toBe('s3cret');
  });

  it('没有前导问号也认（`location.search` 之外直接喂查询串的情况）', () => {
    expect(parseStatsKey('key=s3cret')).toBe('s3cret');
  });

  it('密钥里的中文与特殊字符按原样还原', () => {
    expect(parseStatsKey(`?key=${encodeURIComponent('密码:1')}`)).toBe('密码:1');
  });

  it('两端空白去掉（粘过来最容易多带空格）', () => {
    expect(parseStatsKey('?key=%20s3cret%20')).toBe('s3cret');
  });

  it('没有 key / 空值 / 只有空白 / 别的参数 一律是 null', () => {
    expect(parseStatsKey('')).toBe(null);
    expect(parseStatsKey('?foo=1')).toBe(null);
    expect(parseStatsKey('?key=')).toBe(null);
    expect(parseStatsKey('?key=%20%20')).toBe(null);
  });

  it('重复的 key 取第一个（与 URLSearchParams 的行为一致，写下来免得日后改动踩空）', () => {
    expect(parseStatsKey('?key=first&key=second')).toBe('first');
  });

  it('存储键名固定 —— 改它等于让所有人重新输一次密码', () => {
    expect(STATS_KEY_STORAGE).toBe('statsKey');
  });
});
