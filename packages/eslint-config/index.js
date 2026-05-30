// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Shared flat ESLint config for all Necklace workspaces.
 * Consumers spread this and may append framework-specific overrides.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/*.config.js",
      "**/*.config.ts",
      // macOS AppleDouble resource-fork siblings created on exFAT/network volumes.
      "**/._*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Secrets must never be logged; flag stray console use outside warn/error.
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
);
