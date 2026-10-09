import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * `/stats` 的准入 —— 两把锁 + 失败节流。
 *
 * 两条通路，**任一条通过即可**：
 * 1. `Authorization: Basic ...`（标准做法，本地与正常反代下都可用）
 * 2. `X-Stats-Key: <密码>`（自定义头，给"网关会改写 Authorization"的环境用）
 *
 * 为什么必须有第 2 条：发布环境的网关会**无条件用自己的 Bearer token 覆盖
 * `Authorization` 头** —— 实测把客户端那个头去掉、什么都不发，应用照样收到
 * `Authorization: Bearer <386 字符>`。也就是说在那台机器上 Basic 永远不可能通过，
 * 而自定义头原样到达。这是踩过一次线上 401 才补上的入口。
 *
 * 代价必须说清楚：
 * - 凭证是**明文随每个请求发**的，所以只有上 HTTPS 时才安全；
 * - 浏览器会记住 Basic 凭证并在同域下自动带上，所以别在同一个域名上放别的东西。
 *
 * 为什么还要自己加节流：Basic Auth **本身零防爆破** —— 它没有任何
 * "错了三次就锁"的机制。公网裸奔时这是唯一挡在密码前面的东西，
 * 所以这里按 IP 记失败次数，超了就先锁一段时间。
 */

/** 同一 IP 在窗口内最多错几次 */
const MAX_FAILURES = 10;
/** 失败计数的滑动窗口 */
const WINDOW_MS = 5 * 60 * 1000;

@Injectable()
export class StatsAuth {
  /** ip → 最近失败的时间戳（只保留窗口内的） */
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly config: ConfigService) {}

  /** 密码没配就是**没配**，不是"随便进"（fail closed） */
  get configured(): boolean {
    return this.password.length > 0;
  }

  get username(): string {
    return this.config.get<string>('STATS_USER')?.trim() || 'admin';
  }

  get password(): string {
    return this.config.get<string>('STATS_PASSWORD') ?? '';
  }

  verify(header: string | undefined): boolean {
    return checkBasicAuth(header, this.username, this.password);
  }

  /** 第二条通路：`X-Stats-Key` 直接带密码（网关会覆盖 `Authorization` 的环境靠它） */
  verifyKey(key: string | undefined): boolean {
    return checkStatsKey(key, this.password);
  }

  isLocked(ip: string): boolean {
    const recent = this.recent(ip);
    return recent.length >= MAX_FAILURES;
  }

  registerFailure(ip: string): void {
    const recent = this.recent(ip);
    recent.push(Date.now());
    this.failures.set(ip, recent);

    // 顺手清账：被大量不同 IP 轮着打时，把窗口外的记录摘掉，这张表不该无限长
    if (this.failures.size > 5000) this.sweep();
  }

  clearFailures(ip: string): void {
    this.failures.delete(ip);
  }

  private recent(ip: string): number[] {
    const cutoff = Date.now() - WINDOW_MS;
    return (this.failures.get(ip) ?? []).filter((at) => at > cutoff);
  }

  private sweep(): void {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, stamps] of this.failures) {
      const kept = stamps.filter((at) => at > cutoff);
      if (kept.length === 0) this.failures.delete(key);
      else this.failures.set(key, kept);
    }
  }
}

/**
 * 解析并校验 `Authorization: Basic ...`。
 *
 * 比较用 `timingSafeEqual`：普通的 `===` 会在第一个不同的字节就返回，
 * 攻击者能靠响应耗时逐字节猜出密码（虽然实践中很难，但这里一行就能防住）。
 * `timingSafeEqual` 要求两边等长，所以先各自摘要再比 —— 摘要长度恒定，
 * 于是比较耗时与密码长度无关。
 */
export function checkBasicAuth(
  header: string | undefined,
  username: string,
  password: string,
): boolean {
  // 密码配成空串时直接拒绝：否则 `Basic YWRtaW46` （admin:）就能进 ——
  // 这是"忘了配环境变量"最危险的失败方式，必须在最底层就堵住，而不是指望调用方记得先判
  if (password.length === 0 || username.length === 0) return false;
  if (!header) return false;

  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return false;

  const decoded = Buffer.from(match[1], 'base64').toString('utf8');

  // RFC 7617：用户名里不允许有冒号，所以第一个冒号一定是分隔符；密码里可以有
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;

  // 两个都要算，不能因为用户名错了就短路 —— 那样会漏出"用户名对不对"的时序
  const userOk = safeEqual(decoded.slice(0, separator), username);
  const passOk = safeEqual(decoded.slice(separator + 1), password);
  return userOk && passOk;
}

function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * 校验自定义头里的密码。
 *
 * 只比密码 —— 这条路上没有"用户名"这个概念，少一个要记的东西；能到达这里的人
 * 本来就是拿得到服务器配置的人。比较方式与 Basic 那条完全一致（摘要后定长比较），
 * 于是"密码多长"同样不体现在耗时上。
 *
 * 两端空白容忍掉：这个值通常是**从页面输入框或 `?key=` 粘过来的**，多带一个空格
 * 是最常见的复制失误，为此让人对着"密码不对"发呆不值当。
 */
export function checkStatsKey(key: string | undefined, password: string): boolean {
  // 和 Basic 那条一样 fail closed：没配密码就不是"随便进"
  if (password.length === 0 || !key) return false;
  return safeEqual(key.trim(), password);
}
