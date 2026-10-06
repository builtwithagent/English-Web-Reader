/**
 * 顶层：输入态 → 加载态 → 阅读态，把各层 Hook 串起来（技术方案 7.2）。
 *
 * 三条链在这里汇合，各自只做一件事：
 *   `useArticle`     抓取 + 提取 + 语言判定
 *   `useTranslation` 按块翻译、按 id 回填
 *   `usePreferences` 字号 / 模式 / 深浅色 / 目标语言
 *
 * 语言分叉点也收在这一层：`article.isEnglish` 决定双栏还是单栏，
 * 往下传的就只有"要不要渲染译文列"这一个布尔值。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Topbar } from './components/Topbar';
import { UrlInput } from './components/UrlInput';
import { Toolbar } from './components/Toolbar';
import { LangNotice } from './components/LangNotice';
import { TranslateStatus } from './components/TranslateStatus';
import { Reader } from './components/Reader';
import { ErrorBanner } from './components/ErrorBanner';
import { Skeleton } from './components/Skeleton';
import { ToastStack, type ToastItem } from './components/ToastStack';
import { useArticle } from './hooks/useArticle';
import { useTranslation } from './hooks/useTranslation';
import { usePreferencesApi } from './hooks/usePreferences';
import { targetLangLabel } from './types';

export function App() {
  const { prefs, setMode, bumpFontSize, toggleTheme, setTargetLang } = usePreferencesApi();
  const { status, article, error, load, reset } = useArticle();

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextToastId = useRef(0);

  // 语言判定误判时的临时放行（技术方案 4.7 / 7.5）。
  // 只对当前这篇文章生效，不改变判定逻辑本身，换一篇就重置。
  const [forceTranslate, setForceTranslate] = useState(false);

  const toast = useCallback((message: string) => {
    const id = (nextToastId.current += 1);
    setToasts((list) => [...list, { id, message }]);
    window.setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
    }, 2200);
  }, []);

  const handleSubmit = useCallback(
    (url: string) => {
      if (!url) {
        toast('先粘贴一个网址');
        return;
      }
      setForceTranslate(false);
      load(url);
    },
    [load, toast],
  );

  const handleReset = useCallback(() => {
    setForceTranslate(false);
    reset();
  }, [reset]);

  // 调试/自检入口：`?url=...` 直接进入阅读态。
  // 手点一次要复制粘贴等好几秒，无头浏览器也没法点；有了它截图自检才能自动化。
  //
  // 这里**刻意不加"只跑一次"的 ref 防护**：StrictMode 会模拟一次卸载/重挂载，
  // 加了防护会让第二次挂载直接跳过，而第一次的请求已经被 cleanup abort 掉了
  // （abort 后的 catch 会静默 return，不回退状态）→ 页面永远停在加载态。
  // 去掉防护后，重挂载会重新发起请求，开发期多一次被取消的请求，生产期只有一次。
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('url');
    if (initial) load(initial);
  }, [load]);

  // 降级 = 判非英文 且 用户没点「仍要翻译」
  const degraded = article ? !article.isEnglish && !forceTranslate : false;

  const showLanding = status === 'idle' || status === 'error';
  const showSkeleton = status === 'loading';
  const showReader = status === 'ready' && article !== null;

  /**
   * 要不要发起翻译。
   *
   * **非英文页面一律不发**（技术方案 7.5）—— 这是垂直定位的硬要求，
   * 不是"发了等后端拒"：白花一次上游调用的钱，还要等一圈才拿到拒绝。
   * 唯一的例外是「仍要翻译」，那是判定误判时的兜底，用户明确要求了才绕过。
   */
  const translateEnabled = showReader && (article?.isEnglish === true || forceTranslate);

  const { translations, failedIds, phase, progress, error: translateError, retryMissing } =
    useTranslation({
      article,
      targetLang: prefs.targetLang,
      enabled: translateEnabled,
    });

  return (
    <>
      <Topbar
        targetLang={prefs.targetLang}
        onTargetLangChange={(v) => {
          setTargetLang(v);
          // 目标语言是 `useTranslation` 的依赖，改了会自动重翻整篇（并 abort 上一轮）。
          // 不需要用户再点一次"重新翻译"。
          if (showReader) toast(`正在用${targetLangLabel(v)}重新翻译`);
        }}
        theme={prefs.theme}
        onToggleTheme={toggleTheme}
        onToggleFavorite={() => toast('收藏需要登录 · 点击进入登录')}
        onExport={() => toast('导出功能还没做')}
        canExport={showReader}
      />

      {showLanding ? (
        <>
          <UrlInput onSubmit={handleSubmit} busy={false} />
          {error ? <ErrorBanner error={error} /> : null}
        </>
      ) : null}

      {showSkeleton ? <Skeleton /> : null}

      {showReader && article ? (
        <>
          <div className="reading-chrome">
            <div className="chrome-inner">
              <div className="mini-url">
                <span className="lock">🔒</span>
                <span className="u">{article.finalUrl}</span>
              </div>
              <button type="button" className="btn" onClick={handleReset}>
                换一篇
              </button>
            </div>

            <Toolbar
              mode={prefs.mode}
              onModeChange={setMode}
              fontSize={prefs.fontSize}
              onFontBump={bumpFontSize}
              showModeSwitch={!degraded}
              status={
                degraded ? (
                  <span className="status">未翻译</span>
                ) : (
                  <TranslateStatus
                    phase={phase}
                    progress={progress}
                    error={translateError}
                    onRetry={retryMissing}
                  />
                )
              }
            />

            {degraded ? (
              <LangNotice
                lang={article.lang}
                onForceTranslate={() => {
                  setForceTranslate(true);
                  toast('已放行，开始翻译');
                }}
              />
            ) : null}
          </div>

          <Reader
            article={article}
            targetLang={prefs.targetLang}
            mode={prefs.mode}
            translations={translations}
            failedIds={failedIds}
            forceTranslate={forceTranslate}
          />
        </>
      ) : null}

      <ToastStack items={toasts} />
    </>
  );
}
