import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    // Ignore macOS AppleDouble resource-fork siblings (._*) on this volume.
    exclude: ["**/node_modules/**", "**/dist/**", "**/._*"],
    // Feature agents add the tests; tolerate none until then.
    passWithNoTests: true,
  },
});
