import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ArticleModule } from './article/article.module';
import { StatsModule } from './stats/stats.module';
import { TranslateModule } from './translate/translate.module';

/**
 * 发布期的前端产物目录。
 *
 * `__dirname` 在产物里是 `server/dist`，上两级正好回到仓库根。
 * 于是**同一个 Node 进程既提供页面又提供接口** —— 同源，前端那些
 * `/api/...` 相对路径不用改一个字，也就没有 CORS 这回事（技术方案 7.1）。
 */
const WEB_DIST = join(__dirname, '..', '..', 'web', 'dist');

@Module({
  imports: [
    // 环境变量全局可用（PORT、LLM_API_KEY、STATS_PASSWORD 都从这里读）
    ConfigModule.forRoot({ isGlobal: true }),
    ArticleModule,
    TranslateModule,
    StatsModule,

    // 开发期 `web/dist` 一般不存在（前端跑在 Vite 的 5173 上），这时**不挂**静态托管：
    // 挂了的话，任何没命中的路径都会被兜成 index.html，接口的 404 会被一张 200 的
    // HTML 盖掉 —— 排查时非常误导。所以用"产物在不在"来决定，而不是看 NODE_ENV。
    ...(existsSync(join(WEB_DIST, 'index.html'))
      ? [
          ServeStaticModule.forRoot({
            rootPath: WEB_DIST,
            // 只有 `/api` 不参与 SPA 兜底：打错的接口路径必须老老实实回 404 JSON，
            // 否则前端按 JSON 解析会得到一句莫名其妙的语法错误。
            //
            // **`/stats` 要参与兜底** —— 它已经是前端路由了（页面在
            // web/src/pages/StatsPage.tsx，数据走 /api/stats）。把这一条也排除掉的话，
            // 浏览器访问 /stats 会直接 404，而开发期在 5173 上却正常，
            // 变成"发布后才出现"的那类问题。
            //
            // `{*splat}` 是 path-to-regexp 8 要求的写法（Express 5 起不再支持裸 `*`），
            // 花括号表示这一段可以没有，所以 `/api/` 与 `/api/foo/bar` 都算命中。
            exclude: ['/api/{*splat}'],
          }),
        ]
      : []),
  ],
})
export class AppModule {}
