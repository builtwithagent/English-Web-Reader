import { describe, expect, it } from 'vitest';
import { AppError, ERROR_SPEC } from '../src/common/errors';

/**
 * 错误码表的契约测试。
 *
 * 错误码是**稳定契约**：前端按 code 做分支、文案由服务端唯一提供。
 * 所以这里守三件事 ——
 *   1. 码表本身完整、每个码有可用的 HTTP 状态与文案；
 *   2. 码集合与前端 `web/src/types.ts` 那份一致（跨工程对照放在前端侧做）；
 *   3. "上游 401 不能透出成 401" 这类**归一口径**不被后人改回去。
 */

/** 当前全部错误码。新增/删除时这里会红 —— 那是提醒你前端那份也要同步改 */
const EXPECTED_CODES = [
  'blocked_by_site',
  'blocked_target',
  'connection_reset',
  'daily_limit_reached',
  'dns_failed',
  'extract_failed',
  'internal_error',
  'invalid_request',
  'invalid_url',
  'js_rendered',
  'not_found',
  'not_html',
  'size_limit',
  'source_not_english',
  'stats_disabled',
  'stats_locked',
  'stats_unauthorized',
  'timeout',
  'too_many_redirects',
  'too_many_requests',
  'translate_auth_failed',
  'translate_quota',
  'translate_rate_limited',
  'translate_timeout',
  'translate_unavailable',
  'unsupported_protocol',
  'upstream_error',
].sort();

describe('ERROR_SPEC：码表完整性', () => {
  it('码集合与预期完全一致', () => {
    expect(Object.keys(ERROR_SPEC).sort()).toEqual(EXPECTED_CODES);
  });

  it('每个码都有合法的 HTTP 状态与一句话文案', () => {
    for (const [code, spec] of Object.entries(ERROR_SPEC)) {
      expect(Number.isInteger(spec.status), `${code} 的 status 不是整数`).toBe(true);
      expect(spec.status, `${code} 的 status 不在 4xx/5xx`).toBeGreaterThanOrEqual(400);
      expect(spec.status, `${code} 的 status 不在 4xx/5xx`).toBeLessThan(600);
      expect(spec.message.trim().length, `${code} 缺少用户可读文案`).toBeGreaterThan(0);
    }
  });
});

describe('ERROR_SPEC：归一口径（改回去就是 bug）', () => {
  it('上游 401 一律映射成 5xx，绝不透出 401', () => {
    // 401 有两层完全不同的含义："我们的 key 过期了"（服务端问题）
    // 与"用户没登录"（用户问题）。前端不该去猜，所以统一落在 5xx。
    expect(ERROR_SPEC.translate_auth_failed.status).toBe(502);
    for (const code of ['translate_auth_failed', 'translate_quota', 'translate_unavailable'] as const) {
      expect(ERROR_SPEC[code].status).toBeGreaterThanOrEqual(500);
    }
  });

  it('限流保留 429（它是唯一"等一下有用"的翻译错误）', () => {
    expect(ERROR_SPEC.translate_rate_limited.status).toBe(429);
  });

  it('我们自己的两道闸门与上游限流**必须是三个不同的码**', () => {
    // `translate_rate_limited` 讲的是"上游把我们限流了"（后端会自动重试一次），
    // 我们自己的闸门拦下来是**重试没有用**的。合成一个码的话，
    // 前端就再也分不清"该不该再试一次"，只能猜。
    expect(ERROR_SPEC.too_many_requests.status).toBe(429);
    expect(ERROR_SPEC.daily_limit_reached.status).toBe(429);
    expect(ERROR_SPEC.too_many_requests.message).not.toBe(ERROR_SPEC.translate_rate_limited.message);
    // 频率问题与额度问题是两种处境（"等半分钟" vs "今天没了"），说法也不能一样
    expect(ERROR_SPEC.daily_limit_reached.message).not.toBe(ERROR_SPEC.too_many_requests.message);
  });

  it('超时用 504，且与 translation 侧的其它失败区分开', () => {
    expect(ERROR_SPEC.translate_timeout.status).toBe(504);
    expect(ERROR_SPEC.timeout.status).toBe(504);
  });

  it('connection_reset 必须与 timeout 分开（性质相反：73ms 被重置 vs 25s 等不到）', () => {
    expect(ERROR_SPEC.connection_reset.status).not.toBe(ERROR_SPEC.timeout.status);
    expect(ERROR_SPEC.connection_reset.message).not.toBe(ERROR_SPEC.timeout.message);
  });

  it('安全红线类的错误码固定：SSRF 拦截给 403，非英文闸门给 422', () => {
    expect(ERROR_SPEC.blocked_target.status).toBe(403);
    expect(ERROR_SPEC.source_not_english.status).toBe(422);
  });

  it('统计接口的 401 是**我们自己的**登录要求，不是把上游 401 漏了出去', () => {
    // 上面那条"绝不透出 401"讲的是**上游**（LLM 服务商）的 401 —— 那是我们 key 的问题，
    // 前端不该猜。这里反过来：统计接口的 401 就是"你还没登录"，而且必须原样透出 ——
    // 浏览器正是靠 `401 + WWW-Authenticate` 才会弹登录框。两者含义相反，别合并。
    expect(ERROR_SPEC.stats_unauthorized.status).toBe(401);
    expect(ERROR_SPEC.stats_disabled.status).toBe(503);
    expect(ERROR_SPEC.stats_locked.status).toBe(429);
  });
});

describe('AppError', () => {
  it('message 与 status 都取自码表，不需要调用方重复写', () => {
    const err = new AppError('blocked_target');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AppError');
    expect(err.code).toBe('blocked_target');
    expect(err.message).toBe(ERROR_SPEC.blocked_target.message);
    expect(err.status).toBe(403);
  });

  it('toPayload 产出前端约定的形状', () => {
    expect(new AppError('invalid_url').toPayload()).toEqual({
      error: {
        code: 'invalid_url',
        message: ERROR_SPEC.invalid_url.message,
        hint: ERROR_SPEC.invalid_url.hint,
      },
    });
  });

  it('码表里没有 hint 的，payload 里就不出现 hint 字段', () => {
    // 注意不是 `hint: undefined` —— 那样 JSON 序列化后仍会留一个键
    expect(new AppError('not_found').toPayload()).toEqual({
      error: { code: 'not_found', message: ERROR_SPEC.not_found.message },
    });
  });

  it('hintOverride 能覆盖默认 hint（同码在不同上下文给不同建议）', () => {
    const payload = new AppError('invalid_request', '至少要有一个待翻译块').toPayload();
    expect(payload.error.hint).toBe('至少要有一个待翻译块');
    expect(payload.error.code).toBe('invalid_request');

    // 默认没有 hint 的码，也能靠 override 补上
    expect(new AppError('internal_error', '看日志').toPayload().error.hint).toBe('看日志');
  });

  it('是真正的 Error：能带堆栈、能被 catch 到', () => {
    const err = new AppError('internal_error');
    expect(err.stack).toBeTruthy();
  });
});
