import { describe, expect, it } from "vitest";

import { GET, dynamic, revalidate } from "./route";

describe("GET /api/health", () => {
  it("returns the public frontend health status without caching", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "frontend",
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).toContain("max-age=0");
  });

  it("is always handled dynamically", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(revalidate).toBe(0);
  });
});
