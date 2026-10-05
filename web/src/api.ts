/**
 * 请求封装（技术方案 7.2）。
 *
 * 两条硬规矩：
 * 1. **只写同源相对路径** `/api/...` —— 开发期由 Vite 代理转发，发布期由 Nest 同源托管，
 *    一份代码两处跑，不用改配置（7.1）。这里绝不出现 `http://localhost:3000`。
 * 2. 后端的错误一律是 `{ error: { code, message, hint } }`，在这里统一转成 `ApiError`，
 *    上层只认 `code` 做分支，不解析字符串。
 */

import type { Article, ErrorCode, ErrorPayload } from './types';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  /** HTTP 状态码；网络层失败时为 0 */
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number, hint?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

/** 用户主动取消（换了一篇、组件卸载）—— 上层不该把它当错误展示 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * 抓取并提取一篇文章。
 *
 * @param url    用户粘贴的网址（原样传，规范化交给后端，保证前后端判定一致）
 * @param signal 用于取消上一次请求
 */
export async function fetchArticle(url: string, signal?: AbortSignal): Promise<Article> {
  let res: Response;
  try {
    res = await fetch(`/api/article?url=${encodeURIComponent(url)}`, { signal });
  } catch (err) {
    // 取消要原样抛出，否则上层会把"用户换了篇文章"显示成报错
    if (isAbortError(err)) throw err;
    throw new ApiError('internal_error', '连不上服务器', 0, '检查一下网络，或稍后再试');
  }

  if (!res.ok) {
    throw await toApiError(res);
  }

  // 后端返回 200 但内容不是预期结构时，也不能让页面白屏
  try {
    return (await res.json()) as Article;
  } catch {
    throw new ApiError('internal_error', '服务器返回的数据看不懂', res.status);
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as Partial<ErrorPayload>;
    const err = body?.error;
    if (err?.code) {
      return new ApiError(err.code, err.message || '请求失败', res.status, err.hint);
    }
  } catch {
    // 落到下面的兜底
  }
  return new ApiError('internal_error', '服务器出了点问题', res.status);
}
