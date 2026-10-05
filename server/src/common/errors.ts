/**
 * 统一错误码。
 *
 * 设计要点（技术方案 4.6 / 5.6）：
 * - 抓取失败与翻译失败都归一成本文件的错误码，前端只认这一套；
 * - 错误码是**稳定契约**，文案可以改，code 不能随便改（前端按 code 做分支）；
 * - 上游（目标网站 / DeepSeek）的原始错误一律在后端消化，不往外抛。
 */
export type ErrorCode =
  // ---- 抓取侧（技术方案 4.6）----
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
  // ---- 翻译侧（技术方案 5.6）----
  | 'source_not_english'
  // ---- 兜底 ----
  | 'internal_error';

interface ErrorSpec {
  /** HTTP 状态码 */
  status: number;
  /** 给用户看的一句话 */
  message: string;
  /** 可选的补充建议 */
  hint?: string;
}

export const ERROR_SPEC: Record<ErrorCode, ErrorSpec> = {
  invalid_url: {
    status: 400,
    message: '这个链接不像网页地址',
    hint: '检查一下是不是少了一段，或者有拼错的字符',
  },
  unsupported_protocol: {
    status: 400,
    message: '暂不支持这种协议的链接',
    hint: '只支持 http:// 与 https:// 开头的网址',
  },
  dns_failed: {
    status: 502,
    message: '网址打不开，域名可能拼错了',
  },
  blocked_target: {
    status: 403,
    message: '这个地址不允许访问',
    hint: '出于安全考虑，只允许抓取公网地址',
  },
  timeout: {
    status: 504,
    message: '抓取超时，网站响应太慢',
    hint: '稍后再试，或换一个来源',
  },
  blocked_by_site: {
    status: 502,
    message: '目标网站拒绝了抓取',
    hint: '该站点可能有反爬保护，或需要登录才能阅读',
  },
  not_html: {
    status: 415,
    message: '这个链接不是网页',
    hint: '可能是 PDF、图片或文件下载地址',
  },
  size_limit: {
    status: 413,
    message: '页面太大了，超出处理上限',
  },
  too_many_redirects: {
    status: 502,
    message: '这个链接跳转次数太多，没能到达最终页面',
  },
  js_rendered: {
    status: 422,
    message: '页面内容靠脚本渲染，抓不到正文',
    hint: '这类单页应用首版不支持',
  },
  extract_failed: {
    status: 422,
    message: '没能识别出这个页面的正文',
  },
  upstream_error: {
    status: 502,
    message: '目标网站出错了，稍后再试',
  },
  source_not_english: {
    status: 422,
    message: '这不是英文网页，未做翻译',
  },
  internal_error: {
    status: 500,
    message: '服务器出了点问题，稍后再试',
  },
};

export interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
  };
}

/**
 * 业务异常。任何需要"按错误码返回"的地方都抛它。
 * 其它未捕获的异常由全局过滤器兜成 upstream_error。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  /** 覆盖默认 hint（用于同一个 code 在不同上下文给出更贴切的建议） */
  readonly hintOverride?: string;

  constructor(code: ErrorCode, hintOverride?: string) {
    super(ERROR_SPEC[code].message);
    this.name = 'AppError';
    this.code = code;
    this.hintOverride = hintOverride;
  }

  get status(): number {
    return ERROR_SPEC[this.code].status;
  }

  toPayload(): ErrorPayload {
    const spec = ERROR_SPEC[this.code];
    return {
      error: {
        code: this.code,
        message: spec.message,
        ...(this.hintOverride ?? spec.hint ? { hint: this.hintOverride ?? spec.hint } : {}),
      },
    };
  }
}
