/**
 * 翻译接线（技术方案 5.2 / 7.2）。
 *
 * 职责边界很清楚：**它只管"把块发出去、把译文按 id 收回来"**，
 * 不碰抓取（那是 `useArticle`），不碰偏好（那是 `usePreferences`）。
 * 三个 Hook 在 `App` 里汇合，各自只有一件事。
 *
 * 三条容易写错的地方：
 *
 * 1. **不按到达顺序回填**。服务端并发 3，第 8 块可能先于第 3 块回来 ——
 *    按到达顺序塞数组，整篇就错位了。所以译文存 `Map<id, text>`。
 *
 * 2. **同一份"要不要翻"的判断，前端只在这里做一次**。非英文页面根本不发翻译请求
 *    （技术方案 7.5 的硬要求），而不是发了等后端拒 —— 那是白花钱。
 *
 * 3. **换了文章 / 换了目标语言，旧译文必须立刻清空**。
 *    只清不重发会让用户看着上一篇的译文发呆；只重发不清空则会出现
 *    "新文章的左栏配旧文章的右栏"。两件事在同一个 effect 里做，顺序固定。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isAbortError, streamTranslate } from '../api';
import type { Article, Block, TargetLang } from '../types';

export type TranslationPhase =
  /** 不需要翻译（非英文页降级态），或没有可译块 */
  | 'idle'
  | 'running'
  | 'done'
  /** 整篇被拦下：上游不可用、密钥缺失、或入口语言闸门拒了 */
  | 'blocked';

export interface TranslationProgress {
  total: number;
  done: number;
  failed: number;
}

export interface UseTranslationResult {
  /** 译文，按块 id 索引 —— `BlockView` 的 `translation` 直接取它 */
  translations: Map<number, string | string[]>;
  /** 失败的块 id。这些块的格子里会显示"没译出来"，其它块照常 */
  failedIds: ReadonlySet<number>;
  phase: TranslationPhase;
  progress: TranslationProgress;
  /** 整篇级的错误（单块失败不走这里）。`null` 表示没有 */
  error: ApiError | null;
  /** 重试所有还没有译文的块（失败 + 没轮到的） */
  retryMissing(): void;
}

interface UseTranslationOptions {
  article: Article | null;
  targetLang: TargetLang;
  /** 英文页为 true；非英文页只有在用户点了「仍要翻译」时才为 true */
  enabled: boolean;
}

/** 一次要发的块。与 `TranslateRequest['blocks']` 的唯一差别是保留了原文块类型 */
interface Job {
  id: number;
  text: string;
}

export function useTranslation({
  article,
  targetLang,
  enabled,
}: UseTranslationOptions): UseTranslationResult {
  const [translations, setTranslations] = useState<Map<number, string | string[]>>(
    () => new Map(),
  );
  const [failedIds, setFailedIds] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // 换一篇 / 换语言时要 abort 掉在途的流，否则旧译文会陆续落到新文章上
  const abortRef = useRef<AbortController | null>(null);

  const blocks = useMemo<Block[]>(() => article?.blocks ?? [], [article]);
  const blockById = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);
  const jobs = useMemo(() => buildJobs(blocks), [blocks]);

  const pageUrl = article?.finalUrl;

  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * 发一轮。**不含清空逻辑** —— 全量翻译和"补翻漏掉的"对旧结果的处理方式不同，
   * 由调用方决定，这里只管发和收。
   */
  const send = useCallback(
    async (items: Job[], controller: AbortController): Promise<void> => {
      try {
        await streamTranslate(
          {
            url: pageUrl,
            targetLang,
            blocks: items.map(({ id, text }) => ({ id, text })),
          },
          {
            onBlock(id, text) {
              const block = blockById.get(id);
              setTranslations((prev) => {
                const next = new Map(prev);
                next.set(id, decodeTranslation(block, text));
                return next;
              });
              // 重试成功的情形：把之前的失败标记撤掉，
              // 否则格里子显示译文、计数却还算它失败
              setFailedIds((prev) => {
                if (!prev.has(id)) return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
            },
            onBlockError(id) {
              setFailedIds((prev) => new Set(prev).add(id));
            },
            onFatal(err) {
              setError(err);
            },
          },
          controller.signal,
        );
      } catch (err) {
        // 用户换了文章 / 换了语言而取消 —— 不是错误，安静退出
        if (isAbortError(err) || controller.signal.aborted) return;
        setError(normalizeError(err));
      }
    },
    [pageUrl, targetLang, blockById],
  );

  useEffect(() => {
    // 不翻译的两种情形：降级态，以及一篇文章里没有可译块。
    // 清空是必须的 —— 从英文页换到中文页时，右栏要立刻消失，不能留着上一篇的译文。
    if (!enabled || jobs.length === 0) {
      abortRef.current?.abort();
      abortRef.current = null;
      setTranslations(new Map());
      setFailedIds(new Set());
      setError(null);
      setBusy(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setTranslations(new Map());
    setFailedIds(new Set());
    setError(null);
    setBusy(true);

    void send(jobs, controller).finally(() => {
      // 只有"还是当前这一发"时才收尾，否则会把后来那一发的 busy 提前抹掉
      if (abortRef.current === controller) setBusy(false);
    });

    return () => controller.abort();
  }, [enabled, jobs, send]);

  const retryMissing = useCallback(() => {
    const pending = jobs.filter((job) => !translations.has(job.id));
    if (pending.length === 0) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setFailedIds(new Set());
    setError(null);
    setBusy(true);

    void send(pending, controller).finally(() => {
      if (abortRef.current === controller) setBusy(false);
    });
  }, [jobs, translations, send]);

  const phase = useMemo<TranslationPhase>(() => {
    if (!enabled || jobs.length === 0) return 'idle';
    if (error) return 'blocked';
    if (busy) return 'running';
    // 译文与失败数加起来覆盖了全部块 = 这一轮跑完了
    return translations.size + failedIds.size >= jobs.length ? 'done' : 'idle';
  }, [enabled, jobs.length, error, busy, translations.size, failedIds.size]);

  const progress = useMemo<TranslationProgress>(
    () => ({ total: jobs.length, done: translations.size, failed: failedIds.size }),
    [jobs.length, translations.size, failedIds.size],
  );

  return { translations, failedIds, phase, progress, error, retryMissing };
}

// ============================================================================
// 纯函数
// ============================================================================

/**
 * 挑出要发的块，并把它压成**纯文本**。
 *
 * - 代码块、图片块不发（后端也会再过滤一遍，两边一致才不会出现"前端发了后端跳过"
 *   导致进度条永远差几格的情况）
 * - 空白文本不发
 * - 列表块用换行拼起来发 —— 上游只有 `{id, text}` 一个字段，
 *   而列表要的是"逐项对应"，换行是唯一能表达"项边界"又不改契约的办法
 */
function buildJobs(blocks: Block[]): Job[] {
  const jobs: Job[] = [];
  for (const block of blocks) {
    if (!block.translatable) continue;
    const text = sourceText(block);
    if (!text.trim()) continue;
    jobs.push({ id: block.id, text });
  }
  return jobs;
}

function sourceText(block: Block): string {
  if (block.type === 'ul' || block.type === 'ol') return (block.items ?? []).join('\n');
  return block.text ?? '';
}

/**
 * 把译文还原成该块的形状。
 *
 * 列表块要的是数组，但上游只回一段文本，所以按行切回去。
 * **行数对不上就整段当成一项** —— 模型少吐一个换行是很常见的，
 * 硬按行数切会让后面所有项错位（第 3 项的内容跑到第 2 项去），
 * 那比"这一段少了个项目符号"严重得多。
 */
function decodeTranslation(block: Block | undefined, text: string): string | string[] {
  if (!block || (block.type !== 'ul' && block.type !== 'ol')) return text;

  const expected = block.items?.length ?? 0;
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•·]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean);

  return lines.length === expected ? lines : [text.trim()];
}

function normalizeError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError('internal_error', '翻译时出了点意外', 0, (err as Error)?.message);
}
