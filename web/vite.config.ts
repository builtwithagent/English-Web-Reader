import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发期：Vite（5173）把 /api/* 代理给 Nest（3000）。
 *
 * 前端代码里**只写同源相对路径** `/api/...`，绝不写 `http://localhost:3000` ——
 * 开发期的跨域交给这里的 proxy，发布期由 Nest 同源托管天然解决。
 * 一份代码两处跑，不用改任何配置（技术方案 7.1）。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
