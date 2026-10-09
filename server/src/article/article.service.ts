import { Inject, Injectable, Logger } from '@nestjs/common';
import { FetchService } from './fetch.service';
import { ExtractService, type Block } from './extract.service';
import { ARTICLE_LIMITS, articleLimitError } from './article.limits';
import { normalizeUrl } from '../common/url';
import { detectPageLang } from '../common/lang';
import { AppError } from '../common/errors';
import type { RateLimiter } from '../common/rate-limit';
import { StatsService } from '../stats/stats.service';
import { urlKey } from '../stats/stats.types';

/**
 * 文章服务：编排"校验 → 抓取 → 提取 → 语言判定"这条链（技术方案 3·请求时序）。
 *
 * 这一层刻意只做编排，把三件事各自下沉：
 * - 网络与安全 → FetchService
 * - DOM 与正文 → ExtractService
 * - 语言分叉   → detectPageLang
 */

export interface ArticleResponse {
  /** 用户原始输入规范化后的地址 */
  url: string;
  /** 跟随重定向后的最终地址 */
  finalUrl: string;
  title: string;
  byline: string;
  siteName: string;
  /** 页面主语言（BCP 47）。非 `en` 即表示前端应走单栏降级 */
  lang: string;
  /** `lang === 'en'` 的等值表达，前端直接用，避免在客户端写死字符串比较 */
  isEnglish: boolean;
  /** 实际生效的提取级别，用于上线后观察提取质量分布 */
  extractLevel: string;
  /** 正文是否被截断（当前版本不截断，保留字段以稳定契约） */
  truncated: boolean;
  blocks: Block[];
}

@Injectable()
export class ArticleService {
  private readonly logger = new Logger(ArticleService.name);

  constructor(
    private readonly fetchService: FetchService,
    private readonly extractService: ExtractService,
    private readonly stats: StatsService,
    // token 注入（理由见 article.limits.ts 与 translate.module.ts 的同名说明）
    @Inject(ARTICLE_LIMITS) private readonly limits: RateLimiter,
  ) {}

  async getArticle(rawUrl: string, ip: string): Promise<ArticleResponse> {
    // 打点要覆盖**失败**，所以整条链都圈进来 —— 包括 normalizeUrl 自己抛的
    // `invalid_url`（那是"用户输入有问题"里最常见的一类，不记就看不出来）
    //
    // 记的是**完整 URL**而不是域名：看板上要能一眼看出"是哪一篇挂了"。
    // `urlKey` 负责去 fragment、截断；归一化失败时退化成用户原始输入
    // （失败明细里看到"用户到底输了什么"比看到空白有用）
    let trackedUrl = urlKey(rawUrl);
    try {
      // 额度闸门放在**最前面**（对外发任何请求之前），而且放在 try 里面 ——
      // 被它拦下的请求会走下面的 catch，记成一条 `too_many_requests` 的失败明细，
      // 于是看板上能看到"闸门拦了多少次、拦的是谁"。
      //
      // 每次抓取记 1 个单位：一次抓取就是一次对外 HTTP 请求。
      //
      // 注意这里**没有配套的 refund**（翻译那边有）。理由是"退款条件"必须
      // 不是调用方能控制的：翻译的退款只发生在整体故障，那是我们的 bug；
      // 而抓取失败完全由用户输入的 URL 决定 —— 退款等于说"只要每次都输一个
      // 抓不到的地址，就永远不扣额度"，把闸门直接送掉了。
      const quota = this.limits.take(ip, 1);
      if (!quota.ok) {
        throw articleLimitError(quota.reason, this.limits.spec, quota.retryAfterSec);
      }

      const url = normalizeUrl(rawUrl);
      trackedUrl = urlKey(url.href);
      this.logger.log(`抓取 ${url.host}${url.pathname}`);

      const fetched = await this.fetchService.fetchHtml(url);
      const extracted = this.extractService.extract(fetched.html, fetched.finalUrl);

      // 语言判定用的是"人能读到的正文"，所以：
      // 1. 只取可翻译块（代码块、图片天然排除在外）；
      //    技术文章里代码占比可能过半，混进去会把统计整个带偏（技术方案 4.7）。
      // 2. 列表块取 items 拼起来的文本。
      const textForDetection = extracted.blocks
        .filter((block) => block.translatable)
        .map((block) => block.text ?? (block.items ?? []).join(' '))
        .join('\n');

      const verdict = detectPageLang(textForDetection, extracted.htmlLang);

      this.logger.log(
        `提取完成 level=${extracted.extractLevel} blocks=${extracted.blocks.length} ` +
          `lang=${verdict.lang} (latin=${verdict.latinRatio.toFixed(2)} cjk=${verdict.cjkRatio.toFixed(2)})`,
      );

      this.stats.recordArticle({ url: trackedUrl, ok: true });

      return {
        url: url.toString(),
        finalUrl: fetched.finalUrl,
        title: extracted.title,
        byline: extracted.byline,
        siteName: extracted.siteName,
        lang: verdict.lang,
        isEnglish: verdict.isEnglish,
        extractLevel: extracted.extractLevel,
        truncated: false,
        blocks: extracted.blocks,
      };
    } catch (err) {
      this.stats.recordArticle({
        url: trackedUrl,
        ok: false,
        errorCode: err instanceof AppError ? err.code : 'internal_error',
      });
      throw err;
    }
  }
}
