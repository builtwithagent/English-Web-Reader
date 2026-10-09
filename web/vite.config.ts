import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发期：Vite（5173）把 /api/* 代理给 Nest（3000）。
 *
 * 前端代码里**只写同源相对路径** `/api/...`，绝不写 `http://localhost:3000` ——
 * 开发期的跨域交给这里的 proxy，发布期由 Nest 同源托管天然解决。
 * 一份代码两处跑，不用改任何配置（技术方案 7.1）。
 *
 * 端口可以用环境变量改：`npm run shot` 的端口预检在 3000/5173 被占时会直接
 * 拒绝启动（那是刻意的，见 scripts/lib/cdp.mjs），而"被占"往往只是
 * 开发机上还开着一个本地服务。这时换一组端口跑自检就行，
 * 不必去杀别人的进程。两个变量成对使用，见 scripts/shot.mjs 顶部。
 */
/**
 * web 这边的 `tsconfig` 是**浏览器环境**（`types: ["vite/client"]`，没有 node 类型），
 * 而这个配置文件跑在 Node 里。为了读两个环境变量在这儿声明一下，
 * 比往 web 里塞 `@types/node` 干净 —— 那一整套 `fs` / `net` 的类型
 * 出现在浏览器代码里只会误导人（`types.ts` 里那句"纯浏览器环境"是真的在守）。
 */
declare const process: { env: Record<string, string | undefined> };

const apiPort = Number(process.env.VITE_API_PORT ?? 3000);
const port = Number(process.env.VITE_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
