import { Controller, Get, Query } from '@nestjs/common';
import { ArticleService, type ArticleResponse } from './article.service';

@Controller('article')
export class ArticleController {
  constructor(private readonly articleService: ArticleService) {}

  /**
   * GET /api/article?url=<encodeURIComponent(url)>
   *
   * 失败时不返回半截内容，而是给出归一化的错误码（技术方案 4.6 的关键原则）。
   */
  @Get()
  getArticle(@Query('url') url?: string): Promise<ArticleResponse> {
    return this.articleService.getArticle(url ?? '');
  }
}
