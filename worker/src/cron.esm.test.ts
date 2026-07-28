import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Vitest transforms modules through its own bundler, which papers over CommonJS
 * interop mistakes. Production runs `tsx cli/worker.ts` as native ESM, where a
 * named import of a CJS-only export is a hard link-time SyntaxError. Load the
 * module the way production does so that class of bug cannot pass CI again.
 */
describe("cron module under native ESM", () => {
  it("loads and evaluates when imported by tsx, as the worker does", () => {
    const stdout = execFileSync(
      path.join(workerRoot, "node_modules/.bin/tsx"),
      [
        "--eval",
        `import("./src/cron.ts").then((m) => {
           console.log(m.nextCronFire("0 3 * * *", "UTC", new Date("2026-01-01T00:00:00Z")).toISOString());
         });`,
        "--tsconfig",
        path.join(workerRoot, "tsconfig.json"),
      ],
      { cwd: workerRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(stdout.trim()).toBe("2026-01-01T03:00:00.000Z");
  });
});
