import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedTelegramSetup } from "./managed-telegram-setup";

function deferredPromise() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("ManagedTelegramSetup", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("normalizes the username for safe Telegram links and the start command", () => {
    render(<ManagedTelegramSetup available username="  @@@VitalsRelayBot  " />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Connect Telegram" })
    ).toBeInTheDocument();
    expect(screen.getByText("@VitalsRelayBot")).toBeInTheDocument();
    expect(screen.getByText("/start@VitalsRelayBot")).toBeInTheDocument();

    const directLink = screen.getByRole("link", { name: /open bot/i });
    expect(directLink).toHaveAttribute(
      "href",
      "https://t.me/VitalsRelayBot"
    );
    expect(directLink).toHaveAttribute("target", "_blank");
    expect(directLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(directLink).not.toHaveAttribute("type");

    const groupLink = screen.getByRole("link", { name: /add bot to group/i });
    expect(groupLink).toHaveAttribute(
      "href",
      "https://t.me/VitalsRelayBot?startgroup=true"
    );
    expect(groupLink).toHaveAttribute("target", "_blank");
    expect(groupLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("uses a level-two heading in the unavailable state", () => {
    render(<ManagedTelegramSetup available={false} username={null} />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Connect Telegram" })
    ).toBeInTheDocument();
  });

  it("explains setup for private chats, groups, channels, and forum topics", () => {
    render(<ManagedTelegramSetup available username="VitalsRelayBot" />);

    expect(screen.getByText(/private chat/i)).toBeInTheDocument();
    expect(screen.getByText(/^groups$/i)).toBeInTheDocument();
    expect(screen.getByText(/^channels$/i)).toBeInTheDocument();
    expect(screen.getByText(/post messages/i)).toBeInTheDocument();
    expect(screen.getByText(/forum topics/i)).toBeInTheDocument();
    expect(screen.getByText(/inside the exact topic/i)).toBeInTheDocument();
    expect(
      screen.getByText(/replies in that destination with a 10-minute connection link/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/review the active organization, and confirm the channel/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/choose the project/i)).not.toBeInTheDocument();
  });

  it("copies the exact command and reports success", async () => {
    render(<ManagedTelegramSetup available username="@VitalsRelayBot" />);

    fireEvent.click(screen.getByRole("button", { name: /copy command/i }));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/start@VitalsRelayBot"
      )
    );
    expect(screen.getByRole("status")).toHaveTextContent("Command copied");
  });

  it("reports clipboard failure and clears it after a successful retry", async () => {
    const retry = deferredPromise();
    vi.mocked(navigator.clipboard.writeText)
      .mockRejectedValueOnce(new Error("denied"))
      .mockReturnValueOnce(retry.promise);
    render(<ManagedTelegramSetup available username="VitalsRelayBot" />);

    const copyButton = screen.getByRole("button", { name: /copy command/i });
    fireEvent.click(copyButton);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t copy the command. Try again."
    );

    fireEvent.click(copyButton);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await act(async () => retry.resolve());

    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    );
    expect(screen.getByRole("status")).toHaveTextContent("Command copied");
  });

  it("keeps newer success when an older clipboard attempt fails later", async () => {
    const older = deferredPromise();
    const newer = deferredPromise();
    vi.mocked(navigator.clipboard.writeText)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    render(<ManagedTelegramSetup available username="VitalsRelayBot" />);

    const copyButton = screen.getByRole("button", { name: /copy command/i });
    fireEvent.click(copyButton);
    fireEvent.click(copyButton);

    await act(async () => newer.resolve());
    expect(screen.getByRole("status")).toHaveTextContent("Command copied");

    await act(async () => older.reject(new Error("older failure")));

    expect(screen.getByRole("status")).toHaveTextContent("Command copied");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps newer failure when an older clipboard attempt succeeds later", async () => {
    const older = deferredPromise();
    const newer = deferredPromise();
    vi.mocked(navigator.clipboard.writeText)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    render(<ManagedTelegramSetup available username="VitalsRelayBot" />);

    const copyButton = screen.getByRole("button", { name: /copy command/i });
    fireEvent.click(copyButton);
    fireEvent.click(copyButton);

    await act(async () => newer.reject(new Error("newer failure")));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t copy the command. Try again."
    );

    await act(async () => older.resolve());

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t copy the command. Try again."
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("clears completed feedback when the normalized username changes", async () => {
    const { rerender } = render(
      <ManagedTelegramSetup available username="FirstRelayBot" />
    );

    fireEvent.click(screen.getByRole("button", { name: /copy command/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Command copied"
    );

    rerender(<ManagedTelegramSetup available username="SecondRelayBot" />);

    expect(screen.getByText("@SecondRelayBot")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores clipboard completion from the previous normalized username", async () => {
    const previousAttempt = deferredPromise();
    vi.mocked(navigator.clipboard.writeText).mockReturnValueOnce(
      previousAttempt.promise
    );
    const { rerender } = render(
      <ManagedTelegramSetup available username="FirstRelayBot" />
    );

    fireEvent.click(screen.getByRole("button", { name: /copy command/i }));
    rerender(<ManagedTelegramSetup available username="SecondRelayBot" />);

    await act(async () => previousAttempt.resolve());

    expect(screen.getByText("@SecondRelayBot")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    "VitalsBot/../../admin",
    "VitalsBot?startgroup=true",
    "VítalsRelayBot",
    "_VitalsRelayBot",
    "Bot",
    "VitalsRelay",
    "A23456789012345678901234567890Bot",
  ])("rejects invalid managed bot username %s", (username) => {
    render(<ManagedTelegramSetup available username={username} />);

    expect(
      screen.getByText(/telegram setup is temporarily unavailable/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /copy command/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(`@${username}`)).not.toBeInTheDocument();
    expect(screen.queryByText(`/start@${username}`)).not.toBeInTheDocument();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it.each([
    { available: false, username: "VitalsRelayBot" },
    { available: true, username: null },
    { available: true, username: "  @@@  " },
  ])(
    "renders a safe unavailable state for $available / $username",
    ({ available, username }) => {
      render(
        <ManagedTelegramSetup available={available} username={username} />
      );

      expect(
        screen.getByText(/telegram setup is temporarily unavailable/i)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/existing telegram channels continue/i)
      ).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /copy command/i })
      ).not.toBeInTheDocument();
    }
  );

  it("never renders inputs for Telegram credentials or destination IDs", () => {
    render(<ManagedTelegramSetup available username="VitalsRelayBot" />);

    const credentialName =
      /token|bot token|chat id|group id|topic id/i;
    const controls = [
      ...screen.queryAllByRole("textbox"),
      ...screen.queryAllByRole("spinbutton"),
      ...screen.queryAllByRole("combobox"),
    ];
    for (const element of controls) {
      expect(element).not.toHaveAccessibleName(credentialName);
    }
  });
});
