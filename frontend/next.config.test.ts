import { describe, expect, it } from "vitest";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import nextConfig from "./next.config";

describe("Legacy hostname redirect", () => {
  it.each([
    ["/", "https://systemvitals.link/"],
    ["/privacy", "https://systemvitals.link/privacy"],
    [
      "/status/production?source=legacy",
      "https://systemvitals.link/status/production?source=legacy",
    ],
  ])("permanently redirects %s while preserving the request path", async (path, expected) => {
    const response = await unstable_getResponseFromNextConfig({
      url: `https://systemvitals.nihey.org${path}`,
      nextConfig,
    });

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(expected);
  });

  it("does not redirect the canonical hostname", async () => {
    const response = await unstable_getResponseFromNextConfig({
      url: "https://systemvitals.link/privacy",
      nextConfig,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("Next response headers", () => {
  it.each([
    ["/login?next=%2Fchannels%2Ftelegram%2Fconnect%3Ftoken%3Dsecret", "no-referrer"],
    ["/channels/telegram/connect?token=secret", "no-referrer"],
    ["/verify-email?token=secret", "no-referrer"],
    ["/dashboard", "strict-origin-when-cross-origin"],
  ])("resolves %s to Referrer-Policy %s", async (path, expectedPolicy) => {
    const response = await unstable_getResponseFromNextConfig({
      url: `https://app.example.test${path}`,
      nextConfig,
    });

    expect(response.headers.get("referrer-policy")).toBe(expectedPolicy);
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
