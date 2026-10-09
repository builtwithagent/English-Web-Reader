import { describe, expect, it } from 'vitest';
import { AppError, type ErrorCode } from '../src/common/errors';
import { MIN_SAMPLE_CHARS } from '../src/common/lang';
import { RateLimiter, type LimitSpec } from '../src/common/rate-limit';
import type { LlmService } from '../src/translate/llm.service';
import { TranslateService, type TranslateEvent } from '../src/translate/translate.service';
import type { TranslateRequestDto } from '../src/translate/translate.dto';

/**
 * 翻译编排层的单测（技术方案 5.2 / 5.3 / 5.6）。
 *
 * 这一层负责四件事，每件都有明确的失败形态：
 *   1. **入口闸门** —— 非英文页在发流之前拦下，零上游调用；
 *   2. **并发编排** —— 并发 3，谁先译完谁先回流；
 *   3. **失败隔离** —— 单块失败不中断整条流；
 *   4. **重试口径** —— 只重试"等一下可能有救"的错误。
 *
 * 上游用假的 LlmService 顶替：这里要验证的是**编排**，不是网络。
 * （网络那一层的边界在 `llm.service.test.ts` 里，用假 fetch 覆盖。）
 */

// 注意：汉字数必须 ≥ MIN_SAMPLE_CHARS（80）。这句正文每份 25 个汉字，
// 所以至少 repeat(4) —— 少一份样本就不足，闸门会按设计放行。
const ZH_TEXT = '这是一段中文正文，用来验证入口语言闸门的拦截是否生效。'.repeat(4);
const EN_TEXT =
  'This paragraph is long enough to be treated as an English sample by the detector, ' +
  'so the preflight gate should let it through without any complaint.';

/** 假的 LlmService：只实现编排层真正用到的三个成员 */
class FakeLlm {
  hasApiKey: boolean;
  model = 'fake-model';
  /** 收到过的文本，按调用顺序 */
  seen: string[] = [];
  /** 同时在飞的请求数峰值 —— 用来验证并发上限 */
  peak = 0;
  private active = 0;

  constructor(
    private readonly handler: (text: string, call: number) => Promise<string> = async (t) => `【译】${t}`,
    hasApiKey = true,
  ) {
    this.hasApiKey = hasApiKey;
  }

  async complete(_system: string, user: string): Promise<string> {
    this.seen.push(user);
    const call = this.seen.length;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await this.handler(user, call);
    } finally {
      this.active--;
    }
  }
}

/**
 * 默认给一个**全部关掉**的限流器：这个文件要验的是语言闸门与并发编排，
 * 额度闸门自己有单独的用例（见下面"preflight：额度闸门"那一段与
 * test/rate-limit.test.ts）—— 混在一起会让"为什么这条挂了"变得难判断。
 */
const NO_LIMITS: LimitSpec = { perMinute: 0, perIpPerDay: 0, globalPerDay: 0 };

/** 每个用例固定用一个 IP：限流按 IP 记账，用同一个值才复现得出来 */
const IP = '203.0.113.7';

function makeService(llm: FakeLlm, spec: LimitSpec = NO_LIMITS): TranslateService {
  return new TranslateService(llm as unknown as LlmService, new RateLimiter(spec));
}

function dto(blocks: Array<{ id: number; text: string }>, targetLang = 'zh-Hans'): TranslateRequestDto {
  return { url: 'https://example.com/post', targetLang, blocks };
}

/** 把异步生成器收干 */
async function collect(service: TranslateService, request: TranslateRequestDto): Promise<TranslateEvent[]> {
  const events: TranslateEvent[] = [];
  for await (const event of service.translate(request, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

/** 取事件上的 id；整体失败的事件没有 id，这里用 -1 代表 */
function idOf(event: TranslateEvent): number {
  return 'id' in event ? event.id : -1;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 抓出 preflight 抛的错误码 */
function preflightCode(
  service: TranslateService,
  request: TranslateRequestDto,
  ip = IP,
): ErrorCode | null {
  try {
    service.preflight(request, ip);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return (err as AppError).code;
  }
}

// ============================================================================

describe('preflight：发流之前的闸门', () => {
  it('没有配 key → translate_auth_failed（不让用户等到超时才看到失败）', () => {
    const service = makeService(new FakeLlm(undefined, false));
    expect(preflightCode(service, dto([{ id: 1, text: EN_TEXT }]))).toBe('translate_auth_failed');
  });

  it('英文正文 → 放行', () => {
    const service = makeService(new FakeLlm());
    expect(preflightCode(service, dto([{ id: 1, text: EN_TEXT }]))).toBeNull();
  });

  it('中文正文 → source_not_english，且**零上游调用**', () => {
    const llm = new FakeLlm();
    expect(preflightCode(makeService(llm), dto([{ id: 1, text: ZH_TEXT }]))).toBe('source_not_english');
    // 这道闸门存在的意义就是"一分钱都不花"，一旦它开始调上游就白设了
    expect(llm.seen).toHaveLength(0);
  });

  it('样本不足时**不拦** —— "判不出来"不等于"确认不是英文"', () => {
    // 拿不确信的结论去拒绝请求会误伤短内容（标签行、列表页头几条）
    const service = makeService(new FakeLlm());
    expect(preflightCode(service, dto([{ id: 1, text: '你好' }]))).toBeNull();
    expect(MIN_SAMPLE_CHARS).toBeGreaterThan(2);
  });

  it('多块拼起来一起判：单块都短、合起来够长，仍然能拦下中文页', () => {
    const blocks = ZH_TEXT.match(/.{1,20}/g)!.map((text, i) => ({ id: i + 1, text }));
    expect(preflightCode(makeService(new FakeLlm()), dto(blocks))).toBe('source_not_english');
  });

  it('key 缺失的判定**先于**语言判定（缺 key 时不该报"这不是英文页"）', () => {
    const service = makeService(new FakeLlm(undefined, false));
    expect(preflightCode(service, dto([{ id: 1, text: ZH_TEXT }]))).toBe('translate_auth_failed');
  });
});

/**
 * 额度闸门（技术方案 7.8.1）。
 *
 * 这里验的是**编排层怎么用它**（顺序、计费口径、回滚），
 * 计数本身的正误在 test/rate-limit.test.ts 里。
 */
describe('preflight：额度闸门', () => {
  const en = (id: number) => ({ id, text: EN_TEXT });

  it('每 IP 每天用尽 → daily_limit_reached，且**零上游调用**', () => {
    const llm = new FakeLlm();
    const service = makeService(llm, { perMinute: 0, perIpPerDay: 2, globalPerDay: 0 });
    expect(preflightCode(service, dto([en(1), en(2)]))).toBeNull();
    expect(preflightCode(service, dto([en(3)]))).toBe('daily_limit_reached');
    expect(llm.seen).toHaveLength(0);
  });

  it('每分钟次数用尽 → too_many_requests（**与额度用尽分成两个码**）', () => {
    // 两种处境不一样："等半分钟"和"今天没了"。共用一个码的话，
    // 那句固定文案必然对其中一种说谎。
    const service = makeService(new FakeLlm(), { perMinute: 1, perIpPerDay: 0, globalPerDay: 0 });
    expect(preflightCode(service, dto([en(1)]))).toBeNull();
    expect(preflightCode(service, dto([en(2)]))).toBe('too_many_requests');
  });

  it('计费的是**可译块数**：不可译的块不占额度', () => {
    const service = makeService(new FakeLlm(), { perMinute: 0, perIpPerDay: 2, globalPerDay: 0 });
    const mixed = dto([
      { id: 1, text: '2026-10-10' }, // 没有字母
      { id: 2, text: '—' },
      { id: 3, text: EN_TEXT },
      { id: 4, text: EN_TEXT },
    ]);
    // 4 个块里只有 2 个会被真发出去 → 正好占满 2 个单位。
    // （如果按 blocks.length 计费，这一句就已经被拦了。）
    expect(preflightCode(service, mixed)).toBeNull();
    expect(preflightCode(service, dto([en(5)]))).toBe('daily_limit_reached');
  });

  it('全站日额度是**跨 IP** 的总闸：前两道全关掉也拦得住', () => {
    // 这条是"保钱"的最后一道 —— XFF 可以伪造，所以每 IP 的限制对
    // 铁了心刷的人等于没有，只有这一道拦得住。
    const service = makeService(new FakeLlm(), { perMinute: 0, perIpPerDay: 0, globalPerDay: 1 });
    expect(preflightCode(service, dto([en(1)]))).toBeNull();
    expect(preflightCode(service, dto([en(2)]), '198.51.100.9')).toBe('daily_limit_reached');
  });

  it('被**语言闸门**拦下的请求不扣额度（顺序：语言判定在预扣之前）', () => {
    // 拿中文页试的人不应该把额度吃掉 —— 那道闸门挡下的量在统计里并不小，
    // 顺序反了的话"判断不了的文章"也会记账。
    const service = makeService(new FakeLlm(), { perMinute: 0, perIpPerDay: 1, globalPerDay: 0 });
    for (let i = 0; i < 5; i++) {
      expect(preflightCode(service, dto([{ id: 1, text: ZH_TEXT }]))).toBe('source_not_english');
    }
    expect(preflightCode(service, dto([en(1)]))).toBeNull();
  });

  it('refund 把预扣退回来之后额度可以再花', () => {
    const service = makeService(new FakeLlm(), { perMinute: 0, perIpPerDay: 2, globalPerDay: 0 });
    const ticket = service.preflight(dto([en(1), en(2)]), IP);
    expect(preflightCode(service, dto([en(3)]))).toBe('daily_limit_reached');

    service.refund(ticket);
    expect(preflightCode(service, dto([en(3)]))).toBeNull();
  });

  it('refund(null) 不炸（没有预扣的时候不该要求调用方先判空）', () => {
    const service = makeService(new FakeLlm());
    expect(() => service.refund(null)).not.toThrow();
  });

  it('preflight 返回的凭据带着扣账明细，供调用方决定要不要退', () => {
    const service = makeService(new FakeLlm(), { perMinute: 0, perIpPerDay: 5, globalPerDay: 0 });
    const ticket = service.preflight(dto([en(1), en(2)]), IP);
    expect(ticket).not.toBeNull();
    expect(ticket!.units).toBe(2);
    // 全站那道关着 —— 回滚时不能去减一个从没扣过的账（减了会变负数）
    expect(ticket!.chargedIpDay).toBe(true);
    expect(ticket!.chargedGlobal).toBe(false);
  });
});

describe('translate：跳过不值得发请求的块', () => {
  it('空白、纯数字、纯符号的块不会被发出去', async () => {
    const llm = new FakeLlm();
    const events = await collect(
      makeService(llm),
      dto([
        { id: 1, text: EN_TEXT },
        { id: 2, text: '   ' },
        { id: 3, text: '2026-10-07' },
        { id: 4, text: '—' },
        { id: 5, text: 'Another real sentence here.' },
      ]),
    );

    expect(llm.seen).toHaveLength(2);
    expect(llm.seen).toContain(EN_TEXT);
    expect(llm.seen).toContain('Another real sentence here.');
    expect(events.map(idOf).sort((a, b) => a - b)).toEqual([1, 5]);
  });

  it('一块都不可译时直接结束：不发请求、不产出事件', async () => {
    const llm = new FakeLlm();
    const events = await collect(
      makeService(llm),
      dto([
        { id: 1, text: '12' },
        { id: 2, text: '   ' },
      ]),
    );
    expect(events).toEqual([]);
    expect(llm.seen).toHaveLength(0);
  });
});

describe('translate：回流顺序与 id 对应', () => {
  it('**按完成顺序回流，不按 id 顺序** —— 前端必须靠 id 回填', async () => {
    // 并发 3 跑三块，慢的不同：完成顺序必然是 3 → 2 → 1
    const delayOf: Record<string, number> = {
      'Block one.': 60,
      'Block two.': 40,
      'Block three.': 20,
    };
    const llm = new FakeLlm(async (text) => {
      await sleep(delayOf[text]);
      return `译文:${text}`;
    });

    const events = await collect(
      makeService(llm),
      dto([
        { id: 1, text: 'Block one.' },
        { id: 2, text: 'Block two.' },
        { id: 3, text: 'Block three.' },
      ]),
    );

    expect(events.map(idOf)).toEqual([3, 2, 1]);

    // 关键：不管顺序怎么乱，每条事件的 id 与 text 必须自洽 —— 这就是"按 id 回填"的前提
    const textBySource: Record<string, string> = {
      1: '译文:Block one.',
      2: '译文:Block two.',
      3: '译文:Block three.',
    };
    for (const event of events) {
      expect('text' in event).toBe(true);
      if ('text' in event) expect(event.text).toBe(textBySource[event.id]);
    }
  });

  it('每块恰好回一条事件，不重不漏', async () => {
    const llm = new FakeLlm();
    const blocks = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, text: `Sentence number ${i}.` }));
    const events = await collect(makeService(llm), dto(blocks));

    expect(events.map(idOf).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('translate：并发编排', () => {
  it('并发上限是 3，不会把上游的限流撞响', async () => {
    const llm = new FakeLlm(async (text) => {
      await sleep(10);
      return text;
    });
    const blocks = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, text: `Sentence number ${i}.` }));
    await collect(makeService(llm), dto(blocks));

    expect(llm.peak).toBe(3);
  });

  it('块数少于并发度时不会硬撑到 3', async () => {
    const llm = new FakeLlm(async (text) => {
      await sleep(5);
      return text;
    });
    await collect(makeService(llm), dto([{ id: 1, text: 'Only one.' }]));
    expect(llm.peak).toBe(1);
  });

  it('全部块都发出去，一个不落', async () => {
    const llm = new FakeLlm();
    const blocks = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, text: `Sentence number ${i}.` }));
    const events = await collect(makeService(llm), dto(blocks));
    expect(events).toHaveLength(12);
    expect(llm.seen).toHaveLength(12);
  });
});

describe('translate：单块失败不中断整条流', () => {
  it('第 3 块失败，其余块照常回流', async () => {
    const llm = new FakeLlm(async (text) => {
      if (text.includes('three')) throw new AppError('translate_unavailable');
      return `【译】${text}`;
    });
    const events = await collect(
      makeService(llm),
      dto([
        { id: 1, text: 'Block one.' },
        { id: 2, text: 'Block two.' },
        { id: 3, text: 'Block three.' },
        { id: 4, text: 'Block four.' },
      ]),
    );

    expect(events).toHaveLength(4);
    const failed = events.filter((e) => 'error' in e);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: 3, error: { code: 'translate_unavailable' } });

    // **有 id 才是单块失败**；没有 id 的事件表示整体失败（前端靠这个区分）
    expect(events.some((e) => 'error' in e && !('id' in e))).toBe(false);
    expect(events.filter((e) => 'text' in e)).toHaveLength(3);
  });

  it('非 AppError 的异常也被归一成错误码，不把原始异常泄给前端', async () => {
    const llm = new FakeLlm(async () => {
      throw new Error('boom: internal detail');
    });
    const events = await collect(makeService(llm), dto([{ id: 1, text: 'A real sentence.' }]));

    expect(events).toEqual([{ id: 1, error: { code: 'translate_unavailable' } }]);
    expect(JSON.stringify(events)).not.toContain('internal detail');
  });

  it('一块失败不会连累同一批里其它的块', async () => {
    const llm = new FakeLlm(async (text) => {
      if (text.includes('bad')) throw new AppError('translate_timeout');
      return `【译】${text}`;
    });
    const events = await collect(
      makeService(llm),
      dto([
        { id: 1, text: 'good one.' },
        { id: 2, text: 'bad one.' },
        { id: 3, text: 'good two.' },
      ]),
    );

    expect(events.filter((e) => 'text' in e)).toHaveLength(2);
    expect(events.filter((e) => 'error' in e)).toHaveLength(1);
  });

  it('限流时整批块各自失败，但流本身正常收尾（不会挂在那儿）', async () => {
    const llm = new FakeLlm(async () => {
      throw new AppError('translate_rate_limited');
    });
    const events = await collect(
      makeService(llm),
      dto([
        { id: 1, text: 'First sentence.' },
        { id: 2, text: 'Second sentence.' },
      ]),
    );
    expect(events).toHaveLength(2);
    expect(events.every((e) => 'error' in e)).toBe(true);
  });
});

describe('translate：重试口径', () => {
  it('可重试的错误重试一次（共打两次上游）', async () => {
    let calls = 0;
    const llm = new FakeLlm(async () => {
      calls++;
      throw new AppError('translate_rate_limited');
    });
    const events = await collect(makeService(llm), dto([{ id: 1, text: 'A real sentence.' }]));

    expect(calls).toBe(2);
    expect(events).toEqual([{ id: 1, error: { code: 'translate_rate_limited' } }]);
  });

  it('401 不重试（重试一百次也是同样的结果）', async () => {
    let calls = 0;
    const llm = new FakeLlm(async () => {
      calls++;
      throw new AppError('translate_auth_failed');
    });
    await collect(makeService(llm), dto([{ id: 1, text: 'A real sentence.' }]));
    expect(calls).toBe(1);
  });

  it('402 余额不足不重试', async () => {
    let calls = 0;
    const llm = new FakeLlm(async () => {
      calls++;
      throw new AppError('translate_quota');
    });
    await collect(makeService(llm), dto([{ id: 1, text: 'A real sentence.' }]));
    expect(calls).toBe(1);
  });

  it('第一次失败、重试成功 → 回流的是译文而不是错误', async () => {
    let calls = 0;
    const llm = new FakeLlm(async () => {
      calls++;
      if (calls === 1) throw new AppError('translate_unavailable');
      return '【译】终于成功';
    });
    const events = await collect(makeService(llm), dto([{ id: 1, text: 'A real sentence.' }]));

    expect(calls).toBe(2);
    expect(events).toEqual([{ id: 1, text: '【译】终于成功' }]);
  });
});

describe('translate：参数传递', () => {
  /** 记录每次调用收到的 system prompt */
  function spySystem(llm: FakeLlm): string[] {
    const seen: string[] = [];
    const target = llm as unknown as { complete: (s: string, u: string) => Promise<string> };
    const original = target.complete.bind(llm);
    target.complete = async (system: string, user: string) => {
      seen.push(system);
      return original(system, user);
    };
    return seen;
  }

  it('system 里写的是**目标语言的语言名**', async () => {
    const llm = new FakeLlm();
    const systems = spySystem(llm);
    await collect(makeService(llm), dto([{ id: 1, text: 'A real sentence.' }], 'ja'));
    expect(systems[0]).toContain('日语');
  });

  it('非法 targetLang 静默回落简体中文，不报错', async () => {
    const llm = new FakeLlm();
    const systems = spySystem(llm);
    await collect(makeService(llm), dto([{ id: 1, text: 'A real sentence.' }], 'en'));
    expect(systems[0]).toContain('简体中文');
  });
});

describe('translate：错误码白名单', () => {
  it('编排层只产出翻译侧的错误码', async () => {
    const llm = new FakeLlm(async () => {
      throw new AppError('translate_timeout');
    });
    const events = await collect(makeService(llm), dto([{ id: 1, text: 'A real sentence.' }]));

    const codes = events.flatMap((e) => ('error' in e ? [e.error.code] : []));
    expect(codes).toHaveLength(1);
    expect(codes.every((code) => code.startsWith('translate_'))).toBe(true);
  });
});
