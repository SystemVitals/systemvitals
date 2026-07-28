import { describe, it, expect } from "vitest";
import { isBlockedHost, assertTargetAllowed } from "../src/ssrf.js";
import { probe } from "../src/prober.js";

describe("isBlockedHost — IPv4 private/reserved ranges", () => {
  it("blocks loopback 127.0.0.1", () => {
    expect(isBlockedHost("127.0.0.1")).toBe(true);
  });

  it("blocks 10.1.2.3 (private 10/8)", () => {
    expect(isBlockedHost("10.1.2.3")).toBe(true);
  });

  it("blocks 192.168.0.1 (private 192.168/16)", () => {
    expect(isBlockedHost("192.168.0.1")).toBe(true);
  });

  it("blocks 172.16.5.5 (private 172.16/12)", () => {
    expect(isBlockedHost("172.16.5.5")).toBe(true);
  });

  it("blocks 169.254.169.254 (link-local / metadata)", () => {
    expect(isBlockedHost("169.254.169.254")).toBe(true);
  });

  it("blocks 0.0.0.0 (unspecified)", () => {
    expect(isBlockedHost("0.0.0.0")).toBe(true);
  });

  it("blocks 0.1.2.3 (0.0.0.0/8 loopback bypass)", () => {
    expect(isBlockedHost("0.1.2.3")).toBe(true);
  });

  it("allows 8.8.8.8 (public)", () => {
    expect(isBlockedHost("8.8.8.8")).toBe(false);
  });

  it("allows 1.1.1.1 (public)", () => {
    expect(isBlockedHost("1.1.1.1")).toBe(false);
  });
});

describe("isBlockedHost — IPv6 reserved", () => {
  it("blocks ::1 (loopback)", () => {
    expect(isBlockedHost("::1")).toBe(true);
  });

  it("blocks :: (unspecified)", () => {
    expect(isBlockedHost("::")).toBe(true);
  });

  it("blocks fc00::1 (ULA fc00::/7)", () => {
    expect(isBlockedHost("fc00::1")).toBe(true);
  });

  it("blocks fd00::1 (ULA fd00::/7)", () => {
    expect(isBlockedHost("fd00::1")).toBe(true);
  });

  it("blocks fe80::1 (link-local fe80::/10)", () => {
    expect(isBlockedHost("fe80::1")).toBe(true);
  });
});

describe("isBlockedHost — IPv4-mapped / NAT64 IPv6", () => {
  it("blocks ::ffff:169.254.169.254 (dotted-quad IPv4-mapped metadata)", () => {
    expect(isBlockedHost("::ffff:169.254.169.254")).toBe(true);
  });

  it("blocks ::ffff:7f00:1 (hex IPv4-mapped 127.0.0.1)", () => {
    expect(isBlockedHost("::ffff:7f00:1")).toBe(true);
  });

  it("allows ::ffff:8.8.8.8 (public via IPv4-mapped)", () => {
    expect(isBlockedHost("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("assertTargetAllowed", () => {
  it("resolves for a public IP URL (allowPrivate=false)", async () => {
    // Call with explicit false — bypasses env and asserts blocking logic directly
    await expect(assertTargetAllowed("http://8.8.8.8/x", false)).resolves.toBeUndefined();
  });

  it("rejects for a private IP URL (allowPrivate=false)", async () => {
    await expect(assertTargetAllowed("http://127.0.0.1/x", false)).rejects.toThrow(/blocked/i);
  });

  it("resolves for a private IP URL when allowPrivate=true", async () => {
    await expect(assertTargetAllowed("http://127.0.0.1/x", true)).resolves.toBeUndefined();
  });

  it("rejects for 169.254.169.254 (allowPrivate=false)", async () => {
    await expect(assertTargetAllowed("http://169.254.169.254/", false)).rejects.toThrow(/blocked/i);
  });

  it("rejects for 10.0.0.1 (allowPrivate=false)", async () => {
    await expect(assertTargetAllowed("http://10.0.0.1/", false)).rejects.toThrow(/blocked/i);
  });

  it("rejects http://[::ffff:169.254.169.254]/ (IPv4-mapped metadata, allowPrivate=false)", async () => {
    await expect(assertTargetAllowed("http://[::ffff:169.254.169.254]/", false)).rejects.toThrow(/blocked/i);
  });
});

describe("probe SSRF integration — blocked target degrades to failed probe", () => {
  it("probe HTTP to 169.254.169.254 with allowPrivate=false → up:false, error contains 'blocked'", async () => {
    const result = await probe(
      { type: "HTTP", target: "http://169.254.169.254/", timeoutMs: 2000 },
      false,
    );
    expect(result.up).toBe(false);
    expect(result.error).toMatch(/blocked/i);
  });

  it("probe TCP to 127.0.0.1:9 with allowPrivate=false → up:false, error contains 'blocked'", async () => {
    const result = await probe(
      { type: "TCP", target: "127.0.0.1:9", timeoutMs: 2000 },
      false,
    );
    expect(result.up).toBe(false);
    expect(result.error).toMatch(/blocked/i);
  });
});
