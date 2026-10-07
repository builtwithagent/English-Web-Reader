import { defineConfig } from 'vitest/config';

/**
 * 单测配置（前端）。
 *
 * 与后端那份是同一套思路：用 Vitest（走 esbuild 转译）而不是 Jest，
 * 这样测试与 TypeScript 版本解耦 —— 这个工程用的是 TS 7，Jest 生态的
 * `ts-jest` 依赖 TS 的编程式编译器 API，而那个 API 在 TS 7 里已经没了。
 *
 * **环境是 node 不是 jsdom**：这里测的是纯逻辑（导出 Markdown、SSE 分帧、
 * 偏好读写、契约对照），不是渲染。界面的对错由 `npm run shot`
 * （无头 Chrome 跑真实页面 + 布局断言）负责，那比 jsdom 里的组件快照可信得多。
 *
 * 测试与源码同目录（`src/**\/*.test.ts`），因为它们本来就不进打包 ——
 * Vite 只从 index.html 出发找模块，测试文件不在那条链上。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 单测必须能离线跑、且不受环境变量影响：环境里注入的 http_proxy
    // 曾经把对本机服务的请求截走（踩过），这里直接清干净。
    env: {
      http_proxy: '',
      https_proxy: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      NO_PROXY: '*',
    },
  },
});
