/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { dirname, join } from "path";

/**
 * react-router 7 的 exports 只有 development 条件：不处理的话生产包里带的是
 * 开发版（多出警告与校验代码）。构建时把 react-router 与 react-router/dom
 * 指向它自带的 dist/production 版本。
 */
function reactRouterProductionAliases() {
  const fromDom = createRequire(createRequire(import.meta.url).resolve("react-router-dom"));
  const root = dirname(dirname(dirname(fromDom.resolve("react-router"))));
  return [
    { find: /^react-router$/, replacement: join(root, "dist/production/index.mjs") },
    { find: /^react-router\/dom$/, replacement: join(root, "dist/production/dom-export.mjs") },
  ];
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "~", replacement: fileURLToPath(new URL("./app", import.meta.url)) },
      ...(command === "build" ? reactRouterProductionAliases() : []),
    ],
  },
  server: {
    port: 15173,
    strictPort: true,
  },
  preview: {
    port: 15173,
    strictPort: true,
    host: true,
  },
  build: {
    // 代码分割优化
    rollupOptions: {
      output: {
        // 把 10 KB 以下的公共小块并进会一起加载的块：路由仍按页懒加载，
        // 但少了十几个小文件各自的 gzip 开销，JS 总量约少 5.4 KB
        experimentalMinChunkSize: 10_000,
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");
          if (!normalizedId.includes("/node_modules/")) return;

          const packageName = normalizedId.match(
            /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/,
          )?.[1];

          if (!packageName) return;

          // Keep ReactDOM client in the React chunk. With object-form chunks,
          // Rollup can place this module behind the canvas chunk and force the
          // home page to preload the canvas runtime just to call createRoot().
          if (
            [
              "react",
              "react-dom",
              "scheduler",
              "react-router",
              "react-router-dom",
              "@remix-run/router",
              "@tanstack/query-core",
              "@tanstack/react-query",
              "zustand",
              "use-sync-external-store",
            ].includes(packageName)
          ) {
            return "react-vendor";
          }

          if (packageName === "@xyflow/react" || packageName === "@xyflow/system") {
            return "flow-vendor";
          }
        },
      },
    },
    // 只出 ES2022 语法（Chrome 94+ / Firefox 93+ / Safari 16.4+），省去类字段等降级代码，JS gzip 约少 4.6 KB
    target: "es2022",
    // 启用 CSS 代码分割
    cssCodeSplit: true,
    // Gzip budgets are enforced by scripts/check-bundle-budget.mjs.
    chunkSizeWarningLimit: 600,
    // terser 两遍压缩比 esbuild 小约 3%（gzip），只影响构建耗时
    minify: 'terser',
    terserOptions: {
      compress: { passes: 2 },
      format: { comments: false },
    },
    // 启用源码映射（仅用于错误追踪）
    sourcemap: false,
  },
  // 优化依赖预构建
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      'zustand',
      '@tanstack/react-query',
    ],
  },
  test: {
    globals: true,
    environment: "jsdom",
    maxWorkers: 4,
    setupFiles: "./app/setupTests.ts",
    css: true,
    exclude: ["tests/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "./coverage",
      include: ["app/**/*.{ts,tsx}"],
      exclude: [
        "app/main.tsx",
        "app/vite-env.d.ts",
        "app/types/index.ts",
        "app/mocks",
      ],
    },
  },
}));
