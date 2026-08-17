// Backend-only ESLint config (no React/Tailwind/Vite rules).
// Mirrors the server block of the original unified repo's eslint.config.js.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { createNodeResolver, importX } from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import boundaries from "eslint-plugin-boundaries";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist-server/**", "node_modules/**"],
  },
  {
    files: ["server/**/*.{js,ts}"],
    ignores: ["server/**/*.d.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: {
      boundaries,
      "import-x": importX,
      "unused-imports": unusedImports,
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    settings: {
      "import-x/resolver-next": createTypeScriptImportResolver(
        createNodeResolver(),
        {
          project: ["server/tsconfig.json"],
          pathFilter: [{ from: "server", to: "server" }],
        }
      ),
      "boundaries/include": ["server/**/*.{js,ts}"],
      "boundaries/elements": [
        {
          type: "shared",
          pattern: ["server/shared/*.{js,ts}", "shared/*.{js,ts}"],
        },
        {
          type: "backend-module",
          pattern: "server/modules/*",
        },
      ],
    },
    rules: {
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": [
        "warn",
        { vars: "all", varsIgnorePattern: "^_", args: "after-used", argsIgnorePattern: "^_" },
      ],
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "boundaries/no-unknown": "warn",
    },
  }
);
