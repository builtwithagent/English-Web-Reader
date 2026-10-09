import { Controller, Get, Logger, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from '../common/errors';
import { clientIp } from '../common/ip';
import { buildStatsResponse, type StatsApiResponse } from './stats.api';
import { StatsAuth } from './stats.auth';
import { StatsService } from './stats.service';

/**
 * `GET /api/stats` —— 访问统计数据（JSON）。
 *
 * **这个 controller 只发数据，不发页面**。页面在 `web/src/pages/StatsPage.tsx`，
 * 走前端路由 `/stats`。前一版是服务端直出 HTML 字符串，那样页面样式与产品其余部分
 * 分家（CSS 变量得抄一份），而且"看板"和"产品"会永远长成两种东西。
 *
 * 路径落在 `/api` 下（全局前缀生效），于是开发期 5173 的 Vite 代理顺手就转发了，
 * 不用为它单开一条 proxy 规则。
 *
 * 鉴权是"Basic **或** 自定义头"两条通路，具体取舍见 stats.auth.ts。
 */
@Controller('stats')
export class StatsController {
  private readonly logger = new Logger(StatsController.name);

  constructor(
    private readonly stats: StatsService,
    private readonly auth: StatsAuth,
  ) {}

  @Get()
  get(@Req() req: Request, @Res({ passthrough: true }) res: Response): StatsApiResponse {
    const ip = clientIp(req);

    // 没配密码 ≠ 不校验。公网上"忘配密码"就等于把访问数据全公开，
    // 所以直接拒绝，并且把原因说清楚（能看到这条消息的人本来就进得去服务器）
    if (!this.auth.configured) {
      this.logger.warn('/api/stats 被访问，但未配置 STATS_PASSWORD，已拒绝');
      throw new AppError('stats_disabled');
    }

    if (this.auth.isLocked(ip)) {
      throw new AppError('stats_locked');
    }

    if (!this.auth.verify(req.get('authorization')) && !this.auth.verifyKey(req.get('x-stats-key'))) {
      this.auth.registerFailure(ip);

      // **这里刻意不回 `WWW-Authenticate`。**
      //
      // 它唯一的用途是让浏览器**自己**弹出登录框。但发布环境的网关会把这个头
      // 覆盖成它自己的 `Bearer`（见 stats.auth.ts 开头），于是浏览器弹框 → 用户
      // 输密码 → 凭证发上去又被覆盖 → 又一次 401 → 再弹框，变成一个关不掉的循环。
      // 与其在两个环境里做两套行为，不如让页面自己收密码（`StatsPage.tsx`），
      // 本地和线上走同一条路。
      throw new AppError('stats_unauthorized');
    }

    this.auth.clearFailures(ip);
    // 统计**不能进缓存**：CDN 或浏览器缓存一份，下次看到的就是旧数
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return buildStatsResponse(this.stats.snapshot());
  }
}
