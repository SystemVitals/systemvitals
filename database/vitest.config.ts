import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://systemvitals:systemvitals@localhost:5432/systemvitals?schema=public",
    },
    testTimeout: 30000,
  },
});
