import { describe, expect, it } from 'vitest';
import { MIN_SAMPLE_CHARS, detectPageLang } from '../src/common/lang';

/**
 * 语言判定的单测。
 *
 * 这个函数是**产品垂直定位的唯一分叉开关**：判成英文走双栏翻译，判成非英文
 * 就降级成单栏原文、一个上游请求都不发。它判错的代价是双向的 ——
 * 误判成英文会白烧额度翻一篇不该翻的文章，误判成非英文会让用户拿不到译文。
 * 所以这里把每条分支都钉死。
 */

/** 够长的英文正文（拉丁字母数远超 MIN_SAMPLE_CHARS） */
const EN_TEXT =
  'Readability turns a page of markup into the text a human would actually read, ' +
  'dropping navigation, advertising and sidebars along the way. It is used by the ' +
  'reader mode of a well known browser.';

/** 中文正文：全部字符都是汉字，CJK 占比 1.0 */
const ZH_TEXT = '这是一段中文正文，用来验证语言判定的字符脚本统计是否正确。'.repeat(4);

/** 日文正文：含平假名与片假名 —— 出现假名即判日语，这是最可靠的一条 */
const JA_TEXT = 'これは日本語の本文です。ひらがなとカタカナが含まれています。'.repeat(4);

/** 韩文正文：只有谚文，不含汉字 */
const KO_TEXT = '이것은 한국어로 쓰인 본문입니다. 언어 판정을 확인하기 위한 문장입니다.'.repeat(3);

describe('detectPageLang：样本充足时以正文字符构成为准', () => {
  it('纯英文 → en，isEnglish 为 true', () => {
    const v = detectPageLang(EN_TEXT);
    expect(v.lang).toBe('en');
    expect(v.isEnglish).toBe(true);
    expect(v.latinRatio).toBe(1);
    expect(v.cjkRatio).toBe(0);
    expect(v.sampleChars).toBeGreaterThanOrEqual(MIN_SAMPLE_CHARS);
  });

  it('纯中文 → zh-Hans', () => {
    const v = detectPageLang(ZH_TEXT);
    expect(v.lang).toBe('zh-Hans');
    expect(v.isEnglish).toBe(false);
    expect(v.cjkRatio).toBe(1);
  });

  it('含假名 → ja（中文正文里不会出现假名，这条判断最可靠）', () => {
    expect(detectPageLang(JA_TEXT).lang).toBe('ja');
  });

  it('含谚文 → ko', () => {
    expect(detectPageLang(KO_TEXT).lang).toBe('ko');
  });

  it('中英混排且中文成规模 → zh-Hans（不能当英文页硬翻）', () => {
    // 汉字 4 份，拉丁字母 1 份，CJK 占比远高于 0.15 的阈值
    const v = detectPageLang(`${ZH_TEXT} ${EN_TEXT}`);
    expect(v.cjkRatio).toBeGreaterThan(0.15);
    expect(v.lang).toBe('zh-Hans');
  });

  it('英文里夹了几个汉字 → 仍判 en（阈值以下不算混排）', () => {
    const v = detectPageLang(`${EN_TEXT} 中文`);
    expect(v.cjkRatio).toBeLessThan(0.15);
    expect(v.lang).toBe('en');
  });

  it('样本充足时**不采信** <html lang>：正文说了算', () => {
    // 一个把 lang 错标成中文的英文页面，必须仍然判成英文
    expect(detectPageLang(EN_TEXT, 'zh-CN').lang).toBe('en');
    // 反过来同理：错标成英文的中文页面不能被放行
    expect(detectPageLang(ZH_TEXT, 'en').lang).toBe('zh-Hans');
  });

  it('isEnglish 恒等于 lang === "en"（前端只认 isEnglish，两者不能脱钩）', () => {
    for (const text of [EN_TEXT, ZH_TEXT, JA_TEXT, KO_TEXT, '']) {
      const v = detectPageLang(text);
      expect(v.isEnglish).toBe(v.lang === 'en');
    }
  });

  it('只统计"字"：数字、标点、空白不参与', () => {
    const v = detectPageLang('12345 67890 !!! --- ??? 你好');
    // 只有 2 个汉字进入统计
    expect(v.sampleChars).toBe(2);
    expect(v.lang).toBe('unknown');
  });

  it('样本截断在 20000 字符以内（长文不做全量扫描）', () => {
    const head = 'a'.repeat(20_000);
    const v = detectPageLang(`${head}${'中'.repeat(5_000)}`);
    // 后面的中文没进样本，所以仍判成英文
    expect(v.sampleChars).toBe(20_000);
    expect(v.lang).toBe('en');
  });
});

describe('detectPageLang：样本不足时降级用 HTML lang 兜底', () => {
  it('样本不足 + 没有 lang 属性 → unknown，且按非英文处理', () => {
    const v = detectPageLang('Hi');
    expect(v.lang).toBe('unknown');
    expect(v.isEnglish).toBe(false);
    expect(v.sampleChars).toBeLessThan(MIN_SAMPLE_CHARS);
  });

  it('样本不足 + lang=en-US → en', () => {
    const v = detectPageLang('Hi there', 'en-US');
    expect(v.lang).toBe('en');
    expect(v.isEnglish).toBe(true);
  });

  it('语言标签大小写与空格都能容忍', () => {
    expect(detectPageLang('Hi', '  EN-GB  ').lang).toBe('en');
  });

  it('lang=zh-TW / zh-HK → zh-Hant，其余 zh-* → zh-Hans', () => {
    expect(detectPageLang('Hi', 'zh-TW').lang).toBe('zh-Hant');
    expect(detectPageLang('Hi', 'zh-HK').lang).toBe('zh-Hant');
    expect(detectPageLang('Hi', 'zh-Hans-CN').lang).toBe('zh-Hans');
    expect(detectPageLang('Hi', 'zh').lang).toBe('zh-Hans');
  });

  it('lang=ja / ko 也能兜底', () => {
    expect(detectPageLang('Hi', 'ja-JP').lang).toBe('ja');
    expect(detectPageLang('Hi', 'ko-KR').lang).toBe('ko');
  });

  it('不认识的语种标签**不采信**（不猜，回落成 unknown）', () => {
    // 它们本来也是"非英文"，具体标签不重要
    expect(detectPageLang('Hi', 'fr-FR').lang).toBe('unknown');
    expect(detectPageLang('Hi', 'de').lang).toBe('unknown');
    expect(detectPageLang('Hi', '').lang).toBe('unknown');
    expect(detectPageLang('Hi', null).lang).toBe('unknown');
  });
});

describe('detectPageLang：已知的能力边界（写成测试，免得以后被当成 bug）', () => {
  it('其它拉丁语系页面会被判成 en —— 这是刻意的取舍', () => {
    // 本产品的用户是"中文读者读英文网页"，把法语页面一并走翻译流程，
    // 比漏判更符合预期。要精确区分得引入语种识别库，收益抵不上依赖成本。
    const FR_TEXT =
      'Ceci est un texte redige en francais avec quelques accents et beaucoup de mots, ' +
      'afin de depasser largement le seuil minimal de caracteres necessaire a la detection.';
    expect(detectPageLang(FR_TEXT).lang).toBe('en');
  });

  it('简繁不区分：繁体中文也归到 zh-Hans', () => {
    // 两者都属于"非英文"，降级行为一致，不影响功能
    const TRAD = '這是一段繁體中文正文，用來驗證語言判定的字符腳本統計是否正確。'.repeat(4);
    expect(detectPageLang(TRAD).lang).toBe('zh-Hans');
  });
});
