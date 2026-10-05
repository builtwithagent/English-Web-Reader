import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // 所有接口统一挂在 /api 下（前端拼的是同源相对路径 /api/...）
  app.setGlobalPrefix('api');

  // "一套错误码"的落地点
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableShutdownHooks();

  // 发布沙箱要求：必须监听 PORT 并绑定 0.0.0.0
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  Logger.log(`服务已启动：http://0.0.0.0:${port}/api/article?url=...`, 'Bootstrap');
}

void bootstrap();
