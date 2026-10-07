import { describe, expect, it } from 'vitest';
import {
  CONCURRENCY,
  MAX_ATTEMPTS,
  MAX_BLOCKS,
  MAX_BLOCK_CHARS,
  RETRY_BASE_DELAY_MS,
  TEMPERATURE,
  estimateMaxTokens,
  isRetryable,
  needsTranslation,
} from '../src/translate/translate.constants';

/**
 * 翻译侧的可调参数与两个纯判定函数。
 *
 * `needsTranslation` 直接决定**花不花上游的钱**：一篇文章五十来块，
 * 每一块都是一次真实请求。跳过规则太松会白烧额度，太紧会把该翻的漏掉。
 */

describe('编排参数', () => {
  it('并发 3 —— 不是越高越好（会撞响上游限流，然后整批 429 一起失败）', () => {
    expect(CONCURRENCY).toBe(3);
  });

  it('重试总次数是 2（首次 + 1 次重试）', () => {
    expect(MAX_ATTEMPTS).toBe(2);
  });

  it('退避起点 400ms，配合 2^n 得 400 / 800', () => {
    expect(RETRY_BASE_DELAY_MS).toBe(400);
    expect([1, 2].map((n) => RETRY_BASE_DELAY_MS * 2 ** (n - 1))).toEqual([400, 800]);
  });

  it('温度低（翻译要的是稳定复现，不是创造力）', () => {
    expect(TEMPERATURE).toBeLessThanOrEqual(0.3);
    expect(TEMPERATURE).toBeGreaterThanOrEqual(0);
  });

  it('块数上限存在（防一篇文章被拆成上万次上游调用）', () => {
    expect(MAX_BLOCKS).toBeGreaterThan(0);
    expect(MAX_BLOCK_CHARS).toBeGreaterThan(0);
  });
});

describe('estimateMaxTokens：按源文本长度估上限', () => {
  it('短文本有下限保护（不然模型可能一个字都吐不出来）', () => {
    expect(estimateMaxTokens('')).toBe(256);
    expect(estimateMaxTokens('hi')).toBe(256);
  });

  it('长文本有上限保护（不把成本上限一次顶满）', () => {
    expect(estimateMaxTokens('a'.repeat(20_000))).toBe(8192);
  });

  it('中间区间 = 字符数 × 1.5（对"英文→中文更短、→德语更长"两头都留余量）', () => {
    expect(estimateMaxTokens('a'.repeat(1_000))).toBe(1_500);
    expect(estimateMaxTokens('a'.repeat(333))).toBe(500);
  });

  it('结果随长度单调不降', () => {
    let prev = 0;
    for (const len of [10, 100, 500, 1_000, 5_000, 10_000]) {
      const value = estimateMaxTokens('a'.repeat(len));
      expect(value).toBeGreaterThanOrEqual(prev);
      prev = value;
    }
  });
});

describe('needsTranslation：跳过不值得发请求的块', () => {
  it('该跳过的：空白、过短、没有字母（纯数字 / 纯符号）', () => {
    // 它们翻了和不翻没区别，但每一次都是实打实的钱
    for (const text of ['', ' ', '   ', '\n\n', 'a', '2', '-', '|', '—', '1.2', '2026-10-07', '12', '!!!', '· · ·']) {
      expect(needsTranslation(text), `${JSON.stringify(text)} 不该被发出去`).toBe(false);
    }
  });

  it('该翻译的：有至少两个字母的文本', () => {
    for (const text of ['ab', 'Hello', ' ok ', 'version 2', 'A B']) {
      expect(needsTranslation(text), `${JSON.stringify(text)} 应该被翻译`).toBe(true);
    }
  });

  it('两端空白不影响判定', () => {
    expect(needsTranslation('  ab  ')).toBe(true);
    expect(needsTranslation('  a  ')).toBe(false);
  });

  it('纯中文块会被跳过 —— 上游是英文页面，正常路径下不该出现这种块', () => {
    // 记下来：如果哪天真的出现（中英混排页面），它会被静默跳过。
    // 不做额外处理是因为入口闸门已经挡住了非英文页面。
    expect(needsTranslation('这是一段中文')).toBe(false);
  });
});

describe('isRetryable：谁值得等一下再试', () => {
  it('限流 / 上游故障 / 超时 → 值得重试', () => {
    expect(isRetryable('translate_rate_limited')).toBe(true);
    expect(isRetryable('translate_unavailable')).toBe(true);
    expect(isRetryable('translate_timeout')).toBe(true);
  });

  it('密钥失效 / 余额不足 → 不重试（重试一百次也是同样的结果）', () => {
    expect(isRetryable('translate_auth_failed')).toBe(false);
    expect(isRetryable('translate_quota')).toBe(false);
  });

  it('非翻译侧的错误码一律不重试', () => {
    expect(isRetryable('source_not_english')).toBe(false);
    expect(isRetryable('invalid_url')).toBe(false);
    expect(isRetryable('internal_error')).toBe(false);
    expect(isRetryable('')).toBe(false);
  });
});
