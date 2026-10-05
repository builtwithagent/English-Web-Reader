/**
 * 页面主语言判定（技术方案 4.7）。
 *
 * 这是产品垂直定位落到代码上的**唯一分叉开关**：
 *   英文 → 双栏对照翻译；非英文 → 单栏原文降级、不翻译。
 *
 * 判定依据的优先级：
 *   1. **正文文本的字符脚本统计**（事实来源）
 *   2. HTML `lang` / `og:locale`（仅作辅助，只在正文样本不足时兜底）
 *   3. 都拿不到 → 按"非英文"处理（宁可降级，不白花上游调用的钱）
 *
 * 为什么不信 `<html lang>`：错标、留空、写成 `en-US` 却整页中文的情况非常常见。
 * 正文实际由什么字符构成，才是事实。
 */

/** 判定为正文字符的脚本正则 */
const RE_LATIN = /[A-Za-z]/g;
/** 汉字（含扩展 A） */
const RE_HAN = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
/** 平假名 + 片假名 —— 出现即说明是日语（中文里不会用到） */
const RE_KANA = /[\u3040-\u30ff]/g;
/** 谚文（韩语） */
const RE_HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/g;

/**
 * CJK 占比阈值：超过它就直接判为非英文。
 * 这是最关键的一条 —— 中英混排页面里只要中文成规模，它就不是"英文页面"，
 * 硬翻会得到一篇半中半英的怪物。
 */
const CJK_RATIO_THRESHOLD = 0.15;

/**
 * 有效字符数下限。正文太短（提取失败、SPA 空壳）时统计不可信，
 * 此时才允许拿 `<html lang>` 兜底。
 */
const MIN_SAMPLE_CHARS = 80;

/** 只取正文开头这么多字符做统计 —— 够判定了，也避免长文全量扫描 */
const SAMPLE_LIMIT = 20000;

export interface LangVerdict {
  /**
   * BCP 47 语言标签。
   * 能识别出具体语言时给具体值（`en` / `ja` / `ko` / `zh-Hans`），
   * 判不出来时给 `unknown` —— 它同样会被当作"非英文"。
   */
  lang: string;
  /** 是否英文页面 —— 前端据此决定双栏还是单栏 */
  isEnglish: boolean;
  /** 拉丁字母占比（0~1），用于排查误判 */
  latinRatio: number;
  /** CJK 占比（0~1），用于排查误判 */
  cjkRatio: number;
  /** 参与统计的字符数，用于排查误判 */
  sampleChars: number;
}

/**
 * 判定一段正文的主语言。
 *
 * @param text        提取后的**正文文本**（不是整页 HTML）。
 *                    调用方必须先把代码块排除掉 —— 技术文章里代码占比可能超过一半，
 *                    会把统计结果整个带偏。
 * @param htmlLangRaw 可选的 `<html lang>` 或 `og:locale`，只在样本不足时兜底
 */
export function detectPageLang(text: string, htmlLangRaw?: string | null): LangVerdict {
  // 只统计"字"：数字、标点、空白全部忽略，它们不携带语言信息
  const sample = text.slice(0, SAMPLE_LIMIT);

  const latin = (sample.match(RE_LATIN) ?? []).length;
  const han = (sample.match(RE_HAN) ?? []).length;
  const kana = (sample.match(RE_KANA) ?? []).length;
  const hangul = (sample.match(RE_HANGUL) ?? []).length;

  const cjk = han + kana + hangul;
  const total = latin + cjk;

  const latinRatio = total > 0 ? latin / total : 0;
  const cjkRatio = total > 0 ? cjk / total : 0;

  // ---- 样本太少：统计不可信，降级用 HTML lang 兜底 ----
  if (total < MIN_SAMPLE_CHARS) {
    const fromAttr = normalizeHtmlLang(htmlLangRaw);
    return {
      lang: fromAttr ?? 'unknown',
      isEnglish: fromAttr === 'en',
      latinRatio,
      cjkRatio,
      sampleChars: total,
    };
  }

  // ---- 样本充足：以正文字符构成为准 ----
  let lang: string;
  if (cjkRatio > CJK_RATIO_THRESHOLD) {
    // 有假名 → 日语（中文正文不会出现假名，这个判断很可靠）
    if (kana > 0) lang = 'ja';
    // 有谚文 → 韩语
    else if (hangul > 0) lang = 'ko';
    // 剩下按中文处理（简繁不做区分，代价是繁体会被判成 zh-Hans，
    // 但两者都属于"非英文"，降级行为一致，不影响功能）
    else lang = 'zh-Hans';
  } else {
    // 拉丁字母占绝对多数。
    //
    // 注意这里的能力边界：本条分支**不区分具体是哪种拉丁语系语言**，
    // 法语 / 德语 / 西班牙语页面同样会被判成 `en`。
    // 这是刻意的取舍 —— 本产品的用户是"中文读者读英文网页"，
    // 把其它拉丁语系页面一并走翻译流程，比漏判更符合预期；
    // 要精确区分需要引入语种识别库，而那时依赖成本换不来对应的收益。
    lang = 'en';
  }

  return { lang, isEnglish: lang === 'en', latinRatio, cjkRatio, sampleChars: total };
}

/** 把 `<html lang="...">` 归一成我们认识的标签；不认识就返回 null（不采信） */
function normalizeHtmlLang(raw?: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;

  if (v.startsWith('en')) return 'en';
  if (v.startsWith('ja')) return 'ja';
  if (v.startsWith('ko')) return 'ko';
  if (v.startsWith('zh-hant') || v.startsWith('zh-tw') || v.startsWith('zh-hk')) return 'zh-Hant';
  if (v.startsWith('zh')) return 'zh-Hans';
  // 其它语言一律不采信：它们都属于"非英文"，但具体标签不重要
  return null;
}
