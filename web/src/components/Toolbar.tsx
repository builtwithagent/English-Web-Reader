/**
 * 阅读态控制条（技术方案 7.2）。
 *
 * 纯展示组件，动作全靠 props 上抛。三种模式里"仅译文"需要译文存在才有意义，
 * 降级态则由上层把整个切换器藏掉（7.5）。
 */

import type { ReactNode } from 'react';
import type { DisplayMode } from '../types';

const MODES: ReadonlyArray<{ value: DisplayMode; label: string }> = [
  { value: 'both', label: '双语对照' },
  { value: 'dst', label: '仅译文' },
  { value: 'src', label: '仅原文' },
];

interface ToolbarProps {
  mode: DisplayMode;
  onModeChange(value: DisplayMode): void;
  fontSize: number;
  onFontBump(delta: number): void;
  /** 非英文页面没有第二种形态，切换器整个不渲染 */
  showModeSwitch: boolean;
  /** 右侧状态区（翻译进度 / 未翻译说明） */
  status?: ReactNode;
}

export function Toolbar({
  mode,
  onModeChange,
  fontSize,
  onFontBump,
  showModeSwitch,
  status,
}: ToolbarProps) {
  return (
    <div className="controls">
      {showModeSwitch ? (
        <div className="segmented mode-seg">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={mode === m.value ? 'on' : undefined}
              onClick={() => onModeChange(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="zs-group">
        <button
          type="button"
          className="btn icon"
          title="缩小字号"
          onClick={() => onFontBump(-1)}
        >
          A-
        </button>
        <span className="zs-val">{fontSize}</span>
        <button
          type="button"
          className="btn icon"
          title="放大字号"
          onClick={() => onFontBump(1)}
        >
          A+
        </button>
      </div>

      {status ? <div className="right">{status}</div> : null}
    </div>
  );
}
