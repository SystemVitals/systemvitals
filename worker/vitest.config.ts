import { defineConfig } from "vitest/config";

/**
 * These are integration tests against a real database: they CREATE and
 * `deleteMany` organizations, projects, checks and events.
 *
 * The default therefore names `systemvitals_test`, a database that exists only
 * to be written to — never `systemvitals`, which on a developer's machine is
 * their working dev database. Hardcoding that name here previously meant
 * `npx vitest run` wrote into whatever the developer happened to be working on.
 *
 * CI points DATABASE_URL at its own throwaway service container, and anyone
 * wanting a different target can do the same:
 *
 *   DATABASE_URL=postgresql://…/my_scratch_db npx vitest run
 */
const DEFAULT_TEST_DATABASE_URL =
  "postgresql://systemvitals:systemvitals@localhost:5432/systemvitals_test?schema=public";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
      SSRF_ALLOW_PRIVATE: "true",
    },
  },
});
