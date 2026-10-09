import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { createPageViewMiddleware } from './stats/stats.middleware';
import { StatsService } from './stats/stats.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // 页面访问统计必须**第一个**挂上，而且要用不带路径的 `app.use()`：
  // 静态资源中间件是"命中就不再往下走"的，晚一步注册就再也看不到首页请求了。
  // 走 Nest 的模块中间件（forRoutes('*')）会踩两个坑 —— 详细原因见
  // stats.middleware.ts 的文件头注释。
  //
  // `app.get(StatsService)` 在 listen() 之前是安全的：容器在 NestFactory.create()
  // 阶段就已经把 provider 实例化完了，init() 只负责挂钩子与挂路由。
  app.use(createPageViewMiddleware(app.get(StatsService)));

  // 所有接口统一挂在 /api 下（前端拼的是同源相对路径 /api/...）。
  // 统计接口也在这下面（/api/stats）—— 它就是个普通接口，没有例外。
  // 页面级的 /stats 不归后端管：那是前端路由，由下面的静态托管兜底到 index.html。
  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      // `transform` 必须开：`/api/translate` 的请求体里有嵌套 DTO 数组，
      // 不开的话 controller 里拿到的还是普通对象字面量，
      // 嵌层那些 @IsInt / @MaxLength **一个都不会执行**，而且不报错
      transform: true,
      // 丢掉 DTO 上没声明的字段，避免调用方顺手塞进来的东西一路流到上游
      whitelist: true,
    }),
  );

  // "一套错误码"的落地点
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableShutdownHooks();

  // 发布沙箱要求：必须监听 PORT 并绑定 0.0.0.0
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  Logger.log(
    `服务已启动：http://0.0.0.0:${port}/  ·  /api/article?url=...  ·  /api/translate  ·  /api/stats`,
    'Bootstrap',
  );
}

void bootstrap();
