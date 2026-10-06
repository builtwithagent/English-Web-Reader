import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // 所有接口统一挂在 /api 下（前端拼的是同源相对路径 /api/...）
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
    `服务已启动：http://0.0.0.0:${port}/api/article?url=...  ·  /api/translate`,
    'Bootstrap',
  );
}

void bootstrap();
