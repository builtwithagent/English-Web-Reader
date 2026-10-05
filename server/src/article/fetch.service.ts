import { Injectable, Logger } from '@nestjs/common';
import * as http from 'node:http';
import * as https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { AppError } from '../common/errors';
import { isPrivateIp } from '../common/ip';

/**
 * 抓取服务（技术方案 4.4）。
 *
 * 为什么不用 `fetch`：
 * 1. **重定向必须逐跳校验** —— 否则攻击者可以拿一个公网域名 302 跳到内网。
 *    `fetch` 的 `redirect: 'manual'` 在 Node 下会返回 opaque-redirect（status 0、读不到 Location），
 *    做不到"读到下一跳再校验"。
 * 2. **必须在连接层绑定已校验的 IP** —— 只做"解析后校验、再交给 fetch 自己解析"会留下
 *    DNS rebinding 的窗口（两次解析可能返回不同结果）。`http.request` 支持自定义 `lookup`，
 *    可以把校验和连接合并在一次解析里完成。
 * 3. 超时、响应体上限、字符集嗅探都需要底层控制。
 */

const MAX_REDIRECTS = 5;
/** 单次请求的 socket 空闲超时 */
const SOCKET_TIMEOUT_MS = 15_000;
/** 整个抓取过程（含所有跳转与读体）的总超时 */
const TOTAL_TIMEOUT_MS = 25_000;
/** 响应体上限 5MB */
const MAX_BYTES = 5 * 1024 * 1024;
/** 只允许标准 Web 端口 */
const ALLOWED_PORTS = new Set(['', '80', '443']);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 自定义 lookup 用它标记"解析到了内网地址"，好在下游映射成 blocked_target */
const SSRF_BLOCKED = 'SSRF_BLOCKED';

export interface FetchResult {
  /** 解码后的 HTML 源码 */
  html: string;
  /** 跟随重定向后的最终地址 */
  finalUrl: string;
  contentType: string;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

@Injectable()
export class FetchService {
  private readonly logger = new Logger(FetchService.name);

  async fetchHtml(startUrl: URL): Promise<FetchResult> {
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    let current = startUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      this.assertAllowedShape(current);

      const res = await this.requestOnce(current, deadline);

      // ---- 重定向：读 Location，回到循环顶部重新做安全校验 ----
      if (isRedirect(res.status)) {
        const location = res.headers.location;
        if (!location) throw new AppError('upstream_error');
        try {
          current = new URL(location, current);
        } catch {
          throw new AppError('upstream_error');
        }
        this.logger.debug(`redirect ${res.status} → ${current.host}`);
        continue;
      }

      // ---- 状态码分类 ----
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        throw new AppError('blocked_by_site');
      }
      if (res.status >= 500) throw new AppError('upstream_error');
      if (res.status >= 400) throw new AppError('blocked_by_site');

      // ---- 类型判断 ----
      const contentType = String(res.headers['content-type'] ?? '');
      if (!isHtmlContentType(contentType)) throw new AppError('not_html');

      return {
        html: decodeBody(res.body, contentType),
        finalUrl: current.toString(),
        contentType,
      };
    }

    throw new AppError('too_many_redirects');
  }

  /**
   * 协议、端口、"直接写 IP"的静态校验。
   *
   * 注意这里必须单独挡一次 IP 字面量 —— 见下面 `guardedLookup` 的说明：
   * hostname 是域名时才会走 lookup，直接写 IP 时 Node 根本不解析，
   * 只靠 lookup 钩子会漏掉 `http://169.254.169.254/` 这种最常见的打点。
   * 顺序上先判地址、再判端口：内网地址优先报"不允许访问"，避免用端口错误掩盖攻击意图。
   */
  private assertAllowedShape(url: URL): void {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('unsupported_protocol');
    }

    // IPv6 字面量在 URL 里带方括号（[::1]），剥掉才能交给 isIP 判定
    const host = stripBrackets(url.hostname);
    if (isIP(host) !== 0 && isPrivateIp(host)) {
      throw new AppError('blocked_target');
    }

    if (!ALLOWED_PORTS.has(url.port)) {
      throw new AppError('blocked_target', '只允许访问 80 / 443 端口');
    }
  }

  /** 发一次请求并读完响应体（不跟随重定向） */
  private async requestOnce(url: URL, deadline: number): Promise<RawResponse> {
    const mod = url.protocol === 'https:' ? https : http;

    return new Promise<RawResponse>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        reject(err);
      };
      const done = (value: RawResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        resolve(value);
      };

      const totalTimer = setTimeout(() => {
        req.destroy();
        fail(new AppError('timeout'));
      }, Math.max(1, deadline - Date.now()));

      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'identity',
          },
          // 关键：DNS 解析与 SSRF 校验在同一次 lookup 里完成，杜绝 DNS rebinding
          lookup: this.guardedLookup,
        },
        (res) => {
          this.readBody(res, MAX_BYTES, deadline)
            .then((body) =>
              done({ status: res.statusCode ?? 0, headers: res.headers, body }),
            )
            .catch(fail);
        },
      );

      req.setTimeout(SOCKET_TIMEOUT_MS, () => {
        req.destroy();
        fail(new AppError('timeout'));
      });

      req.on('error', (err: NodeJS.ErrnoException) => {
        fail(mapNetworkError(err));
      });

      req.end();
    });
  }

  /**
   * 自定义 DNS 解析：解析 → 校验所有返回的地址 → 交给连接使用。
   * 只要有一个解析结果是内网/保留地址就整体拒绝（防止用轮询 DNS 绕过）。
   *
   * **能力边界（踩过的坑，别再踩）**：这个钩子只在 hostname 是域名时被调用。
   * URL 里直接写 IP 字面量时 Node 不会做 DNS 解析，钩子完全不触发 ——
   * 所以 IP 字面量必须在 `assertAllowedShape` 里静态挡掉，两边缺一不可。
   */
  private guardedLookup: typeof dnsLookup = ((
    hostname: string,
    options: unknown,
    callback: (err: Error | null, address?: unknown, family?: number) => void,
  ) => {
    dnsLookup(hostname, { ...(options as object), all: true }, (err, addresses) => {
      if (err) {
        callback(err, undefined, 0);
        return;
      }
      const list = addresses as unknown as LookupAddress[];
      if (!list.length) {
        callback(new Error('ENOTFOUND'), undefined, 0);
        return;
      }
      for (const entry of list) {
        if (isPrivateIp(entry.address)) {
          callback(new Error(SSRF_BLOCKED), undefined, 0);
          return;
        }
      }
      callback(null, list, 0);
    });
  }) as unknown as typeof dnsLookup;

  /** 流式读响应体，边读边计字节数，超限立即中断 */
  private readBody(
    res: http.IncomingMessage,
    maxBytes: number,
    deadline: number,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let finished = false;

      const fail = (err: Error) => {
        if (finished) return;
        finished = true;
        res.destroy();
        reject(err);
      };

      const idleTimer = setTimeout(() => fail(new AppError('timeout')), SOCKET_TIMEOUT_MS);
      const resetIdle = () => {
        idleTimer.refresh();
      };

      res.on('data', (chunk: Buffer) => {
        resetIdle();
        received += chunk.length;
        if (received > maxBytes) {
          clearTimeout(idleTimer);
          fail(new AppError('size_limit'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (finished) return;
        finished = true;
        clearTimeout(idleTimer);
        resolve(Buffer.concat(chunks));
      });

      res.on('error', (err) => {
        clearTimeout(idleTimer);
        fail(mapNetworkError(err));
      });

      // 总超时到点直接掐断
      const remain = Math.max(1, deadline - Date.now());
      setTimeout(() => {
        if (!finished) fail(new AppError('timeout'));
      }, remain).unref?.();
    });
  }
}

/** 剥掉 IPv6 字面量的方括号：[::1] → ::1，否则 isIP 认不出来 */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isHtmlContentType(ct: string): boolean {
  // 没给 content-type 时按 HTML 试一次，而不是直接拒绝
  if (!ct) return true;
  const v = ct.toLowerCase();
  return v.includes('text/html') || v.includes('application/xhtml+xml');
}

function mapNetworkError(err: NodeJS.ErrnoException): AppError {
  const msg = String(err?.message ?? '');

  if (msg.includes(SSRF_BLOCKED)) return new AppError('blocked_target');

  switch (err?.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new AppError('dns_failed');
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return new AppError('timeout');
    // 连接被重置 / 半开断开 / 路由不可达 —— 这些**不是**"网站响应慢"。
    // 实测 huggingface.co 只用了 73ms 就被重置，归成 timeout 的话
    // 用户看到"网站响应太慢，稍后再试"，方向就完全错了。
    case 'ECONNRESET':
    case 'EPIPE':
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return new AppError('connection_reset');
    default:
      return new AppError('upstream_error');
  }
}

/**
 * 响应体解码。
 * 优先信 HTTP 头的 charset，其次嗅探 HTML 里的 `<meta charset>`，
 * 都没有就按 UTF-8。用 TextDecoder 而不是 toString('utf8')，
 * 是为了让 gbk / iso-8859-1 这类老页面不至于整篇乱码。
 */
function decodeBody(buffer: Buffer, contentType: string): string {
  const charset = sniffCharset(buffer, contentType);
  if (!charset) return buffer.toString('utf-8');
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf-8');
  }
}

function sniffCharset(buffer: Buffer, contentType: string): string | null {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return normalizeCharset(fromHeader);

  // 只看开头一段，meta charset 必须出现在前 1024 字节内才有效
  const head = buffer.subarray(0, 2048).toString('latin1');
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head)?.[1];

  return fromMeta ? normalizeCharset(fromMeta) : null;
}

function normalizeCharset(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v || v === 'utf8') return 'utf-8';
  if (v === 'latin1' || v === 'iso8859-1') return 'iso-8859-1';
  return v;
}
