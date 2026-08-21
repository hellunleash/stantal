import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Real models never run here. Layer 2's live suite is separate and opt-in.
    testTimeout: 10_000,
  },
});
