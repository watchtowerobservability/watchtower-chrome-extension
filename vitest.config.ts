import { defineConfig } from "vitest/config";
import { alias } from "./aliases.mjs";

export default defineConfig({
  resolve: { alias },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
