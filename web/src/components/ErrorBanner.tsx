/**
 * 错误展示（技术方案 7.2）。
 *
 * 后端的错误码都带一句"给用户的话"和一个可操作的建议，这里原样呈现。
 * 另外把 `code` 也低调地显示出来 —— 自己排查问题时不至于只能看截图猜。
 */

import type { ApiError } from '../api';

interface ErrorBannerProps {
  error: ApiError;
}

export function ErrorBanner({ error }: ErrorBannerProps) {
  return (
    <div className="error-banner" role="alert">
      <div className="box">
        <span className="ic">!</span>
        <div>
          <div className="title">{error.message}</div>
          {error.hint ? <div className="hint">{error.hint}</div> : null}
          <div className="code">{error.code}</div>
        </div>
      </div>
    </div>
  );
}
