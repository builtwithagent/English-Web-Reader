/**
 * 目标语言选择器（技术方案 7.2）。
 *
 * 放在顶栏而不是输入框旁边：读完随时能换语言重译，不必回到首页。
 * `EN →` 前缀是垂直定位的体现 —— 源语言锁死英文，不可选。
 */

import { TARGET_LANGS, type TargetLang } from '../types';

interface LanguageSelectProps {
  value: TargetLang;
  onChange(value: TargetLang): void;
}

export function LanguageSelect({ value, onChange }: LanguageSelectProps) {
  return (
    <label className="lang-pair" title="源语言固定英文，可选择译文语言">
      <b>EN</b>
      <i>→</i>
      <select
        value={value}
        aria-label="译文语言"
        onChange={(e) => onChange(e.target.value as TargetLang)}
      >
        {TARGET_LANGS.map((lang) => (
          <option key={lang.value} value={lang.value}>
            {lang.label}
          </option>
        ))}
      </select>
      <span className="caret">▾</span>
    </label>
  );
}
