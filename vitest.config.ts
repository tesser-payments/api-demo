import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    server: {
      deps: {
        // @tesser-payments/types uses directory-style ESM imports that Node's
        // native resolver rejects. Force Vite to handle it.
        inline: [/@tesser-payments\/types/],
      },
    },
  },
});
