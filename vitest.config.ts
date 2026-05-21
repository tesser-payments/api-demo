import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

// Suppress the noisy "Sourcemap for ... points to a source file outside
// its package" warnings emitted by Vite for @tesser-payments/types
// (whose published sourcemaps reference a /src/ path that doesn't ship
// in the package). Filed-but-unfixed upstream; the warnings add zero
// signal here. Vite emits these via console.warn, so we patch it.
const _origConsoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.startsWith("Sourcemap for ")) return;
  _origConsoleWarn(...args);
};

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
      setupFiles: ["./tests/setup/suppress-sourcemap-warnings.ts"],
      // The custom reporter is the only one. Drop "default" so the matrix
      // (one row per how-to × provider × currency × network) stays the
      // prominent thing in the log, not interleaved per-test stdout.
      reporters: ["./tests/setup/test-plan-reporter.ts"],
      // Hide example console.log during passing tests; on failure vitest
      // still prints captured stdout so diagnostics stay accessible.
      silent: "passed-only",
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
