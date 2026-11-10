import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.nyc_output/**",
      "**/.healing/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { ecmaVersion: "latest" },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      ...js.configs.recommended.rules,
      // Storage and focus recovery intentionally tolerate unavailable browser APIs.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: [
      "apps/healing-hub/**/*.{js,mjs,cjs}",
      "scripts/**/*.{js,mjs,cjs}",
      "tests/**/*.{js,mjs,cjs}",
      "*.config.{js,mjs,cjs}",
    ],
    languageOptions: { globals: globals.nodeBuiltin },
  },
  {
    files: ["apps/console/public/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["tests/console-task-controller.test.mjs"],
    // This Node test explicitly installs and restores its own document mock.
    languageOptions: { globals: { document: "readonly" } },
  },
];
