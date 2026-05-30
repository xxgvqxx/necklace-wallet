import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Ignore macOS AppleDouble resource-fork siblings (._*) on this volume.
    exclude: ["**/node_modules/**", "**/dist/**", "**/._*"],
  },
});
