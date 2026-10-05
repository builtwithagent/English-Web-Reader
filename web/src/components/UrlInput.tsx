/**
 * 网址输入（技术方案 7.2）。
 *
 * 首屏只有一行说明 + 输入框。说明文案里"公开的"同时点明了
 * "不能是需要登录态的网页"这个限制（PRD 3.1）。
 *
 * 规范化交给后端做，前端原样传 —— 保证前后端对同一个输入的判定完全一致。
 */

import { useState, type FormEvent } from 'react';

interface UrlInputProps {
  onSubmit(url: string): void;
  busy?: boolean;
}

export function UrlInput({ onSubmit, busy }: UrlInputProps) {
  const [value, setValue] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // 空输入也提交上去，由上层统一提示 —— 组件不做业务判断
    onSubmit(value.trim());
  }

  return (
    <section className="landing">
      <p className="sub">粘贴一个公开的英文网页链接</p>
      <form className="url-box" onSubmit={handleSubmit}>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="example.com/post  或  https://example.com/post"
          aria-label="网页链接"
          autoFocus
          spellCheck={false}
        />
        <button className="btn primary" type="submit" disabled={busy}>
          开始阅读
        </button>
      </form>
    </section>
  );
}
