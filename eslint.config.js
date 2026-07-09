// Flat config (ESLint 9). The repo installs @typescript-eslint/parser + eslint-plugin directly
// (not the combined `typescript-eslint` package), so they are wired up by hand here. Kept minimal:
// it lints src/**/*.ts for genuinely dead code and a few correctness-leaning rules, and leaves the
// dynamically-typed Graph/Helpdesk boundaries (`any`) alone.
const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");

module.exports = [
  {
    ignores: ["build/**", "node_modules/**", "coverage/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // Catch dead code; allow intentional throwaways named with a leading underscore (e.g. _timer).
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // The Graph/Helpdesk HTTP boundaries are deliberately typed `any`.
      "@typescript-eslint/no-explicit-any": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      eqeqeq: ["error", "smart"],
    },
  },
];
