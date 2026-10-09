import { describe, expect, it } from 'vitest';
import { AI_TRANSLATION_NOTE, buildAttribution } from './attribution';

/**
 * 出处署名的加工逻辑（技术方案 7.11）。
 *
 * 全是"缺字段怎么办"的兜底：站点名没有、作者没有、地址不安全。
 * 这些在页面上出问题时只是"少了一行字"，没人会当 bug 报 —— 所以要在这里钉住。
 */

const article = (over: Partial<{ finalUrl: string; siteName: string; byline: string }>) => ({
  finalUrl: 'https://example.com/posts/1',
  siteName: 'Example Blog',
  byline: 'Jane Doe',
  ...over,
});

describe('buildAttribution：出处署名', () => {
  it('字段齐全时原样用', () => {
    const a = buildAttribution(article({}));
    expect(a).toEqual({
      href: 'https://example.com/posts/1',
      source: 'Example Blog',
      byline: 'Jane Doe',
      credit: '原文出自 Example Blog · Jane Doe',
    });
  });

  it('缺站点名 → 出处退回"原文"（不留空位，也不写 undefined）', () => {
    const a = buildAttribution(article({ siteName: '' }));
    expect(a.source).toBe('原文');
    expect(a.credit).toBe('原文出自 原文 · Jane Doe');
  });

  it('缺作者 → 署名句里**不出现**那个分隔点（不能留下"原文出自 X ·"这种尾巴）', () => {
    const a = buildAttribution(article({ byline: '' }));
    expect(a.byline).toBe('');
    expect(a.credit).toBe('原文出自 Example Blog');
  });

  it('两端空白要吃掉（抓下来的字段常带换行与空格）', () => {
    const a = buildAttribution(article({ siteName: '  Example Blog\n', byline: ' Jane ' }));
    expect(a.source).toBe('Example Blog');
    expect(a.byline).toBe('Jane');
  });

  it('**不是 http(s) 的地址不给链接** —— 那是 XSS，不是显示问题', () => {
    // 服务端给的 finalUrl 按构造一定是 http(s)，但渲染 href 的地方自己把关，
    // 比"相信上游永远给对的"可靠：上游多出别的来源时，改的是这里一处。
    expect(buildAttribution(article({ finalUrl: 'javascript:alert(1)' })).href).toBeNull();
    expect(buildAttribution(article({ finalUrl: 'not a url' })).href).toBeNull();
    expect(buildAttribution(article({ finalUrl: '' })).href).toBeNull();
  });

  it('地址不安全时**其余部分照常给**（署名不该因为链接不可用而一起消失）', () => {
    const a = buildAttribution(article({ finalUrl: 'javascript:alert(1)' }));
    expect(a.href).toBeNull();
    expect(a.source).toBe('Example Blog');
  });

  it('http（非 https）也是合法原文链接', () => {
    expect(buildAttribution(article({ finalUrl: 'http://old.example.com/x' })).href).toBe(
      'http://old.example.com/x',
    );
  });
});

describe('AI_TRANSLATION_NOTE：声明文案', () => {
  it('说的是"AI 生成 + 仅供参考"，不夸大也不隐瞒', () => {
    expect(AI_TRANSLATION_NOTE).toContain('AI');
    expect(AI_TRANSLATION_NOTE).toContain('仅供参考');
  });
});
