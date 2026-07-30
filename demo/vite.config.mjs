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
  },
});
