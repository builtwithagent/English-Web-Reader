/**
 * 统计页的访问密钥（只有作者一个人用）。
 *
 * 密钥存在 `sessionStorage` 而不是 `localStorage`：它只是"这个标签页这一会儿"
 * 的凭证，关掉标签页就该没了。放在本地持久存储里，等于把管理密码长期留在一台
 * 可能不是自己独用的机器上。
 *
 * 引导方式是 `?key=<密码>`：粘一次就能进，之后把 query 从地址栏抹掉（见
 * `StatsPage.tsx`），免得密码跟着 URL 进浏览器历史、被截图、被 Referer 带出去。
 */

/** sessionStorage 里存密钥用的键名 */
export const STATS_KEY_STORAGE = 'statsKey';

/**
 * 从查询串里取一次性密钥。
 *
 * 单独抽成纯函数是为了能测：组件里那半截要碰 `sessionStorage` 和 `history`，
 * 在 node 环境的单测里跑不了。这里只做"字符串 → 密钥或 null"。
 */
export function parseStatsKey(search: string): string | null {
  const raw = new URLSearchParams(search).get('key');
  if (!raw) return null;
  const key = raw.trim();
  return key.length > 0 ? key : null;
}
