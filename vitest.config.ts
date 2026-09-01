import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "packages/vaulltcore-web/src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./packages/vaulltcore-web/src/test/setup.ts"],
  },
});
