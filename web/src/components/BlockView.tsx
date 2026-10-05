/**
 * 单个块的渲染（技术方案 7.2）。
 *
 * 三种身份：
 * - `src` 原文侧
 * - `dst` 译文侧
 * - `shared` **不参与翻译的块**（代码 / 图片）—— 它们没有原文译文的区别，
 *   两侧共用一份、跨整行显示。这样"仅译文"模式下代码块不会凭空消失。
 */

import type { Block } from '../types';

export type BlockSide = 'src' | 'dst' | 'shared';

interface BlockViewProps {
  block: Block;
  side: BlockSide;
  /** 译文。`undefined` = 还没到（此时显示占位）—— M3 接入 SSE 后按 id 回填 */
  translation?: string | string[];
  highlighted?: boolean;
  onHover?(id: number | null): void;
}

export function BlockView({
  block,
  side,
  translation,
  highlighted,
  onHover,
}: BlockViewProps) {
  const className = [
    'cell',
    `col-${side}`,
    block.translatable ? '' : 'skip',
    highlighted ? 'hl' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      data-type={block.type}
      data-row={block.id}
      onMouseEnter={() => onHover?.(block.id)}
      onMouseLeave={() => onHover?.(null)}
    >
      {renderInner(block, side, translation)}
    </div>
  );
}

function renderInner(block: Block, side: BlockSide, translation?: string | string[]) {
  // ---- 代码块：原样输出，不翻译 ----
  if (block.type === 'pre') {
    return (
      <>
        <div className="badge">{block.lang ?? 'code'} · 不翻译</div>
        <div className="txt">{block.text ?? ''}</div>
      </>
    );
  }

  // ---- 图片：同样不翻译 ----
  if (block.type === 'img') {
    return (
      <img
        src={block.src}
        alt={block.alt ?? ''}
        loading="lazy"
        // 很多站点的图床会检查 Referer，从我们的域直接请求会被拒。
        // 不带 Referer 反而更容易加载成功。
        referrerPolicy="no-referrer"
      />
    );
  }

  // ---- 列表 ----
  if (block.type === 'ul' || block.type === 'ol') {
    const items = side === 'dst' ? (translation as string[] | undefined) : block.items;
    if (!items) return <Placeholder />;
    const ListTag = block.type === 'ul' ? 'ul' : 'ol';
    return (
      <div className="txt">
        <ListTag>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ListTag>
      </div>
    );
  }

  // ---- 普通文本块（标题 / 段落 / 引用 / 图注）----
  const text = side === 'dst' ? (translation as string | undefined) : block.text;
  if (side === 'dst' && text === undefined) return <Placeholder />;

  return <div className="txt">{text ?? ''}</div>;
}

/**
 * 译文还没到时的占位。
 * M2 阶段译文整体未接入，所以右栏会一直停在这里 —— 这是刻意留白，
 * 不是"正在加载"，因此不用转圈动画（转圈会让人以为在等）。
 */
function Placeholder() {
  return (
    <div className="txt">
      <span className="pending">待翻译</span>
    </div>
  );
}
