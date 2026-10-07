import { describe, expect, it } from 'vitest';
import { buildMarkdown, suggestFileName } from './markdown';
import type { Article, Block, DisplayMode, TargetLang } from './types';

/**
 * 导出 Markdown 的单测（PRD 3.6）。
 *
 * 这段逻辑有两类错误最难发现：
 *   1. **作用域搞错** —— 用户在"仅译文"下点了导出，拿到却是一份双语文档，
 *      等于把他刚做的选择又推翻了；
 *   2. **降级态传错 mode** —— 非英文页面明明只显示了原文，导出却标着
 *      "English → 简体中文"。这一条在界面上完全看不出来，只有打开文件才知道。
 */

const AT = new Date(2026, 9, 7, 12, 34); // 本地时间 2026-10-07 12:34

const P: Block = { id: 1, type: 'p', text: 'Original paragraph.', translatable: true };
const H2: Block = { id: 2, type: 'h2', text: 'A heading', translatable: true };
const UL: Block = { id: 3, type: 'ul', items: ['first item', 'second item'], translatable: true };
const PRE: Block = {
  id: 4,
  type: 'pre',
  text: 'const a = 1;\nreturn a;',
  lang: 'js',
  translatable: false,
};
const IMG: Block = {
  id: 5,
  type: 'img',
  src: 'https://example.com/pic.png',
  alt: '一张图',
  translatable: false,
};

function makeArticle(blocks: Block[], overrides: Partial<Article> = {}): Article {
  return {
    url: 'https://example.com/post',
    finalUrl: 'https://example.com/post',
    title: 'A Post',
    byline: 'Jane Doe',
    siteName: 'Example',
    lang: 'en',
    isEnglish: true,
    extractLevel: 'readability',
    truncated: false,
    blocks,
    ...overrides,
  };
}

const TRANSLATIONS = new Map<number, string | string[]>([
  [1, '原文段落。'],
  [2, '一个标题'],
  [3, ['第一项', '第二项']],
]);

function build(
  blocks: Block[],
  mode: DisplayMode,
  {
    translations = TRANSLATIONS,
    targetLang = 'zh-Hans' as TargetLang,
    overrides = {},
  }: {
    translations?: Map<number, string | string[]>;
    targetLang?: TargetLang;
    overrides?: Partial<Article>;
  } = {},
) {
  return buildMarkdown({
    article: makeArticle(blocks, overrides),
    translations,
    mode,
    targetLang,
    exportedAt: AT,
  });
}

const lines = (md: string): string[] => md.split('\n');

// ============================================================================

describe('buildMarkdown：文件头', () => {
  const { markdown } = build([P], 'both');

  it('第一行是文章标题，空的标题退回最终地址', () => {
    expect(lines(markdown)[0]).toBe('# A Post');
    expect(lines(build([P], 'both', { overrides: { title: '' } }).markdown)[0]).toBe(
      '# https://example.com/post',
    );
  });

  it('带来源 / 站点 / 作者 / 导出时间', () => {
    expect(markdown).toContain('> **来源**：https://example.com/post');
    expect(markdown).toContain('> **站点**：Example');
    expect(markdown).toContain('> **作者**：Jane Doe');
    expect(markdown).toContain('> **导出**：2026-10-07 12:34');
  });

  it('写了格式约定（读者不用猜旁边的引用块是什么）', () => {
    expect(markdown).toContain('<!-- 格式约定：每个内容块先原文，紧随其后的引用块是它的译文。 -->');
  });

  it('站点 / 作者为空时对应那行不出现（不输出空标签）', () => {
    const md = build([P], 'both', { overrides: { byline: '', siteName: '' } }).markdown;
    expect(md).not.toContain('> **作者**');
    expect(md).not.toContain('> **站点**');
  });

  it('语言行在双语模式下给出"源 → 目标"', () => {
    expect(markdown).toContain('> **语言**：English → 简体中文');
  });

  it('语言行在仅原文模式下只写源语言', () => {
    expect(build([P], 'src').markdown).toContain('> **语言**：English');
  });

  it('语言行在仅译文模式下仍标出翻译方向', () => {
    expect(build([P], 'dst').markdown).toContain('> **语言**：English → 简体中文');
  });

  it('降级态（非英文页）由调用方传 src，导出的语言行不该凭空出现箭头', () => {
    // 这就是 handleExport 里传 effectiveMode 而不是 prefs.mode 的原因
    const md = build([P], 'src', { overrides: { lang: 'zh-Hans', isEnglish: false } }).markdown;
    expect(md).toContain('> **语言**：简体中文');
    expect(md).not.toContain('→');
  });
});

describe('buildMarkdown：显示模式决定导出范围', () => {
  it('both：原文后面紧跟它的译文引用块', () => {
    const { markdown } = build([P], 'both');
    expect(markdown).toContain('Original paragraph.');
    expect(markdown).toContain('> 原文段落。');

    const all = lines(markdown);
    const sourceAt = all.indexOf('Original paragraph.');
    expect(sourceAt).toBeGreaterThan(-1);
    // "紧随其后" —— 中间只隔空行
    expect(all.slice(sourceAt + 1).filter((line) => line !== '')[0]).toBe('> 原文段落。');
  });

  it('src：只导原文，一个字译文都不带', () => {
    const { markdown } = build([P], 'src');
    expect(markdown).toContain('Original paragraph.');
    expect(markdown).not.toContain('原文段落。');
  });

  it('dst：只导译文，不带原文', () => {
    const { markdown } = build([P], 'dst');
    expect(markdown).toContain('> 原文段落。');
    expect(markdown).not.toContain('Original paragraph.');
  });
});

describe('buildMarkdown：块的渲染', () => {
  it('标题降一级（文章标题已经占了 #）', () => {
    // h2 → ###，这样导出的文档里标题层级是连续的
    expect(build([H2], 'src').markdown).toContain('### A heading');
  });

  it('标题的译文**仍然是引用块**，不还原成标题', () => {
    // 还原的话一篇双语文档就有两套互相打架的标题层级、两套目录
    const { markdown } = build([H2], 'both');
    expect(markdown).toContain('### A heading');
    expect(markdown).toContain('> 一个标题');
    expect(markdown).not.toContain('### 一个标题');
  });

  it('代码块原样保留，带语言标注', () => {
    const { markdown } = build([PRE], 'both');
    expect(markdown).toContain('```js');
    expect(markdown).toContain('const a = 1;');
    expect(markdown).toContain('return a;');
  });

  it('代码内容里本来就有 ``` 时围栏升一级（否则代码被提前截断）', () => {
    const block: Block = { id: 1, type: 'pre', text: '```\ninner\n```', translatable: false };
    const { markdown } = build([block], 'both');
    // 外层必须是四个反引号，内层那三反引号才不会被当成围栏结束
    expect(markdown).toContain('````\n```\ninner\n```\n````');
  });

  it('图片导出成标准 Markdown 图片语法', () => {
    expect(build([IMG], 'both').markdown).toContain('![一张图](https://example.com/pic.png)');
  });

  it('代码块与图片在三种模式下都只出现一次（没有译文侧）', () => {
    for (const mode of ['both', 'src', 'dst'] as DisplayMode[]) {
      const { markdown } = build([PRE, IMG], mode);
      expect(markdown.match(/const a = 1;/g), `${mode} 下代码块重复了`).toHaveLength(1);
      expect(markdown.match(/!\[一张图\]/g), `${mode} 下图片重复了`).toHaveLength(1);
    }
  });

  it('列表块译文逐项加引用前缀，编号保持', () => {
    const { markdown } = build([UL], 'both');
    expect(markdown).toContain('- first item');
    expect(markdown).toContain('> - 第一项');
    expect(markdown).toContain('> - 第二项');
  });

  it('有序列表保留序号', () => {
    const ol: Block = { id: 1, type: 'ol', items: ['one', 'two'], translatable: true };
    const { markdown } = build([ol], 'both', {
      translations: new Map([[1, ['甲', '乙']]]),
    });
    expect(markdown).toContain('1. one');
    expect(markdown).toContain('> 1. 甲');
    expect(markdown).toContain('> 2. 乙');
  });

  it('多行译文逐行加引用前缀（否则只有第一行进引用块）', () => {
    const { markdown } = build([P], 'both', {
      translations: new Map([[1, '第一行\n第二行']]),
    });
    expect(markdown).toContain('> 第一行\n> 第二行');
  });

  it('引用块里的多行原文逐行加前缀', () => {
    const bq: Block = { id: 1, type: 'blockquote', text: 'line one\nline two', translatable: true };
    const { markdown } = build([bq], 'src');
    expect(markdown).toContain('> line one\n> line two');
  });

  it('图注用斜体', () => {
    const cap: Block = { id: 1, type: 'figcaption', text: '图注', translatable: true };
    expect(build([cap], 'src').markdown).toContain('*图注*');
  });
});

describe('buildMarkdown：缺译文时怎么办', () => {
  it('both 模式下统计缺译文的块数，并**不重复输出原文**', () => {
    const { markdown, missing } = build([P], 'both', { translations: new Map() });
    expect(missing).toBe(1);
    expect(markdown.match(/Original paragraph\./g)).toHaveLength(1);
  });

  it('dst 模式下缺译文时退回原文（总比留一片空白强）', () => {
    const { markdown, missing } = build([P], 'dst', { translations: new Map() });
    expect(missing).toBe(1);
    expect(markdown).toContain('Original paragraph.');
  });

  it('src 模式下不统计 missing —— 它本来就不要译文', () => {
    const { missing } = build([P], 'src', { translations: new Map() });
    expect(missing).toBe(0);
  });

  it('全部译出时 missing 为 0', () => {
    expect(build([P, H2, UL], 'both').missing).toBe(0);
  });

  it('只有一部分缺失时，计数准确', () => {
    const two: Block[] = [P, { id: 2, type: 'p', text: 'Second paragraph.', translatable: true }];
    const { missing } = build(two, 'both', { translations: new Map([[1, '第一段']]) });
    expect(missing).toBe(1);
  });

  it('不可译块不计入 missing（它们本来就没有译文）', () => {
    expect(build([PRE, IMG], 'both').missing).toBe(0);
  });
});

describe('buildMarkdown：文件收尾', () => {
  it('没有连续三个空行', () => {
    const { markdown } = build([P, H2, PRE, IMG], 'both');
    expect(markdown).not.toMatch(/\n{3,}/);
  });

  it('恰好以一个换行结尾（不多不少）', () => {
    const { markdown } = build([P], 'both');
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown.endsWith('\n\n')).toBe(false);
  });

  it('标题里有 markdown 特殊字符也照原样输出（不擅自转义）', () => {
    const { markdown } = build([P], 'both', { overrides: { title: 'a *b* [c]' } });
    expect(markdown.startsWith('# a *b* [c]')).toBe(true);
  });
});

describe('suggestFileName', () => {
  it('用标题做文件名，带时间戳后缀', () => {
    expect(suggestFileName(makeArticle([P]), AT)).toBe('A Post-20261007-1234.md');
  });

  it('按 Windows 非法字符表清洗 —— 名字里带 : 会直接存不下来', () => {
    const name = suggestFileName(makeArticle([P], { title: 'a/b\\c:d*e?f"g<h>i|j' }), AT);
    expect(name).toBe('a b c d e f g h i j-20261007-1234.md');
  });

  it('控制字符也被清掉', () => {
    const name = suggestFileName(makeArticle([P], { title: 'a\u0000b\u001fc' }), AT);
    expect(name).toBe('a b c-20261007-1234.md');
  });

  it('连续空白压成一个空格', () => {
    expect(suggestFileName(makeArticle([P], { title: 'a    b' }), AT)).toBe('a b-20261007-1234.md');
  });

  it('标题过长时截到 60 字（避免超出文件系统上限）', () => {
    const name = suggestFileName(makeArticle([P], { title: '长'.repeat(100) }), AT);
    expect(name).toBe(`${'长'.repeat(60)}-20261007-1234.md`);
  });

  it('没有标题就退回站点名', () => {
    const name = suggestFileName(makeArticle([P], { title: '', siteName: 'Example' }), AT);
    expect(name).toBe('Example-20261007-1234.md');
  });

  it('标题和站点名都没有就退回域名', () => {
    const name = suggestFileName(
      makeArticle([P], { title: '', siteName: '', finalUrl: 'https://example.com/x' }),
      AT,
    );
    expect(name).toBe('example.com-20261007-1234.md');
  });

  it('什么都没有也要给一个能用的名字（不能是 .md）', () => {
    const name = suggestFileName(
      makeArticle([P], { title: '', siteName: '', finalUrl: 'not a url' }),
      AT,
    );
    expect(name).toBe('article-20261007-1234.md');
  });

  it('清洗后只剩空白的标题 → 落到 `article` 兜底', () => {
    // 注意它不会回头去找站点名：`title || siteName` 是在清洗**之前**取的。
    // 结果仍是个能用的文件名，够用。
    const name = suggestFileName(makeArticle([P], { title: '///', siteName: 'Example' }), AT);
    expect(name).toBe('article-20261007-1234.md');
  });
});
