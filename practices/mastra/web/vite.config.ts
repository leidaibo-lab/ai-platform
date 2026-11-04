import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** 浏览器仅访问同源路由；代理目标固定本机，不加载实践的服务端 .env。 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/review-api": { target: "http://127.0.0.1:4111", changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      "/review-api": { target: "http://127.0.0.1:4111", changeOrigin: true },
    },
  },
});
