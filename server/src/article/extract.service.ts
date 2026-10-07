import { Injectable, Logger } from '@nestjs/common';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { AppError } from '../common/errors';

/**
 * 正文提取（技术方案 4.5）。
 *
 * 三级降级：
 *   L1 Readability（主路径，新闻 / 博客 / 技术文档）
 *   L2 启发式容器选择（Readability 返回空或正文过短时）
 *   L3 body 兜底（剔除导航/页脚/脚本后按块切分）
 *
 * 核心产出是 **blocks**：一份与 DOM 解耦的、带稳定 id 的结构化正文。
 * 前端靠它做左右对齐，翻译靠它做逐段请求与缓存命中。
 */

export type BlockType =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'p'
  | 'ul'
  | 'ol'
  | 'blockquote'
  | 'pre'
  | 'img'
  | 'figcaption';

export interface Block {
  /** 稳定 id：前后端对齐、翻译回填、缓存命中的共同锚点 */
  id: number;
  type: BlockType;
  /** 单文本块（标题 / 段落 / 引用 / 图注） */
  text?: string;
  /** 列表项（type 为 ul / ol 时） */
  items?: string[];
  /** 图片地址（type 为 img 时） */
  src?: string;
  /** 图片替代文本 */
  alt?: string;
  /** 代码块语言（type 为 pre 时） */
  lang?: string;
  /** 是否需要翻译 */
  translatable: boolean;
}

export type ExtractLevel = 'readability' | 'heuristic' | 'body';

export interface ExtractResult {
  title: string;
  byline: string;
  siteName: string;
  /** `<html lang>` / `og:locale` 的值 —— 仅供语言判定在样本不足时兜底 */
  htmlLang: string | null;
  extractLevel: ExtractLevel;
  blocks: Block[];
}

/** 正文长度低于这个值就认为这一级没提取成功，继续降级 */
const MIN_ARTICLE_CHARS = 200;

/** 这些标签整棵子树直接跳过 */
const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'nav',
  'footer',
  'aside',
]);

/** L2 常见正文容器选择器，按优先级排列 */
const HEURISTIC_SELECTORS = [
  'article',
  '[role="main"]',
  'main',
  '.post-content',
  '.entry-content',
  '.markdown-body',
  '.article-body',
  '.post-body',
  '.content-body',
  '#content',
];

/**
 * 代码语言标签的白名单（一律小写）。
 *
 * 不少技术站点会在代码块上方标一行语言名（MDN 是 `js`，别的站点是 `python` / `bash` …）。
 * Readability 会把承载它的那个容器改写成 `<p>js</p>`，于是它作为普通段落混进正文，
 * 还会被发去翻译 —— 模型看到一个孤零零的 `js`，往往自作主张译成 "JavaScript" 之类的词。
 * 它只是代码块的装饰性标注，对读者没有任何信息量。
 *
 * 不追求把世界上所有语言名列全：**漏掉的代价只是多留一行标签**，
 * 而列表越长，"正文里恰好出现一个同名短词、又刚好挨着代码块"被误伤的概率越大。
 */
const CODE_LANG_LABELS = new Set([
  // 前端
  'js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx', 'mjs', 'cjs',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  // 数据 / 配置
  'json', 'jsonc', 'json5', 'xml', 'yaml', 'yml', 'toml', 'ini', 'csv', 'env', 'dotenv',
  // 文档标记
  'md', 'markdown', 'rst', 'tex', 'latex',
  // 命令行
  'sh', 'bash', 'shell', 'zsh', 'fish', 'powershell', 'ps1', 'bat', 'cmd', 'console', 'terminal',
  // 后端语言
  'py', 'python', 'rb', 'ruby', 'php', 'java', 'kt', 'kotlin', 'scala', 'groovy',
  'go', 'golang', 'rs', 'rust', 'c', 'cpp', 'c++', 'cs', 'csharp', 'swift', 'dart', 'lua', 'perl', 'r', 'julia', 'matlab',
  // 数据 / 工程
  'sql', 'plsql', 'tsql', 'graphql', 'gql', 'prisma',
  'dockerfile', 'docker', 'makefile', 'cmake', 'nginx', 'htaccess', 'git',
  // 其它常见
  'text', 'txt', 'plain', 'plaintext', 'diff', 'patch', 'log', 'http', 'regex',
  'zig', 'nim', 'elm', 'clojure', 'clj', 'erlang', 'elixir', 'ex', 'haskell', 'hs', 'ocaml', 'lisp', 'scheme', 'prolog',
  'wasm', 'asm', 'nasm', 'glsl', 'hlsl', 'svg', 'proto',
  'jinja', 'jinja2', 'handlebars', 'hbs', 'ejs', 'pug', 'twig', 'liquid', 'mustache',
  'objc', 'objectivec', 'abap', 'apex', 'solidity', 'vba', 'vb', 'pascal', 'fortran', 'cobol',
]);

/** 语言标签不会长过这个长度（最长的 `objectivec` / `dockerfile` 也就 10 个字符） */
const MAX_CODE_LANG_LABEL_CHARS = 16;

@Injectable()
export class ExtractService {
  private readonly logger = new Logger(ExtractService.name);

  extract(html: string, sourceUrl: string): ExtractResult {
    const dom = new JSDOM(html, { url: sourceUrl });
    const doc = dom.window.document;

    // meta 要在 Readability 之前读 —— Readability 会就地改写文档
    const title = firstNonEmpty(
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      doc.title,
      doc.querySelector('h1')?.textContent,
    );
    const byline = firstNonEmpty(
      doc.querySelector('meta[name="author"]')?.getAttribute('content'),
      doc.querySelector('[rel="author"]')?.textContent,
    );
    const siteName = firstNonEmpty(
      doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content'),
      hostOf(sourceUrl),
    );
    const htmlLang = firstNonEmpty(
      doc.documentElement.getAttribute('lang'),
      doc.querySelector('meta[property="og:locale"]')?.getAttribute('content'),
      doc.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content'),
    );

    // ---- L1: Readability ----
    const l1 = this.tryReadability(html, sourceUrl);
    let blocks = l1.blocks;
    let level: ExtractLevel = 'readability';
    // Readability 会把页面**导语**（`p.summary` / dek 这类）当成 excerpt 摘走、
    // 并从正文 content 里删掉。只有它确实是页面上的一段可见文字时才捡回来；
    // 若 excerpt 只是 <meta name="description">，那是给搜索引擎的摘要，混进正文反而是污染。
    let excerpt = l1.excerpt && isExcerptVisibleText(doc, l1.excerpt) ? l1.excerpt : null;
    this.logger.debug(`L1 readability → ${translatableLength(blocks)} chars`);

    // ---- L2: 启发式容器 ----
    if (!isGoodEnough(blocks)) {
      blocks = this.tryHeuristic(doc);
      level = 'heuristic';
      excerpt = null; // 这一级没用 Readability，excerpt 不再适用
      this.logger.debug(`L2 heuristic → ${translatableLength(blocks)} chars`);
    }

    // ---- L3: body 兜底 ----
    if (!isGoodEnough(blocks)) {
      blocks = this.tryBody(doc);
      level = 'body';
      excerpt = null;
      this.logger.debug(`L3 body → ${translatableLength(blocks)} chars`);
    }

    // ---- 三级全失败：区分"SPA 抓不到"与"真没认出来" ----
    if (!isGoodEnough(blocks)) {
      throw new AppError(looksLikeSpa(doc) ? 'js_rendered' : 'extract_failed');
    }

    return {
      title: title ?? '',
      byline: byline ?? '',
      siteName: siteName ?? hostOf(sourceUrl) ?? '',
      htmlLang: htmlLang ?? null,
      extractLevel: level,
      blocks: prependExcerpt(blocks, excerpt),
    };
  }

  /**
   * L1：Readability。用克隆的文档，避免它改写原 doc 影响后续降级。
   *
   * 返回的 `excerpt` 是 Readability 从正文里**摘出去**的导语（它认为那是"摘要"），
   * 对阅读器而言却是正文的一部分，所以一并带出来，由上层决定补不补回。
   */
  private tryReadability(
    html: string,
    sourceUrl: string,
  ): { blocks: Block[]; excerpt: string | null } {
    try {
      const dom = new JSDOM(html, { url: sourceUrl });
      const clone = dom.window.document.cloneNode(true) as Document;
      const parsed = new Readability(clone, { charThreshold: MIN_ARTICLE_CHARS }).parse();
      if (!parsed?.content) return { blocks: [], excerpt: null };

      const contentDom = new JSDOM(parsed.content, { url: sourceUrl });
      const body = contentDom.window.document.body;
      return {
        blocks: body ? buildBlocks(body, sourceUrl) : [],
        excerpt: parsed.excerpt?.trim() || null,
      };
    } catch (err) {
      this.logger.debug(`Readability 失败，降级：${(err as Error).message}`);
      return { blocks: [], excerpt: null };
    }
  }

  /** L2：按常见容器选择器找，再按文本密度兜底 */
  private tryHeuristic(doc: Document): Block[] {
    for (const selector of HEURISTIC_SELECTORS) {
      const el = doc.querySelector(selector);
      if (!el) continue;
      const blocks = buildBlocks(el, doc.baseURI);
      if (isGoodEnough(blocks)) return blocks;
    }

    const densest = findByTextDensity(doc.body);
    return densest ? buildBlocks(densest, doc.baseURI) : [];
  }

  /** L3：body 剔杂后按块切分。宁可给"杂乱但可读"，也不给空白 */
  private tryBody(doc: Document): Block[] {
    if (!doc.body) return [];
    const clone = doc.body.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('script, style, noscript, nav, header, footer, aside, form, iframe, svg')
      .forEach((node) => node.remove());
    return buildBlocks(clone, doc.baseURI);
  }
}

// ============================================================================
// DOM → blocks
// ============================================================================

/**
 * 递归遍历，把 DOM 拍平成块数组。
 *
 * 策略：只对"块级语义标签"产出块，遇到普通容器（div / section / span）就往下钻。
 * 这样既不会被各种 wrapper 干扰，也不会漏内容。
 *
 * @param baseUrl 页面地址，用来把图片的相对路径补成绝对地址。
 *                Readability 返回的 HTML 里 src 全是相对的，不带这个参数前端会 404。
 */
function buildBlocks(root: Element, baseUrl?: string): Block[] {
  const out: Block[] = [];
  let nextId = 1;

  const push = (block: Omit<Block, 'id'>): void => {
    out.push({ id: nextId++, ...block });
  };

  const visit = (el: Element): void => {
    const tag = el.tagName.toLowerCase();

    if (SKIP_TAGS.has(tag)) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (el.getAttribute('hidden') !== null) return;

    // ---- 标题 ----
    if (/^h[1-4]$/.test(tag)) {
      const text = clean(el.textContent);
      if (text) push({ type: tag as BlockType, text, translatable: true });
      return;
    }

    // ---- 代码块：原样保留，不翻译 ----
    if (tag === 'pre') {
      // pre 内的换行必须保留，所以这里不做 clean
      const code = el.querySelector('code');
      const text = ((code ?? el).textContent ?? '').replace(/^\n+/, '').replace(/[ \t]+$/, '');
      if (text.trim()) {
        push({
          type: 'pre',
          text,
          translatable: false,
          ...(guessCodeLang(code ?? el) ? { lang: guessCodeLang(code ?? el) as string } : {}),
        });
      }
      return;
    }

    // ---- 列表 ----
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(el.children)
        .filter((child) => child.tagName.toLowerCase() === 'li')
        .map((li) => clean(li.textContent))
        .filter((text) => text.length > 0);
      if (items.length) push({ type: tag as BlockType, items, translatable: true });
      return;
    }

    // ---- 引用 ----
    if (tag === 'blockquote') {
      const text = clean(el.textContent);
      if (text) push({ type: 'blockquote', text, translatable: true });
      return;
    }

    // ---- 图片与图注 ----
    if (tag === 'img') {
      // 懒加载站点把真地址放在 data-src / data-original，src 往往是占位图，所以按顺序取。
      // 用 `||` 而不是 `??`：属性存在但为空串时也要往后走。
      const raw =
        el.getAttribute('data-src') ||
        el.getAttribute('data-original') ||
        el.getAttribute('src') ||
        '';
      const src = resolveUrl(raw, baseUrl);
      if (src && !src.startsWith('data:')) {
        push({
          type: 'img',
          src,
          alt: el.getAttribute('alt') ?? '',
          translatable: false,
        });
      }
      return;
    }

    if (tag === 'figcaption') {
      const text = clean(el.textContent);
      if (text) push({ type: 'figcaption', text, translatable: true });
      return;
    }

    // ---- 段落 ----
    if (tag === 'p') {
      const text = clean(el.textContent);
      // 代码块上方的语言标签（`<p>js</p>` 紧挨着 `<pre>`）不是正文，见 isCodeLangLabel
      if (text && !isCodeLangLabel(el, text)) {
        push({ type: 'p', text, translatable: true });
      }
      return;
    }

    // ---- 表格：首版不处理，整块跳过（避免把表格文本打散成乱句）----
    if (tag === 'table') return;

    // ---- 其它容器：往下钻 ----
    for (const child of Array.from(el.children)) visit(child);
  };

  for (const child of Array.from(root.children)) visit(child);
  return out;
}

// ============================================================================
// 工具
// ============================================================================

function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** 比较用的归一化：忽略空白差异与大小写 */
function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 判断 excerpt 是不是**页面上真实存在的一段可见文字**。
 *
 * Readability 的 excerpt 有两个来源：被它摘走的页面导语，和 `<meta name="description">`。
 * 前者该补回正文，后者是给搜索引擎看的摘要 —— 补进去是污染而不是修复。
 * 页面上真有这段字时，某一棵子树的 textContent 里就能找到它。
 */
function isExcerptVisibleText(doc: Document, excerpt: string): boolean {
  const probe = normalizeForCompare(excerpt);
  if (!probe) return false;
  const head = probe.slice(0, 40);

  for (const el of Array.from(doc.querySelectorAll('p, blockquote, div, section'))) {
    const text = normalizeForCompare(el.textContent ?? '');
    if (!text.includes(head)) continue;
    // 只认"文本量级和 excerpt 相当"的元素，否则匹配到的是包住整篇的容器
    if (text.length <= probe.length * 2 + 200) return true;
  }
  return false;
}

/**
 * 把被 Readability 摘走、又从正文里删掉的导语补回正文最前面。
 *
 * 顺带去重：万一这段本来就还在正文里（不同站点行为不一），不要再加一遍。
 * 补回时所有块的 id 要整体后移 —— 前端按 id 做左右对齐，契约必须保持从 1 起连续。
 */
function prependExcerpt(blocks: Block[], excerpt: string | null): Block[] {
  if (!excerpt) return blocks;

  const probe = normalizeForCompare(excerpt).slice(0, 60);
  if (!probe) return blocks;

  const alreadyThere = blocks.some((b) =>
    normalizeForCompare(b.text ?? (b.items ?? []).join(' ')).includes(probe),
  );
  if (alreadyThere) return blocks;

  return [
    { id: 1, type: 'p', text: excerpt, translatable: true },
    ...blocks.map((b) => ({ ...b, id: b.id + 1 })),
  ];
}

/**
 * 把相对地址补全成绝对地址。
 * 补不了（没有 baseUrl、或本来就是 data: / 协议相对等怪值）就原样返回，
 * 让上层自己决定丢不丢 —— 这里不擅自判死。
 */
function resolveUrl(raw: string, baseUrl?: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (!baseUrl) return value;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

/** 可翻译内容的总字符数 —— 用来判断这一级提取是否"够料" */
export function translatableLength(blocks: Block[]): number {
  return blocks.reduce((sum, block) => {
    if (!block.translatable) return sum;
    if (block.text) return sum + block.text.length;
    if (block.items) return sum + block.items.join('').length;
    return sum;
  }, 0);
}

function isGoodEnough(blocks: Block[]): boolean {
  return translatableLength(blocks) >= MIN_ARTICLE_CHARS;
}

/**
 * 判断一个 `<p>` 是不是"代码块上方的语言标签"。
 *
 * 三个条件同时成立才算：
 *   1. 文本很短且是单行 —— 语言标签就是一个词；
 *   2. 文本在语言名白名单里；
 *   3. 它的**紧邻兄弟**里有一个 `<pre>`。
 *
 * 第 3 条是关键。只看前两条的话，正文里恰好出现一个短词（比如一段独立的 `<p>C</p>`）
 * 就会被误吞；要求它贴着代码块，才契合"这是代码块的一部分"这个语义。
 *
 * 为什么不用 `class` 认（`language-name` / `brush: js` 这些都在 class 里）：
 * Readability 会把它们**全部剥掉**（技术方案 §11 已知限制），到这里只剩形状可认。
 *
 * 导出是为了单测能直接打这个判据（它靠 DOM 邻近关系，比走一遍 Readability 更可控）。
 */
export function isCodeLangLabel(el: Element, text: string): boolean {
  if (text.length > MAX_CODE_LANG_LABEL_CHARS) return false;
  if (/\s/.test(text)) return false; // 语言标签是一个词，不含任何空白
  if (!CODE_LANG_LABELS.has(text.toLowerCase())) return false;
  return neighbourTag(el, 'next') === 'pre' || neighbourTag(el, 'prev') === 'pre';
}

/**
 * 找元素的"下一个 / 上一个有文本的兄弟"的标签名，本级找不到就顺着祖先往上找。
 *
 * 不能只看 `el.nextElementSibling`：语言标签和 `<pre>` 之间常隔着一层 wrapper。
 * MDN 的情况恰好是兄弟（`<div class="example-header">` 被 Readability 改写成 `<p>` 后
 * 与 `<pre>` 同级），但别的站点未必这么巧，所以往上冒泡一层更稳。
 */
function neighbourTag(el: Element, dir: 'next' | 'prev'): string | null {
  for (let node: Element | null = el; node; node = node.parentElement) {
    let sib = dir === 'next' ? node.nextElementSibling : node.previousElementSibling;
    while (sib && !(sib.textContent ?? '').trim()) {
      sib = dir === 'next' ? sib.nextElementSibling : sib.previousElementSibling;
    }
    if (sib) return sib.tagName.toLowerCase();
  }
  return null;
}

/** 从 class 里猜代码语言，用于前端语法高亮与展示 */
function guessCodeLang(el: Element): string | undefined {
  const pattern = /(?:language|lang|highlight|brush)[-:]([\w+#.-]+)/i;
  for (const node of [el, el.parentElement, el.parentElement?.parentElement]) {
    if (!node) continue;
    const match = pattern.exec(node.getAttribute('class') ?? '');
    if (match) return match[1].toLowerCase();
  }
  return undefined;
}

/**
 * 文本密度最高的容器。
 * 减去链接文本占比，是因为导航/目录这类"全是链接"的块文本量也很大，
 * 但显然不是正文。
 */
function findByTextDensity(root: Element | null): Element | null {
  if (!root) return null;

  let best: Element | null = null;
  let bestScore = 0;

  for (const el of Array.from(root.querySelectorAll('div, section, article, main'))) {
    const textLen = clean(el.textContent).length;
    if (textLen < MIN_ARTICLE_CHARS) continue;

    const linkLen = clean(
      Array.from(el.querySelectorAll('a'))
        .map((a) => a.textContent ?? '')
        .join(''),
    ).length;

    const score = textLen * (1 - Math.min(0.9, linkLen / textLen));
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

/** 命中挂载点但几乎没文本 → 判定为靠脚本渲染的 SPA */
function looksLikeSpa(doc: Document): boolean {
  const body = doc.body;
  if (!body) return false;
  const textLen = visibleTextLength(body);
  // 挂载点要认全：`<app-root>` 这种自定义元素（Angular）以前漏了，
  // 于是 docs.nestjs.com 被笼统报成 extract_failed，而不是更准确的 js_rendered。
  const hasMountPoint = Boolean(
    doc.querySelector(
      '#app, #root, #__next, #__nuxt, app-root, [data-reactroot], [ng-version]',
    ),
  );
  return hasMountPoint && textLen < 500;
}

/**
 * **可见**文本长度。
 *
 * 不能直接用 `body.textContent` —— 它把 `<script>` / `<style>` 里的代码也算作文本，
 * 一堆 SPA 外壳靠这个"骗"过了判定：实测 docs.nestjs.com 页面上几乎没有可见文字，
 * 但正文里塞了 1851 字的 service-worker 代码，于是被判成"有内容"，
 * 最后只能报笼统的 extract_failed，说不清到底为什么抓不到。
 */
function visibleTextLength(body: Element): number {
  const clone = body.cloneNode(true) as Element;
  for (const el of Array.from(clone.querySelectorAll('script, style, noscript, template'))) {
    el.remove();
  }
  return clean(clone.textContent).length;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = (value ?? '').trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
