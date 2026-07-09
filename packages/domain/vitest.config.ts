import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "domain",
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
