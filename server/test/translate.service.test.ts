import { describe, expect, it } from 'vitest';
import { AppError, type ErrorCode } from '../src/common/errors';
import { MIN_SAMPLE_CHARS } from '../src/common/lang';
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

function makeService(llm: FakeLlm): TranslateService {
  return new TranslateService(llm as unknown as LlmService);
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
function preflightCode(service: TranslateService, request: TranslateRequestDto): ErrorCode | null {
  try {
    service.preflight(request);
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
