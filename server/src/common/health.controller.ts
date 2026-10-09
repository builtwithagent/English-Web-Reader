import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `GET /api/health` —— 探活 + "配置到底从哪来"的自检。
 *
 * 为什么需要它：发布沙箱是黑盒。曾经出现过"本地 `.env` 里的统计密码能登录、
 * 线上同一个请求头却被拒"的情况，从外面看不出问题在哪，只能让应用自己回报。
 * 那次排查的结论是发布网关会覆盖 `Authorization` 头（见 `stats/stats.auth.ts`），
 * 于是这里曾经还回报过"收到了哪些请求头"—— 定位完就删掉了，只留下长期有用的部分。
 *
 * **它绝不回显任何密钥值**，只报三类信息：
 *   1. 存在性：文件在不在、键在不在、mtime
 *   2. 长度：生效值多长、文件里那份多长
 *   3. 一致性布尔：生效值是不是就等于文件里那份 / 进程环境里那份
 * 这三类都不构成泄漏："长度"是判断"线上用的是不是我这一份"最直接的证据，
 * 而知道一个 key 有多长没有利用价值；"是否相同"是一次服务端内部比较。
 */
const KEYS = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'STATS_USER', 'STATS_PASSWORD'];

/**
 * 按 dotenv 的宽松规则解析 `.env`，只为回答"文件里那个值跟生效值是不是同一个"。
 *
 * 为什么自己写而不引 `dotenv`：它是 `@nestjs/config` 的传递依赖，直接 import 能用，
 * 但这份诊断代码不值得为一个临时用途引入隐性依赖；规则就这几条，够用且可读。
 * 解析结果**不出函数**：调用方只拿到 sha256 比对的结果。
 */
function readEnvValues(path: string): Map<string, string> {
  const values = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return values;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*export\s+/, '');
    const m = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;

    let value = m[2].trim();
    const quoted = /^["'`]/.test(value);
    // 没加引号时，`#` 之后是注释（加引号的才允许值里带 `#`）
    if (!quoted) {
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (quoted && value.length > 1 && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    values.set(m[1], value);
  }
  return values;
}

/** 只比"等不等"，两个值都只进哈希，不返回任何可打印形态 */
function sameDigest(a: string, b: string): boolean {
  return createHash('sha256').update(a, 'utf8').digest().equals(createHash('sha256').update(b, 'utf8').digest());
}

function probe(path: string): { exists: boolean; mtime?: string } {
  try {
    const stat = statSync(path);
    return { exists: stat.isFile(), mtime: stat.mtime.toISOString() };
  } catch {
    return { exists: false };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  get() {
    const cwd = process.cwd();
    const envPath = join(cwd, '.env');
    const fileValues = readEnvValues(envPath);

    return {
      ok: true,
      /** 进程的工作目录最后一段（应当是 `server`；不是的话说明启动方式变了） */
      cwdTail: cwd.split(/[\\/]/).filter(Boolean).pop() ?? '',
      /** 前端产物在不在（在 = 同源托管生效） */
      webDistMounted: existsSync(join(cwd, '..', 'web', 'dist', 'index.html')),

      /**
       * 四个探针，专门用来分辨"点开头的文件"和"被 .gitignore 挡住的文件"
       * 分别会不会被上传 —— 两个维度各取一个样本：
       *   .npmrc          点开头 + 已入库
       *   package.json    不带点 + 已入库
       *   .env            点开头 + 被 gitignore
       *   data/stats.json 不带点 + 被 gitignore
       */
      files: [
        { path: '.npmrc', ...probe(join(cwd, '.npmrc')) },
        { path: 'package.json', ...probe(join(cwd, 'package.json')) },
        { path: '.env', ...probe(envPath) },
        { path: 'data/stats.json', ...probe(join(cwd, 'data', 'stats.json')) },
      ],

      keys: KEYS.map((key) => {
        const raw = process.env[key];
        // ConfigService 是应用真正用的那个值（.env 文件与进程环境谁赢，由它决定）
        const effective = this.config.get<string>(key) ?? '';
        const fromFile = fileValues.get(key) ?? '';
        return {
          key,
          inProcessEnv: raw !== undefined,
          inEnvFile: fileValues.has(key),
          effectiveLen: effective.trim().length,
          fileLen: fromFile.trim().length,
          /**
           * 生效值 == `.env` 文件里那一份？
           * 为 false 说明**别处把这个键注进来了**（dotenv 不覆盖已存在的进程环境变量），
           * 那就是"同一份文件、同一份代码、结果却不同"的答案。
           */
          effectiveEqualsFile: sameDigest(effective, fromFile),
          effectiveEqualsProcessEnv: sameDigest(effective, raw ?? ''),
        };
      }),
    };
  }
}
