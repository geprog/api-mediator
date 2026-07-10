import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "ir",
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
