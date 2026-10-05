import { Module } from '@nestjs/common';
import { ArticleController } from './article.controller';
import { ArticleService } from './article.service';
import { FetchService } from './fetch.service';
import { ExtractService } from './extract.service';

@Module({
  controllers: [ArticleController],
  providers: [ArticleService, FetchService, ExtractService],
})
export class ArticleModule {}
