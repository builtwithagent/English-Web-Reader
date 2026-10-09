import { Body, Controller, Logger, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../common/errors';
import { StatsService } from '../stats/stats.service';
import { urlKey } from '../stats/stats.types';import { normalizeTargetLang } from './langs';
import { TranslateRequestDto } from './translate.dto';
import { TranslateService } from './translate.service';

/**
 * `POST /api/translate` —— SSE 回流（技术方案 5.2）。
 *
 * 为什么不用 Nest 的 `@Sse()` 装饰器：它是**只支持 GET** 的（因为浏览器的
 * `EventSource` 只能发 GET），而我们的请求体里有整篇待翻译的块，必须 POST。
 * 所以这里手写 SSE：`@Post()` + `@Res()`，头部自己设，帧自己拼。
 * 前端那边也不能用 `EventSource`，要用 `fetch` + 手动读 `ReadableStream`。
 */
@Controller('translate')
export class TranslateController {
  private readonly logger = new Logger(TranslateController.name);

  constructor(
    private readonly translateService: TranslateService,
    private readonly stats: StatsService,
  ) {}

  @Post()
  async translate(@Body() dto: TranslateRequestDto, @Res() res: Response): Promise<void> {
    // 前置检查必须在写头之前跑完。一 flushHeaders() 状态码就定死，
    // 此时再抛错只能往流里塞一个错误事件，而前端拿到的 HTTP 状态还是 200。
    try {
      this.translateService.preflight(dto);
    } catch (err) {
      // 被挡下的请求也要记：它反映"有多少人在拿非英文页试"，
      // 是判断要不要放宽语言闸门的唯一依据。
      this.stats.recordTranslateReject(err instanceof AppError ? err.code : 'internal_error');
      throw err;
    }

    // 记账放在 preflight 之后、发流之前：**一次请求只记一次**，
    // 记在 finally 里会在客户端断开时被漏掉，记在每块里又会重复。
    // 语言先归一：DTO 只校验了"是个字符串"，原样记下来分布就没法看了。
    // 地址记完整的（不记域名）：看板上要能看出"是哪一篇在烧额度"。
    this.stats.recordTranslate({
      url: urlKey(dto.url ?? ''),
      targetLang: normalizeTargetLang(dto.targetLang),
      blocks: dto.blocks.length,
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 反向代理默认会缓冲响应体，缓冲了就不是流式了 —— 用户会一直转圈，
    // 直到整篇译完才一次性看到内容
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const abort = new AbortController();
    const onClientGone = (): void => abort.abort();
    res.on('close', onClientGone);

    try {
      for await (const event of this.translateService.translate(dto, abort.signal)) {
        if (!writeFrame(res, JSON.stringify(event))) {
          // 客户端已经走了（关了标签页 / 点了停止）。掐掉上游 ——
          // 用户都不看了，再翻完剩下的块纯属白烧额度。
          this.logger.debug('客户端已断开，中止本次翻译');
          abort.abort();
          break;
        }
      }
    } catch (err) {
      // 能走到这里的只有**整体性**故障（单块失败是普通事件，不会抛）。
      // 此时头已经发出去了，只能把错误当成一条流事件交给前端。
      const appError = err instanceof AppError ? err : new AppError('internal_error');
      this.logger.error(
        `翻译流出错：${appError.code}`,
        err instanceof Error ? err.stack : undefined,
      );
      // 带上完整的 error payload（code + message + hint）。
      // 前端要拿 message 直接显示给用户，而错误文案**只能有一处定义**（common/errors.ts）——
      // 前端再抄一份中文表，就是等着两边不一致。
      writeFrame(res, JSON.stringify({ error: appError.toPayload().error }));
    } finally {
      res.off('close', onClientGone);
      // 哪怕中途出错也要补一个结束标记：前端靠它收尾，
      // 缺了的话流会一直挂着，界面停在一半的状态
      writeFrame(res, '[DONE]');
      res.end();
    }
  }
}

/**
 * 写一帧 SSE，返回"是否写成功"。
 *
 * 客户端断开后 `res.write` 会静默失败或抛 EPIPE，两种情况都得挡住 ——
 * 断线不该把异常冒到全局过滤器，更不该中断调度。
 */
function writeFrame(res: Response, data: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`data: ${data}\n\n`);
    return true;
  } catch {
    return false;
  }
}
