import { isHttpUrl } from './url';
import type { Article } from './types';

/**
 * 出处署名（技术方案 7.11）。
 *
 * ## 为什么这件事值得单独写一层
 *
 * 这个站的产品形态是"**任何一篇文章都能生成一个可分享的双语链接**"。
 * 一旦链接流出去，页面就承担了两件本来由原站承担的事：
 *
 * 1. **署名**：读者要先知道"这是谁写的东西"，而不是把译文当成原站发布的中文版；
 * 2. **回源**：读者要能一键回到原站 —— 否则我们就是在拿别人的内容做自己的页面。
 *
 * 两条都不是"顺手加的礼貌"，缺了它们，"分享"这个用法本身就不成立。
 *
 * ## 这里只做**加工**，不做渲染
 *
 * 抽成纯函数是为了能离线单测：最容易错的恰恰是那几个"缺字段怎么办"的兜底
 * （站点名没有、作者没有、地址不是 http(s)），而它们在页面上出问题时看起来
 * 只是"少了一行字"，很难当成 bug 报上来。
 */

/** 译文声明。**页面与导出的 Markdown 用同一句** —— 两处各写一份迟早不一致 */
export const AI_TRANSLATION_NOTE = '译文由 AI 生成，仅供参考';

export interface Attribution {
  /**
   * 可点的原文地址。**不是 http(s) 就是 null** —— 此时上层不生成链接，
   * 只显示文字（把 `javascript:` 之类塞进 `href` 是 XSS，见 url.ts）。
   */
  href: string | null;
  /** 出处名：优先站点名，没有就退回"原文"（宁可少个名字，也别留个空位） */
  source: string;
  /** 作者。**可以为空** —— 不是每个页面都标了作者，别为了凑格式编一个出来 */
  byline: string;
  /** 拼好的署名短句，页脚直接用 */
  credit: string;
}

export function buildAttribution(
  article: Pick<Article, 'finalUrl' | 'siteName' | 'byline'>,
): Attribution {
  const url = (article.finalUrl ?? '').trim();
  const source = (article.siteName ?? '').trim() || '原文';
  const byline = (article.byline ?? '').trim();

  return {
    href: isHttpUrl(url) ? url : null,
    source,
    byline,
    // 作者可能是一串（"张三, 李四"），原样带上即可 —— 判断"哪个是人名"不是这里的事
    credit: byline ? `原文出自 ${source} · ${byline}` : `原文出自 ${source}`,
  };
}
