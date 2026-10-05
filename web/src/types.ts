/**
 * 前后端契约（技术方案 7.2）。
 *
 * **这个文件是契约的唯一落点**：后端接口一改，先改这里，TS 会在所有用到的地方报错。
 * 这就是上 TypeScript 最直接的收益 —— 原生 JS 下这类改动只能靠人工全局搜索。
 *
 * 来源对照：
 * - `Article` / `Block` / `BlockType` ← server/src/article/{article,extract}.service.ts
 * - `ErrorCode`                      ← server/src/common/errors.ts
 * - `TargetLang`                     ← 技术方案 §5.2（10 种，**不含 English**）
 */

// ============================================================================
// 正文块
// ============================================================================

export type BlockType =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'p'
  | 'ul'
  | 'ol'
  | 'blockquote'
  | 'pre'
  | 'img'
  | 'figcaption';

/**
 * 正文块。`id` 是稳定锚点 —— 左右对齐、译文回填、缓存命中三件事都靠它。
 */
export interface Block {
  id: number;
  type: BlockType;
  /** 单文本块（标题 / 段落 / 引用 / 图注） */
  text?: string;
  /** 列表项（`ul` / `ol`） */
  items?: string[];
  /** 图片地址（`img`），后端已补成绝对地址 */
  src?: string;
  /** 图片替代文本 */
  alt?: string;
  /** 代码块语言（`pre`） */
  lang?: string;
  /** 是否需要翻译。`pre` / `img` 恒为 false */
  translatable: boolean;
}

/** 实际生效的正文提取级别，用于文章头的来源标签 */
export type ExtractLevel = 'readability' | 'heuristic' | 'body';

// ============================================================================
// 文章
// ============================================================================

/** 对应后端 `ArticleResponse`（server/src/article/article.service.ts） */
export interface Article {
  /** 规范化后的输入地址 */
  url: string;
  /** 跟随重定向后的最终地址 */
  finalUrl: string;
  title: string;
  byline: string;
  siteName: string;
  /**
   * 页面主语言（BCP 47）。
   * 注意它和 `targetLang` 完全是两码事 —— 见下面 `Lang` 的说明。
   */
  lang: string;
  /** `lang === 'en'` 的等值表达，前端直接用，避免在客户端写死字符串比较 */
  isEnglish: boolean;
  extractLevel: ExtractLevel;
  truncated: boolean;
  blocks: Block[];
}

// ============================================================================
// 两种"语言" —— 容易混，分开定义（技术方案 7.3）
// ============================================================================

/**
 * **页面**的语言：后端判定的一次抓取产物，会话级，**不持久化**。
 * 它是分叉开关：`en` → 双栏对照；其它 → 单栏原文降级。
 */
export type Lang = string;

/**
 * 用户选的**译文语言**：跨会话的偏好，**要持久化**。
 * 中文读者就一直是中文读者，不该每次重选。列表里没有 `en`（源语言固定英文）。
 */
export type TargetLang =
  | 'zh-Hans'
  | 'zh-Hant'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'de'
  | 'es'
  | 'pt'
  | 'it'
  | 'ru';

export const TARGET_LANGS: ReadonlyArray<{ value: TargetLang; label: string }> = [
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'zh-Hant', label: '繁體中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'pt', label: 'Português' },
  { value: 'it', label: 'Italiano' },
  { value: 'ru', label: 'Русский' },
];

/**
 * 语言标签 → 人类可读名。
 * 用途是显示（"检测到 日本語 · 未翻译"），不参与判定逻辑。
 */
export const LANG_LABELS: Record<string, string> = {
  en: 'English',
  ...Object.fromEntries(TARGET_LANGS.map((l) => [l.value, l.label])),
  unknown: '未知语言',
};

export function langLabel(lang: Lang): string {
  return LANG_LABELS[lang] ?? lang;
}

export function targetLangLabel(lang: TargetLang): string {
  return LANG_LABELS[lang] ?? lang;
}

// ============================================================================
// 偏好
// ============================================================================

/** 显示模式：双语对照 / 仅译文 / 仅原文 */
export type DisplayMode = 'both' | 'dst' | 'src';

export type Theme = 'light' | 'dark';

export interface Preferences {
  /** 正文字号（px），映射到根节点的 `--reading-font-size` */
  fontSize: number;
  mode: DisplayMode;
  theme: Theme;
  targetLang: TargetLang;
}

export const FONT_SIZE_MIN = 13;
export const FONT_SIZE_MAX = 24;

// ============================================================================
// 错误
// ============================================================================

/** 与 server/src/common/errors.ts 的 `ErrorCode` 保持一致 */
export type ErrorCode =
  // ---- 抓取侧 ----
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'dns_failed'
  | 'blocked_target'
  | 'timeout'
  | 'blocked_by_site'
  | 'not_html'
  | 'size_limit'
  | 'too_many_redirects'
  | 'js_rendered'
  | 'extract_failed'
  | 'upstream_error'
  // ---- 翻译侧 ----
  | 'source_not_english'
  // ---- 兜底 ----
  | 'internal_error';

/** 后端统一的错误响应体 */
export interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
  };
}

/** 提取级别的展示文案 */
export const EXTRACT_LEVEL_LABELS: Record<ExtractLevel, string> = {
  readability: 'Readability 提取',
  heuristic: '启发式提取',
  body: '整页提取',
};
