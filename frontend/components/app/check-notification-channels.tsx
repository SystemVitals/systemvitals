"use client";

import { useEffect, useRef, useState } from "react";
import { useApolloClient, useMutation } from "@apollo/client/react";
import {
  Bell,
  LoaderCircle,
  Mail,
  MessageSquare,
  Send,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { CHANNELS, SET_CHECK_CHANNEL_ENABLED } from "@/lib/queries";

export interface NotificationChannelOption {
  id: string;
  type: "EMAIL" | "TELEGRAM" | "WEBHOOK" | "SLACK" | string;
  configJson: string;
  enabled: boolean;
}

interface CheckNotificationChannelsProps {
  checkId: string;
  checkName: string;
  notificationChannelIds: string[];
  channels: NotificationChannelOption[];
  variant: "compact" | "detail";
}

interface SetCheckChannelEnabledData {
  setCheckChannelEnabled: {
    id: string;
    notificationChannelIds: string[];
  };
}

interface SetCheckChannelEnabledVariables {
  checkId: string;
  channelId: string;
  enabled: boolean;
}

interface ChannelPresentation {
  Icon: LucideIcon;
  label: string;
  summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

function parseConfig(configJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(configJson);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function nonblankString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeEmail(value: unknown): string | null {
  const email = nonblankString(value);
  if (
    !email ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }
  return email;
}

function safeHostname(value: unknown): string | null {
  const urlValue = nonblankString(value);
  if (!urlValue) return null;

  try {
    const url = new URL(urlValue);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname
    ) {
      return null;
    }
    return url.hostname;
  } catch {
    return null;
  }
}

function safeChatId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  const chatId = nonblankString(value);
  return chatId && /^-?\d+$/.test(chatId) ? chatId : null;
}

function safeTopic(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  const topic = nonblankString(value);
  if (!topic || topic.length > 80) return null;
  return topic;
}

function safeChannelTypeLabel(type: string): string {
  const trimmed = type.trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(trimmed)) {
    return "Notification channel";
  }
  const words = trimmed.replace(/[_-]+/g, " ").toLowerCase();
  return words.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function telegramSummary(config: Record<string, unknown> | null): string {
  if (!config) return "Telegram destination";
  const destination =
    nonblankString(config.chatTitle) ??
    safeChatId(config.chatId) ??
    "Telegram destination";
  const topic = safeTopic(config.messageThreadId);
  return topic ? `${destination} · topic ${topic}` : destination;
}

function channelPresentation(
  channel: NotificationChannelOption,
): ChannelPresentation {
  const config = parseConfig(channel.configJson);

  switch (channel.type) {
    case "EMAIL":
      return {
        Icon: Mail,
        label: "Email",
        summary: safeEmail(config?.email) ?? "Email destination",
      };
    case "TELEGRAM":
      return {
        Icon: Send,
        label: "Telegram",
        summary: telegramSummary(config),
      };
    case "WEBHOOK":
      return {
        Icon: Webhook,
        label: "Webhook",
        summary: safeHostname(config?.url) ?? "Webhook destination",
      };
    case "SLACK":
      return {
        Icon: MessageSquare,
        label: "Slack",
        summary: safeHostname(config?.webhookUrl) ?? "Slack destination",
      };
    default:
      return {
        Icon: Bell,
        label: safeChannelTypeLabel(channel.type),
        summary: "Notification destination",
      };
  }
}

export function CheckNotificationChannels({
  checkId,
  checkName,
  notificationChannelIds,
  channels,
  variant,
}: CheckNotificationChannelsProps) {
  const client = useApolloClient();
  const [setCheckChannelEnabled] = useMutation<
    SetCheckChannelEnabledData,
    SetCheckChannelEnabledVariables
  >(SET_CHECK_CHANNEL_ENABLED, { fetchPolicy: "no-cache" });
  const [selectedIds, setSelectedIds] = useState(
    () => new Set(notificationChannelIds),
  );
  const [pendingIds, setPendingIds] = useState(() => new Set<string>());
  const pendingPreviousValues = useRef(new Map<string, boolean>());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setSelectedIds((current) => {
      const reconciled = new Set(notificationChannelIds);
      for (const channelId of pendingPreviousValues.current.keys()) {
        if (current.has(channelId)) {
          reconciled.add(channelId);
        } else {
          reconciled.delete(channelId);
        }
      }
      return reconciled;
    });
  }, [notificationChannelIds]);

  const activeChannels = channels.filter((channel) => channel.enabled);
  const hasSelectedActiveChannel = activeChannels.some((channel) =>
    selectedIds.has(channel.id),
  );

  async function saveChannel(
    channel: NotificationChannelOption,
    enabled: boolean,
  ) {
    if (pendingPreviousValues.current.has(channel.id)) return;

    const wasEnabled = selectedIds.has(channel.id);
    pendingPreviousValues.current.set(channel.id, wasEnabled);
    setPendingIds((current) => {
      const next = new Set(current);
      next.add(channel.id);
      return next;
    });
    setSelectedIds((current) => {
      const next = new Set(current);
      if (enabled) {
        next.add(channel.id);
      } else {
        next.delete(channel.id);
      }
      return next;
    });

    try {
      await setCheckChannelEnabled({
        variables: {
          checkId,
          channelId: channel.id,
          enabled,
        },
      });

      const normalizedId = client.cache.identify({
        __typename: "CheckModel",
        id: checkId,
      });
      if (normalizedId) {
        client.cache.modify<{ notificationChannelIds: readonly string[] }>({
          id: normalizedId,
          fields: {
            notificationChannelIds(existing) {
              const existingIds = isStringArray(existing) ? existing : [];
              const withoutTarget = existingIds.filter(
                (id) => id !== channel.id,
              );
              return enabled
                ? [...withoutTarget, channel.id]
                : withoutTarget;
            },
          },
        });
      }
    } catch {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (wasEnabled) {
          next.add(channel.id);
        } else {
          next.delete(channel.id);
        }
        return next;
      });
      setErrorMessage(
        `Could not update notifications for ${checkName}. Please try again.`,
      );
      void client.refetchQueries({ include: [CHANNELS] }).catch(() => undefined);
    } finally {
      pendingPreviousValues.current.delete(channel.id);
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(channel.id);
        return next;
      });
    }
  }

  return (
    <>
      <section
        data-variant={variant}
        className="w-full overflow-hidden rounded-lg border border-border/70 bg-background"
      >
        <div
          className={cn(
            "flex items-center justify-between border-b border-border/60 bg-muted/20",
            variant === "compact" ? "px-3 py-2" : "px-4 py-3",
          )}
        >
          <h3 className="text-sm font-medium text-foreground">Notifications</h3>
          <span className="font-mono text-[10px] font-medium tracking-[0.12em] text-muted-foreground">
            DOWN + RECOVERY
          </span>
        </div>

        {activeChannels.length === 0 ? (
          <div
            className={cn(
              "flex flex-col items-start text-sm",
              variant === "compact"
                ? "gap-1.5 px-3 py-3"
                : "gap-2 px-4 py-4",
            )}
          >
            <p className="text-muted-foreground">
              No active notification channels
            </p>
            <Link
              href="/channels"
              className="font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
            >
              Add or activate a notification channel
            </Link>
          </div>
        ) : (
          <>
            <div className="divide-y divide-border/60">
              {activeChannels.map((channel) => {
                const { Icon, label, summary } = channelPresentation(channel);
                const pending = pendingIds.has(channel.id);
                return (
                  <div
                    key={channel.id}
                    data-slot="channel-row"
                    className={cn(
                      "flex items-center gap-3",
                      variant === "compact" ? "px-3 py-2" : "px-4 py-3",
                    )}
                  >
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/35">
                      <Icon
                        aria-hidden="true"
                        className="size-3.5 text-muted-foreground"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium leading-5 text-foreground">
                        {label}
                      </div>
                      <div className="truncate text-xs leading-4 text-muted-foreground">
                        {summary}
                      </div>
                    </div>
                    <div className="flex min-w-19 items-center justify-end gap-2">
                      {pending ? (
                        <span
                          role="status"
                          className="flex items-center gap-1 text-[11px] text-muted-foreground"
                        >
                          <LoaderCircle
                            aria-hidden="true"
                            className="size-3 animate-spin"
                          />
                          Saving…
                        </span>
                      ) : null}
                      <Switch
                        size="sm"
                        checked={selectedIds.has(channel.id)}
                        disabled={pending}
                        aria-label={`${checkName} — ${label} notifications`}
                        onCheckedChange={(checked) => {
                          void saveChannel(channel, checked);
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {!hasSelectedActiveChannel ? (
              <p className="border-t border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs leading-4 text-amber-800 dark:text-amber-300">
                Notifications off — This check will not send DOWN or RECOVERY
                notifications.
              </p>
            ) : null}
          </>
        )}
      </section>

      <Dialog
        open={errorMessage !== null}
        onOpenChange={(open) => {
          if (!open) setErrorMessage(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
