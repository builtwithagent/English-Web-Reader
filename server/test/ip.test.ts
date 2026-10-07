import { describe, expect, it } from 'vitest';
import { isPrivateIp } from '../src/common/ip';

/**
 * SSRF 防护的第二道门（第一道是 URL 形状校验）。
 *
 * 服务端"按用户给的地址去抓"，不校验目标 IP 的话，攻击者就能让服务器
 * 去读内网服务、或读云厂商元数据（169.254.169.254 上通常挂着实例凭证）。
 *
 * 判定原则是 **fail closed**：认不出来的一律当作不安全。
 * 下面每一条都必须保持这样 —— 放宽任何一条都是在开一个洞。
 */

describe('isPrivateIp：IPv4 必须拦下的段', () => {
  it.each([
    ['0.0.0.0', '本网络'],
    ['0.1.2.3', '本网络 0.0.0.0/8'],
    ['10.0.0.1', '私有'],
    ['10.255.255.254', '私有 10/8 的末尾'],
    ['100.64.0.1', '运营商级 NAT'],
    ['100.127.255.254', '运营商级 NAT 的末尾'],
    ['127.0.0.1', '环回'],
    ['127.255.255.255', '环回段末尾'],
    ['169.254.169.254', '云元数据（最典型的目标）'],
    ['169.254.0.1', '链路本地'],
    ['172.16.0.1', '私有 172.16/12 起点'],
    ['172.31.255.254', '私有 172.16/12 终点'],
    ['192.0.0.1', 'IETF 协议分配'],
    ['192.0.2.5', 'TEST-NET-1'],
    ['192.168.0.1', '私有'],
    ['192.168.255.255', '私有 192.168/16 末尾'],
    ['198.18.0.1', '基准测试'],
    ['198.19.255.255', '基准测试段末尾'],
    ['198.51.100.7', 'TEST-NET-2'],
    ['203.0.113.9', 'TEST-NET-3'],
    ['224.0.0.1', '组播'],
    ['239.255.255.255', '组播段末尾'],
    ['240.0.0.1', '保留'],
    ['255.255.255.255', '广播'],
  ])('%s 拦下（%s）', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it('私网段的边界外必须放行（否则正常站点也抓不到）', () => {
    expect(isPrivateIp('172.15.255.255')).toBe(false);
    expect(isPrivateIp('172.32.0.0')).toBe(false);
    expect(isPrivateIp('9.255.255.255')).toBe(false);
    expect(isPrivateIp('11.0.0.0')).toBe(false);
    expect(isPrivateIp('100.63.255.255')).toBe(false);
    expect(isPrivateIp('100.128.0.0')).toBe(false);
    expect(isPrivateIp('198.17.255.255')).toBe(false);
    expect(isPrivateIp('198.20.0.0')).toBe(false);
  });

  it('正常公网地址放行', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '223.5.5.5']) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });
});

describe('isPrivateIp：IPv6', () => {
  it.each([
    ['::1', '环回'],
    ['::', '未指定'],
    ['fe80::1', '链路本地 fe80::/10'],
    ['febf::1', '链路本地上边界'],
    ['fc00::1', '唯一本地 fc00::/7'],
    ['fd12:3456::1', '唯一本地 fd 段'],
    ['ff02::1', '组播'],
    ['ff00::', '组播段起点'],
  ])('%s 拦下（%s）', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it('IPv4 映射地址按内层 IPv4 判', () => {
    // ::ffff:127.0.0.1 是最经典的绕过手法
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateIp('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('公网 IPv6 放行', () => {
    expect(isPrivateIp('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
  });

  it('fe80 之外的 fe 段不误伤', () => {
    expect(isPrivateIp('fe00::1')).toBe(false);
  });
});

describe('isPrivateIp：fail closed', () => {
  it('认不出来的一律当作不安全', () => {
    // 域名、空串、越界的 IPv4、乱写的字符串 —— 都必须拦下。
    // 这里只要有一条返回 false，就等于给"解析失败时放行"开了个口子。
    for (const value of [
      'example.com',
      '',
      '   ',
      'not-an-ip',
      '999.1.1.1',
      '1.2.3',
      '1.2.3.4.5',
      '::gggg',
      'localhost',
      '0x7f.0.0.1',
      '2130706433',
    ]) {
      expect(isPrivateIp(value), `${JSON.stringify(value)} 竟被放行`).toBe(true);
    }
  });
});
