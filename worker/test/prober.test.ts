import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { probe } from "../src/prober.js";

// Ephemeral server helpers
let currentServer: http.Server | net.Server | null = null;

afterEach(async () => {
  if (currentServer) {
    await new Promise<void>((resolve) => currentServer!.close(() => resolve()));
    currentServer = null;
  }
});

async function startHttpServer(
  handler: http.RequestListener,
): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    currentServer = server;
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve(addr.port);
    });
  });
}

async function startTcpServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    currentServer = server;
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve(addr.port);
    });
  });
}

describe("probe — HTTP", () => {
  it("returns up=true, statusCode=200, responseTimeMs>=0 for a 200 server", async () => {
    const port = await startHttpServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    const result = await probe({
      type: "HTTP",
      target: `http://127.0.0.1:${port}`,
      timeoutMs: 2000,
    });

    expect(result.up).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("returns up=false, statusCode=500 when server returns 500 and expectedStatus=200", async () => {
    const port = await startHttpServer((_req, res) => {
      res.writeHead(500);
      res.end("error");
    });

    const result = await probe({
      type: "HTTP",
      target: `http://127.0.0.1:${port}`,
      timeoutMs: 2000,
      expectedStatus: 200,
    });

    expect(result.up).toBe(false);
    expect(result.statusCode).toBe(500);
  });

  it("returns up=true, statusCode=200 when server returns 200 and expectedStatus=200", async () => {
    const port = await startHttpServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    const result = await probe({
      type: "HTTP",
      target: `http://127.0.0.1:${port}`,
      timeoutMs: 2000,
      expectedStatus: 200,
    });

    expect(result.up).toBe(true);
    expect(result.statusCode).toBe(200);
  });
});

describe("probe — TCP", () => {
  it("returns up=true for a listening TCP server", async () => {
    const port = await startTcpServer();

    const result = await probe({
      type: "TCP",
      target: `127.0.0.1:${port}`,
      timeoutMs: 2000,
    });

    expect(result.up).toBe(true);
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("returns up=false with an error for an unused port", async () => {
    // Pick a port that should be unoccupied by binding briefly then releasing
    const tmpServer = net.createServer();
    const tmpPort = await new Promise<number>((resolve) => {
      tmpServer.listen(0, "127.0.0.1", () => {
        const addr = tmpServer.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });
    // Close immediately so the port is free (connection refused)
    await new Promise<void>((resolve) => tmpServer.close(() => resolve()));

    const result = await probe({
      type: "TCP",
      target: `127.0.0.1:${tmpPort}`,
      timeoutMs: 2000,
    });

    expect(result.up).toBe(false);
    expect(result.error).toBeDefined();
  });
});
