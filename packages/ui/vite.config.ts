import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Produces packages/ui/dist/index.html as a single self-contained HTML file —
// scripts and styles are inlined. Same artifact is loaded by VS Code's webview
// (via esbuild's text loader → string passed to webview.html) and Tauri's
// renderer in Phase 3.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    target: "es2020",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
