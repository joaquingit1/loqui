// Flat ESLint config shared across all workspaces (ESLint walks up to find it,
// so each workspace's `eslint .` uses this single source of truth). Kept
// deliberately lean: TypeScript recommended rules (non-type-checked, so it runs
// without project resolution) plus Prettier to turn off formatting rules that
// would conflict with `prettier --check`.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // Build output, deps, emitted artifacts, and non-source dirs.
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      "**/coverage/**",
      "packages/shared/schema/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow intentionally-unused args/vars that are prefixed with `_`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Node-driven scripts and config files run outside the type system.
  {
    files: ["**/*.mjs", "**/*.cjs", "**/*.config.js", "scripts/**"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly" },
    },
  },
  prettier,
);
