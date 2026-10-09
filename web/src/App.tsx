/**
 * 顶层：**路由**，然后是两个页面。
 *
 * 路由是手写的（`src/router.ts`）—— 全站只有两条路径，装一个路由库换来的
 * 是一套与项目其余部分无关的概念，而它要解决的问题在这里只有二十行。
 *
 * 之所以必须拆成两个组件（而不是在 `App` 里 `if` 完再往下写），是**钩子规则**：
 * `ReaderApp` 里那十来个 hook 一个都不能少跑，条件返回会让它们时有时无。
 * 拆开之后每条分支各自完整，React 也就能在切换时干净地卸载。
 *
 * 阅读器那部分（输入态 → 加载态 → 阅读态）的说明沿用了原来的注释 ——
 * 三条链在那里汇合：
 *   `useArticle`     抓取 + 提取 + 语言判定
 *   `useTranslation` 按块翻译、按 id 回填
 *   `usePreferences` 字号 / 模式 / 深浅色 / 目标语言
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
import { buildMarkdown, downloadText, suggestFileName } from './markdown';
import { StatsPage } from './pages/StatsPage';
import { usePathname } from './router';
import { targetLangLabel, type DisplayMode } from './types';
import { isHttpUrl } from './url';

export function App() {
  const path = usePathname();
  // 未知路径也落到阅读器上：这是个单页工具，用户手打错了地址时
  // 给他一个能用的页面，比一张"404 找不到页面"更合理
  return path === '/stats' ? <StatsPage /> : <ReaderApp />;
}

function ReaderApp() {
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

  /**
   * **实际生效**的显示模式。
   *
   * 和 `Reader` 内部那份是同一个判断：降级态下即便偏好存的是"双语对照"，
   * 屏幕上也只有原文。导出必须跟屏幕上看到的一致 ——
   * 否则一篇中文文章会导出一份写着"English → 简体中文"的双语文件。
   */
  const effectiveMode: DisplayMode = degraded ? 'src' : prefs.mode;

  const handleExport = useCallback(() => {
    if (!article) return;

    const { markdown, missing } = buildMarkdown({
      article,
      translations,
      mode: effectiveMode,
      targetLang: prefs.targetLang,
    });
    downloadText(markdown, suggestFileName(article));

    // 译文没齐时照样导 —— 不打断用户，但得说清楚少了什么
    if (missing > 0) {
      toast(`已导出 · ${missing} 段还没译出，已保留原文`);
    } else {
      toast('已导出 Markdown');
    }
  }, [article, translations, effectiveMode, prefs.targetLang, toast]);

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
        onExport={handleExport}
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
                {/* 地址条回答的是"这篇原文在哪"，让它可点是最自然的做法（技术方案 7.11）。
                    不是 http(s) 的串退回纯文本 —— 塞进 href 就是 XSS（见 url.ts）。 */}
                {isHttpUrl(article.finalUrl) ? (
                  <a
                    className="u"
                    href={article.finalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="在新标签页打开原文"
                  >
                    {article.finalUrl}
                  </a>
                ) : (
                  <span className="u">{article.finalUrl}</span>
                )}
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
