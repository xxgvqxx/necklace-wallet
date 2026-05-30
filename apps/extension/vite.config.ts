import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json" with { type: "json" };

/**
 * MV3 build via @crxjs. The popup (index.html) and the background service
 * worker declared in manifest.json are the build entrypoints. No remote code:
 * everything is bundled locally and the manifest CSP forbids remote script/wasm.
 */
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      // Keep output deterministic-ish; crx manages most entry wiring.
      output: {
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    // Stable HMR port for the MV3 dev workflow.
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
