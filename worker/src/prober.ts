import * as net from "node:net";
import { config } from "./config.js";
import { assertTargetAllowed } from "./ssrf.js";

export interface ProbeResult {
  up: boolean;
  responseTimeMs: number;
  statusCode?: number;
  error?: string;
}

interface CheckLike {
  type: string;
  target: string | null | undefined;
  method?: string | null;
  expectedStatus?: number | null;
  timeoutMs?: number | null;
}

export async function probe(
  check: CheckLike,
  allowPrivate: boolean = config.ssrfAllowPrivate,
): Promise<ProbeResult> {
  if (check.type === "HTTP") {
    return probeHttp(check, allowPrivate);
  } else if (check.type === "TCP") {
    return probeTcp(check, allowPrivate);
  }
  return {
    up: false,
    responseTimeMs: 0,
    error: `Unsupported probe type: ${check.type}`,
  };
}

async function probeHttp(check: CheckLike, allowPrivate: boolean): Promise<ProbeResult> {
  const start = Date.now();
  const target = check.target ?? "";

  // Guard against missing/empty target
  if (!target) {
    return {
      up: false,
      responseTimeMs: 0,
      error: "missing target",
    };
  }

  // SSRF guard — blocked targets degrade to a failed probe (no throw out)
  try {
    await assertTargetAllowed(target, allowPrivate);
  } catch {
    return { up: false, responseTimeMs: 0, error: "blocked target" };
  }

  const method = check.method ?? "GET";
  const timeoutMs = check.timeoutMs ?? 10000;

  try {
    const res = await fetch(target, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    const responseTimeMs = Date.now() - start;
    const statusCode = res.status;

    let up: boolean;
    if (check.expectedStatus != null) {
      up = statusCode === check.expectedStatus;
    } else {
      up = statusCode >= 200 && statusCode < 400;
    }

    res.body?.cancel();
    return { up, responseTimeMs, statusCode };
  } catch (err: unknown) {
    const responseTimeMs = Date.now() - start;
    return {
      up: false,
      responseTimeMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeTcp(check: CheckLike, allowPrivate: boolean): Promise<ProbeResult> {
  const target = check.target ?? "";

  // Guard against missing/empty target
  if (!target) {
    return {
      up: false,
      responseTimeMs: 0,
      error: "missing target",
    };
  }

  const timeoutMs = check.timeoutMs ?? 10000;

  // Parse host:port from target
  const lastColon = target.lastIndexOf(":");
  const host = target.slice(0, lastColon);
  const port = parseInt(target.slice(lastColon + 1), 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    return { up: false, responseTimeMs: 0, error: "invalid port" };
  }

  // SSRF guard — blocked targets degrade to a failed probe (no throw out)
  try {
    await assertTargetAllowed(`http://${host}:${port}`, allowPrivate);
  } catch {
    return { up: false, responseTimeMs: 0, error: "blocked target" };
  }

  return new Promise<ProbeResult>((resolve) => {
    const start = Date.now();
    const socket = net.connect({ host, port });

    socket.setTimeout(timeoutMs);

    let settled = false;

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.on("connect", () => {
      finish({ up: true, responseTimeMs: Date.now() - start });
    });

    socket.on("error", (err: Error) => {
      finish({
        up: false,
        responseTimeMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    socket.on("timeout", () => {
      finish({
        up: false,
        responseTimeMs: Date.now() - start,
        error: "TCP connection timed out",
      });
    });
  });
}
