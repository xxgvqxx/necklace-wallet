import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Golden-fixture KAT tests live in tests/; co-located unit tests in src/.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Ignore macOS AppleDouble resource-fork siblings (._*) on this volume.
    exclude: ["**/node_modules/**", "**/dist/**", "**/._*"],
    passWithNoTests: true,
  },
});
