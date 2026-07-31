import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const demoDir = dirname(fileURLToPath(import.meta.url));

/** 为渠道页面提供独立构建目录，并在开发模式转发既有 Runtime API。 */
export default defineConfig({
  root: demoDir,
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4010",
    },
  },
  build: {
    outDir: resolve(demoDir, "dist"),
    emptyOutDir: true,
    // Rollup 原始体积提示按设计系统块放宽；真正门禁由 gzip 单块和总量脚本执行。
    chunkSizeWarningLimit: 760,
    rollupOptions: {
      output: {
        /** 按稳定依赖域拆分缓存块，避免渠道代码变化使全部 vendor 失效。 */
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
          if (/node_modules\/(@ant-design\/x-markdown|marked|dompurify|shiki|highlight.js)\//.test(id)) {
            return "vendor-markdown";
          }
          if (/node_modules\/@ant-design\/x\//.test(id)) return "vendor-ant-x";
          if (/node_modules\/(antd|@ant-design\/icons|rc-|@rc-component)\//.test(id)) return "vendor-design";
          return undefined;
        },
      },
    },
  },
});
