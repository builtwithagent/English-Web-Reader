import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  STORAGE_KEY,
  clampFontSize,
  isDisplayMode,
  isTargetLang,
  loadPreferences,
  savePreferences,
} from './preferences';

/**
 * 偏好持久化的单测（技术方案 7.3 / 7.6）。
 *
 * 这里的错都是**静默**的：localStorage 里留了个旧版本写进去的值，直接采纳的话
 * 界面会进入"看起来正常、其实不对"的状态 —— 最典型的是 `targetLang: 'en'`：
 * 下拉框找不到对应选项显示成空白，而请求照发，用户看到的是
 * "语言选择器空着，但右边在出中文"。所以每个字段都要单独钉住。
 */

/** 一个够用的内存版 localStorage */
function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const setItem = vi.fn((key: string, value: string) => {
    store.set(key, String(value));
  });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem,
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
  return { store, setItem };
}

const stored = (value: unknown): Record<string, string> => ({
  [STORAGE_KEY]: typeof value === 'string' ? value : JSON.stringify(value),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================================

describe('clampFontSize', () => {
  it('夹在上下界之间', () => {
    expect(clampFontSize(1)).toBe(13);
    expect(clampFontSize(999)).toBe(24);
    expect(clampFontSize(17)).toBe(17);
  });

  it('取整（滑杆与小步进都可能给出小数）', () => {
    expect(clampFontSize(17.4)).toBe(17);
    expect(clampFontSize(17.6)).toBe(18);
    expect(clampFontSize(-17.6)).toBe(13);
  });

  it('NaN / Infinity 一律退回默认字号，不会把 CSS 写成 NaNpx', () => {
    // `Math.round('huge')` → NaN，而 NaN 会**穿过** Math.min / Math.max，
    // 最后 `--reading-font-size: NaNpx` 无效、字号静默退回浏览器默认值。
    // 所以非有限值不当"越界"处理，直接当垃圾丢掉 —— 越界是用户意图明确、
    // 非有限值是数据坏了，两者不该走同一条路。
    expect(clampFontSize(Number.NaN)).toBe(17);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(17);
    expect(clampFontSize(Number.NEGATIVE_INFINITY)).toBe(17);
  });

  it('永远返回 [13, 24] 内的整数', () => {
    for (const input of [Number.NaN, -1e9, 0, 13, 17.5, 24, 1e9, Number.POSITIVE_INFINITY]) {
      const result = clampFontSize(input);
      expect(Number.isInteger(result), `${input} → ${result} 不是整数`).toBe(true);
      expect(result).toBeGreaterThanOrEqual(13);
      expect(result).toBeLessThanOrEqual(24);
    }
  });
});

describe('isDisplayMode / isTargetLang', () => {
  it('显示模式只认三种', () => {
    expect(isDisplayMode('both')).toBe(true);
    expect(isDisplayMode('dst')).toBe(true);
    expect(isDisplayMode('src')).toBe(true);
    expect(isDisplayMode('BOTH')).toBe(false);
    expect(isDisplayMode('')).toBe(false);
    expect(isDisplayMode(null)).toBe(false);
    expect(isDisplayMode(1)).toBe(false);
  });

  it('目标语言必须是 10 种之一，**en 不在其中**', () => {
    expect(isTargetLang('zh-Hans')).toBe(true);
    expect(isTargetLang('ru')).toBe(true);
    // 这就是那个坑：源语言固定英文，选英文等于不翻译
    expect(isTargetLang('en')).toBe(false);
    expect(isTargetLang('zh')).toBe(false);
    expect(isTargetLang(undefined)).toBe(false);
  });
});

describe('loadPreferences：没有存档时', () => {
  it('用默认值', () => {
    stubStorage();
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('深浅色跟随系统（用户没手动选过时）', () => {
    stubStorage();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(loadPreferences().theme).toBe('dark');

    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(loadPreferences().theme).toBe('light');
  });

  it('没有 matchMedia 的环境（老浏览器 / 测试环境）不报错', () => {
    stubStorage();
    vi.stubGlobal('window', {});
    expect(loadPreferences().theme).toBe('light');
  });
});

describe('loadPreferences：逐字段校验', () => {
  it('正常存档能完整读回', () => {
    stubStorage(stored({ fontSize: 19, mode: 'src', theme: 'dark', targetLang: 'ja' }));
    expect(loadPreferences()).toEqual({ fontSize: 19, mode: 'src', theme: 'dark', targetLang: 'ja' });
  });

  it('字号越界 → 夹回界内', () => {
    stubStorage(stored({ ...DEFAULT_PREFERENCES, fontSize: 1000 }));
    expect(loadPreferences().fontSize).toBe(24);
    stubStorage(stored({ ...DEFAULT_PREFERENCES, fontSize: -5 }));
    expect(loadPreferences().fontSize).toBe(13);
  });

  it('字号是字符串 / null → 回落默认值', () => {
    stubStorage(stored({ ...DEFAULT_PREFERENCES, fontSize: 'huge' }));
    expect(loadPreferences().fontSize).toBe(17);
    stubStorage(stored({ ...DEFAULT_PREFERENCES, fontSize: null }));
    expect(loadPreferences().fontSize).toBe(17);
  });

  it('mode 非法 → 回落 both', () => {
    stubStorage(stored({ ...DEFAULT_PREFERENCES, mode: 'double' }));
    expect(loadPreferences().mode).toBe('both');
  });

  it('theme 非法 → 回落默认（不是系统主题，就是 light）', () => {
    stubStorage(stored({ ...DEFAULT_PREFERENCES, theme: 'sepia' }));
    expect(loadPreferences().theme).toBe('light');
  });

  it('**targetLang 是 en → 回落简体中文**（列表改版后最容易留下的脏值）', () => {
    stubStorage(stored({ ...DEFAULT_PREFERENCES, targetLang: 'en' }));
    expect(loadPreferences().targetLang).toBe('zh-Hans');
  });

  it('缺字段的旧存档也能读，缺的用默认值补', () => {
    stubStorage(stored({ fontSize: 20 }));
    expect(loadPreferences()).toEqual({ ...DEFAULT_PREFERENCES, fontSize: 20 });
  });

  it('多余的字段被忽略（不会混进偏好对象）', () => {
    stubStorage(stored({ ...DEFAULT_PREFERENCES, extra: 'x', legacyMode: 'y' }));
    expect(Object.keys(loadPreferences()).sort()).toEqual(['fontSize', 'mode', 'targetLang', 'theme']);
  });
});

describe('loadPreferences：坏数据不能让应用卡死', () => {
  it('JSON 损坏 → 默认值', () => {
    stubStorage(stored('{不是 JSON'));
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('存档是个数组 / 数字 / null → 默认值', () => {
    for (const value of ['[]', '123', 'null', '"text"']) {
      stubStorage(stored(value));
      expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    }
  });

  it('localStorage 本身抛错（隐私模式 / 配额满）→ 默认值，不往上抛', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError: localStorage is disabled');
      },
      setItem: () => {},
    });
    expect(() => loadPreferences()).not.toThrow();
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('连 localStorage 这个全局都没有时也不炸，退回默认值', () => {
    // 极端情形：某些嵌入式 webview / SSR 环境下压根没有它。
    // 访问 `undefined.getItem` 会抛 TypeError，但那一步在 try 里面。
    vi.stubGlobal('localStorage', undefined);
    expect(() => loadPreferences()).not.toThrow();
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('savePreferences', () => {
  it('写进去的能被 loadPreferences 原样读回（往返一致）', () => {
    stubStorage();
    const prefs = { fontSize: 21, mode: 'dst' as const, theme: 'dark' as const, targetLang: 'ko' as const };
    savePreferences(prefs);
    expect(loadPreferences()).toEqual(prefs);
  });

  it('存的是 JSON，键名固定为 ewr_preferences', () => {
    const { store, setItem } = stubStorage();
    savePreferences(DEFAULT_PREFERENCES);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect([...store.keys()]).toEqual([STORAGE_KEY]);
    expect(JSON.parse(store.get(STORAGE_KEY)!)).toEqual(DEFAULT_PREFERENCES);
  });

  it('写失败（配额满）静默吞掉，不影响本次使用', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(() => savePreferences(DEFAULT_PREFERENCES)).not.toThrow();
  });
});
