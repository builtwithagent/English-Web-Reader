/**
 * URL 相关的小工具。
 *
 * `isHttpUrl` 原本住在 `stats.ts`（统计明细表要拿它把关 `href`），
 * 现在阅读器渲染"原文链接"也要用**同一个**判断，于是挪到这儿。
 *
 * 为什么强调"同一个"：这是一个**安全判断**。判断规则一旦有两份，
 * 早晚会有一份忘了改 —— 而它失守的后果是"可执行串进了 href"，
 * 属于 XSS，不是显示问题。
 */

/**
 * 这个串能不能当链接打开。
 *
 * 白名单只放 `http` / `https`。`javascript:` 与 `data:` 绝对不能进 `href`。
 *
 * 注意它可能出现的位置比想象中多：统计页失败明细里存的是**用户原始输入**
 * （可能是 `not a url`，也可能是 `javascript:alert(1)`）；阅读器的
 * `article.finalUrl` 按构造一定是 http(s)（抓取只走这两种协议）。
 * 但"渲染 href 的地方自己把关"比"相信上游永远给对的"更可靠 ——
 * 上游多出别的来源时，改的是这里一处，而不是记得去每个 `href` 前面加判断。
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
