import { Module } from '@nestjs/common';
import { StatsAuth } from './stats.auth';
import { StatsController } from './stats.controller';
import { STATS_FILE, StatsService, defaultStatsFile } from './stats.service';

/**
 * 访问统计模块。
 *
 * `ArticleModule` 与 `TranslateModule` 都会 import 它，用来在各自的
 * 关键节点打点。**这不破坏"抓取与翻译互不相识"那条约定** ——
 * 它们之间仍然没有任何依赖，只是共同依赖了一个旁路的观测模块。
 *
 * 注意这里**没有 `configure()`**：页面访问中间件不走 Nest 的中间件体系，
 * 而是在 `main.ts` 里用 `app.use()` 显式挂在最前面。原因写在
 * `stats.middleware.ts` 的文件头（模块通配路径的老坑，踩过一次）。
 */
@Module({
  controllers: [StatsController],
  providers: [
    // 路径走 token 注入：开了 emitDecoratorMetadata 之后，构造函数里的
    // `string` 类型会被当成一个叫 String 的依赖去容器里找，启动直接报错
    { provide: STATS_FILE, useFactory: (): string => process.env.STATS_FILE ?? defaultStatsFile() },
    StatsService,
    StatsAuth,
  ],
  exports: [StatsService],
})
export class StatsModule {}
