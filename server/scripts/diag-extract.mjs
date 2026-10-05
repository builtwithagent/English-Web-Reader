/**
 * 提取质量诊断。
 *
 * 用来定位"某一层内容丢了"这类问题到底丢在哪一步：
 *   原始 HTML → Readability → buildBlocks
 * 每一步都检查目标片段还在不在，避免靠猜。
 *
 * 用法：node scripts/diag-extract.mjs <页面地址> [要找的片段]
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const url = process.argv[2];
const needle = process.argv[3] ?? 'Harnesses encode assumptions';

if (!url) {
  console.error('用法：node scripts/diag-extract.mjs <页面地址> [要找的片段]');
  process.exit(1);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 这些标签整棵子树直接跳过（与后端 extract.service.ts 保持一致） */
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'iframe', 'form', 'button',
  'input', 'select', 'textarea', 'nav', 'footer', 'aside',
]);

const res = await fetch(url, {
  headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
});
const html = await res.text();
console.log(`抓取：${res.status}  ${html.length} 字符`);

// ---- 第 1 步：原始 HTML 里有没有 ----
console.log(`\n[1] 原始 HTML 含目标片段：${html.includes(needle) ? '有' : '没有'}`);

// ---- 定位这个片段在 DOM 里的结构 ----
const dom = new JSDOM(html, { url });
const doc = dom.window.document;

const holders = [...doc.querySelectorAll('*')].filter(
  (el) => el.children.length === 0 && (el.textContent ?? '').includes(needle),
);
for (const el of holders) {
  const chain = [];
  let node = el;
  for (let i = 0; i < 4 && node; i++) {
    const cls = typeof node.className === 'string' ? node.className : '';
    chain.push(`${node.tagName.toLowerCase()}${cls ? '.' + cls.split(/\s+/).join('.') : ''}`);
    node = node.parentElement;
  }
  console.log(`\n[2] 承载元素：${chain.join('  <  ')}`);
  console.log(`    文本：${(el.textContent ?? '').trim().slice(0, 90)}`);
}

// ---- 第 3 步：Readability 之后还在不在 ----
const parsed = new Readability(doc.cloneNode(true), { charThreshold: 200 }).parse();
const content = parsed?.content ?? '';
console.log(`\n[3] Readability 输出含目标片段：${content.includes(needle) ? '有' : '没有'}`);
console.log(`    Readability 还给出了 excerpt：${parsed?.excerpt ? '「' + parsed.excerpt.slice(0, 80) + '…」' : '(无)'}`);
console.log(`    byline：${parsed?.byline || '(无)'}`);

// ---- 第 4 步：用后端的拍平逻辑跑一遍，看最终 blocks ----
const contentDom = new JSDOM(content, { url });
const body = contentDom.window.document.body;
const blocks = buildBlocks(body, url);
console.log(`\n[4] 拍平后 blocks：${blocks.length} 个，含目标片段：${blocks.some((b) => (b.text ?? '').includes(needle)) ? '有' : '没有'}`);

const idx = blocks.findIndex((b) => (b.text ?? '').includes(needle));
if (idx >= 0) {
  console.log(`    位于第 ${idx} 块：${JSON.stringify(blocks[idx]).slice(0, 160)}`);
} else {
  console.log('    前 6 块：');
  for (const b of blocks.slice(0, 6)) {
    console.log(`      [${b.type}] ${(b.text ?? (b.items ?? []).join(' / ')).slice(0, 70)}`);
  }
}

// ============================================================================
// 下面是 server/src/article/extract.service.ts 里 buildBlocks 的等价实现，
// 目的是能单独复现"拍平"这一步。第 4 步若也找不到目标片段，就说明丢在更上游
// （通常是 Readability），而不是拍平逻辑吃掉了它。
// ============================================================================

function clean(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function buildBlocks(root, baseUrl) {
  const out = [];
  let nextId = 1;
  const push = (block) => {
    out.push({ id: nextId++, ...block });
  };

  const visit = (el) => {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (el.getAttribute('hidden') !== null) return;

    if (/^h[1-4]$/.test(tag)) {
      const text = clean(el.textContent);
      if (text) push({ type: tag, text, translatable: true });
      return;
    }
    if (tag === 'pre') {
      const code = el.querySelector('code');
      const text = ((code ?? el).textContent ?? '').replace(/^\n+/, '');
      if (text.trim()) push({ type: 'pre', text, translatable: false });
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(el.children)
        .filter((c) => c.tagName.toLowerCase() === 'li')
        .map((li) => clean(li.textContent))
        .filter(Boolean);
      if (items.length) push({ type: tag, items, translatable: true });
      return;
    }
    if (tag === 'blockquote') {
      const text = clean(el.textContent);
      if (text) push({ type: 'blockquote', text, translatable: true });
      return;
    }
    if (tag === 'img') {
      const raw = el.getAttribute('data-src') || el.getAttribute('src') || '';
      let src = raw;
      try { src = raw ? new URL(raw, baseUrl).href : ''; } catch { /* 保持原值 */ }
      if (src && !src.startsWith('data:')) push({ type: 'img', src, translatable: false });
      return;
    }
    if (tag === 'figcaption') {
      const text = clean(el.textContent);
      if (text) push({ type: 'figcaption', text, translatable: true });
      return;
    }
    if (tag === 'p') {
      const text = clean(el.textContent);
      if (text) push({ type: 'p', text, translatable: true });
      return;
    }
    if (tag === 'table') return;

    for (const child of Array.from(el.children)) visit(child);
  };

  for (const child of Array.from(root.children)) visit(child);
  return out;
}
