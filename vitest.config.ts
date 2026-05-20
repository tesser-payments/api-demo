import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Vite/Vitest do not auto-load .env the way Bun does.
  // Load .env (no suffix) for all modes so flow tests get WEBHOOK_SITE_TOKEN.
  const env = loadEnv(mode, process.cwd(), "");

  const seedFromEnv = process.env.VITEST_SEED ?? env.VITEST_SEED;
  const seed = seedFromEnv ? Number(seedFromEnv) : Date.now();

  return {
    test: {
      env,
      include: ["tests/**/*.test.ts"],
      environment: "node",
      // All tests run in a single fork so the shared-state pool is one
      // module instance across all files. fileParallelism is implied but
      // we keep it explicit.
      fileParallelism: false,
      pool: "forks",
      maxWorkers: 1,
      isolate: false,
      // Generous default test timeout for sandbox round-trips with retries.
      testTimeout: 300_000,
      globalSetup: ["./tests/setup/seed-and-summary.ts"],
      sequence: {
        shuffle: {
          files: true,
          tests: true,
        },
        seed,
      },
      server: {
        deps: {
          // @tesser-payments/types uses directory-style ESM imports that
          // Node's native resolver rejects. Force Vite to handle it.
          inline: [/@tesser-payments\/types/],
        },
      },
    },
  };
});
