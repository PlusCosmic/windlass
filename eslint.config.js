import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default [
  globalIgnores(["**/dist/**", "**/coverage/**", "**/node_modules/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
];
