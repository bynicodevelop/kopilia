// ESLint : les règles recommandées (JavaScript et TypeScript), plus celles qui
// attrapent de vrais bugs dans ce projet (promesse oubliée). Pas de règle de
// style : la forme relève de Prettier.
// NB : pas de consistent-type-imports. Avec les métadonnées de décorateurs de
// NestJS, un import de classe changé en « import type » casserait l'injection.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.angular/**",
      "models/**",
      "data/**",
      "vendor/**",
      "workers/whisper/bin/**",
      "workers/kokoro/.venv/**",
      ".claude/**",
      // Application Mac : compilation Rust et schémas générés par Tauri
      "apps/desktop/src-tauri/target/**",
      "apps/desktop/src-tauri/gen/**",
      "apps/desktop/waiting/orb.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["apps/server/tsconfig.test.json", "apps/web/tsconfig.test.json", "apps/web/tsconfig.app.json", "packages/contracts/tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Une promesse ni attendue ni marquée « void » : une erreur qui disparaîtrait en silence.
      // Les test() de node:test sont suivis par le lanceur de tests lui-même.
      "@typescript-eslint/no-floating-promises": [
        "error",
        { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it", "suite"] }] },
      ],
      // « const { [id]: _, ...rest } » : écarter une clé en la nommant « _ » est voulu.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        URL: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        performance: "readonly",
        sampleRate: "readonly",
        currentFrame: "readonly",
        registerProcessor: "readonly",
        AudioWorkletProcessor: "readonly",
      },
    },
  },
);
