/**
 * 顶栏：产品名 + 语言对 + 收藏 + 导出 + 深浅色。
 *
 * 产品名用**名词**（这是什么），首屏那句说明用**句子**（它能做什么）——
 * 两者分工不重复（命名原则）。
 */

import { LanguageSelect } from './LanguageSelect';
import type { TargetLang, Theme } from '../types';

interface TopbarProps {
  targetLang: TargetLang;
  onTargetLangChange(value: TargetLang): void;
  theme: Theme;
  onToggleTheme(): void;
  onToggleFavorite(): void;
  onExport(): void;
  /** 没读到文章时导出没有意义 */
  canExport: boolean;
}

export function Topbar({
  targetLang,
  onTargetLangChange,
  theme,
  onToggleTheme,
  onToggleFavorite,
  onExport,
  canExport,
}: TopbarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="mark">📖</span>
        <span>英文网页阅读器</span>
      </div>

      <div className="spacer" />

      <LanguageSelect value={targetLang} onChange={onTargetLangChange} />

      <button type="button" className="btn" onClick={onToggleFavorite}>
        ☆ 收藏
      </button>
      <button type="button" className="btn btn-export" onClick={onExport} disabled={!canExport}>
        导出
      </button>
      <button
        type="button"
        className="btn icon"
        title="深浅色"
        aria-label="切换深浅色"
        onClick={onToggleTheme}
      >
        {theme === 'light' ? '☾' : '☀'}
      </button>
    </header>
  );
}
