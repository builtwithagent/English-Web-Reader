import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { TranslateController } from './translate.controller';
import { TranslateService } from './translate.service';

/**
 * 翻译模块。
 *
 * 与 `ArticleModule` 之间**没有任何 import 关系** —— 这是刻意的：
 * 抓取链路（`/api/article`）与翻译链路（`/api/translate`）各自独立，
 * 翻译服务不依赖正文提取的结果，也不感知它是从哪来的。
 * 把"翻译已抓取的文章"串起来是**前端**的事（它先拿 article、再拿它的 blocks 发 translate）。
 */
@Module({
  controllers: [TranslateController],
  providers: [TranslateService, LlmService],
})
export class TranslateModule {}
