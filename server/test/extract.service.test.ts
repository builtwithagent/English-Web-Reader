import { describe, expect, it } from 'vitest';
import { AppError } from '../src/common/errors';
import { ExtractService, translatableLength } from '../src/article/extract.service';
import type { Block } from '../src/article/extract.service';

/**
 * 正文提取的单测（技术方案 4.5）。
 *
 * 三级降级（Readability → 启发式 → body）里的前两级很难用单测精确覆盖 ——
 * 它们的行为跟站点结构强相关，真正的验收是 `npm run smoke` 打真实网页。
 * 这里覆盖的是**不依赖站点、但出错代价很大**的三类：
 *
 *   1. **块契约** —— id 从 1 连续、pre/img 恒为不可译、图片地址必须绝对化。
 *      前端靠 id 做左右对齐与译文回填，这个契约破了整篇会错位。
 *   2. **导语**（曾经丢过）—— Readability 会把页面导语当 excerpt 摘走。
 *      补回时必须**只补一次**，也要能识别"这段其实只是 meta description"。
 *   3. **失败要能说清为什么** —— SPA 外壳报 `js_rendered`，而不是笼统的 `extract_failed`。
 */

const ARTICLE_URL = 'https://example.com/posts/hello';

/** 只在 <meta name="description"> 里出现，页面上并不存在这段文字 */
const META_ONLY = 'META_ONLY_MARKER 这是给搜索引擎看的摘要，不在页面上。';
/** 页面上真实存在的导语 */
const DEK = 'DEK_MARKER 这是页面上的导语，Readability 会把它当作 excerpt 摘走。';

/** 撑过 Readability 的 charThreshold（200 字符）所需的正文 */
const BODY_PARAGRAPHS = [
  'The first section explains what the whole article is about and why it matters to anyone who happens to be reading it today. It rambles a little, as introductory paragraphs tend to do.',
  'The second paragraph adds a bit more context, mentions a few numbers, and generally fills the space so that the extraction algorithm has something substantial to work with.',
  'A third paragraph is included for good measure, because a two paragraph article is not really an article at all, and readers deserve better than that.',
].map((text) => `<p>${text}</p>`).join('\n      ');

function fixture({
  description = META_ONLY,
  dek = DEK,
  includeDek = true,
}: { description?: string | null; dek?: string; includeDek?: boolean } = {}): string {
  const metaDescription = description === null ? '' : `<meta name="description" content="${description}">`;
  const dekParagraph = includeDek ? `<p class="dek">${dek}</p>` : '';

  return `<!DOCTYPE html>
<html lang="en-US">
<head>
  <meta charset="utf-8">
  <title>文档标题（不该盖过 og:title）</title>
  <meta property="og:title" content="OG 标题">
  <meta property="og:site_name" content="Example Blog">
  <meta name="author" content="Jane Doe">
  ${metaDescription}
</head>
<body>
  <nav><a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav>
  <article>
    <h1>OG 标题</h1>
    ${dekParagraph}
    <h2>First section</h2>
    ${BODY_PARAGRAPHS}
    <ul>
      <li>第一个列表项，写得足够长以便被保留下来。</li>
      <li>第二个列表项，同样写得足够长以便被保留下来。</li>
    </ul>
    <pre><code class="language-js">const a = 1;
function f() {
  return a;
}</code></pre>
    <figure>
      <img src="/images/pic.png" alt="一张示意图">
      <figcaption>图注文字在这里。</figcaption>
    </figure>
    <p>Closing paragraph so that the article does not end on a figure element.</p>
  </article>
  <footer>版权所有 2026 Example</footer>
  <script>window.analytics = { track() {} };</script>
</body>
</html>`;
}

function extract(html: string) {
  return new ExtractService().extract(html, ARTICLE_URL);
}

function textOf(block: Block): string {
  return block.text ?? (block.items ?? []).join(' ');
}

function findByType(blocks: Block[], type: Block['type']): Block[] {
  return blocks.filter((b) => b.type === type);
}

// ============================================================================

describe('extract：元信息', () => {
  const result = extract(fixture());

  it('标题优先取 og:title，不被 <title> 盖过', () => {
    expect(result.title).toBe('OG 标题');
  });

  it('作者取 meta[name=author]', () => {
    expect(result.byline).toBe('Jane Doe');
  });

  it('站点名取 og:site_name', () => {
    expect(result.siteName).toBe('Example Blog');
  });

  it('页面语言取自 html lang（只用于兜底，判定仍以正文为准）', () => {
    expect(result.htmlLang).toBe('en-US');
  });

  it('记录了实际生效的提取级别', () => {
    expect(['readability', 'heuristic', 'body']).toContain(result.extractLevel);
  });
});

describe('extract：块契约（前端靠它做左右对齐与译文回填）', () => {
  const { blocks } = extract(fixture());

  it('id 从 1 起连续递增，没有空洞', () => {
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.map((b) => b.id)).toEqual(blocks.map((_, i) => i + 1));
  });

  it('代码块被保留、不参与翻译、换行原样保留', () => {
    const pre = findByType(blocks, 'pre');
    expect(pre).toHaveLength(1);
    expect(pre[0].translatable).toBe(false);
    expect(pre[0].text).toContain('function f() {');
    expect(pre[0].text).toContain('\n'); // 代码里的换行不能被压成空格
  });

  it('代码语言标签在 Readability 路径下会丢失（已知限制）', () => {
    // Readability 默认剥掉所有 class（只留它自己的 `page`），而 `guessCodeLang`
    // 正是靠 class 认语言的 —— 于是主路径提取出来的代码块拿不到 lang。
    // 影响面很小（前端只拿它当角标文案、导出时写进 ``` 的信息串），
    // 真要修就在 Readability 上开 `keepClasses`，但那会连带保留下大量无意义的 class。
    const pre = findByType(blocks, 'pre');
    expect(pre[0].lang).toBeUndefined();
  });

  it('图片块不参与翻译，且地址被补成绝对地址', () => {
    // Readability 返回的 HTML 里 src 全是相对的，不补全前端会 404
    const img = findByType(blocks, 'img');
    expect(img).toHaveLength(1);
    expect(img[0].translatable).toBe(false);
    expect(img[0].src).toBe('https://example.com/images/pic.png');
    expect(img[0].alt).toBe('一张示意图');
  });

  it('列表块以 items 数组形式给出，不是一段文本', () => {
    const list = findByType(blocks, 'ul');
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].items!.length).toBeGreaterThanOrEqual(2);
  });

  it('只有 pre 与 img 是不可译的（前端据此决定发不发请求）', () => {
    for (const block of blocks) {
      const shouldBeTranslatable = block.type !== 'pre' && block.type !== 'img';
      expect(block.translatable, `${block.type} 的 translatable 不对`).toBe(shouldBeTranslatable);
    }
  });

  it('块类型都在前后端约定的枚举里', () => {
    const allowed = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'blockquote', 'pre', 'img', 'figcaption']);
    for (const block of blocks) {
      expect(allowed.has(block.type), `出现了契约外的块类型 ${block.type}`).toBe(true);
    }
  });

  it('不产出空块（空白块会让右栏出现一个永远填不上的格子）', () => {
    for (const block of blocks) {
      if (block.type === 'img') continue;
      expect(textOf(block).trim().length).toBeGreaterThan(0);
    }
  });

  it('页面的导航与页脚不出现在正文里', () => {
    const all = blocks.map(textOf).join('\n');
    expect(all).not.toContain('版权所有 2026');
  });
});

describe('extract：导语（曾经丢过的那一段）', () => {
  it('页面上真实存在的导语会留在正文里', () => {
    const { blocks } = extract(fixture());
    expect(blocks.map(textOf).join('\n')).toContain('DEK_MARKER');
  });

  it('导语**只出现一次** —— 补回时要先查正文里有没有', () => {
    // Readability 的行为在不同站点不一致：有时把导语摘走，有时留在原地。
    // 去重逻辑一旦失效，同一段导语就会出现两遍。
    const { blocks } = extract(fixture());
    const occurrences = blocks.filter((b) => textOf(b).includes('DEK_MARKER'));
    expect(occurrences).toHaveLength(1);
  });

  it('excerpt 只是 <meta name="description"> 时**不补进正文**', () => {
    // 那是给搜索引擎看的摘要，补进去是污染而不是修复。
    // 判据是"这段文字在页面上真的可见吗" —— meta 里的当然不可见。
    const { blocks } = extract(fixture());
    expect(blocks.map(textOf).join('\n')).not.toContain('META_ONLY_MARKER');
  });

  it('meta description 恰好等于页面导语时，仍然只出现一次', () => {
    // 这是最常见的站点写法：meta description 直接抄导语。
    // 此时 excerpt 是真实可见的文字，补回逻辑会走一遍，去重必须兜住。
    const { blocks } = extract(fixture({ description: DEK }));
    const occurrences = blocks.filter((b) => textOf(b).includes('DEK_MARKER'));
    expect(occurrences).toHaveLength(1);
  });

  it('没有 meta description 也不会把首个段落复制一份', () => {
    // Readability 在没有 meta description 时会拿正文第一个 <p> 当 excerpt，
    // 而那个段落本来就还在正文里 —— 这时绝不能补。
    const { blocks } = extract(fixture({ description: null }));
    const occurrences = blocks.filter((b) => textOf(b).includes('DEK_MARKER'));
    expect(occurrences).toHaveLength(1);
  });
});

describe('extract：失败要能说清为什么', () => {
  it('空壳 SPA → js_rendered（而不是笼统的 extract_failed）', () => {
    const spa = `<!DOCTYPE html><html><body>
      <div id="root"></div>
      <script>console.log('bundle loaded')</script>
    </body></html>`;
    try {
      extract(spa);
      throw new Error('预期抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('js_rendered');
    }
  });

  it('挂载点里的 <script> 文本不算"可见内容"', () => {
    // 曾经用 body.textContent 数长度，结果一堆 SPA 外壳靠 service worker 代码
    // "骗"过了判定，最后只能报笼统的 extract_failed。
    const spa = `<!DOCTYPE html><html><body>
      <div id="root"></div>
      <script>${'var aVeryLongVariableName = 1;'.repeat(200)}</script>
    </body></html>`;
    expect(() => extract(spa)).toThrow(/脚本/);
  });

  it('确实没内容的页面 → extract_failed（没有挂载点，不能赖到 SPA 头上）', () => {
    try {
      extract('<!DOCTYPE html><html><body><p>short</p></body></html>');
      throw new Error('预期抛错');
    } catch (err) {
      expect((err as AppError).code).toBe('extract_failed');
    }
  });

  it('识别得出 Angular 自定义元素挂载点', () => {
    const spa = `<!DOCTYPE html><html><body><app-root></app-root><script>boot()</script></body></html>`;
    expect(() => extract(spa)).toThrow(/脚本/);
  });
});

describe('translatableLength：判断"这一级提取得够不够料"', () => {
  it('只累计可翻译块的字符数', () => {
    const blocks: Block[] = [
      { id: 1, type: 'p', text: 'abcde', translatable: true },
      { id: 2, type: 'pre', text: 'x'.repeat(100), translatable: false },
      { id: 3, type: 'ul', items: ['ab', 'cd'], translatable: true },
      { id: 4, type: 'img', src: 'https://example.com/a.png', translatable: false },
    ];
    expect(translatableLength(blocks)).toBe(5 + 4);
  });

  it('空数组与全不可译的数组都是 0', () => {
    expect(translatableLength([])).toBe(0);
    expect(translatableLength([{ id: 1, type: 'img', src: 'x', translatable: false }])).toBe(0);
  });
});
