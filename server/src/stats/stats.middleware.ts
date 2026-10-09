import type { RequestHandler } from 'express';
import { clientIp } from '../common/ip';
import { StatsService } from './stats.service';
import { hostOf } from './stats.types';

/**
 * 页面访问记录。
 *
 * ## 为什么不用 Nest 的模块中间件（`consumer.apply(X).forRoutes('*')`）
 *
 * 踩过，记在这里：有全局前缀（`setGlobalPrefix('api')`）时，`forRoutes('*')`
 * **不会**生成一个全局挂载，Nest 算出来的是 `['/api$', '/api/*', '/stats']`
 * （见 `RouteInfoPathExtractor.extractPathsFrom`）。于是：
 *
 * 1. `/` 和普通页面路径**一条都匹配不上**，访问量恒为 0；
 * 2. 而 `/stats` 被挂成 `app.use('/stats', …)`，Express 会把挂载前缀从 `req.url`
 *    里**剥掉** —— 中间件里读到的 `req.path` 变成 `/`，`shouldCount('/')` 为真，
 *    结果**每次看统计都被记成一次首页访问**。数字看着有值，其实全是我自己。
 *
 * 所以这里改成在 `main.ts` 里 `app.use(createPageViewMiddleware(stats))`：
 * 不带路径的挂载＝真正的全局，排在静态资源与所有路由之前，且没有任何前缀剥离。
 * 路径也从 `req.originalUrl` 取 —— 它是**唯一不受挂载剥前缀影响**的那个字段，
 * 万一以后有人又给它加了挂载点，计数口径也不会跟着变。
 */
export function createPageViewMiddleware(stats: StatsService): RequestHandler {
  return (req, _res, next) => {
    if (req.method === 'GET') {
      const path = pathnameOf(req.originalUrl);
      if (shouldCount(path)) {
        stats.recordPageView({
          path,
          ip: clientIp(req),
          ua: req.get('user-agent') ?? '',
          referer: hostOf(req.get('referer')) ?? undefined,
          hasUrlParam: typeof req.query.url === 'string' && req.query.url.length > 0,
        });
      }
    }
    next();
  };
}

/** 从 URL 里取 path（丢掉查询串）。`req.originalUrl` 一定以 `/` 开头，这是兜底 */
export function pathnameOf(url: string): string {
  const query = url.indexOf('?');
  const path = query >= 0 ? url.slice(0, query) : url;
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * 哪些请求算"一次页面访问"。
 *
 * 单独抽成纯函数是为了能离线单测 —— 这条规则最容易写错：
 * 写松了静态资源会把访问量灌到十倍，写紧了首页都不计数。
 */
export function shouldCount(path: string): boolean {
  // 接口自己有更细的记录（成功/失败/错误码），这里再算一遍是重复计数。
  // `/api/stats` 也是靠这条挡掉的 —— 看统计不该算成一次访问
  if (path.startsWith('/api')) return false;
  // `/stats` 是**前端路由的页面路径**（数据来自 /api/stats）。这里在保护的
  // 是"我自己在看统计"，不是用户访问。它曾经也是后端直出页面的挂载点，
  // 那时这条规则还有第二层作用，见文件头。
  if (path.startsWith('/stats')) return false;
  if (path === '/favicon.ico' || path === '/robots.txt') return false;

  // 带扩展名的一律当静态资源（.js/.css/.png/.woff2 …）。
  // SPA 只有 `/` 一个入口，`/index.html` 也会被这条挡掉，正好不重复计。
  return !/\.[a-z0-9]{1,8}$/i.test(path);
}
