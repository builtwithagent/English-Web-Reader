/**
 * 正文容器（技术方案 7.2、7.4、7.5）。
 *
 * 双栏还是单栏由 `article.lang` 决定 —— 这是垂直定位的唯一分叉点，就落在这一层。
 *
 * 对齐与滚动同步（7.4）：不用"两个滚动容器 + 监听 scrollTop"，而是让左右两栏
 * 成为**同一行网格的两列**。行高由行内较高的那侧撑开，于是：
 *   - 左右同行天然等高
 *   - 滚动天然同步（根本不存在第二个滚动条）
 * 把"同步"从运行时逻辑降级成布局结果，稳定性高一个数量级。
 */

import { Fragment, useState } from 'react';
import { BlockView } from './BlockView';
import {
  EXTRACT_LEVEL_LABELS,
  langLabel,
  targetLangLabel,
  type Article,
  type DisplayMode,
  type TargetLang,
} from '../types';

interface ReaderProps {
  article: Article;
  /** 目标语言（用于文章头的语言对标签） */
  targetLang: TargetLang;
  /** 用户选的显示模式；降级态下会被强制成单栏原文 */
  mode: DisplayMode;
  /** 译文，**按块 id 索引** —— 服务端并发回流，顺序是乱的，只能按 id 取 */
  translations?: Map<number, string | string[]>;
  /** 没译出来的块。这些格子显示"没译出来"，其余照常 */
  failedIds?: ReadonlySet<number>;
  /** 用户在降级说明条上点了「仍要翻译」——本次强制走双栏（误判兜底，4.7） */
  forceTranslate?: boolean;
}

export function Reader({
  article,
  targetLang,
  mode: preferredMode,
  translations,
  failedIds,
  forceTranslate,
}: ReaderProps) {
  // 非英文页面：降级为单栏原文（技术方案 7.5）。
  // 注意这是**渲染层的临时决定**，不写回用户偏好 —— 否则用户下次打开英文页会莫名只剩原文。
  const degraded = !article.isEnglish && !forceTranslate;

  const [hoverId, setHoverId] = useState<number | null>(null);

  // 降级态下"双语对照 / 仅译文"都没有意义：只有原文一种形态，
  // 给个能切但切了没反应的开关等于给假选项，所以直接锁成单栏原文。
  const mode: DisplayMode = degraded ? 'src' : preferredMode;

  return (
    <div className="reader" data-lang={degraded ? 'non-en' : 'en'} data-mode={mode}>
      <article className="article">
        <header className="art-head">
          <h1>{article.title || article.finalUrl}</h1>
          <div className="art-meta">
            <span>{article.siteName}</span>
            {article.byline ? (
              <>
                <span className="dot" />
                <span>{article.byline}</span>
              </>
            ) : null}
            <span className="dot" />
            <span className="tag ok">{EXTRACT_LEVEL_LABELS[article.extractLevel]}</span>
            <span className="dot" />
            <span className="tag">
              {degraded
                ? `检测到 ${langLabel(article.lang)} · 未翻译`
                : `EN → ${targetLangLabel(targetLang)}`}
            </span>
          </div>
        </header>

        <div className="grid pane-divider" data-mode={mode}>
          {article.blocks.map((block) => {
            // 不翻译的块（代码 / 图片）两侧共用一份，跨整行
            if (!block.translatable) {
              return (
                <BlockView
                  key={`shared-${block.id}`}
                  block={block}
                  side="shared"
                  highlighted={hoverId === block.id}
                  onHover={setHoverId}
                />
              );
            }

            return (
              <Fragment key={block.id}>
                <BlockView
                  block={block}
                  side="src"
                  highlighted={hoverId === block.id}
                  onHover={setHoverId}
                />
                {/* 降级态下译文列的 DOM 直接不生成，而不是藏起来（7.5 要点 2） */}
                {!degraded ? (
                  <BlockView
                    block={block}
                    side="dst"
                    translation={translations?.get(block.id)}
                    failed={failedIds?.has(block.id)}
                    highlighted={hoverId === block.id}
                    onHover={setHoverId}
                  />
                ) : null}
              </Fragment>
            );
          })}
        </div>
      </article>
    </div>
  );
}
