import { AppError } from './errors';

/**
 * URL 规范化（PRD 3.1 / 技术方案 4.3）。
 *
 * 规则：
 *   - 已带 http:// / https://  → 原样使用，不做任何改写
 *   - 未带协议头（example.com/post） → 自动补 https://
 *   - 其它协议（ftp:// / file:// / data: …） → 拒绝
 *
 * `file://` 是硬拦项而不是"顺手不支持"：服务端若真能读 file://，
 * 等于把服务器本地文件（配置、密钥）暴露给任何访客，属安全红线。
 */

/** 我们认识、但明确不支持的协议 */
const KNOWN_UNSUPPORTED_SCHEMES = new Set([
  'ftp',
  'ftps',
  'sftp',
  'file',
  'ws',
  'wss',
  'data',
  'blob',
  'mailto',
  'javascript',
  'about',
  'chrome',
  'view-source',
]);

/**
 * 提取开头的 scheme。
 * 注意：这里**不能**用 `/^[a-z]+:\/\//` 直接判断有没有协议头 ——
 * `localhost:3000` 会被误认成 scheme 是 `localhost`。
 * 所以先抓出 scheme，再看它是不是一个我们认识的协议名。
 */
const LEADING_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

export function normalizeUrl(raw: string): URL {
  const input = (raw ?? '').trim();
  if (!input) throw new AppError('invalid_url');

  const matched = input.match(LEADING_SCHEME);
  const scheme = matched?.[1]?.toLowerCase();

  let candidate: string;

  if (scheme === 'http' || scheme === 'https') {
    candidate = input;
  } else if (scheme && KNOWN_UNSUPPORTED_SCHEMES.has(scheme)) {
    throw new AppError('unsupported_protocol');
  } else if (scheme && matched && input.slice(matched[0].length, matched[0].length + 2) === '//') {
    // 未在名单里的自定义协议（如 `weird://x`）→ 同样拒绝，不放行未知协议
    throw new AppError('unsupported_protocol');
  } else {
    // 没有协议头（含 `example.com/post`、`localhost:3000` 这类）→ 补 https://
    candidate = `https://${input}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AppError('invalid_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('unsupported_protocol');
  }
  if (!url.hostname) throw new AppError('invalid_url');

  return url;
}

/**
 * 拼给用户看的错误提示时用：只保留协议 + 主机名，丢掉 query 与 hash。
 * 目的是不把用户粘贴的链接原样回显（里面可能有跟踪参数甚至凭证）。
 */
export function safeUrlLabel(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}
