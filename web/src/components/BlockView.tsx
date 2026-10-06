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
  /** 译文。`undefined` = 还没到（显示占位）；服务端并发回流，按 id 取 */
  translation?: string | string[];
  /** 这一块没译出来。**只影响它自己** —— 其余块照常显示译文 */
  failed?: boolean;
  highlighted?: boolean;
  onHover?(id: number | null): void;
}

export function BlockView({
  block,
  side,
  translation,
  failed,
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
      {renderInner(block, side, translation, failed)}
    </div>
  );
}

function renderInner(
  block: Block,
  side: BlockSide,
  translation?: string | string[],
  failed?: boolean,
) {
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

  // ---- 译文侧的三态：失败 / 还没到 / 到了 ----
  // 统一在这里判，后面的分支就不必各写一遍
  if (side === 'dst') {
    if (failed) return <Missing />;
    if (translation === undefined) return <Placeholder />;
  }

  // ---- 列表 ----
  if (block.type === 'ul' || block.type === 'ol') {
    // 译文侧理论上恒为数组（列表块发出去时按行拼、回来时按行切）；
    // 万一不是，包成一项也比崩掉强
    const items =
      side === 'dst'
        ? Array.isArray(translation)
          ? translation
          : [String(translation)]
        : (block.items ?? []);

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
  return <div className="txt">{text ?? ''}</div>;
}

/**
 * 译文还没到时的占位。
 * 不用转圈动画：转圈适合"不知道要多久"，而这里是"排队中" ——
 * 控制条上已经有 `12/48 翻译中` 了，格子里再转一圈只会显得吵。
 */
function Placeholder() {
  return (
    <div className="txt">
      <span className="pending">待翻译</span>
    </div>
  );
}

/** 这一块失败了。措辞要诚实且不吓人 —— 其余块都好好的，这不是"文章坏了" */
function Missing() {
  return (
    <div className="txt">
      <span className="miss">这段没译出来</span>
    </div>
  );
}
