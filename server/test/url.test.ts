import { describe, expect, it } from 'vitest';
import { AppError } from '../src/common/errors';
import { normalizeUrl, safeUrlLabel } from '../src/common/url';

/** 断言 normalizeUrl 抛出指定错误码 */
function expectCode(raw: string, code: string): void {
  try {
    normalizeUrl(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return;
  }
  throw new Error(`预期 ${JSON.stringify(raw)} 抛出 ${code}，但它通过了`);
}

describe('normalizeUrl：补协议头', () => {
  it('没带协议头 → 补 https://', () => {
    expect(normalizeUrl('example.com/post').href).toBe('https://example.com/post');
  });

  it('已带 http:// https:// → 原样使用，不升级不改写', () => {
    // 不擅自把 http 升成 https：有些站点只有 http，改了直接打不开
    expect(normalizeUrl('http://example.com/a?b=1#c').href).toBe('http://example.com/a?b=1#c');
    expect(normalizeUrl('https://example.com/').href).toBe('https://example.com/');
  });

  it('两端空白先去掉', () => {
    expect(normalizeUrl('  https://example.com/x  ').href).toBe('https://example.com/x');
  });

  it('`localhost:3000` 不能被误认成协议头', () => {
    // 这是这个函数最容易写错的地方：抓出 scheme 再判断是不是已知协议，
    // 而不是拿 `/^[a-z]+:\/\//` 去猜
    const url = normalizeUrl('localhost:3000');
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('localhost');
    expect(url.port).toBe('3000');
  });

  it('带端口的普通网址照常', () => {
    expect(normalizeUrl('http://example.com:8080/x').port).toBe('8080');
  });
});

describe('normalizeUrl：拒绝不该放的协议', () => {
  it('ftp / file / javascript / data 等已知协议一律拒绝', () => {
    // file:// 是安全红线：真让它过，服务器本地文件（配置、密钥）就暴露给任何访客了
    expectCode('ftp://example.com/x', 'unsupported_protocol');
    expectCode('ftps://example.com/x', 'unsupported_protocol');
    expectCode('sftp://example.com/x', 'unsupported_protocol');
    expectCode('file:///etc/passwd', 'unsupported_protocol');
    expectCode('data:text/html,<h1>x</h1>', 'unsupported_protocol');
    expectCode('blob:https://example.com/uuid', 'unsupported_protocol');
    expectCode('javascript:alert(1)', 'unsupported_protocol');
    expectCode('mailto:a@b.com', 'unsupported_protocol');
    expectCode('ws://example.com/socket', 'unsupported_protocol');
    expectCode('wss://example.com/socket', 'unsupported_protocol');
    expectCode('about:blank', 'unsupported_protocol');
    expectCode('view-source:https://example.com', 'unsupported_protocol');
  });

  it('不在名单里的未知协议也拒绝（不放行未知协议）', () => {
    expectCode('weird://example.com/x', 'unsupported_protocol');
    expectCode('myapp://open/thing', 'unsupported_protocol');
  });

  it('垃圾输入 → invalid_url', () => {
    expectCode('', 'invalid_url');
    expectCode('   ', 'invalid_url');
    expectCode('https://', 'invalid_url');
  });

  it('空输入不能被"补协议头"救活', () => {
    // 若先补成 `https://` 再解析，会得到一个看似合法实则无主机的 URL
    expectCode('', 'invalid_url');
  });
});

describe('safeUrlLabel：回显给用户时不带凭证', () => {
  it('只保留协议 + 主机 + 路径，丢掉 query 与 hash', () => {
    const label = safeUrlLabel(new URL('https://example.com/a/b?token=secret#frag'));
    expect(label).toBe('https://example.com/a/b');
    expect(label).not.toContain('secret');
    expect(label).not.toContain('#');
  });

  it('带端口时端口保留在 host 里', () => {
    expect(safeUrlLabel(new URL('http://example.com:8080/x?y=1'))).toBe(
      'http://example.com:8080/x',
    );
  });
});
