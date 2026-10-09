/**
 * 导出 Markdown（PRD 3.6）。
 *
 * 导出的内容**跟随当前显示模式**，而不是固定导出双语：
 * 用户在工具栏上切到"仅译文"，说明他这次要的就是中文——导出再塞一份英文进去，
 * 等于把他刚做出的选择又推翻了。默认模式是"双语对照"，所以默认导出就是
 * PRD 里写的"原文 + 译文"。
 *
 * 格式约定写在文件头部（一条 HTML 注释）：**每个内容块先原文，紧随其后的引用块是译文**。
 * 用引用块而不是加"原文/译文"标签，是因为它渲染出来自然、纯文本读也不刺眼；
 * 而把约定写在开头，读者扫一眼就懂，不用猜。
 */

import { AI_TRANSLATION_NOTE } from './attribution';
import {
  langLabel,
  targetLangLabel,
  type Article,
  type Block,
  type DisplayMode,
  type TargetLang,
} from './types';

export interface MarkdownInput {
  article: Article;
  translations: Map<number, string | string[]>;
  /**
   * **实际生效**的显示模式。
   * 注意降级态（非英文页）下 `usePreferences` 里的 mode 仍是用户偏好，
   * 真正渲染的是 `src` —— 传错会让一篇中文文章导出时凭空多出一句
   * "English → 简体中文"。
   */
  mode: DisplayMode;
  targetLang: TargetLang;
  exportedAt?: Date;
}

export interface MarkdownResult {
  markdown: string;
  /**
   * 该出译文却没出的块数（翻译还没跑完 / 这块失败了）。
   * 这些块退回了原文 —— 调用方拿它决定要不要提示用户。
   */
  missing: number;
}

export function buildMarkdown({
  article,
  translations,
  mode,
  targetLang,
  exportedAt = new Date(),
}: MarkdownInput): MarkdownResult {
  const wantSource = mode !== 'dst';
  const wantTarget = mode !== 'src';

  const lines: string[] = [];
  lines.push(`# ${article.title || article.finalUrl}`, '');
  lines.push(`> **来源**：${article.finalUrl}`);
  if (article.siteName) lines.push(`> **站点**：${article.siteName}`);
  if (article.byline) lines.push(`> **作者**：${article.byline}`);
  lines.push(
    `> **语言**：${
      wantTarget ? `${langLabel(article.lang)} → ${targetLangLabel(targetLang)}` : langLabel(article.lang)
    }`,
  );
  lines.push(`> **导出**：${formatTime(exportedAt)} · 英文网页阅读器`);
  // 只在**真有译文**时声明（模式选"仅原文"时导出的是纯原文，标一句"译文由 AI 生成"
  // 是假话）。这一句与页脚用的是同一个常量 —— 两处各写一份迟早不一致（7.11）
  if (wantTarget) lines.push(`> **声明**：${AI_TRANSLATION_NOTE}`);
  lines.push('');
  lines.push('<!-- 格式约定：每个内容块先原文，紧随其后的引用块是它的译文。 -->');
  lines.push('');
  lines.push('---', '');

  let missing = 0;

  for (const block of article.blocks) {
    // 代码块与图片不翻译，两侧共用一份，只出现一次
    if (!block.translatable) {
      lines.push(...renderRaw(block), '');
      continue;
    }

    const translation = translations.get(block.id);
    const source = renderSource(block);

    if (wantSource) lines.push(...source);

    if (!wantTarget) {
      lines.push('');
      continue;
    }

    if (translation === undefined) {
      // 该出译文却没有。'both' 下原文刚写过了，直接跳过；
      // 'dst' 下拿原文顶上 —— 总比留一片空白强，至少用户知道这段是什么。
      missing++;
      if (!wantSource) lines.push(...source);
    } else {
      lines.push('', ...renderTranslated(block, translation));
    }

    lines.push('');
  }

  // 结尾清掉多余空行，免得文件末尾一堆空白
  const markdown = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  return { markdown, missing };
}

// ============================================================================
// 块 → Markdown
// ============================================================================

/** 不翻译的块：代码与图片，原样输出 */
function renderRaw(block: Block): string[] {
  if (block.type === 'pre') {
    // 内容里本来就有 ``` 时，围栏要比它长一级，否则代码会被提前截断
    const fence = block.text?.includes('```') ? '````' : '```';
    return [`${fence}${block.lang ?? ''}`, block.text ?? '', fence];
  }
  if (block.type === 'img') {
    return [`![${block.alt ?? ''}](${block.src ?? ''})`];
  }
  return [];
}

/** 原文块：保留它本来的层级与形态（标题降一级，因为文章标题已经占了 `#`） */
function renderSource(block: Block): string[] {
  switch (block.type) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4': {
      const level = Number(block.type[1]) + 1;
      return [`${'#'.repeat(level)} ${block.text ?? ''}`];
    }
    case 'ul':
    case 'ol':
      return renderList(block, block.items ?? [], false);
    case 'blockquote':
      return quoteLines(block.text ?? '');
    case 'figcaption':
      // 图注用斜体，视觉上依附于上面那张图
      return [`*${block.text ?? ''}*`];
    default:
      return [block.text ?? ''];
  }
}

/**
 * 译文块：**一律用引用块**。
 *
 * 标题的译文不再降级成标题 —— 否则译文会混进目录结构里，
 * 一篇双语文档就有了两套互相打架的标题层级。
 */
function renderTranslated(block: Block, translation: string | string[]): string[] {
  if (block.type === 'ul' || block.type === 'ol') {
    const items = Array.isArray(translation) ? translation : [String(translation)];
    return renderList(block, items, true);
  }
  const text = Array.isArray(translation) ? translation.join('\n') : translation;
  return quoteLines(text);
}

function renderList(block: Block, items: string[], quoted: boolean): string[] {
  const ordered = block.type === 'ol';
  return items.map((item, i) => {
    const marker = ordered ? `${i + 1}.` : '-';
    return `${quoted ? '> ' : ''}${marker} ${item}`;
  });
}

/** 多行文本逐行加引用前缀，否则只有第一行进引用块 */
function quoteLines(text: string): string[] {
  return text.split('\n').map((line) => `> ${line}`);
}

// ============================================================================
// 文件
// ============================================================================

/**
 * 建议的文件名。
 *
 * 按 Windows 的非法字符表清洗 —— 用户在 Windows 上保存这个文件是大概率事件，
 * 名字里带个 `:` 会直接存不下来，而报错信息来自浏览器，很难懂。
 */
export function suggestFileName(article: Article, at: Date = new Date()): string {
  const base = (article.title || article.siteName || hostOf(article.finalUrl) || 'article')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

  return `${base || 'article'}-${formatStamp(at)}.md`;
}

/** 触发浏览器下载 */
export function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // 立刻 revoke 会让部分浏览器来不及把内容取走，延后释放
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function formatStamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
}

function formatTime(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
}
