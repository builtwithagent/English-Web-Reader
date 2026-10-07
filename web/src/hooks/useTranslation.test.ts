import { describe, expect, it } from 'vitest';
import { buildJobs, decodeTranslation } from './useTranslation';
import type { Block } from '../types';

/**
 * 翻译接线上两个纯函数的单测。
 *
 * 它们各自的错法都很隐蔽：
 * - `buildJobs` 挑错块 → 少发或多发请求。多发是花钱，少发是进度条永远差几格。
 * - `decodeTranslation` 切错行 → 列表项整体错位。**界面看起来"有译文"**，
 *   只有逐项对照原文才发现第 3 项的内容跑到了第 2 项。
 * 所以这两处不靠肉眼看界面，靠单测钉住。
 */

function block(partial: Partial<Block> & Pick<Block, 'id' | 'type'>): Block {
  return { translatable: true, ...partial };
}

describe('buildJobs：挑出发给服务端的块', () => {
  it('代码块与图片块不发（后端也会再过滤一遍，两边必须一致）', () => {
    // 不一致的表现是"进度条永远差几格"：前端按自己的可译数显示总数，
    // 后端却压根没为这几块回流任何事件
    const jobs = buildJobs([
      block({ id: 1, type: 'p', text: 'A paragraph.' }),
      block({ id: 2, type: 'pre', text: 'const a = 1;', translatable: false }),
      block({ id: 3, type: 'img', src: 'https://example.com/a.png', translatable: false }),
      block({ id: 4, type: 'p', text: 'Another paragraph.' }),
    ]);
    expect(jobs.map((job) => job.id)).toEqual([1, 4]);
  });

  it('空白文本不发', () => {
    const jobs = buildJobs([
      block({ id: 1, type: 'p', text: '   ' }),
      block({ id: 2, type: 'p', text: '' }),
      block({ id: 3, type: 'p', text: '\n\n' }),
      block({ id: 4, type: 'p', text: 'real' }),
    ]);
    expect(jobs.map((job) => job.id)).toEqual([4]);
  });

  it('列表块用换行拼起来发（上游只有 {id,text} 一个字段）', () => {
    // 换行是唯一能表达"项边界"又不改契约的办法
    const jobs = buildJobs([block({ id: 7, type: 'ul', items: ['first', 'second', 'third'] })]);
    expect(jobs).toEqual([{ id: 7, text: 'first\nsecond\nthird' }]);
  });

  it('有序列表同样按行拼', () => {
    const jobs = buildJobs([block({ id: 1, type: 'ol', items: ['a', 'b'] })]);
    expect(jobs[0].text).toBe('a\nb');
  });

  it('列表没有 items 时产出空文本 → 被跳过（不发空请求）', () => {
    expect(buildJobs([block({ id: 1, type: 'ul', items: [] })])).toEqual([]);
  });

  it('id 原样保留（后端靠它回填，不能重排、不能重编号）', () => {
    const jobs = buildJobs([
      block({ id: 42, type: 'p', text: 'x' }),
      block({ id: 7, type: 'p', text: 'y' }),
    ]);
    expect(jobs.map((job) => job.id)).toEqual([42, 7]);
  });

  it('空文章 → 空数组', () => {
    expect(buildJobs([])).toEqual([]);
  });
});

describe('decodeTranslation：把一坨文本还原成该块的形状', () => {
  it('非列表块原样返回字符串', () => {
    expect(decodeTranslation(block({ id: 1, type: 'p' }), '一段译文')).toBe('一段译文');
  });

  it('标题 / 引用 / 图注都走字符串分支', () => {
    for (const type of ['h1', 'h2', 'blockquote', 'figcaption'] as const) {
      expect(decodeTranslation(block({ id: 1, type }), 'X')).toBe('X');
    }
  });

  it('找不到对应块时也返回字符串（降级，不抛）', () => {
    expect(decodeTranslation(undefined, 'X')).toBe('X');
  });

  it('列表块：行数与原文项数一致 → 切成数组', () => {
    const ul = block({ id: 1, type: 'ul', items: ['a', 'b', 'c'] });
    expect(decodeTranslation(ul, '甲\n乙\n丙')).toEqual(['甲', '乙', '丙']);
  });

  it('列表块：**行数对不上就整段当一项**', () => {
    // 模型少吐一个换行很常见。硬按行切会让后面所有项错位，
    // 那比"这一段少了个项目符号"严重得多。
    const ul = block({ id: 1, type: 'ul', items: ['a', 'b', 'c'] });
    expect(decodeTranslation(ul, '甲\n乙')).toEqual(['甲\n乙']);

    const ul2 = block({ id: 2, type: 'ul', items: ['a'] });
    expect(decodeTranslation(ul2, '甲\n乙\n丙')).toEqual(['甲\n乙\n丙']);
  });

  it('列表块：剥掉行首的列表符号（模型爱自己加上）', () => {
    const ul = block({ id: 1, type: 'ul', items: ['a', 'b'] });
    expect(decodeTranslation(ul, '- 甲\n* 乙')).toEqual(['甲', '乙']);
    expect(decodeTranslation(ul, '• 甲\n· 乙')).toEqual(['甲', '乙']);
    expect(decodeTranslation(ul, '1. 甲\n2. 乙')).toEqual(['甲', '乙']);
    expect(decodeTranslation(ul, '1) 甲\n2、乙')).toEqual(['甲', '乙']);
  });

  it('列表块：空行被过滤掉', () => {
    const ul = block({ id: 1, type: 'ul', items: ['a', 'b'] });
    expect(decodeTranslation(ul, '甲\n\n乙')).toEqual(['甲', '乙']);
  });

  it('列表块：行首符号剥离后为空的项也过滤', () => {
    const ul = block({ id: 1, type: 'ul', items: ['a', 'b'] });
    expect(decodeTranslation(ul, '甲\n- \n乙')).toEqual(['甲', '乙']);
  });

  it('列表块：两端空白被清掉', () => {
    const ul = block({ id: 1, type: 'ul', items: ['a', 'b'] });
    expect(decodeTranslation(ul, '  甲  \n  乙  ')).toEqual(['甲', '乙']);
  });

  it('列表块：原文项数为 0 时不会把结果切空', () => {
    // items 为空的 ul 其实发不出去（buildJobs 会跳过），这里只保证不崩
    const ul = block({ id: 1, type: 'ul', items: [] });
    expect(decodeTranslation(ul, '甲\n乙')).toEqual(['甲\n乙']);
  });

  it('行内出现的符号不会被误剥（只剥行首）', () => {
    const ul = block({ id: 1, type: 'ul', items: ['a'] });
    expect(decodeTranslation(ul, 'a - b')).toEqual(['a - b']);
  });

  it('产出类型与原文块形状一致：列表给数组、其它给字符串', () => {
    expect(Array.isArray(decodeTranslation(block({ id: 1, type: 'ul', items: ['a'] }), '甲'))).toBe(true);
    expect(typeof decodeTranslation(block({ id: 1, type: 'p' }), '甲')).toBe('string');
  });
});
