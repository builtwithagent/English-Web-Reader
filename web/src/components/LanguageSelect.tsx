/**
 * 目标语言选择器（技术方案 7.2）。
 *
 * 放在顶栏而不是输入框旁边：读完随时能换语言重译，不必回到首页。
 * `EN →` 前缀是垂直定位的体现 —— 源语言锁死英文，不可选。
 *
 * **为什么不用原生 `<select>`**：它展开的那个列表由**操作系统**绘制，CSS 一行都够不着 ——
 * 在 Windows 上就是灰底细框 + 系统蓝高亮，跟整套配色完全打架。
 * 所以自己做：一个按钮 + 一块浮层，颜色全走主题变量，深浅色自动跟随。
 *
 * 无障碍上做了一个取舍：浮层常驻 DOM、用 `display` 控制显隐，
 * 选项是原生 `<button>` —— 于是 Tab / Enter / Esc 这些**浏览器原生行为**直接可用，
 * 不必手写 `activeIndex` 那套 listbox 键盘导航。十来个选项的列表里，
 * Tab 的体验和 ↑↓ 没有实质差别。
 */

import { useEffect, useRef, useState } from 'react';
import { TARGET_LANGS, targetLangLabel, type TargetLang } from '../types';

interface LanguageSelectProps {
  value: TargetLang;
  onChange(value: TargetLang): void;
}

export function LanguageSelect({ value, onChange }: LanguageSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 点别处 / 按 Esc 收起。
  // 用 `mousedown` 而不是 `click`：click 要等鼠标松开才触发，
  // 点在旁边按钮上时会有"那一下被浮层吃掉、按钮像没反应"的观感。
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choose = (lang: TargetLang): void => {
    setOpen(false);
    triggerRef.current?.focus();
    // 选了同一个语言就不回调 —— 否则会白白触发一次整篇重译
    if (lang !== value) onChange(lang);
  };

  return (
    <div
      className={`lang-pair${open ? ' open' : ''}`}
      ref={rootRef}
      title="源语言固定英文，可选择译文语言"
    >
      <b>EN</b>
      <i>→</i>

      <button
        type="button"
        ref={triggerRef}
        className="lang-trigger"
        // 自动化（web/scripts/shot.mjs）与偏好用例靠它读当前值，
        // 别再回到"从 select.value 里捞"那种写法
        data-value={value}
        aria-label="译文语言"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {targetLangLabel(value)}
      </button>

      <span className="caret" aria-hidden="true">
        ▾
      </span>

      <div className={`lang-menu${open ? ' open' : ''}`} role="listbox" aria-label="译文语言">
        {TARGET_LANGS.map((lang) => (
          <button
            key={lang.value}
            type="button"
            role="option"
            aria-selected={lang.value === value}
            data-value={lang.value}
            className={`lang-option${lang.value === value ? ' on' : ''}`}
            onClick={() => choose(lang.value)}
          >
            {lang.label}
          </button>
        ))}
      </div>
    </div>
  );
}
