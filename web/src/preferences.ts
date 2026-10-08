/**
 * 偏好的持久化与校验（技术方案 7.3、7.6）。
 *
 * 从 `hooks/usePreferences.tsx` 里拆出来，是因为这两件事的**失败形态完全不同**：
 * React 那边管的是"状态怎么流"，这里管的是"存进去的东西还能不能信"。
 * 后者全是纯函数，出错时最难排查（用户打开页面发现字号不对，但没人会想到是
 * localStorage 里留了个旧版本的值），所以单独成文件、单独测。
 *
 * 一条硬规矩：**读回来的每个字段都要逐项校验**，不能 `{...DEFAULTS, ...parsed}` 了事。
 * localStorage 里可能有上一个版本写进去的值，直接采纳会让界面进入
 * "显示空白但逻辑照跑"的状态（`targetLang: 'en'` 就是这么踩过的）。
 */

import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  TARGET_LANGS,
  type DisplayMode,
  type Preferences,
  type TargetLang,
  type Theme,
} from './types';

export const STORAGE_KEY = 'ewr_preferences';

export const DEFAULT_PREFERENCES: Preferences = {
  fontSize: 17,
  mode: 'both',
  theme: 'light',
  targetLang: 'zh-Hans',
};

/** 系统深浅色偏好 —— 用户没手动选过时跟随它（PRD 里的"深浅色跟随"） */
export function systemTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function loadPreferences(): Preferences {
  const fallback: Preferences = { ...DEFAULT_PREFERENCES, theme: systemTheme() };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    // 逐字段校验后再合并：localStorage 里可能是旧版本残留的脏数据
    return {
      fontSize: clampFontSize(parsed.fontSize ?? fallback.fontSize),
      mode: isDisplayMode(parsed.mode) ? parsed.mode : fallback.mode,
      theme: parsed.theme === 'dark' || parsed.theme === 'light' ? parsed.theme : fallback.theme,
      targetLang: isTargetLang(parsed.targetLang) ? parsed.targetLang : fallback.targetLang,
    };
  } catch {
    // 隐私模式 / 配额满 / JSON 损坏 —— 一律退回默认值，不让偏好把应用卡死
    return fallback;
  }
}

export function savePreferences(prefs: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 存不进去就算了，不影响本次使用
  }
}

/**
 * 字号夹到 [13, 24] 之间。
 *
 * `Number.isFinite` 那一步不是多余的：`Math.round('huge')` 得到 `NaN`，
 * 而 `NaN` 会**穿过** `Math.min` / `Math.max`（它们遇到 NaN 就返回 NaN），
 * 最后把 `--reading-font-size` 写成 `NaNpx` —— CSS 变量无效，
 * 于是字号静默退回浏览器默认值。用户只会觉得"我的字号设置没生效"，
 * 完全想不到是 localStorage 里留了个非数字的值。写单测时撞出来的。
 */
export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PREFERENCES.fontSize;
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(n)));
}

export function isDisplayMode(v: unknown): v is DisplayMode {
  return v === 'both' || v === 'dst' || v === 'src';
}

/**
 * 目标语言的合法性校验。
 *
 * 别省这一步：localStorage 里可能留着旧版本写的值（比如列表改版前存在的 `en`）。
 * 直接采纳的话，选择器会顶着一个**列表里根本没有**的语言名，选中态也无处安放 ——
 * 而请求照样发出去，用户看到的是"选择器写着 English，右边却在出中文"。
 * 后端有 `normalizeTargetLang` 兜底，前端也得自己兜住。
 */
export function isTargetLang(v: unknown): v is TargetLang {
  return typeof v === 'string' && TARGET_LANGS.some((lang) => lang.value === v);
}
