import { Module } from '@nestjs/common';
import { ArticleController } from './article.controller';
import { ArticleService } from './article.service';
import { FetchService } from './fetch.service';
import { ExtractService } from './extract.service';
import { StatsModule } from '../stats/stats.module';

@Module({
  // StatsModule 只是为了在服务里打点（成功/失败各记一次）。
  // 注意抓取链路**不感知**翻译链路，两者仍然互不相识。
  imports: [StatsModule],
  controllers: [ArticleController],
  providers: [ArticleService, FetchService, ExtractService],
})
export class ArticleModule {}
