/**
 * 顶层：输入态 → 加载态 → 阅读态，把各层 Hook 串起来（技术方案 7.2）。
 *
 * 语言分叉点收在这一层：`article.isEnglish` 决定双栏还是单栏，
 * 往下传的就只有"要不要渲染译文列"这一个布尔值。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Topbar } from './components/Topbar';
import { UrlInput } from './components/UrlInput';
import { Toolbar } from './components/Toolbar';
import { LangNotice } from './components/LangNotice';
import { Reader } from './components/Reader';
import { ErrorBanner } from './components/ErrorBanner';
import { Skeleton } from './components/Skeleton';
import { ToastStack, type ToastItem } from './components/ToastStack';
import { useArticle } from './hooks/useArticle';
import { usePreferencesApi } from './hooks/usePreferences';

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

  return (
    <>
      <Topbar
        targetLang={prefs.targetLang}
        onTargetLangChange={(v) => {
          setTargetLang(v);
          toast('译文语言已切换，重新翻译后生效');
        }}
        theme={prefs.theme}
        onToggleTheme={toggleTheme}
        onToggleFavorite={() => toast('收藏需要登录 · 点击进入登录')}
        onExport={() => toast('导出将在接入翻译后提供')}
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
              status={<span className="status">{degraded ? '未翻译' : '待翻译'}</span>}
            />

            {degraded ? (
              <LangNotice
                lang={article.lang}
                onForceTranslate={() => {
                  setForceTranslate(true);
                  toast('已放行本次翻译（翻译接入后生效）');
                }}
              />
            ) : null}
          </div>

          <Reader
            article={article}
            targetLang={prefs.targetLang}
            mode={prefs.mode}
            forceTranslate={forceTranslate}
          />
        </>
      ) : null}

      <ToastStack items={toasts} />
    </>
  );
}
