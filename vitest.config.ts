import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Flow tests share one webhook.site token and the sandbox is sequential
    // by design. Parallel file execution would interleave webhook arrivals.
    fileParallelism: false,
    // Generous default test timeout for sandbox round-trips with retries.
    testTimeout: 300_000,
    server: {
      deps: {
        // @tesser-payments/types uses directory-style ESM imports that
        // Node's native resolver rejects. Force Vite to handle it.
        inline: [/@tesser-payments\/types/],
      },
    },
  },
});
