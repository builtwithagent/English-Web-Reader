import { isIP } from 'node:net';

/**
 * 从请求里取客户端 IP —— 只给**统计与限流**用，不参与 SSRF 判定。
 *
 * 为什么要先看 `X-Forwarded-For`：发布沙箱（以及任何反向代理）后面，
 * socket 的 remoteAddress 永远是代理自己的地址，直接用它做限流等于
 * 把所有人算成同一个人。这里取 XFF 的**第一跳**，也就是最靠近客户端的那个。
 *
 * 注意：XFF 是**客户端可以伪造**的。所以这个值只能用来做"粗暴的限流/去重"，
 * 绝不能当安全边界（SSRF 那道门看的是解析出来的真实 IP，与本函数无关）。
 */
export function clientIp(req: {
  headers: Record<string, unknown>;
  socket?: { remoteAddress?: string };
}): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === 'string' && raw.length > 0) {
    const first = raw.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * 私有 / 保留网段判定 —— SSRF 防护的第二道门（技术方案 4.4 第 2 条）。
 *
 * 服务端"按用户给的 URL 去抓"，如果不校验目标 IP，攻击者就能让服务器
 * 去读内网服务、云厂商元数据（169.254.169.254 上通常挂着实例凭证）。
 * 这是服务端抓取最典型的攻击面，必须挡住。
 *
 * 判定原则：**认不出来的一律当作不安全**（fail closed）。
 */

/** IPv4 黑名单：[网络地址, 前缀长度] */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私有
  ['100.64.0.0', 10], // 运营商级 NAT
  ['127.0.0.0', 8], // 环回
  ['169.254.0.0', 16], // 链路本地 + 云元数据（169.254.169.254）
  ['172.16.0.0', 12], // 私有
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // 私有
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留（含 255.255.255.255）
];

export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedV4(ip);
  if (version === 6) return isBlockedV6(ip);
  // 既不是合法 IPv4 也不是 IPv6 → 不冒险放行
  return true;
}

function isBlockedV4(ip: string): boolean {
  const value = ipv4ToUint(ip);
  return BLOCKED_V4.some(([network, prefix]) => {
    const net = ipv4ToUint(network);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0 === (net & mask) >>> 0;
  });
}

function ipv4ToUint(ip: string): number {
  const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
  return (
    ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  ) >>> 0;
}

function isBlockedV6(ip: string): boolean {
  const v = ip.toLowerCase();

  // IPv4 映射地址（::ffff:192.168.1.1）→ 拆出后 32 位，按 IPv4 规则判
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);

  if (v === '::1' || v === '::') return true; // 环回 / 未指定
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // fc00::/7 唯一本地地址
  if (/^fe[89ab]/.test(v)) return true; // fe80::/10 链路本地
  if (v.startsWith('ff')) return true; // ff00::/8 组播

  return false;
}
