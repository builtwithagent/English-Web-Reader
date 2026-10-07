import { describe, expect, it } from 'vitest';
import { EXTRACT_LEVEL_LABELS, TARGET_LANGS, langLabel, targetLangLabel } from './types';

/**
 * 展示用的语言标签与文案。
 *
 * 注意这里**不包含**与后端的契约对照（错误码清单、目标语言清单）——
 * 那个检查需要读文件，而 web 的 tsconfig 是纯浏览器环境、没有 node 类型。
 * 它放在 `server/test/contract.test.ts` 里，从后端侧读这边的源码来对。
 */

describe('语言标签展示', () => {
  it('每种目标语言都能查到标签', () => {
    for (const lang of TARGET_LANGS) {
      expect(langLabel(lang.value)).toBe(lang.label);
      expect(targetLangLabel(lang.value)).toBe(lang.label);
    }
  });

  it('列表本身：10 项、取值唯一、每项都有标签', () => {
    expect(TARGET_LANGS).toHaveLength(10);
    expect(new Set(TARGET_LANGS.map((lang) => lang.value)).size).toBe(10);
    for (const lang of TARGET_LANGS) {
      expect(lang.label.trim().length, `${lang.value} 缺少标签`).toBeGreaterThan(0);
    }
  });

  it('**不含 English** —— 源语言固定英文，选英文等于不翻译', () => {
    expect(TARGET_LANGS.map((lang) => lang.value)).not.toContain('en');
    expect(TARGET_LANGS.map((lang) => lang.label)).not.toContain('English');
  });

  it('默认语言（列表第一项）是简体中文', () => {
    // 后端 `DEFAULT_TARGET_LANG` 也是 zh-Hans，两边的默认值必须一致，
    // 否则首次打开时下拉框显示的语言和实际请求的语言会对不上
    expect(TARGET_LANGS[0].value).toBe('zh-Hans');
    expect(TARGET_LANGS[0].label).toBe('简体中文');
  });

  it('en 与 unknown 也有标签（降级态与兜底态都要显示）', () => {
    expect(langLabel('en')).toBe('English');
    expect(langLabel('unknown')).toBe('未知语言');
  });

  it('查不到的标签原样返回，不显示成 undefined', () => {
    // 后端将来新增一个语种时，界面至少还能把标签本身显示出来
    expect(langLabel('th')).toBe('th');
    expect(langLabel('')).toBe('');
  });
});

describe('提取级别的展示文案', () => {
  it('三级都有对应的中文标签', () => {
    expect(EXTRACT_LEVEL_LABELS.readability).toBeTruthy();
    expect(EXTRACT_LEVEL_LABELS.heuristic).toBeTruthy();
    expect(EXTRACT_LEVEL_LABELS.body).toBeTruthy();
    expect(Object.keys(EXTRACT_LEVEL_LABELS).sort()).toEqual(['body', 'heuristic', 'readability']);
  });
});
