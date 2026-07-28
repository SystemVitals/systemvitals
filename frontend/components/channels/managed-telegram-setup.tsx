"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bot,
  Check,
  Copy,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface ManagedTelegramSetupProps {
  available: boolean;
  username: string | null;
}

type CopyState = "idle" | "copied" | "error";

interface CopyFeedback {
  username: string;
  state: Exclude<CopyState, "idle">;
}

const TELEGRAM_BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{1,28}bot$/i;

function normalizeUsername(username: string | null): string {
  const normalized = username?.trim().replace(/^@+/, "") ?? "";
  return TELEGRAM_BOT_USERNAME.test(normalized) ? normalized : "";
}

const destinationSteps = [
  {
    title: "Private chat",
    body: "Open the bot, then send the command shown above in your conversation.",
  },
  {
    title: "Groups",
    body: "Add the bot to your group, then send the command shown above there.",
  },
  {
    title: "Channels",
    body: "Add the bot as an admin with the Post Messages permission, then send the command in the channel.",
  },
  {
    title: "Forum topics",
    body: "Add the bot to the forum group, then send the command shown above inside the exact topic you want alerts delivered to.",
  },
] as const;

export function ManagedTelegramSetup({
  available,
  username,
}: ManagedTelegramSetupProps) {
  const normalizedUsername = normalizeUsername(username);
  const isAvailable = available && normalizedUsername.length > 0;
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null);
  const copyAttemptId = useRef(0);

  useEffect(() => {
    copyAttemptId.current += 1;
  }, [normalizedUsername]);

  const copyState: CopyState =
    copyFeedback?.username === normalizedUsername
      ? copyFeedback.state
      : "idle";

  if (!isAvailable) {
    return (
      <Card className="border-dashed bg-muted/20">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-lg border bg-background text-muted-foreground">
                <Bot aria-hidden="true" className="size-4" />
              </div>
              <div>
                <CardTitle>
                  <h2>Connect Telegram</h2>
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Managed bot connection
                </p>
              </div>
            </div>
            <Badge variant="outline">Unavailable</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm font-medium">
            Telegram setup is temporarily unavailable.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Existing Telegram channels continue to receive alerts. Try setting
            up a new destination again later.
          </p>
        </CardContent>
      </Card>
    );
  }

  const command = `/start@${normalizedUsername}`;
  const directLink = `https://t.me/${normalizedUsername}`;
  const groupLink = `${directLink}?startgroup=true`;

  async function copyCommand() {
    const attemptId = ++copyAttemptId.current;
    const attemptUsername = normalizedUsername;
    setCopyFeedback(null);

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(command);
      if (attemptId === copyAttemptId.current) {
        setCopyFeedback({
          username: attemptUsername,
          state: "copied",
        });
      }
    } catch {
      if (attemptId === copyAttemptId.current) {
        setCopyFeedback({
          username: attemptUsername,
          state: "error",
        });
      }
    }
  }

  return (
    <Card className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-primary/70"
      />
      <CardHeader className="border-b">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-primary/5 text-primary">
              <Bot aria-hidden="true" className="size-5" />
            </div>
            <div>
              <CardTitle>
                <h2>Connect Telegram</h2>
              </CardTitle>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                Route alerts through the managed SystemVitals bot. No bot
                credentials or destination IDs to copy.
              </p>
            </div>
          </div>
          <Badge variant="outline" className="border-primary/30 text-primary">
            <ShieldCheck aria-hidden="true" data-icon="inline-start" />
            Managed
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 font-mono text-xs font-semibold text-primary">
              01
            </span>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Telegram bot
              </p>
              <p className="mt-0.5 font-mono text-sm font-semibold">
                @{normalizedUsername}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={directLink}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Open bot
              <ArrowUpRight aria-hidden="true" data-icon="inline-end" />
            </a>
            <a
              href={groupLink}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Add bot to group
              <ArrowUpRight aria-hidden="true" data-icon="inline-end" />
            </a>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0 rounded-lg border bg-background">
            <div className="flex items-center gap-3 px-3 py-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 font-mono text-xs font-semibold text-primary">
                02
              </span>
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm font-medium">
                {command}
              </code>
            </div>
          </div>
          <Button type="button" variant="secondary" onClick={copyCommand}>
            {copyState === "copied" ? (
              <Check aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
            Copy command
          </Button>
        </div>

        {copyState === "copied" && (
          <p role="status" className="text-xs text-success">
            Command copied
          </p>
        )}
        {copyState === "error" && (
          <p role="alert" className="text-xs text-destructive">
            Couldn’t copy the command. Try again.
          </p>
        )}

        <ol className="grid gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-2">
          {destinationSteps.map((step, index) => (
            <li key={step.title} className="bg-card p-4">
              <div className="flex gap-3">
                <span className="font-mono text-xs font-semibold text-primary">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="text-sm font-semibold">{step.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ol>

        <div className="flex gap-3 rounded-lg bg-primary/5 p-4 text-sm">
          <MessageCircle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-primary"
          />
          <p className="leading-6 text-muted-foreground">
            SystemVitals replies in that destination with a 10-minute
            connection link. Open it, choose the project, and confirm the
            channel.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
