import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, isAbortError, streamTranslate, type TranslateHandlers } from './api';
import type { ErrorCode, TranslateRequest } from './types';

/**
 * SSE 流式翻译的客户端单测（技术方案 5.2 / 7.2）。
 *
 * 不用 `EventSource` 是刻意的：它只能发 GET、带不了请求体（整篇的块），
 * 也拿不到 HTTP 状态码 —— 而"非英文页闸门 / 密钥缺失"这两种拦截
 * **在发流之前**就以普通 JSON 错误返回了，前端必须能区分它们。
 * 于是这里要覆盖两类完全不同的失败：**流里的错误**与**流之前的错误**。
 *
 * 分帧细节（一个帧被劈成两个 chunk、末尾没有空行）在这层最容易写错：
 * 写错的表现是偶尔丢几段译文，而不是稳定报错，所以逐条钉住。
 */

const encoder = new TextEncoder();

function request(blocks: Array<{ id: number; text: string }>): TranslateRequest {
  return { url: 'https://example.com/post', targetLang: 'zh-Hans', blocks };
}

interface FakeResponseInit {
  status?: number;
  contentType?: string;
  chunks?: Array<string | Uint8Array>;
  body?: ReadableStream<Uint8Array> | null;
  json?: unknown;
}

function fakeResponse(init: FakeResponseInit = {}): Response {
  const chunks = init.chunks;
  const body =
    init.body !== undefined
      ? init.body
      : chunks
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
              }
              controller.close();
            },
          })
        : null;

  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? (init.contentType ?? '') : null),
    },
    json: async () => init.json,
    text: async () => JSON.stringify(init.json ?? ''),
  } as unknown as Response;
}

const SSE_HEADERS = { contentType: 'text/event-stream; charset=utf-8' };

function stubFetch(impl: () => Promise<Response> | Response) {
  const spy = vi.fn(impl as unknown as typeof fetch);
  vi.stubGlobal('fetch', spy);
  return spy;
}

interface Recorder {
  blocks: Array<[number, string]>;
  blockErrors: Array<[number, ErrorCode]>;
  fatals: ApiError[];
  handlers: TranslateHandlers;
}

function recorder(): Recorder {
  const blocks: Array<[number, string]> = [];
  const blockErrors: Array<[number, ErrorCode]> = [];
  const fatals: ApiError[] = [];
  return {
    blocks,
    blockErrors,
    fatals,
    handlers: {
      onBlock: (id, text) => blocks.push([id, text]),
      onBlockError: (id, code) => blockErrors.push([id, code]),
      onFatal: (err) => fatals.push(err),
    },
  };
}

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const deltaFrame = (id: number, text: string): string => frame({ id, text });
const DONE = 'data: [DONE]\n\n';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================================

describe('streamTranslate：正常回流', () => {
  it('逐帧回调，并带上 id 与译文', async () => {
    const rec = recorder();
    stubFetch(() =>
      fakeResponse({ ...SSE_HEADERS, chunks: [deltaFrame(1, '第一段'), deltaFrame(2, '第二段'), DONE] }),
    );

    await streamTranslate(request([{ id: 1, text: 'a' }, { id: 2, text: 'b' }]), rec.handlers);

    expect(rec.blocks).toEqual([
      [1, '第一段'],
      [2, '第二段'],
    ]);
    expect(rec.blockErrors).toEqual([]);
    expect(rec.fatals).toEqual([]);
  });

  it('**按到达顺序回调，不保证与请求顺序一致**（服务端并发 3）', async () => {
    const rec = recorder();
    stubFetch(() =>
      fakeResponse({ ...SSE_HEADERS, chunks: [deltaFrame(3, 'c'), deltaFrame(1, 'a'), deltaFrame(2, 'b'), DONE] }),
    );

    await streamTranslate(request([{ id: 1, text: 'a' }, { id: 2, text: 'b' }, { id: 3, text: 'c' }]), rec.handlers);

    // 上层必须靠 id 回填，不能靠数组下标
    expect(rec.blocks.map(([id]) => id)).toEqual([3, 1, 2]);
  });

  it('请求体按契约发出（url / targetLang / blocks）', async () => {
    const rec = recorder();
    const spy = stubFetch(() => fakeResponse({ ...SSE_HEADERS, chunks: [DONE] }));

    await streamTranslate(request([{ id: 1, text: 'hello' }]), rec.handlers);

    const init = spy.mock.calls[0][1] as RequestInit;
    expect(spy.mock.calls[0][0]).toBe('/api/translate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'https://example.com/post',
      targetLang: 'zh-Hans',
      blocks: [{ id: 1, text: 'hello' }],
    });
  });

  it('只写同源相对路径（发布期同源托管、开发期走 Vite 代理）', async () => {
    const spy = stubFetch(() => fakeResponse({ ...SSE_HEADERS, chunks: [DONE] }));
    await streamTranslate(request([{ id: 1, text: 'x' }]), recorder().handlers);
    expect(String(spy.mock.calls[0][0])).not.toMatch(/^https?:\/\//);
  });
});

describe('streamTranslate：分帧的边界情况', () => {
  it('一个帧被劈成两个 chunk 也能拼回来', async () => {
    const rec = recorder();
    const whole = deltaFrame(1, '完整的译文');
    const cut = Math.floor(whole.length / 2);
    stubFetch(() => fakeResponse({ ...SSE_HEADERS, chunks: [whole.slice(0, cut), whole.slice(cut), DONE] }));

    await streamTranslate(request([{ id: 1, text: 'x' }]), rec.handlers);
    expect(rec.blocks).toEqual([[1, '完整的译文']]);
  });

  it('多字节字符被劈在中间也不乱码', async () => {
    const rec = recorder();
    const bytes = encoder.encode(deltaFrame(1, '中文测试'));
    stubFetch(() =>
      fakeResponse({ ...SSE_HEADERS, chunks: [bytes.slice(0, 3), bytes.slice(3), encoder.encode(DONE)] }),
    );

    await streamTranslate(request([{ id: 1, text: 'x' }]), rec.handlers);
    expect(rec.blocks).toEqual([[1, '中文测试']]);
  });

  it('流末尾没有空行收尾，最后一帧也要处理', async () => {
    const rec = recorder();
    // 只给一帧、且不带结尾的 \n\n
    stubFetch(() => fakeResponse({ ...SSE_HEADERS, chunks: [`data: ${JSON.stringify({ id: 1, text: '尾巴' })}`] }));

    await streamTranslate(request([{ id: 1, text: 'x' }]), rec.handlers);
    expect(rec.blocks).toEqual([[1, '尾巴']]);
  });

  it('[DONE] 之后不再回调', async () => {
    const rec = recorder();
    stubFetch(() => fakeResponse({ ...SSE_HEADERS, chunks: [deltaFrame(1, '要的'), DONE, deltaFrame(2, '多余的')] }));

    await streamTranslate(request([{ id: 1, text: 'x' }]), rec.handlers);
    expect(rec.blocks).toEqual([[1, '要的']]);
  });

  it('注释行（: keep-alive）与空 data 被忽略', async () => {
    const rec = recorder();
    stubFetch(() =>
      fakeResponse({
        ...SSE_HEADERS,
        chunks: [': keep-alive\n\n', 'data:\n\n', 'data: \n\n', deltaFrame(1, 'ok'), DONE],
      }),
    );

    await streamTranslate(request([{ id: 1, text: 'x' }]), rec.handlers);
    expect(rec.blocks).toEqual([[1, 'ok']]);
  });

  it('单个坏帧跳过，后面的帧继续处理', async () => {
    const rec = recorder();
    stubFetch(() =>
      fakeResponse({
        ...SSE_HEADERS,
        chunks: [deltaFrame(1, 'A'), 'data: {坏掉的 JSON\n\n', deltaFrame(2, 'B'), DONE],
      }),
    );

    await streamTranslate(request([{ id: 1, text: 'a' }, { id: 2, text: 'b' }]), rec.handlers);
    // 坏帧不能让整篇译文消失
    expect(rec.blocks).toEqual([
      [1, 'A'],
      [2, 'B'],
    ]);
  });
});

describe('streamTranslate：流里的错误', () => {
  it('带 id 的 error 走 onBlockError，**其它块不受影响**', async () => {
    const rec = recorder();
    stubFetch(() =>
      fakeResponse({
        ...SSE_HEADERS,
        chunks: [
          deltaFrame(1, 'A'),
          frame({ id: 2, error: { code: 'translate_timeout' } }),
          deltaFrame(3, 'C'),
          DONE,
        ],
      }),
    );

    await streamTranslate(
      request([{ id: 1, text: 'a' }, { id: 2, text: 'b' }, { id: 3, text: 'c' }]),
      rec.handlers,
    );

    expect(rec.blocks).toEqual([
      [1, 'A'],
      [3, 'C'],
    ]);
    expect(rec.blockErrors).toEqual([[2, 'translate_timeout']]);
    expect(rec.fatals).toEqual([]);
  });

  it('**没有 id 的 error 才是整体失败**，带完整文案走 onFatal', async () => {
    const rec = recorder();
    stubFetch(() =>
      fakeResponse({
        ...SSE_HEADERS,
        chunks: [
          frame({
            error: {
              code: 'translate_auth_failed',
              message: '翻译服务暂时不可用',
              hint: '检查一下服务端的密钥配置',
            },
          }),
          DONE,
        ],
      }),
    );

    await streamTranslate(request([{ id: 1, text: 'a' }]), rec.handlers);

    expect(rec.blocks).toEqual([]);
    expect(rec.blockErrors).toEqual([]);
    expect(rec.fatals).toHaveLength(1);
    expect(rec.fatals[0]).toBeInstanceOf(ApiError);
    expect(rec.fatals[0].code).toBe('translate_auth_failed');
    // 文案由服务端唯一提供，前端不再抄一份
    expect(rec.fatals[0].message).toBe('翻译服务暂时不可用');
    expect(rec.fatals[0].hint).toBe('检查一下服务端的密钥配置');
  });

  it('整体失败不带文案时用兜底文案，不显示成 undefined', async () => {
    const rec = recorder();
    stubFetch(() => fakeResponse({ ...SSE_HEADERS, chunks: [frame({ error: { code: 'internal_error' } }), DONE] }));

    await streamTranslate(request([{ id: 1, text: 'a' }]), rec.handlers);
    expect(rec.fatals[0].message).toBe('翻译失败');
  });

  it('单块失败与整体失败可以同时存在，互不干扰', async () => {
    const rec = recorder();
    stubFetch(() =>
      fakeResponse({
        ...SSE_HEADERS,
        chunks: [
          deltaFrame(1, 'A'),
          frame({ id: 2, error: { code: 'translate_unavailable' } }),
          frame({ error: { code: 'translate_quota', message: '翻译额度已耗尽' } }),
          DONE,
        ],
      }),
    );

    await streamTranslate(request([{ id: 1, text: 'a' }, { id: 2, text: 'b' }]), rec.handlers);
    expect(rec.blocks).toEqual([[1, 'A']]);
    expect(rec.blockErrors).toEqual([[2, 'translate_unavailable']]);
    expect(rec.fatals).toHaveLength(1);
  });
});

describe('streamTranslate：发流之前的错误（HTTP 层）', () => {
  it('非英文页闸门给的 422 直接抛出来，带 code / message / hint', async () => {
    const rec = recorder();
    stubFetch(() =>
      fakeResponse({
        status: 422,
        json: { error: { code: 'source_not_english', message: '这不是英文网页，未做翻译' } },
      }),
    );

    await expect(streamTranslate(request([{ id: 1, text: '中文' }]), rec.handlers)).rejects.toMatchObject({
      code: 'source_not_english',
      status: 422,
      message: '这不是英文网页，未做翻译',
    });
    // 关键：这类失败**不是流里的错误**，不该走 onFatal
    expect(rec.fatals).toEqual([]);
  });

  it('密钥缺失给的 502 同样直接抛', async () => {
    const rec = recorder();
    stubFetch(() =>
      fakeResponse({ status: 502, json: { error: { code: 'translate_auth_failed', message: '翻译服务暂时不可用' } } }),
    );

    await expect(streamTranslate(request([{ id: 1, text: 'a' }]), rec.handlers)).rejects.toMatchObject({
      code: 'translate_auth_failed',
      status: 502,
    });
  });

  it('错误体不是预期 JSON 时兜底成 internal_error，不让页面拿到 undefined', async () => {
    const rec = recorder();
    stubFetch(() =>
      fakeResponse({
        status: 500,
        json: null,
      }),
    );
    // json 返回 null → body?.error 取不到 → 兜底分支
    await expect(streamTranslate(request([{ id: 1, text: 'a' }]), rec.handlers)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('200 但 content-type 不是 SSE → 报"预期外的格式"', async () => {
    const rec = recorder();
    stubFetch(() => fakeResponse({ contentType: 'application/json', chunks: [DONE] }));

    await expect(streamTranslate(request([{ id: 1, text: 'a' }]), rec.handlers)).rejects.toMatchObject({
      code: 'internal_error',
      message: '译文服务返回了预期外的格式',
    });
  });

  it('200 但没有响应体 → 同样报"预期外的格式"', async () => {
    const rec = recorder();
    stubFetch(() => fakeResponse({ ...SSE_HEADERS, body: null }));

    await expect(streamTranslate(request([{ id: 1, text: 'a' }]), rec.handlers)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('streamTranslate：网络层与取消', () => {
  it('连不上服务器 → ApiError(internal_error, status 0)', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });

    await expect(streamTranslate(request([{ id: 1, text: 'a' }]), recorder().handlers)).rejects.toMatchObject({
      code: 'internal_error',
      status: 0,
      message: '连不上服务器',
    });
  });

  it('用户取消（换文章 / 换语言）原样抛出 AbortError，不被当成错误展示', async () => {
    stubFetch(() => {
      throw new DOMException('This operation was aborted', 'AbortError');
    });

    try {
      await streamTranslate(request([{ id: 1, text: 'a' }]), recorder().handlers);
      throw new Error('预期抛错');
    } catch (err) {
      expect(isAbortError(err)).toBe(true);
      expect(err).not.toBeInstanceOf(ApiError);
    }
  });

  it('取消信号会透给 fetch', async () => {
    const spy = stubFetch(() => fakeResponse({ ...SSE_HEADERS, chunks: [DONE] }));
    const controller = new AbortController();
    await streamTranslate(request([{ id: 1, text: 'a' }]), recorder().handlers, controller.signal);

    expect((spy.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });
});

describe('ApiError / isAbortError', () => {
  it('ApiError 保留 code / status / hint，message 可直接展示', () => {
    const err = new ApiError('blocked_target', '这个地址不允许访问', 403, '只允许公网地址');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
    expect(err.code).toBe('blocked_target');
    expect(err.status).toBe(403);
    expect(err.hint).toBe('只允许公网地址');
  });

  it('isAbortError 只认 AbortError，不误伤普通错误', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError(new DOMException('x', 'TimeoutError'))).toBe(false);
    expect(isAbortError(new Error('aborted'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(new ApiError('internal_error', 'x', 0))).toBe(false);
  });
});
