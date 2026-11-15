import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import uiPlugin from "@pluscosmic/ui/eslint";

export default [
  globalIgnores(["**/dist/**", "**/coverage/**", "**/node_modules/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // The editor's words live in web/src/copy/, so they can be reviewed in one place.
    files: ["web/src/**/*.tsx"],
    ignores: ["web/src/copy/**"],
    plugins: { ui: uiPlugin },
    rules: { "ui/no-jsx-copy": "error" },
  },
];
