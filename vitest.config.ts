import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The service ships in this repository and holds the receiving half of
    // the provider direction's privacy rule. A boundary nothing exercises is
    // one nobody notices breaking.
    include: ["src/**/*.test.ts", "service/**/*.test.mjs"],
    // Real models never run here. Layer 2's live suite is separate and opt-in.
    testTimeout: 10_000,
  },
});
