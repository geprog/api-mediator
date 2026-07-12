import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "transform",
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
