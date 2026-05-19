import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Vite/Vitest do not auto-load .env the way Bun does.
  // Load .env (no suffix) for all modes so flow tests get WEBHOOK_SITE_TOKEN.
  const env = loadEnv(mode, process.cwd(), "");

  return {
    test: {
      env,
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
  };
});
