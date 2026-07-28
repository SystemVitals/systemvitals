import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType } from "@systemvitals/database";
import {
  dispatchChannel,
  telegramPost as productionTelegramPost,
} from "../src/notifiers.js";
import type { NotifyMessage, NotifierDeps } from "../src/notifiers.js";
import { CollectingMailer } from "../src/mailer.js";
import { assertTargetAllowed } from "../src/ssrf.js";

vi.mock("../src/ssrf.js", () => ({
  assertTargetAllowed: vi.fn().mockResolvedValue(undefined),
}));

function makeChannel(type: ChannelType, config: unknown) {
  return {
    id: "chan-1",
    projectId: "proj-1",
    type,
    config,
    enabled: true,
    verifiedAt: type === ChannelType.EMAIL ? new Date() : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const msg: NotifyMessage = {
  subject: "[SystemVitals] API is DOWN",
  text: 'ALERT: "API" is DOWN.\n\nStatus: DOWN\nDetected at: 2026-06-20T00:00:00.000Z',
  kind: "down",
  check: { id: "check-1", name: "API", status: "DOWN" },
};

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected promise to reject");
}

function expectNoTelegramLeak(error: string): void {
  for (const secret of [
    "managed-test-token",
    "legacy-test-token",
    "https://api.telegram.org",
    "-1001234567890",
    msg.subject,
    msg.text,
    "telegram-description-secret",
    "inner-transport-secret",
    "request body",
  ]) {
    expect(error).not.toContain(secret);
  }
}

describe("dispatchChannel", () => {
  let mailer: CollectingMailer;
  let httpPost: ReturnType<typeof vi.fn>;
  let telegramPost: ReturnType<typeof vi.fn>;
  let deps: NotifierDeps;

  beforeEach(() => {
    mailer = new CollectingMailer();
    httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    telegramPost = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, result: { message_id: 123 } },
    });
    deps = {
      mailer,
      httpPost,
      telegramPost,
      telegramBotToken: "managed-test-token",
    };
  });

  it("EMAIL — calls mailer.send with to/subject/text", async () => {
    const channel = makeChannel(ChannelType.EMAIL, { email: "ops@example.com" });
    await dispatchChannel(channel, msg, deps);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      to: "ops@example.com",
      subject: msg.subject,
      text: msg.text,
    });
    expect(httpPost).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled", false, new Date()],
    ["unverified", true, null],
  ])(
    "EMAIL — refuses a %s channel before calling mailer.send",
    async (_state, enabled, verifiedAt) => {
      const channel = {
        ...makeChannel(ChannelType.EMAIL, { email: "ops@example.com" }),
        enabled,
        verifiedAt,
      };
      const send = vi.spyOn(mailer, "send");

      await expect(dispatchChannel(channel, msg, deps)).rejects.toThrow(
        "EMAIL channel chan-1 is not verified",
      );

      expect(send).not.toHaveBeenCalled();
    },
  );

  it("SLACK — calls httpPost with webhookUrl and body containing subject+text", async () => {
    const webhookUrl = "https://hooks.slack.com/services/T00/B00/xxx";
    const channel = makeChannel(ChannelType.SLACK, { webhookUrl });
    await dispatchChannel(channel, msg, deps);

    expect(httpPost).toHaveBeenCalledOnce();
    const [url, body] = httpPost.mock.calls[0] as [string, { text: string }];
    expect(url).toBe(webhookUrl);
    expect(body.text).toContain(msg.subject);
    expect(body.text).toContain(msg.text);
    expect(mailer.sent).toHaveLength(0);
  });

  it("TELEGRAM managed — sends through the managed bot with the exact payload", async () => {
    const channel = makeChannel(ChannelType.TELEGRAM, {
      mode: "MANAGED",
      chatId: "-1001234567890",
    });
    await dispatchChannel(channel, msg, deps);

    expect(telegramPost).toHaveBeenCalledOnce();
    const [url, body] = telegramPost.mock.calls[0] as [
      string,
      { chat_id: string; text: string; message_thread_id?: number },
    ];
    expect(url).toBe(
      "https://api.telegram.org/botmanaged-test-token/sendMessage",
    );
    expect(body).toEqual({
      chat_id: "-1001234567890",
      text: `${msg.subject}\n${msg.text}`,
    });
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("TELEGRAM managed — preserves a numeric forum topic", async () => {
    const channel = makeChannel(ChannelType.TELEGRAM, {
      mode: "MANAGED",
      chatId: "-1001234567890",
      messageThreadId: 42,
    });

    await dispatchChannel(channel, msg, deps);

    const [, body] = telegramPost.mock.calls[0] as [
      string,
      { chat_id: string; text: string; message_thread_id?: number },
    ];
    expect(body).toMatchObject({
      chat_id: "-1001234567890",
      message_thread_id: 42,
    });
  });

  it.each([
    ["an absent mode", undefined],
    ["LEGACY mode", "LEGACY"],
  ])(
    "TELEGRAM legacy — %s keeps using the row token",
    async (_label, mode) => {
      const channel = makeChannel(ChannelType.TELEGRAM, {
        ...(mode === undefined ? {} : { mode }),
        botToken: "legacy-test-token",
        chatId: "-1001234567890",
      });

      await dispatchChannel(channel, msg, deps);

      expect(telegramPost).toHaveBeenCalledWith(
        "https://api.telegram.org/botlegacy-test-token/sendMessage",
        {
          chat_id: "-1001234567890",
          text: `${msg.subject}\n${msg.text}`,
        },
      );
      expect(httpPost).not.toHaveBeenCalled();
    },
  );

  it("TELEGRAM legacy — botToken takes precedence over a conflicting managed mode", async () => {
    const channel = makeChannel(ChannelType.TELEGRAM, {
      mode: "MANAGED",
      botToken: "legacy-test-token",
      chatId: "-1001234567890",
    });

    await dispatchChannel(channel, msg, deps);

    expect(telegramPost).toHaveBeenCalledWith(
      "https://api.telegram.org/botlegacy-test-token/sendMessage",
      {
        chat_id: "-1001234567890",
        text: `${msg.subject}\n${msg.text}`,
      },
    );
    expect(telegramPost).not.toHaveBeenCalledWith(
      expect.stringContaining("managed-test-token"),
      expect.anything(),
    );
  });

  it.each([
    [
      "managed",
      { mode: "MANAGED", chatId: "-1001234567890" },
      "https://api.telegram.org/botmanaged-test-token/sendMessage",
    ],
    [
      "legacy",
      {
        mode: "LEGACY",
        botToken: "legacy-test-token",
        chatId: "-1001234567890",
      },
      "https://api.telegram.org/botlegacy-test-token/sendMessage",
    ],
  ])(
    "TELEGRAM %s — accepts a successful envelope with message_id zero",
    async (_label, channelConfig, expectedUrl) => {
      telegramPost.mockResolvedValue({
        ok: true,
        status: 200,
        body: { ok: true, result: { message_id: 0 } },
      });
      const channel = makeChannel(ChannelType.TELEGRAM, channelConfig);

      await dispatchChannel(channel, msg, deps);

      expect(telegramPost).toHaveBeenCalledWith(expectedUrl, {
        chat_id: "-1001234567890",
        text: `${msg.subject}\n${msg.text}`,
      });
    },
  );

  it.each(["", "   ", "\u00a0\t"])(
    "TELEGRAM legacy — a conflicting managed mode ignores a blank global token",
    async (telegramBotToken) => {
      deps.telegramBotToken = telegramBotToken;
      const channel = makeChannel(ChannelType.TELEGRAM, {
        mode: "MANAGED",
        botToken: "legacy-test-token",
        chatId: "-1001234567890",
      });

      await dispatchChannel(channel, msg, deps);

      expect(telegramPost).toHaveBeenCalledWith(
        "https://api.telegram.org/botlegacy-test-token/sendMessage",
        {
          chat_id: "-1001234567890",
          text: `${msg.subject}\n${msg.text}`,
        },
      );
      expect(httpPost).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an absent mode", undefined],
    ["LEGACY mode", "LEGACY"],
  ])(
    "TELEGRAM legacy — %s rejects a missing row token before HTTP",
    async (_label, mode) => {
      const channel = makeChannel(ChannelType.TELEGRAM, {
        ...(mode === undefined ? {} : { mode }),
        chatId: "-1001234567890",
      });

      await expect(dispatchChannel(channel, msg, deps)).rejects.toThrow(
        "TELEGRAM channel chan-1 missing legacy configuration",
      );
      expect(httpPost).not.toHaveBeenCalled();
      expect(telegramPost).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["managed missing chatId", { mode: "MANAGED" }],
    ["managed blank chatId", { mode: "MANAGED", chatId: "   " }],
    ["legacy missing chatId", { botToken: "legacy-test-token" }],
    [
      "legacy blank chatId",
      { botToken: "legacy-test-token", chatId: "   " },
    ],
  ])("TELEGRAM — rejects %s before HTTP", async (_label, channelConfig) => {
    const channel = makeChannel(ChannelType.TELEGRAM, channelConfig);

    await expect(dispatchChannel(channel, msg, deps)).rejects.toThrow(
      `TELEGRAM channel chan-1 missing ${
        "mode" in channelConfig && channelConfig.mode === "MANAGED"
          ? "managed"
          : "legacy"
      } configuration`,
    );
    expect(httpPost).not.toHaveBeenCalled();
    expect(telegramPost).not.toHaveBeenCalled();
  });

  it.each([
    ["trailing MANAGED whitespace", "MANAGED "],
    ["leading MANAGED whitespace", "\tMANAGED"],
    ["lowercase managed", "managed"],
    ["mixed-case managed", "Managed"],
    ["lowercase legacy", "legacy"],
    ["trailing LEGACY whitespace", "LEGACY "],
    ["an unknown future mode", "FUTURE"],
    ["null", null],
    ["a number", 1],
    ["an array", ["MANAGED"]],
    ["an object", { value: "MANAGED" }],
    ["explicit undefined", undefined],
  ])("TELEGRAM nonlegacy — rejects %s mode without fallback", async (_label, mode) => {
    const channel = makeChannel(ChannelType.TELEGRAM, {
      mode,
      chatId: "-1001234567890",
    });

    const error = await rejectionMessage(dispatchChannel(channel, msg, deps));

    expect(error).toBe("TELEGRAM channel chan-1 has invalid mode in config");
    expectNoTelegramLeak(error);
    expect(httpPost).not.toHaveBeenCalled();
    expect(telegramPost).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["a number", 123],
    ["an array", ["legacy-test-token"]],
    ["an object", { token: "legacy-test-token" }],
  ])(
    "TELEGRAM legacy — rejects %s botToken instead of coercing it",
    async (_label, botToken) => {
      const channel = makeChannel(ChannelType.TELEGRAM, {
        mode: "LEGACY",
        botToken,
        chatId: "-1001234567890",
      });

      await expect(dispatchChannel(channel, msg, deps)).rejects.toThrow(
        "TELEGRAM channel chan-1 missing legacy configuration",
      );
      expect(telegramPost).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["managed number", { mode: "MANAGED", chatId: 123 }],
    ["managed array", { mode: "MANAGED", chatId: ["-1001234567890"] }],
    ["managed object", { mode: "MANAGED", chatId: { id: "-1001234567890" } }],
    [
      "legacy number",
      {
        mode: "LEGACY",
        botToken: "legacy-test-token",
        chatId: 123,
      },
    ],
    [
      "legacy array",
      {
        mode: "LEGACY",
        botToken: "legacy-test-token",
        chatId: ["-1001234567890"],
      },
    ],
    [
      "legacy object",
      {
        mode: "LEGACY",
        botToken: "legacy-test-token",
        chatId: { id: "-1001234567890" },
      },
    ],
  ])("TELEGRAM — rejects %s chatId instead of coercing it", async (
    _label,
    channelConfig,
  ) => {
    const channel = makeChannel(ChannelType.TELEGRAM, channelConfig);

    await expect(dispatchChannel(channel, msg, deps)).rejects.toThrow(
      `TELEGRAM channel chan-1 missing ${
        channelConfig.mode === "MANAGED" ? "managed" : "legacy"
      } configuration`,
    );
    expect(telegramPost).not.toHaveBeenCalled();
  });

  it.each([
    [
      "managed NBSP/tab-only chatId",
      { mode: "MANAGED", chatId: "\u00a0\t" },
      "managed",
    ],
    [
      "legacy NBSP/tab-only botToken",
      {
        mode: "LEGACY",
        botToken: "\u00a0\t",
        chatId: "-1001234567890",
      },
      "legacy",
    ],
    [
      "legacy NBSP/tab-only chatId",
      {
        mode: "LEGACY",
        botToken: "legacy-test-token",
        chatId: "\u00a0\t",
      },
      "legacy",
    ],
  ])("TELEGRAM — rejects %s", async (_label, channelConfig, expectedMode) => {
    const channel = makeChannel(ChannelType.TELEGRAM, channelConfig);

    await expect(dispatchChannel(channel, msg, deps)).rejects.toThrow(
      `TELEGRAM channel chan-1 missing ${expectedMode} configuration`,
    );
    expect(telegramPost).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["a number", 123],
    ["an array", ["legacy-test-token"]],
    ["an object", { token: "legacy-test-token" }],
  ])(
    "TELEGRAM legacy — validates a present %s row botToken",
    async (_label, botToken) => {
      const channel = makeChannel(ChannelType.TELEGRAM, {
        mode: "MANAGED",
        botToken,
        chatId: "-1001234567890",
      });

      await expect(dispatchChannel(channel, msg, deps)).rejects.toThrow(
        "TELEGRAM channel chan-1 missing legacy configuration",
      );
      expect(telegramPost).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a string", "42"],
    ["a fraction", 1.5],
    ["zero", 0],
    ["a negative number", -1],
    ["a value above the Telegram maximum", 2_147_483_648],
    ["infinity", Number.POSITIVE_INFINITY],
  ])(
    "TELEGRAM — rejects %s as a forum topic without leaking it",
    async (_label, messageThreadId) => {
      const channel = makeChannel(ChannelType.TELEGRAM, {
        mode: "MANAGED",
        chatId: "-1001234567890",
        messageThreadId,
      });

      await expect(dispatchChannel(channel, msg, deps)).rejects.toThrow(
        "TELEGRAM channel chan-1 has invalid messageThreadId in config",
      );
      expect(httpPost).not.toHaveBeenCalled();
      expect(telegramPost).not.toHaveBeenCalled();
    },
  );

  it("WEBHOOK — posts to config.url with event:'alert' payload including kind and check", async () => {
    const webhookUrl = "https://my-webhook.example.com/hook";
    const channel = makeChannel(ChannelType.WEBHOOK, { url: webhookUrl });
    await dispatchChannel(channel, msg, deps);

    expect(httpPost).toHaveBeenCalledOnce();
    const [url, body] = httpPost.mock.calls[0] as [
      string,
      { event: string; kind: string; check: { id: string; name: string }; message: string },
    ];
    expect(url).toBe(webhookUrl);
    expect(body.event).toBe("alert");
    expect(body.kind).toBe(msg.kind);
    expect(body.check.id).toBe(msg.check.id);
    expect(body.check.name).toBe(msg.check.name);
    expect(body.message).toBe(msg.text);
  });

  it.each([
    ["EMAIL", ChannelType.EMAIL],
    ["SLACK", ChannelType.SLACK],
    ["TELEGRAM", ChannelType.TELEGRAM],
    ["WEBHOOK", ChannelType.WEBHOOK],
  ])(
    "%s — rejects null, array, and primitive config safely",
    async (label, type) => {
      for (const invalidConfig of [null, ["config-secret"], "config-secret"]) {
        const channel = makeChannel(type, invalidConfig);
        const error = await dispatchChannel(channel, msg, deps).then(
          () => "",
          (reason: unknown) =>
            reason instanceof Error ? reason.message : String(reason),
        );

        expect(error).toContain(`${label} channel chan-1`);
        expect(error).not.toContain("config-secret");
      }
      expect(httpPost).not.toHaveBeenCalled();
      expect(telegramPost).not.toHaveBeenCalled();
    },
  );

  it("TELEGRAM — sanitizes non-2xx delivery failures", async () => {
    telegramPost.mockResolvedValue({
      ok: false,
      status: 503,
      body: {
        ok: false,
        description: "telegram-description-secret",
      },
    });
    const channel = makeChannel(ChannelType.TELEGRAM, {
      mode: "MANAGED",
      chatId: "-1001234567890",
    });

    const error = await rejectionMessage(dispatchChannel(channel, msg, deps));

    expect(error).toBe(
      "TELEGRAM channel chan-1 sendMessage failed with status 503",
    );
    expectNoTelegramLeak(error);
  });

  it("TELEGRAM — replaces thrown transport failures with a sanitized error", async () => {
    telegramPost.mockRejectedValue(
      new Error(
        "inner-transport-secret managed-test-token legacy-test-token -1001234567890 request body",
      ),
    );
    const channel = makeChannel(ChannelType.TELEGRAM, {
      mode: "MANAGED",
      chatId: "-1001234567890",
    });

    const error = await rejectionMessage(dispatchChannel(channel, msg, deps));

    expect(error).toBe(
      "TELEGRAM channel chan-1 sendMessage transport failure",
    );
    expectNoTelegramLeak(error);
  });

  it.each([
    ["ok false", { ok: false, description: "telegram-description-secret" }],
    ["missing body", undefined],
    ["null body", null],
    ["array body", [{ ok: true }]],
    ["primitive body", "telegram-description-secret"],
    ["missing result", { ok: true }],
    ["null result", { ok: true, result: null }],
    ["false result", { ok: true, result: false }],
    ["missing message_id", { ok: true, result: {} }],
    ["string message_id", { ok: true, result: { message_id: "1" } }],
    ["negative message_id", { ok: true, result: { message_id: -1 } }],
    ["fractional message_id", { ok: true, result: { message_id: 1.5 } }],
    [
      "unsafe message_id",
      { ok: true, result: { message_id: Number.MAX_SAFE_INTEGER + 1 } },
    ],
  ])(
    "TELEGRAM — rejects a 2xx envelope with %s",
    async (_label, body) => {
      telegramPost.mockResolvedValue({ ok: true, status: 200, body });
      const channel = makeChannel(ChannelType.TELEGRAM, {
        mode: "MANAGED",
        botToken: "legacy-test-token",
        chatId: "-1001234567890",
      });

      const error = await rejectionMessage(
        dispatchChannel(channel, msg, deps),
      );

      expect(error).toBe(
        "TELEGRAM channel chan-1 sendMessage invalid response",
      );
      expectNoTelegramLeak(error);
    },
  );

  it("SLACK non-2xx httpPost response — dispatchChannel throws", async () => {
    httpPost.mockResolvedValue({ ok: false, status: 500 });
    const channel = makeChannel(ChannelType.SLACK, {
      webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
    });

    await expect(dispatchChannel(channel, msg, deps)).rejects.toThrow();
  });
});

describe("telegramPost", () => {
  beforeEach(() => {
    vi.mocked(assertTargetAllowed).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the guarded JSON POST transport and parses a Telegram envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 456 } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const url = "https://api.telegram.org/botmanaged-test-token/sendMessage";
    const body = { chat_id: "-1001234567890", text: "test message" };
    const result = await productionTelegramPost(url, body);

    expect(assertTargetAllowed).toHaveBeenCalledWith(url, expect.any(Boolean));
    expect(fetchMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: { ok: true, result: { message_id: 456 } },
    });
  });

  it("turns malformed Telegram JSON into an undefined body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    );

    const result = await productionTelegramPost(
      "https://api.telegram.org/botmanaged-test-token/sendMessage",
      { chat_id: "-1001234567890", text: "test message" },
    );

    expect(result).toEqual({ ok: true, status: 200, body: undefined });
  });
});
