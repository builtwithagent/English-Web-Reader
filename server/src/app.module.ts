import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ArticleModule } from './article/article.module';
import { TranslateModule } from './translate/translate.module';

@Module({
  imports: [
    // 环境变量全局可用（PORT、DEEPSEEK_API_KEY 都从这里读）
    ConfigModule.forRoot({ isGlobal: true }),
    ArticleModule,
    TranslateModule,
  ],
})
export class AppModule {}
