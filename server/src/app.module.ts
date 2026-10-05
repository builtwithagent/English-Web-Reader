import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ArticleModule } from './article/article.module';

@Module({
  imports: [
    // 环境变量全局可用（PORT、后续的 DEEPSEEK_API_KEY 都从这里读）
    ConfigModule.forRoot({ isGlobal: true }),
    ArticleModule,
  ],
})
export class AppModule {}
