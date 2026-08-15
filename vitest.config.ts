import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "offchain/**/*.test.ts",
      "examples/**/*.test.ts",
      "examples/**/*.test.tsx",
    ],
    exclude: ["lib/**", "ref/**", "node_modules/**", "dist/**"],
    environment: "node",
    passWithNoTests: false,
  },
});
