import type { Mailer } from "./mailer.js";
import { config } from "./config.js";
import { assertTargetAllowed } from "./ssrf.js";

export interface NotifyMessage {
  subject: string;
  text: string;
  kind: "down" | "recovery";
  check: { id: string; name: string; status: string };
}

export interface TelegramPostResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface NotifierDeps {
  mailer: Mailer;
  httpPost: (
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ ok: boolean; status: number }>;
  telegramPost: (
    url: string,
    body: unknown,
  ) => Promise<TelegramPostResponse>;
  telegramBotToken: string;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  await assertTargetAllowed(url, config.ssrfAllowPrivate);

  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    redirect: "manual",
  });
}

/**
 * Default httpPost implementation using fetch with a 10-second timeout.
 * Throws if the URL is SSRF-blocked (caller records a failed AlertLog).
 */
export async function httpPost(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number }> {
  const res = await postJson(url, body, headers);
  return { ok: res.ok, status: res.status };
}

/**
 * Telegram transport additionally parses the Bot API JSON envelope. Invalid
 * JSON is represented as an absent body so parser details never escape.
 */
export async function telegramPost(
  url: string,
  body: unknown,
): Promise<TelegramPostResponse> {
  const res = await postJson(url, body);
  let responseBody: unknown;
  try {
    responseBody = await res.json();
  } catch {
    responseBody = undefined;
  }
  return { ok: res.ok, status: res.status, body: responseBody };
}

// Shape of a channel passed in (minimal subset we need — avoids depending on
// Prisma's generated type directly so the function is easy to test with plain
// objects).
interface ChannelLike {
  id: string;
  type: string;
  config: unknown;
  enabled: boolean;
  verifiedAt: Date | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Dispatch a notification message to a single channel.
 * Throws if the HTTP transport returns a non-2xx response, so the caller can
 * record a failure AlertLog and continue with other channels.
 */
export async function dispatchChannel(
  channel: ChannelLike,
  msg: NotifyMessage,
  deps: NotifierDeps,
): Promise<void> {
  const cfg = isRecord(channel.config) ? channel.config : {};
  const { subject, text } = msg;

  switch (channel.type) {
    case "EMAIL": {
      if (channel.enabled !== true || !channel.verifiedAt) {
        throw new Error(`EMAIL channel ${channel.id} is not verified`);
      }
      const to = String(cfg["email"] ?? "");
      if (!to) throw new Error(`EMAIL channel ${channel.id} has no email in config`);
      await deps.mailer.send({ to, subject, text });
      break;
    }

    case "SLACK": {
      const webhookUrl = String(cfg["webhookUrl"] ?? "");
      if (!webhookUrl) throw new Error(`SLACK channel ${channel.id} has no webhookUrl in config`);
      const res = await deps.httpPost(webhookUrl, { text: `${subject}\n${text}` });
      if (!res.ok) {
        throw new Error(
          `SLACK webhook failed with status ${res.status}`,
        );
      }
      break;
    }

    case "TELEGRAM": {
      const hasRowBotToken = Object.prototype.hasOwnProperty.call(
        cfg,
        "botToken",
      );
      const hasMode = Object.prototype.hasOwnProperty.call(cfg, "mode");
      const mode = cfg["mode"];
      let managed: boolean;
      if (hasRowBotToken || !hasMode || mode === "LEGACY") {
        managed = false;
      } else if (mode === "MANAGED") {
        managed = true;
      } else {
        throw new Error(
          `TELEGRAM channel ${channel.id} has invalid mode in config`,
        );
      }

      const rowBotToken = cfg["botToken"];
      let botToken = "";
      if (managed) {
        botToken = deps.telegramBotToken.trim();
      } else if (typeof rowBotToken === "string") {
        botToken = rowBotToken.trim();
      }
      const rawChatId = cfg["chatId"];
      const chatId =
        typeof rawChatId === "string" ? rawChatId.trim() : "";
      if (!botToken || !chatId) {
        throw new Error(
          `TELEGRAM channel ${channel.id} missing ${
            managed ? "managed" : "legacy"
          } configuration`,
        );
      }
      const messageThreadId = cfg["messageThreadId"];
      const body: {
        chat_id: string;
        text: string;
        message_thread_id?: number;
      } = {
        chat_id: chatId,
        text: `${subject}\n${text}`,
      };
      if (messageThreadId !== undefined) {
        if (
          typeof messageThreadId !== "number" ||
          !Number.isInteger(messageThreadId) ||
          messageThreadId <= 0 ||
          messageThreadId > 2_147_483_647
        ) {
          throw new Error(
            `TELEGRAM channel ${channel.id} has invalid messageThreadId in config`,
          );
        }
        body.message_thread_id = messageThreadId;
      }
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      let res: TelegramPostResponse;
      try {
        res = await deps.telegramPost(url, body);
      } catch {
        throw new Error(
          `TELEGRAM channel ${channel.id} sendMessage transport failure`,
        );
      }
      if (!res.ok) {
        throw new Error(
          `TELEGRAM channel ${channel.id} sendMessage failed with status ${res.status}`,
        );
      }
      const envelope = res.body;
      const result = isRecord(envelope) ? envelope["result"] : undefined;
      const messageId = isRecord(result) ? result["message_id"] : undefined;
      if (
        !isRecord(envelope) ||
        envelope["ok"] !== true ||
        !isRecord(result) ||
        typeof messageId !== "number" ||
        !Number.isSafeInteger(messageId) ||
        messageId < 0
      ) {
        throw new Error(
          `TELEGRAM channel ${channel.id} sendMessage invalid response`,
        );
      }
      break;
    }

    case "WEBHOOK": {
      const url = String(cfg["url"] ?? "");
      if (!url) throw new Error(`WEBHOOK channel ${channel.id} has no url in config`);
      const res = await deps.httpPost(url, {
        event: "alert",
        kind: msg.kind,
        check: msg.check,
        message: text,
      });
      if (!res.ok) {
        throw new Error(
          `WEBHOOK delivery failed with status ${res.status}`,
        );
      }
      break;
    }

    default:
      throw new Error(`Unknown channel type: ${String(channel.type)}`);
  }
}
