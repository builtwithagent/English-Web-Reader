/**
 * 翻译进度 / 结果（技术方案 5.2）。
 *
 * 放在控制条右侧。三种状态各有各的表示，但**都不用转圈动画** ——
 * 转圈适合"不知道要多久"，而这里进度是确定的（48 块里的 12 块），
 * 给个数字比给个转圈更让人安心。
 *
 * 全篇失败（`blocked`）时直接用服务端给的 `message`：文案只有一处定义，
 * 前端不抄第二份中文表（否则改了一边另一边的用户就看到旧话术）。
 */

import type { ApiError } from '../api';
import type { TranslationPhase, TranslationProgress } from '../hooks/useTranslation';

interface TranslateStatusProps {
  phase: TranslationPhase;
  progress: TranslationProgress;
  error: ApiError | null;
  onRetry(): void;
}

export function TranslateStatus({ phase, progress, error, onRetry }: TranslateStatusProps) {
  if (phase === 'blocked') {
    return (
      <span className="status bad" title={error?.hint ?? undefined}>
        {error?.message ?? '翻译暂时不可用'}
      </span>
    );
  }

  if (phase === 'running') {
    return (
      <span className="status">
        {progress.done}/{progress.total} 翻译中
      </span>
    );
  }

  if (phase === 'done') {
    // 一块都没成，说明是整篇性的问题（密钥、额度），别报一个"0 段已翻译"
    if (progress.done === 0) {
      return <span className="status bad">翻译没有成功</span>;
    }

    return (
      <>
        <span className="status ok">{progress.done} 段已翻译</span>
        {progress.failed > 0 ? (
          <button type="button" className="link" onClick={onRetry}>
            {progress.failed} 段没译出来 · 重试
          </button>
        ) : null}
      </>
    );
  }

  return null;
}
