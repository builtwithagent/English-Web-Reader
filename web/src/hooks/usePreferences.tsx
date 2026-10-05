/**
 * 偏好：字号 / 显示模式 / 深浅色 / 目标语言（技术方案 7.3、7.6）。
 *
 * 用 Context + useReducer，不引 Redux / Zustand —— 状态就四个字段，上状态库只会多出样板。
 *
 * 两条容易做错的地方：
 * 1. **`mode` 在降级态不写回**（7.5）。非英文页面下"仅原文"是渲染层的临时决定，
 *    不是用户偏好；写回去用户下次打开英文页面就会莫名只剩原文。
 *    这里用 `setMode` 的调用点保证（降级态下压根没有切换器），不做自动回写。
 * 2. 字号只改根节点上的 `--reading-font-size` 一个变量，两栏自动同步（7.6）。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  type DisplayMode,
  type Preferences,
  type TargetLang,
  type Theme,
} from '../types';

const STORAGE_KEY = 'ewr_preferences';

const DEFAULT_PREFERENCES: Preferences = {
  fontSize: 17,
  mode: 'both',
  theme: 'light',
  targetLang: 'zh-Hans',
};

// ============================================================================
// 持久化
// ============================================================================

/** 系统深浅色偏好 —— 用户没手动选过时跟随它（PRD 里的"深浅色跟随"） */
function systemTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function loadPreferences(): Preferences {
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
      targetLang: parsed.targetLang ?? fallback.targetLang,
    };
  } catch {
    // 隐私模式 / 配额满 / JSON 损坏 —— 一律退回默认值，不让偏好把应用卡死
    return fallback;
  }
}

function savePreferences(prefs: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 存不进去就算了，不影响本次使用
  }
}

function clampFontSize(n: number): number {
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(n)));
}

function isDisplayMode(v: unknown): v is DisplayMode {
  return v === 'both' || v === 'dst' || v === 'src';
}

// ============================================================================
// Reducer
// ============================================================================

type Action =
  | { type: 'setFontSize'; value: number }
  | { type: 'bumpFontSize'; delta: number }
  | { type: 'setMode'; value: DisplayMode }
  | { type: 'setTheme'; value: Theme }
  | { type: 'toggleTheme' }
  | { type: 'setTargetLang'; value: TargetLang };

function reducer(state: Preferences, action: Action): Preferences {
  switch (action.type) {
    case 'setFontSize':
      return { ...state, fontSize: clampFontSize(action.value) };
    case 'bumpFontSize':
      return { ...state, fontSize: clampFontSize(state.fontSize + action.delta) };
    case 'setMode':
      return { ...state, mode: action.value };
    case 'setTheme':
      return { ...state, theme: action.value };
    case 'toggleTheme':
      return { ...state, theme: state.theme === 'light' ? 'dark' : 'light' };
    case 'setTargetLang':
      return { ...state, targetLang: action.value };
  }
}

// ============================================================================
// Context
// ============================================================================

interface PreferencesApi {
  prefs: Preferences;
  setFontSize(value: number): void;
  bumpFontSize(delta: number): void;
  setMode(value: DisplayMode): void;
  setTheme(value: Theme): void;
  toggleTheme(): void;
  setTargetLang(value: TargetLang): void;
}

const PreferencesContext = createContext<PreferencesApi | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, dispatch] = useReducer(reducer, undefined, loadPreferences);

  // 落盘
  useEffect(() => {
    savePreferences(prefs);
  }, [prefs]);

  // 字号 → 根节点 CSS 变量（两栏共用同一个变量，改一处两栏同步）
  useEffect(() => {
    document.documentElement.style.setProperty('--reading-font-size', `${prefs.fontSize}px`);
  }, [prefs.fontSize]);

  // 深浅色 → 根节点 data-theme，样式表按属性选择器切换整组变量
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
  }, [prefs.theme]);

  const api = useMemo<PreferencesApi>(
    () => ({
      prefs,
      setFontSize: (value) => dispatch({ type: 'setFontSize', value }),
      bumpFontSize: (delta) => dispatch({ type: 'bumpFontSize', delta }),
      setMode: (value) => dispatch({ type: 'setMode', value }),
      setTheme: (value) => dispatch({ type: 'setTheme', value }),
      toggleTheme: () => dispatch({ type: 'toggleTheme' }),
      setTargetLang: (value) => dispatch({ type: 'setTargetLang', value }),
    }),
    [prefs],
  );

  return <PreferencesContext.Provider value={api}>{children}</PreferencesContext.Provider>;
}

export function usePreferencesApi(): PreferencesApi {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferencesApi 必须在 PreferencesProvider 内使用');
  return ctx;
}

/** 只取偏好值（大多数组件只关心这个，不关心 setter） */
export function usePreferences(): Preferences {
  return usePreferencesApi().prefs;
}

/** 单独取目标语言 —— LanguageSelect 与文章头的语言对标签常用 */
export function useTargetLang(): [TargetLang, (v: TargetLang) => void] {
  const api = usePreferencesApi();
  const set = useCallback((v: TargetLang) => api.setTargetLang(v), [api]);
  return [api.prefs.targetLang, set];
}
