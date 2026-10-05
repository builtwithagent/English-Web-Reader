/**
 * 抓取一篇文章（技术方案 7.2）。
 *
 * 这一层只负责"拿到文章"，不掺和语言分支 —— `lang` / `isEnglish` 原样透出，
 * 由上层决定双栏还是单栏（分叉点只有一个，越靠上越好找）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fetchArticle, isAbortError } from '../api';
import type { Article } from '../types';

export type ArticleStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseArticleResult {
  status: ArticleStatus;
  article: Article | null;
  error: ApiError | null;
  load(url: string): void;
  reset(): void;
}

export function useArticle(): UseArticleResult {
  const [status, setStatus] = useState<ArticleStatus>('idle');
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  // 连续粘贴两次时，前一个请求要被取消，否则可能后到的旧响应覆盖新文章
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const load = useCallback((url: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('loading');
    setArticle(null);
    setError(null);

    void (async () => {
      try {
        const result = await fetchArticle(url, controller.signal);
        // 请求已被更新的请求取代时不要回写，避免旧数据盖掉新数据
        if (controller.signal.aborted) return;
        setArticle(result);
        setStatus('ready');
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) return;
        setError(normalizeError(err));
        setStatus('error');
      }
    })();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
    setArticle(null);
    setError(null);
  }, []);

  return { status, article, error, load, reset };
}

/** 兜底：任何非 ApiError 的异常也要变成能展示的东西，不能让页面白屏 */
function normalizeError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError('internal_error', '出了点意外的问题', 0, (err as Error)?.message);
}
