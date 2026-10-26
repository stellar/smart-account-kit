import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Typecheck the `*.test-d.ts` type tests with tsc. A type error fails the
    // run, so CI (`pnpm test --run`) catches a public type regression.
    typecheck: {
      enabled: true,
      include: ["src/**/*.test-d.ts"],
      tsconfig: "./tsconfig.typetest.json",
    },
  },
});
