import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppError, type ErrorCode } from './errors';

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

      // 400 基本只有一种来源：全局 ValidationPipe 把请求体挡下来了。
      // 把具体的字段错误放进 `hint` —— 开发期靠它一眼看出是哪条规则没过。
      if (status === 400) {
        const detail = firstConstraintMessage(exception);
        response.status(400).json({
          error: {
            code: 'invalid_request',
            message: '请求参数不合法',
            ...(detail ? { hint: detail } : {}),
          },
        });
        return;
      }

      // 其余框架级异常（404 等）也走同一套形状，前端只认一种格式
      const code: ErrorCode = status === 404 ? 'not_found' : 'internal_error';
      response.status(status).json(new AppError(code).toPayload());
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

/**
 * 从 ValidationPipe 抛出的异常里抠出第一条字段错误。
 *
 * `HttpException.getResponse()` 的形状随来源而变：可能是字符串，
 * 也可能是 `{ message: string | string[], error, statusCode }`。
 * 这里只取第一条 —— 一次请求里往往是同一个字段的多个规则一起没过，
 * 全塞给前端反而看不清。
 */
function firstConstraintMessage(exception: HttpException): string | undefined {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  if (typeof body !== 'object' || body === null) return undefined;

  const message = (body as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
  return undefined;
}
