import js from "@eslint/js";
import eslintPluginSvelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";
import svelteParser from "svelte-eslint-parser";
import svelteConfig from "./svelte.config.js";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...eslintPluginSvelte.configs["flat/recommended"],
  {
    files: ["src/**/*.svelte", "src/**/*.svelte.ts"],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        svelteConfig,
      },
    },
    rules: {
      // TypeScript / svelte-check 已校验未定义符号；no-undef 不认识 DOM 全局。
      "no-undef": "off",
    },
  },
  {
    files: ["src/**/*.ts", "src/**/*.svelte"],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: [".svelte"],
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    ignores: ["out/**", "node_modules/**"],
  },
);
