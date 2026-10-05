/**
 * 非英文页面的降级说明条（技术方案 7.5）。
 *
 * 降级**不是报错** —— 页面本身没问题，只是不该翻译。所以用提示而不是错误样式。
 * 「仍要翻译」是误判兜底（4.7）：判定必然会有错的时候，留一条出路。
 */

import { langLabel } from '../types';

interface LangNoticeProps {
  /** 后端判定的页面语言 */
  lang: string;
  onForceTranslate(): void;
}

export function LangNotice({ lang, onForceTranslate }: LangNoticeProps) {
  return (
    <div className="notice">
      <div className="box">
        <span className="ic">!</span>
        <span>这不是英文网页（检测到 {langLabel(lang)}），仅显示原文</span>
        <button type="button" onClick={onForceTranslate}>
          仍要翻译
        </button>
      </div>
    </div>
  );
}
