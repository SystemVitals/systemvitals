import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const organizationRoute = resolve(testDirectory, "../app/(app)/[org]");

describe("organization check route tree", () => {
  it("uses one shared second-level dynamic segment name", () => {
    const dynamicSegments = readdirSync(organizationRoute, {
      withFileTypes: true,
    })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith("[") &&
          entry.name.endsWith("]"),
      )
      .map((entry) => entry.name)
      .sort();

    expect(dynamicSegments).toEqual(["[check]"]);
    expect(
      existsSync(
        resolve(organizationRoute, "[check]/[legacyCheck]/page.tsx"),
      ),
    ).toBe(true);
  });
});
