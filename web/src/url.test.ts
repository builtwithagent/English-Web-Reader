import { describe, expect, it } from 'vitest';
import { isHttpUrl } from './url';

/**
 * `isHttpUrl` 的单测。
 *
 * 原本在 `stats.test.ts` 里（它先被统计页用上），随实现一起搬过来 ——
 * 现在它是**统计明细表**与**阅读器的原文链接**共用的那一个判断。
 */

describe('isHttpUrl：能不能当链接打开', () => {
  it('http / https 可以', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true);
    expect(isHttpUrl('http://example.com/a')).toBe(true);
  });

  it('有域名就算，哪怕没写协议（浏览器会按相对路径处理，这里按 URL 规则判）', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
  });

  it('**其它协议一律不行** —— 统计明细里存的是用户原始输入，塞进 href 就是 XSS', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
  });

  it('不是 URL 的串不行', () => {
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});
