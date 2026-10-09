import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describeLimitSpec } from '../common/rate-limit';
import { StatsModule } from '../stats/stats.module';
import { LlmService } from './llm.service';
import { TranslateController } from './translate.controller';
import { TRANSLATE_LIMITS, makeTranslateLimiter } from './translate.limits';
import { TranslateService } from './translate.service';

/**
 * 翻译模块。
 *
 * 与 `ArticleModule` 之间**没有任何 import 关系** —— 这是刻意的：
 * 抓取链路（`/api/article`）与翻译链路（`/api/translate`）各自独立，
 * 翻译服务不依赖正文提取的结果，也不感知它是从哪来的。
 * 把"翻译已抓取的文章"串起来是**前端**的事（它先拿 article、再拿它的 blocks 发 translate）。
 *
 * `StatsModule` 是两条链路唯一的共同依赖，而且它只是旁路打点 —— 不算破坏上面这条。
 */
@Module({
  imports: [StatsModule],
  controllers: [TranslateController],
  providers: [
    TranslateService,
    LlmService,

    // 额度闸门。用工厂而不是 `@Injectable()` 的类：它需要一个 `LimitSpec` 参数，
    // 而 `@Injectable()` + 按类型注入在 `emitDecoratorMetadata` 下会被当成依赖去解析
    // （参见 stats 的 `STATS_FILE` 那段说明）。
    //
    // 启动时把**生效值**打出来：额度这类配置最怕"我以为它生效了" ——
    // 线上排查"为什么被限流"时，日志里有没有这一行决定了要花 1 分钟还是 1 小时。
    {
      provide: TRANSLATE_LIMITS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const limiter = makeTranslateLimiter((key) => config.get<string>(key));
        new Logger('TranslateLimits').log(`翻译额度：${describeLimitSpec(limiter.spec)}`);
        return limiter;
      },
    },
  ],
})
export class TranslateModule {}
