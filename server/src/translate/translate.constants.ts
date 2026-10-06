/**
 * 翻译侧的可调参数（技术方案 5.3）。
 *
 * 单独成文件是为了避开 dto ⇄ service 的循环 import：
 * DTO 要用 `MAX_BLOCKS` 做校验，Service 要用同一批常量做编排，
 * 两边都从这里取就不会互相引用。
 */

/** 单次请求的块数上限。超过 `blocks.length >= MAX_BLOCKS` 直接拒绝，防止一篇文章被拆成上万次上游调用 */
export const MAX_BLOCKS = 200;

/** 单块原文长度上限，与 DTO 的 `@MaxLength` 保持一致 */
export const MAX_BLOCK_CHARS = 20_000;

/**
 * 上游并发上限（技术方案 5.3 定 3）。
 *
 * 为什么不是越高越好：这篇文章翻完就是给一个人看的，
 * 并发 10 只会把上游的速率限制撞响，然后整批 429 一起失败。
 */
export const CONCURRENCY = 3;

/** 总尝试次数 = 首次 + 1 次重试（技术方案 5.3） */
export const MAX_ATTEMPTS = 2;

/** 重试退避起点，第 n 次重试等 `RETRY_BASE_DELAY_MS * 2^(n-1)` */
export const RETRY_BASE_DELAY_MS = 400;

/** 单块翻译超时**不在这里** —— 它是上游客户端的属性，由 `DEEPSEEK_TIMEOUT_MS` 配置，
 *  默认 30s。放在编排层会变成第二处定义，两边一改就打架（踩过）。 */

/** 温度调低，翻译任务要的是稳定复现，不是创造力（技术方案 5.3） */
export const TEMPERATURE = 0.2;

/**
 * 按源文本长度估算 `max_tokens`。
 *
 * 别照抄源文本的字符数：英文一个词约 4 个字符，译成中文通常更短，
 * 译成德语/俄语则可能更长。1.5 倍对两头都留了余量，
 * 又不至于一申请就是 8192 把成本上限顶满。
 */
export function estimateMaxTokens(text: string): number {
  return Math.min(8192, Math.max(256, Math.ceil(text.length * 1.5)));
}

/**
 * 判断一块文本值不值得发一次上游请求。
 *
 * 跳过的三类：空白、没有字母（纯数字/纯符号，比如日期行、"|"、"—"）、
 * 字母少于 2 个。它们翻了和不翻没区别，但每一次都是实打实的钱。
 */
export function needsTranslation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  const letters = trimmed.match(/[A-Za-z]/g)?.length ?? 0;
  return letters >= 2;
}

/** 这类错误等一下重试可能有救，401/402 这种重试一百次也是同样的结果 */
export function isRetryable(code: string): boolean {
  return (
    code === 'translate_rate_limited' ||
    code === 'translate_unavailable' ||
    code === 'translate_timeout'
  );
}
