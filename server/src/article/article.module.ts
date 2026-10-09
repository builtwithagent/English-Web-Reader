import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describeLimitSpec } from '../common/rate-limit';
import { ArticleController } from './article.controller';
import { ArticleService } from './article.service';
import { FetchService } from './fetch.service';
import { ExtractService } from './extract.service';
import { ARTICLE_LIMITS, makeArticleLimiter } from './article.limits';
import { StatsModule } from '../stats/stats.module';

@Module({
  // StatsModule 只是为了在服务里打点（成功/失败各记一次）。
  // 注意抓取链路**不感知**翻译链路，两者仍然互不相识。
  imports: [StatsModule],
  controllers: [ArticleController],
  providers: [
    ArticleService,
    FetchService,
    ExtractService,

    // 抓取侧的额度闸门。与翻译那边同机制、不同配置（没有全站日额度），
    // 理由写在 article.limits.ts 的文件头。
    {
      provide: ARTICLE_LIMITS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const limiter = makeArticleLimiter((key) => config.get<string>(key));
        new Logger('ArticleLimits').log(`抓取额度：${describeLimitSpec(limiter.spec)}`);
        return limiter;
      },
    },
  ],
})
export class ArticleModule {}
