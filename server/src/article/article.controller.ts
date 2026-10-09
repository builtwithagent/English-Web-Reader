import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { clientIp } from '../common/ip';
import { ArticleService, type ArticleResponse } from './article.service';

@Controller('article')
export class ArticleController {
  constructor(private readonly articleService: ArticleService) {}

  /**
   * GET /api/article?url=<encodeURIComponent(url)>
   *
   * 失败时不返回半截内容，而是给出归一化的错误码（技术方案 4.6 的关键原则）。
   *
   * IP 是取来给**额度闸门**用的（见 article.limits.ts），不参与抓取判定 ——
   * 抓什么由 URL 决定，与谁在请求无关；而且 `X-Forwarded-For` 可伪造，
   * 拿它做安全边界是错的（SSRF 那道门看的是解析出来的目标 IP）。
   */
  @Get()
  getArticle(@Query('url') url: string | undefined, @Req() req: Request): Promise<ArticleResponse> {
    return this.articleService.getArticle(url ?? '', clientIp(req));
  }
}
