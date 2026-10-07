import { defineConfig } from 'vitest/config';

/**
 * 单测配置（后端）。
 *
 * 用 Vitest 而不是 Jest，原因是**编译器**：
 * 这个工程用的是 TypeScript 7，而 Jest 生态里唯一成熟的 TS 通道 `ts-jest`
 * 依赖 TS 的编程式编译器 API —— 那正是 TS 7 移除掉的东西（`nest build` 也是
 * 因此用不了的，见 docs 的 §2.1）。Vitest 走 esbuild 只做转译、不做类型检查，
 * 与 TS 版本完全解耦，升级 TS 不会把测试一起拖垮。
 *
 * 代价：**测试文件不做类型检查**（esbuild 只剥类型）。类型正确性由
 * `npm run typecheck` 保证 —— 它扫 `src/**`，与测试分开。
 *
 * 测试放 `test/` 而不是 `src/`：`tsconfig.json` 的 include 只有 `src/**\/*`，
 * 放 src 里会被 `tsc -p` 编译进 `dist/`（发布产物里混进测试代码）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 单测必须能离线跑、且不受环境变量影响：
    // 环境里注入的 http_proxy 曾把本地请求截走（踩过），这里直接清掉，
    // 免得哪天有个测试真的发请求、结果被判成"上游不可达"。
    env: {
      http_proxy: '',
      https_proxy: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      NO_PROXY: '*',
    },
  },
});
