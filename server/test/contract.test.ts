import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_SPEC } from '../src/common/errors';
import { TARGET_LANGS } from '../src/translate/langs';

/**
 * **跨工程契约对照**。
 *
 * `web/src/types.ts` 自称是"契约的唯一落点"，但两个工程之间**没有共享包** ——
 * `ErrorCode` 与 `TARGET_LANGS` 在后端是各自手写的另一份。
 * 手抄就会抄错，抄错的后果都不会当场报错：
 *   - 后端多一个错误码 → 前端走进兜底分支，用户看到"服务器出了点问题"，
 *     明明是一个能说清原因的失败；
 *   - 语言表不一致 → 用户在下拉框里选了一个服务端不认识的语言，
 *     后端静默回落成简体中文，而界面还显示着"日本語"。
 *
 * 所以这里**把前端源码当文本读出来对照**。它更像一份防手滑检查，
 * 但正因为没人愿意手动对两份清单，才值得写成自动的。
 *
 * 为什么这个测试在后端而不是前端：读文件要 node 的 `fs`，而 web 的 tsconfig
 * 是纯浏览器环境（`types: ["vite/client"]`）。后端这边的类型环境本来就有 node。
 * 方向反过来效果一样 —— 两边都是"同一份契约的两处落点"。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(HERE, '..', '..', 'web', 'src');

/** 从 `export type ErrorCode = ... ;` 里抽出全部字符串字面量 */
function readClientErrorCodes(): string[] {
  const file = path.join(WEB_SRC, 'types.ts');
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('export type ErrorCode =');
  expect(start, `${file} 里没找到 ErrorCode 定义`).toBeGreaterThan(-1);
  const end = source.indexOf(';', start);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
}

/** 从 `export const TARGET_LANGS = [{ value: '...' }, ...]` 里抽出 value */
function readClientTargetLangs(): string[] {
  const file = path.join(WEB_SRC, 'types.ts');
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('export const TARGET_LANGS');
  expect(start, `${file} 里没找到 TARGET_LANGS`).toBeGreaterThan(-1);
  const end = source.indexOf('];', start);
  return [...source.slice(start, end).matchAll(/value:\s*'([^']+)'/g)].map((match) => match[1]);
}

describe('跨工程契约：错误码', () => {
  const server = Object.keys(ERROR_SPEC).sort();
  const client = readClientErrorCodes();

  it('前端 `web/src/types.ts` 的 ErrorCode 与后端码表逐项一致', () => {
    expect(server.filter((code) => !client.includes(code)), '后端有而前端缺').toEqual([]);
    expect(client.filter((code) => !server.includes(code)), '前端有而后端没有').toEqual([]);
  });

  it('两边的数量都对得上（防止正则漏读导致的假绿）', () => {
    expect(server.length).toBeGreaterThan(20);
    expect(client.length).toBe(server.length);
  });
});

describe('跨工程契约：译文语言表', () => {
  const client = readClientTargetLangs();

  it('前端下拉框的取值与顺序和后端完全一致', () => {
    expect(client).toEqual([...TARGET_LANGS]);
  });

  it('两边都是 10 种，且**都不含 en**', () => {
    expect(client).toHaveLength(10);
    expect(client).not.toContain('en');
    expect(TARGET_LANGS).toHaveLength(10);
    expect(TARGET_LANGS as readonly string[]).not.toContain('en');
  });

  it('默认语言两边一致（否则首次打开时下拉框显示的和实际请求的会对不上）', () => {
    expect(client[0]).toBe('zh-Hans');
    expect(TARGET_LANGS[0]).toBe('zh-Hans');
  });
});
