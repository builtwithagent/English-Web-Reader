import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from './errors';

/**
 * 全局异常过滤器 —— 这是技术方案里"一套错误码"的落地点。
 *
 * 职责：
 * - 把 AppError 原样转成 `{ error: { code, message, hint } }`
 * - 把 Nest 内建的 HttpException（404 / 校验失败等）也归一成同样的形状
 * - 未预料的异常一律兜成 internal_error，**不把堆栈或内部细节漏给前端**
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof AppError) {
      response.status(exception.status).json(exception.toPayload());
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // 404 之类的框架级异常也走同一套形状，前端只认一种格式
      response.status(status).json({
        error: {
          code: status === 404 ? 'invalid_url' : 'internal_error',
          message:
            status === 404
              ? '这个接口不存在'
              : '服务器出了点问题，稍后再试',
        },
      });
      return;
    }

    // 真正的意外：日志里留全量堆栈，对外只给一个干净的 500
    const err = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(`未处理异常：${err.message}`, err.stack);

    response.status(500).json(
      new AppError('internal_error').toPayload(),
    );
  }
}
