import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "test/**/*.test.ts",
      "action/src/**/*.test.ts",
      "github/**/*.test.ts",
      "app/src/**/*.test.ts",
      "web/src/**/*.test.ts",
    ],
  },
});
